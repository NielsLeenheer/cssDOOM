/**
 * Sky render pass for the SoftwareRenderer (mixed onto the prototype via
 * `Object.assign` in software.js, so `this` is the renderer).
 *
 * The sky is the ceiling of whichever sky sector you're looking at. We
 * first lay it down as a full-frame backdrop at a sentinel far depth (so
 * any solid geometry overwrites it), then in the wall pass a wall under a
 * sky ceiling repaints the sky above its top edge at the wall's own depth
 * — exactly the front sector's ceiling visplane — which is what makes
 * distant geometry behind a sky opening disappear (DOOM r_plane: the sky
 * plane is drawn opaquely above the segs).
 *
 * DOOM draws the sky at a fixed vertical scale (≈1 texel per row at 200px
 * tall) anchored so the texture's mountain base sits at the horizon; the
 * params are stashed in `_skyCtx` so the wall pass paints it identically.
 * (Stretching the whole texture to the horizon dragged SKY1's dark lower
 * rows up into a fat band above the walls.)
 */

import { getSkyTexture } from '../textures.js';
import { SKY_DEPTH, skyRow, skyCol } from '../tables.js';

export const skyMethods = {
    _renderSky(cam) {
        const sky = getSkyTexture();
        if (!sky) { this._skyCtx = null; return; }
        const { W, H, fb, zb } = this;
        const { angle, halfH } = cam;
        const skyW = sky.width, skyH = sky.height, sdata = sky.data;
        const colAngle = this._colAngle;
        const ctx = this._skyCtx = {
            sdata, skyW, skyH, colAngle, halfH,
            uBase: (angle / (Math.PI * 2)) * skyW * 4,
            iscale: 200 / H,
            skyHorizon: skyH - 28,
            twoPi: Math.PI * 2,
        };
        for (let y = 0; y < H; y++) {
            const sv = skyRow(ctx, y);
            const row = sv * skyW;
            const base = y * W;
            for (let x = 0; x < W; x++) {
                fb[base + x] = sdata[row + skyCol(ctx, x)] | 0xFF000000;
                zb[base + x] = SKY_DEPTH;
            }
        }
    },
};
