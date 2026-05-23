/**
 * RoomDO — one Durable Object instance per Network DM room.
 *
 * A pairing point that holds WebSockets from master + joining remotes
 * and relays WebRTC signaling messages (offer / answer / ICE candidates)
 * between them. Pure in-memory state — no persistent storage writes,
 * so it's cheap on Cloudflare's billing model.
 *
 * Uses the Hibernation API (`state.acceptWebSocket` + `webSocketMessage`
 * / `webSocketClose` handlers) so the DO can doze between messages
 * without accruing duration charges. Critical for cost: WebSockets are
 * held for ~5–30 seconds per handshake, then closed.
 *
 * # Protocol
 *
 * Both sides connect via:
 *   wss://<host>/signaling/connect?room=ABCD&role=master|join
 *
 * Master flow (creates the room):
 *   → connect with role=master
 *   ← {type: 'ready'}                              you are the master, room is open
 *   ← {type: 'peer-joined', peerId: N}             remote N just connected
 *   → {type: 'offer', toPeerId: N, sdp}            send offer to remote N
 *   ← {type: 'answer', fromPeerId: N, sdp}         remote N's answer
 *   → {type: 'ice', toPeerId: N, candidate}        ICE candidate for remote N
 *   ← {type: 'ice', fromPeerId: N, candidate}      ICE candidate from remote N
 *   ← {type: 'peer-left', peerId: N}               remote N disconnected
 *
 * Remote flow (joins an existing room):
 *   → connect with role=join
 *   ← {type: 'ready', peerId: N}                   you've been assigned peer N
 *   ← {type: 'offer', sdp}                         offer from master
 *   → {type: 'answer', sdp}                        answer to master
 *   ← {type: 'ice', candidate}                     ICE candidate from master
 *   → {type: 'ice', candidate}                     ICE candidate to master
 *   ← {type: 'master-gone'}                        master disconnected — bail
 *
 * # Error responses (HTTP, before WebSocket upgrade)
 *
 *   400  missing/malformed room or role
 *   409  role=master but room already has a master (code collision — caller should retry with a new code)
 *   404  role=join but room has no master (room doesn't exist / expired)
 */

const MAX_REMOTES = 3; // master in slot 0, remotes in slots 1..3

/**
 * Build a "refused upgrade" WebSocket response: accept the upgrade so
 * the browser surfaces the message instead of a generic non-101 error,
 * send a typed `{ type: 'refused', reason }` envelope, and close
 * cleanly. Caller's connectToNetworkRoom reads `reason` to show a
 * specific status ("ROOM IS FULL" / "ROOM NOT FOUND") instead of the
 * generic timeout.
 *
 * `reason` is a stable string the client switches on; current values
 * are 'room-full' and 'room-not-found'.
 */
function refuseRemoteUpgrade(reason) {
    const pair = new WebSocketPair();
    const [client, server] = [pair[0], pair[1]];
    server.accept();
    server.send(JSON.stringify({ type: 'refused', reason }));
    // 1000 = normal closure; the typed message is the actual signal.
    server.close(1000, reason);
    return new Response(null, { status: 101, webSocket: client });
}

export class RoomDO {
    constructor(state, env) {
        this.state = state;
        this.env = env;
        this.master = null;     // WebSocket | null
        this.remotes = new Map(); // peerId (number) → WebSocket
        this.nextPeerId = 1;

        // Restore any WebSockets that survived hibernation. Each WebSocket
        // has a tag stored at accept time so we know its role on wake-up.
        for (const ws of this.state.getWebSockets()) {
            const tag = this.state.getTags(ws)[0];
            if (tag === 'master') {
                this.master = ws;
            } else if (tag?.startsWith('remote:')) {
                const peerId = Number(tag.slice('remote:'.length));
                this.remotes.set(peerId, ws);
                if (peerId >= this.nextPeerId) this.nextPeerId = peerId + 1;
            }
        }
    }

    // ── HTTP entrypoint — upgrades to WebSocket ─────────────────────────

    async fetch(request) {
        if (request.headers.get('Upgrade') !== 'websocket') {
            return new Response('expected WebSocket upgrade', { status: 426 });
        }

        const url = new URL(request.url);
        const role = url.searchParams.get('role');

        if (role === 'master') return this.connectMaster();
        if (role === 'join')   return this.connectRemote();
        return new Response('missing or invalid role', { status: 400 });
    }

    connectMaster() {
        if (this.master) {
            // Code collision — another browser is already master of this
            // DO. Caller should retry with a fresh code.
            return new Response('room already has a master', { status: 409 });
        }

        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        this.state.acceptWebSocket(server, ['master']);
        this.master = server;

        // Acknowledge the master so the client knows the room is open.
        server.send(JSON.stringify({ type: 'ready' }));

        return new Response(null, { status: 101, webSocket: client });
    }

    connectRemote() {
        // Refusal cases (no master, room full) upgrade the WebSocket
        // ANYWAY, send a typed reason message, and close cleanly. The
        // browser's WebSocket API doesn't surface HTTP status codes on
        // failed upgrades — returning 404/409 directly leaves the
        // client unable to distinguish "room doesn't exist" /
        // "room full" from a generic transport failure. Upgrading +
        // typed-close lets connectToNetworkRoom report the specific
        // reason in the joiner's UI.
        if (!this.master) {
            return refuseRemoteUpgrade('room-not-found');
        }
        if (this.remotes.size >= MAX_REMOTES) {
            return refuseRemoteUpgrade('room-full');
        }

        const peerId = this.nextPeerId++;
        const pair = new WebSocketPair();
        const [client, server] = [pair[0], pair[1]];
        this.state.acceptWebSocket(server, [`remote:${peerId}`]);
        this.remotes.set(peerId, server);

        // Tell the remote its peerId so it can include it on outgoing
        // messages (though for our flow, remotes only ever talk to the
        // master, so they don't strictly need it for routing).
        server.send(JSON.stringify({ type: 'ready', peerId }));

        // Tell the master a new remote joined so it can initiate the WebRTC
        // offer toward this peerId.
        this.master.send(JSON.stringify({ type: 'peer-joined', peerId }));

        return new Response(null, { status: 101, webSocket: client });
    }

    // ── Hibernation API handlers — fire on incoming messages / closes ──

    async webSocketMessage(ws, message) {
        const tag = this.state.getTags(ws)[0];
        let msg;
        try {
            msg = JSON.parse(message);
        } catch {
            return; // ignore garbage
        }

        if (tag === 'master') {
            this.routeFromMaster(msg);
        } else if (tag?.startsWith('remote:')) {
            const fromPeerId = Number(tag.slice('remote:'.length));
            this.routeFromRemote(fromPeerId, msg);
        }
    }

    async webSocketClose(ws, _code, _reason, _wasClean) {
        const tag = this.state.getTags(ws)[0];
        if (tag === 'master') {
            // Master left — kick every remote and tear down. The DO will
            // be evicted once all sockets close and it idles out.
            this.master = null;
            for (const remote of this.remotes.values()) {
                try { remote.send(JSON.stringify({ type: 'master-gone' })); } catch {}
                try { remote.close(1000, 'master gone'); } catch {}
            }
            this.remotes.clear();
        } else if (tag?.startsWith('remote:')) {
            const peerId = Number(tag.slice('remote:'.length));
            this.remotes.delete(peerId);
            // Notify master that this remote left so it can free the slot.
            if (this.master) {
                try {
                    this.master.send(JSON.stringify({ type: 'peer-left', peerId }));
                } catch {}
            }
        }
    }

    async webSocketError(ws, _error) {
        // Treat WebSocket errors as a hard close. The CF runtime will
        // also fire webSocketClose right after, but be defensive.
        return this.webSocketClose(ws, 1011, 'error', false);
    }

    // ── Message routing ─────────────────────────────────────────────────

    routeFromMaster(msg) {
        // Master messages target a specific remote by peerId. Re-encode
        // without the toPeerId field — the remote doesn't need to know
        // its own ID on every message.
        const { type, toPeerId, ...rest } = msg;
        if (typeof toPeerId !== 'number') return;
        const remote = this.remotes.get(toPeerId);
        if (!remote) return; // remote already gone
        try {
            remote.send(JSON.stringify({ type, ...rest }));
        } catch {}
    }

    routeFromRemote(fromPeerId, msg) {
        // Remote messages always go to the master, tagged with the
        // sender's peerId so master can dispatch to the right
        // peer-connection on its side.
        if (!this.master) return;
        try {
            this.master.send(JSON.stringify({ ...msg, fromPeerId }));
        } catch {}
    }
}
