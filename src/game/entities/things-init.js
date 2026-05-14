/**
 * Initial population of state.things from map data plus the matching
 * per-thing render specs on mapData.thingRenderSpecs. Called once per level
 * load, before buildScene — which reads the specs to build thing DOM into
 * its fragment. No renderer commands are issued here; the renderer is
 * driven entirely by data this function (and its initDoors / initLifts /
 * initCrushers siblings) prepare.
 */

import { mapData } from '../../shared/maps.js';
import { state } from '../state.js';
import {
    THING_HEALTH, ENEMIES, PICKUPS, SHOOTABLE,
    ENEMY_AI_STATS, LINE_OF_SIGHT_CHECK_INTERVAL, SOLID_THING_RADIUS,
} from '../constants.js';
import { getFloorHeightAt, getSectorAt } from '../physics.js';

export function initThings() {
    mapData.thingRenderSpecs = [];
    if (!mapData.things) return;

    for (const thing of mapData.things) {
        // Bit 4 (0x0010) = multiplayer-only. Maps mark extra weapons /
        // ammo / powerups with this flag so they spawn in network play
        // but not single-player. Honour that: skip MP-only things in
        // SP, allow them through in DM (matches doom.exe -netgame).
        // Based on: linuxdoom-1.10/p_mobj.c P_SpawnMapThing()
        if ((thing.flags & 16) && state.gameMode === 'singleplayer') continue;
        // Skill level flags: bit 0 = skill 1-2, bit 1 = skill 3, bit 2 = skill 4-5
        const skillBit = state.skillLevel <= 2 ? 1 : state.skillLevel === 3 ? 2 : 4;
        if (!(thing.flags & skillBit)) continue;

        const floorHeight = getFloorHeightAt(thing.x, thing.y);
        const sector = getSectorAt(thing.x, thing.y);
        const sectorIndex = sector?.sectorIndex;
        const category = ENEMIES.has(thing.type)
            ? 'enemy'
            : thing.type === 2035 ? 'barrel'
            : PICKUPS.has(thing.type) ? 'pickup'
            : 'decoration';

        let gameId;
        if (PICKUPS.has(thing.type) || SHOOTABLE.has(thing.type) || SOLID_THING_RADIUS[thing.type]) {
            // Game-only data — no DOM references
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
                sectorIndex,
                floorHeight,
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

            gameId = state.things.length;
            state.things.push(entry);
        }

        mapData.thingRenderSpecs.push({
            x: thing.x,
            y: thing.y,
            floorHeight,
            type: thing.type,
            category,
            sectorIndex,
            gameId,
        });
    }
}
