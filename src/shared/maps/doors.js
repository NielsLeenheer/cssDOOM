/**
 * Map-side enrichment for doors. Annotates each `mapData.doors[i]`
 * with its `trackWalls` array — the side walls (jambs) that
 * visually slide with the door panel. buildScene reads
 * `door.trackWalls` to wire up the per-wall animation;
 * `initDoorsState` reads `door.sectorIndex` / `keyRequired` for the
 * per-door state entry.
 *
 * No `state.*` mutation. State population is the game-side concern,
 * handled by `src/game/mechanics/doors.js::initDoorsState`.
 */

export function initDoors(mapData) {
    if (!mapData.doors) return;

    for (const door of mapData.doors) {
        // Identify face walls — any upper wall bordering the door sector.
        const faceWalls = [];
        for (const wall of mapData.walls) {
            if (!wall.isUpperWall) continue;
            if (wall.frontSectorIndex !== door.sectorIndex
                && wall.backSectorIndex !== door.sectorIndex) continue;
            faceWalls.push(wall);
        }

        // Identify track walls — solid walls adjacent to face walls
        // that form the door jambs.
        const trackWalls = [];
        for (const wall of mapData.walls) {
            if (!wall.isSolid || wall.isDoor) continue;
            if (wall.bottomHeight !== door.floorHeight
                || wall.topHeight !== door.closedHeight) continue;
            if (!wall.texture || wall.texture === '-') continue;
            const isAdjacent = faceWalls.some(fw =>
                (wall.start.x === fw.start.x && wall.start.y === fw.start.y) ||
                (wall.start.x === fw.end.x   && wall.start.y === fw.end.y)   ||
                (wall.end.x   === fw.start.x && wall.end.y   === fw.start.y) ||
                (wall.end.x   === fw.end.x   && wall.end.y   === fw.end.y)
            );
            if (isAdjacent) trackWalls.push(wall);
        }

        door.trackWalls = trackWalls;
    }
}
