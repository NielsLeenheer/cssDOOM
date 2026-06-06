/**
 * CanvasRenderer — an experimental DOOM-style renderer that lives next
 * to a DomRenderer in the orchestrator's target list. It exposes the
 * exact same external interface (kind, playerIndex, paneEl, command
 * methods) so the orchestrator's per-pane / world dispatch fans to it
 * with no special-casing — identical in shape to the LineRenderer.
 *
 * Where the DomRenderer builds the scene out of CSS-transformed DOM and
 * the LineRenderer draws an oscilloscope wireframe, this renderer runs
 * a small software rasteriser (see software.js) that reproduces the
 * original game's look: textured walls, floors, ceilings, sky, light
 * diminishing and sprite billboards, painted into a low-resolution
 * framebuffer and upscaled with nearest-neighbour sampling for the
 * authentic chunky DOOM image.
 *
 * It is completely standalone: it never touches the game loop, only
 * receives the same world / per-player envelopes every renderer gets
 * (loadMap, updateCamera, …) and registers itself in the renderer
 * manager's lookup table as `?renderer=canvas`.
 *
 * Select with `?renderer=canvas`, optionally alongside a layout, e.g.
 * `?layout=visualize` swaps in whichever renderers that layout pins.
 */

import { RendererBase } from '../base.js';
import { SoftwareRenderer } from './software.js';
import { clearTextureCache } from './textures.js';
import * as maps from '../../shared/maps/index.js';

// Internal framebuffer base dimensions. Height matches the original
// game's vertical resolution; width is derived from the pane aspect on
// resize and clamped so degenerate aspects don't produce wild buffer
// sizes. A `?resolution=Nx` URL param multiplies all three at boot.
const RENDER_HEIGHT_BASE = 200;
const MIN_WIDTH_BASE = 200;
const MAX_WIDTH_BASE = 640;
const MAX_RESOLUTION = 4;

// `?resolution=1x..4x` → 1..4 integer factor, defaulting to 1. Any
// garbage value falls back to 1 silently rather than producing a giant
// framebuffer no machine could keep at 60 fps.
function parseResolution() {
    const v = document.body.dataset.resolution;
    if (!v) return 1;
    const m = /^(\d+)x?$/i.exec(v);
    if (!m) return 1;
    return Math.max(1, Math.min(MAX_RESOLUTION, parseInt(m[1], 10)));
}

export class CanvasRenderer extends RendererBase {
    /**
     * @param {object} options
     * @param {number} options.playerIndex   the player this renderer is for
     * @param {HTMLElement} options.gameContainer  `#game` — where the pane is appended
     */
    constructor({ playerIndex, gameContainer }) {
        super();
        // Same orchestrator marker as DomRenderer so callers that find
        // a target by kind don't need to learn a new one — matches the
        // LineRenderer's reasoning.
        this.kind = 'dom';
        this.playerIndex = playerIndex;

        this.paneEl = document.createElement('div');
        this.paneEl.className = 'pane pane-canvas';
        this.paneEl.dataset.player = String(playerIndex);
        this.paneEl.dataset.active = 'true';

        // Display canvas — sized to the pane × devicePixelRatio.
        this.canvas = document.createElement('canvas');
        this.canvas.className = 'canvas-render';
        this.paneEl.appendChild(this.canvas);
        gameContainer.appendChild(this.paneEl);
        this.ctx = this.canvas.getContext('2d');

        // Internal low-res framebuffer canvas, blitted (scaled, no
        // smoothing) onto the display canvas each frame.
        this.internalCanvas = document.createElement('canvas');
        this.internalCtx = this.internalCanvas.getContext('2d');

        // Framebuffer-resolution multiplier (1x..4x). The world is sampled
        // at `factor`× the density. The screen-space UI (HUD, weapon)
        // deliberately scales *less* than the world — `max(1, factor-1)`
        // — so at higher resolutions the bar/weapon take up relatively
        // less of the screen (a big chunky status bar reads as oversized
        // once the world is crisp). So: 1x→1, 2x→1, 3x→2, 4x→3.
        this.resolution = parseResolution();

        this.software = new SoftwareRenderer();
        this.software.uiScale = Math.max(1, this.resolution - 1);
        this._camera = null;
        this._hasScene = false;

        // Rolling frame-time stats. Shown as a small overlay on the
        // display canvas whenever `?resolution=` is explicit, so the
        // perf cost of higher resolutions is visible.
        this._frameTimes = new Float32Array(60);
        this._frameTimeIdx = 0;
        this._showStats = document.body.dataset.resolution != null;

        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(this.paneEl);
        this._resize();

        this._raf = requestAnimationFrame(this._tick);
    }

    // ── Duck-type accessors expected by the orchestrator / culler ────────
    get camera() { return this._camera; }
    get hasScene() { return this._hasScene; }

    // ── Active commands ──────────────────────────────────────────────────

    /**
     * World loadMap fans here too. Resolve the map through the shared
     * `maps` store — the same source the DomRenderer's scene builder
     * uses — rather than fetching a private copy. `maps.load` is
     * idempotent and runs the map-side enrichment (initThings), so
     * `maps.mapData.things` arrives already filtered by the selected
     * skill level and game mode and annotated with category /
     * sectorIndex / floorHeight. Reading the raw JSON ourselves would
     * bypass that filter and show enemies that don't belong to the
     * chosen difficulty. Awaiting keeps this pane a real participant in
     * the orchestrator's loadMap Promise.all round.
     */
    async loadMap(name) {
        await maps.load(name);
        this.software.setMap(maps.mapData);
        this._hasScene = true;
    }

    /** Per-pane camera update — stash for the next frame. */
    updateCamera(cameraData) {
        this._camera = cameraData;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    destroy() {
        cancelAnimationFrame(this._raf);
        this._resizeObserver.disconnect();
        this.paneEl.remove();
        clearTextureCache();
    }

    clear() {
        this.software.clear();
        this._hasScene = false;
    }

    /** Visibility is resolved by the per-pixel depth buffer — nothing
     *  to cull on the CPU side. */
    updateCulling() {}

    // ── Internals ────────────────────────────────────────────────────────

    _resize() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, this.paneEl.clientWidth);
        const h = Math.max(1, this.paneEl.clientHeight);

        // Display backing store at device resolution; CSS keeps it
        // filling the pane.
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;

        // Internal framebuffer: base dimensions multiplied by the
        // resolution factor, so the world is sampled at `factor`× the
        // density while keeping the same aspect.
        const f = this.resolution;
        const ih = RENDER_HEIGHT_BASE * f;
        const iw = Math.max(MIN_WIDTH_BASE * f,
            Math.min(MAX_WIDTH_BASE * f, Math.round(ih * w / h)));
        this.internalCanvas.width = iw;
        this.internalCanvas.height = ih;
        this.software.resize(iw, ih, this.internalCtx);

        // Repaint at the new size right away. Setting canvas.width above
        // clears the display, and browsers commonly pause requestAnimation-
        // Frame during a resize drag — so without this the view would sit
        // blank/stale until the drag ends. ResizeObserver callbacks fire
        // regardless of RAF, so painting here keeps the render live.
        this._paint();
    }

    /** Render the current frame into the framebuffer and blit it, scaled
     *  with nearest-neighbour, onto the display canvas. */
    _paint() {
        if (!this._hasScene || !this._camera) return;
        // Keep the software renderer's notion of "which player is this
        // pane" current so it hides this viewer's own billboard.
        this.software.viewerPlayerIndex = this.playerIndex;
        const t0 = performance.now();
        this.software.render(this._camera);
        this.internalCtx.putImageData(this.software.imageData, 0, 0);

        const ctx = this.ctx;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.drawImage(this.internalCanvas, 0, 0, this.canvas.width, this.canvas.height);
        const t1 = performance.now();

        // Roll the elapsed ms into a 60-frame window for the readout.
        this._frameTimes[this._frameTimeIdx] = t1 - t0;
        this._frameTimeIdx = (this._frameTimeIdx + 1) % this._frameTimes.length;
        if (this._showStats) this._drawStats();
    }

    /** Top-left frame-time overlay. Drawn on the display canvas (not the
     *  framebuffer) so the text stays crisp instead of getting upscaled
     *  with the world. */
    _drawStats() {
        let sum = 0, n = 0;
        for (let i = 0; i < this._frameTimes.length; i++) {
            const v = this._frameTimes[i];
            if (v > 0) { sum += v; n++; }
        }
        const avg = n ? sum / n : 0;
        const fps = avg > 0 ? Math.min(999, 1000 / avg) : 0;
        const dpr = window.devicePixelRatio || 1;
        const ctx = this.ctx;
        ctx.save();
        ctx.font = `${12 * dpr}px monospace`;
        ctx.textBaseline = 'top';
        const text = `${this.resolution}x  ${this.internalCanvas.width}×${this.internalCanvas.height}  ${avg.toFixed(1)} ms  ${fps.toFixed(0)} fps`;
        const m = ctx.measureText(text);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, m.width + 12 * dpr, 18 * dpr);
        ctx.fillStyle = '#ffdd55';
        ctx.fillText(text, 6 * dpr, 3 * dpr);
        ctx.restore();
    }

    _tick = () => {
        this._raf = requestAnimationFrame(this._tick);
        this._paint();
    };
}

// World commands that drive live entity state. Each is a thin forwarder
// to the software renderer, which owns the entity collections. Bound on
// the prototype so RendererBase.dispatch routes `this[cmd](...args)`
// here; commands not listed (HUD, lobby/overlay screens, …) no-op
// automatically because the method simply doesn't exist.
const ENTITY_COMMANDS = [
    'updateThingPosition',
    'reparentThingToSector',
    'collectItem',
    'uncollectItem',
    'setEnemyState',
    'setThingMoving',
    'playPlayerAttack',
    'killEnemy',
    'resetEnemy',
    'updateEnemyRotation',
    'createProjectile',
    'removeProjectile',
    'createPuff',
    'createExplosion',
    'createTeleportFog',
    'createCorpse',
    'createPlayerSprite',
    'setDoorState',
    'setLiftState',
    'switchWeapon',
    'startFiring',
    'stopFiring',
    'triggerFlash',
    'updateHud',
];

for (const cmd of ENTITY_COMMANDS) {
    CanvasRenderer.prototype[cmd] = function (...args) {
        return this.software[cmd](...args);
    };
}
