/**
 * Player weapon equipping, firing, hit detection, and rocket projectiles.
 */

import { state } from '../state.js';
import {
    WEAPONS, SHOOTABLE, EYE_HEIGHT,
    PLAYER_ROCKET_SPEED, PLAYER_ROCKET_RADIUS,
    ROCKET_SPLASH_DAMAGE, PLAYER_RADIUS,
    BARREL_RADIUS, WEAPON_SWITCH_MS,
} from '../constants.js';
import { getFloorHeightAt, rayHitPoint } from '../physics.js';
import { hasLineOfSight } from '../line-of-sight.js';
import { damagePlayer } from '../player/damage.js';
import { hasPowerup } from '../player/pickups.js';
import { playSound } from '../../audio/audio.js';
import { setEnemyState } from './enemies.js';
import { damageEnemy } from './combat.js';
import * as renderer from '../../renderer/index.js';
import { inputs } from '../../input/index.js';
import { propagateSound } from '../sound-propagation.js';
import { isMatchLobby } from '../match.js';

// ============================================================================
// Weapon Loading & Equipping
// ============================================================================

/**
 * Equips a weapon by slot number. Updates player state and tells the renderer
 * to switch visuals (the renderer decides whether to animate).
 */
export function equipWeapon(player, slot) {
    const weapon = WEAPONS[slot];
    if (!weapon || !player.ownedWeapons.has(slot)) return;

    const isSwitching = slot !== player.currentWeapon;

    player.isFiring = false;
    player.currentWeapon = slot;
    if (isSwitching) {
        player.weaponSwitchUntil = performance.now() + WEAPON_SWITCH_MS;
    }
    renderer.switchWeapon(player.viewportIndex, weapon.name, weapon.fireRate);
}

// ============================================================================
// Firing
// ============================================================================

/**
 * Per-player interval handles for continuous-fire weapons (e.g. chaingun).
 * When a continuous weapon fires, an interval is started that keeps firing
 * rounds at the weapon's fire rate until the player releases the fire button,
 * runs out of ammo, or dies.
 */
const automaticFireIntervalsByPlayer = new Map();

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
export function fireWeapon(player) {
    if (player.isDead || player.isFiring || performance.now() < player.weaponSwitchUntil) return;
    // Lobby gate: claimed players can't shoot until the match formally
    // starts. Also covers the chaingun auto-fire loop (which calls
    // fireWeapon recursively while fireHeld stays true).
    if (isMatchLobby()) return;

    const weapon = WEAPONS[player.currentWeapon];
    if (!weapon) return;

    // Check ammo availability (some weapons like the fist have no ammo type)
    if (weapon.ammoType && player.ammo[weapon.ammoType] < weapon.ammoPerShot) return;

    // Deduct ammo cost for this shot
    if (weapon.ammoType) player.ammo[weapon.ammoType] -= weapon.ammoPerShot;
    player.isFiring = true;

    playSound(weapon.sound);

    renderer.startFiring(player.viewportIndex);

    // Trigger the attack pose on this player's billboard sprite so the
    // opposing player sees them firing (front-facing PLAYE/F frames, row
    // 5 of the PLAY sheet). The renderer auto-returns to walk after the
    // animation duration.
    if (player.thingIndex >= 0) renderer.playPlayerAttack(player.thingIndex);

    // Perform hitscan hit detection for this shot
    checkWeaponHit(player);

    // Wake up nearby idle enemies who can hear the gunfire
    alertNearbyEnemies(player);

    // Continuous-fire weapons (chaingun): set up an auto-fire interval that
    // keeps shooting at the weapon's fire rate while the fire button is held.
    // Each interval tick deducts ammo, plays the fire sound, and runs hit detection.
    const playerInput = inputs[player.index];
    if (weapon.continuous && playerInput.fireHeld) {
        stopAutoFire(player);
        const handle = setInterval(() => {
            if (!playerInput.fireHeld || player.isDead || (weapon.ammoType && player.ammo[weapon.ammoType] < weapon.ammoPerShot)) {
                stopAutoFire(player);
                return;
            }
            if (weapon.ammoType) player.ammo[weapon.ammoType] -= weapon.ammoPerShot;
            playSound(weapon.sound);
            checkWeaponHit(player);
            alertNearbyEnemies(player);
        }, weapon.fireRate);
        automaticFireIntervalsByPlayer.set(player.index, handle);
    } else {
        // Non-continuous weapons: re-allow firing after the fire rate elapses.
        // If the fire button is still held, immediately fire again.
        setTimeout(() => {
            player.isFiring = false;
            if (playerInput.fireHeld) fireWeapon(player);
        }, weapon.fireRate);
    }
}

/**
 * Stops the continuous-fire interval (used by chaingun). Called when the
 * player releases the fire button, runs out of ammo, or dies.
 */
export function stopAutoFire(player) {
    const handle = automaticFireIntervalsByPlayer.get(player.index);
    if (handle) {
        clearInterval(handle);
        automaticFireIntervalsByPlayer.delete(player.index);
        renderer.stopFiring(player.viewportIndex);
        player.isFiring = false;
    }
}

// ============================================================================
// Sound Alert — enemies hear gunfire and wake up
// ============================================================================

/**
 * When the player fires a weapon, propagate sound through connected sectors.
 * Enemies in reached sectors will wake up during their next AI idle check.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_NoiseAlert() → P_RecursiveSound()
 * Sound floods through two-sided linedefs, blocked by ML_SOUNDBLOCK lines
 * (can pass through at most one sound-blocking line).
 */
function alertNearbyEnemies(player) {
    propagateSound(player);
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
function rollWeaponDamage(player, damageType) {
    switch (damageType) {
        case 'melee': {
            // Based on: linuxdoom-1.10/p_map.c:P_LineAttack() — Berserk multiplies by 10
            const baseDamage = (Math.floor(Math.random() * 10) + 1) * 2;
            return hasPowerup(player, 'berserk') ? baseDamage * 10 : baseDamage;
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
 * Includes other players (kind:'player' things) as valid targets — the
 * firing player's own thing is excluded so you can't hitscan yourself.
 *
 * The ray is defined by a direction vector (dirX, dirY) and a maximum range.
 * A dot product threshold of 0.99 (~8° cone) determines if a thing is close
 * enough to the ray to be considered a hit.
 */
function findHitscanTarget(player, dirX, dirY, range) {
    let closestDistance = Infinity;
    let closestThing = null;
    const ownThing = player.thingRef;

    const allThings = state.things;
    for (let index = 0, length = allThings.length; index < length; index++) {
        const thing = allThings[index];
        if (thing.collected) continue;
        if (thing === ownThing) continue;
        if (!SHOOTABLE.has(thing.type) && thing.kind !== 'player') continue;

        const deltaX = thing.x - player.x;
        const deltaY = thing.y - player.y;
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
 * Routes damage from a hitscan/melee hit to the right damage function based
 * on whether the target is another player (damagePlayer) or an enemy/barrel
 * (damageEnemy). Source is always the firing Player ref.
 */
function damageHitscanTarget(target, amount, source) {
    if (target.kind === 'player') {
        damagePlayer(target.player, amount, source);
    } else {
        damageEnemy(target, amount, source);
    }
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
function checkWeaponHit(player) {
    const weapon = WEAPONS[player.currentWeapon];
    if (!weapon) return;

    const forwardX = -Math.sin(player.angle);
    const forwardY = Math.cos(player.angle);

    if (weapon.damageType === 'rocket') {
        // Rocket launcher spawns a projectile instead of hitscan
        spawnPlayerRocket(player, forwardX, forwardY);
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
            const pelletAngle = player.angle + spreadAngle;
            const pelletDirX = -Math.sin(pelletAngle);
            const pelletDirY = Math.cos(pelletAngle);

            const target = findHitscanTarget(player, pelletDirX, pelletDirY, weapon.range);
            if (target && hasLineOfSight(player.x, player.y, target.x, target.y)) {
                spawnPuff(player, target.x, target.y, getFloorHeightAt(target.x, target.y));
                damageHitscanTarget(target, rollWeaponDamage(player, 'hitscan'), player);
            } else {
                const wallHit = rayHitPoint(player.x, player.y, pelletDirX, pelletDirY, weapon.range, player.floorHeight + EYE_HEIGHT);
                if (wallHit) spawnPuff(player, wallHit.x, wallHit.y);
            }
        }
        return;
    }

    // Melee and single-ray hitscan weapons
    const target = findHitscanTarget(player, forwardX, forwardY, weapon.range);

    if (target && hasLineOfSight(player.x, player.y, target.x, target.y)) {
        if (weapon.hitscan) spawnPuff(player, target.x, target.y, getFloorHeightAt(target.x, target.y));
        damageHitscanTarget(target, rollWeaponDamage(player, weapon.damageType), player);
        return;
    }

    // No target or target behind a wall — spawn wall puff
    if (weapon.hitscan) {
        const wallHitPoint = rayHitPoint(player.x, player.y, forwardX, forwardY, weapon.range, player.floorHeight + EYE_HEIGHT);
        if (wallHitPoint) spawnPuff(player, wallHitPoint.x, wallHitPoint.y);
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
function spawnPlayerRocket(player, forwardX, forwardY) {
    const spawnX = player.x;
    const spawnY = player.y;
    const spawnZ = player.floorHeight + EYE_HEIGHT * 0.8;

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
        damage: rollWeaponDamage(player, 'rocket'),
        hitSound: 'DSBAREXP',
        source: player,
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
export function rocketExplosion(impactX, impactY, attacker = null) {
    // Based on: linuxdoom-1.10/p_map.c:PIT_RadiusAttack()
    // DOOM uses Chebyshev distance (max of abs deltas) minus target radius

    // Damage every player within splash radius (rockets can self-damage).
    // `attacker` is the firing Player ref so frag attribution works for
    // splash kills — without it, awardFrag treats the kill as a suicide
    // and decrements the victim's score instead of giving the killer +1.
    for (const player of state.players) {
        const playerDX = Math.abs(player.x - impactX);
        const playerDY = Math.abs(player.y - impactY);
        const playerDist = Math.max(0, Math.max(playerDX, playerDY) - PLAYER_RADIUS);
        if (playerDist < ROCKET_SPLASH_DAMAGE
            && hasLineOfSight(impactX, impactY, player.x, player.y)) {
            damagePlayer(player, ROCKET_SPLASH_DAMAGE - playerDist, attacker);
        }
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

        damageEnemy(thing, ROCKET_SPLASH_DAMAGE - dist, attacker);
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
function spawnPuff(player, hitX, hitY, hitFloorHeight) {
    // Pull back 8 units toward the player so the puff doesn't clip into the wall
    const toPlayerX = player.x - hitX;
    const toPlayerY = player.y - hitY;
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
