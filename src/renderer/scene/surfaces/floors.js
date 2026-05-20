/**
 * Floor surface construction and animation.
 */

import { mapData } from '../../../shared/maps/index.js';
import { buildHorizontalSurface } from './horizontal.js';

export function buildFloors(ctx) {
    if (!mapData.sectorPolygons) return;

    for (const sector of mapData.sectorPolygons) {
        buildHorizontalSurface(ctx, sector, sector.floorHeight, sector.floorTexture, 'floor');
    }
}

/**
 * Animate this renderer's floor surface DOM for a single sector to
 * the given height. Game-side mechanics (src/game/mechanics/floors.js)
 * owns the simulation-state mutation; this impl is paint-only.
 */
export function setFloorHeight(renderer, sectorIndex, height) {
    for (let j = 0, seLen = renderer.sceneState.surfaceElements.length; j < seLen; j++) {
        const el = renderer.sceneState.surfaceElements[j];
        if (el._sectorIndex === sectorIndex && el._type === 'floor') {
            el.style.transition = 'transform 2s ease-in-out';
            el.style.setProperty('--floor-z', height);
        }
    }
}
