/**
 * Entry point — dispatches to the role's boot routine.
 *
 *   - Master (default): full game loop, input, audio, broadcast listener.
 *     See [src/master.js](src/master.js).
 *   - Local DM secondary (`?join` with no value): BroadcastChannel
 *     transport, display-only, audio off. See [src/client.js](src/client.js).
 *   - Network DM remote (`?join=ABCD`): WebRTC transport via signaling
 *     for room ABCD, full input pipeline forwarded, audio plays locally.
 */

import { initMaster } from './src/master.js';
import { initClientWindow } from './src/client.js';

const params = new URLSearchParams(location.search);
const joinParam = params.get('join'); // null when absent; '' when present without value
const isClient = joinParam !== null;
const roomCode = joinParam || null;   // null for Local DM secondary
const isKiosk = params.has('kiosk');
if (isKiosk) document.body.classList.add('kiosk');

if (isClient) {
    initClientWindow({ roomCode });
} else {
    initMaster({ isKiosk });
}
