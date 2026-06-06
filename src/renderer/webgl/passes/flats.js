/**
 * Floor & ceiling (flat) pass for the WebGLRenderer (mixed onto the
 * engine prototype).
 *
 * DOOM sectors are arbitrary concave polygons, often with holes (pillars,
 * inner sectors). Rather than triangulate them — fiddly and failure-prone
 * with holes — we use the classic stencil even-odd fill, which the canvas
 * renderer does in software with a scanline even-odd test:
 *
 *   1. Mark the polygon into the stencil buffer by drawing a triangle fan
 *      from a single apex over every boundary loop with op INVERT and no
 *      colour/depth writes. Pixels covered an odd number of times — the
 *      interior, holes excluded — end up set.
 *   2. Draw the sector's bounding-box quad at the plane height, textured
 *      with the world-aligned flat, where the stencil is set and the
 *      depth test passes. This is the only pass that writes colour+depth.
 *   3. Undo the mark by re-running the fan with INVERT, returning the
 *      stencil to zero for the next sector — cheaper than clearing the
 *      whole buffer per sector.
 *
 * The polygon XY geometry is static, built once in `_buildFlatGeometry`;
 * only the plane height (a uniform) changes as doors lower their ceiling
 * or lifts raise their floor, so animation never touches a buffer.
 */

import { StaticBuffer } from '../glutil.js';
import { animName } from '../../canvas/tables.js';

export const flatPassMethods = {
    /** Build the static per-sector fan + bounding-quad geometry. Called
     *  from the engine's setMap after the scene has ingested the map. */
    _buildFlatGeometry() {
        const gl = this.gl;
        if (this._flats) for (const f of this._flats) { f.fan.dispose(); f.quad.dispose(); }
        this._flats = [];

        for (const sector of this.scene.sectorPolygons) {
            const loops = sector.boundaries;
            const outer = loops && loops[0];
            if (!outer || outer.length < 3) continue;

            // Fan apex — any point works for the even-odd fill; the outer
            // loop's first vertex keeps the fan triangles local to the
            // sector (less stencil overdraw than fanning from the origin).
            const ax = outer[0].x, ay = outer[0].y;
            const fan = [];
            let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
            for (const loop of loops) {
                if (!loop || loop.length < 3) continue;
                const n = loop.length;
                for (let i = 0; i < n; i++) {
                    const c = loop[i], d = loop[(i + 1) % n];
                    fan.push(ax, ay, c.x, c.y, d.x, d.y);
                }
                for (const v of loop) {
                    if (v.x < minX) minX = v.x; if (v.x > maxX) maxX = v.x;
                    if (v.y < minY) minY = v.y; if (v.y > maxY) maxY = v.y;
                }
            }
            if (fan.length === 0 || maxX <= minX || maxY <= minY) continue;

            const quad = [minX, minY, maxX, minY, maxX, maxY,
                          minX, minY, maxX, maxY, minX, maxY];

            this._flats.push({
                sector,
                fan: new StaticBuffer(gl, new Float32Array(fan)),
                fanCount: fan.length / 2,
                quad: new StaticBuffer(gl, new Float32Array(quad)),
            });
        }
    },

    _renderFlats() {
        const gl = this.gl;
        const scene = this.scene;
        const prog = this.flatProgram;
        prog.use();
        this._setCameraUniforms(prog);
        gl.uniform1i(prog.u('u_tex'), 0);
        gl.activeTexture(gl.TEXTURE0);

        // Single-bit stencil: INVERT toggles bit 0 only (0↔1), so the
        // even-odd mark lands on exactly 1 and the cover test below can
        // match it. (A full 0xff mask would INVERT 0x00→0xff, which never
        // equals the ref value 1 — nothing would ever draw.)
        gl.enable(gl.STENCIL_TEST);
        gl.stencilMask(0x1);

        const loc = prog.a('a_xy');

        for (const f of this._flats) {
            const sector = f.sector;
            const ceilingHeight = scene._ceilOverride.get(sector) ?? sector.ceilingHeight;
            const floorHeight = scene._floorOverride.get(sector) ?? sector.floorHeight;
            if (ceilingHeight <= floorHeight) continue;
            const light = sector.lightLevel * (scene._sectorLightMul[sector.sectorIndex] ?? 1);

            const floorTex = this._getFlat(animName(sector.floorTexture, scene._animFrame));
            if (floorTex) this._drawFlat(f, floorHeight, floorTex, light, loc);

            // Sky ceilings are left empty so the sky backdrop shows through.
            if (sector.ceilingTexture !== 'F_SKY1') {
                const ceilTex = this._getFlat(animName(sector.ceilingTexture, scene._animFrame));
                if (ceilTex) this._drawFlat(f, ceilingHeight, ceilTex, light, loc);
            }
        }

        gl.disable(gl.STENCIL_TEST);
    },

    _drawFlat(f, planeZ, tex, light, loc) {
        const gl = this.gl;
        const prog = this.flatProgram;
        gl.uniform1f(prog.u('u_planeZ'), planeZ);

        // 1. Mark the polygon interior into the stencil (INVERT, no draw).
        gl.colorMask(false, false, false, false);
        gl.depthMask(false);
        gl.disable(gl.DEPTH_TEST);
        gl.stencilFunc(gl.ALWAYS, 0, 0x1);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
        gl.bindBuffer(gl.ARRAY_BUFFER, f.fan.buffer);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, f.fanCount);

        // 2. Texture the bounding quad where stencil == 1, depth-tested.
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
        gl.stencilFunc(gl.EQUAL, 1, 0x1);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.KEEP);
        gl.bindTexture(gl.TEXTURE_2D, tex.tex);
        gl.uniform1f(prog.u('u_light'), light);
        gl.bindBuffer(gl.ARRAY_BUFFER, f.quad.buffer);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 6);

        // 3. Reset the stencil to zero for the next sector.
        gl.colorMask(false, false, false, false);
        gl.depthMask(false);
        gl.disable(gl.DEPTH_TEST);
        gl.stencilFunc(gl.ALWAYS, 0, 0x1);
        gl.stencilOp(gl.KEEP, gl.KEEP, gl.INVERT);
        gl.bindBuffer(gl.ARRAY_BUFFER, f.fan.buffer);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, f.fanCount);

        // Leave colour/depth writes enabled for whatever draws next.
        gl.colorMask(true, true, true, true);
        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
    },
};
