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
 * The actual key→action mapping (movement, fire, weapon select, dead
 * respawn, etc.) lives in [kbm-input-handler.js](kbm-input-handler.js)
 * and is shared with mouse.js + remote-master.js. This file owns the
 * keyboard-only wrappers: Escape, Tab, press-to-claim on first key,
 * event.repeat suppression, blur reset, and the input-provider hookup.
 */

import { inputs, registerInputProvider } from './index.js';
import { getDriverSlot, tryClaimSlot, onClaimChange } from './claim-registry.js';
import { state } from '../game/state.js';
import { isMenuOpen, toggleMenu } from '../ui/menu.js';
import { pingActivity } from '../ui/attract.js';
import { isMatchEnded } from '../game/match.js';
import { createKbmInputHandler } from './kbm-input-handler.js';

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

// Shared kbm input handler — one instance drives both keyboard and
// mouse events for the locally-active virtual device. Mouse imports
// `kbmHandler` to feed mousedown/up/move into the same pipeline.
export const kbmHandler = createKbmInputHandler({
    getSlot: activeSlot,
    inputs,
});

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

    // Flip active. Clear the previous slot's transient input so the
    // user's currently-held keys/buttons don't keep driving the
    // abandoned slot.
    kbmHandler.clearFireHeld();
    kbmHandler.resetKeys();
    activeKbm = other;
    syncKbmTargetAttribute();
}

/**
 * Initializes keyboard event listeners.
 * Should be called once during application startup.
 */
export function initKeyboardInput() {
    registerInputProvider(() => activeSlot(), kbmHandler.getInput);
    onClaimChange(syncKbmTargetAttribute);
    syncKbmTargetAttribute();

    document.addEventListener('keydown', event => {
        pingActivity();

        // Escape — master-window menu toggle. Outside the kbm pipeline
        // because the menu lives on the master regardless of which slot
        // the active kbm is driving.
        if (event.code === 'Escape') {
            toggleMenu(!isMenuOpen());
            event.preventDefault();
            return;
        }

        if (isMenuOpen()) return;

        // Tab — debug-only kbm-target swap. preventDefault unconditionally
        // so Tab never cycles page focus, regardless of build mode.
        if (event.code === 'Tab') {
            event.preventDefault();
            handleTab();
            return;
        }

        // Press-to-claim: in DM lobby with the active kbm unbound, *any*
        // key counts as a join. Skip while a match has ended so a fire
        // key triggers the restart inside kbmHandler instead of being
        // consumed by the claim flow.
        if (state.mode === 'deathmatch' && activeSlot() == null && !isMatchEnded()) {
            tryClaimSlot(activeKbm);
            event.preventDefault();
            return;
        }

        // Suppress OS key-repeat events to prevent rapid action firing.
        if (event.repeat) return;

        if (kbmHandler.handleKeyDown(event.code)) {
            event.preventDefault();
        }
    });

    document.addEventListener('keyup', event => {
        kbmHandler.handleKeyUp(event.code);
    });

    window.addEventListener('blur', kbmHandler.resetKeys);
}
