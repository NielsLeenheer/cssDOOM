/**
 * Crusher rendering — scene construction and visual state updates.
 */

import { dom, sceneState, sceneStates } from '../../dom.js';
import { setContainerLight } from '../surfaces/walls.js';

/**
 * Builds the visual representation of a crusher in the scene. Reparents
 * ceiling surfaces and upper walls into a container.
 */
export function buildCrusher(crusher) {
    const container = document.createElement('div');
    container.className = 'crusher';
    setContainerLight(container, crusher.sectorIndex);

    // Move ceiling surfaces into the container
    for (const surfaceElement of sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === crusher.sectorIndex && surfaceElement._type === 'ceiling') {
            container.appendChild(surfaceElement);
        }
    }

    // Move upper walls into the container
    for (const wallElement of sceneState.wallElements) {
        const wallData = wallElement._wall;
        if (!wallData || !wallData.isUpperWall) continue;
        if (wallData.frontSectorIndex !== crusher.sectorIndex && wallData.backSectorIndex !== crusher.sectorIndex) continue;
        container.appendChild(wallElement);
    }

    dom.scene.appendChild(container);
    sceneState.crusherContainers.set(crusher.sectorIndex, container);
}

export function setCrusherOffset(sectorIndex, offset) {
    for (const sState of sceneStates) {
        const container = sState.crusherContainers.get(sectorIndex);
        if (container) container.style.setProperty('--crusher-offset', offset);
    }
}
