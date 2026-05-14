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
import { Level, _setCurrentLevel, getCurrentLevel } from './level.js';
import { orchestrator } from '../orchestrator.js';
import { getNextMap } from '../shared/maps.js';
import { resetMatch, startMatch } from './match.js';
import { spawnPlayer } from './player/spawn.js';
import { onClaimChange, isSlotClaimedLocally } from '../input/claim-registry.js';

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

    /**
     * Boot the Game. Enters LOBBY state, pushes the showLobby renderer
     * command so panes (local + sinks) paint the lobby overlay, and for
     * SP auto-finalizes immediately into beginPlay (per §3b — SP roster
     * is fixed at [Player 0], no claim wait needed).
     *
     * Local DM and Network DM stay in LOBBY here; the caller is
     * responsible for triggering beginPlay later (Local DM: when all
     * slots claim, Network DM: when host fires start). Once L4 cuts
     * over, that triggering also moves into Game; today the legacy
     * lobby.js auto-start and the legacy NETWORK_START gate are still
     * authoritative.
     *
     * No caller yet (L2.9 wires master.js → Game.start). Until then
     * the only effect of calling start() manually from the dev console
     * is to push a redundant showLobby command into a UI that's already
     * being driven by the legacy event subscriptions.
     */
    async start() {
        this._transitionTo('LOBBY');
        orchestrator.showLobby({
            slots: this.roster,
            mapCursor: this.mapCursor,
        });

        // Subscribe to device→slot claim changes so Local DM
        // auto-starts when both slots are claimed. _checkAutoStart
        // is mode-gated (Local DM only) and state-gated (LOBBY
        // only — so the subscription is harmless after Game.stop
        // marks _state ENDED).
        //
        // claim-registry's onClaimChange currently has no
        // unsubscribe API; multiple Games over a session each
        // accumulate a subscription. The state-gate keeps stale
        // subscriptions inert (they bail before doing anything).
        //
        // SP doesn't need this — start() drops straight into
        // beginPlay below. Network DM uses host-fire-start via the
        // NETWORK_START gate, not all-claimed auto-start.
        onClaimChange(() => this._checkAutoStart());

        if (this.gameMode === 'singleplayer') {
            await this.beginPlay();
            return;
        }

        if (this.gameMode === 'deathmatch' && this.networkMode === 'standalone') {
            // §3b Local DM: construct + load Level immediately so the
            // lobby UI sits on top of a loaded paused scene rather
            // than on an empty pane. beginPlay later just calls
            // level.start() — skipping the LOADING phase per the
            // §3b happy path.
            await this._preloadLevel();

            // Kick the auto-start check ONCE after preload. Claims
            // persist across sessions in sessionStorage (kiosk
            // pattern — controllers stay bound to monitors), so a
            // ?kiosk boot can find both slots already claimed
            // without any user press. onClaimChange only fires on
            // CHANGE events, not on restored claims, so without
            // this synchronous check the kiosk would sit in LOBBY
            // indefinitely: no prompts visible (carriedOverClaims
            // marks both panes 'active') but state.gameState still
            // 'lobby', so input handlers that gate on ACTIVE
            // suppress everything.
            this._checkAutoStart();
            return;
        }

        // Network DM (host): no preload. Level constructs on
        // host-fire-start (L6 wiring).
    }

    /**
     * Construct + load this.mapCursor's Level and start it ticking.
     * Used by start()'s Local DM branch so the lobby UI sits on top
     * of a live (but pre-match) world — players can walk around in
     * warmup, AI animates, doors work, etc. Matches the pre-cutover
     * behavior where loadMap → world ticking during lobby was what
     * corrected player floor heights via updateMovement →
     * updateHeight.
     *
     * Idempotent — no-op when this.level already exists.
     *
     * The §3b spec describes Level as "paused" during the lobby
     * phase, but in practice the legacy world ran (gated by
     * isMatchLobby checks inside updateGame for scoring etc.).
     * Pausing the Level here regressed kiosk DM: players spawned
     * at the fallback floor height from applyDeathmatchStarts and
     * never got corrected. Starting the Level restores legacy
     * behavior; the scoring/match-clock gating inside match.js
     * (legacy) keeps the match "not active" until startMatch.
     */
    async _preloadLevel() {
        if (this.level) return;
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
    }

    /**
     * Local DM auto-start trigger. Subscribed to claim-registry
     * onClaimChange in start(). Guards:
     *   - _state must still be LOBBY (no-op after stop / once
     *     beginPlay has fired).
     *   - mode must be Local DM (SP starts via start()'s SP branch;
     *     Network DM uses host-fire).
     *   - All slots in the roster must be claimed (local OR remote
     *     — the registry tracks both via isSlotClaimedLocally and
     *     external slot sets owned by network code, but Local DM
     *     only has local claims).
     */
    _checkAutoStart() {
        if (this._state !== 'LOBBY') return;
        if (this.gameMode !== 'deathmatch') return;
        if (this.networkMode !== 'standalone') return;

        for (let i = 0; i < this.roster.length; i++) {
            if (!isSlotClaimedLocally(i)) return;
        }

        this.beginPlay();
    }
    pause()              { /* L5 */ }
    resume()             { /* L5 */ }
    /**
     * Clean teardown. Stops the held Level (if any), destroys it
     * (clears state.things / doorState / liftState / crusherState /
     * projectiles), nulls `this.level`, clears the L1.7 registry,
     * hides any open overlays, and transitions to ENDED.
     *
     * Idempotent — stop() on an already-ENDED Game is a no-op.
     *
     * Subscriber cleanup: the arrow-function handlers registered via
     * `_subscribeLevel(level)` are held by the Level's own _listeners
     * Map. When `this.level = null` clears the Game's last reference
     * and `level.destroy()` runs, the Level becomes unreachable; the
     * handlers go with it. No explicit unsubscribe needed.
     *
     * Caveat for the L4 sequence: `_transitionTo('ENDED')` writes
     * body.dataset.gameState = 'ENDED'. Legacy CSS keyed on the
     * `body[data-game-state="ended"]` selector triggers the
     * scoreboard overlay — but here we mean "Game lifecycle ended",
     * not "DM match ended with scoreboard." L4.8 audits + resolves
     * the body-class vocabulary collision. Until then Game.stop is
     * only invoked from dead-code paths (App.endGame, which has no
     * runtime caller until L4.9 cuts master.js over), so the bad
     * write never fires at runtime.
     */
    async stop() {
        if (this._state === 'ENDED') return;

        if (this.level) {
            this.level.stop();
            this.level.destroy();
            if (getCurrentLevel() === this.level) {
                _setCurrentLevel(null);
            }
            this.level = null;
        }

        // Hide any open overlays. Impls are no-ops until L4.2
        // installs real ones via the late-binding registry; calling
        // them keeps teardown semantics correct so future-us doesn't
        // discover stale lobby/intermission/results visuals after a
        // Game switch.
        orchestrator.hideLobby();
        orchestrator.hideIntermission();
        orchestrator.hideResults();

        this._transitionTo('ENDED');
        this._emit('game-ended', {});
    }
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
        orchestrator.updateLobbyState({
            slots: this.roster,
            slot,
            deviceId,
        });
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
        orchestrator.hideLobby();

        if (!this.level) {
            // Network DM / fallback (preload missed for some reason):
            // construct + load now. LOBBY → LOADING → PLAYING.
            this._transitionTo('LOADING');
            this.level = new Level({
                map: this.mapCursor,
                players: this.roster,
                rules: this.rules,
                orchestrator,
            });
            this._subscribeLevel(this.level);
            await this.level.load();
            _setCurrentLevel(this.level);
        }
        // Local DM happy path lands here with this.level already
        // preloaded by start() — direct LOBBY → PLAYING, no LOADING
        // splash, per §3b.

        this.level.start();
        this._transitionTo('PLAYING');

        // Sync legacy game-state.js → ACTIVE so the body's
        // `data-game-state="lobby"` flips to "active" and CSS-driven
        // overlays (lobby press-to-claim prompts, etc.) hide. Until
        // L7 retires game-state.js, Game must drive both state
        // machines. startMatch is a no-op for SP (early-returns when
        // state.match is null).
        if (this.gameMode === 'deathmatch') {
            startMatch();
        }
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
    async restartMatch() {
        orchestrator.hideResults();

        // Reset legacy match state (kill matrix, scores, frag clock,
        // body.dataset.gameState → LOBBY via game-state.js). Until L7
        // moves match-state ownership onto Game, this remains
        // authoritative; calling it here also fires match.js's
        // onMatch('reset') event that lobby.js + master broadcast
        // both subscribe to.
        resetMatch();

        this._transitionTo('LOBBY');
        orchestrator.showLobby({
            slots: this.roster,
            mapCursor: this.mapCursor,
        });
        this._emit('match-restarted', { mapCursor: this.mapCursor });

        // Reload the Level so state.things / state.projectiles /
        // state.doorState / state.liftState / state.crusherState all
        // reset, and the renderer rebuilds its scene from fresh
        // mapData. Without this, beginPlay's "level exists → just
        // start()" idempotent path would keep the previous match's
        // mid-match world (corpses, picked-up items, opened doors,
        // half-killed enemies) live into the next match. Mirrors the
        // pre-cutover `resetMatch + loadMap(currentMap)` flow from
        // legacy match.js::restartMatch.
        //
        // Calling Level.load on the existing instance re-runs the
        // full load body (fade-in → fetch → init → scene rebuild
        // → fade-out). Map cycling per §4b is deferred — restart
        // reloads the SAME map, matching legacy behavior.
        if (this.level) {
            await this.level.load();
        }

        // Level.load's clearSceneState clears isDead+powerups but
        // doesn't reset HP / weapons / ammo / keys. spawnPlayer
        // does the full reset to DM defaults + picks a DM start
        // avoiding nearby players. Apply to every roster slot so
        // dead and damaged players both come back fresh.
        for (const player of this.roster) {
            if (player) spawnPlayer(player);
        }

        // On kiosk where claims persist across matches, all slots
        // are typically still claimed when the new lobby opens. The
        // onClaimChange subscription wouldn't fire without an actual
        // change, so explicitly run the auto-start check here. For
        // Local DM non-kiosk this is a no-op unless both slots happen
        // to still be claimed; for kiosk it fires immediately and
        // beginPlay's idempotent level.start() + transition to
        // PLAYING + startMatch land the new match cleanly.
        this._checkAutoStart();
    }

    /**
     * SP intermission dismiss — INTERMISSION → LOADING + load next map.
     * Game pushes hideIntermission via orchestrator, advances mapCursor
     * to the pending next map (captured by _onLevelComplete), then
     * delegates to beginPlay() for the construct-load-start sequence.
     *
     * Today's gates.js still calls intermission.js::dismissIntermission
     * which invokes switches.js's loadMap callback; advance() is the
     * parallel future path that gates.js will call once L4 cuts over.
     * Dead code until a caller wires it.
     */
    async advance() {
        orchestrator.hideIntermission();
        if (this._pendingNextMap) {
            this.mapCursor = this._pendingNextMap;
            this._pendingNextMap = null;
        }

        // Drop the stopped Level so beginPlay constructs a fresh
        // one for the advanced mapCursor. Without this, beginPlay's
        // "level exists → just call level.start()" idempotent path
        // would resume the OLD Level (same map) — but we want to
        // load the next map. Also clear the registry so master.js's
        // gameLoop doesn't briefly tick the stale Level between
        // here and beginPlay's new _setCurrentLevel call.
        if (this.level) {
            if (getCurrentLevel() === this.level) {
                _setCurrentLevel(null);
            }
            this.level = null;
        }

        await this.beginPlay();
    }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }

    /**
     * Internal state transition. Updates `_state` and emits
     * `state-changed`. Callers (Game's own methods) use this rather
     * than assigning `_state` directly so subscribers stay in sync.
     *
     * Intentionally does NOT write `body.dataset.gameState`. Legacy
     * `src/game/game-state.js` still owns that attribute and its
     * own vocabulary (ACTIVE / LOBBY / INTERMISSION / ENDED /
     * ATTRACT) — which CSS keys on across the codebase. If Game
     * also wrote here with the new vocab (LOBBY / LOADING / PLAYING /
     * INTERMISSION / RESULTS / ENDED), the two writers would race
     * and CSS rules keyed on `="active"` would stop matching once
     * Game fired PLAYING. L7 deletes game-state.js, audits CSS,
     * and migrates rules onto the new vocab — at which point this
     * method gets its body write back.
     */
    _transitionTo(newState) {
        const from = this._state;
        this._state = newState;
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
            // Stash the next map so advance() can pick it up when the
            // user dismisses the intermission overlay.
            this._pendingNextMap = payload?.nextMap ?? null;
            // Freeze the world. Without this, Level.tick keeps
            // running behind the intermission overlay — the player
            // can walk away from the exit switch and back, and
            // re-press USE which re-triggers level-complete and
            // restarts the intermission count-up. With stop(),
            // Level.tick becomes a no-op (state = 'loaded-paused');
            // movement freezes. The intermission gate in actions/
            // gates.js consumes USE / weapon presses too so the
            // switch logic itself can't re-fire even though it's
            // event-bus-driven.
            if (this.level) this.level.stop();
            this._transitionTo('INTERMISSION');
            orchestrator.showIntermission(payload);
        } else {
            // DM: vanilla DOOM exit ends the match (§4b). Today's
            // switches.js DM branch still does setTimeout(loadMap,
            // 1000), so the scoreboard pushed here will briefly
            // appear before that auto-load fires. L4 removes the
            // switches.js DM branch once Game owns the response.
            this._transitionTo('RESULTS');
            orchestrator.showResults(this._buildResultsPayload());
        }
        this._emit('level-complete', payload);
    }

    /**
     * Build the payload for `showResults`. Reads `state.match` (when
     * present) for the kill matrix and players' `score` field. Until
     * L4 wires match-end determination into Game, winnerIndex falls
     * back to -1 (which the scoreboard renders as "TIE") because the
     * `state.match.winner` field is only set by `match.js::endMatch`,
     * which doesn't run on a DM exit.
     */
    _buildResultsPayload() {
        const m = state.match;
        return {
            scores: this.roster.map(p => p?.score ?? 0),
            kills: m
                ? m.kills.map(row => row.slice())
                : this.roster.map(() => this.roster.map(() => 0)),
            winnerIndex: m?.winner?.index ?? -1,
            mapName: this.mapCursor,
        };
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
