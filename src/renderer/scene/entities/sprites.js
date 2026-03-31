/**
 * Sprite rendering — DOM updates for enemy/thing sprite state, position, and rotation.
 *
 * Owns all sprite sheet knowledge: layout tables, rotation-to-frame mapping,
 * attack/death/walk state transitions. Game code provides direction and state
 * changes via thing index; this module looks up DOM elements from sceneState
 * and translates game state into CSS custom property updates.
 */

import { dom, sceneState } from '../../dom.js';
import { state as gameState } from '../../../game/state.js';

// ============================================================================
// Sprite Sheet Layout
// ============================================================================

// Combined sprite sheet layout: walk rows (0-4), attack row (5), death row (6)
// Maps thing type → { atkRow, atkFrames, dieRow, dieFrames, walkFrames }
const SPRITE_LAYOUT = {
    3004: { atkRow: 5, atkFrames: 2, dieRow: 6, dieFrames: 5, walkFrames: 2 }, // Zombieman
    9:    { atkRow: 5, atkFrames: 2, dieRow: 6, dieFrames: 5, walkFrames: 2 }, // Shotgun Guy
    3001: { atkRow: 5, atkFrames: 3, dieRow: 6, dieFrames: 5, walkFrames: 2 }, // Imp
    3002: { atkRow: 5, atkFrames: 3, dieRow: 6, dieFrames: 6, walkFrames: 2 }, // Demon
    58:   { atkRow: 5, atkFrames: 3, dieRow: 6, dieFrames: 6, walkFrames: 2 }, // Spectre (same as Demon)
    3003: { atkRow: 5, atkFrames: 3, dieRow: 6, dieFrames: 7, walkFrames: 2 }, // Baron
    2035: { atkRow: -1, atkFrames: 0, dieRow: 1, dieFrames: 5, walkFrames: 2 }, // Barrel
};

// ============================================================================
// Low-level helpers (internal)
// ============================================================================

function setSpriteFrame(sprite, heading, frames, mirror) {
    if (heading !== undefined) sprite.style.setProperty('--heading', heading);
    if (frames !== undefined) sprite.style.setProperty('--frames', frames);
    if (mirror !== undefined) sprite.style.setProperty('--mirror', mirror);
}

function setSpriteState(sprite, newState) {
    if (newState) {
        sprite.dataset.state = newState;
    } else {
        delete sprite.dataset.state;
    }
}

// ============================================================================
// Enemy sprite — high-level API called by game code via thing index
// ============================================================================

/**
 * Updates the sprite visuals for an enemy AI state change. Game code calls
 * this after updating the AI state; the renderer maps the state to the
 * correct sprite sheet row, frame count, and animation mode.
 */
export function setEnemyState(thingIndex, thingType, newState) {
    const domData = sceneState.thingDom.get(thingIndex);
    if (!domData?.sprite) return;
    const layout = SPRITE_LAYOUT[thingType];

    if (newState === 'attacking') {
        setSpriteState(domData.sprite, 'attacking');
        setSpriteFrame(domData.sprite, layout.atkRow, layout.atkFrames, 1);
    } else if (newState !== 'dead') {
        setSpriteState(domData.sprite, null);
        setSpriteFrame(domData.sprite, undefined, layout.walkFrames);
    }
}

/**
 * Triggers the death animation on an enemy's sprite and marks its container
 * as dead. Called when an enemy or barrel is killed.
 */
export function killEnemy(thingIndex, thingType) {
    const domData = sceneState.thingDom.get(thingIndex);
    if (!domData) return;
    domData.element.classList.add('dead');
    if (!domData.sprite) return;
    const layout = SPRITE_LAYOUT[thingType];
    domData.sprite.style.animationDelay = '';
    setSpriteFrame(domData.sprite, layout.dieRow, layout.dieFrames, 1);
    setSpriteState(domData.sprite, 'dead');
}

/**
 * Computes the DOOM sprite rotation frame (1-8) based on the viewing angle
 * from the player to the enemy relative to the enemy's facing direction,
 * and updates the sprite sheet row and mirror accordingly.
 *
 * DOOM sprites have 8 rotation angles. The sprite sheet has 5 rows (1-5).
 * Rotations 6-8 reuse rows 3-1 with horizontal mirroring.
 */
export function updateEnemyRotation(thingIndex, enemy) {
    const domData = sceneState.thingDom.get(thingIndex);
    if (!domData?.sprite) return;
    // Skip rotation updates for attack/death states (they use front-facing only)
    if (domData.sprite.dataset.state) return;

    const angleToPlayer = Math.atan2(
        gameState.playerY - enemy.y,
        gameState.playerX - enemy.x
    );

    let relativeAngle = angleToPlayer - enemy.facing;
    relativeAngle = ((relativeAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    const rotationIndex = (Math.floor((relativeAngle + Math.PI / 8) / (Math.PI / 4)) % 8) + 1;

    let sheetRow, mirrorScale;
    if (rotationIndex <= 5) {
        sheetRow = rotationIndex - 1;
        mirrorScale = 1;
    } else {
        sheetRow = 9 - rotationIndex;
        mirrorScale = -1;
    }

    // Cache on domData to avoid redundant CSS updates
    if (domData._lastHeading !== sheetRow || domData._lastMirror !== mirrorScale) {
        domData._lastHeading = sheetRow;
        domData._lastMirror = mirrorScale;
        setSpriteFrame(domData.sprite, sheetRow, undefined, mirrorScale);
    }
}

/** Resets sprite visuals and position for enemy respawn. */
export function resetEnemy(thingIndex, thingType, x, y, floorHeight) {
    const domData = sceneState.thingDom.get(thingIndex);
    if (!domData) return;
    const layout = SPRITE_LAYOUT[thingType];
    domData.element.classList.remove('dead');
    if (domData.sprite) {
        delete domData.sprite.dataset.state;
        if (layout?.walkFrames !== undefined) {
            domData.sprite.style.setProperty('--frames', layout.walkFrames);
        }
    }
    domData.element.style.setProperty('--x', x);
    domData.element.style.setProperty('--y', y);
    domData.element.style.setProperty('--floor-z', floorHeight);
}

// ============================================================================
// Thing position and lighting
// ============================================================================

/** Update a thing's position and floor height CSS custom properties. */
export function updateThingPosition(thingIndex, x, y, floorHeight) {
    const domData = sceneState.thingDom.get(thingIndex);
    if (!domData) return;
    domData.element.style.setProperty('--x', x);
    domData.element.style.setProperty('--y', y);
    domData.element.style.setProperty('--floor-z', floorHeight);
}

/**
 * Reparent a thing's DOM element to a different sector container using moveBefore().
 * This preserves running CSS animations (walk cycles, light effects) while inheriting
 * the new sector's --light value (including any CSS light animations).
 */
export function reparentThingToSector(thingIndex, sectorIndex) {
    const domData = sceneState.thingDom.get(thingIndex);
    if (!domData) return;
    const target = sceneState.sectorContainers[sectorIndex];
    if (!target || domData.element.parentNode === target) return;
    target.moveBefore(domData.element, null);
}

/** Mark a pickup/thing element as collected (hides it via CSS). */
export function collectItem(thingIndex) {
    const domData = sceneState.thingDom.get(thingIndex);
    if (domData) domData.element.classList.add('collected');
}

/** Spawn a bullet puff element at the given position. Self-removes after animation. */
export function createPuff(x, z, y) {
    const el = document.createElement('div');
    el.className = 'puff';
    el.style.setProperty('--x', x);
    el.style.setProperty('--z', z);
    el.style.setProperty('--y', y);
    dom.scene.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

/** Spawn a fireball explosion element at the given position. Self-removes after animation. */
export function createExplosion(x, y, z) {
    const el = document.createElement('div');
    el.className = 'fireball-explosion';
    el.style.setProperty('--x', x);
    el.style.setProperty('--z', z);
    el.style.setProperty('--y', y);
    dom.scene.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

/** Spawn a teleport fog sprite at the given world position. Self-removes after animation. */
export function createTeleportFog(x, z, y) {
    const el = document.createElement('div');
    el.className = 'teleport-fog';
    el.style.setProperty('--x', x);
    el.style.setProperty('--z', z);
    el.style.setProperty('--y', y);
    dom.scene.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

/**
 * Create a projectile DOM element, append it to the scene, and store it
 * in sceneState.projectileDom keyed by the given ID.
 */
const PROJECTILE_CLASS = {
    'enemy':         'projectile',
    'player-rocket': 'projectile player-rocket',
};

export function createProjectile(projectileId, { type, width, height, sprite, startX, startY, startZ, endX, endY, endZ, duration }) {
    const el = document.createElement('div');
    el.className = PROJECTILE_CLASS[type] || 'projectile';
    el.style.width = `${width}px`;
    el.style.height = `${height}px`;
    el.style.backgroundImage = `url('/assets/sprites/${sprite}.png')`;
    el.style.backgroundSize = `${width}px ${height}px`;
    el.style.setProperty('--start-x', startX);
    el.style.setProperty('--start-y', startY);
    el.style.setProperty('--start-z', startZ);
    el.style.setProperty('--end-x', endX);
    el.style.setProperty('--end-y', endY);
    el.style.setProperty('--end-z', endZ);
    el.style.setProperty('--duration', `${duration}s`);
    dom.scene.appendChild(el);
    sceneState.projectileDom.set(projectileId, el);
}

/** Remove a projectile's DOM element by its ID. */
export function removeProjectile(projectileId) {
    const el = sceneState.projectileDom.get(projectileId);
    if (el) {
        el.remove();
        sceneState.projectileDom.delete(projectileId);
    }
}
