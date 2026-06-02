/**
 * Builds the debug menu from the declarative SETTINGS registry. Iterates the
 * registry in order, opening a section header whenever `section` changes and
 * dispatching one builder per `kind`. The per-frame culling stats live here
 * because they're bespoke; everything repetitive is data in registry.js. The
 * Renderer picker calls the shared switchRenderer feature.
 *
 * Companion stylesheet: panel.css.
 */

import { culling, cullingStats } from '../../renderer/dom/scene/culling.js';
import { switchRenderer } from '../features/renderer.js';
import { SETTINGS } from './registry.js';

// Per-frame culling stat elements, keyed by the registry entry's `stat`.
const statElements = {};

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

/** Build one registry entry's DOM into `parent`. */
function buildEntry(s, parent) {
    switch (s.kind) {
        case 'css': {
            // invert: checked = class absent (reads as "visible")
            const has = document.body.classList.contains(s.class);
            const cb = makeCheckbox(s.invert ? !has : has, (checked) => {
                document.body.classList.toggle(s.class, s.invert ? !checked : checked);
            });
            parent.appendChild(makeRow(cb, s.label));
            break;
        }
        case 'flag': {
            const cb = makeCheckbox(!!s.target[s.key], (checked) => { s.target[s.key] = checked; });
            parent.appendChild(makeRow(cb, s.label));
            if (s.stat) {
                const stat = document.createElement('div');
                stat.className = 'debug-stat';
                parent.appendChild(stat);
                statElements[s.stat] = stat;
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
// console's debug() and master's DEV boot both call it; isDebugMenuOpen() gates
// the per-frame stats refresh. The menu is the UI's own concern, so this lives
// here rather than in the console.
let menuOpen = false;
export function openDebugMenu() {
    if (menuOpen) return;
    menuOpen = true;
    initDebugMenu();
    console.log('Debug menu enabled');
}
export const isDebugMenuOpen = () => menuOpen;

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
}

/** Update the per-step culling stats text. Called each frame from the loop. */
export function updateDebugStats() {
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
