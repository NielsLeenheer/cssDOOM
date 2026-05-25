/**
 * Sprite rendering — DOM updates for enemy/thing sprite state, position, and rotation.
 *
 * Owns all sprite sheet knowledge: layout tables, rotation-to-frame mapping,
 * attack/death/walk state transitions. Each impl takes a renderer instance
 * and operates on `renderer.sceneState` / `renderer.sceneEl`. The orchestrator's
 * world dispatch fans every command to every render target so each renderer
 * updates its own per-pane DOM independently.
 *
 * Impls that update thing position / collected state also write to
 * `renderer.state.things[]` (the per-renderer world-view used by the
 * culler). See dom-renderer.js's `makeRendererState` / `ensureThing`.
 *
 * Enemy rotation picks its viewer via `viewers[renderer.playerIndex]` — in
 * mirror SP both renderers share playerIndex 0 and compute against player 0;
 * in DM each renderer reads its own player.
 */

import { ensureThing } from '../../dom-renderer.js';

// ============================================================================
// Sprite Sheet Layout
// ============================================================================

// Combined sprite sheet layout per thing type. See enemies.css for the
// row plan; the runtime needs to know per-state row indices + frame
// counts to drive --heading and --frames on the .sprite element.
//
//   walkRowBase  = first row of the walk rotations (rotations 1..5 fill
//                  walkRowBase..walkRowBase+4); always 0.
//   atkRowBase   = first row of the attack rotations; -1 if the type has
//                  no attack state (barrel).
//   walkFrames / atkFrames = frame count per row for animation cycles.
//   dieRow       = single front-only death row.
//   xdieRow      = single front-only gib/xdeath row; -1 if the type has
//                  no extreme death (SARG/Spectre/Baron/Barrel).
//
// Barrel keeps the legacy two-row layout (idle + explode) — it never had
// rotations or attack frames.
const SPRITE_LAYOUT = {
    3004: { atkRowBase: 5, atkFrames: 2, dieRow: 10, dieFrames: 5, xdieRow: 11, xdieFrames: 7, walkFrames: 2 }, // Zombieman
    9:    { atkRowBase: 5, atkFrames: 2, dieRow: 10, dieFrames: 5, xdieRow: 11, xdieFrames: 7, walkFrames: 2 }, // Shotgun Guy
    3001: { atkRowBase: 5, atkFrames: 3, dieRow: 10, dieFrames: 5, xdieRow: 11, xdieFrames: 7, walkFrames: 2 }, // Imp
    3002: { atkRowBase: 5, atkFrames: 3, dieRow: 10, dieFrames: 6, xdieRow: -1, xdieFrames: 0, walkFrames: 2 }, // Demon — no gib
    58:   { atkRowBase: 5, atkFrames: 3, dieRow: 10, dieFrames: 6, xdieRow: -1, xdieFrames: 0, walkFrames: 2 }, // Spectre — no gib
    3003: { atkRowBase: 5, atkFrames: 3, dieRow: 10, dieFrames: 7, xdieRow: -1, xdieFrames: 0, walkFrames: 2 }, // Baron — no gib (canonical DOOM)
    2035: { atkRowBase: -1, atkFrames: 0, dieRow: 1, dieFrames: 5, xdieRow: -1, xdieFrames: 0, walkFrames: 2 }, // Barrel (2-row sheet, dieRow=1)
    [-1]: { atkRowBase: 5, atkFrames: 2, dieRow: 10, dieFrames: 7, xdieRow: 11, xdieFrames: 9, walkFrames: 4 }, // Player (kind:'player', type:-1)
};

/**
 * Pick the sprite-sheet row + mirror scale for a given DOOM rotation index
 * (1..8). Rotations 1..5 map to rows base..base+4 at scale 1; 6..8 reuse
 * rows base+3..base+1 mirrored via scaleX(-1). Used by both walk and
 * attack rotation handling.
 */
function rotationToHeading(rotationIndex, rowBase) {
    if (rotationIndex <= 5) {
        return { sheetRow: rowBase + rotationIndex - 1, mirror: 1 };
    }
    return { sheetRow: rowBase + (9 - rotationIndex), mirror: -1 };
}

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
 * Updates the sprite visuals for an enemy AI state change. Maps the state
 * to the correct sprite sheet row range, frame count, and animation mode
 * in this renderer's pane. `attacking` enters the attack rotation block;
 * the next updateEnemyRotation tick refreshes --heading against the new
 * row base so the attack pose tracks the viewer angle, same as walk.
 * Reset to walk frames on any other non-dead state.
 */
export function setEnemyState(renderer, thingIndex, thingType, newState) {
    const layout = SPRITE_LAYOUT[thingType];
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (!domData?.sprite) return;

    if (newState === 'attacking') {
        setSpriteState(domData.sprite, 'attacking');
        setSpriteFrame(domData.sprite, undefined, layout.atkFrames, undefined);
        // Force the next updateEnemyRotation tick to recompute --heading
        // against the new rowBase (atkRowBase instead of 0). Without
        // this the cached previous walk row would persist for a frame.
        domData._lastHeading = undefined;
        domData._lastMirror = undefined;
    } else if (newState !== 'dead') {
        setSpriteState(domData.sprite, null);
        setSpriteFrame(domData.sprite, undefined, layout.walkFrames);
        domData._lastHeading = undefined;
        domData._lastMirror = undefined;
    }
}

/**
 * Triggers the death animation on an enemy's sprite and marks its container
 * as dead in this renderer's pane. Pass `instant: true` to skip the animation
 * and pin the sprite at the final frame — used by the world-snapshot apply
 * path so enemies that died before a joiner connected don't re-play their
 * death animation when culled in. Works because `forwards` fill + an
 * animation-delay past the duration leaves the sprite on its end keyframe,
 * surviving the cull system's display:none → block flips.
 */
export function killEnemy(renderer, thingIndex, thingType, instant = false, gib = false) {
    // Per-renderer world-view state — match what the mirror does on
    // the singleton. `collected` is the catch-all "skip this thing"
    // flag the culler reads (pickups + dead things alike). Set
    // unconditionally so the per-instance state matches the mirror
    // even if the DOM hasn't been built for this thing yet on this
    // renderer.
    ensureThing(renderer.state, thingIndex).collected = true;

    const layout = SPRITE_LAYOUT[thingType];
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (!domData) return;
    domData.element.classList.add('dead');
    if (!domData.sprite) return;
    domData.sprite.style.animationDelay = instant ? '-10s' : '';
    // Pick the xdeath row if this type has one AND the caller asked
    // for it; otherwise fall back to the normal death row. Baron and
    // Demon have no gib in DOOM, so even a rocket leaves the normal
    // corpse — preserve that authenticity rather than synthesizing
    // a gib for them.
    const useGib = gib && layout.xdieRow >= 0;
    const row = useGib ? layout.xdieRow : layout.dieRow;
    const frames = useGib ? layout.xdieFrames : layout.dieFrames;
    setSpriteFrame(domData.sprite, row, frames, 1);
    setSpriteState(domData.sprite, useGib ? 'gibbing' : 'dead');
}

// Player attack animation — when this player fires their weapon, the
// opposing player's view briefly sees them in the attack pose. Layout
// row 5 holds two front-facing frames (PLAY E1/F1). The timer key is
// per-renderer + per-thing because a player attack on master and on a
// client run independently.
const PLAYER_ATTACK_DURATION_MS = 600;

// The attack frames are front-only, so playing them when the viewer
// isn't roughly in front of the shooter makes the shooter look like
// they're aiming at the viewer regardless of where they're actually
// pointing. Only swap to the attack pose when the viewer falls inside
// the shooter's front bucket of the 8-way rotation table — same
// bucketing as updateEnemyRotation so the threshold matches the walk
// sprite's front view (±22.5°).
export function playPlayerAttack(renderer, thingIndex, shooter) {
    const layout = SPRITE_LAYOUT[-1];
    if (!layout) return;
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (!domData?.sprite) return;

    // Switch to attack frame count + clear rotation cache so the very
    // next updateEnemyRotation tick rewrites --heading against the
    // attack row base. No more "front-bucket only" gate — we ship all
    // 5 attack rotations now, so the shooter looks correct from every
    // viewer angle.
    setSpriteFrame(domData.sprite, undefined, layout.atkFrames, undefined);
    setSpriteState(domData.sprite, 'attacking');
    domData._lastHeading = undefined;
    domData._lastMirror = undefined;

    let timers = renderer._playerAttackTimers;
    if (!timers) {
        timers = new Map();
        renderer._playerAttackTimers = timers;
    }
    const prev = timers.get(thingIndex);
    if (prev) clearTimeout(prev);
    timers.set(thingIndex, setTimeout(() => {
        // Return to walk cycle. Clear the rotation-cache fields so the
        // next updateEnemyRotation tick rewrites --heading: without this
        // the sprite would stay on its current attack row and the walk
        // cycle would animate through PLAYE, PLAYF, blank, blank —
        // visible as a flicker / "disappearing" sprite.
        const after = renderer.sceneState.thingDom.get(thingIndex);
        if (!after?.sprite) return;
        // Don't override the dead state (player died mid-attack-anim).
        if (after.sprite.dataset.state === 'dead'
            || after.sprite.dataset.state === 'gibbing') return;
        setSpriteState(after.sprite, null);
        setSpriteFrame(after.sprite, undefined, layout.walkFrames);
        after._lastHeading = undefined;
        after._lastMirror = undefined;
        timers.delete(thingIndex);
    }, PLAYER_ATTACK_DURATION_MS));
}

/**
 * Computes the DOOM sprite rotation frame (1-8) based on the viewing angle
 * from this renderer's viewer to the enemy relative to the enemy's facing
 * direction, and updates the sprite sheet row and mirror.
 *
 * `viewers` is the full array of state.players (same for every renderer);
 * each renderer picks `viewers[renderer.playerIndex]` — mirror SP has both
 * renderers at playerIndex 0 so they both compute against player 0; DM each
 * renderer reads its own player.
 */
export function updateEnemyRotation(renderer, thingIndex, enemy, viewers) {
    const player = viewers[renderer.playerIndex] ?? viewers[0];
    if (!player) return;
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (!domData?.sprite) return;
    // Death and gib are single front-only rows — no rotation tracking
    // (the corpse / gib pile doesn't pivot as the viewer walks around).
    const spriteState = domData.sprite.dataset.state;
    if (spriteState === 'dead' || spriteState === 'gibbing') return;

    // Choose the row-block base for the current state. Walk uses rows
    // 0..4; attack uses rows atkRowBase..atkRowBase+4 (both rotation
    // blocks follow the same mirror scheme for rotations 6..8).
    const layout = SPRITE_LAYOUT[enemy?.type ?? -1] ?? SPRITE_LAYOUT[-1];
    const rowBase = spriteState === 'attacking' ? layout.atkRowBase : 0;
    if (rowBase < 0) return; // no rotation rows configured (barrel)

    const angleToPlayer = Math.atan2(
        player.y - enemy.y,
        player.x - enemy.x,
    );

    let relativeAngle = angleToPlayer - enemy.facing;
    relativeAngle = ((relativeAngle % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);

    const rotationIndex = (Math.floor((relativeAngle + Math.PI / 8) / (Math.PI / 4)) % 8) + 1;
    const { sheetRow, mirror } = rotationToHeading(rotationIndex, rowBase);

    // Cache on domData to avoid redundant CSS updates (per-pane)
    if (domData._lastHeading !== sheetRow || domData._lastMirror !== mirror) {
        domData._lastHeading = sheetRow;
        domData._lastMirror = mirror;
        setSpriteFrame(domData.sprite, sheetRow, undefined, mirror);
    }
}

/** Resets sprite visuals and position for enemy respawn in this renderer's pane. */
export function resetEnemy(renderer, thingIndex, thingType, x, y, floorHeight) {
    const layout = SPRITE_LAYOUT[thingType];
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (!domData) return;
    domData.element.classList.remove('dead');
    if (domData.sprite) {
        delete domData.sprite.dataset.state;
        if (layout?.walkFrames !== undefined) {
            domData.sprite.style.setProperty('--frames', layout.walkFrames);
        }
    }
    // Force the next updateEnemyRotation tick to rewrite --heading:
    // killEnemy left it on the death row, which would otherwise stick
    // if the post-respawn rotation happens to match the cached value.
    domData._lastHeading = undefined;
    domData._lastMirror = undefined;
    domData.element.style.setProperty('--x', x);
    domData.element.style.setProperty('--y', y);
    domData.element.style.setProperty('--floor-z', floorHeight);
}

// ============================================================================
// Thing position and lighting
// ============================================================================

/** Update a thing's position and floor height in this renderer's pane. */
export function updateThingPosition(renderer, thingIndex, x, y, floorHeight) {
    // Per-renderer world-view state (read by the culler). The
    // singleton mirror still fires in parallel during step 1.
    const thing = ensureThing(renderer.state, thingIndex);
    thing.x = x;
    thing.y = y;
    if (floorHeight !== undefined) thing.floorHeight = floorHeight;

    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (!domData) return;
    domData.element.style.setProperty('--x', x);
    domData.element.style.setProperty('--y', y);
    domData.element.style.setProperty('--floor-z', floorHeight);
}

/**
 * Reparent a thing's DOM element to a different sector container in this
 * renderer's pane, using moveBefore() to preserve running CSS animations
 * (walk cycles, light effects) while inheriting the new sector's --light
 * value (including any CSS light animations). Falls back to appendChild()
 * in browsers that don't support moveBefore (e.g. Safari).
 */
export function reparentThingToSector(renderer, thingIndex, sectorIndex) {
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (!domData) return;
    const target = renderer.sceneState.sectorContainers[sectorIndex];
    if (!target || domData.element.parentNode === target) return;
    if (target.moveBefore) {
        target.moveBefore(domData.element, null);
    } else {
        target.appendChild(domData.element);
    }
}

/** Mark a pickup/thing element as collected in this renderer's pane (hides it via CSS). */
export function collectItem(renderer, thingIndex) {
    ensureThing(renderer.state, thingIndex).collected = true;
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (domData) domData.element.classList.add('collected');
}

/** Reverse of collectItem — removes the .collected class so the sprite
 *  re-appears. Used when a player respawns. */
export function uncollectItem(renderer, thingIndex) {
    ensureThing(renderer.state, thingIndex).collected = false;
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (domData) domData.element.classList.remove('collected');
}

/**
 * Toggles the `.moving` class on a thing's container in this renderer's
 * pane. Used by movement.js to pause/resume player billboard sprite
 * walk-cycle animation when the represented player starts/stops moving.
 */
export function setThingMoving(renderer, thingIndex, moving) {
    const domData = renderer.sceneState.thingDom.get(thingIndex);
    if (domData?.element) {
        domData.element.classList.toggle('moving', moving);
    }
}

/** Spawn a bullet puff in this renderer's pane. Self-removes after its animation. */
export function createPuff(renderer, x, z, y) {
    const el = document.createElement('div');
    el.className = 'puff';
    el.style.setProperty('--x', x);
    el.style.setProperty('--z', z);
    el.style.setProperty('--y', y);
    renderer.sceneEl.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

/** Spawn a fireball explosion in this renderer's pane. Self-removes after its animation. */
export function createExplosion(renderer, x, y, z) {
    const el = document.createElement('div');
    el.className = 'fireball-explosion';
    el.style.setProperty('--x', x);
    el.style.setProperty('--z', z);
    el.style.setProperty('--y', y);
    renderer.sceneEl.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

/** Spawn a teleport fog sprite in this renderer's pane. Self-removes after its animation. */
export function createTeleportFog(renderer, x, z, y) {
    const el = document.createElement('div');
    el.className = 'teleport-fog';
    el.style.setProperty('--x', x);
    el.style.setProperty('--z', z);
    el.style.setProperty('--y', y);
    renderer.sceneEl.appendChild(el);
    el.addEventListener('animationend', () => el.remove());
}

/**
 * Create a projectile DOM element in this renderer's pane and store it
 * in the renderer's projectileDom keyed by the given ID.
 */
const PROJECTILE_CLASS = {
    'enemy':         'projectile',
    'player-rocket': 'projectile player-rocket',
};

export function createProjectile(renderer, projectileId, { type, width, height, sprite, startX, startY, startZ, endX, endY, endZ, duration }) {
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
    renderer.sceneEl.appendChild(el);
    renderer.sceneState.projectileDom.set(projectileId, el);
}

/**
 * Creates a player billboard sprite for the given player thing in this
 * renderer's scene tree, registers in `renderer.sceneState.thingDom`
 * keyed by thingIndex. Each renderer sees the sprite from its own viewer
 * via updateEnemyRotation. CSS hides each player's own sprite in their
 * own pane (.pane[data-player="N"] .enemy.player[data-player-index="N"]
 * { display:none }).
 */
export function createPlayerSprite(renderer, thingIndex, playerIndex, x, y, floorHeight, sectorIndex) {
    // Idempotent — calling twice for the same renderer + thingIndex is a
    // no-op. Lets master fan createPlayerSprite to all renderers on every
    // peer-attach / pane-rebuild without worrying about duplicate
    // billboards on renderers that already have the sprite.
    if (renderer.sceneState.thingDom.has(thingIndex)) return;

    // Per-renderer world-view state — establish the thing entry so
    // the culler's first-frame read sees a real position rather than
    // an undefined entry (the singleton mirror does the same).
    const thing = ensureThing(renderer.state, thingIndex);
    thing.x = x;
    thing.y = y;
    thing.floorHeight = floorHeight ?? 0;

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
        ? renderer.sceneState.sectorContainers[sectorIndex]
        : null;
    if (sectorContainer) {
        sectorContainer.appendChild(container);
    } else {
        renderer.sceneEl.appendChild(container);
    }

    renderer.sceneState.thingDom.set(thingIndex, { element: container, sprite });
    renderer.sceneState.thingContainers.push({ element: container, x, y, sectorIndex, gameId: thingIndex });
}

// Map player index → corpse sprite suffix. Mirror the DM color choice in
// enemies.css: P0 = green default (no suffix), P1 = red, P2 = indigo,
// P3 = brown.
const PLAYER_CORPSE_VARIANT = ['', '-red', '-indigo', '-brown'];

/**
 * Spawns a player corpse at the given position in this renderer's scene
 * tree. Static decoration (single PLAYN0 / PLAYW0 sprite, billboarded to
 * face the viewer) — doesn't enter state.things, has no game-state
 * interaction. Persists for the rest of the match; cleared on next
 * renderer.clear().
 *
 * `playerIndex` selects the recolored variant so a red player drops a red
 * corpse instead of reverting to the default green sprite. `gib=true`
 * uses the PLAYW0 (gib pile) sprite instead of PLAYN0 — the visual
 * residue of an extreme/xdeath kill (rocket etc.).
 */
export function createCorpse(renderer, x, y, floorHeight, sectorIndex, playerIndex = 0, gib = false) {
    const variant = PLAYER_CORPSE_VARIANT[playerIndex] ?? '';
    const base = gib ? 'PLAYW0' : 'PLAYN0';
    const container = document.createElement('div');
    container.className = 'decoration corpse';
    container.style.setProperty('--x', x);
    container.style.setProperty('--y', y);
    container.style.setProperty('--floor-z', floorHeight);

    const img = document.createElement('img');
    img.src = `/assets/sprites/${base}${variant}.png`;
    img.draggable = false;
    container.appendChild(img);

    const sectorContainer = sectorIndex !== undefined && sectorIndex !== null
        ? renderer.sceneState.sectorContainers[sectorIndex]
        : null;
    if (sectorContainer) {
        sectorContainer.appendChild(container);
    } else {
        renderer.sceneEl.appendChild(container);
    }
}

/** Remove a projectile's DOM element from this renderer's pane by its ID. */
export function removeProjectile(renderer, projectileId) {
    const el = renderer.sceneState.projectileDom.get(projectileId);
    if (el) {
        el.remove();
        renderer.sceneState.projectileDom.delete(projectileId);
    }
}
