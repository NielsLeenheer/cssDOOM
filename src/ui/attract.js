/**
 * Attract loop — kiosk idle behavior.
 *
 * Deathmatch-only. Idle behavior has three stages:
 *
 *   1. Lobby idle (30s)      → enter attract (reload E1M1, slow rotate).
 *                              Short window: an empty lobby with nobody
 *                              pressing buttons should fall back to the
 *                              attract loop quickly.
 *   2. In-match idle (60s)   → end the current match early. Players or
 *                              kiosk visitors get to see the post-match
 *                              scoreboard instead of jumping straight to
 *                              attract from mid-game.
 *   3. Scoreboard idle (30s) → enter attract. Shorter window because the
 *                              match is already over and there's nothing
 *                              left to engage with on the scoreboard.
 *
 * Any input pings `pingActivity()` from the input modules (keyboard,
 * mouse, gamepad, remote), which resets the idle clock and exits attract
 * if it's showing.
 *
 * In single-player there is no attract — SP is for dev/testing, the
 * installation kiosk runs DM exclusively.
 *
 * Idle is paused while the menu is open or a load is in flight, so the
 * timer doesn't fire on a user mid-decision or mid-transition.
 */

import { state } from '../game/state.js';
import { loadMap } from '../shared/maps.js';
import { getFloorHeightAt } from '../game/physics.js';
import { EYE_HEIGHT } from '../game/constants.js';
import { resetMatch, endMatch } from '../game/match.js';
import { isMenuOpen } from './menu.js';
import { GAME_STATE, getGameState, transitionTo } from '../game/game-state.js';

// Idle thresholds.
//   GAME_IDLE_MS — in-progress match → end the match so the scoreboard
//                  appears before attract takes over.
//   LOBBY_IDLE_MS / SCORE_IDLE_MS — lobby / scoreboard → enter attract.
//     Both are short because nothing engaging is happening on screen.
const GAME_IDLE_MS = 60_000;
const LOBBY_IDLE_MS = 30_000;
const SCORE_IDLE_MS = 30_000;
const ROTATE_RAD_PER_MS = 0.0002; // ~12°/sec — full rotation every 30s.
                                   // Slow enough to feel ambient, low enough
                                   // that the kiosk's GPU compositor stays
                                   // cool with the render throttling in
                                   // gameLoop (see ATTRACT_RENDER_INTERVAL_MS).

let lastActivityAt = performance.now();
let entering = false;
let rotateStartTime = 0;
const baseAngles = []; // baseAngle per player at the moment of attract entry
// Tracks the previous tick's game state so we can detect the LOBBY/ACTIVE
// → ENDED transition and reset the idle clock — without this, a 60s
// in-match idle would immediately trip the 30s scoreboard timeout the
// moment endMatch fires.
let wasEnded = false;

export function isAttractActive() {
    return getGameState() === GAME_STATE.ATTRACT;
}

/**
 * Called by input modules whenever they observe a button press, axis nudge,
 * pointer motion, or any other live engagement. Resets the idle timer and
 * exits attract mode if it's currently showing.
 *
 * Returns `true` when the call ended an active attract session — discrete
 * input handlers (keydown / mousedown / gamepad button-press) should treat
 * that as "input consumed by waking up" and skip further processing so the
 * wakeup press doesn't immediately claim a slot, fire a weapon, or open
 * the menu. Continuous handlers (mousemove / gamepad sticks) can ignore
 * the return value — they have no discrete action to suppress.
 */
export function pingActivity() {
    lastActivityAt = performance.now();
    if (getGameState() === GAME_STATE.ATTRACT) {
        exitAttract();
        return true;
    }
    return false;
}

/**
 * Per-frame check from the game loop. Enters attract mode when idle long
 * enough; drives the slow camera rotation for every player while active.
 */
export function attractTick(timestamp) {
    if (isMenuOpen() || entering) {
        // Menu open or load-in-flight = paused, not idle.
        lastActivityAt = timestamp;
        return;
    }

    // Attract is a DM-only kiosk feature.
    if (state.mode !== 'deathmatch') {
        lastActivityAt = timestamp;
        return;
    }

    const gs = getGameState();

    // Detect the in-game → scoreboard transition (either an organic
    // match-end via frag limit / timer / debug button, or our own
    // GAME_IDLE_MS-triggered endMatch below) and restart the idle clock
    // so the scoreboard gets its full SCORE_IDLE_MS window.
    const ended = gs === GAME_STATE.ENDED;
    if (ended && !wasEnded) lastActivityAt = timestamp;
    wasEnded = ended;

    if (gs !== GAME_STATE.ATTRACT) {
        const idle = timestamp - lastActivityAt;
        if (ended) {
            // Scoreboard up → attract after the shorter idle window.
            if (idle > SCORE_IDLE_MS) enterAttract();
        } else if (gs === GAME_STATE.ACTIVE) {
            // Mid-match idle → end the match so the scoreboard appears
            // before attract takes over. Next tick picks up the
            // ended-state transition above.
            if (idle > GAME_IDLE_MS) endMatch();
        } else {
            // Lobby (or no match yet) → attract restart.
            if (idle > LOBBY_IDLE_MS) enterAttract();
        }
        return;
    }

    // Attract active — drive the slow camera rotation.
    const elapsed = ROTATE_RAD_PER_MS * (timestamp - rotateStartTime);
    for (let i = 0; i < state.players.length; i++) {
        state.players[i].angle = (baseAngles[i] ?? 0) + elapsed;
    }
}

export async function enterAttract() {
    entering = true;

    // Treat attract as "match abandoned" — zero scores and restart the
    // timer so when the next pair of players walks up, they get a fully
    // fresh match. (resetGameState in loadMap already handles health,
    // ammo, weapons, projectiles, corpses; map rebuild restores pickups.)
    resetMatch();

    // Always reload E1M1 — guarantees a clean attract view (both players
    // at fresh DM starts, full health, no in-flight projectiles, no
    // corpses lingering from the previous match).
    state.players[0].isDead = true; // force resetGameState path
    await loadMap('E1M1');

    // Resample real floor at each DM start. applyDeathmatchStarts seeds
    // floorHeight from mapData.playerStart and relies on the next
    // updateHeight() frame to correct it, but attract skips the game
    // loop's movement update — without this the camera sits at the wrong
    // height (sometimes below the actual sector floor).
    for (const p of state.players) {
        p.floorHeight = getFloorHeightAt(p.x, p.y);
        p.z = p.floorHeight + EYE_HEIGHT;
    }

    baseAngles.length = 0;
    for (const p of state.players) baseAngles.push(p.angle);
    rotateStartTime = performance.now();
    entering = false;
    transitionTo(GAME_STATE.ATTRACT);
}

function exitAttract() {
    lastActivityAt = performance.now();
    // After attract, loadMap put us in a fresh post-resetMatch world.
    // resetMatch already transitioned us to LOBBY; we just need to
    // un-set the ATTRACT state. transitionTo(LOBBY) is a no-op if we're
    // somehow not in ATTRACT (e.g., direct dismissIntermission called
    // pingActivity). The body[data-game-state] attribute follows, and
    // the client mirrors via the GAME_STATE envelope.
    transitionTo(GAME_STATE.LOBBY);
    // Restart the match clock — the wall-clock timer kept advancing while
    // attract was running but matchTick was paused, so without this the
    // very next updateGame frame would see elapsed > timeLimit and call
    // endMatch() ("TIE" flash) before the player even moves.
    if (state.match) state.match.startTime = performance.now();
}
