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
 * Capture runs at ~30fps and skips the leading "silence": a segment doesn't
 * start sampling until the player first moves, anchoring the standing pose as
 * t=0 (Mark starts the next segment immediately since the player is already
 * moving). Runs of identical frames are collapsed to a held pair so stationary
 * stretches stay compact and replay as a hold rather than a drift.
 *
 * Exposed as debug.path.* in console.js.
 */

import { state } from '../game/state.js';
import { EYE_HEIGHT } from '../shared/constants.js';
import { getFloorHeightAt } from '../game/physics.js';

const round = (n, d = 2) => Math.round(n * 10 ** d) / 10 ** d;
const POS_EPS = 0.1;  // movement threshold that ends the skip-silence wait
const ANG_EPS = 0.002;

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

// ── Recording session ──────────────────────────────────────────────────────
// rec while active:
//   segments — finished segments, each { samples: [{t,x,y,angle}] }
//   cur      — in-progress segment { samples, t0 }  (t0=null = waiting to move)
//   prev     — previous pose, for the skip-silence movement test
//   paused, rewound, rafId
let rec = null;
let lastSession = null;  // { segments } after stop()

function startSegment(skipSilence) {
    rec.prev = null;
    if (skipSilence) {
        rec.cur = { samples: [], t0: null, lastMs: null };
    } else {
        // Immediate (mark mid-walk): anchor the current pose as t=0.
        const now = performance.now();
        rec.cur = { samples: [{ t: 0, ...pose(state.players[0]) }], t0: now, lastMs: now };
    }
}

function finalizeSegment() {
    if (rec.cur?.samples.length) rec.segments.push({ samples: rec.cur.samples });
    rec.cur = null;
}

function sampleFrame() {
    if (!rec || rec.paused || !rec.cur) return;
    rec.rafId = requestAnimationFrame(sampleFrame);

    // Throttle to ~30fps.
    const now = performance.now();
    if (rec.cur.lastMs != null && now - rec.cur.lastMs < SAMPLE_INTERVAL_MS) return;
    rec.cur.lastMs = now;

    const cur = pose(state.players[0]);

    if (rec.cur.t0 === null) {
        // Skip leading silence — wait for the first real movement.
        const moved = rec.prev && (
            Math.abs(cur.x - rec.prev.x) > POS_EPS ||
            Math.abs(cur.y - rec.prev.y) > POS_EPS ||
            Math.abs(cur.angle - rec.prev.angle) > ANG_EPS
        );
        if (moved) {
            rec.cur.t0 = now;
            rec.cur.samples.push({ t: 0, ...rec.prev });  // standing pose as t=0
        }
        rec.prev = cur;
        return;
    }

    // Record, collapsing runs of identical frames to two samples (the
    // arrival + a held end whose time keeps extending) so a stationary
    // stretch replays as a hold instead of a slow drift between endpoints.
    const t = Math.round(now - rec.cur.t0);
    const s = rec.cur.samples;
    const last = s[s.length - 1];
    const same = last && last.x === cur.x && last.y === cur.y && last.angle === cur.angle;
    if (same) {
        const prev2 = s[s.length - 2];
        const holding = prev2 && prev2.x === cur.x && prev2.y === cur.y && prev2.angle === cur.angle;
        if (holding) last.t = t;            // extend the held run
        else s.push({ t, ...cur });         // mark the end of the held run
    } else {
        s.push({ t, ...cur });
    }
}

function startSampling() { rec.rafId = requestAnimationFrame(sampleFrame); }
function stopSampling() { if (rec?.rafId) cancelAnimationFrame(rec.rafId); if (rec) rec.rafId = null; }

/** Start a recording session (opens the transport panel). */
export function record() {
    if (rec) { console.warn('[path] already recording'); return; }
    rec = { segments: [], cur: null, prev: null, paused: false, rewound: false, rafId: null };
    startSegment(true);
    startSampling();
    buildPanel();
    console.log('[path] recording — transport top-centre. Walk to record; mark / pause / stop.');
}

/** Cut the current segment and start the next, without stopping. */
export function mark() {
    if (!rec || rec.paused) { console.warn('[path] not recording'); return; }
    finalizeSegment();
    startSegment(false);  // continue immediately (player is mid-walk)
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
    startSegment(true);   // skip-silence: wait for the player to walk on
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
    return play({ samples: last.samples });
}

/** Finish the session; returns { segments }. */
export function stop() {
    if (!rec) { console.warn('[path] not recording'); return null; }
    if (!rec.paused) { finalizeSegment(); stopSampling(); }
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

/** Log + clipboard each segment as an independent playable path; returns the array. */
export function exportPath(session = lastSession) {
    if (!session?.segments?.length) { console.warn('[path] nothing to export — record() first'); return null; }
    const paths = session.segments.map(s => ({ samples: s.samples }));
    const json = JSON.stringify(paths);
    console.log(json);
    navigator.clipboard?.writeText(json).then(() => console.log('[path] copied to clipboard'), () => {});
    return paths;
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
 * play() — which continues seamlessly from there:
 *
 *   debug.path.seek('walk', { segment: 1 });   // jump to its first frame
 *   await delay(3000);                          // hold the shot
 *   await debug.path.play('walk', { segment: 1 });
 */
export function seek(path, opts = {}) {
    const samples = resolveSamples(path, opts);
    if (!samples?.length) { console.warn('[path] nothing to seek'); return; }
    setPlayer(sampleAt(samples, opts.t ?? 0));
}

/**
 * Move the player along a path while the game loop runs. `path` may be a path
 * object { samples }, a whole session { segments } (plays each in order), or a
 * saved slot name. opts: { speed = 1, segment } — `segment` is a 0-based index
 * to play just one segment of a session/slot. Returns a promise that resolves
 * when it finishes, so you can `await` it between scripted steps (or not, to
 * run it alongside other debug.* calls).
 *
 *   debug.path.play('walk')                 — whole session, every segment
 *   debug.path.play('walk', { segment: 1 }) — just the 2nd segment
 */
export async function play(path, opts = {}) {
    if (typeof path === 'string') path = load(path);
    if (path?.segments) {                       // a session
        if (opts.segment != null) {             // …play just one segment
            const seg = path.segments[opts.segment];
            if (!seg) { console.warn(`[path] no segment ${opts.segment} (have ${path.segments.length})`); return; }
            return play({ samples: seg.samples }, { speed: opts.speed });
        }
        for (const seg of path.segments) await play({ samples: seg.samples }, { speed: opts.speed });
        return;
    }
    const samples = path?.samples;
    if (!samples?.length) { console.warn('[path] nothing to play'); return; }

    const { speed = 1 } = opts;
    const player = state.players[0];
    const t1 = samples.at(-1).t;
    const startMs = performance.now();

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
            if (done) { resolve(); return; }
            requestAnimationFrame(frame);
        };
        requestAnimationFrame(frame);
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
