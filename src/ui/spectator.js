/**
 * Spectator Mode — top-down map view and follow-behind camera.
 *
 * Camera transforms are defined in CSS (spectator.css) and driven by custom
 * properties. JavaScript only manages interactive state (pan, zoom, rotate)
 * and sets custom properties — no transform string composition.
 *
 * Follow mode needs NO JS animation loop — CSS computes the camera position
 * from --player-* properties using sin()/cos(). Only zoom (R/F keys) updates
 * --follow-height.
 *
 * Top-down mode uses a JS loop for keyboard-driven pan/zoom/rotate, but only
 * sets --spectator-offset-x/y, --spectator-height, --spectator-angle as custom
 * properties. CSS composes the transform.
 */

import { state } from '../game/state.js';
import { dom } from '../renderer/dom.js';

export let spectatorActive = false;
let spectatorLoopRunning = false;
const spectator = { offsetX: 0, offsetY: 0, height: 3000, angle: 0, keys: {}, mode: 'top' };
const spectatorControls = document.getElementById('spectator-controls');

/**
 * Sets spectator custom properties on the viewport element for CSS to consume.
 */
function updateSpectatorProperties() {
    const s = dom.viewport.style;
    s.setProperty('--spectator-offset-x', spectator.offsetX);
    s.setProperty('--spectator-offset-y', spectator.offsetY);
    s.setProperty('--spectator-height', spectator.height);
    s.setProperty('--spectator-angle', spectator.angle);
}

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

        updateSpectatorProperties();
        updatePlayerSprite(spectator.angle);
    } else {
        // Follow mode: CSS handles the camera transform automatically.
        // Only zoom keys need JS.
        if (spectator.keys.r) spectator.height = Math.max(100, spectator.height - spectator.height * 0.02);
        if (spectator.keys.f) spectator.height += spectator.height * 0.02;

        dom.viewport.style.setProperty('--follow-height', spectator.height);
        updatePlayerSprite(-state.players[0].angle, true);
    }
    requestAnimationFrame(spectatorLoop);
}

// --- Spectator button ---
const spectatorButton = document.getElementById('spectator-button');
if (spectatorButton) {
    spectatorButton.addEventListener('click', () => window.spectate());
}

// Player sprite rotation — same system as enemies (--heading/--mirror on sprite sheet)
// Walk animation is handled by CSS @keyframes sprite-cycle
let lastPlayerHeading = -1;
let lastPlayerMirror = -1;

function updatePlayerSprite(cameraAngle, forceBack = false) {
    const sprite = document.querySelector('#player > .sprite');
    if (!sprite) return;

    // Determine which of the 8 DOOM rotation angles to show
    let sheetRow, mirrorScale;
    if (forceBack) {
        sheetRow = 4;
        mirrorScale = 1;
    } else {
        let relAngle = cameraAngle - state.players[0].angle + Math.PI;
        relAngle = ((relAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
        const rotationIndex = (Math.floor((relAngle + Math.PI / 8) / (Math.PI / 4)) % 8) + 1;

        if (rotationIndex <= 5) {
            sheetRow = rotationIndex - 1;
            mirrorScale = 1;
        } else {
            sheetRow = 9 - rotationIndex;
            mirrorScale = -1;
        }
    }

    if (sheetRow !== lastPlayerHeading || mirrorScale !== lastPlayerMirror) {
        lastPlayerHeading = sheetRow;
        lastPlayerMirror = mirrorScale;
        sprite.style.setProperty('--heading', sheetRow);
        sprite.style.setProperty('--mirror', mirrorScale);
    }

    // Set spectator angle for CSS billboard — CSS handles the actual transform
    dom.viewport.style.setProperty('--spectator-angle', cameraAngle);
}

/**
 * Animates the .scene transform by setting an inline transition, then toggling
 * the CSS class in the next frame. The inline transition overrides the
 * `transition: none` in spectator CSS rules. A requestAnimationFrame ensures
 * the browser captures the "before" state before applying the class change.
 */
function transitionScene(duration, callback) {
    dom.scene.style.transition = `translate ${duration}s ease-in-out, rotate ${duration}s ease-in-out, transform ${duration}s ease-in-out`;
    requestAnimationFrame(() => {
        callback();
        dom.scene.addEventListener('transitionend', function onEnd(e) {
            if (e.target !== dom.scene || e.propertyName !== 'rotate') return;
            dom.scene.removeEventListener('transitionend', onEnd);
            dom.scene.style.transition = '';
        });
    });
}

/**
 * Fades ceiling elements in or out via inline transition+opacity.
 * Avoids CSS @starting-style which re-triggers continuously in Safari.
 */
function transitionCeilings(fadeIn, duration, delay = 0) {
    for (const el of dom.scene.querySelectorAll('.ceiling')) {
        if (fadeIn) {
            el.style.opacity = '0';
            el.style.transition = `opacity ${duration}s ease ${delay}s`;
            requestAnimationFrame(() => {
                el.style.opacity = '';
                el.addEventListener('transitionend', function onEnd(e) {
                    if (e.propertyName !== 'opacity') return;
                    el.removeEventListener('transitionend', onEnd);
                    el.style.transition = '';
                }, { once: true });
            });
        } else {
            el.style.transition = `opacity ${duration}s ease ${delay}s`;
            el.style.opacity = '0';
            el.addEventListener('transitionend', function onEnd(e) {
                if (e.propertyName !== 'opacity') return;
                el.removeEventListener('transitionend', onEnd);
                el.style.transition = '';
                el.style.opacity = '';
            }, { once: true });
        }
    }
}

window.spectate = function() {
    // Spectator is single-player only — the camera follows state.players[0]
    // and the controls overlay isn't routed per-pane. Refuse to enter from
    // a DM session; allow exit if somehow already active.
    if (state.mode === 'deathmatch' && !spectatorActive) {
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

        updateSpectatorProperties();
        dom.viewport.style.setProperty('--follow-height', spectator.height);
        if (spectatorControls) spectatorControls.classList.remove('hidden');

        // Fade out ceilings, then toggle spectator class which sets display:none
        transitionCeilings(false, 1.5);

        // Inline transition overrides CSS `transition: none`, then toggle class
        transitionScene(1.5, () => {
            document.body.classList.add('spectator', 'follow-mode');
        });

        // Update tab active state
        spectatorTabs.forEach(tab => tab.classList.toggle('active', tab.dataset.mode === 'follow'));

        // Start interactive loop after transition completes
        setTimeout(() => {
            if (spectatorActive) {
                updatePlayerSprite(-state.players[0].angle, true);
                spectatorLoopRunning = true;
                spectatorLoop();
            }
        }, 1500);

        console.log('Spectator mode ON. Run spectate() again to exit.');
    } else {
        spectatorLoopRunning = false;
        if (spectatorControls) spectatorControls.classList.add('hidden');

        // Inline transition overrides CSS rule, then remove class to return to FPS
        transitionScene(1, () => {
            document.body.classList.remove('spectator', 'follow-mode');
            // Ceilings go from display:none → block; fade them in with delay
            transitionCeilings(true, 1, 0.5);
        });

        console.log('Spectator mode OFF');
    }
};


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

    updateSpectatorProperties();
    if (spectator.mode === 'follow') {
        dom.viewport.style.setProperty('--follow-height', spectator.height);
    }

    // Inline transition overrides CSS rule, then toggle class
    transitionScene(1, () => {
        document.body.classList.toggle('follow-mode', spectator.mode === 'follow');
    });

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
