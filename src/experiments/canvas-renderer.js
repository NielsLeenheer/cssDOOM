/**
 * Experiment: Software-render the 3D scene via Canvas drawElementImage().
 *
 * Wraps #viewport inside a <canvas layoutsubtree> and paints it each frame
 * using drawElementImage(). This bypasses GPU compositing for the 3D scene,
 * working around Chrome rendering glitches with deeply nested CSS 3D transforms.
 * See: https://issues.chromium.org/issues/501115507
 *
 * Toggled via the debug menu checkbox "Canvas renderer".
 */

let active = false;
let canvas = null;
let ctx = null;
let painting = false;

export function initCanvasRenderer() {
    if (!('drawElementImage' in CanvasRenderingContext2D.prototype)) {
        console.warn(
            '[canvas-renderer] drawElementImage not available.\n' +
            'Enable: chrome://flags/#canvas-draw-element'
        );
        return null;
    }

    return { enable: enableCanvasRenderer, disable: disableCanvasRenderer };
}

function enableCanvasRenderer() {
    if (active) return;
    active = true;

    const viewport = document.getElementById('viewport');
    const renderer = viewport.parentElement; // #renderer

    // Create canvas that replaces viewport's position in the DOM
    canvas = document.createElement('canvas');
    canvas.id = 'canvas-renderer';
    canvas.setAttribute('layoutsubtree', '');
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
    canvas.style.cssText = `
        position: fixed;
        inset: 0;
        width: 100vw;
        height: 100vh;
    `;

    // Reparent: insert canvas where viewport was, move viewport inside
    renderer.insertBefore(canvas, viewport);
    canvas.appendChild(viewport);

    // Viewport fills the canvas layout box.
    // Cannot use position:fixed inside layoutsubtree — use absolute instead.
    viewport.style.position = 'absolute';
    viewport.style.inset = '0';
    viewport.style.width = '100%';
    viewport.style.height = '100%';

    ctx = canvas.getContext('2d');

    // Wait for browser to layout + paint the viewport inside the canvas
    // before starting the draw loop (avoids "no cached paint record")
    requestAnimationFrame(() => {
        requestAnimationFrame(() => {
            if (!painting) {
                painting = true;
                requestAnimationFrame(paint);
            }
            console.log('[canvas-renderer] Enabled — software rendering via drawElementImage');
        });
    });
}

function disableCanvasRenderer() {
    if (!active) return;
    active = false;

    const viewport = document.getElementById('viewport');
    const renderer = canvas.parentElement; // #renderer

    // Reparent viewport back out of the canvas
    renderer.insertBefore(viewport, canvas);
    canvas.remove();

    // Restore viewport styles
    viewport.style.position = '';
    viewport.style.inset = '';
    viewport.style.width = '';
    viewport.style.height = '';

    canvas = null;
    ctx = null;
    painting = false;

    console.log('[canvas-renderer] Disabled — back to GPU compositing');
}

function paint() {
    if (!active) { painting = false; return; }

    try {
        const viewport = document.getElementById('viewport');
        const w = canvas.width;
        const h = canvas.height;

        if (!paint.logged) {
            console.log('[canvas-renderer] paint debug:', {
                canvasCSS: `${canvas.offsetWidth}x${canvas.offsetHeight}`,
                canvasBuffer: `${w}x${h}`,
                viewportOffset: `${viewport.offsetWidth}x${viewport.offsetHeight}`,
                viewportClient: `${viewport.clientWidth}x${viewport.clientHeight}`,
                viewportStyle: viewport.style.cssText,
            });
            paint.logged = true;
        }

        // Fill red to distinguish "black from no draw" vs "black from content"
        ctx.fillStyle = 'red';
        ctx.fillRect(0, 0, w, h);

        // Test: draw a simple non-transformed test label first
        if (!paint.testEl) {
            paint.testEl = document.createElement('div');
            paint.testEl.textContent = 'drawElementImage test — if you see this, layout capture works';
            paint.testEl.style.cssText = 'position:absolute;top:10px;left:10px;color:lime;font:bold 24px monospace;z-index:999;background:rgba(0,0,0,0.8);padding:8px;';
            viewport.appendChild(paint.testEl);
        }

        ctx.drawElementImage(viewport, 0, 0, w, h);
    } catch (e) {
        if (!paint.loggedErr) {
            console.warn('[canvas-renderer] drawElementImage failed:', e);
            paint.loggedErr = true;
        }
    }

    requestAnimationFrame(paint);
}
