/**
 * Single-player level intermission screen.
 *
 * Mirrors DOOM's post-level summary: FINISHED title over the WIMAP0
 * intermission backdrop, then KILLS / ITEMS / SECRET as % and TIME as
 * m:ss. Each value counts up from zero to its final reading in turn,
 * matching the original game. Shown when the player triggers an exit
 * (switch or walk-over); a fire press snaps any in-progress counter to
 * its final value, a second fire press dismisses and loads the next map.
 *
 * Built into every `.pane-intermission` element — same pattern as the
 * DM scoreboard. In SP only pane 0 is visible so the second pane's
 * copy is hidden by CSS (display: none on .pane-intermission unless
 * body[data-game-state="intermission"]).
 */

import { GAME_STATE, getGameState } from '../../game/game-state.js';
import { orchestrator } from '../../orchestrator.js';

const LABEL_BASE = '/assets/intermission';
const COUNT_UP_MS = 1200;     // per-row duration
const STEP_DELAY_MS = 250;    // pause between rows

let pendingNextMap = null;
let onAdvance = null;
let dismissable = false;
// Set while the count-up animations are running. First fire press
// during this period snaps everything to final; second press dismisses.
let animating = false;
let finalizeAnimation = null;

/**
 * Render the intermission and arm the fire-key advance callback.
 * @param {object} payload
 * @param {string|null} payload.nextMap  Map to load when the player presses fire,
 *                                       or null if there's no next map (final
 *                                       level). The advance handler is still
 *                                       installed but does nothing in that case.
 * @param {string|null} payload.mapName  Name of the level just finished — drives
 *                                       the WILV title sprite at the top of the
 *                                       screen.
 * @param {{kills,items,secrets,elapsedMs}|null} payload.stats  SP stats snapshot.
 *                                       Null outside SP mode, in which case
 *                                       the function early-returns.
 * @param {() => void} advanceCallback  Called once the player dismisses
 *                                the screen — typically `() => loadMap(next)`.
 */
export function showIntermission(payload, advanceCallback) {
    if (!payload?.stats) return;

    pendingNextMap = payload.nextMap;
    onAdvance = advanceCallback;

    for (const container of document.querySelectorAll('.pane-intermission')) {
        container.replaceChildren(buildIntermissionNode(payload.mapName));
    }
    orchestrator.setGameState(GAME_STATE.INTERMISSION);

    // Brief grace period — the same fire press that triggered the exit
    // (in attract-like flows) shouldn't immediately advance the screen.
    dismissable = false;
    setTimeout(() => { dismissable = true; }, 500);

    runCountUp(payload.stats);
}

export function hideIntermission() {
    if (getGameState() === GAME_STATE.INTERMISSION) {
        orchestrator.setGameState(GAME_STATE.ACTIVE);
    }
    pendingNextMap = null;
    onAdvance = null;
    dismissable = false;
    animating = false;
    finalizeAnimation?.();
    finalizeAnimation = null;
    for (const container of document.querySelectorAll('.pane-intermission')) {
        container.replaceChildren();
    }
}

/** True if the intermission is currently shown (input handlers route
 *  fire to advance instead of fireWeapon). */
export function isIntermissionActive() {
    return getGameState() === GAME_STATE.INTERMISSION;
}

/**
 * Called by input handlers when fire is pressed during intermission.
 * First press during count-up snaps the animation to final values; a
 * subsequent press loads the next map.
 */
export function dismissIntermission() {
    if (!isIntermissionActive() || !dismissable) return;
    if (animating) {
        finalizeAnimation?.();
        return;
    }
    const next = pendingNextMap;
    const cb = onAdvance;
    // Lock against a double-press during the fade. dismissable=false
    // makes a second dismissIntermission call a no-op until the
    // intermission state clears.
    dismissable = false;
    pendingNextMap = null;
    onAdvance = null;
    // Kick off the next map load FIRST — loadMap's fade-to-black
    // overlay (z-index 10000) starts transitioning in immediately, so
    // it covers the intermission before we clear it. Hiding the
    // intermission first would briefly reveal the old level scene
    // between the dismiss and the fade-in. The loading overlay's fade
    // is 600 ms; clear the intermission once it's fully opaque so the
    // black screen smoothly transitions to the new level rather than
    // back to the old one.
    cb?.(next);
    setTimeout(hideIntermission, 600);
}

function buildIntermissionNode(mapName) {
    const root = document.createElement('div');
    root.className = 'intermission';

    const header = document.createElement('div');
    header.className = 'intermission-header';
    const levelSrc = levelNameSpriteSrc(mapName);
    if (levelSrc) {
        const level = document.createElement('img');
        level.className = 'intermission-level';
        level.src = levelSrc;
        level.alt = mapName || '';
        header.appendChild(level);
    }
    const finished = document.createElement('img');
    finished.className = 'intermission-finished';
    finished.src = `${LABEL_BASE}/WIF.png`;
    finished.alt = 'FINISHED';
    header.appendChild(finished);
    root.appendChild(header);

    const rows = document.createElement('div');
    rows.className = 'intermission-rows';
    rows.appendChild(buildStatRow('kills',   'WIOSTK.png', 'KILLS'));
    rows.appendChild(buildStatRow('items',   'WIOSTI.png', 'ITEMS'));
    rows.appendChild(buildStatRow('secrets', 'WIOSTS.png', 'SECRET'));
    rows.appendChild(buildStatRow('time',    'WITIME.png', 'TIME'));
    root.appendChild(rows);

    return root;
}

function buildStatRow(key, labelFile, alt) {
    const row = document.createElement('div');
    row.className = `intermission-row intermission-row-${key}`;

    const label = document.createElement('img');
    label.className = 'intermission-label';
    label.src = `${LABEL_BASE}/${labelFile}`;
    label.alt = alt;
    row.appendChild(label);

    const val = document.createElement('div');
    val.className = `intermission-value intermission-value-${key}`;
    val.textContent = key === 'time' ? '0:00' : '0%';
    row.appendChild(val);

    return row;
}

/**
 * Animate each stat counting up from 0 → its target, sequentially.
 * The finalizeAnimation hook lets the input handler snap everything
 * to final mid-count.
 */
function runCountUp(stats) {
    const steps = [
        { selector: '.intermission-value-kills',   target: percentValue(stats.kills),   format: percentStr },
        { selector: '.intermission-value-items',   target: percentValue(stats.items),   format: percentStr },
        { selector: '.intermission-value-secrets', target: percentValue(stats.secrets), format: percentStr },
        { selector: '.intermission-value-time',    target: stats.elapsedMs / 1000,       format: timeStr },
    ];

    animating = true;

    let cancelled = false;
    let rafId = null;
    let timeoutId = null;

    finalizeAnimation = () => {
        cancelled = true;
        if (rafId != null) cancelAnimationFrame(rafId);
        if (timeoutId != null) clearTimeout(timeoutId);
        for (const step of steps) writeAll(step.selector, step.format(step.target));
        animating = false;
        finalizeAnimation = null;
    };

    let i = 0;
    function startNext() {
        if (cancelled) return;
        if (i >= steps.length) {
            animating = false;
            finalizeAnimation = null;
            return;
        }
        const step = steps[i++];
        const t0 = performance.now();
        function tick(now) {
            if (cancelled) return;
            const t = Math.min(1, (now - t0) / COUNT_UP_MS);
            writeAll(step.selector, step.format(step.target * t));
            if (t < 1) {
                rafId = requestAnimationFrame(tick);
            } else {
                rafId = null;
                timeoutId = setTimeout(startNext, STEP_DELAY_MS);
            }
        }
        rafId = requestAnimationFrame(tick);
    }
    startNext();
}

function writeAll(selector, text) {
    for (const el of document.querySelectorAll(selector)) el.textContent = text;
}

function percentValue({ collected, total }) {
    if (!total) return 100;
    return Math.round(100 * collected / total);
}

function percentStr(v) {
    return `${Math.round(v)}%`;
}

function timeStr(seconds) {
    const totalSec = Math.max(0, Math.floor(seconds));
    const m = Math.floor(totalSec / 60);
    const s = totalSec % 60;
    return `${m}:${s.toString().padStart(2, '0')}`;
}

/**
 * Map E1M{N} (N = 1..9) to its WILV0{N-1} sprite path. Returns null for
 * map names that don't match the E1 episode (no sprite shipped). DOOM's
 * WILV graphics are pre-rendered white level titles ("HANGAR", "NUCLEAR
 * PLANT", etc.).
 */
function levelNameSpriteSrc(mapName) {
    if (!mapName) return null;
    const match = /^E1M([1-9])$/.exec(mapName);
    if (!match) return null;
    const idx = Number(match[1]) - 1;
    return `${LABEL_BASE}/WILV0${idx}.png`;
}

// ── Renderer-command entry points ──────────────────────────────────────
// Game pushes showIntermission / hideIntermission through the
// orchestrator (see src/renderer/commands.js); commands.js imports
// these directly and wires them as the world-command impls. The
// advance callback is a no-op because Game.advance is the sole
// dismiss path: actions/gates.js's intermissionAdvance fires
// Game.advance on FIRE_DOWN, which pushes hideIntermission via
// orchestrator. dismissIntermission's onAdvance invocation is dead
// code on master (gates routes to Game.advance first) and on the
// joiner (gates aren't initialized client-side).

export function renderIntermission(_renderer, payload) {
    showIntermission(payload, () => {});
}

export function clearIntermission(_renderer) {
    hideIntermission();
}
