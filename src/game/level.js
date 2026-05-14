/**
 * Level — one loaded map being simulated.
 *
 * L1.2 fills in `load()`. Other methods stay stubs:
 *   L1.3 — start() + tick()
 *   L1.4 — pause() / resume()
 *   L1.5 — stop() / destroy()
 *   L1.6 — wires level-complete / player-died / player-spawned emits
 *           from existing callers
 *   L1.7 — _setCurrentLevel / getCurrentLevel registry helpers
 *
 * See LIFECYCLE_REFACTOR.md §5 (Level state machine) and §8 (Level API)
 * for the target contract.
 *
 * `load()` mirrors the body of today's `loadMap()` in `shared/maps.js`
 * exactly (same calls, same order, same side effects on `state.*`,
 * same `cssdoom:*` window-event dispatches, same setTimeouts). Once
 * Game owns Level construction (L2), this body stays put — only the
 * caller changes. The `cssdoom:*` dispatches get torn out in L4.
 */

import { EYE_HEIGHT } from './constants.js';
import { state } from './state.js';
import { transitionToLevel, resetGameState } from './player/damage.js';
import { domRenderers } from '../renderer/dom.js';
import { showLevelTransition, hideLevelTransition } from '../ui/overlay.js';
import { buildSectorAdjacency } from './sound-propagation.js';
import { clearSpatialGrid, buildSpatialGrid } from './spatial-grid.js';
import { initDoors } from './mechanics/doors.js';
import { initLifts } from './mechanics/lifts.js';
import { initCrushers } from './mechanics/crushers.js';
import { initThings } from './entities/things-init.js';
import { initSpStats } from './sp-stats.js';
import { updateCulling } from '../renderer/scene/culling.js';
import * as renderer from '../renderer/index.js';
import {
    fetchMapJson,
    decorateMapData,
    _setMapData,
    _setCurrentMap,
    getCurrentMap,
    applyPlayerStart,
    addPlayerThings,
} from '../shared/maps.js';

export class Level {
    constructor({ map, players, rules, orchestrator }) {
        this.map = map;
        this.players = players;
        this.rules = rules;
        this.orchestrator = orchestrator;

        this._listeners = new Map();
        this._state = 'unloaded'; // 'unloaded' | 'loaded-paused' | 'loaded-running'
    }

    async load() {
        const name = this.map;
        const isInitialLoad = !getCurrentMap();

        // Tell any connected client that the scene is about to be
        // rebuilt. Skipped on the very first load (no client could be
        // connected yet). Listener lives in master setup; the dispatch
        // is fire-and-forget. Removed in L4 when window events go away.
        if (!isInitialLoad) {
            window.dispatchEvent(new CustomEvent('cssdoom:level-changing', { detail: { level: name } }));
            await showLevelTransition();
        }

        const mapData = await fetchMapJson(name);
        _setCurrentMap(name);
        _setMapData(mapData);
        decorateMapData(mapData);
        applyPlayerStart();

        // Death restarts with a full reset (health/ammo/weapons); level
        // transitions keep the player's inventory intact. Mode-switch
        // from menu marks player 0 dead before reload to force the
        // reset path.
        if (isInitialLoad || state.players[0].isDead) {
            resetGameState();
        } else {
            transitionToLevel();
        }

        if (!isInitialLoad) {
            // Tear down every renderer's scene and yield to the browser
            // so iOS Safari can release GPU-backed texture memory
            // before the next loadMap allocates new elements.
            for (const r of domRenderers) r.clear();
            clearSpatialGrid();
            await new Promise(r => setTimeout(r, 100));
        }

        // Game-side level init: mutates state.* (state.things,
        // state.doorState, state.liftState, state.crusherState),
        // annotates mapData with the render specs that buildScene reads
        // (mapData.thingRenderSpecs, door.trackWalls). No renderer
        // commands fire here.
        initThings();
        initDoors();
        initLifts();
        initCrushers();

        // Build every local renderer's scene independently. The
        // `domRenderers` registry already reflects what this window
        // needs (1 in SP, 2 in mirror SP / DM, 1 on a non-kiosk client,
        // etc.) — boot / mode-switch code constructs and destroys to
        // match.
        await Promise.all(domRenderers.map(r => r.loadMap()));

        // Game-side post-build: spatial grid (needs state.things),
        // player thing entries (creates player billboards via renderer
        // command), sound graph.
        buildSpatialGrid();
        addPlayerThings();
        buildSectorAdjacency();
        // Reset SP stats and start the per-level timer. No-op in DM.
        initSpStats();

        // Initial render pass — primes camera transforms and runs
        // culling once synchronously so the browser doesn't have to
        // composite the entire level on the first frame.
        for (const player of state.players) {
            renderer.updateCamera(player, player.viewportIndex);
        }
        for (const r of domRenderers) {
            updateCulling(r, state.things, false);
        }

        // Drop camera from intro height to eye level after scene is
        // ready — every active player's pane gets the drop animation
        // (CSS transition on --player-z smooths the jump).
        setTimeout(() => {
            for (const p of state.players) p.z = p.floorHeight + EYE_HEIGHT;
        }, 600);

        if (!isInitialLoad) {
            hideLevelTransition();
        }

        // Tell master's broadcast layer that the scene is rebuilt and
        // it's safe to accept client reconnections again. Fires on
        // every load (initial too); the master listener handles the
        // no-op case. Removed in L4.
        window.dispatchEvent(new CustomEvent('cssdoom:level-loaded', { detail: { level: name } }));

        this._state = 'loaded-paused';
    }

    start()   { /* L1.3 */ }
    pause()   { /* L1.4 */ }
    resume()  { /* L1.4 */ }
    stop()    { /* L1.5 */ }
    destroy() { /* L1.5 */ }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
