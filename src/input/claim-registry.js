/**
 * Press-to-claim registry.
 *
 * Maps `deviceId → slot index` for input devices that have claimed a
 * player slot during a Local DM lobby. Modes that don't need claiming
 * (singleplayer) bypass it — see `getDriverSlot` below.
 *
 * Pure registry: no knowledge of input slots, providers, or per-frame
 * input collection. Claims are persistent — `unclaim` runs only on
 * explicit release (gamepad disconnect, future menu action). The
 * per-frame transient-input reset on match-reset lives on the
 * orchestrator as `resetTransientInputs` because it touches the
 * `inputs` array.
 *
 * Bindings are mirrored to `sessionStorage` so a tab reload keeps every
 * controller on the same monitor. Cleared on tab close — a new browser
 * session may enumerate gamepad indices differently, so we ask players
 * to press-to-claim again. Input modules call `applySavedClaim` at
 * startup to restore the mapping.
 */

import { state } from '../game/state.js';

const STORAGE_KEY = 'cssdoom:claims';

// Upper bound for sane saved slots. Matches the orchestrator's MAX_SLOTS
// but duplicated here rather than imported so this module stays
// dependency-free of the I/O hub (it's an input concern, not rendering).
const MAX_SLOT_INDEX = 4;

const claims = new Map();
const claimListeners = new Set();

// Saved bindings read from sessionStorage at module load. Each entry is
// consumed by the first `applySavedClaim(deviceId)` call that matches
// (so a device only restores once per session).
const savedClaims = loadSavedClaims();

function loadSavedClaims() {
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY);
        if (!raw) return new Map();
        const entries = JSON.parse(raw);
        if (!Array.isArray(entries)) return new Map();
        return new Map(entries);
    } catch {
        return new Map();
    }
}

function persistClaims() {
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify([...claims]));
    } catch {
        /* sessionStorage may be unavailable (private mode etc.) — non-fatal */
    }
}

// When set, devices without an explicit claim resolve to this slot. Used
// by single-player mode (every device drives slot 0). Game-mode policy
// lives in menu.js's applyMode — claim-registry just exposes the knob.
let defaultSlot = null;

/**
 * Set the slot returned by `getDriverSlot` for any unclaimed device.
 * Called from menu.applyMode: 0 for singleplayer (every device auto-binds
 * to player 0), null for deathmatch (devices must claim explicitly).
 */
export function setDefaultSlot(slot) {
    if (defaultSlot === slot) return;
    defaultSlot = slot;
    notifyClaimChange();
}

/**
 * Returns the slot a device is currently driving. Providers call this
 * from their getPlayerIndex callback so routing follows claim state.
 *
 * Resolution order: explicit claim → defaultSlot (if set) → null. The
 * default-slot fallback is what makes singleplayer "every device drives
 * player 0" without claim-registry knowing about modes.
 */
export function getDriverSlot(deviceId) {
    return claims.get(deviceId) ?? defaultSlot;
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
 * lowest unclaimed slot in [0, state.players.length). Returns the
 * claimed slot, or null if no slot is free.
 */
export function tryClaimSlot(deviceId) {
    const existing = claims.get(deviceId);
    if (existing != null) return existing;
    for (let i = 0; i < state.players.length; i++) {
        if (isSlotClaimedLocally(i)) continue;
        claims.set(deviceId, i);
        notifyClaimChange();
        return i;
    }
    return null;
}

/** Release a device's claim (e.g. on gamepad disconnect). */
export function unclaim(deviceId) {
    if (!claims.has(deviceId)) return;
    claims.delete(deviceId);
    notifyClaimChange();
}

/**
 * Subscribe to claim-state changes. Fires on add, remove, and
 * default-slot updates. Returns an unsubscribe function.
 */
export function onClaimChange(callback) {
    claimListeners.add(callback);
    return () => claimListeners.delete(callback);
}

function notifyClaimChange() {
    persistClaims();
    for (const cb of claimListeners) cb();
}

/**
 * Try to apply a saved binding for the given deviceId.
 *
 * Restores the slot from sessionStorage if the device had one before
 * the page reload AND that slot is still free. Returns the claimed
 * slot or null. Idempotent within a session: after the first successful
 * restore the saved entry is consumed.
 *
 * Called from each input module at startup (keyboard-mouse.js for KBM_A/B,
 * gamepad.js on connect / at init for already-connected pads) so the
 * same controllers land on the same panes after a tab reload.
 */
export function applySavedClaim(deviceId) {
    if (!savedClaims.has(deviceId)) return null;
    const slot = savedClaims.get(deviceId);
    savedClaims.delete(deviceId);
    // We deliberately don't gate on state.players.length here: input
    // init runs before applyMode expands the roster for DM, so checking
    // length would reject every saved slot-1 claim on boot. SP just
    // ignores claims for slot ≥ 1 via setDefaultSlot(0) — no harm
    // leaving the entry in the map.
    if (slot == null || slot < 0 || slot >= MAX_SLOT_INDEX) return null;
    if (isSlotClaimedLocally(slot)) return null;
    claims.set(deviceId, slot);
    notifyClaimChange();
    return slot;
}
