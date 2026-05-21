/**
 * Per-pane level-transition fade. Covers this pane while its scene
 * is being rebuilt — fired as a world command from
 * `Level.load`: show fades the pane to black, the scene rebuild
 * runs hidden, hide fades back in.
 *
 * Per-pane (not window-level) so a single-pane rebuild — e.g. a
 * Local DM secondary detach grace-rebuild on master — could cover
 * only that pane without disturbing the live sibling. Today
 * Level.load is window-wide so every pane fades together, but the
 * mechanism is ready for finer-grained rebuilds.
 *
 * The fade duration (600ms) is owned by the CSS; callers that need
 * to await the fade-in (so the scene rebuild lands on a fully
 * covered pane) wait the matching duration after firing show.
 */

export function showLevelTransition(renderer) {
    const el = renderer.paneEl.querySelector('.pane-transition');
    if (el) el.classList.add('visible');
}

export function hideLevelTransition(renderer) {
    const el = renderer.paneEl.querySelector('.pane-transition');
    if (el) el.classList.remove('visible');
}
