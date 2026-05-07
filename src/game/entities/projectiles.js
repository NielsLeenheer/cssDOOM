/**
 * Projectile movement, collision detection, and explosion effects.
 */

import { SHOOTABLE, ENEMY_RADIUS, EYE_HEIGHT } from '../constants.js';

import { state } from '../state.js';
import { Player } from '../player/player.js';
import { rayHitPoint, getFloorHeightAt } from '../physics.js';
import { hasLineOfSight } from '../line-of-sight.js';
import { damagePlayer } from '../player/damage.js';
import { playSound } from '../../audio/audio.js';
import { damageEnemy } from './combat.js';
import { rocketExplosion } from './weapons.js';
import * as renderer from '../../renderer/index.js';

// ============================================================================
// Projectiles
// ============================================================================

/** Collision radius for projectile-vs-player hit detection (in map units) */
const PROJECTILE_HIT_RADIUS = 24;

/**
 * Updates all active projectiles each frame. Position is calculated from
 * elapsed time since spawn (matching the renderer's visual interpolation).
 * The game layer only tracks position for collision detection.
 *
 * Iterates backwards so that splice() during removal doesn't skip elements.
 */
export function updateProjectiles() {
    const now = performance.now() / 1000;

    for (let index = state.projectiles.length - 1; index >= 0; index--) {
        const projectile = state.projectiles[index];
        const elapsed = now - projectile.spawnTime;

        // Remove projectiles that have exceeded their maximum lifetime
        if (elapsed >= projectile.lifetime) {
            renderer.removeProjectile(projectile.id);
            state.projectiles.splice(index, 1);
            continue;
        }

        // Calculate position from elapsed time (matches renderer interpolation)
        const newX = projectile.startX + projectile.directionX * projectile.speed * elapsed;
        const newY = projectile.startY + projectile.directionY * projectile.speed * elapsed;
        const newZ = projectile.startZ + projectile.directionZ * projectile.speed * elapsed;

        // Check wall collision: if line-of-sight from old to new position is
        // blocked, the projectile has hit a wall. Find the actual impact point
        // using rayHitPoint so the explosion appears on the wall surface.
        if (!hasLineOfSight(projectile.x, projectile.y, newX, newY)) {
            const moveX = newX - projectile.x;
            const moveY = newY - projectile.y;
            const moveDist = Math.sqrt(moveX * moveX + moveY * moveY);
            const dirX = moveX / moveDist;
            const dirY = moveY / moveDist;
            const hitPoint = rayHitPoint(projectile.x, projectile.y, dirX, dirY, moveDist);
            // Pull the explosion 25 units back from the wall so it doesn't clip into the surface
            const impactX = hitPoint ? hitPoint.x - dirX * 25 : projectile.x;
            const impactY = hitPoint ? hitPoint.y - dirY * 25 : projectile.y;
            spawnFireballExplosion(impactX, impactY, projectile.z);
            playSound(projectile.hitSound);
            if (projectile.isPlayerRocket) rocketExplosion(impactX, impactY);
            renderer.removeProjectile(projectile.id);
            state.projectiles.splice(index, 1);
            continue;
        }

        projectile.x = newX;
        projectile.y = newY;
        projectile.z = newZ;

        // Check floor collision: if the projectile has dropped below the floor
        // at its current position, it has hit the ground.
        const floorHeight = getFloorHeightAt(newX, newY);
        if (newZ <= floorHeight) {
            spawnFireballExplosion(newX, newY, floorHeight);
            playSound(projectile.hitSound);
            if (projectile.isPlayerRocket) rocketExplosion(newX, newY);
            renderer.removeProjectile(projectile.id);
            state.projectiles.splice(index, 1);
            continue;
        }

        // Check player collision using circular hit detection. The projectile's
        // own firer is skipped (a player rocket can't directly hit its firer,
        // though rocketExplosion splash can still self-damage). For enemy
        // projectiles the firer is an enemy, so all players are checked.
        let hitPlayer = false;
        for (const player of state.players) {
            if (player === projectile.source) continue;
            if (player.isDead) continue;
            const playerDeltaX = projectile.x - player.x;
            const playerDeltaY = projectile.y - player.y;
            if (playerDeltaX * playerDeltaX + playerDeltaY * playerDeltaY < PROJECTILE_HIT_RADIUS * PROJECTILE_HIT_RADIUS) {
                spawnFireballExplosion(projectile.x, projectile.y, projectile.z);
                playSound(projectile.hitSound);
                // Player rockets deal direct hit damage + splash; enemy projectiles
                // roll damage on impact: (P_Random()%8+1) * missileDamage.
                // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() missile damage.
                if (projectile.isPlayerRocket) {
                    damagePlayer(player, projectile.damage, projectile.source);
                    rocketExplosion(projectile.x, projectile.y);
                } else {
                    damagePlayer(player, (Math.floor(Math.random() * 8) + 1) * projectile.missileDamage, projectile.source);
                }
                renderer.removeProjectile(projectile.id);
                state.projectiles.splice(index, 1);
                hitPlayer = true;
                break;
            }
        }
        if (hitPlayer) continue;

        // Check enemy collision — projectiles can hit any enemy except the one
        // that fired them. This enables infighting: an Imp fireball that misses
        // the player and hits a Zombieman will cause the Zombieman to retarget
        // the Imp. Based on: linuxdoom-1.10/p_map.c:PIT_CheckThing()
        let hitEnemy = false;
        const allThings = state.things;
        for (let thingIndex = 0, count = allThings.length; thingIndex < count; thingIndex++) {
            const thing = allThings[thingIndex];
            if (thing.collected || thing === projectile.source) continue;
            if (!SHOOTABLE.has(thing.type)) continue;

            const enemyRadius = thing.ai ? thing.ai.radius : ENEMY_RADIUS;
            const enemyDeltaX = projectile.x - thing.x;
            const enemyDeltaY = projectile.y - thing.y;
            if (enemyDeltaX * enemyDeltaX + enemyDeltaY * enemyDeltaY < (PROJECTILE_HIT_RADIUS + enemyRadius) * (PROJECTILE_HIT_RADIUS + enemyRadius)) {
                spawnFireballExplosion(projectile.x, projectile.y, projectile.z);
                playSound(projectile.hitSound);
                // Player rockets deal direct hit damage + splash damage in a radius
                if (projectile.isPlayerRocket) {
                    damageEnemy(thing, projectile.damage, projectile.source);
                    rocketExplosion(projectile.x, projectile.y);
                } else {
                    // Roll damage on impact: (P_Random()%8+1) * missileDamage
                    damageEnemy(thing, (Math.floor(Math.random() * 8) + 1) * projectile.missileDamage, projectile.source);
                }
                renderer.removeProjectile(projectile.id);
                state.projectiles.splice(index, 1);
                hitEnemy = true;
                break;
            }
        }
        if (hitEnemy) continue;
    }
}

// ============================================================================
// Fireball Explosion
// ============================================================================

/**
 * Spawns a fireball explosion effect at the given 3D position. This is the
 * visual impact effect when an enemy projectile hits a wall or the player.
 * The renderer handles the animation and cleanup.
 */
function spawnFireballExplosion(worldX, worldY, worldZ) {
    renderer.createExplosion(worldX, worldY, worldZ);
}

/**
 * Spawns an enemy projectile (e.g. Imp fireball, Cacodemon lightning ball).
 * The projectile is created at the enemy's position at chest height and given
 * a 3D velocity vector aimed at the current target (player or infighting enemy).
 * The renderer creates the visual representation; the game layer tracks the
 * projectile in state.projectiles for per-frame movement updates.
 *
 * The `source` field on the projectile tracks which enemy fired it, used for
 * infighting retarget when the projectile hits another enemy.
 */
export function spawnProjectile(enemy, projectileDefinition) {
    // Resolve target position — aim at the current AI target (player or enemy)
    let targetX, targetY, targetFloorHeight;
    if (enemy.ai.target instanceof Player) {
        targetX = enemy.ai.target.x;
        targetY = enemy.ai.target.y;
        targetFloorHeight = enemy.ai.target.floorHeight;
    } else {
        targetX = enemy.ai.target.x;
        targetY = enemy.ai.target.y;
        targetFloorHeight = getFloorHeightAt(targetX, targetY);
    }

    const deltaX = targetX - enemy.x;
    const deltaY = targetY - enemy.y;
    const horizontalDistance = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Spawn at enemy position at roughly chest height (80% of eye height)
    const floorHeight = getFloorHeightAt(enemy.x, enemy.y);
    const spawnHeight = floorHeight + EYE_HEIGHT * 0.8;

    // Compute 3D direction vector aimed at the target's eye height
    const targetHeight = targetFloorHeight + EYE_HEIGHT;
    const deltaHeight = targetHeight - spawnHeight;
    const totalDistance = Math.sqrt(horizontalDistance * horizontalDistance + deltaHeight * deltaHeight);
    const directionX = deltaX / totalDistance;
    const directionY = deltaY / totalDistance;
    const directionZ = deltaHeight / totalDistance;

    // Create the visual projectile via the renderer
    const speed = state.skillLevel === 5 ? projectileDefinition.speed * 2 : projectileDefinition.speed;
    const lifetime = 5;
    const endX = enemy.x + directionX * speed * lifetime;
    const endY = enemy.y + directionY * speed * lifetime;
    const endZ = spawnHeight + directionZ * speed * lifetime;

    const projectileId = state.nextProjectileId++;
    renderer.createProjectile(projectileId, {
        type: 'enemy',
        width: projectileDefinition.size, height: projectileDefinition.size,
        sprite: projectileDefinition.sprite,
        startX: enemy.x, startY: enemy.y, startZ: spawnHeight,
        endX, endY, endZ, duration: lifetime,
    });

    const projectile = {
        id: projectileId,
        startX: enemy.x,
        startY: enemy.y,
        startZ: spawnHeight,
        x: enemy.x,
        y: enemy.y,
        z: spawnHeight,
        directionX, directionY, directionZ,
        speed,
        missileDamage: projectileDefinition.missileDamage,
        hitSound: projectileDefinition.hitSound,
        source: enemy, // which enemy fired this — used for infighting retarget on hit
        lifetime,
        spawnTime: performance.now() / 1000,
    };

    state.projectiles.push(projectile);
    playSound(projectileDefinition.sound);
}
