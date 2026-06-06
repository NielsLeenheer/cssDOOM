/**
 * GLEngine — the WebGL2 counterpart of the canvas SoftwareRenderer.
 *
 * Where SoftwareRenderer paints a low-res pixel buffer on the CPU, this
 * draws the world with the GPU: textured wall quads, stencil-filled
 * floor/ceiling planes, a cylindrical sky backdrop and camera-facing
 * sprite billboards, all into a full-resolution drawing buffer with real
 * per-pixel depth. The textures are sampled NEAREST and the sector light
 * is quantised into colormap-style bands in the fragment shaders, so the
 * crisp high-res geometry still wears the original game's chunky low-res
 * skin — the look this project is built around.
 *
 * It deliberately reuses the canvas renderer's rendering-agnostic parts:
 *
 *   Scene (../canvas/scene.js)      the mutable world model + per-frame
 *                                   simulation (doors, lifts, light
 *                                   specials, animation clocks). Identical
 *                                   between the two renderers, so it lives
 *                                   in one place and both forward the same
 *                                   SCENE_COMMANDS to it.
 *   commandMethods (../canvas/…)    the view-side command setters (weapon,
 *                                   HUD readout, flash, screen toggles) —
 *                                   pure presentation state, renderer-
 *                                   independent.
 *   tables.js data                  sprite / animation / HUD layout tables.
 *
 * Everything WebGL-specific — the programs, the passes, the overlay blit —
 * is local to this folder. Per-frame orchestration lives in `render`; the
 * passes (passes/*.js) and the overlay (overlay.js) are mixins assembled
 * onto the prototype at the bottom of this file, exactly as the canvas
 * renderer assembles its software passes.
 */

import { Program, StaticBuffer, DynamicBuffer } from './glutil.js';
import {
    WORLD_VS, WORLD_FS, FLAT_VS, FLAT_FS, SKY_VS, SKY_FS,
    BLIT_VS, BLIT_FS, SOLID_VS, SOLID_FS,
} from './shaders.js';
import { getWallTexture, getFlatTexture, clearTextureCache } from './textures.js';

import { Scene, SCENE_COMMANDS } from '../canvas/scene.js';
import { commandMethods } from '../canvas/commands.js';
import { NEAR } from '../canvas/tables.js';

import { skyPassMethods } from './passes/sky.js';
import { wallPassMethods } from './passes/walls.js';
import { flatPassMethods } from './passes/flats.js';
import { entityPassMethods } from './passes/entities.js';
import { overlayMethods } from './overlay.js';

const FAR = 20000;   // depth far plane — generously past any map extent

export class GLEngine {
    constructor(gl, resolution) {
        this.gl = gl;
        this.resolution = resolution;

        // World model + per-frame simulation (shared with the canvas
        // renderer). The engine forwards every world command here.
        this.scene = new Scene();

        // GL programs, one per pass.
        this.worldProgram = new Program(gl, WORLD_VS, WORLD_FS);
        this.flatProgram = new Program(gl, FLAT_VS, FLAT_FS);
        this.skyProgram = new Program(gl, SKY_VS, SKY_FS);
        this.blitProgram = new Program(gl, BLIT_VS, BLIT_FS);
        this.solidProgram = new Program(gl, SOLID_VS, SOLID_FS);

        // A clip-space covering triangle, reused by the sky + solid passes.
        this._fullscreenBuffer = new StaticBuffer(gl, new Float32Array([-1, -1, 3, -1, -1, 3]));
        // Streamed geometry buffers for billboards + overlay quads.
        this._spriteBuffer = new DynamicBuffer(gl);
        this._overlayBuffer = new DynamicBuffer(gl);

        this._flats = null;            // per-sector static flat geometry

        // ── View state (per-pane presentation; see commandMethods) ──────
        this.viewerPlayerIndex = 0;
        this.weapon = null;
        this.flash = null;
        this.hud = null;
        this.intermission = null;
        this.results = null;
        this.lobby = null;

        // Drawing-buffer + overlay dimensions, set by resize().
        this.W = 0; this.H = 0;
        this.overlayW = 0; this.overlayH = 0;
        // The overlay (HUD/weapon) scales below the world resolution so the
        // bar/weapon stay relatively smaller as the world sharpens — same
        // 1x→1, 2x→1, 3x→2, 4x→3 mapping the canvas renderer uses.
        this.uiScale = Math.max(1, resolution - 1);

        // Per-frame transients.
        this._cam = null;
        this._aspect = 1;
        this._A = (FAR + NEAR) / (FAR - NEAR);
        this._B = -2 * FAR * NEAR / (FAR - NEAR);
        this._lastFrameTime = 0;
        this._bobX = 0; this._bobY = 0;
        this._lastCamX = null; this._lastCamY = null;
    }

    /** Size the drawing buffer (W×H device pixels) and recompute the
     *  overlay virtual canvas (mirrors canvas/renderer.js::_resize). */
    resize(W, H) {
        this.W = W; this.H = H;
        this._aspect = W / H;
        this.gl.viewport(0, 0, W, H);

        const f = this.resolution;
        const aspect = W / H;
        const maxIH = 200 * f, maxIW = 640 * f;
        let iw, ih;
        if (maxIH * aspect <= maxIW) { ih = maxIH; iw = Math.max(1, Math.round(ih * aspect)); }
        else { iw = maxIW; ih = Math.max(1, Math.round(iw / aspect)); }
        this.overlayW = iw; this.overlayH = ih;
    }

    setMap(data) {
        this.scene.setMap(data);
        this._buildFlatGeometry();
    }

    clear() {
        this.scene.clear();
        if (this._flats) { for (const f of this._flats) { f.fan.dispose(); f.quad.dispose(); } this._flats = []; }
    }

    destroy() {
        const gl = this.gl;
        this._fullscreenBuffer.dispose();
        this._spriteBuffer.dispose();
        this._overlayBuffer.dispose();
        if (this._wallBuffer) this._wallBuffer.dispose();
        if (this._flats) for (const f of this._flats) { f.fan.dispose(); f.quad.dispose(); }
        for (const p of [this.worldProgram, this.flatProgram, this.skyProgram, this.blitProgram, this.solidProgram]) {
            gl.deleteProgram(p.program);
        }
        clearTextureCache(gl);
    }

    // ── Shared pass helpers ──────────────────────────────────────────

    /** Push the live camera + projection into a world/flat program. */
    _setCameraUniforms(prog) {
        const gl = this.gl, c = this._cam;
        gl.uniform3f(prog.u('u_eye'), c.ex, c.ey, c.ez);
        gl.uniform2f(prog.u('u_rot'), c.ca, c.sa);
        gl.uniform1f(prog.u('u_aspect'), this._aspect);
        gl.uniform1f(prog.u('u_A'), this._A);
        gl.uniform1f(prog.u('u_B'), this._B);
    }

    /** Bind a 6-float-stride world vertex buffer to a_pos/a_uv/a_light. */
    _bindWorldAttribs(prog, buf) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, buf.buffer);
        const ap = prog.a('a_pos'), au = prog.a('a_uv'), al = prog.a('a_light');
        gl.enableVertexAttribArray(ap); gl.vertexAttribPointer(ap, 3, gl.FLOAT, false, 24, 0);
        gl.enableVertexAttribArray(au); gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 24, 12);
        gl.enableVertexAttribArray(al); gl.vertexAttribPointer(al, 1, gl.FLOAT, false, 24, 20);
    }

    _getWall(name) { return getWallTexture(this.gl, name); }
    _getFlat(name) { return getFlatTexture(this.gl, name); }

    // ── Per-frame entry point ────────────────────────────────────────

    render(camera) {
        const gl = this.gl;
        if (!this.W) return;
        gl.viewport(0, 0, this.W, this.H);
        const now = performance.now();

        // Full-screen overlays own the whole pane and freeze the world,
        // matching the canvas renderer's routing exactly.
        if (this.results) { this._renderResults(now); return; }
        if (this.intermission) { this._renderIntermission(now); return; }
        if (this.lobby?.variant === 'network' || (this.lobby && this.scene.walls.length === 0)) {
            this._renderLobby(now); return;
        }

        // Advance the world: moving sectors, light specials, anim clocks.
        const dt = this._lastFrameTime ? Math.min(0.1, (now - this._lastFrameTime) / 1000) : 0;
        this._lastFrameTime = now;
        this.scene.viewerPlayerIndex = this.viewerPlayerIndex;
        this.scene.update(dt, now);

        this._cam = {
            ex: camera.x, ey: camera.y, ez: camera.z,
            ca: Math.cos(camera.angle), sa: Math.sin(camera.angle),
            angle: camera.angle,
        };

        gl.clearColor(0, 0, 0, 1);
        gl.clearDepth(1);
        gl.clearStencil(0);
        gl.depthMask(true);
        gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
        gl.depthFunc(gl.LESS);

        this._renderSky(this._cam);
        this._renderFlats();
        this._renderWalls(this._cam);
        this._renderEntities(this._cam);

        // Screen-space overlay on top of the world.
        this._beginOverlay();
        this._renderWeapon(this._cam, now, dt);
        this._renderHud(now);
        this._renderFlash(now);
        if (this.lobby?.variant === 'local') this._overlayLocalLobby(now);
    }
}

// Assemble the passes + overlay + view commands onto the prototype.
Object.assign(
    GLEngine.prototype,
    skyPassMethods,
    wallPassMethods,
    flatPassMethods,
    entityPassMethods,
    overlayMethods,
    commandMethods,
);

// World dispatch commands forward to the Scene, so the engine presents one
// flat command surface (WebGLRenderer dispatches `this.engine[cmd](...)`)
// while the world mutation logic stays on the shared model.
for (const cmd of SCENE_COMMANDS) {
    GLEngine.prototype[cmd] = function (...args) { return this.scene[cmd](...args); };
}
