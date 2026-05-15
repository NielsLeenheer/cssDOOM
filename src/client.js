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
    const app = new App();
    window.app = app;
    await app.joinRemoteGame(roomCode);
}
