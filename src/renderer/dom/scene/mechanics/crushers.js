/**
 * Crusher rendering — scene construction and visual state updates.
 */

import { setContainerLight } from '../surfaces/walls.js';

/**
 * Builds the visual representation of a crusher into the build context.
 * Reparents ceiling surfaces and upper walls into a container.
 */
export function buildCrusher(ctx, crusher) {
    const container = document.createElement('div');
    container.className = 'crusher';
    setContainerLight(container, crusher.sectorIndex);

    // Move ceiling surfaces into the container
    for (const surfaceElement of ctx.sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === crusher.sectorIndex && surfaceElement._type === 'ceiling') {
            container.appendChild(surfaceElement);
        }
    }

    // Move upper walls into the container
    for (const wallElement of ctx.sceneState.wallElements) {
        const wallData = wallElement._wall;
        if (!wallData || !wallData.isUpperWall) continue;
        if (wallData.frontSectorIndex !== crusher.sectorIndex && wallData.backSectorIndex !== crusher.sectorIndex) continue;
        container.appendChild(wallElement);
    }

    ctx.fragment.appendChild(container);
    ctx.sceneState.crusherContainers.set(crusher.sectorIndex, container);
}

export function setCrusherOffset(renderer, sectorIndex, offset) {
    const container = renderer.sceneState.crusherContainers.get(sectorIndex);
    if (container) container.style.setProperty('--crusher-offset', offset);
}
