/**
 * Gamepad Input
 *
 * Gamepad/controller support using gamecontroller.js. Maps standard gamepad
 * controls to DOOM actions:
 *
 *   Left stick:        move forward/backward + strafe left/right
 *   Right stick:       turn left/right
 *   A / button0:       use (open doors, activate switches/lifts)
 *   Right trigger:     fire weapon
 *   Left/Right bumpers: cycle weapons
 *   Start:             toggle menu
 *   D-pad:             move (alternative to left stick)
 *
 * Per-player: each connected gamepad drives a player slot equal to its
 * `gamepad.index` (gamepad 0 → state.players[0], gamepad 1 → state.players[1]).
 * Each gamepad has its own analog state so two pads contribute to two
 * different input slots independently. fireHeld is set on the gamepad's
 * own slot.
 *
 * Uses gamecontroller.js which handles connection/disconnection, polling,
 * and deadzone management via the Gamepad API.
 */

import 'gamecontroller.js';
import { inputs, registerInputProvider } from './index.js';
import { state } from '../game/state.js';
import { currentMap } from '../shared/maps.js';
import { isMenuOpen, toggleMenu } from '../ui/menu.js';
import { tryOpenDoor } from '../game/mechanics/doors.js';
import { tryUseSwitch } from '../game/mechanics/switches.js';
import { tryUseLift } from '../game/mechanics/lifts.js';
import { fireWeapon, equipWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { loadMap } from '../shared/maps.js';

const STICK_DEADZONE = 0.15;
const TURN_SENSITIVITY = 0.04;

/** Per-gamepad analog state, keyed by gamepad.index. */
const padStates = new Map();

/**
 * Initialise gamepad input. The gamecontroller.js library auto-detects
 * connections; we just need to bind actions when a gamepad appears.
 */
export function initGamepadInput() {
    if (!window.gameControl) return;

    window.gameControl.on('connect', gamepad => {
        setupGamepad(gamepad);
    });

    window.gameControl.on('disconnect', gamepad => {
        const padState = padStates.get(gamepad.index);
        if (padState) {
            padState.moveX = 0;
            padState.moveY = 0;
            padState.turnDelta = 0;
        }
        const slot = inputs[gamepad.index];
        if (slot) slot.fireHeld = false;
    });

    // Single global afterCycle handler that walks all known gamepads each
    // polling tick and updates their padState from raw axes.
    window.gameControl.on('afterCycle', () => {
        for (const [index, padState] of padStates) {
            const pad = window.gameControl.gamepads?.[index];
            if (!pad) continue;
            const axes0 = pad.axeValues[0];
            if (axes0) {
                const lx = parseFloat(axes0[0]) || 0;
                const ly = parseFloat(axes0[1]) || 0;
                padState.moveX = Math.abs(lx) > STICK_DEADZONE ? lx : 0;
                padState.moveY = Math.abs(ly) > STICK_DEADZONE ? -ly : 0; // invert Y
            }
            const axes1 = pad.axeValues[1];
            if (axes1) {
                const rx = parseFloat(axes1[0]) || 0;
                padState.turnDelta = Math.abs(rx) > STICK_DEADZONE ? -rx * TURN_SENSITIVITY : 0;
            }
        }
    });
}

/** Returns true if any gamepad is currently connected. */
export function isGamepadConnected() {
    return padStates.size > 0;
}

// ============================================================================
// Gamepad Binding
// ============================================================================

function setupGamepad(gamepad) {
    const playerIndex = gamepad.index;
    const padState = { moveX: 0, moveY: 0, turnDelta: 0 };
    padStates.set(playerIndex, padState);

    // Per-gamepad provider — contributes to its own player slot.
    registerInputProvider(() => playerIndex, () => padState);

    // Set deadzone threshold for analog sticks
    gamepad.set('axeThreshold', STICK_DEADZONE);

    /** The player driven by this gamepad. May be undefined if SP and the
     *  gamepad's slot is beyond state.players.length. */
    const playerForPad = () => state.players[playerIndex];

    // --- A / Cross (button0): Use ---
    gamepad.before('button0', () => {
        const player = playerForPad();
        if (!player) return;
        if (handleDeadRestart(player)) return;
        if (isMenuOpen()) return;
        tryOpenDoor(player);
        tryUseSwitch(player);
        tryUseLift(player);
    });

    // --- Right trigger (R2 / button7): Fire ---
    gamepad.before('r2', () => {
        const player = playerForPad();
        if (!player) return;
        if (handleDeadRestart(player)) return;
        if (isMenuOpen()) return;
        inputs[playerIndex].fireHeld = true;
        fireWeapon(player);
    });
    gamepad.after('r2', () => {
        const player = playerForPad();
        inputs[playerIndex].fireHeld = false;
        if (player) stopAutoFire(player);
    });

    // --- Left bumper (L1 / button4): Previous weapon ---
    gamepad.before('l1', () => {
        if (isMenuOpen()) return;
        cycleWeapon(playerIndex, -1);
    });

    // --- Right bumper (R1 / button5): Next weapon ---
    gamepad.before('r1', () => {
        if (isMenuOpen()) return;
        cycleWeapon(playerIndex, 1);
    });

    // --- Start (button9): Toggle menu ---
    gamepad.before('start', () => {
        toggleMenu(!isMenuOpen());
    });

    // --- D-pad: alternative movement ---
    gamepad.on('up0',    () => { padState.moveY = 1; });
    gamepad.after('up0', () => { padState.moveY = 0; });
    gamepad.on('down0',    () => { padState.moveY = -1; });
    gamepad.after('down0', () => { padState.moveY = 0; });
    gamepad.on('left0',    () => { padState.moveX = -1; });
    gamepad.after('left0', () => { padState.moveX = 0; });
    gamepad.on('right0',    () => { padState.moveX = 1; });
    gamepad.after('right0', () => { padState.moveX = 0; });
}

// ============================================================================
// Helpers
// ============================================================================

function cycleWeapon(playerIndex, direction) {
    const player = state.players[playerIndex];
    if (!player) return;
    const owned = [...player.ownedWeapons].sort((a, b) => a - b);
    const currentIndex = owned.indexOf(player.currentWeapon);
    const nextIndex = (currentIndex + direction + owned.length) % owned.length;
    equipWeapon(player, owned[nextIndex]);
}

function handleDeadRestart(player) {
    if (!player.isDead) return false;
    if (performance.now() - player.deathTime > 4000) {
        loadMap(currentMap);
    }
    return true;
}
