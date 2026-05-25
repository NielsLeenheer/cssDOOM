#!/usr/bin/env node
/**
 * Walk public/assets/textures + public/assets/flats, compute the
 * average RGB of each PNG, and write public/assets/flat-colors.json
 * keyed by texture name (without extension). Consumed by the
 * FlatRenderer to paint walls / floors / ceilings with solid colors
 * instead of texture images for the talk's progression visual.
 *
 * Average is plain arithmetic mean over fully-opaque pixels — close
 * enough for "what color does this texture read as." Transparent
 * pixels are skipped so e.g. a chain-link wall doesn't average toward
 * black.
 *
 * Run from the worktree root: `node scripts/precompute-flat-colors.js`.
 * Re-run any time a texture is added / regenerated.
 */

import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, basename } from 'node:path';
import { PNG } from 'pngjs';

const ROOT = new URL('../public/assets/', import.meta.url).pathname;
const OUT = new URL('../public/assets/flat-colors.json', import.meta.url).pathname;
const DIRS = ['textures', 'flats'];

// Gamma-correct sRGB ↔ linear (γ = 2.2) so the average is what
// you'd perceptually see when blurring the texture out completely.
// Naive sRGB averaging biases toward dark — DOOM textures have lots
// of shadow / grout pixels that dominate an arithmetic mean and
// produce nearly-black averages for clearly grey-looking textures
// (e.g. CEIL5_1 → rgb(23,23,23)). Gamma-correct averaging treats
// dark and bright pixels by their luminance contribution, which is
// what the eye does.
function sRGBtoLinear(c) { return Math.pow(c / 255, 2.2); }
function linearToSRGB(l) { return Math.round(Math.pow(l, 1 / 2.2) * 255); }

function averageColor(pngBuffer) {
    const png = PNG.sync.read(pngBuffer);
    const { data, width, height } = png;
    // Collect opaque pixels with a perceptual-luminance key (Rec. 709
    // weights, against the linearised channel) so we can sort by
    // brightness and take only the top half. DOOM textures are
    // characterized visually by their highlights / detail areas; the
    // dark mortar / shadow that fills most of the pixel count drags a
    // naive average toward black. Averaging only the brighter half in
    // linear space gives a color that reads as the texture's
    // "character" rather than its arithmetic mean. The result is then
    // gamma-encoded back to sRGB for CSS.
    const pixels = [];
    for (let i = 0, len = width * height * 4; i < len; i += 4) {
        if (data[i + 3] < 128) continue;
        const lr = sRGBtoLinear(data[i]);
        const lg = sRGBtoLinear(data[i + 1]);
        const lb = sRGBtoLinear(data[i + 2]);
        const luma = 0.2126 * lr + 0.7152 * lg + 0.0722 * lb;
        pixels.push({ lr, lg, lb, luma });
    }
    if (pixels.length === 0) return null;
    // Average the brightest 25% of pixels (luminance-sorted) so the
    // result reads as the texture's "character" rather than a mean
    // dragged down by dark mortar / shadow areas. Then mix toward
    // each channel's per-texture max (75 / 25) so an entirely-dark
    // texture (e.g. CEIL5_1, ~rgb(26)) still picks up enough
    // contrast to survive the sector-light brightness filter cssDOOM
    // applies on top. This gives consistent visibility across the
    // brightness range — a deliberate departure from "true average"
    // toward "what the eye reads."
    pixels.sort((a, b) => a.luma - b.luma);
    const start = Math.floor(pixels.length * 0.75);
    let r = 0, g = 0, b = 0;
    let maxR = 0, maxG = 0, maxB = 0;
    for (const p of pixels) {
        if (p.lr > maxR) maxR = p.lr;
        if (p.lg > maxG) maxG = p.lg;
        if (p.lb > maxB) maxB = p.lb;
    }
    for (let i = start; i < pixels.length; i++) {
        r += pixels[i].lr;
        g += pixels[i].lg;
        b += pixels[i].lb;
    }
    const n = pixels.length - start;
    const avgR = r / n, avgG = g / n, avgB = b / n;
    let mixR = 0.75 * avgR + 0.25 * maxR;
    let mixG = 0.75 * avgG + 0.25 * maxG;
    let mixB = 0.75 * avgB + 0.25 * maxB;
    // Apply a minimum-luminance floor so genuinely-dark textures
    // (e.g. CEIL5_1, which is uniformly near-black) still survive
    // multiplication by sector light < 1 and remain perceptible
    // against the page's dark background. Floor is in linear space
    // so the perceptual lift is comfortable, not blown-out. Scale
    // each channel uniformly to preserve hue.
    const MIN_LUMINANCE = 0.08; // ~rgb(80) in sRGB at neutral grey
    const luma = 0.2126 * mixR + 0.7152 * mixG + 0.0722 * mixB;
    if (luma > 0 && luma < MIN_LUMINANCE) {
        const k = MIN_LUMINANCE / luma;
        mixR = Math.min(1, mixR * k);
        mixG = Math.min(1, mixG * k);
        mixB = Math.min(1, mixB * k);
    }
    return [linearToSRGB(mixR), linearToSRGB(mixG), linearToSRGB(mixB)];
}

const colors = {};
for (const dir of DIRS) {
    const path = join(ROOT, dir);
    for (const file of readdirSync(path)) {
        if (!file.endsWith('.png')) continue;
        const name = basename(file, '.png');
        const buf = readFileSync(join(path, file));
        const rgb = averageColor(buf);
        if (rgb) colors[name] = `rgb(${rgb[0]} ${rgb[1]} ${rgb[2]})`;
    }
}

writeFileSync(OUT, JSON.stringify(colors, null, 2));
console.log(`wrote ${Object.keys(colors).length} entries to ${OUT}`);
