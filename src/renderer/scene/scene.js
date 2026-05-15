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

// Fixed perspective for kiosk panes. Kiosk hardware is known and the
// pane's internal logical width is 1920px regardless of HD vs 4K
// input (HD: 100vw=1920 + scale(0.5); 4K: 50vw=1920 native). 960 is
// half that logical width, giving ~90° FOV per pane — the "feels
// like a full HD window" look the kiosk design is built around.
const KIOSK_PERSPECTIVE = 960;

// Lower bound on perspective as a fraction of window width for the
// non-kiosk path. With CSS perspective, smaller values give a wider
// FOV. Pure paneWidth/2 (the "natural" per-pane perspective) over-
// widens narrow split-screen panes — peripheral walls render past the
// culler's frustum and pop in/out at the sides. This floor caps how
// wide the FOV can get on narrow panes.
//   0.5  → full single-window perspective; narrowest FOV on split-screen
//   0.4  → moderate widening
//   0.3  → close to the cull horizon
//   0.25 → cull pops start to show at pane edges
const MIN_PERSPECTIVE_RATIO = 0.3;

// Absolute minimum perspective. Catches small physical screens
// (phones in portrait) where even paneWidth * 0.5 produces an
// uncomfortably wide FOV with too much foreshortening. Kicks in
// independently of the window-ratio floor.
const MIN_PERSPECTIVE_PX = 350;

/**
 * Recompute each pane's `--perspective`.
 *
 * Kiosk uses a fixed value tuned to the installation hardware (see
 * KIOSK_PERSPECTIVE above). HD and 4K kiosk look identical because
 * both render at the same internal logical width per pane.
 *
 * Non-kiosk panes use the larger of the per-pane natural value
 * (`paneWidth / 2`, ~90° FOV per pane) and a window-width floor —
 * so a full-window pane gets its full perspective, while narrow
 * split-screen panes get a moderately widened FOV without the
 * over-distortion that breaks culling. Phone in portrait has
 * paneWidth ≈ window.innerWidth so the natural per-pane perspective
 * applies (wide FOV, no special case).
 *
 * Call after any layout change — client join/leave, kiosk toggle,
 * window resize.
 */
export function updatePerspective() {
    if (document.body.classList.contains('kiosk')) {
        for (const r of domRenderers) {
            r.sceneState.perspectiveValue = KIOSK_PERSPECTIVE;
            r.viewportEl.style.setProperty('--perspective', `${KIOSK_PERSPECTIVE}px`);
        }
        return;
    }

    const floor = Math.max(window.innerWidth * MIN_PERSPECTIVE_RATIO, MIN_PERSPECTIVE_PX);
    for (const r of domRenderers) {
        const paneWidth = r.viewportEl.clientWidth || window.innerWidth;
        const perspectiveValue = Math.max(paneWidth / 2, floor);
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
