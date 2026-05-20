/**
 * Floors — game-side mechanics for permanent floor-height changes.
 *
 * DOOM "lower floor to lowest neighbor" triggers (used by E1M8's
 * post-boss exit, and a handful of other map scripts) permanently
 * mutate sector geometry. Physics reads the lowered height
 * immediately via `getFloorHeightAt` → `sector.floorHeight` on
 * mapData.sectorPolygons. The renderer's job is to animate the
 * visual transition.
 *
 * This module owns the simulation-state mutation. Callers compute
 * which sectors lower (via tag lookup), apply the mutation here,
 * then dispatch per-sector renderer.setFloorHeight commands to
 * animate each one. The renderer impl no longer reads tags or
 * touches mapData.
 *
 * Based on: linuxdoom-1.10/p_spec.c:P_FindLowestFloorSurrounding()
 */

import { mapData } from '../../shared/maps/index.js';

/**
 * Lower every sector with the given tag to its lowest adjacent
 * floor height. Mutates `mapData.sectorPolygons[*].floorHeight`
 * in place so physics lookups see the new geometry immediately.
 *
 * Returns the list of `{sectorIndex, height}` updates so the
 * caller can fan per-sector setFloorHeight renderer commands.
 * Empty array if no sectors match the tag (already lowered or
 * tag not present on this map).
 */
export function lowerFloorsWithTag(tag) {
    const updates = [];
    const sectors = mapData.sectors;
    const linedefs = mapData.linedefs;
    const sidedefs = mapData.sidedefs;
    const sectorPolygons = mapData.sectorPolygons;

    for (let i = 0, len = sectors.length; i < len; i++) {
        if (sectors[i].tag !== tag) continue;

        let lowestFloor = sectors[i].floorHeight;
        for (let j = 0, ldLen = linedefs.length; j < ldLen; j++) {
            const ld = linedefs[j];
            const frontSector = ld.frontSidedef >= 0 ? sidedefs[ld.frontSidedef].sectorIndex : -1;
            const backSector = ld.backSidedef >= 0 ? sidedefs[ld.backSidedef].sectorIndex : -1;
            if (frontSector !== i && backSector !== i) continue;
            const otherIndex = frontSector === i ? backSector : frontSector;
            if (otherIndex < 0) continue;
            if (sectors[otherIndex].floorHeight < lowestFloor) {
                lowestFloor = sectors[otherIndex].floorHeight;
            }
        }

        // sectorPolygons can have multiple polys per sectorIndex
        // (sectors with holes / disjoint regions). Apply to all
        // matching polys so physics sees a uniform floor height.
        for (let j = 0, spLen = sectorPolygons.length; j < spLen; j++) {
            if (sectorPolygons[j].sectorIndex === i) {
                sectorPolygons[j].floorHeight = lowestFloor;
            }
        }

        updates.push({ sectorIndex: i, height: lowestFloor });
    }

    return updates;
}
