/**
 * Keyboard Input
 *
 * Key bindings (matches original DOOM + WASD):
 *   Movement:    W / ArrowUp    = forward
 *                S / ArrowDown  = backward
 *                ArrowLeft      = turn left  (strafe if Z held)
 *                ArrowRight     = turn right (strafe if Z held)
 *                A / ,          = strafe left
 *                D / .          = strafe right
 *   Modifiers:   Shift          = run (2x speed)
 *                Z              = strafe modifier (arrows strafe instead of turn)
 *   Actions:     Space          = use (open doors, activate switches)
 *                Alt (L/R) / X  = fire weapon
 *                1-7            = select weapon by slot number
 *
 * Per-player: keyboard drives whichever player is currently in
 * `state.kbmTargetPlayer` (default 0). The Tab key (gated to dev + DM mode +
 * zero gamepads) toggles the target between 0 and 1, clearing held-key
 * state on the previous target so a held W or fire-button doesn't leak.
 *
 * When the player is dead, any keypress reloads the current map.
 * When the window loses focus, all movement keys are released to prevent
 * stuck-key issues. The Meta key also clears all movement state, since
 * keyup events are suppressed while Meta is held on macOS.
 */

import { inputs, registerInputProvider, clearInputSlot, getDriverSlot, tryClaimSlot } from './index.js';
import { state } from '../game/state.js';
import { currentMap } from '../shared/maps.js';
import { WEAPONS } from '../game/constants.js';
import { tryOpenDoor } from '../game/mechanics/doors.js';
import { tryUseSwitch } from '../game/mechanics/switches.js';
import { tryUseLift } from '../game/mechanics/lifts.js';
import { fireWeapon, equipWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { spawnPlayer } from '../game/player/spawn.js';
import { isMatchEnded, restartMatch } from '../game/match.js';
import { loadMap } from '../shared/maps.js';
import { isMenuOpen, toggleMenu } from '../ui/menu.js';
import { pingActivity } from '../ui/attract.js';

const DM_RESPAWN_COOLDOWN_MS = 2000;
const SP_RESTART_COOLDOWN_MS = 4000;

// Internal key state — not exposed to the game layer. Note these are GLOBAL
// across players: the keyboard physically belongs to one human at a time, so
// only the current `state.kbmTargetPlayer` reads them.
const keys = {
    up: false, down: false, left: false, right: false,
    strafeLeft: false, strafeRight: false, run: false, strafe: false,
};

// deviceId for the keyboard+mouse combo. They share a slot — see the
// commentary in mouse.js. The press-to-claim flow binds this device.
export const KBM_DEVICE = 'kbm';

/** The player object currently driven by keyboard input, or null if the
 *  kbm device is unbound (Local DM lobby state). */
function kbmPlayer() {
    const slot = getDriverSlot(KBM_DEVICE);
    if (slot == null) return null;
    return state.players[slot];
}

/** The slot index the keyboard is currently driving, or null if unbound. */
function kbmSlot() {
    return getDriverSlot(KBM_DEVICE);
}

/**
 * Returns true if the dev Tab handler is allowed to switch keyboard
 * targets right now. Gated so the affordance only exists during local
 * development of deathmatch mode without gamepads.
 */
function canSwitchKbmTarget() {
    if (!import.meta.env.DEV) return false;
    if (state.mode !== 'deathmatch') return false;
    const connectedGamepads = navigator.getGamepads().filter(Boolean);
    return connectedGamepads.length === 0;
}

function switchKbmTarget() {
    const previous = state.kbmTargetPlayer;
    // Release any held keyboard state so a stuck W doesn't follow us.
    keys.up = keys.down = keys.left = keys.right = false;
    keys.strafeLeft = keys.strafeRight = keys.run = keys.strafe = false;
    // Zero the previous slot's input + fireHeld so chaingun auto-fire
    // doesn't keep ticking on the abandoned player.
    clearInputSlot(previous);
    state.kbmTargetPlayer = previous === 0 ? 1 : 0;
    document.body.dataset.kbmTarget = String(state.kbmTargetPlayer);
}

/**
 * Initializes keyboard event listeners.
 * Should be called once during application startup.
 */
export function initKeyboardInput() {
    // Keyboard's slot is determined by the press-to-claim system. In SP,
    // getDriverSlot auto-binds to slot 0; in DM, the slot is null until
    // a fire-press claims one. The provider returning null causes
    // collectInputs to skip its contribution, which is what we want
    // pre-claim.
    registerInputProvider(() => kbmSlot(), getInput);
    document.body.dataset.kbmTarget = String(state.kbmTargetPlayer);

    // Keyboard: key down
    // Tracks which movement keys are pressed and handles discrete actions
    // (use, fire, weapon switch). Repeated key events are ignored.
    document.addEventListener('keydown', event => {
        pingActivity();

        // Escape toggles the menu overlay
        if (event.code === 'Escape') {
            toggleMenu(!isMenuOpen());
            event.preventDefault();
            return;
        }

        // Block game input while menu is open
        if (isMenuOpen()) return;

        // Match-end restart: any fire / use key triggers a fresh match.
        if (isMatchEnded()) {
            const code = event.code;
            if (code === 'AltLeft' || code === 'AltRight' || code === 'KeyX' || code === 'Space') {
                restartMatch();
                event.preventDefault();
            }
            return;
        }

        // Tab — dev-only keyboard target switch (gated). Caught before the
        // dead-restart gate so Tab still works even if the current target
        // is dead. We always preventDefault Tab so it doesn't cycle focus
        // through page elements regardless of whether the gate is active.
        if (event.code === 'Tab') {
            event.preventDefault();
            if (canSwitchKbmTarget()) {
                switchKbmTarget();
            }
            return;
        }

        const player = kbmPlayer();

        // Press-to-claim: in DM lobby with kbm unbound, *any* key counts
        // as a join — the user shouldn't have to figure out which key is
        // "the right one." Escape, Tab, and the menu/match-end keys are
        // already handled higher up so they don't reach this gate.
        if (state.mode === 'deathmatch' && player == null) {
            tryClaimSlot(KBM_DEVICE);
            event.preventDefault();
            return;
        }

        // Dead handling differs by mode:
        //   SP: any key restarts the level after a 4-second cooldown.
        //   DM: any key respawns this player at a deathmatch start after a
        //       2-second cooldown — the rest of the world keeps playing.
        if (player?.isDead) {
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
            return;
        }

        // Ignore OS key-repeat events to prevent unintended rapid actions
        if (event.repeat) return;

        switch (event.code) {
            // Forward movement: W or Up arrow
            case 'ArrowUp': case 'KeyW': keys.up = true; break;
            // Backward movement: S or Down arrow
            case 'ArrowDown': case 'KeyS': keys.down = true; break;
            // Turn left: Left arrow (strafe if Alt held)
            case 'ArrowLeft': keys.left = true; break;
            // Turn right: Right arrow (strafe if Alt held)
            case 'ArrowRight': keys.right = true; break;
            // Strafe left: A or comma
            case 'KeyA': case 'Comma': keys.strafeLeft = true; break;
            // Strafe right: D or period
            case 'KeyD': case 'Period': keys.strafeRight = true; break;
            // Run modifier: Shift
            case 'ShiftLeft': case 'ShiftRight': keys.run = true; break;
            // Strafe modifier: Z (arrows strafe instead of turn)
            case 'KeyZ': keys.strafe = true; break;
            // Use action: open doors and activate switches
            case 'Space': tryOpenDoor(player); tryUseSwitch(player); tryUseLift(player); break;
            // Fire weapon: Alt or X
            case 'AltLeft': case 'AltRight': case 'KeyX':
                inputs[kbmSlot()].fireHeld = true;
                fireWeapon(player);
                break;
            // Weapon selection: number keys 1-7
            case 'Digit1': case 'Digit2': case 'Digit3':
            case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7':
                const weaponSlot = parseInt(event.code[5]);
                if (WEAPONS[weaponSlot]) equipWeapon(player, weaponSlot);
                break;
            // Unrecognized key — return early without calling preventDefault
            default: return;
        }
        event.preventDefault();
    });

    // Keyboard: key up
    // Releases movement keys and stops auto-fire when Alt is released.
    // Also handles the macOS Meta key quirk where held Meta suppresses
    // other keyup events, causing stuck movement keys.
    document.addEventListener('keyup', event => {
        const player = kbmPlayer();
        switch (event.code) {
            case 'ArrowUp': case 'KeyW': keys.up = false; break;
            case 'ArrowDown': case 'KeyS': keys.down = false; break;
            case 'ArrowLeft': keys.left = false; break;
            case 'ArrowRight': keys.right = false; break;
            case 'KeyA': case 'Comma': keys.strafeLeft = false; break;
            case 'KeyD': case 'Period': keys.strafeRight = false; break;
            case 'ShiftLeft': case 'ShiftRight': keys.run = false; break;
            case 'KeyZ': keys.strafe = false; break;
            case 'AltLeft': case 'AltRight': case 'KeyX': {
                const slot = kbmSlot();
                if (slot != null) inputs[slot].fireHeld = false;
                if (player) stopAutoFire(player);
                break;
            }

            // Meta key release: clear all movement to avoid stuck keys on macOS
            case 'MetaLeft': case 'MetaRight':
                keys.up = keys.down = keys.left = keys.right = false;
                keys.strafeLeft = keys.strafeRight = false;
                break;
        }
    });

    // Prevents the player from continuing to move when the window loses focus,
    // since keyup events won't fire while another window is active.
    window.addEventListener('blur', () => {
        keys.up = keys.down = keys.left = keys.right = false;
        keys.strafeLeft = keys.strafeRight = keys.run = keys.strafe = false;
    });
}

// ============================================================================
// Input Provider
// ============================================================================

/**
 * Returns this module's contribution to the unified input state.
 * Converts boolean key flags into analog-style moveX/moveY/turn values.
 */
function getInput() {
    let moveX = 0, moveY = 0, turn = 0;

    if (keys.up) moveY += 1;
    if (keys.down) moveY -= 1;

    if (keys.strafeLeft || (keys.strafe && keys.left)) moveX -= 1;
    if (keys.strafeRight || (keys.strafe && keys.right)) moveX += 1;

    if (keys.left && !keys.strafe) turn += 1;
    if (keys.right && !keys.strafe) turn -= 1;

    return { moveX, moveY, turn, run: keys.run };
}
