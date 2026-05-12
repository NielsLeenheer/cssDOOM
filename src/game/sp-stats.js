/**
 * Single-player level stats — kills, items, secrets, time.
 *
 * DOOM tracks these for the post-level intermission screen. We mirror
 * the same set, populated from the same hooks the game already runs:
 *
 *   - kills:   damageEnemy() when target.hp ≤ 0
 *   - items:   checkPickups() when a counted-item type is collected
 *   - secrets: per-frame in movement.js when the player enters a sector
 *              with the SECRET_SPECIAL type (9), once per sector
 *   - time:    wall-clock from level load to exit
 *
 * Totals are scanned from mapData at level start so percentages can be
 * computed at intermission time. DM mode skips all of this — `state.match`
 * already covers the DM scoreboard story.
 */

import { state } from './state.js';
import { mapData } from '../shared/maps.js';
import { ENEMIES } from './constants.js';

// MF_COUNTITEM in DOOM source — armor, bonuses, soulsphere, powerups.
// Stimpacks/medikits/ammo/weapons/backpack/keys are NOT counted items.
const COUNTED_ITEM_TYPES = new Set([
    2018, // Green Armor
    2019, // Blue Armor (Megaarmor)
    2014, // Health Bonus (potion)
    2015, // Armor Bonus (helmet)
    2013, // Soulsphere
    2022, // Invulnerability
    2023, // Berserk
    2024, // Invisibility (Blursphere)
    2025, // Radiation Suit
    2026, // Computer Area Map
    2045, // Light Amplification Visor
]);

// DOOM sector special — type 9 = SECRET. Walking into one credits the
// player and clears the special so it doesn't fire again.
const SECRET_SPECIAL = 9;

/**
 * Initialise stats at level load. Scans mapData for total kill / item /
 * secret counts so percentages can be reported at intermission time.
 * No-op outside single-player.
 */
export function initSpStats() {
    if (state.mode !== 'singleplayer') {
        state.sp = null;
        return;
    }

    let killsTotal = 0;
    let itemsTotal = 0;
    if (mapData.things) {
        for (const thing of mapData.things) {
            // Skip multiplayer-only things in SP (matches things-init.js).
            if (thing.flags & 16) continue;
            // Skip things not present at this skill level.
            const skillBit = state.skillLevel <= 2 ? 1 : state.skillLevel === 3 ? 2 : 4;
            if (!(thing.flags & skillBit)) continue;

            if (ENEMIES.has(thing.type)) killsTotal++;
            if (COUNTED_ITEM_TYPES.has(thing.type)) itemsTotal++;
        }
    }

    let secretsTotal = 0;
    if (mapData.sectors) {
        for (const sector of mapData.sectors) {
            if (sector.specialType === SECRET_SPECIAL) secretsTotal++;
        }
    }

    state.sp = {
        killsTotal,
        killsCollected: 0,
        itemsTotal,
        itemsCollected: 0,
        secretsTotal,
        secretsCollected: 0,
        // performance.now() at level start. Frozen on intermission entry.
        startTime: performance.now(),
        elapsedMs: 0,
        // Sectors already credited as visited — avoids double-counting if
        // the player walks in and out repeatedly.
        visitedSecrets: new Set(),
    };
}

/** Called from combat.js when an enemy dies. */
export function recordKill(thing) {
    if (!state.sp || !thing || !ENEMIES.has(thing.type)) return;
    state.sp.killsCollected++;
}

/** Called from pickups.js when a thing is collected. */
export function recordPickup(thing) {
    if (!state.sp || !thing) return;
    if (COUNTED_ITEM_TYPES.has(thing.type)) state.sp.itemsCollected++;
}

/** Called from movement.js when the player enters a sector. */
export function recordSectorEnter(sectorIndex) {
    if (!state.sp || sectorIndex == null) return;
    if (state.sp.visitedSecrets.has(sectorIndex)) return;
    const sector = mapData.sectors?.[sectorIndex];
    if (sector?.specialType !== SECRET_SPECIAL) return;
    state.sp.visitedSecrets.add(sectorIndex);
    state.sp.secretsCollected++;
}

/**
 * Freeze elapsed time and return a snapshot suitable for the
 * intermission UI. Called from the exit handler.
 */
export function captureSpStats() {
    if (!state.sp) return null;
    state.sp.elapsedMs = performance.now() - state.sp.startTime;
    return {
        kills:   { collected: state.sp.killsCollected,   total: state.sp.killsTotal   },
        items:   { collected: state.sp.itemsCollected,   total: state.sp.itemsTotal   },
        secrets: { collected: state.sp.secretsCollected, total: state.sp.secretsTotal },
        elapsedMs: state.sp.elapsedMs,
    };
}
