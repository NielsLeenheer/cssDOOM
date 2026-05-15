/**
 * RemoteGame — the client-window analog of Game.
 *
 * Same App-facing API surface (start / stop / pause / resume / on)
 * as Game, but the implementation is radically different. RemoteGame
 * owns:
 *   - the wire transport (WebRTC for Network DM, BroadcastChannel for
 *     Local DM secondary);
 *   - a RenderClient that applies inbound renderer commands;
 *   - a local input forwarder that ships gameplay actions over the
 *     wire to master.
 *
 * RemoteGame does NOT own:
 *   - a Level (no per-frame world simulation on the client);
 *   - a roster (state.players is a placeholder for this remote's
 *     own slot);
 *   - a match struct (state.match stays null);
 *   - the gameLoop's updateGame (no world step).
 *
 * See LIFECYCLE_REFACTOR.md §7b (RemoteGame API) and §12 (Network
 * coordination — the start sequence) for the target contract.
 *
 * Constructed by App.joinRemoteGame on the client window.
 */

import { RenderClient } from '../transport/render-client.js';
import { MSG } from '../transport/protocol.js';
import { ClientConnection } from '../transport/peer-connection.js';
import { connectToNetworkRoom } from '../transport/webrtc-transport.js';
import { inputs } from '../orchestrator.js';
import { createDomRenderer, destroyDomRenderer, domRenderers } from '../renderer/dom.js';
import { setDefaultSlot } from '../input/claim-registry.js';
import { initKeyboardMouse } from '../input/keyboard-mouse.js';
import { initGamepadInput } from '../input/gamepad.js';
import { initTouchInput } from '../input/touch.js';
import { on } from '../input/event-bus.js';
import * as A from '../input/actions.js';
import { startCullingLoop } from '../renderer/scene/culling.js';
import { updatePerspective } from '../renderer/scene/scene.js';
import { isAttractActive } from '../ui/attract.js';
import { spectatorActive } from '../ui/spectator.js';
import { applyMode } from '../mode.js';
import { hideInitialOverlay } from '../ui/overlay.js';
import { setAudioEnabled } from '../audio/audio.js';
import { loadMap } from '../shared/maps.js';
import { setClientSlot } from '../ui/client-lobby.js';
import { ensureDisconnectedOverlay } from '../ui/disconnected-overlay.js';
import { applyRemoteGameState } from '../game/game-state.js';

// 60Hz analog snapshot push (matches master's game loop cadence).
const ANALOG_PUSH_INTERVAL_MS = 16;

// Actions that stay LOCAL on the remote — never forwarded to master.
// MENU_TOGGLE opens the remote's own local menu; KBM_SWAP is a dev
// affordance master-side only.
const NON_FORWARDED_ACTIONS = new Set([A.MENU_TOGGLE, A.KBM_SWAP]);

// Network DM transport-open retry loop. Master may be mid-reconnect
// or briefly paused for a load when the remote scans the QR.
const CONNECT_RETRIES = 5;
const CONNECT_RETRY_DELAY_MS = 2000;

export class RemoteGame {
    constructor({ roomCode, orchestrator }) {
        this.roomCode = roomCode;
        this.orchestrator = orchestrator;

        this._state = 'CONNECTING';
        this._transport = null;
        this._connection = null;
        this._renderClient = null;
        this._overlay = null;
        this._mySlot = null;
        this._forwardInput = roomCode != null; // Network DM forwards; Local DM secondary doesn't
        this._paused = false;
        this._analogTimer = null;

        this._listeners = new Map();
    }

    /**
     * Open the transport, construct ClientConnection, set up wire
     * callbacks, start the culling RAF. The ACK callback finishes
     * the bootstrap (slot assignment, renderer creation, loadMap,
     * input forwarder kickoff).
     *
     * For Network DM (roomCode set): opens WebRTC transport with a
     * retry loop; gives up after CONNECT_RETRIES, transitioning to
     * 'FAILED'. For Local DM secondary (roomCode null): transport
     * stays null and ClientConnection falls back to its
     * BroadcastChannel default.
     */
    async start() {
        document.body.classList.add('client-window');
        // Both Local DM secondaries and Network DM remotes have
        // data-network-mode="client" + .client-window; the
        // `.network-client` class is the canonical signal for
        // Network-DM-specific UI gates (network lobby visibility,
        // applyNetworkLobbyState routing in the renderer-command
        // impl) so Local DM secondaries don't pick them up.
        if (this.roomCode) document.body.classList.add('network-client');
        this._overlay = ensureDisconnectedOverlay();

        if (this.roomCode) {
            this._overlay.classList.add('visible');
            let lastErr = null;
            for (let attempt = 0; attempt < CONNECT_RETRIES; attempt++) {
                try {
                    this._transport = await connectToNetworkRoom({ roomCode: this.roomCode });
                    this._overlay.classList.remove('visible');
                    break;
                } catch (err) {
                    lastErr = err;
                    console.warn(`[remote-game] connect attempt ${attempt + 1} failed:`, err.message ?? err);
                    if (attempt < CONNECT_RETRIES - 1) {
                        await new Promise(r => setTimeout(r, CONNECT_RETRY_DELAY_MS));
                    }
                }
            }
            if (!this._transport) {
                console.error('[remote-game] giving up after retries:', lastErr);
                this._state = 'FAILED';
                this._emit('connection-failed', { error: lastErr });
                return;
            }
        }

        this._connection = new ClientConnection({
            transport: this._transport, // null for Local DM → BroadcastChannel default
            // L6.5: LOBBY_STATE, MATCH_END, and GAME_STATE wire envelopes
            // all deleted — their content rides the renderer-command
            // pipeline (updateLobbyState, showResults, setGameState).
            // The impls live in lobby.js, client-lobby.js,
            // network-lobby.js, scoreboard.js, and game-state.js.
            onAck: (payload, isReconnect) => this._onAck(payload, isReconnect),
            onLeave: () => this._onLeave(),
            // L6.6 — coordinated in-place loadMap. Replaces the legacy
            // MSG.LEVEL_CHANGE → location.reload() flow that wiped
            // the joiner's inventory between levels. Now we rebuild
            // the scene on the existing page (so transitionToLevel
            // keeps weapons / ammo / armor) and reply with READY_TO_PLAY
            // when finished so master can proceed to PLAY.
            onLoadMap: async (msg) => {
                if (!msg?.name) return;
                try {
                    await loadMap(msg.name);
                } catch (err) {
                    console.warn('[remote-game] loadMap failed:', err);
                }
                this._connection.sendReadyToPlay();
            },
            // L6.6 — master signalled every joiner is ready. Visual
            // state continues to ride the renderer-command pipeline;
            // this hook is a placeholder for any future local PLAYING
            // flag (e.g. input gating).
            onPlay: () => {
                // No-op for now.
            },
        });

        startCullingLoop({
            isAttract: isAttractActive,
            getSpectatorActive: () => spectatorActive,
        });
        window.addEventListener('resize', updatePerspective);
        hideInitialOverlay();
    }

    /**
     * Master ACK handler. Applies the snapshot fields (gameMode,
     * level, gameState, slotIndex), rebuilds the local DomRenderer at
     * the assigned slot, loads the map, and wires up the RenderClient
     * + input forwarder. Transitions CONNECTING → CONNECTED.
     *
     * `isReconnect=true` means master came back after a drop. Simplest
     * recovery is location.reload() — clean state, fresh handshake.
     */
    async _onAck(payload, isReconnect) {
        console.log('[remote-game] master accepted, syncing', payload, isReconnect ? '(reconnect)' : '');
        if (isReconnect) {
            location.reload();
            return;
        }
        this._overlay.classList.remove('visible');
        if (payload.gameMode) applyMode(payload.gameMode, 'client');

        const slotIndex = payload.slotIndex ?? 1;
        this._mySlot = slotIndex;

        // Rebuild DomRenderer at this slot. Nuke any prior renderer
        // so reconnects start clean.
        for (const r of [...domRenderers]) destroyDomRenderer(r);
        for (let i = 0; i < this.orchestrator.targets.length; i++) {
            this.orchestrator.targets[i] = null;
        }
        const renderer = createDomRenderer(slotIndex);
        this.orchestrator.replaceTarget(slotIndex, renderer);

        if (payload.level) {
            await loadMap(payload.level);
        }
        if (payload.gameState) applyRemoteGameState(payload.gameState);
        setClientSlot(slotIndex);

        this._wireUp();

        this._state = 'CONNECTED';
        this._emit('connected', { slot: slotIndex });
    }

    /**
     * Once ACK has assigned a slot and the renderer is in place, hook
     * up the two halves of the client pipeline:
     *   - RenderClient subscribes to the transport and dispatches
     *     inbound CMD_PANE / CMD_WORLD envelopes to the local
     *     DomRenderer (per-pane) and orchestrator (world).
     *   - Input forwarder (Network DM only) initializes the local
     *     input pipeline and ships every action / analog snapshot
     *     over the wire as MSG.ACTION / MSG.ANALOG.
     * Finally sends MSG.READY so master knows our RenderClient is
     * subscribed and it's safe to fire the initial-state burst.
     */
    _wireUp() {
        // Local DM secondary shares physical audio with master, so
        // mute to avoid echo. Network DM remote on a separate machine
        // plays its own audio.
        if (!this._forwardInput) setAudioEnabled(false);

        this._renderClient = new RenderClient(
            this._connection.channel,
            this._mySlot,
            this.orchestrator.target(this._mySlot),
            this.orchestrator,
        );

        if (this._forwardInput) {
            this._initInputForwarder();
        }

        // Master defers the spawn / initial-state burst until READY
        // arrives — without this the world commands fire before our
        // RenderClient is subscribed.
        this._connection.channel.send({ type: MSG.READY });
    }

    _initInputForwarder() {
        // Every unclaimed local device routes to this remote's slot.
        setDefaultSlot(this._mySlot);

        initKeyboardMouse();
        initGamepadInput();
        initTouchInput();

        // Forward action events. The pause gate (_paused) lets
        // pause() suppress input shipping during local menu use
        // without disturbing the master.
        for (const kind of Object.values(A)) {
            if (NON_FORWARDED_ACTIONS.has(kind)) continue;
            on(kind, (event) => {
                if (this._paused) return;
                this._connection.channel.send({ type: MSG.ACTION, ...event });
            });
        }

        // 60Hz analog snapshot. Same gate.
        this._analogTimer = setInterval(() => {
            if (this._paused) return;
            this.orchestrator.collectInputs();
            const snapshot = inputs[this._mySlot];
            if (!snapshot) return;
            this._connection.channel.send({
                type: MSG.ANALOG,
                slot: this._mySlot,
                moveX: snapshot.moveX,
                moveY: snapshot.moveY,
                turn: snapshot.turn,
                turnDelta: snapshot.turnDelta,
                run: snapshot.run,
            });
        }, ANALOG_PUSH_INTERVAL_MS);
    }

    /**
     * Master went silent (closed, reloaded, crashed). Show the
     * DISCONNECTED overlay; for Network DM auto-reload after a brief
     * pause so the join flow's retry loop re-establishes (a brief
     * master blip recovers without user action). Local DM keeps the
     * existing behavior — its BroadcastChannel stays open and a
     * master reload will re-ACK.
     */
    _onLeave() {
        console.log('[remote-game] master went silent — showing DISCONNECTED');
        this._overlay?.classList.add('visible');
        this._state = 'DISCONNECTED';
        this._emit('disconnected');
        if (this.roomCode) {
            setTimeout(() => location.reload(), 2000);
        }
    }

    /**
     * Gate the local input forwarder so ACTION / ANALOG envelopes
     * stop shipping. Per §7b, RemoteGame.pause does NOT pause the
     * master's world — master keeps simulating and the visual scene
     * keeps updating. The local menu overlay handles "paused" UX on
     * the client side. (Master-initiated pause arrives as a
     * paused-state renderer command via showPaused, hooked separately.)
     */
    pause() {
        this._paused = true;
    }

    resume() {
        this._paused = false;
    }

    /**
     * Tear down the transport, stop the analog forwarder, close the
     * ClientConnection. Idempotent.
     */
    async stop() {
        if (this._state === 'DISCONNECTED' || this._state === 'FAILED') return;
        if (this._analogTimer) {
            clearInterval(this._analogTimer);
            this._analogTimer = null;
        }
        this._connection?.close?.();
        this._state = 'DISCONNECTED';
        this._emit('disconnected');
    }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
