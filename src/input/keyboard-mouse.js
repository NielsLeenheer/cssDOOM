/**
 * Keyboard + mouse — one input device, one entry point.
 *
 * Keyboard and mouse are a single logical device: they share state
 * (movement keys + mouse-look feed the same per-frame analog snapshot),
 * route to the same player slot, and respond to the same Tab swap. This
 * module owns the whole pipeline end-to-end.
 *
 * Three concerns live in this file, sectioned below:
 *
 *   1. Interpretation — shadow key state + mouseTurnDelta + the
 *      key/button → action mapping. Was kbm-input-handler.js.
 *   2. KBM device + Tab swap — two virtual device IDs (kbm-A, kbm-B)
 *      so each can claim a slot independently; Tab (dev only) flips
 *      which one is active. Was the top of keyboard.js.
 *   3. DOM wiring + init — keyboard listeners, mouse listeners,
 *      pointer-lock, blur reset, attract wake-up.
 *
 * # Key bindings (matches original DOOM + WASD):
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
 *                Left click     = fire
 *                Mouse move     = look (in pointer-lock)
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
 */

import { registerInputProvider } from '../orchestrator.js';
import { getDriverSlot, tryClaimSlot, applySavedClaim } from './claim-registry.js';
import { isMenuOpen } from '../ui/menu.js';
import { pingActivity } from '../renderer/screens/attract.js';
import { spectatorActive } from '../ui/spectator.js';
import { emit } from './event-bus.js';
import * as A from './actions.js';
import { WEAPONS } from '../shared/constants.js';

// ── Constants ──────────────────────────────────────────────────────────

const KBM_A = 'kbm-A';
const KBM_B = 'kbm-B';

// Mouse-movement sensitivity (turn-delta per pixel of pointer motion).
const MOUSE_SENSITIVITY = 0.003;

// True on touch-capable browsers — suppress mouse-down to fire so a tap
// on the weapon sprite doesn't accidentally fire (touch input has its
// own dedicated overlay button).
const isTouchDevice = matchMedia('(pointer: coarse)').matches;

// ── KBM active-device state ────────────────────────────────────────────

// Which virtual device is currently driving keyboard + mouse events.
let activeKbm = KBM_A;

/** Slot the active kbm device drives, or null if unbound. */
function activeSlot() {
    return getDriverSlot(activeKbm);
}

// ── Interpretation: shadow key state + mouse turn delta ────────────────

const keys = {
    up: false, down: false, left: false, right: false,
    strafeLeft: false, strafeRight: false, run: false, strafe: false,
};
let mouseTurnDelta = 0;

/** Per-frame analog snapshot read by the orchestrator's collectInputs. */
function getInput() {
    let moveX = 0, moveY = 0, turn = 0;

    if (keys.up) moveY += 1;
    if (keys.down) moveY -= 1;

    if (keys.strafeLeft || (keys.strafe && keys.left)) moveX -= 1;
    if (keys.strafeRight || (keys.strafe && keys.right)) moveX += 1;

    if (keys.left && !keys.strafe) turn += 1;
    if (keys.right && !keys.strafe) turn -= 1;

    const turnDelta = mouseTurnDelta;
    mouseTurnDelta = 0;

    return { moveX, moveY, turn, turnDelta, run: keys.run };
}

/**
 * Translate a keydown into either a movement-state update or an action
 * event. Returns true if the key was meaningful (caller may
 * preventDefault).
 */
function handleKeyDown(code) {
    const slot = activeSlot();
    switch (code) {
        case 'ArrowUp': case 'KeyW': keys.up = true; return true;
        case 'ArrowDown': case 'KeyS': keys.down = true; return true;
        case 'ArrowLeft': keys.left = true; return true;
        case 'ArrowRight': keys.right = true; return true;
        case 'KeyA': case 'Comma': keys.strafeLeft = true; return true;
        case 'KeyD': case 'Period': keys.strafeRight = true; return true;
        case 'ShiftLeft': case 'ShiftRight': keys.run = true; return true;
        case 'KeyZ': keys.strafe = true; return true;
        case 'Space':
            emit({ kind: A.USE, slot, deviceId: activeKbm });
            return true;
        case 'AltLeft': case 'AltRight': case 'KeyX':
            emit({ kind: A.FIRE_DOWN, slot, deviceId: activeKbm });
            return true;
        case 'Digit1': case 'Digit2': case 'Digit3':
        case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': {
            const ws = parseInt(code[5]);
            if (WEAPONS[ws]) emit({ kind: A.WEAPON_SELECT, slot, deviceId: activeKbm, weapon: ws });
            return true;
        }
        default: return false;
    }
}

function handleKeyUp(code) {
    switch (code) {
        case 'ArrowUp': case 'KeyW': keys.up = false; break;
        case 'ArrowDown': case 'KeyS': keys.down = false; break;
        case 'ArrowLeft': keys.left = false; break;
        case 'ArrowRight': keys.right = false; break;
        case 'KeyA': case 'Comma': keys.strafeLeft = false; break;
        case 'KeyD': case 'Period': keys.strafeRight = false; break;
        case 'ShiftLeft': case 'ShiftRight': keys.run = false; break;
        case 'KeyZ': keys.strafe = false; break;
        case 'AltLeft': case 'AltRight': case 'KeyX':
            emit({ kind: A.FIRE_UP, slot: activeSlot(), deviceId: activeKbm });
            break;
        // Meta release: clear movement to avoid stuck keys on macOS,
        // where keyup is suppressed while Meta is held.
        case 'MetaLeft': case 'MetaRight':
            keys.up = keys.down = keys.left = keys.right = false;
            keys.strafeLeft = keys.strafeRight = false;
            break;
    }
}

function handleMouseDown(button) {
    if (button !== 0) return;
    emit({ kind: A.FIRE_DOWN, slot: activeSlot(), deviceId: activeKbm });
}

function handleMouseUp(button) {
    if (button !== 0) return;
    emit({ kind: A.FIRE_UP, slot: activeSlot(), deviceId: activeKbm });
}

function addMouseTurn(dx) {
    mouseTurnDelta -= dx * MOUSE_SENSITIVITY;
}

function resetKeys() {
    keys.up = keys.down = keys.left = keys.right = false;
    keys.strafeLeft = keys.strafeRight = keys.run = keys.strafe = false;
}

/** Release any held fire on the active slot — used by Tab swap so the
 *  abandoned slot doesn't keep firing after the device flips away. */
function releaseHeldFire() {
    const slot = activeSlot();
    if (slot != null) emit({ kind: A.FIRE_UP, slot, deviceId: activeKbm });
}

// ── Tab debug swap ─────────────────────────────────────────────────────

function isTabSwapEnabled() {
    const host = location.hostname;
    if (host === 'localhost' || host === '127.0.0.1') return true;
    if (host.includes('-staging.')) return true;
    if (host === 'dm.cssdoom.wtf') return true;
    return false;
}

/**
 * Tab pressed — debug affordance for driving two players from one
 * keyboard. Enabled on dev (`localhost`), the `*-staging.*workers.dev`
 * URL, and the `dm.cssdoom.wtf` subdomain (network-DM staging) for
 * smoke-testing two-player Local DM from one keyboard; disabled on
 * production / the kiosk URL.
 */
function handleTab() {
    if (!isTabSwapEnabled()) return;
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
    releaseHeldFire();
    resetKeys();
    activeKbm = other;
}

// ── Public init ────────────────────────────────────────────────────────

/**
 * Wire keyboard + mouse to the orchestrator and the event bus. One
 * entry point covers both halves; callers no longer need to remember
 * to init each separately.
 */
export function initKeyboardMouse() {
    registerInputProvider(activeSlot, getInput);
    // Resume any KBM bindings from the previous page load in this tab
    // (sessionStorage). Keyboard is always "connected" so we can do
    // this synchronously at init.
    applySavedClaim(KBM_A);
    applySavedClaim(KBM_B);

    // ── Keyboard ──────────────────────────────────────────────────

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

        // Tab — debug-only KBM_A ↔ KBM_B device swap.
        if (event.code === 'Tab') {
            event.preventDefault();
            handleTab();
            return;
        }

        // Suppress OS key-repeat events to prevent rapid action firing.
        if (event.repeat) return;

        if (handleKeyDown(event.code)) {
            event.preventDefault();
        }
    });

    document.addEventListener('keyup', event => {
        handleKeyUp(event.code);
    });

    window.addEventListener('blur', resetKeys);

    // ── Mouse ─────────────────────────────────────────────────────

    document.addEventListener('mousedown', event => {
        // Wake from attract — first click only dismisses the overlay;
        // claim/fire happen on subsequent presses (handled by gates).
        if (pingActivity()) return;
        if (event.button !== 0 || spectatorActive || isTouchDevice) return;
        if (event.target.closest('#debug-menu, #menu, .hud, #spectator, #touch-controls, #help-overlay, #ui-buttons')) return;

        handleMouseDown(event.button);
    });

    document.addEventListener('mouseup', event => {
        handleMouseUp(event.button);
    });

    // Request pointer lock when entering fullscreen.
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            document.documentElement.requestPointerLock();
        }
    });

    // Accumulate mouse movement as turn delta.
    document.addEventListener('mousemove', event => {
        if (document.pointerLockElement) {
            addMouseTurn(event.movementX);
            pingActivity();
        }
    });
}
