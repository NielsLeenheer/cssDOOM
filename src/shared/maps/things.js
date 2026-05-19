/**
 * Map-side enrichment for things. Annotates each surviving
 * `mapData.things[i]` in place with the fields buildScene + game
 * state init both read: sectorIndex, floorHeight, category, gameId.
 *
 * "Surviving" = not filtered out by skill level or MP-only flag.
 * Filtered-out entries are LEFT UNTOUCHED — they have no `category`
 * field. Downstream consumers (buildScene, initThingsState) skip
 * entries without `category`.
 *
 * `gameId` is the contiguous index a future state.things entry will
 * occupy. Only types that `initThingsState` pushes to state.things
 * get a gameId; decorations leave it undefined.
 *
 * No `state.*` mutation. State population is the game-side concern,
 * handled by `src/game/entities/things-init.js::initThingsState`.
 */

import { ENEMIES, PICKUPS, SHOOTABLE, SOLID_THING_RADIUS } from '../constants.js';
import { getFloorHeightAt, getSectorAt } from '../../game/physics.js';
import { state } from '../../game/state.js';

export function initThings(mapData) {
    if (!mapData.things) return;

    let nextGameId = 0;
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

        thing.floorHeight = getFloorHeightAt(thing.x, thing.y);
        thing.sectorIndex = getSectorAt(thing.x, thing.y)?.sectorIndex;
        thing.category = ENEMIES.has(thing.type)   ? 'enemy'
                       : thing.type === 2035        ? 'barrel'
                       : PICKUPS.has(thing.type)   ? 'pickup'
                       : 'decoration';

        // Only types that initThingsState will push into state.things
        // get a gameId. Decorations leave it undefined — they render
        // but aren't simulated.
        if (PICKUPS.has(thing.type)
            || SHOOTABLE.has(thing.type)
            || SOLID_THING_RADIUS[thing.type]) {
            thing.gameId = nextGameId++;
        }
    }
}
