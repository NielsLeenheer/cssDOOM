/**
 * Per-pane level-transition fade. Covers this pane while its scene
 * is being rebuilt — fired as a world command from `Level.load`:
 * show fades the pane to black, the scene rebuild runs hidden, hide
 * fades back in.
 *
 * Per-pane (not window-level) so a single-pane rebuild — e.g. a
 * Local DM secondary detach grace-rebuild on master — could cover
 * only that pane without disturbing the live sibling. Today
 * Level.load is window-wide so every pane fades together, but the
 * mechanism is ready for finer-grained rebuilds.
 *
 * Both impls return a promise: `setTimeout` matched to the CSS
 * transition duration (600 ms — see level-transition.css), or an
 * already-resolved promise when the pane is already in the target
 * state. The orchestrator collects them with `Promise.all` so callers
 * `await orchestrator.showLevelTransition()` get fade-complete
 * timing. Idempotent — Game.advance, Game.beginPlay, and Level.load
 * each call show without coordination; only the first does real work,
 * the rest hit the early-return and resolve immediately.
 *
 * Why setTimeout, not `transitionend`: the event is fragile (cancelled
 * mid-flight, intermediate-frame races, browser optimizations skipping
 * the event on no-op transitions). The CSS duration is owned in one
 * place; mirroring it here keeps the contract simple.
 */

const TRANSITION_MS = 600;

export function showLevelTransition(renderer) {
    const el = renderer.paneEl.querySelector('.pane-transition');
    if (!el) return Promise.resolve();
    if (el.classList.contains('visible')) return Promise.resolve();
    el.classList.add('visible');
    return new Promise(r => setTimeout(r, TRANSITION_MS));
}

export function hideLevelTransition(renderer) {
    const el = renderer.paneEl.querySelector('.pane-transition');
    if (!el) return Promise.resolve();
    if (!el.classList.contains('visible')) return Promise.resolve();
    el.classList.remove('visible');
    return new Promise(r => setTimeout(r, TRANSITION_MS));
}
