/**
 * WebGLRenderer — a WebGL2 renderer that lives next to a CSSRenderer in
 * the orchestrator's target list. It exposes the exact same external
 * interface as the CSSRenderer and CanvasRenderer (kind, playerIndex,
 * paneEl, command methods) so the orchestrator's per-pane / world
 * dispatch fans to it with no special-casing — identical in shape to its
 * siblings, so the three are freely swappable.
 *
 * Where the CSSRenderer builds the scene out of CSS-transformed DOM and
 * the CanvasRenderer runs a software rasteriser, this one draws the world
 * on the GPU: a real 3D scene (perspective walls, depth-buffered
 * floors/ceilings, sky, sprite billboards) rendered at full display
 * resolution, but textured with the original game's low-res art sampled
 * NEAREST and lit with colormap-style banding — high-res geometry, old
 * low-res feel. The render logic lives in GLEngine (engine.js); this
 * class owns the canvas, the GL context, the resize/RAF lifecycle, and
 * the command forwarding.
 *
 * It is completely standalone: it never touches the game loop, only
 * receives the same world / per-player envelopes every renderer gets
 * (loadMap, updateCamera, …) and registers itself in the renderer
 * manager's lookup table as `?renderer=webgl`.
 *
 * Select with `?renderer=webgl`, optionally alongside a layout, and with
 * `?resolution=Nx` controlling the overlay/HUD chunkiness (the world
 * itself always renders at full display resolution).
 */

import { RendererBase } from '../base.js';
import { GLEngine } from './engine.js';
import * as maps from '../../shared/maps/index.js';

const MAX_RESOLUTION = 4;
const DEFAULT_RESOLUTION = 2;

// `?resolution=1x..4x` → 1..4 integer factor (defaults to 2x). Same
// parsing as the canvas renderer; here it only drives the HUD/overlay
// scale, since the 3D world is always drawn at full display resolution.
function parseResolution() {
    const v = document.body.dataset.resolution;
    if (!v) return DEFAULT_RESOLUTION;
    const m = /^(\d+)x?$/i.exec(v);
    if (!m) return DEFAULT_RESOLUTION;
    return Math.max(1, Math.min(MAX_RESOLUTION, parseInt(m[1], 10)));
}

export class WebGLRenderer extends RendererBase {
    static type = 'canvas';   // draws on a <canvas> via WebGL2, not the CSS/DOM scene

    /**
     * @param {object} options
     * @param {number} options.playerIndex   the player this renderer is for
     * @param {HTMLElement} options.gameContainer  `#game` — where the pane is appended
     */
    constructor({ playerIndex, gameContainer }) {
        super();
        // Same orchestrator marker as CSSRenderer so callers that find a
        // target by kind don't need to learn a new one (matches the
        // canvas + line renderers).
        this.kind = 'dom';
        this.playerIndex = playerIndex;

        this.paneEl = document.createElement('div');
        this.paneEl.className = 'pane pane-webgl';
        this.paneEl.dataset.player = String(playerIndex);
        this.paneEl.dataset.active = 'true';

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'webgl-render';
        this.paneEl.appendChild(this.canvas);
        gameContainer.appendChild(this.paneEl);

        this.gl = this.canvas.getContext('webgl2', {
            alpha: false,
            antialias: false,
            depth: true,
            stencil: true,
            preserveDrawingBuffer: false,
        });
        if (!this.gl) {
            // No WebGL2 — leave a visible note rather than throwing into
            // the orchestrator's dispatch loop. The pane stays inert.
            this.paneEl.textContent = 'WebGL2 unavailable';
            this._dead = true;
            return;
        }

        this.resolution = parseResolution();
        this.engine = new GLEngine(this.gl, this.resolution);
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

    /** World loadMap fans here too. Resolve through the shared `maps`
     *  store (same enrichment the CSSRenderer + CanvasRenderer use) so the
     *  thing list is already skill / multiplayer filtered. */
    async loadMap(name) {
        if (this._dead) return;
        await maps.load(name);
        this.engine.setMap(maps.mapData);
        this._hasScene = true;
    }

    /** Per-pane camera update — stash for the next frame. */
    updateCamera(cameraData) {
        this._camera = cameraData;
    }

    // ── Lifecycle ────────────────────────────────────────────────────────

    destroy() {
        if (this._raf) cancelAnimationFrame(this._raf);
        if (this._resizeObserver) this._resizeObserver.disconnect();
        if (this.engine) this.engine.destroy();
        this.paneEl.remove();
    }

    clear() {
        if (this._dead) return;
        this.engine.clear();
        this._hasScene = false;
    }

    /** Visibility is resolved by the GPU depth buffer — nothing to cull
     *  on the CPU side. */
    updateCulling() {}

    // ── Internals ────────────────────────────────────────────────────────

    _resize() {
        if (this._dead) return;
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, this.paneEl.clientWidth);
        const h = Math.max(1, this.paneEl.clientHeight);
        const bw = Math.round(w * dpr), bh = Math.round(h * dpr);
        this.canvas.width = bw;
        this.canvas.height = bh;
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
        this.engine.resize(bw, bh);
        this._paint();
    }

    _paint() {
        if (this._dead || !this._hasScene || !this._camera) return;
        this.engine.viewerPlayerIndex = this.playerIndex;
        this.engine.render(this._camera);
    }

    _tick = () => {
        this._raf = requestAnimationFrame(this._tick);
        this._paint();
    };
}

// World commands that drive live entity / view state. Each is a thin
// forwarder to the engine (which owns the scene + view state). Bound on
// the prototype so RendererBase.dispatch routes `this[cmd](...args)`
// here; commands not listed no-op automatically because the method
// simply doesn't exist. Kept identical to the canvas renderer's list.
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
    'showIntermission',
    'hideIntermission',
    'showResults',
    'hideResults',
    'showLobby',
    'hideLobby',
];

for (const cmd of ENTITY_COMMANDS) {
    WebGLRenderer.prototype[cmd] = function (...args) {
        if (this._dead) return;
        return this.engine[cmd](...args);
    };
}
