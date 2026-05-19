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
 *   1. Render-target dispatch — `targets` is a flat list of every
 *      registered target (DomRenderer, RenderSink, AudioRenderer).
 *      Per-pane commands fan to every target whose `playerIndex`
 *      matches the addressed slot; world commands fan to every
 *      target. Each kind's prototype method decides what it does
 *      (DomRenderer paints, RenderSink forwards over the wire,
 *      AudioRenderer updates its per-listener state). Command names
 *      are generated from
 *      [renderer/commands.js](renderer/commands.js).
 *
 *   2. Remote-slot lifecycle — `nextOrCurrentRemoteSlot`, `bindRemoteSlot`,
 *      `unbindRemoteSlot`. A joining client triggers bind: the local
 *      DomRenderer at that slot leaves the target list (its sceneEl
 *      is cleared and the paneEl's `data-active` flips to "false" so
 *      CSS hides it), a RenderSink is added in its place, and (for
 *      Network DM remotes) the local AudioRenderer also leaves so
 *      master doesn't double-play sounds the remote already plays
 *      on its own device. `#game[data-active-renderers]` updates so
 *      the remaining locals reflow to fill the screen. Unbind is
 *      the reverse with a grace-period deferred visual-unhide so a
 *      quickly-reloading client doesn't flash.
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

import { RenderSink } from './transport/render-sink.js';
import { PER_PANE_COMMANDS, WORLD_COMMANDS } from './renderer/commands.js';
import { AudioRenderer } from './audio/audio.js';

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
        // Flat list of render targets, in registration order. Each
        // target carries `kind` ('dom' | 'sink' | 'audio') and
        // `playerIndex` (the slot it services). Multiple targets can
        // share one slot — e.g. a DomRenderer + an AudioRenderer both
        // service slot 0 locally. Per-pane dispatch matches against
        // playerIndex; world dispatch fans to all. Lifecycle (who's
        // in the list when) is owned by the modules that create
        // targets: DomRendererManager for 'dom', bindRemoteSlot /
        // unbindRemoteSlot for 'sink', audio.js for 'audio'.
        this.targets = [];

        // Remote-slot bookkeeping. `_occupiedRemoteSlots` is the set of
        // slots currently held by any remote client. `_remoteBindings`
        // is keyed by peerKey ('local' for Local DM, peerId per remote
        // for Network DM) and carries the per-peer state we need at
        // unbind time: which slot, the target we swapped out (so we
        // can restore it; may be null for network-only slots that never
        // had a local pane), and the deferred-unhide grace timer.
        this._occupiedRemoteSlots = new Set();
        this._remoteBindings = new Map(); // peerKey → { slot, sink, savedDom, unbindGraceTimer, suppressAudio }

        // Lowest slot index a joining remote can be allocated to. Held
        // local slots (master's host, kiosk's second local) must be
        // above this. Default 1 keeps slot 0 reserved for master's local
        // pane (non-kiosk Network DM, all SP / Local DM modes). Kiosk
        // Network DM bumps to 2 because both slot 0 and slot 1 are
        // locals; without this, the first joiner would steal slot 1
        // from kiosk's second local pane, collapsing the split-screen.
        // Set by `mode.js::applyMode` when entering Network DM host.
        this._minRemoteSlot = 1;

        // Authoritative payload provider for stateful overlay commands.
        // Set by Game.start (cleared on Game.stop) so when game code
        // signals `orchestrator.showResults()` / `showIntermission()` /
        // `showLobby()`, the orchestrator can pull the current data
        // straight from the game instead of relying on the caller to
        // pass a payload that becomes stale the moment it's sent. The
        // joiner reconnect path (`replayCurrentOverlayTo`) uses the
        // same provider, so live fires and reconnect re-fires share one
        // data source — there's no separate "overlay state" to drift.
        //
        // Provider contract (Game implements all):
        //   getCurrentOverlay()        → 'showResults' | 'showIntermission' | 'showLobby' | null
        //   getResultsPayload()        → scoreboard data
        //   getIntermissionPayload()   → { nextMap, mapName, stats }
        //   getLobbyPayload()          → unified lobby state
        this._provider = null;

        // ── Audio listener lifecycle ────────────────────────────────
        // Tracks the slots this window plays audio for + the global
        // enable switch. `_rebuildAudioTargets` recreates the
        // AudioRenderer set from these on any change (configureAudio,
        // setAudioEnabled, bindRemoteSlot, unbindRemoteSlot). The
        // listeners themselves live in `this.targets` like any other
        // render target.
        this._audioEnabled = true;
        this._audioSlots = [];
    }

    /** Register / clear the overlay payload provider. Game wires this
     *  in `start()` and clears in `stop()`. */
    setPayloadProvider(provider) {
        this._provider = provider;
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

    /**
     * Find the first target at the given slot with the given kind, or
     * null. Callers needing a specific role (the local DomRenderer for
     * overlay replay, the sink for a remote, the AudioRenderer for
     * mute) pick by kind — multiple targets can share one slot.
     */
    findTarget(slot, kind) {
        for (const t of this.targets) {
            if (t.playerIndex === slot && t.kind === kind) return t;
        }
        return null;
    }

    /**
     * Register a target. Each target must expose `kind` and
     * `playerIndex`. Refreshes `#game[data-active-renderers]` because
     * adding a local DomRenderer changes how CSS sizes the panes.
     */
    addTarget(target) {
        this.targets.push(target);
        this._publishActiveRendererCount();
    }

    /**
     * Deregister a target. Silently no-ops if not present so callers
     * can be defensive without checking first.
     */
    removeTarget(target) {
        const i = this.targets.indexOf(target);
        if (i < 0) return;
        this.targets.splice(i, 1);
        this._publishActiveRendererCount();
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

    // ── Spectator mode ───────────────────────────────────────────────────
    // SP-only feature. All forwards target slot 0's local DomRenderer
    // (always present in SP). UI calls these on the orchestrator and
    // never holds a renderer reference directly.
    setSpectatorCamera(camera)        { this.findTarget(0, 'dom')?.setSpectatorCamera?.(camera); }
    setSpectatorFollowHeight(height)  { this.findTarget(0, 'dom')?.setSpectatorFollowHeight?.(height); }
    setSpectatorAngle(angle)          { this.findTarget(0, 'dom')?.setSpectatorAngle?.(angle); }
    startSpectatorMode(mode)          { this.findTarget(0, 'dom')?.startSpectatorMode?.(mode); }
    switchSpectatorMode(mode)         { this.findTarget(0, 'dom')?.switchSpectatorMode?.(mode); }
    endSpectatorMode()                { this.findTarget(0, 'dom')?.endSpectatorMode?.(); }

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

    // ── Audio listener lifecycle ────────────────────────────────────────
    //
    // The orchestrator owns the set of AudioRenderer targets the same
    // way it owns DomRenderers and RenderSinks. `configureAudio` sets
    // the roster size; `setAudioEnabled` flips the master switch; bind /
    // unbind toggle per-slot suppression. Every change funnels through
    // `_rebuildAudioTargets`, which derives the live set from the
    // current configuration in one place.

    /**
     * (Re)build the listener set for the slots this window should play
     * audio for. Master passes `[...state.players.keys()]` (its local
     * roster, slots 0..N-1); a Network DM joiner passes `[slotIndex]`
     * (its single master-assigned slot — its `state.players` array
     * indices don't align with the master-side slot, so it can't use
     * a `.keys()` of its local roster).
     *
     * Listener count drives the pan mode after suppression: 1 = bearing
     * pan, 2+ = locked L/R for split-screen. Called by `mode.js`'s
     * applyMode (master path), `master.js`'s onJoin handler, and the
     * joiner's `_onAck` after `resetToJoinerSlot` puts its DomRenderer
     * at the assigned slot.
     */
    configureAudio(slots) {
        this._audioSlots = [...slots];
        this._rebuildAudioTargets();
    }

    /**
     * Master switch — when false, every listener is dropped from the
     * target list so world `playSound` dispatch can't reach an audio
     * target on this window. Used by the Local DM secondary so master
     * and secondary don't double-play through the same room speakers.
     */
    setAudioEnabled(value) {
        if (this._audioEnabled === value) return;
        this._audioEnabled = value;
        this._rebuildAudioTargets();
    }

    /**
     * Reconcile audio targets with current config. Drops every
     * AudioRenderer in `this.targets` and recreates listeners for the
     * effective slot set — `_audioSlots` minus those a Network DM
     * remote currently owns audio for (the remote plays its own
     * sounds on its own device).
     *
     * Pan mode keys off the EFFECTIVE listener count after suppression
     * so a Network DM master with 1 local + 1 remote keeps its solo
     * listener on bearing-pan instead of locking to one side.
     *
     * Listener state.camera is reset on rebuild — the very next
     * per-pane updateCamera dispatch (which runs before any playSound
     * in a frame) restores correct values, so this gap is invisible.
     */
    _rebuildAudioTargets() {
        for (const t of [...this.targets]) {
            if (t.kind === 'audio') this.removeTarget(t);
        }

        if (!this._audioEnabled) return;

        const activeSlots = this._audioSlots.filter(s => !this._isSlotAudioSuppressed(s));
        const split = activeSlots.length >= 2;
        activeSlots.forEach((slot, idx) => {
            const paneSide = split ? (idx === 0 ? 'left' : 'right') : null;
            this.addTarget(new AudioRenderer({ slot, paneSide }));
        });
    }

    /** True if a remote currently OWNS this slot AND had `suppressAudio`
     *  set (Network DM remote on a separate machine plays its own audio).
     *  The `_occupiedRemoteSlots` gate is what lets a mid-grace unbind
     *  return the listener to the active set even though the binding
     *  itself lingers in `_remoteBindings` until the grace timer fires
     *  (the binding is kept around so a same-peer reconnect can recover
     *  its `savedDom`). Internal to the audio-rebuild path. */
    _isSlotAudioSuppressed(slot) {
        if (!this._occupiedRemoteSlots.has(slot)) return false;
        for (const b of this._remoteBindings.values()) {
            if (b.slot === slot && b.suppressAudio) return true;
        }
        return false;
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
        // so the user doesn't see a flash, and recover its savedDom.
        const previous = this._remoteBindings.get(peerKey);
        let savedDom = previous?.savedDom ?? null;
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
                savedDom = savedDom ?? b.savedDom;
            }
        }

        this._occupiedRemoteSlots.add(slot);

        // Pull the local DomRenderer (if any) out of the active target
        // list — the remote now drives this slot's visual. The renderer
        // instance survives in savedDom for restore on unbind.
        const localDom = savedDom ?? this.findTarget(slot, 'dom');
        if (localDom && this.targets.includes(localDom)) {
            this.removeTarget(localDom);
            // Master skips the wasted work on an invisible subtree —
            // world commands and the culling loop both early-exit on
            // the now-empty sceneState arrays after clear().
            localDom.clear();
            // Mark the pane inactive so CSS hides it (the sceneEl is
            // empty now). Flips back to "true" on the unbind grace-
            // expiry path when loadMap rebuilds the scene.
            localDom.paneEl.dataset.active = 'false';
            this._publishActiveRendererCount();
        }

        const sink = new RenderSink(transport, slot);
        this.addTarget(sink);

        this._remoteBindings.set(peerKey, {
            slot,
            sink,
            savedDom: localDom ?? null,
            unbindGraceTimer: null,
            suppressAudio,
        });

        // Reconcile audio listeners against the new binding state. If
        // suppressAudio was set, the listener at this slot is now
        // dropped from the target list and the surviving listeners'
        // pan mode is recomputed (split L/R → solo bearing-pan when
        // one of two slots becomes suppressed).
        if (suppressAudio) this._rebuildAudioTargets();

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
     *
     * Optional `onGraceRebuilt(renderer)` callback fires once the
     * post-grace rebuild completes. Game-side code (master.js) uses it
     * to re-fire per-player setup that the original level-load fan-out
     * landed only on renderers existing at the time (createPlayerSprite
     * for cross-pane billboards). No callback fires if the slot had no
     * local DomRenderer (savedTarget was null) or if a reconnect
     * cancelled the grace timer.
     */
    unbindRemoteSlot(peerKey, { onGraceRebuilt } = {}) {
        const binding = this._remoteBindings.get(peerKey);
        if (!binding) return;

        const { slot, sink, savedDom, suppressAudio } = binding;

        // Pull the sink so master's per-frame commands stop forwarding
        // to a vanished peer.
        this.removeTarget(sink);
        this._occupiedRemoteSlots.delete(slot);

        // Restore the local DomRenderer immediately so master's per-frame
        // commands keep its DOM in sync; visual unhide is deferred via
        // grace so a quick reconnect doesn't flash the pane visible.
        if (savedDom) this.addTarget(savedDom);

        // Reconcile audio: the slot is no longer remote-owned (we just
        // dropped it from `_occupiedRemoteSlots`), so `_isSlotAudioSuppressed`
        // returns false for it and the rebuild brings the listener back.
        // The binding itself stays in `_remoteBindings` during grace so
        // a mid-grace reconnect can recover savedDom; the suppressAudio
        // flag on it is meaningless once the slot is unoccupied.
        if (suppressAudio) this._rebuildAudioTargets();

        if (binding.unbindGraceTimer) clearTimeout(binding.unbindGraceTimer);
        binding.unbindGraceTimer = setTimeout(async () => {
            // If a reconnect arrived during grace, bindRemoteSlot
            // cancelled this timer and we never reach this body.
            this._remoteBindings.delete(peerKey);
            if (!savedDom) return;
            // `reload()` rebuilds against the map this renderer last
            // loaded — the renderer owns that memory so the
            // orchestrator doesn't need to import the maps layer.
            // Await so onGraceRebuilt fires with a fully-built scene.
            await savedDom.reload();
            // Re-mark the pane as active so CSS reveals it (the
            // sceneEl is repopulated by reload above). Done after
            // reload so the pane doesn't flash empty during the
            // rebuild — but reload is fast enough on master that
            // the gap is imperceptible.
            savedDom.paneEl.dataset.active = 'true';
            this._publishActiveRendererCount();
            onGraceRebuilt?.(savedDom);
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
// `playerIndex` matches. In normal modes a single DomRenderer matches;
// in mirror SP two DomRenderers share playerIndex 0 and both receive
// the call; in Network DM a RenderSink at the player's slot forwards
// to the wire; with AudioRenderer as a target the matching listener
// also receives the call (e.g. updateCamera keeps its state.camera in
// sync). Each target's prototype-bound method decides what its kind
// does with the call.
for (const name of Object.keys(PER_PANE_COMMANDS)) {
    Orchestrator.prototype[name] = function (playerIndex, ...args) {
        for (const t of this.targets) {
            if (t.playerIndex !== playerIndex) continue;
            t[name]?.(...args);
        }
    };
}

// World commands: iterate every target. Each DomRenderer runs the impl
// against itself; each RenderSink forwards to the wire (its client's
// own orchestrator then iterates its own targets). AudioRenderer has
// no world commands today, but the optional-chaining handles any kind
// that doesn't expose a particular method.
for (const name of Object.keys(WORLD_COMMANDS)) {
    Orchestrator.prototype[name] = function (...args) {
        for (const t of this.targets) {
            t[name]?.(...args);
        }
    };
}

// World sound: hand-rolled rather than registry-driven because the
// dispatch is intrinsically per-kind — only AudioRenderers actually
// emit sound (each runs its own distance/pan math from its listener
// state); DomRenderers ignore it. Sinks still forward via the standard
// CMD_WORLD envelope (the receiving window's orchestrator dispatches
// through this same method, where its own AudioRenderers handle the
// playback). Both call sites — local game code and incoming wire from
// a joiner — use one entry point so any dispatch goes to every target
// kind that cares.
Orchestrator.prototype.playSound = function (name, opts) {
    for (const t of this.targets) {
        if (t.kind === 'audio') t.playSound(name, opts);
        else if (t.kind === 'sink') t.forwardWorld('playSound', [name, opts]);
    }
};

// Stateful overlay commands — when called WITHOUT a payload (game code
// signalling "show what's current"), the orchestrator pulls a fresh
// payload from the registered provider (Game). When called WITH a
// payload (RenderClient dispatching an incoming wire envelope on a
// joiner — see transport/render-client.js::_dispatchWorldCommand),
// the explicit arg wins. This dual-path lets a master signal and a
// joiner receive go through the same method without the joiner trying
// to pull from a provider it doesn't have.
//
// Pulling at dispatch time on master means live fires AND joiner-
// reconnect re-fires share one data source, so they can't drift; no
// caller carries a payload that goes stale before it's sent.
//
// The hide* commands keep the generic wrapper — they're pure signals
// with no associated data.
const OVERLAY_PULLERS = {
    showResults:      'getResultsPayload',
    showIntermission: 'getIntermissionPayload',
    showLobby:        'getLobbyPayload',
};

for (const [name, pull] of Object.entries(OVERLAY_PULLERS)) {
    Orchestrator.prototype[name] = function (payload) {
        if (payload === undefined) payload = this._provider?.[pull]?.();
        for (const t of this.targets) {
            t[name]?.(payload);
        }
    };
}

/**
 * loadMap is a world command — every target receives it — but unlike
 * the generic fan-out we need to AWAIT every local renderer's scene
 * build so callers (Level.load) can synchronize on "all panes built."
 * Each DomRenderer's loadMap returns a Promise (buildScene is async);
 * each RenderSink's loadMap returns undefined (the wire envelope is
 * fire-and-forget). Promise.all accepts non-Promise values
 * transparently, so we await DomRenderers and ignore Sinks — joiner
 * completion is signalled separately via MSG.READY_TO_PLAY, posted
 * by the joiner's RenderClient after its local scene rebuild resolves.
 *
 * Assignment is placed AFTER the generic world-command binding loop
 * (which unconditionally writes Orchestrator.prototype.loadMap from
 * WORLD_COMMANDS) so this explicit version wins.
 */
Orchestrator.prototype.loadMap = function (name) {
    const promises = [];
    for (const t of this.targets) {
        promises.push(t.loadMap?.(name));
    }
    return Promise.all(promises);
};

/** Re-fire whichever overlay the provider says is currently visible,
 *  targeted at a single render target instead of fanning to all. Used
 *  by master.js's onReady to catch a freshly-bound joiner up to the
 *  current visible state without re-rendering existing clients'
 *  overlays. */
Orchestrator.prototype.replayCurrentOverlayTo = function (target) {
    if (!target) return;
    const cmd = this._provider?.getCurrentOverlay?.();
    if (!cmd) return;
    const pull = OVERLAY_PULLERS[cmd];
    if (!pull) return;
    target[cmd]?.(this._provider[pull]());
};

export const orchestrator = new Orchestrator();
