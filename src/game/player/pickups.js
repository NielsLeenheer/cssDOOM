/**
 * Item collection logic and powerup duration management.
 *
 * Pickup collection logic:
 * - Each frame, all map things are checked against the player's position.
 * - If within PICKUP_RANGE, the thing type determines the effect:
 *   * Keys: added to the player's collected keys and notified to the renderer.
 *   * Health: capped at MAX_HEALTH (100) for normal items. Soul Sphere (type 2013)
 *     and Mega Sphere (type 2014) can exceed this cap up to 200.
 *   * Armor: capped at MAX_ARMOR. Skipped if already at max.
 *   * Ammo: capped per-type via MAX_AMMO table. Skipped if already at max.
 *   * Weapons: added to ownedWeapons set and auto-equipped on pickup.
 * - Collected items are flagged and hidden by the renderer, then skipped
 *   in future frames.
 */

import {
    PICKUP_EFFECTS, KEY_TYPES, PICKUPS, PICKUP_RANGE,
    MAX_HEALTH, MAX_ARMOR, MAX_AMMO, WEAPON_PICKUPS,
    POWERUP_DURATION,
} from '../constants.js';

import { state } from '../state.js';
import { equipWeapon } from '../entities/weapons.js';
import { playSound } from '../../audio/audio.js';
import * as renderer from '../../renderer/index.js';

export function checkPickups() {
    if (state.isDead) return;

    const things = state.things;
    for (let index = 0, length = things.length; index < length; index++) {
        const thing = things[index];
        if (thing.collected) continue;

        const deltaX = state.playerX - thing.x;
        const deltaY = state.playerY - thing.y;
        const distanceSquared = deltaX * deltaX + deltaY * deltaY;

        if (distanceSquared < PICKUP_RANGE * PICKUP_RANGE) {
            const keyColor = KEY_TYPES[thing.type];
            if (keyColor) {
                state.collectedKeys.add(keyColor);
                renderer.collectKey(keyColor);
                thing.collected = true;
                renderer.collectItem(index);
                triggerPickupFlash();
                continue;
            }

            const effect = PICKUP_EFFECTS[thing.type];
            if (effect) {
                if (effect.statType === 'health') {
                    // Health Bonus (2014) and Soul Sphere (2013) can push health above 100, up to 200
                    // Based on: linuxdoom-1.10/p_inter.c:P_GiveBody() — bonuses cap at 200
                    const healthCap = (thing.type === 2013 || thing.type === 2014) ? 200 : MAX_HEALTH;
                    if (state.health >= healthCap) continue;
                    state.health = Math.min(healthCap, state.health + effect.amount);
                } else if (effect.statType === 'armor') {
                    if (effect.armorClass && effect.armorClass > 0) {
                        // Green/Blue Armor: P_GiveArmor — skip if current armor >= armorClass * 100
                        // Green (class 1): skip if armor >= 100
                        // Blue (class 2): skip if armor >= 200
                        if (state.armor >= effect.armorClass * 100) continue;
                        state.armor = effect.amount;
                        state.armorType = effect.armorClass;
                    } else {
                        // Armor Bonus (2015): just adds 1 point, caps at MAX_ARMOR (200)
                        // Gives class 1 if player has no armor type yet
                        if (state.armor >= MAX_ARMOR) continue;
                        state.armor = Math.min(MAX_ARMOR, state.armor + effect.amount);
                        if (!state.armorType) state.armorType = 1;
                    }
                } else if (effect.statType === 'ammo') {
                    const ammoType = effect.ammoType;
                    if (state.ammo[ammoType] >= state.maxAmmo[ammoType]) continue;
                    // Based on: linuxdoom-1.10/p_inter.c — skill 1 & 5 double ammo pickups
                    const amount = (state.skillLevel === 1 || state.skillLevel === 5)
                        ? effect.amount * 2 : effect.amount;
                    state.ammo[ammoType] = Math.min(state.maxAmmo[ammoType], state.ammo[ammoType] + amount);
                } else if (effect.statType === 'powerup') {
                    activatePowerup(effect.powerup);
                }
                thing.collected = true;
                renderer.collectItem(index);
                triggerPickupFlash();
                continue;
            }

            const weaponPickup = WEAPON_PICKUPS[thing.type];
            if (weaponPickup) {
                state.ownedWeapons.add(weaponPickup.slot);
                equipWeapon(weaponPickup.slot);
                if (weaponPickup.ammoType) {
                    const amount = (state.skillLevel === 1 || state.skillLevel === 5)
                        ? weaponPickup.amount * 2 : weaponPickup.amount;
                    state.ammo[weaponPickup.ammoType] = Math.min(
                        state.maxAmmo[weaponPickup.ammoType],
                        state.ammo[weaponPickup.ammoType] + amount
                    );
                }
            }

            // Based on: linuxdoom-1.10/p_inter.c:P_TouchSpecialThing() — backpack
            // Doubles max ammo capacity and gives one clip of each ammo type.
            if (thing.type === 8) {
                if (!state.hasBackpack) {
                    state.hasBackpack = true;
                    for (const type in MAX_AMMO) {
                        state.maxAmmo[type] = MAX_AMMO[type] * 2;
                    }
                }
                const doubleAmmo = state.skillLevel === 1 || state.skillLevel === 5;
                state.ammo.bullets = Math.min(state.maxAmmo.bullets, state.ammo.bullets + (doubleAmmo ? 20 : 10));
                state.ammo.shells  = Math.min(state.maxAmmo.shells,  state.ammo.shells  + (doubleAmmo ? 8 : 4));
                state.ammo.rockets = Math.min(state.maxAmmo.rockets, state.ammo.rockets + (doubleAmmo ? 2 : 1));
            }

            if (PICKUPS.has(thing.type)) {
                thing.collected = true;
                renderer.collectItem(index);
                triggerPickupFlash();
            }
        }
    }
}

/**
 * Triggers a brief golden flash overlay when the player picks up an item.
 * Rapid successive pickups restart the flash animation.
 */
function triggerPickupFlash() {
    playSound('DSITEMUP');
    renderer.triggerFlash('pickup-flash');
}

// ============================================================================
// Powerups
// ============================================================================
//
// Based on: linuxdoom-1.10/p_user.c:P_PlayerThink() — powerup countdown logic.
// Each powerup has a remaining duration in seconds. When collected, the
// duration is set (or refreshed) to the defined value. Each frame,
// updatePowerups() decrements the timers and removes expired effects.
//
// Effects:
//   invulnerability — blocks all damage, green-tinted palette
//   berserk         — 10× melee damage, +100 health, auto-switch to fist, lasts entire level
//   invisibility    — enemies have much wider spread (miss more often)
//   radsuit         — immune to sector (nukage/slime) damage
//   lightamp        — all sectors rendered at full brightness
// ============================================================================

/**
 * Activates a powerup, setting its duration and applying any immediate effects.
 * Based on: linuxdoom-1.10/p_inter.c:P_TouchSpecialThing() powerup cases
 */
function activatePowerup(name) {
    state.powerups[name] = POWERUP_DURATION[name];
    renderer.showPowerup(name);

    if (name === 'berserk') {
        // Berserk gives +100 health (capped at 100) and auto-switches to fist
        state.health = Math.max(state.health, 100);
        equipWeapon(1);
    }
}

/**
 * Tick down all active powerup durations. Called each frame from the game loop.
 * Based on: linuxdoom-1.10/p_user.c:P_PlayerThink() lines 282-338
 *
 * When a timed powerup's duration drops below 4 seconds, the visual effect
 * flickers rapidly as a warning (matching DOOM's palette flash behavior
 * where the effect blinks before expiring).
 */
export function updatePowerups(deltaTime) {
    for (const name in state.powerups) {
        if (state.powerups[name] === Infinity) continue;
        state.powerups[name] -= deltaTime;

        // Flicker warning in the last 4 seconds
        if (state.powerups[name] <= 4 && state.powerups[name] > 0) {
            const visible = Math.floor(state.powerups[name] * 8) % 2 === 0;
            renderer.flickerPowerup(name, visible);
        }

        if (state.powerups[name] <= 0) {
            delete state.powerups[name];
            renderer.hidePowerup(name);
        }
    }
}

/** Returns true if the named powerup is currently active. */
export function hasPowerup(name) {
    return state.powerups[name] > 0;
}
