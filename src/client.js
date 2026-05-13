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
import { orchestrator, inputs } from './orchestrator.js';
import { setDefaultSlot } from './input/claim-registry.js';
import { initKeyboardMouse } from './input/keyboard-mouse.js';
import { initGamepadInput } from './input/gamepad.js';
import { initTouchInput } from './input/touch.js';
import { on } from './input/event-bus.js';
import * as A from './input/actions.js';
import { sceneStates } from './renderer/dom.js';
import { startCullingLoop } from './renderer/scene/culling.js';
import { updatePerspective } from './renderer/scene/scene.js';
import { isAttractActive } from './ui/attract.js';
import { spectatorActive } from './ui/spectator.js';
import { initClientRendererState } from './renderer/renderer-state.js';
import { applyMode } from './ui/menu.js';
import { hideInitialOverlay } from './ui/overlay.js';
import { loadMap } from './shared/maps.js';
import { setClientSlot, applyLobbyState } from './ui/client-lobby.js';
import { showScoreboard, hideScoreboard } from './ui/scoreboard.js';
import { ensureDisconnectedOverlay } from './ui/disconnected-overlay.js';
import { applyRemoteGameState } from './game/game-state.js';

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

// ── Boot ───────────────────────────────────────────────────────────────

/**
 * Client window boot. Runs in any window with `?join` in the URL —
 * a Local DM secondary today, a Network DM remote tomorrow. Opens a
 * ClientConnection; on ACK, syncs mode/level locally so the renderer
 * has the same scene as master, then calls `initClient` to wire the
 * RenderClient half (and, for Network DM remotes, the input forwarder).
 *
 * Disconnect handling: when master goes silent (closed, reloaded, crashed),
 * the connection's watchdog fires onLeave. We show a DISCONNECTED overlay
 * and the connection keeps sending LOOKING in the background. If a master
 * comes back, the simplest correct behavior is to reload this window —
 * any deltas that flowed through during the original session left the
 * scene out of sync with whatever the new master starts at.
 */
export async function initClientWindow() {
    document.body.classList.add('client-window');

    // Stand up the renderer-state arrays sized for the client's two-pane
    // DOM. The mirror callbacks (declared in commands.js) populate them as
    // updates flow in from master; until then they sit at spawn-default zeros.
    initClientRendererState(sceneStates.length);

    const overlay = ensureDisconnectedOverlay();

    const conn = new ClientConnection({
        onLobbyState: (msg) => {
            // Per-pane claim-state mirror only — body[data-game-state]
            // is driven by the GAME_STATE handler below.
            applyLobbyState(msg);
        },
        onMatchEnd: (msg) => {
            // body[data-game-state] is driven by GAME_STATE; this
            // handler just paints the scoreboard DOM from the payload.
            showScoreboard(msg);
        },
        onGameState: ({ state }) => {
            // Mirror master's game-state machine — applyRemoteGameState
            // writes body[data-game-state]. We also clear the scoreboard
            // when leaving ENDED so a rematch doesn't keep the old DOM
            // behind the dim overlay.
            const wasEnded = document.body.dataset.gameState === 'ended';
            applyRemoteGameState(state);
            if (wasEnded && state !== 'ended') hideScoreboard();
        },
        onAck: async (payload, isReconnect) => {
            console.log('[broadcast] master accepted, syncing', payload, isReconnect ? '(reconnect)' : '');
            if (isReconnect) {
                // Master came back after a disconnect. The simplest way to
                // guarantee a consistent scene is to reload — clean local
                // state, run the join handshake again from scratch.
                location.reload();
                return;
            }
            overlay.classList.remove('visible');
            if (payload.mode) applyMode(payload.mode);
            if (payload.level) {
                await loadMap(payload.level);
            }
            // Mirror master's current game-state immediately — without
            // this the client's body attributes would lag until the
            // master's next transition. Applies via applyRemoteGameState
            // (no echo back to the channel).
            if (payload.gameState) applyRemoteGameState(payload.gameState);

            // Master assigns us a slot; default to 1 if it's missing
            // (e.g., older master that doesn't include slotIndex). The
            // local DomRenderer always paints to pane 1 of the client's
            // HTML; the data-player attribute is set to match the slot
            // so the "hide own billboard" CSS keys correctly even if the
            // assigned slot isn't 1.
            const slotIndex = payload.slotIndex ?? 1;
            const visiblePane = document.querySelectorAll('.pane')[1];
            if (visiblePane) visiblePane.dataset.player = String(slotIndex);

            // Tell the lobby mirror which slot we represent — it'll use
            // this to pick our slot's bit out of incoming LOBBY_STATE
            // broadcasts. Replays any LOBBY_STATE that arrived during
            // onAck's await loadMap.
            setClientSlot(slotIndex);

            // Local DM secondary is display-only: master sees the same
            // physical inputs directly and forwarding would double-
            // process every press. Network DM remotes drop the flag and
            // get the full input pipeline shipped over the wire.
            initClient(conn.channel, slotIndex, { forwardInput: false });
            console.log('[broadcast] client wired up at slot', slotIndex);
        },
        onLeave: () => {
            console.log('[broadcast] master went silent — showing DISCONNECTED');
            overlay.classList.add('visible');
        },
    });

    startCullingLoop({
        isAttract: isAttractActive,
        getSpectatorActive: () => spectatorActive,
    });
    window.addEventListener('resize', updatePerspective);
    hideInitialOverlay();
}
