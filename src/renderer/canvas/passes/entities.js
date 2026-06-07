/**
 * Entity render pass for the SoftwareRenderer (mixed onto the prototype):
 * things, projectiles and transient effects, all drawn as camera-facing
 * billboards using the front-facing sprite frame, depth-tested against the
 * world per pixel.
 */

import { getSpriteTexture } from '../textures.js';
import {
    itemFrameName, buildRotName,
    DEATH_FRAME_MS, WALK_FRAME_MS, NEAR, MAX_DIST,
    lightFor, shade,
} from '../tables.js';

export const entityMethods = {
    _renderEntities(cam) {
        const now = performance.now();
        const scene = this.scene;

        // Static decorations + corpses (some decorations idle-animate).
        for (const s of scene.statics) {
            const tex = getSpriteTexture(itemFrameName(s.name, now));
            if (tex && tex.width > 1) {
                this._drawBillboard(cam, s.x, s.y, s.floorZ, tex, s.light, false, false, s.sectorIndex);
            }
        }

        // Game-driven things (enemies, pickups, barrels, players).
        for (const e of scene.things.values()) {
            if (e.collected) continue;
            // Don't draw this viewer's own player billboard.
            if (e.playerIndex !== undefined && e.playerIndex === this.viewerPlayerIndex) continue;
            const spr = this._thingSprite(e, now);
            if (!spr) continue;
            const tex = getSpriteTexture(spr.name);
            if (!tex || tex.width <= 1) continue;
            this._drawBillboard(cam, e.x, e.y, e.floorZ, tex, e.light, spr.mirror, false, e.sectorIndex);
        }

        // Projectiles — linear interpolation start → end over duration.
        for (const [id, p] of scene.projectiles) {
            const t = (now - p.start) / (p.duration * 1000);
            if (t >= 1) { scene.projectiles.delete(id); continue; }
            const tex = getSpriteTexture(p.sprite);
            if (tex && tex.width > 1) {
                this._drawBillboard(cam,
                    p.sx + (p.ex - p.sx) * t,
                    p.sy + (p.ey - p.sy) * t,
                    p.sz + (p.ez - p.sz) * t,
                    tex, 250, false, true);
            }
        }

        // Transient effects — advance frames, drop when finished.
        for (let i = scene.effects.length - 1; i >= 0; i--) {
            const fx = scene.effects[i];
            const frame = ((now - fx.start) / fx.frameMs) | 0;
            if (frame >= fx.frames.length) { scene.effects.splice(i, 1); continue; }
            const tex = getSpriteTexture(fx.frames[frame]);
            if (tex && tex.width > 1) {
                this._drawBillboard(cam, fx.x, fx.y, fx.z, tex, 250, false, fx.centered);
            }
        }
    },

    /** Current sprite frame + mirror flag for a thing entry. */
    _thingSprite(e, now) {
        if (!e.isEnemy) return { name: itemFrameName(e.fixedName, now), mirror: false };
        const anim = e.anim;

        if (e.state === 'dead' && anim.death) {
            const fr = anim.death;
            const idx = e.deathStart < 0
                ? fr.length - 1                                  // instant: rest frame
                : Math.min(fr.length - 1, ((now - e.deathStart) / DEATH_FRAME_MS) | 0);
            return { name: `${anim.spr}${fr[idx]}0`, mirror: false };
        }

        const frame = e.state === 'attack' ? anim.attack
            : e.state === 'idle' ? anim.walk[0]
            : anim.walk[(((now + e.walkPhase) / WALK_FRAME_MS) | 0) % anim.walk.length];
        return buildRotName(anim.spr, frame, e.rotation);
    },

    /**
     * Draw a camera-facing billboard. `centered` floats the sprite about
     * `z` (projectiles, puffs, explosions); otherwise it stands on `z`
     * (things, corpses, fog). `mirror` flips it horizontally for the
     * reused rotation art.
     */
    _drawBillboard(cam, wx, wy, z, tex, level, mirror, centered, sectorIndex = -1) {
        const { W, H, fb, zb } = this.framebuffer;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;

        const cx = (wx - ex) * ca + (wy - ey) * sa;
        const cy = ca * (wy - ey) - sa * (wx - ex);
        if (cy < NEAR || cy > MAX_DIST) return;

        const sw = tex.width, sh = tex.height, sdata = tex.data;
        const halfWorld = sw * 0.5;

        const pxL = halfW + ((cx - halfWorld) / cy) * sxScale;
        const pxR = halfW + ((cx + halfWorld) / cy) * sxScale;
        const topZ = (centered ? z + sh * 0.5 : z + sh) - ez;
        const botZ = (centered ? z - sh * 0.5 : z) - ez;
        const pyTop = halfH - (topZ / cy) * syScale;
        const pyBot = halfH - (botZ / cy) * syScale;

        const x0 = Math.max(0, Math.ceil(pxL - 0.5));
        const x1 = Math.min(W - 1, Math.floor(pxR - 0.5));
        const y0 = Math.max(0, Math.ceil(pyTop - 0.5));
        const y1 = Math.min(H - 1, Math.floor(pyBot - 0.5));
        if (x0 > x1 || y0 > y1) return;

        const invW = sw / (pxR - pxL || 1e-6);
        const invH = sh / (pyBot - pyTop || 1e-6);
        // Apply the live light-special multiplier for the billboard's sector
        // (1 for sectors without a special / projectiles), so decorations on a
        // pulsing platform dim in step with the surfaces — matches the walls
        // pass (`wall.lightLevel * _sectorLightMul`).
        const mul = sectorIndex >= 0 ? (this.scene._sectorLightMul[sectorIndex] ?? 1) : 1;
        const lf = lightFor(level * mul);

        for (let y = y0; y <= y1; y++) {
            const ty = ((y + 0.5 - pyTop) * invH) | 0;
            if (ty < 0 || ty >= sh) continue;
            const row = ty * sw;
            const base = y * W;
            for (let x = x0; x <= x1; x++) {
                const idx = base + x;
                // 2-unit lenience so a billboard sits in front of the
                // surface it rests on without z-fighting it.
                if (cy > zb[idx] + 2) continue;
                let tx = ((x + 0.5 - pxL) * invW) | 0;
                if (tx < 0 || tx >= sw) continue;
                if (mirror) tx = sw - 1 - tx;
                const texel = sdata[row + tx];
                if ((texel >>> 24) < 128) continue;
                fb[idx] = shade(texel, lf);
                zb[idx] = cy;
            }
        }
    },
};
