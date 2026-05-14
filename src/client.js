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
 *     transport, no input forwarding (master already sees the inputs
 *     since they're on the same machine), audio off.
 *   - `?join=ABCD` → Network DM remote. Opens a `WebRTCDataChannelTransport`
 *     to room ABCD via the Cloudflare-Worker signaling endpoint, then
 *     forwards input back to master over the same channel. Audio plays
 *     locally (separate device).
 *
 * Opens a ClientConnection; on ACK, syncs mode/level locally so the
 * renderer has the same scene as master, then calls `initClient` to wire
 * the RenderClient half (and, for Network DM remotes, the input forwarder).
 *
 * Disconnect handling: when master goes silent (closed, reloaded, crashed),
 * the connection's watchdog fires onLeave. We show a DISCONNECTED overlay
 * and the connection keeps sending LOOKING in the background. For Local
 * DM the overlay just waits; for Network DM the WebRTC connection is
 * already torn down by then, so the reload-on-ACK path is the only way
 * back — but that requires the user to re-scan the QR / re-enter the
 * code. Phase 8 will polish that path.
 */
export async function initClientWindow({ roomCode = null } = {}) {
    document.body.classList.add('client-window');

    // rendererState.cameras grows lazily as inbound `updateCamera` mirror
    // callbacks land — no pre-sizing needed.

    const overlay = ensureDisconnectedOverlay();

    // Network DM: open the WebRTC transport before wiring the connection.
    // The transport's `open` resolves once master's data channel is up.
    // Show the disconnected overlay until then so the user sees something
    // happening rather than a blank scene. Local DM skips this entirely
    // and falls through to the BroadcastChannel default in ClientConnection.
    let transport = null;
    if (roomCode) {
        overlay.classList.add('visible');
        // Retry a few times — master's signaling listener may be
        // mid-reconnect (network-host's transient-drop handling), or
        // the host may be just about to click Start New Game right
        // before we scan the QR. After CONNECT_RETRIES failures give
        // up and leave the overlay up so the user knows it didn't take.
        const CONNECT_RETRIES = 5;
        const CONNECT_RETRY_DELAY_MS = 2000;
        let lastErr = null;
        for (let attempt = 0; attempt < CONNECT_RETRIES; attempt++) {
            try {
                transport = await connectToNetworkRoom({ roomCode });
                overlay.classList.remove('visible');
                break;
            } catch (err) {
                lastErr = err;
                console.warn(`[client] connect attempt ${attempt + 1} failed:`, err.message ?? err);
                if (attempt < CONNECT_RETRIES - 1) {
                    await new Promise(r => setTimeout(r, CONNECT_RETRY_DELAY_MS));
                }
            }
        }
        if (!transport) {
            console.error('[client] giving up after retries:', lastErr);
            return;
        }
    }

    // Network DM remotes own a full input pipeline and ship every press
    // back to master; Local DM secondaries are display-only because
    // master already sees the same physical inputs.
    const forwardInput = roomCode != null;

    const conn = new ClientConnection({
        transport, // null for Local DM → BroadcastChannel default
        onLobbyState: (msg) => {
            // body[data-game-state] is driven by the GAME_STATE handler
            // below; this just paints the lobby UI for whichever mode
            // we're in.
            //   - Local DM: applyLobbyState updates per-pane
            //     data-claim-state from `slotsClaimed`.
            //   - Network DM: applyNetworkLobbyState mirrors the 4-row
            //     slot list from `slotOccupants`.
            // Both fields ride on the same envelope; each consumer
            // ignores the field it doesn't use.
            applyLobbyState(msg);
            if (msg.slotOccupants) applyNetworkLobbyState(msg.slotOccupants);
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
            if (payload.gameMode) applyMode(payload.gameMode, 'client');

            // Master assigns us a slot; default to 1 if it's missing
            // (e.g., older master that doesn't include slotIndex). The
            // client renders one pane for that slot — playerIndex equals
            // the slot, and the CSS "hide own billboard" rule keys off
            // the matching data-player on the pane.
            const slotIndex = payload.slotIndex ?? 1;

            // Build (or rebuild) the client's local DomRenderer at this
            // slot before loadMap, so loadMap's per-renderer iteration
            // has something to write into. Reconnect-friendly: nuke any
            // prior renderer so we start clean.
            for (const r of [...domRenderers]) destroyDomRenderer(r);
            for (let i = 0; i < orchestrator.targets.length; i++) {
                orchestrator.targets[i] = null;
            }
            const renderer = createDomRenderer(slotIndex);
            orchestrator.replaceTarget(slotIndex, renderer);

            if (payload.level) {
                await loadMap(payload.level);
            }
            // Mirror master's current game-state immediately — without
            // this the client's body attributes would lag until the
            // master's next transition. Applies via applyRemoteGameState
            // (no echo back to the channel).
            if (payload.gameState) applyRemoteGameState(payload.gameState);

            // Tell the lobby mirror which slot we represent — it'll use
            // this to pick our slot's bit out of incoming LOBBY_STATE
            // broadcasts. Replays any LOBBY_STATE that arrived during
            // onAck's await loadMap.
            setClientSlot(slotIndex);

            // forwardInput captured at boot from the roomCode presence:
            // Network DM remote (roomCode set) ships its full input
            // pipeline over the wire; Local DM secondary stays display-
            // only because master sees the same physical inputs.
            initClient(conn.channel, slotIndex, { forwardInput });
            console.log('[client] wired up at slot', slotIndex, forwardInput ? '(network)' : '(local)');
        },
        onLeave: () => {
            console.log('[client] master went silent — showing DISCONNECTED');
            overlay.classList.add('visible');
            if (roomCode) {
                // Network DM: WebRTC is gone; the existing ClientConnection's
                // LOOKING retries would talk to a dead transport. Reloading
                // re-enters the join flow (which has its own retry loop)
                // so a brief master blip recovers without user action.
                // Short delay gives the user a glimpse of the DISCONNECTED
                // overlay so reloads don't appear silent. Local DM keeps
                // the old behavior — its BroadcastChannel stays open and
                // a master reload will re-ACK.
                setTimeout(() => location.reload(), 2000);
            }
        },
    });

    startCullingLoop({
        isAttract: isAttractActive,
        getSpectatorActive: () => spectatorActive,
    });
    window.addEventListener('resize', updatePerspective);
    hideInitialOverlay();
}
