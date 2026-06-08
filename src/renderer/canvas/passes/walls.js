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
        const scene = this.scene;
        if (!this._unpegged) this._buildWallPegging();
        for (const wall of scene.walls) {
            // Lift boundary walls are drawn by _renderLiftWalls at the
            // animated platform height; skip them here so the static and
            // moving copies don't z-fight (matches the DOM's buildWalls).
            if (wall.isLiftWall) continue;
            const tex = getWallTexture(animName(wall.texture, scene._animFrame));
            if (!tex) continue;

            // Door panels raise their visible bottom edge as the door opens
            // (bottomOffset); track jambs override their (zero) top. Door
            // panels are unpegged, so pinning the texture to the rising
            // bottom (see _drawWall) slides it up on its own — the yOffset
            // stays the wall's own, no bottomOffset folded in. Matches WebGL/DOM.
            const bottomOffset = scene._wallBottomOffset.get(wall) || 0;
            const wallBottom = wall.bottomHeight + bottomOffset;
            const wallTop = scene._wallTopOverride.get(wall) ?? wall.topHeight;
            const yOff = wall.yOffset || 0;
            const light = wall.lightLevel * (scene._sectorLightMul[wall.sectorIndex] ?? 1);

            // If this wall reaches its sector's sky ceiling, the area above
            // its top edge is that sector's sky — paint it at the wall's
            // depth so it occludes whatever lies beyond the opening.
            const skyCeil = scene._skyCeil.get(wall.sectorIndex);
            const skyAbove = skyCeil !== undefined && Math.abs(wallTop - skyCeil) < 1;

            this._drawWall(cam, wall, tex, wallBottom, wallTop, yOff, light, false, skyAbove, this._unpegged.has(wall));
        }
    },

    /**
     * Mark walls whose texture pins to the wall bottom (lower-unpegged),
     * mirroring the WebGL/DOM renderers: ML_DONTPEGBOTTOM walls
     * (`wall.isUnpegged`), every door face, and every door track jamb (the
     * walls carrying a top override). Lift shaft walls pass the flag directly
     * from `_renderLiftWalls`. Rebuilt per scene (invalidated on setMap/clear).
     */
    _buildWallPegging() {
        const scene = this.scene;
        const set = this._unpegged = new Set();
        for (const w of scene.walls) if (w.isUnpegged) set.add(w);
        for (const door of scene.doors.values()) for (const w of door.faceWalls) set.add(w);
        for (const w of scene._wallTopOverride.keys()) set.add(w);
    },

    /**
     * Draw lift shaft walls. The platform-face walls span from the
     * platform's current height to the floor they face (so they grow as
     * the lift drops); the static shaft sides span the full travel so the
     * shaft isn't see-through once the platform has moved away.
     */
    _renderLiftWalls(cam) {
        for (const lift of this.scene.lifts.values()) {
            for (const wall of lift.shaftWalls) {
                const tex = getWallTexture(wall.texture);
                if (!tex || tex.width <= 1) continue;
                let bottom, top, unpegged, yOff;
                if (wall.isPlatformFace) {
                    const nf = wall.neighborFloor ?? lift.lower;
                    bottom = Math.min(lift.current, nf);
                    top = Math.max(lift.current, nf);
                    // Pin the face texture to the platform top so it rides down
                    // with the lift (the DOM translates a full-height panel
                    // pinned to the platform — top-pegging offset by the full
                    // panel height so the texel at the platform matches). Matches WebGL.
                    const fullH = lift.upper - Math.min(nf, lift.lower);
                    unpegged = false;
                    yOff = (wall.yOffset || 0) - fullH;
                } else {
                    bottom = wall.neighborFloor !== undefined
                        ? Math.min(wall.neighborFloor, lift.lower) : lift.lower;
                    top = lift.upper;
                    unpegged = true;                 // static shaft sides
                    yOff = wall.yOffset || 0;
                }
                if (top - bottom < 0.5) continue;
                const light = wall.lightLevel ?? lift.light;
                this._drawWall(cam, wall, tex, bottom, top, yOff, light, true, false, unpegged);
            }
        }
    },

    /**
     * Rasterise one textured wall quad: back-face cull, transform to
     * camera space, near-plane clip, project, then fill each screen
     * column with a perspective-correct textured strip, depth-tested.
     */
    _drawWall(cam, wall, tex, wallBottom, wallTop, yOff, baseLight, noCull = false, skyAbove = false, unpegged = false) {
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

        let u1 = (wall.xOffset || 0) + (wall.isScrolling ? this.scene._scrollOffset : 0);
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
        // Vertical texel reference. Top-pegged (default): yOff at the top
        // running to yOff+wallH at the bottom. Lower-unpegged (door faces,
        // door tracks, ML_DONTPEGBOTTOM, lift sides): pin the texture's
        // bottom to the wall bottom instead — yOff−wallH at the top, yOff at
        // the bottom (REPEAT-wrapped). Matches the WebGL/DOM renderers.
        const vBase = unpegged ? yOff - wallH : yOff;

        // Flat per-sector brightness — matches the CSSRenderer / WebGL light
        // model (doomLight); constant across the wall, so resolve it once.
        const lf = lightFor(baseLight);
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

            const col = texX;
            const invColH = 1 / colH;

            for (let y = y0; y <= y1; y++) {
                const idx = y * W + x;
                if (cy >= zb[idx]) continue;
                const frac = (y + 0.5 - ytop) * invColH;
                let v = frac * wallH + vBase;
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
