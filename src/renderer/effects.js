/**
 * Visual effects — flash overlays and abstract player state classes.
 * Game logic calls these to trigger visual feedback without DOM knowledge.
 *
 * Per-player: each pane has its own .renderer element in dom.renderers[i].
 * Each function takes a playerIndex so the right pane's overlay/powerup
 * class toggles. In mirror mode, viewportsForEffect() fans out player 0's
 * effects to pane 1 so the mirror pane sees the same visuals.
 */

import { dom } from './dom.js';
import { viewportsForEffect } from './scene/scene.js';

/**
 * Triggers a brief screen flash on the given player's pane by toggling a
 * CSS class on that pane's .renderer. Uses a forced reflow (void offsetWidth)
 * to restart the animation if flashes occur in rapid succession.
 */
export function triggerFlash(playerIndex, className, duration = 300) {
    for (const i of viewportsForEffect(playerIndex)) {
        const rendererEl = dom.renderers[i];
        rendererEl.classList.remove(className);
        void rendererEl.offsetWidth;
        rendererEl.classList.add(className);
        setTimeout(() => rendererEl.classList.remove(className), duration);
    }
}

// --- Powerups ---

export function showPowerup(playerIndex, name) {
    for (const i of viewportsForEffect(playerIndex)) {
        dom.renderers[i].classList.add(`powerup-${name}`);
    }
}

export function hidePowerup(playerIndex, name) {
    for (const i of viewportsForEffect(playerIndex)) {
        dom.renderers[i].classList.remove(`powerup-${name}`);
    }
}

export function flickerPowerup(playerIndex, name, visible) {
    for (const i of viewportsForEffect(playerIndex)) {
        dom.renderers[i].classList.toggle(`powerup-${name}`, visible);
    }
}
