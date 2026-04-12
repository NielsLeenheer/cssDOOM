/**
 * Hides scene elements that are not visible to reduce compositor workload.
 *
 * Three independent culling strategies, each togglable from the debug menu:
 *   - Frustum: hides elements outside the camera's horizontal field of view.
 *   - Distance: hides elements beyond MAX_RENDER_DISTANCE.
 *   - Backface: hides walls facing away from the camera.
 *
 * For floors/ceilings, frustum checks test all four bounding box corners
 * (not just the center) to avoid incorrectly culling large surfaces that
 * partially overlap the view.
 */

import { state } from '../../game/state.js';
import { sceneState } from '../dom.js';
import { MAX_RENDER_DISTANCE } from '../../game/constants.js';
import { spectatorActive } from '../../ui/spectator.js';

// Culling flags — toggled by the debug menu
export const culling = {
    frustum: true,
    distance: true,
    backface: true,
    sky: true,
};

// Stats updated each frame — per-step counts track how many elements
// survived after each culling pass (in processing order)
export const cullingStats = {
    total: 0,
    culled: 0,
    afterDistance: 0,
    afterBackface: 0,
    afterFrustum: 0,
    afterSky: 0,
};

// Half-FOV derived from perspective: atan(viewportWidth/2 / perspective)
// Plus a generous margin so elements at the edges aren't popped in/out visibly.
const FRUSTUM_MARGIN = 0.15; // ~9° extra on each side

/**
 * Tests whether a point (relative to the player) is within the camera's
 * horizontal view frustum. Returns true if visible.
 */
function pointInFrustum(relX, relY, sinAngle, cosAngle, halfFov) {
    // Rotate point into camera-local space (forward = +Z)
    const localX = relX * cosAngle + relY * sinAngle;
    const localZ = -relX * sinAngle + relY * cosAngle;

    // Behind the camera
    if (localZ <= 0) return false;

    // Check horizontal angle against half-FOV
    const angle = Math.abs(Math.atan2(localX, localZ));
    return angle < halfFov;
}

/**
 * Tests whether a wall (defined by two endpoints) is within the frustum.
 * Returns true if either endpoint or the midpoint is visible, or if the
 * player is close enough to the wall that it could span across the view.
 */
const NEAR_WALL_DIST_SQ = 200 * 200; // Never cull walls closer than this

function wallInFrustum(wall, playerX, playerY, sinAngle, cosAngle, halfFov) {
    const startRelX = wall.start.x - playerX;
    const startRelY = wall.start.y - playerY;
    const endRelX = wall.end.x - playerX;
    const endRelY = wall.end.y - playerY;

    // Never cull walls the player is close to — when up close, endpoints
    // can all land behind the camera while the wall surface is still visible.
    const dx = endRelX - startRelX;
    const dy = endRelY - startRelY;
    const lenSq = dx * dx + dy * dy;
    // Project player position onto the wall segment to find closest point
    const t = Math.max(0, Math.min(1, -(startRelX * dx + startRelY * dy) / lenSq));
    const closestX = startRelX + t * dx;
    const closestY = startRelY + t * dy;
    if (closestX * closestX + closestY * closestY < NEAR_WALL_DIST_SQ) return true;

    return pointInFrustum(startRelX, startRelY, sinAngle, cosAngle, halfFov) ||
           pointInFrustum(endRelX, endRelY, sinAngle, cosAngle, halfFov) ||
           pointInFrustum((startRelX + endRelX) / 2, (startRelY + endRelY) / 2, sinAngle, cosAngle, halfFov);
}

/**
 * Tests whether a surface bounding box is within the frustum.
 * Checks corners, center, and whether the camera is inside the bbox
 * or the frustum edges intersect the bbox edges.
 */
function surfaceInFrustum(element, playerX, playerY, sinAngle, cosAngle, halfFov) {
    const minX = element._minX - playerX;
    const maxX = element._maxX - playerX;
    const minY = element._minY - playerY;
    const maxY = element._maxY - playerY;

    // Camera is inside the bounding box — always visible
    if (minX <= 0 && maxX >= 0 && minY <= 0 && maxY >= 0) return true;

    // Any corner or center in frustum
    if (pointInFrustum(minX, minY, sinAngle, cosAngle, halfFov) ||
        pointInFrustum(maxX, minY, sinAngle, cosAngle, halfFov) ||
        pointInFrustum(minX, maxY, sinAngle, cosAngle, halfFov) ||
        pointInFrustum(maxX, maxY, sinAngle, cosAngle, halfFov) ||
        pointInFrustum((minX + maxX) / 2, (minY + maxY) / 2, sinAngle, cosAngle, halfFov)) {
        return true;
    }

    // Check if frustum edges intersect bbox edges.
    // The left and right frustum rays can cross a large bbox even when
    // no corners are in the frustum.
    const sinH = Math.sin(halfFov);
    const cosH = Math.cos(halfFov);
    const leftDirX = -sinH * cosAngle - cosH * sinAngle;
    const leftDirY = -sinH * sinAngle + cosH * cosAngle;
    const rightDirX = sinH * cosAngle - cosH * sinAngle;
    const rightDirY = sinH * sinAngle + cosH * cosAngle;

    return rayIntersectsAABB(0, 0, leftDirX, leftDirY, minX, minY, maxX, maxY) ||
           rayIntersectsAABB(0, 0, rightDirX, rightDirY, minX, minY, maxX, maxY);
}

/**
 * Tests whether a ray from (ox,oy) in direction (dx,dy) intersects an AABB.
 * Uses the slab method — only checks forward hits (t > 0).
 */
function rayIntersectsAABB(ox, oy, dx, dy, minX, minY, maxX, maxY) {
    let tmin = 0;
    let tmax = 1e9;

    if (dx !== 0) {
        const tx1 = (minX - ox) / dx;
        const tx2 = (maxX - ox) / dx;
        tmin = Math.max(tmin, Math.min(tx1, tx2));
        tmax = Math.min(tmax, Math.max(tx1, tx2));
    } else if (ox < minX || ox > maxX) {
        return false;
    }

    if (dy !== 0) {
        const ty1 = (minY - oy) / dy;
        const ty2 = (maxY - oy) / dy;
        tmin = Math.max(tmin, Math.min(ty1, ty2));
        tmax = Math.min(tmax, Math.max(ty1, ty2));
    } else if (oy < minY || oy > maxY) {
        return false;
    }

    return tmax >= tmin;
}

/**
 * Tests whether a wall faces toward the camera (backface culling).
 * The wall normal points perpendicular to the wall surface. If the dot
 * product of (camera → wall center) and the wall normal is positive,
 * the wall faces away from the camera.
 */
function wallFacesCamera(wallData, wallAngle, midX, midY, playerX, playerY) {
    // Wall normal: perpendicular to the wall direction (right-hand side = front in DOOM)
    const normalX = Math.sin(wallAngle);
    const normalY = -Math.cos(wallAngle);

    // Vector from wall center to camera
    const toCameraX = playerX - midX;
    const toCameraY = playerY - midY;

    // Dot product > 0 means the wall faces toward the camera
    return normalX * toCameraX + normalY * toCameraY > 0;
}

// Elements must be at least this far past the sky wall intersection
// point (along the ray from the player) to be culled.
const SKY_CULL_MARGIN = 128;

// Elements in sky sectors closer than this distance are never sky-culled —
// they are visible perimeter walls of a nearby outdoor area.
const SKY_EXEMPT_DISTANCE_SQ = 1500 * 1500;

/**
 * Tests whether a sky wall segment lies between the player and the element.
 * Casts a ray from the player to the element and checks if it crosses any
 * sky wall segment. If so, and the element is far enough past the crossing
 * point, the element is culled.
 */
function behindSkyWall(x, y, z, sectorIndex, playerX, playerY, skyPlanes) {
    // Nearby elements in sky sectors are visible outdoor perimeter — skip culling.
    if (sceneState.skyGroupOf?.has(sectorIndex)) {
        const dx2 = x - playerX, dy2 = y - playerY;
        if (dx2 * dx2 + dy2 * dy2 < SKY_EXEMPT_DISTANCE_SQ) return false;
    }

    const dx = x - playerX;
    const dy = y - playerY;

    for (let i = 0, len = skyPlanes.length; i < len; i++) {
        const plane = skyPlanes[i];

        // Don't cull elements in the same connected sky group as this sky
        // wall — they form the visible perimeter of the same outdoor area.
        // Elements in unrelated sky groups should still be culled.
        if (plane.skyGroup !== undefined && sceneState.skyGroupOf?.get(sectorIndex) === plane.skyGroup) continue;

        // Only cull elements above the sky wall's floor — below that,
        // the element could be visible through a window or doorway.
        if (z < plane.floorZ) continue;

        // Ray-segment intersection: ray from player in direction (dx,dy)
        // against wall segment from A to B.
        const sx = plane.bx - plane.ax;
        const sy = plane.by - plane.ay;

        const denom = dx * sy - dy * sx;
        if (denom === 0) continue; // parallel

        // t = parameter along the ray (0=player, 1=element)
        const t = ((plane.ax - playerX) * sy - (plane.ay - playerY) * sx) / denom;
        if (t <= 0 || t >= 1) continue; // intersection not between player and element

        // u = parameter along the wall segment (0=A, 1=B)
        const u = ((plane.ax - playerX) * dy - (plane.ay - playerY) * dx) / denom;
        if (u < 0 || u > 1) continue; // intersection outside the wall segment

        // The ray crosses this sky wall. Check if the element is far
        // enough past the intersection point.
        const totalDist = Math.sqrt(dx * dx + dy * dy);
        const pastWallDist = (1 - t) * totalDist;
        if (pastWallDist < SKY_CULL_MARGIN) continue;

        return true;
    }
    return false;
}

/** Debug: trace sky culling for a wall by ID. Call via traceSky('ld489'). */
export function debugSkyTrace(wallId) {
    const el = sceneState.wallElements.find(e => e.id === wallId);
    if (!el) { console.log(`Wall ${wallId} not found in wallElements`); return; }

    const playerX = state.playerX, playerY = state.playerY;
    const x = el._midX, y = el._midY;
    const z = el._wall ? el._wall.topHeight : 0;
    const dx = x - playerX, dy = y - playerY;
    const totalDist = Math.sqrt(dx * dx + dy * dy);
    const skyPlanes = sceneState.skyWallPlanes;
    const skySectors = sceneState.skySectors;

    console.log(`--- traceSky(${wallId}) ---`);
    console.log(`Player: (${Math.round(playerX)}, ${Math.round(playerY)})`);
    console.log(`Wall mid: (${Math.round(x)}, ${Math.round(y)}), topHeight: ${z}, sector: ${el._sectorIndex}`);
    console.log(`Distance: ${Math.round(totalDist)}, sector: ${el._sectorIndex}`);
    console.log(`Sky planes: ${skyPlanes.length}`);

    let closest = null;
    for (let i = 0; i < skyPlanes.length; i++) {
        const plane = skyPlanes[i];
        const sx = plane.bx - plane.ax, sy = plane.by - plane.ay;
        const denom = dx * sy - dy * sx;
        if (denom === 0) continue;
        const t = ((plane.ax - playerX) * sy - (plane.ay - playerY) * sx) / denom;
        const u = ((plane.ax - playerX) * dy - (plane.ay - playerY) * dx) / denom;

        const info = {
            i, t: +t.toFixed(4), u: +u.toFixed(4),
            from: `${plane.ax},${plane.ay}`, to: `${plane.bx},${plane.by}`,
            floorZ: plane.floorZ,
        };

        if (el._sectorIndex === plane.sectorIndex) { info.reason = `same sector ${plane.sectorIndex}`; }
        else if (t <= 0 || t >= 1) { info.reason = `t out of range`; }
        else if (u < 0 || u > 1) { info.reason = `u out of range`; }
        else if (z < plane.floorZ) { info.reason = `z ${z} < floorZ ${plane.floorZ}`; }
        else {
            const pastWallDist = (1 - t) * totalDist;
            info.pastWallDist = Math.round(pastWallDist);
            if (pastWallDist < SKY_CULL_MARGIN) info.reason = `pastWallDist ${Math.round(pastWallDist)} < margin ${SKY_CULL_MARGIN}`;
            else info.reason = 'WOULD CULL';
        }

        if (info.reason !== 't out of range' && info.reason !== 'u out of range') {
            console.log(info);
        }
        if (!closest || Math.abs(t - 0.5) < Math.abs(closest.t - 0.5)) closest = info;
    }
    if (!closest) console.log('No sky wall intersections found at all');
}

/**
 * Run culling checks on all scene elements. Called each frame from the game loop.
 * Elements are hidden/shown by toggling the `hidden` attribute which maps to
 * `display: none` and fully removes them from compositor work.
 */
export function updateCulling() {
    const anyCulling = culling.frustum || culling.distance || culling.backface || culling.sky;

    let total = 0;
    let culled = 0;
    let distanceCulled = 0;
    let backfaceCulled = 0;
    let frustumCulled = 0;
    let skyCulled = 0;

    const playerX = state.playerX;
    const playerY = state.playerY;
    const distSq = MAX_RENDER_DISTANCE * MAX_RENDER_DISTANCE;
    const skyPlanes = culling.sky ? sceneState.skyWallPlanes : null;

    // Precompute frustum parameters
    const sinAngle = Math.sin(state.playerAngle);
    const cosAngle = Math.cos(state.playerAngle);
    const halfFov = Math.atan2(window.innerWidth / 2, sceneState.perspectiveValue) + FRUSTUM_MARGIN;

    // Cull walls
    const walls = sceneState.wallElements;
    for (let i = 0, len = walls.length; i < len; i++) {
        const el = walls[i];
        total++;

        if (!anyCulling) {
            if (el.hidden) el.hidden = false;
            continue;
        }

        let hide = false;

        if (!hide && culling.distance && el._midX !== undefined) {
            const dx = el._midX - playerX;
            const dy = el._midY - playerY;
            if (dx * dx + dy * dy > distSq) { hide = true; distanceCulled++; }
        }

        if (!hide && culling.backface && el._wall) {
            if (!wallFacesCamera(el._wall, el._angle, el._midX, el._midY, playerX, playerY)) {
                hide = true; backfaceCulled++;
            }
        }

        if (!hide && culling.frustum && el._wall) {
            if (!wallInFrustum(el._wall, playerX, playerY, sinAngle, cosAngle, halfFov)) {
                hide = true; frustumCulled++;
            }
        }

        if (!hide && skyPlanes && skyPlanes.length > 0 && el._midX !== undefined) {
            if (behindSkyWall(el._midX, el._midY, el._wall ? el._wall.topHeight : 0, el._sectorIndex, playerX, playerY, skyPlanes)) {
                hide = true; skyCulled++;
            }
        }

        if (hide) culled++;
        if (el.hidden !== hide) el.hidden = hide;
    }

    // Cull surfaces (floors/ceilings)
    const surfaces = sceneState.surfaceElements;
    for (let i = 0, len = surfaces.length; i < len; i++) {
        const el = surfaces[i];
        total++;

        // In spectator mode, CSS controls ceiling visibility — skip culling
        if (spectatorActive && el.className === 'ceiling') continue;

        if (!anyCulling) {
            if (el.hidden) el.hidden = false;
            continue;
        }

        let hide = false;

        if (!hide && culling.distance) {
            const dx = el._midX - playerX;
            const dy = el._midY - playerY;
            if (dx * dx + dy * dy > distSq) { hide = true; distanceCulled++; }
        }

        if (!hide && culling.frustum) {
            if (!surfaceInFrustum(el, playerX, playerY, sinAngle, cosAngle, halfFov)) {
                hide = true; frustumCulled++;
            }
        }

        if (!hide && skyPlanes && skyPlanes.length > 0) {
            if (behindSkyWall(el._midX, el._midY, el._height, el._sectorIndex, playerX, playerY, skyPlanes)) {
                hide = true; skyCulled++;
            }
        }

        if (hide) culled++;
        if (el.hidden !== hide) el.hidden = hide;
    }

    // Cull things (enemies, pickups, decorations)
    const things = sceneState.thingContainers;
    for (let i = 0, len = things.length; i < len; i++) {
        const t = things[i];
        total++;

        // Skip dead/collected things — but ensure visibility is restored
        // so death/explosion animations can play even if the thing was
        // previously culled offscreen.
        const gameEntry = t.gameId !== undefined ? state.things[t.gameId] : null;
        if (gameEntry?.collected) {
            if (t.element.hidden) t.element.hidden = false;
            continue;
        }

        if (!anyCulling) {
            if (t.element.hidden) t.element.hidden = false;
            continue;
        }

        const relX = t.x - playerX;
        const relY = t.y - playerY;
        let hide = false;

        if (culling.distance) {
            if (relX * relX + relY * relY > distSq) { hide = true; distanceCulled++; }
        }

        if (!hide && culling.frustum) {
            if (!pointInFrustum(relX, relY, sinAngle, cosAngle, halfFov)) {
                hide = true; frustumCulled++;
            }
        }

        if (!hide && skyPlanes && skyPlanes.length > 0) {
            if (behindSkyWall(t.x, t.y, 0, -1, playerX, playerY, skyPlanes)) {
                hide = true; skyCulled++;
            }
        }

        if (hide) culled++;
        if (t.element.hidden !== hide) t.element.hidden = hide;
    }

    cullingStats.total = total;
    cullingStats.culled = culled;
    cullingStats.afterDistance = total - distanceCulled;
    cullingStats.afterBackface = cullingStats.afterDistance - backfaceCulled;
    cullingStats.afterFrustum = cullingStats.afterBackface - frustumCulled;
    cullingStats.afterSky = cullingStats.afterFrustum - skyCulled;
}

const CULLING_INTERVAL = 3; // Run every N frames
let frameCount = 0;

function cullingLoop() {
    frameCount++;
    if (frameCount >= CULLING_INTERVAL) {
        frameCount = 0;
        updateCulling();
    }
    requestAnimationFrame(cullingLoop);
}

export function startCullingLoop() {
    requestAnimationFrame(cullingLoop);
}
