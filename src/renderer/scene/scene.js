/**
 * Scene orchestration — buildScene, perspective.
 *
 * Coordinate mapping from DOOM to CSS 3D:
 *   DOOM X  → CSS X  (left/right)
 *   DOOM Y  → CSS −Z (forward/back — DOOM Y increases northward, CSS Z increases toward viewer)
 *   DOOM Z (height) → CSS −Y (vertical — CSS Y increases downward)
 *
 * Every renderer builds its own scene independently — buildScene() is a
 * pure function of (mapData + state) and returns `{ fragment, sceneState }`
 * that the renderer absorbs via DomRenderer.loadMap(). No cloning between
 * panes; each pane runs the build for itself. See RENDERER_REFACTOR.md
 * for the migration story.
 */

import { domRenderers } from '../dom.js';
import { makeSceneState } from '../dom-renderer.js';
import { mapData } from '../../shared/maps.js';
import { buildSectorContainers } from './sectors.js';
import { buildWalls } from './surfaces/walls.js';
import { buildFloors } from './surfaces/floors.js';
import { buildCeilings } from './surfaces/ceilings.js';
import { buildPlayer } from './entities/player.js';
import { buildThing } from './entities/things.js';
import { buildDoor } from './mechanics/doors.js';
import { buildLift } from './mechanics/lifts.js';
import { buildCrusher } from './mechanics/crushers.js';

/**
 * Recompute each pane's `--perspective` from its current rendered
 * width. Perspective = half the pane's width gives a ~90° horizontal
 * FOV; reading `clientWidth` per pane means split-screen, kiosk,
 * mirror, single-pane SP, and master+client all just work without
 * mode branching. Call after any layout change that resizes the panes
 * — client join/leave, kiosk toggle, window resize.
 */
export function updatePerspective() {
    for (let i = 0; i < domRenderers.length; i++) {
        const r = domRenderers[i];
        const paneWidth = r.viewportEl.clientWidth || window.innerWidth;
        const perspectiveValue = paneWidth / 2;
        r.sceneState.perspectiveValue = perspectiveValue;
        r.viewportEl.style.setProperty('--perspective', `${perspectiveValue}px`);
    }
}

/**
 * Builds the renderer scene as a pure DocumentFragment, returning
 * `{ fragment, sceneState }`. The caller hands these to a renderer:
 *
 *   const { fragment, sceneState } = await buildScene();
 *   renderer.sceneEl.replaceChildren(fragment);
 *   Object.assign(renderer.sceneState, sceneState);
 *
 * No DOM-ownership knowledge in the build code — a second renderer can
 * call buildScene() again to produce its own independent fragment. The
 * scene is fully self-contained: static geometry (sectors, walls, floors,
 * ceilings, player billboard) plus dynamic level objects (things, doors,
 * lifts, crushers). Game-side init functions are expected to have run
 * first — they populate `mapData.thingRenderSpecs`, annotate doors with
 * `trackWalls`, and leave `mapData.lifts` / `mapData.crushers` ready to
 * read.
 *
 * Async because it preloads textures before returning.
 */
export async function buildScene() {
    updatePerspective();

    const ctx = {
        fragment: document.createDocumentFragment(),
        sceneState: makeSceneState(),
    };

    buildSectorContainers(ctx);
    buildWalls(ctx);
    buildFloors(ctx);
    buildCeilings(ctx);
    buildPlayer(ctx);

    // Dynamic level objects — game-side init has populated the data
    // these helpers read.
    if (mapData?.thingRenderSpecs) {
        for (const spec of mapData.thingRenderSpecs) buildThing(ctx, spec);
    }
    if (mapData?.doors) {
        for (const door of mapData.doors) buildDoor(ctx, door, door.trackWalls || []);
    }
    if (mapData?.lifts) {
        for (const lift of mapData.lifts) {
            if (lift.upperHeight - lift.lowerHeight > 0) buildLift(ctx, lift);
        }
    }
    if (mapData?.crushers) {
        for (const crusher of mapData.crushers) {
            if (crusher.topHeight - crusher.crushHeight > 0) buildCrusher(ctx, crusher);
        }
    }

    await preloadTextures(ctx.fragment);

    return { fragment: ctx.fragment, sceneState: ctx.sceneState };
}

/**
 * Collects all unique texture URLs used in the scene (wall textures, floor
 * flats, and sprite images), and returns a promise that resolves once all
 * images are loaded. A timeout ensures the promise resolves even if some
 * textures fail to load.
 */
function preloadTextures(sceneRoot) {
    const urls = new Set();

    for (const el of sceneRoot.querySelectorAll('.wall, .floor, .ceiling')) {
        const bg = el.style.backgroundImage;
        const match = bg?.match(/url\(['"]?([^'")\s]+)['"]?\)/);
        if (match) urls.add(match[1]);
    }

    for (const el of sceneRoot.querySelectorAll('.switch[data-texture^="SW1"]')) {
        urls.add(`/assets/textures/SW2${el.dataset.texture.slice(3)}.png`);
    }

    for (const img of sceneRoot.querySelectorAll('img[src]')) {
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
