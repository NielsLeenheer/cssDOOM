/**
 * Weapon-select actions — WEAPON_SELECT picks a specific slot,
 * WEAPON_PREV/NEXT cycles through the player's owned weapons.
 */

import { state } from '../game/state.js';
import { equipWeapon } from '../game/entities/weapons.js';
import * as A from '../input/actions.js';
import { on } from '../input/event-bus.js';

export function initWeaponAction() {
    on(A.WEAPON_SELECT, ({ slot, weapon }) => {
        if (slot == null) return;
        const player = state.players[slot];
        if (!player) return;
        if (!player.ownedWeapons.has(weapon)) return;
        equipWeapon(player, weapon);
    });

    on(A.WEAPON_PREV, ({ slot }) => cycleWeapon(slot, -1));
    on(A.WEAPON_NEXT, ({ slot }) => cycleWeapon(slot, +1));
}

function cycleWeapon(slot, direction) {
    if (slot == null) return;
    const player = state.players[slot];
    if (!player) return;
    const owned = [...player.ownedWeapons].sort((a, b) => a - b);
    const currentIndex = owned.indexOf(player.currentWeapon);
    const nextIndex = (currentIndex + direction + owned.length) % owned.length;
    equipWeapon(player, owned[nextIndex]);
}
