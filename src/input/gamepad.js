/**
 * Gamepad Input
 *
 * Native Gamepad API — no library dependency. Detects connect/disconnect
 * via `gamepadconnected` / `gamepaddisconnected` events plus a RAF poll
 * loop that doubles as a fallback for browsers that don't reliably fire
 * `gamepadconnected` for gamepads already plugged in at page load
 * (Firefox/Safari behaviour). The poll loop is also where per-frame
 * input is read.
 *
 * Bindings (modern FPS console layout):
 *
 *   Left stick:        move forward/backward + strafe left/right
 *   Right stick:       turn left/right
 *   A / Cross / b0:    use (open doors, activate switches/lifts)
 *   Right trigger / b7: fire weapon
 *   Left trigger / b6: run modifier (hold for sprint speed)
 *   L1 / LB / b4:      previous weapon
 *   R1 / RB / b5:      next weapon
 *   D-pad up / b12:    next weapon (alternative to R1)
 *   D-pad down / b13:  previous weapon (alternative to L1)
 *   Start / Options / b9: toggle menu
 *
 * Triggers (L2 / R2) are read via the analog `value` property in
 * addition to `pressed`. Some controllers — notably Xbox on macOS —
 * don't reliably flip `buttons[N].pressed` even when the trigger is
 * fully pulled. Polling the value each cycle works on every
 * controller we've tested.
 *
 * Per-player: each gamepad's deviceId is `gamepad-${gamepad.index}`.
 * The press-to-claim registry binds it to a player slot. Each pad has
 * its own analog state so multiple pads contribute to different input
 * slots independently.
 */

import { inputs, registerInputProvider } from '../orchestrator.js';
import { getDriverSlot, unclaim, applySavedClaim } from './claim-registry.js';
import { pingActivity } from '../game/attract.js';
import { emit } from './event-bus.js';
import * as A from './actions.js';

const STICK_DEADZONE = 0.15;
// Right-stick deflection is mapped to the same `turn` rate channel the
// keyboard uses, so movement.js applies it via `turn * TURN_SPEED * dt`
// and turning stays framerate-independent. At full stick this scale
// yields TURN_SPEED * GAMEPAD_TURN_SCALE rad/s — tune by feel.
const GAMEPAD_TURN_SCALE = 0.65;
// Threshold past which an analog trigger counts as "pressed". Half-pull
// fires the action; release returns it to false. Standard FPS feel.
const TRIGGER_THRESHOLD = 0.5;
// Press detection for non-trigger buttons falls back to `value` when the
// `pressed` boolean stays false despite an active button — seen on
// Firefox + PS5 DualSense face buttons. Face buttons are digital, so
// `value` is effectively 0 or 1; 0.5 catches the active state cleanly.
const BUTTON_PRESS_THRESHOLD = 0.5;
// PS5 DualSense in Firefox (mapping="") reports the D-pad on axis 6 as
// an 8-way hat instead of buttons 12–15. Values: up=-1.0, down=0.143,
// left=0.714, right=-0.429, neutral=1.286. Step between directions is
// 2/7 because 8 directions span the [-1, 1] range plus one neutral
// slot. Confirmed by `_gamepadLogChanges` capture from both new pads.
const HAT_AXIS = 6;
const HAT_NEUTRAL_THRESHOLD = 1.14;
const HAT_DIRECTION_STEP = 2 / 7;

/** Per-gamepad analog state, keyed by gamepad.index. */
const padStates = new Map();

/** Build the per-gamepad deviceId used by the press-to-claim registry. */
function gamepadDeviceId(gamepadIndex) {
    return `gamepad-${gamepadIndex}`;
}

/**
 * Initialise gamepad input. Native `gamepadconnected` fires when a pad
 * is plugged in (or first interacted with on a page-load-already-plugged
 * gamepad). The poll loop is the source of truth — it both reads pad
 * state and detects pads that the connect event missed.
 *
 * Polling runs on `setInterval` rather than `requestAnimationFrame` so
 * sampling stays at a fixed ~125Hz independent of paint throttling.
 * RAF was getting throttled to ~22Hz in attract mode (heavy DOM mutation
 * pushing browser frame budget over 16ms), which let quick button taps
 * fall between samples. A fixed-cadence timer is immune to that.
 */
const POLL_INTERVAL_MS = 8;

export function initGamepadInput() {
    window.addEventListener('gamepadconnected', (e) => {
        if (!padStates.has(e.gamepad.index)) {
            setupGamepad(e.gamepad);
        }
    });
    window.addEventListener('gamepaddisconnected', (e) => {
        handleDisconnect(e.gamepad.index);
    });

    // Walk pads that are already enumerated at init — on a same-tab
    // reload the browser remembers them, so `gamepadconnected` may not
    // fire. Setting them up here means saved claims (sessionStorage)
    // are restored synchronously before the lobby's match-reset
    // snapshot runs, so the restored slots are treated as carried-over
    // and don't flash READY.
    const initial = navigator.getGamepads ? navigator.getGamepads() : [];
    for (const pad of initial) {
        if (pad && !padStates.has(pad.index)) setupGamepad(pad);
    }

    setInterval(pollGamepads, POLL_INTERVAL_MS);

    // TEMPORARY DIAGNOSTIC. Call `_gamepadDebug()` from the console to
    // dump every connected pad's id, mapping, axes, and buttons.
    window._gamepadDebug = () => {
        const pads = navigator.getGamepads ? navigator.getGamepads() : [];
        for (const pad of pads) {
            if (!pad) continue;
            console.log({
                index: pad.index,
                id: pad.id,
                mapping: pad.mapping,
                connected: pad.connected,
                axes: Array.from(pad.axes).map((v, i) => ({ [i]: Number(v.toFixed(3)) })),
                buttons: Array.from(pad.buttons).map((b, i) => ({
                    [i]: { pressed: b.pressed, value: Number((b.value ?? 0).toFixed(2)) },
                })),
            });
        }
    };

    // Toggle a change-logger that prints whenever any axis or button on
    // any pad changes from its previous polled value. Use to discover
    // where unusual inputs (e.g. PS5 D-pad in non-standard mapping) are
    // reported: enable, press each direction once, disable, read log.
    window._gamepadLogChanges = (enable) => {
        _logChangesEnabled = !!enable;
        _logChangesPrev.clear();
        console.log(`[gamepad] change logger ${_logChangesEnabled ? 'ON' : 'OFF'}`);
    };
}

let _logChangesEnabled = false;
const _logChangesPrev = new Map();
const AXIS_CHANGE_THRESHOLD = 0.1;

function logChangesIfEnabled(rawPad) {
    if (!_logChangesEnabled) return;
    const key = rawPad.index;
    const prev = _logChangesPrev.get(key) ?? { axes: [], buttons: [] };
    const next = {
        axes: Array.from(rawPad.axes),
        buttons: Array.from(rawPad.buttons).map(b => ({ pressed: b.pressed, value: b.value ?? 0 })),
    };
    for (let i = 0; i < next.axes.length; i++) {
        const before = prev.axes[i] ?? 0;
        if (Math.abs(next.axes[i] - before) > AXIS_CHANGE_THRESHOLD) {
            console.log(`[pad ${key}] axis[${i}] ${before.toFixed(3)} → ${next.axes[i].toFixed(3)}`);
        }
    }
    for (let i = 0; i < next.buttons.length; i++) {
        const before = prev.buttons[i] ?? { pressed: false, value: 0 };
        const after = next.buttons[i];
        if (before.pressed !== after.pressed || Math.abs(before.value - after.value) > 0.1) {
            console.log(`[pad ${key}] button[${i}] pressed=${before.pressed}→${after.pressed} value=${before.value.toFixed(2)}→${after.value.toFixed(2)}`);
        }
    }
    _logChangesPrev.set(key, next);
}

/**
 * Per-frame poll. Walks `navigator.getGamepads()` and:
 *   - Sets up any pad we haven't seen before (covers the case where
 *     `gamepadconnected` didn't fire — Firefox/Safari sometimes only
 *     surface a gamepad after the first user gesture on it).
 *   - Updates each pad's analog state and dispatches button transitions.
 *   - Detects pads that disappeared without firing `gamepaddisconnected`.
 */
// TEMPORARY DIAGNOSTIC: log when the gap between consecutive polls grows
// beyond ~3× the expected interval (now setInterval-based at 8ms). With
// the timer-driven poll we expect ~8–16ms gaps; sustained gaps near 44ms
// would mean the timer itself is being throttled, not just RAF.
function pollGamepads() {
    const rawPads = navigator.getGamepads ? navigator.getGamepads() : [];

    for (let i = 0; i < rawPads.length; i++) {
        const rawPad = rawPads[i];
        if (!rawPad) {
            // Slot empty — if we previously had a pad here, it went away.
            if (padStates.has(i) && padStates.get(i)._wasConnected) {
                handleDisconnect(i);
            }
            continue;
        }

        // Late-detected gamepad (gamepadconnected didn't fire, e.g.
        // because the user hadn't pressed anything on it yet).
        if (!padStates.has(rawPad.index)) {
            setupGamepad(rawPad);
        }

        logChangesIfEnabled(rawPad);
        processGamepad(rawPad);
    }
}

/** Translate a gamepad's current state into padState updates + button events. */
function processGamepad(rawPad) {
    const padState = padStates.get(rawPad.index);
    if (!padState) return;
    padState._wasConnected = true;

    // ── Sticks → padState (left = move, right = turn) ──
    const axes = rawPad.axes ?? [];
    if (axes.length >= 2) {
        const lx = axes[0] || 0;
        const ly = axes[1] || 0;
        padState.moveX = Math.abs(lx) > STICK_DEADZONE ? lx : 0;
        padState.moveY = Math.abs(ly) > STICK_DEADZONE ? -ly : 0; // invert Y for north=forward
    }
    if (axes.length >= 4) {
        const rx = axes[2] || 0;
        padState.turn = Math.abs(rx) > STICK_DEADZONE ? -rx * GAMEPAD_TURN_SCALE : 0;
    }
    if (padState.moveX || padState.moveY || padState.turn) pingActivity();

    // ── D-pad hat fallback ──
    // PS5 DualSense in Firefox: the D-pad is on axis 9 (8-way hat),
    // not buttons 12–15. Decode the hat into synthetic press flags so
    // the unified button loop below can edge-detect them just like any
    // other button. Standard-mapping controllers still drive buttons
    // 12–15 directly; the OR below makes both sources work.
    const hat = axes[HAT_AXIS];
    let hatUp = false, hatDown = false, hatLeft = false, hatRight = false;
    if (typeof hat === 'number' && hat <= HAT_NEUTRAL_THRESHOLD) {
        const idx = Math.round((hat + 1) / HAT_DIRECTION_STEP);
        // 0 = N, 1 = NE, 2 = E, 3 = SE, 4 = S, 5 = SW, 6 = W, 7 = NW
        hatUp    = idx === 0 || idx === 1 || idx === 7;
        hatRight = idx === 1 || idx === 2 || idx === 3;
        hatDown  = idx === 3 || idx === 4 || idx === 5;
        hatLeft  = idx === 5 || idx === 6 || idx === 7;
    }

    // ── Button transitions ──
    // Detect each button's press/release transition by comparing current
    // state against the previous tick. All buttons use both `pressed`
    // and `value` — some Firefox + controller combos (Xbox on macOS,
    // PS5 DualSense face buttons) leave `pressed` false while `value`
    // goes to 1.0.
    const handlers = padState._handlers;
    const prev = padState._prevButtons ??= [];
    const buttons = rawPad.buttons ?? [];
    for (let i = 0; i < buttons.length; i++) {
        const button = buttons[i];
        if (!button) continue;
        const threshold = (i === 6 || i === 7) ? TRIGGER_THRESHOLD : BUTTON_PRESS_THRESHOLD;
        const hatFlag = i === 12 ? hatUp : i === 13 ? hatDown : i === 14 ? hatLeft : i === 15 ? hatRight : false;
        const isPressed = button.pressed || (button.value ?? 0) > threshold || hatFlag;
        const wasPressed = prev[i] ?? false;

        if (isPressed && !wasPressed) {
            // Wake from attract on any press; if that's what just
            // happened, skip the emit so the wakeup press is a
            // dedicated "enter lobby" press, not also a fire/use/etc.
            if (pingActivity()) {
                prev[i] = isPressed;
                continue;
            }
            // Each handler emits its logical action on the bus.
            // Press-to-claim / dead-respawn / match-end / intermission
            // gates in src/actions/gates.js consume as needed.
            handlers[i]?.press?.();
        } else if (!isPressed && wasPressed) {
            handlers[i]?.release?.();
        }
        prev[i] = isPressed;
    }

    // ── Run modifier (L2 / button6) ──
    // Continuous state (held = run, released = walk), separate from the
    // button-transition handling above. Sets padState.run which
    // collectInputs OR-merges into the slot's input.
    const l2 = buttons[6];
    padState.run = !!l2 && (l2.pressed || (l2.value ?? 0) > TRIGGER_THRESHOLD);
}

/** Returns true if any gamepad is currently connected. */
export function isGamepadConnected() {
    for (const padState of padStates.values()) {
        if (padState._wasConnected) return true;
    }
    return false;
}

// ============================================================================
// Gamepad Binding
// ============================================================================

function setupGamepad(gamepad) {
    const gamepadIndex = gamepad.index;
    const deviceId = gamepadDeviceId(gamepadIndex);
    const padState = {
        moveX: 0, moveY: 0, turn: 0, run: false,
        _wasConnected: false,
    };
    padStates.set(gamepadIndex, padState);

    // Per-gamepad provider — contributes to whichever slot the press-to-
    // claim system has bound this gamepad to. SP auto-binds to slot 0,
    // DM requires fire-press claim before contributing. The unregister
    // function is stashed on padState so handleDisconnect can remove
    // the provider when the pad goes away.
    padState._unregister = registerInputProvider(
        () => getDriverSlot(deviceId),
        () => padState,
    );

    // Resume any saved binding from this tab's sessionStorage so reloads
    // keep the same controller on the same pane. Gamepad indices are
    // typically stable across same-tab reloads when the hardware doesn't
    // change; if not, the saved entry silently drops to null and the
    // player can re-claim by pressing fire.
    applySavedClaim(deviceId);

    /** The slot this gamepad currently drives, or null if unbound. */
    const slotForPad = () => getDriverSlot(deviceId);

    // Per-button press/release handlers, dispatched by `processGamepad`.
    // Each handler just emits the logical action on the bus — gates +
    // action handlers in src/actions/ do the dispatch.
    const handlers = {};

    // A / Cross (button0): Use
    handlers[0] = {
        press: () => emit({ kind: A.USE, slot: slotForPad(), deviceId }),
    };
    // L1 / LB (button4): Previous weapon
    handlers[4] = {
        press: () => emit({ kind: A.WEAPON_PREV, slot: slotForPad(), deviceId }),
    };
    // R1 / RB (button5): Next weapon
    handlers[5] = {
        press: () => emit({ kind: A.WEAPON_NEXT, slot: slotForPad(), deviceId }),
    };
    // R2 / RT (button7): Fire. Run-modifier is L2 (button6) — handled
    // separately via padState.run because it's a continuous state rather
    // than a discrete press/release.
    handlers[7] = {
        press: () => emit({ kind: A.FIRE_DOWN, slot: slotForPad(), deviceId }),
        release: () => emit({ kind: A.FIRE_UP, slot: slotForPad(), deviceId }),
    };
    // Start / Options (button9): Toggle menu
    handlers[9] = {
        press: () => emit({ kind: A.MENU_TOGGLE, slot: slotForPad(), deviceId }),
    };
    // D-pad up (button12): Next weapon (mirrors R1)
    handlers[12] = {
        press: () => emit({ kind: A.WEAPON_NEXT, slot: slotForPad(), deviceId }),
    };
    // D-pad down (button13): Previous weapon (mirrors L1)
    handlers[13] = {
        press: () => emit({ kind: A.WEAPON_PREV, slot: slotForPad(), deviceId }),
    };

    padState._handlers = handlers;
}

/**
 * Drop a gamepad on disconnect. Unregisters the input provider so the
 * orchestrator stops polling a defunct closure, drops the padState
 * entry, and releases the slot claim so a different device can take it
 * in DM lobby. On reconnect (same or different index) the standard
 * `gamepadconnected` path / poll-loop late-detect runs setupGamepad
 * fresh — a new padState + new provider.
 */
function handleDisconnect(gamepadIndex) {
    const padState = padStates.get(gamepadIndex);
    if (padState) {
        padState._unregister?.();
        padStates.delete(gamepadIndex);
    }
    const deviceId = gamepadDeviceId(gamepadIndex);
    const claimedSlot = getDriverSlot(deviceId);
    if (claimedSlot != null) {
        unclaim(deviceId);
        const slotInputs = inputs[claimedSlot];
        if (slotInputs) slotInputs.fireHeld = false;
    }
}

