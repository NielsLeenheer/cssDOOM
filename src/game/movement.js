/**
 * Player movement: turning, walking, strafing, collision resolution,
 * floor height tracking, and the moving state flag for head-bob / weapon-bob.
 */

import { EYE_HEIGHT, MOVE_SPEED, RUN_MULTIPLIER, TURN_SPEED, PLAYER_RADIUS } from './constants.js';
import { canMoveTo, getFloorHeightAt, getSectorAt } from './physics.js';
import { playSound } from '../audio/audio.js';
import { updatePlayerFromLift } from './mechanics/lifts.js';
import * as renderer from '../renderer/index.js';
import { inputs } from '../input/index.js';
import { state } from './state.js';
import { isMatchLobby } from './match.js';

const wasMovingByPlayer = new Map();

export function updateMovement(player, deltaTime, timestamp) {
    // Dead players don't move — their input is gated upstream and their
    // camera drops to floor via the .renderer.dead CSS rule. Other players
    // continue updating independently.
    if (player.isDead) return;
    // DM lobby: claimed players can't run around the map before the
    // match formally begins. Same applies in Network DM while waiting
    // for the host to press start.
    if (isMatchLobby()) return;
    updateLocation(player, deltaTime);
    updatePlayerFromLift(timestamp);
    updateHeight(player);
    updateMovingState(player);
}

function updateLocation(player, deltaTime) {
    const input = inputs[player.index];

    // Speed modifier
    const speed = input.run ? MOVE_SPEED * RUN_MULTIPLIER : MOVE_SPEED;
    const turnSpeed = input.run ? TURN_SPEED * RUN_MULTIPLIER : TURN_SPEED;

    /* Turning */

    // Rate-based turning (keyboard arrows) + absolute turn deltas (mouse, analog sticks)
    player.angle += input.turn * turnSpeed * deltaTime + input.turnDelta;

    /* Moving */

    // Forward direction (angle 0 = north = +Y).
    const forwardX = -Math.sin(player.angle);
    const forwardY = Math.cos(player.angle);

    // Strafe direction is perpendicular (90° clockwise from forward).
    const strafeX = Math.cos(player.angle);
    const strafeY = Math.sin(player.angle);

    /* Determine desired movement vector */

    let desiredX = player.x + forwardX * speed * input.moveY * deltaTime
                            + strafeX * speed * input.moveX * deltaTime;
    let desiredY = player.y + forwardY * speed * input.moveY * deltaTime
                            + strafeY * speed * input.moveX * deltaTime;

    /**
     * Collision resolution
     *
     * Movement uses a three-step collision approach:
     *   1. Try the full diagonal move (both axes at once).
     *   2. If blocked, try moving only along X (wall sliding on Y axis).
     *   3. If that is also blocked, try moving only along Y (wall sliding on X axis).
     *
     * This gives natural "wall sliding" behavior — the player glides along
     * walls instead of stopping dead when moving diagonally into them.
     */

    if (desiredX !== player.x || desiredY !== player.y) {
        // Pass this player's own current position and floor height — without
        // them, canMoveTo defaults to state's proxy (player 0), which means
        // player 1's step-up/cross checks would use player 0's coordinates.
        // excludeThing is the player's own entry in state.things so PvP
        // collision works without the player blocking themselves.
        const fromX = player.x;
        const fromY = player.y;
        const floor = player.floorHeight;
        const exclude = player.thingRef;
        if (canMoveTo(desiredX, desiredY, PLAYER_RADIUS, floor, Infinity, exclude, fromX, fromY)) {
            player.x = desiredX;
            player.y = desiredY;
        } else if (canMoveTo(desiredX, player.y, PLAYER_RADIUS, floor, Infinity, exclude, fromX, fromY)) {
            player.x = desiredX;
        } else if (canMoveTo(player.x, desiredY, PLAYER_RADIUS, floor, Infinity, exclude, fromX, fromY)) {
            player.y = desiredY;
        }
    }

    // Sync this player's thing entry so other players' canMoveTo and any
    // hitscan / projectile / AI loop sees the up-to-date position. Also
    // updates the player's billboard sprite in every pane so the opposing
    // player sees them at the right place + facing direction, parented to
    // the right sector for lighting.
    if (player.thingRef && player.thingIndex >= 0) {
        player.thingRef.x = player.x;
        player.thingRef.y = player.y;
        player.thingRef.floorHeight = player.floorHeight;
        // Convert player.angle (north-convention) to thing-facing
        // (east-convention) for updateEnemyRotation's billboard math.
        player.thingRef.facing = Math.PI / 2 + player.angle;

        renderer.updateThingPosition(player.thingIndex, player.x, player.y, player.floorHeight);
        const sector = getSectorAt(player.x, player.y);
        if (sector) renderer.reparentThingToSector(player.thingIndex, sector.sectorIndex);
        renderer.updateEnemyRotation(player.thingIndex, player.thingRef, state.players);
    }
}

/**
 * Clear the moving state for a player. Called from damage.js when a
 * player dies — without this, dying mid-stride leaves wasMovingByPlayer
 * stuck at `true`, and since updateMovement early-exits while dead,
 * `setPlayerMoving(false)` never gets sent. The corpse / death camera
 * keeps bobbing as if walking. Resets both the cached flag and the
 * renderer's `.moving` class on the pane.
 */
export function clearMovingState(player) {
    if (!wasMovingByPlayer.get(player.index)) return;
    wasMovingByPlayer.set(player.index, false);
    renderer.setPlayerMoving(player.viewportIndex, false);
}

function updateMovingState(player) {
    const input = inputs[player.index];
    const isMoving = input.moveX !== 0 || input.moveY !== 0;
    const wasMoving = wasMovingByPlayer.get(player.index) ?? false;
    if (isMoving !== wasMoving) {
        wasMovingByPlayer.set(player.index, isMoving);
        // Local: toggle `.moving` on the player's renderer (drives weapon
        // bob and head-bob in their own pane).
        renderer.setPlayerMoving(player.viewportIndex, isMoving);
        // Cross-pane: toggle `.moving` on the player's thing container in
        // every pane so the billboard sprite's walk cycle pauses/resumes
        // for the OPPOSING player's view.
        if (player.thingIndex >= 0) {
            renderer.setThingMoving(player.thingIndex, isMoving);
        }
    }
}

function updateHeight(player) {
    const prevFloorHeight = player.floorHeight;
    player.floorHeight = getFloorHeightAt(player.x, player.y);
    player.z = player.floorHeight + EYE_HEIGHT;

    // Based on: linuxdoom-1.10/p_mobj.c:P_ZMovement() — oof on hard landing.
    // DOOM plays sfx_oof when momz < -GRAVITY*8. With gravity=1 unit/tic²,
    // that velocity is reached after falling 32 units (v²=2gh → h=8²/2=32).
    if (prevFloorHeight - player.floorHeight > 32) {
        playSound('DSOOF');
    }
}
