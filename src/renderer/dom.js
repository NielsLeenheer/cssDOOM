/**
 * Cached DOM element references and renderer-specific state.
 *
 * Per-pane: every pane has its own .renderer subtree (.viewport, .scene,
 * .hud, .status, .weapon, overlays). The HUD subtree is defined once in
 * #hud-template and cloned into each pane at module load so the markup stays
 * in one place.
 *
 * Arrays (`dom.renderers`, `dom.scenes`, `dom.viewports`, `dom.statusElements`,
 * `dom.weaponElements`) are length 1 in single-player and length 2 in
 * deathmatch (both DOM trees exist in the HTML; the inactive pane is hidden
 * via body.mode-singleplayer in CSS). The legacy singletons (`dom.renderer`,
 * `dom.scene`, etc.) point at pane 0 — they remain as migration aliases until
 * every reader uses an indexed form.
 *
 * UI elements that are NOT per-pane (menu, fullscreen control) stay as
 * single references.
 */

// Clone the HUD template into each pane's .renderer before any querySelector
// for HUD elements runs. Both panes always exist in the HTML; whether pane 1
// is visible is controlled by body.mode-* in CSS.
const hudTemplate = document.querySelector('#hud-template');
const paneRenderers = [...document.querySelectorAll('.pane > .renderer')];
for (const r of paneRenderers) {
    r.appendChild(hudTemplate.content.cloneNode(true));
}

const renderers = paneRenderers;
const scenes = [...document.querySelectorAll('.scene')];
const viewports = [...document.querySelectorAll('.viewport')];
const statusElements = [...document.querySelectorAll('.status')];
const weaponElements = [...document.querySelectorAll('.weapon')];

export const dom = {
    // Per-pane element arrays — length matches the number of panes (always 2
    // in current HTML; whether pane 1 is visible is a CSS concern).
    renderers,
    scenes,
    viewports,
    statusElements,
    weaponElements,

    // Migration aliases pointing at pane 0. Will be removed once every reader
    // uses an indexed form.
    renderer: renderers[0],
    scene: scenes[0],
    viewport: viewports[0],
    status: statusElements[0],
    weaponElement: weaponElements[0],

    // Global UI — never per-pane.
    menuButton: document.getElementById('menu-button'),
    menuOverlay: document.getElementById('menu-overlay'),
    ammoPanel: document.getElementById('ammo-panel'),
};

/**
 * Renderer-specific state — arrays of DOM elements representing the 3D scene.
 * Rebuilt each map load. Game logic should not access these.
 *
 * Each entry in `sceneStates` owns its own wallElements/surfaceElements/
 * thingDom/etc. for one pane. The legacy `sceneState` export is
 * `sceneStates[0]` for backwards compatibility and will be removed once all
 * readers iterate the array.
 */
function makeSceneState() {
    return {
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
        thingDom: new Map(),           // Map<thingIndex, { element, sprite }>
        projectileDom: new Map(),      // Map<projectileId, element>
        // CSS perspective distance in pixels. Determines the field of view;
        // also used as a translateZ offset to position the camera correctly.
        perspectiveValue: 700,
    };
}

export const sceneStates = renderers.map(() => makeSceneState());
export const sceneState = sceneStates[0];
