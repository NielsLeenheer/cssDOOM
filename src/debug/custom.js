/**
 * debug.custom — hand-authored talk scripts.
 *
 * The rest of the debug layer is building-block commands grouped by domain
 * (debug.path.*, debug.sectors.*, debug.layers.*, …). THIS file is the
 * scratchpad for the set pieces performed live during the CSS Day talk: each
 * function strings those commands together on a timeline — play a recorded
 * path, explode a sector, fade a layer, drop in a floor grid, and so on. Add
 * your own as custom.two, custom.three, …
 *
 * Wired by console.js via registerCustom(debug): it hands in the live `debug`
 * namespace, so a script just calls debug.path.play(...),
 * debug.sectors.explode(...), debug.layers.fadeOut(...) directly.
 */

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function registerCustom(debug) {
    const custom = (debug.custom ??= {});

    
}
