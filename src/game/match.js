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
    setWinOverlayText('');
    setTimerActive(false);
    lastTimerSeconds = -1;
}

/** Clears any DM match state — called when leaving DM mode. */
export function clearMatch() {
    state.match = null;
    document.body.removeAttribute('data-match-ended');
    setWinOverlayText('');
    setTimerActive(false);
    lastTimerSeconds = -1;
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
    checkFragLimit();
}

/** Called once per frame from updateGame to enforce the time limit and
 *  drive the on-screen countdown in the last 60 s. */
export function matchTick() {
    if (!state.match || state.match.ended) return;
    const elapsed = performance.now() - state.match.startTime;
    if (elapsed >= state.match.timeLimit) {
        endMatch();
        setTimerActive(false);
        return;
    }
    updateCountdown(state.match.timeLimit - elapsed);
}

let lastTimerSeconds = -1;

/** Updates the m:ss display on every .dm-timer element when in the last
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
    for (const el of document.querySelectorAll('.dm-timer')) el.textContent = text;
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
    setWinOverlayText(tied || !winner ? 'TIE' : `PLAYER ${winner.index + 1} WINS`);
}

/**
 * Writes the same text into every win-overlay element. The global
 * #dm-win-overlay covers the full screen for normal layouts; pane-local
 * .pane-win copies (in the pane template) take over in video-wall layouts
 * so the message lands inside each display rather than on the bezel.
 */
function setWinOverlayText(text) {
    for (const el of document.querySelectorAll('.dm-win-overlay')) {
        el.textContent = text;
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

