/**
 * Tiny WebGL2 helper layer for the WebGLRenderer.
 *
 * Nothing here knows about DOOM — it's the usual compile-a-program /
 * make-a-buffer boilerplate, factored out so the passes and the engine
 * read as drawing code instead of GL ceremony. Every renderer pass goes
 * through `Program` (which caches uniform / attribute locations on first
 * use) and `DynamicBuffer` / `StaticBuffer` for vertex data.
 */

/** Compile one shader stage, throwing with the info log on failure. */
function compileShader(gl, type, source) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, source);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
        const log = gl.getShaderInfoLog(sh);
        gl.deleteShader(sh);
        throw new Error(`WebGL shader compile failed:\n${log}\n${source}`);
    }
    return sh;
}

/**
 * A linked GL program plus lazily-resolved uniform / attribute location
 * caches. `u(name)` and `a(name)` memoise `getUniformLocation` /
 * `getAttribLocation` so the hot path is a Map lookup, not a GL call.
 */
export class Program {
    constructor(gl, vsSource, fsSource) {
        this.gl = gl;
        const vs = compileShader(gl, gl.VERTEX_SHADER, vsSource);
        const fs = compileShader(gl, gl.FRAGMENT_SHADER, fsSource);
        const p = gl.createProgram();
        gl.attachShader(p, vs);
        gl.attachShader(p, fs);
        gl.linkProgram(p);
        if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
            const log = gl.getProgramInfoLog(p);
            throw new Error(`WebGL program link failed:\n${log}`);
        }
        gl.deleteShader(vs);
        gl.deleteShader(fs);
        this.program = p;
        this._u = new Map();
        this._a = new Map();
    }

    use() { this.gl.useProgram(this.program); }

    /** Cached uniform location (null if the uniform was optimised out). */
    u(name) {
        let loc = this._u.get(name);
        if (loc === undefined) {
            loc = this.gl.getUniformLocation(this.program, name);
            this._u.set(name, loc);
        }
        return loc;
    }

    /** Cached attribute location (-1 if absent). */
    a(name) {
        let loc = this._a.get(name);
        if (loc === undefined) {
            loc = this.gl.getAttribLocation(this.program, name);
            this._a.set(name, loc);
        }
        return loc;
    }
}

/**
 * A growable ARRAY_BUFFER for streamed, rebuilt-every-frame geometry
 * (walls, sprites). `set(floatArray, count)` orphans + re-uploads; the
 * backing store only ever grows, so steady-state frames reuse it with
 * no reallocation.
 */
export class DynamicBuffer {
    constructor(gl) {
        this.gl = gl;
        this.buffer = gl.createBuffer();
        this._capacity = 0;   // capacity in floats
    }

    /** Upload the first `count` floats of `data` (default: all of it). */
    set(data, count = data.length) {
        const gl = this.gl;
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        if (count > this._capacity) {
            gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW, 0, count);
            this._capacity = count;
        } else {
            gl.bufferSubData(gl.ARRAY_BUFFER, 0, data, 0, count);
        }
    }

    dispose() { this.gl.deleteBuffer(this.buffer); }
}

/** A write-once ARRAY_BUFFER for static geometry (sector flat fans). */
export class StaticBuffer {
    constructor(gl, data) {
        this.gl = gl;
        this.buffer = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, this.buffer);
        gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
        this.length = data.length;
    }

    dispose() { this.gl.deleteBuffer(this.buffer); }
}
