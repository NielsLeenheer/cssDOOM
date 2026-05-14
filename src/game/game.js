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
    beginPlay()          { /* L2.5 / L2.6 */ }
    restartMatch()       { /* L2.5 */ }
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
}
