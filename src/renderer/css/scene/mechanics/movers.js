/**
 * Shared mover-group helper.
 *
 * A mover (door / lift / crusher) animates by translating a `.mover` group that
 * lives inside a `.sector`. A mover's moving face is often a wall owned by an
 * *adjoining* sector (e.g. the upper wall that hangs down to a closed door),
 * which must ride along but stay in its own sector — so a mover can own several
 * `.mover` groups: its own, plus one inside each adjoining sector whose face
 * walls it drives. See IMPLEMENTATION-PLAN-movers.md (Phase 3).
 */

/** Create a `.mover` group element tagged with its mover type. */
export function createMoverGroup(moverType) {
    const el = document.createElement('div');
    el.className = 'mover';
    el.dataset.mover = moverType;
    return el;
}
