/**
 * SoftwareRenderer — a from-scratch 2D-canvas software renderer that
 * paints a DOOM level the way the original game did, into a low-res
 * internal framebuffer that the CanvasRenderer then upscales (nearest
 * neighbour) to the pane. No DOM, no WebGL — just a Uint32 pixel
 * buffer and a per-pixel depth buffer.
 *
 * Techniques, mirrored from id's renderer (r_segs / r_plane / r_things
 * in linuxdoom-1.10):
 *
 *   - Walls are drawn as vertical textured columns. The horizontal
 *     texture coordinate is perspective-correct (interpolate u/z and
 *     1/z across the span); the vertical coordinate is affine within a
 *     column because a wall is vertical and depth is constant down the
 *     column — exactly DOOM's R_DrawColumn setup.
 *
 *   - Floors and ceilings (flats) are drawn by back-projecting every
 *     screen pixel onto the horizontal plane at the sector's height and
 *     sampling the 64×64 flat at the resulting world (x, y) — the
 *     visplane math, done per-pixel rather than per-span.
 *
 *   - The sky is sampled by view angle per column and is independent
 *     of depth, so it always sits behind the world.
 *
 *   - Light diminishing combines the sector light level with distance
 *     falloff, quantised into bands and nudged by wall orientation
 *     (the N/S-brighter, E/W-darker "fake contrast").
 *
 *   - Things are camera-facing billboards using the front-facing sprite
 *     frame, depth-tested against the world per pixel.
 *
 * The camera transform and projection are byte-for-byte the same shape
 * as the LineRenderer's vendored scene so this pane frames the world
 * identically to its siblings.
 */

import {
    getWallTexture,
    getFlatTexture,
    getSpriteTexture,
    getSkyTexture,
} from './textures.js';
import { THING_SPRITES } from '../dom/scene/constants.js';

const FOV = Math.PI / 2;      // horizontal field of view (matches LineRenderer)
const NEAR = 4;               // near plane, world units
const MAX_DIST = 4000;        // far cull for flats / sprites
const SKY_DEPTH = 1e7;        // pseudo-depth so sky loses to all real geometry
const INV_FADE = 1 / 2600;    // distance light falloff rate
const LIGHT_FLOOR = 0.22;     // darkest a lit surface gets, as a fraction
const LIGHT_BAND = 12;        // colormap-style quantisation step

// val (0..255 brightness) → multiplier in 0..256 for `c * lf >> 8`.
const LIGHT_LUT = new Uint16Array(256);
for (let i = 0; i < 256; i++) LIGHT_LUT[i] = Math.min(256, ((i * 256 / 255) | 0));

export class SoftwareRenderer {
    constructor() {
        this.W = 0;
        this.H = 0;
        this.fb = null;           // Uint32Array framebuffer (ABGR)
        this.zb = null;           // Float32Array depth buffer (forward distance)
        this.imageData = null;    // ImageData backing fb
        this.walls = [];
        this.sectorPolygons = [];
        this.sprites = [];        // [{ x, y, floorZ, light, name }]
        this._colAngle = null;    // per-column view-angle offset, rebuilt on resize
    }

    /** Allocate buffers for an internal resolution of W×H. */
    resize(W, H, ctx) {
        this.W = W;
        this.H = H;
        this.imageData = ctx.createImageData(W, H);
        this.fb = new Uint32Array(this.imageData.data.buffer);
        this.zb = new Float32Array(W * H);
        const halfW = W * 0.5;
        const sxScale = halfW / Math.tan(FOV / 2);
        this._colAngle = new Float32Array(W);
        for (let x = 0; x < W; x++) {
            this._colAngle[x] = Math.atan2(x + 0.5 - halfW, sxScale);
        }
    }

    /** Stash the geometry from a loaded map. */
    setMap(data) {
        this.walls = data.walls || [];
        this.sectorPolygons = data.sectorPolygons || [];

        // Precompute the billboard list: every map thing that has a
        // front-facing sprite and isn't a multiplayer-only spawn. Each
        // gets the floor height + light of the sector it stands in so
        // the billboard is anchored and shaded correctly.
        this.sprites = [];
        for (const t of (data.things || [])) {
            const name = THING_SPRITES[t.type];
            if (!name) continue;
            if (t.flags & 16) continue;        // MP-only thing, skip in SP
            if (!(t.flags & 7)) continue;      // not present on any skill
            const sector = this._sectorAt(t.x, t.y);
            this.sprites.push({
                x: t.x,
                y: t.y,
                floorZ: sector ? sector.floorHeight : 0,
                light: sector ? sector.lightLevel : 180,
                name,
            });
        }
    }

    clear() {
        this.walls = [];
        this.sectorPolygons = [];
        this.sprites = [];
    }

    // ── Per-frame entry point ────────────────────────────────────────────

    render(camera) {
        const { W, H, fb, zb } = this;
        if (!fb) return;

        fb.fill(0xFF000000);
        zb.fill(Infinity);

        const aspect = W / H;
        const fovScale = Math.tan(FOV / 2);
        const halfW = W * 0.5;
        const halfH = H * 0.5;
        const sxScale = halfW / fovScale;
        const syScale = (aspect * halfH) / fovScale;

        const cam = {
            ex: camera.x,
            ey: camera.y,
            ez: camera.z,
            ca: Math.cos(camera.angle),
            sa: Math.sin(camera.angle),
            angle: camera.angle,
            halfW, halfH, sxScale, syScale, aspect, fovScale,
        };

        this._renderWalls(cam);
        this._renderFlats(cam);
        this._renderSprites(cam);
    }

    // ── Walls ────────────────────────────────────────────────────────────

    _renderWalls(cam) {
        const { W, H, fb, zb } = this;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;

        for (const wall of this.walls) {
            const tex = getWallTexture(wall.texture);
            if (!tex) continue;

            const ax = wall.start.x, ay = wall.start.y;
            const bx = wall.end.x, by = wall.end.y;
            const dx = bx - ax, dy = by - ay;

            // No back-face culling: the exported wall quads don't carry
            // a reliable, consistent winding (each is one visible
            // surface facing into its sector), so culling by normal
            // drops walls that should be drawn. The per-pixel depth
            // buffer already resolves occlusion correctly, and at this
            // wall count the extra fill is negligible.

            // Camera-space endpoints.
            let c1x = (ax - ex) * ca + (ay - ey) * sa;
            let c1y = ca * (ay - ey) - sa * (ax - ex);
            let c2x = (bx - ex) * ca + (by - ey) * sa;
            let c2y = ca * (by - ey) - sa * (bx - ex);

            let u1 = wall.xOffset || 0;
            let u2 = u1 + Math.hypot(dx, dy);

            // Near-plane clip (carry the U coordinate along).
            if (c1y < NEAR && c2y < NEAR) continue;
            if (c1y < NEAR) {
                const t = (NEAR - c1y) / (c2y - c1y);
                c1x += (c2x - c1x) * t;
                u1 += (u2 - u1) * t;
                c1y = NEAR;
            } else if (c2y < NEAR) {
                const t = (NEAR - c2y) / (c1y - c2y);
                c2x += (c1x - c2x) * t;
                u2 += (u1 - u2) * t;
                c2y = NEAR;
            }

            const topZ = wall.topHeight - ez;
            const botZ = wall.bottomHeight - ez;

            let p1 = halfW + (c1x / c1y) * sxScale;
            let p2 = halfW + (c2x / c2y) * sxScale;
            let yt1 = halfH - (topZ / c1y) * syScale;
            let yb1 = halfH - (botZ / c1y) * syScale;
            let yt2 = halfH - (topZ / c2y) * syScale;
            let yb2 = halfH - (botZ / c2y) * syScale;
            let inv1 = 1 / c1y, inv2 = 1 / c2y;
            let uo1 = u1 * inv1, uo2 = u2 * inv2;

            if (p1 > p2) {
                let s;
                s = p1; p1 = p2; p2 = s;
                s = yt1; yt1 = yt2; yt2 = s;
                s = yb1; yb1 = yb2; yb2 = s;
                s = inv1; inv1 = inv2; inv2 = s;
                s = uo1; uo1 = uo2; uo2 = s;
            }

            const xs = Math.max(0, Math.ceil(p1 - 0.5));
            const xe = Math.min(W - 1, Math.floor(p2 - 0.5));
            if (xs > xe) continue;

            const span = p2 - p1 || 1e-6;
            const texW = tex.width, texH = tex.height, tdata = tex.data;
            const wallH = wall.topHeight - wall.bottomHeight;
            const yOff = wall.yOffset || 0;

            // Fake contrast: E/W walls darker, N/S walls brighter.
            let baseLight = wall.lightLevel;
            baseLight += Math.abs(dx) > Math.abs(dy) ? -16 : 16;

            for (let x = xs; x <= xe; x++) {
                const t = (x + 0.5 - p1) / span;
                const inv = inv1 + (inv2 - inv1) * t;
                const cy = 1 / inv;
                const u = (uo1 + (uo2 - uo1) * t) / inv;

                let texX = u % texW;
                if (texX < 0) texX += texW;
                texX |= 0;
                if (texX >= texW) texX = texW - 1;

                const ytop = yt1 + (yt2 - yt1) * t;
                const ybot = yb1 + (yb2 - yb1) * t;
                const colH = ybot - ytop;
                if (colH <= 0) continue;

                const y0 = Math.max(0, Math.ceil(ytop - 0.5));
                const y1 = Math.min(H - 1, Math.floor(ybot - 0.5));
                if (y0 > y1) continue;

                const lf = lightFor(baseLight, cy);
                const col = texX;
                const invColH = 1 / colH;

                for (let y = y0; y <= y1; y++) {
                    const idx = y * W + x;
                    if (cy >= zb[idx]) continue;
                    const frac = (y + 0.5 - ytop) * invColH;
                    let v = frac * wallH + yOff;
                    v %= texH;
                    if (v < 0) v += texH;
                    let texY = v | 0;
                    if (texY >= texH) texY = texH - 1;
                    const texel = tdata[texY * texW + col];
                    if ((texel >>> 24) < 128) continue;
                    fb[idx] = shade(texel, lf);
                    zb[idx] = cy;
                }
            }
        }
    }

    // ── Floors & ceilings ────────────────────────────────────────────────

    _renderFlats(cam) {
        const sky = getSkyTexture();
        for (const sector of this.sectorPolygons) {
            if (sector.ceilingHeight > sector.floorHeight) {
                // Floor.
                const floorTex = getFlatTexture(sector.floorTexture);
                if (floorTex) {
                    this._drawPlane(cam, sector.boundaries, sector.floorHeight,
                        floorTex, sector.lightLevel, false, null);
                }
                // Ceiling (sky or flat).
                const isSky = sector.ceilingTexture === 'F_SKY1';
                if (isSky) {
                    if (sky) {
                        this._drawPlane(cam, sector.boundaries, sector.ceilingHeight,
                            null, sector.lightLevel, true, sky);
                    }
                } else {
                    const ceilTex = getFlatTexture(sector.ceilingTexture);
                    if (ceilTex) {
                        this._drawPlane(cam, sector.boundaries, sector.ceilingHeight,
                            ceilTex, sector.lightLevel, false, null);
                    }
                }
            }
        }
    }

    _drawPlane(cam, boundaries, planeZ, tex, lightLevel, isSky, sky) {
        const { W, H, fb, zb } = this;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale, angle } = cam;
        const cz = planeZ - ez;
        if (Math.abs(cz) < 0.01) return;   // plane at eye level — no coverage

        // Clip every boundary loop to the near plane and project to
        // screen. Edges from all loops feed one even-odd scanline fill,
        // which makes holes (hasHoles sectors) just work.
        const edges = [];   // flat [x0,y0,x1,y1, ...]
        let minY = Infinity, maxY = -Infinity;
        let anyVisible = false;

        for (const loop of boundaries) {
            if (!loop || loop.length < 3) continue;
            const n = loop.length;
            const screen = [];
            for (let i = 0; i < n; i++) {
                const cur = loop[i];
                const nxt = loop[(i + 1) % n];
                const cux = (cur.x - ex) * ca + (cur.y - ey) * sa;
                const cuy = ca * (cur.y - ey) - sa * (cur.x - ex);
                const cnx = (nxt.x - ex) * ca + (nxt.y - ey) * sa;
                const cny = ca * (nxt.y - ey) - sa * (nxt.x - ex);
                const curIn = cuy >= NEAR;
                const nxtIn = cny >= NEAR;
                if (curIn) {
                    screen.push(halfW + (cux / cuy) * sxScale,
                                halfH - (cz / cuy) * syScale);
                }
                if (curIn !== nxtIn) {
                    const t = (NEAR - cuy) / (cny - cuy);
                    const ix = cux + (cnx - cux) * t;
                    screen.push(halfW + (ix / NEAR) * sxScale,
                                halfH - (cz / NEAR) * syScale);
                }
            }
            if (screen.length < 6) continue;
            anyVisible = true;
            for (let i = 0; i < screen.length; i += 2) {
                const x0 = screen[i], y0 = screen[i + 1];
                const j = (i + 2) % screen.length;
                const x1 = screen[j], y1 = screen[j + 1];
                edges.push(x0, y0, x1, y1);
                if (y0 < minY) minY = y0;
                if (y0 > maxY) maxY = y0;
            }
        }
        if (!anyVisible) return;

        const yTop = Math.max(0, Math.ceil(minY - 0.5));
        const yBot = Math.min(H - 1, Math.floor(maxY - 0.5));
        if (yTop > yBot) return;

        const skyW = sky ? sky.width : 0;
        const skyH = sky ? sky.height : 0;
        const skyData = sky ? sky.data : null;
        const texW = tex ? tex.width : 0;
        const texH = tex ? tex.height : 0;
        const tdata = tex ? tex.data : null;
        const colAngle = this._colAngle;

        const xsBuf = this._xsBuf || (this._xsBuf = new Float32Array(64));

        for (let y = yTop; y <= yBot; y++) {
            const yc = y + 0.5;

            // Collect scanline/edge intersections.
            let count = 0;
            for (let e = 0; e < edges.length; e += 4) {
                const ay = edges[e + 1], by = edges[e + 3];
                if ((ay <= yc && by > yc) || (by <= yc && ay > yc)) {
                    const ax = edges[e], bx = edges[e + 2];
                    const x = ax + (bx - ax) * ((yc - ay) / (by - ay));
                    if (count < xsBuf.length) xsBuf[count++] = x;
                }
            }
            if (count < 2) continue;

            // Insertion sort (spans are short).
            for (let i = 1; i < count; i++) {
                const v = xsBuf[i];
                let j = i - 1;
                while (j >= 0 && xsBuf[j] > v) { xsBuf[j + 1] = xsBuf[j]; j--; }
                xsBuf[j + 1] = v;
            }

            // Precompute the per-row plane distance for non-sky flats:
            // depth depends only on y, so do the divide once per row.
            const denomY = halfH - yc;
            const rowDepth = isSky ? SKY_DEPTH : (cz * syScale) / denomY;
            if (!isSky && (rowDepth < NEAR || rowDepth > MAX_DIST)) continue;
            const lf = isSky ? 256 : lightFor(lightLevel, rowDepth);
            const base = y * W;
            // Sky vertical coordinate is fixed to the screen row.
            const skyV = isSky
                ? Math.min(skyH - 1, ((y / H) * skyH * 1.5) | 0)
                : 0;

            for (let s = 0; s + 1 < count; s += 2) {
                const xL = Math.max(0, Math.ceil(xsBuf[s] - 0.5));
                const xR = Math.min(W - 1, Math.floor(xsBuf[s + 1] - 0.5));
                for (let x = xL; x <= xR; x++) {
                    const idx = base + x;
                    if (rowDepth >= zb[idx]) continue;

                    if (isSky) {
                        let u = ((angle + colAngle[x]) / (Math.PI * 2)) * skyW * 4;
                        u %= skyW;
                        if (u < 0) u += skyW;
                        const texel = skyData[skyV * skyW + (u | 0)];
                        fb[idx] = texel | 0xFF000000;
                        zb[idx] = SKY_DEPTH;
                        continue;
                    }

                    // Back-project this pixel onto the plane.
                    const cx = (x + 0.5 - halfW) * rowDepth / sxScale;
                    const relX = ca * cx - sa * rowDepth;
                    const relY = sa * cx + ca * rowDepth;
                    const wx = relX + ex;
                    const wy = relY + ey;
                    let tx = (wx | 0) % texW; if (tx < 0) tx += texW;
                    let ty = (wy | 0) % texH; if (ty < 0) ty += texH;
                    const texel = tdata[ty * texW + tx];
                    fb[idx] = shade(texel, lf);
                    zb[idx] = rowDepth;
                }
            }
        }
    }

    // ── Sprites (billboards) ─────────────────────────────────────────────

    _renderSprites(cam) {
        const { W, H, fb, zb } = this;
        const { ex, ey, ez, ca, sa, halfW, halfH, sxScale, syScale } = cam;

        for (const sprite of this.sprites) {
            const tex = getSpriteTexture(sprite.name);
            if (!tex) continue;

            const cx = (sprite.x - ex) * ca + (sprite.y - ey) * sa;
            const cy = ca * (sprite.y - ey) - sa * (sprite.x - ex);
            if (cy < NEAR || cy > MAX_DIST) continue;

            const sw = tex.width, sh = tex.height, sdata = tex.data;
            const halfWorld = sw * 0.5;

            const pxL = halfW + ((cx - halfWorld) / cy) * sxScale;
            const pxR = halfW + ((cx + halfWorld) / cy) * sxScale;
            const topZ = (sprite.floorZ + sh) - ez;
            const botZ = sprite.floorZ - ez;
            const pyTop = halfH - (topZ / cy) * syScale;
            const pyBot = halfH - (botZ / cy) * syScale;

            const x0 = Math.max(0, Math.ceil(pxL - 0.5));
            const x1 = Math.min(W - 1, Math.floor(pxR - 0.5));
            const y0 = Math.max(0, Math.ceil(pyTop - 0.5));
            const y1 = Math.min(H - 1, Math.floor(pyBot - 0.5));
            if (x0 > x1 || y0 > y1) continue;

            const invW = sw / (pxR - pxL || 1e-6);
            const invH = sh / (pyBot - pyTop || 1e-6);
            const lf = lightFor(sprite.light, cy);

            for (let y = y0; y <= y1; y++) {
                let ty = ((y + 0.5 - pyTop) * invH) | 0;
                if (ty < 0 || ty >= sh) continue;
                const row = ty * sw;
                const base = y * W;
                for (let x = x0; x <= x1; x++) {
                    const idx = base + x;
                    // 2-unit lenience so a sprite sits in front of the
                    // floor it stands on without z-fighting it.
                    if (cy > zb[idx] + 2) continue;
                    let tx = ((x + 0.5 - pxL) * invW) | 0;
                    if (tx < 0 || tx >= sw) continue;
                    const texel = sdata[row + tx];
                    if ((texel >>> 24) < 128) continue;
                    fb[idx] = shade(texel, lf);
                    zb[idx] = cy;
                }
            }
        }
    }

    // ── Helpers ──────────────────────────────────────────────────────────

    /** Sector whose outer boundary contains (x, y), ignoring holes. */
    _sectorAt(x, y) {
        for (const s of this.sectorPolygons) {
            const loops = s.boundaries;
            if (!loops || !loops.length) continue;
            if (!pointInLoop(x, y, loops[0])) continue;
            let inHole = false;
            for (let h = 1; h < loops.length; h++) {
                if (pointInLoop(x, y, loops[h])) { inHole = true; break; }
            }
            if (!inHole) return s;
        }
        return null;
    }
}

// Multiply an ABGR texel by a 0..256 light factor.
function shade(texel, lf) {
    const r = ((texel & 0xff) * lf) >> 8;
    const g = (((texel >> 8) & 0xff) * lf) >> 8;
    const b = (((texel >> 16) & 0xff) * lf) >> 8;
    return 0xff000000 | (b << 16) | (g << 8) | r;
}

// Sector light + distance falloff → 0..256 multiplier, banded.
function lightFor(level, dist) {
    let m = 1 - dist * INV_FADE;
    if (m < LIGHT_FLOOR) m = LIGHT_FLOOR;
    let v = level * m;
    v -= v % LIGHT_BAND;          // colormap-style quantisation
    if (v < 0) v = 0; else if (v > 255) v = 255;
    return LIGHT_LUT[v | 0];
}

function pointInLoop(x, y, loop) {
    let inside = false;
    for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
        const xi = loop[i].x, yi = loop[i].y;
        const xj = loop[j].x, yj = loop[j].y;
        if (((yi > y) !== (yj > y)) &&
            (x < ((xj - xi) * (y - yi)) / (yj - yi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}
