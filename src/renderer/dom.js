/**
 * DomRenderer registry + global UI element refs.
 *
 * `domRenderers` is the mutable list of `DomRenderer` instances live in
 * this window. It starts empty — boot code on master / client constructs
 * renderers based on the active mode (SP = 1, mirror SP / DM = 2 local,
 * Network DM = 1 local on non-kiosk / 2 on kiosk, plus any sinks live
 * in the orchestrator's targets array). Mode switches reshape the list.
 *
 * `dom` holds only references to global, never-per-pane UI elements.
 * Per-pane elements (scene, viewport, renderer, status, weapon) live on
 * each `DomRenderer` instance.
 */

import { DomRenderer } from './dom-renderer.js';
import { orchestrator } from '../orchestrator.js';

const gameContainer = document.getElementById('game');
const paneTemplate = document.querySelector('#pane-template');

export const dom = {
    menuButton: document.getElementById('menu-button'),
    menuOverlay: document.getElementById('menu-overlay'),
    ammoPanel: document.getElementById('ammo-panel'),
};

/** Live `DomRenderer` instances in this window. */
export const domRenderers = [];

/**
 * Construct a new `DomRenderer` for the given player, append its pane
 * to the game container, and push it into `domRenderers`. The caller
 * is responsible for installing it as a render target in the orchestrator
 * (via `orchestrator.replaceTarget`) at the right slot.
 */
export function createDomRenderer(playerIndex) {
    const renderer = new DomRenderer({ playerIndex, gameContainer, paneTemplate });
    domRenderers.push(renderer);
    return renderer;
}

/**
 * Remove a renderer from the registry and tear its pane out of the DOM.
 * Caller is responsible for clearing any orchestrator target slot that
 * held this renderer beforehand.
 */
export function destroyDomRenderer(renderer) {
    const i = domRenderers.indexOf(renderer);
    if (i >= 0) domRenderers.splice(i, 1);
    renderer.destroy();
}

/**
 * Construct / destroy local DomRenderers to match what master needs for
 * a given (gameMode, networkMode) combination:
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
 * Renderers are reused across mode switches where possible — only the
 * delta count is created or destroyed, and `playerIndex` updates in
 * place for existing ones. Each renderer is installed into / removed
 * from `orchestrator.targets[slot]` to match. Client windows manage
 * their single renderer separately (see client.js); this helper is
 * master-side only.
 */
export function reshapeMasterRenderers(gameMode, networkMode) {
    const isKiosk = document.body.classList.contains('kiosk');
    const mirror = gameMode === 'singleplayer' && isKiosk;
    const needsTwoLocal = (gameMode === 'deathmatch' && networkMode === 'standalone')
        || mirror
        || (gameMode === 'deathmatch' && networkMode === 'host' && isKiosk);
    const desiredCount = needsTwoLocal ? 2 : 1;

    // Tear down extras (from the end so indices stay stable).
    while (domRenderers.length > desiredCount) {
        const r = domRenderers[domRenderers.length - 1];
        const slot = orchestrator.targets.indexOf(r);
        if (slot >= 0) orchestrator.replaceTarget(slot, null);
        destroyDomRenderer(r);
    }

    // Create missing renderers at the next free slot.
    while (domRenderers.length < desiredCount) {
        const slot = domRenderers.length;
        const playerIndex = mirror ? 0 : slot;
        const r = createDomRenderer(playerIndex);
        orchestrator.replaceTarget(slot, r);
    }

    // Update playerIndex on existing renderers in case mirror just
    // toggled. Pane element's `data-player` follows the playerIndex so
    // CSS hide rules (`body[data-game-mode] .pane[data-player="0"]` …) and
    // the player-sprite "hide own billboard" selector key correctly.
    for (let slot = 0; slot < domRenderers.length; slot++) {
        const r = domRenderers[slot];
        r.playerIndex = mirror ? 0 : slot;
        r.paneEl.dataset.player = String(r.playerIndex);
    }
}
