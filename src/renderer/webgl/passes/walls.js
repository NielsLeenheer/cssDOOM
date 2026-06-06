/**
 * Wall pass for the WebGLRenderer (mixed onto the engine prototype).
 *
 * Walls are textured quads. Unlike the static flats, wall geometry is
 * rebuilt every frame into a streamed buffer: door panels slide, lift
 * shafts grow, textures scroll and animate, so it's simplest (and plenty
 * fast for a DOOM level's wall count) to regenerate the vertices each
 * frame straight from the live scene state — exactly the values the
 * canvas renderer's `_renderWalls` / `_renderLiftWalls` compute.
 *
 * Vertices are grouped by texture so each distinct wall texture is one
 * draw call. Per vertex: world position (x,y,z), texel coordinate in
 * world units (u along the wall, v down it — the FS divides by the
 * texture size and REPEAT-wraps), and the baked sector light including
 * the N/S-brighter / E/W-darker fake contrast.
 */

import { DynamicBuffer } from '../glutil.js';
import { animName } from '../../canvas/tables.js';

export const wallPassMethods = {
    _renderWalls(cam) {
        const scene = this.scene;
        // name → flat vertex array (x,y,z,u,v,light per vertex).
        const groups = this._wallGroups || (this._wallGroups = new Map());
        for (const arr of groups.values()) arr.length = 0;

        for (const wall of scene.walls) {
            // Lift boundary walls are emitted by the lift loop below at the
            // animated platform height; skip the static copy here so they
            // don't z-fight (matches the canvas renderer).
            if (wall.isLiftWall) continue;
            const name = animName(wall.texture, scene._animFrame);
            const tex = this._getWall(name);
            if (!tex) continue;

            const bottomOffset = scene._wallBottomOffset.get(wall) || 0;
            const wallBottom = wall.bottomHeight + bottomOffset;
            const wallTop = scene._wallTopOverride.get(wall) ?? wall.topHeight;
            const yOff = (wall.yOffset || 0) + bottomOffset;
            const light = wall.lightLevel * (scene._sectorLightMul[wall.sectorIndex] ?? 1);
            const u1 = (wall.xOffset || 0) + (wall.isScrolling ? scene._scrollOffset : 0);
            this._emitWall(groups, name, cam, wall, wallBottom, wallTop, yOff, light, u1, false);
        }

        // Lift shaft walls — drawn at the live platform height. The
        // platform-face walls span platform↔facing floor (growing as the
        // lift drops); the static shaft sides span the full travel so the
        // shaft isn't see-through once the platform moves away.
        for (const lift of scene.lifts.values()) {
            for (const wall of lift.shaftWalls) {
                const tex = this._getWall(wall.texture);
                if (!tex || tex.width <= 1) continue;
                let bottom, top;
                if (wall.isPlatformFace) {
                    const nf = wall.neighborFloor ?? lift.lower;
                    bottom = Math.min(lift.current, nf);
                    top = Math.max(lift.current, nf);
                } else {
                    bottom = wall.neighborFloor !== undefined
                        ? Math.min(wall.neighborFloor, lift.lower) : lift.lower;
                    top = lift.upper;
                }
                if (top - bottom < 0.5) continue;
                const light = wall.lightLevel ?? lift.light;
                this._emitWall(groups, wall.texture, cam, wall, bottom, top,
                    wall.yOffset || 0, light, wall.xOffset || 0, true);
            }
        }

        // Draw each texture group.
        const gl = this.gl;
        const prog = this.worldProgram;
        prog.use();
        this._setCameraUniforms(prog);
        gl.uniform1f(prog.u('u_zbias'), 0);
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

    /** Append one wall quad's six vertices to its texture group, after the
     *  geometric back-face cull (lift walls opt out via `noCull`). */
    _emitWall(groups, name, cam, wall, wallBottom, wallTop, yOff, baseLight, u1, noCull) {
        const wallH = wallTop - wallBottom;
        if (wallH <= 0) return;

        const ax = wall.start.x, ay = wall.start.y;
        const bx = wall.end.x, by = wall.end.y;
        const dx = bx - ax, dy = by - ay;

        if (!noCull) {
            const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
            if ((cam.ex - mx) * dy - (cam.ey - my) * dx < 0) return;
        }

        // Fake contrast: E/W walls darker, N/S walls brighter.
        const light = baseLight + (Math.abs(dx) > Math.abs(dy) ? -16 : 16);
        const u2 = u1 + Math.hypot(dx, dy);
        const vTop = yOff, vBot = wallH + yOff;

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
