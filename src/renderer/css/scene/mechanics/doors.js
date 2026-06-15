/**
 * Door rendering — scene construction and visual state updates.
 */

import { appendToSector, getSectorLight } from '../sectors.js';
import { createWallElement } from '../surfaces/walls.js';
import { createMoverGroup } from './movers.js';

/**
 * Builds the visual representation of a door into the build context.
 *
 * A door IS a sector: its moving group is a `.mover` child of the door's own
 * `.sector`, holding the ceiling. Each door face wall stays in its OWN sector,
 * inside a `.mover` group there driven in lockstep — so walls are never
 * reparented across sector boundaries and inherit their own sector's --light /
 * bbox. The `.mover` groups translate up to open. Static track side walls go in
 * the door sector's `.static` group. See IMPLEMENTATION-PLAN-movers.md.
 */
export function buildDoor(ctx, door, trackWallData) {
    const sector = ctx.sceneState.sectorContainers[door.sectorIndex];
    if (!sector) return;

    const travelDistance = door.openHeight - door.closedHeight;
    const offset = `${-travelDistance}px`;

    const mover = createMoverGroup('door');
    mover.style.setProperty('--offset', offset);
    sector.appendChild(mover);

    // Move the door sector's ceiling into the mover (inherits the sector light).
    for (const surfaceElement of ctx.sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === door.sectorIndex && surfaceElement._type === 'ceiling') {
            mover.appendChild(surfaceElement);
        }
    }

    // Distribute the door face walls (upper walls touching the door sector)
    // into per-sector `.mover` groups: a wall owned by the door sector rides
    // the door's own mover; a wall owned by an adjoining sector rides a `.mover`
    // created inside THAT sector. All groups carry this door's --offset and are
    // driven together by setDoorState.
    const groups = [mover];
    const groupBySector = new Map([[door.sectorIndex, mover]]);
    for (const wallElement of ctx.sceneState.wallElements) {
        const wallData = wallElement._wall;
        if (!wallData || !wallData.isUpperWall) continue;
        if (wallData.frontSectorIndex !== door.sectorIndex && wallData.backSectorIndex !== door.sectorIndex) continue;

        const ownerIndex = wallElement._sectorIndex;
        let group = groupBySector.get(ownerIndex);
        if (group === undefined) {
            const ownerSector = ctx.sceneState.sectorContainers[ownerIndex];
            if (!ownerSector) continue;
            group = createMoverGroup('door');
            group.style.setProperty('--offset', offset);
            ownerSector.appendChild(group);
            groupBySector.set(ownerIndex, group);
            groups.push(group);
        }
        wallElement.classList.add('unpegged');
        group.appendChild(wallElement);
    }

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

    ctx.sceneState.doorContainers.set(door.sectorIndex, groups);
}

export function setDoorState(renderer, sectorIndex, doorState) {
    const groups = renderer.sceneState.doorContainers.get(sectorIndex);
    if (!groups) return;
    for (const group of groups) group.dataset.state = doorState;
}
