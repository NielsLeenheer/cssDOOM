/**
 * Cached DOM element references and renderer-specific state.
 *
 * Fixed HTML elements that never change after page load,
 * shared across renderer modules to avoid repeated lookups.
 *
 * Phase 2 multiplayer migration: per-pane elements live in arrays
 * (`dom.renderers`, `dom.scenes`, `dom.viewports`, `dom.weaponElements`,
 * `dom.statusElements`) — length 1 in single-player, length 2 in deathmatch.
 * The legacy singletons (`dom.renderer`, `dom.scene`, etc.) point at the same
 * elements as `[i][0]` and remain as migration aliases until every reader
 * uses an indexed form. Once the renderer is fully parameterized the
 * singletons can be removed.
 *
 * UI elements that are NOT per-pane (menu, fullscreen control) stay as
 * single references.
 */

const renderer = document.getElementById('renderer');
const scene = document.getElementById('scene');
const viewport = document.getElementById('viewport');
const status = document.getElementById('status');
const weaponElement = document.getElementById('weapon');

export const dom = {
    // Per-pane elements (legacy singletons + length-1 arrays sharing the same DOM nodes).
    renderer,
    scene,
    viewport,
    status,
    weaponElement,
    renderers: [renderer],
    scenes: [scene],
    viewports: [viewport],
    statusElements: [status],
    weaponElements: [weaponElement],

    // Global UI — never per-pane.
    menuButton: document.getElementById('menu-button'),
    menuOverlay: document.getElementById('menu-overlay'),
    ammoPanel: document.getElementById('ammo-panel'),
};

/**
 * Renderer-specific state — arrays of DOM elements representing the 3D scene.
 * Rebuilt each map load. Game logic should not access these.
 *
 * Phase 2: `sceneStates` is an array, length 1 in SP and 2 in DM. Each entry
 * owns its own wallElements/surfaceElements/thingDom/etc. so the two panes
 * render independently. The legacy `sceneState` export is `sceneStates[0]`
 * for backwards compatibility and will be removed once all readers iterate
 * the array.
 */
export const sceneState = {
    wallElements: [],
    surfaceElements: [],
    sectorContainers: [],
    thingContainers: [],
    doorContainers: new Map(),
    liftContainers: new Map(),
    crusherContainers: new Map(),
    skyWallPlanes: [],             // Array of { nx, ny, px, py, ax, ay, bx, by } — sky wall occluders
    skySectors: new Set(),         // Sector indices with sky ceilings
    skyGroupOf: new Map(),         // Map<sectorIndex, groupId> — connected sky sector groups
    thingDom: new Map(),          // Map<thingIndex, { element, sprite }>
    projectileDom: new Map(),     // Map<projectileId, element>
    // CSS perspective distance in pixels. Determines the field of view;
    // also used as a translateZ offset to position the camera correctly.
    perspectiveValue: 700,
};

export const sceneStates = [sceneState];
