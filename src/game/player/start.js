/**
 * Player setup at level load. Two phases, both called by Level.load:
 *
 *   - applyPlayerStart(): runs BEFORE scene build. Sets each player's
 *     x / y / angle / z / floorHeight from the map's start data.
 *     Single-player reads mapData.playerStart; deathmatch picks among
 *     type-11 things (DM starts) with the same fallback logic the
 *     map exporter laid out.
 *
 *   - addPlayerThings(): runs AFTER scene build. Pushes each player's
 *     entry into state.things and fires renderer.createPlayerSprite
 *     for the billboard. Lets canMoveTo see the player as a collider
 *     (skipped via excludeThing for the moving player) and lets
 *     hitscan / projectile / AI code treat the player as a damageable
 *     target. Each entry's x/y is synced from player.x/y by
 *     movement.js after every position update.
 *
 * Lives in src/game/ — both phases mutate state.* and the second
 * fires a renderer command. shared/maps/ is the map-data layer only;
 * these belong here.
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
