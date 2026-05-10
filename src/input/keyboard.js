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
 * # KBM device + Tab debug switching
 *
 * Keyboard and mouse share one physical device but expose two **virtual**
 * device IDs: `kbm-A` and `kbm-B`. Each can claim a slot independently
 * via the press-to-claim registry, but only one is "active" at a time —
 * the active one is the slot that key/mouse events route to right now.
 *
 *   - First non-Tab key press claims the **active** kbm device for the
 *     next free slot (default active is kbm-A → typically slot 0).
 *   - Tab claims the **other** kbm device for the next free slot, then
 *     flips active to it (debug affordance: one keyboard drives two
 *     players sequentially).
 *   - Once both are claimed, Tab toggles which one is active.
 *
 * `body[data-kbm-target=N]` tracks the active kbm's current slot so CSS
 * can outline the pane the keyboard is driving.
 *
 * When the player is dead, any keypress reloads the current map (SP) or
 * respawns (DM). When the window loses focus or Meta is released, all
 * movement keys are cleared to prevent stuck-key issues on macOS.
 */

import { inputs, registerInputProvider, getDriverSlot, tryClaimSlot, onClaimChange } from './index.js';
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
// only the active kbm device's slot reads them.
const keys = {
    up: false, down: false, left: false, right: false,
    strafeLeft: false, strafeRight: false, run: false, strafe: false,
};

// Two virtual deviceIds for the same physical keyboard+mouse, so each can
// claim a slot independently via the press-to-claim registry.
export const KBM_A = 'kbm-A';
export const KBM_B = 'kbm-B';

// Which virtual device is currently driving keyboard + mouse events.
let activeKbm = KBM_A;

/** Returns the kbm device currently driving input. Mouse module reads this
 *  so it claims and routes via the same active device. */
export function getActiveKbm() {
    return activeKbm;
}

/** Slot the active kbm device drives, or null if unbound. */
function activeSlot() {
    return getDriverSlot(activeKbm);
}

/** Player object the active kbm device drives, or null if unbound. */
function activePlayer() {
    const slot = activeSlot();
    if (slot == null) return null;
    return state.players[slot];
}

/**
 * Reset all locally-held key flags. Called on Tab swap, window blur,
 * and Meta release so a held W/Alt doesn't leak into the next slot
 * (or stay stuck after losing focus).
 */
function resetHeldKeys() {
    keys.up = keys.down = keys.left = keys.right = false;
    keys.strafeLeft = keys.strafeRight = keys.run = keys.strafe = false;
}

/**
 * Update body[data-kbm-target] to reflect the active kbm's current slot.
 * Removes the attribute when the active kbm is unbound (no outline).
 */
function syncKbmTargetAttribute() {
    const slot = activeSlot();
    if (slot == null) {
        delete document.body.dataset.kbmTarget;
    } else {
        document.body.dataset.kbmTarget = String(slot);
    }
}

/**
 * Tab pressed — debug affordance for driving two players from one
 * keyboard. Gated to the dev server so installation play (kiosk build)
 * can't accidentally land in a half-claimed state from an idle keypress.
 * Three cases:
 *   1. Active kbm not yet claimed → ignore (need a regular keypress
 *      first to claim, then Tab grabs the second slot).
 *   2. Other kbm not yet claimed → try to claim it for the next free
 *      slot. On success, flip active to the newly-claimed device.
 *   3. Both claimed → toggle active between the two.
 *
 * In every "did something" case we drop held keys + the previous slot's
 * fireHeld so a held W or Alt doesn't follow the swap.
 */
function handleTab() {
    if (!import.meta.env.DEV) return;
    if (activeSlot() == null) return;

    const other = activeKbm === KBM_A ? KBM_B : KBM_A;
    const otherSlot = getDriverSlot(other);

    if (otherSlot == null) {
        const claimed = tryClaimSlot(other);
        if (claimed == null) return;  // No free slot available.
    }

    // Flip active. Clear the previous slot's transient input so the user's
    // currently-held keys/buttons don't keep driving the abandoned slot.
    const previousSlot = activeSlot();
    if (previousSlot != null && inputs[previousSlot]) {
        inputs[previousSlot].fireHeld = false;
    }
    resetHeldKeys();
    activeKbm = other;
    syncKbmTargetAttribute();
}

/**
 * Initializes keyboard event listeners.
 * Should be called once during application startup.
 */
export function initKeyboardInput() {
    // Keyboard's slot is determined by the press-to-claim registry. The
    // provider routes via whichever virtual device is currently active.
    registerInputProvider(() => activeSlot(), getInput);

    // Reflect claim-state changes (claim added, released, all-cleared on
    // match reset) in the data-kbm-target attribute so the pane outline
    // tracks reality without each call site remembering to sync.
    onClaimChange(syncKbmTargetAttribute);
    syncKbmTargetAttribute();

    // Keyboard: key down
    document.addEventListener('keydown', event => {
        pingActivity();

        if (event.code === 'Escape') {
            toggleMenu(!isMenuOpen());
            event.preventDefault();
            return;
        }

        if (isMenuOpen()) return;

        if (isMatchEnded()) {
            const code = event.code;
            if (code === 'AltLeft' || code === 'AltRight' || code === 'KeyX' || code === 'Space') {
                restartMatch();
                event.preventDefault();
            }
            return;
        }

        // Tab — debug-only "give the other kbm device a slot, then
        // toggle". preventDefault always so Tab never cycles page focus,
        // regardless of whether the swap actually fires.
        if (event.code === 'Tab') {
            event.preventDefault();
            handleTab();
            return;
        }

        const player = activePlayer();

        // Press-to-claim: in DM lobby with the active kbm unbound, *any*
        // key counts as a join. Escape, Tab, and the menu/match-end keys
        // are already handled above so they don't reach this gate.
        if (state.mode === 'deathmatch' && player == null) {
            tryClaimSlot(activeKbm);
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

        if (event.repeat) return;

        switch (event.code) {
            case 'ArrowUp': case 'KeyW': keys.up = true; break;
            case 'ArrowDown': case 'KeyS': keys.down = true; break;
            case 'ArrowLeft': keys.left = true; break;
            case 'ArrowRight': keys.right = true; break;
            case 'KeyA': case 'Comma': keys.strafeLeft = true; break;
            case 'KeyD': case 'Period': keys.strafeRight = true; break;
            case 'ShiftLeft': case 'ShiftRight': keys.run = true; break;
            case 'KeyZ': keys.strafe = true; break;
            case 'Space': tryOpenDoor(player); tryUseSwitch(player); tryUseLift(player); break;
            case 'AltLeft': case 'AltRight': case 'KeyX': {
                const slot = activeSlot();
                if (slot != null) inputs[slot].fireHeld = true;
                fireWeapon(player);
                break;
            }
            case 'Digit1': case 'Digit2': case 'Digit3':
            case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7':
                const weaponSlot = parseInt(event.code[5]);
                if (WEAPONS[weaponSlot]) equipWeapon(player, weaponSlot);
                break;
            default: return;
        }
        event.preventDefault();
    });

    // Keyboard: key up
    document.addEventListener('keyup', event => {
        const player = activePlayer();
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
                const slot = activeSlot();
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

    window.addEventListener('blur', resetHeldKeys);
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
