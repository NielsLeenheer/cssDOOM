/**
 * Experiment: HTML-in-Canvas monitor on wall ld377 (COMPUTE2 screen in E1M1).
 *
 * Uses the Canvas drawElementImage() API (chrome://flags/#canvas-draw-element)
 * to render a live iframe onto a <canvas layoutsubtree> positioned in the 3D
 * scene, creating an in-game computer monitor showing a real web page.
 *
 * This module is self-contained — it hooks into the scene after build
 * and does not modify any existing game/renderer code.
 */

const WALL_ID = 'ld377';

// Wall geometry from E1M1 map data (hardcoded to avoid coupling)
const START_X = 1600;
const START_Y = -2752;
const END_X = 1600;
const END_Y = -2624;
const FLOOR_Z = 32;
const CEIL_Z = 88;

const WALL_LENGTH = Math.sqrt((END_X - START_X) ** 2 + (END_Y - START_Y) ** 2); // 128
const WALL_HEIGHT = CEIL_Z - FLOOR_Z; // 56

// Canvas resolution — higher than wall pixel size for readable text
const CANVAS_W = 640;
const CANVAS_H = 280;

export function initMonitor() {
    if (!('drawElementImage' in CanvasRenderingContext2D.prototype)) {
        console.warn(
            '[monitor] drawElementImage not available.\n' +
            'Enable: chrome://flags/#canvas-draw-element'
        );
        return null;
    }

    return { enable: enableMonitor, disable: disableMonitor };
}

let canvas = null;
let iframe = null;
let ctx = null;
let painting = false;
let monitorMode = false;

function enableMonitor() {
    if (canvas) return;

    const scene = document.getElementById('scene');
    if (!scene) return;

    // Hide the original wall texture so the canvas replaces it
    const wall = document.getElementById(WALL_ID);
    if (wall) wall.style.visibility = 'hidden';

    // --- Canvas setup ---
    canvas = document.createElement('canvas');
    canvas.setAttribute('layoutsubtree', '');
    canvas.width = CANVAS_W;
    canvas.height = CANVAS_H;

    // Position the canvas exactly where the wall is in 3D space.
    // CSS size is CANVAS_W×CANVAS_H so the iframe gets a usable viewport,
    // then scaled down to wall dimensions (128×56) via the transform.
    const deltaX = END_X - START_X;
    const deltaY = END_Y - START_Y;
    const angle = Math.atan2(deltaY, deltaX);
    const scaleX = WALL_LENGTH / CANVAS_W;
    const scaleY = WALL_HEIGHT / CANVAS_H;

    canvas.style.cssText = `
        width: ${CANVAS_W}px;
        height: ${CANVAS_H}px;
        transform-origin: 0 0;
        transform:
            translate3d(${START_X + 1}px, ${-CEIL_Z}px, ${-START_Y}px)
            rotateY(${angle}rad)
            scale(${scaleX}, ${scaleY});
        image-rendering: auto;
        backface-visibility: hidden;
    `;

    // --- Iframe (inside canvas, rendered via drawElementImage) ---
    iframe = document.createElement('iframe');
    iframe.src = 'http://localhost:5174';
    iframe.style.cssText = `
        position: absolute;
        top: 4px; left: 4px;
        width: calc(100% - 8px);
        height: calc(100% - 8px);
        border: none;
    `;
    canvas.appendChild(iframe);

    scene.appendChild(canvas);
    ctx = canvas.getContext('2d');

    // Start paint loop after a couple frames to ensure layout/paint records exist
    painting = true;
    requestAnimationFrame(() => requestAnimationFrame(paint));

    console.log('[monitor] Canvas monitor active on', WALL_ID, '(press M to interact)');
}

function disableMonitor() {
    if (!canvas) return;

    if (monitorMode) exitMonitorMode();

    painting = false;
    canvas.remove();
    canvas = null;
    iframe = null;
    ctx = null;

    // Restore the original wall texture
    const wall = document.getElementById(WALL_ID);
    if (wall) wall.style.visibility = '';

    console.log('[monitor] Disabled');
}

    // Paint loop — dark green border, then iframe content
    function paint() {
        if (!painting) return;
        ctx.fillStyle = '#003300';
        ctx.fillRect(0, 0, CANVAS_W, CANVAS_H);

        try {
            ctx.drawElementImage(iframe, 4, 4, CANVAS_W - 8, CANVAS_H - 8);
        } catch (e) {
            if (!paint.loggedIframe) {
                console.warn('[monitor] drawElementImage(iframe) failed:', e);
                paint.loggedIframe = true;
            }
        }

        requestAnimationFrame(paint);
    }

// =========================================================================
// Monitor interaction mode — press M to focus the in-world iframe
// =========================================================================

function enterMonitorMode() {
    if (monitorMode || !canvas) return;
    monitorMode = true;
    document.exitPointerLock();
    canvas.style.pointerEvents = 'auto';
    iframe.style.pointerEvents = 'auto';
    iframe.focus();
    console.log('[monitor] Entered monitor mode');
}

function exitMonitorMode() {
    if (!monitorMode) return;
    monitorMode = false;
    if (canvas) canvas.style.pointerEvents = '';
    if (iframe) iframe.style.pointerEvents = '';
    console.log('[monitor] Exited monitor mode');
}

document.addEventListener('keydown', (e) => {
    if (!canvas) return;
    if (e.code === 'KeyM' && !e.repeat) {
        if (monitorMode) {
            exitMonitorMode();
        } else {
            enterMonitorMode();
        }
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
    }
    if (monitorMode && e.code === 'Escape') {
        exitMonitorMode();
        e.stopImmediatePropagation();
        e.preventDefault();
        return;
    }
    // Block all other keys from reaching the game while in monitor mode
    if (monitorMode) {
        e.stopImmediatePropagation();
    }
}, true);

// Block mouse events from reaching the game while in monitor mode
for (const evt of ['mousedown', 'mouseup', 'mousemove', 'click']) {
    document.addEventListener(evt, (e) => {
        if (monitorMode) {
            e.stopImmediatePropagation();
        }
    }, true);
}
