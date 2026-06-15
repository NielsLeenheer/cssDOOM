/**
 * Door rendering — scene construction and visual state updates.
 */

import { appendToSector, getSectorLight } from '../sectors.js';
import { createWallElement } from '../surfaces/walls.js';

/**
 * Builds the visual representation of a door into the build context.
 *
 * A door IS a sector: its moving group is a `.mover` child of the door's own
 * `.sector` (created by buildSectorContainers), so the ceiling + face walls
 * inherit the sector's --light / bbox / --outline with no manual re-set. The
 * `.mover` translates up to open. Static track side walls go in the sector's
 * `.static` group. See IMPLEMENTATION-PLAN-movers.md.
 */
export function buildDoor(ctx, door, trackWallData) {
    const sector = ctx.sceneState.sectorContainers[door.sectorIndex];
    if (!sector) return;

    const travelDistance = door.openHeight - door.closedHeight;

    const mover = document.createElement('div');
    mover.className = 'mover';
    mover.dataset.mover = 'door';
    mover.style.setProperty('--offset', `${-travelDistance}px`);

    // Move the door sector's ceiling into the mover (inherits the sector light).
    for (const surfaceElement of ctx.sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === door.sectorIndex && surfaceElement._type === 'ceiling') {
            mover.appendChild(surfaceElement);
        }
    }

    // Move door face walls into the mover. A face wall owned by an adjoining
    // sector still carries that sector's light explicitly here; Phase 3 will
    // relocate such walls into their own sector's mover group.
    for (const wallElement of ctx.sceneState.wallElements) {
        const wallData = wallElement._wall;
        if (!wallData || !wallData.isUpperWall) continue;
        if (wallData.frontSectorIndex !== door.sectorIndex && wallData.backSectorIndex !== door.sectorIndex) continue;
        wallElement.classList.add('unpegged');
        wallElement.style.setProperty('--light', getSectorLight(wallData.sectorIndex));
        mover.appendChild(wallElement);
    }

    sector.appendChild(mover);

    // Create static track side walls from game-provided wall data — they don't
    // move, so they live in the door sector's static group.
    for (const wall of trackWallData) {
        const trackEl = createWallElement(wall, door.closedHeight, door.openHeight);
        if (!trackEl) continue;

        if (wall.lightLevel !== undefined) {
            trackEl.style.setProperty('--light', getSectorLight(wall.sectorIndex));
        }

        appendToSector({ sceneState: ctx.sceneState, root: ctx.fragment }, trackEl, door.sectorIndex);
        ctx.sceneState.wallElements.push(trackEl);
    }

    ctx.sceneState.doorContainers.set(door.sectorIndex, mover);
}

export function setDoorState(renderer, sectorIndex, doorState) {
    const container = renderer.sceneState.doorContainers.get(sectorIndex);
    if (container) container.dataset.state = doorState;
}
