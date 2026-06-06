/**
 * Texture cache for the CanvasRenderer.
 *
 * Loads PNG assets (wall textures, flats, sprites, the sky) into raw
 * pixel buffers the software rasterizer can sample directly. Each
 * entry is decoded once via an offscreen canvas → getImageData, then
 * stored as a Uint32Array in the same ABGR byte order the framebuffer
 * uses, so a texel read is a single array index and a write is a
 * single store.
 *
 * Loading is lazy and asynchronous: `get*()` returns the decoded
 * texture if it's ready, or `null` while the PNG is still in flight
 * (kicking off the load on first miss). The renderer simply skips a
 * surface whose texture isn't ready yet and picks it up on a later
 * frame — no awaiting in the hot path.
 *
 * Paths mirror the sibling renderers: maps are fetched relative
 * (`maps/…`) and assets live under `assets/{textures,flats,sprites}`.
 */

// path → { width, height, data: Uint32Array } once decoded.
const cache = new Map();
// path → true while a load is in flight (so we don't re-request).
const inflight = new Set();

// One reusable offscreen canvas for decoding. `willReadFrequently`
// hints the browser to keep the backing store in CPU memory.
let decodeCanvas = null;
let decodeCtx = null;

function decode(image) {
    if (!decodeCanvas) {
        decodeCanvas = document.createElement('canvas');
        decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });
    }
    const w = image.naturalWidth;
    const h = image.naturalHeight;
    decodeCanvas.width = w;
    decodeCanvas.height = h;
    decodeCtx.clearRect(0, 0, w, h);
    decodeCtx.drawImage(image, 0, 0);
    const rgba = decodeCtx.getImageData(0, 0, w, h).data;
    // The ImageData buffer is already RGBA little-endian = ABGR
    // uint32, the exact layout the framebuffer wants. Copy into a
    // standalone Uint32Array so it survives the next decode.
    const data = new Uint32Array(rgba.buffer.slice(0));
    return { width: w, height: h, data };
}

function load(path) {
    if (inflight.has(path)) return;
    inflight.add(path);
    const image = new Image();
    image.onload = () => {
        try {
            cache.set(path, decode(image));
        } catch (err) {
            // Decode can throw if the image is tainted or zero-sized;
            // cache a 1×1 transparent stub so we don't retry forever.
            cache.set(path, { width: 1, height: 1, data: new Uint32Array(1) });
        }
        inflight.delete(path);
    };
    image.onerror = () => {
        cache.set(path, { width: 1, height: 1, data: new Uint32Array(1) });
        inflight.delete(path);
    };
    image.src = path;
}

/**
 * Return the decoded texture for `path`, or null if it isn't ready.
 * First miss kicks off the async load.
 */
function getByPath(path) {
    const hit = cache.get(path);
    if (hit) return hit;
    load(path);
    return null;
}

export function getWallTexture(name) {
    if (!name || name === '-') return null;
    return getByPath(`assets/textures/${name}.png`);
}

export function getFlatTexture(name) {
    if (!name || name === '-') return null;
    return getByPath(`assets/flats/${name}.png`);
}

export function getSpriteTexture(name) {
    if (!name) return null;
    return getByPath(`assets/sprites/${name}.png`);
}

export function getSkyTexture() {
    return getByPath('assets/textures/SKY1.png');
}

export function getWeaponTexture(name) {
    if (!name) return null;
    return getByPath(`assets/weapons/${name}.png`);
}

export function getHudTexture(name) {
    if (!name) return null;
    return getByPath(`assets/hud/${name}.png`);
}

/** Drop everything — used when the renderer is torn down. */
export function clearTextureCache() {
    cache.clear();
    inflight.clear();
}
