/**
 * Game update — runs all game systems for a single frame.
 */

import { MAX_FRAME_DELTA_TIME } from './constants.js';
import { state } from './state.js';
import { updateMovement } from './movement.js';
import { checkSectorDamage } from './player/damage.js';
import { checkPickups, updatePowerups } from './player/pickups.js';
import { updateAllEnemies } from './entities/ai.js';
import { updateProjectiles } from './entities/projectiles.js';
import { checkWalkOverTriggers } from './mechanics/lifts.js';
import { checkTeleporters } from './mechanics/teleporters.js';
import { updateCrushers } from './mechanics/crushers.js';

let previousTimestamp = 0;

export function updateGame(timestamp) {
    const deltaTime = Math.min((timestamp - previousTimestamp) / 1000, MAX_FRAME_DELTA_TIME);
    if (updateGame._logCount === undefined) updateGame._logCount = 0;
    if (updateGame._logCount++ < 300 && updateGame._logCount % 60 === 0) {
        console.log('[game] deltaTime:', deltaTime.toFixed(4), 'ts:', timestamp.toFixed(1), 'prev:', previousTimestamp.toFixed(1));
    }
    previousTimestamp = timestamp;

    updateMovement(state.players[0], deltaTime, timestamp);
    checkSectorDamage(state.players[0], deltaTime);
    updateAllEnemies(deltaTime);
    updateProjectiles(deltaTime);
    checkWalkOverTriggers();
    checkTeleporters();
    updateCrushers(deltaTime);
    checkPickups(state.players[0]);
    updatePowerups(state.players[0], deltaTime);
}
