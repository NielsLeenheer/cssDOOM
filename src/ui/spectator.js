/**
 * Spectator Mode — top-down map view and follow-behind camera.
 *
 * Camera transforms are defined in CSS (spectator.css) and driven by
 * custom properties. JavaScript only manages interactive state (pan,
 * zoom, rotate, mode switching, controls visibility) and pushes the
 * resulting values to the renderer via orchestrator calls.
 *
 * Follow mode needs NO JS animation loop — CSS computes the camera
 * position from --player-* properties using sin()/cos(). Only zoom
 * (R/F keys, scroll, pinch) updates --follow-height.
 *
 * Top-down mode uses a JS loop for keyboard-driven pan/zoom/rotate;
 * it pushes --spectator-offset-x/y, --spectator-height, and
 * --spectator-angle. CSS composes the transform.
 *
 * All renderer access goes through the orchestrator. This module
 * never touches CSSRenderer or CSSRendererManager directly.
 */

import { state } from '../game/state.js';
import { orchestrator } from '../orchestrator.js';

export let spectatorActive = false;
let spectatorLoopRunning = false;
const spectator = { offsetX: 0, offsetY: 0, height: 3000, angle: 0, keys: {}, mode: 'top' };
const spectatorControls = document.getElementById('spectator-controls');

function spectatorLoop() {
    if (!spectatorActive || !spectatorLoopRunning) return;

    if (spectator.mode === 'top') {
        const speed = spectator.height * 0.02;
        const cos = Math.cos(spectator.angle);
        const sin = Math.sin(spectator.angle);
        if (spectator.keys.w) { spectator.offsetX -= sin * speed; spectator.offsetY += cos * speed; }
        if (spectator.keys.s) { spectator.offsetX += sin * speed; spectator.offsetY -= cos * speed; }
        if (spectator.keys.a) { spectator.offsetX -= cos * speed; spectator.offsetY -= sin * speed; }
        if (spectator.keys.d) { spectator.offsetX += cos * speed; spectator.offsetY += sin * speed; }
        if (spectator.keys.q) spectator.angle -= 0.03;
        if (spectator.keys.e) spectator.angle += 0.03;
        if (spectator.keys.r) spectator.height = Math.max(200, spectator.height - speed);
        if (spectator.keys.f) spectator.height += speed;

        orchestrator.setSpectatorCamera(spectator);
        updateSpectatorViewer();
    } else {
        // Follow mode: CSS handles the camera transform automatically.
        // Only zoom keys need JS.
        if (spectator.keys.r) spectator.height = Math.max(100, spectator.height - spectator.height * 0.02);
        if (spectator.keys.f) spectator.height += spectator.height * 0.02;

        orchestrator.setSpectatorFollowHeight(spectator.height);
        updateSpectatorViewer();
    }
    requestAnimationFrame(spectatorLoop);
}

// --- Spectator button ---
const spectatorButton = document.getElementById('spectator-button');
if (spectatorButton) {
    spectatorButton.addEventListener('click', () => spectate());
}

// Player-sprite rotation is no longer computed here. The body is the standard
// DM billboard (createPlayerSprite), rotated by the renderer's
// updateEnemyRotation. We only pin the VIEWER it rotates against: a world
// point in the direction of the spectator camera, so the billboard faces the
// camera (and shows its back in follow mode). This reproduces the old heading
// math via geometry. The renderer reads the pinned viewer for every sprite, so
// movement.js's per-frame rotation dispatch — which would otherwise use the
// body's own position — stays correct too.
//
//   follow → θ = player.angle      (viewer directly behind player → back view)
//   top    → θ = spectator.angle   (viewer offset by the top-down camera yaw)
//
// The viewer sits VIEWER_DIST units away, not 1: the viewer is computed here on
// the spectator rAF while updateEnemyRotation runs on the game rAF with the
// body's own position, so the two reads of the player position can be a frame
// apart. At run speed (~10 units/frame) a 1-unit offset would be swamped by
// that delta and the heading would track movement direction instead of facing
// (sideways/reversed sprite when strafing or backing up). A large offset makes
// the per-frame delta negligible against it — the same reason a real camera
// sits far from its subject. Heading depends only on direction, so the
// magnitude is free to be large.
const VIEWER_DIST = 1024;
function updateSpectatorViewer() {
    const p = state.players[0];
    if (!p) return;
    const theta = spectator.mode === 'follow' ? p.angle : spectator.angle;
    orchestrator.setSpectatorViewer({
        x: p.x + Math.sin(theta) * VIEWER_DIST,
        y: p.y - Math.cos(theta) * VIEWER_DIST,
    });
}

export function spectate() {
    // Spectator is single-player only — the camera follows state.players[0]
    // and the controls overlay isn't routed per-pane. Refuse to enter from
    // a DM session; allow exit if somehow already active.
    if (state.gameMode === 'deathmatch' && !spectatorActive) {
        console.log('Spectator mode is disabled in deathmatch.');
        return;
    }
    spectatorActive = !spectatorActive;
    if (spectatorActive) {
        spectator.offsetX = 0;
        spectator.offsetY = 0;
        spectator.height = 300;
        spectator.angle = 0;
        spectator.mode = 'follow';
        spectator.keys = {};

        orchestrator.setSpectatorCamera(spectator);
        orchestrator.setSpectatorFollowHeight(spectator.height);
        if (spectatorControls) spectatorControls.classList.remove('hidden');

        orchestrator.startSpectatorMode('follow');

        // Update tab active state
        spectatorTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.mode === 'follow'));

        // Pin the rotation viewer immediately so the revealed billboard faces
        // the camera from the first frame, before the interactive loop starts.
        updateSpectatorViewer();

        // Start interactive loop after transition completes
        setTimeout(() => {
            if (spectatorActive) {
                updateSpectatorViewer();
                spectatorLoopRunning = true;
                spectatorLoop();
            }
        }, 1500);

        console.log('Spectator mode ON. Click the spectator button again to exit.');
    } else {
        spectatorLoopRunning = false;
        if (spectatorControls) spectatorControls.classList.add('hidden');

        orchestrator.endSpectatorMode();

        console.log('Spectator mode OFF');
    }
}


// --- Spectator drag to pan ---
let dragState = null;

function spectatorDragStart(clientX, clientY) {
    if (!spectatorActive) return;
    dragState = { startX: clientX, startY: clientY, origX: spectator.offsetX, origY: spectator.offsetY };
}

function spectatorDragMove(clientX, clientY) {
    if (!dragState) return;
    // Scale drag distance by height (higher = larger movement per pixel)
    const scale = spectator.height / window.innerHeight * 2;
    const dx = (clientX - dragState.startX) * scale;
    const dy = -(clientY - dragState.startY) * scale;

    // Account for camera rotation
    const cos = Math.cos(spectator.angle);
    const sin = Math.sin(spectator.angle);
    spectator.offsetX = dragState.origX - (dx * cos + dy * sin);
    spectator.offsetY = dragState.origY - (-dx * sin + dy * cos);
}

function spectatorDragEnd() {
    dragState = null;
}

document.addEventListener('mousedown', e => {
    if (spectatorActive && !e.target.closest('#spectator, #debug-menu, #menu')) {
        spectatorDragStart(e.clientX, e.clientY);
    }
});
document.addEventListener('mousemove', e => spectatorDragMove(e.clientX, e.clientY));
document.addEventListener('mouseup', spectatorDragEnd);

document.addEventListener('touchstart', e => {
    if (spectatorActive && !e.target.closest('#spectator, #debug-menu, #menu')) {
        const t = e.touches[0];
        spectatorDragStart(t.clientX, t.clientY);
    }
});
document.addEventListener('touchmove', e => {
    if (dragState) {
        e.preventDefault();
        const t = e.touches[0];
        spectatorDragMove(t.clientX, t.clientY);
    }
}, { passive: false });
document.addEventListener('touchend', spectatorDragEnd);
document.addEventListener('touchcancel', spectatorDragEnd);

// --- Pinch to zoom ---
let pinchState = null;

document.addEventListener('touchstart', e => {
    if (spectatorActive && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        pinchState = { startDist: Math.hypot(dx, dy), origHeight: spectator.height };
    }
});
document.addEventListener('touchmove', e => {
    if (pinchState && e.touches.length === 2) {
        const dx = e.touches[0].clientX - e.touches[1].clientX;
        const dy = e.touches[0].clientY - e.touches[1].clientY;
        const dist = Math.hypot(dx, dy);
        spectator.height = Math.max(200, pinchState.origHeight * (pinchState.startDist / dist));
    }
});
document.addEventListener('touchend', () => { pinchState = null; });
document.addEventListener('touchcancel', () => { pinchState = null; });

// --- Scroll to zoom ---
document.addEventListener('wheel', e => {
    if (!spectatorActive) return;
    spectator.height = Math.max(200, spectator.height + e.deltaY * 2);
    e.preventDefault();
}, { passive: false });

// --- View mode tabs ---
const spectatorTabs = document.querySelectorAll('.spectator-tab');

function switchSpectatorMode(newMode) {
    if (spectator.mode === newMode) return;

    spectatorLoopRunning = false;

    // Reset state for the new mode
    spectator.mode = newMode;
    spectator.height = spectator.mode === 'follow' ? 300 : 3000;
    spectator.offsetX = 0;
    spectator.offsetY = 0;
    // Snap to the nearest full rotation of the player angle so the
    // transition doesn't spin back through accumulated rotations.
    const fullTurn = Math.PI * 2;
    spectator.angle = newMode === 'top'
        ? -Math.round(state.players[0].angle / fullTurn) * fullTurn
        : 0;

    orchestrator.setSpectatorCamera(spectator);
    if (spectator.mode === 'follow') {
        orchestrator.setSpectatorFollowHeight(spectator.height);
    }

    orchestrator.switchSpectatorMode(spectator.mode);

    setTimeout(() => {
        spectatorLoopRunning = true;
        spectatorLoop();
    }, 1000);

    // Update tab active state
    spectatorTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.mode === newMode));
}

spectatorTabs.forEach(tab => {
    tab.addEventListener('click', () => switchSpectatorMode(tab.dataset.mode));
});

// --- Spectator control buttons (touch/mouse) ---
if (spectatorControls) {
    for (const btn of spectatorControls.querySelectorAll('button[data-key]')) {
        const key = btn.dataset.key;
        const press = () => { spectator.keys[key] = true; btn.classList.add('pressed'); };
        const release = () => { spectator.keys[key] = false; btn.classList.remove('pressed'); };

        btn.addEventListener('mousedown', press);
        btn.addEventListener('mouseup', release);
        btn.addEventListener('mouseleave', release);
        btn.addEventListener('touchstart', (e) => { e.preventDefault(); press(); });
        btn.addEventListener('touchend', (e) => { e.preventDefault(); release(); });
        btn.addEventListener('touchcancel', release);
    }
}
