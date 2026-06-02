/**
 * Single declarative source for every debug-panel toggle and action.
 *
 * Two runtime mechanisms, never mixed:
 *   kind:'css'   → a class on <body>, read ONLY by CSS (pure render toggles).
 *                  invert:true  → checkbox checked means the class is ABSENT
 *                                 (reads as "Floors visible", not "Hide floors").
 *                  grid:true    → laid out in the Renderer two-column grid.
 *   kind:'flag'  → a property on a JS object, read ONLY by JS (game / render
 *                  logic). target is the live object; the game loop reads it
 *                  directly without ever touching the DOM.
 *                  stat → optional culling per-step readout key.
 *   kind:'select'→ discrete value (the renderer); the panel owns the swap impl.
 *   kind:'button'→ one-shot action. showClass gates DM-only / kiosk-only
 *                  visibility via CSS.
 *
 * The panel (panel.js) is the only consumer — it groups by `section` (sections
 * render in first-seen order) and dispatches one builder per `kind`.
 */

import { debugFlags } from '../../game/state.js';
import { culling } from '../../renderer/dom/scene/culling.js';
import { endMatch } from '../../game/match.js';
import { enterAttract } from '../../game/attract.js';
import { app } from '../../app.js';

export const SETTINGS = [
    // ── Game ── JS flags read by physics / AI each tick ───────────────────
    { section: 'Game', kind: 'flag', target: debugFlags, key: 'noEnemyAttack', label: 'No enemy attack' },
    { section: 'Game', kind: 'flag', target: debugFlags, key: 'noEnemyMove',   label: 'No enemy movement' },
    { section: 'Game', kind: 'flag', target: debugFlags, key: 'noclip',        label: 'No collision (noclip)' },
    { section: 'Game', kind: 'flag', target: debugFlags, key: 'noDamage',      label: 'No damage' },

    // ── Culling ── JS flags read by updateCulling(); order matches its passes
    { section: 'Culling', kind: 'flag', target: culling, key: 'distance', label: 'Distance culling', stat: 'afterDistance' },
    { section: 'Culling', kind: 'flag', target: culling, key: 'backface', label: 'Backface culling', stat: 'afterBackface' },
    { section: 'Culling', kind: 'flag', target: culling, key: 'frustum',  label: 'Frustum culling',  stat: 'afterFrustum' },
    { section: 'Culling', kind: 'flag', target: culling, key: 'sky',      label: 'Sky culling',      stat: 'afterSky' },
    { section: 'Culling', kind: 'css', class: 'css-distance-culling', label: 'CSS distance culling', default: false },
    { section: 'Culling', kind: 'css', class: 'css-frustum-culling',  label: 'CSS frustum culling',  default: false },

    // ── Effects ── CSS-only render toggles ────────────────────────────────
    { section: 'Effects', kind: 'css', class: 'sector-lights',   label: 'Sector light effects', default: true },
    { section: 'Effects', kind: 'css', class: 'light-falloff',   label: 'Light falloff',        default: false },
    { section: 'Effects', kind: 'css', class: 'scroll-textures', label: 'Scrolling textures',   default: true },
    { section: 'Effects', kind: 'css', class: 'animated-flats',  label: 'Animated flats',       default: true },
    { section: 'Effects', kind: 'css', class: 'head-bob',        label: 'Head bob',             default: true },
    { section: 'Effects', kind: 'css', class: 'all-enemies-shadow', label: 'All enemies shadow', default: false },

    // ── Renderer ── select swaps the SP renderer; grid peels scene layers ──
    { section: 'Renderer', kind: 'select', key: 'renderer', label: 'Renderer', options: ['dom', 'flat', 'shade', 'lighting', 'line', 'cat'] },
    { section: 'Renderer', kind: 'css', class: 'hide-floors',   label: 'Floors',   invert: true, grid: true },
    { section: 'Renderer', kind: 'css', class: 'hide-ceilings', label: 'Ceilings', invert: true, grid: true },
    { section: 'Renderer', kind: 'css', class: 'hide-walls',    label: 'Walls',    invert: true, grid: true },
    { section: 'Renderer', kind: 'css', class: 'hide-things',   label: 'Things',   invert: true, grid: true },
    { section: 'Renderer', kind: 'css', class: 'hide-enemies',  label: 'Enemies',  invert: true, grid: true },
    { section: 'Renderer', kind: 'css', class: 'hide-hud',      label: 'HUD',      invert: true, grid: true },
    { section: 'Renderer', kind: 'css', class: 'hide-sky',      label: 'Sky',      invert: true, grid: true },
    { section: 'Renderer', kind: 'css', class: 'hide-chrome',   label: 'Chrome',   invert: true, grid: true },

    // ── Debug ── CSS-only development visualisations ──────────────────────
    { section: 'Debug', kind: 'css', class: 'show-sky-walls',  label: 'Show sky walls',  default: false },
    { section: 'Debug', kind: 'css', class: 'show-wall-ids',   label: 'Show wall IDs',   default: false },
    { section: 'Debug', kind: 'css', class: 'show-sector-ids', label: 'Show sector IDs', default: false },

    // ── State ── one-shot actions (End match = DM only, Attract = kiosk only)
    { section: 'State', kind: 'button', label: 'End level',     onClick: () => app.game?.endCurrentLevel() },
    { section: 'State', kind: 'button', label: 'End match',     onClick: () => endMatch(),     showClass: 'debug-button-dm' },
    { section: 'State', kind: 'button', label: 'Enter attract', onClick: () => enterAttract(), showClass: 'debug-button-kiosk' },
];

/**
 * Apply CSS-toggle defaults to <body>. Called once at boot so the declared
 * default state holds whether or not the debug menu is ever opened. No
 * persistence — every load resets to these declared defaults.
 */
export function applyCssDefaults() {
    for (const s of SETTINGS) {
        if (s.kind === 'css' && s.default) document.body.classList.add(s.class);
    }
}
