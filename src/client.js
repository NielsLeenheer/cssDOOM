/**
 * Client — boot routine + role coordinator for the joining window.
 *
 * Counterpart to [src/master.js](master.js). Where master is "input from
 * everything + simulation + render out to every pane," client is "open
 * a connection to master, render the slot it gives us, optionally
 * forward our local input."
 *
 * Two exported functions, each at a different level:
 *
 *   - `initClientWindow()` — the boot routine called from index.js.
 *     Opens a ClientConnection, shows the disconnected overlay, and on
 *     ACK syncs mode/level and calls `initClient` to wire the two
 *     halves below.
 *
 *   - `initClient(transport, mySlot, { forwardInput })` — the
 *     coordinator. Stands up:
 *
 *       1. Renderer in — a `RenderClient` subscribes to the Transport
 *                        and dispatches incoming renderer commands to
 *                        the local DomRenderer (for `mySlot`'s pane)
 *                        and the local orchestrator (world commands).
 *
 *       2. Input out  — the full local input pipeline (keyboard, mouse,
 *                       gamepad, touch) is initialised; every device
 *                       routes to `mySlot` via the default-slot
 *                       mechanism. A bus subscriber ships every action
 *                       event as `MSG.ACTION`; a 60Hz tick of
 *                       `orchestrator.collectInputs()` ships the per-slot
 *                       analog snapshot as `MSG.ANALOG`. Optional: the
 *                       Local DM secondary opts out (`forwardInput: false`)
 *                       because master sees its physical inputs directly
 *                       and forwarding would double-process every press.
 *
 * Both halves share the same Transport — one wire carries renderer
 * commands master→client and input envelopes client→master.
 */

import { RenderClient } from './transport/render-client.js';
import { MSG } from './transport/protocol.js';
import { ClientConnection } from './transport/peer-connection.js';
import { connectToNetworkRoom } from './transport/webrtc-transport.js';
import { orchestrator, inputs } from './orchestrator.js';
import { createDomRenderer, destroyDomRenderer, domRenderers } from './renderer/dom.js';
import { setDefaultSlot } from './input/claim-registry.js';
import { initKeyboardMouse } from './input/keyboard-mouse.js';
import { initGamepadInput } from './input/gamepad.js';
import { initTouchInput } from './input/touch.js';
import { on } from './input/event-bus.js';
import * as A from './input/actions.js';
import { startCullingLoop } from './renderer/scene/culling.js';
import { updatePerspective } from './renderer/scene/scene.js';
import { isAttractActive } from './ui/attract.js';
import { spectatorActive } from './ui/spectator.js';
import { applyMode } from './mode.js';
import { hideInitialOverlay } from './ui/overlay.js';
import { setAudioEnabled } from './audio/audio.js';
import { loadMap } from './shared/maps.js';
import { setClientSlot, applyLobbyState } from './ui/client-lobby.js';
import { applyNetworkLobbyState } from './ui/network-lobby.js';
import { showScoreboard, hideScoreboard } from './ui/scoreboard.js';
import { ensureDisconnectedOverlay } from './ui/disconnected-overlay.js';
import { applyRemoteGameState } from './game/game-state.js';
import { App } from './app.js';

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
 * @param {boolean} [options.playAudio]
 *   Defaults to `forwardInput` — a Local DM secondary sharing a room
 *   with master must stay silent to avoid echo; a Network DM remote on
 *   a separate machine plays its own audio. Override explicitly when
 *   the heuristic doesn't fit.
 */
export function initClient(transport, mySlot, {
    forwardInput = true,
    playAudio = forwardInput,
} = {}) {
    // Audio gate first — applyMode (called from onAck before this) may
    // have already called configureAudio, but with the master switch
    // off the renderer list is empty. Re-configure if needed.
    if (!playAudio) setAudioEnabled(false);

    // Renderer in.
    new RenderClient(transport, mySlot, orchestrator.target(mySlot), orchestrator);

    // Input out.
    if (forwardInput) {
        initInputForwarder(transport, mySlot);
    }

    // Tell master we're listening — master defers its spawn / initial-
    // state burst until this lands, so those world commands aren't fired
    // into a not-yet-subscribed transport.
    transport.send({ type: MSG.READY });
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

// ── Boot ───────────────────────────────────────────────────────────────

/**
 * Client window boot. Runs in any window with `?join` in the URL.
 *
 *   - `?join` with no value → Local DM secondary. BroadcastChannel
 *     transport, no input forwarding, audio off.
 *   - `?join=ABCD` → Network DM remote. WebRTC transport via the
 *     Cloudflare-Worker signaling endpoint; forwards input back to
 *     master; plays audio locally.
 *
 * L6.3 cutover: this function now constructs an App + RemoteGame,
 * mirroring master.js's App boot. RemoteGame.start owns transport
 * opening, ClientConnection setup, ACK handling, DomRenderer
 * creation, loadMap, input forwarder kickoff — all the work this
 * function used to do procedurally.
 *
 * The legacy `initClient` + `initInputForwarder` helpers above are
 * now dead code; L7 deletes them. They're kept exported for now so
 * external imports (if any) don't break.
 */
export async function initClientWindow({ roomCode = null } = {}) {
    const app = new App();
    window.app = app;
    await app.joinRemoteGame(roomCode);
}
