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
 * Constructed by App.joinRemoteGame on the client window.
 */

import { RenderClient } from '../transport/render-client.js';
import { MSG } from '../transport/protocol.js';
import { ClientConnection } from '../transport/peer-connection.js';
import { connectToNetworkRoom } from '../transport/webrtc-transport.js';
import { inputs } from '../orchestrator.js';
import { rendererManager } from '../renderer/renderer-manager.js';
import { setDefaultSlot } from '../input/claim-registry.js';
import { initKeyboardMouse } from '../input/keyboard-mouse.js';
import { initGamepadInput } from '../input/gamepad.js';
import { initTouchInput } from '../input/touch.js';
import { on } from '../input/event-bus.js';
import * as A from '../input/actions.js';
import { isAttractActive } from './attract.js';
import { spectatorActive } from '../ui/spectator.js';
import { applyMode } from '../mode.js';
import { hideInitialOverlay, setLoadingStatus } from '../ui/initial-splash.js';
import { ensureDisconnectedOverlay } from '../ui/disconnected-overlay.js';
import { applyCatchupCmds } from '../game/catchup.js';

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

/**
 * Pick the splash text for a terminal join failure. Worker refusals
 * (`room-full`, `room-not-found`) carry a stable code on the thrown
 * error — surface those specifically so the user sees why they can't
 * join. Anything else falls back to the generic check-the-code prompt
 * since the actual cause (ICE failure, dropped signaling, etc.) isn't
 * actionable in a splash-text message.
 */
function messageForFailure(err, roomCode) {
    if (err?.code === 'room-full') {
        return `ROOM ${roomCode} IS FULL`;
    }
    if (err?.code === 'room-not-found') {
        return `ROOM ${roomCode} NOT FOUND`;
    }
    if (err?.code === 'replaced') {
        return `DISCONNECTED\nGAME CONTINUED IN NEW WINDOW`;
    }
    return `CONNECTION FAILED\nCHECK ROOM CODE AND TRY AGAIN`;
}

export class RemoteGame {
    constructor({ roomCode, cid = null, orchestrator }) {
        // Normalize to uppercase so the splash text matches what the
        // transport actually sends (uppercased there too). A user
        // typing ?join=abcd would otherwise see "CONNECTING TO ROOM
        // abcd" while the WS resolves against `ABCD`.
        this.roomCode = roomCode ? roomCode.toUpperCase() : roomCode;
        // URL-derived stable identity. Sent with every LOOKING so a
        // refreshing joiner reattaches to the same slot. null for
        // Local DM secondary (peer identity is 'local' there).
        this.cid = cid;
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
        // Body classes (`client-window`, `network-client`) are set in
        // initClientWindow before this runs — assert rather than write
        // so a future caller that bypasses the entry script surfaces
        // the mistake instead of silently breaking CSS layout.
        console.assert(
            document.body.classList.contains('client-window'),
            '[remote-game] expected body.client-window — set in initClientWindow',
        );
        console.assert(
            !this.roomCode || document.body.classList.contains('network-client'),
            '[remote-game] expected body.network-client for Network DM joiner',
        );
        // Mid-session disconnect uses this overlay (red banner over a
        // built scene). The initial-connect status, by contrast, paints
        // inside the still-visible #loading-overlay via setLoadingStatus
        // so the user sees what's happening under the DOOM logo
        // (loading-overlay sits at z-index 10000, above this red banner).
        this._overlay = ensureDisconnectedOverlay();

        if (this.roomCode) {
            setLoadingStatus(`CONNECTING TO ROOM ${this.roomCode}`);
            let lastErr = null;
            for (let attempt = 0; attempt < CONNECT_RETRIES; attempt++) {
                try {
                    this._transport = await connectToNetworkRoom({ roomCode: this.roomCode });
                    break;
                } catch (err) {
                    lastErr = err;
                    console.warn(`[remote-game] connect attempt ${attempt + 1} failed:`, err.message ?? err);
                    // `room-full` is terminal — the room exists, all
                    // seats are taken, retrying won't change that until
                    // someone leaves. `room-not-found` IS transient,
                    // though: when the host refreshes mid-session the
                    // worker's Durable Object briefly forgets the room
                    // until the new host page reopens its WS. Retry
                    // through the normal window so connected joiners
                    // can recover from a host reload; a genuine wrong
                    // code just falls through to the same terminal
                    // splash after the retries exhaust.
                    if (err?.code === 'room-full') break;
                    if (attempt < CONNECT_RETRIES - 1) {
                        // First couple of attempts are normal — a host
                        // refresh or signaling blip resolves inside
                        // ~4s, so don't alarm the user with "CONNECTION
                        // FAILED" yet. Only escalate once we're past
                        // the silent retry window.
                        if (attempt >= 1) {
                            setLoadingStatus('CONNECTION FAILED\nRETRYING...');
                        }
                        await new Promise(r => setTimeout(r, CONNECT_RETRY_DELAY_MS));
                    }
                }
            }
            if (!this._transport) {
                console.error('[remote-game] giving up after retries:', lastErr);
                setLoadingStatus(messageForFailure(lastErr, this.roomCode));
                this._setState('FAILED');
                this._emit('connection-failed', { error: lastErr });
                this._emit('game-ended', { reason: 'connect-failed' });
                return;
            }
            setLoadingStatus('WAITING FOR HOST');
        }

        this._connection = new ClientConnection({
            transport: this._transport, // null for Local DM → BroadcastChannel default
            // Stable identity sent on every LOOKING so master can
            // reattach us to the same slot across a hard refresh
            // (URL preserves ?cid=, signaling peerId churns).
            cid: this.cid,
            // Lobby / match-end / overlay updates ride the
            // renderer-command pipeline (showLobby, showResults,
            // showAttract, etc.). Impls live in renderer/screens/.
            // Game state (game-state.js) is master-local now — the
            // joiner doesn't sync or read it.
            //
            // Coordinated in-place loadMap rides `cmd-world loadMap`
            // through RenderClient — see render-client.js for the
            // special-case that calls `orchestrator.loadMap(name)`
            // on the joiner and posts MSG.READY_TO_PLAY once the
            // local scene rebuild resolves.
            onAck: (payload, isReconnect) => this._onAck(payload, isReconnect),
            onLeave: () => this._onLeave(),
            // Master signalled every joiner is ready. Visual state
            // continues to ride the renderer-command pipeline; this
            // hook is a placeholder for a future local PLAYING flag.
            onPlay: () => {
                // No-op for now.
            },
            // Apply the catchup envelope against our local
            // DomRenderer directly — both world and per-pane impls
            // are auto-bound onto DomRenderer.prototype by
            // renderer/commands.js. Bypassing the orchestrator
            // sidesteps its per-pane dispatch signature (which
            // prefixes playerIndex), and the AudioRenderer's
            // listener position lands on the next gameLoop frame's
            // updateCamera anyway.
            onCatchup: (cmds) => {
                const renderer = this.orchestrator.findTarget(this._mySlot, 'dom');
                applyCatchupCmds(renderer, cmds);
            },
            // Master refused the join (typically no remote slot
            // available — kiosk DM full). Show the reason, tear down
            // the transport, transition to FAILED. No retry — the
            // refusal is terminal until a remote leaves.
            onRefused: (reason) => this._onRefused(reason),
            // Master saw the LOOKING but isn't ready to seat us yet
            // (mid-match). Show a waiting message; ClientConnection's
            // LOOKING retry keeps polling. Once master returns to
            // LOBBY the next retry gets ACK and _onAck runs normally.
            onWait: () => setLoadingStatus('WAITING FOR CURRENT GAME TO END'),
        });

        rendererManager.startCullingLoop({
            isAttract: isAttractActive,
            getSpectatorActive: () => spectatorActive,
        });
        // Splash stays up until _onAck finishes building the scene —
        // see the hideInitialOverlay() call at the end of _onAck.
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

        // Joiner has exactly one local renderer at the master-assigned
        // slot. resetToJoinerSlot tears down any pre-existing renderers,
        // clears every orchestrator target, then creates + installs a
        // fresh one — all through the Manager + Orchestrator's clean
        // APIs (no reaching past either's surface).
        rendererManager.resetToJoinerSlot(slotIndex);

        // One local audio listener at the master-assigned slot. applyMode
        // skipped this because the slot wasn't known yet, AND
        // resetToJoinerSlot just cleared every target — so this is the
        // first time the joiner has any AudioRenderers. The listener's
        // playerIndex matches the slot master sends updateCamera /
        // playSound under, so the per-pane dispatch lands on it
        // naturally.
        this.orchestrator.configureAudio([slotIndex]);

        if (payload.level) {
            // Initial-bootstrap load — goes through the same per-window
            // pipeline as subsequent coordinated loads (orchestrator
            // fans to the joiner's local DomRenderer → scene.loadMap).
            // No READY_TO_PLAY here: ACK is not part of the coordinated
            // handshake. MSG.READY (sent from _wireUp below) is the
            // bootstrap-finished signal master gates the spawn / initial
            // state burst on.
            await this.orchestrator.loadMap(payload.level);
        }

        this._wireUp();

        // Scene is built, RenderClient is subscribed — safe to reveal
        // the pane behind the splash. Done HERE (after loadMap awaits)
        // rather than synchronously after transport-open in start() so
        // a master-side MSG.REFUSED arriving instead of ACK never has
        // to chase the splash back up: the splash simply stays visible
        // through the failure and _onRefused just paints over it.
        hideInitialOverlay();

        this._setState('CONNECTED');
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
        if (!this._forwardInput) this.orchestrator.setAudioEnabled(false);

        this._renderClient = new RenderClient(
            this._connection.channel,
            this._mySlot,
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

        // 60Hz analog snapshot. moveX/moveY/turn/run are persistent
        // state on the receiver (latestAnalog is overwritten in place,
        // not consumed), so if the snapshot is identical to the last
        // one we sent the receiver already holds those values — the
        // envelope is pure noise. turnDelta is a per-tick delta that
        // master applies on read, so when it's non-zero we MUST send
        // every tick or the rotation is lost. Dedup gate: skip iff
        // turnDelta is 0 AND every field matches the last sent
        // envelope. The transition "stops turning" (last had non-zero
        // turnDelta, this one has 0) goes through because the
        // envelopes differ — that single send overwrites the
        // receiver's stale turnDelta to 0.
        const lastSent = { moveX: NaN, moveY: NaN, turn: NaN, turnDelta: NaN, run: null };
        this._analogTimer = setInterval(() => {
            if (this._paused) return;
            this.orchestrator.collectInputs();
            const snapshot = inputs[this._mySlot];
            if (!snapshot) return;
            const isDuplicateIdle = snapshot.turnDelta === 0
                && snapshot.moveX     === lastSent.moveX
                && snapshot.moveY     === lastSent.moveY
                && snapshot.turn      === lastSent.turn
                && lastSent.turnDelta === 0
                && snapshot.run       === lastSent.run;
            if (isDuplicateIdle) return;
            lastSent.moveX     = snapshot.moveX;
            lastSent.moveY     = snapshot.moveY;
            lastSent.turn      = snapshot.turn;
            lastSent.turnDelta = snapshot.turnDelta;
            lastSent.run       = snapshot.run;
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
        this._setState('DISCONNECTED');
        this._emit('disconnected');
        this._emit('game-ended', { reason: 'master-silent' });
        if (this.roomCode) {
            setTimeout(() => location.reload(), 2000);
        }
    }

    /**
     * Master terminally refused the join (no slot available). Drop the
     * transport, show the reason on the splash, and transition to
     * FAILED. No auto-reload — the refusal isn't transient, so retrying
     * would just re-trigger the refusal in a loop.
     */
    _onRefused(reason) {
        console.log('[remote-game] master refused:', reason);
        // Splash is still up — _onAck (which would have hidden it)
        // never ran. Just repaint the status text over it.
        setLoadingStatus(messageForFailure({ code: reason }, this.roomCode));
        try { this._transport?.close(); } catch {}
        this._transport = null;
        this._connection?.close?.();
        this._setState('FAILED');
        this._emit('connection-failed', { reason });
        this._emit('game-ended', { reason: 'refused' });
    }

    /**
     * Gate the local input forwarder so ACTION / ANALOG envelopes
     * stop shipping, and tint the local pane via the paused renderer
     * command. Does NOT pause the master's world — master keeps
     * simulating and the visual scene keeps updating. Master-initiated
     * pause arrives as the same showPaused command over the wire
     * (from Game.pause) so the visual is symmetric whether the
     * joiner or the host opened the menu.
     */
    pause() {
        this._paused = true;
        if (this._mySlot != null) this.orchestrator.showPaused(this._mySlot);
    }

    resume() {
        this._paused = false;
        if (this._mySlot != null) this.orchestrator.hidePaused(this._mySlot);
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
        this._setState('DISCONNECTED');
        this._emit('disconnected');
        this._emit('game-ended', { reason: 'stop' });
    }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    /**
     * State transition with state-changed emit. Use instead of writing
     * `this._state = …` directly so subscribers stay in sync.
     */
    _setState(next) {
        const from = this._state;
        if (from === next) return;
        this._state = next;
        this._emit('state-changed', { from, to: next });
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
