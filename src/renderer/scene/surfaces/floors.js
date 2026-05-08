/**
 * Floor surface construction and manipulation.
 */

import { mapData } from '../../../shared/maps.js';
import { sceneState, sceneStates } from '../../dom.js';
import { playSound } from '../../../audio/audio.js';
import { buildHorizontalSurface } from './horizontal.js';

export function buildFloors() {
    if (!mapData.sectorPolygons) return;

    for (const sector of mapData.sectorPolygons) {
        buildHorizontalSurface(sector, sector.floorHeight, sector.floorTexture, 'floor');
    }
}

/**
 * Lowers all sector floors with the given tag to their lowest adjacent floor
 * height. Updates both the DOM elements (via CSS custom property) and the
 * sectorPolygon data (for physics/collision).
 *
 * Based on: linuxdoom-1.10/p_spec.c:P_FindLowestFloorSurrounding()
 */
export function lowerTaggedFloor(tag) {
    const sectors = mapData.sectors;
    const sectorPolygons = mapData.sectorPolygons;

    // Find sectors with the matching tag
    for (let i = 0, len = sectors.length; i < len; i++) {
        if (sectors[i].tag !== tag) continue;
        const sectorIndex = i;

        // Find the lowest adjacent floor height from the map data
        let lowestFloor = sectors[i].floorHeight;
        const linedefs = mapData.linedefs;
        const sidedefs = mapData.sidedefs;
        for (let j = 0, ldLen = linedefs.length; j < ldLen; j++) {
            const ld = linedefs[j];
            const frontSector = ld.frontSidedef >= 0 ? sidedefs[ld.frontSidedef].sectorIndex : -1;
            const backSector = ld.backSidedef >= 0 ? sidedefs[ld.backSidedef].sectorIndex : -1;
            if (frontSector !== sectorIndex && backSector !== sectorIndex) continue;
            const otherIndex = frontSector === sectorIndex ? backSector : frontSector;
            if (otherIndex < 0) continue;
            if (sectors[otherIndex].floorHeight < lowestFloor) {
                lowestFloor = sectors[otherIndex].floorHeight;
            }
        }

        // Update sectorPolygon floorHeight for physics
        for (let j = 0, spLen = sectorPolygons.length; j < spLen; j++) {
            if (sectorPolygons[j].sectorIndex === sectorIndex) {
                sectorPolygons[j].floorHeight = lowestFloor;
            }
        }

        // Animate the floor surface DOM elements down — every pane's clone
        for (const sState of sceneStates) {
            for (let j = 0, seLen = sState.surfaceElements.length; j < seLen; j++) {
                const el = sState.surfaceElements[j];
                if (el._sectorIndex === sectorIndex && el._type === 'floor') {
                    el.style.transition = 'transform 2s ease-in-out';
                    el.style.setProperty('--floor-z', lowestFloor);
                }
            }
        }
    }

    playSound('DSPSTART');
}
