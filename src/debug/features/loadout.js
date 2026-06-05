/**
 * Loadout — set the slot-0 player's vitals (health / armor / ammo) for talk
 * shots, e.g. dialling the HUD to specific numbers for the HUD-anatomy frame.
 *
 * Each setter mutates the live Player and flags player._hudDirty; the game loop
 * (master.js renderAllActivePanes) polls that every frame — even while frozen
 * (debug.game.pause) — and re-dispatches updateHud, so the bar updates on its
 * own. The same path every pickup / damage hit uses. Console: debug.player.*.
 */

import { state } from '../../game/state.js';

const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'];

/** The slot-0 player — the single-player / debug-camera target. */
const target = () => state.players[0];

/** Set player health (clamped ≥ 0; HUD refreshes next frame). DOOM tops out at
 *  200 with a soul/megasphere, but we don't cap — pass what the shot needs. */
export function setHealth(n) {
    const p = target();
    p.health = Math.max(0, Math.round(n));
    p._hudDirty = true;
    console.log(`[debug] health = ${p.health}`);
    return p.health;
}

/** Set player armor (clamped ≥ 0). `type` sets the absorb class — 1 = green
 *  (absorbs 1/3), 2 = blue (absorbs 1/2); omitted, a positive armor keeps its
 *  current type and defaults to blue when there was none. Zero armor clears the
 *  type, matching how the game drops it when armor runs out. */
export function setArmor(n, type) {
    const p = target();
    p.armor = Math.max(0, Math.round(n));
    if (type !== undefined) p.armorType = type;
    else if (p.armor > 0 && p.armorType === 0) p.armorType = 2;
    if (p.armor === 0) p.armorType = 0;
    p._hudDirty = true;
    console.log(`[debug] armor = ${p.armor} (type ${p.armorType})`);
    return p.armor;
}

/** Set ammo, each pool clamped to its max:
 *    debug.player.ammo('shells', 50)  — one pool
 *    debug.player.ammo(50)            — every pool to 50
 *    debug.player.ammo()              — fill every pool to max */
export function setAmmo(typeOrAmount, amount) {
    const p = target();
    const set = (t, v) => { p.ammo[t] = Math.max(0, Math.min(Math.round(v), p.maxAmmo[t])); };
    if (typeOrAmount === undefined) {
        for (const t of AMMO_TYPES) set(t, p.maxAmmo[t]);
    } else if (typeof typeOrAmount === 'number') {
        for (const t of AMMO_TYPES) set(t, typeOrAmount);
    } else if (AMMO_TYPES.includes(typeOrAmount)) {
        set(typeOrAmount, amount);
    } else {
        console.warn(`[debug] unknown ammo "${typeOrAmount}" — try: ${AMMO_TYPES.join(', ')}`);
        return;
    }
    p._hudDirty = true;
    console.log(`[debug] ammo = ${AMMO_TYPES.map(t => `${t}:${p.ammo[t]}`).join(' ')}`);
    return { ...p.ammo };
}
