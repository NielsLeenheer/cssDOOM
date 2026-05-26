/**
 * Web Audio plumbing for cssDOOM — AudioContext lifecycle, buffer
 * fetching, and the distance/pan math the listener uses. No renderer
 * concept here; the per-listener target lives in
 * [renderer.js](renderer.js) and imports from this module.
 *
 * iOS Safari requires a user gesture to unlock the AudioContext;
 * global listeners installed at module load handle this.
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

/** True iff the AudioContext exists and the user-gesture unlock has
 *  fired. Listeners use this to short-circuit per-frame distance math
 *  before audio is playable. */
export function isAudioReady() {
    return !!ctx && unlocked;
}

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

// Per-sound nodes, computed at play time so concurrent sounds don't
// stomp on each other's gain/pan values.
export function playBuffer(name, volume, pan) {
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

// ── Distance + bearing math ────────────────────────────────────────────

// Maximum audible range, in world units. DOOM levels are ~5000-20000
// units across; 2000 is "same large room" range. Tune via play-testing.
const MAX_AUDIBLE = 2000;

export function distanceToVolume(dist) {
    if (dist >= MAX_AUDIBLE) return 0;
    return 1 - (dist / MAX_AUDIBLE);
}

/**
 * Bearing-based pan in the listener's reference frame.
 * `sin(relative)` gives -1..+1 — natural left/right sweep that goes to
 * 0 at "directly behind" (the geometry the original DOOM never had).
 */
export function bearingToPan(dx, dy, listenerAngle) {
    const worldBearing = Math.atan2(dx, dy);
    const relative = worldBearing - listenerAngle;
    return Math.sin(relative);
}
