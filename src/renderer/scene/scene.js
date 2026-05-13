/**
 * Scene orchestration — teardown, build, and texture preloading.
 *
 * Coordinate mapping from DOOM to CSS 3D:
 *   DOOM X  → CSS X  (left/right)
 *   DOOM Y  → CSS −Z (forward/back — DOOM Y increases northward, CSS Z increases toward viewer)
 *   DOOM Z (height) → CSS −Y (vertical — CSS Y increases downward)
 *
 * Per-pane: pane 0's scene tree is built normally from map data; remaining
 * panes are populated by cloneSceneToOtherPanes(), which deep-clones pane 0's
 * DOM tree and copies the JS expando properties (the `_foo` data used by
 * culling, sprite rotation, etc.) onto the clones. Each clone pane's
 * sceneState arrays/Maps then point at the cloned elements via a
 * source→clone Map populated during the recursive clone walk. Each pane has
 * its own DOM tree so culling and visibility toggle independently.
 *
 * buildScene() builds only the static renderer DOM (sectors, walls, floors,
 * ceilings, player). Things, doors, lifts, crushers are added separately as
 * renderer commands invoked by game-side init code. Cloning to other panes
 * is also a separate command (cloneSceneToOtherPanes). The orchestration of
 * "build scene + populate dynamic things + clone + initial render" lives in
 * the caller (src/shared/maps.js loadMap), not in this file.
 */

import { dom, sceneState, sceneStates } from '../dom.js';
import { buildSectorContainers } from './sectors.js';
import { buildWalls } from './surfaces/walls.js';
import { buildFloors } from './surfaces/floors.js';
import { buildCeilings } from './surfaces/ceilings.js';
import { buildPlayer } from './entities/player.js';

// Module-level flag for the Phase 3 pane-1 mirror debug toggle. When on:
//   1. The caller should build extra panes by passing paneCount === sceneStates.length
//      (so pane 1 has a renderable scene even when state.players.length === 1).
//   2. Per-player visual effects (flash, powerup, weapon-switch, firing,
//      head-bob, key collect, dead state) fan out from player 0 to pane 1
//      via viewportsForEffect() below — so pane 1 visually mirrors pane 0.
// Phase 4's deathmatch mode does NOT set this; it relies on
// state.players.length === sceneStates.length and per-player effect routing.
let mirrorMode = false;
export function setMirrorMode(value) { mirrorMode = value; }
export function isMirrorMode() { return mirrorMode; }

/**
 * Yields the list of viewport indices that a per-player visual effect should
 * apply to. In normal play this is just the player's own pane. In mirror
 * mode, player 0's effects also fan out to pane 1 so the mirror pane shows
 * weapon switches, head-bob, key flashes, etc. alongside pane 0.
 */
export function viewportsForEffect(playerIndex) {
    if (mirrorMode && playerIndex === 0) return [0, 1];
    return [playerIndex];
}

/**
 * Tears down the current scene in every pane, releasing DOM nodes and GPU
 * resources. Game-side state (spatial grid, doorState, etc.) must be cleared
 * separately by the caller — this function only owns renderer state.
 */
export function teardownScene() {
    for (let i = 0; i < sceneStates.length; i++) {
        const sState = sceneStates[i];
        sState.wallElements = [];
        sState.surfaceElements = [];
        sState.skyWallPlanes = [];
        sState.skySectors = new Set();
        sState.skyGroupOf = new Map();
        sState.sectorContainers = [];
        sState.thingContainers = [];
        sState.doorContainers.clear();
        sState.liftContainers.clear();
        sState.crusherContainers.clear();
        sState.thingDom.clear();
        sState.projectileDom.clear();
        // Atomic DOM clear — single reflow instead of one per child removal
        dom.scenes[i].replaceChildren();
    }
    const oldSvg = document.getElementById('clip-svgs');
    if (oldSvg) oldSvg.remove();
}

/**
 * Recompute each pane's `--perspective` from its current rendered
 * width. Perspective = half the pane's width gives a ~90° horizontal
 * FOV; reading `clientWidth` per pane means split-screen, kiosk,
 * mirror, single-pane SP, and master+client all just work without
 * mode branching. Call after any layout change that resizes the panes
 * — client join/leave, kiosk toggle, window resize.
 */
export function updatePerspective() {
    for (let i = 0; i < dom.viewports.length; i++) {
        const v = dom.viewports[i];
        const paneWidth = v.clientWidth || window.innerWidth;
        const perspectiveValue = paneWidth / 2;
        sceneStates[i].perspectiveValue = perspectiveValue;
        v.style.setProperty('--perspective', `${perspectiveValue}px`);
    }
}

/**
 * Builds the static renderer DOM for pane 0: sector containers, walls,
 * floors, ceilings, and the player billboard. Things, doors, lifts, and
 * crushers are NOT built here — the caller invokes those as renderer
 * commands after this function returns and before cloning to other panes.
 *
 * Async because it preloads textures before returning.
 */
export async function buildScene() {
    updatePerspective();

    // Build pane 0's scene from map data using the existing helpers (which
    // operate on the singletons dom.scene / sceneState — both alias pane 0).
    buildSectorContainers();
    buildWalls();
    buildFloors();
    buildCeilings();
    buildPlayer();

    await preloadTextures();
}

/**
 * Clones pane 0's fully-built scene tree into panes 1..paneCount-1. The
 * caller must invoke this only after all renderer commands that mutate
 * pane 0's DOM (buildThing, buildDoor, buildLift, buildCrusher) have run,
 * so the clone captures the final state.
 */
export function clonePanes(paneCount) {
    if (paneCount > 1) {
        cloneSceneToOtherPanes(paneCount);
    }
}

/**
 * Recursively clones pane 0's `.scene` DOM tree into the remaining panes
 * (1..panesToBuild-1), copying expando JS properties (`_midX`, `_wall`,
 * `_sectorIndex`, etc.) onto the clones via a source→clone Map. After the
 * clone walk, each clone pane's sceneState arrays/Maps are populated by
 * mapping pane 0's references through the cloneMap, so culling, sprite
 * rotation, and mechanics state-toggling all work per-pane out of the box.
 *
 * Element ids on cloned elements (DOOM wall ids like "ld489", sector ids
 * like "s0", the spectator "#player" sprite) are demoted to data-orig-id
 * so duplicate ids across panes don't violate the HTML uniqueness rule.
 * Renderer functions that need to find these elements across all panes use
 * `[data-orig-id="..."]` (see toggleSwitchState).
 */
function cloneSceneToOtherPanes(paneCount) {
    for (let pi = 1; pi < paneCount; pi++) {
        cloneSceneToPane(pi);
    }
}

/**
 * Clone pane 0's current `.scene` DOM tree into the target pane,
 * copying expando JS properties (`_midX`, `_wall`, `_sectorIndex`, etc.)
 * onto the clones via a source→clone Map. After the clone walk, the
 * target pane's sceneState arrays/Maps are populated by mapping pane 0's
 * references through the cloneMap so culling, sprite rotation, and
 * mechanics state-toggling all work per-pane out of the box.
 *
 * Element ids on cloned elements (DOOM wall ids like "ld489", sector
 * ids like "s0", the spectator "#player" sprite) are demoted to
 * data-orig-id so duplicate ids across panes don't violate the HTML
 * uniqueness rule. Renderer functions that need to find these elements
 * across all panes use `[data-orig-id="..."]` (see toggleSwitchState).
 *
 * Idempotent — `targetSceneEl.replaceChildren()` clears any prior tree
 * before re-cloning. Safe to call repeatedly to rebuild a torn-down
 * pane after a client disconnects.
 */
function cloneSceneToPane(pi) {
    const sourceSceneEl = dom.scenes[0];
    const sourceSceneState = sceneStates[0];
    const targetSceneEl = dom.scenes[pi];
    const targetSceneState = sceneStates[pi];
    if (!targetSceneEl || !targetSceneState) return;
    const cloneMap = new Map();

    function cloneRec(src) {
        const tgt = src.cloneNode(false);
        // Promote duplicate id to data-orig-id (cross-pane uniqueness rule).
        if (tgt.id) {
            tgt.dataset.origId = tgt.id;
            tgt.removeAttribute('id');
        }
        // Copy underscore-prefixed expando properties used by culling/etc.
        for (const key of Object.getOwnPropertyNames(src)) {
            if (key.startsWith('_')) tgt[key] = src[key];
        }
        cloneMap.set(src, tgt);
        for (const child of src.children) {
            tgt.appendChild(cloneRec(child));
        }
        return tgt;
    }

    targetSceneEl.replaceChildren();
    for (const child of sourceSceneEl.children) {
        targetSceneEl.appendChild(cloneRec(child));
    }

    // Populate per-pane arrays via the source→clone Map.
    targetSceneState.wallElements = sourceSceneState.wallElements.map(el => cloneMap.get(el));
    targetSceneState.surfaceElements = sourceSceneState.surfaceElements.map(el => cloneMap.get(el));
    targetSceneState.sectorContainers = sourceSceneState.sectorContainers.map(el => cloneMap.get(el));
    targetSceneState.thingContainers = sourceSceneState.thingContainers.map(tc => ({
        ...tc,
        element: cloneMap.get(tc.element),
    }));

    targetSceneState.thingDom.clear();
    for (const [idx, { element, sprite }] of sourceSceneState.thingDom) {
        targetSceneState.thingDom.set(idx, {
            element: cloneMap.get(element),
            sprite: sprite ? cloneMap.get(sprite) : null,
        });
    }
    targetSceneState.doorContainers.clear();
    for (const [idx, container] of sourceSceneState.doorContainers) {
        targetSceneState.doorContainers.set(idx, cloneMap.get(container));
    }
    targetSceneState.liftContainers.clear();
    for (const [idx, container] of sourceSceneState.liftContainers) {
        targetSceneState.liftContainers.set(idx, cloneMap.get(container));
    }
    targetSceneState.crusherContainers.clear();
    for (const [idx, container] of sourceSceneState.crusherContainers) {
        targetSceneState.crusherContainers.set(idx, cloneMap.get(container));
    }
    targetSceneState.projectileDom.clear();
    for (const [idx, el] of sourceSceneState.projectileDom) {
        targetSceneState.projectileDom.set(idx, cloneMap.get(el));
    }

    // Pure data — duplicate so each pane has its own independent copy.
    targetSceneState.skyWallPlanes = [...sourceSceneState.skyWallPlanes];
    targetSceneState.skySectors = new Set(sourceSceneState.skySectors);
    targetSceneState.skyGroupOf = new Map(sourceSceneState.skyGroupOf);
    targetSceneState.perspectiveValue = sourceSceneState.perspectiveValue;
}

/**
 * Tear down a single pane's DOM and sceneState. Used when a client
 * connects and takes over rendering for that slot — clearing
 * sceneStates[paneIndex] makes world commands (setEnemyState,
 * updateThingPosition, etc.) and the culling loop both early-exit when
 * they iterate that pane's empty arrays. Saves CPU/DOM work that would
 * otherwise happen against an invisible subtree.
 *
 * The .scene element itself is preserved (only its children are
 * replaced) — same for the .viewport, .hud, .status, and .weapon
 * elements that live in the pane template. They become empty containers
 * waiting for rebuildPane().
 */
export function tearDownPane(paneIndex) {
    const sState = sceneStates[paneIndex];
    if (!sState) return;
    sState.wallElements = [];
    sState.surfaceElements = [];
    sState.sectorContainers = [];
    sState.thingContainers = [];
    sState.skyWallPlanes = [];
    sState.skySectors = new Set();
    sState.skyGroupOf = new Map();
    sState.thingDom.clear();
    sState.doorContainers.clear();
    sState.liftContainers.clear();
    sState.crusherContainers.clear();
    sState.projectileDom.clear();
    dom.scenes[paneIndex]?.replaceChildren();
}

/**
 * Rebuild a single pane by cloning pane 0's current DOM tree into it.
 * Counterpart to tearDownPane — used when a client disconnects and
 * master needs the local pane back. The clone is from pane 0's *live*
 * state, so accumulated runtime mutations (open doors, dead enemies,
 * collected items) carry over correctly.
 */
export function rebuildPane(paneIndex) {
    if (paneIndex === 0) return; // pane 0 is the source, never rebuilt from itself
    cloneSceneToPane(paneIndex);
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
