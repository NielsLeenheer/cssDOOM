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
 * This module is game-side: idle detection, state transitions, world
 * reset on entry. The VISUAL part of attract — the slow camera
 * rotation each pane shows — lives in
 * [src/renderer/screens/attract.js](../renderer/screens/attract.js)
 * as the showAttract / hideAttract command impls, driven from
 * `orchestrator.showAttract()` / `.hideAttract()` calls below. The
 * rotation animation runs per-pane on the renderer side and mutates
 * each renderer's own `state.camera.angle` — it does NOT mutate
 * `state.players[i].angle`. The simulation stays honest about which
 * way the player is facing; only the camera view rotates.
 *
 * In single-player there is no attract — SP is for dev/testing, the
 * installation kiosk runs DM exclusively.
 *
 * Idle is paused while the menu is open or a load is in flight, so the
 * timer doesn't fire on a user mid-decision or mid-transition.
 */

import { state } from './state.js';
import { swapLevel } from './level.js';
import { getFloorHeightAt } from './physics.js';
import { EYE_HEIGHT } from '../shared/constants.js';
import { resetMatch, endMatch } from './match.js';
import { isMenuOpen } from '../ui/menu.js';
import { GAME_STATE, getGameState, setGameState } from './game-state.js';
import { orchestrator } from '../orchestrator.js';

// Idle thresholds.
//   GAME_IDLE_MS — in-progress match → end the match so the scoreboard
//                  appears before attract takes over.
//   LOBBY_IDLE_MS / SCORE_IDLE_MS — lobby / scoreboard → enter attract.
//     Both are short because nothing engaging is happening on screen.
const GAME_IDLE_MS = 60_000;
const LOBBY_IDLE_MS = 30_000;
const SCORE_IDLE_MS = 30_000;

let lastActivityAt = performance.now();
let entering = false;
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
 * Per-frame idle check from the game loop. Enters attract mode when
 * idle long enough; otherwise no-op. During attract this function still
 * runs (master fires it first thing each frame) but takes the early
 * return on the GAME_STATE.ATTRACT branch — all per-frame visual work
 * is owned by the renderer-side attract animation while attract is
 * active. Master's gameLoop short-circuits the rest of the game step
 * (Level.tick, renderAllActivePanes) for the same reason.
 */
export function attractTick(timestamp) {
    if (isMenuOpen() || entering) {
        // Menu open or load-in-flight = paused, not idle.
        lastActivityAt = timestamp;
        return;
    }

    // Attract is a DM-only kiosk feature.
    if (state.gameMode !== 'deathmatch') {
        lastActivityAt = timestamp;
        return;
    }
    if (!document.body.classList.contains('kiosk')) {
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

    if (gs === GAME_STATE.ATTRACT) return;

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
}

export async function enterAttract() {
    entering = true;

    // Treat attract as "match abandoned" — zero scores and restart the
    // timer so when the next pair of players walks up, they get a fully
    // fresh match. (resetGameState in Level.load already handles health,
    // ammo, weapons, projectiles, corpses; map rebuild restores pickups.)
    resetMatch();

    // Always reload E1M1 — guarantees a clean attract view (both players
    // at fresh DM starts, full health, no in-flight projectiles, no
    // corpses lingering from the previous match).
    state.players[0].isDead = true; // force resetGameState path
    await swapLevel('E1M1');

    // Resample real floor at each DM start. applyDeathmatchStarts seeds
    // floorHeight from mapData.playerStart and relies on the next
    // updateHeight() frame to correct it, but attract skips the game
    // loop's movement update — without this the camera sits at the wrong
    // height (sometimes below the actual sector floor).
    for (const p of state.players) {
        p.floorHeight = getFloorHeightAt(p.x, p.y);
        p.z = p.floorHeight + EYE_HEIGHT;
    }

    entering = false;
    setGameState(GAME_STATE.ATTRACT);
    // Signal each pane to start its own camera-rotation animation.
    // The renderer impl captures its current camera.angle as the base
    // and rotates from there — see src/renderer/screens/attract.js.
    orchestrator.showAttract();
}

function exitAttract() {
    lastActivityAt = performance.now();
    // After attract, swapLevel put us in a fresh post-resetMatch world.
    // resetMatch already transitioned us to LOBBY; we just need to
    // un-set the ATTRACT state. setGameState(LOBBY) is a no-op if we're
    // somehow not in ATTRACT (e.g., direct pingActivity call) —
    // setGameState early-returns on same-state writes.
    setGameState(GAME_STATE.LOBBY);
    orchestrator.hideAttract();
    // Restart the match clock — the wall-clock timer kept advancing while
    // attract was running but matchTick was paused, so without this the
    // very next updateGame frame would see elapsed > timeLimit and call
    // endMatch() ("TIE" flash) before the player even moves.
    if (state.match) state.match.startTime = performance.now();
}
