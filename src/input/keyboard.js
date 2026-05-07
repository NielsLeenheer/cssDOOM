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
 * When the player is dead, any keypress reloads the current map.
 * When the window loses focus, all movement keys are released to prevent
 * stuck-key issues. The Meta key also clears all movement state, since
 * keyup events are suppressed while Meta is held on macOS.
 */

import { input } from './index.js';
import { state } from '../game/state.js';
import { currentMap } from '../shared/maps.js';
import { WEAPONS } from '../game/constants.js';
import { tryOpenDoor } from '../game/mechanics/doors.js';
import { tryUseSwitch } from '../game/mechanics/switches.js';
import { tryUseLift } from '../game/mechanics/lifts.js';
import { fireWeapon, equipWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { loadMap } from '../shared/maps.js';
import { isMenuOpen, toggleMenu } from '../ui/menu.js';
import { registerInputProvider } from './index.js';

// Internal key state — not exposed to the game layer
const keys = {
    up: false, down: false, left: false, right: false,
    strafeLeft: false, strafeRight: false, run: false, strafe: false,
};

/**
 * Initializes keyboard event listeners.
 * Should be called once during application startup.
 */
export function initKeyboardInput() {
    registerInputProvider(getInput);

    // Keyboard: key down
    // Tracks which movement keys are pressed and handles discrete actions
    // (use, fire, weapon switch). Repeated key events are ignored.
    document.addEventListener('keydown', event => {

        // Escape toggles the menu overlay
        if (event.code === 'Escape') {
            toggleMenu(!isMenuOpen());
            event.preventDefault();
            return;
        }

        // Block game input while menu is open
        if (isMenuOpen()) return;

        // When dead, any key restarts after a 4-second cooldown
        if (state.isDead) {
            if (performance.now() - state.deathTime > 4000) loadMap(currentMap);
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
            case 'Space': tryOpenDoor(state.players[0]); tryUseSwitch(state.players[0]); tryUseLift(state.players[0]); break;
            // Fire weapon: Alt or X
            case 'AltLeft': case 'AltRight': case 'KeyX': input.fireHeld = true; fireWeapon(state.players[0]); break;
            // Weapon selection: number keys 1-7
            case 'Digit1': case 'Digit2': case 'Digit3':
            case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7':
                const weaponSlot = parseInt(event.code[5]);
                if (WEAPONS[weaponSlot]) equipWeapon(state.players[0], weaponSlot);
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
        switch (event.code) {
            case 'ArrowUp': case 'KeyW': keys.up = false; break;
            case 'ArrowDown': case 'KeyS': keys.down = false; break;
            case 'ArrowLeft': keys.left = false; break;
            case 'ArrowRight': keys.right = false; break;
            case 'KeyA': case 'Comma': keys.strafeLeft = false; break;
            case 'KeyD': case 'Period': keys.strafeRight = false; break;
            case 'ShiftLeft': case 'ShiftRight': keys.run = false; break;
            case 'KeyZ': keys.strafe = false; break;
            case 'AltLeft': case 'AltRight': case 'KeyX': input.fireHeld = false; stopAutoFire(state.players[0]); break;

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
