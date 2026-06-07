/**
 * GLEngine — the WebGL2 counterpart of the canvas SoftwareRenderer.
 *
 * Where SoftwareRenderer paints a low-res pixel buffer on the CPU, this
 * draws the world with the GPU: textured wall quads, stencil-filled
 * floor/ceiling planes, a cylindrical sky backdrop and camera-facing
 * sprite billboards, all into a full-resolution drawing buffer with real
 * per-pixel depth. The textures are sampled NEAREST and the sector light
 * is quantised into colormap-style bands in the fragment shaders, so the
 * crisp high-res geometry still wears the original game's chunky low-res
 * skin — the look this project is built around.
 *
 * It deliberately reuses the canvas renderer's rendering-agnostic parts:
 *
 *   Scene (../canvas/scene.js)      the mutable world model + per-frame
 *                                   simulation (doors, lifts, light
 *                                   specials, animation clocks). Identical
 *                                   between the two renderers, so it lives
 *                                   in one place and both forward the same
 *                                   SCENE_COMMANDS to it.
 *   commandMethods (../canvas/…)    the view-side command setters (weapon,
 *                                   HUD readout, flash, screen toggles) —
 *                                   pure presentation state, renderer-
 *                                   independent.
 *   tables.js data                  sprite / animation / HUD layout tables.
 *
 * Everything WebGL-specific — the programs, the passes, the overlay blit —
 * is local to this folder. Per-frame orchestration lives in `render`; the
 * passes (passes/*.js) and the overlay (overlay.js) are mixins assembled
 * onto the prototype at the bottom of this file, exactly as the canvas
 * renderer assembles its software passes.
 */

import { Program, StaticBuffer, DynamicBuffer } from './glutil.js';
import {
    WORLD_VS, WORLD_FS, FLAT_VS, FLAT_FS, SKY_VS, SKY_FS, SKYWALL_VS,
    BLIT_VS, BLIT_FS, SOLID_VS, SOLID_FS,
} from './shaders.js';
import { getWallTexture, getFlatTexture, clearTextureCache } from './textures.js';

import { Scene, SCENE_COMMANDS } from '../canvas/scene.js';
import { commandMethods } from '../canvas/commands.js';

import { skyPassMethods } from './passes/sky.js';
import { wallPassMethods } from './passes/walls.js';
import { flatPassMethods } from './passes/flats.js';
import { entityPassMethods } from './passes/entities.js';
import { overlayMethods } from './overlay.js';

const FAR = 20000;   // depth far plane — generously past any map extent
// Near plane, in world units. Kept small so a wall doesn't blink out when
// the camera is pressed right up against it (the GPU clips any geometry
// nearer than this; at the old value of 4 a wall you stood flush against —
// e.g. a lift's back wall, where collision lets you reach it — fell wholly
// inside the near plane and vanished). 1 unit still leaves ample depth
// precision against FAR for a DOOM-scale map.
const NEAR_PLANE = 1;

// HUD scale (source-pixels → CSS-pixels), like the DomRenderer's `--scale`.
// The DOM steps 2→3 at a 1280px-wide pane; we use the same min/max but ramp
// smoothly across a width band instead of stepping, and we never wrap the
// bar into extra rows. Below MIN_W the scale holds at MIN, above MAX_W it
// holds at MAX, and it interpolates between — so the bar lands at the same
// 640 / 960 CSS px as the DOM on ≤1280px and ≥1920px panes.
const HUD_MIN_SCALE = 2;
const HUD_MAX_SCALE = 3;
const HUD_RAMP_MIN_W = 1280;   // CSS px: at/below → MIN scale
const HUD_RAMP_MAX_W = 1920;   // CSS px: at/above → MAX scale

// Head bob — raise the eye 0→BOB_HEIGHT→0 while walking, matching the
// DomRenderer's `--bob` keyframe (0..6 over a 400ms cycle). The amplitude
// eases in/out with movement so the view settles smoothly when you stop.
const BOB_HEIGHT = 6;                       // peak eye rise, world units
const BOB_RATE = (2 * Math.PI) / 0.4;       // one 0→6→0 cycle per 400ms
const BOB_EASE = 8;                         // amplitude ease rate (per second)

// DomRenderer light model (scene/sectors.js::doomLightToCSS +
// constants.js): a DOOM sector light level (0..255) maps through the
// R_InitLightTables colormap selection to a flat 0..1 brightness, with a
// medium-distance scalelight compensation and a never-fully-black floor.
// Matching this exactly is what keeps the WebGL pane's brightness in step
// with the CSS reference — no distance falloff, no per-pixel banding.
const LIGHT_DISTANCE_OFFSET = 4;
const LIGHT_MINIMUM_BRIGHTNESS = 0.12;
function doomLight(lightLevel) {
    const startmap = (15 - lightLevel / 16) * 4 - LIGHT_DISTANCE_OFFSET;
    const colormap = Math.max(0, Math.min(31, startmap));
    return Math.max(LIGHT_MINIMUM_BRIGHTNESS, 1 - colormap / 32);
}

export class GLEngine {
    constructor(gl, resolution) {
        this.gl = gl;
        this.resolution = resolution;

        // World model + per-frame simulation (shared with the canvas
        // renderer). The engine forwards every world command here.
        this.scene = new Scene();

        // GL programs, one per pass.
        this.worldProgram = new Program(gl, WORLD_VS, WORLD_FS);
        this.flatProgram = new Program(gl, FLAT_VS, FLAT_FS);
        this.skyProgram = new Program(gl, SKY_VS, SKY_FS);
        // Sky-wall occluders reuse the sky fragment sampling with a
        // world-projected vertex shader (so they write real depth).
        this.skyWallProgram = new Program(gl, SKYWALL_VS, SKY_FS);
        this.blitProgram = new Program(gl, BLIT_VS, BLIT_FS);
        this.solidProgram = new Program(gl, SOLID_VS, SOLID_FS);

        // A clip-space covering triangle, reused by the sky + solid passes.
        this._fullscreenBuffer = new StaticBuffer(gl, new Float32Array([-1, -1, 3, -1, -1, 3]));
        // Streamed geometry buffers for billboards + overlay quads.
        this._spriteBuffer = new DynamicBuffer(gl);
        this._overlayBuffer = new DynamicBuffer(gl);

        this._flats = null;            // per-sector static flat geometry

        // ── View state (per-pane presentation; see commandMethods) ──────
        this.viewerPlayerIndex = 0;
        this.weapon = null;
        this.flash = null;
        this.hud = null;
        this.intermission = null;
        this.results = null;
        this.lobby = null;

        // Drawing-buffer + overlay dimensions, set by resize().
        this.W = 0; this.H = 0;
        this.overlayW = 0; this.overlayH = 0;
        // HUD/weapon scale, recomputed from the pane width on every resize
        // (see resize()). 1 until the first resize lands.
        this.uiScale = 1;

        // Per-frame transients.
        this._cam = null;
        this._aspect = 1;
        this._A = (FAR + NEAR_PLANE) / (FAR - NEAR_PLANE);
        this._B = -2 * FAR * NEAR_PLANE / (FAR - NEAR_PLANE);
        this._lastFrameTime = 0;
        this._bobX = 0; this._bobY = 0;
        this._lastCamX = null; this._lastCamY = null;
        // Head-bob state: eased amplitude (0..1) + free-running phase, plus
        // the movement flag the weapon bob also reads.
        this._moving = false;
        this._bobAmp = 0;
        this._bobPhase = 0;
    }

    /** Size the drawing buffer (W×H device pixels) and recompute the
     *  overlay virtual canvas (mirrors canvas/renderer.js::_resize). */
    resize(W, H) {
        this.W = W; this.H = H;
        this._aspect = W / H;
        this.gl.viewport(0, 0, W, H);

        const f = this.resolution;
        const aspect = W / H;
        const maxIH = 200 * f, maxIW = 640 * f;
        let iw, ih;
        if (maxIH * aspect <= maxIW) { ih = maxIH; iw = Math.max(1, Math.round(ih * aspect)); }
        else { iw = maxIW; ih = Math.max(1, Math.round(iw / aspect)); }
        this.overlayW = iw; this.overlayH = ih;

        // HUD scale: hold MIN on small panes, MAX on large ones, ramp
        // between the two width breakpoints (see the constants). `scaleCss`
        // is the source→CSS-px factor (what the DOM's `--scale` is);
        // convert it into overlay virtual units so the bar's on-screen size
        // is `320 * scaleCss` CSS px regardless of the overlay resolution or
        // device pixel ratio.
        const dpr = window.devicePixelRatio || 1;
        const paneWidthCss = W / dpr;
        const t = Math.max(0, Math.min(1,
            (paneWidthCss - HUD_RAMP_MIN_W) / (HUD_RAMP_MAX_W - HUD_RAMP_MIN_W)));
        let scaleCss = HUD_MIN_SCALE + (HUD_MAX_SCALE - HUD_MIN_SCALE) * t;
        // Safety for very narrow panes (< ~640px): keep the 320-wide bar
        // from overflowing. The DOM wraps here; we shrink to fit instead.
        scaleCss = Math.min(scaleCss, paneWidthCss / 320);
        this.uiScale = scaleCss * this.overlayW / paneWidthCss;
    }

    setMap(data) {
        this.scene.setMap(data);
        this._buildFlatGeometry();
        this._buildWallPegging();
        // Sectors with an animated light special: their brightness is driven
        // by the special's absolute value (scene._sectorLightMul), matching
        // the DOM keyframes that override --light, rather than the static
        // colormap brightness.
        this._specialSectors = new Set(this.scene._lightSectors.map(e => e.sectorIndex));
    }

    clear() {
        this.scene.clear();
        if (this._flats) { for (const f of this._flats) { f.fan.dispose(); f.quad.dispose(); } this._flats = []; }
    }

    destroy() {
        const gl = this.gl;
        this._fullscreenBuffer.dispose();
        this._spriteBuffer.dispose();
        this._overlayBuffer.dispose();
        if (this._wallBuffer) this._wallBuffer.dispose();
        if (this._flats) for (const f of this._flats) { f.fan.dispose(); f.quad.dispose(); }
        if (this._skyWallBuf) this._skyWallBuf.dispose();
        for (const p of [this.worldProgram, this.flatProgram, this.skyProgram, this.skyWallProgram, this.blitProgram, this.solidProgram]) {
            gl.deleteProgram(p.program);
        }
        clearTextureCache(gl);
    }

    // ── Shared pass helpers ──────────────────────────────────────────

    /** Push the live camera + projection into a world/flat program. */
    _setCameraUniforms(prog) {
        const gl = this.gl, c = this._cam;
        gl.uniform3f(prog.u('u_eye'), c.ex, c.ey, c.ez);
        gl.uniform2f(prog.u('u_rot'), c.ca, c.sa);
        gl.uniform1f(prog.u('u_aspect'), this._aspect);
        gl.uniform1f(prog.u('u_A'), this._A);
        gl.uniform1f(prog.u('u_B'), this._B);
    }

    /** Bind a 6-float-stride world vertex buffer to a_pos/a_uv/a_light. */
    _bindWorldAttribs(prog, buf) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf.buffer);
        const ap = prog.a('a_pos'), au = prog.a('a_uv'), al = prog.a('a_light');
        gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(au); gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 24, 12);
        gl.enableVertexAttribArray(al); gl.vertexAttribPointer(al, 1, gl.FLOAT, false, 24, 20);
    }

    _getWall(name) { return getWallTexture(this.gl, name); }
    _getFlat(name) { return getFlatTexture(this.gl, name); }

    /** Flat per-surface brightness (0..1), matching the DomRenderer. A
     *  sector with an animated light special uses the special's absolute
     *  value (the DOM keyframes override --light); everything else uses the
     *  static colormap brightness for its light level. */
    _sectorBrightness(sectorIndex, lightLevel) {
        if (this._specialSectors && this._specialSectors.has(sectorIndex)) {
            return this.scene._sectorLightMul[sectorIndex] ?? 1;
        }
        return doomLight(lightLevel);
    }

    /** Colormap brightness for a raw light level (no special handling) —
     *  used for sprites, which the DOM dims by their sector's light. */
    _doomLight(lightLevel) { return doomLight(lightLevel); }

    // ── Per-frame entry point ────────────────────────────────────────

    render(camera) {
        const gl = this.gl;
        if (!this.W) return;
        gl.viewport(0, 0, this.W, this.H);
        const now = performance.now();

        // Full-screen overlays own the whole pane and freeze the world,
        // matching the canvas renderer's routing exactly.
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
        // doesn't bob the camera itself, so we derive it from the camera
        // sliding frame-to-frame, like the DomRenderer's `.moving` class.
        this._moving = this._lastCamX !== null
            && (Math.abs(camera.x - this._lastCamX) > 0.5 || Math.abs(camera.y - this._lastCamY) > 0.5);
        this._lastCamX = camera.x; this._lastCamY = camera.y;

        // Head bob: ease the amplitude toward 1 while moving / 0 while still,
        // and add a 0→BOB_HEIGHT→0 rise to the eye height (raised cosine, so
        // it sits at baseline when amplitude is 0 — no leftover offset).
        this._bobAmp += ((this._moving ? 1 : 0) - this._bobAmp) * Math.min(1, BOB_EASE * dt);
        this._bobPhase += dt * BOB_RATE;
        const bobZ = this._bobAmp * (BOB_HEIGHT / 2) * (1 - Math.cos(this._bobPhase));

        this._cam = {
            ex: camera.x, ey: camera.y, ez: camera.z + bobZ,
            ca: Math.cos(camera.angle), sa: Math.sin(camera.angle),
            angle: camera.angle,
        };

        gl.clearColor(0, 0, 0, 1);
        gl.clearDepth(1);
        gl.clearStencil(0);
        gl.depthMask(true);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.depthFunc(gl.LESS);

        this._renderSky(this._cam);
        this._renderSkyWalls(this._cam);
        this._renderFlats();
        this._renderWalls(this._cam);
        this._renderEntities(this._cam);

        // Screen-space overlay on top of the world.
        this._beginOverlay();
        this._renderWeapon(this._cam, now, dt);
        this._renderHud(now);
        this._renderFlash(now);
        if (this.lobby?.variant === 'local') this._overlayLocalLobby(now);
    }
}

// Assemble the passes + overlay + view commands onto the prototype.
Object.assign(
    GLEngine.prototype,
    skyPassMethods,
    wallPassMethods,
    flatPassMethods,
    entityPassMethods,
    overlayMethods,
    commandMethods,
);

// World dispatch commands forward to the Scene, so the engine presents one
// flat command surface (WebGLRenderer dispatches `this.engine[cmd](...)`)
// while the world mutation logic stays on the shared model.
for (const cmd of SCENE_COMMANDS) {
    GLEngine.prototype[cmd] = function (...args) { return this.scene[cmd](...args); };
}
