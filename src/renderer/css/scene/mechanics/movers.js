/**
 * Shared mover-group helper.
 *
 * A mover (door / lift / crusher) animates by translating a `.mover` group that
 * lives inside a `.sector`. A mover's moving face is often a wall owned by an
 * *adjoining* sector (e.g. the upper wall that hangs down to a closed door),
 * which must ride along but stay in its own sector — so a mover can own several
 * `.mover` groups: its own, plus one inside each adjoining sector whose face
 * walls it drives. See IMPLEMENTATION-PLAN-movers.md (Phase C).
 */

import { mapData } from '../../../../shared/maps/index.js';

/**
 * Drive a mover to a state: apply to every `.mover` group tagged
 * `"${moverType}:${sectorIndex}"` (a mover owns one group per sector it spans).
 * Lifts/doors toggle `data-state` (CSS transition handles the travel); crushers
 * set the live `--crusher-offset`. One generic driver for all mover types.
 */
export function setMoverState(renderer, moverType, sectorIndex, value) {
    const groups = renderer.sceneState.moverGroups.get(`${moverType}:${sectorIndex}`);
    if (!groups) return;
    for (const group of groups) {
        if (moverType === 'crusher') group.style.setProperty('--crusher-offset', value);
        else group.dataset.state = value;
    }
}

/**
 * Travel offset (px) baked onto a mover group's `--offset`, used by the CSS
 * transform when the mover is driven to its active state. Lifts translate down
 * by their travel; doors translate up (negative). Crushers carry no static
 * offset — the driver sets `--crusher-offset` live.
 */
function moverOffset(moverType, moverSector) {
    if (moverType === 'lift') {
        const l = mapData.lifts?.find(x => x.sectorIndex === moverSector);
        return l ? l.upperHeight - l.lowerHeight : 0;
    }
    if (moverType === 'door') {
        const d = mapData.doors?.find(x => x.sectorIndex === moverSector);
        return d ? -(d.openHeight - d.closedHeight) : 0;
    }
    return 0;
}

/**
 * Get (or lazily create) the `.mover` group for a given mover, living inside
 * `ownerSectorIndex`'s `.sector`. Keyed by `"type:idx"` and deduped per owner
 * sector, so every wall/surface owned by that sector and driven by that mover
 * shares one group. Registers the group in `sceneState.moverGroups` ("type:idx"
 * → [groups]) so the driver can move every group of a mover in lockstep.
 * Returns null if the owner sector container is missing.
 */
export function getMoverGroup(ctx, ownerSectorIndex, moverType, moverSector) {
    const sector = ctx.sceneState.sectorContainers[ownerSectorIndex];
    if (!sector) return null;

    const key = `${moverType}:${moverSector}`;
    if (!sector._moverGroups) sector._moverGroups = new Map();
    const existing = sector._moverGroups.get(key);
    if (existing) return existing;

    const group = document.createElement('div');
    group.className = 'mover';
    // Split tag: `data-mover-type` drives the (exact-match) CSS transform per
    // mover kind; `data-mover-id` records the controlling sector for debugging.
    group.dataset.moverType = moverType;
    group.dataset.moverId = String(moverSector);
    if (moverType !== 'crusher') {
        group.style.setProperty('--offset', `${moverOffset(moverType, moverSector)}px`);
    }
    sector.appendChild(group);
    sector._moverGroups.set(key, group);

    if (!ctx.sceneState.moverGroups.has(key)) ctx.sceneState.moverGroups.set(key, []);
    ctx.sceneState.moverGroups.get(key).push(group);
    return group;
}

/**
 * If `sectorIndex` is a mover whose MOVING plane is `surfaceType`, return its
 * `{ moverType, moverSector }`; else null. A lift moves its floor; a door and a
 * crusher move their ceiling. Used so a mover's moving surface is built straight
 * into its mover group (born there, never reparented). The owner sector and the
 * controlling sector are the same here — a mover's own moving surface.
 */
export function movingPlaneMover(sectorIndex, surfaceType) {
    if (surfaceType === 'floor') {
        if (mapData.lifts?.some(l => l.sectorIndex === sectorIndex)) {
            return { moverType: 'lift', moverSector: sectorIndex };
        }
    } else if (surfaceType === 'ceiling') {
        if (mapData.doors?.some(d => d.sectorIndex === sectorIndex)) {
            return { moverType: 'door', moverSector: sectorIndex };
        }
        if (mapData.crushers?.some(c => c.sectorIndex === sectorIndex)) {
            return { moverType: 'crusher', moverSector: sectorIndex };
        }
    }
    return null;
}
