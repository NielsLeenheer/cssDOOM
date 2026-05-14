/**
 * Connection lifecycle for master ↔ client (today: Local DM secondary
 * window via BroadcastChannel; tomorrow: Network DM remote via WebRTC).
 *
 * Master and remote share a `Transport` (see [transport.js](transport.js))
 * and a small set of envelope conventions ([protocol.js](protocol.js)'s
 * `MSG` enum), but their lifecycles are completely different:
 *
 *   - Master accepts LOOKING from any peer, replies with ACK, then keeps
 *     each link alive with PING. Tracks N peers via an internal
 *     `Map<peerKey, PeerSession>`; one session for Local DM
 *     (`peerKey='local'`), N for Network DM (one per joined remote).
 *     Pauses LOOKING acceptance during loadMap so a fast-reconnecting
 *     client doesn't ACK against a half-built scene.
 *
 *   - Client sends LOOKING on construction, retries on a timer
 *     until ACK, replies to PING with PONG, and watches for master
 *     silence to flip back to "looking" mode. Single-peer by design.
 *
 * `MasterConnection` owns no transport directly — callers supply each
 * peer's Transport via `addPeer(transport, peerKey, opts)`. For Local
 * DM, `master.js` builds a `BroadcastChannelTransport` and adds it as
 * `'local'`. For Network DM, the signaling layer will hand a fresh
 * `WebRTCDataChannelTransport` per joiner.
 *
 * `ClientConnection` is unchanged from the pre-Network-DM design — it
 * still inherits from `PeerConnectionBase`, which auto-opens a
 * BroadcastChannel. The remote-side WebRTC swap happens in Phase 6.
 */

import { BroadcastChannelTransport } from './transport.js';
import {
    BROADCAST_CHANNEL_NAME, MSG, PING_INTERVAL_MS, PING_TIMEOUT_MS,
} from './protocol.js';

/**
 * Shared infrastructure for the client side: opens the transport,
 * subscribes to incoming envelopes, registers the unload announcement,
 * and provides a safe `_post`. `ClientConnection` extends this.
 *
 * `this.channel` holds the Transport (the name is preserved because
 * `RenderClient` reaches for it as "the wire" regardless of which
 * transport implementation backs it).
 */
class PeerConnectionBase {
    /**
     * @param {object|null} transport  Optional Transport (anything with
     *   send/onMessage/close). When null, defaults to a new
     *   BroadcastChannelTransport on the shared channel — the Local DM
     *   secondary path. Network DM remotes pass in a
     *   WebRTCDataChannelTransport already opened via signaling.
     */
    constructor(transport = null) {
        this.channel = transport ?? new BroadcastChannelTransport(BROADCAST_CHANNEL_NAME);
        this.peerAlive = false;
        this.channel.onMessage((msg) => this._handle(msg));

        // Announce departure on unload so the peer can react immediately
        // instead of waiting on the watchdog.
        window.addEventListener('beforeunload', () => {
            this._post({ type: MSG.LEAVING });
        });
    }

    _post(envelope) {
        try {
            this.channel.send(envelope);
        } catch (err) {
            console.warn('PeerConnection: send failed', err);
        }
    }

    /** Subclasses implement. Called with each incoming envelope. */
    _handle(_msg) {}

    close() {
        this.channel.close();
    }
}


// ============================================================================
// Master
// ============================================================================

/**
 * Master-side connection. Manages a `Map<peerKey, PeerSession>` so the
 * same protocol works for the single Local DM secondary and for N
 * Network DM remotes simultaneously. Each peer gets its own ACK / PING
 * heartbeat / watchdog timers, independently tracked.
 *
 * Construction does not open any transport. Call `addPeer(transport,
 * peerKey, opts)` once the caller has a Transport ready (immediately
 * for Local DM, on each `onPeerConnected` callback for Network DM).
 *
 * @param {object} options
 * @param {(peerKey: string|number) => object} options.snapshotProvider
 *   Returns ACK payload (mode/level/slotIndex/...). Called per peer so the
 *   provider can allocate a distinct slot per joiner.
 * @param {(payload: object, peerKey: string|number) => void} [options.onJoin]
 *   Fires once per peer when it connects (transport is open, ACK sent).
 *   Use this for slot binding — anything that lets master's per-frame
 *   commands start flowing toward the new sink.
 * @param {(peerKey: string|number) => void} [options.onReady]
 *   Fires once per peer when it sends READY (the client's RenderClient
 *   has subscribed to the wire and won't drop incoming command envelopes).
 *   Use this for the spawn / initial-state burst that needs to land on
 *   a live, subscribed client.
 * @param {(peerKey: string|number) => void} [options.onLeave]
 *   Fires when a specific peer goes silent or disconnects.
 * @param {(msg: object, peerKey: string|number) => void} [options.onRemoteInput]
 *   Forwarded ACTION / ANALOG envelopes, tagged with the originating peer.
 */
export class MasterConnection {
    constructor({ snapshotProvider, onJoin, onReady, onLeave, onRemoteInput } = {}) {
        this.snapshotProvider = snapshotProvider;
        this.onJoin = onJoin;
        this.onReady = onReady;
        this.onLeave = onLeave;
        this.onRemoteInput = onRemoteInput;
        // While paused, master ignores LOOKING from every peer. Used
        // during loadMap so a reconnecting client doesn't ACK against a
        // half-built scene and start receiving mid-rebuild deltas.
        this.paused = false;
        this._peers = new Map(); // peerKey → PeerSession

        // Announce departure to every connected peer on unload so each
        // side can react immediately instead of waiting on its watchdog.
        this._onBeforeUnload = () => {
            for (const session of this._peers.values()) {
                try { session.transport.send({ type: MSG.LEAVING }); } catch {}
            }
        };
        window.addEventListener('beforeunload', this._onBeforeUnload);
    }

    /**
     * Register a peer's transport. Subscribes to incoming messages and
     * waits for LOOKING to flip the session alive. Idempotent on
     * duplicate peerKey (logs a warn and no-ops).
     *
     * @param {object} transport  Anything implementing the Transport interface.
     * @param {string|number} peerKey  Unique identifier. Use `'local'` for the
     *                                 Local DM secondary; the signaling
     *                                 `peerId` for each Network DM remote.
     * @param {object} [opts]
     * @param {boolean} [opts.playsAudioLocally=false]  Set true when the peer
     *   plays its own world audio on its own device (Network DM remote on its
     *   own browser). Master then suppresses its own AudioRenderer for that
     *   slot so the sound doesn't double-play. Default false matches the
     *   Local DM secondary, which calls `setAudioEnabled(false)` itself, so
     *   master is the only one playing.
     */
    addPeer(transport, peerKey, opts = {}) {
        if (this._peers.has(peerKey)) {
            console.warn('MasterConnection: peer already added', peerKey);
            return;
        }
        const session = {
            transport,
            peerKey,
            alive: false,
            ready: false,
            lastPong: 0,
            pingTimer: null,
            timeoutCheck: null,
            unsubscribe: null,
            playsAudioLocally: opts.playsAudioLocally ?? false,
        };
        session.unsubscribe = transport.onMessage((msg) => this._handle(session, msg));
        this._peers.set(peerKey, session);
    }

    /**
     * Tear down a peer's session. Fires `onLeave` if the peer had been
     * alive. Does NOT close the transport — that's the caller's job
     * (Network DM's signaling layer owns transport lifecycle; Local DM's
     * single peer lives for the lifetime of the connection).
     */
    removePeer(peerKey) {
        const session = this._peers.get(peerKey);
        if (!session) return;
        this._tearDownSession(session);
        this._peers.delete(peerKey);
    }

    /** Look up the transport for a peer — used by callers wiring RenderSinks. */
    transportFor(peerKey) {
        return this._peers.get(peerKey)?.transport ?? null;
    }

    /** Look up whether a peer expects master to play its audio locally. */
    playsAudioLocallyFor(peerKey) {
        return this._peers.get(peerKey)?.playsAudioLocally ?? false;
    }

    /** True if any peer is currently alive. Mostly for debugging / asserts. */
    get peerAlive() {
        for (const session of this._peers.values()) {
            if (session.alive) return true;
        }
        return false;
    }

    _handle(session, msg) {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === MSG.LOOKING) {
            if (this.paused) return;
            const payload = this.snapshotProvider ? this.snapshotProvider(session.peerKey) : {};
            this._postTo(session, { type: MSG.ACK, payload });
            // Re-LOOKINGs from an already-alive peer don't re-fire onJoin.
            if (!session.alive) {
                session.alive = true;
                session.lastPong = performance.now();
                this._startHeartbeat(session);
                this.onJoin?.(payload, session.peerKey);
            }
        } else if (msg.type === MSG.PONG) {
            session.lastPong = performance.now();
        } else if (msg.type === MSG.READY) {
            // Client's RenderClient is now subscribed. Only fire onReady
            // the first time per session — a reconnect re-runs onJoin
            // which will also produce a fresh READY.
            if (!session.ready) {
                session.ready = true;
                this.onReady?.(session.peerKey);
            }
        } else if (msg.type === MSG.LEAVING) {
            this._handlePeerGone(session);
        } else if (msg.type === MSG.ACTION || msg.type === MSG.ANALOG) {
            this.onRemoteInput?.(msg, session.peerKey);
        }
    }

    /**
     * Tell every alive peer the scene is about to rebuild, and pause
     * LOOKING acceptance so a reconnecting peer doesn't ACK against a
     * half-built scene. resumeAfterLevelLoad() unpauses. We pause
     * unconditionally — the next loadMap might attract a fresh client
     * mid-load even with no current peer.
     */
    signalLevelChange() {
        this.paused = true;
        for (const session of this._peers.values()) {
            if (!session.alive) continue;
            this._postTo(session, { type: MSG.LEVEL_CHANGE });
            this._handlePeerGone(session);
        }
    }

    resumeAfterLevelLoad() {
        this.paused = false;
    }

    /**
     * Broadcast a lobby-state envelope to every alive peer. Caller passes
     * `{ inLobby, slotsClaimed, slotsCarriedOver }`.
     */
    broadcastLobbyState(state) {
        const env = { type: MSG.LOBBY_STATE, ...state };
        this._broadcast(env);
    }

    /** Broadcast the end-of-match scoreboard to every alive peer. */
    broadcastMatchEnd(payload) {
        const env = { type: MSG.MATCH_END, ...payload };
        this._broadcast(env);
    }

    /** Broadcast a game-state transition to every alive peer. */
    broadcastGameState(state) {
        this._broadcast({ type: MSG.GAME_STATE, state });
    }

    _broadcast(envelope) {
        for (const session of this._peers.values()) {
            if (session.alive) this._postTo(session, envelope);
        }
    }

    _postTo(session, envelope) {
        try {
            session.transport.send(envelope);
        } catch (err) {
            console.warn('MasterConnection: send failed', err);
        }
    }

    _startHeartbeat(session) {
        if (session.pingTimer) return;
        session.pingTimer = setInterval(() => {
            this._postTo(session, { type: MSG.PING, t: performance.now() });
        }, PING_INTERVAL_MS);
        session.timeoutCheck = setInterval(() => {
            if (session.alive && performance.now() - session.lastPong > PING_TIMEOUT_MS) {
                this._handlePeerGone(session);
            }
        }, PING_INTERVAL_MS);
    }

    _stopHeartbeat(session) {
        if (session.pingTimer) { clearInterval(session.pingTimer); session.pingTimer = null; }
        if (session.timeoutCheck) { clearInterval(session.timeoutCheck); session.timeoutCheck = null; }
    }

    _handlePeerGone(session) {
        if (!session.alive) return;
        session.alive = false;
        this._stopHeartbeat(session);
        this.onLeave?.(session.peerKey);
    }

    _tearDownSession(session) {
        this._stopHeartbeat(session);
        if (session.unsubscribe) { session.unsubscribe(); session.unsubscribe = null; }
        if (session.alive) {
            session.alive = false;
            this.onLeave?.(session.peerKey);
        }
    }

    close() {
        window.removeEventListener('beforeunload', this._onBeforeUnload);
        for (const session of this._peers.values()) {
            this._tearDownSession(session);
        }
        this._peers.clear();
    }
}


// ============================================================================
// Client
// ============================================================================

/**
 * Client-side connection (Local DM secondary OR Network DM remote).
 * Repeatedly sends LOOKING on construction (and again after master
 * goes silent), finalizes setup on ACK via `onAck`, replies to PING
 * with PONG, and watches for master silence.
 *
 * @param {object} options
 * @param {(payload: object, isReconnect: boolean) => void} [options.onAck]
 *   Fires when master accepts. `isReconnect` is true if we'd previously
 *   been connected (covering the master-restart case).
 * @param {() => void} [options.onLeave]      Master went silent.
 * @param {(msg: object) => void} [options.onLobbyState]  LOBBY_STATE envelope arrived.
 * @param {(msg: object) => void} [options.onMatchEnd]    MATCH_END envelope arrived.
 * @param {(msg: object) => void} [options.onGameState]   GAME_STATE envelope arrived.
 */
export class ClientConnection extends PeerConnectionBase {
    constructor({ transport = null, onAck, onLeave, onLobbyState, onMatchEnd, onGameState } = {}) {
        super(transport);
        this.onAck = onAck;
        this.onLeave = onLeave;
        this.onLobbyState = onLobbyState;
        this.onMatchEnd = onMatchEnd;
        this.onGameState = onGameState;
        this.lastFromMaster = 0;
        this._lookingTimer = null;
        this._timeoutCheck = null;
        this._everConnected = false;
        this._startLooking();
    }

    _handle(msg) {
        if (!msg || typeof msg !== 'object') return;
        // Anything from master counts as proof of life.
        this.lastFromMaster = performance.now();
        const wasAlive = this.peerAlive;

        if (msg.type === MSG.ACK) {
            this.peerAlive = true;
            if (this._lookingTimer) {
                clearInterval(this._lookingTimer);
                this._lookingTimer = null;
            }
            if (!this._timeoutCheck) this._startWatchdog();
            this.onAck?.(msg.payload ?? {}, /* isReconnect */ !wasAlive && this._everConnected);
            this._everConnected = true;
        } else if (msg.type === MSG.PING) {
            this._post({ type: MSG.PONG, t: msg.t });
            this.peerAlive = true;
            if (!this._timeoutCheck) this._startWatchdog();
        } else if (msg.type === MSG.LEAVING) {
            this._handlePeerGone();
        } else if (msg.type === MSG.LEVEL_CHANGE) {
            // Master is about to rebuild its scene. Reload so the next
            // reconnect happens against the master's settled new state.
            location.reload();
        } else if (msg.type === MSG.LOBBY_STATE) {
            this.onLobbyState?.(msg);
        } else if (msg.type === MSG.MATCH_END) {
            this.onMatchEnd?.(msg);
        } else if (msg.type === MSG.GAME_STATE) {
            this.onGameState?.(msg);
        }
    }

    /** Send LOOKING repeatedly until master responds with ACK. */
    _startLooking() {
        if (this._lookingTimer) return;
        this._post({ type: MSG.LOOKING });
        this._lookingTimer = setInterval(() => {
            if (this.peerAlive) {
                clearInterval(this._lookingTimer);
                this._lookingTimer = null;
                return;
            }
            this._post({ type: MSG.LOOKING });
        }, PING_INTERVAL_MS * 2);
    }

    /** Watch for master silence; treat as gone after PING_TIMEOUT_MS. */
    _startWatchdog() {
        if (this._timeoutCheck) return;
        this._timeoutCheck = setInterval(() => {
            if (this.peerAlive && performance.now() - this.lastFromMaster > PING_TIMEOUT_MS) {
                this._handlePeerGone();
            }
        }, PING_INTERVAL_MS);
    }

    _handlePeerGone() {
        if (!this.peerAlive) return;
        this.peerAlive = false;
        // Stop watching; we'll restart the watchdog when ACK comes back.
        if (this._timeoutCheck) { clearInterval(this._timeoutCheck); this._timeoutCheck = null; }
        // Resume looking for master.
        this._startLooking();
        this.onLeave?.();
    }

    close() {
        if (this._lookingTimer) { clearInterval(this._lookingTimer); this._lookingTimer = null; }
        if (this._timeoutCheck) { clearInterval(this._timeoutCheck); this._timeoutCheck = null; }
        super.close();
    }
}
