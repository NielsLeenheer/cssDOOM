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
 * This file is the *spine*: the renderer's state (constructor), buffer
 * allocation (resize), scene ingestion (setMap / clear), the per-frame
 * orchestration (render), and the shared overlay blit primitive (_blit).
 * Everything else is split into focused mixins assembled onto the
 * prototype at the bottom of this file:
 *
 *   commands.js     — the dispatch command surface (entity / HUD / screen
 *                     state setters).
 *   sectors.js      — doors & lifts (state + simulation + lift walls).
 *   passes/*.js     — the world render passes (sky, walls, flats,
 *                     entities) and the screen-space HUD passes.
 *   screens.js      — full-screen intermission / results / lobby screens.
 */

import { THING_SPRITES } from '../dom/scene/constants.js';
import {
    FOV, LIGHT_EFFECT, ANIM_FRAME_MS, ENEMY_ANIM, lightMul,
} from './tables.js';
import { Framebuffer } from './framebuffer.js';
import { commandMethods } from './commands.js';
import { sectorMethods } from './sectors.js';
import { skyMethods } from './passes/sky.js';
import { wallMethods } from './passes/walls.js';
import { flatMethods } from './passes/flats.js';
import { entityMethods } from './passes/entities.js';
import { hudMethods } from './passes/hud.js';
import { screenMethods } from './screens.js';

export class SoftwareRenderer {
    constructor() {
        // Pixel + depth buffers and the overlay blit primitive. The world
        // passes destructure `this.framebuffer` for their hot loops; the
        // display canvas reads `imageData` (exposed below) to blit out.
        this.framebuffer = new Framebuffer();
        this.walls = [];
        this.sectorPolygons = [];

        // Entities. Static, non-interactive billboards live in `statics`
        // (decorations + corpses). Game-driven things are keyed by their
        // gameId in `things` so the dispatch commands (move, collect,
        // kill, rotate, …) can find them. Projectiles and transient
        // effects have their own short-lived collections.
        this.statics = [];
        this.things = new Map();      // gameId → entry
        this.projectiles = new Map(); // projectileId → entry
        this.effects = [];            // [{ x, y, z, frames, start, frameMs, centered }]
        this._sectorLight = [];       // sectorIndex → lightLevel
        this.viewerPlayerIndex = 0;   // which player this pane renders (hides own billboard)

        // Doors. Each animates its sector ceiling + upper face walls
        // between closed/open. `_wallBottomOffset` raises a door panel's
        // bottom edge as it opens; `_ceilOverride` raises the door
        // sector's ceiling so its floor/ceiling become visible.
        this.doors = new Map();          // sectorIndex → door record
        this.lifts = new Map();          // sectorIndex → lift record
        this._wallBottomOffset = new Map(); // wall ref → bottom-height delta
        this._wallTopOverride = new Map();  // wall ref → absolute top height (door tracks)
        this._ceilOverride = new Map();     // sectorPolygon ref → ceiling height
        this._floorOverride = new Map();    // sectorPolygon ref → floor height (lifts)
        this._skyCeil = new Map();          // sectorIndex → ceiling height (sky sectors)
        this._skyCtx = null;                // per-frame sky sampling parameters
        this._lastFrameTime = 0;

        // Sector light specials (flicker / blink / glow / fire).
        this._lightSectors = [];      // [{ sectorIndex, type, phase, seed }]
        this._sectorLightMul = [];    // sectorIndex → current multiplier (default 1)

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
        this._animFrame = 0;          // current animated-texture frame
        this._scrollOffset = 0;       // current scrolling-wall texture offset
        this._bobX = 0;
        this._bobY = 0;
        this._lastCamX = null;
        this._lastCamY = null;

        this._colAngle = null;    // per-column view-angle offset, rebuilt on resize
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

    /**
     * Stash the geometry from the shared, already-enriched map data.
     *
     * Things are taken straight from the game's enrichment pass
     * (`shared/maps/things.js::initThings`): entries that survived the
     * skill-level / multiplayer filter carry a `category`, a resolved
     * `sectorIndex` and a `floorHeight`; entries that were filtered out
     * for the chosen difficulty have no `category`. We render exactly
     * the surviving set, so the billboards match the difficulty the
     * player selected instead of every enemy the map file lists.
     */
    setMap(data) {
        this.walls = data.walls || [];
        this.sectorPolygons = data.sectorPolygons || [];
        const sectors = data.sectors || [];
        this._sectorLight = sectors.map(s => s.lightLevel);

        // Sector light specials.
        this._lightSectors = [];
        this._sectorLightMul = new Array(sectors.length).fill(1);
        for (const sp of this.sectorPolygons) {
            const eff = LIGHT_EFFECT[sp.specialType];
            if (!eff) continue;
            this._lightSectors.push({
                sectorIndex: sp.sectorIndex,
                type: eff.type,
                phase: eff.sync ? 0 : Math.random() * 10,
                seed: (sp.sectorIndex * 2654435761) >>> 0,
            });
        }

        this.statics = [];
        this.things.clear();
        this.projectiles.clear();
        this.effects = [];
        this.doors.clear();
        this.lifts.clear();
        this._wallBottomOffset.clear();
        this._wallTopOverride.clear();
        this._ceilOverride.clear();
        this._floorOverride.clear();

        // Build door records. A door is a sector whose ceiling rises from
        // closedHeight (the stored, squished state) to openHeight; its
        // upper face walls (the panels) slide up with it. Start closed.
        const polyOf = new Map();
        for (const sp of this.sectorPolygons) polyOf.set(sp.sectorIndex, sp);
        for (const door of (data.doors || [])) {
            const faceWalls = this.walls.filter(w => w.isUpperWall
                && (w.frontSectorIndex === door.sectorIndex
                    || w.backSectorIndex === door.sectorIndex));
            const sectorPoly = polyOf.get(door.sectorIndex) || null;
            this.doors.set(door.sectorIndex, {
                closed: door.closedHeight,
                open: door.openHeight,
                current: door.closedHeight,
                target: door.closedHeight,
                faceWalls,
                sectorPoly,
            });
            if (sectorPoly) this._ceilOverride.set(sectorPoly, door.closedHeight);

            // Door track jambs (DOORTRAK) ship as zero-height walls; give
            // them the door's full travel span so the slot the panel
            // slides through is solid instead of see-through.
            for (const track of (door.trackWalls || [])) {
                this._wallTopOverride.set(track, door.openHeight);
            }
        }

        // Build lift records. A lift is a sector whose floor rides between
        // upperHeight (its stored, raised state) and lowerHeight; its
        // shaft walls are kept on the record and drawn each frame at the
        // animated height. Start raised.
        for (const lift of (data.lifts || [])) {
            const sectorPoly = polyOf.get(lift.sectorIndex) || null;
            const raised = sectorPoly ? sectorPoly.floorHeight : lift.upperHeight;
            this.lifts.set(lift.sectorIndex, {
                upper: lift.upperHeight,
                lower: lift.lowerHeight,
                current: raised,
                target: raised,
                sectorPoly,
                light: this._sectorLight[lift.sectorIndex] ?? 200,
                shaftWalls: lift.shaftWalls || [],
            });
            if (sectorPoly) this._floorOverride.set(sectorPoly, raised);
        }

        // Sky ceilings, keyed by sector index → ceiling height. In DOOM the
        // sky is the visible ceiling of whichever sky sector you're looking
        // at: it's drawn opaquely above the walls of that sector and
        // occludes anything beyond. We reproduce that in the wall pass — a
        // wall whose sector has a sky ceiling paints the sky from its top
        // edge upward at the wall's own depth (see passes/walls.js), so
        // distant geometry behind the opening is depth-rejected, no
        // occluder objects or culling required.
        this._skyCeil.clear();
        for (const sp of this.sectorPolygons) {
            if (sp.ceilingTexture === 'F_SKY1') this._skyCeil.set(sp.sectorIndex, sp.ceilingHeight);
        }

        for (const t of (data.things || [])) {
            if (t.category === undefined) continue;   // filtered out by skill / MP
            const name = THING_SPRITES[t.type];
            if (!name) continue;
            const light = sectors[t.sectorIndex]?.lightLevel ?? 180;
            // Anchor to the static floor of the thing's sector rather than
            // the enriched `t.floorHeight`: that value is computed inside
            // maps.load against the global lift state, which on a level
            // transition still holds the *previous* level's lifts, sinking
            // things into the new floor. The sector's own floorHeight is
            // immune; moving things get live heights via updateThingPosition.
            const floorZ = polyOf.get(t.sectorIndex)?.floorHeight ?? t.floorHeight ?? 0;

            // Things the game simulates carry a gameId — the key the
            // dispatch commands address them by. Register those in the
            // things map so they can move / be collected / die. Passive
            // decorations (no gameId) become static billboards.
            if (t.gameId === undefined) {
                this.statics.push({ x: t.x, y: t.y, floorZ, light, name });
                continue;
            }

            const anim = ENEMY_ANIM[t.type] || null;
            this.things.set(t.gameId, {
                type: t.type,
                category: t.category,
                x: t.x,
                y: t.y,
                floorZ,
                light,
                isEnemy: anim !== null,
                anim,
                fixedName: name,                       // used for pickups / barrels
                rotation: 1,
                facing: (t.angle ?? 0) * Math.PI / 180, // DOOM degrees → radians
                state: 'idle',
                collected: false,
                deathStart: 0,
                walkPhase: Math.random() * 1000,
                playerIndex: undefined,
            });
        }
    }

    clear() {
        this.walls = [];
        this.sectorPolygons = [];
        this.statics = [];
        this.things.clear();
        this.projectiles.clear();
        this.effects = [];
        this.doors.clear();
        this.lifts.clear();
        this._wallBottomOffset.clear();
        this._wallTopOverride.clear();
        this._ceilOverride.clear();
        this._floorOverride.clear();
        this._skyCeil.clear();
        this._lightSectors = [];
        this._sectorLightMul = [];
    }

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
        // is visible behind a per-pane prompt, mirroring what DomRenderer
        // shows. Locally we fall through to the world pass and overlay
        // the prompt at the end via `_overlayLocalLobby`.
        if (this.results) { this._renderResults(now); return; }
        if (this.intermission) { this._renderIntermission(now); return; }
        if (this.lobby?.variant === 'network' || (this.lobby && this.walls.length === 0)) {
            this._renderLobby(now); return;
        }

        const dt = this._lastFrameTime ? Math.min(0.1, (now - this._lastFrameTime) / 1000) : 0;
        this._lastFrameTime = now;
        this._updateDoors(dt);
        this._updateLifts(dt);
        const tSec = now / 1000;
        for (const e of this._lightSectors) {
            this._sectorLightMul[e.sectorIndex] = lightMul(e, tSec);
        }
        this._animFrame = (now / ANIM_FRAME_MS) | 0;
        // Scrolling-wall texture offset: DOOM scrolls 1 unit/tic ≈ 35
        // units/sec. Kept bounded so it stays power-of-two aligned.
        this._scrollOffset = (now * 0.035) % 4096;

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
            ez: camera.z,
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
// all of them. Order is immaterial (no key collisions) but listed
// command → simulation → world passes → HUD → screens to read top-down
// the way a frame flows.
Object.assign(
    SoftwareRenderer.prototype,
    commandMethods,
    sectorMethods,
    skyMethods,
    wallMethods,
    flatMethods,
    entityMethods,
    hudMethods,
    screenMethods,
);
