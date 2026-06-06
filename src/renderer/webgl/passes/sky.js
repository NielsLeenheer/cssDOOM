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
};
