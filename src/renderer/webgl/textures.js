/**
 * GL texture cache for the WebGLRenderer.
 *
 * The canvas renderer decodes each PNG into a CPU pixel buffer; here we
 * upload it straight to a GL texture instead. Sampling is always NEAREST
 * — that's the whole point of this project's look: a high-resolution 3D
 * scene wearing the original game's low-res textures, so every texel
 * stays a crisp little square no matter how close the camera gets.
 *
 * Loading is lazy and asynchronous, mirroring canvas/textures.js: a
 * `get*()` returns the texture record once decoded, or `null` while the
 * PNG is still in flight (kicking off the load on first miss). The passes
 * skip a surface whose texture isn't ready and pick it up on a later
 * frame — no awaiting in the hot path.
 *
 * Wrap mode is fixed per category, because it depends on how the texel
 * coordinates are generated: walls and flats address their texture in
 * world units and must REPEAT to tile; sprites / HUD / screen graphics
 * address a single 0..1 quad and CLAMP so the bilinear-free edges don't
 * bleed the opposite side in.
 *
 * The cache is keyed per GL context. Because each WebGLRenderer owns its
 * own context (and its own textures can't be shared across contexts), we
 * hang the cache off the context object itself, and `clearTextureCache`
 * deletes that context's textures when its pane is torn down.
 */

// One reusable offscreen canvas for decoding PNG → ImageData.
let decodeCanvas = null;
let decodeCtx = null;

function decode(image) {
    if (!decodeCanvas) {
        decodeCanvas = document.createElement('canvas');
        decodeCtx = decodeCanvas.getContext('2d', { willReadFrequently: true });
    }
    const w = image.naturalWidth, h = image.naturalHeight;
    decodeCanvas.width = w;
    decodeCanvas.height = h;
    decodeCtx.clearRect(0, 0, w, h);
    decodeCtx.drawImage(image, 0, 0);
    return decodeCtx.getImageData(0, 0, w, h);
}

/** Per-context state: { cache:Map, inflight:Set }. */
function ctxState(gl) {
    let s = gl.__doomTexCache;
    if (!s) s = gl.__doomTexCache = { cache: new Map(), inflight: new Set() };
    return s;
}

function makeTexture(gl, imageData, wrap) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, imageData.width, imageData.height, 0,
        gl.RGBA, gl.UNSIGNED_BYTE, imageData);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, wrap);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, wrap);
    return { tex, width: imageData.width, height: imageData.height };
}

function load(gl, path, wrap) {
    const st = ctxState(gl);
    if (st.inflight.has(path)) return;
    st.inflight.add(path);
    const image = new Image();
    image.onload = () => {
        try {
            st.cache.set(path, makeTexture(gl, decode(image), wrap));
        } catch {
            // Decode/upload can throw on a tainted or zero-sized image;
            // cache a 1×1 transparent stub so we don't retry forever.
            st.cache.set(path, stubTexture(gl));
        }
        st.inflight.delete(path);
    };
    image.onerror = () => {
        st.cache.set(path, stubTexture(gl));
        st.inflight.delete(path);
    };
    image.src = path;
}

let _stub = null;
function stubTexture(gl) {
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, 1, 1, 0, gl.RGBA, gl.UNSIGNED_BYTE,
        new Uint8Array([0, 0, 0, 0]));
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    return { tex, width: 1, height: 1 };
}

function getByPath(gl, path, wrap) {
    const st = ctxState(gl);
    const hit = st.cache.get(path);
    if (hit) return hit;
    load(gl, path, wrap);
    return null;
}

// World surfaces address their texture in world units → REPEAT to tile.
export function getWallTexture(gl, name) {
    if (!name || name === '-') return null;
    return getByPath(gl, `assets/textures/${name}.png`, gl.REPEAT);
}
export function getFlatTexture(gl, name) {
    if (!name || name === '-') return null;
    return getByPath(gl, `assets/flats/${name}.png`, gl.REPEAT);
}
export function getSkyTexture(gl) {
    return getByPath(gl, 'assets/textures/SKY1.png', gl.REPEAT);
}

// Billboards / overlays address a single 0..1 quad → CLAMP.
export function getSpriteTexture(gl, name) {
    if (!name) return null;
    return getByPath(gl, `assets/sprites/${name}.png`, gl.CLAMP_TO_EDGE);
}
export function getWeaponTexture(gl, name) {
    if (!name) return null;
    return getByPath(gl, `assets/weapons/${name}.png`, gl.CLAMP_TO_EDGE);
}
export function getHudTexture(gl, name) {
    if (!name) return null;
    return getByPath(gl, `assets/hud/${name}.png`, gl.CLAMP_TO_EDGE);
}
export function getIntermissionTexture(gl, name) {
    if (!name) return null;
    return getByPath(gl, `assets/intermission/${name}.png`, gl.CLAMP_TO_EDGE);
}
export function getMenuTexture(gl, name) {
    if (!name) return null;
    return getByPath(gl, `assets/menu/${name}.png`, gl.CLAMP_TO_EDGE);
}

// DOOM small font glyph: STCFNnnn.png where nnn is the ASCII code (033..097).
export function getFontTexture(gl, code) {
    if (code < 33 || code > 97) return null;
    return getByPath(gl, `assets/font/STCFN${String(code).padStart(3, '0')}.png`, gl.CLAMP_TO_EDGE);
}

/** Delete this context's textures — used when the pane is torn down. */
export function clearTextureCache(gl) {
    const st = gl.__doomTexCache;
    if (!st) return;
    for (const t of st.cache.values()) gl.deleteTexture(t.tex);
    st.cache.clear();
    st.inflight.clear();
}
