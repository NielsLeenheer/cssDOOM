/**
 * WebRTCDataChannelTransport — implements the `Transport` interface
 * (`send` / `onMessage` / `close`) over an `RTCDataChannel`. Downstream
 * code (`MasterConnection`, `ClientConnection`, `RenderSink`,
 * `RenderClient`) doesn't know it's WebRTC — they only see the
 * Transport contract.
 *
 * Construction is async (unlike `BroadcastChannelTransport` which is
 * synchronous): the data channel has to come up over a signaling
 * handshake first. Two helpers do that handshake:
 *
 *   - `connectToNetworkRoom({ roomCode, ... })` — remote side. One
 *     master per remote, returns a single Promise<Transport>.
 *   - `listenForNetworkClients({ roomCode, onPeerConnected, ... })` —
 *     master side. Receives N peers over time; calls back per peer.
 *
 * Both helpers do the WebSocket-to-signaling dance + WebRTC SDP / ICE
 * exchange + datachannel-open wait. Once the data channel opens, the
 * signaling WebSocket is closed — all game traffic is direct P2P.
 *
 * # Signaling protocol
 *
 * Matches the wire format documented in `worker/signaling.js`. See that
 * file for the full message catalog. This module is the client side of
 * that protocol.
 */

// ── Defaults ───────────────────────────────────────────────────────────

// Free public STUN servers. Cone-NAT clients (most home networks)
// traverse with STUN alone. Symmetric-NAT clients need a TURN fallback;
// add Cloudflare Calls or another provider via `iceServers` override.
const DEFAULT_ICE_SERVERS = [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun.cloudflare.com:3478' },
];

// How long to wait for the data channel to open before treating the
// connection as failed. Includes signaling handshake + ICE gathering +
// peer connection setup.
const DATA_CHANNEL_TIMEOUT_MS = 30_000;

// Default signaling URL — same origin as the cssDOOM page, since the
// Worker hosts both. Override for staging / custom domain.
function defaultSignalingUrl() {
    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return `${protocol}//${location.host}/signaling/connect`;
}

// ── The Transport class ────────────────────────────────────────────────

export class WebRTCDataChannelTransport {
    /**
     * @param {RTCPeerConnection} peerConnection
     * @param {RTCDataChannel} dataChannel  must already be in 'open' state
     */
    constructor(peerConnection, dataChannel) {
        this._pc = peerConnection;
        this._dc = dataChannel;
        this._listeners = new Set();
        this._closed = false;

        this._dc.addEventListener('message', (event) => {
            // RTCDataChannel carries strings or ArrayBuffers; our protocol
            // is JSON over string for parity with the BroadcastChannel
            // structured-clone path.
            let msg;
            try {
                msg = JSON.parse(event.data);
            } catch (err) {
                console.warn('[webrtc-transport] bad message:', err);
                return;
            }
            for (const cb of this._listeners) cb(msg);
        });

        this._dc.addEventListener('close', () => {
            this._closed = true;
            this._listeners.clear();
        });
    }

    send(msg) {
        if (this._closed) return;
        if (this._dc.readyState !== 'open') return;
        try {
            this._dc.send(JSON.stringify(msg));
        } catch {
            // Don't console.warn on a hot per-frame send loop —
            // logging every dropped command starves the main thread
            // and the heartbeat with it. A truly unrecoverable
            // transport error will surface via the dc 'close' /
            // 'error' listeners instead.
        }
    }

    onMessage(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    close() {
        if (this._closed) return;
        this._closed = true;
        try { this._dc.close(); } catch {}
        try { this._pc.close(); } catch {}
        this._listeners.clear();
    }
}

// ── Remote-side helper: join an existing room ──────────────────────────

/**
 * Connect to an existing Network DM room as a joining remote.
 *
 * Flow: open signaling WebSocket → receive 'ready' → receive 'offer'
 * from master → create answer + send → exchange ICE → wait for data
 * channel `open` event → resolve with a `WebRTCDataChannelTransport`.
 *
 * @param {object} options
 * @param {string} options.roomCode                — alphanumeric room code (typed or from QR)
 * @param {string} [options.signalingUrl]          — defaults to same-origin
 * @param {RTCIceServer[]} [options.iceServers]    — defaults to free STUN
 * @returns {Promise<WebRTCDataChannelTransport>}
 */
export async function connectToNetworkRoom({
    roomCode,
    signalingUrl = defaultSignalingUrl(),
    iceServers = DEFAULT_ICE_SERVERS,
} = {}) {
    const wsUrl = `${signalingUrl}?room=${encodeURIComponent(roomCode)}&role=join`;
    const ws = new WebSocket(wsUrl);

    return new Promise((resolve, reject) => {
        const pc = new RTCPeerConnection({ iceServers });
        let dataChannel = null;
        const pendingIce = []; // candidates that arrive before setRemoteDescription
        let remoteDescriptionSet = false;
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            reject(new Error('WebRTC connection timed out'));
        }, DATA_CHANNEL_TIMEOUT_MS);

        function cleanup() {
            clearTimeout(timeout);
            try { ws.close(); } catch {}
        }

        function fail(err) {
            if (settled) return;
            settled = true;
            cleanup();
            try { pc.close(); } catch {}
            reject(err);
        }

        // The master creates the data channel; we receive it via the
        // ondatachannel event.
        pc.addEventListener('datachannel', (event) => {
            dataChannel = event.channel;
            dataChannel.addEventListener('open', () => {
                if (settled) return;
                settled = true;
                cleanup();
                resolve(new WebRTCDataChannelTransport(pc, dataChannel));
            });
            dataChannel.addEventListener('error', (e) => fail(e.error || new Error('data channel error')));
        });

        pc.addEventListener('icecandidate', (event) => {
            if (event.candidate && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: 'ice', candidate: event.candidate.toJSON() }));
            }
        });

        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'failed') fail(new Error('peer connection failed'));
        });

        ws.addEventListener('open', () => {
            // Nothing to send here — the server will assign us a peerId
            // and forward master's offer when the master sends one.
        });

        ws.addEventListener('error', () => fail(new Error('signaling WebSocket error')));

        ws.addEventListener('close', () => {
            // Only treat as failure if it closes before the data channel opens.
            if (!settled) fail(new Error('signaling closed before connection completed'));
        });

        ws.addEventListener('message', async (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }

            switch (msg.type) {
                case 'ready':
                    // We're connected to the room. Waiting for master's offer.
                    break;

                case 'offer':
                    try {
                        await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp });
                        remoteDescriptionSet = true;
                        // Drain any ICE candidates that arrived before the
                        // remote description was set.
                        for (const c of pendingIce) {
                            try { await pc.addIceCandidate(c); } catch (e) {
                                console.warn('[webrtc-transport] queued ICE failed:', e);
                            }
                        }
                        pendingIce.length = 0;

                        const answer = await pc.createAnswer();
                        await pc.setLocalDescription(answer);
                        ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }));
                    } catch (err) {
                        fail(err);
                    }
                    break;

                case 'ice':
                    if (remoteDescriptionSet) {
                        try { await pc.addIceCandidate(msg.candidate); } catch (e) {
                            console.warn('[webrtc-transport] addIceCandidate failed:', e);
                        }
                    } else {
                        pendingIce.push(msg.candidate);
                    }
                    break;

                case 'master-gone':
                    fail(new Error('master left before connection completed'));
                    break;
            }
        });
    });
}

// ── Master-side helper: open a room, wait for joiners ──────────────────

/**
 * Open a Network DM room as the master, then accept peers as they
 * connect. Each peer becomes its own `WebRTCDataChannelTransport`,
 * delivered via the `onPeerConnected` callback.
 *
 * The master may have up to MAX_REMOTES peers (enforced server-side
 * by the RoomDO). Each peer is independent — own RTCPeerConnection,
 * own data channel, own Transport, own slot in the orchestrator.
 *
 * The returned control object lets the caller close the room.
 *
 * @param {object} options
 * @param {string} options.roomCode                       — generated by caller (random 4-char)
 * @param {(transport: WebRTCDataChannelTransport, peerId: number) => void} options.onPeerConnected
 *   Called once per remote, when that remote's data channel has opened.
 * @param {(peerId: number) => void} [options.onPeerLeft]
 *   Called when a remote disconnects (data-channel close or signaling tells us).
 * @param {(err: Error) => void} [options.onError]
 *   Called for room-level failures (collision, signaling lost, etc.).
 *   The room is unusable after this fires; caller should retry with a
 *   fresh code.
 * @param {string} [options.signalingUrl]
 * @param {RTCIceServer[]} [options.iceServers]
 * @returns {{ close: () => void }} control handle
 */
export function listenForNetworkClients({
    roomCode,
    onPeerConnected,
    onPeerLeft = () => {},
    onError = () => {},
    signalingUrl = defaultSignalingUrl(),
    iceServers = DEFAULT_ICE_SERVERS,
}) {
    const wsUrl = `${signalingUrl}?room=${encodeURIComponent(roomCode)}&role=master`;

    // peerId → { pc, dc, pendingIce, transportResolved }
    const peers = new Map();
    let ws = null;
    let closed = false;
    let reconnectTimer = null;
    const SIGNALING_RECONNECT_DELAY_MS = 3000;

    // The signaling WebSocket is the door for NEW joiners. Existing
    // peers' RTCDataChannels are independent of it — once handshake is
    // done they talk P2P. So when the WS drops (DO hibernation eviction,
    // network blip, etc.) we reopen JUST the WS here; we never tear
    // down active peers, which would kick everyone playing. Only
    // `close()` (called from network-host.js's closeRoom) does that.
    function openSignaling() {
        ws = new WebSocket(wsUrl);

        ws.addEventListener('error', () => {
            if (!closed) scheduleReconnect();
        });

        ws.addEventListener('close', () => {
            if (!closed) scheduleReconnect();
        });

        ws.addEventListener('message', async (event) => {
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }

            switch (msg.type) {
                case 'ready':
                    // Room is open and we're the master. Waiting for joiners.
                    break;

                case 'peer-joined':
                    await startPeer(msg.peerId);
                    break;

                case 'answer':
                    await handleAnswer(msg.fromPeerId, msg.sdp);
                    break;

                case 'ice':
                    await handleIce(msg.fromPeerId, msg.candidate);
                    break;

                case 'peer-left':
                    handlePeerLeft(msg.peerId);
                    break;
            }
        });
    }

    function scheduleReconnect() {
        if (reconnectTimer || closed) return;
        reconnectTimer = setTimeout(() => {
            reconnectTimer = null;
            if (closed) return;
            openSignaling();
        }, SIGNALING_RECONNECT_DELAY_MS);
    }

    openSignaling();

    async function startPeer(peerId) {
        const pc = new RTCPeerConnection({ iceServers });
        const peer = { pc, dc: null, pendingIce: [], remoteDescriptionSet: false, resolved: false };
        peers.set(peerId, peer);

        // Master creates the data channel; remote receives it via 'datachannel'.
        // Ordered + reliable by default — same delivery semantics as
        // BroadcastChannel, so downstream code doesn't need to handle
        // dropped or reordered messages.
        const dc = pc.createDataChannel('cssdoom', { ordered: true });
        peer.dc = dc;

        dc.addEventListener('open', () => {
            if (peer.resolved || closed) return;
            peer.resolved = true;
            onPeerConnected(new WebRTCDataChannelTransport(pc, dc), peerId);
        });

        dc.addEventListener('close', () => {
            if (peers.delete(peerId)) onPeerLeft(peerId);
        });

        pc.addEventListener('icecandidate', (event) => {
            if (event.candidate && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'ice',
                    toPeerId: peerId,
                    candidate: event.candidate.toJSON(),
                }));
            }
        });

        pc.addEventListener('connectionstatechange', () => {
            if (pc.connectionState === 'failed' || pc.connectionState === 'closed') {
                if (peers.delete(peerId)) onPeerLeft(peerId);
            }
        });

        try {
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            ws.send(JSON.stringify({ type: 'offer', toPeerId: peerId, sdp: offer.sdp }));
        } catch (err) {
            console.warn('[webrtc-transport] master createOffer failed:', err);
            peers.delete(peerId);
        }
    }

    async function handleAnswer(peerId, sdp) {
        const peer = peers.get(peerId);
        if (!peer) return;
        try {
            await peer.pc.setRemoteDescription({ type: 'answer', sdp });
            peer.remoteDescriptionSet = true;
            for (const c of peer.pendingIce) {
                try { await peer.pc.addIceCandidate(c); } catch (e) {
                    console.warn('[webrtc-transport] queued ICE failed:', e);
                }
            }
            peer.pendingIce.length = 0;
        } catch (err) {
            console.warn('[webrtc-transport] setRemoteDescription failed:', err);
            peers.delete(peerId);
        }
    }

    async function handleIce(peerId, candidate) {
        const peer = peers.get(peerId);
        if (!peer) return;
        if (peer.remoteDescriptionSet) {
            try { await peer.pc.addIceCandidate(candidate); } catch (e) {
                console.warn('[webrtc-transport] addIceCandidate failed:', e);
            }
        } else {
            peer.pendingIce.push(candidate);
        }
    }

    function handlePeerLeft(peerId) {
        const peer = peers.get(peerId);
        if (!peer) return;
        // Once the data channel is open, the P2P connection is fully
        // independent of signaling. The remote is *supposed* to close
        // their signaling WebSocket after handshake (their cleanup()
        // does exactly that), and the DO duly notifies us with
        // 'peer-left'. Reacting by closing the pc would kick a
        // perfectly-connected player. The pc.onconnectionstatechange
        // and dc.onclose listeners below will fire onPeerLeft on any
        // REAL disconnect; this signaling 'peer-left' is just noise
        // after handshake. Drop it.
        if (peer.resolved) return;

        // Pre-handshake — the remote bailed before the data channel
        // could open. Tear down the half-built peer connection. No
        // onPeerLeft callback because we never fired onPeerConnected.
        peers.delete(peerId);
        try { peer.pc.close(); } catch {}
    }

    return {
        close() {
            if (closed) return;
            closed = true;
            for (const peer of peers.values()) {
                try { peer.pc.close(); } catch {}
            }
            peers.clear();
            try { ws.close(); } catch {}
        },
    };
}
