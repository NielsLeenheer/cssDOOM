/**
 * Switch rendering — visual state toggle.
 *
 * Each renderer has its own switch element with `id={wallId}` inside its
 * scene tree. This impl toggles the state on the renderer's own copy.
 * The orchestrator's world dispatch fans the call to every renderer so
 * all panes flip in lockstep.
 */

export function toggleSwitchState(renderer, wallId) {
    const el = renderer.sceneEl.querySelector(`[id="${wallId}"]`);
    if (!el) return;
    el.dataset.state = el.dataset.state === 'on' ? 'off' : 'on';
}
