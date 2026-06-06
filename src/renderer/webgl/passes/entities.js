/**
 * Entity pass for the WebGLRenderer (mixed onto the engine prototype):
 * things, projectiles and transient effects, all drawn as camera-facing
 * billboards using the same front-facing sprite frame selection as the
 * canvas renderer (see `_thingSprite`), depth-tested against the world.
 *
 * A billboard is a vertical quad whose width runs along the camera's
 * world-space right vector (cos, sin of the view yaw) and whose height
 * runs up the world Z axis — so it always faces the viewer but stays
 * upright. Sprites are pulled a couple of world units toward the camera
 * (the shared shader's `u_zbias`) so they sit cleanly in front of the
 * floor they stand on instead of z-fighting it.
 */

import { getSpriteTexture } from '../textures.js';
import {
    itemFrameName, buildRotName, DEATH_FRAME_MS, WALK_FRAME_MS, NEAR, MAX_DIST,
} from '../../canvas/tables.js';

export const entityPassMethods = {
    _renderEntities(cam) {
        const gl = this.gl;
        const now = performance.now();
        const scene = this.scene;

        const prog = this.worldProgram;
        prog.use();
        this._setCameraUniforms(prog);
        gl.uniform1f(prog.u('u_zbias'), 2);
        gl.uniform1f(prog.u('u_uvWorld'), 0);
        gl.uniform2f(prog.u('u_texSize'), 1, 1);
        gl.uniform1i(prog.u('u_tex'), 0);
        gl.activeTexture(gl.TEXTURE0);
        gl.enable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);

        // Static decorations + corpses (some decorations idle-animate).
        for (const s of scene.statics) {
            const tex = getSpriteTexture(gl, itemFrameName(s.name, now));
            if (tex && tex.width > 1) this._drawBillboard(cam, s.x, s.y, s.floorZ, tex, s.light, false, false);
        }

        // Game-driven things (enemies, pickups, barrels, players).
        for (const e of scene.things.values()) {
            if (e.collected) continue;
            if (e.playerIndex !== undefined && e.playerIndex === this.viewerPlayerIndex) continue;
            const spr = this._thingSprite(e, now);
            if (!spr) continue;
            const tex = getSpriteTexture(gl, spr.name);
            if (!tex || tex.width <= 1) continue;
            this._drawBillboard(cam, e.x, e.y, e.floorZ, tex, e.light, spr.mirror, false);
        }

        // Projectiles — linear interpolation start → end over duration.
        for (const [id, p] of scene.projectiles) {
            const t = (now - p.start) / (p.duration * 1000);
            if (t >= 1) { scene.projectiles.delete(id); continue; }
            const tex = getSpriteTexture(gl, p.sprite);
            if (tex && tex.width > 1) {
                this._drawBillboard(cam,
                    p.sx + (p.ex - p.sx) * t, p.sy + (p.ey - p.sy) * t, p.sz + (p.ez - p.sz) * t,
                    tex, 250, false, true);
            }
        }

        // Transient effects — advance frames, drop when finished.
        for (let i = scene.effects.length - 1; i >= 0; i--) {
            const fx = scene.effects[i];
            const frame = ((now - fx.start) / fx.frameMs) | 0;
            if (frame >= fx.frames.length) { scene.effects.splice(i, 1); continue; }
            const tex = getSpriteTexture(gl, fx.frames[frame]);
            if (tex && tex.width > 1) this._drawBillboard(cam, fx.x, fx.y, fx.z, tex, 250, false, fx.centered);
        }
    },

    /** Current sprite frame + mirror flag for a thing entry (identical
     *  selection logic to the canvas renderer). */
    _thingSprite(e, now) {
        if (!e.isEnemy) return { name: itemFrameName(e.fixedName, now), mirror: false };
        const anim = e.anim;
        if (e.state === 'dead' && anim.death) {
            const fr = anim.death;
            const idx = e.deathStart < 0
                ? fr.length - 1
                : Math.min(fr.length - 1, ((now - e.deathStart) / DEATH_FRAME_MS) | 0);
            return { name: `${anim.spr}${fr[idx]}0`, mirror: false };
        }
        const frame = e.state === 'attack' ? anim.attack
            : e.state === 'idle' ? anim.walk[0]
            : anim.walk[(((now + e.walkPhase) / WALK_FRAME_MS) | 0) % anim.walk.length];
        return buildRotName(anim.spr, frame, e.rotation);
    },

    _drawBillboard(cam, wx, wy, z, tex, level, mirror, centered) {
        // Cull behind the near plane / past the far cull, matching canvas.
        const cy = cam.ca * (wy - cam.ey) - cam.sa * (wx - cam.ex);
        if (cy < NEAR || cy > MAX_DIST) return;

        const gl = this.gl;
        const prog = this.worldProgram;
        const sw = tex.width, sh = tex.height;
        const half = sw * 0.5;
        // Camera-right vector in world space is (cos, sin) of the yaw.
        const rx = cam.ca * half, ry = cam.sa * half;
        const lx = wx - rx, ly = wy - ry;
        const Rx = wx + rx, Ry = wy + ry;
        const topZ = centered ? z + sh * 0.5 : z + sh;
        const botZ = centered ? z - sh * 0.5 : z;

        const u0 = mirror ? 1 : 0, u1 = mirror ? 0 : 1;
        const data = this._spriteScratch || (this._spriteScratch = new Float32Array(36));
        // x,y,z,u,v,light per vertex; ABC, ACD with A=topL B=topR C=botR D=botL.
        let i = 0;
        const push = (x, y, zz, u, v) => {
            data[i++] = x; data[i++] = y; data[i++] = zz; data[i++] = u; data[i++] = v; data[i++] = level;
        };
        push(lx, ly, topZ, u0, 0);
        push(Rx, Ry, topZ, u1, 0);
        push(Rx, Ry, botZ, u1, 1);
        push(lx, ly, topZ, u0, 0);
        push(Rx, Ry, botZ, u1, 1);
        push(lx, ly, botZ, u0, 1);

        const buf = this._spriteBuffer;
        buf.set(data, 36);
        this._bindWorldAttribs(prog, buf);
        gl.bindTexture(gl.TEXTURE_2D, tex.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    },
};
