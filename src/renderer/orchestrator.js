/**
 * Orchestrator — the I/O hub for everything slot-scoped.
 *
 * One slot is one player position: index 0 is the host's local view;
 * indices 1..MAX_SLOTS-1 are filled by local players sitting at master
 * (rendered into master's pane N) or by remote secondaries (a
 * BroadcastSink streams renderer commands across the channel). The
 * orchestrator owns four concerns that all key off slot index:
 *
 *   1. Render-target dispatch — per-pane commands route to one target by
 *      paneIndex; world commands invoke the local impl once and fan out
 *      to every BroadcastSink so secondary windows mirror the change.
 *      Command names are generated from [commands.js](commands.js).
 *
 *   2. Remote-slot lifecycle — `nextOrCurrentRemoteSlot`, `bindRemoteSlot`,
 *      `unbindRemoteSlot`. A joining secondary triggers bind: target
 *      swaps for a BroadcastSink, the master-side pane DOM is torn down,
 *      `body.secondary-active` hides the empty pane, perspective is
 *      refreshed. Unbind is the reverse with a grace-period deferred
 *      unhide so a quickly-reloading secondary doesn't flash.
 *
 *   3. Press-to-claim registry — `tryClaimSlot`, `unclaim`,
 *      `getDriverSlot`, `setDefaultSlot`, `applySavedClaim`,
 *      `onClaimChange`. Maps device IDs to slots. Persists across tab
 *      reloads via sessionStorage so the same controller lands on the
 *      same monitor.
 *
 *   4. Per-frame input collection — `collectInputs` zeros + sums every
 *      provider's contribution into the per-slot `inputs[]` array, which
 *      game code (movement, weapons, fire) reads directly via the
 *      module-level `inputs` export. `registerInputProvider` is the
 *      hook input modules call at init time.
 *
 * `setupMasterBroadcast` in `index.js` is just thin wiring on top: it
 * opens the BroadcastChannel and routes handshake events into the
 * orchestrator's bind/unbind methods.
 *
 * The public command API mirrors what `src/renderer/index.js` exported
 * before the orchestrator refactor — flat function names, paneIndex /
 * playerIndex as the first argument for per-player commands. Game code
 * is unchanged.
 */

import { DomRenderer } from './dom-renderer.js';
import { BroadcastSink } from './broadcast-sink.js';
import { PER_PANE_COMMANDS, WORLD_COMMANDS } from './commands.js';
import {
    clonePanes as clonePanesHelper,
    setMirrorMode as setMirrorModeHelper,
    isMirrorMode as isMirrorModeHelper,
    viewportsForEffect as viewportsForEffectHelper,
    tearDownPane,
    rebuildPane,
    updatePerspective,
} from './scene/scene.js';
import { state } from '../game/state.js';

// sessionStorage key for the device → slot claim map. Persists across tab
// reloads but is cleared on tab close — a fresh browser session can
// enumerate gamepads differently, so players re-claim from scratch.
const CLAIM_STORAGE_KEY = 'cssdoom:claims';

function loadSavedClaims() {
    try {
        const raw = sessionStorage.getItem(CLAIM_STORAGE_KEY);
        if (!raw) return new Map();
        const entries = JSON.parse(raw);
        if (!Array.isArray(entries)) return new Map();
        return new Map(entries);
    } catch {
        return new Map();
    }
}

// Master-side cap on pane count. Slot 0 is always the host's local view;
// slots 1..MAX_SLOTS-1 can be filled by either a Local-on-master player
// (rendered to master's pane N) or a Remote (BroadcastSink → secondary).
const MAX_SLOTS = 4;

// Deferred-unhide window. When a secondary disconnects, the target swap
// (sink → DomRenderer) happens immediately so master's per-frame commands
// keep the local pane DOM current. The visual "show pane again" toggle is
// deferred this long so a quickly-reloading secondary can reconnect
// without the user seeing master's pane flash visible.
const RECONNECT_GRACE_MS = 500;

// Per-player input state. `inputs[i]` is the unified input snapshot for
// the player at state.players[i]. Lives at module scope (not on the
// Orchestrator instance) so consumers can import it directly without
// going through `orchestrator.inputs` in their hot paths.
//
// `fireHeld` is set/cleared by event handlers and persists across frames
// so chaingun auto-fire can poll it. The other fields are zeroed and
// resummed every frame by `collectInputs`.
const NUM_INPUT_SLOTS = 2;
function makeInputSlot() {
    return { moveX: 0, moveY: 0, turn: 0, turnDelta: 0, run: false, fireHeld: false };
}
export const inputs = Array.from({ length: NUM_INPUT_SLOTS }, makeInputSlot);

const inputProviders = [];

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
    inputProviders.push({ getPlayerIndex, getInput });
}

class Orchestrator {
    constructor() {
        // Default registration: one DomRenderer per pane in the current
        // sceneStates layout (always 2 in current HTML). bindRemoteSlot
        // swaps one of these for a BroadcastSink when a secondary joins.
        this.targets = [new DomRenderer(0), new DomRenderer(1)];

        // Remote-slot bookkeeping. `occupiedRemoteSlots` is the set of
        // slots currently held by a secondary. `currentSecondarySlot` is
        // the single-secondary fast path (Local DM today; multi-secondary
        // network DM would generalize). `savedRemoteTarget` is the
        // DomRenderer we swapped out, kept so unbind can restore it.
        this._occupiedRemoteSlots = new Set();
        this._currentSecondarySlot = null;
        this._savedRemoteTarget = null;
        this._unbindGraceTimer = null;

        // Press-to-claim registry. `_claims` maps `deviceId → slot` for
        // every device that has claimed a slot in Local DM. `_defaultSlot`
        // is the fallback for unclaimed devices (0 in SP so every input
        // drives player 0; null in DM so claiming is required).
        // `_savedClaims` is the persisted-from-sessionStorage map that
        // `applySavedClaim` consumes once per device per session.
        this._claims = new Map();
        this._defaultSlot = null;
        this._claimListeners = new Set();
        this._savedClaims = loadSavedClaims();
    }

    /** Returns the target for a given pane index, or null if out of range. */
    target(paneIndex) {
        return this.targets[paneIndex] ?? null;
    }

    /**
     * Swap the target at a given pane index. Low-level — `bindRemoteSlot`
     * is the higher-level entrypoint that also handles pane teardown and
     * the visibility toggle. Returned: the previous target.
     */
    replaceTarget(paneIndex, target) {
        const previous = this.targets[paneIndex];
        this.targets[paneIndex] = target;
        return previous;
    }

    /** All sink targets currently registered (used to fan out world commands). */
    _sinks() {
        const out = [];
        for (const t of this.targets) {
            if (t && typeof t.forwardWorld === 'function') out.push(t);
        }
        return out;
    }

    /** Forward a world command to all registered sinks. */
    _broadcastWorld(method, args) {
        for (const sink of this._sinks()) sink.forwardWorld(method, args);
    }

    // ── Scene controls (orchestrator-only, no per-target dispatch) ───────

    clonePanes(paneCount) { clonePanesHelper(paneCount); }
    setMirrorMode(value) { setMirrorModeHelper(value); }
    isMirrorMode() { return isMirrorModeHelper(); }
    viewportsForEffect(playerIndex) { return viewportsForEffectHelper(playerIndex); }

    // ── Remote-slot lifecycle ────────────────────────────────────────────

    /**
     * Return the slot the snapshot provider should advertise to a joining
     * secondary. Reuses the active single-secondary slot if there is one
     * (a duplicate LOOKING retry from an already-alive peer); otherwise
     * allocates the lowest free remote slot. Returns null if no slot
     * is free.
     *
     * Pure allocation — no binding happens here. The actual swap occurs
     * in `bindRemoteSlot` once the peer answers with JOIN.
     */
    nextOrCurrentRemoteSlot() {
        if (this._currentSecondarySlot != null) return this._currentSecondarySlot;
        for (let i = 1; i < MAX_SLOTS; i++) {
            if (!this._occupiedRemoteSlots.has(i)) return i;
        }
        return null;
    }

    /** Returns the slot currently held by a remote secondary, or null. */
    currentRemoteSlot() {
        return this._currentSecondarySlot;
    }

    /**
     * Bind a connected secondary to the given slot. Installs a
     * BroadcastSink in place of the DomRenderer, tears down master's
     * local DOM for that pane (since the secondary now renders it),
     * hides the pane via `body.secondary-active`, and refreshes
     * perspectives because the remaining pane just grew from 50% → 100%
     * width. Cancels any pending unbind grace timer in case this join is
     * a reconnect that landed mid-grace.
     */
    bindRemoteSlot(slot, channel) {
        if (slot == null) {
            console.warn('[orchestrator] bindRemoteSlot called with null slot');
            return;
        }

        // A reconnecting secondary cancels any pending visual-unhide so
        // the user doesn't see a flash during reload.
        if (this._unbindGraceTimer) {
            clearTimeout(this._unbindGraceTimer);
            this._unbindGraceTimer = null;
        }

        this._occupiedRemoteSlots.add(slot);
        this._currentSecondarySlot = slot;

        const sink = new BroadcastSink(channel, slot);
        this._savedRemoteTarget = this.replaceTarget(slot, sink);

        // Master skips the wasted work on an invisible subtree — world
        // commands and the culling loop both early-exit on the now-empty
        // sceneStates[slot] arrays after teardown.
        tearDownPane(slot);
        document.body.classList.add('secondary-active');
        updatePerspective();

        console.log('[orchestrator] secondary bound at slot', slot, '- pane torn down');
    }

    /**
     * Reverse of bindRemoteSlot. Restores the DomRenderer immediately so
     * master's per-frame commands keep the local pane DOM in sync, but
     * defers the visual unhide for RECONNECT_GRACE_MS so a reloading
     * secondary's reconnect doesn't flash the pane visible. After the
     * grace expires, the pane DOM is rebuilt from pane 0's current state
     * before unhiding (otherwise the user sees an empty .scene for a
     * frame).
     */
    unbindRemoteSlot() {
        const slot = this._currentSecondarySlot;
        if (slot != null) {
            this.replaceTarget(slot, this._savedRemoteTarget ?? new DomRenderer(slot));
            this._occupiedRemoteSlots.delete(slot);
        }
        this._savedRemoteTarget = null;
        this._currentSecondarySlot = null;

        if (this._unbindGraceTimer) clearTimeout(this._unbindGraceTimer);
        this._unbindGraceTimer = setTimeout(() => {
            this._unbindGraceTimer = null;
            if (slot != null) rebuildPane(slot);
            document.body.classList.remove('secondary-active');
            updatePerspective();
        }, RECONNECT_GRACE_MS);

        console.log('[orchestrator] secondary unbound from slot', slot);
    }

    // ── Press-to-claim registry ──────────────────────────────────────────

    /**
     * Set the slot returned by `getDriverSlot` for any unclaimed device.
     * Called from menu.applyMode: 0 for singleplayer (every device
     * auto-binds to player 0), null for deathmatch (devices must claim
     * explicitly).
     */
    setDefaultSlot(slot) {
        if (this._defaultSlot === slot) return;
        this._defaultSlot = slot;
        this._notifyClaimChange();
    }

    /**
     * Returns the slot a device is currently driving. Providers call this
     * from their getPlayerIndex callback so routing follows claim state.
     *
     * Resolution order: explicit claim → defaultSlot (if set) → null. The
     * default-slot fallback is what makes singleplayer "every device drives
     * player 0" without input modules knowing about modes.
     */
    getDriverSlot(deviceId) {
        return this._claims.get(deviceId) ?? this._defaultSlot;
    }

    /** Returns true if any local device has claimed the given slot. */
    isSlotClaimedLocally(slotIndex) {
        for (const claimed of this._claims.values()) {
            if (claimed === slotIndex) return true;
        }
        return false;
    }

    /**
     * Try to claim a slot for the given deviceId. Idempotent: if the
     * device already has a claim, returns its existing slot. Otherwise
     * picks the lowest unclaimed slot in [0, state.players.length).
     * Returns the claimed slot, or null if no slot is free.
     */
    tryClaimSlot(deviceId) {
        const existing = this._claims.get(deviceId);
        if (existing != null) return existing;
        for (let i = 0; i < state.players.length; i++) {
            if (this.isSlotClaimedLocally(i)) continue;
            this._claims.set(deviceId, i);
            this._notifyClaimChange();
            return i;
        }
        return null;
    }

    /** Release a device's claim (e.g. on gamepad disconnect). */
    unclaim(deviceId) {
        if (!this._claims.has(deviceId)) return;
        this._claims.delete(deviceId);
        this._notifyClaimChange();
    }

    /**
     * Subscribe to claim-state changes. Fires on add, remove, and
     * default-slot updates. Returns an unsubscribe function.
     */
    onClaimChange(callback) {
        this._claimListeners.add(callback);
        return () => this._claimListeners.delete(callback);
    }

    /**
     * Try to apply a saved binding for the given deviceId.
     *
     * Restores the slot from sessionStorage if the device had one before
     * the page reload AND that slot is still free. Returns the claimed
     * slot or null. Idempotent within a session: after the first
     * successful restore the saved entry is consumed.
     *
     * Called from each input module at startup (keyboard.js for KBM_A/B,
     * gamepad.js on connect / at init for already-connected pads) so the
     * same controllers land on the same panes after a tab reload.
     */
    applySavedClaim(deviceId) {
        if (!this._savedClaims.has(deviceId)) return null;
        const slot = this._savedClaims.get(deviceId);
        this._savedClaims.delete(deviceId);
        // Slot must look sane (non-negative, capped at MAX_SLOTS) but we
        // deliberately don't gate on state.players.length: input init
        // runs before applyMode expands the roster for DM, so checking
        // length here would reject every saved slot-1 claim on boot. SP
        // just ignores claims for slot ≥ 1 via setDefaultSlot(0) — no
        // harm leaving the entry in the map.
        if (slot == null || slot < 0 || slot >= MAX_SLOTS) return null;
        if (this.isSlotClaimedLocally(slot)) return null;
        this._claims.set(deviceId, slot);
        this._notifyClaimChange();
        return slot;
    }

    _persistClaims() {
        try {
            sessionStorage.setItem(CLAIM_STORAGE_KEY, JSON.stringify([...this._claims]));
        } catch {
            /* sessionStorage may be unavailable (private mode etc.) — non-fatal */
        }
    }

    _notifyClaimChange() {
        this._persistClaims();
        for (const cb of this._claimListeners) cb();
    }

    // ── Per-frame input collection ───────────────────────────────────────

    /**
     * Per-frame input collection. Called once from the game loop before
     * any movement update so all players' input slots are fresh for the
     * frame. Zeros the per-frame fields on every slot, sums all provider
     * contributions routed by their declared player index, and clamps
     * the per-axis totals. `fireHeld` is intentionally not reset — it's
     * event-driven and persists across frames.
     */
    collectInputs() {
        for (const slot of inputs) {
            slot.moveX = 0;
            slot.moveY = 0;
            slot.turn = 0;
            slot.turnDelta = 0;
            slot.run = false;
        }

        for (let i = 0; i < inputProviders.length; i++) {
            const { getPlayerIndex, getInput } = inputProviders[i];
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
     * Reset transient input state on every slot. Called on match-reset
     * so a held fire-button or pending mouse / stick delta from the
     * previous match doesn't carry over into the next one's lobby.
     * Claims themselves (the device→slot bindings) are intentionally
     * preserved across match-reset.
     */
    resetTransientInputs() {
        for (const slot of inputs) {
            slot.moveX = 0;
            slot.moveY = 0;
            slot.turn = 0;
            slot.turnDelta = 0;
            slot.run = false;
            slot.fireHeld = false;
        }
    }
}

// Per-pane commands: route to one target by paneIndex. Target's method
// (DomRenderer or BroadcastSink) is responsible for everything past the
// paneIndex argument.
for (const name of Object.keys(PER_PANE_COMMANDS)) {
    Orchestrator.prototype[name] = function (paneIndex, ...args) {
        this.targets[paneIndex]?.[name](...args);
    };
}

// World commands: invoke local impl, then fan out to every sink so
// secondary windows mirror the change.
for (const [name, { impl }] of Object.entries(WORLD_COMMANDS)) {
    Orchestrator.prototype[name] = function (...args) {
        impl(...args);
        this._broadcastWorld(name, args);
    };
}

export const orchestrator = new Orchestrator();
