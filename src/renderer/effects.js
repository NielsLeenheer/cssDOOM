/**
 * Visual effects — flash overlays and abstract player state classes.
 * Game logic calls these to trigger visual feedback without DOM knowledge.
 *
 * Each function takes a renderer instance and toggles classes on its
 * `rendererEl`. Mirror-mode fan-out (pane 1 mirroring player 0's effects)
 * is handled at the orchestrator dispatch layer — every renderer whose
 * `playerIndex` matches the called playerIndex receives the call.
 */

/**
 * Triggers a brief screen flash on this renderer by toggling a CSS class.
 * Uses a forced reflow (void offsetWidth) to restart the animation if
 * flashes occur in rapid succession.
 */
export function triggerFlash(renderer, className, duration = 300) {
    const el = renderer.rendererEl;
    el.classList.remove(className);
    void el.offsetWidth;
    el.classList.add(className);
    setTimeout(() => el.classList.remove(className), duration);
}

// --- Powerups ---

export function showPowerup(renderer, name) {
    renderer.rendererEl.classList.add(`powerup-${name}`);
}

export function hidePowerup(renderer, name) {
    renderer.rendererEl.classList.remove(`powerup-${name}`);
}

export function flickerPowerup(renderer, name, visible) {
    renderer.rendererEl.classList.toggle(`powerup-${name}`, visible);
}
