/**
 * Layers — animated opacity fades of a whole scene layer (walls / floors /
 * ceilings / things / enemies) plus the sky, the counterpart to the menu's
 * instant hide-* toggles. Toggles a body.fade-{layer} class; the actual fade
 * lives in CSS (features/layers.css). 'sky' fades a black overlay in behind the
 * scene (the sky is a background-image, which can't transition).
 *
 * 'corpses' is an extra sub-layer (a subset of 'things') that fades just the
 * map-placed dead-body / gore decorations — handy when you want to keep things
 * but drop the corpses. It's not part of the "fade all" set (no arg) since
 * 'things' already covers it; pass it explicitly.
 *
 * A shared feature: console exposes these as debug.layers.*.
 */

const LAYER_NAMES = ['walls', 'floors', 'ceilings', 'sky', 'things', 'enemies'];
const eachLayer = (layer) => layer ? [layer] : LAYER_NAMES;

/** Fade a scene layer ('walls' | 'floors' | 'ceilings' | 'things' | 'enemies' |
 *  'sky', or all) out — or 'corpses' for just the map's dead-body decorations. */
export const fadeOut = (layer) => eachLayer(layer).forEach(l => document.body.classList.add(`fade-${l}`));
/** Fade a scene layer (or all) back in. */
export const fadeIn = (layer) => eachLayer(layer).forEach(l => document.body.classList.remove(`fade-${l}`));
