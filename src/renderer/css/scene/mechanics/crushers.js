/**
 * Crusher rendering — scene construction and visual state updates.
 */

import { createMoverGroup } from './movers.js';

/**
 * Builds the visual representation of a crusher into the build context.
 *
 * A crusher IS a sector: its moving group is a `.mover` child of the crusher's
 * own `.sector`, holding the ceiling. Each upper face wall stays in its OWN
 * sector inside a `.mover` group there, driven in lockstep — so walls are never
 * reparented across sector boundaries and inherit their own sector's --light /
 * bbox. The groups translate down to crush, driven by --crusher-offset.
 */
export function buildCrusher(ctx, crusher) {
    const sector = ctx.sceneState.sectorContainers[crusher.sectorIndex];
    if (!sector) return;

    const mover = createMoverGroup('crusher');
    sector.appendChild(mover);

    // Move the crusher sector's ceiling into the mover.
    for (const surfaceElement of ctx.sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === crusher.sectorIndex && surfaceElement._type === 'ceiling') {
            mover.appendChild(surfaceElement);
        }
    }

    // Distribute upper face walls into per-sector `.mover` groups (own sector
    // vs each adjoining sector), all driven together by setCrusherOffset.
    const groups = [mover];
    const groupBySector = new Map([[crusher.sectorIndex, mover]]);
    for (const wallElement of ctx.sceneState.wallElements) {
        const wallData = wallElement._wall;
        if (!wallData || !wallData.isUpperWall) continue;
        if (wallData.frontSectorIndex !== crusher.sectorIndex && wallData.backSectorIndex !== crusher.sectorIndex) continue;

        const ownerIndex = wallElement._sectorIndex;
        let group = groupBySector.get(ownerIndex);
        if (group === undefined) {
            const ownerSector = ctx.sceneState.sectorContainers[ownerIndex];
            if (!ownerSector) continue;
            group = createMoverGroup('crusher');
            ownerSector.appendChild(group);
            groupBySector.set(ownerIndex, group);
            groups.push(group);
        }
        group.appendChild(wallElement);
    }

    ctx.sceneState.crusherContainers.set(crusher.sectorIndex, groups);
}

export function setCrusherOffset(renderer, sectorIndex, offset) {
    const groups = renderer.sceneState.crusherContainers.get(sectorIndex);
    if (!groups) return;
    for (const group of groups) group.style.setProperty('--crusher-offset', offset);
}
