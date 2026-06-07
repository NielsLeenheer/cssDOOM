/**
 * Screen-space HUD passes for the SoftwareRenderer (mixed onto the
 * prototype): the status bar, the held weapon sprite, and the damage /
 * pickup screen flash. All drawn into the framebuffer after the world,
 * with no depth test — they sit on top. They draw through the shared
 * `this.framebuffer.blit` overlay primitive and read `this.uiScale`.
 */

import { getHudTexture, getWeaponTexture } from '../textures.js';
import {
    glyphIndex, BIG_GLYPH_W, BIG_GLYPH_H, SMALL_GLYPH_W, SMALL_GLYPH_H,
    FACE_W, FACE_H, WEAPON_AMMO, HUD_AMMO_TYPES, ARMS_SLOTS, HUD_KEYS,
    FLASH_MS,
} from '../tables.js';

export const hudMethods = {
    _renderHud(now) {
        const hud = this.hud;
        if (!hud) return;
        const stbar = getHudTexture('STBAR');
        if (!stbar || stbar.width <= 1) return;

        const { W, H } = this.framebuffer;
        // Draw the bar at its native 320×32 resolution times uiScale,
        // bottom-centred. Narrower framebuffers clip the sides rather
        // than downscaling the bar; at higher resolutions the bar grows
        // with the framebuffer so its relative on-screen size is the
        // same as at 1x.
        const scale = this.uiScale;
        const barW = 320 * scale;
        const barH = 32 * scale;
        const barY = H - barH;
        const barX = Math.round((W - barW) / 2);   // negative → sides clip
        const dx = nx => barX + nx * scale;
        const dy = ny => barY + ny * scale;

        // Bar background.
        this.framebuffer.blit(stbar, 0, 0, 320, 32, barX, barY, barW, barH);

        const digits = getHudTexture('DIGITS_SHEET');

        // Big number, right-aligned so its last glyph ends at native xR.
        const bigNum = (str, xR, yT) => {
            if (!digits || digits.width <= 1) return;
            let x = xR;
            for (let i = str.length - 1; i >= 0; i--) {
                const g = glyphIndex(str[i]);
                if (g < 0) continue;
                x -= BIG_GLYPH_W;
                this.framebuffer.blit(digits, g * BIG_GLYPH_W, 0, BIG_GLYPH_W, BIG_GLYPH_H,
                    dx(x), dy(yT), BIG_GLYPH_W * scale, BIG_GLYPH_H * scale);
            }
        };

        // Ammo (current weapon), health, armor.
        // Right-edge anchors follow cssDOOM's STBAR section layout
        // (ammo 0-48, health 48-106, armor 179-236).
        const ammoType = WEAPON_AMMO[hud.currentWeapon];
        if (ammoType) bigNum(String(Math.round(hud.ammo[ammoType] ?? 0)), 44, 3);
        bigNum(`${hud.health}%`, 104, 3);
        bigNum(`${hud.armor}%`, 235, 3);

        // Per-type ammo: current (right edge 288) and max (right edge 314),
        // four rows 6px apart from y=5.
        const small = getHudTexture('SMALL_DIGITS_SHEET');
        if (small && small.width > 1) {
            const smallNum = (str, xR, yT) => {
                let x = xR;
                for (let i = str.length - 1; i >= 0; i--) {
                    const g = glyphIndex(str[i]);
                    if (g < 0 || g > 9) continue;
                    x -= SMALL_GLYPH_W;
                    this.framebuffer.blit(small, g * SMALL_GLYPH_W, 0, SMALL_GLYPH_W, SMALL_GLYPH_H,
                        dx(x), dy(yT), SMALL_GLYPH_W * scale, SMALL_GLYPH_H * scale);
                }
            };
            for (let i = 0; i < HUD_AMMO_TYPES.length; i++) {
                const t = HUD_AMMO_TYPES[i];
                const yT = 5 + i * 6;
                smallNum(String(Math.round(hud.ammo[t] ?? 0)), 288, yT);
                smallNum(String(hud.maxAmmo[t] ?? 0), 314, yT);
            }
        }

        // Arms panel (weapon ownership): the ARMS background plus a per-
        // slot number — yellow STYSNUM if owned, grey STGNUM otherwise.
        const arms = getHudTexture('STARMS');
        if (arms && arms.width > 1) {
            this.framebuffer.blit(arms, 0, 0, 40, 32, dx(104), dy(0), 40 * scale, 32 * scale);
            for (const s of ARMS_SLOTS) {
                const owned = hud.ownedWeapons.has(s.slot);
                const glyph = getHudTexture(`${owned ? 'STYSNUM' : 'STGNUM'}${s.slot}`);
                if (!glyph || glyph.width <= 1) continue;
                this.framebuffer.blit(glyph, 0, 0, 4, 6, dx(s.x), dy(s.y), 4 * scale, 6 * scale);
            }
        }

        // Face: row by health band, column animates while alive.
        const face = getHudTexture('FACE_SHEET');
        if (face && face.width > 1) {
            const h = hud.health;
            const row = h >= 80 ? 0 : h >= 60 ? 1 : h >= 40 ? 2 : h >= 20 ? 3 : 4;
            const col = h <= 0 ? 0 : ((now / 500) | 0) % 3;
            this.framebuffer.blit(face, col * FACE_W, row * FACE_H, FACE_W, FACE_H,
                dx(143 + (36 - FACE_W) / 2), dy(1), FACE_W * scale, FACE_H * scale);
        }

        // Collected keycards: 7×5 icons stacked in the keys section
        // (native x 236-249), centred horizontally and spaced down the bar.
        for (let i = 0; i < HUD_KEYS.length; i++) {
            if (!hud.keys.has(HUD_KEYS[i].color)) continue;
            const icon = getHudTexture(HUD_KEYS[i].icon);
            if (!icon || icon.width <= 1) continue;
            this.framebuffer.blit(icon, 0, 0, 7, 5,
                dx(239), dy(4 + i * 9), 7 * scale, 5 * scale);
        }
    },

    _renderWeapon(cam, now, dt) {
        const wpn = this.weapon;
        if (!wpn) return;
        const tex = getWeaponTexture(wpn.name);
        if (!tex || tex.width <= 1) return;
        const { fw, fh, frames } = wpn.info;

        // Pick the frame: idle (0) unless mid fire animation.
        let frame = 0;
        if (wpn.firing) {
            const e = now - wpn.fireStart;
            if (e < wpn.fireRate) {
                frame = 1 + Math.min(frames - 2, ((e / wpn.fireRate) * (frames - 1)) | 0);
            }
        }

        // Weapon bob: a small figure-eight that builds while the view is
        // moving and eases back to centre when it stops. `this._moving` is
        // detected once per frame in render() (it also drives the head bob),
        // so the weapon sway stays in sync with the view.
        const targetMag = this._moving ? 1 : 0;
        const phase = (now / 1000) * 6;
        const ease = 6 * dt;
        this._bobX += ((Math.cos(phase) * 5 * targetMag) - this._bobX) * Math.min(1, ease);
        this._bobY += ((Math.abs(Math.sin(phase)) * 4 * targetMag) - this._bobY) * Math.min(1, ease);

        const { W, H } = this.framebuffer;
        const ui = this.uiScale;
        const destW = fw * ui, destH = fh * ui;
        // Rest the weapon on top of the status bar, tucked ~30 CSS px into
        // it, matching the DomRenderer (`bottom: anchor(top)` +
        // `margin-bottom: -30px`) and the WebGL renderer. The bar is 32
        // framebuffer px × uiScale tall (see _renderHud); without this the
        // sprite sat flush at the very bottom of the framebuffer — about a
        // full bar-height too low.
        const barTop = H - 32 * ui;
        const dpr = window.devicePixelRatio || 1;
        const overlap = this.displayH ? 30 * dpr * H / this.displayH : 0.4 * 32 * ui;
        const destX = Math.round((W - destW) / 2 + this._bobX * ui);
        const destY = Math.round(barTop + overlap - destH + this._bobY * ui);
        this.framebuffer.blit(tex, frame * fw, 0, fw, fh, destX, destY, destW, destH);
    },

    _renderFlash(now) {
        if (!this.flash) return;
        const e = now - this.flash.start;
        if (e >= FLASH_MS) { this.flash = null; return; }
        const a = 0.35 * (1 - e / FLASH_MS);
        const ia = 1 - a;
        const fr = this.flash.r * a, fg = this.flash.g * a, fb_ = this.flash.b * a;
        const { fb } = this.framebuffer;
        for (let i = 0, n = fb.length; i < n; i++) {
            const px = fb[i];
            const r = ((px & 0xff) * ia + fr) | 0;
            const g = (((px >> 8) & 0xff) * ia + fg) | 0;
            const b = (((px >> 16) & 0xff) * ia + fb_) | 0;
            fb[i] = 0xff000000 | (b << 16) | (g << 8) | r;
        }
    },
};
