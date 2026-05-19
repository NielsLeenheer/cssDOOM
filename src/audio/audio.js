/**
 * Audio playback using the Web Audio API.
 *
 * `AudioRenderer` is an orchestrator render target alongside DomRenderer
 * and RenderSink. Each instance represents one local listener (one local
 * player's pane). Per-pane `updateCamera` dispatch lands on the renderer
 * with the matching `playerIndex` (orchestrator-side fan-out keeps its
 * `state.camera` current). World `playSound` dispatch fans to every
 * audio target locally (each runs its own distance / pan math) and to
 * every RenderSink over the wire (the receiving window's orchestrator
 * fans to its own audio targets).
 *
 * **Lifecycle is owned by the orchestrator.** `orchestrator.configureAudio`
 * (re)builds the local listener set; `orchestrator.setAudioEnabled`
 * toggles the master switch. This module only provides the class plus
 * the Web Audio plumbing it uses internally — there are no module-level
 * lifecycle exports.
 *
 * Buffers are fetched + decoded on first use and cached. iOS Safari
 * requires a user gesture to unlock the AudioContext; global listeners
 * handle this at module load.
 */

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

// ── AudioRenderer (per-listener) ───────────────────────────────────────

export class AudioRenderer {
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
        // Per-listener world view. Only x/y/angle are read in playSound();
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
     * from listener-bearing (or locked pane side in split-screen), then
     * schedules a Web Audio playback. Out-of-range sounds drop silently.
     * Disabled / suppressed-slot listeners aren't in the orchestrator's
     * target list at all, so this never fires for them.
     */
    playSound(name, opts) {
        if (!ctx || !unlocked || !opts) return;
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
