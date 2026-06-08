/**
 * Builds the debug menu from the declarative SETTINGS registry. Iterates the
 * registry in order, opening a section header whenever `section` changes and
 * dispatching one builder per `kind`. The per-frame culling stats live here
 * because they're bespoke; everything repetitive is data in registry.js. The
 * Renderer picker calls the shared switchRenderer feature.
 *
 * Companion stylesheet: panel.css.
 */

import { culling, cullingStats } from '../../renderer/css/scene/culling.js';
import { switchRenderer } from '../features/renderer.js';
import { rendererType } from '../../renderer/manager.js';
import { SETTINGS, HIDE_DISABLED_SECTIONS } from './registry.js';

// Per-frame culling stat elements, keyed by the registry entry's `stat`.
const statElements = {};

// Checkboxes gated by renderer type ({ input, label, type, hide, stat }).
// When the active renderer's type doesn't match, the control is greyed +
// disabled — or, if `hide`, removed from layout entirely (see applyRendererTypes).
const typedControls = [];

/** Apply renderer-type gating: controls whose type doesn't match the active
 *  renderer are greyed + disabled, or hidden outright in HIDE_DISABLED_SECTIONS
 *  so those sections show only the relevant set. */
function applyRendererTypes() {
    const active = rendererType(document.body.dataset.renderer || 'css');
    for (const c of typedControls) {
        const off = c.type !== active;
        if (c.hide) {
            c.label.style.display = off ? 'none' : '';
            if (c.stat) c.stat.style.display = off ? 'none' : '';
        } else {
            c.input.disabled = off;
            c.label.classList.toggle('debug-disabled', off);
        }
    }
}

function makeCheckbox(checked, onChange) {
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = checked;
    cb.addEventListener('change', () => onChange(cb.checked));
    return cb;
}

function makeRow(checkbox, label) {
    const lbl = document.createElement('label');
    lbl.appendChild(checkbox);
    lbl.appendChild(document.createTextNode(` ${label}`));
    return lbl;
}

/** Append a checkbox row, registering it for renderer-type gating if the entry
 *  declares a `rendererType` (disabled — or hidden, in HIDE_DISABLED_SECTIONS —
 *  when the active renderer doesn't match). Returns the typedControls entry (or
 *  null) so the caller can link extras like the stat element. */
function addCheckboxRow(s, cb, parent) {
    const row = makeRow(cb, s.label);
    parent.appendChild(row);
    if (!s.rendererType) return null;
    const tc = { input: cb, label: row, type: s.rendererType, hide: HIDE_DISABLED_SECTIONS.has(s.section), stat: null };
    typedControls.push(tc);
    return tc;
}

/** Build one registry entry's DOM into `parent`. */
function buildEntry(s, parent) {
    switch (s.kind) {
        case 'css': {
            // invert: checked = class absent (reads as "visible")
            const has = document.body.classList.contains(s.class);
            const cb = makeCheckbox(s.invert ? !has : has, (checked) => {
                document.body.classList.toggle(s.class, s.invert ? !checked : checked);
            });
            addCheckboxRow(s, cb, parent);
            break;
        }
        case 'layer': {
            // Same features/layers.js object the console drives — checked = shown.
            const cb = makeCheckbox(s.layer.shown, (checked) => (checked ? s.layer.show() : s.layer.hide()));
            addCheckboxRow(s, cb, parent);
            break;
        }
        case 'flag': {
            const cb = makeCheckbox(!!s.target[s.key], (checked) => { s.target[s.key] = checked; });
            const tc = addCheckboxRow(s, cb, parent);
            if (s.stat) {
                const stat = document.createElement('div');
                stat.className = 'debug-stat';
                parent.appendChild(stat);
                statElements[s.stat] = stat;
                if (tc) tc.stat = stat; // hide the stat alongside its row when gated out
            }
            break;
        }
        case 'select': {
            const lbl = document.createElement('label');
            lbl.appendChild(document.createTextNode(`${s.label}: `));
            const select = document.createElement('select');
            select.className = 'debug-select';
            for (const kind of s.options) {
                const opt = document.createElement('option');
                opt.value = kind;
                opt.textContent = kind;
                select.appendChild(opt);
                if (kind === s.separatorAfter) {
                    const sep = document.createElement('option');
                    sep.disabled = true;
                    sep.textContent = '──────────';
                    select.appendChild(sep);
                }
            }
            select.value = document.body.dataset.renderer || s.options[0];
            select.addEventListener('change', () => switchRenderer(select.value));
            lbl.appendChild(select);
            parent.appendChild(lbl);
            break;
        }
        case 'button': {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.textContent = s.label;
            btn.className = `debug-button${s.showClass ? ' ' + s.showClass : ''}`;
            btn.addEventListener('click', s.onClick);
            parent.appendChild(btn);
            break;
        }
    }
}

// ── Open state ─────────────────────────────────────────────────────────────
// The menu builds once. openDebugMenu() is the idempotent public entry — the
// console's debug() and the debug bootstrap (DEV) both call it. The menu owns
// its own per-frame culling-stats refresh: a rAF loop that runs only while the
// <details> is expanded (the stats are invisible when collapsed). No game-loop
// involvement — updateDebugStats() just reads the shared cullingStats object.
let menuOpen = false;
let menuEl = null;
let statsRAF = 0;

export function openDebugMenu() {
    if (menuOpen) return;
    menuOpen = true;
    menuEl = initDebugMenu();
    menuEl.addEventListener('toggle', () => (menuEl.open ? startStats() : stopStats()));
    if (menuEl.open) startStats();
    // Gate type-specific checkboxes on the active renderer, and re-gate whenever
    // the renderer changes (the picker / debug.view.renderer set body.dataset.renderer).
    applyRendererTypes();
    new MutationObserver(applyRendererTypes)
        .observe(document.body, { attributes: true, attributeFilter: ['data-renderer'] });
    console.log('Debug menu enabled');
}

function startStats() {
    if (statsRAF) return;
    const tick = () => { updateDebugStats(); statsRAF = requestAnimationFrame(tick); };
    statsRAF = requestAnimationFrame(tick);
}

function stopStats() {
    if (statsRAF) { cancelAnimationFrame(statsRAF); statsRAF = 0; }
}

function initDebugMenu() {
    const details = document.createElement('details');
    details.id = 'debug-menu';

    const summary = document.createElement('summary');
    summary.textContent = 'Debug';
    details.appendChild(summary);

    let section = null;
    let grid = null; // current .debug-grid container, reset when section changes
    for (const s of SETTINGS) {
        if (s.section !== section) {
            section = s.section;
            grid = null;
            const h = document.createElement('div');
            h.className = 'debug-section';
            h.textContent = section;
            details.appendChild(h);
        }
        if (s.grid) {
            if (!grid) {
                grid = document.createElement('div');
                grid.className = 'debug-grid';
                details.appendChild(grid);
            }
            buildEntry(s, grid);
        } else {
            buildEntry(s, details);
        }
    }

    document.body.appendChild(details);
    return details;
}

/** Update the per-step culling stats text. Driven by the rAF loop above while
 *  the menu is expanded; reads the shared cullingStats the renderer fills. */
function updateDebugStats() {
    const { total } = cullingStats;
    const anyCulling = culling.frustum || culling.distance || culling.backface;

    let prev = total;
    for (const s of SETTINGS) {
        if (s.kind !== 'flag' || !s.stat) continue;
        const el = statElements[s.stat];
        if (!el) continue;
        if (anyCulling && culling[s.key]) {
            const after = cullingStats[s.stat];
            el.textContent = `${prev} → ${after}`;
            prev = after;
        } else {
            el.textContent = '';
        }
    }
}
