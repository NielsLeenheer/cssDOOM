/**
 * Deathmatch match state — frag scoring, frag-limit / timer end conditions,
 * win overlay, and restart.
 *
 * SP doesn't touch any of this; `state.match` stays null. DM mode entry
 * (menu.js's switchMode) calls resetMatch() to initialize.
 *
 * Lifecycle is driven by the unified `game-state` machine:
 *   resetMatch()  → LOBBY  (warmup, scoring suppressed)
 *   startMatch()  → ACTIVE (clock running, frags counted)
 *   endMatch()    → ENDED  (scoreboard up, awaiting restart input)
 */

import { state } from './state.js';
import { Player } from './player/player.js';
import { clearMovingState } from './movement.js';
import { GAME_STATE, getGameState, setGameState } from './game-state.js';
import { orchestrator } from '../orchestrator.js';

const DEFAULT_FRAG_LIMIT = 20;
const DEFAULT_TIME_LIMIT_MS = 6 * 60 * 1000;

/**
 * Module-level emitter for match-lifecycle events. Subscribed at boot
 * by master.js (re-broadcast LOBBY_STATE on reset) and lobby.js
 * (clear carried-over claims + reset transient inputs). Replaces the
 * earlier `cssdoom:match-reset` window-event side-channel.
 *
 * Symmetric with `game/level.js`'s onLevel emitter: each lifecycle
 * module owns its own module-level event channel rather than going
 * through a generic event bus.
 */
const _matchListeners = new Map();

export function onMatch(eventName, handler) {
    if (!_matchListeners.has(eventName)) _matchListeners.set(eventName, new Set());
    _matchListeners.get(eventName).add(handler);
}

function _emitMatchEvent(eventName, payload) {
    const set = _matchListeners.get(eventName);
    if (set) for (const h of set) h(payload);
}

/**
 * Initializes (or resets) state.match and zeros every player's score.
 * Called when entering DM mode and on match restart. Transitions to
 * LOBBY — players may walk around in warmup but scoring + the clock
 * don't start until startMatch() is called.
 */
export function resetMatch({
    fragLimit = DEFAULT_FRAG_LIMIT,
    timeLimit = DEFAULT_TIME_LIMIT_MS,
} = {}) {
    const n = state.players.length;
    state.match = {
        fragLimit,
        timeLimit,
        startTime: 0,
        winner: null,
        // kills[killer][victim] — PvP kills increment kills[k][v]; suicide
        // / environmental death increments kills[v][v]. Drives the
        // post-match scoreboard. Per-player .score stays the canonical
        // total (+1 PvP, -1 suicide); the matrix is purely for display.
        // Sized to current roster; ensureMatchSize() grows it if the
        // roster expands later (Network DM remote join after resetMatch).
        kills: Array.from({ length: n }, () => new Array(n).fill(0)),
    };
    for (const p of state.players) { p.score = 0; p._hudDirty = true; }
    orchestrator.hideResults();
    hideTimer();
    setGameState(GAME_STATE.LOBBY);
    // Clear any transient held-input from the previous match (a fire
    // key still down from the kill that ended it would otherwise
    // blow through the lobby into the next match) but keep
    // device→slot claims so a player on a given monitor keeps their
    // controller→pane assignment across back-to-back games. The
    // kiosk loop is players standing side-by-side — we do NOT want
    // their assignments to shuffle between matches.
    orchestrator.resetTransientInputs();
    // Notify lobby UI + master broadcast that a new match cycle
    // started, so lobby-state can snapshot carried-over claims and
    // master can re-broadcast showLobby with the fresh payload.
    _emitMatchEvent('reset');
}

/**
 * Formally start the match — transition to ACTIVE and stamp the clock.
 * Idempotent: only fires if we're currently in LOBBY.
 */
export function startMatch() {
    if (getGameState() !== GAME_STATE.LOBBY) return;
    if (!state.match) return;
    state.match.startTime = performance.now();
    setGameState(GAME_STATE.ACTIVE);
}

/** True if a DM match is in the lobby state — exists but not yet started. */
export function isMatchLobby() {
    return getGameState() === GAME_STATE.LOBBY;
}

/**
 * Grow `state.match.kills` to an n×n matrix when the roster expands
 * after `resetMatch()`. Network DM joiners connect via master's
 * `onReady` which calls `ensurePlayerCount(slot + 1)`; without growing
 * the kills matrix in parallel, awardFrag() throws when the joiner
 * later frags the host (kills[killer.index] is undefined) and the
 * end-of-match scoreboard renders an empty grid (kills[k] is undefined
 * for every k beyond the original matrix size).
 *
 * Idempotent — never shrinks. No-op when state.match is null (Local
 * DM secondary in a non-match state, or before resetMatch has run).
 */
export function ensureMatchSize(n) {
    if (!state.match) return;
    const kills = state.match.kills;
    while (kills.length < n) {
        kills.push(new Array(n).fill(0));
    }
    for (let i = 0; i < kills.length; i++) {
        while (kills[i].length < n) kills[i].push(0);
    }
}

/** Clears any DM match state — called when leaving DM mode. */
export function clearMatch() {
    state.match = null;
    orchestrator.hideResults();
    hideTimer();
    setGameState(GAME_STATE.ACTIVE);
}

/**
 * Award a frag for a kill. `victim` is the dead player. `killer` is the
 * attacker — a Player ref for a PvP frag, anything else (null, an enemy
 * ref, or the victim themselves) is treated as a suicide.
 *
 * Per the locked design: PvP frag = +1 killer; suicide / environmental /
 * enemy-killed = -1 victim. Self-damage from your own rocket splash is
 * also a -1 since the killer === victim case is rejected.
 */
export function awardFrag(victim, killer) {
    if (getGameState() !== GAME_STATE.ACTIVE) return;
    if (!state.match) return;
    if (killer instanceof Player && killer !== victim) {
        killer.score++;
        killer._hudDirty = true;
        state.match.kills[killer.index][victim.index]++;
    } else {
        victim.score--;
        victim._hudDirty = true;
        state.match.kills[victim.index][victim.index]++;
    }
    checkFragLimit();
}

/** Called once per frame from updateGame to enforce the time limit and
 *  drive the on-screen countdown in the last 60 s. */
export function matchTick() {
    if (getGameState() !== GAME_STATE.ACTIVE || !state.match) return;
    const elapsed = performance.now() - state.match.startTime;
    if (elapsed >= state.match.timeLimit) {
        endMatch();
        hideTimer();
        return;
    }
    updateCountdown(state.match.timeLimit - elapsed);
}

// Last value fanned out to clients. Tracked so we only push an envelope
// when the displayed value actually changes (once per second during the
// last 60 s, plus a single hide when the window opens/closes). Also
// surfaces the current value to snapshot.js so a late-joining client
// gets it right after their world snapshot applies.
let _currentTimerText = null;

/** Pushes the m:ss display through the orchestrator in the last 60 s of
 *  a match — fans to master's own DOM and to every connected client so
 *  the readout stays in sync without each side running its own clock. */
function updateCountdown(remainingMs) {
    if (remainingMs > 60_000) {
        hideTimer();
        return;
    }
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    const text = `${m}:${s.toString().padStart(2, '0')}`;
    if (text === _currentTimerText) return;
    _currentTimerText = text;
    orchestrator.showTimer(text);
}

function hideTimer() {
    if (_currentTimerText === null) return;
    _currentTimerText = null;
    orchestrator.showTimer(null);
}

/** Current m:ss text being broadcast, or null if the timer is hidden.
 *  Used by snapshot.js so a late-joining client gets the current
 *  readout immediately after their world snapshot applies. */
export function getCurrentTimerText() {
    return _currentTimerText;
}

function checkFragLimit() {
    if (getGameState() === GAME_STATE.ENDED) return;
    for (const p of state.players) {
        if (p.score >= state.match.fragLimit) {
            endMatch();
            return;
        }
    }
}

/**
 * End the match early. Exported so the debug menu (and future host UI)
 * can force the scoreboard without waiting for frag-limit / timer.
 */
export function endMatch() {
    if (getGameState() === GAME_STATE.ENDED) return;
    if (!state.match) return;

    // Highest score wins; tie when two players are level.
    let winner = null;
    let bestScore = -Infinity;
    let tied = false;
    for (const p of state.players) {
        if (p.score > bestScore) {
            winner = p;
            bestScore = p.score;
            tied = false;
        } else if (p.score === bestScore) {
            tied = true;
        }
    }
    state.match.winner = tied ? null : winner;

    // After ENDED, updateGame's per-player movement update stops firing.
    // Any player who was walking when the match ended would keep their
    // .moving class (and head-bob animation) all the way through
    // scoreboard → attract. Clear it explicitly here.
    for (const p of state.players) clearMovingState(p);

    setGameState(GAME_STATE.ENDED);
    // Signal the scoreboard — orchestrator pulls the current payload
    // from the registered provider (Game.getResultsPayload), so this
    // call carries no data. The same signal fires from both the
    // frag/time-limit path (this function) and the DM exit-switch
    // path (Game._onLevelComplete now calls endMatch), so winner +
    // payload are always computed by the same code.
    orchestrator.showResults();
    // Notify subscribers (Game re-emits as 'match-ended'). Subscriber
    // pulls a fresh payload from Game.getResultsPayload if it needs
    // one, matching the orchestrator pattern.
    _emitMatchEvent('ended');
}

/** True when DM is active and the match has ended. */
export function isMatchEnded() {
    return getGameState() === GAME_STATE.ENDED;
}
