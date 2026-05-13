/**
 * Client — the remote-side coordinator, peer to `src/orchestrator.js`.
 *
 * Lives at the top of `src/` because, like the orchestrator, it's a
 * runtime-role choice (master vs client) rather than a layer concept.
 * Master's `initMaster()` stands up the orchestrator + gameloop +
 * broadcast wiring; a remote's `initClient(transport, mySlot)` stands
 * up the two halves a remote needs:
 *
 *   1. Renderer in   — a `RenderClient` subscribes to the Transport and
 *                      dispatches incoming renderer commands to the
 *                      local DomRenderer (for `mySlot`'s pane) and the
 *                      local orchestrator (for world commands).
 *
 *   2. Input out     — the full local input pipeline (keyboard, mouse,
 *                      gamepad, touch) is initialised; every device
 *                      routes to `mySlot` via the default-slot
 *                      mechanism. A bus subscriber ships every action
 *                      event as `MSG.ACTION`; a 60Hz tick of
 *                      `orchestrator.collectInputs()` ships the per-slot
 *                      analog snapshot as `MSG.ANALOG`. Optional: the
 *                      The Local DM secondary opts out (`forwardInput: false`)
 *                      because master sees its physical inputs directly
 *                      and forwarding would double-process every press.
 *
 * Both halves share the same Transport — one wire carries renderer
 * commands master→remote and input envelopes remote→master.
 */

import { RenderClient } from './transport/render-client.js';
import { MSG } from './transport/protocol.js';
import { orchestrator, inputs } from './orchestrator.js';
import { setDefaultSlot } from './input/claim-registry.js';
import { initKeyboardMouse } from './input/keyboard-mouse.js';
import { initGamepadInput } from './input/gamepad.js';
import { initTouchInput } from './input/touch.js';
import { on } from './input/event-bus.js';
import * as A from './input/actions.js';

// How often to push analog snapshots. 60 Hz matches master's game loop;
// a one-frame stale snapshot is fine so we don't need sub-frame cadence.
const ANALOG_PUSH_INTERVAL_MS = 16;

// Actions that stay LOCAL on the remote — never forwarded to master.
//   MENU_TOGGLE: Escape opens the remote's own local menu (disconnect,
//                volume) rather than pausing master's game for everyone.
//   KBM_SWAP:    Tab is a dev-only two-keyboards affordance, master-local.
const NON_FORWARDED_ACTIONS = new Set([A.MENU_TOGGLE, A.KBM_SWAP]);

/**
 * @param {{send: (msg: object) => void,
 *          onMessage: (cb: (msg: object) => void) => () => void}} transport
 * @param {number} mySlot                Player slot this remote drives.
 * @param {object} [options]
 * @param {boolean} [options.forwardInput=true]
 *   Set to false for the Local DM secondary, where master sees the same
 *   physical inputs and forwarding would double-process every press.
 */
export function initClient(transport, mySlot, { forwardInput = true } = {}) {
    // Renderer in.
    new RenderClient(transport, mySlot, orchestrator.target(mySlot), orchestrator);

    // Input out.
    if (forwardInput) {
        initInputForwarder(transport, mySlot);
    }
}

function initInputForwarder(transport, mySlot) {
    // Every unclaimed local device routes to this remote's slot — same
    // pattern SP uses (defaultSlot=0). No press-to-claim ceremony on a
    // remote: the device IS the remote, and the remote IS one slot.
    setDefaultSlot(mySlot);

    // Wire the standard input modules. They emit on the local bus and
    // register their analog contribution with the local orchestrator —
    // exactly the same as a local SP install. Touch is a no-op on
    // non-touch devices (initTouchInput's own guard).
    initKeyboardMouse();
    initGamepadInput();
    initTouchInput();

    // Forward every action emitted on the local bus. The remote doesn't
    // call initActions(), so the forwarder is the only subscriber for
    // most kinds — MENU_TOGGLE / KBM_SWAP are filtered so they stay
    // local for whatever the remote's UI wants to do with them.
    for (const kind of Object.values(A)) {
        if (NON_FORWARDED_ACTIONS.has(kind)) continue;
        on(kind, (event) => {
            transport.send({ type: MSG.ACTION, ...event });
        });
    }

    // Tick the orchestrator's input collection at game-loop cadence and
    // forward the resulting per-slot analog snapshot. This is exactly
    // what master's game loop does locally — we just ship the result
    // instead of consuming it.
    setInterval(() => {
        orchestrator.collectInputs();
        const snapshot = inputs[mySlot];
        if (!snapshot) return;
        transport.send({
            type: MSG.ANALOG,
            slot: mySlot,
            moveX: snapshot.moveX,
            moveY: snapshot.moveY,
            turn: snapshot.turn,
            turnDelta: snapshot.turnDelta,
            run: snapshot.run,
        });
    }, ANALOG_PUSH_INTERVAL_MS);
}
