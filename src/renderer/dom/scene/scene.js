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

import { makeSceneState } from '../dom-renderer.js';
import * as maps from '../../../shared/maps/index.js';
import { buildSectorContainers } from './sectors.js';
import { buildWalls } from './surfaces/walls.js';
import { buildFloors } from './surfaces/floors.js';
import { buildCeilings } from './surfaces/ceilings.js';
import { buildPlayer } from './entities/player.js';
import { buildThing } from './entities/things.js';
import { buildDoor } from './mechanics/doors.js';
import { buildLift } from './mechanics/lifts.js';
import { buildCrusher } from './mechanics/crushers.js';
import { updateCulling as runCulling } from './culling.js';

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
 * iOS Safari holds GPU-backed texture memory across map loads
 * unless given a yield window between teardown and re-allocation.
 * 100ms is the empirical minimum that consistently lets the
 * compositor release the prior scene's textures before the next
 * scene's images allocate. Originally one yield in Level.load
 * shared across all renderers; now per-renderer, but Promise.all
 * makes them collapse to one wall-clock yield.
 */
const IOS_GPU_RELEASE_DELAY_MS = 100;

/**
 * Recompute one renderer's `--perspective` based on its own viewport
 * size and the current window mode.
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
 * Called by the DomRenderer's own ResizeObserver — fires on initial
 * observe, window resize, and any CSS layout change that resizes the
 * viewport (e.g. a sibling pane appearing or disappearing when a
 * remote client joins or leaves). No external trigger needed.
 */
export function updatePerspective(renderer) {
    const value = document.body.classList.contains('kiosk')
        ? KIOSK_PERSPECTIVE
        : Math.max(
            (renderer.viewportEl.clientWidth || window.innerWidth) / 2,
            Math.max(window.innerWidth * MIN_PERSPECTIVE_RATIO, MIN_PERSPECTIVE_PX),
        );
    renderer.sceneState.perspectiveValue = value;
    renderer.viewportEl.style.setProperty('--perspective', `${value}px`);
}

/**
 * Builds the renderer scene as a pure DocumentFragment, returning
 * `{ fragment, sceneState }`. The caller hands these to a renderer:
 *
 *   const { fragment, sceneState } = await buildScene(mapData);
 *   renderer.sceneEl.replaceChildren(fragment);
 *   Object.assign(renderer.sceneState, sceneState);
 *
 * No DOM-ownership knowledge in the build code — a second renderer can
 * call buildScene() again to produce its own independent fragment. The
 * scene is fully self-contained: static geometry (sectors, walls, floors,
 * ceilings, player billboard) plus dynamic level objects (things, doors,
 * lifts, crushers). Map-side enrichment (`shared/maps/things.js` and
 * `shared/maps/doors.js`) is expected to have run first — it
 * annotates each `mapData.things[i]` in place with category /
 * sectorIndex / floorHeight / gameId and each `mapData.doors[i]`
 * with `trackWalls`. `mapData.lifts` / `mapData.crushers` are read
 * as-is.
 *
 * Async because it preloads textures before returning.
 *
 * Note: sub-helpers (buildWalls, buildFloors, ...) still read mapData
 * via their own module imports. The parameter here is the public
 * contract — current value will match via the live ES module binding,
 * so they're consistent today. A future cleanup would pass mapData
 * through ctx so sub-helpers stop importing it.
 */
export async function buildScene(mapData) {
    const ctx = {
        fragment: document.createDocumentFragment(),
        sceneState: makeSceneState(),
    };

    buildSectorContainers(ctx);
    buildWalls(ctx);
    buildFloors(ctx);
    buildCeilings(ctx);
    buildPlayer(ctx);

    // Dynamic level objects — map-side init has enriched mapData.things
    // in place with sectorIndex / floorHeight / category / gameId for
    // each surviving entry. Skip entries without `category`: those are
    // skill / MP-only filtered out and shouldn't render.
    if (mapData?.things) {
        for (const thing of mapData.things) {
            if (thing.category === undefined) continue;
            buildThing(ctx, thing);
        }
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
 * Full per-renderer map-load sequence:
 *   1. Resolve mapData via maps.load (idempotent on master after Level
 *      has already loaded; first call on joiner side).
 *   2. Build a fresh scene fragment + sceneState from mapData.
 *   3. Absorb both into the renderer (replace its DOM subtree + alias
 *      state).
 *   4. Prime this renderer's camera so the first composited frame has
 *      the right transform.
 *   5. Prime culling once so visibility classifications are correct on
 *      the first composited frame.
 *
 * Each DomRenderer in the orchestrator's target list runs this
 * independently — no cross-pane coupling. The camera prime reads
 * `renderer.state.camera`, populated by the `updateCamera` impl on
 * every dispatch. Master's `Level.load` fires an explicit
 * `renderer.updateCamera` for each player after `applyPlayerStart`
 * and BEFORE this `orchestrator.loadMap(name)` call so the warmup
 * sees fresh values on the first composited frame. The same
 * fan-out forwards to joiners over each RenderSink, so the joiner's
 * scene.loadMap warmup primes against fresh data too.
 *
 * Wired onto DomRenderer.prototype as the `loadMap` world-command
 * impl via commands.js's auto-binding loop. Returns a Promise so the
 * orchestrator's `loadMap` override can Promise.all every local
 * renderer.
 */
export async function loadMap(renderer, name) {
    // Teardown phase — only if this renderer has a prior scene to
    // tear down. Empty on first construction; non-empty after any
    // prior load. Reuses DomRenderer.clear() — same operation the
    // orchestrator triggers when a remote takes over master's pane
    // (different lifecycle, same DOM/state reset).
    //
    // The yield gives iOS Safari a window to release the GPU-backed
    // texture memory the cleared DOM held before the build below
    // allocates new elements. With N renderers running in parallel
    // via orchestrator.loadMap's Promise.all, all N yields fire at
    // the same microtask — wall-clock cost stays ~one yield.
    if (renderer.hasScene) {
        renderer.clear();
        await new Promise(resolve => setTimeout(resolve, IOS_GPU_RELEASE_DELAY_MS));
    }

    await maps.load(name);
    const { fragment, sceneState } = await buildScene(maps.mapData);
    renderer.sceneEl.replaceChildren(fragment);
    Object.assign(renderer.sceneState, sceneState);

    // Record the map this renderer is now showing so `reload()` can
    // rebuild against it later without needing the orchestrator to
    // know which map is current.
    renderer._lastLoadedMap = name;

    // Warmup phase — primes camera transform + culling visibility so
    // the browser doesn't have to composite the entire level on the
    // first RAF frame. Reads from this renderer's own state (which
    // was populated by `updateCamera` / `updateThingPosition`
    // dispatches fired before loadMap). Calling through the
    // auto-generated per-pane prototype method keeps the prime
    // local to this renderer; we skip the orchestrator so other
    // panes don't get double-primed when a sibling DomRenderer's
    // loadMap runs.
    if (renderer.state.camera) {
        renderer.updateCamera(renderer.state.camera);
    }
    if (renderer.hasScene) {
        runCulling(renderer, renderer.state.things, false);
    }
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
