/**
 * Connection lifecycle for master ↔ remote (today: secondary window via
 * BroadcastChannel; tomorrow: network peer via WebRTC).
 *
 * Master and remote share a `Transport` (see [transport.js](transport.js))
 * and a small set of envelope conventions (`./broadcast-protocol.js`'s
 * `MSG` enum), but their lifecycles are completely different:
 *
 *   - Master accepts LOOKING, replies with ACK, then keeps the link
 *     alive with PING. Tracks one peer at a time. Pauses LOOKING
 *     acceptance during loadMap so a fast-reconnecting secondary
 *     doesn't ACK against a half-built scene.
 *
 *   - Secondary sends LOOKING on construction, retries on a timer
 *     until ACK, replies to PING with PONG, and watches for master
 *     silence to flip back to "looking" mode.
 *
 * To keep each role's logic readable we use two classes
 * (`MasterConnection`, `SecondaryConnection`) sharing the tiny
 * `BroadcastConnectionBase` for transport + post + unload + close. The
 * per-pane and world renderer commands flow through `BroadcastSink` /
 * `BroadcastClient`, which share the same Transport via the
 * `.channel` accessor here.
 */

import { BroadcastChannelTransport } from './transport.js';
import {
    BROADCAST_CHANNEL_NAME, MSG, PING_INTERVAL_MS, PING_TIMEOUT_MS,
} from './broadcast-protocol.js';

/**
 * Shared infrastructure: opens the transport, subscribes to incoming
 * envelopes, registers the unload announcement, and provides a safe
 * `_post`. Subclasses override `_handle(msg)` to dispatch role-specific
 * behavior.
 *
 * `this.channel` holds the Transport (not a raw BroadcastChannel — the
 * name is preserved because sinks and clients still treat it as "the
 * wire" regardless of which transport backs it).
 */
class BroadcastConnectionBase {
    constructor() {
        this.channel = new BroadcastChannelTransport(BROADCAST_CHANNEL_NAME);
        this.peerAlive = false;
        this.channel.onMessage((msg) => this._handle(msg));

        // Both sides announce departure on unload so the peer can react
        // immediately instead of waiting on the watchdog.
        window.addEventListener('beforeunload', () => {
            this._post({ type: MSG.LEAVING });
        });
    }

    _post(envelope) {
        try {
            this.channel.send(envelope);
        } catch (err) {
            console.warn('BroadcastConnection: send failed', err);
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
 * Master-side connection. Replies to a secondary's LOOKING with ACK,
 * pings on a heartbeat, and reports the secondary's lifecycle via the
 * `onJoin` / `onLeave` callbacks so the application can swap render
 * targets between a local DomRenderer and a BroadcastSink.
 *
 * @param {object} options
 * @param {() => object} options.snapshotProvider Returns ACK payload (mode/level/slot).
 * @param {(payload: object) => void} [options.onJoin]    Fires once when a secondary connects.
 * @param {() => void}                [options.onLeave]   Fires when the secondary goes silent.
 * @param {(msg: object) => void}     [options.onRemoteInput] Forwarded INPUT envelopes.
 */
export class MasterConnection extends BroadcastConnectionBase {
    constructor({ snapshotProvider, onJoin, onLeave, onRemoteInput } = {}) {
        super();
        this.snapshotProvider = snapshotProvider;
        this.onJoin = onJoin;
        this.onLeave = onLeave;
        this.onRemoteInput = onRemoteInput;
        // While paused, master ignores LOOKING. Used during loadMap so a
        // reconnecting secondary doesn't ACK against a half-built scene
        // and start receiving mid-rebuild deltas.
        this.paused = false;
        this.lastPong = 0;
        this._pingTimer = null;
        this._timeoutCheck = null;
    }

    _handle(msg) {
        if (!msg || typeof msg !== 'object') return;

        if (msg.type === MSG.LOOKING) {
            if (this.paused) return;
            const payload = this.snapshotProvider ? this.snapshotProvider() : {};
            this._post({ type: MSG.ACK, payload });
            // Re-LOOKINGs from an already-connected peer don't re-fire onJoin.
            if (!this.peerAlive) {
                this.peerAlive = true;
                this.lastPong = performance.now();
                this._startHeartbeat();
                this.onJoin?.(payload);
            }
        } else if (msg.type === MSG.PONG) {
            this.lastPong = performance.now();
        } else if (msg.type === MSG.LEAVING) {
            this._handlePeerGone();
        } else if (msg.type === MSG.INPUT) {
            this.onRemoteInput?.(msg);
        }
    }

    /**
     * Tell the connected secondary the scene is about to rebuild, and
     * pause LOOKING acceptance so a reconnecting peer doesn't ACK
     * against a half-built scene. resumeAfterLevelLoad() unpauses. We
     * pause unconditionally — the next loadMap might attract a fresh
     * secondary mid-load even with no current peer.
     */
    signalLevelChange() {
        this.paused = true;
        if (this.peerAlive) {
            this._post({ type: MSG.LEVEL_CHANGE });
            this._handlePeerGone();
        }
    }

    resumeAfterLevelLoad() {
        this.paused = false;
    }

    /**
     * Broadcast a lobby-state envelope. Caller passes
     * `{ inLobby, slotsClaimed, slotsCarriedOver }`; secondary mirrors
     * it onto its own DOM. No-op when no peer is alive.
     */
    broadcastLobbyState(state) {
        if (!this.peerAlive) return;
        this._post({ type: MSG.LOBBY_STATE, ...state });
    }

    /**
     * Broadcast the end-of-match scoreboard. Payload mirrors what
     * scoreboard.js's renderer expects so the secondary hands it
     * straight through.
     */
    broadcastMatchEnd(payload) {
        if (!this.peerAlive) return;
        this._post({ type: MSG.MATCH_END, ...payload });
    }

    /**
     * Broadcast a game-state transition. The secondary mirrors via
     * `applyRemoteGameState` so its CSS body attributes track ours.
     */
    broadcastGameState(state) {
        if (!this.peerAlive) return;
        this._post({ type: MSG.GAME_STATE, state });
    }

    _startHeartbeat() {
        if (this._pingTimer) return;
        this._pingTimer = setInterval(() => {
            this._post({ type: MSG.PING, t: performance.now() });
        }, PING_INTERVAL_MS);
        this._timeoutCheck = setInterval(() => {
            if (this.peerAlive && performance.now() - this.lastPong > PING_TIMEOUT_MS) {
                this._handlePeerGone();
            }
        }, PING_INTERVAL_MS);
    }

    _stopHeartbeat() {
        if (this._pingTimer) { clearInterval(this._pingTimer); this._pingTimer = null; }
        if (this._timeoutCheck) { clearInterval(this._timeoutCheck); this._timeoutCheck = null; }
    }

    _handlePeerGone() {
        if (!this.peerAlive) return;
        this.peerAlive = false;
        this._stopHeartbeat();
        this.onLeave?.();
    }

    close() {
        this._stopHeartbeat();
        super.close();
    }
}


// ============================================================================
// Secondary
// ============================================================================

/**
 * Secondary-side connection. Repeatedly sends LOOKING on construction
 * (and again after the master goes silent), finalizes setup on ACK via
 * `onAck`, replies to PING with PONG, and watches for master silence.
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
export class SecondaryConnection extends BroadcastConnectionBase {
    constructor({ onAck, onLeave, onLobbyState, onMatchEnd, onGameState } = {}) {
        super();
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
