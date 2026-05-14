/**
 * Game — one match / session.
 *
 * Skeleton only. Bodies land in subsequent L2 steps:
 *   L2.3 — claimSlot() + roster ownership
 *   L2.4 — Level event subscriptions (level-complete / player-died /
 *          player-spawned)
 *   L2.5 — match.js logic absorption (beginPlay / restartMatch / endMatch)
 *   L2.6 — lobby UI ownership (showLobby / updateLobbyState / hideLobby
 *          renderer commands)
 *   L2.7 — intermission UI ownership (advance())
 *   L2.8 — results / scoreboard UI ownership
 *   L2.9 — master.js boots a Game; Game constructs Levels
 *   L5   — pause() / resume()
 *
 * See LIFECYCLE_REFACTOR.md §4 (Game state machine) and §7 (Game API)
 * for the target contract.
 *
 * `_transitionTo` writes `body.dataset.gameState`. Today
 * `src/game/game-state.js`'s legacy machine also writes that attribute;
 * the two coexist until L3.4 deletes the old machine. Until something
 * actually calls Game._transitionTo (L2.5+), only the legacy writer
 * fires, so the two don't race.
 */

import { state } from './state.js';
import { ensurePlayerCount } from '../mode.js';
import { Level, _setCurrentLevel } from './level.js';
import { orchestrator } from '../orchestrator.js';
import { getNextMap } from '../shared/maps.js';

export class Game {
    constructor(modeConfig) {
        this.modeConfig = modeConfig;
        this.gameMode = modeConfig.gameMode;
        this.networkMode = modeConfig.networkMode;
        this.rules = modeConfig.rules ?? null;
        this.skillLevel = modeConfig.skillLevel ?? 3;

        // Authoritative roster. Aliased to `state.players` so legacy code
        // reading state.players (movement, damage, AI, renderer) sees
        // Game-driven updates with no copy step. `state.players` is
        // mutated in place (ensurePlayerCount pushes; never reassigns),
        // so the alias stays stable across the Game's lifetime.
        //
        // Per LIFECYCLE_REFACTOR.md §10 the eventual richer shape is
        // `{ slot, kind, deviceId, ready, player }` per entry. For L2.3
        // the simpler alias matches the spec's `this.roster = state.players`
        // sketch and avoids inventing a parallel structure ahead of
        // L2.6's lobby UI ownership move, when the richer shape will
        // actually be needed.
        this.roster = state.players;

        // The currently-loaded Level (or null between LOBBY and the
        // first PLAYING entry, and between RESULTS and the next LOBBY).
        // Game constructs and tears down Levels in L2.5 / L2.6.
        this.level = null;

        // Map for the next match start. SP advances through the cycle on
        // INTERMISSION → LOADING; DM advances on RESULTS → LOBBY per §4b.
        this.mapCursor = modeConfig.startMap ?? 'E1M1';

        this._state = 'LOBBY'; // §4: new Game() → LOBBY always
        this._listeners = new Map();
    }

    async start()        { /* L2.5 / L2.6 */ }
    pause()              { /* L5 */ }
    resume()             { /* L5 */ }
    async stop()         { /* L2.5 */ }
    /**
     * Record that `deviceId` has claimed `slot`. Ensures the underlying
     * `state.players[slot]` Player exists (extending the roster if
     * needed) and emits `roster-updated` for subscribers.
     *
     * L2.3 is intentionally minimal: today's claim flow still runs
     * through `input/claim-registry.js` (each input module calls
     * `tryClaimSlot(deviceId)` directly and lobby UI subscribes to
     * `onClaimChange`). Game.claimSlot is the parallel future entry
     * point; L2.6 cuts over once lobby UI moves into Game.
     */
    claimSlot(slot, deviceId) {
        ensurePlayerCount(slot + 1);
        this._emit('roster-updated', {
            slot,
            deviceId,
            roster: this.roster,
        });
    }
    /**
     * Roster is finalized — construct the Level for `this.mapCursor`,
     * load it, start it, and transition through LOBBY → LOADING →
     * PLAYING. Today's match.js still owns the actual match-start
     * trigger (`startMatch`); L2.5b cuts match.js over to call this.
     *
     * SP and Local DM use the same monolithic load-then-start path
     * for L2.5a. The Local DM "background load during claim UI" /
     * direct LOBBY → PLAYING optimization from §3b lands when lobby
     * UI moves into Game (L2.6). Network DM extension (LOAD_MAP
     * broadcast + ready-to-play handshake per §12) is L6.
     *
     * `_setCurrentLevel(this.level)` keeps the legacy `getCurrentLevel`
     * registry in sync so the existing per-frame tick caller in
     * master.js and the level-event emit sites in switches.js /
     * damage.js / spawn.js continue to find the right Level
     * instance. L7 retires the registry once master.js routes through
     * `app.game.level` directly.
     */
    async beginPlay() {
        this._transitionTo('LOADING');
        this.level = new Level({
            map: this.mapCursor,
            players: this.roster,
            rules: this.rules,
            orchestrator,
        });
        this._subscribeLevel(this.level);
        await this.level.load();
        this.level.start();
        _setCurrentLevel(this.level);
        this._transitionTo('PLAYING');
    }

    /**
     * RESULTS → LOBBY transition for DM. Advances `mapCursor` per
     * the §4b cycle (currently uses `getNextMap` from shared/maps.js;
     * secret-exit handling per §4b is deferred to L2.8 along with the
     * results overlay).
     *
     * Does NOT tear down `this.level` — that already happened at
     * PLAYING → RESULTS per §12 (Match end). RESULTS → LOBBY is the
     * pure state transition; the next match's Level is constructed
     * lazily by the next `beginPlay()`.
     *
     * Today's match.js owns the actual restart trigger; L2.5b cuts
     * over.
     */
    restartMatch() {
        const next = getNextMap();
        if (next) this.mapCursor = next;
        this._transitionTo('LOBBY');
        this._emit('match-restarted', { mapCursor: this.mapCursor });
    }

    advance()            { /* L2.7 */ }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }

    /**
     * Internal state transition. Updates `_state`, writes the body
     * attribute that CSS reads, and emits `state-changed`. Callers
     * (Game's own methods) use this rather than assigning `_state`
     * directly so subscribers and the DOM stay in sync.
     */
    _transitionTo(newState) {
        const from = this._state;
        this._state = newState;
        document.body.dataset.gameState = newState;
        this._emit('state-changed', { from, to: newState });
    }

    /**
     * Wire this Game's handlers onto a Level's event emitter. Called
     * by `beginPlay()` (L2.5 / L2.9) immediately after constructing
     * `this.level`. Not invoked automatically in L2.4 — Game doesn't
     * own a Level yet — so the handlers below are reachable only via
     * a manual `g._subscribeLevel(lvl)` from the dev console for now.
     */
    _subscribeLevel(level) {
        level.on('level-complete', (p) => this._onLevelComplete(p));
        level.on('player-died',    (p) => this._onPlayerDied(p));
        level.on('player-spawned', (p) => this._onPlayerSpawned(p));
    }

    /**
     * Reacts to Level emitting `level-complete`. SP: PLAYING →
     * INTERMISSION. DM: PLAYING → RESULTS (vanilla DOOM exit-ends-
     * match per §4b). Re-emits at the Game layer so App-side
     * listeners can react.
     *
     * Does NOT trigger UI side effects yet — today's switches.js
     * still owns the SP `showIntermission` call and the DM
     * `setTimeout(loadMap, 1000)` path. UI ownership migrates in
     * L2.7 (intermission) / L2.8 (results), at which point the
     * inline switches.js paths get torn out and Game becomes the
     * single trigger.
     */
    _onLevelComplete(payload) {
        if (this.gameMode === 'singleplayer') {
            this._transitionTo('INTERMISSION');
        } else {
            this._transitionTo('RESULTS');
        }
        this._emit('level-complete', payload);
    }

    /**
     * Reacts to Level emitting `player-died`. DM scoring + frag-limit
     * detection still lives in damage.js / match.js for L2.5a; Game's
     * handler is a pure re-emit so App-side observers can subscribe
     * without duplicating side effects. L4 cleans up the legacy
     * inline handling once Game owns the response end-to-end.
     */
    _onPlayerDied(payload) {
        this._emit('player-died', payload);
    }

    /**
     * Reacts to Level emitting `player-spawned`. Informational — pure
     * re-emit. The respawn-overlay-hide work is deferred to L2.8
     * along with the rest of the per-slot overlay lifecycle.
     */
    _onPlayerSpawned(payload) {
        this._emit('player-spawned', payload);
    }
}
