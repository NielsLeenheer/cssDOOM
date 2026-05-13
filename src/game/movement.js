/**
 * Player movement: turning, walking, strafing, collision resolution,
 * floor height tracking, and the moving state flag for head-bob / weapon-bob.
 */

import { EYE_HEIGHT, MOVE_SPEED, RUN_MULTIPLIER, TURN_SPEED, PLAYER_RADIUS } from './constants.js';
import { canMoveTo, getFloorHeightAt, getSectorAt } from './physics.js';
import { orchestrator } from '../orchestrator.js';
import { updatePlayerFromLift } from './mechanics/lifts.js';
import * as renderer from '../renderer/index.js';
import { inputs } from '../orchestrator.js';
import { state } from './state.js';
import { isMatchLobby } from './match.js';
import { recordSectorEnter } from './sp-stats.js';

const wasMovingByPlayer = new Map();

// ── Movement-axis smoothing ───────────────────────────────────────────
//
// Keyboard movement is binary on/off — pressing W jumps moveY straight
// to 1, releasing it drops to 0. Gamepad sticks are already analog and
// feel right. To make keyboard feel less robotic we ramp the
// moveX/moveY axes toward the input value over ~125ms when the source
// is digital. Detection: a value of exactly ±1 or 0 is treated as
// digital; anything in between is analog (gamepad stick) and passes
// through unchanged.
//
// Turn is intentionally NOT smoothed — keyboard tap-turns would feel
// laggy. Mouse turn is already delta-based, naturally smooth.
//
// Smoothed state is per-slot and persists across frames. It resets to
// zero whenever the player is dead or the match is in lobby so resumed
// play starts fresh — no residual velocity carried over from a prior
// match.

const RAMP_RATE = 8; // per second — 0→1 in ~125ms
const smoothedAxes = new Map(); // slot → { moveX, moveY }

function isDigital(v) {
    return v === 1 || v === -1 || v === 0;
}

function rampToward(current, target, dt) {
    if (current === target) return target;
    const step = RAMP_RATE * dt;
    if (Math.abs(target - current) <= step) return target;
    return current + Math.sign(target - current) * step;
}

function smoothedInputFor(player, dt) {
    const raw = inputs[player.index];
    let s = smoothedAxes.get(player.index);
    if (!s) {
        s = { moveX: 0, moveY: 0 };
        smoothedAxes.set(player.index, s);
    }
    s.moveX = isDigital(raw.moveX) ? rampToward(s.moveX, raw.moveX, dt) : raw.moveX;
    s.moveY = isDigital(raw.moveY) ? rampToward(s.moveY, raw.moveY, dt) : raw.moveY;
    return { ...raw, moveX: s.moveX, moveY: s.moveY };
}

function resetSmoothedAxes(slot) {
    const s = smoothedAxes.get(slot);
    if (s) { s.moveX = 0; s.moveY = 0; }
}

export function updateMovement(player, deltaTime, timestamp) {
    // Dead players don't move — their input is gated upstream and their
    // camera drops to floor via the .renderer.dead CSS rule. Other players
    // continue updating independently.
    if (player.isDead) {
        resetSmoothedAxes(player.index);
        return;
    }

    // DM lobby: claimed players can't run around the map before the
    // match formally begins (same applies in Network DM while waiting
    // for the host to press start). But height tracking and lift
    // following must still run — spawn points on raised floors need
    // `player.z` resolved from `floorHeight` so the camera isn't stuck
    // below the platform during the lobby wait.
    const inLobby = isMatchLobby();
    if (inLobby) resetSmoothedAxes(player.index);

    const input = inLobby ? null : smoothedInputFor(player, deltaTime);

    if (input) updateLocation(player, deltaTime, input);
    updatePlayerFromLift(timestamp);
    updateHeight(player);
    if (input) updateMovingState(player, input);
}

function updateLocation(player, deltaTime, input) {
    // Speed modifier (run, turn, turnDelta come straight from the raw
    // input — only moveX/moveY are smoothed; see smoothedInputFor above)
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
        if (sector) {
            renderer.reparentThingToSector(player.thingIndex, sector.sectorIndex);
            // SP stats: credit the player for entering a SECRET sector
            // (no-op in DM / repeat enters / non-secret sectors).
            recordSectorEnter(sector.sectorIndex);
        }
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

function updateMovingState(player, input) {
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
        orchestrator.playSound('DSOOF', { x: player.x, y: player.y });
    }
}
