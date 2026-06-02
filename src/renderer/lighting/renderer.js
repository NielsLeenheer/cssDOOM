/**
 * LightingRenderer — a pure black-and-white lighting view of the level.
 *
 * Identical to ShadeRenderer (same geometry-only scene, same suppressed
 * commands, same door pinning) except for the surface CSS: every wall / floor /
 * ceiling renders OPAQUE WHITE, so the inherited
 * `filter: brightness(var(--light))` cascade shows only the per-sector
 * lighting, in greyscale — no surface colours, no transparency. The look lives
 * in lighting/styles.css; here we just swap shade's `.pane-shade` CSS hook for
 * `.pane-lighting`.
 */

import { ShadeRenderer } from '../shade/renderer.js';

export class LightingRenderer extends ShadeRenderer {
    constructor(options) {
        super(options);
        this.paneEl.classList.replace('pane-shade', 'pane-lighting');
    }
}
