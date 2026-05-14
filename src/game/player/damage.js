/**
 * Handles player damage, sector damage, and game state reset.
 */

import { SECTOR_DAMAGE } from '../constants.js';
import { state } from '../state.js';
import { orchestrator } from '../../orchestrator.js';
import { pointInPolygon } from '../geometry.js';
import { forEachSectorAt } from '../spatial-grid.js';
import { equipWeapon } from '../entities/weapons.js';
import { getSectorAt } from '../physics.js';
import { awardFrag } from '../match.js';
import { getCurrentLevel } from '../level.js';
import * as renderer from '../../renderer/index.js';
import { clearWeaponSlots } from '../../renderer/hud.js';
import { clearMovingState } from '../movement.js';

// ============================================================================
// Player Damage
// ============================================================================
//
// Damage flash overlay system:
// When the player takes damage, the renderer shows a brief red flash (300ms).
// Rapid successive hits restart the flash. On death, a persistent red tint
// remains until the game resets.
//
// The `attacker` parameter is the entity (enemy or other Player) that caused
// the damage, or null for environmental sources (sector damage, crushers).
// It is currently unused but threaded through call sites in preparation for
// deathmatch frag attribution (`player.lastDamagedBy`).
// ============================================================================

/**
 * Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines 692-704
 * Accuracy: Exact — same integer division, same absorption ratios, same armor depletion logic.
 *
 * Green armor (armorType 1) absorbs damage/3; blue armor (armorType 2) absorbs damage/2.
 * If remaining armor points are less than or equal to the absorbed amount, the armor is
 * fully depleted and armorType resets to 0.
 */
export function damagePlayer(player, damageAmount, attacker = null) {
    if (player.isDead) return;
    if (player.powerups.invulnerability) return;

    // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() — skill 1 halves damage
    if (state.skillLevel === 1) damageAmount >>= 1;

    // Armor absorption depends on armor type: green (1) = 1/3, blue (2) = 1/2
    if (player.armorType) {
        let saved = player.armorType === 1
            ? Math.floor(damageAmount / 3)
            : Math.floor(damageAmount / 2);

        // If armor can't cover the absorbed amount, it's fully depleted
        if (player.armor <= saved) {
            saved = player.armor;
            player.armorType = 0;
        }
        player.armor -= saved;
        damageAmount -= saved;
    }
    player.health -= damageAmount;

    // Record attribution so awardFrag can credit the right killer when this
    // damage pushes health to zero.
    player.lastDamagedBy = attacker;
    player.lastDamagedTime = performance.now();

    renderer.triggerFlash(player.viewportIndex, 'hurt');
    orchestrator.playSound('DSPLPAIN', { x: player.x, y: player.y });

    if (player.health <= 0) {
        player.health = 0;
        player.isDead = true;
        player.deathTime = performance.now();
        // Stop the head-bob / weapon-bob — dying mid-stride otherwise
        // leaves the moving state stuck on, since updateMovement early-
        // exits while dead and never gets to toggle it off.
        clearMovingState(player);
        // DM frag attribution. SP no-ops because state.match is null.
        awardFrag(player, attacker);
        // Mark this player's thing entry collected so AI ignores them,
        // PvP collision lets the other player walk through, and hitscan /
        // projectile loops skip the now-defunct live entry.
        if (player.thingRef) player.thingRef.collected = true;
        if (player.thingIndex >= 0) {
            // Stop the walk cycle and play the death animation on the live
            // sprite (PLAYH→PLAYN, row 6 of the sheet). After the animation
            // finishes, hide the live sprite and place a static corpse
            // decoration at the death point so the body persists when the
            // player respawns elsewhere.
            renderer.setThingMoving(player.thingIndex, false);
            renderer.killEnemy(player.thingIndex, -1);

            const deathX = player.x;
            const deathY = player.y;
            const deathFloor = player.floorHeight;
            const deathSectorIndex = getSectorAt(deathX, deathY)?.sectorIndex;
            const playerIndex = player.index;
            const thingIndex = player.thingIndex;
            // 7 frames × 200ms (matches the player-specific override in
            // enemies.css — slower than the enemy death animation).
            setTimeout(() => {
                renderer.collectItem(thingIndex);
                renderer.createCorpse(deathX, deathY, deathFloor, deathSectorIndex, playerIndex);
            }, 1400);
        }

        renderer.setPlayerDead(player.viewportIndex, true);
        orchestrator.playSound('DSPLDETH', { x: player.x, y: player.y });

        // Announce the death for Game (subscribed in L2.4) to run
        // DM scoring / SP respawn-overlay flow. Fired AFTER all
        // visual/audio side effects so listeners can read the
        // already-marked-dead Player.
        getCurrentLevel()?._emit('player-died', {
            slot: player.index,
            attacker,
        });
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

export function checkSectorDamage(player, deltaTime) {
    const { damage: sectorDamageAmount, specialType } = getSectorDamageAt(player.x, player.y);
    // Based on: linuxdoom-1.10/p_spec.c:P_PlayerInSpecialSector()
    // Radsuit protects against damage, but type 4 and 16 sectors can
    // bypass the suit with ~2% probability per tick (P_Random() < 5).
    const radsuitBypassed = player.powerups.radsuit
        && (specialType === 4 || specialType === 16)
        && Math.random() < 5 / 256;
    if (sectorDamageAmount > 0 && (!player.powerups.radsuit || radsuitBypassed)) {
        player.sectorDamageTimer += deltaTime;
        if (player.sectorDamageTimer >= 32 / 35) {
            player.sectorDamageTimer -= 32 / 35;
            damagePlayer(player, sectorDamageAmount);
        }
    } else {
        player.sectorDamageTimer = 0;
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

// Clear transient scene state (called on any map change).
// Resets per-player transient flags for every player in state.players.
function clearSceneState() {
    for (const player of state.players) {
        player.isDead = false;
        player.isFiring = false;
        player.sectorDamageTimer = 0;
        // Clear all active powerup effects and visuals
        for (const name in player.powerups) {
            renderer.hidePowerup(player.viewportIndex, name);
        }
        player.powerups = {};
    }
    // Clear in place so the rendererState alias (master:
    // rendererState.things === state.things) stays valid across map loads.
    state.things.length = 0;
    for (let index = 0; index < state.projectiles.length; index++) renderer.removeProjectile(state.projectiles[index].id);
    state.projectiles = [];
    state.nextProjectileId = 0;
    for (const player of state.players) renderer.setPlayerDead(player.viewportIndex, false);
}

// Level transition — keep inventory, clear keys (keys are per-level)
export function transitionToLevel() {
    clearSceneState();
    for (const player of state.players) {
        player.collectedKeys.clear();
        renderer.clearKeys(player.viewportIndex);
        // Each player's weapon DOM needs equipWeapon to set data-type so
        // the right sprite renders in their pane.
        equipWeapon(player, player.currentWeapon);
        // DM rule: every player carries all three keys at all times. SP
        // gates doors by collected keys; DM doesn't, so on a level change
        // we re-grant them here just like resetGameState does for the
        // dead/initial path.
        if (state.gameMode === 'deathmatch') {
            for (const color of ['blue', 'yellow', 'red']) {
                player.collectedKeys.add(color);
                renderer.collectKey(player.viewportIndex, color);
            }
        }
    }
}

// Full reset — new game or respawn after death
export function resetGameState() {
    clearSceneState();
    for (const player of state.players) {
        player.health = 100;
        player.armor = 0;
        player.armorType = 0;
        player.ammo = { bullets: 50, shells: 0, rockets: 0, cells: 0 };
        player.maxAmmo = { bullets: 200, shells: 50, rockets: 50, cells: 300 };
        player.hasBackpack = false;
        player.currentWeapon = 2;
        player.ownedWeapons = new Set([1, 2]);
        player.collectedKeys.clear();
        renderer.clearKeys(player.viewportIndex);
    }
    clearWeaponSlots();
    // Each player's weapon DOM needs equipWeapon to set data-type so the
    // right sprite renders in their pane. In DM, also grant every player
    // all three keys (DOOM-authentic — DM doesn't gate doors by keys).
    for (const player of state.players) {
        equipWeapon(player, player.currentWeapon);
        if (state.gameMode === 'deathmatch') {
            for (const color of ['blue', 'yellow', 'red']) {
                player.collectedKeys.add(color);
                renderer.collectKey(player.viewportIndex, color);
            }
        }
    }
}
