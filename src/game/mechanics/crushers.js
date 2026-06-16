/**
 * Crushers
 *
 * Ceiling crushers that cycle between raised and lowered positions, damaging
 * the player when caught underneath.
 *
 * Based on: linuxdoom-1.10/p_ceilng.c:EV_DoCeiling(), T_MoveCeiling()
 * Accuracy: Approximation — same raise-then-crush cycle, but we use linear
 * interpolation instead of DOOM's fixed-point per-tic movement. Damage is
 * applied once per second while crushed (DOOM applies 10 damage per tic-cycle).
 *
 * Visual approach: The renderer groups upper walls belonging to the crusher
 * sector into an animated container that moves between the raised and crushed
 * heights. Ceiling surfaces (if any) are also included.
 *
 * Crusher types:
 * - crushAndRaise: ceiling raises to highest neighbor ceiling, then lowers to
 *   floor + 8, repeating indefinitely. Activated by switch (SR type 63) or
 *   walk-over trigger (W1/WR types 6, 25, 73, 77).
 */

import { state } from '../state.js';
import { mapData } from '../../shared/maps/index.js';
import { getSectorAt } from '../physics.js';
import { damagePlayer } from '../player/damage.js';
import { orchestrator } from '../../orchestrator.js';

const CRUSHER_SLOW_SPEED = 32;  // Map units per second (DOOM: 1 unit per tic at 35fps ≈ 35/s, we use 32)
const CRUSHER_FAST_SPEED = 64;  // Fast crushers move at double speed
// Based on: linuxdoom-1.10/p_spec.c:T_MoveCeiling() — 10 damage every 4 tics
const CRUSHER_DAMAGE = 10;
const CRUSHER_DAMAGE_INTERVAL = 4 / 35; // 4 tics ≈ 0.114 seconds

let crusherEntries = [];

export function initCrushersState() {
    state.crusherState = new Map();
    crusherEntries = [];
    if (!mapData.crushers) return;

    for (const crusher of mapData.crushers) {
        const travelDistance = crusher.topHeight - crusher.crushHeight;
        if (travelDistance <= 0) continue;

        const entry = {
            sectorIndex: crusher.sectorIndex,
            topHeight: crusher.topHeight,
            crushHeight: crusher.crushHeight,
            speed: crusher.speed === 'fast' ? CRUSHER_FAST_SPEED : CRUSHER_SLOW_SPEED,
            currentHeight: crusher.topHeight,
            direction: -1,
            active: false,
            // Damage timer is tracked per-player so two players in the same
            // crusher accumulate independently. Map<player.index, seconds>.
            damageTimers: new Map(),
        };

        state.crusherState.set(crusher.sectorIndex, entry);
        crusherEntries.push(entry);
    }
}

/**
 * Activates a crusher by sector index. Called when the player triggers the
 * switch or walk-over linedef that starts the crusher.
 */
export function activateCrusher(sectorIndex) {
    const entry = state.crusherState.get(sectorIndex);
    if (!entry || entry.active) return;
    entry.active = true;
    entry.direction = -1; // start by lowering
}

/**
 * Updates all active crushers each frame. Moves the ceiling height, updates
 * the renderer with the current offset, and damages every player being crushed.
 */
export function updateCrushers(deltaTime) {
    for (let i = 0; i < crusherEntries.length; i++) {
        const entry = crusherEntries[i];
        if (!entry.active) continue;

        const moveAmount = entry.speed * deltaTime * entry.direction;
        entry.currentHeight += moveAmount;

        // Reverse direction at limits
        if (entry.currentHeight <= entry.crushHeight) {
            entry.currentHeight = entry.crushHeight;
            entry.direction = 1; // start raising
        } else if (entry.currentHeight >= entry.topHeight) {
            entry.currentHeight = entry.topHeight;
            entry.direction = -1; // start lowering
        }

        // Apply visual offset via renderer
        const offset = entry.topHeight - entry.currentHeight;
        orchestrator.dispatch({ type: 'world', cmd: 'setMoverState', args: ['crusher', entry.sectorIndex, offset] });

        // Check each player for being crushed; per-player damage timer so two
        // players in the same crusher accumulate independently.
        for (const player of state.players) {
            checkCrusherDamage(entry, player, deltaTime);
        }
    }
}

/**
 * Checks if the given player is standing in a crusher sector and being crushed.
 * Uses a simple AABB check against the sector's bounding area by checking
 * the floor height at the player's position against the crusher's sector.
 */
function checkCrusherDamage(entry, player, deltaTime) {
    // Only damage when the ceiling is low enough to crush the player
    // Player height is approximately EYE_HEIGHT (41 units)
    const playerCeilingClearance = entry.currentHeight - player.floorHeight;
    if (playerCeilingClearance > 41) {
        entry.damageTimers.delete(player.index);
        return;
    }

    // Check if the player is actually in this sector
    const playerSector = getSectorAt(player.x, player.y);
    const playerInSector = playerSector && playerSector.sectorIndex === entry.sectorIndex;

    if (!playerInSector) {
        entry.damageTimers.delete(player.index);
        return;
    }

    let timer = (entry.damageTimers.get(player.index) ?? 0) + deltaTime;
    if (timer >= CRUSHER_DAMAGE_INTERVAL) {
        timer -= CRUSHER_DAMAGE_INTERVAL;
        damagePlayer(player, CRUSHER_DAMAGE);
    }
    entry.damageTimers.set(player.index, timer);
}
