/**
 * RendererManager — single owner of the renderer lifecycle in this
 * window. Manages DomRenderers by default, plus LineRenderer /
 * FlatRenderer instances when ?lines mode is active.
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

import { DomRenderer } from './dom/dom-renderer.js';
import { LineRenderer } from './line/renderer.js';
import { FlatRenderer } from './flat/renderer.js';
import { orchestrator } from '../orchestrator.js';
import { CULLING_INTERVAL, CULLING_INTERVAL_ATTRACT } from './dom/scene/culling.js';

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
     * Construct a new `DomRenderer` for the given player, append its
     * pane to the game container, and register it. Caller (or reshape)
     * is responsible for installing it as an orchestrator target via
     * `orchestrator.addTarget`.
     */
    create(playerIndex) {
        const renderer = new DomRenderer({
            playerIndex,
            gameContainer: this._gameContainer,
            paneTemplate: this._paneTemplate,
        });
        this._renderers.push(renderer);
        return renderer;
    }

    /** ?lines-only: construct a LineRenderer instead of a DomRenderer
     *  for one of the panes. Same lifecycle surface (destroy / paneEl
     *  / orchestrator-target shape) so reshape + the culling loop
     *  don't need a different code path. */
    _createLineRenderer(playerIndex) {
        const renderer = new LineRenderer({
            playerIndex,
            gameContainer: this._gameContainer,
        });
        this._renderers.push(renderer);
        return renderer;
    }

    /** ?lines-only: construct a FlatRenderer (DomRenderer subclass)
     *  for the flat-shaded pane. */
    _createFlatRenderer(playerIndex) {
        const renderer = new FlatRenderer({
            playerIndex,
            gameContainer: this._gameContainer,
            paneTemplate: this._paneTemplate,
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
     * Master-side reshape: construct or destroy local renderers to
     * match what the mode needs, registering / deregistering each
     * with the orchestrator. Idempotent.
     *
     *   - SP standalone non-kiosk: 1 renderer at slot 0 (playerIndex 0).
     *   - SP standalone kiosk:     2 renderers at slots 0 + 1, both
     *                               playerIndex 0 — mirror. Player 0's
     *                               per-player commands fan to both panes
     *                               so the right monitor mirrors the left.
     *   - Local DM (deathmatch+standalone):  2 renderers, playerIndex 0 + 1.
     *   - Network host non-kiosk:  1 local renderer at slot 0. Slots 1..3
     *                               fill with sinks when remotes join.
     *   - Network host kiosk:      2 local renderers (slots 0 + 1,
     *                               playerIndex 0 + 1). Slots 2..3 sinks.
     *
     * Existing renderers are reused across mode switches; only the
     * delta count is created or destroyed, and `playerIndex` updates
     * in place for existing ones. Client windows manage their single
     * renderer separately (joiner-side) — they call create/destroy
     * directly without reshape.
     */
    reshape(gameMode, networkMode) {
        const isKiosk = document.body.classList.contains('kiosk');
        const isLines = document.body.classList.contains('lines');

        // ?lines SP: progression demo for the talk. 2×2 quadrants:
        // top-left wireframe, top-right flat-shaded, bottom-left
        // empty (placeholder for a future fourth renderer),
        // bottom-right fully textured. All three live renderers
        // render the same player (mirror). Custom layout path —
        // doesn't fit the count-based loop below.
        if (isLines && gameMode === 'singleplayer') {
            this._reshapeLines();
            return;
        }

        const mirror = gameMode === 'singleplayer' && isKiosk;
        const needsTwoLocal = (gameMode === 'deathmatch' && networkMode === 'standalone')
            || mirror
            || (gameMode === 'deathmatch' && networkMode === 'host' && isKiosk);
        const desiredCount = needsTwoLocal ? 2 : 1;

        // Tear down extras (from the end so indices stay stable).
        while (this._renderers.length > desiredCount) {
            const r = this._renderers[this._renderers.length - 1];
            orchestrator.removeTarget(r);
            this.destroy(r);
        }

        // Create missing renderers and register each as a target. New
        // renderers come in at the end of `this._renderers` so the slot
        // index is the current length.
        while (this._renderers.length < desiredCount) {
            const slot = this._renderers.length;
            const playerIndex = mirror ? 0 : slot;
            const r = this.create(playerIndex);
            orchestrator.addTarget(r);
        }

        // Update playerIndex on existing renderers in case mirror just
        // toggled. Pane element's `data-player` follows the playerIndex
        // so CSS hide rules (`body[data-game-mode] .pane[data-player="0"]`
        // …) and the player-sprite "hide own billboard" selector key
        // correctly.
        // `data-slot` tracks the pane's physical position (0 = first/left,
        // 1 = second/right) independent of which player it renders — kiosk
        // SP mirror reuses player 0 in both panes, so `data-player` is the
        // same on both and can't drive positioning.
        for (let slot = 0; slot < this._renderers.length; slot++) {
            const r = this._renderers[slot];
            r.playerIndex = mirror ? 0 : slot;
            r.paneEl.dataset.player = String(r.playerIndex);
            r.paneEl.dataset.slot = String(slot);
        }
    }

    /**
     * ?lines SP layout. Three renderers, all rendering player 0:
     *
     *   data-slot=0 (top-left)     → LineRenderer       (wireframe)
     *   data-slot=1 (top-right)    → FlatRenderer       (flat-shaded)
     *   data-slot=3 (bottom-right) → DomRenderer        (fully textured)
     *
     * Slot 2 (bottom-left) is intentionally left empty as a slot for
     * a future fourth renderer. Idempotent.
     */
    _reshapeLines() {
        const specs = [
            { kind: 'line', slot: 0 },
            { kind: 'flat', slot: 1 },
            { kind: 'dom',  slot: 3 },
        ];
        // First-time build: tear down anything already present and
        // construct the three panes in spec order. Subsequent calls
        // are no-ops (we keep the existing renderers).
        if (this._renderers.length !== specs.length) {
            while (this._renderers.length > 0) {
                const r = this._renderers.pop();
                orchestrator.removeTarget(r);
                r.destroy();
            }
            for (const spec of specs) {
                const r = spec.kind === 'line' ? this._createLineRenderer(0)
                        : spec.kind === 'flat' ? this._createFlatRenderer(0)
                        : this.create(0);
                orchestrator.addTarget(r);
            }
        }
        for (let i = 0; i < specs.length; i++) {
            const r = this._renderers[i];
            r.playerIndex = 0;
            r.paneEl.dataset.player = '0';
            r.paneEl.dataset.slot = String(specs[i].slot);
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
        const renderer = this.create(slot);
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
