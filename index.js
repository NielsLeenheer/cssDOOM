/**
 * Entry point — initialization and main game loop.
 */

import { state } from './src/game/state.js';
import { mapData } from './src/shared/maps.js';
import { updateGame } from './src/game/index.js';
import { loadMap } from './src/shared/maps.js';
import { updateCamera } from './src/renderer/scene/camera.js';
import { startCullingLoop } from './src/renderer/scene/culling.js';
import { updateHud } from './src/renderer/hud.js';
import { sceneStates } from './src/renderer/dom.js';
import { updateMenuSelection } from './src/ui/menu.js';
import { hideInitialOverlay } from './src/ui/overlay.js';
import { initKeyboardInput } from './src/input/keyboard.js';
import { initMouseInput } from './src/input/mouse.js';
import { initTouchInput } from './src/input/touch.js';
import { initGamepadInput } from './src/input/gamepad.js';
import { initDebugMenu, updateDebugStats } from './src/ui/debug.js';
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
 * Game Loop
 */
function gameLoop(timestamp) {
    if (!mapData) {
        requestAnimationFrame(gameLoop);
        return;
    }

    if (state.isDead) {
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

    await loadMap('E1M1');
    startCullingLoop();

    updateMenuSelection();
    renderAllActivePanes();

    await new Promise(resolve => setTimeout(resolve, 600));

    hideInitialOverlay();

    /* Start game loop */
    requestAnimationFrame(gameLoop);
    window.focus();
}

init();
