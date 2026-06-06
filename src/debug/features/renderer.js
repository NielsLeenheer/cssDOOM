/**
 * Renderer swap — a shared debug feature.
 *
 * Tears down the SP pane and rebuilds it with a different renderer kind via
 * manager.create() (which reads body.dataset.renderer), reloads the current
 * map, then replays a world-state catchup so the new renderer arrives with the
 * same door / lift / thing state the old one had. The first renderer in the
 * manager's list is the SP pane; bails if there isn't one (e.g. a join-only
 * client window).
 *
 * Used by both presenters: the menu's Renderer picker (ui/panel.js) and
 * debug.view.renderer() (console/console.js) — neither owns it.
 */

import { orchestrator } from '../../orchestrator.js';
import { currentMap } from '../../shared/maps/index.js';
import { rendererManager } from '../../renderer/manager.js';
import { buildCatchup, applyCatchupCmds } from '../../game/catchup.js';

export async function switchRenderer(kind) {
    const old = rendererManager.all[0];
    if (!old) return;

    const playerIndex = old.playerIndex;
    const savedSlot = old.paneEl.dataset.slot;
    const savedCamera = old.state?.camera ? { ...old.state.camera } : null;

    orchestrator.removeTarget(old);
    rendererManager.destroy(old);

    document.body.dataset.renderer = kind;
    const fresh = rendererManager.create(kind, playerIndex);
    if (savedSlot !== undefined) fresh.paneEl.dataset.slot = savedSlot;
    orchestrator.addTarget(fresh);

    if (currentMap && typeof fresh.loadMap === 'function') {
        await fresh.loadMap(currentMap);
        applyCatchupCmds(fresh, buildCatchup(playerIndex));
        if (savedCamera && typeof fresh.updateCamera === 'function') {
            fresh.updateCamera(savedCamera);
        }
    }
}
