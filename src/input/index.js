/**
 * Input Manager
 *
 * Provides a unified per-player input abstraction so the game layer reads
 * `inputs[player.index]` regardless of how many input sources exist or
 * which player they target.
 *
 * Each input module (keyboard, mouse, gamepad, touch) registers a provider
 * via `registerInputProvider(getPlayerIndex, getInput)`:
 *
 *   getPlayerIndex(): returns the player slot this provider currently
 *                     targets (0 or 1). Dynamic — looked up via
 *                     `getDriverSlot(deviceId)` against the press-to-claim
 *                     registry. May return `null` if the device is
 *                     currently unbound (Local DM lobby state, before
 *                     a slot has been claimed).
 *   getInput():       returns the current contribution as
 *                     { moveX, moveY, turn, turnDelta, run }.
 *
 * `collectInputs()` is called once per frame from the game loop. It zeros
 * the per-frame fields on every input slot, sums all provider contributions
 * routed by their declared player index, and clamps the per-axis totals.
 *
 * `fireHeld` lives on each slot and is NOT reset by collectInputs — it is
 * set/cleared by event handlers (keydown/keyup, gamepad before/after) and
 * persists across frames so chaingun auto-fire can poll it.
 *
 * Press-to-claim (the deviceId → slot binding used in Local DM lobby)
 * lives in [claim-registry.js](claim-registry.js). This module wraps
 * `clearAllClaims` to additionally reset transient input-slot state on a
 * fresh match — that side effect needs `inputs` here.
 */

import { clearAllClaims as registryClearAllClaims } from './claim-registry.js';

const NUM_INPUT_SLOTS = 2;

const providers = [];

function makeSlot() {
    return { moveX: 0, moveY: 0, turn: 0, turnDelta: 0, run: false, fireHeld: false };
}

/**
 * Per-player input slots. inputs[i] is the unified input state for the
 * player at state.players[i].
 */
export const inputs = Array.from({ length: NUM_INPUT_SLOTS }, makeSlot);

/**
 * Register an input provider.
 *
 * @param {() => number|null} getPlayerIndex  Returns the target slot index
 *   (or null if the provider is currently unbound — its contribution is
 *   skipped). Called every frame by collectInputs so the target can be
 *   runtime-mutable.
 * @param {() => object} getInput  Returns the provider's contribution to
 *   the input state for this frame.
 */
export function registerInputProvider(getPlayerIndex, getInput) {
    providers.push({ getPlayerIndex, getInput });
}

/**
 * Per-frame input collection. Called once from the game loop before any
 * movement update so all players' input slots are fresh for the frame.
 */
export function collectInputs() {
    for (const slot of inputs) {
        slot.moveX = 0;
        slot.moveY = 0;
        slot.turn = 0;
        slot.turnDelta = 0;
        slot.run = false;
        // fireHeld intentionally not reset — it's event-driven and persists.
    }

    for (let i = 0; i < providers.length; i++) {
        const { getPlayerIndex, getInput } = providers[i];
        const playerIndex = getPlayerIndex();
        if (playerIndex == null) continue;
        const slot = inputs[playerIndex];
        if (!slot) continue;
        const p = getInput();
        slot.moveX += p.moveX || 0;
        slot.moveY += p.moveY || 0;
        slot.turn += p.turn || 0;
        slot.turnDelta += p.turnDelta || 0;
        if (p.run) slot.run = true;
    }

    for (const slot of inputs) {
        slot.moveX = Math.max(-1, Math.min(1, slot.moveX));
        slot.moveY = Math.max(-1, Math.min(1, slot.moveY));
        slot.turn = Math.max(-1, Math.min(1, slot.turn));
    }
}

/**
 * Drop every claim AND reset transient input state on every slot. Called
 * on match-reset so a held fire-button or pending mouse delta from the
 * previous match doesn't carry over into the next one's lobby.
 */
export function clearAllClaims() {
    registryClearAllClaims();
    for (const slot of inputs) {
        slot.moveX = 0;
        slot.moveY = 0;
        slot.turn = 0;
        slot.turnDelta = 0;
        slot.run = false;
        slot.fireHeld = false;
    }
}
