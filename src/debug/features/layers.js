/**
 * Layers — per-layer visibility controls for the debug console (debug.layers.*).
 *
 * Each layer is an object with .show() / .hide():
 *   - Scene layers — walls / floors / ceilings / sky / things / enemies /
 *     corpses — cross-fade via a body.fade-{layer} class (animated opacity in
 *     features/layers.css). 'sky' fades a black overlay in behind the scene
 *     (the sky is a background-image, which can't transition). 'corpses' is a
 *     subset of 'things' — just the map-placed dead-body / gore decorations.
 *   - hud / chrome hide INSTANTLY via the body.hide-{layer} class the menu also
 *     drives. hud additionally has .isolate(on?) — fade the scene to a flat grey
 *     field and leave just the HUD (status bar + weapon); see features/isolate.js.
 *
 * hide() makes the layer disappear (fade out / hide), show() brings it back;
 * `shown` reports the current state. A shared feature with two presenters over
 * the SAME objects — the console exposes the whole thing as debug.layers, and
 * the menu's Renderer grid checkboxes drive the same per-layer show()/hide()
 * (registry.js kind:'layer'), so panel and console are one codepath, not two.
 */

import { isolateHud } from './isolate.js';

/** A layer toggled by a single body class: hide() adds it, show() removes it,
 *  `shown` is true while the class is absent (used by the menu checkbox). */
const classLayer = (cls) => ({
    hide: () => document.body.classList.add(cls),
    show: () => document.body.classList.remove(cls),
    get shown() { return !document.body.classList.contains(cls); },
});

// Scene layers cross-fade (body.fade-*); hud/chrome hide instantly (body.hide-*).
const FADE_LAYERS = ['walls', 'floors', 'ceilings', 'sky', 'things', 'enemies', 'corpses'];

export const layers = {};
for (const name of FADE_LAYERS) layers[name] = classLayer(`fade-${name}`);
layers.hud = { ...classLayer('hide-hud'), isolate: isolateHud };
layers.chrome = classLayer('hide-chrome');
