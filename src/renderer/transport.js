/**
 * Transport — the wire abstraction over which master and a remote (today
 * a secondary window via BroadcastChannel; tomorrow a network peer via
 * WebRTC) exchange envelopes.
 *
 * The Transport interface is intentionally tiny. Three methods, plus a
 * structured-clone-friendly message payload:
 *
 *   send(msg)         — post an envelope to the other side.
 *   onMessage(cb)     — subscribe; returns an unsubscribe function.
 *   close()           — tear down the underlying wire.
 *
 * The renderer-side classes that touch the wire — `BroadcastConnection*`,
 * `BroadcastSink`, `BroadcastClient`, and the (scaffolding) input
 * forwarder in `src/input/remote-secondary.js` — talk only to this
 * interface. Swapping the transport (e.g. for Network DM) is a one-line
 * change at construction time; nothing downstream knows which wire it's
 * on.
 *
 * One Transport instance corresponds to one wire. In Local DM that's one
 * BroadcastChannel shared between the master window's connection + sink
 * and the secondary window's connection + client. In a future Network
 * DM, each peer's WebRTC DataChannel is its own Transport instance.
 */

/**
 * Transport backed by a `BroadcastChannel`. Multiplexes a single
 * underlying `addEventListener('message', ...)` to N registered
 * `onMessage` listeners so multiple consumers (e.g. a Connection +
 * Client in the secondary window) can share one Transport instance
 * without each opening their own BroadcastChannel.
 */
export class BroadcastChannelTransport {
    /**
     * @param {string} name  BroadcastChannel name. Master and secondary
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
