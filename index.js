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
 * Game Loop
 */
function gameLoop(timestamp) {
    if (!mapData) {
        requestAnimationFrame(gameLoop);
        return;
    }

    if (state.isDead) {
        for (const player of state.players) updateCamera(player);
        requestAnimationFrame(gameLoop);
        return;
    }

    updateGame(timestamp);
    updateHud();
    for (const player of state.players) updateCamera(player);

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
    updateHud();
    for (const player of state.players) updateCamera(player);

    await new Promise(resolve => setTimeout(resolve, 600));

    hideInitialOverlay();

    /* Start game loop */
    requestAnimationFrame(gameLoop);
    window.focus();
}

init();
