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
    getWeaponTexture,
    getHudTexture,
} from './textures.js';
import { THING_SPRITES } from '../dom/scene/constants.js';
import {
    FOV, NEAR, MAX_DIST, SKY_DEPTH, TAU,
    WALK_FRAME_MS, DEATH_FRAME_MS, DOOR_SPEED, LIFT_SPEED,
    LIGHT_EFFECT, ANIM_FRAME_MS, animName,
    WEAPON_INFO, FLASH_COLOR, FLASH_MS,
    BIG_GLYPH_W, BIG_GLYPH_H, SMALL_GLYPH_W, SMALL_GLYPH_H, FACE_W, FACE_H,
    WEAPON_AMMO, HUD_AMMO_TYPES, ARMS_SLOTS, HUD_KEYS,
    ENEMY_ANIM, PLAYER_ANIM, PLAYER_CORPSE_VARIANT,
    itemFrameName, buildRotName,
    PUFF_FRAMES, EXPLOSION_FRAMES, BARREL_FRAMES, TFOG_FRAMES,
    lightMul, shade, lightFor, glyphIndex, skyRow, skyCol,
} from './tables.js';
import { screenMethods } from './screens.js';

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
        // Pixel scale for *full-screen* UI elements (intermission, future
        // results / lobby screens). Scales 1:1 with the render factor so
        // those screens always fill the framebuffer.
        this.screenScale = 1;
        this._animFrame = 0;          // current animated-texture frame
        this._scrollOffset = 0;       // current scrolling-wall texture offset
        this._bobX = 0;
        this._bobY = 0;
        this._lastCamX = null;
        this._lastCamY = null;

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
        // edge upward at the wall's own depth (see _drawWall), so distant
        // geometry behind the opening is depth-rejected, no occluder
        // objects or culling required.
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

    // ── HUD overlay commands ─────────────────────────────────────────────

    switchWeapon(name, fireRate) {
        const info = WEAPON_INFO[name];
        if (!info) { this.weapon = null; return; }
        this.weapon = { name, info, fireRate: fireRate || 400, firing: false, fireStart: 0 };
    }

    startFiring() {
        if (this.weapon) { this.weapon.firing = true; this.weapon.fireStart = performance.now(); }
    }

    stopFiring() {
        if (this.weapon) this.weapon.firing = false;
    }

    triggerFlash(color) {
        const rgb = FLASH_COLOR[color];
        if (rgb) this.flash = { r: rgb[0], g: rgb[1], b: rgb[2], start: performance.now() };
    }

    updateHud(player) {
        if (!player) return;
        this.hud = {
            health: Math.round(player.health ?? 0),
            armor: Math.round(player.armor ?? 0),
            ammo: player.ammo || {},
            maxAmmo: player.maxAmmo || {},
            currentWeapon: player.currentWeapon ?? 2,
            ownedWeapons: new Set(player.ownedWeapons || []),
            keys: new Set(player.collectedKeys || []),
        };
    }

    showIntermission(payload) {
        if (!payload?.stats) return;
        this.intermission = {
            mapName: payload.mapName ?? null,
            stats: payload.stats,
            startTime: performance.now(),
        };
    }

    hideIntermission() {
        this.intermission = null;
    }

    showResults(payload) { this.results = payload || null; }
    hideResults() { this.results = null; }

    // The Game re-fires showLobby AFTER it has transitioned to PLAYING
    // (with inLobby:false) so the DM lobby's per-pane claim overlays can
    // flip 'ready'→'active' — see Game.beginPlay. For this renderer that
    // late fire would otherwise latch the lobby panel back on top of the
    // running world, so treat inLobby:false as a hide, exactly like the
    // DomRenderer's showLobby does.
    showLobby(payload) { this.lobby = payload && payload.inLobby ? payload : null; }
    hideLobby() { this.lobby = null; }

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

    setLiftState(sectorIndex, liftState) {
        const lift = this.lifts.get(sectorIndex);
        if (lift) lift.target = liftState === 'lowered' ? lift.lower : lift.upper;
    }

    /** Advance lift animations: move the platform floor toward its target
     *  and refresh the floor-height override that drives the visplane. */
    _updateLifts(dt) {
        for (const lift of this.lifts.values()) {
            if (lift.current === lift.target) continue;
            const dir = Math.sign(lift.target - lift.current);
            lift.current += dir * LIFT_SPEED * dt;
            if ((dir > 0 && lift.current > lift.target)
                || (dir < 0 && lift.current < lift.target)) {
                lift.current = lift.target;
            }
            if (lift.sectorPoly) this._floorOverride.set(lift.sectorPoly, lift.current);
        }
    }

    /**
     * Draw lift shaft walls. The platform-face walls span from the
     * platform's current height to the floor they face (so they grow as
     * the lift drops); the static shaft sides span the full travel so the
     * shaft isn't see-through once the platform has moved away.
     */
    _renderLiftWalls(cam) {
        for (const lift of this.lifts.values()) {
            for (const wall of lift.shaftWalls) {
                const tex = getWallTexture(wall.texture);
                if (!tex || tex.width <= 1) continue;
                let bottom, top;
                if (wall.isPlatformFace) {
                    const nf = wall.neighborFloor ?? lift.lower;
                    bottom = Math.min(lift.current, nf);
                    top = Math.max(lift.current, nf);
                } else {
                    bottom = wall.neighborFloor !== undefined
                        ? Math.min(wall.neighborFloor, lift.lower) : lift.lower;
                    top = lift.upper;
                }
                if (top - bottom < 0.5) continue;
                const light = wall.lightLevel ?? lift.light;
                this._drawWall(cam, wall, tex, bottom, top, wall.yOffset || 0, light, true);
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

        // Full-screen overlays (lobby before a match, intermission /
        // results between or after) freeze the world and own the whole
        // pane — paint the screen and skip every world / HUD / weapon
        // pass. At most one is ever set; check in display priority.
        if (this.results) { this._renderResults(now); return; }
        if (this.intermission) { this._renderIntermission(now); return; }
        if (this.lobby) { this._renderLobby(now); return; }

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
    }

    // ── HUD status bar ───────────────────────────────────────────────────

    /**
     * Blit a source rectangle of `tex` into the framebuffer, nearest-
     * neighbour scaled to the destination rectangle, alpha-tested. Used
     * for all the screen-space overlay graphics (status bar, digits,
     * face). No depth test — overlays sit on top of the world.
     */
    _blit(tex, sx, sy, sw, sh, dx, dy, dw, dh) {
        const { W, H, fb } = this;
        const data = tex.data, texW = tex.width;
        const x0 = Math.max(0, dx | 0), x1 = Math.min(W, (dx + dw) | 0);
        const y0 = Math.max(0, dy | 0), y1 = Math.min(H, (dy + dh) | 0);
        const ix = sw / dw, iy = sh / dh;
        for (let y = y0; y < y1; y++) {
            const srcY = sy + ((y - dy) * iy | 0);
            const srcRow = srcY * texW;
            const dstRow = y * W;
            for (let x = x0; x < x1; x++) {
                const srcX = sx + ((x - dx) * ix | 0);
                const texel = data[srcRow + srcX];
                if ((texel >>> 24) < 128) continue;
                fb[dstRow + x] = texel | 0xff000000;
            }
        }
    }

    _renderHud(now) {
        const hud = this.hud;
        if (!hud) return;
        const stbar = getHudTexture('STBAR');
        if (!stbar || stbar.width <= 1) return;

        const { W, H } = this;
        // Draw the bar at its native 320×32 resolution times uiScale,
        // bottom-centred. Narrower framebuffers clip the sides rather
        // than downscaling the bar; at higher resolutions the bar grows
        // with the framebuffer so its relative on-screen size is the
        // same as at 1x.
        const scale = this.uiScale;
        const barW = 320 * scale;
        const barH = 32 * scale;
        const barY = H - barH;
        const barX = Math.round((W - barW) / 2);   // negative → sides clip
        const dx = nx => barX + nx * scale;
        const dy = ny => barY + ny * scale;

        // Bar background.
        this._blit(stbar, 0, 0, 320, 32, barX, barY, barW, barH);

        const digits = getHudTexture('DIGITS_SHEET');

        // Big number, right-aligned so its last glyph ends at native xR.
        const bigNum = (str, xR, yT) => {
            if (!digits || digits.width <= 1) return;
            let x = xR;
            for (let i = str.length - 1; i >= 0; i--) {
                const g = glyphIndex(str[i]);
                if (g < 0) continue;
                x -= BIG_GLYPH_W;
                this._blit(digits, g * BIG_GLYPH_W, 0, BIG_GLYPH_W, BIG_GLYPH_H,
                    dx(x), dy(yT), BIG_GLYPH_W * scale, BIG_GLYPH_H * scale);
            }
        };

        // Ammo (current weapon), health, armor.
        // Right-edge anchors follow cssDOOM's STBAR section layout
        // (ammo 0-48, health 48-106, armor 179-236).
        const ammoType = WEAPON_AMMO[hud.currentWeapon];
        if (ammoType) bigNum(String(Math.round(hud.ammo[ammoType] ?? 0)), 44, 3);
        bigNum(`${hud.health}%`, 104, 3);
        bigNum(`${hud.armor}%`, 235, 3);

        // Per-type ammo: current (right edge 288) and max (right edge 314),
        // four rows 6px apart from y=5.
        const small = getHudTexture('SMALL_DIGITS_SHEET');
        if (small && small.width > 1) {
            const smallNum = (str, xR, yT) => {
                let x = xR;
                for (let i = str.length - 1; i >= 0; i--) {
                    const g = glyphIndex(str[i]);
                    if (g < 0 || g > 9) continue;
                    x -= SMALL_GLYPH_W;
                    this._blit(small, g * SMALL_GLYPH_W, 0, SMALL_GLYPH_W, SMALL_GLYPH_H,
                        dx(x), dy(yT), SMALL_GLYPH_W * scale, SMALL_GLYPH_H * scale);
                }
            };
            for (let i = 0; i < HUD_AMMO_TYPES.length; i++) {
                const t = HUD_AMMO_TYPES[i];
                const yT = 5 + i * 6;
                smallNum(String(Math.round(hud.ammo[t] ?? 0)), 288, yT);
                smallNum(String(hud.maxAmmo[t] ?? 0), 314, yT);
            }
        }

        // Arms panel (weapon ownership): the ARMS background plus a per-
        // slot number — yellow STYSNUM if owned, grey STGNUM otherwise.
        const arms = getHudTexture('STARMS');
        if (arms && arms.width > 1) {
            this._blit(arms, 0, 0, 40, 32, dx(104), dy(0), 40 * scale, 32 * scale);
            for (const s of ARMS_SLOTS) {
                const owned = hud.ownedWeapons.has(s.slot);
                const glyph = getHudTexture(`${owned ? 'STYSNUM' : 'STGNUM'}${s.slot}`);
                if (!glyph || glyph.width <= 1) continue;
                this._blit(glyph, 0, 0, 4, 6, dx(s.x), dy(s.y), 4 * scale, 6 * scale);
            }
        }

        // Face: row by health band, column animates while alive.
        const face = getHudTexture('FACE_SHEET');
        if (face && face.width > 1) {
            const h = hud.health;
            const row = h >= 80 ? 0 : h >= 60 ? 1 : h >= 40 ? 2 : h >= 20 ? 3 : 4;
            const col = h <= 0 ? 0 : ((now / 500) | 0) % 3;
            this._blit(face, col * FACE_W, row * FACE_H, FACE_W, FACE_H,
                dx(143 + (36 - FACE_W) / 2), dy(1), FACE_W * scale, FACE_H * scale);
        }

        // Collected keycards: 7×5 icons stacked in the keys section
        // (native x 236-249), centred horizontally and spaced down the bar.
        for (let i = 0; i < HUD_KEYS.length; i++) {
            if (!hud.keys.has(HUD_KEYS[i].color)) continue;
            const icon = getHudTexture(HUD_KEYS[i].icon);
            if (!icon || icon.width <= 1) continue;
            this._blit(icon, 0, 0, 7, 5,
                dx(239), dy(4 + i * 9), 7 * scale, 5 * scale);
        }
    }

    // ── HUD overlay: weapon sprite + screen flash ────────────────────────

    _renderWeapon(cam, now, dt) {
        const wpn = this.weapon;
        if (!wpn) return;
        const tex = getWeaponTexture(wpn.name);
        if (!tex || tex.width <= 1) return;
        const { fw, fh, frames } = wpn.info;

        // Pick the frame: idle (0) unless mid fire animation.
        let frame = 0;
        if (wpn.firing) {
            const e = now - wpn.fireStart;
            if (e < wpn.fireRate) {
                frame = 1 + Math.min(frames - 2, ((e / wpn.fireRate) * (frames - 1)) | 0);
            }
        }

        // Weapon bob: a small figure-eight that builds while the view is
        // moving and eases back to centre when it stops.
        const moving = this._lastCamX !== null
            && (Math.abs(cam.ex - this._lastCamX) > 0.5 || Math.abs(cam.ey - this._lastCamY) > 0.5);
        this._lastCamX = cam.ex;
        this._lastCamY = cam.ey;
        const targetMag = moving ? 1 : 0;
        const phase = (now / 1000) * 6;
        const ease = 6 * dt;
        this._bobX += ((Math.cos(phase) * 5 * targetMag) - this._bobX) * Math.min(1, ease);
        this._bobY += ((Math.abs(Math.sin(phase)) * 4 * targetMag) - this._bobY) * Math.min(1, ease);

        const { W, H } = this;
        const ui = this.uiScale;
        const destW = fw * ui, destH = fh * ui;
        const destX = Math.round((W - destW) / 2 + this._bobX * ui);
        const destY = Math.round(H - destH + this._bobY * ui);
        this._blit(tex, frame * fw, 0, fw, fh, destX, destY, destW, destH);
    }

    _renderFlash(now) {
        if (!this.flash) return;
        const e = now - this.flash.start;
        if (e >= FLASH_MS) { this.flash = null; return; }
        const a = 0.35 * (1 - e / FLASH_MS);
        const ia = 1 - a;
        const fr = this.flash.r * a, fg = this.flash.g * a, fb_ = this.flash.b * a;
        const { fb } = this;
        for (let i = 0, n = fb.length; i < n; i++) {
            const px = fb[i];
            const r = ((px & 0xff) * ia + fr) | 0;
            const g = (((px >> 8) & 0xff) * ia + fg) | 0;
            const b = (((px >> 16) & 0xff) * ia + fb_) | 0;
            fb[i] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
    }

    // ── Sky ───────────────────────────────────────────────────────────────
    //
    // The sky is the ceiling of whichever sky sector you're looking at.
    // We first lay it down as a full-frame backdrop at a sentinel far
    // depth (so any solid geometry overwrites it), then in the wall pass a
    // wall under a sky ceiling repaints the sky above its top edge at the
    // wall's own depth — exactly the front sector's ceiling visplane —
    // which is what makes distant geometry behind a sky opening disappear
    // (DOOM r_plane: the sky plane is drawn opaquely above the segs).
    //
    // DOOM draws the sky at a fixed vertical scale (≈1 texel per row at
    // 200px tall) anchored so the texture's mountain base sits at the
    // horizon; the params are stashed in `_skyCtx` so the wall pass paints
    // it identically. (Stretching the whole texture to the horizon
    // dragged SKY1's dark lower rows up into a fat band above the walls.)
    _renderSky(cam) {
        const sky = getSkyTexture();
        if (!sky) { this._skyCtx = null; return; }
        const { W, H, fb, zb } = this;
        const { angle, halfH } = cam;
        const skyW = sky.width, skyH = sky.height, sdata = sky.data;
        const colAngle = this._colAngle;
        const ctx = this._skyCtx = {
            sdata, skyW, skyH, colAngle, halfH,
            uBase: (angle / (Math.PI * 2)) * skyW * 4,
            iscale: 200 / H,
            skyHorizon: skyH - 28,
            twoPi: Math.PI * 2,
        };
        for (let y = 0; y < H; y++) {
            const sv = skyRow(ctx, y);
            const row = sv * skyW;
            const base = y * W;
            for (let x = 0; x < W; x++) {
                fb[base + x] = sdata[row + skyCol(ctx, x)] | 0xFF000000;
                zb[base + x] = SKY_DEPTH;
            }
        }
    }

    // ── Walls ────────────────────────────────────────────────────────────

    _renderWalls(cam) {
        for (const wall of this.walls) {
            // Lift boundary walls are drawn by _renderLiftWalls at the
            // animated platform height; skip them here so the static and
            // moving copies don't z-fight (matches the DOM's buildWalls).
            if (wall.isLiftWall) continue;
            const tex = getWallTexture(animName(wall.texture, this._animFrame));
            if (!tex) continue;

            // Door panels raise their bottom edge as the door opens;
            // track jambs override their (zero) top to the travel span.
            const bottomOffset = this._wallBottomOffset.get(wall) || 0;
            const wallBottom = wall.bottomHeight + bottomOffset;
            const wallTop = this._wallTopOverride.get(wall) ?? wall.topHeight;
            // Adding the door's rise to the vertical texture offset pins
            // the panel texture to its moving bottom edge, so the door
            // texture slides up with the panel instead of squashing.
            const yOff = (wall.yOffset || 0) + bottomOffset;
            const light = wall.lightLevel * (this._sectorLightMul[wall.sectorIndex] ?? 1);

            // If this wall reaches its sector's sky ceiling, the area above
            // its top edge is that sector's sky — paint it at the wall's
            // depth so it occludes whatever lies beyond the opening.
            const skyCeil = this._skyCeil.get(wall.sectorIndex);
            const skyAbove = skyCeil !== undefined && Math.abs(wallTop - skyCeil) < 1;

            this._drawWall(cam, wall, tex, wallBottom, wallTop, yOff, light, false, skyAbove);
        }
    }

    /**
     * Rasterise one textured wall quad: back-face cull, transform to
     * camera space, near-plane clip, project, then fill each screen
     * column with a perspective-correct textured strip, depth-tested.
     */
    _drawWall(cam, wall, tex, wallBottom, wallTop, yOff, baseLight, noCull = false, skyAbove = false) {
        const { W, H, fb, zb } = this;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;

        const ax = wall.start.x, ay = wall.start.y;
        const bx = wall.end.x, by = wall.end.y;
        const dx = bx - ax, dy = by - ay;

        // Back-face cull against the front normal (dy, -dx). Lift shaft
        // walls opt out (noCull): their winding isn't guaranteed to face
        // the viewer and the depth buffer resolves any overdraw. Use a
        // strict `< 0` test (not `<= 0`) so that a wall the camera lies
        // *exactly* on its line still draws — the player can hug a wall
        // and the cull math then evaluates to 0, which is the boundary
        // between front- and back-facing and should be treated as visible.
        if (!noCull) {
            const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
            if ((ex - mx) * dy - (ey - my) * dx < 0) return;
        }

        let c1x = (ax - ex) * ca + (ay - ey) * sa;
        let c1y = ca * (ay - ey) - sa * (ax - ex);
        let c2x = (bx - ex) * ca + (by - ey) * sa;
        let c2y = ca * (by - ey) - sa * (bx - ex);

        let u1 = (wall.xOffset || 0) + (wall.isScrolling ? this._scrollOffset : 0);
        let u2 = u1 + Math.hypot(dx, dy);

        if (c1y < NEAR && c2y < NEAR) return;
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

        const topZ = wallTop - ez;
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
        if (xs > xe) return;

        const span = p2 - p1 || 1e-6;
        const texW = tex.width, texH = tex.height, tdata = tex.data;
        const wallH = wallTop - wallBottom;

        // Fake contrast: E/W walls darker, N/S walls brighter.
        const light = baseLight + (Math.abs(dx) > Math.abs(dy) ? -16 : 16);
        const skyCtx = skyAbove ? this._skyCtx : null;

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

            // Ceiling visplane: paint this sector's sky above the wall top
            // at the wall's depth, occluding anything farther in the column.
            if (skyCtx) {
                const skyEnd = Math.min(H, Math.ceil(ytop - 0.5));
                const sCol = skyCol(skyCtx, x);
                for (let y = 0; y < skyEnd; y++) {
                    const idx = y * W + x;
                    if (cy >= zb[idx]) continue;
                    fb[idx] = skyCtx.sdata[skyRow(skyCtx, y) * skyCtx.skyW + sCol] | 0xff000000;
                    zb[idx] = cy;
                }
            }

            const colH = ybot - ytop;
            if (colH <= 0) continue;

            const y0 = Math.max(0, Math.ceil(ytop - 0.5));
            const y1 = Math.min(H - 1, Math.floor(ybot - 0.5));
            if (y0 > y1) continue;

            const lf = lightFor(light, cy);
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

    // ── Floors & ceilings ────────────────────────────────────────────────

    _renderFlats(cam) {
        for (const sector of this.sectorPolygons) {
            // Doors animate their ceiling height; lifts animate their floor.
            const ceilingHeight = this._ceilOverride.get(sector) ?? sector.ceilingHeight;
            const floorHeight = this._floorOverride.get(sector) ?? sector.floorHeight;
            if (ceilingHeight <= floorHeight) continue;

            const light = sector.lightLevel * (this._sectorLightMul[sector.sectorIndex] ?? 1);
            const floorTex = getFlatTexture(animName(sector.floorTexture, this._animFrame));
            if (floorTex) {
                this._drawPlane(cam, sector.boundaries, floorHeight, floorTex, light);
            }
            // Sky ceilings are painted by the backdrop pass, not here.
            if (sector.ceilingTexture === 'F_SKY1') continue;
            const ceilTex = getFlatTexture(animName(sector.ceilingTexture, this._animFrame));
            if (ceilTex) {
                this._drawPlane(cam, sector.boundaries, ceilingHeight, ceilTex, light);
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

        // Static decorations + corpses (some decorations idle-animate).
        for (const s of this.statics) {
            const tex = getSpriteTexture(itemFrameName(s.name, now));
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
        if (!e.isEnemy) return { name: itemFrameName(e.fixedName, now), mirror: false };
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

// Mix the full-screen overlay screens (intermission / results / lobby)
// and their text helpers onto the prototype — kept in screens.js to keep
// this file focused on world + entity rasterisation and per-frame state.
Object.assign(SoftwareRenderer.prototype, screenMethods);
