/**
 * Game update — runs all game systems for a single frame.
 */

import { MAX_FRAME_DELTA_TIME } from '../shared/constants.js';
import { state } from './state.js';
import { orchestrator } from '../orchestrator.js';
import { updateMovement } from './movement.js';
import { checkSectorDamage } from './player/damage.js';
import { checkPickups, updatePowerups, checkItemRespawns } from './player/pickups.js';
import { updateAllEnemies } from './entities/ai.js';
import { updateProjectiles } from './entities/projectiles.js';
import { checkWalkOverTriggers } from './mechanics/lifts.js';
import { checkTeleporters } from './mechanics/teleporters.js';
import { updateCrushers } from './mechanics/crushers.js';
import { matchTick } from './match.js';
import { GAME_STATE, getGameState } from './game-state.js';

let previousTimestamp = 0;

export function updateGame(timestamp) {
    const deltaTime = Math.min((timestamp - previousTimestamp) / 1000, MAX_FRAME_DELTA_TIME);
    previousTimestamp = timestamp;

    // Tick the DM match clock and check the time-limit end condition.
    // No-op in SP (state.match is null).
    matchTick();
    if (getGameState() === GAME_STATE.ENDED) {
        // Match ended — freeze all gameplay logic. The win overlay covers
        // the screen; input handlers route fire-press to restartMatch().
        return;
    }

    // Single per-frame input collection — populates inputs[i] for every
    // active player slot from all registered providers.
    orchestrator.collectInputs();

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
    // DM only: tick the 30-second respawn timer on collected pickups.
    checkItemRespawns(deltaTime);
}
