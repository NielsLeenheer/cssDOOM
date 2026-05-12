/**
 * Fire action — translate FIRE_DOWN / FIRE_UP events into weapon
 * fire-or-stop calls. The dead-respawn / match-end / intermission
 * gates run at higher priority and consume the event before this
 * handler sees it (see actions/index.js).
 */

import { state } from '../game/state.js';
import { fireWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { inputs } from '../renderer/orchestrator.js';
import * as A from '../input/actions.js';
import { on } from '../input/event-bus.js';

export function initFireAction() {
    on(A.FIRE_DOWN, ({ slot }) => {
        if (slot == null) return;
        const player = state.players[slot];
        if (!player) return;
        inputs[slot].fireHeld = true;
        fireWeapon(player);
    });

    on(A.FIRE_UP, ({ slot }) => {
        if (slot == null) return;
        const player = state.players[slot];
        if (!player) return;
        inputs[slot].fireHeld = false;
        stopAutoFire(player);
    });
}
