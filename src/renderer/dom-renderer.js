/**
 * DomRenderer — one rendering unit, one pane, one player's view.
 *
 * Each DomRenderer owns:
 *
 *   - Its DOM subtree: a `<div class="pane">` it created from
 *     `#pane-template`, plus the cached `rendererEl / sceneEl / viewportEl
 *     / statusEl / weaponEl` children.
 *   - Its per-pane scene state: arrays / Maps holding the wall, sector,
 *     thing, door, lift, crusher, sky, projectile DOM references for
 *     this pane.
 *   - Its camera state (the viewer's position, updated by updateCamera).
 *   - Its `playerIndex` — the player whose view it renders.
 *
 * No DomRenderer reaches into another DomRenderer's state. Cross-pane
 * fan-out is the orchestrator's job (it iterates renderers).
 *
 * Per-player and world methods on the prototype are generated from
 * [commands.js](commands.js)'s PER_PANE_COMMANDS / WORLD_COMMANDS at
 * module load. Each method calls the registered `impl` with `this`
 * (the renderer) baked in as the first arg, so impls operate directly
 * on `this.sceneState` / `this.sceneEl` / `this.viewportEl` / etc.
 * The orchestrator's per-player dispatch fans to renderers whose
 * `playerIndex` matches; its world dispatch fans to every target.
 */

import { updatePerspective } from './scene/scene.js';
import { updateCulling as runCulling } from './scene/culling.js';
import * as spectator from './spectator.js';
import { rendererState } from './renderer-state.js';

// Per-player and world command methods are bound onto this prototype
// at the bottom of `commands.js` — commands.js owns the registry and
// runs the binding after both the registry and this class are loaded.
// Doing it here used to be a circular-import TDZ hazard: any module
// in the renderer impl chain (hud.js, scene.js, etc.) that wanted to
// touch a DomRenderer would transitively pull commands.js, which in
// turn pulls hud.js again — and dom-renderer.js's binding loop fired
// before commands.js had finished defining its exports.

export class DomRenderer {
    /**
     * @param {object} options
     * @param {number} options.playerIndex   the player this renderer is for
     * @param {HTMLElement} options.gameContainer  `#game` — where the pane is appended
     * @param {HTMLTemplateElement} options.paneTemplate  `#pane-template`
     */
    constructor({ playerIndex, gameContainer, paneTemplate }) {
        this.playerIndex = playerIndex;

        // Build the pane DOM. The template carries the full per-pane
        // subtree (.renderer > .viewport > .scene + .hud + overlays).
        this.paneEl = document.createElement('div');
        this.paneEl.className = 'pane';
        this.paneEl.dataset.player = String(playerIndex);
        // `data-active="true"` marks this pane as locally-rendered. Flipped
        // to "false" by the orchestrator when a remote takes over this slot
        // (sceneEl is cleared, paneEl stays in the DOM for fast restore on
        // disconnect). CSS uses this for visibility — see viewport.css.
        this.paneEl.dataset.active = 'true';
        this.paneEl.appendChild(paneTemplate.content.cloneNode(true));
        gameContainer.appendChild(this.paneEl);

        // Cache per-pane element refs.
        this.rendererEl  = this.paneEl.querySelector('.renderer');
        this.sceneEl     = this.paneEl.querySelector('.scene');
        this.viewportEl  = this.paneEl.querySelector('.viewport');
        this.statusEl    = this.paneEl.querySelector('.status');
        this.weaponEl    = this.paneEl.querySelector('.weapon');

        // Per-pane scene state (walls, sectors, things, doors, lifts,
        // crushers, sky planes, projectile DOM, perspective). Rebuilt
        // each map load.
        this.sceneState = makeSceneState();

        // Watch this pane's viewport for size changes and recompute
        // perspective whenever it shifts. The observer covers every
        // trigger that used to need an external call — window resize
        // (viewport tracks window size), bind/unbind layout reflow
        // (sibling pane appearing/disappearing changes viewport
        // clientWidth), and the initial observe call sets the
        // perspective at construction time. No external trigger needed.
        this._perspectiveObserver = new ResizeObserver(() => updatePerspective(this));
        this._perspectiveObserver.observe(this.viewportEl);
    }

    /**
     * Live camera the culler / audio read for this renderer's viewer.
     *
     * On master, `rendererState.cameras` aliases `state.players` so the
     * lookup returns the live Player object the simulation mutates each
     * frame. On a client the array is a local mirror populated by
     * `applyCameraUpdate`. Either way, indexing by this renderer's
     * `playerIndex` gives us "the camera this pane is rendering for" —
     * including mirror SP, where both renderers share playerIndex 0 and
     * therefore both read player 0's pose.
     */
    get camera() {
        return rendererState.cameras[this.playerIndex];
    }

    /**
     * Tear the pane out of the DOM. Scene-state arrays are left in
     * place — a follow-on map load would re-populate them — and the
     * referenced DOM nodes are gone with the pane.
     */
    destroy() {
        this._perspectiveObserver.disconnect();
        this.paneEl.remove();
    }

    /**
     * Drop this renderer's DOM and reset its scene-state. Used by the
     * orchestrator when a remote client takes over this slot — master
     * stops painting an invisible subtree until the client disconnects
     * (at which point loadMap() rebuilds it).
     *
     * `loadMap(name)` itself is bound onto this prototype by the
     * COMMANDS auto-binding loop in `./commands.js` — it routes to
     * `scene.loadMap(this, name)`, which fetches/enriches mapData,
     * builds the scene fragment, absorbs it into this renderer, and
     * primes camera + culling for the first composited frame.
     */
    clear() {
        this.sceneEl.replaceChildren();
        Object.assign(this.sceneState, makeSceneState());
    }

    /**
     * Run one culling pass on this pane. Delegates to culling.js's
     * algorithm with `this` as the renderer arg. Skips when the pane
     * has no camera (e.g. an unbound slot) or no built geometry yet.
     * Called by `DomRendererManager`'s culling loop, which schedules
     * each renderer's pass at a staggered cadence.
     */
    updateCulling(spectatorActive, collectStats) {
        if (!this.camera) return;
        if (this.sceneState.wallElements.length === 0) return;
        runCulling(this, rendererState.things, spectatorActive, collectStats);
    }

    // ── Spectator mode ───────────────────────────────────────────────────
    // Thin delegates to `renderer/spectator.js`. Spectator is SP-only;
    // these methods only meaningfully run on the primary renderer (slot
    // 0). See `renderer/spectator.js` for the choreography details
    // (body class toggles, scene transitions, ceiling fades) and
    // `Orchestrator`'s `startSpectatorMode` / etc. for the public surface
    // the UI calls through.
    setSpectatorCamera(camera)         { spectator.setSpectatorCamera(this, camera); }
    setSpectatorFollowHeight(height)   { spectator.setSpectatorFollowHeight(this, height); }
    setSpectatorAngle(angle)           { spectator.setSpectatorAngle(this, angle); }
    startSpectatorMode(mode)           { spectator.startSpectatorMode(this, mode); }
    switchSpectatorMode(mode)          { spectator.switchSpectatorMode(this, mode); }
    endSpectatorMode()                 { spectator.endSpectatorMode(this); }
}

export function makeSceneState() {
    return {
        wallElements: [],
        surfaceElements: [],
        sectorContainers: [],
        thingContainers: [],
        doorContainers: new Map(),
        liftContainers: new Map(),
        crusherContainers: new Map(),
        skyWallPlanes: [],             // sky wall occluders
        skySectors: new Set(),         // sector indices with sky ceilings
        skyGroupOf: new Map(),         // Map<sectorIndex, groupId>
        thingDom: new Map(),           // Map<thingIndex, { element, sprite }>
        projectileDom: new Map(),      // Map<projectileId, element>
        perspectiveValue: 700,
    };
}

