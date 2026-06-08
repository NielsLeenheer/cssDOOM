/**
 * Single declarative source for every debug-panel toggle and action.
 *
 * Two runtime mechanisms, never mixed:
 *   kind:'css'   → a class on <body>, read ONLY by CSS (pure render toggles).
 *                  invert:true  → checkbox checked means the class is ABSENT
 *                                 (reads as "Floors visible", not "Hide floors").
 *                  grid:true    → laid out in the Renderer two-column grid.
 *   kind:'layer' → a layer object from features/layers.js (`layer`), with
 *                  show()/hide()/`shown`. The SAME object the console drives as
 *                  debug.layers.* — checkbox checked = shown; scene layers fade,
 *                  hud/chrome hide instantly. Panel + console, one codepath.
 *   kind:'flag'  → a property on a JS object, read ONLY by JS (game / render
 *                  logic). target is the live object; the game loop reads it
 *                  directly without ever touching the DOM.
 *                  stat → optional culling per-step readout key.
 *   kind:'select'→ discrete value (the renderer); the panel owns the swap impl.
 *   kind:'button'→ one-shot action. showClass gates DM-only / kiosk-only
 *                  visibility via CSS.
 *
 * rendererType (on any checkbox entry) → 'dom' | 'canvas'. The panel disables
 *   the checkbox when the active renderer's type (manager.rendererType) doesn't
 *   match — e.g. CSS toggles ('dom') are dead under a canvas renderer, and the
 *   canvas Stats overlay ('canvas') is meaningless under a DOM renderer. Omit to
 *   leave it enabled for every renderer (Game cheats, Chrome, the picker).
 *
 * The panel (panel.js) is the only consumer — it groups by `section` (sections
 * render in first-seen order) and dispatches one builder per `kind`.
 */

import { debugFlags } from '../../game/state.js';
import { culling } from '../../renderer/dom/scene/culling.js';
import { endMatch } from '../../game/match.js';
import { enterAttract } from '../../game/attract.js';
import { app } from '../../app.js';
import { layers } from '../features/layers.js';
import { canvasStats } from '../../renderer/canvas/renderer.js';
import { lineReduction, lineScene, lineDebug } from '../../renderer/line/renderer.js';
import { PICKABLE_RENDERERS } from '../../renderer/manager.js';

export const SETTINGS = [
    // ── Game ── JS flags read by physics / AI each tick ───────────────────
    { section: 'Game', kind: 'flag', target: debugFlags, key: 'noEnemyAttack', label: 'No enemy attack' },
    { section: 'Game', kind: 'flag', target: debugFlags, key: 'noEnemyMove',   label: 'No enemy movement' },
    { section: 'Game', kind: 'flag', target: debugFlags, key: 'noclip',        label: 'No collision (noclip)' },
    { section: 'Game', kind: 'flag', target: debugFlags, key: 'noDamage',      label: 'No damage' },

    // ── Culling ── JS flags read by updateCulling(); order matches its passes.
    // rendererType:'dom' — these drive the DOM renderer's CSS/JS culling passes;
    // a canvas renderer does its own culling, so the panel disables them there.
    { section: 'Culling', kind: 'flag', target: culling, key: 'distance', label: 'Distance culling', stat: 'afterDistance', rendererType: 'dom' },
    { section: 'Culling', kind: 'flag', target: culling, key: 'backface', label: 'Backface culling', stat: 'afterBackface', rendererType: 'dom' },
    { section: 'Culling', kind: 'flag', target: culling, key: 'frustum',  label: 'Frustum culling',  stat: 'afterFrustum', rendererType: 'dom' },
    { section: 'Culling', kind: 'flag', target: culling, key: 'sky',      label: 'Sky culling',      stat: 'afterSky', rendererType: 'dom' },
    { section: 'Culling', kind: 'css', class: 'css-distance-culling', label: 'CSS distance culling', default: false, rendererType: 'dom' },
    { section: 'Culling', kind: 'css', class: 'css-frustum-culling',  label: 'CSS frustum culling',  default: false, rendererType: 'dom' },

    // ── Effects ── CSS-only render toggles (rendererType:'dom' — pure CSS) ──
    // These four effects are ON by default in the renderer CSS; the menu
    // disables each via a `no-*` body class (invert: checked = class absent =
    // effect on). The render default lives in CSS, not here — see
    // lighting/walls/floors/camera.css.
    { section: 'Effects', kind: 'css', class: 'no-sector-lights',   label: 'Sector light effects', invert: true, rendererType: 'dom' },
    { section: 'Effects', kind: 'css', class: 'light-falloff',      label: 'Light falloff',        default: false, rendererType: 'dom' },
    { section: 'Effects', kind: 'css', class: 'no-scroll-textures', label: 'Scrolling textures',   invert: true, rendererType: 'dom' },
    { section: 'Effects', kind: 'css', class: 'no-animated-flats',  label: 'Animated flats',       invert: true, rendererType: 'dom' },
    { section: 'Effects', kind: 'css', class: 'no-head-bob',        label: 'Head bob',             invert: true, rendererType: 'dom' },
    { section: 'Effects', kind: 'css', class: 'all-enemies-shadow', label: 'All enemies shadow', default: false, rendererType: 'dom' },

    // ── Renderer ── select swaps the SP renderer; the rest gate by type ────
    { section: 'Renderer', kind: 'select', key: 'renderer', label: 'Renderer', options: PICKABLE_RENDERERS },
    // Canvas frame-time / size overlay — only the canvas renderer draws it.
    { section: 'Renderer', kind: 'flag', target: canvasStats, key: 'enabled', label: 'Stats', rendererType: 'canvas' },
    // Line renderer: collinear merge vs. plain dedup (off). Effect shows in the
    // Stats overlay's line counts. Line renderer reports type 'canvas'.
    { section: 'Renderer', kind: 'flag', target: lineReduction, key: 'snap', label: 'Snap to grid', rendererType: 'canvas' },
    { section: 'Renderer', kind: 'flag', target: lineReduction, key: 'merge', label: 'Merge lines', rendererType: 'canvas' },
    { section: 'Renderer', kind: 'flag', target: lineReduction, key: 'dropParallel', label: 'Drop parallel lines', rendererType: 'canvas' },
    { section: 'Renderer', kind: 'flag', target: lineScene, key: 'cullInteriorFaces', label: 'Cull interior faces', rendererType: 'canvas' },
    { section: 'Renderer', kind: 'flag', target: lineScene, key: 'drawFloorCeilingOutlines', label: 'Floor/ceiling outlines', rendererType: 'canvas' },
    { section: 'Renderer', kind: 'flag', target: lineDebug, key: 'showDepthBuffer', label: 'Depth buffer', rendererType: 'canvas' },
    { section: 'Renderer', kind: 'flag', target: lineDebug, key: 'showTriangles', label: 'Line triangles', rendererType: 'canvas' },
    // Layer visibility — the SAME features/layers.js objects the console drives
    // as debug.layers.* (one codepath). Scene layers cross-fade; hud/chrome hide
    // instantly. Checkbox checked = layer shown. The scene layers are CSS, so
    // rendererType:'dom'; Chrome is app UI (menu buttons / spectator overlay,
    // not renderer-drawn) so it stays enabled for every renderer.
    { section: 'Renderer', kind: 'layer', layer: layers.floors,   label: 'Floors',   grid: true, rendererType: 'dom' },
    { section: 'Renderer', kind: 'layer', layer: layers.ceilings, label: 'Ceilings', grid: true, rendererType: 'dom' },
    { section: 'Renderer', kind: 'layer', layer: layers.walls,    label: 'Walls',    grid: true, rendererType: 'dom' },
    { section: 'Renderer', kind: 'layer', layer: layers.things,   label: 'Things',   grid: true, rendererType: 'dom' },
    { section: 'Renderer', kind: 'layer', layer: layers.enemies,  label: 'Enemies',  grid: true, rendererType: 'dom' },
    { section: 'Renderer', kind: 'layer', layer: layers.hud,      label: 'HUD',      grid: true, rendererType: 'dom' },
    { section: 'Renderer', kind: 'layer', layer: layers.sky,      label: 'Sky',      grid: true, rendererType: 'dom' },
    { section: 'Renderer', kind: 'layer', layer: layers.chrome,   label: 'Chrome',   grid: true },

    // ── Debug ── CSS-only development visualisations (rendererType:'dom') ──
    { section: 'Debug', kind: 'css', class: 'show-sky-walls',  label: 'Show sky walls',  default: false, rendererType: 'dom' },
    { section: 'Debug', kind: 'css', class: 'show-wall-ids',   label: 'Show wall IDs',   default: false, rendererType: 'dom' },
    { section: 'Debug', kind: 'css', class: 'show-sector-ids', label: 'Show sector IDs', default: false, rendererType: 'dom' },

    // ── State ── one-shot actions (End match = DM only, Attract = kiosk only)
    { section: 'State', kind: 'button', label: 'End level',     onClick: () => app.game?.endCurrentLevel() },
    { section: 'State', kind: 'button', label: 'End match',     onClick: () => endMatch(),     showClass: 'debug-button-dm' },
    { section: 'State', kind: 'button', label: 'Enter attract', onClick: () => enterAttract(), showClass: 'debug-button-kiosk' },
];
