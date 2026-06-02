/**
 * debug.sprites — sprite-sheet stepped-animation visualisation.
 *
 * showSheet(sectorId) lays a half-transparent clone of the WHOLE sprite sheet
 * over each sprite in a sector (the `.sector#s{id}` containers the renderer
 * already groups things under). The clone is appended as a child of the sprite,
 * so it inherits the live sheet metrics (--w/--h/--frames/--cols/--rows/
 * --heading) and the sprite's billboard + mirror transform. Where the real
 * sprite steps background-position to window one cell, the clone shows the whole
 * sheet and translates it by the same amount (driven by --viz-step), so the
 * active cell stays pinned over the opaque original while the sheet drifts.
 *
 * The clone's step animation is start-time-synced to the sprite's own
 * sprite-cycle via the Web Animations API — each sprite carries a randomized
 * animation-delay, so a fresh clone would otherwise run out of phase. Styling
 * lives in debug/sprites.css; this module never touches the renderer.
 *
 * Exposed as debug.sprites.* in console.js.
 */

const spriteSel = (sectorId) =>
    (sectorId == null ? '' : `.sector#s${sectorId} `) + '.sprite';
const ghostSel = (sectorId) =>
    (sectorId == null ? '' : `.sector#s${sectorId} `) + '.sprite-sheet-ghost';

// The sheet animations a sprite can run (see sprites.css): sprite-cycle is the
// looping walk; sprite-stop / sprite-hide are the one-shot attack / death runs.
const SHEET_ANIMS = ['sprite-cycle', 'sprite-stop', 'sprite-hide'];

/** (Re)build the ghost's --viz-step animation to mirror whichever sheet
 *  animation the sprite is currently running — matched columns / steps / timing
 *  and a shared startTime, so the ghosted active cell stays aligned. Cancels any
 *  prior sync first; called on show and again whenever the sprite changes state
 *  (walk → attack → die), since each state runs a different animation. */
function syncStep(sprite, ghost) {
    ghost.getAnimations().forEach(a => a.cancel());     // drop the previous sync
    const frames = parseInt(getComputedStyle(sprite).getPropertyValue('--frames')) || 1;
    const orig = sprite.getAnimations().find(a => SHEET_ANIMS.includes(a.animationName));
    if (!orig) return;     // no sheet animation right now — ghost holds on frame 0
    const t = orig.effect.getComputedTiming();
    // sprite-cycle loops 0..frames-1 (steps(frames), infinite); sprite-stop /
    // -hide step through frames-1 columns once and hold on the last (forwards).
    const cycling = orig.animationName === 'sprite-cycle';
    const lastStep = cycling ? frames : Math.max(1, frames - 1);
    const anim = ghost.animate(
        [{ '--viz-step': '0' }, { '--viz-step': String(lastStep) }],
        {
            duration: t.duration,
            delay: t.delay,
            iterations: cycling ? Infinity : 1,
            fill: cycling ? 'none' : 'forwards',
            easing: `steps(${lastStep})`,
        },
    );
    if (orig.startTime != null) anim.startTime = orig.startTime;
    else if (orig.currentTime != null) anim.currentTime = orig.currentTime;
}

/** Show the sheet ghost over every sprite in a sector (or all sprites if no id).
 *  Skips sprites that already have one. */
export function showSheet(sectorId) {
    document.querySelectorAll(spriteSel(sectorId)).forEach(sprite => {
        if (sprite.querySelector(':scope > .sprite-sheet-ghost')) return;
        const ghost = document.createElement('div');
        ghost.className = 'sprite-sheet-ghost';
        sprite.appendChild(ghost);
        syncStep(sprite, ghost);
        // Re-sync when the sprite switches animation (walk → attack → die): the
        // new run starts later, with its own frame count + timing. rAF so the
        // new animation is live before we read it.
        const obs = new MutationObserver(() =>
            requestAnimationFrame(() => { if (ghost.isConnected) syncStep(sprite, ghost); }));
        obs.observe(sprite, { attributes: true, attributeFilter: ['data-state'] });
        ghost.__vizObserver = obs;
    });
}

/** Remove the sheet ghosts in a sector (or all). */
export function hideSheet(sectorId) {
    document.querySelectorAll(ghostSel(sectorId)).forEach(el => {
        el.__vizObserver?.disconnect();
        el.remove();
    });
}
