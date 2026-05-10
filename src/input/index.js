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
 * # Press-to-claim
 *
 * Local DM uses a press-to-claim flow: on entering DM mode, no local input
 * device is bound to any slot. The first fire-press from an unbound device
 * binds it to the next free slot. Until then, the device's input provider
 * returns null and contributes nothing.
 *
 * The claim registry below maps deviceId → slot. SP mode bypasses claims
 * entirely (devices auto-bind to slot 0). Network DM (future) will have its
 * own claim semantics layered on top.
 */

import { state } from '../game/state.js';

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
 * Migration alias — `input` points at slot 0. Will be removed once every
 * caller reads `inputs[player.index]` directly.
 */
export const input = inputs[0];

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
 * Backwards-compat alias for collectInputs(). Was the only entry point in
 * the single-player era; many callers still use this name. It's now a thin
 * wrapper over collectInputs and can be removed once all callers update.
 */
export function collectInput() {
    collectInputs();
}

// ============================================================================
// Press-to-claim registry
// ============================================================================
//
// Maps deviceId → slot index for devices that have claimed a slot via
// fire-press during a Local DM lobby. Modes that don't need claiming
// (singleplayer) bypass this — see getDriverSlot below.

const claims = new Map();
const claimListeners = new Set();

// Slots that the broadcast layer has assigned to remote sinks. Updated by
// setupMasterBroadcast whenever a secondary joins/leaves. Local claims
// won't pick a slot that's externally claimed.
let externallyClaimedSlots = new Set();
export function setExternallyClaimedSlots(slots) {
    externallyClaimedSlots = new Set(slots);
    notifyClaimChange();
}

/**
 * Returns the slot a device is currently driving. Providers call this
 * from their getPlayerIndex callback so routing follows claim state.
 *
 * - In SP, every device auto-binds to slot 0 (no claim ceremony).
 * - In DM, returns the device's claim if it has one, else `null` (the
 *   provider's contribution is then skipped by collectInputs).
 */
export function getDriverSlot(deviceId) {
    if (state.mode === 'singleplayer') return 0;
    return claims.get(deviceId) ?? null;
}

/** Returns true if any device has claimed the given slot. */
export function isSlotClaimedLocally(slotIndex) {
    for (const claimed of claims.values()) {
        if (claimed === slotIndex) return true;
    }
    return false;
}

/**
 * Try to claim a slot for the given deviceId. If the device already has
 * a claim, returns its existing slot (idempotent). Otherwise picks the
 * lowest unclaimed slot in [0, state.players.length) — skipping slots
 * already claimed locally by another device or externally by a remote
 * sink. Returns the claimed slot, or null if no slot is free.
 */
export function tryClaimSlot(deviceId) {
    const existing = claims.get(deviceId);
    if (existing != null) return existing;
    for (let i = 0; i < state.players.length; i++) {
        if (isSlotClaimedLocally(i)) continue;
        if (externallyClaimedSlots.has(i)) continue;
        claims.set(deviceId, i);
        notifyClaimChange();
        return i;
    }
    return null;
}

/** Release a device's claim (e.g. on disconnect / inactivity timeout). */
export function unclaim(deviceId) {
    if (!claims.has(deviceId)) return;
    claims.delete(deviceId);
    notifyClaimChange();
}

/** Drop every claim — called when a match ends or DM mode is entered.
 *  Also resets transient input state on every slot, so a held fire-button
 *  or pending mouse delta from the previous match doesn't carry over. */
export function clearAllClaims() {
    if (claims.size === 0) return;
    claims.clear();
    for (const slot of inputs) {
        slot.moveX = 0;
        slot.moveY = 0;
        slot.turn = 0;
        slot.turnDelta = 0;
        slot.run = false;
        slot.fireHeld = false;
    }
    notifyClaimChange();
}

/**
 * Subscribe to claim-state changes. Called when any claim is added,
 * removed, or cleared. Used by the lobby UI to update PRESS FIRE TO JOIN
 * overlays and by the auto-start logic to detect "all slots claimed".
 * Returns an unsubscribe function.
 */
export function onClaimChange(callback) {
    claimListeners.add(callback);
    return () => claimListeners.delete(callback);
}

function notifyClaimChange() {
    for (const cb of claimListeners) cb();
}
