/**
 * Deathmatch match state — frag scoring, frag-limit / timer end conditions,
 * win overlay, and restart.
 *
 * SP doesn't touch any of this; state.match stays null. DM mode entry
 * (menu.js's switchMode) calls resetMatch() to initialize.
 */

import { state } from './state.js';
import { Player } from './player/player.js';
import { loadMap, currentMap } from '../shared/maps.js';

const DEFAULT_FRAG_LIMIT = 20;
const DEFAULT_TIME_LIMIT_MS = 6 * 60 * 1000;

/**
 * Initializes (or resets) state.match and zeros every player's score.
 * Called when entering DM mode and on match restart.
 */
export function resetMatch({
    fragLimit = DEFAULT_FRAG_LIMIT,
    timeLimit = DEFAULT_TIME_LIMIT_MS,
} = {}) {
    state.match = {
        fragLimit,
        timeLimit,
        startTime: performance.now(),
        ended: false,
        winner: null,
    };
    for (const p of state.players) p.score = 0;
    document.body.removeAttribute('data-match-ended');
    const overlay = document.getElementById('dm-win-overlay');
    if (overlay) overlay.textContent = '';
    updateScoreboard();
}

/** Clears any DM match state — called when leaving DM mode. */
export function clearMatch() {
    state.match = null;
    document.body.removeAttribute('data-match-ended');
    const overlay = document.getElementById('dm-win-overlay');
    if (overlay) overlay.textContent = '';
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
    if (!state.match || state.match.ended) return;
    if (killer instanceof Player && killer !== victim) {
        killer.score++;
    } else {
        victim.score--;
    }
    updateScoreboard();
    checkFragLimit();
}

/** Called once per frame from updateGame to enforce the time limit. */
export function matchTick() {
    if (!state.match || state.match.ended) return;
    const elapsed = performance.now() - state.match.startTime;
    if (elapsed >= state.match.timeLimit) {
        endMatch();
    }
}

function checkFragLimit() {
    if (state.match.ended) return;
    for (const p of state.players) {
        if (p.score >= state.match.fragLimit) {
            endMatch();
            return;
        }
    }
}

function endMatch() {
    state.match.ended = true;

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

    document.body.dataset.matchEnded = 'true';
    const overlay = document.getElementById('dm-win-overlay');
    if (overlay) {
        if (tied || !winner) {
            overlay.textContent = 'TIE';
        } else {
            overlay.textContent = `PLAYER ${winner.index + 1} WINS`;
        }
    }
}

/** True when DM is active and the match has ended. */
export function isMatchEnded() {
    return state.match?.ended === true;
}

/** Resets and reloads the current map for a fresh DM match. */
export function restartMatch() {
    resetMatch();
    loadMap(currentMap);
}

function updateScoreboard() {
    const scoreboard = document.getElementById('dm-scoreboard');
    if (!scoreboard) return;
    for (const player of state.players) {
        const el = scoreboard.querySelector(`[data-player="${player.index}"]`);
        if (el) el.textContent = String(player.score);
    }
}
