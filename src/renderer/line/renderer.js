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

import { renderScene3D, setRendererSettings, snapLinesToGrid, mergeCollinearLines, dropParallelDuplicates, getDepthBuffer } from './scene.js';
import { RendererBase } from '../base.js';
import { canvasStats } from '../canvas/renderer.js';

// Line-reduction pipeline, shared across LineRenderer instances and toggled
// from the debug panel (Renderer section):
//   snap  — snap endpoints to a uniform grid + dedup (default). Keeps junctions
//           connected, drops sub-grid stubs, never repositions a line.
//   merge — collinear merge on top of snap (default). With snap first, its
//           tolerances are tied to the grid so it only joins segments already on
//           the same grid line — no perpendicular repositioning, so junctions
//           stay connected and nothing shifts into/out of occlusion.
//   dropParallel — drop a shorter near-parallel line when it sits within
//           dropPerpTol (NDC, screen space) of a longer one and is mostly
//           overlapped by it. The kept line doesn't move (no jitter); distance-
//           dependent for free, since recessed-opening edges only converge on
//           screen far away. A dropped line can pop back when you approach.
//   gridSize — snap grid cell in NDC (settable by hand: lineReduction.gridSize).
export const lineReduction = { snap: true, merge: true, dropParallel: true, gridSize: 0.005, dropPerpTol: 0.02 };

// Scene-geometry toggles, shared across LineRenderer instances and applied to
// the scene each frame. cullInteriorFaces is exposed in the debug panel
// (Culling section); depthEpsilon / minVisibleSamples are console-tunable.
//   cullInteriorFaces — drop wall quads buried below their sector floor / above
//                       its ceiling (kills back-side leak stubs).
//   depthResScale — multiplier on the 400px depth-buffer baseline. Higher
//                   resolves thin distant near-edge-on lines that would
//                   otherwise dash, at ~scale² visibility-fill cost (applied on
//                   the next resize).
export const lineScene = { cullInteriorFaces: true, depthEpsilon: 0.025, minVisibleSamples: 3, depthResScale: 3 };

// Debug visualisation toggles (renderer-side, not scene settings). showDepthBuffer
// draws the scene's depth buffer over the wireframe (nearest-neighbour, so its
// grid resolution is visible) with the line segments overlaid in red — to see
// where occlusion stubs leak relative to the depth grid. Exposed in the debug
// panel (Renderer → "Depth buffer").
export const lineDebug = { showDepthBuffer: false, showTriangles: false };

// Render config. fov + nearPlane fill in the camera fields cssDOOM
// doesn't provide; line-scene.js reads them directly. line-scene
// treats `fov` as the horizontal field of view. cssDOOM's CSS
// perspective on a kiosk-style pane reads slightly wider in
// practice than the dev-time ~60° estimate; 90° widens the line
// wireframe to match the textured pane's framing side-by-side.
const CAMERA_DEFAULTS = { fov: Math.PI / 2, nearPlane: 0.1 };

setRendererSettings({
    drawBorder: false,
    renderFloorsCeilings: true,
});

export class LineRenderer extends RendererBase {
    static type = 'canvas';   // draws on a <canvas>, not the CSS/DOM scene

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

        // Half-resolution offscreen canvas for the wide bloom passes.
        // The rasterizer cost of a stroke scales with (width × path
        // length); the widest pass (28px) alone fills more pixels
        // than the other four combined. Painting them onto a half-
        // res buffer cuts that work by ~4× and the upscaled blur is
        // visually indistinguishable from a full-res stroke at the
        // same source widths. The thin core stays on the main canvas
        // to keep the centre line crisp.
        this.glowCanvas = document.createElement('canvas');
        this.glowCtx = this.glowCanvas.getContext('2d');

        // Offscreen canvas for the depth-buffer debug overlay (sized to the
        // depth buffer; upscaled nearest-neighbour so the grid shows).
        this._depthCanvas = document.createElement('canvas');
        this._depthCtx = this._depthCanvas.getContext('2d');
        this._depthImage = null;

        // Scene data, populated by loadMap.
        this._walls = null;
        this._sectorPolygons = null;

        // Latest cssDOOM camera, populated by updateCamera. Adapter
        // applied per-frame in render() so we don't mutate the
        // incoming object (it's shared with the audio listener etc.).
        this._camera = null;

        // Stats for the overlay (gated by the shared canvasStats toggle —
        // the same Renderer → "Stats" checkbox the CanvasRenderer uses).
        // Frame times roll through a 60-frame window for a stable ms/fps
        // readout; line counts are the latest frame's raw total plus the
        // result of each reduction pass so the two can be compared live.
        this._frameTimes = new Float32Array(60);
        this._frameTimeIdx = 0;
        this._rawLineCount = 0;
        this._lineCount = 0;

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
        // Glow buffer sized at half the main canvas in each
        // dimension — quarter the pixel count for the wide bloom
        // strokes.
        this.glowCanvas.width = Math.max(1, Math.round(this.canvas.width / 2));
        this.glowCanvas.height = Math.max(1, Math.round(this.canvas.height / 2));
        // Keep line-scene's depth buffer aspect matched to the canvas
        // so the perspective math doesn't squash vertically. The
        // perspective formulas in line-scene divide by `aspect =
        // depthBufferWidth / depthBufferHeight`; if that drifts from
        // the canvas aspect, the horizon ends up too high or low.
        // 400 px baseline keeps the visibility-test resolution
        // comparable to the default 640×400. lineScene.depthResScale
        // multiplies it: higher = fewer dashed distant lines (thin
        // near-edge-on silhouettes resolve), at ~scale² fill cost.
        // Changing it takes effect on the next resize.
        const dh = Math.max(1, Math.round(400 * (lineScene.depthResScale || 1)));
        setRendererSettings({
            depthBufferWidth: Math.max(1, Math.round(dh * w / h)),
            depthBufferHeight: dh,
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
        const t0 = performance.now();
        // Push the live scene-geometry toggles (cheap Object.assign; no depth
        // realloc since dimensions are unchanged here — those come from _resize).
        setRendererSettings(lineScene);
        const rawLines = renderScene3D(this._walls, camera, this._sectorPolygons);
        // Reduce redundant strokes before painting (cheaper for a real
        // oscilloscope to draw): grid-snap + dedup, plus optional collinear merge.
        let lines = rawLines;
        const g = lineReduction.gridSize;
        if (lineReduction.snap) lines = snapLinesToGrid(lines, g);
        if (lineReduction.merge) {
            // Tolerances tied to the grid: only join segments already on the same
            // grid line (offsetTol < one cell), so the merge never moves a line
            // perpendicular. gapTol bridges the ~1-cell sampling gaps between
            // adjacent visible wall edges, not wide occlusion gaps.
            lines = mergeCollinearLines(lines, { offsetTol: g * 0.5, angleTol: 0.04, gapTol: g * 1.5 });
        }
        if (lineReduction.dropParallel) {
            lines = dropParallelDuplicates(lines, { perpTol: lineReduction.dropPerpTol });
        }
        this._paint(lines);
        const t1 = performance.now();

        this._frameTimes[this._frameTimeIdx] = t1 - t0;
        this._frameTimeIdx = (this._frameTimeIdx + 1) % this._frameTimes.length;
        this._rawLineCount = rawLines.length;
        this._lineCount = lines.length;
        if (canvasStats.enabled) this._drawStats();
    };

    /** Top-left overlay: frame time, fps, and line counts for both reduction
     *  passes (the active one bracketed). Drawn on the display canvas after the
     *  wireframe so the text stays crisp. Mirrors CanvasRenderer._drawStats;
     *  gated by the same shared canvasStats flag. */
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
        const raw = this._rawLineCount;
        const kept = this._lineCount;
        const pct = raw > 0 ? Math.round((1 - kept / raw) * 100) : 0;
        const mode = (lineReduction.snap ? 'snap' : '') + (lineReduction.merge ? '+merge' : '') || 'raw';
        const text = `${kept}/${raw} lines (-${pct}%) ${mode}  ${avg.toFixed(1)} ms  ${fps.toFixed(0)} fps`;
        ctx.save();
        ctx.globalCompositeOperation = 'source-over';
        ctx.font = `${12 * dpr}px monospace`;
        ctx.textBaseline = 'top';
        const m = ctx.measureText(text);
        ctx.fillStyle = 'rgba(0, 0, 0, 0.55)';
        ctx.fillRect(0, 0, m.width + 12 * dpr, 18 * dpr);
        ctx.fillStyle = '#ffdd55';
        ctx.fillText(text, 6 * dpr, 3 * dpr);
        ctx.restore();
    }

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
        if (lineDebug.showTriangles) { this._paintTriangles(lines); return; }
        if (lineDebug.showDepthBuffer) { this._paintDepthDebug(lines); return; }
        const { ctx, glowCtx } = this;
        const w = this.canvas.width;
        const h = this.canvas.height;
        const gw = this.glowCanvas.width;
        const gh = this.glowCanvas.height;
        const dpr = window.devicePixelRatio || 1;

        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        if (!lines.length) return;

        // ── Wide bloom passes on the half-res glow buffer ──────────
        // All wide passes except the thin core paint here. Same NDC
        // → pixel mapping, but the canvas is half size so widths
        // halve too. globalCompositeOperation = 'lighter' makes the
        // overlapping strokes accumulate additively, same as before.
        glowCtx.globalCompositeOperation = 'source-over';
        glowCtx.clearRect(0, 0, gw, gh);
        glowCtx.beginPath();
        for (const seg of lines) {
            const x1 = (seg.start[0] * 0.5 + 0.5) * gw;
            const y1 = (1 - (seg.start[1] * 0.5 + 0.5)) * gh;
            const x2 = (seg.end[0] * 0.5 + 0.5) * gw;
            const y2 = (1 - (seg.end[1] * 0.5 + 0.5)) * gh;
            glowCtx.moveTo(x1, y1);
            glowCtx.lineTo(x2, y2);
        }
        glowCtx.globalCompositeOperation = 'lighter';
        glowCtx.lineCap = 'butt';
        glowCtx.lineJoin = 'miter';
        const passes = LineRenderer.GLOW_PASSES;
        for (let i = 0; i < passes.length - 1; i++) {
            const pass = passes[i];
            glowCtx.lineWidth = pass.width * dpr * 0.5;
            glowCtx.strokeStyle = pass.color;
            glowCtx.stroke();
        }

        // Composite the bloom buffer back at 2×. Two cost cuts here:
        //
        //   - imageSmoothingEnabled = false → nearest-neighbor
        //     upscale, no bilinear sampling. The multi-pass additive
        //     glow already softens pixel boundaries, so the
        //     blockiness isn't visible against the bloom.
        //
        //   - globalCompositeOperation = 'source-over' (NOT 'lighter')
        //     — the main canvas is freshly cleared to black at this
        //     point, so additive over black is equivalent to a plain
        //     copy. Avoiding 'lighter' here saves a read-modify-
        //     write per destination pixel (Firefox's bottleneck when
        //     painting at full canvas size). The thin core pass
        //     below switches back to 'lighter' to add onto the glow.
        ctx.globalCompositeOperation = 'source-over';
        ctx.imageSmoothingEnabled = false;
        ctx.drawImage(this.glowCanvas, 0, 0, w, h);

        // ── Thin core pass on the main canvas ──────────────────────
        // Crisp centre line; round caps soften segment tips.
        ctx.beginPath();
        for (const seg of lines) {
            const x1 = (seg.start[0] * 0.5 + 0.5) * w;
            const y1 = (1 - (seg.start[1] * 0.5 + 0.5)) * h;
            const x2 = (seg.end[0] * 0.5 + 0.5) * w;
            const y2 = (1 - (seg.end[1] * 0.5 + 0.5)) * h;
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2, y2);
        }
        const core = passes[passes.length - 1];
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';
        ctx.lineWidth = core.width * dpr;
        ctx.strokeStyle = core.color;
        ctx.stroke();
        ctx.globalCompositeOperation = 'source-over';
    }

    /** Debug view: draw each segment as a triangle — pointy tip at the start,
     *  wide base at the end — with additive blending. Direction is then obvious
     *  (tip→base = start→end), and segments drawn on top of each other show up
     *  as brighter overlaps, so collapsing / duplicate lines are visible. */
    _paintTriangles(lines) {
        const { ctx } = this;
        const w = this.canvas.width, h = this.canvas.height;
        const dpr = window.devicePixelRatio || 1;
        const baseHalf = 5 * dpr; // half-width of the triangle base (at the end)

        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);
        if (!lines.length) return;

        ctx.globalCompositeOperation = 'lighter'; // overlaps accumulate brightness
        ctx.fillStyle = 'rgba(40, 255, 80, 0.5)';
        for (const seg of lines) {
            const x1 = (seg.start[0] * 0.5 + 0.5) * w;          // tip = start
            const y1 = (1 - (seg.start[1] * 0.5 + 0.5)) * h;
            const x2 = (seg.end[0] * 0.5 + 0.5) * w;            // base centre = end
            const y2 = (1 - (seg.end[1] * 0.5 + 0.5)) * h;
            let dx = x2 - x1, dy = y2 - y1;
            const len = Math.hypot(dx, dy) || 1;
            dx /= len; dy /= len;
            const px = -dy * baseHalf, py = dx * baseHalf; // perpendicular at the base
            ctx.beginPath();
            ctx.moveTo(x1, y1);
            ctx.lineTo(x2 + px, y2 + py);
            ctx.lineTo(x2 - px, y2 - py);
            ctx.closePath();
            ctx.fill();
        }
        ctx.globalCompositeOperation = 'source-over';
    }

    /** Debug view: the depth buffer as a grayscale image (near = bright, far =
     *  dark, empty = dark blue), upscaled nearest-neighbour so the buffer's grid
     *  resolution is visible, with the line segments overlaid in red. Lets us
     *  see where occlusion stubs leak relative to the depth grid. */
    _paintDepthDebug(lines) {
        const { ctx } = this;
        const w = this.canvas.width, h = this.canvas.height;
        const dpr = window.devicePixelRatio || 1;
        const { buffer, width, height } = getDepthBuffer();

        ctx.globalCompositeOperation = 'source-over';
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);

        if (buffer) {
            if (this._depthCanvas.width !== width || this._depthCanvas.height !== height) {
                this._depthCanvas.width = width;
                this._depthCanvas.height = height;
                this._depthImage = this._depthCtx.createImageData(width, height);
            }
            // Normalise finite depths to [min,max] for contrast.
            let min = Infinity, max = 0;
            for (let i = 0; i < buffer.length; i++) {
                const d = buffer[i];
                if (d !== Infinity) { if (d < min) min = d; if (d > max) max = d; }
            }
            const range = max > min ? max - min : 1;
            const data = this._depthImage.data;
            for (let i = 0; i < buffer.length; i++) {
                const d = buffer[i];
                const j = i * 4;
                if (d === Infinity) { data[j] = 0; data[j + 1] = 0; data[j + 2] = 48; data[j + 3] = 255; continue; }
                const g = Math.round(255 * (1 - (d - min) / range)); // near = bright
                data[j] = g; data[j + 1] = g; data[j + 2] = g; data[j + 3] = 255;
            }
            this._depthCtx.putImageData(this._depthImage, 0, 0);
            ctx.imageSmoothingEnabled = false;
            ctx.drawImage(this._depthCanvas, 0, 0, w, h);
        }

        // Overlay the actual line segments in red so leaks are visible on the grid.
        ctx.beginPath();
        for (const seg of lines) {
            ctx.moveTo((seg.start[0] * 0.5 + 0.5) * w, (1 - (seg.start[1] * 0.5 + 0.5)) * h);
            ctx.lineTo((seg.end[0] * 0.5 + 0.5) * w, (1 - (seg.end[1] * 0.5 + 0.5)) * h);
        }
        ctx.lineCap = 'round';
        ctx.lineWidth = 1.5 * dpr;
        ctx.strokeStyle = '#ff3030';
        ctx.stroke();
    }
}

// Commands not implemented above no-op automatically via
// RendererBase.dispatch — it checks `typeof this[command] === 'function'`
// and skips if absent. So no manual no-op loop is needed here; the
// orchestrator's dispatch into commands the line renderer doesn't
// care about (updateHud, createCorpse, lobby/overlay commands…)
// quietly falls through.
