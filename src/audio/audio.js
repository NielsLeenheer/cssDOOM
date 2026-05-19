/**
 * Audio playback using the Web Audio API.
 *
 * `AudioRenderer` is an orchestrator render target alongside DomRenderer
 * and RenderSink. Each instance represents one local listener (one local
 * player's pane). The orchestrator's per-pane updateCamera dispatch
 * naturally lands on the AudioRenderer with the matching `playerIndex`,
 * keeping each listener's `state.camera` current. The orchestrator's
 * `playSound` dispatch fans to every audio target locally (each runs
 * its own distance / pan math from its listener position) and to every
 * RenderSink over the wire (the receiving window's orchestrator then
 * fans to its own audio targets).
 *
 * Lifecycle is owned by this module: `configureAudio(slotCount)`
 * (re)builds the local listener set and (de)registers each renderer
 * with the orchestrator. `setAudioEnabled(false)` (used by the Local
 * DM secondary so master and secondary don't double-play through the
 * same speakers) deregisters every listener. The orchestrator's
 * `bindRemoteSlot` reaches in via `findTarget(slot, 'audio')` to drop
 * a single listener when a Network DM remote takes that slot — the
 * remote plays its own audio on its own device.
 *
 * Buffers are fetched + decoded on first use and cached. iOS Safari
 * requires a user gesture to unlock the AudioContext; global listeners
 * handle this at module load.
 */

import { orchestrator } from '../orchestrator.js';

// ── Web Audio context + unlock ─────────────────────────────────────────

let ctx = null;
let unlocked = false;
const bufferCache = new Map(); // sound name → Promise<AudioBuffer>

function setupUnlock() {
    const events = ['touchstart', 'touchend', 'click', 'keydown'];
    const unlock = () => {
        if (!ctx) {
            ctx = new (window.AudioContext || window.webkitAudioContext)();
        }
        if (unlocked) return;
        ctx.resume().then(() => {
            const silent = ctx.createBuffer(1, 1, 22050);
            const node = ctx.createBufferSource();
            node.buffer = silent;
            node.connect(ctx.destination);
            node.start();
            unlocked = true;
            for (const event of events) {
                document.removeEventListener(event, unlock, true);
            }
        });
    };
    for (const event of events) {
        document.addEventListener(event, unlock, true);
    }
}
setupUnlock();

function loadBuffer(name) {
    let promise = bufferCache.get(name);
    if (promise) return promise;
    promise = fetch(`assets/sounds/${name}.wav`)
        .then(response => {
            if (!response.ok) throw new Error(`fetch ${name}: ${response.status}`);
            return response.arrayBuffer();
        })
        .then(data => ctx.decodeAudioData(data))
        .catch(err => {
            console.error(`[audio] loadBuffer(${name}):`, err);
            bufferCache.delete(name); // allow retry
            return null;
        });
    bufferCache.set(name, promise);
    return promise;
}

// ── Module-level state ─────────────────────────────────────────────────

let enabled = true;
let renderers = [];
let lastSlotCount = 0;

// ── Distance + bearing math ────────────────────────────────────────────

// Maximum audible range, in world units. DOOM levels are ~5000-20000
// units across; 2000 is "same large room" range. Tune via play-testing.
const MAX_AUDIBLE = 2000;

function distanceToVolume(dist) {
    if (dist >= MAX_AUDIBLE) return 0;
    return 1 - (dist / MAX_AUDIBLE);
}

/**
 * Bearing-based pan in the listener's reference frame.
 * `sin(relative)` gives -1..+1 — natural left/right sweep that goes to
 * 0 at "directly behind" (the geometry the original DOOM never had).
 */
function bearingToPan(dx, dy, listenerAngle) {
    const worldBearing = Math.atan2(dx, dy);
    const relative = worldBearing - listenerAngle;
    return Math.sin(relative);
}

// ── AudioRenderer (per-listener) ───────────────────────────────────────

class AudioRenderer {
    /**
     * @param {object} cfg
     * @param {number} cfg.slot        listener slot. Per-pane updateCamera
     *                                 commands at this slot keep
     *                                 `this.state.camera` current via the
     *                                 orchestrator's playerIndex match.
     * @param {'left'|'right'|null} cfg.paneSide  if set, pan locks to this side;
     *                                            null = bearing-based.
     */
    constructor({ slot, paneSide }) {
        // Orchestrator target identity. `kind` distinguishes audio
        // targets from DomRenderer ('dom') and RenderSink ('sink') in
        // dispatch sites that branch on the kind. `playerIndex` is
        // what per-pane dispatch matches against.
        this.kind = 'audio';
        this.playerIndex = slot;

        this.paneSide = paneSide;
        // Per-listener world view. Only x/y/angle are read in play();
        // kept narrow rather than mirroring DomRenderer's full 6
        // fields. updateCamera() below writes these from incoming
        // per-pane command dispatches.
        this.state = { camera: { x: 0, y: 0, angle: 0 } };
    }

    /**
     * Per-pane updateCamera dispatch addressed to this listener's slot.
     * Method name + payload shape match the wire-format args RenderSink
     * sends (stripped player transform), so a joiner's local
     * AudioRenderer receives the same call shape that master's does.
     */
    updateCamera(transform) {
        if (!transform) return;
        const cam = this.state.camera;
        cam.x = transform.x;
        cam.y = transform.y;
        cam.angle = transform.angle;
    }

    /**
     * World playSound dispatch. Computes volume from distance and pan
     * from listener-bearing (or locked pane side in split-screen),
     * then schedules a Web Audio playback. Out-of-range sounds drop
     * silently. UI sounds are not modelled here — every sound has a
     * world position.
     */
    playSound(name, opts) {
        if (!enabled || !ctx || !unlocked) return;
        if (!opts) return;
        const listener = this.state.camera;
        const dx = opts.x - listener.x;
        const dy = opts.y - listener.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const volume = distanceToVolume(dist);
        if (volume <= 0) return;
        const pan = this.paneSide === 'left' ? -1
                  : this.paneSide === 'right' ? 1
                  : bearingToPan(dx, dy, listener.angle);
        playBuffer(name, volume, pan);
    }
}

// Per-sound nodes, computed at play time so concurrent sounds don't
// stomp on each other's gain/pan values.
function playBuffer(name, volume, pan) {
    if (!ctx) return;
    loadBuffer(name).then(buffer => {
        if (!buffer || !ctx) return;
        const src = ctx.createBufferSource();
        src.buffer = buffer;
        const gain = ctx.createGain();
        gain.gain.value = volume;
        const panner = ctx.createStereoPanner();
        panner.pan.value = pan;
        src.connect(panner);
        panner.connect(gain);
        gain.connect(ctx.destination);
        src.start();
    });
}

// ── Public API ─────────────────────────────────────────────────────────

/**
 * (Re)build the listener list for the current mode and sync each
 * renderer's membership in the orchestrator's target list. Listener
 * count drives the pan mode:
 *
 *   count === 1  → one renderer, bearing-based pan (solo)
 *   count >= 2   → one renderer per slot, locked to L/R pane side
 *                  (Local DM split-screen)
 *
 * Slots currently bound to a Network DM remote get pruned afterwards:
 * `bindRemoteSlot` will remove the renderer for that slot via
 * `orchestrator.removeTarget(findTarget(slot, 'audio'))` so the same
 * mechanism handles bind-before-configure and configure-after-bind.
 *
 * Called by `applyMode` whenever the player roster resizes and by
 * `master.js`'s onJoin handler. Cheap — renderer instances hold no
 * Web Audio nodes; those are created per-sound in `playBuffer`.
 */
export function configureAudio(slotCount) {
    lastSlotCount = slotCount;
    rebuildRenderers();
}

function rebuildRenderers() {
    // Drop the previous generation of listeners from the orchestrator
    // before replacing them. Defensive removeTarget is safe — it
    // no-ops on missing entries (e.g. a slot that bindRemoteSlot
    // already pulled out).
    for (const r of renderers) orchestrator.removeTarget(r);
    renderers = [];

    if (!enabled) return;

    // Skip slots a Network DM remote currently owns audio for — that
    // peer plays its own sounds on its own device. Without the skip,
    // a configureAudio call after the bind would resurrect a listener
    // bindRemoteSlot just dropped. `split` keys off the EFFECTIVE
    // listener count after suppression so a Network DM master with 1
    // local + 1 remote keeps its solo listener on bearing-pan instead
    // of locking to one side.
    const activeSlots = [];
    for (let slot = 0; slot < lastSlotCount; slot++) {
        if (orchestrator.isSlotAudioSuppressed(slot)) continue;
        activeSlots.push(slot);
    }
    const split = activeSlots.length >= 2;
    activeSlots.forEach((slot, idx) => {
        const paneSide = split ? (idx === 0 ? 'left' : 'right') : null;
        const renderer = new AudioRenderer({ slot, paneSide });
        renderers.push(renderer);
        orchestrator.addTarget(renderer);
    });
}

/**
 * Master switch — when false, every listener is dropped from the
 * orchestrator so world `playSound` dispatch can't reach an audio
 * target on this window. Used by the Local DM secondary so master
 * and secondary don't double-play through the same room speakers.
 */
export function setAudioEnabled(value) {
    if (enabled === value) return;
    enabled = value;
    rebuildRenderers();
}

/**
 * Rebuild the listener set from the last configured slot count and
 * the orchestrator's current per-slot suppression state. Called by
 * `bindRemoteSlot` / `unbindRemoteSlot` when suppression toggles so
 * the surviving listener's pan mode picks up the new effective count
 * (split-pan with 2 active → bearing-pan with 1).
 */
export function refreshAudioRenderers() {
    rebuildRenderers();
}
