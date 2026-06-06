/**
 * Full-screen overlay screens for the canvas SoftwareRenderer:
 * SP intermission, deathmatch results, and the match lobby, plus the
 * shared DOOM-small-font text helpers they use.
 *
 * These are exported as a methods object and mixed onto
 * SoftwareRenderer.prototype (see software.js), so the methods run with
 * `this` bound to the renderer — they read its per-frame screen state
 * (`this.intermission` / `.results` / `.lobby`, `this.screenScale`) and
 * draw through `this._blit`, exactly as when they lived in the class.
 *
 * Each screen is composed in DOOM's native 320×200 coordinates and
 * scaled by `screenScale` (which tracks the resolution factor), so they
 * fill the framebuffer at any resolution with black margins around them.
 */

import { getIntermissionTexture, getFontTexture } from './textures.js';
import {
    INTERMISSION_W, INTERMISSION_H,
    INTER_COUNT_UP_MS, INTER_STEP_MS, INTER_LABELS, INTER_LABEL_X,
    INTER_ROW_Y, INTER_VALUE_R,
    WINUM_W, WINUM_H, WIPCNT_W, WIPCNT_H, WICOLON_W, WICOLON_H,
    RESULT_COLOR_NAME, percentValue,
} from './tables.js';

export const screenMethods = {
    // ── SP intermission screen ───────────────────────────────────────
    //
    // DOOM's post-level summary: WIMAP0 backdrop, WILV0N + "FINISHED"
    // header, then KILLS / ITEMS / SECRET as percentages and TIME as
    // m:ss, each row counting up from zero to its final reading in turn.
    _renderIntermission(now) {
        const im = this.intermission;
        const { W, H } = this;
        // The intermission is a full-screen element, not an overlay, so it
        // scales with the render factor rather than the HUD's uiScale.
        const scale = this.screenScale;
        const bgW = INTERMISSION_W * scale;
        const bgH = INTERMISSION_H * scale;
        const bgX = Math.round((W - bgW) / 2);
        const bgY = Math.round((H - bgH) / 2);
        const dx = nx => bgX + nx * scale;
        const dy = ny => bgY + ny * scale;

        // Backdrop.
        const wimap = getIntermissionTexture('WIMAP0');
        if (wimap && wimap.width > 1) {
            this._blit(wimap, 0, 0, INTERMISSION_W, INTERMISSION_H,
                bgX, bgY, bgW, bgH);
        }

        // Header: level-name (WILV0N) stacked above "FINISHED" (WIF),
        // both centred horizontally on the 320-wide column.
        const m = /^E1M([1-9])$/.exec(im.mapName || '');
        if (m) {
            const wilv = getIntermissionTexture(`WILV0${Number(m[1]) - 1}`);
            if (wilv && wilv.width > 1) {
                this._blit(wilv, 0, 0, wilv.width, wilv.height,
                    dx(160 - wilv.width / 2), dy(2),
                    wilv.width * scale, wilv.height * scale);
            }
        }
        const wif = getIntermissionTexture('WIF');
        if (wif && wif.width > 1) {
            this._blit(wif, 0, 0, wif.width, wif.height,
                dx(160 - wif.width / 2), dy(20),
                wif.width * scale, wif.height * scale);
        }

        // Stat rows. Targets are captured at showIntermission time;
        // elapsed-since-start drives the count-up progress per row.
        const elapsed = now - im.startTime;
        const progress = i => Math.max(0, Math.min(1,
            (elapsed - i * INTER_STEP_MS) / INTER_COUNT_UP_MS));
        const kills   = percentValue(im.stats.kills);
        const items   = percentValue(im.stats.items);
        const secrets = percentValue(im.stats.secrets);
        const timeSec = (im.stats.elapsedMs ?? 0) / 1000;

        for (let i = 0; i < INTER_LABELS.length; i++) {
            const lbl = getIntermissionTexture(INTER_LABELS[i]);
            if (lbl && lbl.width > 1) {
                this._blit(lbl, 0, 0, lbl.width, lbl.height,
                    dx(INTER_LABEL_X), dy(INTER_ROW_Y[i]),
                    lbl.width * scale, lbl.height * scale);
            }
        }

        const xR = (nx) => bgX + nx * scale;
        this._drawInterPercent(Math.round(kills   * progress(0)), xR(INTER_VALUE_R), dy(INTER_ROW_Y[0]), scale);
        this._drawInterPercent(Math.round(items   * progress(1)), xR(INTER_VALUE_R), dy(INTER_ROW_Y[1]), scale);
        this._drawInterPercent(Math.round(secrets * progress(2)), xR(INTER_VALUE_R), dy(INTER_ROW_Y[2]), scale);
        this._drawInterTime(timeSec * progress(3),                xR(INTER_VALUE_R), dy(INTER_ROW_Y[3]), scale);
    },

    /** Render an integer percentage right-anchored at the given pixel
     *  coordinates. WIPCNT sits at the rightmost slot; WINUM digits step
     *  leftward. */
    _drawInterPercent(value, xR, yTop, scale) {
        const pct = getIntermissionTexture('WIPCNT');
        let x = xR;
        if (pct && pct.width > 1) {
            x -= WIPCNT_W * scale;
            this._blit(pct, 0, 0, WIPCNT_W, WIPCNT_H, x, yTop,
                WIPCNT_W * scale, WIPCNT_H * scale);
        }
        this._drawInterDigits(String(Math.max(0, value | 0)), x, yTop, scale);
    },

    /** Render seconds as "m:ss" (or "mm:ss" when the minutes overflow)
     *  right-anchored at the given pixel coordinates. */
    _drawInterTime(totalSec, xR, yTop, scale) {
        const t = Math.max(0, Math.floor(totalSec));
        const mm = Math.floor(t / 60);
        const ss = t % 60;
        let x = xR;
        // Seconds — always two digits.
        x = this._drawInterDigits(ss.toString().padStart(2, '0'), x, yTop, scale);
        // Colon, vertically aligned to the digit baseline.
        const colon = getIntermissionTexture('WICOLON');
        if (colon && colon.width > 1) {
            x -= WICOLON_W * scale;
            const yColon = yTop + (WINUM_H - WICOLON_H) * scale;
            this._blit(colon, 0, 0, WICOLON_W, WICOLON_H, x, yColon,
                WICOLON_W * scale, WICOLON_H * scale);
        }
        // Minutes — variable width.
        this._drawInterDigits(String(mm), x, yTop, scale);
    },

    /** Blit a digit string right-aligned ending at `xR`; returns the new
     *  left edge so a caller can append further glyphs to the left. */
    _drawInterDigits(str, xR, yTop, scale) {
        let x = xR;
        for (let i = str.length - 1; i >= 0; i--) {
            const d = str.charCodeAt(i) - 48;
            if (d < 0 || d > 9) continue;
            const tex = getIntermissionTexture(`WINUM${d}`);
            if (!tex || tex.width <= 1) continue;
            x -= WINUM_W * scale;
            this._blit(tex, 0, 0, WINUM_W, WINUM_H, x, yTop,
                WINUM_W * scale, WINUM_H * scale);
        }
        return x;
    },

    // ── Text (DOOM small font) ───────────────────────────────────────

    /** Total width of `str` in framebuffer px at the given scale. */
    _measureText(str, scale) {
        const s = str.toUpperCase();
        let w = 0;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 32) { w += 4 * scale; continue; }
            const g = getFontTexture(c);
            w += ((g && g.width > 1 ? g.width : 4) + 1) * scale;
        }
        return w;
    },

    /**
     * Draw `str` with the DOOM small font (red, uppercase). `align` is
     * 'left' (x is the left edge) or 'center' (x is the centre). Returns
     * the right edge. Unknown glyphs advance as a space.
     */
    _text(str, x, y, scale, align = 'left') {
        const s = str.toUpperCase();
        let cx = align === 'center' ? Math.round(x - this._measureText(s, scale) / 2) : x;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 32) { cx += 4 * scale; continue; }
            const g = getFontTexture(c);
            if (!g || g.width <= 1) { cx += 5 * scale; continue; }
            this._blit(g, 0, 0, g.width, g.height, cx, y, g.width * scale, g.height * scale);
            cx += (g.width + 1) * scale;
        }
        return cx;
    },

    // ── Deathmatch results (frag matrix) ─────────────────────────────
    //
    // DOOM's net-game summary: a "FINISHED" header, a winner banner, then
    // a killers×victims frag grid with a TOTAL column.
    _renderResults(now) {
        const res = this.results;
        const { W, H } = this;
        const scale = this.screenScale;
        const bgW = INTERMISSION_W * scale, bgH = INTERMISSION_H * scale;
        const bgX = Math.round((W - bgW) / 2), bgY = Math.round((H - bgH) / 2);
        const dx = nx => bgX + nx * scale;
        const dy = ny => bgY + ny * scale;

        const wimap = getIntermissionTexture('WIMAP0');
        if (wimap && wimap.width > 1) this._blit(wimap, 0, 0, INTERMISSION_W, INTERMISSION_H, bgX, bgY, bgW, bgH);

        const wif = getIntermissionTexture('WIF');
        if (wif && wif.width > 1) {
            this._blit(wif, 0, 0, wif.width, wif.height,
                dx(160 - wif.width / 2), dy(4), wif.width * scale, wif.height * scale);
        }

        // Winner banner.
        const banner = res.winnerIndex >= 0
            ? `${RESULT_COLOR_NAME[res.winnerIndex] ?? `PLAYER ${res.winnerIndex + 1}`} WINS`
            : 'TIE';
        this._text(banner, dx(160), dy(24), 2 * scale, 'center');

        // Frag grid: a column per victim + a TOTAL column, a row per
        // killer. Cells are killer→victim frag counts; the right column
        // is each killer's score.
        const kills = res.kills || [];
        const scores = res.scores || [];
        const n = scores.length;
        if (!n) return;
        const gridTop = 64, rowH = 16, col0 = 90, colW = 30;
        // Header: victim labels P1..Pn, then TOTAL.
        for (let v = 0; v < n; v++) {
            this._text(`P${v + 1}`, dx(col0 + v * colW), dy(gridTop - 14), scale, 'center');
        }
        this._text('TOT', dx(col0 + n * colW), dy(gridTop - 14), scale, 'center');
        for (let k = 0; k < n; k++) {
            const y = gridTop + k * rowH;
            this._text(`P${k + 1}`, dx(col0 - 30), dy(y), scale, 'left');
            for (let v = 0; v < n; v++) {
                const val = (kills[k] && kills[k][v]) || 0;
                this._text(String(val), dx(col0 + v * colW), dy(y), scale, 'center');
            }
            this._text(String(scores[k] ?? 0), dx(col0 + n * colW), dy(y), scale, 'center');
        }
    },

    // ── Match lobby ──────────────────────────────────────────────────
    //
    // Simplified vs the DOM lobby (no QR code): title, room code for
    // network games, a per-slot occupancy list, and a status prompt.
    _renderLobby(now) {
        const lob = this.lobby;
        const { W, H } = this;
        const scale = this.screenScale;
        const cx = W / 2;

        // Plain dark backdrop (no WIMAP0 — the lobby precedes any level).
        this.fb.fill(0xFF101010);

        let y = Math.round(H * 0.18);
        const line = (text, sc, align = 'center', x = cx) => {
            this._text(text, x, y, sc * scale, align);
            y += Math.round((10 * sc + 4) * scale);
        };

        line('DEATHMATCH', 2);
        y += Math.round(8 * scale);
        if (lob.variant === 'network' && lob.roomCode) line(`ROOM ${lob.roomCode}`, 1.5);
        y += Math.round(6 * scale);

        const occ = lob.slotOccupants || lob.slotsClaimed || [];
        for (let i = 0; i < occ.length; i++) {
            let status;
            if (lob.variant === 'network') {
                status = occ[i] === 'empty' || occ[i] === false ? '----'
                       : i === this.viewerPlayerIndex ? 'YOU' : 'READY';
            } else {
                status = occ[i] ? (i === this.viewerPlayerIndex ? 'YOU' : 'JOINED') : '----';
            }
            line(`PLAYER ${i + 1}   ${status}`, 1);
        }

        y += Math.round(10 * scale);
        const prompt = lob.canStart ? 'PRESS FIRE TO START' : 'WAITING FOR PLAYERS';
        line(prompt, 1);
    },
};
