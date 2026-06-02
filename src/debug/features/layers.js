/**
 * Layers — animated opacity fades of a whole scene layer (walls / floors /
 * ceilings / things) plus the sky, the counterpart to the menu's instant
 * hide-* toggles. Toggles a body.fade-{layer} class; the actual fade lives in
 * CSS (features/layers.css). 'sky' fades a black overlay in behind the scene
 * (the sky is a background-image, which can't transition).
 *
 * A shared feature: console exposes these as debug.layers.*.
 */

const LAYER_NAMES = ['walls', 'floors', 'ceilings', 'sky', 'things'];
const eachLayer = (layer) => layer ? [layer] : LAYER_NAMES;

/** Fade a scene layer ('walls' | 'floors' | 'ceilings' | 'things' | 'sky', or
 *  all) out. */
export const fadeOut = (layer) => eachLayer(layer).forEach(l => document.body.classList.add(`fade-${l}`));
/** Fade a scene layer (or all) back in. */
export const fadeIn = (layer) => eachLayer(layer).forEach(l => document.body.classList.remove(`fade-${l}`));
