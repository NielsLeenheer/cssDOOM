/**
 * Mouse Input
 *
 * Pointer-lock aiming and click-to-fire. Activates when the browser enters
 * fullscreen and grants pointer lock, allowing mouse movement to turn the
 * player. Left click fires the current weapon.
 *
 * Per-player: mouse follows the **active kbm device** (kbm-A or kbm-B) so
 * keyboard and mouse drive the same player at all times. The Tab key in
 * keyboard.js flips the active device; the mouse switches with it
 * automatically because both modules feed the same `kbmHandler` instance.
 *
 * Ignores clicks on touch devices to prevent accidental firing from taps.
 */

import { spectatorActive } from '../ui/spectator.js';
import { pingActivity } from '../ui/attract.js';
import { kbmHandler } from './keyboard.js';

const isTouchDevice = matchMedia('(pointer: coarse)').matches;

/**
 * Initializes mouse event listeners.
 * Should be called once during application startup.
 */
export function initMouseInput() {
    document.addEventListener('mousedown', event => {
        // Wake from attract — first click only dismisses the overlay;
        // claim/fire happen on subsequent presses (handled by gates).
        if (pingActivity()) return;
        if (event.button !== 0 || spectatorActive || isTouchDevice) return;
        if (event.target.closest('#debug-menu, #menu, .hud, #spectator, #touch-controls, #help-overlay, #ui-buttons')) return;

        kbmHandler.handleMouseDown(event.button);
    });

    document.addEventListener('mouseup', event => {
        kbmHandler.handleMouseUp(event.button);
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
            kbmHandler.addMouseTurn(event.movementX);
            pingActivity();
        }
    });
}
