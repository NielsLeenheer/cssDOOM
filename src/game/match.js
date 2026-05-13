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
import { loadMap, currentMap } from '../shared/maps.js';
import { showScoreboard, hideScoreboard } from '../ui/scoreboard.js';
import { clearMovingState } from './movement.js';
import { GAME_STATE, getGameState, transitionTo } from './game-state.js';

const DEFAULT_FRAG_LIMIT = 20;
const DEFAULT_TIME_LIMIT_MS = 6 * 60 * 1000;

// Master-side hook for broadcasting the kill matrix + scores to any
// connected client on endMatch. Set by index.js once the master's
// MasterConnection is up; null on clients or before init. Decoupling
// via a setter keeps match.js free of transport / connection imports.
let broadcastMatchEnd = null;
export function setMatchEndBroadcaster(fn) { broadcastMatchEnd = fn; }

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
        kills: Array.from({ length: n }, () => new Array(n).fill(0)),
    };
    for (const p of state.players) p.score = 0;
    hideScoreboard();
    setTimerActive(false);
    lastTimerSeconds = -1;
    transitionTo(GAME_STATE.LOBBY);
    // Notify the lobby UI so it can clear stale input claims and show
    // the PRESS FIRE TO JOIN prompts again. Decoupling via event keeps
    // match.js free of input/UI imports.
    window.dispatchEvent(new CustomEvent('cssdoom:match-reset'));
}

/**
 * Formally start the match — transition to ACTIVE and stamp the clock.
 * Idempotent: only fires if we're currently in LOBBY.
 */
export function startMatch() {
    if (getGameState() !== GAME_STATE.LOBBY) return;
    if (!state.match) return;
    state.match.startTime = performance.now();
    transitionTo(GAME_STATE.ACTIVE);
}

/** True if a DM match is in the lobby state — exists but not yet started. */
export function isMatchLobby() {
    return getGameState() === GAME_STATE.LOBBY;
}

/** Clears any DM match state — called when leaving DM mode. */
export function clearMatch() {
    state.match = null;
    hideScoreboard();
    setTimerActive(false);
    lastTimerSeconds = -1;
    transitionTo(GAME_STATE.ACTIVE);
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
        state.match.kills[killer.index][victim.index]++;
    } else {
        victim.score--;
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
        setTimerActive(false);
        return;
    }
    updateCountdown(state.match.timeLimit - elapsed);
}

let lastTimerSeconds = -1;

/** Updates the m:ss display on every .pane-timer element when in the last
 *  60 s of a match; toggles body[data-timer-active] which the CSS uses
 *  to fade the readout in/out. */
function updateCountdown(remainingMs) {
    if (remainingMs > 60_000) {
        setTimerActive(false);
        lastTimerSeconds = -1;
        return;
    }
    setTimerActive(true);
    const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1000));
    if (totalSeconds === lastTimerSeconds) return;
    lastTimerSeconds = totalSeconds;
    const m = Math.floor(totalSeconds / 60);
    const s = totalSeconds % 60;
    const text = `${m}:${s.toString().padStart(2, '0')}`;
    for (const el of document.querySelectorAll('.pane-timer')) el.textContent = text;
}

function setTimerActive(active) {
    if (active) {
        if (document.body.dataset.timerActive !== 'true') {
            document.body.dataset.timerActive = 'true';
        }
    } else if (document.body.dataset.timerActive === 'true') {
        delete document.body.dataset.timerActive;
    }
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

    const data = buildScoreboardData();
    transitionTo(GAME_STATE.ENDED);
    showScoreboard(data);
    broadcastMatchEnd?.(data);
}

/**
 * Snapshot of the post-match scoreboard. Shipped verbatim to any client
 * via MSG.MATCH_END so it can render the same grid without needing the
 * authoritative state.match.
 */
function buildScoreboardData() {
    return {
        scores: state.players.map(p => p.score),
        kills: state.match.kills.map(row => row.slice()),
        winnerIndex: state.match.winner ? state.match.winner.index : -1,
    };
}

/** True when DM is active and the match has ended. */
export function isMatchEnded() {
    return getGameState() === GAME_STATE.ENDED;
}

/** Resets and reloads the current map for a fresh DM match. */
export function restartMatch() {
    resetMatch();
    loadMap(currentMap);
}
