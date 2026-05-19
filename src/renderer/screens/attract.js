/**
 * Attract overlay — per-pane visual.
 *
 * The renderer half of the attract loop: shows the static overlay
 * (logo + "PRESS TO START" from the pane template) and animates a slow
 * camera rotation so the level scene visible behind / around the
 * overlay sweeps lazily.
 *
 * Driven by the `showAttract` / `hideAttract` world commands fired by
 * [src/game/attract.js](../../game/attract.js)'s `enterAttract` /
 * `exitAttract`. Master fires them once each on the game-state
 * transition; the orchestrator's per-target dispatch lands them on
 * every pane (master locals + every joiner sink → joiner's panes).
 *
 * The rotation animation is fully owned by this module — it mutates
 * each renderer's own `state.camera.angle` and writes the
 * `--player-angle` CSS variable for redraw. It does NOT touch
 * `state.players[i].angle`; the simulation stays honest about which
 * direction the player is facing. Self-throttled to ~50 ms per tick
 * (~20 fps) to keep the kiosk GPU compositor cool during long idle
 * periods — same throttle target the old game-loop-driven path used.
 *
 * Per-pane cancel fn lives in a module-local WeakMap keyed on the
 * pane's `.pane-attract` container, equivalent to a property on the
 * element scoped to this module.
 */

const ROTATE_RAD_PER_MS = 0.0002; // ~12°/sec — full rotation every 30s.
const TICK_INTERVAL_MS = 50;       // ~20 fps; throttles GPU work during
                                    // long idle periods on the kiosk.

const animationsByPane = new WeakMap();

export function showAttract(renderer) {
    const el = renderer.paneEl.querySelector('.pane-attract');
    if (!el) return;

    // Defensive: a stray second show without an intervening hide must
    // not leak the previous RAF.
    animationsByPane.get(el)?.();

    el.classList.add('active');

    // Capture the camera angle the last per-frame updateCamera left us
    // at — typically the spawn angle from the just-loaded E1M1 (see
    // game/level.js's pre-loadMap updateCamera prime).
    const baseAngle = renderer.state.camera.angle;
    const startTime = performance.now();
    let lastTickAt = 0;
    let rafId = null;
    let cancelled = false;

    const tick = (now) => {
        if (cancelled) return;
        if (now - lastTickAt >= TICK_INTERVAL_MS) {
            const angle = baseAngle + ROTATE_RAD_PER_MS * (now - startTime);
            renderer.state.camera.angle = angle;
            renderer.viewportEl.style.setProperty('--player-angle', angle);
            lastTickAt = now;
        }
        rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);

    animationsByPane.set(el, () => {
        cancelled = true;
        if (rafId != null) cancelAnimationFrame(rafId);
    });
}

export function hideAttract(renderer) {
    const el = renderer.paneEl.querySelector('.pane-attract');
    if (!el) return;
    animationsByPane.get(el)?.();
    animationsByPane.delete(el);
    el.classList.remove('active');
}
