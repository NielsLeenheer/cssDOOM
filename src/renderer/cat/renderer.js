/**
 * CatRenderer — FlatRenderer's silly twin. Extends FlatRenderer, so it
 * inherits everything: the pane DOM, the `.pane-flat` CSS hook and its
 * flat surface colours (texture-override.css), the suppressed-command
 * set, and culling. The only override is the scene builder, which
 * paints walls with a random pick from 10 cat photos instead of leaving
 * them flat-coloured (floors / ceilings stay flat). The pane also
 * carries `.pane-cat` for the handful of cat-specific tweaks in
 * cat/styles.css. Built for the talk's "swap renderers on the fly" demo.
 */

import { FlatRenderer } from '../flat/renderer.js';
import { buildCatScene } from './scene.js';

export class CatRenderer extends FlatRenderer {
    constructor(options) {
        super(options); // adds .pane-flat (+ all flat behaviour)
        this.paneEl.classList.add('pane-cat');
    }

    buildScene(mapData) {
        return buildCatScene(mapData);
    }
}
