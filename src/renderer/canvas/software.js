/**
 * SoftwareRenderer — a from-scratch 2D-canvas software renderer that
 * paints a DOOM level the way the original game did, into a low-res
 * internal framebuffer that the CanvasRenderer then upscales (nearest
 * neighbour) to the pane. No DOM, no WebGL — just a Uint32 pixel
 * buffer and a per-pixel depth buffer.
 *
 * Techniques, mirrored from id's renderer (r_segs / r_plane / r_things
 * in linuxdoom-1.10):
 *
 *   - Walls are drawn as vertical textured columns (see passes/walls.js).
 *   - Floors and ceilings are visplanes back-projected per pixel
 *     (passes/flats.js).
 *   - The sky is sampled by view angle per column (passes/sky.js).
 *   - Things are camera-facing billboards (passes/entities.js).
 *   - Light diminishing combines sector light + distance falloff
 *     (helpers in tables.js).
 *
 * The camera transform and projection are byte-for-byte the same shape
 * as the LineRenderer's vendored scene so this pane frames the world
 * identically to its siblings.
 *
 * Architecture — three collaborators:
 *
 *   Scene (scene.js)       the mutable world model: geometry, entities,
 *                          moving sectors, light. Owns the world dispatch
 *                          commands and the per-frame simulation. The
 *                          renderer forwards SCENE_COMMANDS to it.
 *   Framebuffer            the pixel + depth buffers and the overlay blit.
 *   SoftwareRenderer       this file — the *spine*: per-pane view state
 *                          (camera projection, HUD/weapon, screens), the
 *                          per-frame render() orchestration, and the glue
 *                          that drives Scene.update then runs the passes.
 *
 * The passes (passes/*.js), the view commands (commands.js) and the
 * full-screen screens (screens.js) are mixins assembled onto the
 * prototype at the bottom of this file. Passes read the Scene and never
 * write it; mutation flows through the forwarded Scene commands.
 */

import { FOV } from './tables.js';
import { Framebuffer } from './framebuffer.js';
import { Scene, SCENE_COMMANDS } from './scene.js';
import { commandMethods } from './commands.js';
import { skyMethods } from './passes/sky.js';
import { wallMethods } from './passes/walls.js';
import { flatMethods } from './passes/flats.js';
import { entityMethods } from './passes/entities.js';
import { hudMethods } from './passes/hud.js';
import { screenMethods } from './screens.js';

// Head bob — raise the eye 0→BOB_HEIGHT→0 while walking, matching the
// CSSRenderer's `--bob` keyframe (0..6 over a 400ms cycle) and the WebGL
// engine. The amplitude eases in/out with movement so the view settles
// smoothly when you stop. The game doesn't bob the camera itself, so
// movement is derived from the camera sliding frame-to-frame (see render()).
const BOB_HEIGHT = 6;                       // peak eye rise, world units
const BOB_RATE = (2 * Math.PI) / 0.4;       // one 0→6→0 cycle per 400ms
const BOB_EASE = 8;                         // amplitude ease rate (per second)

export class SoftwareRenderer {
    constructor() {
        // Pixel + depth buffers and the overlay blit primitive. The world
        // passes destructure `this.framebuffer` for their hot loops; the
        // display canvas reads `imageData` (exposed below) to blit out.
        this.framebuffer = new Framebuffer();

        // The world model — geometry, entities, moving sectors. The
        // renderer forwards every world dispatch command here (see the
        // SCENE_COMMANDS forwarders below) and reads it through the passes.
        this.scene = new Scene();

        this.viewerPlayerIndex = 0;   // which player this pane renders (hides own billboard)

        // Screen-space HUD overlay: the player's weapon and damage /
        // pickup flashes, drawn into the framebuffer after the world.
        this.weapon = null;           // { name, info, firing, fireStart, fireRate, bob }
        this.flash = null;            // { r, g, b, start }
        this.hud = null;              // { health, armor, ammo, maxAmmo, currentWeapon, ownedWeapons }
        this.intermission = null;     // null | { mapName, stats, startTime }
        this.results = null;          // null | { scores, kills, winnerIndex, mapName }
        this.lobby = null;            // null | lobby payload
        // Pixel scale for screen-space UI (HUD + weapon), in framebuffer
        // pixels per source pixel. Set by the CanvasRenderer; it scales
        // below the render factor so the bar/weapon get relatively smaller
        // as the world resolution rises (1x→1, 2x→1, 3x→2, 4x→3).
        this.uiScale = 1;

        // Per-frame view transients.
        this._skyCtx = null;          // sky sampling params, set by the sky pass, read by walls
        this._lastFrameTime = 0;
        this._bobX = 0;
        this._bobY = 0;
        this._lastCamX = null;
        this._lastCamY = null;
        // Head-bob state: eased amplitude (0..1) + free-running phase, plus
        // the movement flag the weapon bob also reads (both set in render()).
        this._moving = false;
        this._bobAmp = 0;
        this._bobPhase = 0;
        // Display canvas height in device px, set by the CanvasRenderer on
        // resize — lets the weapon tuck a fixed CSS distance into the bar.
        this.displayH = 0;
        this._colAngle = null;        // per-column view-angle offset, rebuilt on resize
    }

    /** ImageData the display canvas blits from — owned by the framebuffer. */
    get imageData() { return this.framebuffer.imageData; }

    /** Allocate buffers for an internal resolution of W×H. */
    resize(W, H, ctx) {
        this.framebuffer.resize(W, H, ctx);
        const halfW = W * 0.5;
        const sxScale = halfW / Math.tan(FOV / 2);
        this._colAngle = new Float32Array(W);
        for (let x = 0; x < W; x++) {
            this._colAngle[x] = Math.atan2(x + 0.5 - halfW, sxScale);
        }
    }

    /** Ingest the shared, already-enriched map data into the scene. */
    setMap(data) { this.scene.setMap(data); this._unpegged = null; }

    /** Drop the scene — used when the pane is torn down / between levels. */
    clear() { this.scene.clear(); this._unpegged = null; }

    // ── Per-frame entry point ────────────────────────────────────────────

    render(camera) {
        const fbuf = this.framebuffer;
        if (!fbuf.fb) return;
        fbuf.clear();

        const now = performance.now();

        // Full-screen overlays (intermission, results) freeze the world
        // and own the whole pane. The Network DM lobby behaves the same
        // way — there's no level loaded behind it. The Local DM lobby
        // doesn't: the level pre-loads in standalone mode so the world
        // is visible behind a per-pane prompt, mirroring what CSSRenderer
        // shows. Locally we fall through to the world pass and overlay
        // the prompt at the end via `_overlayLocalLobby`.
        if (this.results) { this._renderResults(now); return; }
        if (this.intermission) { this._renderIntermission(now); return; }
        if (this.lobby?.variant === 'network' || (this.lobby && this.scene.walls.length === 0)) {
            this._renderLobby(now); return;
        }

        // Advance the world: moving sectors, light specials, anim clocks.
        const dt = this._lastFrameTime ? Math.min(0.1, (now - this._lastFrameTime) / 1000) : 0;
        this._lastFrameTime = now;
        this.scene.viewerPlayerIndex = this.viewerPlayerIndex;
        this.scene.update(dt, now);

        // Movement detection (shared by head bob + weapon bob): the game
        // doesn't bob the camera itself, so derive it from the camera
        // sliding frame-to-frame, like the CSSRenderer's `.moving` class.
        // _renderWeapon reuses this._moving so the two bobs stay in sync.
        this._moving = this._lastCamX !== null
            && (Math.abs(camera.x - this._lastCamX) > 0.5 || Math.abs(camera.y - this._lastCamY) > 0.5);
        this._lastCamX = camera.x; this._lastCamY = camera.y;

        // Head bob: ease the amplitude toward 1 while moving / 0 while still
        // and add a 0→BOB_HEIGHT→0 rise to the eye (raised cosine, so it sits
        // at baseline when amplitude is 0 — no leftover offset when stopped).
        this._bobAmp += ((this._moving ? 1 : 0) - this._bobAmp) * Math.min(1, BOB_EASE * dt);
        this._bobPhase += dt * BOB_RATE;
        const bobZ = this._bobAmp * (BOB_HEIGHT / 2) * (1 - Math.cos(this._bobPhase));

        const { W, H } = fbuf;
        const aspect = W / H;
        const fovScale = Math.tan(FOV / 2);
        const halfW = W * 0.5;
        const halfH = H * 0.5;
        const sxScale = halfW / fovScale;
        const syScale = (aspect * halfH) / fovScale;

        const cam = {
            ex: camera.x,
            ey: camera.y,
            ez: camera.z + bobZ,
            ca: Math.cos(camera.angle),
            sa: Math.sin(camera.angle),
            angle: camera.angle,
            halfW, halfH, sxScale, syScale, aspect, fovScale,
        };

        this._renderSky(cam);
        this._renderWalls(cam);
        this._renderLiftWalls(cam);
        this._renderFlats(cam);
        this._renderEntities(cam);
        this._renderWeapon(cam, now, dt);
        this._renderHud(now);
        this._renderFlash(now);
        // Local DM lobby — world is rendered above, this paints the
        // per-pane prompt overlay on top, matching the DOM lobby's
        // CSS-driven `data-claim-state` panel.
        if (this.lobby?.variant === 'local') this._overlayLocalLobby(now);
    }
}

// Assemble the renderer from its focused mixins. Each contributes a
// disjoint set of prototype methods; `this` is the renderer instance in
// all of them. Listed view-commands → world passes → HUD → screens to
// read top-down the way a frame flows.
Object.assign(
    SoftwareRenderer.prototype,
    commandMethods,
    skyMethods,
    wallMethods,
    flatMethods,
    entityMethods,
    hudMethods,
    screenMethods,
);

// World dispatch commands are forwarded to the Scene, so the renderer
// presents one flat command surface to the orchestrator (CanvasRenderer
// dispatches `this.software[cmd](...)`) while the world mutation logic
// lives on the model. View commands (weapon, HUD, screens) are handled by
// commandMethods above and stay on the renderer.
for (const cmd of SCENE_COMMANDS) {
    SoftwareRenderer.prototype[cmd] = function (...args) {
        return this.scene[cmd](...args);
    };
}
