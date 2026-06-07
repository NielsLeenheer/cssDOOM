/**
 * Shared map data store + loader. Pure data layer — zero `game/`
 * imports.
 *
 * Owns the parsed JSON map data (walls, sectors, things, doors,
 * lifts, etc.) loaded from `maps/E*M*.json`. Both the game layer
 * and renderer import this directly — it's not owned by either
 * layer.
 *
 * `load(name)` fetches + caches the raw JSON, then runs the
 * map-side enrichment functions (initThings + initDoors) to
 * annotate mapData in place. State population (`state.things`,
 * `state.doorState`, etc.) is NOT done here — it's the game
 * layer's concern, handled by `initThingsState` / `initDoorsState`
 * / etc. in `src/game/`. Renderer-side scene construction
 * (buildScene + per-renderer warmup) lives in `src/renderer/scene/`
 * and reads mapData via its own import.
 *
 * Callers that need "construct + load + start a Level for this map"
 * use `swapLevel` in `src/game/level.js`. That's a game-layer
 * concern and lives there.
 */

import { initThings } from './things.js';
import { initDoors } from './doors.js';

export const MAPS = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'];

/** The currently loaded map's parsed JSON data. Null until a map is loaded. */
export let mapData = null;

/** Name of the currently loaded map (e.g. "E1M1"). */
export let currentMap = null;

const _fetchCache = new Map();

/**
 * Fetch + enrich a map. Idempotent on `currentMap` — calling with
 * the same name is a no-op. State population (state.things etc.)
 * is the caller's responsibility; see `initThingsState` /
 * `initDoorsState` / etc.
 */
export async function load(name) {
    if (currentMap === name) return;
    let raw = _fetchCache.get(name);
    if (!raw) {
        const response = await fetch(`maps/${name}.json`);
        raw = await response.json();
        _fetchCache.set(name, raw);
    }
    // Set the singletons BEFORE running enrichment. initThings calls
    // getFloorHeightAt → physics.js → reads the global mapData, so
    // the global must already point at `raw` when init runs.
    // (initThings takes `raw` as a parameter for clarity but
    // transitively depends on the global. A future cleanup: have
    // physics.js take mapData explicitly. Out of scope here.)
    mapData = raw;
    currentMap = name;
    initThings(raw);
    initDoors(raw);
}

// ── Map sequencing ────────────────────────────────────────────────

export function getNextMap() {
    const currentIndex = MAPS.indexOf(currentMap);
    return currentIndex >= 0 && currentIndex < MAPS.length - 1 ? MAPS[currentIndex + 1] : null;
}

export function getSecretExitMap() {
    return 'E1M9';
}

// ── Sector geometry helper used by audio dispatch ─────────────────

/**
 * Approximate centroid of a sector — average of its outer-boundary
 * vertices across every polygon that belongs to the sector. Used by
 * audio dispatch to give sector-bound sounds (door open/close, lift
 * start/stop) a world position, and by lifts.js to decide which side
 * of a shaft edge is the lift interior (insideSign).
 *
 * `sectorPolygons` is a LIST keyed by each entry's `.sectorIndex`
 * property — NOT positionally indexed — and a single sector can span
 * multiple polygon entries (see floors.js, spatial-grid.js, which both
 * match on `.sectorIndex`). Indexing the array by sectorIndex returns
 * an unrelated sector: for ~80% of sectors in E1M2 the array position
 * doesn't equal the `.sectorIndex`. That mis-resolution put a lift's
 * centroid on the wrong side of its shaft edge, inverting insideSign
 * and trapping players standing at the foot of a raised lift.
 *
 * Good enough for convex / mildly-concave sectors typical in DOOM E1;
 * truly pathological concave shapes might miss but those don't matter
 * for the consumers here. Returns `{x, y}` or null if the sector has
 * no polygon.
 */
export function sectorCenter(sectorIndex) {
    const polygons = mapData?.sectorPolygons;
    if (!polygons) return null;
    let cx = 0, cy = 0, n = 0;
    for (const poly of polygons) {
        if (poly?.sectorIndex !== sectorIndex) continue;
        const pts = poly.boundaries?.[0];
        if (!pts) continue;
        for (const p of pts) { cx += p.x; cy += p.y; n++; }
    }
    return n ? { x: cx / n, y: cy / n } : null;
}
