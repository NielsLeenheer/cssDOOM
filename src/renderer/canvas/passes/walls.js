/**
 * Wall render pass for the SoftwareRenderer (mixed onto the prototype).
 *
 * Walls are drawn as vertical textured columns: the horizontal texture
 * coordinate is perspective-correct (interpolate u/z and 1/z across the
 * span); the vertical coordinate is affine within a column because a wall
 * is vertical and depth is constant down the column — exactly DOOM's
 * R_DrawColumn setup.
 */

import { getWallTexture } from '../textures.js';
import { animName, NEAR, lightFor, shade, skyCol, skyRow } from '../tables.js';

export const wallMethods = {
    _renderWalls(cam) {
        for (const wall of this.walls) {
            // Lift boundary walls are drawn by _renderLiftWalls at the
            // animated platform height; skip them here so the static and
            // moving copies don't z-fight (matches the DOM's buildWalls).
            if (wall.isLiftWall) continue;
            const tex = getWallTexture(animName(wall.texture, this._animFrame));
            if (!tex) continue;

            // Door panels raise their bottom edge as the door opens;
            // track jambs override their (zero) top to the travel span.
            const bottomOffset = this._wallBottomOffset.get(wall) || 0;
            const wallBottom = wall.bottomHeight + bottomOffset;
            const wallTop = this._wallTopOverride.get(wall) ?? wall.topHeight;
            // Adding the door's rise to the vertical texture offset pins
            // the panel texture to its moving bottom edge, so the door
            // texture slides up with the panel instead of squashing.
            const yOff = (wall.yOffset || 0) + bottomOffset;
            const light = wall.lightLevel * (this._sectorLightMul[wall.sectorIndex] ?? 1);

            // If this wall reaches its sector's sky ceiling, the area above
            // its top edge is that sector's sky — paint it at the wall's
            // depth so it occludes whatever lies beyond the opening.
            const skyCeil = this._skyCeil.get(wall.sectorIndex);
            const skyAbove = skyCeil !== undefined && Math.abs(wallTop - skyCeil) < 1;

            this._drawWall(cam, wall, tex, wallBottom, wallTop, yOff, light, false, skyAbove);
        }
    },

    /**
     * Rasterise one textured wall quad: back-face cull, transform to
     * camera space, near-plane clip, project, then fill each screen
     * column with a perspective-correct textured strip, depth-tested.
     */
    _drawWall(cam, wall, tex, wallBottom, wallTop, yOff, baseLight, noCull = false, skyAbove = false) {
        const { W, H, fb, zb } = this.framebuffer;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;

        const ax = wall.start.x, ay = wall.start.y;
        const bx = wall.end.x, by = wall.end.y;
        const dx = bx - ax, dy = by - ay;

        // Back-face cull against the front normal (dy, -dx). Lift shaft
        // walls opt out (noCull): their winding isn't guaranteed to face
        // the viewer and the depth buffer resolves any overdraw. Use a
        // strict `< 0` test (not `<= 0`) so that a wall the camera lies
        // *exactly* on its line still draws — the player can hug a wall
        // and the cull math then evaluates to 0, which is the boundary
        // between front- and back-facing and should be treated as visible.
        if (!noCull) {
            const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
            if ((ex - mx) * dy - (ey - my) * dx < 0) return;
        }

        let c1x = (ax - ex) * ca + (ay - ey) * sa;
        let c1y = ca * (ay - ey) - sa * (ax - ex);
        let c2x = (bx - ex) * ca + (by - ey) * sa;
        let c2y = ca * (by - ey) - sa * (bx - ex);

        let u1 = (wall.xOffset || 0) + (wall.isScrolling ? this._scrollOffset : 0);
        let u2 = u1 + Math.hypot(dx, dy);

        if (c1y < NEAR && c2y < NEAR) return;
        if (c1y < NEAR) {
            const t = (NEAR - c1y) / (c2y - c1y);
            c1x += (c2x - c1x) * t;
            u1 += (u2 - u1) * t;
            c1y = NEAR;
        } else if (c2y < NEAR) {
            const t = (NEAR - c2y) / (c1y - c2y);
            c2x += (c1x - c2x) * t;
            u2 += (u1 - u2) * t;
            c2y = NEAR;
        }

        const topZ = wallTop - ez;
        const botZ = wallBottom - ez;

        let p1 = halfW + (c1x / c1y) * sxScale;
        let p2 = halfW + (c2x / c2y) * sxScale;
        let yt1 = halfH - (topZ / c1y) * syScale;
        let yb1 = halfH - (botZ / c1y) * syScale;
        let yt2 = halfH - (topZ / c2y) * syScale;
        let yb2 = halfH - (botZ / c2y) * syScale;
        let inv1 = 1 / c1y, inv2 = 1 / c2y;
        let uo1 = u1 * inv1, uo2 = u2 * inv2;

        if (p1 > p2) {
            let s;
            s = p1; p1 = p2; p2 = s;
            s = yt1; yt1 = yt2; yt2 = s;
            s = yb1; yb1 = yb2; yb2 = s;
            s = inv1; inv1 = inv2; inv2 = s;
            s = uo1; uo1 = uo2; uo2 = s;
        }

        const xs = Math.max(0, Math.ceil(p1 - 0.5));
        const xe = Math.min(W - 1, Math.floor(p2 - 0.5));
        if (xs > xe) return;

        const span = p2 - p1 || 1e-6;
        const texW = tex.width, texH = tex.height, tdata = tex.data;
        const wallH = wallTop - wallBottom;

        // Fake contrast: E/W walls darker, N/S walls brighter.
        const light = baseLight + (Math.abs(dx) > Math.abs(dy) ? -16 : 16);
        const skyCtx = skyAbove ? this._skyCtx : null;

        for (let x = xs; x <= xe; x++) {
            const t = (x + 0.5 - p1) / span;
            const inv = inv1 + (inv2 - inv1) * t;
            const cy = 1 / inv;
            const u = (uo1 + (uo2 - uo1) * t) / inv;

            let texX = u % texW;
            if (texX < 0) texX += texW;
            texX |= 0;
            if (texX >= texW) texX = texW - 1;

            const ytop = yt1 + (yt2 - yt1) * t;
            const ybot = yb1 + (yb2 - yb1) * t;

            // Ceiling visplane: paint this sector's sky above the wall top
            // at the wall's depth, occluding anything farther in the column.
            if (skyCtx) {
                const skyEnd = Math.min(H, Math.ceil(ytop - 0.5));
                const sCol = skyCol(skyCtx, x);
                for (let y = 0; y < skyEnd; y++) {
                    const idx = y * W + x;
                    if (cy >= zb[idx]) continue;
                    fb[idx] = skyCtx.sdata[skyRow(skyCtx, y) * skyCtx.skyW + sCol] | 0xff000000;
                    zb[idx] = cy;
                }
            }

            const colH = ybot - ytop;
            if (colH <= 0) continue;

            const y0 = Math.max(0, Math.ceil(ytop - 0.5));
            const y1 = Math.min(H - 1, Math.floor(ybot - 0.5));
            if (y0 > y1) continue;

            const lf = lightFor(light, cy);
            const col = texX;
            const invColH = 1 / colH;

            for (let y = y0; y <= y1; y++) {
                const idx = y * W + x;
                if (cy >= zb[idx]) continue;
                const frac = (y + 0.5 - ytop) * invColH;
                let v = frac * wallH + yOff;
                v %= texH;
                if (v < 0) v += texH;
                let texY = v | 0;
                if (texY >= texH) texY = texH - 1;
                const texel = tdata[texY * texW + col];
                if ((texel >>> 24) < 128) continue;
                fb[idx] = shade(texel, lf);
                zb[idx] = cy;
            }
        }
    },
};
