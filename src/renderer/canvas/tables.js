/**
 * Static data + pure helpers for the canvas SoftwareRenderer.
 *
 * Everything here is stateless: render configuration constants, the
 * DOOM sprite/animation/HUD layout tables, and small pure functions
 * (texel shading, light falloff, sky sampling, frame-name resolution).
 * The renderer and its per-pass modules import what they need from
 * here, keeping software.js focused on per-frame state and drawing.
 */

// ── Render configuration ─────────────────────────────────────────────
export const FOV = Math.PI / 2;      // horizontal field of view (matches LineRenderer)
export const NEAR = 4;               // near plane, world units
export const MAX_DIST = 4000;        // far cull for flats / sprites
export const SKY_DEPTH = 1e7;        // pseudo-depth so sky loses to all real geometry
export const TAU = Math.PI * 2;

const INV_FADE = 1 / 2600;    // distance light falloff rate
const LIGHT_FLOOR = 0.22;     // darkest a lit surface gets, as a fraction
const LIGHT_BAND = 12;        // colormap-style quantisation step

// val (0..255 brightness) → multiplier in 0..256 for `c * lf >> 8`.
const LIGHT_LUT = new Uint16Array(256);
for (let i = 0; i < 256; i++) LIGHT_LUT[i] = Math.min(256, ((i * 256 / 255) | 0));

export const WALK_FRAME_MS = 180;    // enemy walk-cycle frame duration
export const DEATH_FRAME_MS = 120;   // enemy death-animation frame duration
export const DOOR_SPEED = 100;       // door travel speed, world units per second
export const LIFT_SPEED = 140;       // lift platform speed, world units per second

// Sector light specials, keyed by DOOM sector specialType.
export const LIGHT_EFFECT = {
    1:  { type: 'flicker',   sync: false },
    2:  { type: 'blinkfast', sync: false },
    3:  { type: 'blink',     sync: false },
    8:  { type: 'glow',      sync: false },
    12: { type: 'blinkfast', sync: true },
    13: { type: 'blink',     sync: true },
    17: { type: 'fire',      sync: false },
};

// ── Animated flats / walls ───────────────────────────────────────────
export const ANIM_FRAME_MS = 200;    // animated flat/wall frame duration

const ANIM_SEQUENCES = [
    ['NUKAGE1', 'NUKAGE2', 'NUKAGE3'],
    ['SLADRIP1', 'SLADRIP2', 'SLADRIP3'],
];
const ANIM_OF = new Map();
for (const seq of ANIM_SEQUENCES) for (const n of seq) ANIM_OF.set(n, seq);

/** Current frame name for an animated wall/flat texture, or `name`. */
export function animName(name, frame) {
    const seq = ANIM_OF.get(name);
    return seq ? seq[frame % seq.length] : name;
}

// ── Weapons ──────────────────────────────────────────────────────────
// On-screen weapon sprite sheets (single row: frame 0 idle, 1..N fire).
export const WEAPON_INFO = {
    FIST:     { fw: 147, fh: 76,  frames: 4 },
    PISTOL:   { fw: 79,  fh: 103, frames: 5 },
    SHOTGUN:  { fw: 119, fh: 151, frames: 6 },
    CHAINGUN: { fw: 114, fh: 103, frames: 3 },
    ROCKET:   { fw: 105, fh: 119, frames: 5 },
    CHAINSAW: { fw: 154, fh: 89,  frames: 4 },
};

// ── Screen flash ─────────────────────────────────────────────────────
export const FLASH_COLOR = {
    hurt:             [255, 0, 0],
    'pickup-flash':   [255, 215, 0],
    'teleport-flash': [0, 255, 0],
};
export const FLASH_MS = 300;

// ── HUD status bar ───────────────────────────────────────────────────
export const BIG_GLYPH_W = 14, BIG_GLYPH_H = 16;
export const SMALL_GLYPH_W = 4, SMALL_GLYPH_H = 6;
export const FACE_W = 24, FACE_H = 31;
export const WEAPON_AMMO = { 1: null, 2: 'bullets', 3: 'shells', 4: 'bullets',
                             5: 'rockets', 6: 'cells', 7: 'cells', 8: null };
export const HUD_AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'];
export const ARMS_SLOTS = [
    { slot: 2, x: 111, y: 4 },  { slot: 3, x: 123, y: 4 },  { slot: 4, x: 135, y: 4 },
    { slot: 5, x: 111, y: 14 }, { slot: 6, x: 123, y: 14 }, { slot: 7, x: 135, y: 14 },
];
export const HUD_KEYS = [
    { color: 'blue', icon: 'STKEYS0' },
    { color: 'yellow', icon: 'STKEYS1' },
    { color: 'red', icon: 'STKEYS2' },
];

// ── Intermission / results layout ────────────────────────────────────
export const WINUM_W = 11, WINUM_H = 12;     // big yellow digits 0-9
export const WIPCNT_W = 13, WIPCNT_H = 12;   // percent sign
export const WICOLON_W = 5, WICOLON_H = 10;  // m:ss colon
export const WIMINUS_W = 6, WIMINUS_H = 3;   // negative-score sign
export const INTERMISSION_W = 320, INTERMISSION_H = 200;
export const INTER_COUNT_UP_MS = 1200;       // per-row duration, matches DOM
export const INTER_STEP_DELAY_MS = 250;      // gap between rows
export const INTER_STEP_MS = INTER_COUNT_UP_MS + INTER_STEP_DELAY_MS;
export const INTER_ROW_Y = [50, 68, 86, 110];   // KILLS, ITEMS, SECRET, TIME
export const INTER_LABEL_X = 50;                 // label left edge
export const INTER_VALUE_R = 270;                // value right edge
export const INTER_LABELS = ['WIOSTK', 'WIOSTI', 'WIOSTS', 'WITIME'];
export const RESULT_COLOR_NAME = ['GREEN', 'RED', 'INDIGO', 'BROWN'];

// ── Sector light specials ────────────────────────────────────────────
// Small integer hash → [0,1), for the random light flickers.
export function hashRnd(a, b) {
    let h = (a ^ Math.imul(b, 374761393)) >>> 0;
    h = Math.imul(h ^ (h >>> 15), 2246822519);
    h ^= h >>> 13;
    return (h >>> 0) / 4294967296;
}

// Light multiplier for a special-light sector at time t (seconds).
export function lightMul(e, t) {
    const p = t + e.phase;
    switch (e.type) {
        case 'glow':      return 0.75 + 0.25 * (0.5 - 0.5 * Math.cos(p * Math.PI)); // ~2s
        case 'blink':     return (p % 1) < 0.5 ? 1 : 0.5;                            // 1s
        case 'blinkfast': return (p % 0.5) < 0.25 ? 1 : 0.5;                         // 0.5s
        case 'flicker':   return hashRnd(e.seed, (t * 10) | 0) < 0.5 ? 1 : 0.5;
        case 'fire':      return 0.6 + 0.4 * hashRnd(e.seed, (t * 18) | 0);
        default:          return 1;
    }
}

// ── Sprites ──────────────────────────────────────────────────────────
// Per-enemy sprite animation, keyed by DOOM thing type. `spr` is the
// 4-letter base; walk/attack frames have 8-rotation art, death frames
// are single-view (rotation 0), last one is the resting corpse.
export const ENEMY_ANIM = {
    3004: { spr: 'POSS', walk: ['A', 'B'], attack: 'E', death: ['H', 'I', 'J', 'K', 'L'] },
    9:    { spr: 'SPOS', walk: ['A', 'B'], attack: 'E', death: ['H', 'I', 'J', 'K', 'L'] },
    3001: { spr: 'TROO', walk: ['A', 'B'], attack: 'E', death: ['I', 'J', 'K', 'L', 'M'] },
    3002: { spr: 'SARG', walk: ['A', 'B'], attack: 'E', death: ['I', 'J', 'K', 'L', 'M', 'N'] },
    58:   { spr: 'SARG', walk: ['A', 'B'], attack: 'E', death: ['I', 'J', 'K', 'L', 'M', 'N'] },
    3003: { spr: 'BOSS', walk: ['A', 'B'], attack: 'E', death: ['I', 'J', 'K', 'L', 'M', 'N', 'O'] },
};
export const PLAYER_ANIM = { spr: 'PLAY', walk: ['A', 'B'], attack: 'E', death: null };
export const PLAYER_CORPSE_VARIANT = ['', '-red', '-indigo', '-brown'];

// Idle-animated pickups / decorations: 4-letter prefix → frame count.
export const ITEM_ANIM = {
    SOUL: 4, BON1: 4, BON2: 4, PINS: 4, ARM1: 2, ARM2: 2, TRED: 4, BAR1: 2,
};
export const ITEM_FRAME_MS = 250;

// Transient effect frame sequences (single-view).
export const PUFF_FRAMES = ['PUFFA0', 'PUFFB0', 'PUFFC0', 'PUFFD0'];
export const EXPLOSION_FRAMES = ['BAL1C0', 'BAL1D0', 'BAL1E0'];       // enemy fireball impact
export const BARREL_FRAMES = ['BEXPA0', 'BEXPB0', 'BEXPC0', 'BEXPD0', 'BEXPE0'];
export const TFOG_FRAMES = ['TFOGA0', 'TFOGB0', 'TFOGC0', 'TFOGD0', 'TFOGE0',
                            'TFOGF0', 'TFOGG0', 'TFOGH0', 'TFOGI0', 'TFOGJ0'];

/** Current frame name for an idle-animated pickup/decoration sprite. */
export function itemFrameName(name, now) {
    const n = ITEM_ANIM[name.slice(0, 4)];
    if (!n) return name;
    const i = ((now / ITEM_FRAME_MS) | 0) % n;
    return name.slice(0, 4) + String.fromCharCode(65 + i) + '0';
}

/** Resolve a sprite filename + horizontal mirror flag for an 8-rotation
 *  frame (rotations 6-8 reuse 2/3/4 mirrored, per WAD lump naming). */
export function buildRotName(spr, frame, rot) {
    switch (rot) {
        case 5:  return { name: `${spr}${frame}5`, mirror: false };
        case 2:  return { name: `${spr}${frame}2${frame}8`, mirror: false };
        case 8:  return { name: `${spr}${frame}2${frame}8`, mirror: true };
        case 3:  return { name: `${spr}${frame}3${frame}7`, mirror: false };
        case 7:  return { name: `${spr}${frame}3${frame}7`, mirror: true };
        case 4:  return { name: `${spr}${frame}4${frame}6`, mirror: false };
        case 6:  return { name: `${spr}${frame}4${frame}6`, mirror: true };
        default: return { name: `${spr}${frame}1`, mirror: false }; // rotation 1 (front)
    }
}

// ── Sky sampling ─────────────────────────────────────────────────────
// Sky texture row for screen row y, given the per-frame sky context.
export function skyRow(c, y) {
    let sv = (((y - c.halfH) * c.iscale) + c.skyHorizon) | 0;
    if (sv < 0) sv = 0; else if (sv >= c.skyH) sv = c.skyH - 1;
    return sv;
}

// Sky texture column for screen column x.
export function skyCol(c, x) {
    let u = c.uBase - (c.colAngle[x] / c.twoPi) * c.skyW * 4;
    u %= c.skyW;
    if (u < 0) u += c.skyW;
    return u | 0;
}

// ── Misc pure helpers ────────────────────────────────────────────────
// {collected,total} → integer 0..100 percent (empty objective = 100%).
export function percentValue(p) {
    if (!p || !p.total) return 100;
    return Math.round(100 * p.collected / p.total);
}

// Character → DIGITS_SHEET / SMALL_DIGITS glyph index (0-9, % = 10, - = 11).
export function glyphIndex(ch) {
    if (ch >= '0' && ch <= '9') return ch.charCodeAt(0) - 48;
    if (ch === '%') return 10;
    if (ch === '-') return 11;
    return -1;
}

// Multiply an ABGR texel by a 0..256 light factor.
export function shade(texel, lf) {
    const r = ((texel & 0xff) * lf) >> 8;
    const g = (((texel >> 8) & 0xff) * lf) >> 8;
    const b = (((texel >> 16) & 0xff) * lf) >> 8;
    return 0xff000000 | (b << 16) | (g << 8) | r;
}

// Sector light + distance falloff → 0..256 multiplier, banded.
export function lightFor(level, dist) {
    let m = 1 - dist * INV_FADE;
    if (m < LIGHT_FLOOR) m = LIGHT_FLOOR;
    let v = level * m;
    v -= v % LIGHT_BAND;          // colormap-style quantisation
    if (v < 0) v = 0; else if (v > 255) v = 255;
    return LIGHT_LUT[v | 0];
}
