/**
 * Single-player level intermission screen.
 *
 * Mirrors DOOM's post-level summary: FINISHED title over the WIMAP0
 * intermission backdrop, then KILLS / ITEMS / SECRET as % and TIME as
 * m:ss. Each value counts up from zero to its final reading in turn,
 * matching the original game.
 *
 * Built per pane, dispatched once per render target. Every write lands
 * inside `renderer.paneEl` — no document-scoped queries, no body
 * writes, no game-state reads. CSS shows the screen when the per-pane
 * `.pane-intermission` element carries an `.active` class (added by
 * `renderIntermission`, removed by `clearIntermission`).
 *
 * Each pane runs its own count-up animation. Dispatch fires `renderIntermission`
 * once per renderer within the same task, so they start nearly synchronously
 * and tick in visual lockstep without explicit cross-pane coordination.
 * Each pane's cancel-fn lives in a module-local WeakMap keyed on the
 * pane's intermission container — equivalent to a property on the
 * element, scoped to this module.
 */

const LABEL_BASE = '/assets/intermission';
const COUNT_UP_MS = 1200;     // per-row duration
const STEP_DELAY_MS = 250;    // pause between rows

// Per-pane animation cancel-fn lookup. WeakMap keyed on the
// `.pane-intermission` container so the entry is garbage-collected
// when the pane is destroyed without explicit cleanup.
const animationsByPane = new WeakMap();

// ── Renderer-command entry points ──────────────────────────────────────
// Game pushes showIntermission / hideIntermission through the
// orchestrator as world envelopes; CSSRenderer's bottom-of-file
// binding wires these as the impls. Game also owns the
// `body.dataset.gameState` transition that gates CSS visibility —
// this module never touches it.

/**
 * @param {object} renderer  CSSRenderer for the pane this call addresses.
 * @param {object} payload
 * @param {string|null} payload.mapName  Name of the level just finished —
 *                                       drives the WILV title sprite.
 * @param {{kills,items,secrets,elapsedMs}|null} payload.stats
 *                                       Null outside SP mode (function
 *                                       early-returns).
 */
export function renderIntermission(renderer, payload) {
    if (!payload?.stats) return;
    const container = renderer.paneEl.querySelector('.pane-intermission');
    if (!container) return;

    // Cancel any in-flight animation on this pane before rebuilding
    // (defensive — a second showIntermission without an intervening
    // hide shouldn't leak RAF / timeout handles).
    animationsByPane.get(container)?.();

    container.replaceChildren(buildIntermissionNode(payload.mapName));
    container.classList.add('active');
    const cancel = runCountUp(container, payload.stats);
    animationsByPane.set(container, cancel);
}

export function clearIntermission(renderer) {
    const container = renderer.paneEl.querySelector('.pane-intermission');
    if (!container) return;
    animationsByPane.get(container)?.();
    animationsByPane.delete(container);
    container.classList.remove('active');
    container.replaceChildren();
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
 * Scoped to one pane: all element lookups are inside `container`.
 * Returns a cancel function that aborts any in-flight RAF / timeout.
 */
function runCountUp(container, stats) {
    const steps = [
        { selector: '.intermission-value-kills',   target: percentValue(stats.kills),   format: percentStr },
        { selector: '.intermission-value-items',   target: percentValue(stats.items),   format: percentStr },
        { selector: '.intermission-value-secrets', target: percentValue(stats.secrets), format: percentStr },
        { selector: '.intermission-value-time',    target: stats.elapsedMs / 1000,       format: timeStr },
    ];

    let cancelled = false;
    let rafId = null;
    let timeoutId = null;

    const write = (selector, text) => {
        const el = container.querySelector(selector);
        if (el) el.textContent = text;
    };

    let i = 0;
    function startNext() {
        if (cancelled) return;
        if (i >= steps.length) return;
        const step = steps[i++];
        const t0 = performance.now();
        function tick(now) {
            if (cancelled) return;
            const t = Math.min(1, (now - t0) / COUNT_UP_MS);
            write(step.selector, step.format(step.target * t));
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

    return () => {
        cancelled = true;
        if (rafId != null) cancelAnimationFrame(rafId);
        if (timeoutId != null) clearTimeout(timeoutId);
    };
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
