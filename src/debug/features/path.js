/**
 * Player-path record / replay — segment-based, for hand-scripted talk visuals.
 *
 * Recording is a SESSION split into SEGMENTS. You walk the player around (live
 * input); a top-centre transport panel lets you cut segments, pause, review,
 * redo, and stop. Each segment is an independent playable path. Replay moves
 * the PLAYER (state.players[0]) along a path while the game loop runs — the
 * camera follows because renderAllActivePanes() pushes it from the player,
 * and AI / triggers see the player move. Floor/z derive from the map.
 *
 * Transport (panel buttons; also on debug.path.*):
 *   recording:  Mark (cut a segment, keep going) · Pause (cut + pause) · Stop
 *   paused:     Rewind (jump to start of last segment, arms overwrite) ·
 *               Review (replay last segment) ·
 *               Continue (resume; snaps to the last segment's END so segments
 *                 join — unless you just Rewound, then it re-records over the
 *                 last segment) · Stop
 *
 * Capture runs at ~30fps and records every frame, including any standing-
 * still. play({ trim: true }) / seek({ trim: true }) drop the non-moving
 * frames at the start and end of a segment so a shot begins and ends on motion.
 *
 * Action events (USE, FIRE, weapon switches) are captured alongside the pose
 * and re-emitted on the input bus at the right moment during play(), so a
 * replayed walk opens the same doors and fires the same shots it did live.
 *
 * Exposed as debug.path.* in console.js.
 */

import { state } from '../../game/state.js';
import { EYE_HEIGHT } from '../../shared/constants.js';
import { getFloorHeightAt } from '../../game/physics.js';
import { orchestrator } from '../../orchestrator.js';
import * as A from '../../input/actions.js';
import { on, emit } from '../../input/event-bus.js';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const POS_EPS = 0.1;   // "moving" thresholds used by the play() trim
const ANG_EPS = 0.002;

// Action events captured alongside the pose during a recording and re-emitted
// on playback, so a replayed walk opens the same doors / fires the same shots
// it did live. UI actions (menu toggle, kbm swap) are deliberately excluded.
const RECORDED_ACTIONS = [A.USE, A.FIRE_DOWN, A.FIRE_UP, A.WEAPON_SELECT, A.WEAPON_PREV, A.WEAPON_NEXT];

// Sample at ~30fps regardless of refresh rate. The -4ms margin reliably
// catches the every-other-frame on a 60Hz display (which lands ~33ms apart).
const SAMPLE_INTERVAL_MS = 1000 / 30 - 4;

const pose = (p) => ({ x: round(p.x), y: round(p.y), angle: round(p.angle, 4) });

/** Snap the player to a pose (instant); the game loop renders it next frame. */
function setPlayer({ x, y, angle }) {
    const p = state.players[0];
    p.x = x;
    p.y = y;
    p.angle = angle;
    p.floorHeight = getFloorHeightAt(x, y);
    p.z = p.floorHeight + EYE_HEIGHT;
}

/** Flag the player moving (or not) during replay, so the walk cycle plays —
 *  replay sets position directly, so the normal input-driven movement state in
 *  movement.js never fires. Mirrors its setPlayerMoving (drives `.renderer.moving`
 *  → the spectator #player sprite + head/weapon bob) and setThingMoving (the
 *  opposing-player billboard in DM). Only toggles `.moving`; the gameloop's
 *  updateMovingState only re-dispatches on a change, so an idle keyboard won't
 *  fight it. */
function setPlaybackMoving(moving) {
    const p = state.players[0];
    if (!p) return;
    orchestrator.dispatch({ type: 'player', slot: p.viewportIndex, cmd: 'setPlayerMoving', args: [moving] });
    if (p.thingIndex >= 0) {
        orchestrator.dispatch({ type: 'world', cmd: 'setThingMoving', args: [p.thingIndex, moving] });
    }
}

// ── Recording session ──────────────────────────────────────────────────────
// rec while active:
//   segments — finished segments, each { samples: [{t,x,y,angle}], events: [{t,kind,…}] }
//   cur      — in-progress segment { samples, events, t0, lastMs }
//   paused, rewound, rafId, unsubs (action-bus subscriptions)
let rec = null;
let lastSession = null;  // { segments } after stop()

function startSegment() {
    // Record from the current pose immediately. Every frame is captured,
    // including any standing-still — play({ trim: true }) drops the
    // non-moving frames at the start/end.
    const now = performance.now();
    rec.cur = { samples: [{ t: 0, ...pose(state.players[0]) }], events: [], t0: now, lastMs: now };
}

function finalizeSegment() {
    if (rec.cur?.samples.length) rec.segments.push({ samples: rec.cur.samples, events: rec.cur.events });
    rec.cur = null;
}

/** Capture an action event into the current segment at its relative time.
 *  Subscribed at high priority and never consumes, so gameplay is unaffected;
 *  ignores events while paused (e.g. during a review() replay). */
function recordEvent(event) {
    if (!rec || rec.paused || !rec.cur) return;
    const e = { t: Math.round(performance.now() - rec.cur.t0), kind: event.kind, slot: event.slot, deviceId: event.deviceId };
    if (event.weapon != null) e.weapon = event.weapon;
    rec.cur.events.push(e);
}

function sampleFrame() {
    if (!rec || rec.paused || !rec.cur) return;
    rec.rafId = requestAnimationFrame(sampleFrame);

    // Throttle to ~30fps; record every frame from there.
    const now = performance.now();
    if (now - rec.cur.lastMs < SAMPLE_INTERVAL_MS) return;
    rec.cur.lastMs = now;
    rec.cur.samples.push({ t: Math.round(now - rec.cur.t0), ...pose(state.players[0]) });
}

function startSampling() { rec.rafId = requestAnimationFrame(sampleFrame); }
function stopSampling() { if (rec?.rafId) cancelAnimationFrame(rec.rafId); if (rec) rec.rafId = null; }

/** Start a recording session (opens the transport panel). */
export function record() {
    if (rec) { console.warn('[path] already recording'); return; }
    rec = { segments: [], cur: null, paused: false, rewound: false, rafId: null, unsubs: [] };
    startSegment();
    startSampling();
    // Observe the gameplay action bus (high priority, non-consuming) to capture
    // doors / fire / weapon switches alongside the pose.
    rec.unsubs = RECORDED_ACTIONS.map(kind => on(kind, recordEvent, { priority: 10_000 }));
    buildPanel();
    console.log('[path] recording — transport top-centre. Walk to record; mark / pause / stop.');
}

/** Cut the current segment and start the next, without stopping. */
export function mark() {
    if (!rec || rec.paused) { console.warn('[path] not recording'); return; }
    finalizeSegment();
    startSegment();
    updatePanel();
    console.log(`[path] cut — ${rec.segments.length} segment(s)`);
}

/** End the current segment and pause sampling. */
export function pause() {
    if (!rec || rec.paused) { console.warn('[path] not recording'); return; }
    finalizeSegment();
    stopSampling();
    rec.paused = true;
    rec.rewound = false;
    updatePanel();
    console.log(`[path] paused — ${rec.segments.length} segment(s). Review / Continue / Rewind.`);
}

/** Resume recording. Snaps to the last segment's end (join) — unless Rewound,
 *  in which case it drops the last segment and re-records over it. */
export function resume() {
    if (!rec || !rec.paused) { console.warn('[path] not paused'); return; }
    if (rec.rewound) {
        const seg = rec.segments.pop();      // overwrite: re-record from its start
        if (seg) setPlayer(seg.samples[0]);
        rec.rewound = false;
        console.log('[path] redo — overwriting last segment');
    } else {
        const last = rec.segments.at(-1);
        if (last) setPlayer(last.samples.at(-1));  // join at the last segment's end
    }
    startSegment();
    rec.paused = false;
    startSampling();
    updatePanel();
}

/** Jump the player to the start of the last segment and arm overwrite. */
export function rewind() {
    if (!rec || !rec.paused) { console.warn('[path] not paused'); return; }
    const last = rec.segments.at(-1);
    if (!last) { console.warn('[path] no segment to rewind'); return; }
    setPlayer(last.samples[0]);
    rec.rewound = true;
    updatePanel();
    console.log('[path] rewound — Continue to overwrite this segment, Review to watch it');
}

/** Replay the last segment (player walks it) to review it. */
export function review() {
    if (!rec || !rec.paused) { console.warn('[path] not paused'); return; }
    const last = rec.segments.at(-1);
    if (!last) { console.warn('[path] no segment to review'); return; }
    rec.rewound = false;  // watching to the end = keeping it
    updatePanel();
    return play({ samples: last.samples, events: last.events });
}

/** Finish the session; returns { segments }. */
export function stop() {
    if (!rec) { console.warn('[path] not recording'); return null; }
    if (!rec.paused) { finalizeSegment(); stopSampling(); }
    rec.unsubs?.forEach(u => u());
    lastSession = { segments: rec.segments };
    destroyPanel();
    const n = lastSession.segments.length;
    rec = null;
    console.log(`[path] stopped — ${n} segment(s). export() / save("slot") / play(segment).`);
    return lastSession;
}

// ── Storage / export ───────────────────────────────────────────────────────
const KEY = (slot) => `cssdoom-path-${slot}`;

/** Save a session (default: the last recorded) to localStorage. */
export function save(slot, session = lastSession) {
    if (!session?.segments?.length) { console.warn('[path] nothing to save — record() first'); return; }
    localStorage.setItem(KEY(slot), JSON.stringify(session));
    console.log(`[path] saved "${slot}" — ${session.segments.length} segment(s)`);
}

/** Load a saved session from localStorage. */
export function load(slot) {
    const json = localStorage.getItem(KEY(slot));
    if (!json) { console.warn(`[path] no saved path "${slot}"`); return null; }
    return JSON.parse(json);
}

/** Dump a path session as JSON to the console + clipboard for safekeeping — the
 *  last recorded session, or a saved slot by name (export('slot')). It's the
 *  same { segments } shape save() stores, so it round-trips: keep the JSON in a
 *  file, then import('slot', json) to restore it. Returns the JSON string. */
export function exportPath(slotOrSession = lastSession) {
    const session = typeof slotOrSession === 'string' ? load(slotOrSession) : slotOrSession;
    if (!session?.segments?.length) { console.warn('[path] nothing to export'); return null; }
    const json = JSON.stringify(session);
    console.log(json);
    navigator.clipboard?.writeText(json).then(() => console.log('[path] copied to clipboard'), () => {});
    return json;
}

/** Restore an exported session JSON into a saved slot (the inverse of export()).
 *  Validates it parses to a { segments } session before writing localStorage. */
export function importPath(slot, json) {
    if (typeof json !== 'string' || !json) { console.warn('[path] import needs the JSON string'); return; }
    let session;
    try { session = JSON.parse(json); } catch { console.warn('[path] import — invalid JSON'); return; }
    if (!session?.segments?.length) { console.warn('[path] import — not a path session'); return; }
    localStorage.setItem(KEY(slot), json);
    console.log(`[path] imported into "${slot}" — ${session.segments.length} segment(s)`);
}

// ── Replay ───────────────────────────────────────────────────────────────
/** Shortest-route angle interpolation (wraps through ±π). */
function lerpAngle(a, b, f) {
    let d = (b - a) % (2 * Math.PI);
    d = (d + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    return a + d * f;
}

/** Sample (x, y, angle) at time t by interpolating the bracketing samples. */
function sampleAt(samples, t) {
    if (t <= samples[0].t) return samples[0];
    if (t >= samples.at(-1).t) return samples.at(-1);
    let lo = 0, hi = samples.length - 1;
    while (hi - lo > 1) {
        const mid = (lo + hi) >> 1;
        if (samples[mid].t <= t) lo = mid; else hi = mid;
    }
    const a = samples[lo], b = samples[hi];
    const f = (t - a.t) / (b.t - a.t || 1);
    return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        angle: lerpAngle(a.angle, b.angle, f),
    };
}

/** Index range [start, end] of the first and last MOVING frames — what trim
 *  keeps. Returns the full range if the segment never moves. */
function trimWindow(samples) {
    if (samples.length < 2) return { start: 0, end: samples.length - 1 };
    const moving = (a, b) =>
        Math.abs(a.x - b.x) > POS_EPS ||
        Math.abs(a.y - b.y) > POS_EPS ||
        Math.abs(a.angle - b.angle) > ANG_EPS;
    let start = 0;
    while (start < samples.length - 1 && !moving(samples[start], samples[start + 1])) start++;
    let end = samples.length - 1;
    while (end > 0 && !moving(samples[end], samples[end - 1])) end--;
    if (start >= end) return { start: 0, end: samples.length - 1 };
    return { start, end };
}

/** Drop leading/trailing non-moving frames and re-base time to 0. Keeps the
 *  pose just before the first move and the frame the last move lands on, so a
 *  shot starts and ends on motion. Returns the list unchanged if it never moves. */
function trimSamples(samples) {
    if (samples.length < 2) return samples;
    const { start, end } = trimWindow(samples);
    const t0 = samples[start].t;
    return samples.slice(start, end + 1).map(s => ({ ...s, t: s.t - t0 }));
}

/** Shift / filter recorded events to match a trim of `samples` (the only opt
 *  that changes timing): events outside the kept window drop, the rest re-base
 *  by the same offset so they stay aligned with the trimmed poses. */
function processEvents(events, samples, opts = {}) {
    if (!events?.length || !opts.trim) return events ?? [];
    const { start, end } = trimWindow(samples);
    const t0 = samples[start].t, t1 = samples[end].t;
    return events.filter(e => e.t >= t0 && e.t <= t1).map(e => ({ ...e, t: e.t - t0 }));
}

const DEG = Math.PI / 180;

/** Box-blur x / y / angle over a window of `n` frames (clamped at the ends).
 *  Angle is averaged shortest-route via sin/cos so it doesn't tear at the ±π
 *  wrap. Takes the human jitter out of a recorded walk. n <= 1 is a no-op. */
function smoothSamples(samples, n) {
    if (!(n > 1) || samples.length < 3) return samples;
    const k = Math.floor(n / 2);
    return samples.map((s, i) => {
        let sx = 0, sy = 0, sin = 0, cos = 0, c = 0;
        for (let j = Math.max(0, i - k); j <= Math.min(samples.length - 1, i + k); j++) {
            sx += samples[j].x; sy += samples[j].y;
            sin += Math.sin(samples[j].angle); cos += Math.cos(samples[j].angle);
            c++;
        }
        return { ...s, x: sx / c, y: sy / c, angle: Math.atan2(sin / c, cos / c) };
    });
}

/** Bend a path so it starts / ends exactly on the given poses, spreading the
 *  correction across the WHOLE segment (weighted by normalized time) so the
 *  motion drifts smoothly onto the target instead of snapping. `start` / `end`
 *  are { x?, y?, angle? } with angle in DEGREES; any field may be omitted.
 *  Position deltas blend start→end along the path; angle eases shortest-route. */
function retargetSamples(samples, start, end) {
    if ((!start && !end) || samples.length < 2) return samples;
    const t0 = samples[0].t;
    const span = (samples.at(-1).t - t0) || 1;
    const s0 = samples[0], e0 = samples.at(-1);
    const num = (v) => typeof v === 'number';
    const pin = (target, actual) => (target != null && num(target)) ? target - actual : 0;
    const dsx = start ? pin(start.x, s0.x) : 0;
    const dsy = start ? pin(start.y, s0.y) : 0;
    const dex = end ? pin(end.x, e0.x) : 0;
    const dey = end ? pin(end.y, e0.y) : 0;
    // Shortest-route angle deltas, targets given in degrees.
    const angDelta = (deg, from) => {
        let d = (deg * DEG - from) % (2 * Math.PI);
        return (d + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
    };
    const dsa = start && num(start.angle) ? angDelta(start.angle, s0.angle) : 0;
    const dea = end && num(end.angle) ? angDelta(end.angle, e0.angle) : 0;
    return samples.map(s => {
        const w = (s.t - t0) / span;          // 0 at start → 1 at end
        return {
            ...s,
            x: s.x + dsx * (1 - w) + dex * w,
            y: s.y + dsy * (1 - w) + dey * w,
            angle: s.angle + dsa * (1 - w) + dea * w,
        };
    });
}

/** Shared seek/play post-processing, applied in order: trim → smooth →
 *  retarget. opts: { trim, smooth, start, end } (see play()). Returns a new
 *  sample list; the stored session is never mutated. */
function processSamples(samples, opts = {}) {
    if (opts.trim) samples = trimSamples(samples);
    if (opts.smooth) samples = smoothSamples(samples, opts.smooth);
    if (opts.start || opts.end) samples = retargetSamples(samples, opts.start, opts.end);
    return samples;
}

/** Resolve a path argument to a flat sample list. `path` is a path object
 *  { samples }, a session { segments } (use opts.segment, default first), or a
 *  saved slot name. */
function resolveSamples(path, opts = {}) {
    if (typeof path === 'string') path = load(path);
    if (path?.segments) return path.segments[opts.segment ?? 0]?.samples;
    return path?.samples;
}

/**
 * Teleport the player to a path's start frame (or any time via opts.t),
 * without playing. Use it to pre-position the camera for a shot, hold, then
 * play() — which continues seamlessly from there. Shares play()'s
 * post-processing opts (trim / smooth / start / end), so pass the SAME ones to
 * both and the seeked pose matches where the played path begins:
 *
 *   debug.path.seek('walk', { segment: 1 });   // jump to its first frame
 *   await delay(3000);                          // hold the shot
 *   await debug.path.play('walk', { segment: 1 });
 */
export function seek(path, opts = {}) {
    let samples = resolveSamples(path, opts);
    if (!samples?.length) { console.warn('[path] nothing to seek'); return; }
    samples = processSamples(samples, opts);
    setPlayer(sampleAt(samples, opts.t ?? 0));
}

/**
 * Move the player along a path while the game loop runs, re-emitting its
 * recorded actions (doors / fire / weapon switches) at their moments. `path`
 * may be a path object { samples, events }, a whole session { segments } (plays
 * each in order), or a saved slot name. opts: { speed = 1, segment, trim,
 * smooth, start, end }:
 *   segment — 0-based index to play just one segment
 *   trim    — drop non-moving frames at the start / end of each segment
 *   smooth  — box-blur window (frames) over x / y / angle to de-jitter the walk
 *   start / end — { x?, y?, angle? } (angle in DEGREES); bend the path so it
 *     begins / lands exactly on these, spread across the whole segment
 *   moving — flag the player as moving so the walk cycle runs (spectator /
 *     3rd-person view) + head/weapon bob; off by default
 * Returns a promise that resolves when it finishes, so you can `await` it
 * between scripted steps (or not, to run it alongside other debug.* calls).
 *
 *   debug.path.play('walk')                            — whole session
 *   debug.path.play('walk', { segment: 1 })            — just the 2nd segment
 *   debug.path.play('walk', { segment: 1, trim: true }) — …trimmed to motion
 *   debug.path.play('walk', { segment: 1, smooth: 7, end: { x: 512, y: -64, angle: 90 } })
 */
export async function play(path, opts = {}) {
    if (typeof path === 'string') path = load(path);
    if (path?.segments) {                       // a session
        const pass = { speed: opts.speed, trim: opts.trim, smooth: opts.smooth, start: opts.start, end: opts.end, moving: opts.moving };
        if (opts.segment != null) {             // …play just one segment
            const seg = path.segments[opts.segment];
            if (!seg) { console.warn(`[path] no segment ${opts.segment} (have ${path.segments.length})`); return; }
            return play({ samples: seg.samples, events: seg.events }, pass);
        }
        for (const seg of path.segments) await play({ samples: seg.samples, events: seg.events }, pass);
        return;
    }
    const raw = path?.samples;
    if (!raw?.length) { console.warn('[path] nothing to play'); return; }
    const events = processEvents(path?.events, raw, opts);   // before processSamples reassigns
    const samples = processSamples(raw, opts);

    const { speed = 1 } = opts;
    const player = state.players[0];
    const t1 = samples.at(-1).t;
    const startMs = performance.now();
    let evCursor = 0;

    // Replay sets position directly, so the input-driven movement state never
    // fires. Opt in with { moving: true } to flag the player moving for the
    // duration — drives the walk cycle (spectator / 3rd-person view) and the
    // first-person head/weapon bob. Off by default (first-person shots usually
    // don't want it).
    if (opts.moving) setPlaybackMoving(true);
    return new Promise(resolve => {
        const frame = () => {
            const t = (performance.now() - startMs) * speed;
            const done = t >= t1;
            const s = sampleAt(samples, done ? t1 : t);
            // Move the player itself — the game loop's renderAllActivePanes()
            // pushes the camera from here, and AI / triggers see it move.
            player.x = s.x;
            player.y = s.y;
            player.angle = s.angle;
            player.floorHeight = getFloorHeightAt(s.x, s.y);
            player.z = player.floorHeight + EYE_HEIGHT;
            // Re-emit any actions whose moment has passed — pose is already set
            // this frame, so USE / FIRE act from the right spot.
            const now = done ? t1 : t;
            while (evCursor < events.length && events[evCursor].t <= now) {
                const e = events[evCursor++];
                emit({ kind: e.kind, slot: e.slot, deviceId: e.deviceId, ...(e.weapon != null ? { weapon: e.weapon } : {}) });
            }
            if (done) { if (opts.moving) setPlaybackMoving(false); resolve(); return; }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    });
}

/**
 * Smoothly ease the player from `start` to `end` over `duration` seconds —
 * for hand-tuned turns and tiny moves between scripted shots, when recording a
 * path would be overkill. Snaps to `start`, then eases (in-out) to `end`.
 *
 * Angles are in DEGREES (any field omitted falls back to the player's current
 * pose). `direction` ('clockwise' | 'anti-clockwise') chooses which way the
 * view rotates: anti-clockwise sweeps the angle up (the engine's increasing
 * direction), clockwise sweeps it down — so a turn is honoured even when the
 * named direction is the long way round. Returns a promise that resolves on
 * arrival, so you can `await` it between steps.
 *
 *   await debug.path.transition({
 *     duration: 2, direction: 'clockwise',
 *     start: { x: 1024, y: -512, angle: 0 },
 *     end:   { x: 1024, y: -512, angle: 90 },
 *   });
 */
export function transition({ duration = 1, direction = 'clockwise', start = {}, end = {} } = {}) {
    const p = state.players[0];
    const sx = start.x ?? p.x, sy = start.y ?? p.y;
    const ex = end.x ?? p.x, ey = end.y ?? p.y;
    const sa = start.angle != null ? start.angle * DEG : p.angle;
    const ea = end.angle != null ? end.angle * DEG : p.angle;

    // Directed angle sweep. The [0, 2π) value is the anti-clockwise (increasing)
    // arc from sa to ea; clockwise takes the decreasing arc (−2π, 0] instead.
    const TWO_PI = 2 * Math.PI;
    let dA = ((ea - sa) % TWO_PI + TWO_PI) % TWO_PI;
    if (direction === 'clockwise') dA -= TWO_PI;

    const ms = Math.max(1, duration * 1000);
    const startMs = performance.now();
    return new Promise(resolve => {
        const frame = () => {
            const raw = Math.min(1, (performance.now() - startMs) / ms);
            const e = 0.5 - 0.5 * Math.cos(Math.PI * raw);   // ease in-out (sine)
            setPlayer({ x: sx + (ex - sx) * e, y: sy + (ey - sy) * e, angle: sa + dA * e });
            if (raw >= 1) { resolve(); return; }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
    });
}

/** Instantly move the player to a pose — angle in DEGREES, any field omitted
 *  keeps its current value. The object-shaped, degrees counterpart to seek(),
 *  handy for jumping to a transition's start/end while scripting.
 *
 *   debug.path.move({ x: 39, y: -3113, angle: 246 });
 */
export function move({ x, y, angle } = {}) {
    const p = state.players[0];
    setPlayer({
        x: x ?? p.x,
        y: y ?? p.y,
        angle: angle != null ? angle * DEG : p.angle,
    });
}

// ── Transport panel ────────────────────────────────────────────────────────
let panelEl = null;

function btn(label, title, onClick) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'path-ctrl-btn';
    b.textContent = label;
    b.title = title;
    // Blur after click so keyboard focus returns to the game (so the
    // recorder can keep walking with the keyboard between clicks).
    b.addEventListener('click', () => { onClick(); b.blur(); });
    return b;
}

function buildPanel() {
    destroyPanel();
    panelEl = document.createElement('div');
    panelEl.id = 'path-controls';
    document.body.appendChild(panelEl);
    updatePanel();
}

function updatePanel() {
    if (!panelEl || !rec) return;
    const status = document.createElement('span');
    status.className = 'path-ctrl-status';
    if (rec.paused) {
        status.classList.add('paused');
        status.textContent = `paused · ${rec.segments.length} seg${rec.rewound ? ' · rewound' : ''}`;
        panelEl.replaceChildren(
            status,
            btn('⏮', 'Rewind to start of last segment (arms overwrite)', rewind),
            btn('▶', 'Review — replay the last segment', review),
            btn(rec.rewound ? 'Continue ⟲' : 'Continue', 'Resume recording', resume),
            btn('⏹', 'Stop recording', stop),
        );
    } else {
        status.textContent = `● rec · ${rec.segments.length} seg`;
        panelEl.replaceChildren(
            status,
            btn('✂ Mark', 'Cut a segment here, keep recording', mark),
            btn('⏸ Pause', 'Pause and end the segment', pause),
            btn('⏹', 'Stop recording', stop),
        );
    }
}

function destroyPanel() {
    panelEl?.remove();
    panelEl = null;
}
