/**
 * Screen-space overlay for the WebGLRenderer (mixed onto the engine
 * prototype): the status bar, the held weapon, the damage/pickup flash,
 * and the full-screen intermission / results / lobby screens.
 *
 * This is the canvas renderer's HUD (passes/hud.js) + screens (screens.js)
 * ported from a software framebuffer to GL: every `framebuffer.blit` is a
 * textured 2D quad (`_blit`) and the two per-pixel passes — the screen
 * flash and the lobby dim — become a single blended fullscreen quad
 * (`_solidFill`). The layout maths is unchanged, so the HUD lands
 * pixel-for-pixel where the canvas pane puts it.
 *
 * Everything is laid out in a virtual pixel space (`overlayW × overlayH`,
 * height = 200 × resolution, width following the pane aspect); the
 * full-screen screens draw at native 320×200 centred in it. The status bar
 * and weapon scale with `this.uiScale`, which the engine recomputes each
 * resize: held at a min scale on small panes and a max on large ones,
 * ramping between two width breakpoints — the CSSRenderer's 2↔3 range,
 * smoothed and never wrapping into rows. The blit shader
 * samples the source graphics with NEAREST, so the overlay stays as crunchy
 * as the world's textures even though the GL canvas itself is high-res.
 */

import {
    getHudTexture, getWeaponTexture, getIntermissionTexture,
    getFontTexture, getMenuTexture,
} from './textures.js';
import {
    glyphIndex, BIG_GLYPH_W, BIG_GLYPH_H, SMALL_GLYPH_W, SMALL_GLYPH_H,
    FACE_W, FACE_H, WEAPON_AMMO, HUD_AMMO_TYPES, ARMS_SLOTS, HUD_KEYS,
    FLASH_MS,
    INTERMISSION_W, INTERMISSION_H,
    INTER_COUNT_UP_MS, INTER_STEP_MS, INTER_LABELS, INTER_LABEL_X,
    INTER_ROW_Y, INTER_VALUE_R,
    WINUM_W, WINUM_H, WIPCNT_W, WIPCNT_H, WICOLON_W, WICOLON_H,
    WIMINUS_W, WIMINUS_H, RESULT_COLOR_NAME, percentValue,
} from '../canvas/tables.js';

// DOM HUD pairing: P0→STFB0 (green), P1→STFB3 (red), P2→STFB1 (indigo),
// P3→STFB2 (brown). Matches scoreboard.css / hud.css.
const PLAYER_SWATCH = ['STFB0', 'STFB3', 'STFB1', 'STFB2'];

export const overlayMethods = {
    // ── GL blit primitives ───────────────────────────────────────────

    /** Set up the blit program + 2D state for a run of `_blit` calls. */
    _beginOverlay() {
        const gl = this.gl;
        const prog = this.blitProgram;
        prog.use();
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.disable(gl.BLEND);
        gl.uniform2f(prog.u('u_vres'), this.overlayW, this.overlayH);
        gl.uniform1i(prog.u('u_tex'), 0);
        gl.activeTexture(gl.TEXTURE0);
    },

    /** Blit a source texel rect of `tex` into a virtual-pixel dest rect,
     *  alpha-tested. Same signature as the canvas Framebuffer.blit. */
    _blit(tex, sx, sy, sw, sh, dx, dy, dw, dh) {
        if (!tex || tex.width <= 1) return;
        const gl = this.gl;
        const prog = this.blitProgram;
        const tw = tex.width, th = tex.height;
        const u0 = sx / tw, v0 = sy / th, u1 = (sx + sw) / tw, v1 = (sy + sh) / th;
        const x0 = dx, y0 = dy, x1 = dx + dw, y1 = dy + dh;
        const data = this._quadScratch || (this._quadScratch = new Float32Array(24));
        data.set([
            x0, y0, u0, v0,  x1, y0, u1, v0,  x1, y1, u1, v1,
            x0, y0, u0, v0,  x1, y1, u1, v1,  x0, y1, u0, v1,
        ]);
        this._overlayBuffer.set(data, 24);
        gl.bindBuffer(gl.ARRAY_BUFFER, this._overlayBuffer.buffer);
        const ap = prog.a('a_pos'), au = prog.a('a_uv');
        gl.enableVertexAttribArray(ap);
        gl.vertexAttribPointer(ap, 2, gl.FLOAT, false, 16, 0);
        gl.enableVertexAttribArray(au);
        gl.vertexAttribPointer(au, 2, gl.FLOAT, false, 16, 8);
        gl.bindTexture(gl.TEXTURE_2D, tex.tex);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
    },

    /** Blended fullscreen quad — the flash tint and the lobby dim. */
    _solidFill(r, g, b, a) {
        const gl = this.gl;
        const prog = this.solidProgram;
        prog.use();
        gl.disable(gl.DEPTH_TEST);
        gl.disable(gl.STENCIL_TEST);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
        gl.uniform4f(prog.u('u_color'), r, g, b, a);
        const loc = prog.a('a_pos');
        gl.bindBuffer(gl.ARRAY_BUFFER, this._fullscreenBuffer.buffer);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
        gl.disable(gl.BLEND);
    },

    // ── HUD: status bar ──────────────────────────────────────────────
    _renderHud(now) {
        const gl = this.gl;
        const hud = this.hud;
        if (!hud) return;
        const stbar = getHudTexture(gl, 'STBAR');
        if (!stbar || stbar.width <= 1) return;

        const W = this.overlayW, H = this.overlayH;
        const scale = this.uiScale;
        const barW = 320 * scale, barH = 32 * scale;
        const barY = H - barH;
        const barX = Math.round((W - barW) / 2);
        const dx = nx => barX + nx * scale;
        const dy = ny => barY + ny * scale;

        this._blit(stbar, 0, 0, 320, 32, barX, barY, barW, barH);

        const digits = getHudTexture(gl, 'DIGITS_SHEET');
        const bigNum = (str, xR, yT) => {
            if (!digits || digits.width <= 1) return;
            let x = xR;
            for (let i = str.length - 1; i >= 0; i--) {
                const g = glyphIndex(str[i]);
                if (g < 0) continue;
                x -= BIG_GLYPH_W;
                this._blit(digits, g * BIG_GLYPH_W, 0, BIG_GLYPH_W, BIG_GLYPH_H,
                    dx(x), dy(yT), BIG_GLYPH_W * scale, BIG_GLYPH_H * scale);
            }
        };

        const ammoType = WEAPON_AMMO[hud.currentWeapon];
        if (ammoType) bigNum(String(Math.round(hud.ammo[ammoType] ?? 0)), 44, 3);
        bigNum(`${hud.health}%`, 104, 3);
        bigNum(`${hud.armor}%`, 235, 3);

        const small = getHudTexture(gl, 'SMALL_DIGITS_SHEET');
        if (small && small.width > 1) {
            const smallNum = (str, xR, yT) => {
                let x = xR;
                for (let i = str.length - 1; i >= 0; i--) {
                    const g = glyphIndex(str[i]);
                    if (g < 0 || g > 9) continue;
                    x -= SMALL_GLYPH_W;
                    this._blit(small, g * SMALL_GLYPH_W, 0, SMALL_GLYPH_W, SMALL_GLYPH_H,
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

        const arms = getHudTexture(gl, 'STARMS');
        if (arms && arms.width > 1) {
            this._blit(arms, 0, 0, 40, 32, dx(104), dy(0), 40 * scale, 32 * scale);
            for (const s of ARMS_SLOTS) {
                const owned = hud.ownedWeapons.has(s.slot);
                const glyph = getHudTexture(gl, `${owned ? 'STYSNUM' : 'STGNUM'}${s.slot}`);
                if (!glyph || glyph.width <= 1) continue;
                this._blit(glyph, 0, 0, 4, 6, dx(s.x), dy(s.y), 4 * scale, 6 * scale);
            }
        }

        const face = getHudTexture(gl, 'FACE_SHEET');
        if (face && face.width > 1) {
            const h = hud.health;
            const row = h >= 80 ? 0 : h >= 60 ? 1 : h >= 40 ? 2 : h >= 20 ? 3 : 4;
            const col = h <= 0 ? 0 : ((now / 500) | 0) % 3;
            this._blit(face, col * FACE_W, row * FACE_H, FACE_W, FACE_H,
                dx(143 + (36 - FACE_W) / 2), dy(1), FACE_W * scale, FACE_H * scale);
        }

        for (let i = 0; i < HUD_KEYS.length; i++) {
            if (!hud.keys.has(HUD_KEYS[i].color)) continue;
            const icon = getHudTexture(gl, HUD_KEYS[i].icon);
            if (!icon || icon.width <= 1) continue;
            this._blit(icon, 0, 0, 7, 5, dx(239), dy(4 + i * 9), 7 * scale, 5 * scale);
        }
    },

    // ── HUD: held weapon ─────────────────────────────────────────────
    _renderWeapon(cam, now, dt) {
        const wpn = this.weapon;
        if (!wpn) return;
        const tex = getWeaponTexture(this.gl, wpn.name);
        if (!tex || tex.width <= 1) return;
        const { fw, fh, frames } = wpn.info;

        let frame = 0;
        if (wpn.firing) {
            const e = now - wpn.fireStart;
            if (e < wpn.fireRate) {
                frame = 1 + Math.min(frames - 2, ((e / wpn.fireRate) * (frames - 1)) | 0);
            }
        }

        // Movement is detected once per frame in the engine's render() (it
        // also drives the head bob); reuse it here.
        const targetMag = this._moving ? 1 : 0;
        const phase = (now / 1000) * 6;
        const ease = Math.min(1, 6 * dt);
        this._bobX += ((Math.cos(phase) * 5 * targetMag) - this._bobX) * ease;
        this._bobY += ((Math.abs(Math.sin(phase)) * 4 * targetMag) - this._bobY) * ease;

        const W = this.overlayW, H = this.overlayH;
        const ui = this.uiScale;
        const destW = fw * ui, destH = fh * ui;
        // Rest the weapon on top of the status bar, tucked ~30 CSS px into
        // it, matching the CSSRenderer (`bottom: anchor(top)` +
        // `margin-bottom: -30px`). The bar is 32 overlay px × uiScale tall
        // (see _renderHud); without this the sprite sat flush at the very
        // bottom of the framebuffer — about a full bar-height too low.
        const barTop = H - 32 * ui;
        const dpr = window.devicePixelRatio || 1;
        const overlap = this.H ? 30 * dpr * H / this.H : 0.4 * 32 * ui;
        const destX = Math.round((W - destW) / 2 + this._bobX * ui);
        const destY = Math.round(barTop + overlap - destH + this._bobY * ui);
        this._blit(tex, frame * fw, 0, fw, fh, destX, destY, destW, destH);
    },

    // ── HUD: screen flash ────────────────────────────────────────────
    _renderFlash(now) {
        if (!this.flash) return;
        const e = now - this.flash.start;
        if (e >= FLASH_MS) { this.flash = null; return; }
        const a = 0.35 * (1 - e / FLASH_MS);
        this._solidFill(this.flash.r / 255, this.flash.g / 255, this.flash.b / 255, a);
    },

    // ── SP intermission screen ───────────────────────────────────────
    _renderIntermission(now) {
        const im = this.intermission;
        const { ox, oy } = this._beginScreen('WIMAP0');
        const dx = nx => ox + nx, dy = ny => oy + ny;

        const m = /^E1M([1-9])$/.exec(im.mapName || '');
        if (m) {
            const wilv = getIntermissionTexture(this.gl, `WILV0${Number(m[1]) - 1}`);
            this._blitSprite(wilv, dx(160 - (wilv?.width ?? 0) / 2 | 0), dy(2));
        }
        const wif = getIntermissionTexture(this.gl, 'WIF');
        this._blitSprite(wif, dx(160 - (wif?.width ?? 0) / 2 | 0), dy(20));

        const elapsed = now - im.startTime;
        const progress = i => Math.max(0, Math.min(1, (elapsed - i * INTER_STEP_MS) / INTER_COUNT_UP_MS));
        const kills = percentValue(im.stats.kills);
        const items = percentValue(im.stats.items);
        const secrets = percentValue(im.stats.secrets);
        const timeSec = (im.stats.elapsedMs ?? 0) / 1000;

        for (let i = 0; i < INTER_LABELS.length; i++) {
            this._blitSprite(getIntermissionTexture(this.gl, INTER_LABELS[i]), dx(INTER_LABEL_X), dy(INTER_ROW_Y[i]));
        }
        this._drawInterPercent(Math.round(kills * progress(0)), dx(INTER_VALUE_R), dy(INTER_ROW_Y[0]));
        this._drawInterPercent(Math.round(items * progress(1)), dx(INTER_VALUE_R), dy(INTER_ROW_Y[1]));
        this._drawInterPercent(Math.round(secrets * progress(2)), dx(INTER_VALUE_R), dy(INTER_ROW_Y[2]));
        this._drawInterTime(timeSec * progress(3), dx(INTER_VALUE_R), dy(INTER_ROW_Y[3]));
    },

    _drawInterPercent(value, xR, yTop) {
        const pct = getIntermissionTexture(this.gl, 'WIPCNT');
        let x = xR;
        if (pct && pct.width > 1) {
            x -= WIPCNT_W;
            this._blit(pct, 0, 0, WIPCNT_W, WIPCNT_H, x, yTop, WIPCNT_W, WIPCNT_H);
        }
        this._drawInterDigits(String(Math.max(0, value | 0)), x, yTop);
    },

    _drawInterTime(totalSec, xR, yTop) {
        const t = Math.max(0, Math.floor(totalSec));
        const mm = Math.floor(t / 60), ss = t % 60;
        let x = xR;
        x = this._drawInterDigits(ss.toString().padStart(2, '0'), x, yTop);
        const colon = getIntermissionTexture(this.gl, 'WICOLON');
        if (colon && colon.width > 1) {
            x -= WICOLON_W;
            this._blit(colon, 0, 0, WICOLON_W, WICOLON_H, x, yTop + (WINUM_H - WICOLON_H), WICOLON_W, WICOLON_H);
        }
        this._drawInterDigits(String(mm), x, yTop);
    },

    _drawInterDigits(str, xR, yTop) {
        let x = xR;
        for (let i = str.length - 1; i >= 0; i--) {
            const d = str.charCodeAt(i) - 48;
            if (d < 0 || d > 9) continue;
            const tex = getIntermissionTexture(this.gl, `WINUM${d}`);
            if (!tex || tex.width <= 1) continue;
            x -= WINUM_W;
            this._blit(tex, 0, 0, WINUM_W, WINUM_H, x, yTop, WINUM_W, WINUM_H);
        }
        return x;
    },

    // ── Deathmatch results (frag matrix) ─────────────────────────────
    _renderResults(now) {
        const res = this.results;
        const { ox, oy } = this._beginScreen('WIMAP0');
        const dx = nx => ox + nx, dy = ny => oy + ny;

        const wif = getIntermissionTexture(this.gl, 'WIF');
        this._blitSprite(wif, dx(160 - (wif?.width ?? 0) / 2 | 0), dy(4));

        const banner = res.winnerIndex >= 0
            ? `${RESULT_COLOR_NAME[res.winnerIndex] ?? `PLAYER ${res.winnerIndex + 1}`} WINS`
            : 'TIE';
        this._text(banner, dx(160), dy(22), 'center');

        const scores = res.scores || [];
        const kills = res.kills || [];
        const n = scores.length;
        if (!n) return;

        const faceW = 26, faceH = 22;
        const dataW = 44, totalW = 70;
        const cellH = 26, headTop = 56;
        const gridW = faceW + 8 + n * dataW + totalW;
        const gridLeft = (320 - gridW) / 2 | 0;
        const faceColX = gridLeft;
        const dataX0 = gridLeft + faceW + 8;
        const totalColX = dataX0 + n * dataW;

        for (let v = 0; v < n; v++) {
            this._drawFaceSwatch(v, dx(dataX0 + v * dataW + (dataW - faceW) / 2 | 0), dy(headTop), faceW, faceH);
        }
        const totalLabel = getIntermissionTexture(this.gl, 'WIMSTT');
        if (totalLabel && totalLabel.width > 1) {
            this._blit(totalLabel, 0, 0, totalLabel.width, totalLabel.height,
                dx(totalColX + (totalW - totalLabel.width) / 2 | 0),
                dy(headTop + (faceH - totalLabel.height) / 2 | 0),
                totalLabel.width, totalLabel.height);
        }

        const rowsTop = headTop + faceH + 8;
        for (let k = 0; k < n; k++) {
            const ry = rowsTop + k * cellH;
            this._drawFaceSwatch(k, dx(faceColX), dy(ry + (cellH - faceH) / 2 | 0), faceW, faceH);
            for (let v = 0; v < n; v++) {
                const val = (kills[k] && kills[k][v]) || 0;
                this._drawCenteredNumber(val, dx(dataX0 + v * dataW + dataW / 2 | 0), dy(ry + (cellH - WINUM_H) / 2 | 0));
            }
            this._drawCenteredNumber(scores[k] ?? 0, dx(totalColX + totalW / 2 | 0), dy(ry + (cellH - WINUM_H) / 2 | 0));
        }
    },

    // ── Match lobby (network variant takes the whole screen) ─────────
    _renderLobby(now) {
        const lob = this.lobby;
        const { ox, oy } = this._beginScreen('WIMAP0');
        const dx = nx => ox + nx, dy = ny => oy + ny;

        const newg = getMenuTexture(this.gl, 'M_NEWG');
        this._blitSprite(newg, dx(160 - (newg?.width ?? 0) / 2 | 0), dy(20));
        const m = /^E1M([1-9])$/.exec(lob.mapCursor || '');
        if (m) {
            const wilv = getIntermissionTexture(this.gl, `WILV0${Number(m[1]) - 1}`);
            this._blitSprite(wilv, dx(160 - (wilv?.width ?? 0) / 2 | 0), dy(40));
        }

        const occ = lob.slotOccupants?.length ? lob.slotOccupants : (lob.slotsClaimed ?? []);
        const swatchW = 20, swatchH = 16, rowH = 22;
        const chevronX = 70, swatchX = 88, labelX = 116, statusX = 200;
        let y = 70;
        for (let i = 0; i < occ.length; i++) {
            if (i === this.viewerPlayerIndex) this._text('>>', dx(chevronX), dy(y + 4), 'left');
            this._drawFaceSwatch(i, dx(swatchX), dy(y), swatchW, swatchH);
            const claimed = occ[i] !== 'empty' && occ[i] !== false && occ[i] != null;
            const status = !claimed ? 'WAITING' : i === this.viewerPlayerIndex ? 'YOU' : 'READY';
            this._text(`PLAYER ${i + 1}`, dx(labelX), dy(y + 4), 'left');
            this._text(status, dx(statusX), dy(y + 4), 'left');
            y += rowH;
        }

        if (lob.roomCode) {
            y += 8;
            this._text(`ROOM CODE: ${lob.roomCode}`, dx(160), dy(y), 'center');
            y += 14;
        }
        y += 6;
        const prompt = lob.canStart
            ? (this.viewerPlayerIndex === 0 ? 'PRESS FIRE TO START GAME' : 'WAITING FOR GAME TO START')
            : 'WAITING FOR PLAYERS';
        this._text(prompt, dx(160), dy(y), 'center');
    },

    /** Local DM lobby overlay — painted on top of the live world. */
    _overlayLocalLobby(now) {
        const lob = this.lobby;
        const slot = this.viewerPlayerIndex;
        if (slot == null) return;

        const carried = lob.slotsCarriedOver?.[slot];
        const claimed = lob.slotsClaimed?.[slot];
        let claimState;
        if (claimed) claimState = carried ? 'active' : 'ready';
        else if (slot === lob.promptingSlot) claimState = 'prompting';
        else claimState = 'waiting';
        if (claimState === 'active') return;

        // Dim the world to ~30% brightness for waiting/prompting panes —
        // the canvas renderer's ×77/256 per-pixel darken expressed as a
        // black overlay at the matching alpha.
        if (claimState === 'waiting' || claimState === 'prompting') {
            this._solidFill(0, 0, 0, 1 - 77 / 256);
        }
        if (claimState === 'waiting') return;

        this._beginOverlay();
        const text = claimState === 'ready' ? 'READY!' : 'PRESS BUTTON TO\nCONNECT CONTROLLER';
        const W = this.overlayW, H = this.overlayH;
        const lines = text.split('\n');
        const lineH = 10;
        let y = (H - lines.length * lineH) / 2 | 0;
        for (const line of lines) { this._text(line, W / 2, y, 'center'); y += lineH; }
    },

    // ── Screen helpers ───────────────────────────────────────────────
    _screenOrigin() {
        return {
            ox: Math.round((this.overlayW - INTERMISSION_W) / 2),
            oy: Math.round((this.overlayH - INTERMISSION_H) / 2),
        };
    },

    /** Clear to black, stretch a backdrop over the whole overlay, and
     *  return the origin of the 320×200 native composition inside it. */
    _beginScreen(bgName) {
        const gl = this.gl;
        gl.clearColor(0, 0, 0, 1);
        gl.clear(gl.COLOR_BUFFER_BIT);
        this._beginOverlay();
        const bg = getIntermissionTexture(gl, bgName);
        if (bg && bg.width > 1) this._blit(bg, 0, 0, bg.width, bg.height, 0, 0, this.overlayW, this.overlayH);
        return this._screenOrigin();
    },

    _blitSprite(tex, x, y) {
        if (!tex || tex.width <= 1) return;
        this._blit(tex, 0, 0, tex.width, tex.height, x, y, tex.width, tex.height);
    },

    _drawFaceSwatch(playerIdx, x, y, w, h) {
        const swatch = getHudTexture(this.gl, PLAYER_SWATCH[playerIdx] ?? 'STFB0');
        if (swatch && swatch.width > 1) this._blit(swatch, 0, 0, swatch.width, swatch.height, x, y, w, h);
        const face = getHudTexture(this.gl, 'STFST00');
        if (face && face.width > 1) {
            const fw = Math.max(1, w - 4), fh = Math.max(1, h - 4);
            this._blit(face, 0, 0, face.width, face.height, x + (w - fw) / 2 | 0, y + (h - fh) / 2 | 0, fw, fh);
        }
    },

    _drawCenteredNumber(value, xCenter, yTop) {
        const v = value | 0;
        const neg = v < 0;
        const str = Math.abs(v).toString();
        const totalW = str.length * WINUM_W + (neg ? WIMINUS_W + 1 : 0);
        let x = xCenter + (totalW / 2 | 0);
        x = this._drawInterDigits(str, x, yTop);
        if (neg) {
            const minus = getIntermissionTexture(this.gl, 'WIMINUS');
            if (minus && minus.width > 1) {
                x -= WIMINUS_W + 1;
                this._blit(minus, 0, 0, WIMINUS_W, WIMINUS_H, x, yTop + (WINUM_H - WIMINUS_H) / 2 | 0, WIMINUS_W, WIMINUS_H);
            }
        }
    },

    // ── Text (DOOM small font) ───────────────────────────────────────
    _measureText(str, scale = 1) {
        const s = str.toUpperCase();
        let w = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 32) { w += 4 * scale; continue; }
            const g = getFontTexture(this.gl, c);
            w += ((g && g.width > 1 ? g.width : 4) + 1) * scale;
        }
        return w;
    },

    _text(str, x, y, align = 'left') { return this._textScaled(str, x, y, 1, align); },

    _textScaled(str, x, y, scale, align = 'left') {
        const s = str.toUpperCase();
        let cx = align === 'center' ? Math.round(x - this._measureText(s, scale) / 2) : x;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 32) { cx += 4 * scale; continue; }
            const g = getFontTexture(this.gl, c);
            if (!g || g.width <= 1) { cx += 5 * scale; continue; }
            this._blit(g, 0, 0, g.width, g.height, cx, y, g.width * scale, g.height * scale);
            cx += (g.width + 1) * scale;
        }
        return cx;
    },
};
