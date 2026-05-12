/**
 * Keyboard input — emits logical action events on the bus and
 * accumulates movement keys for the per-frame `inputs[]` aggregate.
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
 *   - First action-press (fire/use/weapon) by an unbound kbm in a DM
 *     lobby claims the next free slot (handled by the claim gate in
 *     `src/actions/gates.js`).
 *   - Tab (dev only) claims the *other* kbm device for the next free
 *     slot and flips active to it.
 *   - Once both are claimed, Tab toggles which one is active.
 *
 * `body[data-kbm-target=N]` tracks the active kbm's current slot so CSS
 * can outline the pane the keyboard is driving.
 *
 * The actual key→action emit lives in
 * [kbm-input-handler.js](kbm-input-handler.js) and is shared with
 * `mouse.js` + `remote-master.js`. This file owns: Escape menu toggle,
 * Tab dev swap, isMenuOpen gating of movement keys, event.repeat
 * suppression, blur reset, attract wake-up, and the input-provider
 * hookup.
 */

import { inputs, registerInputProvider } from './index.js';
import { getDriverSlot, tryClaimSlot, onClaimChange, applySavedClaim } from './claim-registry.js';
import { isMenuOpen } from '../ui/menu.js';
import { pingActivity } from '../ui/attract.js';
import { createKbmInputHandler } from './kbm-input-handler.js';
import { emit } from './event-bus.js';
import * as A from './actions.js';

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
// `kbmHandler` to feed mousedown/up/move into the same pipeline. The
// getDeviceId callback returns whichever virtual kbm is currently
// active, so Tab's swap is reflected in the bus events without
// recreating the handler.
export const kbmHandler = createKbmInputHandler({
    getSlot: activeSlot,
    getDeviceId: () => activeKbm,
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
 * keyboard. Gated to the dev server so installation play can't
 * accidentally land in a half-claimed state from an idle keypress.
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

export function initKeyboardInput() {
    registerInputProvider(() => activeSlot(), kbmHandler.getInput);
    onClaimChange(syncKbmTargetAttribute);
    // Resume any KBM bindings from the previous page load in this tab
    // (sessionStorage). Keyboard is always "connected" so we can do
    // this synchronously at init.
    applySavedClaim(KBM_A);
    applySavedClaim(KBM_B);
    syncKbmTargetAttribute();

    document.addEventListener('keydown', event => {
        // Wake from attract on any keypress; if that's what just happened,
        // consume the event so the wakeup press doesn't immediately claim
        // a slot or toggle the menu.
        if (pingActivity()) {
            event.preventDefault();
            return;
        }

        // Escape — master-window menu toggle. Routed via the bus so the
        // menu action lives in src/actions/menu.js.
        if (event.code === 'Escape') {
            emit({ kind: A.MENU_TOGGLE, slot: null, deviceId: activeKbm });
            event.preventDefault();
            return;
        }

        // Menu open — block all other keys so movement / fire / etc.
        // don't leak through. Bus gate handles action events, but
        // movement keys update the shadow state directly so we skip
        // here too.
        if (isMenuOpen()) return;

        // Tab — debug-only kbm-target swap.
        if (event.code === 'Tab') {
            event.preventDefault();
            handleTab();
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
