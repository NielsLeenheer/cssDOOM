/**
 * Orchestrator — the I/O hub for everything slot-scoped.
 *
 * Lives at the top of `src/` (not under `renderer/`) because it owns
 * concerns from both sides: render targets AND per-frame input
 * collection. Input modules and game code both reach into it through a
 * neutral path.
 *
 * One slot is one player position: index 0 is the host's local view;
 * indices 1..MAX_SLOTS-1 are filled by local players sitting at master
 * (rendered into master's pane N) or by remote secondaries (a
 * RenderSink streams renderer commands across the channel). The
 * orchestrator owns three concerns that all key off slot index:
 *
 *   1. Render-target dispatch — per-pane commands route to one target by
 *      paneIndex; world commands invoke the local impl once and fan out
 *      to every RenderSink so clients mirror the change.
 *      Command names are generated from
 *      [renderer/commands.js](renderer/commands.js).
 *
 *   2. Remote-slot lifecycle — `nextOrCurrentRemoteSlot`, `bindRemoteSlot`,
 *      `unbindRemoteSlot`. A joining client triggers bind: target
 *      swaps for a RenderSink, the master-side pane's sceneEl is
 *      cleared, the paneEl's `data-active` flips to "false" so CSS
 *      hides it, `#game[data-active-renderers]` updates so the
 *      remaining locals reflow to fill the screen, perspective is
 *      refreshed. Unbind is the reverse with a grace-period deferred
 *      unhide so a quickly-reloading client doesn't flash.
 *
 *   3. Per-frame input collection — `collectInputs` zeros + sums every
 *      provider's contribution into the per-slot `inputs[]` array, which
 *      game code (movement, weapons, fire) reads directly via the
 *      module-level `inputs` export. `registerInputProvider` is the
 *      hook input modules call at init time.
 *
 * Press-to-claim (device → slot binding) lives in its own module at
 * [input/claim-registry.js](input/claim-registry.js) — input modules
 * import directly from there as a sibling.
 *
 * `setupMasterBroadcast` in `index.js` is just thin wiring on top: it
 * opens the Transport and routes handshake events into the
 * orchestrator's bind/unbind methods.
 *
 * The public command API mirrors what `src/renderer/index.js` exported
 * before the orchestrator refactor — flat function names, paneIndex /
 * playerIndex as the first argument for per-player commands. Game code
 * is unchanged.
 */

import { domRenderers } from './renderer/dom.js';
import { RenderSink } from './transport/render-sink.js';
import { PER_PANE_COMMANDS, WORLD_COMMANDS } from './renderer/commands.js';
import * as audio from './audio/audio.js';
import { setSlotAudioSuppressed } from './audio/audio.js';
import { updatePerspective } from './renderer/scene/scene.js';

// Master-side cap on pane count. Slot 0 is always the host's local view;
// slots 1..MAX_SLOTS-1 can be filled by either a Local-on-master player
// (rendered to master's pane N) or a Remote (RenderSink → client).
const MAX_SLOTS = 4;

// Deferred-unhide window. When a client disconnects, the target swap
// (sink → DomRenderer) happens immediately so master's per-frame commands
// keep the local pane DOM current. The visual "show pane again" toggle is
// deferred this long so a quickly-reloading client can reconnect
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
const NUM_INPUT_SLOTS = 4;
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
 * @returns {() => void}  Unregister function. Call when the source goes
 *   away (gamepad disconnect, future Network DM remote leaving) so the
 *   orchestrator stops polling a defunct provider.
 */
export function registerInputProvider(getPlayerIndex, getInput) {
    const entry = { getPlayerIndex, getInput };
    inputProviders.push(entry);
    return () => {
        const i = inputProviders.indexOf(entry);
        if (i >= 0) inputProviders.splice(i, 1);
    };
}

class Orchestrator {
    constructor() {
        // One target per slot. Starts empty — boot code on master /
        // client installs DomRenderers via `replaceTarget` based on the
        // active mode (SP = 1 local renderer at slot 0; mirror SP / DM
        // = 2 locals; Network DM master = 1 local + sinks at remote
        // slots). Each DomRenderer owns its own pane DOM and sceneState
        // — see dom-renderer.js.
        this.targets = [null, null, null, null];

        // Remote-slot bookkeeping. `_occupiedRemoteSlots` is the set of
        // slots currently held by any remote client. `_remoteBindings`
        // is keyed by peerKey ('local' for Local DM, peerId per remote
        // for Network DM) and carries the per-peer state we need at
        // unbind time: which slot, the target we swapped out (so we
        // can restore it; may be null for network-only slots that never
        // had a local pane), and the deferred-unhide grace timer.
        this._occupiedRemoteSlots = new Set();
        this._remoteBindings = new Map(); // peerKey → { slot, savedTarget, unbindGraceTimer }

        // Lowest slot index a joining remote can be allocated to. Held
        // local slots (master's host, kiosk's second local) must be
        // above this. Default 1 keeps slot 0 reserved for master's local
        // pane (non-kiosk Network DM, all SP / Local DM modes). Kiosk
        // Network DM bumps to 2 because both slot 0 and slot 1 are
        // locals; without this, the first joiner would steal slot 1
        // from kiosk's second local pane, collapsing the split-screen.
        // Set by `mode.js::applyMode` when entering Network DM host.
        this._minRemoteSlot = 1;
    }

    /**
     * Configure the lowest slot index that may be allocated to a
     * joining remote. Used by mode.js when entering Network DM host
     * mode — kiosk reserves [0, 1] for locals so the first remote
     * starts at slot 2; non-kiosk reserves [0] so the first remote
     * starts at slot 1.
     */
    setMinRemoteSlot(slot) {
        this._minRemoteSlot = slot;
    }

    /** Returns the target for a given slot, or null. */
    target(slot) {
        return this.targets[slot] ?? null;
    }

    /**
     * Swap the target at a given slot. Low-level — `bindRemoteSlot` is
     * the higher-level entrypoint that also handles pane teardown and
     * the visibility toggle. Returned: the previous target (may be null).
     *
     * Keeps `#game[data-active-renderers]` in sync with the number of
     * slots currently holding a DomRenderer (vs. a RenderSink or null).
     * CSS uses this for pane sizing — 1 active renderer = full-width,
     * 2 = split, etc. Detection uses `typeof t.clear === 'function'`
     * which is DomRenderer's interface and not RenderSink's (matching
     * the existing pattern around line 269).
     */
    replaceTarget(slot, target) {
        const previous = this.targets[slot];
        this.targets[slot] = target;
        this._publishActiveRendererCount();
        return previous;
    }

    /** Recompute and write `#game[data-active-renderers]` based on the
     *  count of panes currently marked active (`data-active="true"`).
     *  Reads from the DOM rather than `this.targets` because during the
     *  unbindRemoteSlot grace window a DomRenderer is back in targets
     *  but its paneEl is still hidden (data-active="false") until
     *  loadMap rebuilds the scene; CSS sizing should treat it as 1
     *  pane visible, not 2. */
    _publishActiveRendererCount() {
        const gameEl = typeof document !== 'undefined'
            ? document.getElementById('game')
            : null;
        if (!gameEl) return;
        const count = gameEl.querySelectorAll('.pane[data-active="true"]').length;
        gameEl.dataset.activeRenderers = String(count);
    }

    /** All sink targets currently registered (used to fan out sounds). */
    _sinks() {
        const out = [];
        for (const t of this.targets) {
            if (t && typeof t.forwardWorld === 'function') out.push(t);
        }
        return out;
    }

    // ── Audio dispatch ───────────────────────────────────────────────────

    /**
     * Play a sound. Game code calls this for every sound — the orchestrator
     * decides whether to also broadcast to clients.
     *
     *   playSound('DSPISTOL', { x, y })   → world: local play + fan-out to sinks
     *   playSound('DSSWTCHN', { ui: true }) → UI: centered local play, no broadcast
     *
     * UI sounds are local to whichever window initiated them (menu select on
     * master plays on master only; same for a client).
     */
    playSound(name, opts) {
        audio.playLocal(name, opts);
        if (opts && !opts.ui) {
            for (const sink of this._sinks()) sink.forwardSound(name, opts);
        }
    }

    // ── Remote-slot lifecycle ────────────────────────────────────────────

    /**
     * Return the slot the snapshot provider should advertise to a joining
     * client. Reuses the slot already bound to this peer if there is one
     * (a duplicate LOOKING retry from an already-alive peer, including a
     * mid-grace reconnect); otherwise allocates the lowest free remote
     * slot. Returns null if no slot is free.
     *
     * Pure allocation — no binding happens here. The actual swap occurs
     * in `bindRemoteSlot` once the peer answers with JOIN.
     */
    nextOrCurrentRemoteSlot(peerKey) {
        const existing = this._remoteBindings.get(peerKey);
        if (existing) return existing.slot;
        for (let i = this._minRemoteSlot; i < MAX_SLOTS; i++) {
            if (!this._occupiedRemoteSlots.has(i)) return i;
        }
        return null;
    }

    /** Returns the slot bound to the given peerKey, or null. */
    currentRemoteSlot(peerKey) {
        return this._remoteBindings.get(peerKey)?.slot ?? null;
    }

    /**
     * Bind a connected peer to the given slot. Installs a RenderSink in
     * place of the DomRenderer, tears down master's local DOM for that
     * pane (since the client now renders it), hides the pane via
     * `paneEl[data-active="false"]`, and refreshes perspectives because
     * the remaining pane just grew from 50% → 100% width. Cancels any
     * pending unbind grace timer in case this join is a reconnect (same
     * peerKey) that landed mid-grace, OR another peer's grace that's
     * still pending on the same slot.
     */
    bindRemoteSlot(slot, transport, peerKey, opts = {}) {
        if (slot == null) {
            console.warn('[orchestrator] bindRemoteSlot called with null slot');
            return;
        }

        const suppressAudio = opts.suppressAudio === true;

        // Mid-grace reconnect by the same peer: cancel its visual-unhide
        // so the user doesn't see a flash, and recover its savedTarget.
        const previous = this._remoteBindings.get(peerKey);
        let savedTarget = previous?.savedTarget ?? null;
        if (previous?.unbindGraceTimer) {
            clearTimeout(previous.unbindGraceTimer);
        }

        // A *different* peer's binding is still mid-grace on this slot
        // (rare in practice — would mean someone left and another joined
        // within RECONNECT_GRACE_MS). Cancel that timer too so its
        // loadMap rebuild doesn't stomp the new sink's output.
        for (const [otherKey, b] of this._remoteBindings) {
            if (otherKey === peerKey) continue;
            if (b.slot === slot && b.unbindGraceTimer) {
                clearTimeout(b.unbindGraceTimer);
                this._remoteBindings.delete(otherKey);
                savedTarget = savedTarget ?? b.savedTarget;
            }
        }

        this._occupiedRemoteSlots.add(slot);

        // Capture the DomRenderer (if any) currently at this slot BEFORE
        // we replace the target — if one lived here, that's the renderer
        // we need to clear on master.
        const previousRenderer = this.targets[slot];
        const wasLocalRenderer = previousRenderer && typeof previousRenderer.clear === 'function';

        const sink = new RenderSink(transport, slot);
        const swappedOut = this.replaceTarget(slot, sink);
        this._remoteBindings.set(peerKey, {
            slot,
            savedTarget: savedTarget ?? swappedOut,
            unbindGraceTimer: null,
            suppressAudio,
        });

        // Master skips the wasted work on an invisible subtree — world
        // commands and the culling loop both early-exit on the now-empty
        // sceneState arrays after clear(). No clear needed if the slot
        // didn't have a local renderer (e.g. Network DM slot 2 or 3 bound
        // from empty state straight to a remote).
        if (wasLocalRenderer) {
            previousRenderer.clear();
            // Mark the pane inactive so CSS hides it (the DomRenderer's
            // sceneEl is empty now). data-active flips back to "true"
            // on the unbindRemoteSlot grace-expiry path when loadMap
            // rebuilds the scene.
            previousRenderer.paneEl.dataset.active = 'false';
            this._publishActiveRendererCount();
        }
        if (suppressAudio) setSlotAudioSuppressed(slot, true);
        updatePerspective();

        console.log('[orchestrator] client bound at slot', slot, '- peer', peerKey);
    }

    /**
     * Reverse of bindRemoteSlot for one peer. Restores the DomRenderer
     * immediately so master's per-frame commands keep the local pane DOM
     * in sync, but defers the visual unhide for RECONNECT_GRACE_MS so a
     * reloading client's reconnect doesn't flash the pane visible. After
     * the grace expires, the pane DOM is rebuilt from pane 0's current
     * state, paneEl's `data-active` flips back to "true" so CSS reveals
     * it again, and `#game[data-active-renderers]` updates so the
     * remaining locals reflow to share the screen.
     */
    unbindRemoteSlot(peerKey) {
        const binding = this._remoteBindings.get(peerKey);
        if (!binding) return;

        const { slot, savedTarget } = binding;
        // Restore whatever target was here before the bind — typically a
        // DomRenderer for Local DM (slot 1's pane 1 swap). For Network
        // DM slots that were never local (slot 2 or 3 bound straight to
        // a remote), savedTarget is null and we leave the slot empty.
        this.replaceTarget(slot, savedTarget ?? null);
        this._occupiedRemoteSlots.delete(slot);

        if (binding.suppressAudio) setSlotAudioSuppressed(slot, false);

        // The restored target rebuilds its own scene at grace-expiry —
        // it reads the current mapData + state, so accumulated runtime
        // mutations (open doors, dead enemies, collected items) carry
        // over correctly via the underlying state.* the build reads from.
        const rendererToRebuild = (savedTarget && typeof savedTarget.loadMap === 'function')
            ? savedTarget
            : null;

        if (binding.unbindGraceTimer) clearTimeout(binding.unbindGraceTimer);
        binding.unbindGraceTimer = setTimeout(() => {
            // If a reconnect arrived during grace, bindRemoteSlot
            // cancelled this timer and we never reach this body.
            this._remoteBindings.delete(peerKey);
            rendererToRebuild?.loadMap();
            // Re-mark the pane as active so CSS reveals it (the
            // sceneEl is repopulated by loadMap above). Done after
            // loadMap so the pane doesn't flash empty during the
            // rebuild — but loadMap is fast enough on master that
            // the gap is imperceptible.
            if (rendererToRebuild) {
                rendererToRebuild.paneEl.dataset.active = 'true';
                this._publishActiveRendererCount();
            }
            updatePerspective();
        }, RECONNECT_GRACE_MS);

        console.log('[orchestrator] client unbound from slot', slot, '- peer', peerKey);
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

// Per-player commands: iterate targets and dispatch to every one whose
// `playerIndex` matches. In normal modes that's exactly one target. In
// mirror SP, two DomRenderers share playerIndex 0 and both receive the
// call. In Network DM, a RenderSink at the player's slot forwards to the
// wire.
for (const name of Object.keys(PER_PANE_COMMANDS)) {
    Orchestrator.prototype[name] = function (playerIndex, ...args) {
        for (const t of this.targets) {
            if (!t) continue;
            if (t.playerIndex !== playerIndex) continue;
            t[name](...args);
        }
    };
}

// World commands: iterate every target. Each DomRenderer runs the impl
// against itself; each RenderSink forwards to the wire (its client's
// own orchestrator then iterates its own targets). Build commands are
// no longer here — they were folded into buildScene in Phase B.
for (const name of Object.keys(WORLD_COMMANDS)) {
    Orchestrator.prototype[name] = function (...args) {
        for (const t of this.targets) {
            if (!t) continue;
            t[name]?.(...args);
        }
    };
}

export const orchestrator = new Orchestrator();
