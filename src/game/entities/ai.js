/**
 * Enemy AI — state machine, movement, and per-frame update loop.
 */

import {
    ENEMIES, ENEMY_PROJECTILES,
    MELEE_RANGE, LINE_OF_SIGHT_CHECK_INTERVAL, MAX_RENDER_DISTANCE,
    MAX_STEP_HEIGHT, ENEMY_RADIUS,
} from '../constants.js';

import { state, debug } from '../state.js';
import { canMoveTo, getFloorHeightAt, getSectorLightAt } from '../physics.js';
import * as renderer from '../../renderer/index.js';
import { hasLineOfSight } from '../line-of-sight.js';
import { damagePlayer } from '../player/damage.js';
import { playSound } from '../../audio/audio.js';
import { setEnemyState, respawnEnemy } from './enemies.js';
import { enemyHitscanAttack, enemyHitscanAttackEnemy, checkMissileRange, damageEnemy } from './combat.js';
import { spawnProjectile } from './projectiles.js';

// ============================================================================
// Enemy AI
// ============================================================================

/**
 * Timestamp of the last enemy alert sound, used to throttle alert sounds so
 * multiple enemies waking up simultaneously don't stack their alert cries.
 */
let lastAlertSoundTime = 0;

// ============================================================================
// DOOM-style 8-directional movement system
// Based on: linuxdoom-1.10/p_enemy.c — direction enums, xspeed/yspeed,
// P_NewChaseDir, P_Move, P_TryWalk
// ============================================================================

const DI_EAST = 0;
const DI_NORTHEAST = 1;
const DI_NORTH = 2;
const DI_NORTHWEST = 3;
const DI_WEST = 4;
const DI_SOUTHWEST = 5;
const DI_SOUTH = 6;
const DI_SOUTHEAST = 7;
const DI_NODIR = 8;

// opposite[dir] — the reverse direction, used for turnaround prevention.
// Based on: linuxdoom-1.10/p_enemy.c:opposite[]
const oppositeDir = [DI_WEST, DI_SOUTHWEST, DI_SOUTH, DI_SOUTHEAST, DI_EAST, DI_NORTHEAST, DI_NORTH, DI_NORTHWEST, DI_NODIR];

// Diagonal direction lookup: diagDir[((deltaY<0)<<1) + (deltaX>0)]
// Maps quadrant to the appropriate diagonal direction.
// Based on: linuxdoom-1.10/p_enemy.c:diags[]
const diagDir = [DI_NORTHWEST, DI_NORTHEAST, DI_SOUTHWEST, DI_SOUTHEAST];

// Movement vectors per direction (cardinal = 1.0, diagonal ≈ 0.7071)
// Based on: linuxdoom-1.10/p_enemy.c:xspeed[]/yspeed[] tables
const dirDX = [1, 0.7071, 0, -0.7071, -1, -0.7071, 0, 0.7071];
const dirDY = [0, 0.7071, 1, 0.7071, 0, -0.7071, -1, -0.7071];

/**
 * Rolls random melee damage for an enemy type using DOOM's exact formulas.
 * Based on: linuxdoom-1.10/p_enemy.c — A_TroopAttack, A_SargAttack, A_BruisAttack
 */
function rollMeleeDamage(enemyType) {
    switch (enemyType) {
        case 3001: return (Math.floor(Math.random() * 8) + 1) * 3;   // Imp: 3–24
        case 3002:
        case 58:   return (Math.floor(Math.random() * 10) + 1) * 4;  // Demon/Spectre: 4–40
        case 3003: return (Math.floor(Math.random() * 8) + 1) * 10;  // Baron: 10–80
        default:   return 0;
    }
}

/**
 * Tests whether an enemy can take one step in a given direction.
 * The step distance matches DOOM's P_Move: mobjinfo.speed map units.
 * We derive this from the enemy's effective speed and chase tics:
 * stepSize = speed * chaseTics / 35 (recovering the original DOOM speed).
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_TryWalk() → P_Move()
 */
function canWalkDir(enemy, dir) {
    if (dir >= DI_NODIR) return false;
    const stepSize = enemy.ai.speed * (enemy.ai.chaseTics || 3) / 35;
    const testX = enemy.x + stepSize * dirDX[dir];
    const testY = enemy.y + stepSize * dirDY[dir];
    const floorHeight = getFloorHeightAt(enemy.x, enemy.y);
    return canMoveTo(testX, testY, ENEMY_RADIUS, floorHeight, MAX_STEP_HEIGHT);
}

/**
 * Picks a DOOM-style movement direction for an enemy, following the exact
 * try-order from P_NewChaseDir:
 *   1. Try the diagonal toward the target
 *   2. Try the horizontal axis toward the target
 *   3. Try the vertical axis toward the target
 *      (2 and 3 are randomly swapped ~21% of the time, or when |ΔY|>|ΔX|)
 *   4. Try the previous direction
 *   5. Exhaustive scan of all 8 directions (random forward/backward order)
 *   6. Last resort: try the turnaround direction
 *   7. Give up: set DI_NODIR (enemy is stuck)
 *
 * Each candidate is tested for walkability via canWalkDir before committing.
 * The turnaround direction (opposite of previous) is excluded from steps 1-5.
 *
 * On success, sets enemy.ai.moveDir and enemy.ai.moveTimer based on DOOM's
 * movecount mechanism: random 0-15, scaled by chase frame duration.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_NewChaseDir()
 * Accuracy: Exact try-order and turnaround logic. Uses canMoveTo instead of
 * DOOM's P_TryMove/P_CheckPosition, which is functionally equivalent.
 */
function pickMoveDirection(enemy, targetX, targetY) {
    const deltaX = targetX - enemy.x;
    const deltaY = targetY - enemy.y;

    const oldDir = enemy.ai.moveDir ?? DI_NODIR;
    const turnaround = oppositeDir[oldDir];

    // Determine horizontal and vertical preferences (DOOM uses 10*FRACUNIT dead zone)
    let horizDir, vertDir;
    if (deltaX > 10) horizDir = DI_EAST;
    else if (deltaX < -10) horizDir = DI_WEST;
    else horizDir = DI_NODIR;

    if (deltaY < -10) vertDir = DI_SOUTH;
    else if (deltaY > 10) vertDir = DI_NORTH;
    else vertDir = DI_NODIR;

    // Step 1: Try diagonal toward target
    if (horizDir !== DI_NODIR && vertDir !== DI_NODIR) {
        const diag = diagDir[((deltaY < 0) ? 2 : 0) + (deltaX > 0 ? 1 : 0)];
        if (diag !== turnaround && canWalkDir(enemy, diag)) {
            commitDirection(enemy, diag);
            return;
        }
    }

    // Steps 2-3: Try axis-aligned directions
    // Randomly swap try order (~21% chance) or when |ΔY| > |ΔX|
    if (Math.random() * 255 > 200 || Math.abs(deltaY) > Math.abs(deltaX)) {
        const tmp = horizDir; horizDir = vertDir; vertDir = tmp;
    }
    if (horizDir === turnaround) horizDir = DI_NODIR;
    if (vertDir === turnaround) vertDir = DI_NODIR;

    if (horizDir !== DI_NODIR && canWalkDir(enemy, horizDir)) {
        commitDirection(enemy, horizDir);
        return;
    }
    if (vertDir !== DI_NODIR && canWalkDir(enemy, vertDir)) {
        commitDirection(enemy, vertDir);
        return;
    }

    // Step 4: Try old direction
    if (oldDir !== DI_NODIR && oldDir !== turnaround && canWalkDir(enemy, oldDir)) {
        commitDirection(enemy, oldDir);
        return;
    }

    // Step 5: Exhaustive scan of all 8 directions (random forward or backward)
    if (Math.random() < 0.5) {
        for (let dir = DI_EAST; dir <= DI_SOUTHEAST; dir++) {
            if (dir !== turnaround && canWalkDir(enemy, dir)) {
                commitDirection(enemy, dir);
                return;
            }
        }
    } else {
        for (let dir = DI_SOUTHEAST; dir >= DI_EAST; dir--) {
            if (dir !== turnaround && canWalkDir(enemy, dir)) {
                commitDirection(enemy, dir);
                return;
            }
        }
    }

    // Step 6: Last resort — try turnaround
    if (turnaround !== DI_NODIR && canWalkDir(enemy, turnaround)) {
        commitDirection(enemy, turnaround);
        return;
    }

    // Step 7: Completely stuck
    enemy.ai.moveDir = DI_NODIR;
}

/**
 * Commits a chosen direction and sets the move timer based on DOOM's movecount.
 * movecount = random(0..15), which corresponds to that many A_Chase calls before
 * the next direction pick. Duration = movecount × chaseTics / 35 seconds.
 * Based on: linuxdoom-1.10/p_enemy.c:P_TryWalk() — movecount = P_Random()&15
 */
function commitDirection(enemy, dir) {
    enemy.ai.moveDir = dir;
    const moveCount = Math.floor(Math.random() * 16);
    enemy.ai.moveTimer = moveCount * (enemy.ai.chaseTics || 3) / 35;
}

/**
 * Moves an enemy toward a target position using DOOM-style cardinal movement.
 * Each frame, the enemy moves along its current direction at its configured speed.
 * When the move timer expires (DOOM's movecount depleted) or the enemy is blocked,
 * a new direction is picked via pickMoveDirection.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:A_Chase() movement section + P_Move()
 * Accuracy: Uses continuous delta-time movement instead of discrete per-tic steps.
 * Direction selection and timer mechanism match DOOM exactly.
 */
function moveEnemyToward(enemy, targetX, targetY, deltaTime) {
    if (debug.noEnemyMove) return;
    const deltaX = targetX - enemy.x;
    const deltaY = targetY - enemy.y;
    const distSqToTarget = deltaX * deltaX + deltaY * deltaY;
    if (distSqToTarget <= MELEE_RANGE * MELEE_RANGE) return;

    // Count down the move timer; pick a new direction when it expires
    // Based on: A_Chase() — if (--actor->movecount < 0 || !P_Move(actor)) P_NewChaseDir(actor);
    enemy.ai.moveTimer = (enemy.ai.moveTimer ?? 0) - deltaTime;
    if (enemy.ai.moveTimer <= 0 || enemy.ai.moveDir === undefined || enemy.ai.moveDir === DI_NODIR) {
        pickMoveDirection(enemy, targetX, targetY);
    }

    const dir = enemy.ai.moveDir;
    if (dir === undefined || dir >= DI_NODIR) return;

    const movementStep = enemy.ai.speed * deltaTime;
    const movementX = dirDX[dir] * movementStep;
    const movementY = dirDY[dir] * movementStep;

    let newX = enemy.x + movementX;
    let newY = enemy.y + movementY;
    const previousX = enemy.x;
    const previousY = enemy.y;
    const enemyFloorHeight = getFloorHeightAt(enemy.x, enemy.y);

    // Try full diagonal move first, then axis-aligned sliding, then give up
    if (canMoveTo(newX, newY, ENEMY_RADIUS, enemyFloorHeight, MAX_STEP_HEIGHT)) {
        enemy.x = newX;
        enemy.y = newY;
    } else if (canMoveTo(newX, enemy.y, ENEMY_RADIUS, enemyFloorHeight, MAX_STEP_HEIGHT)) {
        enemy.x = newX;
    } else if (canMoveTo(enemy.x, newY, ENEMY_RADIUS, enemyFloorHeight, MAX_STEP_HEIGHT)) {
        enemy.y = newY;
    } else {
        // Fully blocked — force direction re-evaluation
        pickMoveDirection(enemy, targetX, targetY);
    }

    // Update the enemy's facing direction based on actual movement vector
    const actualMovementX = enemy.x - previousX;
    const actualMovementY = enemy.y - previousY;
    if (actualMovementX * actualMovementX + actualMovementY * actualMovementY > 0.001) {
        enemy.facing = Math.atan2(actualMovementY, actualMovementX);
    }
}

/**
 * Updates an enemy's rendered position and lighting to match its current
 * world coordinates. Notifies the renderer to update the visual representation.
 */
function updateEnemyPosition(thingIndex, enemy) {
    const floorHeight = getFloorHeightAt(enemy.x, enemy.y);
    renderer.updateThingPosition(thingIndex, enemy.x, enemy.y, floorHeight);
    // Only update lighting periodically — sector light doesn't change often
    if (!enemy._lastLightUpdate || performance.now() - enemy._lastLightUpdate > 1000) {
        enemy._lastLightUpdate = performance.now();
        const sectorLight = getSectorLightAt(enemy.x, enemy.y);
        renderer.updateThingLight(thingIndex, sectorLight);
    }
}

/**
 * Resolves the current chase target's position. Returns {x, y} for wherever
 * the enemy should move toward and attack. If the target is 'player', uses
 * the player's position. If the target is another enemy entry, uses that
 * enemy's position.
 *
 * Also handles target invalidation: if the target enemy is dead/collected,
 * reverts to targeting the player and resets threshold.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:A_Chase() lines ~470-490
 * Accuracy: Exact — same "target dead → threshold=0 → P_LookForPlayers" flow,
 * except P_LookForPlayers always finds the single player in our single-player game.
 */
function resolveTarget(enemy, deltaTime) {
    const enemyAI = enemy.ai;

    if (enemyAI.target !== 'player') {
        // Infighting target — check if it's still alive
        if (enemyAI.target.collected || enemyAI.target.hp <= 0) {
            // Target killed: revert to chasing the player
            enemyAI.target = 'player';
            enemyAI.threshold = 0;
        }
    }

    // Count down the retarget lock timer (in seconds, frame-rate independent)
    if (enemyAI.threshold > 0) {
        enemyAI.threshold -= deltaTime;
    }

    if (enemyAI.target === 'player') {
        return { x: state.playerX, y: state.playerY };
    }
    return { x: enemyAI.target.x, y: enemyAI.target.y };
}

/**
 * Updates a single enemy's AI behavior for one frame.
 *
 * @param {number} thingIndex - Index into state.things
 * @param {object} enemy - The enemy game object
 * @param {number} deltaTime - Frame delta in seconds
 * @param {number} currentTime - Current time from performance.now()
 */
function updateSingleEnemy(thingIndex, enemy, deltaTime, currentTime) {
    const enemyAI = enemy.ai;
    enemyAI.stateTime += deltaTime;

    // Resolve who the enemy is targeting (player or another enemy via infighting)
    const targetPos = resolveTarget(enemy, deltaTime);
    const deltaX = targetPos.x - enemy.x;
    const deltaY = targetPos.y - enemy.y;
    const distSqToTarget = deltaX * deltaX + deltaY * deltaY;

    switch (enemyAI.state) {
        case 'idle':
            // Periodically check if the player is visible (throttled to save performance)
            enemyAI.losTimer += deltaTime;
            if (enemyAI.losTimer >= LINE_OF_SIGHT_CHECK_INTERVAL) {
                enemyAI.losTimer = 0;
                if (distSqToTarget < enemyAI.sightRange * enemyAI.sightRange && hasLineOfSight(enemy.x, enemy.y, targetPos.x, targetPos.y)) {
                    setEnemyState(thingIndex, enemy, 'chasing');
                    // Reaction time: delay before the enemy can first attack after
                    // spotting the player. Based on: linuxdoom-1.10/p_enemy.c:A_Chase()
                    // which checks reactiontime > 0 before allowing missile attacks.
                    enemyAI.reactionTimer = enemyAI.reactionTime;
                    // Throttle alert sounds so multiple enemies waking up at once
                    // don't produce a cacophony of overlapping cries
                    if (currentTime - lastAlertSoundTime > 500) {
                        lastAlertSoundTime = currentTime;
                        playSound(enemyAI.alertSound);
                    }
                }
            }
            break;

        case 'chasing':
            moveEnemyToward(enemy, targetPos.x, targetPos.y, deltaTime);
            updateEnemyPosition(thingIndex, enemy);

            // Count down reaction time (delay before first attack after sighting)
            if (enemyAI.reactionTimer > 0) {
                enemyAI.reactionTimer -= deltaTime;
                break;
            }

            // Attack decision: DOOM checks melee first, then ranged.
            // Based on: linuxdoom-1.10/p_enemy.c:A_Chase() lines 405–440
            if ((currentTime - enemyAI.lastAttack) > enemyAI.cooldown * 1000) {
                if (debug.noEnemyAttack && enemyAI.target === 'player') break;

                // Melee attack: if enemy has a melee state and target is within MELEERANGE (64)
                if (enemyAI.meleeRange && distSqToTarget < enemyAI.meleeRange * enemyAI.meleeRange) {
                    enemyAI.attackIsMelee = true;
                    setEnemyState(thingIndex, enemy, 'attacking');
                }
                // Ranged attack: non-melee-only enemies check LOS + P_CheckMissileRange
                else if (!enemyAI.melee && distSqToTarget < enemyAI.attackRange * enemyAI.attackRange) {
                    enemyAI.losTimer += deltaTime;
                    if (enemyAI.losTimer >= LINE_OF_SIGHT_CHECK_INTERVAL) {
                        enemyAI.losTimer = 0;
                        if (hasLineOfSight(enemy.x, enemy.y, targetPos.x, targetPos.y)
                            && checkMissileRange(enemy, Math.sqrt(distSqToTarget))) {
                            enemyAI.attackIsMelee = false;
                            setEnemyState(thingIndex, enemy, 'attacking');
                        }
                    }
                }
            }
            break;

        case 'attacking':
            // Damage is dealt at the midpoint of the attack animation, giving
            // the visual wind-up time before the actual hit/shot connects
            if (!enemyAI.damageDealt && enemyAI.stateTime >= enemyAI.attackDuration / 2) {
                enemyAI.damageDealt = true;
                const targetIsPlayer = enemyAI.target === 'player';

                if (enemyAI.attackIsMelee) {
                    // Melee attack: random damage roll matching DOOM's A_TroopAttack,
                    // A_SargAttack, A_BruisAttack formulas
                    const meleeDmg = rollMeleeDamage(enemy.type);
                    if (hasLineOfSight(enemy.x, enemy.y, targetPos.x, targetPos.y)) {
                        if (targetIsPlayer) {
                            damagePlayer(meleeDmg);
                        } else {
                            damageEnemy(enemyAI.target, meleeDmg, enemy);
                        }
                    }
                    // Demon/Spectre: sfx_sgtatk, Imp/Baron: sfx_claw
                    playSound(enemy.type === 3002 || enemy.type === 58 ? 'DSSGTATK' : 'DSCLAW');
                } else {
                    // Ranged attack: either spawn a projectile or use hitscan
                    const projectileDefinition = ENEMY_PROJECTILES[enemy.type];
                    if (projectileDefinition) {
                        // Projectile enemies (Imp, Cacodemon, Baron): spawn a fireball
                        // toward the current target (player or infighting enemy)
                        spawnProjectile(enemy, projectileDefinition);
                    } else if (enemyAI.pellets) {
                        // Hitscan enemies (Zombieman, Shotgun Guy)
                        if (targetIsPlayer) {
                            enemyHitscanAttack(enemy, enemyAI);
                        } else {
                            // Hitscan against another enemy during infighting
                            enemyHitscanAttackEnemy(enemy, enemyAI);
                        }
                    }
                }
            }
            // Return to chasing after the full attack animation completes
            if (enemyAI.stateTime >= enemyAI.attackDuration) {
                enemyAI.lastAttack = currentTime;
                setEnemyState(thingIndex, enemy, 'chasing');
            }
            break;

        case 'pain':
            // Wait for the pain stun duration to expire before resuming chase
            if (enemyAI.stateTime >= enemyAI.painDuration) {
                setEnemyState(thingIndex, enemy, 'chasing');
            }
            break;
    }
}

/**
 * Main per-frame update for all enemies. Iterates all thing elements, skipping
 * dead/collected things, non-enemies, and enemies beyond the maximum render
 * distance (performance optimization — distant enemies are not visible and
 * don't need AI updates). For each active nearby enemy, runs AI state updates
 * and sprite rotation calculations.
 */
export function updateAllEnemies(deltaTime) {
    if (state.isDead) return;
    const currentTime = performance.now();
    const allThings = state.things;
    for (let index = 0, length = allThings.length; index < length; index++) {
        const thing = allThings[index];
        if (!thing.ai) continue;
        if (!ENEMIES.has(thing.type)) continue;

        // Nightmare respawn: count down dead enemies and respawn them
        // Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
        if (thing.collected) {
            if (thing.respawnTimer !== undefined) {
                thing.respawnTimer -= deltaTime;
                if (thing.respawnTimer <= 0) {
                    respawnEnemy(index, thing);
                }
            }
            continue;
        }

        // Skip enemies too far away for performance (they won't be visible anyway)
        const deltaX = thing.x - state.playerX;
        const deltaY = thing.y - state.playerY;
        if (deltaX * deltaX + deltaY * deltaY > MAX_RENDER_DISTANCE * MAX_RENDER_DISTANCE) continue;

        updateSingleEnemy(index, thing, deltaTime, currentTime);
        renderer.updateEnemyRotation(index, thing);
    }
}
