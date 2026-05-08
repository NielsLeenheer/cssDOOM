/**
 * Entry point — initialization and main game loop.
 */

import { state } from './src/game/state.js';
import { mapData } from './src/shared/maps.js';
import { updateGame } from './src/game/index.js';
import { loadMap } from './src/shared/maps.js';
import { updateCamera } from './src/renderer/scene/camera.js';
import { updateCulling, CULLING_INTERVAL } from './src/renderer/scene/culling.js';
import { updateHud } from './src/renderer/hud.js';
import { sceneStates } from './src/renderer/dom.js';
import { updateMenuSelection, loadSavedMode, applyMode } from './src/ui/menu.js';
import { hideInitialOverlay } from './src/ui/overlay.js';
import { initKeyboardInput } from './src/input/keyboard.js';
import { initMouseInput } from './src/input/mouse.js';
import { initTouchInput } from './src/input/touch.js';
import { initGamepadInput } from './src/input/gamepad.js';
import { initDebugMenu, updateDebugStats } from './src/ui/debug.js';
import { attractTick, isAttractActive } from './src/ui/attract.js';
import { spectatorActive } from './src/ui/spectator.js';
import './src/ui/spectator.js';

let debugEnabled = false;

window.debug = function() {
    if (!debugEnabled) {
        debugEnabled = true;
        initDebugMenu();
        console.log('Debug menu enabled');
    }
};

/**
 * Render every pane that has a built scene tree. Pane index i uses
 * state.players[i] when present; panes beyond the player count (mirror mode)
 * fall back to player 0 — the same view rendered into a second viewport.
 */
function renderAllActivePanes() {
    for (let i = 0; i < sceneStates.length; i++) {
        if (sceneStates[i].wallElements.length === 0) continue;
        const player = state.players[i] || state.players[0];
        updateHud(player, i);
        updateCamera(player, i);
    }
}

/**
 * Culling loop. Runs every CULLING_INTERVAL frames per pane, hiding
 * off-screen elements. Lives at the orchestration layer (not inside the
 * renderer module) because it iterates game state — state.players for the
 * camera position, state.things for live thing positions, and the spectator
 * toggle for ceiling-skip behavior.
 */
let cullingFrameCount = 0;
function cullingLoop() {
    cullingFrameCount++;
    if (cullingFrameCount >= CULLING_INTERVAL) {
        cullingFrameCount = 0;
        for (let i = 0; i < sceneStates.length; i++) {
            if (sceneStates[i].wallElements.length === 0) continue;
            const player = state.players[i] || state.players[0];
            updateCulling(player, state.things, spectatorActive, i);
        }
    }
    requestAnimationFrame(cullingLoop);
}

/**
 * Game Loop
 */
function gameLoop(timestamp) {
    if (!mapData) {
        requestAnimationFrame(gameLoop);
        return;
    }

    attractTick(timestamp);
    if (isAttractActive()) {
        // Skip game logic in attract mode — attractTick is rotating the
        // camera; just render the current scene state and idle the world.
        renderAllActivePanes();
        requestAnimationFrame(gameLoop);
        return;
    }

    // Freeze game logic only when EVERY player is dead. In DM with one
    // player alive, the world (enemies, doors, etc.) keeps ticking and the
    // alive player keeps playing; the dead player's camera shows the
    // death-cam view at their corpse until they fire to respawn.
    if (state.players.every(p => p.isDead)) {
        for (let i = 0; i < sceneStates.length; i++) {
            if (sceneStates[i].wallElements.length === 0) continue;
            const player = state.players[i] || state.players[0];
            updateCamera(player, i);
        }
        requestAnimationFrame(gameLoop);
        return;
    }

    updateGame(timestamp);
    renderAllActivePanes();

    if (import.meta.env.DEV || debugEnabled) updateDebugStats();

    requestAnimationFrame(gameLoop);
}


/**
 * Initialization
 */
async function init() {
    if (import.meta.env.DEV) { debugEnabled = true; initDebugMenu(); }
    initKeyboardInput();
    initMouseInput();
    initTouchInput();
    initGamepadInput();

    // Restore the previously chosen mode (default singleplayer) before the
    // initial map load so the scene is built with the right pane count and
    // DM gets player 2 + match state from the first frame.
    applyMode(loadSavedMode());

    await loadMap('E1M1');
    requestAnimationFrame(cullingLoop);

    updateMenuSelection();
    renderAllActivePanes();

    await new Promise(resolve => setTimeout(resolve, 600));

    hideInitialOverlay();

    /* Start game loop */
    requestAnimationFrame(gameLoop);
    window.focus();
}

init();
