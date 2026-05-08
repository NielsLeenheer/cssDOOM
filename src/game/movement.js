/**
 * Player movement: turning, walking, strafing, collision resolution,
 * floor height tracking, and the moving state flag for head-bob / weapon-bob.
 */

import { EYE_HEIGHT, MOVE_SPEED, RUN_MULTIPLIER, TURN_SPEED } from './constants.js';
import { canMoveTo, getFloorHeightAt } from './physics.js';
import { playSound } from '../audio/audio.js';
import { updatePlayerFromLift } from './mechanics/lifts.js';
import * as renderer from '../renderer/index.js';
import { inputs } from '../input/index.js';

const wasMovingByPlayer = new Map();

export function updateMovement(player, deltaTime, timestamp) {
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
        if (canMoveTo(desiredX, desiredY)) {
            player.x = desiredX;
            player.y = desiredY;
        } else if (canMoveTo(desiredX, player.y)) {
            player.x = desiredX;
        } else if (canMoveTo(player.x, desiredY)) {
            player.y = desiredY;
        }
    }
}

function updateMovingState(player) {
    const input = inputs[player.index];
    const isMoving = input.moveX !== 0 || input.moveY !== 0;
    const wasMoving = wasMovingByPlayer.get(player.index) ?? false;
    if (isMoving !== wasMoving) {
        wasMovingByPlayer.set(player.index, isMoving);
        renderer.setPlayerMoving(player.viewportIndex, isMoving);
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
