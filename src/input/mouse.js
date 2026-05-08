/**
 * Mouse Input
 *
 * Pointer-lock aiming and click-to-fire. Activates when the browser enters
 * fullscreen and grants pointer lock, allowing mouse movement to turn the
 * player. Left click fires the current weapon.
 *
 * Per-player: mouse drives the same target slot as keyboard
 * (`state.kbmTargetPlayer`) — keyboard and mouse are one logical input
 * combo (FPS-standard WASD + mouselook), so they switch together.
 *
 * Ignores clicks on touch devices to prevent accidental firing from taps.
 */

import { inputs, registerInputProvider } from './index.js';
import { state } from '../game/state.js';
import { fireWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { spawnPlayer } from '../game/player/spawn.js';
import { isMatchEnded, restartMatch } from '../game/match.js';
import { spectatorActive } from '../ui/spectator.js';
import { pingActivity } from '../ui/attract.js';

const DM_RESPAWN_COOLDOWN_MS = 2000;

const MOUSE_SENSITIVITY = 0.003;
const isTouchDevice = matchMedia('(pointer: coarse)').matches;

// Accumulated mouse turn delta (consumed each frame by the provider)
let turnDelta = 0;

/** The player object currently driven by mouse input (same as keyboard). */
function kbmPlayer() {
    return state.players[state.kbmTargetPlayer];
}

/**
 * Initializes mouse event listeners.
 * Should be called once during application startup.
 */
export function initMouseInput() {
    // Mouse shares the keyboard target slot.
    registerInputProvider(() => state.kbmTargetPlayer, getInput);

    // Fire weapon on left click (outside UI elements). In DM, fire on a
    // dead kbm-target player respawns them after the cooldown.
    document.addEventListener('mousedown', event => {
        pingActivity();
        if (event.button !== 0 || spectatorActive || isTouchDevice) return;
        if (event.target.closest('#debug-menu, #menu, .hud, #spectator, #touch-controls, #help-overlay, #help-button, #fullscreen-button')) return;

        if (isMatchEnded()) { restartMatch(); return; }

        const player = kbmPlayer();
        if (player?.isDead) {
            if (state.mode === 'deathmatch'
                && performance.now() - player.deathTime > DM_RESPAWN_COOLDOWN_MS) {
                spawnPlayer(player);
            }
            return;
        }
        inputs[state.kbmTargetPlayer].fireHeld = true;
        fireWeapon(player);
    });
    document.addEventListener('mouseup', event => {
        if (event.button === 0) {
            inputs[state.kbmTargetPlayer].fireHeld = false;
            const player = kbmPlayer();
            if (player) stopAutoFire(player);
        }
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
            pingActivity();
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
