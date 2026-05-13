/**
 * Thing (entity) DOM construction.
 *
 * `buildThing(spec)` is a one-shot renderer command that creates the DOM for
 * a single map thing — enemy, pickup, barrel, decoration — and parents it
 * into the appropriate sector container. The caller (game-side initThings)
 * owns the iteration over mapData.things, the skill/mode filter, sector and
 * floor-height lookup, and the state.things push for shootables/pickups.
 * This module just creates DOM from a fully-prepared spec.
 *
 * Spec shape:
 *   {
 *     x, y, floorHeight       — world position
 *     type                    — DOOM thing type number (used for sprite lookup)
 *     category                — DOM class: 'enemy' | 'barrel' | 'pickup' | 'decoration'
 *     sectorIndex             — sector to parent under (undefined = scene root)
 *     gameId                  — index into state.things; undefined for
 *                               passive decorations that aren't tracked there
 *   }
 */

import { THING_SPRITES, THING_NAMES } from '../constants.js';
import { sceneState } from '../../dom.js';
import { appendToSector } from '../sectors.js';

export function buildThing(spec) {
    const thingName = THING_NAMES[spec.type];
    const staticSprite = THING_SPRITES[spec.type];
    if (!thingName && !staticSprite) return;

    const thingContainer = document.createElement('div');
    thingContainer.className = spec.category;
    thingContainer.style.setProperty('--x', spec.x);
    thingContainer.style.setProperty('--floor-z', spec.floorHeight);
    thingContainer.style.setProperty('--y', spec.y);

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
    appendToSector(thingContainer, spec.sectorIndex);

    if (spec.gameId !== undefined) {
        sceneState.thingDom.set(spec.gameId, { element: thingContainer, sprite: spriteElement });
        sceneState.thingContainers.push({ element: thingContainer, x: spec.x, y: spec.y, sectorIndex: spec.sectorIndex, gameId: spec.gameId });
    } else {
        sceneState.thingContainers.push({ element: thingContainer, x: spec.x, y: spec.y, sectorIndex: spec.sectorIndex });
    }
}
