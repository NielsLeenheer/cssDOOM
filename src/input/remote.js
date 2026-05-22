/**
 * Master-side input source for envelopes forwarded from one or more
 * remotes.
 *
 * From master's perspective each remote is just another input device —
 * exactly like keyboard, mouse, gamepad, touch — that registers an
 * analog provider with the orchestrator and emits action events on the
 * bus. The only difference is the source: instead of DOM events, the
 * input arrives over a Transport from a remote that ran its own input
 * pipeline ([../client.js](../client.js)) and shipped the results.
 *
 *   - ACTION  → re-emit on master's event bus. Master's `src/actions/*`
 *               handlers run as if the action were local. The action
 *               envelope already carries its own slot.
 *   - ANALOG  → cache the latest snapshot per slot. Master's per-frame
 *               `collectInputs` polls each slot's snapshot via the
 *               registered input provider so movement / turn track the
 *               originating remote.
 *
 * Per-slot snapshots are lazily initialised on the first ANALOG envelope
 * carrying a given slot, registering an input provider scoped to that
 * slot. `clearRemoteSlot(slot)` zeros a slot's snapshot when its peer
 * disconnects so residual movement doesn't apply to a freshly-rebound
 * slot.
 */

import { registerInputProvider } from '../orchestrator.js';
import { pingActivity } from '../game/attract.js';
import { emit } from './event-bus.js';
import { MSG } from '../transport/protocol.js';

// slot → { moveX, moveY, turn, turnDelta, run }. Mutated in place so
// each slot's provider can return its snapshot by reference and the
// orchestrator's collectInputs reads the current values.
const analogBySlot = new Map();

function makeZeroAnalog() {
    return { moveX: 0, moveY: 0, turn: 0, turnDelta: 0, run: false };
}

/**
 * Ensure a snapshot + registered provider exist for `slot`. Idempotent.
 * Returns the snapshot object so the caller can mutate it.
 */
function ensureSlot(slot) {
    let snapshot = analogBySlot.get(slot);
    if (snapshot) return snapshot;
    snapshot = makeZeroAnalog();
    analogBySlot.set(slot, snapshot);
    registerInputProvider(() => slot, () => snapshot);
    return snapshot;
}

/** Called by PeerConnection when an ACTION or ANALOG envelope arrives. */
export function applyRemoteInput(msg) {
    if (msg.type === MSG.ACTION) {
        // Discrete press from the remote wakes attract; first wake-up
        // press is consumed so it doesn't double as a weapon fire.
        if (pingActivity() && isWakeable(msg.kind)) return;
        // Re-emit on master's bus. The full envelope already carries
        // kind / slot / deviceId / any action-specific extras — pass
        // through unchanged.
        emit(msg);
    } else if (msg.type === MSG.ANALOG) {
        const snapshot = ensureSlot(msg.slot);
        snapshot.moveX     = msg.moveX     || 0;
        snapshot.moveY     = msg.moveY     || 0;
        snapshot.turn      = msg.turn      || 0;
        // turnDelta is a per-tick delta — consume on read by zeroing
        // here would be wrong since the next ANALOG arrives before the
        // next frame collects inputs. Just take the latest value; if
        // updates lag a frame the worst case is a one-frame stale turn.
        snapshot.turnDelta = msg.turnDelta || 0;
        snapshot.run       = !!msg.run;
    }
}

/**
 * Zero a slot's snapshot. Called from master.js's onLeave so a
 * departed peer's last analog values don't bleed into the slot when
 * it's rebound to a new peer (or the host's local roster reclaims it).
 * No-op for slots that never received ANALOG.
 */
export function clearRemoteSlot(slot) {
    const snapshot = analogBySlot.get(slot);
    if (!snapshot) return;
    snapshot.moveX = 0;
    snapshot.moveY = 0;
    snapshot.turn = 0;
    snapshot.turnDelta = 0;
    snapshot.run = false;
}

// Actions that should "wake" attract mode (the discrete-press analog of
// a controller button or fire key). Movement-direction analog doesn't
// belong here — that flows through ANALOG envelopes which never wake
// attract.
function isWakeable(kind) {
    return kind === 'fire-down'
        || kind === 'use'
        || kind === 'weapon-prev'
        || kind === 'weapon-next'
        || kind === 'weapon-select';
}
