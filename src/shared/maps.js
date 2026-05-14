/**
 * Shared map data store and loader.
 *
 * Holds the parsed JSON map data (walls, sectors, things, doors, lifts, etc.)
 * loaded from maps/E*M*.json files. Both the game layer and renderer import
 * this directly — it is not owned by either layer.
 *
 * Also owns map loading, level transitions, and map sequencing. The loader
 * orchestrates game state resets and renderer scene (re)builds, but does not
 * own either — it delegates to them.
 */

import { EYE_HEIGHT, PLAYER_RADIUS } from '../game/constants.js';

export const MAPS = ['E1M1', 'E1M2', 'E1M3', 'E1M4', 'E1M5', 'E1M6', 'E1M7', 'E1M8', 'E1M9'];
import { state } from '../game/state.js';
import { transitionToLevel, resetGameState } from '../game/player/damage.js';
import { domRenderers } from '../renderer/dom.js';
import { showLevelTransition, hideLevelTransition } from '../ui/overlay.js';
import { buildSectorAdjacency } from '../game/sound-propagation.js';
import { getSectorAt } from '../game/physics.js';
import { clearSpatialGrid, buildSpatialGrid } from '../game/spatial-grid.js';
import { initDoors } from '../game/mechanics/doors.js';
import { initLifts } from '../game/mechanics/lifts.js';
import { initCrushers } from '../game/mechanics/crushers.js';
import { initThings } from '../game/entities/things-init.js';
import { initSpStats } from '../game/sp-stats.js';
import { updateCulling } from '../renderer/scene/culling.js';
import * as renderer from '../renderer/index.js';

/** The currently loaded map's parsed JSON data. Null until a map is loaded. */
export let mapData = null;

/** Name of the currently loaded map (e.g. "E1M1"). */
export let currentMap = null;

/** Clears the map data reference (for teardown/GC). */
export function clearMap() {
    mapData = null;
}

/**
 * Fetches a map JSON and applies it to game state: sets player position,
 * resets game/level state, and rebuilds the 3D scene.
 *
 * Handles both initial load (no existing scene) and level transitions
 * (overlay fade, teardown with GPU yield).
 */
export async function loadMap(name) {
    const isInitialLoad = !currentMap;

    // Tell any connected client that the scene is about to be rebuilt.
    // Skipped on the very first load (no client could be connected yet,
    // nothing to do). Listener lives in index.js's master setup; the
    // dispatch is fire-and-forget.
    if (!isInitialLoad) {
        window.dispatchEvent(new CustomEvent('cssdoom:level-changing', { detail: { level: name } }));
        await showLevelTransition();
    }

    const response = await fetch(`maps/${name}.json`);
    currentMap = name;
    mapData = await response.json();
    applyPlayerStart();

    // Death restarts with a full reset (health/ammo/weapons);
    // level transitions keep the player's inventory intact. Mode-switch
    // from menu marks player 0 dead before reload to force the reset path.
    if (isInitialLoad || state.players[0].isDead) {
        resetGameState();
    } else {
        transitionToLevel();
    }

    if (!isInitialLoad) {
        // Tear down every renderer's scene and yield to the browser so
        // iOS Safari can release GPU-backed texture memory before the
        // next loadMap allocates new elements.
        for (const r of domRenderers) r.clear();
        clearSpatialGrid();
        await new Promise(r => setTimeout(r, 100));
    }

    // Game-side level init: mutates state.* (state.things, state.doorState,
    // state.liftState, state.crusherState), annotates mapData with the
    // render specs that buildScene reads (mapData.thingRenderSpecs,
    // door.trackWalls). No renderer commands fire here.
    initThings();
    initDoors();
    initLifts();
    initCrushers();

    // Build every local renderer's scene independently. The `domRenderers`
    // registry already reflects what this window needs (1 in SP, 2 in
    // mirror SP / DM, 1 on a non-kiosk client, etc.) — boot / mode-switch
    // code constructs and destroys to match.
    await Promise.all(domRenderers.map(r => r.loadMap()));

    // Game-side post-build: spatial grid (needs state.things), player thing
    // entries (creates player billboards via renderer command), sound graph.
    buildSpatialGrid();
    addPlayerThings();
    buildSectorAdjacency();
    // Reset SP stats and start the per-level timer. No-op in DM.
    initSpStats();

    // Initial render pass — primes camera transforms and runs culling once
    // synchronously so the browser doesn't have to composite the entire
    // level on the first frame. spectatorActive is false at scene-build
    // time (the toggle is user-driven and only fires after init). The
    // orchestrator's per-player dispatch fans updateCamera to all
    // renderers with matching playerIndex (covers mirror SP for free).
    for (const player of state.players) {
        renderer.updateCamera(player, player.viewportIndex);
    }
    for (const r of domRenderers) {
        updateCulling(r, state.things, false);
    }

    // Drop camera from intro height to eye level after scene is ready —
    // every active player's pane gets the drop animation (CSS transition
    // on --player-z smooths the jump).
    setTimeout(() => {
        for (const p of state.players) p.z = p.floorHeight + EYE_HEIGHT;
    }, 600);

    if (!isInitialLoad) {
        hideLevelTransition();
    }

    // Tell master's broadcast layer that the scene is rebuilt and it's
    // safe to accept client reconnections again. Fires on every load
    // (initial too); the master listener handles the no-op case.
    window.dispatchEvent(new CustomEvent('cssdoom:level-loaded', { detail: { level: name } }));
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
function applyPlayerStart() {
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

function addPlayerThings() {
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
