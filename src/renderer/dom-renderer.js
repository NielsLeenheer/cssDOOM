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
import { wireWeaponEvents } from './hud/weapons.js';
import * as spectator from './spectator.js';

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
        // Explicit type marker. Orchestrator uses `target.kind` to
        // distinguish local DomRenderers from RenderSinks instead of
        // duck-typing on method existence — see
        // orchestrator.bindRemoteSlot / unbindRemoteSlot.
        this.kind = 'dom';

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

        // Per-renderer world view — the camera this renderer renders
        // from and the array of things-in-the-world this renderer
        // knows about (positions, collected flags). Populated by the
        // renderer-command impls (updateCamera, updateThingPosition,
        // collectItem, etc.) as they receive dispatches. Read by the
        // culler and the scene warmup. Independent per renderer —
        // sibling renderers in the same window each have their own.
        this.state = makeRendererState();

        // Remembered for `reload()` — set inside scene.loadMap on
        // each successful load. Null until the first load completes.
        this._lastLoadedMap = null;

        // Watch this pane's viewport for size changes and recompute
        // perspective whenever it shifts. The observer covers every
        // trigger that used to need an external call — window resize
        // (viewport tracks window size), bind/unbind layout reflow
        // (sibling pane appearing/disappearing changes viewport
        // clientWidth), and the initial observe call sets the
        // perspective at construction time. No external trigger needed.
        this._perspectiveObserver = new ResizeObserver(() => updatePerspective(this));
        this._perspectiveObserver.observe(this.viewportEl);

        // Wire per-renderer DOM-event listeners that need to live as
        // long as the pane element. Attached here (not at module-load
        // in weapons.js) so each renderer owns its own listener on
        // its own element — when the pane is destroyed, the listener
        // is GC'd with it.
        wireWeaponEvents(this.weaponEl);
    }

    /**
     * Live camera the culler reads for this renderer's viewer.
     * Populated by `updateCamera` dispatches (the impl writes both
     * the DOM transform AND `renderer.state.camera`).
     */
    get camera() {
        return this.state.camera;
    }

    /**
     * True once this renderer has built a scene at least once. Read
     * by scene.loadMap to decide whether teardown (clear + iOS yield)
     * is needed, and by updateCulling to skip a pass on an unbuilt
     * pane. wallElements.length is the source of truth: empty until
     * buildWalls populates it; cleared back to empty by clear().
     */
    get hasScene() {
        return this.sceneState.wallElements.length > 0;
    }

    /**
     * Rebuild this renderer's scene against whatever map it last
     * loaded. No-op if no map has been loaded yet (renderer was
     * constructed but never built — possible for a slot bound
     * straight to a remote sink, then never serviced locally).
     *
     * Used by orchestrator.unbindRemoteSlot's grace-expiry to
     * restore a pane after a remote leaves. Putting the "what map
     * was I last on?" memory on the renderer itself means the
     * orchestrator doesn't need to import the maps layer just to
     * know what to reload.
     */
    async reload() {
        if (this._lastLoadedMap == null) return;
        await this.loadMap(this._lastLoadedMap);
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
        if (!this.hasScene) return;
        runCulling(this, this.state.things, spectatorActive, collectStats);
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

/** Initial per-renderer world-view state. `camera` is the single
 *  viewer the culler / DOM transforms key off; `things[i]` records
 *  the position + collected flag for each in-world thing the
 *  renderer needs to draw / cull. Populated lazily by the impls
 *  (updateCamera, updateThingPosition, etc.). */
export function makeRendererState() {
    return {
        camera: { x: 0, y: 0, z: 0, angle: 0, floorHeight: 0, isFiring: false },
        things: [],
    };
}

/** Lazily allocate a per-thing state entry on a renderer. Used by
 *  the renderer-command impls that update thing position / collected
 *  state. */
export function ensureThing(state, thingIndex) {
    let thing = state.things[thingIndex];
    if (!thing) {
        thing = state.things[thingIndex] = {
            x: 0, y: 0, floorHeight: 0, collected: false,
        };
    }
    return thing;
}

