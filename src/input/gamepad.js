/**
 * Gamepad Input
 *
 * Native Gamepad API — no library dependency. Detects connect/disconnect
 * via `gamepadconnected` / `gamepaddisconnected` events plus a RAF poll
 * loop that doubles as a fallback for browsers that don't reliably fire
 * `gamepadconnected` for gamepads already plugged in at page load
 * (Firefox/Safari behaviour). The poll loop is also where per-frame
 * input is read.
 *
 * Bindings (modern FPS console layout):
 *
 *   Left stick:        move forward/backward + strafe left/right
 *   Right stick:       turn left/right
 *   A / Cross / b0:    use (open doors, activate switches/lifts)
 *   Right trigger / b7: fire weapon
 *   Left trigger / b6: run modifier (hold for sprint speed)
 *   L1 / LB / b4:      previous weapon
 *   R1 / RB / b5:      next weapon
 *   D-pad up / b12:    next weapon (alternative to R1)
 *   D-pad down / b13:  previous weapon (alternative to L1)
 *   Start / Options / b9: toggle menu
 *
 * Triggers (L2 / R2) are read via the analog `value` property in
 * addition to `pressed`. Some controllers — notably Xbox on macOS —
 * don't reliably flip `buttons[N].pressed` even when the trigger is
 * fully pulled. Polling the value each cycle works on every
 * controller we've tested.
 *
 * Per-player: each gamepad's deviceId is `gamepad-${gamepad.index}`.
 * The press-to-claim registry binds it to a player slot. Each pad has
 * its own analog state so multiple pads contribute to different input
 * slots independently.
 */

import { inputs, registerInputProvider } from './index.js';
import { getDriverSlot, tryClaimSlot, unclaim } from './claim-registry.js';
import { state } from '../game/state.js';
import { currentMap } from '../shared/maps.js';
import { isMenuOpen, toggleMenu } from '../ui/menu.js';
import { pingActivity } from '../ui/attract.js';
import { tryOpenDoor } from '../game/mechanics/doors.js';
import { tryUseSwitch } from '../game/mechanics/switches.js';
import { tryUseLift } from '../game/mechanics/lifts.js';
import { fireWeapon, equipWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { spawnPlayer } from '../game/player/spawn.js';
import { isMatchEnded, restartMatch } from '../game/match.js';
import { loadMap } from '../shared/maps.js';

const DM_RESPAWN_COOLDOWN_MS = 2000;
const SP_RESTART_COOLDOWN_MS = 4000;

const STICK_DEADZONE = 0.15;
const TURN_SENSITIVITY = 0.04;
// Threshold past which an analog trigger counts as "pressed". Half-pull
// fires the action; release returns it to false. Standard FPS feel.
const TRIGGER_THRESHOLD = 0.5;

/** Per-gamepad analog state, keyed by gamepad.index. */
const padStates = new Map();

/** Build the per-gamepad deviceId used by the press-to-claim registry. */
function gamepadDeviceId(gamepadIndex) {
    return `gamepad-${gamepadIndex}`;
}

/**
 * Initialise gamepad input. Native `gamepadconnected` fires when a pad
 * is plugged in (or first interacted with on a page-load-already-plugged
 * gamepad). The RAF poll loop is the source of truth — it both reads
 * per-frame state and detects pads that the connect event missed.
 */
export function initGamepadInput() {
    window.addEventListener('gamepadconnected', (e) => {
        if (!padStates.has(e.gamepad.index)) {
            setupGamepad(e.gamepad);
        }
    });
    window.addEventListener('gamepaddisconnected', (e) => {
        handleDisconnect(e.gamepad.index);
    });

    requestAnimationFrame(pollGamepads);
}

/**
 * Per-frame poll. Walks `navigator.getGamepads()` and:
 *   - Sets up any pad we haven't seen before (covers the case where
 *     `gamepadconnected` didn't fire — Firefox/Safari sometimes only
 *     surface a gamepad after the first user gesture on it).
 *   - Updates each pad's analog state and dispatches button transitions.
 *   - Detects pads that disappeared without firing `gamepaddisconnected`.
 */
function pollGamepads() {
    const rawPads = navigator.getGamepads ? navigator.getGamepads() : [];

    for (let i = 0; i < rawPads.length; i++) {
        const rawPad = rawPads[i];
        if (!rawPad) {
            // Slot empty — if we previously had a pad here, it went away.
            if (padStates.has(i) && padStates.get(i)._wasConnected) {
                handleDisconnect(i);
            }
            continue;
        }

        // Late-detected gamepad (gamepadconnected didn't fire, e.g.
        // because the user hadn't pressed anything on it yet).
        if (!padStates.has(rawPad.index)) {
            setupGamepad(rawPad);
        }

        processGamepad(rawPad);
    }

    requestAnimationFrame(pollGamepads);
}

/** Translate a gamepad's current state into padState updates + button events. */
function processGamepad(rawPad) {
    const padState = padStates.get(rawPad.index);
    if (!padState) return;
    padState._wasConnected = true;

    // ── Sticks → padState (left = move, right = turn) ──
    const axes = rawPad.axes ?? [];
    if (axes.length >= 2) {
        const lx = axes[0] || 0;
        const ly = axes[1] || 0;
        padState.moveX = Math.abs(lx) > STICK_DEADZONE ? lx : 0;
        padState.moveY = Math.abs(ly) > STICK_DEADZONE ? -ly : 0; // invert Y for north=forward
    }
    if (axes.length >= 4) {
        const rx = axes[2] || 0;
        padState.turnDelta = Math.abs(rx) > STICK_DEADZONE ? -rx * TURN_SENSITIVITY : 0;
    }
    if (padState.moveX || padState.moveY || padState.turnDelta) pingActivity();

    // ── Button transitions ──
    // Detect each button's press/release transition by comparing current
    // state against the previous tick. Triggers (6, 7) use value-based
    // detection so analog triggers register even if the browser doesn't
    // flip the boolean pressed flag (Xbox-on-macOS issue).
    const handlers = padState._handlers;
    const claimOrPass = padState._claimOrPass;
    const prev = padState._prevButtons ??= [];
    const buttons = rawPad.buttons ?? [];
    for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        if (!button) continue;
        const isTrigger = i === 6 || i === 7;
        const isPressed = isTrigger
            ? (button.pressed || (button.value ?? 0) > TRIGGER_THRESHOLD)
            : button.pressed;
        const wasPressed = prev[i] ?? false;

        if (isPressed && !wasPressed) {
            pingActivity();
            // Lobby claim is universal: any button press claims when the
            // gamepad is unbound in DM. Returns true if the press was
            // consumed by the claim attempt.
            if (!claimOrPass()) {
                handlers[i]?.press?.();
            }
        } else if (!isPressed && wasPressed) {
            handlers[i]?.release?.();
        }
        prev[i] = isPressed;
    }

    // ── Run modifier (L2 / button6) ──
    // Continuous state (held = run, released = walk), separate from the
    // button-transition handling above. Sets padState.run which
    // collectInputs OR-merges into the slot's input.
    const l2 = buttons[6];
    padState.run = !!l2 && (l2.pressed || (l2.value ?? 0) > TRIGGER_THRESHOLD);
}

/** Returns true if any gamepad is currently connected. */
export function isGamepadConnected() {
    for (const padState of padStates.values()) {
        if (padState._wasConnected) return true;
    }
    return false;
}

// ============================================================================
// Gamepad Binding
// ============================================================================

function setupGamepad(gamepad) {
    const gamepadIndex = gamepad.index;
    const deviceId = gamepadDeviceId(gamepadIndex);
    const padState = {
        moveX: 0, moveY: 0, turnDelta: 0, run: false,
        _wasConnected: false,
    };
    padStates.set(gamepadIndex, padState);

    // Per-gamepad provider — contributes to whichever slot the press-to-
    // claim system has bound this gamepad to. SP auto-binds to slot 0,
    // DM requires fire-press claim before contributing.
    registerInputProvider(() => getDriverSlot(deviceId), () => padState);

    /** The slot this gamepad currently drives, or null if unbound. */
    const slotForPad = () => getDriverSlot(deviceId);
    /** The player driven by this gamepad, or null if unbound. */
    const playerForPad = () => {
        const s = slotForPad();
        return s != null ? state.players[s] : null;
    };
    /** True if this gamepad is unbound and should claim on next press. */
    const isLobbyClaimPending = () =>
        state.mode === 'deathmatch' && slotForPad() == null;

    /**
     * Claim-or-pass: when this gamepad is unbound in a DM lobby, *any*
     * button press counts as a claim attempt. Returns true if the press
     * was consumed by the claim and the caller should skip its action.
     */
    function claimOrPass() {
        if (!isLobbyClaimPending()) return false;
        tryClaimSlot(deviceId);
        return true;
    }
    padState._claimOrPass = claimOrPass;

    // Per-button press/release handlers, dispatched by `processGamepad`.
    const handlers = {};

    // A / Cross (button0): Use
    handlers[0] = {
        press: () => {
            const player = playerForPad();
            if (!player) return;
            if (isMatchEnded()) { restartMatch(); return; }
            if (handleDeadRestart(player)) return;
            if (isMenuOpen()) return;
            tryOpenDoor(player);
            tryUseSwitch(player);
            tryUseLift(player);
        },
    };
    // L1 / LB (button4): Previous weapon
    handlers[4] = {
        press: () => {
            if (isMenuOpen()) return;
            const slot = slotForPad();
            if (slot != null) cycleWeapon(slot, -1);
        },
    };
    // R1 / RB (button5): Next weapon
    handlers[5] = {
        press: () => {
            if (isMenuOpen()) return;
            const slot = slotForPad();
            if (slot != null) cycleWeapon(slot, 1);
        },
    };
    // R2 / RT (button7): Fire. Run-modifier is L2 (button6) — handled
    // separately via padState.run because it's a continuous state rather
    // than a discrete press/release.
    handlers[7] = {
        press: () => {
            const player = playerForPad();
            if (!player) return;
            if (isMatchEnded()) { restartMatch(); return; }
            if (handleDeadRestart(player)) return;
            if (isMenuOpen()) return;
            const slot = slotForPad();
            inputs[slot].fireHeld = true;
            fireWeapon(player);
        },
        release: () => {
            const slot = slotForPad();
            const player = playerForPad();
            if (slot != null) inputs[slot].fireHeld = false;
            if (player) stopAutoFire(player);
        },
    };
    // Start / Options (button9): Toggle menu
    handlers[9] = {
        press: () => toggleMenu(!isMenuOpen()),
    };
    // D-pad up (button12): Next weapon (mirrors R1)
    handlers[12] = {
        press: () => {
            if (isMenuOpen()) return;
            const slot = slotForPad();
            if (slot != null) cycleWeapon(slot, 1);
        },
    };
    // D-pad down (button13): Previous weapon (mirrors L1)
    handlers[13] = {
        press: () => {
            if (isMenuOpen()) return;
            const slot = slotForPad();
            if (slot != null) cycleWeapon(slot, -1);
        },
    };

    padState._handlers = handlers;
}

/**
 * Reset a gamepad's state on disconnect. The padState entry is kept (not
 * deleted) so the registered input provider's closure stays valid; if
 * the gamepad reconnects at the same index, the poll loop repopulates
 * the state in place. Released claim lets a different device take the
 * slot in DM lobby.
 */
function handleDisconnect(gamepadIndex) {
    const padState = padStates.get(gamepadIndex);
    if (padState) {
        padState.moveX = 0;
        padState.moveY = 0;
        padState.turnDelta = 0;
        padState.run = false;
        padState._prevButtons = [];
        padState._wasConnected = false;
    }
    const deviceId = gamepadDeviceId(gamepadIndex);
    const claimedSlot = getDriverSlot(deviceId);
    if (claimedSlot != null) {
        unclaim(deviceId);
        const slotInputs = inputs[claimedSlot];
        if (slotInputs) slotInputs.fireHeld = false;
    }
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
    const cooldown = state.mode === 'deathmatch'
        ? DM_RESPAWN_COOLDOWN_MS
        : SP_RESTART_COOLDOWN_MS;
    if (performance.now() - player.deathTime > cooldown) {
        if (state.mode === 'deathmatch') {
            spawnPlayer(player);
        } else {
            loadMap(currentMap);
        }
    }
    return true;
}
