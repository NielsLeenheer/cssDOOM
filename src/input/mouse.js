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

import { inputs, registerInputProvider, getDriverSlot, tryClaimSlot } from './index.js';
import { state } from '../game/state.js';
import { fireWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { spawnPlayer } from '../game/player/spawn.js';
import { isMatchEnded, restartMatch } from '../game/match.js';
import { spectatorActive } from '../ui/spectator.js';
import { pingActivity } from '../ui/attract.js';
import { KBM_DEVICE } from './keyboard.js';

const DM_RESPAWN_COOLDOWN_MS = 2000;

const MOUSE_SENSITIVITY = 0.003;
const isTouchDevice = matchMedia('(pointer: coarse)').matches;

// Accumulated mouse turn delta (consumed each frame by the provider)
let turnDelta = 0;

/** Slot the mouse is currently driving, or null if unbound. Mouse shares
 *  the keyboard's KBM_DEVICE so they're claimed together. */
function kbmSlot() {
    return getDriverSlot(KBM_DEVICE);
}

/** The player object the mouse is currently driving, or null if unbound. */
function kbmPlayer() {
    const slot = kbmSlot();
    if (slot == null) return null;
    return state.players[slot];
}

/**
 * Initializes mouse event listeners.
 * Should be called once during application startup.
 */
export function initMouseInput() {
    // Mouse shares the keyboard's KBM_DEVICE — same press-to-claim binding.
    registerInputProvider(() => kbmSlot(), getInput);

    // Fire weapon on left click (outside UI elements). In DM, fire on a
    // dead kbm-target player respawns them after the cooldown. Pre-claim
    // in DM, the click claims the slot instead of firing.
    document.addEventListener('mousedown', event => {
        pingActivity();
        if (event.button !== 0 || spectatorActive || isTouchDevice) return;
        if (event.target.closest('#debug-menu, #menu, .hud, #spectator, #touch-controls, #help-overlay, #ui-buttons')) return;

        // Press-to-claim in DM lobby: unbound left-click claims a slot.
        if (state.mode === 'deathmatch' && kbmSlot() == null) {
            tryClaimSlot(KBM_DEVICE);
            return;
        }

        if (isMatchEnded()) { restartMatch(); return; }

        const player = kbmPlayer();
        if (player?.isDead) {
            if (state.mode === 'deathmatch'
                && performance.now() - player.deathTime > DM_RESPAWN_COOLDOWN_MS) {
                spawnPlayer(player);
            }
            return;
        }
        const slot = kbmSlot();
        if (slot == null || !player) return;
        inputs[slot].fireHeld = true;
        fireWeapon(player);
    });
    document.addEventListener('mouseup', event => {
        if (event.button === 0) {
            const slot = kbmSlot();
            if (slot != null) inputs[slot].fireHeld = false;
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
