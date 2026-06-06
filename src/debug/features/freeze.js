/**
 * Freeze — freeze the whole game for a freeze-frame, then resume mid-motion.
 *
 * freeze() stops the world tick (the Level stops ticking, so projectiles / AI /
 * physics / the player hold their state) AND pauses every CSS animation via
 * body.debug-frozen (features/freeze.css) — so an in-flight fireball, a walk
 * cycle, or a light flicker holds its exact frame. unfreeze() restarts both: the
 * fireball continues along its path from where it stopped.
 *
 * No game-loop change needed — the loop already no-ops its tick while the Level
 * is paused (master.js → getCurrentLevel().tick). We pause the Level directly
 * (not Game.pause) so there's no "PAUSED" tint, just a clean freeze.
 *
 * Console: debug.game.freeze() / debug.game.unfreeze().
 */

import { getCurrentLevel } from '../../game/level.js';
import { state } from '../../game/state.js';

let pausedAt = null;   // performance.now()/1000 at freeze, or null when running

/** Freeze game state (Level tick) + all CSS animations. */
export function freeze() {
    if (pausedAt != null) return;            // already frozen
    pausedAt = performance.now() / 1000;
    getCurrentLevel()?.pause();
    document.body.classList.add('debug-frozen');
    console.log('[debug] frozen — debug.game.unfreeze() to resume');
}

/** Resume game state + CSS animations; in-flight motion continues. */
export function unfreeze() {
    if (pausedAt == null) return;
    // Projectiles move on an ABSOLUTE clock (elapsed = now/1000 - spawnTime), so
    // the wall-clock that passed while frozen would expire them the instant we
    // resume. Shift their spawnTime forward by the paused duration so their
    // elapsed picks up exactly where it froze — the fireball flies on, not gone.
    const pausedFor = performance.now() / 1000 - pausedAt;
    for (const p of state.projectiles) p.spawnTime += pausedFor;
    pausedAt = null;
    getCurrentLevel()?.resume();
    document.body.classList.remove('debug-frozen');
    console.log('[debug] resumed');
}
