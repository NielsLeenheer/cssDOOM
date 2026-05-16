/**
 * World-state snapshot for late-joining / reconnecting Network DM
 * clients.
 *
 * The joiner's own loadMap rebuilds the scene from scratch — every
 * pickup looks uncollected, every enemy alive, every door at its
 * map-default state. This snapshot lets master tell the joiner "here's
 * what actually happened since match start": dead enemies stay dead,
 * collected pickups stay collected, doors / lifts / crushers at their
 * current state, and player corpses appear at their original death
 * points.
 *
 * The joiner applies the snapshot via existing renderer commands
 * (killEnemy / collectItem / setDoorState / setLiftState /
 * setCrusherOffset / createCorpse / updateThingPosition /
 * reparentThingToSector). Animations are CSS-suppressed during the
 * apply so the catch-up doesn't visibly re-play every death and
 * door-open since match start.
 */

import { state } from './state.js';
import { PICKUPS, ENEMIES } from './constants.js';
import { currentMap } from '../shared/maps.js';
import { getFloorHeightAt } from './physics.js';

/**
 * Build a snapshot of master's current world state. Returns a
 * JSON-cloneable plain object — primitives only, no Map/Set/refs.
 */
export function getWorldSnapshot() {
    return {
        map: currentMap,
        things: snapshotThings(),
        doors: snapshotDoors(),
        lifts: snapshotLifts(),
        crushers: snapshotCrushers(),
        corpses: snapshotCorpses(),
    };
}

function snapshotThings() {
    const out = [];
    for (let gameId = 0; gameId < state.things.length; gameId++) {
        const t = state.things[gameId];
        if (!t) continue;
        // Skip player thing entries — the joiner's local addPlayerThings
        // re-creates these, and the host's beginPlay re-fires
        // createPlayerSprite on connect already. Player position is
        // covered by per-frame updateCamera / updateThingPosition once
        // the match resumes.
        if (t.kind === 'player') continue;

        // `t.floorHeight` is only updated at init / by lifts, NOT by the
        // AI as enemies chase across sectors. Resolve live from coords so
        // a wandered-then-killed enemy lands on the floor it's actually
        // standing on, not the one it spawned over. Matches what ai.js
        // ticks into the renderer via updateThingPosition.
        out.push({
            gameId,
            type: t.type,
            x: t.x,
            y: t.y,
            floorHeight: getFloorHeightAt(t.x, t.y),
            sectorIndex: t.sectorIndex,
            collected: !!t.collected,
            // Differentiates "dead enemy" (killEnemy path) from
            // "collected pickup" (collectItem path) on the joiner.
            category: ENEMIES.has(t.type) ? 'enemy'
                    : t.type === 2035    ? 'barrel'
                    : PICKUPS.has(t.type) ? 'pickup'
                    : 'decoration',
            // Enemy-only — null for everything else.
            facing: t.facing,
        });
    }
    return out;
}

function snapshotDoors() {
    const out = [];
    for (const [sectorIndex, entry] of state.doorState) {
        out.push({ sectorIndex, state: entry.open ? 'open' : 'closed' });
    }
    return out;
}

function snapshotLifts() {
    const out = [];
    for (const [sectorIndex, entry] of state.liftState) {
        // Derive a stable resting state from the target so a lift mid-
        // animation snaps to its endpoint when the joiner applies.
        const liftState = entry.targetHeight === entry.upperHeight ? 'raised' : 'lowered';
        out.push({ sectorIndex, state: liftState });
    }
    return out;
}

function snapshotCrushers() {
    const out = [];
    for (const [sectorIndex, entry] of state.crusherState) {
        out.push({ sectorIndex, offset: entry.currentOffset ?? 0 });
    }
    return out;
}

function snapshotCorpses() {
    // state.deathCorpses is populated by damage.js when a player dies.
    // Each entry is already a plain object suitable for sending over
    // the wire, but copy to insulate against future shape changes.
    return state.deathCorpses.map(c => ({
        x: c.x,
        y: c.y,
        floorHeight: c.floorHeight,
        sectorIndex: c.sectorIndex,
        playerIndex: c.playerIndex,
    }));
}
