/**
 * State-side init for things. Reads the enriched `mapData.things`
 * (built by `src/shared/maps/things.js::initThings`) and pushes
 * simulation state entries into `state.things` at their assigned
 * `gameId` positions.
 *
 * Decorations don't have a `gameId` — they're rendered but not
 * simulated, so they don't appear in `state.things`.
 *
 * Called by `Level.load()` after `maps.load(name)` has run the
 * enrichment pass.
 */

import { mapData } from '../../shared/maps/index.js';
import { state } from '../state.js';
import {
    THING_HEALTH, ENEMY_AI_STATS, LINE_OF_SIGHT_CHECK_INTERVAL,
    SHOOTABLE, SOLID_THING_RADIUS,
} from '../../shared/constants.js';

export function initThingsState() {
    state.things.length = 0;
    if (!mapData.things) return;

    for (const thing of mapData.things) {
        // Filtered out by skill / MP-only flag — enrichment left it
        // without a `category` field. Decorations have a category
        // but no `gameId` — they're rendered but not simulated.
        if (thing.category === undefined) continue;
        if (thing.gameId === undefined) continue;

        const entry = {
            x: thing.x,
            y: thing.y,
            type: thing.type,
            collected: false,
            hp: THING_HEALTH[thing.type] || 0,
            // Remembered so lifts.js can push a fresh floorHeight into
            // dead things sitting on a moving platform — live enemies
            // get this every AI tick via getFloorHeightAt, but corpses
            // stop ticking and would otherwise hang in mid-air.
            sectorIndex: thing.sectorIndex,
            floorHeight: thing.floorHeight,
        };

        // Solid decorations: store collision radius for canMoveTo() checks.
        // Based on: linuxdoom-1.10/info.c — MF_SOLID decorations block movement.
        if (SOLID_THING_RADIUS[thing.type] && !SHOOTABLE.has(thing.type)) {
            entry.solidRadius = SOLID_THING_RADIUS[thing.type];
        }

        const aiStats = ENEMY_AI_STATS[thing.type];
        if (aiStats) {
            // Store spawn data for nightmare respawning
            entry.spawnX = thing.x;
            entry.spawnY = thing.y;
            entry.maxHp = entry.hp;
            // Convert DOOM angle (degrees, 0=east) to radians
            entry.facing = thing.angle * Math.PI / 180;
            entry.ai = {
                state: 'idle',
                stateTime: 0,
                losTimer: Math.random() * LINE_OF_SIGHT_CHECK_INTERVAL,
                lastAttack: 0,
                damageDealt: false,
                reactionTimer: 0,
                // Based on: linuxdoom-1.10/p_mobj.c — MTF_AMBUSH (bit 3) means
                // the enemy is "deaf" and only wakes from sound with LOS
                ambush: (thing.flags & 8) !== 0,
                // Infighting: `target` is a Player reference or a reference to
                // another enemy entry. `threshold` counts down each AI tick —
                // while > 0 the enemy stays locked on its current target and
                // won't retarget. Phase 4 will replace state.players[0] with a
                // dynamic nearest-visible-player selection for deathmatch.
                // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() retarget logic
                target: state.players[0],
                threshold: 0,
                ...aiStats
            };
            // Based on: linuxdoom-1.10/g_game.c — nightmare doubles speeds,
            // halves reaction/attack/pain timings (fastparm)
            if (state.skillLevel === 5) {
                entry.ai.speed *= 2;
                entry.ai.reactionTime /= 2;
                entry.ai.attackDuration /= 2;
                entry.ai.painDuration /= 2;
                entry.ai.cooldown /= 2;
            }
        }

        state.things[thing.gameId] = entry;
    }
}
