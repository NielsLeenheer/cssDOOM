/**
 * Game-level physics queries: collision detection, ray casting, floor/sector lookup.
 *
 * Uses pure geometry functions from geometry.js and the spatial grid query API
 * from spatial-grid.js.
 */

import { PLAYER_RADIUS, PLAYER_HEIGHT, MAX_STEP_HEIGHT, BARREL_RADIUS, SOLID_THING_RADIUS, EYE_HEIGHT } from './constants.js';
import { state, debug } from './state.js';
import { isDoorClosed, getDoorEntry } from './mechanics/doors.js';
import { circleLineCollision, pointInPolygon } from './geometry.js';
import { forEachWallInAABB, forEachSectorAt } from './spatial-grid.js';

// ============================================================================
// Linedef Crossing
// ============================================================================

/**
 * Returns true when the circle at (newX, newY) with the given radius is
 * crossing from one side of the wall's linedef to the other.  Two-sided
 * linedefs in DOOM only block movement *through* the line, not movement
 * parallel to it.  We test this by computing which side of the infinite
 * line both the current player position and the candidate position fall on.
 * If both centres are on the same side, the player is moving along (or away
 * from) the linedef and should not be blocked.
 *
 * Based on: linuxdoom-1.10/p_map.c — PIT_CheckLine only rejects moves that
 * cross from front to back (or vice-versa) of a two-sided linedef.
 */
function crossesLinedef(newX, newY, _radius, wall) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;

    // Perpendicular (signed) distance of old and new centres from the line.
    // sign > 0  →  "front" side,  sign < 0  →  "back" side.
    const oldSide = (state.playerX - wall.start.x) * dy - (state.playerY - wall.start.y) * dx;
    const newSide = (newX          - wall.start.x) * dy - (newY          - wall.start.y) * dx;

    // If both centres are on the same side the player is not crossing.
    if ((oldSide > 0) === (newSide > 0)) return false;

    return true;
}

// ============================================================================
// Collision Detection
// ============================================================================

/**
 * Tests whether a circle at (newX, newY) with the given radius can occupy
 * that position without colliding with solid walls, barrels, or lift shafts,
 * and without encountering an impassable step height change.
 */
export function canMoveTo(newX, newY, radius = PLAYER_RADIUS, currentFloorHeight = state.floorHeight, maxDropHeight = Infinity, excludeThing = null) {
    if (debug.noclip) return true;

    // Check collision against walls via spatial grid.
    // Solid walls and closed doors always block. Two-sided linedefs (windows,
    // ledges) block only when the player crosses the linedef and the opening
    // doesn't provide enough clearance.
    // Based on: linuxdoom-1.10/p_map.c:PIT_CheckLine()
    const playerTop = currentFloorHeight + PLAYER_HEIGHT;
    let blocked = false;
    forEachWallInAABB(newX - radius, newY - radius, newX + radius, newY + radius, wall => {
        // Door walls are checked first — door linedefs have ML_BLOCKING but
        // should be passable when the door is open
        const doorEntry = getDoorEntry(wall);
        if (doorEntry) {
            if (doorEntry.passable) return;
        } else if (wall.isUpperWall && wall.bottomHeight !== undefined && wall.topHeight !== undefined) {
            // Upper wall: block if opening is too small for the player.
            // Skip if the wall doesn't overlap the player's height range.
            if (wall.topHeight <= currentFloorHeight || wall.bottomHeight >= playerTop) return;
            // Two-sided walls only block when the player crosses the linedef,
            // not when moving parallel to it. This prevents lifts from trapping
            // players who ride into overlap with the upper wall geometry.
            if (!crossesLinedef(newX, newY, radius, wall)) return;
        } else if (wall.isSolid) {
            // Solid wall or two-sided linedef with ML_BLOCKING (windows, railings)
        } else {
            return;
        }
        if (circleLineCollision(newX, newY, radius,
            wall.start.x, wall.start.y, wall.end.x, wall.end.y)) {
            blocked = true;
            return false; // stop iteration
        }
    });
    if (blocked) return false;

    // Check collision against solid things (enemies, barrels, solid decorations).
    // Based on: linuxdoom-1.10/p_map.c:PIT_CheckThing() — any MF_SOLID thing blocks.
    // Dead enemies lose MF_SOLID (P_KillMobj sets collected=true here).
    const things = state.things;
    for (let i = 0, thingCount = things.length; i < thingCount; i++) {
        const thing = things[i];
        if (thing.collected || thing === excludeThing) continue;
        let thingRadius;
        if (thing.ai) {
            thingRadius = thing.ai.radius;
        } else if (thing.type === 2035) {
            thingRadius = BARREL_RADIUS;
        } else if (thing.solidRadius) {
            thingRadius = thing.solidRadius;
        } else {
            continue;
        }
        const deltaX = newX - thing.x;
        const deltaY = newY - thing.y;
        const combinedRadius = radius + thingRadius;
        if (deltaX * deltaX + deltaY * deltaY < combinedRadius * combinedRadius) {
            return false;
        }
    }

    // Check collision against lift shaft edges when the lift platform is above the player
    for (const [, liftEntry] of state.liftState) {
        const edges = liftEntry.collisionEdges;
        if (!edges) continue;
        if (currentFloorHeight >= liftEntry.currentHeight - MAX_STEP_HEIGHT) continue;
        for (let i = 0, edgeCount = edges.length; i < edgeCount; i++) {
            const edge = edges[i];
            if (circleLineCollision(newX, newY, radius, edge.start.x, edge.start.y, edge.end.x, edge.end.y)) {
                return false;
            }
        }
    }

    // Block if the floor step up is too high or the drop down is too far
    const newFloorHeight = getFloorHeightAt(newX, newY);
    if (newFloorHeight - currentFloorHeight > MAX_STEP_HEIGHT) return false;
    if (currentFloorHeight - newFloorHeight > maxDropHeight) return false;
    return true;
}

// ============================================================================
// Ray Casting
// ============================================================================

/**
 * Casts a ray from the origin in the given direction and returns the
 * intersection point with the nearest solid wall, or null if no wall
 * is hit within maxDistance.
 */
export function rayHitPoint(originX, originY, directionX, directionY, maxDistance) {
    let closestHitDistance = maxDistance;
    const endX = originX + directionX * maxDistance;
    const endY = originY + directionY * maxDistance;
    const eyeZ = state.floorHeight + EYE_HEIGHT;

    forEachWallInAABB(
        Math.min(originX, endX), Math.min(originY, endY),
        Math.max(originX, endX), Math.max(originY, endY),
        wall => {
            // Two-sided walls (upper, lower, middle): only block when the
            // ray's eye level is within the wall's height range. This lets
            // shots pass through window openings even on ML_BLOCKING linedefs.
            // One-sided solid walls and closed doors always block.
            if (wall.isUpperWall || wall.isLowerWall || wall.isMiddleWall) {
                // Door face walls (upper walls) slide up when open — don't
                // block rays through the opening at eye level.
                if (wall.isUpperWall && !isDoorClosed(wall)) {
                    const door = getDoorEntry(wall);
                    if (door && door.passable) return;
                }
                let wallBottom = wall.bottomHeight;
                let wallTop = wall.topHeight;
                // Lower walls on lift boundaries use the lift's animated height.
                // When a lift lowers, the floor step collapses and the wall
                // should no longer block rays at the original static height.
                if (wall.isLiftWall) {
                    const lift = state.liftState.get(wall.liftSectorIndex);
                    if (lift) {
                        // Determine the non-lift sector's floor (the static side)
                        const neighborFloor = wall.topHeight === lift.upperHeight
                            ? wall.bottomHeight : wall.topHeight;
                        wallBottom = Math.min(neighborFloor, lift.currentHeight);
                        wallTop = Math.max(neighborFloor, lift.currentHeight);
                    }
                }
                if (wallBottom === undefined || eyeZ < wallBottom || eyeZ > wallTop) return;
            } else if (!wall.isSolid && !isDoorClosed(wall)) {
                return;
            }

            const segmentDeltaX = wall.end.x - wall.start.x;
            const segmentDeltaY = wall.end.y - wall.start.y;
            const crossProductDenominator = directionX * segmentDeltaY - directionY * segmentDeltaX;
            if (Math.abs(crossProductDenominator) < 1e-8) return;

            const rayParameter = ((wall.start.x - originX) * segmentDeltaY - (wall.start.y - originY) * segmentDeltaX) / crossProductDenominator;
            const segmentParameter = ((wall.start.x - originX) * directionY - (wall.start.y - originY) * directionX) / crossProductDenominator;
            if (rayParameter > 0 && rayParameter < closestHitDistance && segmentParameter >= 0 && segmentParameter <= 1) {
                closestHitDistance = rayParameter;
            }
        }
    );

    if (closestHitDistance >= maxDistance) return null;
    return { x: originX + directionX * closestHitDistance, y: originY + directionY * closestHitDistance };
}

// ============================================================================
// Floor / Sector Lookup
// ============================================================================

/**
 * Returns the floor height at a world position by testing which sectors
 * contain the point. Returns the highest floor among matching sectors.
 * Lift sectors use their animated currentHeight.
 */
export function getFloorHeightAt(x, y) {
    let highestFloor = -Infinity;
    forEachSectorAt(x, y, sector => {
        const outerBoundary = sector.boundaries[0];
        if (!outerBoundary || outerBoundary.length < 3) return;

        if (pointInPolygon(x, y, outerBoundary)) {
            let insideHole = false;
            for (let h = 1; h < sector.boundaries.length; h++) {
                if (sector.boundaries[h].length >= 3 && pointInPolygon(x, y, sector.boundaries[h])) {
                    insideHole = true;
                    break;
                }
            }
            if (!insideHole) {
                const lift = state.liftState.get(sector.sectorIndex);
                const effectiveFloor = lift ? lift.currentHeight : sector.floorHeight;
                if (effectiveFloor > highestFloor) {
                    highestFloor = effectiveFloor;
                }
            }
        }
    });
    return highestFloor === -Infinity ? 0 : highestFloor;
}

/**
 * Returns the sector polygon data at a world position, or null if not found.
 */
export function getSectorAt(x, y) {
    let found = null;
    forEachSectorAt(x, y, sector => {
        const outerBoundary = sector.boundaries[0];
        if (!outerBoundary || outerBoundary.length < 3) return;

        if (pointInPolygon(x, y, outerBoundary)) {
            let insideHole = false;
            for (let h = 1; h < sector.boundaries.length; h++) {
                if (sector.boundaries[h].length >= 3 && pointInPolygon(x, y, sector.boundaries[h])) {
                    insideHole = true;
                    break;
                }
            }
            if (!insideHole) {
                found = sector;
                return false; // stop iteration
            }
        }
    });
    return found;
}

/**
 * Returns the light level of the sector at the given world position,
 * defaulting to 255 (full brightness) if no sector is found.
 */
export function getSectorLightAt(x, y) {
    const sector = getSectorAt(x, y);
    return sector?.lightLevel ?? 255;
}
