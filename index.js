/**
 * Entry point — dispatches to the role's boot routine.
 *
 *   - Master (default): full game loop, input, audio, broadcast listener.
 *     See [src/master.js](src/master.js).
 *   - Client (`?join` URL param): connects to master and renders the slot
 *     master assigns. See [src/client.js](src/client.js).
 */

import { initMaster } from './src/master.js';
import { initClientWindow } from './src/client.js';

const isClient = new URLSearchParams(location.search).has('join');
const isKiosk = new URLSearchParams(location.search).has('kiosk');
if (isKiosk) document.body.classList.add('kiosk');

if (isClient) {
    initClientWindow();
} else {
    initMaster({ isKiosk });
}
