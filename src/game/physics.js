/**
 * Game-level physics queries: collision detection, ray casting, floor/sector lookup.
 *
 * Uses pure geometry functions from geometry.js and the spatial grid query API
 * from spatial-grid.js.
 *
 * Multiplayer status: every caller passes explicit position / floor / eye
 * data — there are no implicit player-0 defaults. canMoveTo's fromX/fromY
 * and currentFloorHeight come from the moving entity (player or enemy);
 * rayHitPoint's eyeZ comes from the firing player's eye height or the
 * projectile's z. Each player / projectile / enemy operates on its own
 * coordinates regardless of state.players[0]'s position.
 */

import { PLAYER_RADIUS, PLAYER_HEIGHT, MAX_STEP_HEIGHT, BARREL_RADIUS, SOLID_THING_RADIUS, EYE_HEIGHT } from '../shared/constants.js';
import { state, debugFlags } from './state.js';
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
 * line both the current and candidate positions fall on. If both are on
 * the same side, the mover is moving along (or away from) the linedef and
 * should not be blocked.
 *
 * Based on: linuxdoom-1.10/p_map.c — PIT_CheckLine only rejects moves that
 * cross from front to back (or vice-versa) of a two-sided linedef.
 */
function crossesLinedef(fromX, fromY, newX, newY, _radius, wall) {
    const dx = wall.end.x - wall.start.x;
    const dy = wall.end.y - wall.start.y;

    // Perpendicular (signed) distance of old and new centres from the line.
    // sign > 0  →  "front" side,  sign < 0  →  "back" side.
    const oldSide = (fromX - wall.start.x) * dy - (fromY - wall.start.y) * dx;
    const newSide = (newX  - wall.start.x) * dy - (newY  - wall.start.y) * dx;

    // If both centres are on the same side the mover is not crossing.
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
 *
 * `fromX, fromY` are the mover's current position — used for the linedef
 * crossing test (two-sided lines only block when the mover crosses, not
 * when moving parallel) and step-height comparison. Callers pass their own
 * coordinates (movement.js: player.x/y, ai.js: enemy.x/y).
 */
export function canMoveTo(newX, newY, radius = PLAYER_RADIUS, currentFloorHeight = 0, maxDropHeight = Infinity, excludeThing = null, fromX = 0, fromY = 0) {
    if (debugFlags.noclip) return true;

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
            if (!crossesLinedef(fromX, fromY, newX, newY, radius, wall)) return;
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

    // Check collision against lift shaft edges when the lift platform is
    // above the player. The edge.insideSign annotation (precomputed in
    // lifts.js initLifts) tells us which side of the edge is the lift's
    // interior; we only block when the new position sits on that side,
    // so a player who's *outside* the footprint but brushing the edge
    // (e.g., just after stepping off a raised lift) isn't trapped.
    for (const [, liftEntry] of state.liftState) {
        const edges = liftEntry.collisionEdges;
        if (!edges) continue;
        if (currentFloorHeight >= liftEntry.currentHeight - MAX_STEP_HEIGHT) continue;
        for (let i = 0, edgeCount = edges.length; i < edgeCount; i++) {
            const edge = edges[i];
            if (edge.insideSign !== 0) {
                const dx = edge.end.x - edge.start.x;
                const dy = edge.end.y - edge.start.y;
                const side = (newX - edge.start.x) * dy - (newY - edge.start.y) * dx;
                const sideSign = side > 0 ? 1 : (side < 0 ? -1 : 0);
                if (sideSign !== edge.insideSign) continue;
            }
            if (circleLineCollision(newX, newY, radius, edge.start.x, edge.start.y, edge.end.x, edge.end.y)) {
                return false;
            }
        }
    }

    // Block if the floor step up is too high or the drop down is too far.
    const newFloorHeight = getFloorHeightAt(newX, newY);
    if (currentFloorHeight - newFloorHeight > maxDropHeight) return false;

    // Step-up is tested at the mover's leading edge (one radius ahead in the
    // direction of travel), not just the centre. Otherwise the centre can be
    // pushed flush against a too-high step face — e.g. a lift's back riser —
    // with the body overlapping it, which embeds the camera in that wall (it
    // then clips through the near plane and the wall appears see-through).
    // DOOM tests the whole bounding box against the linedef opening; sampling
    // the leading edge is the cheap equivalent that keeps the eye out of the
    // riser. Drops (walking off a ledge) still use the centre, so ledge edges
    // remain reachable.
    let stepUp = newFloorHeight - currentFloorHeight;
    const mvX = newX - fromX, mvY = newY - fromY;
    const mvLen = Math.hypot(mvX, mvY);
    if (mvLen > 0.001) {
        const aheadFloor = getFloorHeightAt(newX + (mvX / mvLen) * radius, newY + (mvY / mvLen) * radius);
        stepUp = Math.max(stepUp, aheadFloor - currentFloorHeight);
    }
    if (stepUp > MAX_STEP_HEIGHT) return false;
    return true;
}

// ============================================================================
// Ray Casting
// ============================================================================

/**
 * Casts a ray from the origin in the given direction and returns the
 * intersection point with the nearest solid wall, or null if no wall
 * is hit within maxDistance.
 *
 * `eyeZ` is the height at which the ray travels — used to test whether
 * a wall's vertical span actually obstructs the ray. Player firing passes
 * `player.floorHeight + EYE_HEIGHT`; projectile collision passes the
 * projectile's z.
 */
export function rayHitPoint(originX, originY, directionX, directionY, maxDistance, eyeZ = 0) {
    let closestHitDistance = maxDistance;
    const endX = originX + directionX * maxDistance;
    const endY = originY + directionY * maxDistance;

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
                if (wall.moverType === 'lift') {
                    const lift = state.liftState.get(wall.moverSector);
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
