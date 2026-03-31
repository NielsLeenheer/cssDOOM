/**
 * Handles player damage, sector damage, and game state reset.
 */

import { SECTOR_DAMAGE } from '../constants.js';
import { state } from '../state.js';
import { playSound } from '../../audio/audio.js';
import { pointInPolygon } from '../geometry.js';
import { forEachSectorAt } from '../spatial-grid.js';
import { equipWeapon } from '../entities/weapons.js';
import * as renderer from '../../renderer/index.js';
import { clearWeaponSlots } from '../../renderer/hud.js';

// ============================================================================
// Player Damage
// ============================================================================
//
// Damage flash overlay system:
// When the player takes damage, the renderer shows a brief red flash (300ms).
// Rapid successive hits restart the flash. On death, a persistent red tint
// remains until the game resets.
// ============================================================================

/**
 * Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines 692-704
 * Accuracy: Exact — same integer division, same absorption ratios, same armor depletion logic.
 *
 * Green armor (armorType 1) absorbs damage/3; blue armor (armorType 2) absorbs damage/2.
 * If remaining armor points are less than or equal to the absorbed amount, the armor is
 * fully depleted and armorType resets to 0.
 */
export function damagePlayer(damageAmount) {
    if (state.isDead) return;
    if (state.powerups.invulnerability) return;

    // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() — skill 1 halves damage
    if (state.skillLevel === 1) damageAmount >>= 1;

    // Armor absorption depends on armor type: green (1) = 1/3, blue (2) = 1/2
    if (state.armorType) {
        let saved = state.armorType === 1
            ? Math.floor(damageAmount / 3)
            : Math.floor(damageAmount / 2);

        // If armor can't cover the absorbed amount, it's fully depleted
        if (state.armor <= saved) {
            saved = state.armor;
            state.armorType = 0;
        }
        state.armor -= saved;
        damageAmount -= saved;
    }
    state.health -= damageAmount;

    renderer.triggerFlash('hurt');
    playSound('DSPLPAIN');

    if (state.health <= 0) {
        state.health = 0;
        state.isDead = true;
        state.deathTime = performance.now();
        renderer.setPlayerDead(true);
        playSound('DSPLDETH');
    }
}

// ============================================================================
// Sector Damage
// ============================================================================
//
// Sector damage handles environmental hazards like nukage (green slime) and
// damaging floors. Each damaging sector has a DPS value looked up by sector
// special type (e.g. type 5 = 10 DPS nukage, type 7 = 5 DPS slime).
// A timer accumulates elapsed time while the player stands in a damaging
// sector. Every 32 tics (32/35 ≈ 0.914 seconds) of accumulated time, the
// sector's damage is applied as a single hit (matching DOOM's timing from
// linuxdoom-1.10/p_spec.c:P_PlayerInSpecialSector()).
// When the player leaves the damaging sector, the timer resets to zero.
// ============================================================================

/**
 * Returns the damage-per-second value for the sector at the given position.
 *
 * When multiple sectors overlap at a point (e.g. a damaging floor beneath a
 * raised platform), the damage from the sector with the highest effective
 * floor is used — matching the sector the player would actually be standing on.
 */
function getSectorDamageAt(x, y) {
    let highestFloor = -Infinity;
    let highestFloorDamage = 0;
    let highestFloorSpecialType = 0;
    forEachSectorAt(x, y, sector => {
        const outerBoundary = sector.boundaries[0];
        if (!outerBoundary || outerBoundary.length < 3) return;

        if (pointInPolygon(x, y, outerBoundary)) {
            let insideHole = false;
            for (let h = 1; h < sector.boundaries.length; h++) {
                if (sector.boundaries[h].length >= 3 && pointInPolygon(x, y, sector.boundaries[h])) {
                    insideHole = true;
                    break;
                }
            }
            if (!insideHole) {
                const lift = state.liftState.get(sector.sectorIndex);
                const effectiveFloor = lift ? lift.currentHeight : sector.floorHeight;
                if (effectiveFloor > highestFloor) {
                    highestFloor = effectiveFloor;
                    highestFloorDamage = SECTOR_DAMAGE[sector.specialType] || 0;
                    highestFloorSpecialType = sector.specialType;
                }
            }
        }
    });
    return { damage: highestFloorDamage, specialType: highestFloorSpecialType };
}

export function checkSectorDamage(deltaTime) {
    const { damage: sectorDamageAmount, specialType } = getSectorDamageAt(state.playerX, state.playerY);
    // Based on: linuxdoom-1.10/p_spec.c:P_PlayerInSpecialSector()
    // Radsuit protects against damage, but type 4 and 16 sectors can
    // bypass the suit with ~2% probability per tick (P_Random() < 5).
    const radsuitBypassed = state.powerups.radsuit
        && (specialType === 4 || specialType === 16)
        && Math.random() < 5 / 256;
    if (sectorDamageAmount > 0 && (!state.powerups.radsuit || radsuitBypassed)) {
        state.sectorDamageTimer += deltaTime;
        if (state.sectorDamageTimer >= 32 / 35) {
            state.sectorDamageTimer -= 32 / 35;
            damagePlayer(sectorDamageAmount);
        }
    } else {
        state.sectorDamageTimer = 0;
    }
}

// ============================================================================
// Game State Reset
// ============================================================================
//
// Two levels of reset exist:
//
// resetGameState (full reset):
//   Used when starting a new game or respawning after death. Resets ALL player
//   state to initial values: health to 100, armor to 0, ammo to starting
//   amounts (50 bullets only), weapons to fist + pistol, clears all keys.
//
// transitionToLevel (partial reset):
//   Used when moving between levels. Keeps the player's current inventory
//   intact but clears keys since keys are per-level in DOOM. Also clears
//   transient scene state (projectiles, thing references, death/firing flags).
//
// Both call clearSceneState internally to clean up per-map transient data.
// ============================================================================

// Clear transient scene state (called on any map change)
function clearSceneState() {
    state.isDead = false;
    state.isFiring = false;
    state.sectorDamageTimer = 0;
    state.things = [];
    for (let index = 0; index < state.projectiles.length; index++) renderer.removeProjectile(state.projectiles[index].id);
    state.projectiles = [];
    state.nextProjectileId = 0;
    // Clear all active powerup effects and visuals
    for (const name in state.powerups) {
        renderer.hidePowerup(name);
    }
    state.powerups = {};
    renderer.setPlayerDead(false);
}

// Level transition — keep inventory, clear keys (keys are per-level)
export function transitionToLevel() {
    clearSceneState();
    state.collectedKeys.clear();
    renderer.clearKeys();
    equipWeapon(state.currentWeapon);
}

// Full reset — new game or respawn after death
export function resetGameState() {
    clearSceneState();
    state.health = 100;
    state.armor = 0;
    state.armorType = 0;
    state.ammo = { bullets: 50, shells: 0, rockets: 0, cells: 0 };
    state.maxAmmo = { bullets: 200, shells: 50, rockets: 50, cells: 300 };
    state.hasBackpack = false;
    state.currentWeapon = 2;
    state.ownedWeapons = new Set([1, 2]);
    state.collectedKeys.clear();
    renderer.clearKeys();
    clearWeaponSlots();
    equipWeapon(state.currentWeapon);
}
