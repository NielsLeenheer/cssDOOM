/**
 * Lift rendering — scene construction and visual state updates.
 */

import { appendToSector } from '../sectors.js';
import { createWallElement } from '../surfaces/walls.js';

/**
 * Builds the visual representation of a lift into the build context.
 *
 * A lift IS a sector: its moving group is a `.mover` child of the lift's own
 * `.sector`, holding the floor + platform-face shaft walls, so they inherit the
 * sector's --light / bbox / --outline. The `.mover` translates down to lower.
 * Non-face shaft walls are static and go in the sector's `.static` group.
 */
export function buildLift(ctx, lift) {
    const sector = ctx.sceneState.sectorContainers[lift.sectorIndex];
    if (!sector) return;

    const heightDelta = lift.upperHeight - lift.lowerHeight;

    const mover = document.createElement('div');
    mover.className = 'mover';
    mover.dataset.mover = 'lift';
    mover.style.setProperty('--offset', `${heightDelta}px`);

    // Move the lift sector's floor into the mover (inherits the sector light).
    for (const surfaceElement of ctx.sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === lift.sectorIndex && surfaceElement._type === 'floor') {
            mover.appendChild(surfaceElement);
        }
    }

    // Create shaft walls. The wall normally spans the lift's travel range
    // (lowerHeight..upperHeight). For one-way lifts (e.g. E1M1's imp
    // platform, type 36) whose `lowerHeight` sits a few units above the
    // adjacent floor, extend down to `neighborFloor` to close the gap.
    // Only extend — never raise the bottom above lowerHeight, or the
    // static shaft walls on the entry-corridor side (where neighborFloor
    // equals upperHeight) collapse to zero height and the shaft becomes
    // see-through when the platform is lowered.
    for (const shaftWall of lift.shaftWalls) {
        const bottom = shaftWall.neighborFloor !== undefined
            ? Math.min(shaftWall.neighborFloor, lift.lowerHeight)
            : lift.lowerHeight;
        const el = createWallElement(shaftWall, bottom, lift.upperHeight);
        if (!el) continue;

        if (shaftWall.lightLevel !== undefined) {
            el.style.setProperty('--light', Math.max(0.1, shaftWall.lightLevel / 255));
        }

        // Platform faces ride the platform; the rest of the shaft is static.
        if (shaftWall.isPlatformFace) {
            mover.appendChild(el);
        } else {
            appendToSector({ sceneState: ctx.sceneState, root: ctx.fragment }, el, lift.sectorIndex);
        }
        ctx.sceneState.wallElements.push(el);
    }

    sector.appendChild(mover);
    ctx.sceneState.liftContainers.set(lift.sectorIndex, mover);
}

export function setLiftState(renderer, sectorIndex, liftState) {
    const container = renderer.sceneState.liftContainers.get(sectorIndex);
    if (container) container.dataset.state = liftState;
}
