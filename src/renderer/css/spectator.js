/**
 * Renderer-side spectator support.
 *
 * Spectator mode is a single-player dev/installation feature with two
 * sub-modes — follow-behind camera and top-down map view. The CSS
 * (`src/ui/spectator.css`) does all the transforms, keyed on
 * `body.spectator` (with `body.follow-mode` selecting the variant) and
 * driven by custom properties on the renderer's viewport.
 *
 * This module owns the renderer's part: setting those custom properties,
 * fading ceilings, running the scene-transform transition with the body
 * class toggle that triggers the CSS animation.
 *
 * Every function takes a `renderer` arg and operates only on that
 * renderer's DOM (`renderer.viewportEl`, `renderer.sceneEl`). The UI
 * (`src/ui/spectator.js`) doesn't reach in here directly — it goes
 * through `Orchestrator` which forwards to `renderer.startSpectatorMode`,
 * etc. The CSSRenderer methods at the bottom of this file are the thin
 * delegates the Orchestrator hands off to.
 */

/** Runtime camera state for top-down mode (also feeds the billboard
 *  --spectator-angle inheriting onto .scene). Written from the spectator
 *  loop on every tick; the spectator UI module owns the source values. */
function setSpectatorCamera(renderer, { offsetX, offsetY, height, angle }) {
    const s = renderer.viewportEl.style;
    s.setProperty('--spectator-offset-x', offsetX);
    s.setProperty('--spectator-offset-y', offsetY);
    s.setProperty('--spectator-height', height);
    s.setProperty('--spectator-angle', angle);
}

/** Follow-mode camera distance — set on R/F key, drag, pinch. */
function setSpectatorFollowHeight(renderer, height) {
    renderer.viewportEl.style.setProperty('--follow-height', height);
}

/**
 * Pin — or clear (`null`) — the viewer that `updateEnemyRotation` uses to
 * pick sprite headings. The local player's body is the standard
 * `createPlayerSprite` billboard, normally hidden in its own pane and
 * dispatched every frame with viewers[0] = its own position (degenerate).
 * Spectator pins a viewer offset from the player toward the spectator camera
 * so the billboard — and every other sprite in this pane — orients to the
 * camera. The UI (`src/ui/spectator.js`) computes the world point (it owns
 * player position) and pushes it here each tick; this only stashes it.
 */
function setSpectatorViewer(renderer, viewer) {
    renderer._viewerOverride = viewer;
}

/**
 * Full entry choreography for spectator mode:
 *   1. Fade ceilings out so the top-down view isn't blocked.
 *   2. Run the scene-transform transition; inside the rAF callback,
 *      toggle the body class that drives the CSS transform change.
 *
 * `mode` is 'follow' or 'top'. The body class toggle owns the global
 * 'spectator' class plus the variant ('follow-mode' or not). The
 * inline scene transition runs alongside so the CSS `transition: none`
 * doesn't snap the change.
 */
function startSpectatorMode(renderer, mode) {
    fadeCeilings(renderer, false, 1.5);
    transitionScene(renderer, 1.5, () => {
        document.body.classList.add('spectator');
        document.body.classList.toggle('follow-mode', mode === 'follow');
    });
}

/**
 * Mid-spectator sub-mode change (top ↔ follow). No ceiling fade —
 * they stay hidden across the transition. Toggles `follow-mode` only;
 * `spectator` stays on.
 */
function switchSpectatorMode(renderer, mode) {
    transitionScene(renderer, 1, () => {
        document.body.classList.toggle('follow-mode', mode === 'follow');
    });
}

/**
 * Full exit choreography:
 *   1. Run scene transition + remove body classes.
 *   2. Fade ceilings back in (delayed so the transform settles first).
 */
function endSpectatorMode(renderer) {
    // Release the pinned rotation viewer so sprites fall back to the normal
    // per-pane viewer (the body is re-hidden in its own pane anyway).
    renderer._viewerOverride = null;
    transitionScene(renderer, 1, () => {
        document.body.classList.remove('spectator', 'follow-mode');
        fadeCeilings(renderer, true, 1, 0.5);
    });
}

// ── Internal helpers ─────────────────────────────────────────────────────

/**
 * Animate the .scene transform during a class toggle. The CSS rules
 * for spectator scenes carry `transition: none` (so per-frame camera
 * updates don't smear); this helper sets an inline transition that
 * overrides that for the duration of one class flip, then clears it
 * on the rotate transitionend.
 *
 * The rAF wrapper ensures the inline transition is in place BEFORE
 * the callback's class toggle triggers the CSS transform change.
 */
function transitionScene(renderer, duration, callback) {
    const sceneEl = renderer.sceneEl;
    sceneEl.style.transition =
        `translate ${duration}s ease-in-out, rotate ${duration}s ease-in-out, transform ${duration}s ease-in-out`;
    requestAnimationFrame(() => {
        callback();
        sceneEl.addEventListener('transitionend', function onEnd(e) {
            if (e.target !== sceneEl || e.propertyName !== 'rotate') return;
            sceneEl.removeEventListener('transitionend', onEnd);
            sceneEl.style.transition = '';
        });
    });
}

/**
 * Fade ceilings in/out via inline opacity transition. Avoids CSS
 * `@starting-style` (which re-triggers continuously in Safari). On
 * fade-in we set opacity:0 first, then rAF to '' to trigger the
 * transition; on fade-out we set transition first, then opacity:0.
 */
function fadeCeilings(renderer, fadeIn, duration, delay = 0) {
    for (const el of renderer.sceneEl.querySelectorAll('.ceiling')) {
        if (fadeIn) {
            el.style.opacity = '0';
            el.style.transition = `opacity ${duration}s ease ${delay}s`;
            requestAnimationFrame(() => {
                el.style.opacity = '';
                el.addEventListener('transitionend', function onEnd(e) {
                    if (e.propertyName !== 'opacity') return;
                    el.removeEventListener('transitionend', onEnd);
                    el.style.transition = '';
                }, { once: true });
            });
        } else {
            el.style.transition = `opacity ${duration}s ease ${delay}s`;
            el.style.opacity = '0';
            el.addEventListener('transitionend', function onEnd(e) {
                if (e.propertyName !== 'opacity') return;
                el.removeEventListener('transitionend', onEnd);
                el.style.transition = '';
                el.style.opacity = '';
            }, { once: true });
        }
    }
}

export {
    setSpectatorCamera,
    setSpectatorFollowHeight,
    setSpectatorViewer,
    startSpectatorMode,
    switchSpectatorMode,
    endSpectatorMode,
};
