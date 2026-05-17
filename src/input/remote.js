/**
 * Master-side input source for envelopes forwarded from a remote.
 *
 * From master's perspective, the remote is just another input device —
 * exactly like keyboard, mouse, gamepad, touch — that registers an
 * analog provider with the orchestrator and emits action events on the
 * bus. The only difference is the source: instead of DOM events, the
 * input arrives over a Transport from a remote that ran its own input
 * pipeline ([../client.js](../client.js)) and shipped the results.
 *
 *   - ACTION  → re-emit on master's event bus. Master's `src/actions/*`
 *               handlers run as if the action were local.
 *   - ANALOG  → cache the latest snapshot. Master's per-frame
 *               `collectInputs` polls this via the registered input
 *               provider so movement / turn track the remote's stick.
 *
 * Slot is hardcoded to player 1 today (Local DM's only remote slot).
 * Network DM will need a per-remote receiver — the function would take
 * a slot argument and the input provider would route by that.
 */

import { registerInputProvider } from '../orchestrator.js';
import { pingActivity } from '../renderer/screens/attract.js';
import { emit } from './event-bus.js';
import { MSG } from '../transport/protocol.js';

const SECONDARY_PLAYER = 1;

// Latest analog snapshot from the remote. Returned each frame by the
// registered input provider; defaults to zeros until the first ANALOG
// envelope arrives. Mutated in place so the provider's getInput() can
// just return the object reference.
const latestAnalog = makeZeroAnalog();

function makeZeroAnalog() {
    return { moveX: 0, moveY: 0, turn: 0, turnDelta: 0, run: false };
}

/**
 * Register the input provider for the remote's slot. Called once during
 * master init regardless of whether a remote is connected — the provider
 * just contributes zeros until ANALOG envelopes arrive.
 */
export function initRemoteInput() {
    registerInputProvider(() => SECONDARY_PLAYER, () => latestAnalog);
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
        latestAnalog.moveX     = msg.moveX     || 0;
        latestAnalog.moveY     = msg.moveY     || 0;
        latestAnalog.turn      = msg.turn      || 0;
        // turnDelta is a per-tick delta — consume on read by zeroing
        // here would be wrong since the next ANALOG arrives before the
        // next frame collects inputs. Just take the latest value; if
        // updates lag a frame the worst case is a one-frame stale turn.
        latestAnalog.turnDelta = msg.turnDelta || 0;
        latestAnalog.run       = !!msg.run;
    }
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
