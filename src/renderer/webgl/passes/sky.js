/**
 * Sky pass for the WebGLRenderer (mixed onto the engine prototype).
 *
 * The sky is a fullscreen backdrop drawn first, with the depth test off
 * and no depth writes, so every solid surface painted afterwards simply
 * covers it. Wherever a sky ceiling left a column empty (the flats pass
 * skips F_SKY1 ceilings) the backdrop shows through — which is exactly
 * where DOOM shows sky. The cylindrical sampling (yaw → column, fixed
 * vertical scale anchored at the horizon) lives in the sky fragment
 * shader; see shaders.js.
 */

import { getSkyTexture } from '../textures.js';
import { DynamicBuffer } from '../glutil.js';

// Sky-wall quads rise from a sky-perimeter wall's top edge to here. Only
// needs to be tall enough that it always clears the top of the screen; the
// depth it writes is the wall's forward distance, independent of this
// height. Kept well inside the far plane.
const SKY_TOP = 16000;

export const skyPassMethods = {
    _renderSky(cam) {
        const gl = this.gl;
        const sky = getSkyTexture(gl);
        if (!sky) return;

        const prog = this.skyProgram;
        prog.use();
        gl.disable(gl.DEPTH_TEST);
        gl.depthMask(false);
        gl.disable(gl.STENCIL_TEST);

        gl.uniform1i(prog.u('u_sky'), 0);
        gl.uniform2f(prog.u('u_res'), this.W, this.H);
        gl.uniform1f(prog.u('u_angle'), cam.angle);
        gl.uniform2f(prog.u('u_skySize'), sky.width, sky.height);

        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sky.tex);

        const loc = prog.a('a_pos');
        gl.bindBuffer(gl.ARRAY_BUFFER, this._fullscreenBuffer.buffer);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);

        gl.depthMask(true);
        gl.enable(gl.DEPTH_TEST);
    },

    /**
     * Occlude level geometry that would otherwise show through the sky.
     *
     * For every front-facing wall whose sector has a sky ceiling and whose
     * top reaches it (the same test the canvas renderer's `skyAbove` uses),
     * emit a quad from that top edge up to SKY_TOP and draw it sampling the
     * sky (seamless with the backdrop) while writing depth. Anything beyond
     * the opening then fails the depth test and disappears, exactly as in
     * the original game. Rebuilt each frame so the back-face cull tracks the
     * camera. Runs after the backdrop, before the world passes.
     */
    _renderSkyWalls(cam) {
        const gl = this.gl;
        const scene = this.scene;
        const sky = getSkyTexture(gl);
        if (!sky) return;

        const arr = this._skyWallArr || (this._skyWallArr = []);
        arr.length = 0;
        for (const wall of scene.walls) {
            const skyCeil = scene._skyCeil.get(wall.sectorIndex);
            if (skyCeil === undefined) continue;
            const wallTop = scene._wallTopOverride.get(wall) ?? wall.topHeight;
            if (Math.abs(wallTop - skyCeil) >= 1) continue;
            const ax = wall.start.x, ay = wall.start.y, bx = wall.end.x, by = wall.end.y;
            const dx = bx - ax, dy = by - ay;
            // Same back-face cull as the wall pass — only paint sky above
            // walls actually facing the viewer.
            const mx = (ax + bx) * 0.5, my = (ay + by) * 0.5;
            if ((cam.ex - mx) * dy - (cam.ey - my) * dx < 0) continue;
            arr.push(ax, ay, skyCeil, bx, by, skyCeil, bx, by, SKY_TOP,
                     ax, ay, skyCeil, bx, by, SKY_TOP, ax, ay, SKY_TOP);
        }
        if (arr.length === 0) return;

        const buf = this._skyWallBuf || (this._skyWallBuf = new DynamicBuffer(gl));
        let scratch = this._skyWallF32;
        if (!scratch || scratch.length < arr.length) scratch = this._skyWallF32 = new Float32Array(arr.length);
        scratch.set(arr);
        buf.set(scratch, arr.length);

        const prog = this.skyWallProgram;
        prog.use();
        this._setCameraUniforms(prog);
        gl.uniform1i(prog.u('u_sky'), 0);
        gl.uniform2f(prog.u('u_res'), this.W, this.H);
        gl.uniform1f(prog.u('u_angle'), cam.angle);
        gl.uniform2f(prog.u('u_skySize'), sky.width, sky.height);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, sky.tex);

        gl.enable(gl.DEPTH_TEST);
        gl.depthMask(true);
        gl.disable(gl.STENCIL_TEST);

        const loc = prog.a('a_pos');
        gl.bindBuffer(gl.ARRAY_BUFFER, buf.buffer);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 3, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, arr.length / 3);
    },
};
