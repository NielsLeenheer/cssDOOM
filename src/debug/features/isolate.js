/**
 * Isolate HUD — fade the 3D scene out behind a flat grey field, leaving just the
 * HUD (status bar + weapon) floating, for the talk's "anatomy of the HUD" shot.
 *
 * Toggles body.debug-isolate-hud; the fade is a grey #434343 layer that eases in
 * over .renderer::after — above .viewport (the scene), below .hud (z-index 1000,
 * which carries both the status bar and the weapon) — so the HUD stays fully lit
 * while the world dims away. (.viewport's own ::before/::after are taken by the
 * sky fade + spectator dim.) See features/isolate.css. Console: debug.isolateHud().
 */

const CLASS = 'debug-isolate-hud';

/** No arg toggles; pass a boolean to set the isolate-HUD overlay on/off. */
export function isolateHud(on) {
    const want = on === undefined ? !document.body.classList.contains(CLASS) : !!on;
    document.body.classList.toggle(CLASS, want);
}
