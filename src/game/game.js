/**
 * Game — one match / session on the host side.
 *
 * Owns the LOBBY → LOADING → PLAYING → INTERMISSION → RESULTS → ENDED
 * state machine, constructs and tears down `Level` instances, holds
 * the roster, and pushes lobby / intermission / results / paused
 * renderer commands so master's local panes and any connected
 * clients stay in sync.
 *
 * Game._transitionTo intentionally does NOT write `body.dataset.gameState`
 * — that attribute is owned by `src/game/game-state.js`'s parallel
 * machine, which has a different vocabulary (LOBBY/ACTIVE/ENDED/...)
 * and is what most of the CSS keys on. Both machines coexist.
 */

import { state } from './state.js';
import { ensurePlayerCount } from '../mode.js';
import { Level, _setCurrentLevel, getCurrentLevel } from './level.js';
import { orchestrator } from '../orchestrator.js';
import { getNextMap } from '../shared/maps.js';
import { resetMatch, startMatch, endMatch, onMatch, isMatchLobby } from './match.js';
import { getMasterConnection } from '../network-host.js';
import { spawnPlayer } from './player/spawn.js';
import { onClaimChange, isSlotClaimedLocally } from '../input/claim-registry.js';
import { getCarriedOverClaims } from '../ui/lobby.js';
import { getNetworkSlotOccupants } from '../ui/network-lobby.js';

// How long to keep the just-claimed pane's READY indicator visible
// before auto-starting the match. If a slot un-claims during the
// delay, the pending timer cancels.
const READY_FLASH_MS = 1000;

export class Game {
    constructor(modeConfig) {
        this.modeConfig = modeConfig;
        // gameMode + networkMode are getters below — they read from
        // `state.gameMode` / `state.networkMode` directly so legacy
        // applyMode calls and Game stay automatically in sync. The
        // alternative (storing modeConfig.gameMode on Game) led to a
        // class of "two state machines running in parallel" bugs
        // where a legacy applyMode call would update state.gameMode
        // but leave Game.gameMode stale — e.g. kiosk boot
        // (Game.gameMode='deathmatch') followed by menu-switch to SP
        // (state.gameMode='singleplayer') made Game._onLevelComplete
        // take the wrong branch on SP exit. With getters there's a
        // single source of truth.
        //
        // modeConfig.gameMode / .networkMode are still expected to
        // match what applyMode set on state before construction —
        // the caller (app.startLocalGame, master.js boot, switchMode)
        // is responsible for ensuring applyMode runs first. The
        // modeConfig itself is retained on `this.modeConfig` for
        // diagnostic / future use.
        this.rules = modeConfig.rules ?? null;
        this.skillLevel = modeConfig.skillLevel ?? 3;

        // Authoritative roster. Aliased to `state.players` so code
        // reading state.players (movement, damage, AI, renderer) sees
        // Game-driven updates with no copy step. `state.players` is
        // mutated in place (ensurePlayerCount pushes; never reassigns),
        // so the alias stays stable across the Game's lifetime.
        this.roster = state.players;

        // The currently-loaded Level (or null between LOBBY and the
        // first PLAYING entry, and between RESULTS and the next LOBBY).
        this.level = null;

        // Map for the next match start. SP advances through the cycle on
        // INTERMISSION → LOADING; DM advances on RESULTS → LOBBY.
        this.mapCursor = modeConfig.startMap ?? 'E1M1';

        this._state = 'LOBBY'; // new Game() always boots into LOBBY
        this._listeners = new Map();
        this._autoStartTimer = null;
    }

    /** Reads from state directly — see constructor for rationale. */
    get gameMode() { return state.gameMode; }
    get networkMode() { return state.networkMode; }

    /**
     * Boot the Game. Enters LOBBY state, pushes the showLobby renderer
     * command so panes (local + sinks) paint the lobby overlay, and
     * for SP auto-finalizes immediately into beginPlay — SP roster is
     * fixed at [Player 0] so there's no claim wait.
     *
     * Local DM and Network DM stay in LOBBY here; the caller is
     * responsible for triggering beginPlay later (Local DM: auto-start
     * when all slots claim — driven by Game's own onClaimChange
     * subscription; Network DM: host fires start via the NETWORK_START
     * gate in actions/gates.js).
     *
     * Called from `App.startLocalGame`.
     */
    async start() {
        // Register as the orchestrator's payload provider so signals
        // like `orchestrator.showResults()` pull current state from
        // here rather than the caller carrying a payload. Cleared in
        // stop() so a stale Game doesn't keep serving payloads after
        // teardown.
        orchestrator.setPayloadProvider(this);

        this._transitionTo('LOBBY');
        orchestrator.showLobby();
        this._emit('lobby-updated', this.getLobbyPayload());

        // Subscribe to device→slot claim changes so Local DM
        // auto-starts when both slots are claimed AND the lobby UI
        // repaints with the new claim set. Both effects are
        // state-gated to LOBBY (a stale subscription on a stopped
        // Game bails before doing anything).
        //
        // claim-registry's onClaimChange currently has no
        // unsubscribe API; multiple Games over a session each
        // accumulate a subscription. The state-gate keeps stale
        // subscriptions inert.
        //
        // SP doesn't need auto-start — start() drops straight into
        // beginPlay below. Network DM uses host-fire-start via the
        // NETWORK_START gate, not all-claimed auto-start.
        onClaimChange(() => {
            if (this._state !== 'LOBBY') return;
            orchestrator.showLobby();
            this._emit('lobby-updated', this.getLobbyPayload());
            this._checkAutoStart();
        });

        // Bridge match.js's 'ended' channel onto Game's own emit
        // pattern + transition the local state machine. match.js::endMatch
        // is now the single end-match entry point (the DM exit-switch
        // path also funnels through it via Game._onLevelComplete) so
        // this subscriber is the single converge point that flips
        // Game._state to RESULTS.
        onMatch('ended', () => {
            if (this._state === 'ENDED' || this._state === 'RESULTS') return;
            this._transitionTo('RESULTS');
            this._emit('match-ended', this.getResultsPayload());
        });

        if (this.gameMode === 'singleplayer') {
            await this.beginPlay();
            return;
        }

        if (this.gameMode === 'deathmatch' && this.networkMode === 'standalone') {
            // Local DM: construct + load Level immediately so the
            // lobby UI sits on top of a loaded paused scene rather
            // than on an empty pane. beginPlay later just calls
            // level.start() — skipping the LOADING phase.
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
     * The lobby intuitively wants Level "paused" during warmup, but
     * in practice the world has to be ticking: pausing the Level
     * regressed kiosk DM because players spawned at the fallback
     * floor height from applyDeathmatchStarts and the updateHeight
     * pass that corrects it never ran. Starting the Level here means
     * the world is live during warmup; scoring is gated separately
     * by isMatchLobby checks inside updateGame so the match clock
     * doesn't start until startMatch.
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
     *   - All slots in the roster must be claimed.
     *
     * beginPlay is deferred by READY_FLASH_MS after the last claim so
     * the just-claimed pane's `data-claim-state="ready"` indicator is
     * visible for a beat before the lobby vanishes into PLAYING. If
     * someone un-claims during the delay, the pending timer is
     * cancelled.
     */
    _checkAutoStart() {
        if (this._state !== 'LOBBY') return;
        if (this.gameMode !== 'deathmatch') return;
        if (this.networkMode !== 'standalone') return;

        if (!this._allSlotsClaimed()) {
            if (this._autoStartTimer) {
                clearTimeout(this._autoStartTimer);
                this._autoStartTimer = null;
            }
            return;
        }

        if (this._autoStartTimer) return;  // already pending
        this._autoStartTimer = setTimeout(() => {
            this._autoStartTimer = null;
            // Re-verify at fire time: state could have moved out of
            // LOBBY (someone called beginPlay externally) or a slot
            // could have un-claimed during the delay.
            if (this._state !== 'LOBBY') return;
            if (!this._allSlotsClaimed()) return;
            this.beginPlay();
        }, READY_FLASH_MS);
    }

    _allSlotsClaimed() {
        for (let i = 0; i < this.roster.length; i++) {
            if (!isSlotClaimedLocally(i)) return false;
        }
        return true;
    }
    /**
     * Pause the held Level and fan a 'paused' tint to every pane.
     *
     * Level tick freezes only while PLAYING — pausing during LOADING /
     * LOBBY / INTERMISSION / RESULTS has no live Level to freeze
     * (LOADING holds a Level instance but its tick is still gated by
     * load completion). The renderer-command fan-out fires regardless
     * so the menu visually paints every pane, including joiner panes
     * whose own App.state is IN_GAME (the joiner sees host's pause
     * via the wire, not via its own state).
     */
    pause() {
        if (this._state === 'PLAYING') {
            this.level?.pause();
        }
        for (let i = 0; i < this.roster.length; i++) {
            orchestrator.showPaused(i);
        }
    }

    /**
     * Resume the held Level and clear the paused tint. Counterpart to
     * pause() — same state-gating on Level, same unconditional
     * renderer-command fan-out.
     */
    resume() {
        if (this._state === 'PLAYING') {
            this.level?.resume();
        }
        for (let i = 0; i < this.roster.length; i++) {
            orchestrator.hidePaused(i);
        }
    }
    /**
     * Clean teardown. Stops the held Level (if any), destroys it
     * (clears state.things / doorState / liftState / crusherState /
     * projectiles), nulls `this.level`, clears the level singleton
     * registry, hides any open overlays, and transitions to ENDED.
     *
     * Idempotent — stop() on an already-ENDED Game is a no-op.
     *
     * Subscriber cleanup: the arrow-function handlers registered via
     * `_subscribeLevel(level)` are held by the Level's own _listeners
     * Map. When `this.level = null` clears the Game's last reference
     * and `level.destroy()` runs, the Level becomes unreachable; the
     * handlers go with it. No explicit unsubscribe needed.
     */
    async stop() {
        if (this._state === 'ENDED') return;

        if (this._autoStartTimer) {
            clearTimeout(this._autoStartTimer);
            this._autoStartTimer = null;
        }

        if (this.level) {
            this.level.stop();
            this.level.destroy();
            if (getCurrentLevel() === this.level) {
                _setCurrentLevel(null);
            }
            this.level = null;
        }

        // Hide any open overlays so a Game switch doesn't leak stale
        // lobby/intermission/results visuals into the next session.
        orchestrator.hideLobby();
        orchestrator.hideIntermission();
        orchestrator.hideResults();

        // Surrender the provider slot so a stale Game doesn't keep
        // serving payloads after teardown. App tears down the old
        // Game (this stop) before constructing the next, so we never
        // clobber a newer provider here.
        orchestrator.setPayloadProvider(null);

        this._transitionTo('ENDED');
        this._emit('game-ended', {});
    }
    /**
     * Record that `deviceId` has claimed `slot`. Ensures the underlying
     * `state.players[slot]` Player exists (extending the roster if
     * needed) and emits `roster-updated` for subscribers.
     *
     * Currently a parallel entry point — the live claim flow still
     * runs through `input/claim-registry.js` (input modules call
     * `tryClaimSlot(deviceId)` directly; Game subscribes to
     * `onClaimChange` and signals showLobby from there).
     */
    claimSlot(slot, deviceId) {
        ensurePlayerCount(slot + 1);
        orchestrator.showLobby();
        this._emit('roster-updated', {
            slot,
            deviceId,
            roster: this.roster,
        });
    }
    /**
     * Roster is finalized — construct the Level for `this.mapCursor`,
     * load it, start it, and transition through LOBBY → LOADING →
     * PLAYING. For Local DM the Level is preloaded by start() so this
     * skips the LOADING phase. For Network DM, Level construction is
     * deferred to here so beginPlay can drive the LOAD_MAP /
     * READY_TO_PLAY / PLAY handshake with connected joiners.
     *
     * `_setCurrentLevel(this.level)` keeps the legacy `getCurrentLevel`
     * singleton in sync so master.js's per-frame tick and the
     * level-event emit sites in switches.js / damage.js / spawn.js
     * continue to find the right Level instance.
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
            // The level-load fires onLevel('changing', { name }) which
            // master.js subscribes to and turns into broadcastLoadMap
            // on the MasterConnection — so every connected client begins
            // its own loadMap in parallel with master's. No explicit
            // broadcast call needed here.
            await this.level.load();
            _setCurrentLevel(this.level);
        }
        // Local DM happy path lands here with this.level already
        // preloaded by start() — direct LOBBY → PLAYING, no LOADING
        // splash.

        // Network DM host: wait for every connected peer to send
        // MSG.READY_TO_PLAY (signalling its local loadMap finished),
        // then broadcast MSG.PLAY so the joiners' UI knows the match
        // is starting. No-op when no MasterConnection is held (client
        // window) or no peer is alive (solo master). Times out at 10 s
        // with a warn and proceeds anyway — a crashed joiner shouldn't
        // hang the host's match-start.
        if (this.networkMode === 'host') {
            const mc = getMasterConnection();
            if (mc) {
                await mc.awaitAllReadyToPlay({ timeoutMs: 10_000 });
                mc.broadcastPlay();
            }
        }

        this.level.start();
        this._transitionTo('PLAYING');

        // Drive the parallel game-state.js machine → ACTIVE too so
        // `body.dataset.gameState` flips from "lobby" to "active" and
        // CSS-driven overlays (press-to-claim prompts, etc.) hide.
        // Game owns its own state machine but doesn't write the body
        // attribute itself — see the file-level docstring.
        if (this.gameMode === 'deathmatch') {
            startMatch();
        }

        // Re-render the lobby UI so per-pane `data-claim-state`
        // flips from 'ready' (post-claim, pre-match) to 'active'
        // (match running) — which is what CSS reads to hide the
        // READY! overlay. Game's onClaimChange handler doesn't fire
        // here (no claim change), so we have to push the re-render
        // explicitly. Otherwise the READY! overlay lingers over the
        // running match.
        orchestrator.showLobby();
        this._emit('lobby-updated', this.getLobbyPayload());
    }

    /**
     * RESULTS → LOBBY transition for DM. Advances mapCursor to the
     * next map (per vanilla DOOM: any end-of-match — exit-switch OR
     * frag/time-limit — advances), then constructs a fresh Level for
     * that map and lands in LOBBY ready for the next match's start
     * trigger. Called from `actions/gates.js` on FIRE_DOWN during
     * the match-end gate.
     *
     * The Level construction here goes through Game's normal subscribe
     * path (`_subscribeLevel`), which is what makes the NEXT exit-switch
     * fire `_onLevelComplete` — switches.js used to do `setTimeout(
     * shared/maps.js::loadMap)` which built a Level without that
     * subscription, silently breaking results on match 2+.
     */
    async restartMatch() {
        orchestrator.hideResults();

        // Advance mapCursor. _pendingNextMap is set by _onLevelComplete
        // when an exit switch triggered the end (carries secret-exit
        // routing too); frag/time-limit ends leave it null so we fall
        // through to getNextMap. Final fallback to currentMap covers
        // the end-of-cycle case (no next map defined).
        this.mapCursor = this._pendingNextMap ?? getNextMap() ?? this.mapCursor;
        this._pendingNextMap = null;

        // Reset match state in match.js (kill matrix, scores, frag
        // clock, body.dataset.gameState → LOBBY via game-state.js).
        // Also fires match.js's onMatch('reset') event that lobby.js
        // + master broadcast both subscribe to.
        resetMatch();

        this._transitionTo('LOBBY');
        orchestrator.showLobby();
        this._emit('lobby-updated', this.getLobbyPayload());
        this._emit('match-restarted', { mapCursor: this.mapCursor });

        // Tear down the old Level (map-bound at construction) and
        // build a fresh one for the new mapCursor. Same shape as
        // Game.advance for SP — Level instances are map-bound so a
        // map change is always a destroy+reconstruct, never a reload.
        if (this.level) {
            this.level.stop();
            this.level.destroy();
            if (getCurrentLevel() === this.level) _setCurrentLevel(null);
            this.level = null;
        }

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
     * Called from `actions/gates.js` on FIRE_DOWN during INTERMISSION.
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
     * Intentionally does NOT write `body.dataset.gameState`.
     * `src/game/game-state.js` owns that attribute with its own
     * vocabulary (ACTIVE / LOBBY / INTERMISSION / ENDED / ATTRACT),
     * which CSS keys on across the codebase. If Game also wrote
     * here with its vocab (LOBBY / LOADING / PLAYING / INTERMISSION /
     * RESULTS / ENDED), the two writers would race and CSS rules
     * keyed on `="active"` would stop matching once Game fired
     * PLAYING.
     */
    _transitionTo(newState) {
        const from = this._state;
        this._state = newState;
        this._emit('state-changed', { from, to: newState });
    }

    /**
     * Wire this Game's handlers onto a Level's event emitter. Called
     * by `beginPlay()` immediately after constructing `this.level`.
     */
    _subscribeLevel(level) {
        level.on('level-complete', (p) => this._onLevelComplete(p));
        level.on('player-died',    (p) => this._onPlayerDied(p));
        level.on('player-spawned', (p) => this._onPlayerSpawned(p));
    }

    /**
     * Reacts to Level emitting `level-complete`. SP: PLAYING →
     * INTERMISSION, signals showIntermission (orchestrator pulls the
     * payload from this Game via the provider hookup). DM: funnels
     * straight into match.js::endMatch — the single end-match entry
     * point. endMatch computes the winner, transitions GAME_STATE to
     * ENDED, signals showResults, and fires onMatch('ended'); Game's
     * own onMatch subscriber then flips _state → RESULTS. In BOTH
     * modes we stash payload.nextMap so the next advance (Game.advance
     * for SP, Game.restartMatch for DM) loads the right map.
     *
     * switches.js used to also `setTimeout(loadMap(nextMap), 1000)`
     * for DM, which constructed a Level via shared/maps.js::loadMap
     * — bypassing Game's _subscribeLevel. After that, the new Level
     * had no Game subscriber, so the NEXT exit-switch silently
     * dropped its level-complete on the floor: no _onLevelComplete,
     * no endMatch, no results. That's gone — Game.restartMatch
     * owns DM map advancement now.
     */
    _onLevelComplete(payload) {
        // Stash next-map so the post-overlay advance path (Game.advance
        // for SP, Game.restartMatch for DM) knows where to go. Carries
        // secret-exit info implicitly because switches.js already
        // resolved it to the correct target map.
        this._pendingNextMap = payload?.nextMap ?? null;

        if (this.gameMode === 'singleplayer') {
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
            orchestrator.showIntermission();
        } else {
            // DM: funnel into the same endMatch path as frag/time-limit.
            // The onMatch('ended') subscriber in start() flips _state
            // → RESULTS, and endMatch itself signals showResults.
            endMatch();
        }
        this._emit('level-complete', payload);
    }

    // ── Overlay payload provider ─────────────────────────────────────────
    // Implements the orchestrator's payload-provider contract. The
    // orchestrator calls these synchronously from inside its dispatch
    // when the corresponding signal fires, so what lands on every
    // renderer is whatever Game says is true right now.

    /** Which overlay command, if any, is currently visible. Drives
     *  `orchestrator.replayCurrentOverlayTo` on joiner reconnect. */
    getCurrentOverlay() {
        switch (this._state) {
            case 'RESULTS':      return 'showResults';
            case 'INTERMISSION': return 'showIntermission';
            case 'LOBBY':        return 'showLobby';
            default:             return null;
        }
    }

    /** Scoreboard payload for `showResults`. winnerIndex defaults to
     *  -1 (which the scoreboard renders as "TIE") if state.match isn't
     *  populated — endMatch is what sets winner, so a results pull
     *  before endMatch has run will read TIE. */
    getResultsPayload() {
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

    /** Intermission payload — the next map the SP advance() will load. */
    getIntermissionPayload() {
        return { nextMap: this._pendingNextMap ?? null };
    }

    /** Unified lobby payload consumed by every lobby renderer
     *  ([ui/lobby.js], [ui/network-lobby.js], [ui/client-lobby.js]).
     *  Combines roster info (slots + mapCursor) with the master-side
     *  per-slot bookkeeping (claims, carried-over claims, network
     *  occupants) so every consumer can pick the fields it needs from
     *  one canonical shape. Used to be split across two payload shapes
     *  pushed from two places (Game vs master.js::broadcastLobbyState),
     *  which forced handlers to gate on which fields were present. */
    getLobbyPayload() {
        const slotsClaimed = state.players.map((_, i) => isSlotClaimedLocally(i));
        const carried = getCarriedOverClaims();
        const slotsCarriedOver = state.players.map((_, i) => carried.has(i));
        return {
            inLobby: isMatchLobby(),
            slots: this.roster,
            mapCursor: this.mapCursor,
            slotsClaimed,
            slotsCarriedOver,
            slotOccupants: getNetworkSlotOccupants(),
        };
    }

    /**
     * Reacts to Level emitting `player-died`. DM scoring + frag-limit
     * detection lives in damage.js / match.js; Game's handler is a
     * pure re-emit so App-side observers can subscribe without
     * duplicating side effects.
     */
    _onPlayerDied(payload) {
        this._emit('player-died', payload);
    }

    /**
     * Reacts to Level emitting `player-spawned`. Informational —
     * pure re-emit. Per-slot respawn-overlay management is not yet
     * implemented.
     */
    _onPlayerSpawned(payload) {
        this._emit('player-spawned', payload);
    }
}
