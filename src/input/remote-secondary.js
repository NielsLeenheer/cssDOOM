/**
 * Forward keyboard and mouse events from the secondary window over the
 * BroadcastChannel to the master. Master-side handler (remote-master.js)
 * applies them as input from player 1, the player whose view the
 * secondary is rendering. This is a same-machine fixture today; a network
 * transport (WebSocket / WebRTC) could swap in for remote multiplayer
 * without changing either end.
 *
 * Raw events are forwarded — keydown/keyup/mousemove/mousedown/mouseup —
 * not pre-processed input snapshots. Master owns the interpretation
 * (auto-repeat suppression, sensitivity, key→action mapping). Keeps the
 * protocol unopinionated and matches what a future network protocol
 * would carry.
 */

import { MSG } from '../renderer/broadcast-protocol.js';

export function initRemoteInputForwarder(channel) {
    const post = (msg) => channel.postMessage({ type: MSG.INPUT, ...msg });

    document.addEventListener('keydown', (e) => {
        // Skip OS auto-repeat — master tracks discrete down/up transitions
        // and would otherwise see a flood of duplicate downs while a key
        // is held.
        if (e.repeat) return;
        post({ kind: 'keydown', code: e.code });
    });
    document.addEventListener('keyup', (e) => {
        post({ kind: 'keyup', code: e.code });
    });

    document.addEventListener('mousedown', (e) => {
        // Don't forward clicks on UI chrome (menu button, fullscreen button,
        // disconnected overlay, etc.) — they're for the secondary's own
        // local UI, not gameplay.
        if (e.target.closest('#ui-buttons, #menu-button, #disconnected-overlay, #help-overlay')) return;
        post({ kind: 'mousedown', button: e.button });
    });
    document.addEventListener('mouseup', (e) => {
        post({ kind: 'mouseup', button: e.button });
    });

    // Pointer-lock on fullscreen (matches master's mouse.js). Once locked,
    // mousemove deltas are forwarded as turn deltas.
    document.addEventListener('fullscreenchange', () => {
        if (document.fullscreenElement) {
            document.documentElement.requestPointerLock();
        }
    });
    document.addEventListener('mousemove', (e) => {
        if (document.pointerLockElement) {
            post({ kind: 'mousemove', dx: e.movementX, dy: e.movementY });
        }
    });

    // Window blur — clear all keys on master so a held W doesn't get stuck
    // when the secondary loses focus and never sends keyup.
    window.addEventListener('blur', () => {
        post({ kind: 'blur' });
    });
}
