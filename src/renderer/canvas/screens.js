/**
 * Full-screen overlay screens for the canvas SoftwareRenderer:
 * SP intermission, deathmatch results, and the match lobby, plus the
 * shared DOOM-small-font text helpers they use.
 *
 * Mixed onto SoftwareRenderer.prototype (see software.js), so the
 * methods run with `this` bound to the renderer — they read its
 * per-frame screen state (`this.intermission` / `.results` / `.lobby`,
 * `this.viewerPlayerIndex`) and draw through `this._blit`.
 *
 * Layout strategy: backdrops fill the framebuffer end-to-end so the
 * screen never letterboxes. Everything painted on top — labels, digit
 * sprites, face swatches, small-font text — is drawn at native DOOM
 * resolution (1 source pixel = 1 framebuffer pixel) inside a 320×200
 * region centred in the framebuffer. At higher render-resolution
 * factors the world is sampled at the full framebuffer detail while
 * the overlay stays compact in the middle, matching how the DOM
 * renderer sizes these screens against its pane.
 */

import { getIntermissionTexture, getFontTexture, getHudTexture } from './textures.js';
import {
    INTERMISSION_W, INTERMISSION_H,
    INTER_COUNT_UP_MS, INTER_STEP_MS, INTER_LABELS, INTER_LABEL_X,
    INTER_ROW_Y, INTER_VALUE_R,
    WINUM_W, WINUM_H, WIPCNT_W, WIPCNT_H, WICOLON_W, WICOLON_H,
    WIMINUS_W, WIMINUS_H,
    RESULT_COLOR_NAME, percentValue,
} from './tables.js';

// DOM HUD pairing: P0→STFB0 (green), P1→STFB3 (red), P2→STFB1 (indigo),
// P3→STFB2 (brown). Matches scoreboard.css / hud.css.
const PLAYER_SWATCH = ['STFB0', 'STFB3', 'STFB1', 'STFB2'];

export const screenMethods = {
    // ── SP intermission screen ───────────────────────────────────────
    //
    // DOOM's post-level summary: WIMAP0 backdrop, WILV0N + "FINISHED"
    // header, then KILLS / ITEMS / SECRET as percentages and TIME as
    // m:ss, each row counting up from zero to its final reading in turn.
    _renderIntermission(now) {
        const im = this.intermission;
        const { ox, oy } = this._beginScreen('WIMAP0');
        const dx = nx => ox + nx;
        const dy = ny => oy + ny;

        // Header: level-name (WILV0N) stacked above "FINISHED" (WIF),
        // both centred horizontally on the 320-wide column.
        const m = /^E1M([1-9])$/.exec(im.mapName || '');
        if (m) {
            const wilv = getIntermissionTexture(`WILV0${Number(m[1]) - 1}`);
            this._blitSprite(wilv, dx(160 - (wilv?.width ?? 0) / 2 | 0), dy(2));
        }
        const wif = getIntermissionTexture('WIF');
        this._blitSprite(wif, dx(160 - (wif?.width ?? 0) / 2 | 0), dy(20));

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
            this._blitSprite(getIntermissionTexture(INTER_LABELS[i]),
                dx(INTER_LABEL_X), dy(INTER_ROW_Y[i]));
        }

        this._drawInterPercent(Math.round(kills   * progress(0)), dx(INTER_VALUE_R), dy(INTER_ROW_Y[0]));
        this._drawInterPercent(Math.round(items   * progress(1)), dx(INTER_VALUE_R), dy(INTER_ROW_Y[1]));
        this._drawInterPercent(Math.round(secrets * progress(2)), dx(INTER_VALUE_R), dy(INTER_ROW_Y[2]));
        this._drawInterTime(timeSec * progress(3),                dx(INTER_VALUE_R), dy(INTER_ROW_Y[3]));
    },

    /** Render an integer percentage right-anchored at the given pixel
     *  coordinates. WIPCNT sits at the rightmost slot; WINUM digits step
     *  leftward. */
    _drawInterPercent(value, xR, yTop) {
        const pct = getIntermissionTexture('WIPCNT');
        let x = xR;
        if (pct && pct.width > 1) {
            x -= WIPCNT_W;
            this._blit(pct, 0, 0, WIPCNT_W, WIPCNT_H, x, yTop, WIPCNT_W, WIPCNT_H);
        }
        this._drawInterDigits(String(Math.max(0, value | 0)), x, yTop);
    },

    /** Render seconds as "m:ss" (or "mm:ss" when minutes overflow)
     *  right-anchored at the given pixel coordinates. */
    _drawInterTime(totalSec, xR, yTop) {
        const t = Math.max(0, Math.floor(totalSec));
        const mm = Math.floor(t / 60);
        const ss = t % 60;
        let x = xR;
        // Seconds — always two digits ("00"…"59").
        x = this._drawInterDigits(ss.toString().padStart(2, '0'), x, yTop);
        const colon = getIntermissionTexture('WICOLON');
        if (colon && colon.width > 1) {
            x -= WICOLON_W;
            this._blit(colon, 0, 0, WICOLON_W, WICOLON_H,
                x, yTop + (WINUM_H - WICOLON_H), WICOLON_W, WICOLON_H);
        }
        this._drawInterDigits(String(mm), x, yTop);
    },

    /** Blit a digit string right-aligned ending at `xR`; returns the new
     *  left edge so a caller can append further glyphs to the left. */
    _drawInterDigits(str, xR, yTop) {
        let x = xR;
        for (let i = str.length - 1; i >= 0; i--) {
            const d = str.charCodeAt(i) - 48;
            if (d < 0 || d > 9) continue;
            const tex = getIntermissionTexture(`WINUM${d}`);
            if (!tex || tex.width <= 1) continue;
            x -= WINUM_W;
            this._blit(tex, 0, 0, WINUM_W, WINUM_H, x, yTop, WINUM_W, WINUM_H);
        }
        return x;
    },

    // ── Deathmatch results (frag matrix) ─────────────────────────────
    //
    // Mirrors the DOM scoreboard: WIF header, a winner banner, then a
    // killer×victim frag grid with face-swatch axis labels and a TOTAL
    // column. Numbers use WINUM digits like the SP intermission;
    // axis labels reuse the HUD STFB swatches that drive the per-pane
    // HUD face background, so a player's color in the grid matches the
    // colour on their bar during the match.
    _renderResults(now) {
        const res = this.results;
        const { ox, oy } = this._beginScreen('WIMAP0');
        const dx = nx => ox + nx;
        const dy = ny => oy + ny;

        const wif = getIntermissionTexture('WIF');
        this._blitSprite(wif, dx(160 - (wif?.width ?? 0) / 2 | 0), dy(4));

        const banner = res.winnerIndex >= 0
            ? `${RESULT_COLOR_NAME[res.winnerIndex] ?? `PLAYER ${res.winnerIndex + 1}`} WINS`
            : 'TIE';
        this._text(banner, dx(160), dy(22), 'center');

        const scores = res.scores || [];
        const kills = res.kills || [];
        const n = scores.length;
        if (!n) return;

        // Grid metrics. Cells are sized to fit a 3-digit score with a
        // little breathing room. The killer-face column sits before the
        // victim columns; the TOTAL column sits after, capped by the
        // WIMSTT label above it.
        const faceW = 24, faceH = 20;
        const cellW = 36, cellH = 22;
        const headTop = 50;
        const gridLeft = 60;
        const faceColX = gridLeft;
        const dataX0 = gridLeft + faceW + 8;

        // Header row: empty corner, victim face swatches, TOTAL label.
        for (let v = 0; v < n; v++) {
            this._drawFaceSwatch(v, dx(dataX0 + v * cellW + (cellW - faceW) / 2 | 0),
                dy(headTop), faceW, faceH);
        }
        const totalLabel = getIntermissionTexture('WIMSTT');
        if (totalLabel && totalLabel.width > 1) {
            this._blit(totalLabel, 0, 0, totalLabel.width, totalLabel.height,
                dx(dataX0 + n * cellW + (cellW - totalLabel.width) / 2 | 0),
                dy(headTop + (faceH - totalLabel.height) / 2 | 0),
                totalLabel.width, totalLabel.height);
        }

        // Killer rows.
        const rowsTop = headTop + faceH + 6;
        for (let k = 0; k < n; k++) {
            const ry = rowsTop + k * cellH;
            this._drawFaceSwatch(k, dx(faceColX), dy(ry + (cellH - faceH) / 2 | 0), faceW, faceH);
            for (let v = 0; v < n; v++) {
                const val = (kills[k] && kills[k][v]) || 0;
                this._drawCenteredNumber(val,
                    dx(dataX0 + v * cellW + cellW / 2 | 0),
                    dy(ry + (cellH - WINUM_H) / 2 | 0));
            }
            this._drawCenteredNumber(scores[k] ?? 0,
                dx(dataX0 + n * cellW + cellW / 2 | 0),
                dy(ry + (cellH - WINUM_H) / 2 | 0));
        }
    },

    // ── Match lobby ──────────────────────────────────────────────────
    //
    // Simplified vs the DOM lobby: plain dark backdrop (no level scene
    // behind it yet, no WIMAP0 — the lobby precedes the chosen map's
    // intermission backdrop), centred DEATHMATCH header, room code for
    // network games, per-slot status with face swatches, action prompt.
    _renderLobby(now) {
        const lob = this.lobby;
        this.fb.fill(0xFF101010);
        const { ox, oy } = this._screenOrigin();
        // Native-coord helpers — every coordinate below is inside the
        // centred 320×200 composition.
        const dx = nx => ox + nx;
        const dy = ny => oy + ny;
        const cx = 160;

        this._textScaled('DEATHMATCH', dx(cx), dy(30), 2, 'center');

        let y = 60;
        if (lob.variant === 'network' && lob.roomCode) {
            this._textScaled(`ROOM ${lob.roomCode}`, dx(cx), dy(y), 1, 'center');
            y += 16;
        }

        // Network DM provides `slotOccupants` (string per slot); Local DM
        // provides `slotsClaimed` (boolean per slot). Either array's
        // length is the slot count to draw — never both. `slotOccupants`
        // is `[]` for the local variant, so don't use plain `||` (an
        // empty array is truthy and would suppress the fallback).
        const occ = lob.slotOccupants?.length ? lob.slotOccupants : (lob.slotsClaimed ?? []);
        const swatchW = 18, swatchH = 14;
        const rowH = 20;
        // Lay the per-slot row out around the composition centre: face
        // swatch, then label, then status. Widths picked so "PLAYER N"
        // (~50px in the small font) and a 5-char status don't run into
        // each other.
        const swatchX = cx - 60;
        const labelX = cx - 35;
        const statusX = cx + 25;
        y += 8;
        for (let i = 0; i < occ.length; i++) {
            const claimed = lob.variant === 'network'
                ? occ[i] !== 'empty' && occ[i] !== false
                : !!occ[i];
            this._drawFaceSwatch(i, dx(swatchX), dy(y), swatchW, swatchH);
            let status;
            if (!claimed) {
                status = '----';
            } else if (i === this.viewerPlayerIndex) {
                status = 'YOU';
            } else {
                status = lob.variant === 'network' ? 'READY' : 'JOINED';
            }
            this._text(`PLAYER ${i + 1}`, dx(labelX), dy(y + 3), 'left');
            this._text(status, dx(statusX), dy(y + 3), 'left');
            y += rowH;
        }

        y += 12;
        const prompt = lob.canStart ? 'PRESS FIRE TO START' : 'WAITING FOR PLAYERS';
        this._text(prompt, dx(cx), dy(y), 'center');
    },

    // ── Screen helpers ───────────────────────────────────────────────

    /** Centre of the 320×200 native composition inside the framebuffer. */
    _screenOrigin() {
        return {
            ox: Math.round((this.W - INTERMISSION_W) / 2),
            oy: Math.round((this.H - INTERMISSION_H) / 2),
        };
    },

    /** Fill the framebuffer with a backdrop texture (stretched) and
     *  return the origin of the 320×200 composition inside it. */
    _beginScreen(bgName) {
        const bg = getIntermissionTexture(bgName);
        if (bg && bg.width > 1) {
            this._blit(bg, 0, 0, bg.width, bg.height, 0, 0, this.W, this.H);
        } else {
            this.fb.fill(0xFF000000);
        }
        return this._screenOrigin();
    },

    /** Blit a sprite at its native source size, no-op if not yet loaded. */
    _blitSprite(tex, x, y) {
        if (!tex || tex.width <= 1) return;
        this._blit(tex, 0, 0, tex.width, tex.height, x, y, tex.width, tex.height);
    },

    /** STFB[…] swatch + STFST00 face overlay — same composition the DOM
     *  scoreboard builds with .scoreboard-swatch + .player-N. */
    _drawFaceSwatch(playerIdx, x, y, w, h) {
        const swatch = getHudTexture(PLAYER_SWATCH[playerIdx] ?? 'STFB0');
        if (swatch && swatch.width > 1) {
            this._blit(swatch, 0, 0, swatch.width, swatch.height, x, y, w, h);
        }
        const face = getHudTexture('STFST00');
        if (face && face.width > 1) {
            // Inset a couple of pixels so the swatch border shows around
            // the face, matching the DOM .scoreboard-swatch padding.
            const fw = Math.max(1, w - 4);
            const fh = Math.max(1, h - 4);
            this._blit(face, 0, 0, face.width, face.height,
                x + (w - fw) / 2 | 0, y + (h - fh) / 2 | 0, fw, fh);
        }
    },

    /** Draw a WINUM number centred at xCenter. Negative scores (suicides
     *  > frags) prepend WIMINUS, matching DOM's pad() output. */
    _drawCenteredNumber(value, xCenter, yTop) {
        const v = value | 0;
        const neg = v < 0;
        const str = Math.abs(v).toString();
        const totalW = str.length * WINUM_W + (neg ? WIMINUS_W + 1 : 0);
        let x = xCenter + (totalW / 2 | 0);
        x = this._drawInterDigits(str, x, yTop);
        if (neg) {
            const minus = getIntermissionTexture('WIMINUS');
            if (minus && minus.width > 1) {
                x -= WIMINUS_W + 1;
                this._blit(minus, 0, 0, WIMINUS_W, WIMINUS_H,
                    x, yTop + (WINUM_H - WIMINUS_H) / 2 | 0,
                    WIMINUS_W, WIMINUS_H);
            }
        }
    },

    // ── Text (DOOM small font) ───────────────────────────────────────

    /** Total width of `str` at the given pixel scale. */
    _measureText(str, scale = 1) {
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

    /** Native-size small-font text, returns the right edge. */
    _text(str, x, y, align = 'left') {
        return this._textScaled(str, x, y, 1, align);
    },

    /** Scaled small-font text. `scale=1` is the native DOOM size. */
    _textScaled(str, x, y, scale, align = 'left') {
        const s = str.toUpperCase();
        let cx = align === 'center'
            ? Math.round(x - this._measureText(s, scale) / 2)
            : x;
        for (let i = 0; i < s.length; i++) {
            const c = s.charCodeAt(i);
            if (c === 32) { cx += 4 * scale; continue; }
            const g = getFontTexture(c);
            if (!g || g.width <= 1) { cx += 5 * scale; continue; }
            this._blit(g, 0, 0, g.width, g.height,
                cx, y, g.width * scale, g.height * scale);
            cx += (g.width + 1) * scale;
        }
        return cx;
    },
};
