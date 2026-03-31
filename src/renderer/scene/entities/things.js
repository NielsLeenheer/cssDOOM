/**
 * Thing (entity) construction from map data.
 *
 * Creates DOM elements for enemies, pickups, barrels, and decorations.
 * Enemies get AI state initialized from ENEMY_AI_STATS constants.
 * Nightmare skill level doubles speeds and halves timings.
 */

import {
    THING_HEALTH, ENEMIES, PICKUPS, SHOOTABLE,
    ENEMY_AI_STATS, LINE_OF_SIGHT_CHECK_INTERVAL, SOLID_THING_RADIUS,
} from '../../../game/constants.js';
import { THING_SPRITES, THING_NAMES } from '../constants.js';

import { state } from '../../../game/state.js';
import { mapData } from '../../../shared/maps.js';
import { sceneState } from '../../dom.js';
import { getFloorHeightAt, getSectorAt } from '../../../game/physics.js';
import { appendToSector } from '../sectors.js';

export function buildThings() {
    if (!mapData.things) return;

    for (const thing of mapData.things) {
        // Bit 4 = multiplayer only — skip in single player
        if (thing.flags & 16) continue;
        // Skill level flags: bit 0 = skill 1-2, bit 1 = skill 3, bit 2 = skill 4-5
        const skillBit = state.skillLevel <= 2 ? 1 : state.skillLevel === 3 ? 2 : 4;
        if (!(thing.flags & skillBit)) continue;

        const thingName = THING_NAMES[thing.type];
        const staticSprite = THING_SPRITES[thing.type];
        if (!thingName && !staticSprite) continue;

        const floorHeight = getFloorHeightAt(thing.x, thing.y);

        const thingContainer = document.createElement('div');
        const category = ENEMIES.has(thing.type) ? 'enemy' : thing.type === 2035 ? 'barrel' : PICKUPS.has(thing.type) ? 'pickup' : 'decoration';
        thingContainer.className = category;
        thingContainer.style.setProperty('--x', thing.x);
        thingContainer.style.setProperty('--floor-z', floorHeight);
        thingContainer.style.setProperty('--y', thing.y);
        const sector = getSectorAt(thing.x, thing.y);

        let spriteElement = null;
        if (thingName) {
            spriteElement = document.createElement('div');
            spriteElement.className = 'sprite';
            spriteElement.dataset.type = thingName;
            // Randomize animation offset so enemies don't walk in sync
            spriteElement.style.animationDelay = `-${Math.random() * 2}s`;
            thingContainer.appendChild(spriteElement);
        } else {
            const imageElement = document.createElement('img');
            imageElement.src = `/assets/sprites/${staticSprite}.png`;
            imageElement.draggable = false;
            thingContainer.appendChild(imageElement);
        }

        thingContainer.hidden = true;
        appendToSector(thingContainer, sector?.sectorIndex);

        if (PICKUPS.has(thing.type) || SHOOTABLE.has(thing.type) || SOLID_THING_RADIUS[thing.type]) {
            // Game-only data — no DOM references
            const entry = {
                x: thing.x,
                y: thing.y,
                type: thing.type,
                collected: false,
                hp: THING_HEALTH[thing.type] || 0
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
                    // Infighting: `target` is 'player' or a reference to another enemy entry.
                    // `threshold` counts down each AI tick — while > 0 the enemy stays locked
                    // on its current target and won't retarget.
                    // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() retarget logic
                    target: 'player',
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

            const thingIndex = state.things.length;
            state.things.push(entry);

            // Store DOM refs in renderer state, keyed by thing index
            sceneState.thingDom.set(thingIndex, { element: thingContainer, sprite: spriteElement });
            sceneState.thingContainers.push({ element: thingContainer, x: thing.x, y: thing.y, gameId: thingIndex });
        } else {
            sceneState.thingContainers.push({ element: thingContainer, x: thing.x, y: thing.y });
        }
    }
}
