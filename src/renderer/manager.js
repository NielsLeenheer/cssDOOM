/**
 * RendererManager — single owner of the renderer lifecycle in this
 * window. Manages DomRenderers by default, plus LineRenderer /
 * FlatRenderer instances when ?visualize mode is active.
 *
 * Each window (master or joiner) has exactly one Manager instance,
 * exported as a singleton. The Manager owns the live renderer
 * registry as instance state — there's no module-level array anyone
 * else can mutate. Everything that creates, destroys, or reshapes
 * renderers goes through the Manager.
 *
 * Boundary with Orchestrator: the Manager owns DomRenderer lifecycle
 * (which renderers exist, what their `playerIndex` is, when they die).
 * Orchestrator owns dispatch (which target receives a command). The
 * Manager installs a fresh renderer into Orchestrator via
 * `orchestrator.addTarget(renderer)` after creating it, and
 * `orchestrator.removeTarget(renderer)` before destroying it.
 *
 * Both master and joiner use the same primitives. Master typically
 * holds 1–2 local renderers + sinks at the remaining slots; joiner
 * holds exactly one local renderer at its assigned slot. The shape
 * differs; the management surface does not.
 */

import { DomRenderer } from './dom/renderer.js';
import { LineRenderer } from './line/renderer.js';
import { CanvasRenderer } from './canvas/renderer.js';
import { WebGLRenderer } from './webgl/renderer.js';
import { FlatRenderer } from './flat/renderer.js';
import { ShadeRenderer } from './shade/renderer.js';
import { LightingRenderer } from './lighting/renderer.js';
import { CatRenderer } from './cat/renderer.js';
import { AxisRenderer } from './axis/renderer.js';
import { orchestrator } from '../orchestrator.js';
import { CULLING_INTERVAL, CULLING_INTERVAL_ATTRACT } from './dom/scene/culling.js';

// `?renderer=…` lookup table for the default-pane factory. Keys are
// the URL values; values are the constructors. Missing entries (or
// no `?renderer=`) fall back to DomRenderer.
const RENDERERS = {
    line:     LineRenderer,
    canvas:   CanvasRenderer,
    webgl:    WebGLRenderer,
    flat:     FlatRenderer,
    shade:    ShadeRenderer,
    lighting: LightingRenderer,
    cat:      CatRenderer,
    axis:     AxisRenderer,
    dom:      DomRenderer,
};

/** The rendering technology of a renderer kind — 'dom' (CSS/DOM scene) or
 *  'canvas' (a <canvas> framebuffer). Read by the debug panel to disable
 *  CSS-only toggles when a canvas renderer is active. Unknown kinds → 'dom'. */
export function rendererType(kind) {
    return RENDERERS[kind]?.type ?? 'dom';
}

// The renderer kinds offered in the debug picker (console
// `debug.view.renderer` + the panel dropdown), in display order. A curated
// subset of RENDERERS: `axis` is omitted because it needs an `extras.axis`
// and is pinned per-slot by the visualize/cad layouts, not selectable as a
// whole-screen renderer. Single source of truth for both pickers so they
// can't drift (they each used to hardcode their own copy).
// Ordered: real renderers first (dom, line, canvas, webgl), then the
// visualisation renderers (flat, shade, lighting, cat). The panel dropdown
// draws a divider between the two groups (see `separatorAfter` in registry.js).
export const PICKABLE_RENDERERS = ['dom', 'line', 'canvas', 'webgl', 'flat', 'shade', 'lighting', 'cat'];

// Per-layout pane composition, all static. Each layout has:
//
//   grid     — pane positioning model, written to `body.dataset.grid`.
//              Omitted = the default flex layout (#game is display:flex,
//              panes fill via flex-grow, count drives fullscreen vs
//              50/50 via `#game[data-active-renderers]`).
//              'tiled' = transform-scaled 2×2 grid keyed off
//              `data-slot`, used by the video-wall kiosk + talk
//              layouts; see viewport.css.
//
//   slots    — index-aligned with the panes the layout can build.
//              `kind` is a key of RENDERERS, or null to use ?renderer=
//              routing (default + kiosk are URL-routable; visualize +
//              cad pin specific renderers per slot). `extras` are
//              passed through to the constructor (e.g. AxisRenderer's
//              axis).
//
//   players  — gameMode → networkMode → playerIndex[]. The ARRAY
//              LENGTH is the number of slots active in this mode; the
//              VALUES are which playerIndex each slot renders. SP
//              kiosk uses `[0, 0]` because both panes mirror player 0;
//              Local DM uses `[0, 1]`; network host non-kiosk uses
//              `[0]` because the lone local pane covers player 0 and
//              the rest fill with remote sinks.
//
// `reshape` looks up `LAYOUT_SPECS[body.dataset.layout]`. If the
// chosen layout doesn't list the current (gameMode, networkMode) —
// e.g. ?layout=cad in deathmatch — reshape falls back to the
// `default` layout entirely.
const LAYOUT_SPECS = {
    default: {
        slots: [
            { kind: null },
            { kind: null },
        ],
        players: {
            singleplayer: { standalone: [0] },
            deathmatch:   { standalone: [0, 1], host: [0] },
        },
    },
    kiosk: {
        grid: 'tiled',
        slots: [
            { kind: null },
            { kind: null },
        ],
        players: {
            // SP mirror — both panes render player 0 so the right
            // monitor mirrors the left.
            singleplayer: { standalone: [0, 0] },
            deathmatch:   { standalone: [0, 1], host: [0, 1] },
        },
    },
    // ?layout=visualize SP: talk progression demo.
    // top-left wireframe, top-right black+white shade,
    // bottom-left flat-shaded, bottom-right fully textured.
    visualize: {
        grid: 'tiled',
        slots: [
            { kind: 'line' },
            { kind: 'shade' },
            { kind: 'flat' },
            { kind: 'dom' },
        ],
        players: { singleplayer: { standalone: [0, 0, 0, 0] } },
    },
    // ?layout=cad SP: three AxisRenderers + one default DomRenderer.
    // AxisRenderer overrides updateCamera to place the camera
    // perpendicular to the player on its axis.
    cad: {
        grid: 'tiled',
        slots: [
            { kind: 'axis', extras: { axis: 'z' } },
            { kind: 'axis', extras: { axis: 'y' } },
            { kind: 'axis', extras: { axis: 'x' } },
            { kind: 'dom' },
        ],
        players: { singleplayer: { standalone: [0, 0, 0, 0] } },
    },
};

// `?renderer=dom,canvas[,…]` requests an ad-hoc side-by-side renderer
// comparison: one pane per kind, all mirroring player 0 (SP only). This
// replaces the old fixed `compare` / `compare-gl` layouts — any combination
// of renderers works now. 2 kinds → flex 50/50 full height; 3–4 kinds →
// tiled 2×2 (kinds fill quadrants in order; a 3rd leaves the last quadrant
// empty). More than 4 don't fit the grid and are dropped. A single kind is
// the normal whole-screen routing handled by create() and never reaches here.
function comparisonKinds() {
    const raw = (document.body.dataset.renderer ?? '')
        .split(',').map(s => s.trim()).filter(Boolean);
    const valid = raw.filter(k => k in RENDERERS);
    const unknown = raw.filter(k => !(k in RENDERERS));
    if (unknown.length) {
        console.warn(`[renderer] unknown ?renderer kind(s): ${unknown.join(', ')} — known: ${Object.keys(RENDERERS).join(', ')}`);
    }
    if (valid.length > 4) {
        console.warn(`[renderer] ?renderer lists ${valid.length} renderers; only 4 fit the comparison grid — dropped: ${valid.slice(4).join(', ')}`);
    }
    return valid.slice(0, 4);
}

/** Synthesise a comparison layout (one pane per renderer kind) for an ad-hoc
 *  `?renderer=a,b[,…]` request. SP only — falls back to `default` in DM. */
function comparisonLayout(kinds) {
    return {
        grid: kinds.length > 2 ? 'tiled' : undefined,   // 2 → flex 50/50; 3–4 → tiled 2×2
        slots: kinds.map(kind => ({ kind })),
        players: { singleplayer: { standalone: kinds.map(() => 0) } },
    };
}

class RendererManager {
    constructor() {
        this._renderers = [];
        // Captured once at module load. Both elements live in index.html
        // and never change; the Manager holds them so DomRenderer
        // construction doesn't have to re-query the DOM each time.
        this._gameContainer = document.getElementById('game');
        this._paneTemplate = document.querySelector('#pane-template');

        // Culling-loop state. Set by startCullingLoop; null until then.
        // `_cullingFrame` is a free-running counter the stagger keys on
        // — each renderer ticks when `_cullingFrame % interval === index
        // % interval`, so panes don't all cull on the same frame.
        this._cullingHooks = null;
        this._cullingFrame = 0;
    }

    /** Live `DomRenderer` instances, in registration order. Callers may
     *  iterate but must not mutate — use create/destroy/reshape. */
    get all() {
        return this._renderers;
    }

    /**
     * Construct a new renderer for the given player, append its pane
     * to the game container, and register it. Caller (or reshape) is
     * responsible for installing it as an orchestrator target via
     * `orchestrator.addTarget`.
     *
     * Renderer kind is selected by `?renderer=…` (stashed on
     * `body.dataset.renderer` at boot). Defaults to DomRenderer. Pinned
     * layouts (visualize / cad) and the ad-hoc comparison layout pass an
     * explicit `kind` per slot, so the URL routing below only applies to
     * the URL-routable layouts (default / kiosk) and joiner panes; for a
     * comma-listed `?renderer` it picks the first kind.
     */
    create(kind, playerIndex, extras = {}) {
        // When routing via the URL (kind == null), `?renderer` may be a comma
        // list for the comparison layout — take the first kind for any
        // single-pane fallback (a joiner, or DM where comparison doesn't apply).
        const routed = kind ?? document.body.dataset.renderer?.split(',')[0].trim();
        const RendererClass = RENDERERS[routed] ?? DomRenderer;
        const renderer = new RendererClass({
            playerIndex,
            gameContainer: this._gameContainer,
            paneTemplate: this._paneTemplate,
            ...extras,
        });
        this._renderers.push(renderer);
        return renderer;
    }

    /**
     * Tear down a renderer's pane and remove it from the registry.
     * Caller is responsible for clearing any orchestrator target slot
     * that held this renderer beforehand.
     */
    destroy(renderer) {
        const i = this._renderers.indexOf(renderer);
        if (i >= 0) this._renderers.splice(i, 1);
        renderer.destroy();
    }

    /**
     * Master-side reshape: drive the local renderer set from
     * LAYOUT_SPECS based on `body.dataset.layout` + the supplied
     * mode. If the chosen layout doesn't support this mode (e.g.
     * ?layout=cad in deathmatch), reshape falls back to the `default`
     * layout entirely. Existing renderers are reused across mode
     * switches; only the tail delta is created or destroyed, and
     * playerIndex updates in place. Client windows manage their
     * single renderer separately (joiner-side) — they call create /
     * destroy directly without reshape.
     */
    reshape(gameMode, networkMode) {
        // An ad-hoc `?renderer=a,b[,…]` comparison (multiple kinds, no explicit
        // ?layout) synthesises its own layout; otherwise pick the named layout
        // (default when unset / unknown).
        const kinds = comparisonKinds();
        const explicitLayout = document.body.dataset.layout;
        let layout = (!explicitLayout && kinds.length > 1)
            ? comparisonLayout(kinds)
            : (LAYOUT_SPECS[explicitLayout ?? 'default'] ?? LAYOUT_SPECS.default);
        if (!layout.players[gameMode]?.[networkMode]) {
            layout = LAYOUT_SPECS.default;
        }
        const players = layout.players[gameMode][networkMode];

        // `body.dataset.grid` drives the pane positioning model in
        // viewport.css. Unset = the default flex layout.
        if (layout.grid) {
            document.body.dataset.grid = layout.grid;
        } else {
            delete document.body.dataset.grid;
        }

        // Tail-prune any renderers past the active slot count, then
        // tail-create to fill out missing slots from the layout's
        // slot definitions.
        while (this._renderers.length > players.length) {
            const r = this._renderers[this._renderers.length - 1];
            orchestrator.removeTarget(r);
            this.destroy(r);
        }
        while (this._renderers.length < players.length) {
            const i = this._renderers.length;
            const slot = layout.slots[i];
            orchestrator.addTarget(
                this.create(slot.kind, players[i], slot.extras ?? {}),
            );
        }

        // Refresh playerIndex + pane dataset on every active slot.
        // `data-player` follows playerIndex (CSS hide rules + "hide
        // own billboard" key off it); `data-slot` is the pane's
        // physical position (kiosk SP mirrors player 0 to both panes,
        // so data-player is identical on both and can't drive
        // positioning).
        for (let i = 0; i < players.length; i++) {
            const r = this._renderers[i];
            r.playerIndex = players[i];
            r.paneEl.dataset.player = String(players[i]);
            r.paneEl.dataset.slot = String(i);
        }
    }

    /**
     * Joiner-side bootstrap: tear down any existing renderers, drop
     * every orchestrator target, install one fresh renderer at the
     * master-assigned slot. Returns the new renderer.
     *
     * Different from `reshape(gameMode, networkMode)`: reshape is
     * master-side and computes desired count from game mode + kiosk
     * flag. Here the slot is dictated by master's ACK payload and
     * there's always exactly one local renderer afterward.
     *
     * A joiner shouldn't normally have sinks installed (that's a
     * master-only concept), but any stray target is dropped through
     * the proper bookkeeping path so the active-renderer-count
     * dataset stays accurate.
     */
    resetToJoinerSlot(slot) {
        for (const r of [...this._renderers]) {
            orchestrator.removeTarget(r);
            this.destroy(r);
        }
        // Defensive: drop any non-DomRenderer targets too.
        for (const t of [...orchestrator.targets]) {
            orchestrator.removeTarget(t);
        }
        const renderer = this.create(null, slot);
        renderer.paneEl.dataset.slot = String(slot);
        orchestrator.addTarget(renderer);
        return renderer;
    }

    /**
     * Start the per-frame culling loop. Single RAF; each tick the
     * renderer at offset `frame % interval === i % interval` runs its
     * culling pass — so 2 panes cull on alternating frames instead of
     * spiking on the same frame.
     *
     * `interval` flips to the slower attract value when
     * `hooks.isAttract()` returns true — the kiosk idle camera barely
     * moves, so 10 Hz is plenty and saves GPU work.
     *
     * Only renderer 0 collects stats — `cullingStats` in culling.js is
     * a module-global the debug overlay reads, and frame-spread would
     * otherwise make it bounce across renderers per frame. Picking
     * renderer 0 keeps the readout stable for the debug overlay's
     * SP-aligned use today. A future per-renderer debug breakdown
     * would replace this.
     *
     * Called once at boot from master.js / remote-game.js. The hooks
     * (`isAttract` / `getSpectatorActive`) come from UI modules; they
     * can't be imported from culling.js or the manager directly without
     * creating an import cycle.
     *
     * @param {object} hooks
     * @param {() => boolean} hooks.isAttract           true if attract is active.
     * @param {() => boolean} hooks.getSpectatorActive  current spectator flag.
     */
    startCullingLoop(hooks) {
        this._cullingHooks = hooks;
        const tick = () => {
            this._cullingFrame++;
            const interval = this._cullingHooks.isAttract()
                ? CULLING_INTERVAL_ATTRACT
                : CULLING_INTERVAL;
            const slot = this._cullingFrame % interval;
            const spectator = this._cullingHooks.getSpectatorActive();
            for (let i = 0; i < this._renderers.length; i++) {
                if (i % interval !== slot) continue;
                this._renderers[i].updateCulling(spectator, i === 0);
            }
            requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
    }
}

export const rendererManager = new RendererManager();
