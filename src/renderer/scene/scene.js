/**
 * Scene orchestration — teardown, build, and texture preloading.
 *
 * Coordinate mapping from DOOM to CSS 3D:
 *   DOOM X  → CSS X  (left/right)
 *   DOOM Y  → CSS −Z (forward/back — DOOM Y increases northward, CSS Z increases toward viewer)
 *   DOOM Z (height) → CSS −Y (vertical — CSS Y increases downward)
 */

import { dom, sceneState } from '../dom.js';
import { state } from '../../game/state.js';
import { clearSpatialGrid, buildSpatialGrid } from '../../game/spatial-grid.js';
import { initDoors } from '../../game/mechanics/doors.js';
import { initLifts } from '../../game/mechanics/lifts.js';
import { initCrushers } from '../../game/mechanics/crushers.js';
import { updateCamera } from './camera.js';
import { buildSectorContainers } from './sectors.js';
import { updateCulling } from './culling.js';
import { buildWalls } from './surfaces/walls.js';
import { buildFloors } from './surfaces/floors.js';
import { buildCeilings } from './surfaces/ceilings.js';
import { buildThings } from './entities/things.js';
import { buildPlayer } from './entities/player.js';

/**
 * Tears down the current scene, releasing DOM nodes and GPU resources.
 * Call before buildScene() with a yield in between to let the browser GC.
 */
export function teardownScene() {
    // Drop JS references to DOM elements first so they become GC-eligible
    sceneState.wallElements = [];
    sceneState.surfaceElements = [];
    sceneState.skyWallPlanes = [];
    sceneState.skySectors = new Set();
    sceneState.skyGroupOf = new Map();
    sceneState.sectorContainers = [];
    sceneState.thingContainers = [];
    sceneState.doorContainers.clear();
    sceneState.liftContainers.clear();
    sceneState.crusherContainers.clear();
    sceneState.thingDom.clear();
    sceneState.projectileDom.clear();
    clearSpatialGrid();
    // Atomic DOM clear — single reflow instead of one per child removal
    dom.scene.replaceChildren();
    const oldSvg = document.getElementById('clip-svgs');
    if (oldSvg) oldSvg.remove();
}

export async function buildScene() {
    const viewportWidth = window.innerWidth;
    sceneState.perspectiveValue = viewportWidth / 2;
    dom.viewport.style.setProperty('--perspective', `${sceneState.perspectiveValue}px`);

    buildSectorContainers();
    buildWalls();
    buildFloors();
    buildCeilings();
    buildThings();
    buildPlayer();

    await preloadTextures();

    initDoors();
    initLifts();
    initCrushers();
    buildSpatialGrid();
    for (const player of state.players) updateCamera(player);

    // Run culling synchronously before the first frame so the browser
    // never has to composite the entire level at once. Elements are
    // created hidden and only unhidden here if they pass culling.
    updateCulling();
}

/**
 * Collects all unique texture URLs used in the scene (wall textures, floor
 * flats, and sprite images), and returns a promise that resolves once all
 * images are loaded. A timeout ensures the promise resolves even if some
 * textures fail to load.
 */
function preloadTextures() {
    const urls = new Set();

    for (const el of dom.scene.querySelectorAll('.wall, .floor, .ceiling')) {
        const bg = el.style.backgroundImage;
        const match = bg?.match(/url\(['"]?([^'")\s]+)['"]?\)/);
        if (match) urls.add(match[1]);
    }

    for (const el of dom.scene.querySelectorAll('.switch[data-texture^="SW1"]')) {
        urls.add(`/assets/textures/SW2${el.dataset.texture.slice(3)}.png`);
    }

    for (const img of dom.scene.querySelectorAll('img[src]')) {
        urls.add(img.src);
    }

    if (urls.size === 0) return Promise.resolve();

    return new Promise(resolve => {
        let loaded = 0;
        const total = urls.size;

        function onComplete() {
            if (++loaded >= total) resolve();
        }

        for (const url of urls) {
            const img = new Image();
            img.onload = onComplete;
            img.onerror = onComplete;
            img.src = url;
        }

        // Safety timeout — resolve even if some textures stall
        setTimeout(resolve, 5000);
    });
}
