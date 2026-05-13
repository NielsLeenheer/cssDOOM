/**
 * Audio playback using the Web Audio API.
 *
 * Two play modes, both invoked via `orchestrator.playSound(name, opts)` —
 * game code never imports from this file directly.
 *
 *   - World sound  (opts has x, y): each local `AudioRenderer` computes
 *     its own volume + pan from its listener's position. Volume falls
 *     off with distance to the listener; pan is either bearing-based
 *     (solo mode) or locked to pane side (split-screen).
 *   - UI sound     (opts.ui === true): plays once centered through the
 *     master mix, full volume. No positional math, no per-listener
 *     iteration.
 *
 * One `AudioRenderer` per local listener. `configureAudio(slotCount)`
 * (re)builds the renderer list — solo gets one bearing-pan renderer;
 * split-screen gets one pane-side renderer per slot.
 *
 * Buffers are fetched + decoded on first use and cached. iOS Safari
 * requires a user gesture to unlock the AudioContext; global listeners
 * handle this at module load.
 */

import { rendererState } from '../renderer/renderer-state.js';

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
     * @param {number} cfg.slot        rendererState.cameras index this listener reads from
     * @param {'left'|'right'|null} cfg.paneSide  if set, pan locks to this side;
     *                                            null = bearing-based.
     */
    constructor({ slot, paneSide }) {
        this.slot = slot;
        this.paneSide = paneSide;
    }

    play(name, x, y) {
        const listener = rendererState.cameras[this.slot];
        if (!listener) return;
        const dx = x - listener.x;
        const dy = y - listener.y;
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
 * (Re)build the listener list for the current mode.
 *
 *   slotCount === 1  → one renderer, bearing-based pan (solo)
 *   slotCount >= 2   → one renderer per slot, locked to L/R pane side
 *                       (split-screen layout)
 *
 * Called by `applyMode` whenever the player roster resizes. Cheap; the
 * renderer instances themselves hold no Web Audio nodes — those are
 * created per-sound in playBuffer.
 */
export function configureAudio(slotCount) {
    if (!enabled) {
        renderers = [];
        return;
    }
    const split = slotCount >= 2;
    renderers = [];
    for (let i = 0; i < slotCount; i++) {
        const paneSide = split ? (i === 0 ? 'left' : 'right') : null;
        renderers.push(new AudioRenderer({ slot: i, paneSide }));
    }
}

/**
 * Master switch — when false, every playSound becomes a no-op.
 * Used by the Local DM secondary window (Phase 3) so master and
 * secondary don't double-play through the same room speakers.
 */
export function setAudioEnabled(value) {
    enabled = value;
    if (!enabled) renderers = [];
}

/**
 * Play a sound locally. Called from `orchestrator.playSound` after it
 * decides whether to also broadcast to clients (world only, not UI).
 *
 * @param {string} name
 * @param {{x: number, y: number} | {ui: true}} opts
 */
export function playLocal(name, opts) {
    if (!enabled || !ctx || !unlocked) return;
    if (!opts) return;
    if (opts.ui) {
        playBuffer(name, 1.0, 0);
        return;
    }
    // World sound — fan out to every local listener.
    for (const r of renderers) {
        r.play(name, opts.x, opts.y);
    }
}
