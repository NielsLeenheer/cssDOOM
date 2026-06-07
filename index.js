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
// `?layout=kiosk | cad | visualize` chooses a multi-pane layout.
// `?kiosk` is kept as a shorthand for `?layout=kiosk` (it's the URL
// the installation kiosk boots from — predates the layout switch).
// Stashed on body.dataset.layout so CSS + JS read a single token
// instead of three independent body-class checks.
const layout = params.get('layout') ?? (params.has('kiosk') ? 'kiosk' : null);
// `?renderer=flat | shade | line` swaps which renderer the manager
// builds for each pane (default `dom`). Stashed on
// body.dataset.renderer so the manager picks the constructor in
// `create()` without re-parsing the URL. The alternative renderers
// still receive the same world / per-player envelopes, just paint
// them differently.
const rendererKind = params.get('renderer');
// `?resolution=1x | 2x | 3x` lets the CanvasRenderer multiply its
// framebuffer base resolution (200 rows × paneAspect). Higher values
// give a sharper, less chunky image at the cost of ~factor² more
// per-frame CPU. Stashed on body.dataset.resolution so the renderer
// can read it without re-parsing the URL; ignored by other renderers.
const resolution = params.get('resolution');
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

if (layout) document.body.dataset.layout = layout;
if (rendererKind) document.body.dataset.renderer = rendererKind;
if (resolution) document.body.dataset.resolution = resolution;
// `body.dev` marks a dev-server run (statically dropped from prod builds) so
// CSS can adjust dev-only chrome — e.g. fading the auto-opened debug menu out
// of the kiosk display (see viewport.css).
if (import.meta.env.DEV) document.body.classList.add('dev');
// `body.recording` is added later (in the player, after the
// click-to-start overlay is dismissed) so the debug menu stays
// reachable while the user configures the recording.

if (playSlot) {
    initMaster({ playSlot, exportFormat });
} else if (isClient) {
    initClientWindow({ roomCode });
} else {
    initMaster();
}
