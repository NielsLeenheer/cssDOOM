/**
 * Mouse Input
 *
 * Pointer-lock aiming and click-to-fire. Activates when the browser enters
 * fullscreen and grants pointer lock, allowing mouse movement to turn the
 * player. Left click fires the current weapon.
 *
 * Ignores clicks on touch devices to prevent accidental firing from taps.
 */

import { input } from './index.js';
import { state } from '../game/state.js';
import { fireWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { spectatorActive } from '../ui/spectator.js';
import { registerInputProvider } from './index.js';

const MOUSE_SENSITIVITY = 0.003;
const isTouchDevice = matchMedia('(pointer: coarse)').matches;

// Accumulated mouse turn delta (consumed each frame by the provider)
let turnDelta = 0;

/**
 * Initializes mouse event listeners.
 * Should be called once during application startup.
 */
export function initMouseInput() {
    registerInputProvider(getInput);

    // Fire weapon on left click (outside UI elements)
    document.addEventListener('mousedown', event => {
        if (event.button === 0 && !spectatorActive && !isTouchDevice && !event.target.closest('#debug-menu, #menu, #hud, #spectator, #touch-controls, #help-overlay, #help-button, #fullscreen-button')) {
            input.fireHeld = true;
            fireWeapon(state.players[0]);
        }
    });
    document.addEventListener('mouseup', event => {
        if (event.button === 0) { input.fireHeld = false; stopAutoFire(state.players[0]); }
    });

    // Request pointer lock when entering fullscreen
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            document.documentElement.requestPointerLock();
        }
    });

    // Accumulate mouse movement as turn delta
    document.addEventListener('mousemove', event => {
        if (document.pointerLockElement) {
            turnDelta -= event.movementX * MOUSE_SENSITIVITY;
        }
    });
}

// ============================================================================
// Input Provider
// ============================================================================

function getInput() {
    const td = turnDelta;
    turnDelta = 0;
    return { turnDelta: td };
}
