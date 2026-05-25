/**
 * Enemies — AI state management and respawn logic.
 *
 * Pure game logic — no DOM, CSS, or sprite knowledge. Visual updates are
 * delegated to renderer/entities/sprites.js which owns all sprite sheet
 * layout, rotation-to-frame mapping, and animation state.
 */

import { state } from '../state.js';
import { getFloorHeightAt } from '../physics.js';
import { findVisibleTargetForEnemy } from './ai.js';
import * as renderer from '../../renderer/dom/index.js';

// ============================================================================
// Enemy State Management
// ============================================================================

/**
 * Transitions an enemy to a new AI state. Resets the state timer and the
 * per-attack damage-dealt flag, then notifies the renderer to update the
 * sprite visuals for the new state.
 *
 * @param {number} thingIndex - Index into state.things
 * @param {object} enemy - The enemy game object
 * @param {string} newState - New AI state name
 */
export function setEnemyState(thingIndex, enemy, newState) {
    enemy.ai.state = newState;
    enemy.ai.stateTime = 0;
    enemy.ai.damageDealt = false;
    renderer.setEnemyState(thingIndex, enemy.type, newState);
}

// ============================================================================
// Respawn
// ============================================================================

/**
 * Respawns a dead enemy at its original spawn position with full health.
 * Based on: linuxdoom-1.10/p_mobj.c:P_NightmareRespawn()
 *
 * @param {number} thingIndex - Index into state.things
 * @param {object} enemy - The enemy game object
 */
export function respawnEnemy(thingIndex, enemy) {
    enemy.collected = false;
    enemy.hp = enemy.maxHp;
    enemy.x = enemy.spawnX;
    enemy.y = enemy.spawnY;
    delete enemy.respawnTimer;

    // Reset AI state
    enemy.ai.state = 'idle';
    enemy.ai.stateTime = 0;
    enemy.ai.target = findVisibleTargetForEnemy(enemy);
    enemy.ai.threshold = 0;
    enemy.ai.reactionTimer = 0;
    enemy.ai.damageDealt = false;

    // Reset visuals via renderer
    const floorHeight = getFloorHeightAt(enemy.x, enemy.y);
    renderer.resetEnemy(thingIndex, enemy.type, enemy.x, enemy.y, floorHeight);
}
