/**
 * Wall pass for the WebGLRenderer (mixed onto the engine prototype).
 *
 * Walls are textured quads. Unlike the static flats, wall geometry is
 * rebuilt every frame into a streamed buffer: door panels slide, lift
 * faces ride the platform, textures scroll and animate, so it's simplest
 * (and plenty fast for a DOOM level's wall count) to regenerate the vertices
 * each frame straight from the live scene state — exactly the values the
 * canvas renderer's `_renderWalls` computes.
 *
 * Vertices are grouped by texture so each distinct wall texture is one
 * draw call. Per vertex: world position (x,y,z), texel coordinate in
 * world units (u along the wall, v down it — the FS divides by the
 * texture size and REPEAT-wraps), and the surface's flat 0..1 brightness
 * (computed CPU-side via the CSSRenderer's colormap mapping).
 */

import { DynamicBuffer } from '../glutil.js';
import { animName } from '../../canvas/tables.js';

export const wallPassMethods = {
    /**
     * Precompute which walls are lower-unpegged (texture pinned to the
     * wall bottom rather than the top), mirroring the CSSRenderer:
     *
     *   - a regular wall with the ML_DONTPEGBOTTOM flag (`wall.isUnpegged`);
     *   - every door face wall (doors.js force-adds `unpegged`);
     *   - every door track jamb (createWallElement force-adds `unpegged`).
     *
     * Lift shaft walls are also always unpegged, but they're emitted from
     * their own loop so they pass the flag directly. Called from the
     * engine's setMap after the scene has ingested the map.
     */
    _buildWallPegging() {
        const scene = this.scene;
        const set = this._unpegged = new Set();
        for (const w of scene.walls) if (w.isUnpegged) set.add(w);
        for (const door of scene.doors.values()) for (const w of door.faceWalls) set.add(w);
        for (const w of scene._wallTopOverride.keys()) set.add(w); // door tracks
    },

    _renderWalls(cam) {
        const scene = this.scene;
        if (!this._unpegged) this._buildWallPegging();
        // name → flat vertex array (x,y,z,u,v,light per vertex).
        const groups = this._wallGroups || (this._wallGroups = new Map());
        for (const arr of groups.values()) arr.length = 0;

        for (const wall of scene.walls) {
            const name = animName(wall.texture, scene._animFrame);
            const tex = this._getWall(name);
            if (!tex) continue;

            let wallBottom, wallTop, yOff, noCull, unpegged;
            if (wall.moverType === 'lift') {
                // Lift faces are ordinary walls drawn at the live platform
                // height: the riser spans platform↔facing floor (growing as the
                // lift drops), texture pinned to the platform top so it rides
                // down with it. Well-lining walls carry no moverType and draw
                // statically like any other wall.
                const lift = scene.lifts.get(wall.moverSector);
                if (!lift) continue;
                const nf = wall.bottomHeight;          // facing floor (face top == lift.upper)
                wallBottom = Math.min(lift.current, nf);
                wallTop = Math.max(lift.current, nf);
                if (wallTop - wallBottom < 0.5) continue;
                yOff = (wall.yOffset || 0) - (lift.upper - Math.min(nf, lift.lower));
                noCull = true;
                unpegged = false;
            } else {
                // Door panels raise their visible bottom edge as the door opens
                // (bottomOffset). Door panels are unpegged, so pinning the
                // texture to the rising bottom makes it slide up with the panel.
                const bottomOffset = scene._wallBottomOffset.get(wall) || 0;
                wallBottom = wall.bottomHeight + bottomOffset;
                wallTop = scene._wallTopOverride.get(wall) ?? wall.topHeight;
                yOff = wall.yOffset || 0;
                noCull = false;
                unpegged = this._unpegged.has(wall);
            }
            const light = this._sectorBrightness(wall.sectorIndex, wall.lightLevel);
            const u1 = (wall.xOffset || 0) + (wall.isScrolling ? scene._scrollOffset : 0);
            this._emitWall(groups, name, cam, wall, wallBottom, wallTop, yOff, light, u1,
                noCull, unpegged);
        }

        // Draw each texture group.
        const gl = this.gl;
        const prog = this.worldProgram;
        prog.use();
        this._setCameraUniforms(prog);
        gl.uniform1f(prog.u('u_uvWorld'), 1);
        gl.uniform1i(prog.u('u_tex'), 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.enable(gl.DEPTH_TEST);

        const buf = this._wallBuffer || (this._wallBuffer = new DynamicBuffer(gl));
        const scratch = this._wallScratch || (this._wallScratch = { data: new Float32Array(0) });

        for (const [name, arr] of groups) {
            if (arr.length === 0) continue;
            const tex = this._getWall(name);
            if (!tex) continue;
            if (scratch.data.length < arr.length) scratch.data = new Float32Array(arr.length);
            scratch.data.set(arr);
            buf.set(scratch.data, arr.length);
            this._bindWorldAttribs(prog, buf);
            gl.bindTexture(gl.TEXTURE_2D, tex.tex);
            gl.uniform2f(prog.u('u_texSize'), tex.width, tex.height);
            gl.drawArrays(gl.TRIANGLES, 0, arr.length / 6);
        }
    },

    /**
     * Append one wall quad's six vertices to its texture group, after the
     * geometric back-face cull (lift walls opt out via `noCull`).
     *
     * Vertical texture coordinate (world texel units, the FS REPEAT-wraps
     * by the texture height): top-pegged walls run yOff at the top to
     * yOff+wallH at the bottom; lower-unpegged walls pin the texture's
     * bottom to the wall's bottom instead — yOff at the bottom, yOff−wallH
     * at the top (mod the texture height, which the REPEAT wrap handles).
     * This matches the CSSRenderer's `background-position-y: 100%` rule.
     */
    _emitWall(groups, name, cam, wall, wallBottom, wallTop, yOff, light, u1, noCull, unpegged) {
        const wallH = wallTop - wallBottom;
        if (wallH <= 0) return;

        const ax = wall.start.x, ay = wall.start.y;
        const bx = wall.end.x, by = wall.end.y;
        const dx = bx - ax, dy = by - ay;

        if (!noCull) {
            const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
            if ((cam.ex - mx) * dy - (cam.ey - my) * dx < 0) return;
        }

        // `light` is the final 0..1 brightness (computed CPU-side to match
        // the CSSRenderer). The DOM applies no orientation-based fake
        // contrast, so neither do we.
        const u2 = u1 + Math.hypot(dx, dy);
        const vTop = unpegged ? yOff - wallH : yOff;
        const vBot = unpegged ? yOff : yOff + wallH;

        let arr = groups.get(name);
        if (!arr) groups.set(name, arr = []);
        // A(start,top) B(end,top) C(end,bot) D(start,bot) → ABC, ACD.
        arr.push(
            ax, ay, wallTop,    u1, vTop, light,
            bx, by, wallTop,    u2, vTop, light,
            bx, by, wallBottom, u2, vBot, light,
            ax, ay, wallTop,    u1, vTop, light,
            bx, by, wallBottom, u2, vBot, light,
            ax, ay, wallBottom, u1, vBot, light,
        );
    },
};
