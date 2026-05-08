/**
 * Lift rendering — scene construction and visual state updates.
 */

import { dom, sceneState, sceneStates } from '../../dom.js';
import { createWallElement, setContainerLight } from '../surfaces/walls.js';

/**
 * Builds the visual representation of a lift in the scene. Reparents floor
 * surfaces into the animated platform, creates shaft wall elements, and adds
 * them to state.wallElements.
 */
export function buildLift(lift) {
    const heightDelta = lift.upperHeight - lift.lowerHeight;

    const liftGroup = document.createElement('div');
    liftGroup.className = 'lift';
    setContainerLight(liftGroup, lift.sectorIndex);

    const liftPlatform = document.createElement('div');
    liftPlatform.className = 'platform';
    liftPlatform.style.setProperty('--offset', `${heightDelta}px`);
    liftGroup.appendChild(liftPlatform);

    // Move floor surfaces into the platform
    for (const surfaceElement of sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === lift.sectorIndex && surfaceElement._type === 'floor') {
            liftPlatform.appendChild(surfaceElement);
        }
    }

    // Create shaft walls
    for (const shaftWall of lift.shaftWalls) {
        const el = createWallElement(shaftWall, lift.lowerHeight, lift.upperHeight);
        if (!el) continue;

        if (shaftWall.lightLevel !== undefined) {
            el.style.setProperty('--light', Math.max(0.1, shaftWall.lightLevel / 255));
        }

        if (shaftWall.isPlatformFace) {
            liftPlatform.appendChild(el);
        } else {
            liftGroup.appendChild(el);
        }
        sceneState.wallElements.push(el);
    }

    dom.scene.appendChild(liftGroup);
    sceneState.liftContainers.set(lift.sectorIndex, liftPlatform);
}

export function setLiftState(sectorIndex, liftState) {
    for (const sState of sceneStates) {
        const container = sState.liftContainers.get(sectorIndex);
        if (container) container.dataset.state = liftState;
    }
}
