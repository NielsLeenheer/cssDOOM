/**
 * Client — boot routine for the joining window.
 *
 * Counterpart to [src/master.js](master.js). The joining window constructs
 * an App that holds a RemoteGame instead of a Game; RemoteGame owns the
 * transport, ACK handshake, DomRenderer setup, map load, and input
 * forwarder.
 *
 *   - `?join` with no value → Local DM secondary. BroadcastChannel
 *     transport, no input forwarding, audio off.
 *   - `?join=ABCD` → Network DM remote. WebRTC transport via the
 *     Cloudflare-Worker signaling endpoint; forwards input back to
 *     master; plays audio locally.
 */

import { App } from './app.js';

export async function initClientWindow({ roomCode = null } = {}) {
    // Boot-time window configuration. Both Local DM secondaries and
    // Network DM remotes have .client-window; .network-client is the
    // additional canonical signal for Network-DM-specific UI gates
    // (CSS hides Network DM lobby DOM on non-network-client windows).
    // Set synchronously here — before any rendering or game-loop
    // work begins — so CSS that gates on these classes
    // (`body.client-window .pane { ... }`,
    // `body.network-client .pane-network-lobby { ... }`) applies
    // from first paint.
    document.body.classList.add('client-window');
    if (roomCode) document.body.classList.add('network-client');

    const app = new App();
    window.app = app;
    await app.joinRemoteGame(roomCode);
}
