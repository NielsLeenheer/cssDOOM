/**
 * Floor & ceiling (flat) render pass for the SoftwareRenderer (mixed onto
 * the prototype).
 *
 * Flats are drawn by back-projecting every screen pixel onto the
 * horizontal plane at the sector's height and sampling the 64×64 flat at
 * the resulting world (x, y) — the visplane math, done per-pixel rather
 * than per-span. Plane distance depends only on the scanline, so the
 * perspective divide is hoisted to once per row.
 */

import { getFlatTexture } from '../textures.js';
import { animName, NEAR, MAX_DIST, lightFor, shade } from '../tables.js';

export const flatMethods = {
    _renderFlats(cam) {
        const scene = this.scene;
        for (const sector of scene.sectorPolygons) {
            // Doors animate their ceiling height; lifts animate their floor.
            const ceilingHeight = scene._ceilOverride.get(sector) ?? sector.ceilingHeight;
            const floorHeight = scene._floorOverride.get(sector) ?? sector.floorHeight;
            if (ceilingHeight <= floorHeight) continue;

            const light = sector.lightLevel * (scene._sectorLightMul[sector.sectorIndex] ?? 1);
            const floorTex = getFlatTexture(animName(sector.floorTexture, scene._animFrame));
            if (floorTex) {
                this._drawPlane(cam, sector.boundaries, floorHeight, floorTex, light);
            }
            // Sky ceilings are painted by the backdrop pass, not here.
            if (sector.ceilingTexture === 'F_SKY1') continue;
            const ceilTex = getFlatTexture(animName(sector.ceilingTexture, scene._animFrame));
            if (ceilTex) {
                this._drawPlane(cam, sector.boundaries, ceilingHeight, ceilTex, light);
            }
        }
    },

    _drawPlane(cam, boundaries, planeZ, tex, lightLevel) {
        const { W, H, fb, zb } = this.framebuffer;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;
        const cz = planeZ - ez;
        if (Math.abs(cz) < 0.01) return;   // plane at eye level — no coverage

        // Flat per-sector brightness (no distance falloff) — matches the
        // CSSRenderer / WebGL light model; constant across the plane.
        const lf = lightFor(lightLevel);

        // Clip every boundary loop to the near plane and project to
        // screen. Edges from all loops feed one even-odd scanline fill,
        // which makes holes (hasHoles sectors) just work.
        const edges = [];   // flat [x0,y0,x1,y1, ...]
        let minY = Infinity, maxY = -Infinity;
        let anyVisible = false;

        for (const loop of boundaries) {
            if (!loop || loop.length < 3) continue;
            const n = loop.length;
            const screen = [];
            for (let i = 0; i < n; i++) {
                const cur = loop[i];
                const nxt = loop[(i + 1) % n];
                const cux = (cur.x - ex) * ca + (cur.y - ey) * sa;
                const cuy = ca * (cur.y - ey) - sa * (cur.x - ex);
                const cnx = (nxt.x - ex) * ca + (nxt.y - ey) * sa;
                const cny = ca * (nxt.y - ey) - sa * (nxt.x - ex);
                const curIn = cuy >= NEAR;
                const nxtIn = cny >= NEAR;
                if (curIn) {
                    screen.push(halfW + (cux / cuy) * sxScale,
                                halfH - (cz / cuy) * syScale);
                }
                if (curIn !== nxtIn) {
                    const t = (NEAR - cuy) / (cny - cuy);
                    const ix = cux + (cnx - cux) * t;
                    screen.push(halfW + (ix / NEAR) * sxScale,
                                halfH - (cz / NEAR) * syScale);
                }
            }
            if (screen.length < 6) continue;
            anyVisible = true;
            for (let i = 0; i < screen.length; i += 2) {
                const x0 = screen[i], y0 = screen[i + 1];
                const j = (i + 2) % screen.length;
                const x1 = screen[j], y1 = screen[j + 1];
                edges.push(x0, y0, x1, y1);
                if (y0 < minY) minY = y0;
                if (y0 > maxY) maxY = y0;
            }
        }
        if (!anyVisible) return;

        const yTop = Math.max(0, Math.ceil(minY - 0.5));
        const yBot = Math.min(H - 1, Math.floor(maxY - 0.5));
        if (yTop > yBot) return;

        const texW = tex.width;
        const texH = tex.height;
        const tdata = tex.data;

        const xsBuf = this._xsBuf || (this._xsBuf = new Float32Array(64));

        for (let y = yTop; y <= yBot; y++) {
            const yc = y + 0.5;

            // Collect scanline/edge intersections.
            let count = 0;
            for (let e = 0; e < edges.length; e += 4) {
                const ay = edges[e + 1], by = edges[e + 3];
                if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
                    const ax = edges[e], bx = edges[e + 2];
                    const x = ax + (bx - ax) * ((yc - ay) / (by - ay));
                    if (count < xsBuf.length) xsBuf[count++] = x;
                }
            }
            if (count < 2) continue;

            // Insertion sort (spans are short).
            for (let i = 1; i < count; i++) {
                const v = xsBuf[i];
                let j = i - 1;
                while (j >= 0 && xsBuf[j] > v) { xsBuf[j + 1] = xsBuf[j]; j--; }
                xsBuf[j + 1] = v;
            }

            // Plane distance depends only on the row, so do the divide
            // once: every pixel on this scanline of a horizontal plane is
            // the same distance away.
            const denomY = halfH - yc;
            const rowDepth = (cz * syScale) / denomY;
            if (rowDepth < NEAR || rowDepth > MAX_DIST) continue;
            const base = y * W;

            for (let s = 0; s + 1 < count; s += 2) {
                const xL = Math.max(0, Math.ceil(xsBuf[s] - 0.5));
                const xR = Math.min(W - 1, Math.floor(xsBuf[s + 1] - 0.5));
                for (let x = xL; x <= xR; x++) {
                    const idx = base + x;
                    if (rowDepth >= zb[idx]) continue;

                    // Back-project this pixel onto the plane.
                    const cx = (x + 0.5 - halfW) * rowDepth / sxScale;
                    const relX = ca * cx - sa * rowDepth;
                    const relY = sa * cx + ca * rowDepth;
                    const wx = relX + ex;
                    const wy = relY + ey;
                    let tx = (wx | 0) % texW; if (tx < 0) tx += texW;
                    let ty = (wy | 0) % texH; if (ty < 0) ty += texH;
                    const texel = tdata[ty * texW + tx];
                    fb[idx] = shade(texel, lf);
                    zb[idx] = rowDepth;
                }
            }
        }
    },
};
