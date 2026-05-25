/**
 * DOOM 3D Wireframe Renderer with Depth Buffer
 * Optimized version with object pooling and reduced allocations
 */

// Configurable settings with defaults
let settings = {
    maxRenderDistance: 1000,
    depthBufferWidth: 640,
    depthBufferHeight: 400,
    edgeSampleInterval: 1,
    renderFloorsCeilings: true,
    drawBorder: true,
    debugDisableDepthTest: false,  // When true, shows all edges without visibility testing
    debugDisableBackfaceCull: false  // When true, skips back-face culling
};

// Current depth buffer dimensions
let DEPTH_WIDTH = 640;
let DEPTH_HEIGHT = 400;

// Reusable buffers
let depthBuffer = null;
let lastDepthSize = 0;

// Pre-allocated arrays for visibility testing (avoid per-edge allocation)
let visibilityBuffer = null;
let smoothedBuffer = null;
let maxVisibilitySamples = 256;

// Pre-allocated intersection buffer for rasterization
const MAX_INTERSECTIONS = 32;
const intersectionX = new Float32Array(MAX_INTERSECTIONS);
const intersectionDepth = new Float32Array(MAX_INTERSECTIONS);

// Pre-allocated edge buffer for rasterization
const MAX_EDGES = 64;
const edgeYMin = new Float32Array(MAX_EDGES);
const edgeYMax = new Float32Array(MAX_EDGES);
const edgeX = new Float32Array(MAX_EDGES);
const edgeDx = new Float32Array(MAX_EDGES);
const edgeDepth = new Float32Array(MAX_EDGES);
const edgeDDepth = new Float32Array(MAX_EDGES);

// Reusable result arrays (cleared each frame)
let polygonPool = [];
let transformedPool = [];
let visibleLinesPool = [];
let doorWallsPool = [];

/**
 * Update renderer settings
 */
export function setRendererSettings(newSettings) {
    Object.assign(settings, newSettings);
    DEPTH_WIDTH = settings.depthBufferWidth;
    DEPTH_HEIGHT = settings.depthBufferHeight;

    const newSize = DEPTH_WIDTH * DEPTH_HEIGHT;
    if (newSize !== lastDepthSize) {
        depthBuffer = null;
        lastDepthSize = newSize;
    }
}

/**
 * Ensure visibility buffers are large enough
 */
function ensureVisibilityBuffers(size) {
    if (size > maxVisibilitySamples) {
        maxVisibilitySamples = Math.max(size, maxVisibilitySamples * 2);
        visibilityBuffer = new Uint8Array(maxVisibilitySamples);
        smoothedBuffer = new Uint8Array(maxVisibilitySamples);
    }
    if (!visibilityBuffer) {
        visibilityBuffer = new Uint8Array(maxVisibilitySamples);
        smoothedBuffer = new Uint8Array(maxVisibilitySamples);
    }
}

/**
 * Render scene with proper depth-buffered occlusion
 */
export function renderScene3D(walls, camera, sectorPolygons = []) {
    // Reset pools
    polygonPool.length = 0;
    transformedPool.length = 0;
    visibleLinesPool.length = 0;
    doorWallsPool.length = 0;

    // Step 1: Collect polygons (reusing pool)
    collectPolygonsOptimized(walls, sectorPolygons, camera, polygonPool, doorWallsPool);

    // Step 2: Transform and filter
    const cos = Math.cos(-camera.angle);
    const sin = Math.sin(-camera.angle);
    const fovScale = Math.tan(camera.fov / 2);
    const aspect = DEPTH_WIDTH / DEPTH_HEIGHT;
    const nearPlane = camera.nearPlane;
    const camX = camera.x;
    const camY = camera.y;
    const camZ = camera.z;

    // Step 3: Create/reuse depth buffer
    if (!depthBuffer) {
        depthBuffer = new Float32Array(DEPTH_WIDTH * DEPTH_HEIGHT);
    }
    // Fast fill with Infinity
    for (let i = 0, len = depthBuffer.length; i < len; i++) {
        depthBuffer[i] = Infinity;
    }

    // Process each polygon: transform, cull, rasterize
    for (let p = 0; p < polygonPool.length; p++) {
        const poly = polygonPool[p];
        const verts = poly.vertices;
        const vertCount = verts.length;
        if (vertCount < 3) continue;

        // Transform to camera space (inline for speed)
        let allBehind = true;
        let allInFront = true;
        let centerX = 0, centerY = 0, centerZ = 0;
        let visibleCenterX = 0, visibleCenterY = 0, visibleCenterZ = 0;
        let visibleCount = 0;

        // Use temporary arrays for camera-space vertices
        const camVerts = poly._camVerts || (poly._camVerts = []);
        camVerts.length = vertCount;

        for (let i = 0; i < vertCount; i++) {
            const v = verts[i];
            const relX = v.x - camX;
            const relY = v.y - camY;
            const relZ = v.z - camZ;

            const cx = relX * cos - relY * sin;
            const cy = relX * sin + relY * cos;
            const cz = relZ;

            if (!camVerts[i]) camVerts[i] = { x: 0, y: 0, z: 0 };
            camVerts[i].x = cx;
            camVerts[i].y = cy;
            camVerts[i].z = cz;

            centerX += cx;
            centerY += cy;
            centerZ += cz;

            if (cy >= nearPlane) {
                allBehind = false;
                // Track center of visible vertices only
                visibleCenterX += cx;
                visibleCenterY += cy;
                visibleCenterZ += cz;
                visibleCount++;
            } else {
                allInFront = false;
            }
        }

        if (allBehind) continue;

        // Back-face culling - skip for polygons crossing the near plane
        // (unreliable normal/center when vertices are on both sides)
        const crossesNearPlane = !allInFront && !allBehind;

        if (!crossesNearPlane && !settings.debugDisableBackfaceCull) {
            centerX /= vertCount;
            centerY /= vertCount;
            centerZ /= vertCount;

            let nx, ny, nz;
            if (poly.type === 'floor') {
                nx = 0; ny = 0; nz = 1;
            } else if (poly.type === 'ceiling') {
                nx = 0; ny = 0; nz = -1;
            } else {
                // Calculate normal from first 3 vertices
                const v0 = camVerts[0], v1 = camVerts[1], v2 = camVerts[2];
                const e1x = v1.x - v0.x, e1y = v1.y - v0.y, e1z = v1.z - v0.z;
                const e2x = v2.x - v0.x, e2y = v2.y - v0.y, e2z = v2.z - v0.z;
                nx = e1y * e2z - e1z * e2y;
                ny = e1z * e2x - e1x * e2z;
                nz = e1x * e2y - e1y * e2x;
                const len = Math.sqrt(nx * nx + ny * ny + nz * nz);
                if (len > 0.0001) { nx /= len; ny /= len; nz /= len; }
            }

            const dot = nx * (-centerX) + ny * (-centerY) + nz * (-centerZ);
            if (dot <= 0) continue; // Back-facing
        }

        // Clip to near plane and project
        const screenVerts = poly._screenVerts || (poly._screenVerts = []);
        let screenCount = 0;

        for (let i = 0; i < vertCount; i++) {
            const current = camVerts[i];
            const next = camVerts[(i + 1) % vertCount];
            const currentInside = current.y >= nearPlane;
            const nextInside = next.y >= nearPlane;

            if (currentInside) {
                // Project current vertex
                const depth = current.y;
                const sx = (current.x / (depth * fovScale)) * 0.5 + 0.5;
                const sy = (current.z / (depth * fovScale / aspect)) * 0.5 + 0.5;

                if (!screenVerts[screenCount]) screenVerts[screenCount] = { screenX: 0, screenY: 0, depth: 0 };
                screenVerts[screenCount].screenX = sx * DEPTH_WIDTH;
                screenVerts[screenCount].screenY = (1 - sy) * DEPTH_HEIGHT;
                screenVerts[screenCount].depth = depth;
                screenCount++;

                if (!nextInside) {
                    // Add intersection
                    const t = (nearPlane - current.y) / (next.y - current.y);
                    const ix = current.x + t * (next.x - current.x);
                    const iz = current.z + t * (next.z - current.z);
                    const isx = (ix / (nearPlane * fovScale)) * 0.5 + 0.5;
                    const isy = (iz / (nearPlane * fovScale / aspect)) * 0.5 + 0.5;

                    if (!screenVerts[screenCount]) screenVerts[screenCount] = { screenX: 0, screenY: 0, depth: 0 };
                    screenVerts[screenCount].screenX = isx * DEPTH_WIDTH;
                    screenVerts[screenCount].screenY = (1 - isy) * DEPTH_HEIGHT;
                    screenVerts[screenCount].depth = nearPlane;
                    screenCount++;
                }
            } else if (nextInside) {
                // Add intersection only
                const t = (nearPlane - current.y) / (next.y - current.y);
                const ix = current.x + t * (next.x - current.x);
                const iz = current.z + t * (next.z - current.z);
                const isx = (ix / (nearPlane * fovScale)) * 0.5 + 0.5;
                const isy = (iz / (nearPlane * fovScale / aspect)) * 0.5 + 0.5;

                if (!screenVerts[screenCount]) screenVerts[screenCount] = { screenX: 0, screenY: 0, depth: 0 };
                screenVerts[screenCount].screenX = isx * DEPTH_WIDTH;
                screenVerts[screenCount].screenY = (1 - isy) * DEPTH_HEIGHT;
                screenVerts[screenCount].depth = nearPlane;
                screenCount++;
            }
        }

        if (screenCount < 3) continue;

        // Check screen bounds
        let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
        for (let i = 0; i < screenCount; i++) {
            const sx = screenVerts[i].screenX;
            const sy = screenVerts[i].screenY;
            if (sx < minX) minX = sx;
            if (sx > maxX) maxX = sx;
            if (sy < minY) minY = sy;
            if (sy > maxY) maxY = sy;
        }

        if (maxX < 0 || minX >= DEPTH_WIDTH || maxY < 0 || minY >= DEPTH_HEIGHT) continue;

        // Rasterize to depth buffer
        rasterizePolygonOptimized(screenVerts, screenCount, depthBuffer);

        // Store for edge extraction
        poly._screenCount = screenCount;
        transformedPool.push(poly);
    }

    // Extract visible edges (only from walls - floor/ceiling edges cause occlusion artifacts)
    if (debugCaptureEnabled) {
        debugCameraInfo = { x: camera.x.toFixed(1), y: camera.y.toFixed(1), z: camera.z.toFixed(1), angle: (camera.angle * 180 / Math.PI).toFixed(1) };
    }
    for (let p = 0; p < transformedPool.length; p++) {
        const poly = transformedPool[p];
        // Skip edge extraction for floors/ceilings - they're only used for depth occlusion
        // Their edges would incorrectly appear through floors above them due to depth-buffer limitations
        if (poly.type === 'floor' || poly.type === 'ceiling') continue;
        debugCurrentPolyType = poly.type || 'unknown';
        extractVisibleEdgesOptimized(poly._screenVerts, poly._screenCount, depthBuffer, visibleLinesPool);
    }

    // Add door chevron indicators
    addDoorChevrons(doorWallsPool, camera, depthBuffer, visibleLinesPool);

    // Add border frame if enabled
    if (settings.drawBorder) {
        const b = 0.98; // Slightly inset from edge
        visibleLinesPool.push(
            { start: [-b, -b], end: [b, -b] },  // Bottom
            { start: [b, -b], end: [b, b] },    // Right
            { start: [b, b], end: [-b, b] },    // Top
            { start: [-b, b], end: [-b, -b] }   // Left
        );
    }

    // Output debug capture and reset
    if (debugCaptureEnabled) {
        debugCaptureEnabled = false;
        console.log(`[DEBUG CAPTURE] Frame complete. Total polygons: ${transformedPool.length}, Total edges output: ${visibleLinesPool.length}`);
        console.log(`[DEBUG CAPTURE] Camera: x=${debugCameraInfo.x}, y=${debugCameraInfo.y}, z=${debugCameraInfo.z}, angle=${debugCameraInfo.angle}°`);
        console.log(`[DEBUG CAPTURE] Captured ${debugCapturedEdges.length} problem/borderline edges`);
        for (let i = 0; i < Math.min(debugCapturedEdges.length, 20); i++) {
            const edge = debugCapturedEdges[i];
            let status;
            if (edge.fullyVisible) status = '[VISIBLE]';
            else if (edge.borderline) status = '[BORDERLINE]';
            else status = '[OCCLUDED]';
            console.log(`\n[Edge ${i + 1}] ${status} (${edge.polyType})`);
            console.log(`  v1: screen(${edge.v1.screenX.toFixed(1)}, ${edge.v1.screenY.toFixed(1)}) depth=${edge.v1.depth.toFixed(1)}`);
            console.log(`  v2: screen(${edge.v2.screenX.toFixed(1)}, ${edge.v2.screenY.toFixed(1)}) depth=${edge.v2.depth.toFixed(1)}`);
            console.log(`  Visible: ${edge.visibleCount}/${edge.numSamples} samples`);
            console.log(`  Samples: ${edge.sampleDetails}`);
        }
        debugCapturedEdges = [];
        debugCameraInfo = null;
    }

    return visibleLinesPool;
}

/**
 * Collect polygons with distance culling (optimized)
 */
function collectPolygonsOptimized(walls, sectorPolygons, camera, output, doorWalls) {
    const camX = camera.x;
    const camY = camera.y;
    const useDistanceCulling = settings.maxRenderDistance > 0;
    const maxDistSq = settings.maxRenderDistance * settings.maxRenderDistance;

    // Process walls
    for (let i = 0, len = walls.length; i < len; i++) {
        const wall = walls[i];

        if (useDistanceCulling) {
            const midX = (wall.start.x + wall.end.x) * 0.5;
            const midY = (wall.start.y + wall.end.y) * 0.5;
            const dx = midX - camX;
            const dy = midY - camY;
            if (dx * dx + dy * dy > maxDistSq) continue;
        }

        // Track door walls for chevron rendering
        if (wall.isDoor) {
            doorWalls.push(wall);
        }

        // Reuse or create polygon object
        const poly = getPooledPolygon(output.length);
        poly.type = 'wall';
        poly.vertices.length = 4;

        if (!poly.vertices[0]) poly.vertices[0] = { x: 0, y: 0, z: 0 };
        if (!poly.vertices[1]) poly.vertices[1] = { x: 0, y: 0, z: 0 };
        if (!poly.vertices[2]) poly.vertices[2] = { x: 0, y: 0, z: 0 };
        if (!poly.vertices[3]) poly.vertices[3] = { x: 0, y: 0, z: 0 };

        poly.vertices[0].x = wall.start.x; poly.vertices[0].y = wall.start.y; poly.vertices[0].z = wall.bottomHeight;
        poly.vertices[1].x = wall.end.x; poly.vertices[1].y = wall.end.y; poly.vertices[1].z = wall.bottomHeight;
        poly.vertices[2].x = wall.end.x; poly.vertices[2].y = wall.end.y; poly.vertices[2].z = wall.topHeight;
        poly.vertices[3].x = wall.start.x; poly.vertices[3].y = wall.start.y; poly.vertices[3].z = wall.topHeight;

        output.push(poly);
    }

    if (!settings.renderFloorsCeilings) return;

    // Process sectors
    for (let s = 0, slen = sectorPolygons.length; s < slen; s++) {
        const sector = sectorPolygons[s];
        const boundaries = sector.boundaries;

        for (let b = 0; b < boundaries.length; b++) {
            const boundary = boundaries[b];
            if (!boundary || boundary.length < 3) continue;

            if (useDistanceCulling) {
                const v0 = boundary[0];
                const dx = v0.x - camX;
                const dy = v0.y - camY;
                if (dx * dx + dy * dy > maxDistSq) continue;
            }

            // Floor
            const floorPoly = getPooledPolygon(output.length);
            floorPoly.type = 'floor';
            floorPoly.vertices.length = boundary.length;
            for (let i = 0; i < boundary.length; i++) {
                if (!floorPoly.vertices[i]) floorPoly.vertices[i] = { x: 0, y: 0, z: 0 };
                floorPoly.vertices[i].x = boundary[i].x;
                floorPoly.vertices[i].y = boundary[i].y;
                floorPoly.vertices[i].z = sector.floorHeight;
            }
            output.push(floorPoly);

            // Ceiling
            const ceilPoly = getPooledPolygon(output.length);
            ceilPoly.type = 'ceiling';
            ceilPoly.vertices.length = boundary.length;
            for (let i = 0; i < boundary.length; i++) {
                if (!ceilPoly.vertices[i]) ceilPoly.vertices[i] = { x: 0, y: 0, z: 0 };
                ceilPoly.vertices[i].x = boundary[i].x;
                ceilPoly.vertices[i].y = boundary[i].y;
                ceilPoly.vertices[i].z = sector.ceilingHeight;
            }
            output.push(ceilPoly);
        }
    }
}

// Polygon pool
const polygonPoolCache = [];
function getPooledPolygon(index) {
    if (index < polygonPoolCache.length) {
        return polygonPoolCache[index];
    }
    const poly = { type: '', vertices: [], _camVerts: [], _screenVerts: [], _screenCount: 0 };
    polygonPoolCache.push(poly);
    return poly;
}

/**
 * Rasterize polygon to depth buffer (optimized)
 */
function rasterizePolygonOptimized(verts, vertCount, depthBuffer) {
    // Find Y bounds
    let minY = Infinity, maxY = -Infinity;
    for (let i = 0; i < vertCount; i++) {
        const sy = verts[i].screenY;
        if (sy < minY) minY = sy;
        if (sy > maxY) maxY = sy;
    }

    const yMin = Math.max(0, Math.floor(minY));
    const yMax = Math.min(DEPTH_HEIGHT - 1, Math.ceil(maxY));
    if (yMin > yMax) return;

    // Build edge table (using pre-allocated arrays)
    // Use 1/depth (w) for perspective-correct interpolation
    let edgeCount = 0;
    for (let i = 0; i < vertCount && edgeCount < MAX_EDGES; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % vertCount];
        const dy = v2.screenY - v1.screenY;
        if (Math.abs(dy) < 0.001) continue;

        const top = v1.screenY < v2.screenY ? v1 : v2;
        const bottom = v1.screenY < v2.screenY ? v2 : v1;

        edgeYMin[edgeCount] = top.screenY;
        edgeYMax[edgeCount] = bottom.screenY;
        edgeX[edgeCount] = top.screenX;
        edgeDx[edgeCount] = (bottom.screenX - top.screenX) / (bottom.screenY - top.screenY);
        // Store 1/depth for perspective-correct interpolation
        const topW = 1 / top.depth;
        const bottomW = 1 / bottom.depth;
        edgeDepth[edgeCount] = topW;
        edgeDDepth[edgeCount] = (bottomW - topW) / (bottom.screenY - top.screenY);
        edgeCount++;
    }

    // Scanline fill
    for (let y = yMin; y <= yMax; y++) {
        let intCount = 0;

        for (let e = 0; e < edgeCount && intCount < MAX_INTERSECTIONS; e++) {
            if (y >= edgeYMin[e] && y < edgeYMax[e]) {
                const t = y - edgeYMin[e];
                intersectionX[intCount] = edgeX[e] + t * edgeDx[e];
                intersectionDepth[intCount] = edgeDepth[e] + t * edgeDDepth[e];
                intCount++;
            }
        }

        // Sort intersections by X (simple insertion sort for small arrays)
        for (let i = 1; i < intCount; i++) {
            const x = intersectionX[i];
            const d = intersectionDepth[i];
            let j = i - 1;
            while (j >= 0 && intersectionX[j] > x) {
                intersectionX[j + 1] = intersectionX[j];
                intersectionDepth[j + 1] = intersectionDepth[j];
                j--;
            }
            intersectionX[j + 1] = x;
            intersectionDepth[j + 1] = d;
        }

        // Fill spans (intersectionDepth now contains 1/depth values)
        for (let i = 0; i + 1 < intCount; i += 2) {
            const leftX = intersectionX[i];
            const rightX = intersectionX[i + 1];
            const leftW = intersectionDepth[i];   // 1/depth
            const rightW = intersectionDepth[i + 1]; // 1/depth

            // Use ceil/floor to avoid extrapolating outside polygon bounds
            // Extrapolation can produce depths smaller than actual edge depth,
            // causing edge visibility tests to fail
            const xMin = Math.max(0, Math.ceil(leftX - 0.5));
            const xMax = Math.min(DEPTH_WIDTH - 1, Math.floor(rightX + 0.5));
            if (xMin > xMax) continue;

            const spanWidth = rightX - leftX;
            const dW = spanWidth > 0.001 ? (rightW - leftW) / spanWidth : 0;
            const baseIdx = y * DEPTH_WIDTH;

            for (let x = xMin; x <= xMax; x++) {
                // Clamp interpolation to actual span bounds to prevent extrapolation
                const clampedX = Math.max(leftX, Math.min(rightX, x));
                const w = leftW + (clampedX - leftX) * dW;
                const depth = 1 / w;
                const idx = baseIdx + x;
                if (depth < depthBuffer[idx]) {
                    depthBuffer[idx] = depth;
                }
            }
        }
    }
}

// Debug logging - triggered by button, captures one frame only
let debugCaptureEnabled = false;
let debugCapturedEdges = [];
let debugCurrentPolyType = '';
let debugCameraInfo = null;

/**
 * Enable debug capture for next frame
 */
export function triggerDebugCapture() {
    debugCaptureEnabled = true;
    debugCapturedEdges = [];
    console.log('[DEBUG] Capture enabled for next frame');
}

/**
 * Clip a line segment to screen bounds using Cohen-Sutherland algorithm
 * Returns null if entirely outside, or clipped {x1, y1, x2, y2, t1, t2}
 * t1 and t2 are the parametric values along the original line
 */
function clipLineToScreen(x1, y1, x2, y2) {
    const INSIDE = 0, LEFT = 1, RIGHT = 2, BOTTOM = 4, TOP = 8;
    const xmin = 0, xmax = DEPTH_WIDTH - 1, ymin = 0, ymax = DEPTH_HEIGHT - 1;

    function computeCode(x, y) {
        let code = INSIDE;
        if (x < xmin) code |= LEFT;
        else if (x > xmax) code |= RIGHT;
        if (y < ymin) code |= BOTTOM;
        else if (y > ymax) code |= TOP;
        return code;
    }

    let code1 = computeCode(x1, y1);
    let code2 = computeCode(x2, y2);
    let t1 = 0, t2 = 1;
    const dx = x2 - x1, dy = y2 - y1;

    while (true) {
        if (!(code1 | code2)) {
            // Both inside
            return { x1, y1, x2, y2, t1, t2 };
        }
        if (code1 & code2) {
            // Both outside same region
            return null;
        }

        // Pick point outside
        const codeOut = code1 ? code1 : code2;
        let x, y, t;

        if (codeOut & TOP) {
            t = (ymax - y1) / dy;
            x = x1 + t * dx;
            y = ymax;
        } else if (codeOut & BOTTOM) {
            t = (ymin - y1) / dy;
            x = x1 + t * dx;
            y = ymin;
        } else if (codeOut & RIGHT) {
            t = (xmax - x1) / dx;
            x = xmax;
            y = y1 + t * dy;
        } else {
            t = (xmin - x1) / dx;
            x = xmin;
            y = y1 + t * dy;
        }

        if (codeOut === code1) {
            x1 = x; y1 = y;
            t1 = t;
            code1 = computeCode(x1, y1);
        } else {
            x2 = x; y2 = y;
            t2 = t;
            code2 = computeCode(x2, y2);
        }
    }
}

/**
 * Extract visible edges (optimized)
 */
function extractVisibleEdgesOptimized(verts, vertCount, depthBuffer, output) {
    const invWidth = 2 / DEPTH_WIDTH;
    const invHeight = 2 / DEPTH_HEIGHT;

    // Debug mode: skip visibility testing, but still clip to screen bounds
    // Also limit total edges to prevent browser freeze
    if (settings.debugDisableDepthTest) {
        const MAX_DEBUG_EDGES = 2000;
        for (let i = 0; i < vertCount; i++) {
            if (output.length >= MAX_DEBUG_EDGES) return;

            const v1 = verts[i];
            const v2 = verts[(i + 1) % vertCount];

            // Skip edges entirely outside screen bounds
            const minX = Math.min(v1.screenX, v2.screenX);
            const maxX = Math.max(v1.screenX, v2.screenX);
            const minY = Math.min(v1.screenY, v2.screenY);
            const maxY = Math.max(v1.screenY, v2.screenY);

            if (maxX < 0 || minX >= DEPTH_WIDTH || maxY < 0 || minY >= DEPTH_HEIGHT) {
                continue;
            }

            output.push({
                start: [v1.screenX * invWidth - 1, -(v1.screenY * invHeight - 1)],
                end: [v2.screenX * invWidth - 1, -(v2.screenY * invHeight - 1)]
            });
        }
        return;
    }

    for (let i = 0; i < vertCount; i++) {
        const v1 = verts[i];
        const v2 = verts[(i + 1) % vertCount];

        // Clip edge to screen bounds first
        const clipped = clipLineToScreen(v1.screenX, v1.screenY, v2.screenX, v2.screenY);
        if (!clipped) continue; // Edge entirely off-screen

        // Use clipped coordinates for sampling
        const clipX1 = clipped.x1, clipY1 = clipped.y1;
        const clipX2 = clipped.x2, clipY2 = clipped.y2;
        const clipT1 = clipped.t1, clipT2 = clipped.t2;

        const dx = clipX2 - clipX1;
        const dy = clipY2 - clipY1;
        const length = Math.sqrt(dx * dx + dy * dy);

        // Compute depths at clipped endpoints using perspective-correct interpolation
        const w1 = 1 / v1.depth;
        const w2 = 1 / v2.depth;
        const clipW1 = w1 + clipT1 * (w2 - w1);
        const clipW2 = w1 + clipT2 * (w2 - w1);
        const clipDepth1 = 1 / clipW1;
        const clipDepth2 = 1 / clipW2;

        // Detect edges with near-plane clipped vertices
        const minDepth = Math.min(clipDepth1, clipDepth2);
        const maxDepth = Math.max(clipDepth1, clipDepth2);

        // Skip "clipping cap" edges - both vertices at near plane means this edge
        // is an artifact of near-plane clipping, not real geometry
        const bothAtNearPlane = clipDepth1 < 1.0 && clipDepth2 < 1.0;
        if (bothAtNearPlane) continue;

        const hasNearPlaneVertex = minDepth < 1.0;

        const isCloseEdge = minDepth < 100;
        const shouldDebugLog = debugCaptureEnabled && isCloseEdge;

        if (length < 1) {
            // Very short edge
            const mx = (clipX1 + clipX2) * 0.5;
            const my = (clipY1 + clipY2) * 0.5;
            const mDepth = (clipDepth1 + clipDepth2) * 0.5;

            if (isPointVisibleFast(mx, my, mDepth, depthBuffer)) {
                output.push({
                    start: [clipX1 * invWidth - 1, -(clipY1 * invHeight - 1)],
                    end: [clipX2 * invWidth - 1, -(clipY2 * invHeight - 1)]
                });
            }
            continue;
        }

        // Sample along clipped edge - consider both screen length AND depth range
        const sampleInterval = settings.edgeSampleInterval;
        const screenBasedSamples = Math.ceil(length / sampleInterval);

        // Edges spanning large depth ranges need more samples to catch visibility transitions
        const depthRange = Math.abs(clipDepth2 - clipDepth1);
        const depthSampleInterval = 20; // Sample every ~20 units of depth
        const depthBasedSamples = Math.ceil(depthRange / depthSampleInterval);

        const numSamples = Math.min(Math.max(3, screenBasedSamples, depthBasedSamples), maxVisibilitySamples);
        ensureVisibilityBuffers(numSamples);

        const invSamples = 1 / (numSamples - 1);

        // Use perspective-correct depth interpolation along clipped edge
        const dW = clipW2 - clipW1;

        // Collect debug data if needed
        const debugSamples = shouldDebugLog ? [] : null;

        for (let s = 0; s < numSamples; s++) {
            const t = s * invSamples;
            const x = clipX1 + t * dx;
            const y = clipY1 + t * dy;
            // Perspective-correct depth: interpolate 1/depth, then invert
            const w = clipW1 + t * dW;
            const depth = 1 / w;

            let visible;
            if (hasNearPlaneVertex) {
                // For edges with a near-plane clipped vertex, use the far vertex depth for visibility.
                // The interpolated depth near the clipped end is an artifact (perspective-correct
                // interpolation keeps it tiny), so we use maxDepth which represents the real geometry.
                visible = isPointVisibleNearPlane(x, y, maxDepth, depthBuffer);
            } else {
                visible = isPointVisibleFast(x, y, depth, depthBuffer);
            }
            visibilityBuffer[s] = visible ? 1 : 0;

            // Collect debug data
            if (debugSamples) {
                const ix = ((x + 0.5) | 0);
                const iy = ((y + 0.5) | 0);
                const clampedX = Math.max(0, Math.min(DEPTH_WIDTH - 1, ix));
                const clampedY = Math.max(0, Math.min(DEPTH_HEIGHT - 1, iy));
                const bufferDepth = depthBuffer[clampedY * DEPTH_WIDTH + clampedX];
                debugSamples.push({
                    t: t.toFixed(2),
                    x: x.toFixed(0),
                    y: y.toFixed(0),
                    depth: depth.toFixed(1),
                    bufferDepth: bufferDepth.toFixed(1),
                    visible
                });
            }
        }

        // Collect debug info for edges - capture both occluded AND borderline visible edges
        if (debugSamples) {
            const visibleCount = visibilityBuffer.slice(0, numSamples).reduce((a, b) => a + b, 0);

            // Check if any samples are "borderline" - depth close to buffer depth
            let hasBorderlineSamples = false;
            for (const sample of debugSamples) {
                const depthDiff = Math.abs(parseFloat(sample.depth) - parseFloat(sample.bufferDepth));
                const avgDepth = (parseFloat(sample.depth) + parseFloat(sample.bufferDepth)) / 2;
                if (depthDiff < avgDepth * 0.15) { // Within 15% of each other
                    hasBorderlineSamples = true;
                    break;
                }
            }

            // Capture ALL floor/ceiling edges, or occluded/borderline wall edges
            const isFloorCeiling = debugCurrentPolyType === 'floor' || debugCurrentPolyType === 'ceiling';
            const shouldCapture = isFloorCeiling || visibleCount < numSamples * 0.5 || hasBorderlineSamples;

            if (shouldCapture) {
                // Log samples from start, middle, and end, plus specifically visible samples
                const startSamples = debugSamples.slice(0, 2);
                const midIdx = Math.floor(debugSamples.length / 2);
                const midSamples = debugSamples.slice(midIdx, midIdx + 2);
                const endSamples = debugSamples.slice(-2);
                const visibleSamples = debugSamples.filter(s => s.visible).slice(0, 3);

                const formatSample = s => `t=${s.t}@(${s.x},${s.y}):edge=${s.depth}/buf=${s.bufferDepth}/${s.visible ? 'V' : 'O'}`;

                const sampleDetails = [
                    `Start: ${startSamples.map(formatSample).join(', ')}`,
                    `Mid: ${midSamples.map(formatSample).join(', ')}`,
                    `End: ${endSamples.map(formatSample).join(', ')}`,
                    visibleSamples.length > 0 ? `VISIBLE: ${visibleSamples.map(formatSample).join(', ')}` : ''
                ].filter(Boolean).join(' | ');

                debugCapturedEdges.push({
                    polyType: debugCurrentPolyType,
                    v1: { screenX: v1.screenX, screenY: v1.screenY, depth: v1.depth },
                    v2: { screenX: v2.screenX, screenY: v2.screenY, depth: v2.depth },
                    visibleCount,
                    numSamples,
                    borderline: hasBorderlineSamples,
                    fullyVisible: visibleCount === numSamples,
                    sampleDetails
                });
            }
        }

        // Smooth isolated samples
        for (let s = 1; s < numSamples - 1; s++) {
            if (!visibilityBuffer[s] && visibilityBuffer[s - 1] && visibilityBuffer[s + 1]) {
                visibilityBuffer[s] = 1;
            }
        }
        for (let s = 1; s < numSamples - 1; s++) {
            if (visibilityBuffer[s] && !visibilityBuffer[s - 1] && !visibilityBuffer[s + 1]) {
                visibilityBuffer[s] = 0;
            }
        }

        // Copy to smoothed buffer for hysteresis
        for (let s = 0; s < numSamples; s++) {
            smoothedBuffer[s] = visibilityBuffer[s];
        }

        // Apply hysteresis (require 3+ consecutive occluded)
        let s = 0;
        while (s < numSamples) {
            if (!visibilityBuffer[s]) {
                const runStart = s;
                while (s < numSamples && !visibilityBuffer[s]) s++;
                if (s - runStart < 3) {
                    for (let j = runStart; j < s; j++) smoothedBuffer[j] = 1;
                }
            } else {
                s++;
            }
        }

        // Extract segments
        let segStart = -1;
        for (let s = 0; s < numSamples; s++) {
            if (smoothedBuffer[s] && segStart === -1) {
                segStart = s;
            } else if (!smoothedBuffer[s] && segStart !== -1) {
                const t1 = segStart * invSamples;
                const t2 = (s - 1) * invSamples;
                output.push({
                    start: [(clipX1 + t1 * dx) * invWidth - 1, -((clipY1 + t1 * dy) * invHeight - 1)],
                    end: [(clipX1 + t2 * dx) * invWidth - 1, -((clipY1 + t2 * dy) * invHeight - 1)]
                });
                segStart = -1;
            }
        }

        if (segStart !== -1) {
            const t1 = segStart * invSamples;
            output.push({
                start: [(clipX1 + t1 * dx) * invWidth - 1, -((clipY1 + t1 * dy) * invHeight - 1)],
                end: [clipX2 * invWidth - 1, -(clipY2 * invHeight - 1)]
            });
        }
    }
}

/**
 * Fast point visibility check (inlined math)
 * Checks for nearby occluders (narrow pillars etc) that might be missed by point sampling
 */
function isPointVisibleFast(x, y, depth, depthBuffer) {
    if (x < 0 || x >= DEPTH_WIDTH || y < 0 || y >= DEPTH_HEIGHT) return false;

    const ix = (x + 0.5) | 0;
    const iy = (y + 0.5) | 0;
    const clampedX = ix < 0 ? 0 : (ix >= DEPTH_WIDTH ? DEPTH_WIDTH - 1 : ix);
    const clampedY = iy < 0 ? 0 : (iy >= DEPTH_HEIGHT ? DEPTH_HEIGHT - 1 : iy);

    const baseIdx = clampedY * DEPTH_WIDTH;
    const bufferDepth = depthBuffer[baseIdx + clampedX];

    // Epsilon for depth comparison - needs to handle:
    // 1. Z-fighting at polygon boundaries
    // 2. Interpolation mismatch between edge depth (1D) and buffer depth (2D rasterization)
    // The 2D vs 1D interpolation can cause ~5-8% depth differences for the same surface
    const epsilon = depth * 0.08 + 1.0;

    // Near-plane clipping can create edges with interpolated depths very close to
    // the near plane. Only reject samples extremely close to camera where artifacts occur.
    // Threshold of 3.0 catches true near-plane clipping artifacts without rejecting
    // legitimate close walls.
    if (depth < 3.0 && bufferDepth > depth * 5.0) {
        return false; // Near-plane clipping artifact
    }

    // Threshold for detecting occluders - something significantly closer
    const occluderThreshold = depth * 0.8;

    // Check if there's an occluder at the exact pixel
    if (bufferDepth < occluderThreshold) {
        return false;
    }

    // Check a wider area for occluders (2 pixels each direction)
    // This catches narrow pillars that point sampling might straddle
    const searchRadius = 2;
    const xMin = Math.max(0, clampedX - searchRadius);
    const xMax = Math.min(DEPTH_WIDTH - 1, clampedX + searchRadius);

    for (let sx = xMin; sx <= xMax; sx++) {
        if (depthBuffer[baseIdx + sx] < occluderThreshold) {
            return false; // Found an occluder nearby
        }
    }

    // Check if point is in front of buffer (visible)
    if (depth <= bufferDepth + epsilon) {
        return true;
    }

    // If exact pixel fails, check immediate neighbors for polygon boundary seams
    // (only if no occluder was found above)
    if (clampedX > 0 && depth <= depthBuffer[baseIdx + clampedX - 1] + epsilon) return true;
    if (clampedX < DEPTH_WIDTH - 1 && depth <= depthBuffer[baseIdx + clampedX + 1] + epsilon) return true;

    return false;
}

/**
 * Visibility check for near-plane clipped edges
 * Uses the far vertex depth since interpolated depths near the clipped end are artifacts.
 *
 * The challenge: near the clipping boundary, walls and floors can overlap in screen space
 * at similar depths. But columns (walls) that are genuinely in front have much smaller depths.
 *
 * Strategy:
 * - Use farDepth for occluder threshold: columns at <50% of farDepth are definite occluders
 * - Use generous epsilon for visibility: floor/ceiling depths similar to farDepth should pass
 */
function isPointVisibleNearPlane(x, y, farDepth, depthBuffer) {
    if (x < 0 || x >= DEPTH_WIDTH || y < 0 || y >= DEPTH_HEIGHT) return false;

    const ix = (x + 0.5) | 0;
    const iy = (y + 0.5) | 0;
    const clampedX = ix < 0 ? 0 : (ix >= DEPTH_WIDTH ? DEPTH_WIDTH - 1 : ix);
    const clampedY = iy < 0 ? 0 : (iy >= DEPTH_HEIGHT ? DEPTH_HEIGHT - 1 : iy);

    const baseIdx = clampedY * DEPTH_WIDTH;
    const bufferDepth = depthBuffer[baseIdx + clampedX];

    // Occluder threshold: if something is at less than 50% of farDepth, it's a column/wall in front
    const occluderThreshold = farDepth * 0.5;

    // Check for definite occluders (columns, walls clearly in front)
    if (bufferDepth < occluderThreshold) {
        return false;
    }

    // Also check nearby pixels for occluders (catch narrow columns)
    const searchRadius = 2;
    const xMin = Math.max(0, clampedX - searchRadius);
    const xMax = Math.min(DEPTH_WIDTH - 1, clampedX + searchRadius);
    for (let sx = xMin; sx <= xMax; sx++) {
        if (depthBuffer[baseIdx + sx] < occluderThreshold) {
            return false;
        }
    }

    // Generous epsilon for floor/ceiling overlap at frustum boundary
    // Floors at 50-80% of farDepth should not occlude the wall edge
    const epsilon = farDepth * 0.4 + 2.0;

    if (farDepth <= bufferDepth + epsilon) {
        return true;
    }

    // Check immediate neighbors for polygon boundary seams
    if (clampedX > 0 && farDepth <= depthBuffer[baseIdx + clampedX - 1] + epsilon) return true;
    if (clampedX < DEPTH_WIDTH - 1 && farDepth <= depthBuffer[baseIdx + clampedX + 1] + epsilon) return true;

    return false;
}

/**
 * Add chevron indicators for door walls
 * Renders 3 chevrons (^) at eye level on the front face of each door
 */
function addDoorChevrons(doorWalls, camera, depthBuffer, output) {
    const cos = Math.cos(-camera.angle);
    const sin = Math.sin(-camera.angle);
    const fovScale = Math.tan(camera.fov / 2);
    const aspect = DEPTH_WIDTH / DEPTH_HEIGHT;
    const nearPlane = camera.nearPlane;
    const invWidth = 2 / DEPTH_WIDTH;
    const invHeight = 2 / DEPTH_HEIGHT;

    // Chevron sizing (in world units)
    const chevronWidth = 12;   // Half-width of each chevron arm
    const chevronHeight = 8;   // Height of each chevron point
    const chevronSpacing = 14; // Vertical spacing between chevrons
    const eyeHeight = 41;      // DOOM player eye height

    for (let i = 0; i < doorWalls.length; i++) {
        const wall = doorWalls[i];

        // Calculate door center in world space
        const centerX = (wall.start.x + wall.end.x) * 0.5;
        const centerY = (wall.start.y + wall.end.y) * 0.5;

        // Calculate wall direction for chevron orientation
        const wallDx = wall.end.x - wall.start.x;
        const wallDy = wall.end.y - wall.start.y;
        const wallLen = Math.sqrt(wallDx * wallDx + wallDy * wallDy);
        if (wallLen < 0.001) continue;

        // Normalized wall direction (for chevron width)
        const dirX = wallDx / wallLen;
        const dirY = wallDy / wallLen;

        // Wall normal (perpendicular to wall direction)
        // In DOOM, the front side is typically to the right of the line direction
        const normalX = -dirY;
        const normalY = dirX;

        // Back-face culling: check if camera is on the front side of the wall
        const toCameraX = camera.x - centerX;
        const toCameraY = camera.y - centerY;
        const dotProduct = toCameraX * normalX + toCameraY * normalY;

        // Skip if camera is on the back side (negative dot product)
        if (dotProduct < 0) continue;

        // Position chevrons at floor + eye level (not vertically centered)
        const baseHeight = wall.bottomHeight + eyeHeight;

        // Generate 3 chevrons centered around eye level
        for (let c = 0; c < 3; c++) {
            // Vertical offset: -1, 0, +1 from eye level
            const zOffset = (c - 1) * chevronSpacing;
            const tipZ = baseHeight + zOffset + chevronHeight * 0.5;
            const baseZ = baseHeight + zOffset - chevronHeight * 0.5;

            // Chevron tip (center top)
            const tipX = centerX;
            const tipY = centerY;

            // Chevron left and right base points (along wall direction)
            const leftX = centerX - dirX * chevronWidth;
            const leftY = centerY - dirY * chevronWidth;
            const rightX = centerX + dirX * chevronWidth;
            const rightY = centerY + dirY * chevronWidth;

            // Transform and project each line of the chevron
            // Line 1: left base to tip
            const line1 = projectLine3D(
                leftX, leftY, baseZ,
                tipX, tipY, tipZ,
                camera, cos, sin, fovScale, aspect, nearPlane
            );

            // Line 2: tip to right base
            const line2 = projectLine3D(
                tipX, tipY, tipZ,
                rightX, rightY, baseZ,
                camera, cos, sin, fovScale, aspect, nearPlane
            );

            // Check visibility and add lines
            if (line1) {
                const midDepth = (line1.depth1 + line1.depth2) * 0.5;
                const midX = (line1.x1 + line1.x2) * 0.5;
                const midY = (line1.y1 + line1.y2) * 0.5;
                if (isPointVisibleFast(midX, midY, midDepth, depthBuffer)) {
                    output.push({
                        start: [line1.x1 * invWidth - 1, -(line1.y1 * invHeight - 1)],
                        end: [line1.x2 * invWidth - 1, -(line1.y2 * invHeight - 1)]
                    });
                }
            }

            if (line2) {
                const midDepth = (line2.depth1 + line2.depth2) * 0.5;
                const midX = (line2.x1 + line2.x2) * 0.5;
                const midY = (line2.y1 + line2.y2) * 0.5;
                if (isPointVisibleFast(midX, midY, midDepth, depthBuffer)) {
                    output.push({
                        start: [line2.x1 * invWidth - 1, -(line2.y1 * invHeight - 1)],
                        end: [line2.x2 * invWidth - 1, -(line2.y2 * invHeight - 1)]
                    });
                }
            }
        }
    }
}

/**
 * Project a 3D line to screen space
 * Returns null if entirely behind camera
 */
function projectLine3D(x1, y1, z1, x2, y2, z2, camera, cos, sin, fovScale, aspect, nearPlane) {
    // Transform to camera space
    const rel1X = x1 - camera.x;
    const rel1Y = y1 - camera.y;
    const rel1Z = z1 - camera.z;
    const rel2X = x2 - camera.x;
    const rel2Y = y2 - camera.y;
    const rel2Z = z2 - camera.z;

    let cam1X = rel1X * cos - rel1Y * sin;
    let cam1Y = rel1X * sin + rel1Y * cos;
    let cam1Z = rel1Z;
    let cam2X = rel2X * cos - rel2Y * sin;
    let cam2Y = rel2X * sin + rel2Y * cos;
    let cam2Z = rel2Z;

    // Both behind camera
    if (cam1Y < nearPlane && cam2Y < nearPlane) return null;

    // Clip to near plane if needed
    if (cam1Y < nearPlane) {
        const t = (nearPlane - cam1Y) / (cam2Y - cam1Y);
        cam1X = cam1X + t * (cam2X - cam1X);
        cam1Z = cam1Z + t * (cam2Z - cam1Z);
        cam1Y = nearPlane;
    } else if (cam2Y < nearPlane) {
        const t = (nearPlane - cam2Y) / (cam1Y - cam2Y);
        cam2X = cam2X + t * (cam1X - cam2X);
        cam2Z = cam2Z + t * (cam1Z - cam2Z);
        cam2Y = nearPlane;
    }

    // Project to screen
    const sx1 = (cam1X / (cam1Y * fovScale)) * 0.5 + 0.5;
    const sy1 = (cam1Z / (cam1Y * fovScale / aspect)) * 0.5 + 0.5;
    const sx2 = (cam2X / (cam2Y * fovScale)) * 0.5 + 0.5;
    const sy2 = (cam2Z / (cam2Y * fovScale / aspect)) * 0.5 + 0.5;

    return {
        x1: sx1 * DEPTH_WIDTH,
        y1: (1 - sy1) * DEPTH_HEIGHT,
        depth1: cam1Y,
        x2: sx2 * DEPTH_WIDTH,
        y2: (1 - sy2) * DEPTH_HEIGHT,
        depth2: cam2Y
    };
}

/**
 * Convert lines to points for oscilloscope
 */
export function linesToPoints(lines, pointDensity = 30) {
    const segments = [];

    for (let i = 0, len = lines.length; i < len; i++) {
        const line = lines[i];
        const segment = [];
        const dx = line.end[0] - line.start[0];
        const dy = line.end[1] - line.start[1];
        const length = Math.sqrt(dx * dx + dy * dy);
        const numPoints = Math.max(2, Math.ceil(length * pointDensity));
        const invPoints = numPoints > 1 ? 1 / (numPoints - 1) : 0;

        for (let j = 0; j < numPoints; j++) {
            const t = j * invPoints;
            segment.push([line.start[0] + dx * t, line.start[1] + dy * t]);
        }

        segments.push(segment);
    }

    return segments;
}

/**
 * Deduplicate lines
 * @param {Array} lines - Array of line segments
 * @param {number} threshold - Rounding factor (higher = stricter matching, lower = more aggressive deduplication)
 *                             1000 = 0.001 unit tolerance, 100 = 0.01 unit tolerance, 10 = 0.1 unit tolerance
 */
export function deduplicateLines(lines, threshold = 1000) {
    const seen = new Map();
    const result = [];

    for (let i = 0, len = lines.length; i < len; i++) {
        const line = lines[i];
        const x1 = Math.round(line.start[0] * threshold);
        const y1 = Math.round(line.start[1] * threshold);
        const x2 = Math.round(line.end[0] * threshold);
        const y2 = Math.round(line.end[1] * threshold);

        const key = x1 < x2 || (x1 === x2 && y1 < y2)
            ? `${x1},${y1}-${x2},${y2}`
            : `${x2},${y2}-${x1},${y1}`;

        if (!seen.has(key)) {
            seen.set(key, true);
            result.push(line);
        }
    }

    return result;
}

/**
 * Optimize line order (greedy nearest neighbor)
 */
export function optimizeLineOrder(lines) {
    if (lines.length <= 1) return lines;

    const result = [];
    const used = new Uint8Array(lines.length);
    let lastEnd = lines[0].end;
    result.push(lines[0]);
    used[0] = 1;

    for (let n = 1; n < lines.length; n++) {
        let bestIdx = -1;
        let bestDist = Infinity;
        let reverse = false;

        for (let i = 0; i < lines.length; i++) {
            if (used[i]) continue;

            const line = lines[i];
            const ds = (line.start[0] - lastEnd[0]) ** 2 + (line.start[1] - lastEnd[1]) ** 2;
            const de = (line.end[0] - lastEnd[0]) ** 2 + (line.end[1] - lastEnd[1]) ** 2;

            if (ds < bestDist) { bestDist = ds; bestIdx = i; reverse = false; }
            if (de < bestDist) { bestDist = de; bestIdx = i; reverse = true; }
        }

        if (bestIdx >= 0) {
            used[bestIdx] = 1;
            const line = lines[bestIdx];
            if (reverse) {
                result.push({ start: line.end, end: line.start });
                lastEnd = line.start;
            } else {
                result.push(line);
                lastEnd = line.end;
            }
        }
    }

    return result;
}
