/**
 * Game update — runs all game systems for a single frame.
 */

import { MAX_FRAME_DELTA_TIME } from './constants.js';
import { state } from './state.js';
import { collectInputs } from '../input/index.js';
import { updateMovement } from './movement.js';
import { checkSectorDamage } from './player/damage.js';
import { checkPickups, updatePowerups } from './player/pickups.js';
import { updateAllEnemies } from './entities/ai.js';
import { updateProjectiles } from './entities/projectiles.js';
import { checkWalkOverTriggers } from './mechanics/lifts.js';
import { checkTeleporters } from './mechanics/teleporters.js';
import { updateCrushers } from './mechanics/crushers.js';
import { matchTick } from './match.js';

let previousTimestamp = 0;

export function updateGame(timestamp) {
    const deltaTime = Math.min((timestamp - previousTimestamp) / 1000, MAX_FRAME_DELTA_TIME);
    if (updateGame._logCount === undefined) updateGame._logCount = 0;
    if (updateGame._logCount++ < 300 && updateGame._logCount % 60 === 0) {
        console.log('[game] deltaTime:', deltaTime.toFixed(4), 'ts:', timestamp.toFixed(1), 'prev:', previousTimestamp.toFixed(1));
    }
    previousTimestamp = timestamp;

    // Tick the DM match clock and check the time-limit end condition.
    // No-op in SP (state.match is null).
    matchTick();
    if (state.match?.ended) {
        // Match ended — freeze all gameplay logic. The win overlay covers
        // the screen; input handlers route fire-press to restartMatch().
        return;
    }

    // Single per-frame input collection — populates inputs[i] for every
    // active player slot from all registered providers.
    collectInputs();

    // Per-player updates (movement, sector damage, pickups, powerups).
    // World updates (enemies, projectiles, doors, teleporters, crushers)
    // run once per frame; their internal logic iterates state.players where
    // it needs to touch each player.
    for (const player of state.players) {
        updateMovement(player, deltaTime, timestamp);
        checkSectorDamage(player, deltaTime);
    }
    updateAllEnemies(deltaTime);
    updateProjectiles(deltaTime);
    checkWalkOverTriggers();
    checkTeleporters();
    updateCrushers(deltaTime);
    for (const player of state.players) {
        checkPickups(player);
        updatePowerups(player, deltaTime);
    }
}
