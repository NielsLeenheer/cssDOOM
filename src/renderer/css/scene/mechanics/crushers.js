/**
 * Crusher rendering — scene construction and visual state updates.
 */

/**
 * Builds the visual representation of a crusher into the build context.
 *
 * A crusher IS a sector: its moving group is a `.mover` child of the crusher's
 * own `.sector`, holding the ceiling + upper walls, so they inherit the
 * sector's --light / bbox / --outline. The `.mover` translates down to crush,
 * driven by --crusher-offset.
 */
export function buildCrusher(ctx, crusher) {
    const sector = ctx.sceneState.sectorContainers[crusher.sectorIndex];
    if (!sector) return;

    const mover = document.createElement('div');
    mover.className = 'mover';
    mover.dataset.mover = 'crusher';

    // Move the crusher sector's ceiling into the mover.
    for (const surfaceElement of ctx.sceneState.surfaceElements) {
        if (surfaceElement._sectorIndex === crusher.sectorIndex && surfaceElement._type === 'ceiling') {
            mover.appendChild(surfaceElement);
        }
    }

    // Move upper walls into the mover.
    for (const wallElement of ctx.sceneState.wallElements) {
        const wallData = wallElement._wall;
        if (!wallData || !wallData.isUpperWall) continue;
        if (wallData.frontSectorIndex !== crusher.sectorIndex && wallData.backSectorIndex !== crusher.sectorIndex) continue;
        mover.appendChild(wallElement);
    }

    sector.appendChild(mover);
    ctx.sceneState.crusherContainers.set(crusher.sectorIndex, mover);
}

export function setCrusherOffset(renderer, sectorIndex, offset) {
    const container = renderer.sceneState.crusherContainers.get(sectorIndex);
    if (container) container.style.setProperty('--crusher-offset', offset);
}
