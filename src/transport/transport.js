/**
 * Transport — the wire abstraction over which master and a client (today
 * a Local DM secondary via BroadcastChannel; tomorrow a Network DM remote
 * via WebRTC) exchange envelopes.
 *
 * The Transport interface is intentionally tiny. Three methods, plus a
 * structured-clone-friendly message payload:
 *
 *   send(msg)         — post an envelope to the other side.
 *   onMessage(cb)     — subscribe; returns an unsubscribe function.
 *   close()           — tear down the underlying wire.
 *
 * The classes that touch the wire — `MasterConnection` /
 * `ClientConnection` (peer-connection.js), `RenderSink`, `RenderClient`,
 * and `src/client.js` (its input-forwarding half) — talk only to this
 * interface. Swapping the transport (e.g. for Network DM) is a one-line
 * change at construction time; nothing downstream knows which wire it's on.
 *
 * One Transport instance corresponds to one wire. In Local DM that's one
 * BroadcastChannel shared between the master window's connection + sink
 * and the client window's connection + RenderClient. In a future Network
 * DM, each peer's WebRTC DataChannel is its own Transport instance.
 */

/**
 * Transport backed by a `BroadcastChannel`. Multiplexes a single
 * underlying `addEventListener('message', ...)` to N registered
 * `onMessage` listeners so multiple consumers (e.g. a Connection +
 * RenderClient in a client window) can share one Transport instance
 * without each opening their own BroadcastChannel.
 */
export class BroadcastChannelTransport {
    /**
     * @param {string} name  BroadcastChannel name. Master and client
     *                       must use the same name to communicate.
     */
    constructor(name) {
        this._bc = new BroadcastChannel(name);
        this._listeners = new Set();
        this._bc.addEventListener('message', (event) => {
            for (const cb of this._listeners) cb(event.data);
        });
    }

    /** Post an envelope to peers on this channel. */
    send(msg) {
        this._bc.postMessage(msg);
    }

    /**
     * Subscribe to incoming envelopes. Returns an unsubscribe function.
     * BroadcastChannel does not echo a message back to its own posting
     * instance, so `send` here does not trigger our own listeners — only
     * the peer's transport does.
     */
    onMessage(callback) {
        this._listeners.add(callback);
        return () => this._listeners.delete(callback);
    }

    /** Close the underlying BroadcastChannel and drop all listeners. */
    close() {
        this._bc.close();
        this._listeners.clear();
    }
}
