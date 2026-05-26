/**
 * LineRenderer — wireframe canvas target that lives next to a
 * DomRenderer in the orchestrator's target list. Same interface
 * shape (kind, playerIndex, paneEl, command methods) so the
 * orchestrator's per-pane / world dispatch fans to it without any
 * special-casing. Used by `?visualize` mode for the talk visual: a
 * DomRenderer in one pane and this in another, side by side.
 *
 * Scene rendering is delegated to the vendored line-scene.js
 * (verbatim copy of WebAudioOscilloscope's renderer3d.js — no
 * imports, single self-contained file). Each frame we call
 * `renderScene3D(walls, camera, sectorPolygons)` which returns line
 * segments in NDC; we paint them on a 2D canvas. Only walls + sector
 * polygons participate; things / enemies / pickups / HUD are not
 * rendered (matches the "before CSS" purity of the talk demo).
 */

import { renderScene3D, setRendererSettings } from './scene.js';
import { RendererBase } from '../base.js';

// Render config. fov + nearPlane fill in the camera fields cssDOOM
// doesn't provide; line-scene.js reads them directly. line-scene
// treats `fov` as the horizontal field of view. cssDOOM's CSS
// perspective on a kiosk-style pane works out to ~60° HFOV at the
// dev viewport sizes used for the talk recording — tighten this
// number to match the side-by-side framing.
const CAMERA_DEFAULTS = { fov: Math.PI * 5 / 12, nearPlane: 0.1 };

setRendererSettings({
    drawBorder: false,
    renderFloorsCeilings: true,
});

export class LineRenderer extends RendererBase {
    /**
     * @param {object} options
     * @param {number} options.playerIndex   the player this renderer is for
     * @param {HTMLElement} options.gameContainer  `#game` — where the pane is appended
     */
    constructor({ playerIndex, gameContainer }) {
        super();
        // Same orchestrator marker as DomRenderer so callers that
        // already know how to find a 'dom' target don't have to learn
        // a new kind for the lines pane. Findability-by-kind is mainly
        // used by master.js's onLeave → grace-rebuild path which
        // doesn't apply to a non-network local-only renderer like this
        // one, so the shared kind is safe.
        this.kind = 'dom';
        this.playerIndex = playerIndex;

        this.paneEl = document.createElement('div');
        this.paneEl.className = 'pane pane-line';
        this.paneEl.dataset.player = String(playerIndex);
        this.paneEl.dataset.active = 'true';

        this.canvas = document.createElement('canvas');
        this.canvas.className = 'line-canvas';
        this.paneEl.appendChild(this.canvas);
        gameContainer.appendChild(this.paneEl);

        this.ctx = this.canvas.getContext('2d');

        // Scene data, populated by loadMap.
        this._walls = null;
        this._sectorPolygons = null;

        // Latest cssDOOM camera, populated by updateCamera. Adapter
        // applied per-frame in render() so we don't mutate the
        // incoming object (it's shared with the audio listener etc.).
        this._camera = null;

        // Resize observer keeps the canvas backing store aligned with
        // the displayed size. DomRenderer uses ResizeObserver for its
        // perspective recompute; we reuse the pattern.
        this._resizeObserver = new ResizeObserver(() => this._resize());
        this._resizeObserver.observe(this.paneEl);

        this._raf = requestAnimationFrame(this._tick);
    }

    // ── Duck-type accessors expected by orchestrator / culler ───────────
    // updateCulling guards on `!this.camera || !this.hasScene`, so
    // returning null camera before updateCamera fires keeps the
    // culler quiet without a special-case branch. hasScene is true
    // once a map is loaded — the canvas has something to draw.
    get camera() { return this._camera; }
    get hasScene() { return this._walls != null; }

    // ── Active commands ─────────────────────────────────────────────────

    /**
     * World loadMap fans here too. Fetch the map JSON (same path
     * DomRenderer uses) and stash the bits line-scene.js needs.
     * Returns the fetch promise so `orchestrator.loadMap`'s
     * Promise.all sees us as a real participant in the load round
     * (matches DomRenderer's async loadMap return).
     */
    async loadMap(name) {
        const response = await fetch(`maps/${name}.json`);
        const data = await response.json();
        this._walls = data.walls;
        this._sectorPolygons = data.sectorPolygons;
    }

    /**
     * Per-pane updateCamera. Stash the cssDOOM camera; per-frame
     * render() converts to the line-scene angle convention (cssDOOM
     * uses 0=north; line-scene uses 0=east).
     */
    updateCamera(cameraData) {
        this._camera = cameraData;
    }

    // ── Lifecycle ───────────────────────────────────────────────────────

    /** Match DomRenderer's destroy contract — orchestrator + manager
     *  call this when reshaping or shutting down. */
    destroy() {
        cancelAnimationFrame(this._raf);
        this._resizeObserver.disconnect();
        this.paneEl.remove();
    }

    /** No-op equivalent of DomRenderer.clear (which tears the pane's
     *  scene DOM down). We have nothing to clear that the next
     *  loadMap won't overwrite. */
    clear() {
        this._walls = null;
        this._sectorPolygons = null;
    }

    /** Called by the manager's culling loop. Wireframe needs no
     *  culling — line-scene's own depth buffer handles visibility. */
    updateCulling() {}

    // ── Internals ───────────────────────────────────────────────────────

    _resize() {
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, this.paneEl.clientWidth);
        const h = Math.max(1, this.paneEl.clientHeight);
        this.canvas.width = Math.round(w * dpr);
        this.canvas.height = Math.round(h * dpr);
        this.canvas.style.width = `${w}px`;
        this.canvas.style.height = `${h}px`;
        // Keep line-scene's depth buffer aspect matched to the canvas
        // so the perspective math doesn't squash vertically. The
        // perspective formulas in line-scene divide by `aspect =
        // depthBufferWidth / depthBufferHeight`; if that drifts from
        // the canvas aspect, the horizon ends up too high or low.
        // 400 px baseline keeps the visibility-test resolution
        // comparable to the default 640×400.
        setRendererSettings({
            depthBufferWidth: Math.max(1, Math.round(400 * w / h)),
            depthBufferHeight: 400,
        });
    }

    _tick = () => {
        this._raf = requestAnimationFrame(this._tick);
        if (!this._walls || !this._camera) return;
        const camera = {
            x: this._camera.x,
            y: this._camera.y,
            z: this._camera.z,
            // cssDOOM player.angle: empirically decreases when player
            // turns right (despite the camera.js comment saying
            // "increasing clockwise"). Pass through unmodified so the
            // wireframe rotates the same way as the cssDOOM panes —
            // negation reversed it.
            angle: this._camera.angle,
            ...CAMERA_DEFAULTS,
        };
        const lines = renderScene3D(this._walls, camera, this._sectorPolygons);
        this._paint(lines);
    };

    // CRT phosphor glow passes. Each entry is one stroke layer: width
    // in CSS px, RGBA color. Painted in order under
    // `globalCompositeOperation = 'lighter'` so overlapping strokes
    // accumulate intensity additively — wide low-alpha pass lays a
    // soft green bleed, medium pass thickens the halo, narrow
    // near-white pass paints the hot core last. Tune widths/alphas
    // here to taste; no other knobs.
    static GLOW_PASSES = [
        { width: 28, color: 'rgba(0, 255, 40, 0.05)' },
        { width: 16, color: 'rgba(0, 255, 40, 0.10)' },
        { width: 8,  color: 'rgba(0, 255, 40, 0.22)' },
        { width: 3,  color: 'rgba(40, 255, 40, 0.55)' },
        { width: 1.2, color: '#80ff80' },
    ];

    _paint(lines) {
        const { ctx } = this;
        const w = this.canvas.width;
        const h = this.canvas.height;
        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        if (!lines.length) return;

        // Build the path once, stroke it once per glow pass. Round
        // caps/joins keep the halo continuous through segment ends.
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.beginPath();
        for (const seg of lines) {
            // line-scene returns segments in NDC ([-1, 1]). Map to
            // canvas pixels: x ∈ [0, w], y ∈ [0, h] with +y down.
            const x1 = (seg.start[0] * 0.5 + 0.5) * w;
            const y1 = (1 - (seg.start[1] * 0.5 + 0.5)) * h;
            const x2 = (seg.end[0] * 0.5 + 0.5) * w;
            const y2 = (1 - (seg.end[1] * 0.5 + 0.5)) * h;
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
        }

        const dpr = window.devicePixelRatio || 1;
        ctx.globalCompositeOperation = 'lighter';
        for (const pass of LineRenderer.GLOW_PASSES) {
            ctx.lineWidth = pass.width * dpr;
            ctx.strokeStyle = pass.color;
            ctx.stroke();
        }
        ctx.globalCompositeOperation = 'source-over';
    }
}

// Commands not implemented above no-op automatically via
// RendererBase.dispatch — it checks `typeof this[command] === 'function'`
// and skips if absent. So no manual no-op loop is needed here; the
// orchestrator's dispatch into commands the line renderer doesn't
// care about (updateHud, createCorpse, lobby/overlay commands…)
// quietly falls through.
