/**
 * BroadcastConnection — the lifecycle manager that runs on both the master
 * window (the one with the game loop) and the secondary window (the
 * renderer-only second display).
 *
 * Master side (`role === 'master'`):
 *   - Listens for LOOKING from a secondary trying to join.
 *   - On LOOKING: calls onJoin() so the application can swap target[1] for
 *     a BroadcastSink and stream renderer commands.
 *   - Sends ACK with current level/mode info so the secondary can sync.
 *   - Pings every PING_INTERVAL_MS; if no PONG within PING_TIMEOUT_MS,
 *     calls onLeave() so the application can swap back to a DomRenderer.
 *
 * Secondary side (`role === 'secondary'`):
 *   - On construction, sends LOOKING and periodically retries until ACK.
 *   - On ACK from master: calls onAck(payload) so the application can
 *     load the level and finalize its renderer setup.
 *   - Replies to PING with PONG, and tracks the last activity from master.
 *   - If silent for PING_TIMEOUT_MS: calls onLeave() so the application
 *     can show a DISCONNECTED overlay, and resumes sending LOOKING so a
 *     restarted master will pick us up again.
 *   - On window unload: sends LEAVING.
 *
 * The connection only manages the protocol envelope. Per-pane and world
 * renderer commands flow through BroadcastSink / BroadcastClient (which
 * share the same channel but are layered on top of this).
 */

import {
    BROADCAST_CHANNEL_NAME, MSG, PING_INTERVAL_MS, PING_TIMEOUT_MS,
} from './broadcast-protocol.js';

export class BroadcastConnection {
    /**
     * @param {object} options
     * @param {'master'|'secondary'} options.role
     * @param {() => object} [options.snapshotProvider]   master only — returns ACK payload
     * @param {(payload: object) => void} [options.onJoin]    master — secondary just announced
     * @param {() => void} [options.onLeave]              master — secondary went away
     * @param {(payload: object) => void} [options.onAck]     secondary — master accepted us
     */
    constructor({ role, snapshotProvider, onJoin, onLeave, onAck, onRemoteInput, onLobbyState, onMatchEnd }) {
        this.role = role;
        this.snapshotProvider = snapshotProvider;
        this.onJoin = onJoin;
        this.onLeave = onLeave;
        this.onAck = onAck;
        this.onRemoteInput = onRemoteInput;
        this.onLobbyState = onLobbyState;
        this.onMatchEnd = onMatchEnd;
        this.channel = new BroadcastChannel(BROADCAST_CHANNEL_NAME);
        this.peerAlive = false;
        this.lastPong = 0;
        this.lastFromMaster = 0;
        // When paused, master ignores LOOKING. Used during loadMap so a
        // reconnecting secondary doesn't hand-shake against a half-built
        // scene and start receiving mid-rebuild deltas.
        this.paused = false;
        this._pingTimer = null;
        this._timeoutCheck = null;
        this._lookingTimer = null;

        this.channel.addEventListener('message', (event) => this._handle(event.data));

        // Both sides announce departure on unload so the peer can react
        // immediately instead of waiting on the watchdog.
        window.addEventListener('beforeunload', () => {
            this._post({ type: MSG.LEAVING });
        });

        if (role === 'secondary') {
            this._startLooking();
        }
    }

    /**
     * Secondary-only: send LOOKING repeatedly until master responds with ACK.
     * Stops itself once peerAlive becomes true.
     */
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

    _post(envelope) {
        try {
            this.channel.postMessage(envelope);
        } catch (err) {
            console.warn('BroadcastConnection: post failed', err);
        }
    }

    _handle(msg) {
        if (!msg || typeof msg !== 'object') return;

        if (this.role === 'master') {
            if (msg.type === MSG.LOOKING) {
                // Ignore while paused — master is mid-loadMap and the scene
                // isn't ready to stream. Secondary's _startLooking retry
                // will catch us once we resume.
                if (this.paused) return;
                // Either a fresh secondary, or a previously-connected one
                // re-announcing after a transient drop. Re-fire onJoin only
                // if we don't currently consider one alive.
                const payload = this.snapshotProvider ? this.snapshotProvider() : {};
                this._post({ type: MSG.ACK, payload });
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
        } else if (this.role === 'secondary') {
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
                this.onAck?.(msg.payload ?? {}, /* isReconnect */ wasAlive === false && this._everConnected === true);
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
            }
        }
    }

    /**
     * Master-only: broadcast a lobby-state envelope to all peers. Caller
     * passes `{ inLobby, slotsClaimed }`; secondary mirrors it onto its
     * own DOM. No-op when no peer is alive — saves a postMessage.
     */
    broadcastLobbyState(state) {
        if (this.role !== 'master') return;
        if (!this.peerAlive) return;
        this._post({ type: MSG.LOBBY_STATE, ...state });
    }

    /**
     * Master-only: broadcast the end-of-match scoreboard to all peers.
     * Payload mirrors what scoreboard.js's renderer expects, so the
     * secondary just hands it straight through.
     */
    broadcastMatchEnd(payload) {
        if (this.role !== 'master') return;
        if (!this.peerAlive) return;
        this._post({ type: MSG.MATCH_END, ...payload });
    }

    /**
     * Master-only: signal that loadMap is about to run. Tells the secondary
     * to reload itself, drops the connection on our side, and pauses LOOKING
     * acceptance so a fast-reconnecting secondary doesn't hand-shake against
     * a half-built scene. resumeAfterLevelLoad() un-pauses once loadMap is
     * done. We pause unconditionally (even with no peer alive) — the next
     * loadMap might attract a fresh secondary mid-load.
     */
    signalLevelChange() {
        if (this.role !== 'master') return;
        this.paused = true;
        if (this.peerAlive) {
            this._post({ type: MSG.LEVEL_CHANGE });
            this._handlePeerGone();
        }
    }

    /** Master-only: master finished loadMap, accept LOOKINGs again. */
    resumeAfterLevelLoad() {
        if (this.role !== 'master') return;
        this.paused = false;
    }

    /**
     * Secondary-only: watch for master silence. If no message in
     * PING_TIMEOUT_MS, treat master as gone and resume looking.
     */
    _startWatchdog() {
        if (this._timeoutCheck) return;
        this._timeoutCheck = setInterval(() => {
            if (this.peerAlive && performance.now() - this.lastFromMaster > PING_TIMEOUT_MS) {
                this._handlePeerGone();
            }
        }, PING_INTERVAL_MS);
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
        if (this.role === 'master') {
            this._stopHeartbeat();
        } else {
            // Stop watching; we'll restart the watchdog when ACK comes back.
            if (this._timeoutCheck) { clearInterval(this._timeoutCheck); this._timeoutCheck = null; }
            // Resume looking for master.
            this._startLooking();
        }
        this.onLeave?.();
    }

    close() {
        this._stopHeartbeat();
        if (this._lookingTimer) { clearInterval(this._lookingTimer); this._lookingTimer = null; }
        this.channel.close();
    }
}
