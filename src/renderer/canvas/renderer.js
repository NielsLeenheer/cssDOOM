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

// Internal framebuffer height. The width is derived from the pane's
// aspect ratio on resize. 200 rows matches the original game's vertical
// resolution and gives the recognisable chunky upscaled look; the world
// geometry still frames identically to the other panes because the
// projection uses the pane aspect.
const RENDER_HEIGHT = 200;
const MIN_WIDTH = 200;
const MAX_WIDTH = 640;

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

        this.software = new SoftwareRenderer();
        this._camera = null;
        this._hasScene = false;

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

        // Internal framebuffer: fixed height, width from pane aspect.
        const iw = Math.max(MIN_WIDTH,
            Math.min(MAX_WIDTH, Math.round(RENDER_HEIGHT * w / h)));
        this.internalCanvas.width = iw;
        this.internalCanvas.height = RENDER_HEIGHT;
        this.software.resize(iw, RENDER_HEIGHT, this.internalCtx);
    }

    _tick = () => {
        this._raf = requestAnimationFrame(this._tick);
        if (!this._hasScene || !this._camera) return;

        // Keep the software renderer's notion of "which player is this
        // pane" current so it hides this viewer's own billboard.
        this.software.viewerPlayerIndex = this.playerIndex;
        this.software.render(this._camera);
        this.internalCtx.putImageData(this.software.imageData, 0, 0);

        const ctx = this.ctx;
        ctx.imageSmoothingEnabled = false;
        ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
        ctx.drawImage(this.internalCanvas, 0, 0, this.canvas.width, this.canvas.height);
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
    'switchWeapon',
    'startFiring',
    'stopFiring',
    'triggerFlash',
];

for (const cmd of ENTITY_COMMANDS) {
    CanvasRenderer.prototype[cmd] = function (...args) {
        return this.software[cmd](...args);
    };
}
