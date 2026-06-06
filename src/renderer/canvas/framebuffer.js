/**
 * Framebuffer — the pixel + depth buffers the SoftwareRenderer draws into,
 * plus the one drawing primitive that isn't a world pass (the alpha-tested
 * overlay blit used by the HUD and the full-screen screens).
 *
 * It's a self-contained unit with no knowledge of the renderer: the world
 * passes destructure its `{ W, H, fb, zb }` and index them directly in
 * their hot loops (the field names are kept terse and stable precisely so
 * those loops read identically whether the buffers live here or on the
 * renderer), while `clear` / `blit` / `resize` are the operations callers
 * go through. Isolating it here means it can be allocated, cleared, and
 * blitted into in a test without standing up a whole renderer.
 *
 * Pixels are ABGR uint32 (little-endian RGBA — the exact layout an
 * ImageData buffer uses, so `imageData` aliases `fb` with no copy). Depth
 * is forward camera distance; smaller is nearer.
 */
export class Framebuffer {
    constructor() {
        this.W = 0;
        this.H = 0;
        this.fb = null;        // Uint32Array framebuffer (ABGR), aliases imageData
        this.zb = null;        // Float32Array depth buffer (forward distance)
        this.imageData = null; // ImageData the display canvas blits from
    }

    /** Allocate the buffers for a W×H frame, backed by `ctx`'s ImageData. */
    resize(W, H, ctx) {
        this.W = W;
        this.H = H;
        this.imageData = ctx.createImageData(W, H);
        this.fb = new Uint32Array(this.imageData.data.buffer);
        this.zb = new Float32Array(W * H);
    }

    /** Reset to opaque black at the far plane, ready for a new frame. */
    clear() {
        this.fb.fill(0xFF000000);
        this.zb.fill(Infinity);
    }

    /**
     * Blit a source rectangle of `tex` into the framebuffer, nearest-
     * neighbour scaled to the destination rectangle, alpha-tested. No
     * depth test — overlays (status bar, weapon, intermission/results/
     * lobby graphics) sit on top of the world.
     */
    blit(tex, sx, sy, sw, sh, dx, dy, dw, dh) {
        const { W, H, fb } = this;
        const data = tex.data, texW = tex.width;
        const x0 = Math.max(0, dx | 0), x1 = Math.min(W, (dx + dw) | 0);
        const y0 = Math.max(0, dy | 0), y1 = Math.min(H, (dy + dh) | 0);
        const ix = sw / dw, iy = sh / dh;
        for (let y = y0; y < y1; y++) {
            const srcY = sy + ((y - dy) * iy | 0);
            const srcRow = srcY * texW;
            const dstRow = y * W;
            for (let x = x0; x < x1; x++) {
                const srcX = sx + ((x - dx) * ix | 0);
                const texel = data[srcRow + srcX];
                if ((texel >>> 24) < 128) continue;
                fb[dstRow + x] = texel | 0xff000000;
            }
        }
    }
}
