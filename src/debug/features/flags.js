/**
 * Debug flags — thin toggles over the shared flag objects the game / renderer
 * read each frame: game logic's debugFlags (no-damage / no-enemy-attack /
 * no-enemy-move) and the renderer's culling passes. Both presenters drive the
 * SAME underlying objects — the console as debug.game.* / debug.culling.*, the
 * menu via registry.js — so this module is just the toggle behaviour they share.
 */

import { debugFlags } from '../../game/state.js';
import { culling } from '../../renderer/dom/scene/culling.js';

/** Make a toggle for `key` on `target`: no arg flips it, a boolean sets it; logs
 *  and returns the new state. (The menu checkbox won't redraw until reopened —
 *  the flag is the source of truth.) */
const toggle = (target, key, label) => (on = !target[key]) => {
    target[key] = on;
    console.log(`[debug] ${label} ${on ? 'ON' : 'OFF'}`);
    return on;
};

// ── Game flags (debug.game.*) ──────────────────────────────────────────────
export const noDamage = toggle(debugFlags, 'noDamage', 'no damage');
export const noAttack = toggle(debugFlags, 'noEnemyAttack', 'no enemy attack');
export const noMove   = toggle(debugFlags, 'noEnemyMove', 'no enemy movement');

/** Combined "peaceful" toggle — flips no-damage + no-enemy-attack +
 *  no-enemy-movement together. No arg toggles (off if all three are currently
 *  on, else on); pass a boolean to set them all. */
export const peaceful = (on) => {
    if (on === undefined) {
        on = !(debugFlags.noDamage && debugFlags.noEnemyAttack && debugFlags.noEnemyMove);
    }
    debugFlags.noDamage = debugFlags.noEnemyAttack = debugFlags.noEnemyMove = on;
    console.log(`[debug] peaceful (no damage / attack / move) ${on ? 'ON' : 'OFF'}`);
    return on;
};

// ── Culling passes (debug.culling.*) ───────────────────────────────────────
const CULL_PASSES = ['distance', 'backface', 'frustum', 'sky'];
export const cullDistance = toggle(culling, 'distance', 'distance culling');
export const cullBackface = toggle(culling, 'backface', 'backface culling');
export const cullFrustum  = toggle(culling, 'frustum', 'frustum culling');
export const cullSky      = toggle(culling, 'sky', 'sky culling');
/** Set every culling pass at once (default on); cullAll(false) disables them —
 *  handy to stop sprites/geometry popping at the screen edge during a shot. */
export const cullAll = (on = true) => {
    for (const k of CULL_PASSES) culling[k] = on;
    console.log(`[debug] all culling ${on ? 'ON' : 'OFF'}`);
    return on;
};
