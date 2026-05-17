/**
 * Shared map data store + loader.
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
 * / etc. in `src/game/`.
 *
 * The `loadMap` shim survives through step 5; deleted then.
 */

import { PLAYER_RADIUS } from '../../game/constants.js';
import { state } from '../../game/state.js';
import { getSectorAt } from '../../game/physics.js';
import { Level, _setCurrentLevel } from '../../game/level.js';
import { orchestrator } from '../../orchestrator.js';
import * as renderer from '../../renderer/index.js';
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

// ── Loader shim — goes away in step 5 ─────────────────────────────

/**
 * Backward-compat shim for callers that don't hold a Game instance
 * (menu, debug, switches, RemoteGame, attract). Constructs a Level,
 * loads it, starts it ticking, and registers it as the current Level
 * for this window via `_setCurrentLevel`. Callers that own a Game
 * (master.js boot) construct Levels directly via Game.beginPlay.
 */
export async function loadMap(name) {
    const lvl = new Level({
        map: name,
        players: state.players,
        rules: state.match?.rules ?? null,
        orchestrator,
    });
    await lvl.load();
    lvl.start();
    _setCurrentLevel(lvl);
    return lvl;
}

// ── Player-start + player-thing helpers — move to src/game/ in step 2 ─

/**
 * Sets each player's position and angle from the current map's start
 * data.
 *
 * Single-player: uses mapData.playerStart (a precomputed starting
 * point with x/y/angle/floorHeight, where angle is in radians and
 * floorHeight is preset by the map exporter).
 *
 * Deathmatch: each player gets a different `type === 11` thing
 * (DOOM deathmatch-start markers; angle in degrees, no
 * floorHeight). With fewer starts than players, players cycle
 * through what's available. Floor height for DM spawns falls back
 * to playerStart's value — the first updateHeight() frame will
 * resample to the actual sector floor.
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
            // radians, 0=north — same conversion as mapData.playerStart
            // minus π/2 north adjustment.
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
 * Push a single player's thing entry into state.things and create
 * their billboard sprite in every renderer. Idempotent — calling
 * twice for the same player is a no-op (re-uses the existing
 * thingRef).
 *
 * Lets physics.canMoveTo's solid-thing loop see the player as a
 * collider (skipped via excludeThing for the moving player), and
 * lets hitscan / projectile / AI code treat the player as a
 * damageable target. Each entry's x/y is synced from player.x/y by
 * movement.js after each position update.
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
        // 0=north) to the thing facing convention (atan2
        // east-radians: 0=east) for updateEnemyRotation's billboard
        // math.
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
 * vertices. Used by audio dispatch to give sector-bound sounds (door
 * open/close, lift start/stop) a world position so positional audio
 * works. Good enough for convex / mildly-concave sectors typical in
 * DOOM E1; truly pathological concave shapes might miss but those
 * don't matter for audio. Returns `{x, y}` or null if the sector
 * has no polygon.
 */
export function sectorCenter(sectorIndex) {
    const poly = mapData?.sectorPolygons?.[sectorIndex];
    if (!poly?.boundaries?.[0]) return null;
    const pts = poly.boundaries[0];
    let cx = 0, cy = 0;
    for (const p of pts) { cx += p.x; cy += p.y; }
    return { x: cx / pts.length, y: cy / pts.length };
}
