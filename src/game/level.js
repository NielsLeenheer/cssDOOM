/**
 * Level — one loaded map being simulated.
 *
 * Game owns Level construction for normal gameplay (Game.beginPlay /
 * Game.advance / Game.restartMatch). Callers without a Game (attract,
 * debug warp, SP dead-respawn) use the `swapLevel(name)` helper at
 * the bottom of this file, which constructs + loads + starts a Level
 * and registers it as the current Level for this window.
 *
 * Level emits `changing` / `loaded` / `level-complete` / `player-died`
 * / `player-spawned`. The module-level emitter handles `changing` /
 * `loaded` (cross-instance subscribers); per-instance events flow
 * through each Level's own `on`.
 */

import { EYE_HEIGHT } from '../shared/constants.js';
import { state } from './state.js';
import { updateGame } from './index.js';
import { transitionToLevel, resetGameState } from './player/damage.js';
import { buildSectorAdjacency } from './sound-propagation.js';
import { clearSpatialGrid, buildSpatialGrid } from './spatial-grid.js';
import { initDoorsState } from './mechanics/doors.js';
import { initLiftsState } from './mechanics/lifts.js';
import { initCrushersState } from './mechanics/crushers.js';
import { initThingsState } from './entities/things-init.js';
import { initSpStats } from './sp-stats.js';
import * as maps from '../shared/maps/index.js';
import { applyPlayerStart, addPlayerThings, broadcastPlayerSprites } from './player/start.js';
import { orchestrator } from '../orchestrator.js';
import { orchestrator as renderer } from "../orchestrator.js";

/**
 * Module-level registry for "the Level currently being simulated by
 * this window." Set by Game.beginPlay (the canonical path) and by
 * `swapLevel` (callers without a Game). Read by the RAF tick and
 * the level-event call sites in switches / damage / spawn.
 *
 * Two accessors are intentional: `getCurrentLevel` is the stable read
 * API used by callers. The underscored `_setCurrentLevel` is for the
 * writers — by convention only Game and `swapLevel` touch it.
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
        const isInitialLoad = !maps.currentMap;

        // Tell any connected client that the scene is about to be
        // rebuilt. Subscribers (master.js's broadcast setup) subscribe
        // via onLevel('changing', ...) at boot and call
        // `beginCoordinatedLoad` to reset per-session readyToPlay
        // flags + pause LOOKING before the orchestrator.loadMap
        // fan-out below sends the `cmd-world loadMap` envelope to
        // every alive peer.
        //
        // Fires unconditionally — including on the initial load. A
        // tempting shortcut would be to skip this when isInitialLoad
        // is true (rationale: "no client connected yet"), but Network
        // DM host doesn't preload — the FIRST Level.load happens at
        // host-fire-start, with joiners already waiting in the lobby.
        // They need this event so master's beginCoordinatedLoad
        // primes the handshake before their cmd-world loadMap arrives.
        //
        // The fade-in is gated on !isInitialLoad — there's no scene
        // to fade FROM on the very first load. The orchestrator's
        // showLevelTransition is idempotent: if a caller (Game.advance
        // covering intermission teardown, Game.beginPlay covering
        // lobby teardown) already raised the cover, this await
        // resolves immediately because each pane's impl returns an
        // already-resolved promise when it's already visible.
        _emitLevelEvent('changing', { name });
        if (!isInitialLoad) {
            await this.orchestrator.dispatch({ type: 'world', cmd: 'showLevelTransition', args: [] });
        }

        // Tear down the previous map's per-level geometry state BEFORE
        // maps.load runs enrichment. maps.load → initThings computes each
        // thing's floorHeight via getFloorHeightAt, which reads two pieces
        // of engine state:
        //   - the spatial grid (forEachSectorAt uses it when built, else
        //     falls back to mapData.sectorPolygons), and
        //   - state.liftState (a lift sector reports its animated height).
        // If either still holds the OUTGOING level here, the new map's
        // things get floor heights from the previous level's geometry:
        // a stale grid drops everything to floor 0, and a stale lift whose
        // sector index happens to coincide with a new sector overrides
        // that sector's floor. Clearing both forces initThings onto the
        // freshly-set mapData with no lifts — exactly the state a fresh
        // initial load runs in (no grid, empty liftState) — so barrels and
        // decorations sit at the correct height after a transition. The
        // new map's lifts are rebuilt by initLiftsState below; a thing
        // resting on a lift sits at its upper height, which equals the
        // sector's static floor, so omitting lifts here is correct.
        // (Renderer-side teardown — DOM clear + iOS GPU-release yield — is
        // owned by scene.loadMap and runs there per-renderer.)
        if (!isInitialLoad) {
            clearSpatialGrid();
            state.liftState = new Map();
        }

        // Fetch + enrich mapData. Mutates `maps.mapData` and
        // `maps.currentMap`. State.* is NOT touched here — that's
        // the initThingsState / initDoorsState / etc. calls below.
        await maps.load(name);
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

        // Game-side state init: populates state.things, state.doorState,
        // state.liftState, state.crusherState from the enriched mapData.
        // Map enrichment (mapData.things annotations, door.trackWalls)
        // already ran inside maps.load above.
        initThingsState();
        initDoorsState();
        initLiftsState();
        initCrushersState();

        // Prime each renderer's own state.camera BEFORE scene.loadMap's
        // per-renderer warmup reads it. applyPlayerStart just wrote
        // each player's new x/y/z/angle into state.players; this
        // updateCamera dispatch fans to every target at the matching
        // slot — the local DomRenderer's impl writes its state.camera
        // and the local AudioRenderer writes its listener's. The
        // fan-out also forwards over each RenderSink to its joiner, so
        // the joiner's scene.loadMap warmup primes against fresh data
        // instead of whatever was left in its per-renderer state from
        // the previous map. Renderers read their own state.camera —
        // never state.players directly — so this priming step is what
        // makes the warmup land correct values.
        for (const player of state.players) {
            renderer.dispatch({ type: 'player', slot: player.viewportIndex, cmd: 'updateCamera', args: [{
                x: player.x,
                y: player.y,
                z: player.z,
                angle: player.angle,
                floorHeight: player.floorHeight ?? 0,
                isFiring: player.isFiring,
            }] });
        }

        // Fan the load to every render target. Each local DomRenderer
        // runs scene.loadMap (clear-if-needed, yield-if-cleared, build,
        // prime camera + culling). Each RenderSink forwards a
        // `cmd-world loadMap` envelope to its remote. Promise.all of
        // per-target results so we synchronize on every local renderer
        // being built before proceeding to the game-side post-build.
        await this.orchestrator.dispatch({ type: 'world', cmd: 'loadMap', args: [name] });

        // Game-side post-build: spatial grid (needs state.things),
        // player thing entries (state-only — pushes player entries
        // into state.things for collision / damage / AI targeting;
        // the per-renderer createPlayerSprite fan-out is the caller's
        // job, fired via broadcastPlayerSprites after every receiving
        // renderer's scene is built), sound graph.
        buildSpatialGrid();
        addPlayerThings();
        buildSectorAdjacency();
        // Reset SP stats and start the per-level timer. No-op in DM.
        initSpStats();

        // Drop camera from intro height to eye level after scene is
        // ready — every active player's pane gets the drop animation
        // (CSS transition on --player-z smooths the jump).
        setTimeout(() => {
            for (const p of state.players) p.z = p.floorHeight + EYE_HEIGHT;
        }, 600);

        // Hide unconditionally — covers Level.load's own show (above)
        // and any caller-raised cover. Each pane's impl no-ops when
        // the cover wasn't visible, so this is safe on every path
        // including the truly-initial-load case.
        this.orchestrator.dispatch({ type: 'world', cmd: 'hideLevelTransition', args: [] });

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

/**
 * Construct a fresh Level for the named map, load it, start ticking,
 * and register it as the current Level for this window.
 *
 * Used by master-side callers that swap maps mid-session WITHOUT
 * going through the full Game lifecycle:
 *   - attract.js::enterAttract — kiosk idle, no Game-managed match.
 *   - debug/console/console.js — debug.player.position.load save-slot warp.
 *   - gates.js — SP dead-respawn after cooldown (no Game.respawnSP()
 *     exists yet; future cleanup would add one and drop this caller).
 *
 * Game-managed transitions (SP intermission advance, DM
 * restartMatch, kiosk match restart) construct Levels directly via
 * Game.beginPlay / Game.restartMatch / Game.advance — they don't
 * call this.
 *
 * Joiner-side never calls this. The joiner doesn't construct
 * Levels — it receives `cmd-world loadMap` envelopes through
 * RenderClient, which dispatches to its local orchestrator.loadMap
 * and signals MSG.READY_TO_PLAY after the scene rebuild resolves.
 *
 * Levels constructed here are NOT routed through
 * Game._subscribeLevel, so per-Level events (player-died,
 * player-spawned, level-complete) don't reach a Game handler.
 * Current callers don't trigger those events on Levels they create.
 * Future callers that need the subscription should go through
 * Game.beginPlay.
 */
export async function swapLevel(name) {
    const lvl = new Level({
        map: name,
        players: state.players,
        rules: state.match?.rules ?? null,
        orchestrator,
    });
    await lvl.load();
    // No remote-joiner await in this path (callers: attract, debug
    // warp, match-restart fallback) — master's local renderers are
    // already built by Level.load's awaited orchestrator.loadMap, so
    // it's safe to fan the player billboards out now.
    broadcastPlayerSprites();
    lvl.start();
    _setCurrentLevel(lvl);
    return lvl;
}
