/**
 * Press-to-claim registry.
 *
 * Maps `deviceId → slot index` for input devices that have claimed a
 * player slot during a Local DM lobby. Modes that don't need claiming
 * (singleplayer) bypass it — see `getDriverSlot` below.
 *
 * Also tracks slots claimed externally by remote sinks (a connected
 * secondary window) so local claims don't double up on those.
 *
 * Pure registry: no knowledge of input slots, providers, or per-frame
 * input collection. Callers wanting the "drop all claims AND zero
 * transient input state" combo go through `clearAllClaims` in
 * [index.js](index.js), which wraps `clearAllClaims` here with the
 * input-slot reset.
 */

import { state } from '../game/state.js';

const claims = new Map();
const claimListeners = new Set();

let externallyClaimedSlots = new Set();

/**
 * Replace the set of slots known to be claimed by remote sinks. Called
 * by setupMasterBroadcast whenever a secondary joins or leaves so local
 * claims won't pick a slot a remote already owns.
 */
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

/** Returns true if any local device has claimed the given slot. */
export function isSlotClaimedLocally(slotIndex) {
    for (const claimed of claims.values()) {
        if (claimed === slotIndex) return true;
    }
    return false;
}

/**
 * Try to claim a slot for the given deviceId. Idempotent: if the device
 * already has a claim, returns its existing slot. Otherwise picks the
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

/**
 * Drop every claim. Called when a match ends or DM mode is entered, so
 * each player must re-press to join the next match. The "transient
 * input state" reset that used to ride along here lives in
 * [index.js](index.js)'s `clearAllClaims` wrapper.
 */
export function clearAllClaims() {
    if (claims.size === 0) return;
    claims.clear();
    notifyClaimChange();
}

/**
 * Subscribe to claim-state changes. Fires on add, remove, clear-all, and
 * external-slot updates. Returns an unsubscribe function.
 */
export function onClaimChange(callback) {
    claimListeners.add(callback);
    return () => claimListeners.delete(callback);
}

function notifyClaimChange() {
    for (const cb of claimListeners) cb();
}
