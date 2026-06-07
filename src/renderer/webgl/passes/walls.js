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
 * texture size and REPEAT-wraps), and the surface's flat 0..1 brightness
 * (computed CPU-side via the DomRenderer's colormap mapping).
 */

import { DynamicBuffer } from '../glutil.js';
import { animName } from '../../canvas/tables.js';

export const wallPassMethods = {
    /**
     * Precompute which walls are lower-unpegged (texture pinned to the
     * wall bottom rather than the top), mirroring the DomRenderer:
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
            // Lift boundary walls are emitted by the lift loop below at the
            // animated platform height; skip the static copy here so they
            // don't z-fight (matches the canvas renderer).
            if (wall.isLiftWall) continue;
            const name = animName(wall.texture, scene._animFrame);
            const tex = this._getWall(name);
            if (!tex) continue;

            // Door panels raise their visible bottom edge as the door
            // opens (bottomOffset). The texture offset stays the wall's
            // own yOffset: door panels are unpegged, so pinning the
            // texture to the (rising) bottom makes it slide up with the
            // panel on its own — no need to fold bottomOffset into yOff.
            const bottomOffset = scene._wallBottomOffset.get(wall) || 0;
            const wallBottom = wall.bottomHeight + bottomOffset;
            const wallTop = scene._wallTopOverride.get(wall) ?? wall.topHeight;
            const yOff = wall.yOffset || 0;
            const light = this._sectorBrightness(wall.sectorIndex, wall.lightLevel);
            const u1 = (wall.xOffset || 0) + (wall.isScrolling ? scene._scrollOffset : 0);
            this._emitWall(groups, name, cam, wall, wallBottom, wallTop, yOff, light, u1,
                false, this._unpegged.has(wall));
        }

        // Lift shaft walls — drawn at the live platform height. The
        // platform-face walls span platform↔facing floor (growing as the
        // lift drops); the static shaft sides span the full travel so the
        // shaft isn't see-through once the platform moves away. Lift walls
        // are always unpegged (the DOM mechanic builds them that way).
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
                const light = this._doomLight(wall.lightLevel ?? lift.light);
                this._emitWall(groups, wall.texture, cam, wall, bottom, top,
                    wall.yOffset || 0, light, wall.xOffset || 0, true, true);
            }
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
     * This matches the DomRenderer's `background-position-y: 100%` rule.
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
        // the DomRenderer). The DOM applies no orientation-based fake
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
