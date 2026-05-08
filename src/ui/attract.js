/**
 * Attract loop — kiosk idle behavior.
 *
 * Deathmatch-only feature: after `IDLE_MS` with no player input, reloads
 * E1M1 (resetting both players to fresh DM starts), shows a "PRESS START"
 * overlay, and slowly rotates each player's camera in place. Any input
 * dismisses attract and play resumes from the rotated position.
 *
 * In single-player there is no attract — SP is for dev/testing, the
 * installation kiosk runs DM exclusively.
 *
 * Activity is signalled by the input modules calling `pingActivity()`
 * directly (keyboard keydown, mouse / pointer events, gamepad afterCycle
 * + button hooks). That covers buttons that don't move sticks or trigger
 * fire — e.g. pressing "use" or a weapon-cycle button still counts as
 * engaged.
 *
 * Idle is paused while the menu is open or a load is in flight, so the
 * timer doesn't fire on a user mid-decision or mid-transition.
 */

import { state } from '../game/state.js';
import { loadMap } from '../shared/maps.js';
import { getFloorHeightAt } from '../game/physics.js';
import { EYE_HEIGHT } from '../game/constants.js';
import { isMenuOpen } from './menu.js';

const IDLE_MS = 60_000;
const ROTATE_RAD_PER_MS = 0.0006; // ~36° per second

let lastActivityAt = performance.now();
let attractActive = false;
let entering = false;
let rotateStartTime = 0;
const baseAngles = []; // baseAngle per player at the moment of attract entry

export function isAttractActive() {
    return attractActive;
}

/**
 * Called by input modules whenever they observe a button press, axis nudge,
 * pointer motion, or any other live engagement. Resets the idle timer and
 * exits attract mode if it's currently showing.
 */
export function pingActivity() {
    lastActivityAt = performance.now();
    if (attractActive) exitAttract();
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

    if (!attractActive && timestamp - lastActivityAt > IDLE_MS) {
        enterAttract();
        return;
    }

    if (attractActive) {
        const elapsed = ROTATE_RAD_PER_MS * (timestamp - rotateStartTime);
        for (let i = 0; i < state.players.length; i++) {
            state.players[i].angle = (baseAngles[i] ?? 0) + elapsed;
        }
    }
}

async function enterAttract() {
    entering = true;
    document.body.dataset.attract = 'true';

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
    attractActive = true;
    entering = false;
}

function exitAttract() {
    attractActive = false;
    delete document.body.dataset.attract;
    lastActivityAt = performance.now();
}
