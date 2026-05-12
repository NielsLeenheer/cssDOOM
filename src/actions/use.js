/**
 * Use action — translate USE events into the three mechanic-specific
 * tries. Each helper short-circuits if the player isn't pointing at a
 * relevant target, so it's safe to fire all three on every use press.
 */

import { state } from '../game/state.js';
import { tryOpenDoor } from '../game/mechanics/doors.js';
import { tryUseSwitch } from '../game/mechanics/switches.js';
import { tryUseLift } from '../game/mechanics/lifts.js';
import * as A from '../input/actions.js';
import { on } from '../input/event-bus.js';

export function initUseAction() {
    on(A.USE, ({ slot }) => {
        if (slot == null) return;
        const player = state.players[slot];
        if (!player) return;
        tryOpenDoor(player);
        tryUseSwitch(player);
        tryUseLift(player);
    });
}
