/**
 * Shared map data store and map-flow helpers.
 *
 * Owns the parsed JSON map data (walls, sectors, things, doors, lifts,
 * etc.) loaded from `maps/E*M*.json`. Both the game layer and renderer
 * import this directly — it is not owned by either layer.
 *
 * Map *loading* (fetch → decorate → state init → scene rebuild) used to
 * live in this module's `loadMap()`. As of L1.2 the body has moved into
 * `Level.load()` in `src/game/level.js`. `loadMap()` here is now a thin
 * transitional shim that constructs a `Level` and awaits its load; it
 * exists so existing callers don't have to change yet. L1.7 introduces
 * the Level registry helpers and L2 hands ownership to Game, at which
 * point this shim disappears entirely.
 *
 * This module still owns:
 *   - the `mapData` / `currentMap` singletons (and their underscored
 *     internal setters that Level uses);
 *   - the `fetchMapJson` / `decorateMapData` helpers;
 *   - the player-start helpers (`applyPlayerStart` + DM/SP variants);
 *   - the per-player `addPlayerThing` / `addPlayerThings` helpers;
 *   - map sequencing (`getNextMap`, `getSecretExitMap`) and
 *     `sectorCenter` for audio dispatch.
 */

import { PLAYER_RADIUS } from '../game/constants.js';

export const MAPS = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'];
import { state } from '../game/state.js';
import { getSectorAt } from '../game/physics.js';
import { Level, _setCurrentLevel } from '../game/level.js';
import { orchestrator } from '../orchestrator.js';
import * as renderer from '../renderer/index.js';

/** The currently loaded map's parsed JSON data. Null until a map is loaded. */
export let mapData = null;

/** Name of the currently loaded map (e.g. "E1M1"). */
export let currentMap = null;

/** Read-only accessor used by Level.load to gate the initial-load branch. */
export function getCurrentMap() {
    return currentMap;
}

/**
 * Internal setters used by `Level.load` to update the module-level
 * singletons. Underscored to flag that callers outside Level (and
 * `clearMap()` below) shouldn't touch them. Once Level owns the
 * lifecycle end-to-end (L7), these become private to this module.
 */
export function _setMapData(data) { mapData = data; }
export function _setCurrentMap(name) { currentMap = name; }

/** Clears the map data reference (for teardown/GC). */
export function clearMap() {
    mapData = null;
}

/** Fetches and parses a map JSON. Pure I/O — no side effects on state. */
export async function fetchMapJson(name) {
    const response = await fetch(`maps/${name}.json`);
    return await response.json();
}

/**
 * Pure decoration pass on a freshly-fetched mapData.
 *
 * As of L1.2 this is a stub. Today the per-map decoration that
 * `Level.load` relies on (annotating `mapData.thingRenderSpecs`,
 * `door.trackWalls`, etc.) happens inside `initThings()` /
 * `initDoors()` — which also write to `state.*`. Splitting decoration
 * out from those `init*` functions is a follow-up; until then this
 * call exists so Level's load sequence has the right shape and
 * `decorateMapData` is callable from attract / RemoteGame paths once
 * they need pure decoration (see LIFECYCLE_REFACTOR.md §16).
 */
export function decorateMapData(_mapData) {
    // Intentionally empty for now — see comment above.
}

/**
 * Backward-compat shim. Constructs a Level, awaits its load, starts
 * it ticking, and registers it as the current Level for this window
 * via `_setCurrentLevel` (from `game/level.js`). L2 hands ownership
 * to Game which constructs Levels directly and holds its own
 * reference, at which point this shim disappears.
 */
export async function loadMap(name) {
    const lvl = new Level({
        map: name,
        players: state.players,
        rules: state.match?.rules ?? null,
        orchestrator,
    });
    await lvl.load();
    // Preserve today's "load → immediately playing" behavior: every
    // caller of loadMap expected the world to be live after it
    // resolved. L2's Game will own the load-then-start sequencing
    // explicitly; for now the shim does it inline.
    lvl.start();
    // Register as "the current Level for this window." Callers
    // (master.js's RAF, the level-event emit sites in switches.js /
    // damage.js / spawn.js) read this via `getCurrentLevel()`. L2
    // replaces the registry with Game-owned reference.
    _setCurrentLevel(lvl);
    return lvl;
}

/**
 * Sets each player's position and angle from the current map's start data.
 *
 * Single-player: uses mapData.playerStart (a precomputed starting point with
 * x/y/angle/floorHeight, where angle is in radians and floorHeight is
 * preset by the map exporter).
 *
 * Deathmatch: each player gets a different `type === 11` thing (DOOM
 * deathmatch-start markers; angle in degrees, no floorHeight). With fewer
 * starts than players, players cycle through what's available. Floor
 * height for DM spawns falls back to playerStart's value — the first
 * updateHeight() frame will resample to the actual sector floor.
 */
export function applyPlayerStart() {
    if (state.gameMode === 'deathmatch') {
        applyDeathmatchStarts();
    } else {
        applySinglePlayerStart();
    }
}

function applySinglePlayerStart() {
    const player = state.players[0];
    player.x = mapData.playerStart.x;
    player.y = mapData.playerStart.y;
    player.angle = mapData.playerStart.angle - Math.PI / 2;
    player.floorHeight = mapData.playerStart.floorHeight || 0;
    // Start camera high, then drop to eye height for intro effect
    player.z = player.floorHeight + 80;
}

function applyDeathmatchStarts() {
    const dmStarts = (mapData.things || []).filter(t => t.type === 11);
    const fallbackFloor = mapData.playerStart?.floorHeight || 0;

    for (let i = 0; i < state.players.length; i++) {
        const player = state.players[i];
        const start = dmStarts.length > 0 ? dmStarts[i % dmStarts.length] : null;

        if (start) {
            player.x = start.x;
            player.y = start.y;
            // DM start angles are degrees, 0=east. State playerAngle is
            // radians, 0=north — same conversion as mapData.playerStart minus
            // π/2 north adjustment.
            player.angle = (start.angle * Math.PI / 180) - Math.PI / 2;
            player.floorHeight = fallbackFloor;
        } else if (mapData.playerStart) {
            // No DM starts in this map — both players spawn together at
            // playerStart. Rare, but graceful fallback.
            player.x = mapData.playerStart.x;
            player.y = mapData.playerStart.y;
            player.angle = mapData.playerStart.angle - Math.PI / 2;
            player.floorHeight = fallbackFloor;
        }
        player.z = player.floorHeight + 80;
    }
}

/**
 * Push a single player's thing entry into state.things and create their
 * billboard sprite in every renderer. Idempotent — calling twice for the
 * same player is a no-op (re-uses the existing thingRef).
 *
 * Lets physics.canMoveTo's solid-thing loop see the player as a collider
 * (skipped via excludeThing for the moving player), and lets hitscan /
 * projectile / AI code treat the player as a damageable target. Each
 * entry's x/y is synced from player.x/y by movement.js after each
 * position update.
 */
export function addPlayerThing(player) {
    if (player.thingRef) return;
    const sector = getSectorAt(player.x, player.y);
    const sectorIndex = sector?.sectorIndex;
    const thingRef = {
        kind: 'player',
        player,
        x: player.x,
        y: player.y,
        floorHeight: player.floorHeight,
        // Convert the player's north-convention angle (player.angle:
        // 0=north) to the thing facing convention (atan2 east-radians:
        // 0=east) for updateEnemyRotation's billboard math.
        facing: Math.PI / 2 + player.angle,
        type: -1,
        solidRadius: PLAYER_RADIUS,
        collected: player.isDead || false,
    };
    const thingIndex = state.things.length;
    state.things.push(thingRef);
    player.thingRef = thingRef;
    player.thingIndex = thingIndex;
    renderer.createPlayerSprite(thingIndex, player.index, player.x, player.y, player.floorHeight, sectorIndex);
}

export function addPlayerThings() {
    for (const player of state.players) addPlayerThing(player);
}

export function getNextMap() {
    const currentIndex = MAPS.indexOf(currentMap);
    return currentIndex >= 0 && currentIndex < MAPS.length - 1 ? MAPS[currentIndex + 1] : null;
}

export function getSecretExitMap() {
    return 'E1M9';
}

/**
 * Approximate centroid of a sector — average of its outer-boundary
 * vertices. Used by audio dispatch to give sector-bound sounds (door
 * open/close, lift start/stop) a world position so positional audio
 * works. Good enough for convex / mildly-concave sectors typical in
 * DOOM E1; truly pathological concave shapes might miss but those
 * don't matter for audio. Returns `{x, y}` or null if the sector has
 * no polygon.
 */
export function sectorCenter(sectorIndex) {
    const poly = mapData?.sectorPolygons?.[sectorIndex];
    if (!poly?.boundaries?.[0]) return null;
    const pts = poly.boundaries[0];
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    return { x: cx / pts.length, y: cy / pts.length };
}
