/**
 * Level — one loaded map being simulated.
 *
 * `load()` mirrors the body of `loadMap()` in `shared/maps.js` — same
 * calls, same order, same side effects on `state.*`. Game owns Level
 * construction; `loadMap` survives as a shim for the callers that
 * don't hold a Level instance (menu, debug, mechanics/switches,
 * RemoteGame, attract). Level emits `changing` / `loaded` /
 * `level-complete` / `player-died` / `player-spawned`; the
 * module-level emitter handles `changing` / `loaded` (cross-instance
 * subscribers) and per-instance events go through each Level's own
 * `on`.
 */

import { EYE_HEIGHT } from './constants.js';
import { state } from './state.js';
import { updateGame } from './index.js';
import { transitionToLevel, resetGameState } from './player/damage.js';
import { domRendererManager } from '../renderer/dom-renderer-manager.js';
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

/**
 * Module-level registry for "the Level currently being simulated by
 * this window." Set by `loadMap()` (the shim) and by Game.beginPlay;
 * read by the RAF tick and the level-event call sites in switches /
 * damage / spawn.
 *
 * Two accessors are intentional: `getCurrentLevel` is the stable read
 * API used by callers. The underscored `_setCurrentLevel` is for the
 * writers — by convention only `loadMap` and Game touch it.
 */
let _currentLevel = null;
export function getCurrentLevel() { return _currentLevel; }
export function _setCurrentLevel(lvl) { _currentLevel = lvl; }

/**
 * Module-level emitter for level-lifecycle events that need to be
 * observed across Level instances. Per-instance events
 * (level-complete / player-died / player-spawned) still flow through
 * each Level's own on / _emit pair — those are bound to a specific
 * Level. The events emitted here ('changing' / 'loaded') fire from
 * `Level.load()` and replace the earlier `cssdoom:level-changing` /
 * `cssdoom:level-loaded` window-event side-channel. Subscribers
 * (today: master.js's broadcast setup) subscribe ONCE at boot and
 * see events from every future Level instance — no per-instance
 * re-subscription needed.
 */
const _levelListeners = new Map();

export function onLevel(eventName, handler) {
    if (!_levelListeners.has(eventName)) _levelListeners.set(eventName, new Set());
    _levelListeners.get(eventName).add(handler);
}

function _emitLevelEvent(eventName, payload) {
    const set = _levelListeners.get(eventName);
    if (set) for (const h of set) h(payload);
}

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
        // rebuilt. Subscribers (master.js's broadcast setup) subscribe
        // via onLevel('changing', ...) at boot and turn the event into
        // MSG.LOAD_MAP for every alive peer.
        //
        // Fires unconditionally — including on the initial load. A
        // tempting shortcut would be to skip this when isInitialLoad
        // is true (rationale: "no client connected yet"), but Network
        // DM host doesn't preload — the FIRST Level.load happens at
        // host-fire-start, with joiners already waiting in the lobby.
        // They need this event to start their own load.
        //
        // The showLevelTransition fade is still gated on
        // !isInitialLoad — there's no scene to fade FROM on the very
        // first load.
        _emitLevelEvent('changing', { name });
        if (!isInitialLoad) {
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
            for (const r of domRendererManager.all) r.clear();
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
        // manager's registry already reflects what this window needs
        // (1 in SP, 2 in mirror SP / DM, 1 on a non-kiosk client,
        // etc.) — boot / mode-switch code constructs and destroys to
        // match.
        await Promise.all(domRendererManager.all.map(r => r.loadMap()));

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
        for (const r of domRendererManager.all) {
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
        // no-op case.
        _emitLevelEvent('loaded', { name });

        this._state = 'loaded-paused';
    }

    /**
     * Transitions to the running state. From here on, the RAF caller's
     * per-frame `tick()` will run the world step. Safe to call multiple
     * times (idempotent).
     */
    start() {
        this._state = 'loaded-running';
    }

    /**
     * Per-frame entry point. Invoked from the RAF caller (currently
     * `master.js::gameLoop`; moves onto App in L3). No-op unless the
     * Level is loaded-running — `loaded-paused` and `unloaded` swallow
     * the call so a paused match does not advance state.
     */
    tick(timestamp) {
        if (this._state !== 'loaded-running') return;
        updateGame(timestamp);
    }

    /**
     * Stop ticking without destroying state. The next `resume()` (or
     * `start()`) picks up from the same world snapshot. Idempotent —
     * already-paused or unloaded Levels are unchanged. Used by Game
     * when the App menu opens (wired in L5).
     */
    pause() {
        if (this._state === 'loaded-running') {
            this._state = 'loaded-paused';
        }
    }

    /**
     * Resume ticking after a pause. Same effect as `start()` but named
     * for the post-pause path. Idempotent — already-running or
     * unloaded Levels are unchanged. Calling resume on an `unloaded`
     * Level is intentionally a no-op rather than an error, so
     * Game.resume() doesn't have to special-case "no level loaded yet".
     */
    resume() {
        if (this._state === 'loaded-paused') {
            this._state = 'loaded-running';
        }
    }
    /**
     * Halt the per-frame tick without clearing world state. Same flag
     * effect as `pause()`, but named for the teardown path: Game calls
     * `stop()` before `destroy()` so the world stops advancing while
     * destruction happens. Idempotent.
     *
     * Why stop() exists alongside pause() despite identical body:
     * intent at the call site. pause() is a transient interruption
     * with an expected `resume()` on the same Level instance (e.g.
     * menu open / close). stop() is the pre-destruction halt — no
     * `resume()` will ever follow, so naming it `stop()` makes the
     * teardown sequence read straight.
     */
    stop() {
        if (this._state === 'loaded-running') {
            this._state = 'loaded-paused';
        }
    }

    /**
     * Clear the world-state singletons this Level was simulating into,
     * and mark the instance as unloaded. After destroy(), tick() is
     * a no-op even if start()/resume() were somehow called again.
     *
     * Touches ONLY the Level-owned `state.*` fields (things,
     * projectiles, doors, lifts, crushers). Does NOT touch Game-owned
     * fields (players, match, gameMode, etc.) or renderer DOM. The
     * renderer DOM exclusion is deliberate: kiosk warm attract
     * (IN_GAME → ATTRACT) relies on the scene surviving Level
     * teardown so attract can fade the HUD and rotate the captured
     * camera over the same geometry.
     *
     * Called by `Game.stop()` when tearing down a Level instance.
     * `loadMap` for callers without a Game instance still does its
     * own teardown-then-rebuild inline.
     */
    destroy() {
        state.things.length = 0;
        state.projectiles.length = 0;
        state.nextProjectileId = 0;
        state.doorState.clear();
        state.liftState.clear();
        state.crusherState.clear();
        this._state = 'unloaded';
    }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
