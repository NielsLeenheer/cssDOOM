/**
 * GLSL ES 3.00 shader sources for the WebGLRenderer.
 *
 * The projection is the byte-for-byte equivalent of the canvas
 * SoftwareRenderer's: a 90°-horizontal-FOV pinhole with square pixels,
 * so this pane frames the world identically to its siblings. Rather than
 * build a 4×4 matrix on the CPU we hand the vertex shaders the raw camera
 * (eye position, cos/sin of yaw) and let them do the same right / forward
 * / up decomposition the canvas renderer does per pixel:
 *
 *     vx =  (p - eye)·(cos, sin)          // screen-right
 *     vz = -(p - eye)·(sin,-cos)          // forward (becomes clip w)
 *     vy =  p.z - eye.z                   // up
 *     clip = vec4(vx, vy*aspect, A*vz + B, vz)
 *
 * with aspect = W/H and A,B the usual near/far depth remap. (Sprites are
 * kept just in front of the floor with a glPolygonOffset in the entity
 * pass, not a world-space depth bias — see passes/entities.js.)
 *
 * Lighting is a single 0..1 brightness multiplier on the texel, computed
 * per surface on the CPU to match the DomRenderer exactly: a flat
 * per-sector value from its `doomLightToCSS` colormap mapping, with no
 * distance falloff and no per-pixel banding (the DOM applies `filter:
 * brightness()` per element). Animated light specials override that with
 * an absolute brightness, same as the DOM keyframes. The "high res,
 * low-res feel" comes from the chunky NEAREST texels, not from shading.
 */

// World vertex shader carries the per-vertex brightness (a_light, already
// 0..1) straight through to the fragment shader; the flat shader takes its
// brightness as a per-sector uniform. No lighting maths lives in GLSL.

// ── World program: walls + sprite billboards ─────────────────────────
// a_uv is in world texel units for walls (u_uvWorld=1 → divided by the
// texture size in the FS) and already-normalised 0..1 for sprites.
export const WORLD_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec3 a_pos;
layout(location=1) in vec2 a_uv;
layout(location=2) in float a_light;
uniform vec3 u_eye;
uniform vec2 u_rot;     // cos(angle), sin(angle)
uniform float u_aspect; // W/H
uniform float u_A, u_B; // depth remap
out vec2 v_uv;
out float v_light;
void main() {
    float dx = a_pos.x - u_eye.x;
    float dy = a_pos.y - u_eye.y;
    float vx =  dx * u_rot.x + dy * u_rot.y;
    float vz = -dx * u_rot.y + dy * u_rot.x;
    float vy =  a_pos.z - u_eye.z;
    v_uv = a_uv;
    v_light = a_light;
    // Project exactly. (Sprites get a tiny depth nudge toward the camera
    // via glPolygonOffset in the entity pass, not a world-space z bias:
    // because the far plane is huge, a world-unit bias here would act as a
    // ~20% depth lenience and punch sprites through nearby walls.)
    gl_Position = vec4(vx, vy * u_aspect, u_A * vz + u_B, vz);
}`;

export const WORLD_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
in float v_light;
uniform sampler2D u_tex;
uniform vec2 u_texSize;  // texels; used when u_uvWorld == 1
uniform float u_uvWorld; // 1 = uv in world units (÷texSize), 0 = uv already 0..1
out vec4 outColor;
void main() {
    vec2 uv = u_uvWorld > 0.5 ? v_uv / u_texSize : v_uv;
    vec4 t = texture(u_tex, uv);
    if (t.a < 0.5) discard;
    outColor = vec4(t.rgb * v_light, 1.0);
}`;

// ── Flat program: floors + ceilings ──────────────────────────────────
// Geometry is just the (x,y) of each sector polygon; the plane height is
// a uniform (so doors/lifts animate by changing one float, not the VBO),
// and the texel coordinate is the world (x,y) itself — exactly DOOM's
// world-aligned 64×64 flats.
export const FLAT_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec2 a_xy;
uniform vec3 u_eye;
uniform vec2 u_rot;
uniform float u_aspect;
uniform float u_A, u_B;
uniform float u_planeZ;
out vec2 v_world;
void main() {
    float dx = a_xy.x - u_eye.x;
    float dy = a_xy.y - u_eye.y;
    float vx =  dx * u_rot.x + dy * u_rot.y;
    float vz = -dx * u_rot.y + dy * u_rot.x;
    float vy =  u_planeZ - u_eye.z;
    v_world = a_xy;
    gl_Position = vec4(vx, vy * u_aspect, u_A * vz + u_B, vz);
}`;

export const FLAT_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_world;
uniform sampler2D u_tex;
uniform float u_light;   // 0..1 brightness, computed CPU-side
out vec4 outColor;
void main() {
    vec4 t = texture(u_tex, v_world / 64.0);
    outColor = vec4(t.rgb * u_light, 1.0);
}`;

// ── Sky program ──────────────────────────────────────────────────────
// Fullscreen backdrop. The sky is the original game's cylindrical
// projection: horizontal position follows view yaw, vertical position is
// a fixed-scale slice anchored so the texture base sits at the horizon
// (replicating tables.js::skyCol / skyRow). Drawn first with no depth, so
// any solid geometry painted afterwards covers it — sky shows through
// wherever a sky ceiling left the column empty.
export const SKY_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos; // fullscreen triangle in clip space
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

export const SKY_FS = /* glsl */`#version 300 es
precision highp float;
uniform sampler2D u_sky;
uniform vec2 u_res;     // framebuffer W,H in pixels
uniform float u_angle;
uniform vec2 u_skySize; // sky texture W,H
out vec4 outColor;
void main() {
    float W = u_res.x, H = u_res.y;
    float halfW = W * 0.5, halfH = H * 0.5;
    float x = gl_FragCoord.x;
    float yTop = H - gl_FragCoord.y;            // canvas counts rows from the top
    float skyW = u_skySize.x, skyH = u_skySize.y;
    float colAngle = atan(x - halfW, halfW);    // sxScale == halfW at 90° FOV
    float uBase = (u_angle / 6.2831853) * skyW * 4.0;
    float u = uBase - (colAngle / 6.2831853) * skyW * 4.0;
    u = mod(u, skyW);
    float iscale = 200.0 / H;
    float sv = (yTop - halfH) * iscale + (skyH - 28.0);
    sv = clamp(sv, 0.0, skyH - 1.0);
    vec3 c = texture(u_sky, vec2((u + 0.5) / skyW, (sv + 0.5) / skyH)).rgb;
    outColor = vec4(c, 1.0);
}`;

// ── Overlay blit program: HUD, weapon, screens ───────────────────────
// 2D textured quads in a virtual pixel space (origin top-left). Alpha-
// tested so the chunky DOOM graphics composite opaquely, exactly like
// the canvas framebuffer blit.
export const BLIT_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos; // virtual pixels
layout(location=1) in vec2 a_uv;
uniform vec2 u_vres; // virtual W,H
out vec2 v_uv;
void main() {
    vec2 ndc = vec2(a_pos.x / u_vres.x * 2.0 - 1.0, 1.0 - a_pos.y / u_vres.y * 2.0);
    v_uv = a_uv;
    gl_Position = vec4(ndc, 0.0, 1.0);
}`;

export const BLIT_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
uniform sampler2D u_tex;
out vec4 outColor;
void main() {
    vec4 t = texture(u_tex, v_uv);
    if (t.a < 0.5) discard;
    outColor = vec4(t.rgb, 1.0);
}`;

// ── Solid program: screen flash + lobby dim ──────────────────────────
// A single blended fullscreen quad. Flash = colour at low alpha over the
// world; lobby dim = black at ~0.70 alpha (≈ the canvas renderer's
// per-pixel ×77/256 darken).
export const SOLID_VS = /* glsl */`#version 300 es
precision highp float;
layout(location=0) in vec2 a_pos;
void main() { gl_Position = vec4(a_pos, 0.0, 1.0); }`;

export const SOLID_FS = /* glsl */`#version 300 es
precision highp float;
uniform vec4 u_color;
out vec4 outColor;
void main() { outColor = u_color; }`;
