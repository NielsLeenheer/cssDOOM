/**
 * Player setup at level load. Three phases, called in order:
 *
 *   - applyPlayerStart(): BEFORE scene build. Sets each player's
 *     x / y / angle / z / floorHeight from the map's start data.
 *     Single-player reads mapData.playerStart; deathmatch picks among
 *     type-11 things (DM starts) with the same fallback logic the
 *     map exporter laid out. Called by Level.load.
 *
 *   - addPlayerThings(): AFTER scene build, still inside Level.load.
 *     Pushes each player's entry into state.things so canMoveTo can
 *     see the player as a collider (skipped via excludeThing for the
 *     moving player), and so hitscan / projectile / AI code treats
 *     the player as a damageable target. Each entry's x/y is synced
 *     from player.x/y by movement.js after every position update.
 *     Pure master-side simulation state; no renderer commands.
 *
 *   - broadcastPlayerSprites(): AFTER every renderer's scene is
 *     built (master's local renderers always; remote joiners only
 *     after MSG.READY_TO_PLAY arrives). Fires
 *     renderer.createPlayerSprite via the orchestrator world fan-out
 *     so every pane gets the billboard <img>. Idempotent —
 *     createPlayerSprite no-ops when the sprite already exists in
 *     this renderer's sceneState. Called by the Level.load callers
 *     (Game.beginPlay after awaitAllReadyToPlay, others immediately
 *     after load) — NOT by Level.load itself, because Level doesn't
 *     know whether the caller is waiting on remote joiners.
 *
 * Lives in src/game/ — every phase mutates state.* or fires renderer
 * commands. shared/maps/ is the map-data layer only; these belong here.
 */

import { PLAYER_RADIUS } from '../../shared/constants.js';
import { state } from '../state.js';
import { getSectorAt } from '../physics.js';
import { mapData } from '../../shared/maps/index.js';
import * as renderer from '../../renderer/index.js';

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
    // ensurePlayerCount creates placeholder Players with isDead=true so
    // AI doesn't target an unbound phantom at world origin (see the
    // commentary in mode.js). Players that have a real start position
    // here are real participants — wake them up. For DM, beginPlay's
    // spawnPlayer also sets isDead=false; doing it here too keeps
    // addPlayerThings (which runs between applyPlayerStart and
    // beginPlay) from initializing thingRef.collected to true.
    for (const player of state.players) {
        if (player) player.isDead = false;
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
 * Push a single player's thing entry into state.things. Idempotent —
 * calling twice for the same player no-ops (re-uses the existing
 * thingRef). Pure master-side simulation state; the billboard sprite
 * fan-out is handled by broadcastPlayerSprites once every receiving
 * renderer's scene is built.
 */
export function addPlayerThing(player) {
    if (player.thingRef) return;
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
}

export function addPlayerThings() {
    for (const player of state.players) addPlayerThing(player);
}

/**
 * Fan createPlayerSprite for every player with a thingRef out to
 * every renderer via the orchestrator world dispatch. Idempotent —
 * createPlayerSprite no-ops at the receiver when the sprite already
 * exists in the receiver's sceneState.thingDom.
 *
 * MUST run only after every receiving renderer's scene is built. For
 * master's local renderers that's guaranteed by Level.load's
 * `await orchestrator.loadMap(name)`. For remote joiners over the
 * wire that's guaranteed by waiting on MSG.READY_TO_PLAY (master
 * does this in Game.beginPlay via awaitAllReadyToPlay before
 * calling this).
 */
export function broadcastPlayerSprites() {
    for (const player of state.players) {
        if (!player?.thingRef || player.thingIndex == null) continue;
        const sectorIndex = getSectorAt(player.x, player.y)?.sectorIndex;
        renderer.createPlayerSprite(
            player.thingIndex, player.index,
            player.x, player.y, player.floorHeight, sectorIndex,
        );
    }
}
