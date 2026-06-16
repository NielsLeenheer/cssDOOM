/**
 * Scene — the mutable world model the SoftwareRenderer draws from.
 *
 * This is the single source of truth for everything the game loop can
 * change: geometry (walls, sector polygons, sector light), entities
 * (statics, things, projectiles, transient effects), and the moving
 * sectors (doors, lifts) with the override maps they drive. It owns the
 * inbound command mutators — the dispatch surface the CanvasRenderer
 * forwards every world / per-player envelope to — and the per-frame
 * simulation (`update`) that advances doors, lifts, light specials and
 * the animation clocks.
 *
 * The render passes (passes/*.js) read this object and never write it;
 * the renderer holds one Scene as `this.scene` and forwards the scene
 * dispatch commands to it (see SCENE_COMMANDS in software.js). That split
 * is the whole point: mutation goes through Scene, rendering is read-only
 * over it.
 *
 * View-side state — the held weapon, the screen flash, the HUD readout
 * and the full-screen intermission / results / lobby screens — is *not*
 * here; it lives on the renderer, because it's per-pane presentation, not
 * world state. Those commands stay in commands.js.
 */

import { THING_SPRITES, PROJECTILE_SPRITES } from '../css/scene/constants.js';
import {
    LIGHT_EFFECT, ENEMY_ANIM, ANIM_FRAME_MS, lightMul,
    DOOR_SPEED, LIFT_SPEED, TAU,
    PLAYER_ANIM, PLAYER_CORPSE_VARIANT,
    BARREL_FRAMES, PUFF_FRAMES, EXPLOSION_FRAMES, TFOG_FRAMES,
} from './tables.js';
import { glowParams } from '../../shared/maps/index.js';

// Command method names the renderer forwards to the Scene. Listed here
// (next to the implementations) so software.js can install the forwarders
// without re-stating the set; keep in sync when adding a world command.
export const SCENE_COMMANDS = [
    'updateThingPosition', 'reparentThingToSector',
    'collectItem', 'uncollectItem',
    'setEnemyState', 'setThingMoving', 'playPlayerAttack',
    'killEnemy', 'resetEnemy', 'updateEnemyRotation',
    'createProjectile', 'removeProjectile',
    'createPuff', 'createExplosion', 'createTeleportFog',
    'createCorpse', 'createPlayerSprite',
    'setMoverState',
];

export class Scene {
    constructor() {
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

        // Which player is viewing this scene's pane. Read by
        // updateEnemyRotation to pick which viewer the 8-way sprite
        // rotation faces; synced from the renderer each frame.
        this.viewerPlayerIndex = 0;

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

        // Sector light specials (flicker / blink / glow / fire).
        this._lightSectors = [];      // [{ sectorIndex, type, phase, seed }]
        this._sectorLightMul = [];    // sectorIndex → current multiplier (default 1)

        // World animation clocks, advanced by update().
        this._animFrame = 0;          // current animated-texture frame
        this._scrollOffset = 0;       // current scrolling-wall texture offset
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
            const entry = {
                sectorIndex: sp.sectorIndex,
                type: eff.type,
                phase: eff.sync ? 0 : Math.random() * 10,
                seed: (sp.sectorIndex * 2654435761) >>> 0,
            };
            if (eff.type === 'glow') {
                // DOOM T_Glow: oscillate the LIGHT LEVEL between maxlight and
                // the darkest neighbour at GLOWSPEED — a per-sector range +
                // speed. minMul is min/max so `lightLevel * mul` reproduces
                // the level; phase 0 because DOOM spawns every glow at max in
                // lock-step (so adjacent glow sectors pulse together).
                const gp = glowParams(sp.sectorIndex);
                entry.minMul = gp && gp.max > 0 ? gp.min / gp.max : 1;
                entry.period = gp ? gp.period : 0;
                entry.phase = 0;
            }
            this._lightSectors.push(entry);
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
        this._polyBySector = polyOf;   // sectorIndex → sectorPolygon, for floorOf()
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
        // upperHeight (its stored, raised state) and lowerHeight. Its boundary
        // walls are ordinary walls in `scene.walls` — the face walls (tagged
        // moverType:'lift') are drawn each frame at the animated `current`
        // height by the wall pass; well-lining walls draw statically. Start raised.
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

            // Things the game simulates carry a gameId — the key the
            // dispatch commands address them by. Register those in the
            // things map so they can move / be collected / die. Passive
            // decorations (no gameId) become static billboards.
            if (t.gameId === undefined) {
                // sectorIndex lets the entity passes pick up the live
                // per-frame light multiplier (pulsing light specials), the
                // same way walls/flats do — without it a decoration on a
                // blinking platform stays at a fixed brightness while the
                // surfaces around it pulse.
                this.statics.push({ x: t.x, y: t.y, light, name, sectorIndex: t.sectorIndex });
                continue;
            }

            const anim = ENEMY_ANIM[t.type] || null;
            this.things.set(t.gameId, {
                type: t.type,
                category: t.category,
                x: t.x,
                y: t.y,
                light,
                sectorIndex: t.sectorIndex,   // live light-special lookup + floorOf()
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

    // ── Per-frame simulation ─────────────────────────────────────────────

    /** Advance moving sectors, light specials and animation clocks.
     *  Called once per frame from the renderer before the passes run. */
    update(dt, now) {
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
    }

    /** Advance door animations and refresh the wall / ceiling overrides
     *  they drive. */
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

    // ── Dispatch commands (game loop → world state) ──────────────────────

    // Current floor of a sector for placing things/effects: a lift's live height
    // (via _floorOverride) else the sector's static floor. Things read this by
    // their sectorIndex rather than carrying a per-thing dispatched floor.
    floorOf(sectorIndex) {
        const poly = this._polyBySector?.get(sectorIndex);
        if (!poly) return 0;
        return this._floorOverride.get(poly) ?? poly.floorHeight ?? 0;
    }

    updateThingPosition(i, x, y) {
        const e = this.things.get(i);
        if (e) { e.x = x; e.y = y; }   // floor comes from floorOf(e.sectorIndex) at draw
    }

    reparentThingToSector(i, sectorIndex) {
        const e = this.things.get(i);
        if (!e) return;
        e.sectorIndex = sectorIndex;   // floorOf() reads the thing's current sector
        const l = this._sectorLight[sectorIndex];
        if (l != null) e.light = l;
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
            this._spawnEffect(e.x, e.y, this.floorOf(e.sectorIndex) + 24, BARREL_FRAMES, 60, true);
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
        if (x !== undefined) { e.x = x; e.y = y; }   // floor via floorOf(e.sectorIndex)
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
            sprite: PROJECTILE_SPRITES[spec.type],
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
            x, y, sectorIndex,
            light: this._sectorLight[sectorIndex] ?? 200,
            name: (gib ? 'PLAYW0' : 'PLAYN0') + variant,
        });
    }

    createPlayerSprite(thingIndex, playerIndex, x, y, floorZ, sectorIndex) {
        if (this.things.has(thingIndex)) return;   // idempotent
        this.things.set(thingIndex, {
            type: -1,
            category: 'player',
            x, y, sectorIndex,
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

    setMoverState(moverType, sectorIndex, value) {
        if (moverType === 'door') {
            const door = this.doors.get(sectorIndex);
            if (door) door.target = value === 'open' ? door.open : door.closed;
        } else if (moverType === 'lift') {
            const lift = this.lifts.get(sectorIndex);
            if (lift) lift.target = value === 'lowered' ? lift.lower : lift.upper;
        }
        // crusher: no canvas crusher records (none in E1) — nothing to drive.
    }
}
