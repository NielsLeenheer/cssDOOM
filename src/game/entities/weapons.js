/**
 * Player weapon equipping, firing, hit detection, and rocket projectiles.
 */

import { state } from '../state.js';
import {
    WEAPONS, SHOOTABLE, EYE_HEIGHT,
    PLAYER_ROCKET_SPEED, PLAYER_ROCKET_RADIUS,
    ROCKET_SPLASH_DAMAGE, PLAYER_RADIUS,
    BARREL_RADIUS,
} from '../constants.js';
import { getFloorHeightAt, rayHitPoint } from '../physics.js';
import { hasLineOfSight } from '../line-of-sight.js';
import { damagePlayer } from '../player/damage.js';
import { hasPowerup } from '../player/pickups.js';
import { playSound } from '../../audio/audio.js';
import { setEnemyState } from './enemies.js';
import { damageEnemy } from './combat.js';
import * as renderer from '../../renderer/index.js';
import { input } from '../../input/index.js';

// ============================================================================
// Weapon Loading & Equipping
// ============================================================================

/**
 * Equips a weapon by slot number. Updates game state and tells the renderer
 * to switch visuals (the renderer decides whether to animate).
 */
export function equipWeapon(slot) {
    const weapon = WEAPONS[slot];
    if (!weapon || !state.ownedWeapons.has(slot)) return;

    state.isFiring = false;
    state.currentWeapon = slot;
    renderer.switchWeapon(weapon.name, weapon.fireRate);
}

// ============================================================================
// Firing
// ============================================================================

/**
 * Interval handle for continuous-fire weapons (e.g. chaingun).
 * When a continuous weapon fires, an interval is started that keeps firing
 * rounds at the weapon's fire rate until the player releases the fire button,
 * runs out of ammo, or dies.
 */
let automaticFireInterval = null;

/**
 * Fires the currently equipped weapon. This is the main entry point for all
 * weapon firing logic.
 *
 * Firing mechanics:
 * 1. Checks preconditions: player alive, not already firing, not mid-switch,
 *    weapon exists, and sufficient ammo.
 * 2. Deducts ammo and triggers the fire animation via the renderer.
 * 3. Performs hit detection — hitscan weapons cast instant rays; melee weapons
 *    check a short-range cone; the rocket launcher spawns a projectile.
 * 4. Alerts nearby idle enemies via sound propagation.
 * 5. For continuous-fire weapons (like the chaingun): starts a repeating
 *    setInterval that re-fires automatically as long as the fire button is
 *    held. Each interval tick deducts ammo, plays the fire sound, and runs
 *    hit detection. Non-continuous weapons wait for the renderer to signal
 *    that the fire animation has completed before allowing re-fire.
 */
export function fireWeapon() {
    if (state.isDead || state.isFiring || renderer.isWeaponSwitching()) return;

    const weapon = WEAPONS[state.currentWeapon];
    if (!weapon) return;

    // Check ammo availability (some weapons like the fist have no ammo type)
    if (weapon.ammoType && state.ammo[weapon.ammoType] < weapon.ammoPerShot) return;

    // Deduct ammo cost for this shot
    if (weapon.ammoType) state.ammo[weapon.ammoType] -= weapon.ammoPerShot;
    state.isFiring = true;

    playSound(weapon.sound);

    renderer.startFiring();

    // Perform hitscan hit detection for this shot
    checkWeaponHit();

    // Wake up nearby idle enemies who can hear the gunfire
    alertNearbyEnemies();

    // Continuous-fire weapons (chaingun): set up an auto-fire interval that
    // keeps shooting at the weapon's fire rate while the fire button is held.
    // Each interval tick deducts ammo, plays the fire sound, and runs hit detection.
    if (weapon.continuous && input.fireHeld) {
        stopAutoFire();
        automaticFireInterval = setInterval(() => {
            if (!input.fireHeld || state.isDead || (weapon.ammoType && state.ammo[weapon.ammoType] < weapon.ammoPerShot)) {
                stopAutoFire();
                return;
            }
            if (weapon.ammoType) state.ammo[weapon.ammoType] -= weapon.ammoPerShot;
            playSound(weapon.sound);
            checkWeaponHit();
        }, weapon.fireRate);
    } else {
        // Non-continuous weapons: re-allow firing after the fire rate elapses.
        // If the fire button is still held, immediately fire again.
        setTimeout(() => {
            state.isFiring = false;
            if (input.fireHeld) fireWeapon();
        }, weapon.fireRate);
    }
}

/**
 * Stops the continuous-fire interval (used by chaingun). Called when the
 * player releases the fire button, runs out of ammo, or dies.
 */
export function stopAutoFire() {
    if (automaticFireInterval) {
        clearInterval(automaticFireInterval);
        automaticFireInterval = null;
        renderer.stopFiring();
        state.isFiring = false;
    }
}

// ============================================================================
// Sound Alert — enemies hear gunfire and wake up
// ============================================================================

/**
 * When the player fires a weapon, all idle enemies within 1500 units who have
 * line-of-sight to the player are woken up and transition to the 'chasing'
 * state. This simulates DOOM's sound propagation system where gunfire alerts
 * nearby monsters through connected sectors.
 */
function alertNearbyEnemies() {
    const allThings = state.things;
    for (let index = 0, length = allThings.length; index < length; index++) {
        const thing = allThings[index];
        if (thing.collected || !thing.ai) continue;
        if (thing.ai.state !== 'idle') continue;

        // Calculate squared distance to player for range check (avoids sqrt)
        const deltaX = thing.x - state.playerX;
        const deltaY = thing.y - state.playerY;
        if (deltaX * deltaX + deltaY * deltaY > 1500 * 1500) continue;

        // Only alert if the enemy has line-of-sight to the player
        if (hasLineOfSight(thing.x, thing.y, state.playerX, state.playerY)) {
            setEnemyState(index, thing, 'chasing');
        }
    }
}

// ============================================================================
// Weapon Damage Rolls
// ============================================================================

/**
 * Rolls random weapon damage matching original DOOM formulas.
 *
 * Based on: linuxdoom-1.10/p_pspr.c weapon action functions
 * Accuracy: Exact — same random multiplier ranges and formulas.
 *
 * 'melee':   (P_Random()%10 + 1) * 2 = 2-20 damage.
 *            Based on: A_Punch() / A_Saw() — p_pspr.c lines ~120, ~170
 * 'hitscan': 5 * (P_Random()%3 + 1) = 5, 10, or 15 damage.
 *            Based on: P_GunShot() — p_map.c line ~800
 * 'rocket':  (P_Random()%8 + 1) * 20 = 20-160 direct hit damage.
 *            Based on: A_FireMissile() / P_DamageMobj() — p_pspr.c, p_inter.c
 */
function rollWeaponDamage(damageType) {
    switch (damageType) {
        case 'melee': {
            // Based on: linuxdoom-1.10/p_map.c:P_LineAttack() — Berserk multiplies by 10
            const baseDamage = (Math.floor(Math.random() * 10) + 1) * 2;
            return hasPowerup('berserk') ? baseDamage * 10 : baseDamage;
        }
        case 'hitscan':
            return 5 * (Math.floor(Math.random() * 3) + 1);
        case 'rocket':
            return (Math.floor(Math.random() * 8) + 1) * 20;
        default:
            return 0;
    }
}

// ============================================================================
// Player Hit Detection
// ============================================================================

/**
 * Finds the closest shootable thing along a ray from the player's position.
 * Used by hitscan weapons (pistol, shotgun, chaingun) and melee weapons.
 *
 * The ray is defined by a direction vector (dirX, dirY) and a maximum range.
 * A dot product threshold of 0.99 (~8° cone) determines if a thing is close
 * enough to the ray to be considered a hit.
 */
function findHitscanTarget(dirX, dirY, range) {
    let closestDistance = Infinity;
    let closestThing = null;

    const allThings = state.things;
    for (let index = 0, length = allThings.length; index < length; index++) {
        const thing = allThings[index];
        if (thing.collected) continue;
        if (!SHOOTABLE.has(thing.type)) continue;

        const deltaX = thing.x - state.playerX;
        const deltaY = thing.y - state.playerY;
        const distance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
        if (distance > range) continue;

        const dotProduct = (deltaX * dirX + deltaY * dirY) / distance;
        if (dotProduct < 0.99) continue;

        if (distance < closestDistance) {
            closestDistance = distance;
            closestThing = thing;
        }
    }

    return closestThing;
}

/**
 * Performs weapon hit detection and damage for the current weapon shot.
 *
 * Weapon types handled:
 * - 'melee' (Fist, Chainsaw): Short-range cone check, random 2-20 damage.
 * - 'hitscan' (Pistol, Chaingun): Single ray, random 5/10/15 damage.
 * - 'pellets' (Shotgun): 7 rays with angular spread, each doing 5/10/15 damage.
 *   Based on: linuxdoom-1.10/p_pspr.c:A_FireShotgun() — 7 bullets with
 *   P_GunShot(mo, false) which applies horizontal spread.
 *   Accuracy: Approximation — uses ±22.5° spread per pellet (matching DOOM's
 *   (P_Random()-P_Random())<<18 in a 32-bit angle space ≈ ±22.4° max).
 * - 'rocket' (Rocket Launcher): Spawns a player projectile instead of hitscan.
 */
function checkWeaponHit() {
    const weapon = WEAPONS[state.currentWeapon];
    if (!weapon) return;

    const forwardX = -Math.sin(state.playerAngle);
    const forwardY = Math.cos(state.playerAngle);

    if (weapon.damageType === 'rocket') {
        // Rocket launcher spawns a projectile instead of hitscan
        spawnPlayerRocket(forwardX, forwardY);
        return;
    }

    if (weapon.damageType === 'pellets') {
        // Shotgun: 7 individual pellets, each with angular spread
        // Based on: linuxdoom-1.10/p_pspr.c:A_FireShotgun() calls P_GunShot(mo, false)
        // which applies (P_Random()-P_Random())<<18 spread ≈ ±22.5° max per pellet.
        // Accuracy: Approximation — we use ±22.5° triangular spread via
        // (random - random) to approximate DOOM's (P_Random()-P_Random()).
        for (let pellet = 0; pellet < weapon.pellets; pellet++) {
            const spreadFraction = (Math.floor(Math.random() * 256) - Math.floor(Math.random() * 256)) / 255;
            const spreadAngle = spreadFraction * (22.5 * Math.PI / 180); // ±22.5°
            const pelletAngle = state.playerAngle + spreadAngle;
            const pelletDirX = -Math.sin(pelletAngle);
            const pelletDirY = Math.cos(pelletAngle);

            const target = findHitscanTarget(pelletDirX, pelletDirY, weapon.range);
            if (target && hasLineOfSight(state.playerX, state.playerY, target.x, target.y)) {
                spawnPuff(target.x, target.y, getFloorHeightAt(target.x, target.y));
                damageEnemy(target, rollWeaponDamage('hitscan'), 'player');
            } else {
                const wallHit = rayHitPoint(state.playerX, state.playerY, pelletDirX, pelletDirY, weapon.range);
                if (wallHit) spawnPuff(wallHit.x, wallHit.y);
            }
        }
        return;
    }

    // Melee and single-ray hitscan weapons
    const target = findHitscanTarget(forwardX, forwardY, weapon.range);

    if (target && hasLineOfSight(state.playerX, state.playerY, target.x, target.y)) {
        if (weapon.hitscan) spawnPuff(target.x, target.y, getFloorHeightAt(target.x, target.y));
        damageEnemy(target, rollWeaponDamage(weapon.damageType), 'player');
        return;
    }

    // No target or target behind a wall — spawn wall puff
    if (weapon.hitscan) {
        const wallHitPoint = rayHitPoint(state.playerX, state.playerY, forwardX, forwardY, weapon.range);
        if (wallHitPoint) spawnPuff(wallHitPoint.x, wallHitPoint.y);
    }
}

// ============================================================================
// Player Rocket Projectile
// ============================================================================

/**
 * Spawns a player-fired rocket projectile. The rocket travels in the player's
 * facing direction and explodes on contact with a wall or enemy, dealing
 * direct hit damage plus splash damage in a radius.
 *
 * Based on: linuxdoom-1.10/p_pspr.c:A_FireMissile() and info.c:mobjinfo[MT_ROCKET]
 * Accuracy: Approximation — uses the same speed, radius, and damage values but
 * the projectile physics use our simplified per-frame movement rather than DOOM's
 * fixed-point P_MobjThinker().
 */
function spawnPlayerRocket(forwardX, forwardY) {
    const spawnX = state.playerX;
    const spawnY = state.playerY;
    const spawnZ = state.floorHeight + EYE_HEIGHT * 0.8;

    const lifetime = 5;
    const endX = spawnX + forwardX * PLAYER_ROCKET_SPEED * lifetime;
    const endY = spawnY + forwardY * PLAYER_ROCKET_SPEED * lifetime;

    const projectileId = state.nextProjectileId++;
    renderer.createProjectile(projectileId, {
        type: 'player-rocket',
        width: 11, height: 11, sprite: 'MISLA1',
        startX: spawnX, startY: spawnY, startZ: spawnZ,
        endX, endY, endZ: spawnZ, duration: lifetime,
    });

    state.projectiles.push({
        id: projectileId,
        startX: spawnX,
        startY: spawnY,
        startZ: spawnZ,
        x: spawnX,
        y: spawnY,
        z: spawnZ,
        directionX: forwardX,
        directionY: forwardY,
        directionZ: 0,
        speed: PLAYER_ROCKET_SPEED,
        damage: rollWeaponDamage('rocket'),
        hitSound: 'DSBAREXP',
        source: 'player',
        lifetime,
        isPlayerRocket: true,
        spawnTime: performance.now() / 1000,
    });
}

/**
 * Handles a player rocket explosion at a given position. Deals splash damage
 * to all shootable things and the player within ROCKET_SPLASH_RADIUS.
 * Damage falls off linearly with distance from the impact point.
 *
 * Based on: linuxdoom-1.10/p_map.c:P_RadiusAttack()
 * Accuracy: Exact — uses DOOM's subtractive falloff: damage = splashDamage - dist.
 */
export function rocketExplosion(impactX, impactY) {
    // Based on: linuxdoom-1.10/p_map.c:PIT_RadiusAttack()
    // DOOM uses Chebyshev distance (max of abs deltas) minus target radius

    // Damage the player (rockets can self-damage)
    const playerDX = Math.abs(state.playerX - impactX);
    const playerDY = Math.abs(state.playerY - impactY);
    const playerDist = Math.max(0, Math.max(playerDX, playerDY) - PLAYER_RADIUS);
    if (playerDist < ROCKET_SPLASH_DAMAGE
        && hasLineOfSight(impactX, impactY, state.playerX, state.playerY)) {
        damagePlayer(ROCKET_SPLASH_DAMAGE - playerDist);
    }

    // Damage nearby things
    const allThings = state.things;
    for (let i = 0, len = allThings.length; i < len; i++) {
        const thing = allThings[i];
        if (thing.collected) continue;
        if (!SHOOTABLE.has(thing.type)) continue;

        const dx = Math.abs(thing.x - impactX);
        const dy = Math.abs(thing.y - impactY);
        const thingRadius = thing.ai ? thing.ai.radius : BARREL_RADIUS;
        const dist = Math.max(0, Math.max(dx, dy) - thingRadius);
        if (dist >= ROCKET_SPLASH_DAMAGE) continue;

        if (!hasLineOfSight(impactX, impactY, thing.x, thing.y)) continue;

        damageEnemy(thing, ROCKET_SPLASH_DAMAGE - dist, 'player');
    }
}

// ============================================================================
// Bullet Puff
// ============================================================================

/**
 * Spawns a bullet puff (wall/target impact particle) at the given position.
 * The puff is pulled 8 units back toward the player to prevent z-fighting
 * with the wall surface. The renderer handles animation and cleanup.
 */
function spawnPuff(hitX, hitY, hitFloorHeight) {
    // Pull back 8 units toward the player so the puff doesn't clip into the wall
    const toPlayerX = state.playerX - hitX;
    const toPlayerY = state.playerY - hitY;
    const distanceToPlayer = Math.sqrt(toPlayerX * toPlayerX + toPlayerY * toPlayerY);
    if (distanceToPlayer > 1) {
        hitX += (toPlayerX / distanceToPlayer) * 8;
        hitY += (toPlayerY / distanceToPlayer) * 8;
    }
    // Target hits use the provided floor height + half eye height (chest level);
    // wall hits sample the floor at the pulled-back position + full eye height
    const isTargetHit = hitFloorHeight !== undefined;
    const floorHeight = isTargetHit ? hitFloorHeight : getFloorHeightAt(hitX, hitY);
    const puffHeight = floorHeight + (isTargetHit ? EYE_HEIGHT * 0.5 : EYE_HEIGHT);
    renderer.createPuff(hitX, puffHeight, hitY);
}
