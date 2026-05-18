/**
 * DomRendererManager — single owner of the DomRenderer lifecycle in this
 * window.
 *
 * Each window (master or joiner) has exactly one Manager instance,
 * exported as a singleton. The Manager owns the live `DomRenderer`
 * registry as instance state — there's no module-level array anyone
 * else can mutate. Everything that creates, destroys, or reshapes
 * renderers goes through the Manager.
 *
 * Boundary with Orchestrator: the Manager owns DomRenderer lifecycle
 * (which renderers exist, what their `playerIndex` is, when they die).
 * Orchestrator owns dispatch (which target receives a command). The
 * Manager installs a fresh renderer into Orchestrator via
 * `orchestrator.replaceTarget(slot, renderer)` after creating it, and
 * clears the slot before destroying it.
 *
 * Both master and joiner use the same primitives. Master typically
 * holds 1–2 local renderers + sinks at the remaining slots; joiner
 * holds exactly one local renderer at its assigned slot. The shape
 * differs; the management surface does not.
 */

import { DomRenderer } from './dom-renderer.js';
import { orchestrator } from '../orchestrator.js';
import { CULLING_INTERVAL, CULLING_INTERVAL_ATTRACT } from './scene/culling.js';

class DomRendererManager {
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
     * `orchestrator.replaceTarget` at the right slot.
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
     * match what the mode needs, and keep the orchestrator's `targets[]`
     * in sync. Idempotent.
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
        const mirror = gameMode === 'singleplayer' && isKiosk;
        const needsTwoLocal = (gameMode === 'deathmatch' && networkMode === 'standalone')
            || mirror
            || (gameMode === 'deathmatch' && networkMode === 'host' && isKiosk);
        const desiredCount = needsTwoLocal ? 2 : 1;

        // Tear down extras (from the end so indices stay stable).
        while (this._renderers.length > desiredCount) {
            const r = this._renderers[this._renderers.length - 1];
            const slot = orchestrator.targets.indexOf(r);
            if (slot >= 0) orchestrator.replaceTarget(slot, null);
            this.destroy(r);
        }

        // Create missing renderers at the next free slot.
        while (this._renderers.length < desiredCount) {
            const slot = this._renderers.length;
            const playerIndex = mirror ? 0 : slot;
            const r = this.create(playerIndex);
            orchestrator.replaceTarget(slot, r);
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
     * Joiner-side bootstrap: tear down any existing renderers, clear
     * every orchestrator target slot, install one fresh renderer at the
     * master-assigned slot. Returns the new renderer.
     *
     * Different from `reshape(gameMode, networkMode)`: reshape is
     * master-side and computes desired count from game mode + kiosk
     * flag. Here the slot is dictated by master's ACK payload and
     * there's always exactly one local renderer afterward.
     *
     * Tear-down and target-clearing both go through the Manager + the
     * Orchestrator's bookkeeping methods (no direct touch of
     * `this._renderers` from outside, no direct write to
     * `orchestrator.targets[i]` — `replaceTarget` keeps
     * `#game[data-active-renderers]` in sync).
     */
    resetToJoinerSlot(slot) {
        // Drop any existing renderers, unhooking each from its
        // orchestrator slot through replaceTarget so the active-
        // renderer-count dataset stays accurate.
        for (const r of [...this._renderers]) {
            const slotOfR = orchestrator.targets.indexOf(r);
            if (slotOfR >= 0) orchestrator.replaceTarget(slotOfR, null);
            this.destroy(r);
        }
        // Clear any non-renderer targets at other slots (a joiner
        // shouldn't have sinks installed — that's a master-only
        // concept — but a stray target gets cleared via the proper
        // bookkeeping path rather than a direct null write).
        for (let i = 0; i < orchestrator.targets.length; i++) {
            if (orchestrator.targets[i] != null) orchestrator.replaceTarget(i, null);
        }
        const renderer = this.create(slot);
        renderer.paneEl.dataset.slot = String(slot);
        orchestrator.replaceTarget(slot, renderer);
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

export const domRendererManager = new DomRendererManager();
