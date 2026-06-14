/**
 * Pure geometry helpers for a sector's horizontal footprint: its bounding
 * box and its clip-path value. Shared by:
 *   - sectors.js — sets `--min-x/--max-x/--min-y/--max-y` + `--outline` on the
 *     `.sector` container so the floor and ceiling inherit them (one bbox +
 *     one clip computed per sector, not per surface).
 *   - horizontal.js — still records the bbox as element expandos (`_minX` …)
 *     for the JS culler.
 *
 * Assumes one polygon per sector (the regenerated maps guarantee a single
 * `sectorPolygons` entry per `sectorIndex`; see GLOSSARY.md). The clip is
 * expressed in bbox-relative percentages with DOOM Y flipped, since
 * element-local Y points down.
 */

/** Axis-aligned bounding box of a boundary loop → { minX, maxX, minY, maxY }. */
export function sectorBounds(loop) {
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const v of loop) {
        if (v.x < minX) minX = v.x;
        if (v.x > maxX) maxX = v.x;
        if (v.y < minY) minY = v.y;
        if (v.y > maxY) maxY = v.y;
    }
    return { minX, maxX, minY, maxY };
}

/** True when the loop's 4 vertices are exactly the bbox corners (no clip needed). */
function isRectangular(vertices, minX, maxX, minY, maxY) {
    if (vertices.length !== 4) return false;
    for (const v of vertices) {
        const onX = v.x === minX || v.x === maxX;
        const onY = v.y === minY || v.y === maxY;
        if (!onX || !onY) return false;
    }
    return true;
}

/**
 * Clip-path value for a sector in bbox-relative percentages, or `null` when
 * the sector is a plain rectangle (no clip needed):
 *   - holed sector  → `shape(evenodd …)` over the outline + each hole loop
 *   - concave sector → `polygon(…)`
 * DOOM Y is flipped (`(maxY − y) / H`) because element-local Y points down.
 */
export function sectorClipValue(sector, { minX, maxX, minY, maxY }) {
    const w = maxX - minX, h = maxY - minY;
    if (w < 1 || h < 1) return null;
    const outer = sector.boundaries[0];

    if (sector.hasHoles && sector.boundaries.length > 1) {
        const commands = [];
        for (const loop of sector.boundaries) {
            for (let i = 0; i < loop.length; i++) {
                const px = ((loop[i].x - minX) / w) * 100;
                const py = ((maxY - loop[i].y) / h) * 100;
                commands.push(`${i === 0 ? 'move to' : 'line to'} ${px}% ${py}%`);
            }
            commands.push('close');
        }
        return `shape(evenodd from 0% 0%, ${commands.join(', ')})`;
    }

    if (!isRectangular(outer, minX, maxX, minY, maxY)) {
        const points = outer
            .map(v => `${((v.x - minX) / w) * 100}% ${((maxY - v.y) / h) * 100}%`)
            .join(', ');
        return `polygon(${points})`;
    }

    return null;
}
