/**
 * Sprite rendering — DOM updates for enemy/thing sprite state, position, and rotation.
 *
 * Owns all sprite sheet knowledge: layout tables, rotation-to-frame mapping,
 * attack/death/walk state transitions. Game code provides direction and state
 * changes via thing index; this module looks up DOM elements from sceneStates
 * and translates game state into CSS custom property updates.
 *
 * Per-player: every pane has its own scene tree with duplicated thing DOM.
 * World-state changes (state, death, position, sector reparent, collected,
 * spawn/remove of puffs/explosions/projectiles) fan out internally to every
 * pane in sceneStates. Enemy billboard rotation is computed per-pane against
 * that pane's player so each pane sees the enemy facing its viewer correctly.
 */

import { dom, sceneStates } from '../../dom.js';

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
    [-1]: { atkRow: 5, atkFrames: 2, dieRow: 6, dieFrames: 7, walkFrames: 4 }, // Player (kind:'player', type:-1)
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
 * correct sprite sheet row, frame count, and animation mode in every pane.
 */
export function setEnemyState(thingIndex, thingType, newState) {
    const layout = SPRITE_LAYOUT[thingType];
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (!domData?.sprite) continue;

        if (newState === 'attacking') {
            setSpriteState(domData.sprite, 'attacking');
            setSpriteFrame(domData.sprite, layout.atkRow, layout.atkFrames, 1);
        } else if (newState !== 'dead') {
            setSpriteState(domData.sprite, null);
            setSpriteFrame(domData.sprite, undefined, layout.walkFrames);
        }
    }
}

/**
 * Triggers the death animation on an enemy's sprite and marks its container
 * as dead in every pane. Called when an enemy or barrel is killed.
 */
export function killEnemy(thingIndex, thingType) {
    const layout = SPRITE_LAYOUT[thingType];
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (!domData) continue;
        domData.element.classList.add('dead');
        if (!domData.sprite) continue;
        domData.sprite.style.animationDelay = '';
        setSpriteFrame(domData.sprite, layout.dieRow, layout.dieFrames, 1);
        setSpriteState(domData.sprite, 'dead');
    }
}

// Player attack animation — when this player fires their weapon, the
// opposing player's view briefly sees them in the attack pose. Layout
// row 5 holds two front-facing frames (PLAY E1/F1).
const PLAYER_ATTACK_DURATION_MS = 600;
const playerAttackTimers = new Map(); // thingIndex → timeout handle

export function playPlayerAttack(thingIndex) {
    const layout = SPRITE_LAYOUT[-1];
    if (!layout) return;
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (!domData?.sprite) continue;
        setSpriteFrame(domData.sprite, layout.atkRow, layout.atkFrames, 1);
        setSpriteState(domData.sprite, 'attacking');
    }
    const prev = playerAttackTimers.get(thingIndex);
    if (prev) clearTimeout(prev);
    playerAttackTimers.set(thingIndex, setTimeout(() => {
        // Return to walk cycle. Clear the rotation-cache fields so the
        // next updateEnemyRotation tick rewrites --heading: without this,
        // the sprite would stay on row 5 (attack) and the walk cycle
        // would animate through PLAYE, PLAYF, blank, blank — visible as
        // a flicker / "disappearing" sprite.
        for (const sState of sceneStates) {
            const domData = sState.thingDom.get(thingIndex);
            if (!domData?.sprite) continue;
            // Don't override the dead state (player died mid-attack-anim).
            if (domData.sprite.dataset.state === 'dead') continue;
            setSpriteState(domData.sprite, null);
            setSpriteFrame(domData.sprite, undefined, layout.walkFrames);
            domData._lastHeading = undefined;
            domData._lastMirror = undefined;
        }
        playerAttackTimers.delete(thingIndex);
    }, PLAYER_ATTACK_DURATION_MS));
}

/**
 * Computes the DOOM sprite rotation frame (1-8) based on the viewing angle
 * from each viewer to the enemy relative to the enemy's facing direction,
 * and updates each pane's sprite sheet row and mirror.
 *
 * DOOM sprites have 8 rotation angles. The sprite sheet has 5 rows (1-5).
 * Rotations 6-8 reuse rows 3-1 with horizontal mirroring.
 *
 * Each pane gets its own rotation calc — the imp facing player 1 in the left
 * pane simultaneously faces player 2 in the right pane via different sprite
 * frames. The per-pane domData carries its own _lastHeading / _lastMirror
 * cache so unchanged rotations skip CSS writes.
 *
 * `viewers` is an iterable of objects with `{ x, y, viewportIndex }` —
 * typically state.players, but kept as a plain-data parameter so this module
 * stays game-state-free.
 */
export function updateEnemyRotation(thingIndex, enemy, viewers) {
    for (const player of viewers) {
        const sState = sceneStates[player.viewportIndex];
        const domData = sState.thingDom.get(thingIndex);
        if (!domData?.sprite) continue;
        // Skip rotation updates for attack/death states (front-facing only)
        if (domData.sprite.dataset.state) continue;

        const angleToPlayer = Math.atan2(
            player.y - enemy.y,
            player.x - enemy.x,
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

        // Cache on domData to avoid redundant CSS updates (per-pane)
        if (domData._lastHeading !== sheetRow || domData._lastMirror !== mirrorScale) {
            domData._lastHeading = sheetRow;
            domData._lastMirror = mirrorScale;
            setSpriteFrame(domData.sprite, sheetRow, undefined, mirrorScale);
        }
    }
}

/** Resets sprite visuals and position for enemy respawn in every pane. */
export function resetEnemy(thingIndex, thingType, x, y, floorHeight) {
    const layout = SPRITE_LAYOUT[thingType];
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (!domData) continue;
        domData.element.classList.remove('dead');
        if (domData.sprite) {
            delete domData.sprite.dataset.state;
            if (layout?.walkFrames !== undefined) {
                domData.sprite.style.setProperty('--frames', layout.walkFrames);
            }
        }
        // Force the next updateEnemyRotation tick to rewrite --heading:
        // killEnemy left it on the death row (6), which would otherwise
        // stick if the post-respawn rotation matches the cached value.
        domData._lastHeading = undefined;
        domData._lastMirror = undefined;
        domData.element.style.setProperty('--x', x);
        domData.element.style.setProperty('--y', y);
        domData.element.style.setProperty('--floor-z', floorHeight);
    }
}

// ============================================================================
// Thing position and lighting
// ============================================================================

/** Update a thing's position and floor height in every pane. */
export function updateThingPosition(thingIndex, x, y, floorHeight) {
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (!domData) continue;
        domData.element.style.setProperty('--x', x);
        domData.element.style.setProperty('--y', y);
        domData.element.style.setProperty('--floor-z', floorHeight);
    }
}

/**
 * Reparent a thing's DOM element to a different sector container in every pane,
 * using moveBefore() to preserve running CSS animations (walk cycles, light
 * effects) while inheriting the new sector's --light value (including any CSS
 * light animations). Falls back to appendChild() in browsers that don't
 * support moveBefore (e.g. Safari).
 */
export function reparentThingToSector(thingIndex, sectorIndex) {
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (!domData) continue;
        const target = sState.sectorContainers[sectorIndex];
        if (!target || domData.element.parentNode === target) continue;
        if (target.moveBefore) {
            target.moveBefore(domData.element, null);
        } else {
            target.appendChild(domData.element);
        }
    }
}

/** Mark a pickup/thing element as collected in every pane (hides it via CSS). */
export function collectItem(thingIndex) {
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (domData) domData.element.classList.add('collected');
    }
}

/** Reverse of collectItem — removes the .collected class so the sprite
 *  re-appears. Used when a player respawns. */
export function uncollectItem(thingIndex) {
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (domData) domData.element.classList.remove('collected');
    }
}

/**
 * Toggles the `.moving` class on a thing's container in every pane. Used by
 * movement.js to pause/resume player billboard sprite walk-cycle animation
 * across panes when the represented player starts/stops moving.
 */
export function setThingMoving(thingIndex, moving) {
    for (const sState of sceneStates) {
        const domData = sState.thingDom.get(thingIndex);
        if (domData?.element) {
            domData.element.classList.toggle('moving', moving);
        }
    }
}

/** Spawn a bullet puff in every pane. Each copy self-removes after its animation. */
export function createPuff(x, z, y) {
    for (const scene of dom.scenes) {
        const el = document.createElement('div');
        el.className = 'puff';
        el.style.setProperty('--x', x);
        el.style.setProperty('--z', z);
        el.style.setProperty('--y', y);
        scene.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
    }
}

/** Spawn a fireball explosion in every pane. Each copy self-removes after its animation. */
export function createExplosion(x, y, z) {
    for (const scene of dom.scenes) {
        const el = document.createElement('div');
        el.className = 'fireball-explosion';
        el.style.setProperty('--x', x);
        el.style.setProperty('--z', z);
        el.style.setProperty('--y', y);
        scene.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
    }
}

/** Spawn a teleport fog sprite in every pane. Each copy self-removes after its animation. */
export function createTeleportFog(x, z, y) {
    for (const scene of dom.scenes) {
        const el = document.createElement('div');
        el.className = 'teleport-fog';
        el.style.setProperty('--x', x);
        el.style.setProperty('--z', z);
        el.style.setProperty('--y', y);
        scene.appendChild(el);
        el.addEventListener('animationend', () => el.remove());
    }
}

/**
 * Create a projectile DOM element in every pane and store the per-pane
 * elements in each scene state's projectileDom keyed by the given ID.
 */
const PROJECTILE_CLASS = {
    'enemy':         'projectile',
    'player-rocket': 'projectile player-rocket',
};

export function createProjectile(projectileId, { type, width, height, sprite, startX, startY, startZ, endX, endY, endZ, duration }) {
    for (let i = 0; i < dom.scenes.length; i++) {
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
        dom.scenes[i].appendChild(el);
        sceneStates[i].projectileDom.set(projectileId, el);
    }
}

/**
 * Creates a player billboard sprite for the given player thing in every
 * pane's scene tree, registers in each pane's sceneStates[i].thingDom keyed
 * by thingIndex. Each pane sees the sprite from its viewer's perspective via
 * updateEnemyRotation. CSS hides each player's own sprite in their own pane
 * (.pane[data-player="N"] .enemy.player[data-player-index="N"] { display:none }).
 */
export function createPlayerSprite(thingIndex, playerIndex, x, y, floorHeight, sectorIndex) {
    for (let i = 0; i < sceneStates.length; i++) {
        const sState = sceneStates[i];
        const sceneEl = dom.scenes[i];
        if (!sceneEl) continue;

        const container = document.createElement('div');
        container.className = 'enemy player';
        container.dataset.playerIndex = String(playerIndex);
        container.style.setProperty('--x', x);
        container.style.setProperty('--y', y);
        container.style.setProperty('--floor-z', floorHeight);

        const sprite = document.createElement('div');
        sprite.className = 'sprite';
        sprite.dataset.type = 'player';
        container.appendChild(sprite);

        const sectorContainer = sectorIndex !== undefined && sectorIndex !== null
            ? sState.sectorContainers[sectorIndex]
            : null;
        if (sectorContainer) {
            sectorContainer.appendChild(container);
        } else {
            sceneEl.appendChild(container);
        }

        sState.thingDom.set(thingIndex, { element: container, sprite });
        sState.thingContainers.push({ element: container, x, y, sectorIndex, gameId: thingIndex });
    }
}

// Map player index → corpse sprite suffix. Mirror the DM color choice in
// enemies.css: P0 = green default (no suffix), P1 = red.
const PLAYER_CORPSE_VARIANT = ['', '-red'];

/**
 * Spawns a player corpse at the given position in every pane's scene tree.
 * Static decoration (single PLAYN0 sprite, billboarded to face the viewer)
 * — doesn't enter state.things, has no game-state interaction. Persists
 * for the rest of the match; cleared on next teardownScene().
 *
 * `playerIndex` selects the recolored variant so a red player drops a red
 * corpse instead of reverting to the default green sprite.
 */
export function createCorpse(x, y, floorHeight, sectorIndex, playerIndex = 0) {
    const variant = PLAYER_CORPSE_VARIANT[playerIndex] ?? '';
    for (let i = 0; i < sceneStates.length; i++) {
        const sState = sceneStates[i];
        const sceneEl = dom.scenes[i];
        if (!sceneEl) continue;

        const container = document.createElement('div');
        container.className = 'decoration corpse';
        container.style.setProperty('--x', x);
        container.style.setProperty('--y', y);
        container.style.setProperty('--floor-z', floorHeight);

        const img = document.createElement('img');
        img.src = `/assets/sprites/PLAYN0${variant}.png`;
        img.draggable = false;
        container.appendChild(img);

        const sectorContainer = sectorIndex !== undefined && sectorIndex !== null
            ? sState.sectorContainers[sectorIndex]
            : null;
        if (sectorContainer) {
            sectorContainer.appendChild(container);
        } else {
            sceneEl.appendChild(container);
        }
    }
}

/** Remove a projectile's DOM element from every pane by its ID. */
export function removeProjectile(projectileId) {
    for (const sState of sceneStates) {
        const el = sState.projectileDom.get(projectileId);
        if (el) {
            el.remove();
            sState.projectileDom.delete(projectileId);
        }
    }
}
