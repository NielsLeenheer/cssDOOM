/**
 * Door rendering — scene construction and visual state updates.
 */

import { getSectorLight } from '../sectors.js';
import { createWallElement } from '../surfaces/walls.js';

/**
 * Builds the visual representation of a door into the build context.
 * Reparents ceiling surfaces and face walls into an animated panel,
 * creates track wall elements from the provided wall data, and adds them
 * to the scene state's wallElements.
 */
export function buildDoor(ctx, door, trackWallData) {
    const travelDistance = door.openHeight - door.closedHeight;

    const doorGroup = document.createElement('div');
    doorGroup.className = 'door';

    const doorPanel = document.createElement('div');
    doorPanel.className = 'panel';
    doorPanel.style.setProperty('--offset', `${-travelDistance}px`);
    doorGroup.appendChild(doorPanel);

    // Move ceiling surfaces into the panel — use door sector's light
    const doorLight = getSectorLight(door.sectorIndex);
    for (const surfaceElement of ctx.sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === door.sectorIndex && surfaceElement._type === 'ceiling') {
            surfaceElement.style.setProperty('--light', doorLight);
            doorPanel.appendChild(surfaceElement);
        }
    }

    // Move door face walls into the panel — each wall keeps its own sector's light
    for (const wallElement of ctx.sceneState.wallElements) {
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
        ctx.sceneState.wallElements.push(trackEl);
    }

    ctx.fragment.appendChild(doorGroup);
    ctx.sceneState.doorContainers.set(door.sectorIndex, doorGroup);
}

export function setDoorState(renderer, sectorIndex, doorState) {
    const container = renderer.sceneState.doorContainers.get(sectorIndex);
    if (container) container.dataset.state = doorState;
}
