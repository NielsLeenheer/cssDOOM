/**
 * Full-screen overlay screens for the canvas SoftwareRenderer:
 * SP intermission, deathmatch results, and the match lobby, plus the
 * shared DOOM-small-font text helpers they use.
 *
 * Mixed onto SoftwareRenderer.prototype (see software.js), so the
 * methods run with `this` bound to the renderer — they read its
 * per-frame screen state (`this.intermission` / `.results` / `.lobby`,
 * `this.viewerPlayerIndex`) and draw through `this.framebuffer.blit`.
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

import { getIntermissionTexture, getFontTexture, getHudTexture, getMenuTexture } from './textures.js';
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
            this.framebuffer.blit(pct, 0, 0, WIPCNT_W, WIPCNT_H, x, yTop, WIPCNT_W, WIPCNT_H);
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
            this.framebuffer.blit(colon, 0, 0, WICOLON_W, WICOLON_H,
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
            this.framebuffer.blit(tex, 0, 0, WINUM_W, WINUM_H, x, yTop, WINUM_W, WINUM_H);
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

        // Grid metrics in 320-wide composition coords. Cells host a face
        // swatch in the header / left column and a centred 1-3 digit
        // WINUM score in the data cells. The TOTAL column is sized to
        // the WIMSTT label (62×12) so the label doesn't bleed into the
        // adjacent victim column. The whole grid is centred horizontally
        // for any n (1..4).
        const faceW = 26, faceH = 22;
        const dataW = 44, totalW = 70;
        const cellH = 26;
        const headTop = 56;

        const gridW = faceW + 8 + n * dataW + totalW;
        const gridLeft = (320 - gridW) / 2 | 0;
        const faceColX = gridLeft;
        const dataX0 = gridLeft + faceW + 8;
        const totalColX = dataX0 + n * dataW;

        // Header row: corner is empty; each victim column gets a face
        // swatch (centred in its cell); the TOTAL column shows the WIMSTT
        // label centred in its (wider) cell.
        for (let v = 0; v < n; v++) {
            this._drawFaceSwatch(v, dx(dataX0 + v * dataW + (dataW - faceW) / 2 | 0),
                dy(headTop), faceW, faceH);
        }
        const totalLabel = getIntermissionTexture('WIMSTT');
        if (totalLabel && totalLabel.width > 1) {
            this.framebuffer.blit(totalLabel, 0, 0, totalLabel.width, totalLabel.height,
                dx(totalColX + (totalW - totalLabel.width) / 2 | 0),
                dy(headTop + (faceH - totalLabel.height) / 2 | 0),
                totalLabel.width, totalLabel.height);
        }

        // Killer rows: left face swatch, n victim cells, TOTAL cell.
        const rowsTop = headTop + faceH + 8;
        for (let k = 0; k < n; k++) {
            const ry = rowsTop + k * cellH;
            this._drawFaceSwatch(k, dx(faceColX),
                dy(ry + (cellH - faceH) / 2 | 0), faceW, faceH);
            for (let v = 0; v < n; v++) {
                const val = (kills[k] && kills[k][v]) || 0;
                this._drawCenteredNumber(val,
                    dx(dataX0 + v * dataW + dataW / 2 | 0),
                    dy(ry + (cellH - WINUM_H) / 2 | 0));
            }
            this._drawCenteredNumber(scores[k] ?? 0,
                dx(totalColX + totalW / 2 | 0),
                dy(ry + (cellH - WINUM_H) / 2 | 0));
        }
    },

    // ── Match lobby ──────────────────────────────────────────────────
    //
    // Two variants matching the DOM renderer:
    //
    //   network — full-screen panel over the WIMAP0 backdrop. M_NEWG
    //             title, level-name sprite, slot list with face swatches
    //             and the viewer's row marked by a `>>` chevron, room
    //             code, action prompt. No QR sprite — too heavy to draw
    //             pixel-art QR inside the framebuffer.
    //
    //   local   — no panel at all. The live (pre-match) scene shows
    //             through; this only paints a small per-pane prompt over
    //             it. The world render happens elsewhere; `render()`
    //             only routes here for variant='network' to take over
    //             the framebuffer, while local lobbies fall through to
    //             world rendering with `_overlayLocalLobby` invoked
    //             after the world pass.
    _renderLobby(now) {
        const lob = this.lobby;
        const { ox, oy } = this._beginScreen('WIMAP0');
        const dx = nx => ox + nx;
        const dy = ny => oy + ny;

        // Title: M_NEWG "NEW GAME" (121×15) centred near the top, with
        // the level-name sprite WILV0N tucked beneath it.
        const newg = getMenuTexture('M_NEWG');
        this._blitSprite(newg, dx(160 - (newg?.width ?? 0) / 2 | 0), dy(20));
        const m = /^E1M([1-9])$/.exec(lob.mapCursor || '');
        if (m) {
            const wilv = getIntermissionTexture(`WILV0${Number(m[1]) - 1}`);
            this._blitSprite(wilv, dx(160 - (wilv?.width ?? 0) / 2 | 0), dy(40));
        }

        // Slot list. Network DM provides `slotOccupants` (string per
        // slot); the viewer's row gets a `>>` chevron in the gutter to
        // self-identify, matching the DOM lobby's per-pane marker.
        const occ = lob.slotOccupants?.length ? lob.slotOccupants : (lob.slotsClaimed ?? []);
        const swatchW = 20, swatchH = 16;
        const rowH = 22;
        // Layout columns in composition coords (320 wide):
        //   chevron — swatch — label — — — — status
        const chevronX = 70, swatchX = 88, labelX = 116, statusX = 200;
        let y = 70;
        for (let i = 0; i < occ.length; i++) {
            if (i === this.viewerPlayerIndex) {
                this._text('>>', dx(chevronX), dy(y + 4), 'left');
            }
            this._drawFaceSwatch(i, dx(swatchX), dy(y), swatchW, swatchH);
            const claimed = occ[i] !== 'empty' && occ[i] !== false && occ[i] != null;
            const status = !claimed ? 'WAITING'
                : i === this.viewerPlayerIndex ? 'YOU'
                : 'READY';
            this._text(`PLAYER ${i + 1}`, dx(labelX), dy(y + 4), 'left');
            this._text(status, dx(statusX), dy(y + 4), 'left');
            y += rowH;
        }

        // Room code (host's invite — joiners already entered it).
        if (lob.roomCode) {
            y += 8;
            this._text(`ROOM CODE: ${lob.roomCode}`, dx(160), dy(y), 'center');
            y += 14;
        }

        // Per-pane action prompt — host fires, joiners wait.
        y += 6;
        const prompt = lob.canStart
            ? (this.viewerPlayerIndex === 0 ? 'PRESS FIRE TO START GAME' : 'WAITING FOR GAME TO START')
            : 'WAITING FOR PLAYERS';
        this._text(prompt, dx(160), dy(y), 'center');
    },

    /** Local DM lobby overlay — draws on top of the live world. Mirrors
     *  the CSSRenderer's per-pane `data-claim-state` CSS:
     *
     *    prompting → world dimmed + "PRESS BUTTON TO CONNECT CONTROLLER"
     *    ready     → "READY!" over the live (un-dimmed) world
     *    waiting   → world dimmed to ~30% brightness, no text
     *    active    → nothing (this method returns)
     */
    _overlayLocalLobby(now) {
        const lob = this.lobby;
        const slot = this.viewerPlayerIndex;
        if (slot == null) return;

        const carried = lob.slotsCarriedOver?.[slot];
        const claimed = lob.slotsClaimed?.[slot];
        let claimState;
        if (claimed) {
            claimState = carried ? 'active' : 'ready';
        } else if (slot === lob.promptingSlot) {
            claimState = 'prompting';
        } else {
            claimState = 'waiting';
        }
        if (claimState === 'active') return;

        // 'waiting' and 'prompting' both dim the world to focus attention
        // on the prompting pane; 'ready' keeps full brightness so the
        // just-claimed player sees the live scene clearly with READY!
        // pinned over it. DOM matches via `filter: brightness(0.3)` on
        // the pane itself — same arithmetic per pixel here.
        if (claimState === 'waiting' || claimState === 'prompting') {
            const fb = this.framebuffer.fb, n = fb.length;
            for (let i = 0; i < n; i++) {
                const px = fb[i];
                const r = px & 0xff;
                const g = (px >>> 8) & 0xff;
                const b = (px >>> 16) & 0xff;
                fb[i] = 0xff000000
                    | ((r * 77) >>> 8)
                    | (((g * 77) >>> 8) << 8)
                    | (((b * 77) >>> 8) << 16);
            }
        }

        if (claimState === 'waiting') return;

        const text = claimState === 'ready'
            ? 'READY!'
            : 'PRESS BUTTON TO\nCONNECT CONTROLLER';
        const { W, H } = this.framebuffer;
        const lines = text.split('\n');
        const lineH = 10;
        let y = (H - lines.length * lineH) / 2 | 0;
        for (const line of lines) {
            this._text(line, W / 2, y, 'center');
            y += lineH;
        }
    },

    // ── Screen helpers ───────────────────────────────────────────────

    /** Centre of the 320×200 native composition inside the framebuffer. */
    _screenOrigin() {
        return {
            ox: Math.round((this.framebuffer.W - INTERMISSION_W) / 2),
            oy: Math.round((this.framebuffer.H - INTERMISSION_H) / 2),
        };
    },

    /** Fill the framebuffer with a backdrop texture (stretched) and
     *  return the origin of the 320×200 composition inside it. */
    _beginScreen(bgName) {
        const bg = getIntermissionTexture(bgName);
        if (bg && bg.width > 1) {
            this.framebuffer.blit(bg, 0, 0, bg.width, bg.height, 0, 0, this.framebuffer.W, this.framebuffer.H);
        } else {
            this.framebuffer.fb.fill(0xFF000000);
        }
        return this._screenOrigin();
    },

    /** Blit a sprite at its native source size, no-op if not yet loaded. */
    _blitSprite(tex, x, y) {
        if (!tex || tex.width <= 1) return;
        this.framebuffer.blit(tex, 0, 0, tex.width, tex.height, x, y, tex.width, tex.height);
    },

    /** STFB[…] swatch + STFST00 face overlay — same composition the DOM
     *  scoreboard builds with .scoreboard-swatch + .player-N. */
    _drawFaceSwatch(playerIdx, x, y, w, h) {
        const swatch = getHudTexture(PLAYER_SWATCH[playerIdx] ?? 'STFB0');
        if (swatch && swatch.width > 1) {
            this.framebuffer.blit(swatch, 0, 0, swatch.width, swatch.height, x, y, w, h);
        }
        const face = getHudTexture('STFST00');
        if (face && face.width > 1) {
            // Inset a couple of pixels so the swatch border shows around
            // the face, matching the DOM .scoreboard-swatch padding.
            const fw = Math.max(1, w - 4);
            const fh = Math.max(1, h - 4);
            this.framebuffer.blit(face, 0, 0, face.width, face.height,
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
                this.framebuffer.blit(minus, 0, 0, WIMINUS_W, WIMINUS_H,
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
            this.framebuffer.blit(g, 0, 0, g.width, g.height,
                cx, y, g.width * scale, g.height * scale);
            cx += (g.width + 1) * scale;
        }
        return cx;
    },
};
