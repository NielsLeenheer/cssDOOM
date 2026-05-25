/**
 * Enemy combat — hitscan attacks, damage handling, and barrel explosions.
 */

import {
    SHOOTABLE, ENEMY_RADIUS, PLAYER_RADIUS,
    BARREL_EXPLOSION_DAMAGE, BARREL_RADIUS,
    INFIGHTING_THRESHOLD,
} from '../../shared/constants.js';

import { state } from '../state.js';
import { Player } from '../player/player.js';
import { currentMap } from '../../shared/maps/index.js';
import { hasLineOfSight } from '../line-of-sight.js';
import { damagePlayer } from '../player/damage.js';
import { hasPowerup } from '../player/pickups.js';
import { orchestrator } from '../../orchestrator.js';
import { setEnemyState } from './enemies.js';
import { recordKill } from '../sp-stats.js';
import { lowerFloorsWithTag } from '../mechanics/floors.js';
import { orchestrator as renderer } from "../../orchestrator.js";

// ============================================================================
// Enemy Hitscan Attack
// ============================================================================

/**
 * Performs an enemy hitscan attack (used by Zombieman and Shotgun Guy).
 *
 * Based on: linuxdoom-1.10/p_enemy.c:A_PosAttack() and A_SPosAttack()
 * Accuracy: Approximation — uses the same angular spread formula and damage
 * rolls, but since we don't trace individual rays through the 2D map, we
 * approximate hit/miss by checking if the spread angle is within the angular
 * size of the player at the given distance.
 *
 * Each pellet gets an independent random angular spread of roughly ±22 degrees
 * ((P_Random()-P_Random()) scaled to angle range) and independent damage roll
 * of ((random 0-4) + 1) * 3 = 3 to 15 per pellet.
 *
 * Zombieman fires 1 pellet (3-15 damage), Shotgun Guy fires 3 (9-45 damage).
 */
export function enemyHitscanAttack(enemy, enemyAI, targetPlayer) {
    if (!hasLineOfSight(enemy.x, enemy.y, targetPlayer.x, targetPlayer.y)) {
        orchestrator.playSound(enemyAI.hitscanSound, { x: enemy.x, y: enemy.y });
        return;
    }

    const deltaX = targetPlayer.x - enemy.x;
    const deltaY = targetPlayer.y - enemy.y;
    const distanceToPlayer = Math.sqrt(deltaX * deltaX + deltaY * deltaY);

    // Angular size of the player at this distance (using player collision radius)
    const playerAngularSize = Math.atan2(PLAYER_RADIUS, distanceToPlayer);

    let totalDamage = 0;
    for (let pellet = 0; pellet < enemyAI.pellets; pellet++) {
        // Angular spread: (P_Random()-P_Random()) gives range [-255, +255].
        // In DOOM this is shifted left 20 bits in a 32-bit angle space (2^32 = 360°),
        // giving roughly ±22.4° max spread. We convert directly to radians.
        // Based on: linuxdoom-1.10/p_enemy.c:A_PosAttack() / p_map.c:P_AimLineAttack()
        // When the player has Partial Invisibility (MF_SHADOW), the spread is doubled.
        const maxSpreadDegrees = hasPowerup(targetPlayer, 'invisibility') ? 45 : 22.5;
        const spreadFraction = (Math.floor(Math.random() * 256) - Math.floor(Math.random() * 256)) / 255;
        const spreadAngle = spreadFraction * (maxSpreadDegrees * Math.PI / 180);

        // The pellet hits if the spread angle stays within the player's angular size
        if (Math.abs(spreadAngle) < playerAngularSize) {
            // Damage roll per pellet: ((random 0-4) + 1) * 3 = 3, 6, 9, 12, or 15
            totalDamage += (Math.floor(Math.random() * 5) + 1) * 3;
        }
    }

    orchestrator.playSound(enemyAI.hitscanSound, { x: enemy.x, y: enemy.y });
    if (totalDamage > 0) {
        damagePlayer(targetPlayer, totalDamage, enemy);
    }
}

/**
 * Hitscan attack against another enemy during infighting.
 * Same angular spread and damage rolls as enemyHitscanAttack, but damages
 * the infighting target enemy instead of the player, using ENEMY_RADIUS
 * for the hit cone instead of PLAYER_RADIUS.
 */
export function enemyHitscanAttackEnemy(attacker, attackerAI) {
    const target = attackerAI.target;
    if (!target || target.collected) return;

    if (!hasLineOfSight(attacker.x, attacker.y, target.x, target.y)) {
        orchestrator.playSound(attackerAI.hitscanSound, { x: attacker.x, y: attacker.y });
        return;
    }

    const deltaX = target.x - attacker.x;
    const deltaY = target.y - attacker.y;
    const distanceToTarget = Math.sqrt(deltaX * deltaX + deltaY * deltaY);
    const targetRadius = target.ai ? target.ai.radius : ENEMY_RADIUS;
    const targetAngularSize = Math.atan2(targetRadius, distanceToTarget);

    let totalDamage = 0;
    for (let pellet = 0; pellet < attackerAI.pellets; pellet++) {
        const spreadFraction = (Math.floor(Math.random() * 256) - Math.floor(Math.random() * 256)) / 255;
        const spreadAngle = spreadFraction * (22.5 * Math.PI / 180);
        if (Math.abs(spreadAngle) < targetAngularSize) {
            totalDamage += (Math.floor(Math.random() * 5) + 1) * 3;
        }
    }

    orchestrator.playSound(attackerAI.hitscanSound, { x: attacker.x, y: attacker.y });
    if (totalDamage > 0) {
        damageEnemy(target, totalDamage, attacker);
    }
}

/**
 * Distance-based attack probability check for ranged enemies.
 *
 * Based on: linuxdoom-1.10/p_enemy.c:P_CheckMissileRange()
 * Accuracy: Approximation — uses the same distance-to-probability curve but
 * without DOOM's fixed-point arithmetic or monster-specific overrides (Vile,
 * Revenant, Cyberdemon, Spider Mastermind).
 *
 * At point-blank range the enemy almost always attacks. At long range (200+
 * map units after subtracting the 64-unit close range buffer), there is a
 * ~78% chance (200/256) the enemy decides NOT to attack this frame.
 * Melee-only enemies skip this check entirely (they always attack in range).
 */
export function checkMissileRange(enemy, distanceToTarget) {
    // Subtract a close-range buffer so enemies are very aggressive up close
    let adjustedDistance = distanceToTarget - 64;

    // If the enemy has no melee attack, subtract an additional buffer
    // (they are more eager to fire since they have no fallback)
    if (!enemy.ai.melee) {
        adjustedDistance -= 128;
    }

    // Clamp to [0, 200] — beyond 200, probability of NOT attacking plateaus
    adjustedDistance = Math.max(0, Math.min(200, adjustedDistance));

    // Random 0-255; if random < distance, enemy does NOT attack this tick.
    // Close range: adjustedDistance ≈ 0, so almost always attacks.
    // Far range: adjustedDistance ≈ 200, so ~78% chance of skipping.
    return Math.floor(Math.random() * 256) >= adjustedDistance;
}

// ============================================================================
// Barrel Explosion
// ============================================================================

/**
 * Handles the explosive barrel (thing type 2035) chain-reaction explosion.
 * Deals area-of-effect damage that falls off linearly with distance from the
 * barrel center. Affects all players and nearby shootable things (enemies
 * and other barrels), enabling chain explosions when barrels are clustered.
 *
 * The `attacker` parameter is the entity that triggered this explosion — a
 * Player who shot the barrel, an enemy whose attack hit it, or null for chain
 * reactions originating from another barrel. It is forwarded to damageEnemy so
 * kill attribution and infighting behave correctly: a Player attacker won't
 * trigger infighting on damaged enemies (matching original DOOM where barrels
 * have no "source" monster), while an enemy attacker correctly retargets.
 */
function barrelExplosion(barrel, attacker) {
    // Based on: linuxdoom-1.10/p_map.c:PIT_RadiusAttack()
    // DOOM uses Chebyshev distance (max of abs deltas) minus target radius

    // Damage every player within explosion radius and line of sight
    for (const player of state.players) {
        const playerDX = Math.abs(player.x - barrel.x);
        const playerDY = Math.abs(player.y - barrel.y);
        const playerDist = Math.max(0, Math.max(playerDX, playerDY) - PLAYER_RADIUS);
        if (playerDist < BARREL_EXPLOSION_DAMAGE
            && hasLineOfSight(barrel.x, barrel.y, player.x, player.y)) {
            damagePlayer(player, BARREL_EXPLOSION_DAMAGE - playerDist, attacker);
        }
    }

    // Damage nearby things (enemies and other barrels) within explosion radius
    const allThings = state.things;
    for (let index = 0, length = allThings.length; index < length; index++) {
        const thing = allThings[index];
        if (thing === barrel || thing.collected) continue;
        if (!SHOOTABLE.has(thing.type)) continue;

        const dx = Math.abs(thing.x - barrel.x);
        const dy = Math.abs(thing.y - barrel.y);
        const thingRadius = thing.ai ? thing.ai.radius : BARREL_RADIUS;
        const dist = Math.max(0, Math.max(dx, dy) - thingRadius);
        if (dist >= BARREL_EXPLOSION_DAMAGE) continue;

        if (!hasLineOfSight(barrel.x, barrel.y, thing.x, thing.y)) continue;

        damageEnemy(thing, BARREL_EXPLOSION_DAMAGE - dist, attacker);
    }
}

// ============================================================================
// Enemy Damage (central damage handler)
// ============================================================================

/**
 * Applies damage to an enemy or barrel, handling death, pain, sound effects,
 * and infighting retarget logic.
 *
 * The `source` parameter identifies who dealt the damage:
 * - a Player reference — a player fired a weapon, caused a barrel explosion, etc.
 * - an enemy entry object — another enemy's projectile or hitscan hit this target
 * - null — environmental damage or unattributed (no retarget)
 *
 * Infighting retarget logic:
 * Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines ~730-745
 * Accuracy: Exact — same threshold check, same retarget behavior.
 * No same-species check: any enemy type can fight any other (matching original DOOM).
 *
 * When a monster damages another monster, the target retargets to the attacker
 * if its threshold is 0 (not locked onto a current chase target). The threshold
 * is then set to BASETHRESHOLD (~2.86s) to prevent rapid target-switching.
 * Damage from a Player or null source never triggers infighting — barrels have
 * no "source" monster in original DOOM and player attacks don't make monsters
 * fight each other.
 */
export function damageEnemy(target, damage, source) {
    target.hp -= damage;

    // Find the thing's index for renderer calls
    const thingIndex = state.things.indexOf(target);

    if (target.hp <= 0) {
        // Target killed. DOOM's extreme-death rule: a hit that pushes
        // HP below -spawnhealth gibs the body (rocket / BFG overkill).
        // killEnemy ignores `gib` for types whose SPRITE_LAYOUT has no
        // xdeath row (Demon, Spectre, Baron, Barrel), so it's safe to
        // always compute and pass. Persist on the thing so catchup
        // can re-emit the right death variant to late joiners.
        const gib = target.hp <= -target.maxHp;
        target.collected = true;
        target.gibbed = gib;
        renderer.killEnemy(thingIndex, target.type, false, gib);
        recordKill(target);

        if (target.type === 2035) {
            orchestrator.playSound('DSBAREXP', { x: target.x, y: target.y });
            barrelExplosion(target, source);
        } else {
            orchestrator.playSound('DSPODTH1', { x: target.x, y: target.y });
            // Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
            // Nightmare: enemies respawn 12 seconds after death
            if (state.skillLevel === 5 && target.ai) {
                target.respawnTimer = 12;
            }
            // Based on: linuxdoom-1.10/p_enemy.c:A_BossDeath()
            // E1M8: when all Barons (type 3003) are dead, lower tag 666 sector floor
            if (target.type === 3003 && currentMap === 'E1M8') {
                checkBossDeath(target);
            }
        }
    } else {
        // Target survived — play pain sound (barrels have no pain sound)
        if (target.type !== 2035) {
            orchestrator.playSound('DSPOPAIN', { x: target.x, y: target.y });
        }

        if (target.ai) {
            // Pain chance check: each enemy type has a probability of entering
            // the pain state when damaged (0-255 scale, checked against P_Random).
            // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines ~680-685
            // Accuracy: Exact — same painchance threshold check.
            if (Math.floor(Math.random() * 256) < target.ai.painChance) {
                setEnemyState(thingIndex, target, 'pain');
            }

            // Retarget on damage: any non-self attacker of a different type
            // becomes the new chase target if the lock threshold has cooled.
            // Covers both infighting (enemy hit by another enemy of a
            // different type — preserves the "monsters in-fight" feature)
            // and the player "fight back" case (enemy hit by a player turns
            // on that player).
            //
            // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj() lines ~770-790
            // Accuracy: Exact — DOOM sets target->target = source for any
            // attacker of a different type once threshold expires, with no
            // special-case for player sources. The prior code excluded
            // Player sources entirely, which let a player shoot a chasing
            // enemy in the back without ever drawing aggro — also masked
            // AI-targeting issues for mid-match joiners whose arrival
            // never disturbs already-locked enemies.
            if (source && source !== target && target.ai.threshold <= 0
                && (source instanceof Player || source.type !== target.type)) {
                target.ai.target = source;
                target.ai.threshold = INFIGHTING_THRESHOLD;
            }
        }
    }
}

// ============================================================================
// E1M8 Boss Death Trigger
// ============================================================================

/**
 * Checks if all Barons of Hell are dead. If so, lowers the tag 666 sector
 * floor to open the exit on E1M8.
 */
function checkBossDeath(lastBaron) {
    const allThings = state.things;
    for (let i = 0, len = allThings.length; i < len; i++) {
        if (allThings[i].type === 3003 && !allThings[i].collected) return;
    }
    // Game-side: mutate mapData so physics sees the new floor height.
    // Renderer-side: fan a per-sector setFloorHeight to animate the
    // visual drop. Each renderer's impl is paint-only.
    const updates = lowerFloorsWithTag(666);
    for (const u of updates) renderer.setFloorHeight(u.sectorIndex, u.height);
    // Source position: the dying boss is in the arena where the floor
    // lowers (E1M8 layout puts them in the same room). Good enough proxy
    // without needing to look up the tag-666 sector center.
    orchestrator.playSound('DSPSTART', { x: lastBaron.x, y: lastBaron.y });
}
