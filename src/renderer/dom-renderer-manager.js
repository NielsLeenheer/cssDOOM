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

class DomRendererManager {
    constructor() {
        this._renderers = [];
        // Captured once at module load. Both elements live in index.html
        // and never change; the Manager holds them so DomRenderer
        // construction doesn't have to re-query the DOM each time.
        this._gameContainer = document.getElementById('game');
        this._paneTemplate = document.querySelector('#pane-template');
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
        for (let slot = 0; slot < this._renderers.length; slot++) {
            const r = this._renderers[slot];
            r.playerIndex = mirror ? 0 : slot;
            r.paneEl.dataset.player = String(r.playerIndex);
        }
    }
}

export const domRendererManager = new DomRendererManager();
