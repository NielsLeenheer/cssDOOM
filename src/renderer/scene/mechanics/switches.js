/**
 * Switch rendering — visual state toggle.
 *
 * Pane 0's switch element keeps its `id={wallId}`; cloned switch elements in
 * other panes have `data-orig-id={wallId}` instead (id uniqueness rule —
 * see scene.js cloneSceneToOtherPanes). This helper toggles state on every
 * pane's matching element so all panes flip in sync.
 */

export function toggleSwitchState(wallId) {
    const orig = document.getElementById(wallId);
    if (!orig) return;
    const newState = orig.dataset.state === 'on' ? 'off' : 'on';
    orig.dataset.state = newState;
    for (const el of document.querySelectorAll(`[data-orig-id="${wallId}"]`)) {
        el.dataset.state = newState;
    }
}
