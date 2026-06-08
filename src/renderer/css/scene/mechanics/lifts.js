/**
 * Lift rendering — scene construction and visual state updates.
 */

import { createWallElement, setContainerLight } from '../surfaces/walls.js';

/**
 * Builds the visual representation of a lift into the build context.
 * Reparents floor surfaces into the animated platform, creates shaft wall
 * elements, and adds them to the scene state's wallElements.
 */
export function buildLift(ctx, lift) {
    const heightDelta = lift.upperHeight - lift.lowerHeight;

    const liftGroup = document.createElement('div');
    liftGroup.className = 'lift';
    setContainerLight(liftGroup, lift.sectorIndex);

    const liftPlatform = document.createElement('div');
    liftPlatform.className = 'platform';
    liftPlatform.style.setProperty('--offset', `${heightDelta}px`);
    liftGroup.appendChild(liftPlatform);

    // Move floor surfaces into the platform
    for (const surfaceElement of ctx.sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === lift.sectorIndex && surfaceElement._type === 'floor') {
            liftPlatform.appendChild(surfaceElement);
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

        if (shaftWall.isPlatformFace) {
            liftPlatform.appendChild(el);
        } else {
            liftGroup.appendChild(el);
        }
        ctx.sceneState.wallElements.push(el);
    }

    ctx.fragment.appendChild(liftGroup);
    ctx.sceneState.liftContainers.set(lift.sectorIndex, liftPlatform);
}

export function setLiftState(renderer, sectorIndex, liftState) {
    const container = renderer.sceneState.liftContainers.get(sectorIndex);
    if (container) container.dataset.state = liftState;
}
