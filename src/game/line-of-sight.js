/**
 * 3D line-of-sight check using DOOM's slope-narrowing algorithm.
 * Based on: linuxdoom-1.10/p_sight.c:P_CheckSight(), P_CrossSubsector()
 *
 * The sight ray starts with a vertical cone spanning the full target height.
 * At each two-sided linedef crossing, the cone is narrowed by the opening
 * (max floor, min ceiling) at that linedef. If the cone closes (topSlope
 * <= bottomSlope), line of sight is blocked.
 *
 * Lift sectors use their animated currentHeight instead of the static
 * floor height from the map data.
 */

import { EYE_HEIGHT } from '../shared/constants.js';
import { state } from './state.js';
import { rayHitsSegment } from './geometry.js';
import { forEachWallInAABB, forEachSightLineInAABB } from './spatial-grid.js';
import { isDoorClosed } from './mechanics/doors.js';
import { getFloorHeightAt } from './physics.js';

export function hasLineOfSight(fromX, fromY, toX, toY) {
    const deltaX = toX - fromX;
    const deltaY = toY - fromY;
    const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    if (distance < 1) return true;

    const dirX = deltaX / distance;
    const dirY = deltaY / distance;

    const minX = Math.min(fromX, toX), maxX = Math.max(fromX, toX);
    const minY = Math.min(fromY, toY), maxY = Math.max(fromY, toY);

    // Check one-sided solid walls and closed doors — these always block.
    // Two-sided walls (upper, lower, middle) are skipped here; their openings
    // are handled by the 3D sight-cone check against sightLines below.
    let wallBlocked = false;
    forEachWallInAABB(minX, minY, maxX, maxY, wall => {
        if (wall.isUpperWall || wall.isLowerWall || wall.isMiddleWall) return;
        if (!wall.isSolid && !isDoorClosed(wall)) return;
        if (rayHitsSegment(fromX, fromY, dirX, dirY,
            wall.start.x, wall.start.y, wall.end.x, wall.end.y, distance)) {
            wallBlocked = true;
            return false;
        }
    });
    if (wallBlocked) return false;

    // 3D sight cone check across two-sided linedefs
    // Based on: linuxdoom-1.10/p_sight.c — sightzstart, topslope, bottomslope
    const fromZ = getFloorHeightAt(fromX, fromY) + EYE_HEIGHT;
    const toZ = getFloorHeightAt(toX, toY) + EYE_HEIGHT;
    let topSlope = (toZ + EYE_HEIGHT) - fromZ;    // top of target
    let bottomSlope = (toZ - EYE_HEIGHT) - fromZ;  // bottom of target

    let sightBlocked = false;
    forEachSightLineInAABB(minX, minY, maxX, maxY, line => {
        const segDx = line.end.x - line.start.x;
        const segDy = line.end.y - line.start.y;
        const cross = dirX * segDy - dirY * segDx;
        if (Math.abs(cross) < 1e-8) return;

        const t = ((line.start.x - fromX) * segDy - (line.start.y - fromY) * segDx) / cross;
        if (t <= 0 || t >= distance) return;
        const u = ((line.start.x - fromX) * dirY - (line.start.y - fromY) * dirX) / cross;
        if (u < 0 || u > 1) return;

        // Compute the opening at this linedef, using dynamic heights
        let openBottom = line.openBottom;
        let openTop = line.openTop;

        // Doors: when open, the sector ceiling rises to openHeight
        if (state.doorState) {
            const frontDoor = state.doorState.get(line.frontSector);
            const backDoor = state.doorState.get(line.backSector);
            if (frontDoor && frontDoor.open) openTop = Math.max(openTop, frontDoor.openHeight);
            if (backDoor && backDoor.open) openTop = Math.max(openTop, backDoor.openHeight);
        }

        // Lifts: when raised, the sector floor rises to currentHeight
        if (state.liftState) {
            const frontLift = state.liftState.get(line.frontSector);
            const backLift = state.liftState.get(line.backSector);
            if (frontLift) openBottom = Math.max(openBottom, frontLift.currentHeight);
            if (backLift) openBottom = Math.max(openBottom, backLift.currentHeight);
        }

        if (openBottom >= openTop) { sightBlocked = true; return false; }

        // Narrow the sight cone — slopes are relative to fromZ, scaled by fraction
        if (openBottom > fromZ) {
            const slope = (openBottom - fromZ) / t;
            if (slope > bottomSlope) bottomSlope = slope;
        }
        if (openTop < fromZ) {
            const slope = (openTop - fromZ) / t;
            if (slope < topSlope) topSlope = slope;
        }

        if (topSlope <= bottomSlope) { sightBlocked = true; return false; }
    });

    return !sightBlocked;
}
