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
 *   - Walls are drawn as vertical textured columns. The horizontal
 *     texture coordinate is perspective-correct (interpolate u/z and
 *     1/z across the span); the vertical coordinate is affine within a
 *     column because a wall is vertical and depth is constant down the
 *     column — exactly DOOM's R_DrawColumn setup.
 *
 *   - Floors and ceilings (flats) are drawn by back-projecting every
 *     screen pixel onto the horizontal plane at the sector's height and
 *     sampling the 64×64 flat at the resulting world (x, y) — the
 *     visplane math, done per-pixel rather than per-span.
 *
 *   - The sky is sampled by view angle per column and is independent
 *     of depth, so it always sits behind the world.
 *
 *   - Light diminishing combines the sector light level with distance
 *     falloff, quantised into bands and nudged by wall orientation
 *     (the N/S-brighter, E/W-darker "fake contrast").
 *
 *   - Things are camera-facing billboards using the front-facing sprite
 *     frame, depth-tested against the world per pixel.
 *
 * The camera transform and projection are byte-for-byte the same shape
 * as the LineRenderer's vendored scene so this pane frames the world
 * identically to its siblings.
 */

import {
    getWallTexture,
    getFlatTexture,
    getSpriteTexture,
    getSkyTexture,
} from './textures.js';
import { THING_SPRITES } from '../dom/scene/constants.js';

const FOV = Math.PI / 2;      // horizontal field of view (matches LineRenderer)
const NEAR = 4;               // near plane, world units
const MAX_DIST = 4000;        // far cull for flats / sprites
const SKY_DEPTH = 1e7;        // pseudo-depth so sky loses to all real geometry
const INV_FADE = 1 / 2600;    // distance light falloff rate
const LIGHT_FLOOR = 0.22;     // darkest a lit surface gets, as a fraction
const LIGHT_BAND = 12;        // colormap-style quantisation step

// val (0..255 brightness) → multiplier in 0..256 for `c * lf >> 8`.
const LIGHT_LUT = new Uint16Array(256);
for (let i = 0; i < 256; i++) LIGHT_LUT[i] = Math.min(256, ((i * 256 / 255) | 0));

const TAU = Math.PI * 2;
const WALK_FRAME_MS = 180;    // enemy walk-cycle frame duration
const DEATH_FRAME_MS = 120;   // enemy death-animation frame duration
const DOOR_SPEED = 100;       // door travel speed, world units per second

// Per-enemy sprite animation, keyed by DOOM thing type. `spr` is the
// 4-letter sprite base; `walk`/`attack` frame letters have full
// 8-rotation art on disk; `death` letters are single-view (rotation 0)
// and the last one is the resting corpse frame. Verified against the
// PNGs in public/assets/sprites. Cacodemon (3005) / Lost Soul (3006)
// have no per-frame PNGs here (sheet-only) and aren't in early E1, so
// they're intentionally absent — they fall back to a static billboard.
const ENEMY_ANIM = {
    3004: { spr: 'POSS', walk: ['A', 'B'], attack: 'E', death: ['H', 'I', 'J', 'K', 'L'] },           // Zombieman
    9:    { spr: 'SPOS', walk: ['A', 'B'], attack: 'E', death: ['H', 'I', 'J', 'K', 'L'] },           // Shotgun Guy
    3001: { spr: 'TROO', walk: ['A', 'B'], attack: 'E', death: ['I', 'J', 'K', 'L', 'M'] },           // Imp
    3002: { spr: 'SARG', walk: ['A', 'B'], attack: 'E', death: ['I', 'J', 'K', 'L', 'M', 'N'] },      // Demon
    58:   { spr: 'SARG', walk: ['A', 'B'], attack: 'E', death: ['I', 'J', 'K', 'L', 'M', 'N'] },      // Spectre
    3003: { spr: 'BOSS', walk: ['A', 'B'], attack: 'E', death: ['I', 'J', 'K', 'L', 'M', 'N', 'O'] }, // Baron
};

// Other players' billboards (deathmatch). Death is handled by collectItem
// + createCorpse, so no death frames are needed here.
const PLAYER_ANIM = { spr: 'PLAY', walk: ['A', 'B'], attack: 'E', death: null };
const PLAYER_CORPSE_VARIANT = ['', '-red', '-indigo', '-brown'];

// Transient effect frame sequences (single-view).
const PUFF_FRAMES = ['PUFFA0', 'PUFFB0', 'PUFFC0', 'PUFFD0'];
// Enemy fireball impact — the imp/baron ball's own burst frames.
const EXPLOSION_FRAMES = ['BAL1C0', 'BAL1D0', 'BAL1E0'];
// Barrel detonation — the larger explosion sprite.
const BARREL_FRAMES = ['BEXPA0', 'BEXPB0', 'BEXPC0', 'BEXPD0', 'BEXPE0'];
const TFOG_FRAMES = ['TFOGA0', 'TFOGB0', 'TFOGC0', 'TFOGD0', 'TFOGE0',
                     'TFOGF0', 'TFOGG0', 'TFOGH0', 'TFOGI0', 'TFOGJ0'];

/**
 * Resolve a DOOM sprite filename + horizontal mirror flag for an
 * 8-rotation frame. Mirrored rotations (6,7,8) reuse the 2/3/4 art
 * flipped, matching the WAD lump naming (e.g. TROOA2A8 serves rotation
 * 2 and, flipped, rotation 8).
 */
function buildRotName(spr, frame, rot) {
    switch (rot) {
        case 5:  return { name: `${spr}${frame}5`, mirror: false };
        case 2:  return { name: `${spr}${frame}2${frame}8`, mirror: false };
        case 8:  return { name: `${spr}${frame}2${frame}8`, mirror: true };
        case 3:  return { name: `${spr}${frame}3${frame}7`, mirror: false };
        case 7:  return { name: `${spr}${frame}3${frame}7`, mirror: true };
        case 4:  return { name: `${spr}${frame}4${frame}6`, mirror: false };
        case 6:  return { name: `${spr}${frame}4${frame}6`, mirror: true };
        default: return { name: `${spr}${frame}1`, mirror: false }; // rotation 1 (front)
    }
}

export class SoftwareRenderer {
    constructor() {
        this.W = 0;
        this.H = 0;
        this.fb = null;           // Uint32Array framebuffer (ABGR)
        this.zb = null;           // Float32Array depth buffer (forward distance)
        this.imageData = null;    // ImageData backing fb
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
        this._wallBottomOffset = new Map(); // wall ref → bottom-height delta
        this._ceilOverride = new Map();     // sectorPolygon ref → ceiling height
        this._lastFrameTime = 0;

        this._colAngle = null;    // per-column view-angle offset, rebuilt on resize
    }

    /** Allocate buffers for an internal resolution of W×H. */
    resize(W, H, ctx) {
        this.W = W;
        this.H = H;
        this.imageData = ctx.createImageData(W, H);
        this.fb = new Uint32Array(this.imageData.data.buffer);
        this.zb = new Float32Array(W * H);
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

        this.statics = [];
        this.things.clear();
        this.projectiles.clear();
        this.effects = [];
        this.doors.clear();
        this._wallBottomOffset.clear();
        this._ceilOverride.clear();

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
        }

        for (const t of (data.things || [])) {
            if (t.category === undefined) continue;   // filtered out by skill / MP
            const name = THING_SPRITES[t.type];
            if (!name) continue;
            const light = sectors[t.sectorIndex]?.lightLevel ?? 180;

            // Things the game simulates carry a gameId — the key the
            // dispatch commands address them by. Register those in the
            // things map so they can move / be collected / die. Passive
            // decorations (no gameId) become static billboards.
            if (t.gameId === undefined) {
                this.statics.push({ x: t.x, y: t.y, floorZ: t.floorHeight ?? 0, light, name });
                continue;
            }

            const anim = ENEMY_ANIM[t.type] || null;
            this.things.set(t.gameId, {
                type: t.type,
                category: t.category,
                x: t.x,
                y: t.y,
                floorZ: t.floorHeight ?? 0,
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
        this._wallBottomOffset.clear();
        this._ceilOverride.clear();
    }

    // ── Dispatch commands (game loop → entity state) ─────────────────────

    updateThingPosition(i, x, y, floorZ) {
        const e = this.things.get(i);
        if (e) { e.x = x; e.y = y; e.floorZ = floorZ; }
    }

    reparentThingToSector(i, sectorIndex) {
        const e = this.things.get(i);
        const l = this._sectorLight[sectorIndex];
        if (e && l != null) e.light = l;
    }

    collectItem(i) { const e = this.things.get(i); if (e) e.collected = true; }
    uncollectItem(i) { const e = this.things.get(i); if (e) { e.collected = false; e.state = 'idle'; e.deathStart = 0; } }

    setEnemyState(i, _type, newState) {
        const e = this.things.get(i);
        if (!e || e.state === 'dead') return;
        e.state = newState === 'attacking' ? 'attack'
                : newState === 'idle' ? 'idle'
                : 'walk';
    }

    setThingMoving(i, moving) {
        const e = this.things.get(i);
        if (e && e.state !== 'dead') e.state = moving ? 'walk' : 'idle';
    }

    playPlayerAttack(i) {
        const e = this.things.get(i);
        if (e && e.state !== 'dead') e.state = 'attack';
    }

    killEnemy(i, _type, instant /* , gib */) {
        const e = this.things.get(i);
        if (!e) return;
        if (e.category === 'barrel') {
            // Barrels don't fall over — they detonate and vanish.
            this._spawnEffect(e.x, e.y, e.floorZ + 24, BARREL_FRAMES, 60, true);
            e.collected = true;
            return;
        }
        e.state = 'dead';
        e.deathStart = instant ? -1 : performance.now();
    }

    resetEnemy(i, _type, x, y, floorZ) {
        const e = this.things.get(i);
        if (!e) return;
        e.state = 'idle';
        e.deathStart = 0;
        e.collected = false;
        if (x !== undefined) { e.x = x; e.y = y; e.floorZ = floorZ; }
    }

    updateEnemyRotation(i, enemy, viewers) {
        const e = this.things.get(i);
        if (!e || !e.isEnemy) return;
        e.x = enemy.x; e.y = enemy.y; e.facing = enemy.facing;
        const v = viewers[this.viewerPlayerIndex] ?? viewers[0];
        if (!v) return;
        const toViewer = Math.atan2(v.y - enemy.y, v.x - enemy.x);
        let rel = toViewer - enemy.facing;
        rel = ((rel % TAU) + TAU) % TAU;
        e.rotation = (Math.floor((rel + Math.PI / 8) / (Math.PI / 4)) % 8) + 1;
    }

    createProjectile(id, spec) {
        this.projectiles.set(id, {
            sprite: spec.sprite,
            sx: spec.startX, sy: spec.startY, sz: spec.startZ,
            ex: spec.endX, ey: spec.endY, ez: spec.endZ,
            duration: spec.duration || 1,
            start: performance.now(),
        });
    }

    removeProjectile(id) { this.projectiles.delete(id); }

    // Note the argument orders: puff / teleport-fog are (x, z, y); the
    // explosion is (x, y, z) — matching the game's dispatch sites.
    createPuff(x, z, y) { this._spawnEffect(x, y, z, PUFF_FRAMES, 50, true); }
    createExplosion(x, y, z) { this._spawnEffect(x, y, z, EXPLOSION_FRAMES, 60, true); }
    createTeleportFog(x, z, y) { this._spawnEffect(x, y, z, TFOG_FRAMES, 45, false); }

    _spawnEffect(x, y, z, frames, frameMs, centered) {
        this.effects.push({ x, y, z, frames, frameMs, centered, start: performance.now() });
    }

    createCorpse(x, y, floorZ, sectorIndex, playerIndex, gib) {
        const variant = PLAYER_CORPSE_VARIANT[playerIndex] ?? '';
        this.statics.push({
            x, y, floorZ,
            light: this._sectorLight[sectorIndex] ?? 200,
            name: (gib ? 'PLAYW0' : 'PLAYN0') + variant,
        });
    }

    setDoorState(sectorIndex, doorState) {
        const door = this.doors.get(sectorIndex);
        if (door) door.target = doorState === 'open' ? door.open : door.closed;
    }

    /** Advance door animations and refresh the wall / ceiling overrides
     *  they drive. Called once per frame with the elapsed seconds. */
    _updateDoors(dt) {
        for (const door of this.doors.values()) {
            if (door.current !== door.target) {
                const dir = Math.sign(door.target - door.current);
                door.current += dir * DOOR_SPEED * dt;
                if ((dir > 0 && door.current > door.target)
                    || (dir < 0 && door.current < door.target)) {
                    door.current = door.target;
                }
                const offset = door.current - door.closed;
                for (const w of door.faceWalls) this._wallBottomOffset.set(w, offset);
                if (door.sectorPoly) this._ceilOverride.set(door.sectorPoly, door.current);
            }
        }
    }

    createPlayerSprite(thingIndex, playerIndex, x, y, floorZ /* , sectorIndex */) {
        if (this.things.has(thingIndex)) return;   // idempotent
        this.things.set(thingIndex, {
            type: -1,
            category: 'player',
            x, y, floorZ,
            light: 220,
            isEnemy: true,
            anim: PLAYER_ANIM,
            fixedName: 'PLAYA1',
            rotation: 1,
            facing: 0,
            state: 'idle',
            collected: false,
            deathStart: 0,
            walkPhase: Math.random() * 1000,
            playerIndex,
        });
    }

    // ── Per-frame entry point ────────────────────────────────────────────

    render(camera) {
        const { W, H, fb, zb } = this;
        if (!fb) return;

        fb.fill(0xFF000000);
        zb.fill(Infinity);

        const now = performance.now();
        const dt = this._lastFrameTime ? Math.min(0.1, (now - this._lastFrameTime) / 1000) : 0;
        this._lastFrameTime = now;
        this._updateDoors(dt);

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
        this._renderFlats(cam);
        this._renderEntities(cam);
    }

    // ── Sky backdrop ─────────────────────────────────────────────────────
    //
    // DOOM treats the sky as an infinitely distant backdrop, not a
    // ceiling surface: every sky column is painted from the top of the
    // screen down to the horizon, and the world (walls, floors, real
    // ceilings) is then drawn over it. We do the same — fill the upper
    // half with the sky at a sentinel far depth, so any later geometry
    // overwrites it via the depth test, and whatever stays uncovered
    // (the openings above walls in sky sectors) reads as sky. This side-
    // steps the projected-ceiling-polygon coverage problem for tall sky
    // sectors and keeps the sky locked to the view angle.
    _renderSky(cam) {
        const sky = getSkyTexture();
        if (!sky) return;
        const { W, H, fb, zb } = this;
        const { angle, halfH } = cam;
        const skyW = sky.width, skyH = sky.height, sdata = sky.data;
        const colAngle = this._colAngle;
        const uBase = (angle / (Math.PI * 2)) * skyW * 4;
        const hY = Math.min(H, Math.ceil(halfH));
        for (let y = 0; y < hY; y++) {
            // Top of screen → top of texture; horizon → bottom of
            // texture, so the dark lower band sits at the horizon.
            const sv = Math.min(skyH - 1, ((y / halfH) * skyH) | 0);
            const row = sv * skyW;
            const base = y * W;
            for (let x = 0; x < W; x++) {
                let u = uBase - (colAngle[x] / (Math.PI * 2)) * skyW * 4;
                u %= skyW;
                if (u < 0) u += skyW;
                fb[base + x] = sdata[row + (u | 0)] | 0xFF000000;
                zb[base + x] = SKY_DEPTH;
            }
        }
    }

    // ── Walls ────────────────────────────────────────────────────────────

    _renderWalls(cam) {
        const { W, H, fb, zb } = this;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;

        for (const wall of this.walls) {
            const tex = getWallTexture(wall.texture);
            if (!tex) continue;

            const ax = wall.start.x, ay = wall.start.y;
            const bx = wall.end.x, by = wall.end.y;
            const dx = bx - ax, dy = by - ay;

            // Back-face cull. Each exported quad is one visible surface
            // whose textured face looks into its sector; given the
            // exporter's winding that front normal is (dy, -dx). Skip
            // walls whose front faces away from the camera. This stops a
            // two-sided surface (door panel, sky upper wall, masked
            // mid-texture) from painting its hidden back face over the
            // visible one, and lets the sky show through upper openings
            // instead of a dark wall.
            const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
            if ((ex - mx) * dy - (ey - my) * dx <= 0) continue;

            // Camera-space endpoints.
            let c1x = (ax - ex) * ca + (ay - ey) * sa;
            let c1y = ca * (ay - ey) - sa * (ax - ex);
            let c2x = (bx - ex) * ca + (by - ey) * sa;
            let c2y = ca * (by - ey) - sa * (bx - ex);

            let u1 = wall.xOffset || 0;
            let u2 = u1 + Math.hypot(dx, dy);

            // Near-plane clip (carry the U coordinate along).
            if (c1y < NEAR && c2y < NEAR) continue;
            if (c1y < NEAR) {
                const t = (NEAR - c1y) / (c2y - c1y);
                c1x += (c2x - c1x) * t;
                u1 += (u2 - u1) * t;
                c1y = NEAR;
            } else if (c2y < NEAR) {
                const t = (NEAR - c2y) / (c1y - c2y);
                c2x += (c1x - c2x) * t;
                u2 += (u1 - u2) * t;
                c2y = NEAR;
            }

            // Door panels raise their bottom edge as the door opens.
            const wallBottom = wall.bottomHeight + (this._wallBottomOffset.get(wall) || 0);
            const topZ = wall.topHeight - ez;
            const botZ = wallBottom - ez;

            let p1 = halfW + (c1x / c1y) * sxScale;
            let p2 = halfW + (c2x / c2y) * sxScale;
            let yt1 = halfH - (topZ / c1y) * syScale;
            let yb1 = halfH - (botZ / c1y) * syScale;
            let yt2 = halfH - (topZ / c2y) * syScale;
            let yb2 = halfH - (botZ / c2y) * syScale;
            let inv1 = 1 / c1y, inv2 = 1 / c2y;
            let uo1 = u1 * inv1, uo2 = u2 * inv2;

            if (p1 > p2) {
                let s;
                s = p1; p1 = p2; p2 = s;
                s = yt1; yt1 = yt2; yt2 = s;
                s = yb1; yb1 = yb2; yb2 = s;
                s = inv1; inv1 = inv2; inv2 = s;
                s = uo1; uo1 = uo2; uo2 = s;
            }

            const xs = Math.max(0, Math.ceil(p1 - 0.5));
            const xe = Math.min(W - 1, Math.floor(p2 - 0.5));
            if (xs > xe) continue;

            const span = p2 - p1 || 1e-6;
            const texW = tex.width, texH = tex.height, tdata = tex.data;
            const wallH = wall.topHeight - wallBottom;
            const yOff = wall.yOffset || 0;

            // Fake contrast: E/W walls darker, N/S walls brighter.
            let baseLight = wall.lightLevel;
            baseLight += Math.abs(dx) > Math.abs(dy) ? -16 : 16;

            for (let x = xs; x <= xe; x++) {
                const t = (x + 0.5 - p1) / span;
                const inv = inv1 + (inv2 - inv1) * t;
                const cy = 1 / inv;
                const u = (uo1 + (uo2 - uo1) * t) / inv;

                let texX = u % texW;
                if (texX < 0) texX += texW;
                texX |= 0;
                if (texX >= texW) texX = texW - 1;

                const ytop = yt1 + (yt2 - yt1) * t;
                const ybot = yb1 + (yb2 - yb1) * t;
                const colH = ybot - ytop;
                if (colH <= 0) continue;

                const y0 = Math.max(0, Math.ceil(ytop - 0.5));
                const y1 = Math.min(H - 1, Math.floor(ybot - 0.5));
                if (y0 > y1) continue;

                const lf = lightFor(baseLight, cy);
                const col = texX;
                const invColH = 1 / colH;

                for (let y = y0; y <= y1; y++) {
                    const idx = y * W + x;
                    if (cy >= zb[idx]) continue;
                    const frac = (y + 0.5 - ytop) * invColH;
                    let v = frac * wallH + yOff;
                    v %= texH;
                    if (v < 0) v += texH;
                    let texY = v | 0;
                    if (texY >= texH) texY = texH - 1;
                    const texel = tdata[texY * texW + col];
                    if ((texel >>> 24) < 128) continue;
                    fb[idx] = shade(texel, lf);
                    zb[idx] = cy;
                }
            }
        }
    }

    // ── Floors & ceilings ────────────────────────────────────────────────

    _renderFlats(cam) {
        for (const sector of this.sectorPolygons) {
            // Door sectors animate their ceiling height as they open.
            const ceilingHeight = this._ceilOverride.get(sector) ?? sector.ceilingHeight;
            if (ceilingHeight <= sector.floorHeight) continue;

            const floorTex = getFlatTexture(sector.floorTexture);
            if (floorTex) {
                this._drawPlane(cam, sector.boundaries, sector.floorHeight,
                    floorTex, sector.lightLevel);
            }
            // Sky ceilings are painted by the backdrop pass, not here.
            if (sector.ceilingTexture === 'F_SKY1') continue;
            const ceilTex = getFlatTexture(sector.ceilingTexture);
            if (ceilTex) {
                this._drawPlane(cam, sector.boundaries, ceilingHeight,
                    ceilTex, sector.lightLevel);
            }
        }
    }

    _drawPlane(cam, boundaries, planeZ, tex, lightLevel) {
        const { W, H, fb, zb } = this;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;
        const cz = planeZ - ez;
        if (Math.abs(cz) < 0.01) return;   // plane at eye level — no coverage

        // Clip every boundary loop to the near plane and project to
        // screen. Edges from all loops feed one even-odd scanline fill,
        // which makes holes (hasHoles sectors) just work.
        const edges = [];   // flat [x0,y0,x1,y1, ...]
        let minY = Infinity, maxY = -Infinity;
        let anyVisible = false;

        for (const loop of boundaries) {
            if (!loop || loop.length < 3) continue;
            const n = loop.length;
            const screen = [];
            for (let i = 0; i < n; i++) {
                const cur = loop[i];
                const nxt = loop[(i + 1) % n];
                const cux = (cur.x - ex) * ca + (cur.y - ey) * sa;
                const cuy = ca * (cur.y - ey) - sa * (cur.x - ex);
                const cnx = (nxt.x - ex) * ca + (nxt.y - ey) * sa;
                const cny = ca * (nxt.y - ey) - sa * (nxt.x - ex);
                const curIn = cuy >= NEAR;
                const nxtIn = cny >= NEAR;
                if (curIn) {
                    screen.push(halfW + (cux / cuy) * sxScale,
                                halfH - (cz / cuy) * syScale);
                }
                if (curIn !== nxtIn) {
                    const t = (NEAR - cuy) / (cny - cuy);
                    const ix = cux + (cnx - cux) * t;
                    screen.push(halfW + (ix / NEAR) * sxScale,
                                halfH - (cz / NEAR) * syScale);
                }
            }
            if (screen.length < 6) continue;
            anyVisible = true;
            for (let i = 0; i < screen.length; i += 2) {
                const x0 = screen[i], y0 = screen[i + 1];
                const j = (i + 2) % screen.length;
                const x1 = screen[j], y1 = screen[j + 1];
                edges.push(x0, y0, x1, y1);
                if (y0 < minY) minY = y0;
                if (y0 > maxY) maxY = y0;
            }
        }
        if (!anyVisible) return;

        const yTop = Math.max(0, Math.ceil(minY - 0.5));
        const yBot = Math.min(H - 1, Math.floor(maxY - 0.5));
        if (yTop > yBot) return;

        const texW = tex.width;
        const texH = tex.height;
        const tdata = tex.data;

        const xsBuf = this._xsBuf || (this._xsBuf = new Float32Array(64));

        for (let y = yTop; y <= yBot; y++) {
            const yc = y + 0.5;

            // Collect scanline/edge intersections.
            let count = 0;
            for (let e = 0; e < edges.length; e += 4) {
                const ay = edges[e + 1], by = edges[e + 3];
                if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
                    const ax = edges[e], bx = edges[e + 2];
                    const x = ax + (bx - ax) * ((yc - ay) / (by - ay));
                    if (count < xsBuf.length) xsBuf[count++] = x;
                }
            }
            if (count < 2) continue;

            // Insertion sort (spans are short).
            for (let i = 1; i < count; i++) {
                const v = xsBuf[i];
                let j = i - 1;
                while (j >= 0 && xsBuf[j] > v) { xsBuf[j + 1] = xsBuf[j]; j--; }
                xsBuf[j + 1] = v;
            }

            // Plane distance depends only on the row, so do the divide
            // once: every pixel on this scanline of a horizontal plane is
            // the same distance away.
            const denomY = halfH - yc;
            const rowDepth = (cz * syScale) / denomY;
            if (rowDepth < NEAR || rowDepth > MAX_DIST) continue;
            const lf = lightFor(lightLevel, rowDepth);
            const base = y * W;

            for (let s = 0; s + 1 < count; s += 2) {
                const xL = Math.max(0, Math.ceil(xsBuf[s] - 0.5));
                const xR = Math.min(W - 1, Math.floor(xsBuf[s + 1] - 0.5));
                for (let x = xL; x <= xR; x++) {
                    const idx = base + x;
                    if (rowDepth >= zb[idx]) continue;

                    // Back-project this pixel onto the plane.
                    const cx = (x + 0.5 - halfW) * rowDepth / sxScale;
                    const relX = ca * cx - sa * rowDepth;
                    const relY = sa * cx + ca * rowDepth;
                    const wx = relX + ex;
                    const wy = relY + ey;
                    let tx = (wx | 0) % texW; if (tx < 0) tx += texW;
                    let ty = (wy | 0) % texH; if (ty < 0) ty += texH;
                    const texel = tdata[ty * texW + tx];
                    fb[idx] = shade(texel, lf);
                    zb[idx] = rowDepth;
                }
            }
        }
    }

    // ── Entities (billboards: things, projectiles, effects) ──────────────

    _renderEntities(cam) {
        const now = performance.now();

        // Static decorations + corpses.
        for (const s of this.statics) {
            const tex = getSpriteTexture(s.name);
            if (tex && tex.width > 1) {
                this._drawBillboard(cam, s.x, s.y, s.floorZ, tex, s.light, false, false);
            }
        }

        // Game-driven things (enemies, pickups, barrels, players).
        for (const e of this.things.values()) {
            if (e.collected) continue;
            // Don't draw this viewer's own player billboard.
            if (e.playerIndex !== undefined && e.playerIndex === this.viewerPlayerIndex) continue;
            const spr = this._thingSprite(e, now);
            if (!spr) continue;
            const tex = getSpriteTexture(spr.name);
            if (!tex || tex.width <= 1) continue;
            this._drawBillboard(cam, e.x, e.y, e.floorZ, tex, e.light, spr.mirror, false);
        }

        // Projectiles — linear interpolation start → end over duration.
        for (const [id, p] of this.projectiles) {
            const t = (now - p.start) / (p.duration * 1000);
            if (t >= 1) { this.projectiles.delete(id); continue; }
            const tex = getSpriteTexture(p.sprite);
            if (tex && tex.width > 1) {
                this._drawBillboard(cam,
                    p.sx + (p.ex - p.sx) * t,
                    p.sy + (p.ey - p.sy) * t,
                    p.sz + (p.ez - p.sz) * t,
                    tex, 250, false, true);
            }
        }

        // Transient effects — advance frames, drop when finished.
        for (let i = this.effects.length - 1; i >= 0; i--) {
            const fx = this.effects[i];
            const frame = ((now - fx.start) / fx.frameMs) | 0;
            if (frame >= fx.frames.length) { this.effects.splice(i, 1); continue; }
            const tex = getSpriteTexture(fx.frames[frame]);
            if (tex && tex.width > 1) {
                this._drawBillboard(cam, fx.x, fx.y, fx.z, tex, 250, false, fx.centered);
            }
        }
    }

    /** Current sprite frame + mirror flag for a thing entry. */
    _thingSprite(e, now) {
        if (!e.isEnemy) return { name: e.fixedName, mirror: false };
        const anim = e.anim;

        if (e.state === 'dead' && anim.death) {
            const fr = anim.death;
            const idx = e.deathStart < 0
                ? fr.length - 1                                  // instant: rest frame
                : Math.min(fr.length - 1, ((now - e.deathStart) / DEATH_FRAME_MS) | 0);
            return { name: `${anim.spr}${fr[idx]}0`, mirror: false };
        }

        const frame = e.state === 'attack' ? anim.attack
            : e.state === 'idle' ? anim.walk[0]
            : anim.walk[(((now + e.walkPhase) / WALK_FRAME_MS) | 0) % anim.walk.length];
        return buildRotName(anim.spr, frame, e.rotation);
    }

    /**
     * Draw a camera-facing billboard. `centered` floats the sprite about
     * `z` (projectiles, puffs, explosions); otherwise it stands on `z`
     * (things, corpses, fog). `mirror` flips it horizontally for the
     * reused rotation art.
     */
    _drawBillboard(cam, wx, wy, z, tex, level, mirror, centered) {
        const { W, H, fb, zb } = this;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;

        const cx = (wx - ex) * ca + (wy - ey) * sa;
        const cy = ca * (wy - ey) - sa * (wx - ex);
        if (cy < NEAR || cy > MAX_DIST) return;

        const sw = tex.width, sh = tex.height, sdata = tex.data;
        const halfWorld = sw * 0.5;

        const pxL = halfW + ((cx - halfWorld) / cy) * sxScale;
        const pxR = halfW + ((cx + halfWorld) / cy) * sxScale;
        const topZ = (centered ? z + sh * 0.5 : z + sh) - ez;
        const botZ = (centered ? z - sh * 0.5 : z) - ez;
        const pyTop = halfH - (topZ / cy) * syScale;
        const pyBot = halfH - (botZ / cy) * syScale;

        const x0 = Math.max(0, Math.ceil(pxL - 0.5));
        const x1 = Math.min(W - 1, Math.floor(pxR - 0.5));
        const y0 = Math.max(0, Math.ceil(pyTop - 0.5));
        const y1 = Math.min(H - 1, Math.floor(pyBot - 0.5));
        if (x0 > x1 || y0 > y1) return;

        const invW = sw / (pxR - pxL || 1e-6);
        const invH = sh / (pyBot - pyTop || 1e-6);
        const lf = lightFor(level, cy);

        for (let y = y0; y <= y1; y++) {
            const ty = ((y + 0.5 - pyTop) * invH) | 0;
            if (ty < 0 || ty >= sh) continue;
            const row = ty * sw;
            const base = y * W;
            for (let x = x0; x <= x1; x++) {
                const idx = base + x;
                // 2-unit lenience so a billboard sits in front of the
                // surface it rests on without z-fighting it.
                if (cy > zb[idx] + 2) continue;
                let tx = ((x + 0.5 - pxL) * invW) | 0;
                if (tx < 0 || tx >= sw) continue;
                if (mirror) tx = sw - 1 - tx;
                const texel = sdata[row + tx];
                if ((texel >>> 24) < 128) continue;
                fb[idx] = shade(texel, lf);
                zb[idx] = cy;
            }
        }
    }

}

// Multiply an ABGR texel by a 0..256 light factor.
function shade(texel, lf) {
    const r = ((texel & 0xff) * lf) >> 8;
    const g = (((texel >> 8) & 0xff) * lf) >> 8;
    const b = (((texel >> 16) & 0xff) * lf) >> 8;
    return 0xff000000 | (b << 16) | (g << 8) | r;
}

// Sector light + distance falloff → 0..256 multiplier, banded.
function lightFor(level, dist) {
    let m = 1 - dist * INV_FADE;
    if (m < LIGHT_FLOOR) m = LIGHT_FLOOR;
    let v = level * m;
    v -= v % LIGHT_BAND;          // colormap-style quantisation
    if (v < 0) v = 0; else if (v > 255) v = 255;
    return LIGHT_LUT[v | 0];
}
