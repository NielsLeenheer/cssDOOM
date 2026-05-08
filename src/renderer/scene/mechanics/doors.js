/**
 * Door rendering — scene construction and visual state updates.
 */

import { dom, sceneState, sceneStates } from '../../dom.js';
import { getSectorLight } from '../sectors.js';
import { createWallElement } from '../surfaces/walls.js';

/**
 * Builds the visual representation of a door in the scene. Reparents ceiling
 * surfaces and face walls into an animated panel, creates track wall elements
 * from the provided wall data, and adds them to state.wallElements.
 */
export function buildDoor(door, trackWallData) {
    const travelDistance = door.openHeight - door.closedHeight;

    const doorGroup = document.createElement('div');
    doorGroup.className = 'door';

    const doorPanel = document.createElement('div');
    doorPanel.className = 'panel';
    doorPanel.style.setProperty('--offset', `${-travelDistance}px`);
    doorGroup.appendChild(doorPanel);

    // Move ceiling surfaces into the panel — use door sector's light
    const doorLight = getSectorLight(door.sectorIndex);
    for (const surfaceElement of sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === door.sectorIndex && surfaceElement._type === 'ceiling') {
            surfaceElement.style.setProperty('--light', doorLight);
            doorPanel.appendChild(surfaceElement);
        }
    }

    // Move door face walls into the panel — each wall keeps its own sector's light
    for (const wallElement of sceneState.wallElements) {
        const wallData = wallElement._wall;
        if (!wallData || !wallData.isUpperWall) continue;
        if (wallData.frontSectorIndex !== door.sectorIndex && wallData.backSectorIndex !== door.sectorIndex) continue;
        wallElement.classList.add('unpegged');
        wallElement.style.setProperty('--light', getSectorLight(wallData.sectorIndex));
        doorPanel.appendChild(wallElement);
    }

    // Create static track side walls from game-provided wall data
    for (const wall of trackWallData) {
        const trackEl = createWallElement(wall, door.closedHeight, door.openHeight);
        if (!trackEl) continue;

        if (wall.lightLevel !== undefined) {
            trackEl.style.setProperty('--light', getSectorLight(wall.sectorIndex));
        }

        doorGroup.appendChild(trackEl);
        sceneState.wallElements.push(trackEl);
    }

    dom.scene.appendChild(doorGroup);
    sceneState.doorContainers.set(door.sectorIndex, doorGroup);
}

export function setDoorState(sectorIndex, doorState) {
    for (const sState of sceneStates) {
        const container = sState.doorContainers.get(sectorIndex);
        if (container) container.dataset.state = doorState;
    }
}
