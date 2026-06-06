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
 *     clip = vec4(vx, vy*aspect, A*(vz - zbias) + B, vz)
 *
 * with aspect = W/H and A,B the usual near/far depth remap. `zbias`
 * pulls billboards a couple of world units toward the camera so a sprite
 * sits cleanly in front of the floor it stands on (the canvas renderer's
 * "+2 lenience" in the depth test).
 *
 * Lighting matches tables.js::lightFor + shade: sector light scaled by a
 * distance falloff, quantised into colormap-style bands, multiplied into
 * the texel. Doing it per fragment means the bands sweep smoothly with
 * the high-res geometry while the texels stay chunky — the "high res,
 * low-res feel" the project is after.
 */

// Shared lighting snippet: forward distance + base light → lit rgb.
// Mirrors lightFor() (INV_FADE 1/2600, floor 0.22, 12-step banding).
const LIGHT_GLSL = /* glsl */`
float litFactor(float light, float dist) {
    float m = clamp(1.0 - dist / 2600.0, 0.22, 1.0);
    float v = light * m;
    v = floor(v / 12.0) * 12.0;
    return clamp(v, 0.0, 255.0) / 255.0;
}
`;

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
uniform float u_zbias;
out vec2 v_uv;
out float v_light;
out float v_dist;
void main() {
    float dx = a_pos.x - u_eye.x;
    float dy = a_pos.y - u_eye.y;
    float vx =  dx * u_rot.x + dy * u_rot.y;
    float vz = -dx * u_rot.y + dy * u_rot.x;
    float vy =  a_pos.z - u_eye.z;
    v_uv = a_uv;
    v_light = a_light;
    v_dist = vz;
    // Sprites pass u_zbias>0 to pull their depth a couple of world units
    // toward the camera (so a billboard sits in front of the floor it
    // stands on). Walls/flats pass 0 so they project exactly — biasing
    // them would shift where they cross the near plane.
    gl_Position = vec4(vx, vy * u_aspect, u_A * (vz - u_zbias) + u_B, vz);
}`;

export const WORLD_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_uv;
in float v_light;
in float v_dist;
uniform sampler2D u_tex;
uniform vec2 u_texSize;  // texels; used when u_uvWorld == 1
uniform float u_uvWorld; // 1 = uv in world units (÷texSize), 0 = uv already 0..1
out vec4 outColor;
${LIGHT_GLSL}
void main() {
    vec2 uv = u_uvWorld > 0.5 ? v_uv / u_texSize : v_uv;
    vec4 t = texture(u_tex, uv);
    if (t.a < 0.5) discard;
    outColor = vec4(t.rgb * litFactor(v_light, v_dist), 1.0);
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
out float v_dist;
void main() {
    float dx = a_xy.x - u_eye.x;
    float dy = a_xy.y - u_eye.y;
    float vx =  dx * u_rot.x + dy * u_rot.y;
    float vz = -dx * u_rot.y + dy * u_rot.x;
    float vy =  u_planeZ - u_eye.z;
    v_world = a_xy;
    v_dist = vz;
    gl_Position = vec4(vx, vy * u_aspect, u_A * vz + u_B, vz);
}`;

export const FLAT_FS = /* glsl */`#version 300 es
precision highp float;
in vec2 v_world;
in float v_dist;
uniform sampler2D u_tex;
uniform float u_light;
out vec4 outColor;
${LIGHT_GLSL}
void main() {
    vec4 t = texture(u_tex, v_world / 64.0);
    outColor = vec4(t.rgb * litFactor(u_light, v_dist), 1.0);
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
