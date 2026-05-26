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
const isVisualize = params.has('visualize');
// `?renderer=flat | shade | line` swaps which renderer the manager
// builds for each pane (default `dom`). Stashed on
// body.dataset.renderer so the manager picks the constructor in
// `create()` without re-parsing the URL. The alternative renderers
// still receive the same world / per-player envelopes, just paint
// them differently.
const rendererKind = params.get('renderer');
// `?play=slot` replays a recorded envelope stream from IndexedDB.
// Bypasses both client and server boot paths — initMaster runs a
// stripped sequence (renderers + culling only) and hands off to the
// player module.
const playSlot = params.get('play');
// `?export=mp4 | webm` captures the playback window via
// getDisplayMedia + MediaRecorder and downloads the result when the
// recording ends. Requires a user click before screen capture (the
// player paints a prompt overlay).
const exportFormat = params.get('export');

if (isKiosk) document.body.classList.add('kiosk');
if (isVisualize) document.body.classList.add('visualize');
if (rendererKind) document.body.dataset.renderer = rendererKind;
if (exportFormat) document.body.classList.add('recording');

if (playSlot) {
    initMaster({ isKiosk, playSlot, exportFormat });
} else if (isClient) {
    initClientWindow({ roomCode });
} else {
    initMaster({ isKiosk });
}
