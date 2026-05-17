/**
 * Spatial grid for accelerating geometric queries.
 *
 * The map is divided into CELL_SIZE × CELL_SIZE cells, and walls, sight lines,
 * and sector polygons are inserted into every cell their bounding box overlaps.
 * Higher-level query functions iterate matching items with deduplication,
 * so callers don't need to know about grid internals.
 */

import { mapData } from '../shared/maps/index.js';

const CELL_SIZE = 128;

let gridMinX, gridMinY, gridCols, gridRows;
let wallGrid, sightLineGrid, sectorGrid;
let queryCounter = 0;

function nextQueryId() { return ++queryCounter; }
function cellIndex(col, row) { return row * gridCols + col; }
function cellCol(x) { return Math.floor((x - gridMinX) / CELL_SIZE); }
function cellRow(y) { return Math.floor((y - gridMinY) / CELL_SIZE); }
function clampCol(col) { return Math.max(0, Math.min(gridCols - 1, col)); }
function clampRow(row) { return Math.max(0, Math.min(gridRows - 1, row)); }

function insertAABB(grid, item, minX, minY, maxX, maxY) {
    const c0 = clampCol(cellCol(minX));
    const c1 = clampCol(cellCol(maxX));
    const r0 = clampRow(cellRow(minY));
    const r1 = clampRow(cellRow(maxY));
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            grid[cellIndex(c, r)].push(item);
        }
    }
}

/**
 * Clears the spatial grid so that lookups fall back to iterating all items.
 * Must be called before rebuilding the scene.
 */
export function clearSpatialGrid() {
    wallGrid = sightLineGrid = sectorGrid = undefined;
}

/**
 * Builds the spatial grid from the current map data. Must be called after
 * the map is loaded and all geometry (including lift shaft walls) is set up.
 */
export function buildSpatialGrid() {
    const bounds = mapData.bounds;
    gridMinX = Math.floor(bounds.minX / CELL_SIZE) * CELL_SIZE - CELL_SIZE;
    gridMinY = Math.floor(bounds.minY / CELL_SIZE) * CELL_SIZE - CELL_SIZE;
    const gridMaxX = Math.ceil(bounds.maxX / CELL_SIZE) * CELL_SIZE + CELL_SIZE;
    const gridMaxY = Math.ceil(bounds.maxY / CELL_SIZE) * CELL_SIZE + CELL_SIZE;
    gridCols = (gridMaxX - gridMinX) / CELL_SIZE;
    gridRows = (gridMaxY - gridMinY) / CELL_SIZE;

    const totalCells = gridCols * gridRows;
    wallGrid = new Array(totalCells);
    sightLineGrid = new Array(totalCells);
    sectorGrid = new Array(totalCells);
    for (let i = 0; i < totalCells; i++) {
        wallGrid[i] = [];
        sightLineGrid[i] = [];
        sectorGrid[i] = [];
    }

    const walls = mapData.walls;
    for (let i = 0; i < walls.length; i++) {
        const wall = walls[i];
        wall._queryId = -1;
        const sx = wall.start.x, sy = wall.start.y, ex = wall.end.x, ey = wall.end.y;
        insertAABB(wallGrid, wall,
            sx < ex ? sx : ex, sy < ey ? sy : ey,
            sx > ex ? sx : ex, sy > ey ? sy : ey);
    }

    const sightLines = mapData.sightLines || [];
    for (let i = 0; i < sightLines.length; i++) {
        const line = sightLines[i];
        line._queryId = -1;
        const sx = line.start.x, sy = line.start.y, ex = line.end.x, ey = line.end.y;
        insertAABB(sightLineGrid, line,
            sx < ex ? sx : ex, sy < ey ? sy : ey,
            sx > ex ? sx : ex, sy > ey ? sy : ey);
    }

    const sectors = mapData.sectorPolygons || [];
    for (let i = 0; i < sectors.length; i++) {
        const sector = sectors[i];
        sector._queryId = -1;
        const outer = sector.boundaries[0];
        if (!outer || outer.length < 3) continue;
        let sMinX = Infinity, sMaxX = -Infinity, sMinY = Infinity, sMaxY = -Infinity;
        for (let j = 0; j < outer.length; j++) {
            const v = outer[j];
            if (v.x < sMinX) sMinX = v.x;
            if (v.x > sMaxX) sMaxX = v.x;
            if (v.y < sMinY) sMinY = v.y;
            if (v.y > sMaxY) sMaxY = v.y;
        }
        sector._minX = sMinX; sector._maxX = sMaxX;
        sector._minY = sMinY; sector._maxY = sMaxY;
        insertAABB(sectorGrid, sector, sMinX, sMinY, sMaxX, sMaxY);
    }
}

// ============================================================================
// Query API
// ============================================================================

/**
 * Calls `callback(wall)` for each unique wall in cells overlapping the AABB.
 * Falls back to iterating all walls if the grid hasn't been built yet.
 * If the callback returns `false`, iteration stops early.
 */
export function forEachWallInAABB(minX, minY, maxX, maxY, callback) {
    if (!wallGrid) {
        const walls = mapData.walls;
        for (let i = 0, len = walls.length; i < len; i++) {
            if (callback(walls[i]) === false) return;
        }
        return;
    }
    const qid = nextQueryId();
    const c0 = clampCol(cellCol(minX)), c1 = clampCol(cellCol(maxX));
    const r0 = clampRow(cellRow(minY)), r1 = clampRow(cellRow(maxY));
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const cell = wallGrid[cellIndex(c, r)];
            for (let i = 0, len = cell.length; i < len; i++) {
                const wall = cell[i];
                if (wall._queryId === qid) continue;
                wall._queryId = qid;
                if (callback(wall) === false) return;
            }
        }
    }
}

/**
 * Calls `callback(line)` for each unique sight line in cells overlapping the AABB.
 * Falls back to iterating all sight lines if the grid hasn't been built yet.
 * If the callback returns `false`, iteration stops early.
 */
export function forEachSightLineInAABB(minX, minY, maxX, maxY, callback) {
    const sightLines = mapData.sightLines;
    if (!sightLines || sightLines.length === 0) return;
    if (!sightLineGrid) {
        for (let i = 0, len = sightLines.length; i < len; i++) {
            if (callback(sightLines[i]) === false) return;
        }
        return;
    }
    const qid = nextQueryId();
    const c0 = clampCol(cellCol(minX)), c1 = clampCol(cellCol(maxX));
    const r0 = clampRow(cellRow(minY)), r1 = clampRow(cellRow(maxY));
    for (let r = r0; r <= r1; r++) {
        for (let c = c0; c <= c1; c++) {
            const cell = sightLineGrid[cellIndex(c, r)];
            for (let i = 0, len = cell.length; i < len; i++) {
                const line = cell[i];
                if (line._queryId === qid) continue;
                line._queryId = qid;
                if (callback(line) === false) return;
            }
        }
    }
}

/**
 * Calls `callback(sector)` for each unique sector polygon whose bounding box
 * covers the given point. Falls back to all sectors if grid not built.
 * If the callback returns `false`, iteration stops early.
 */
export function forEachSectorAt(x, y, callback) {
    const sectors = sectorGrid
        ? sectorGrid[cellIndex(clampCol(cellCol(x)), clampRow(cellRow(y)))]
        : mapData.sectorPolygons;
    if (!sectors) return;
    const qid = nextQueryId();
    for (let i = 0, len = sectors.length; i < len; i++) {
        const sector = sectors[i];
        if (sector._queryId === qid) continue;
        sector._queryId = qid;
        if (sector._minX !== undefined) {
            if (x < sector._minX || x > sector._maxX || y < sector._minY || y > sector._maxY) continue;
        }
        if (callback(sector) === false) return;
    }
}
