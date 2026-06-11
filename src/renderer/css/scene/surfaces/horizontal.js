/**
 * Shared helper for building horizontal (floor/ceiling) surface elements.
 *
 * Surfaces are divs sized to the sector's bounding box, rotated into the
 * horizontal plane via rotateX(90deg) in the stylesheet. Their shapes are
 * clipped to match sector polygons using CSS clip-path.
 */

import { NO_TEXTURE, SKY_TEXTURE } from '../constants.js';

import { appendToSector } from '../sectors.js';

/**
 * Checks if a polygon's vertices exactly match its bounding box corners,
 * meaning the polygon is a rectangle and no clip-path is needed.
 */
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
 * Builds a horizontal floor or ceiling surface for a sector.
 *
 * The sector's polygon shape is applied via CSS clip-path:
 * - Simple sectors use polygon() with percentage-based vertex coordinates.
 * - Sectors with holes use shape() with the evenodd fill rule.
 * - Rectangular sectors need no clip-path.
 */
export function buildHorizontalSurface(ctx, sector, height, textureName, surfaceType) {
    const outerBoundary = sector.boundaries[0];
    if (!outerBoundary || outerBoundary.length < 3) return;

    // Compute bounding box of the outer boundary polygon
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const vertex of outerBoundary) {
        if (vertex.x < minX) minX = vertex.x;
        if (vertex.x > maxX) maxX = vertex.x;
        if (vertex.y < minY) minY = vertex.y;
        if (vertex.y > maxY) maxY = vertex.y;
    }

    const boundingBoxWidth = maxX - minX;
    const boundingBoxHeight = maxY - minY;
    if (boundingBoxWidth < 1 || boundingBoxHeight < 1) return;

    const surfaceElement = document.createElement('div');
    surfaceElement.className = surfaceType;

    // Pass raw DOOM bounding box — CSS computes width, height, and position
    surfaceElement.style.setProperty('--min-x', minX);
    surfaceElement.style.setProperty('--max-x', maxX);
    surfaceElement.style.setProperty('--min-y', minY);
    surfaceElement.style.setProperty('--max-y', maxY);
    surfaceElement.style.setProperty(surfaceType === 'floor' ? '--floor-z' : '--ceiling-z', height);

    /**
     * Clip-path for non-rectangular sector shapes:
     *
     * For sectors with holes (hasHoles=true, multiple boundaries), we use
     * CSS shape() with the evenodd fill rule. The outer boundary is traced
     * as one subpath and each hole as another subpath. The evenodd rule
     * means areas enclosed an odd number of times are filled (the main
     * floor) and areas enclosed an even number of times are transparent
     * (the holes where pillars or inner sectors exist).
     *
     * Simple non-rectangular sectors use polygon() with percentage coordinates.
     *
     * Rectangular sectors need no clip-path — the div is already the right shape.
     *
     * In both cases, DOOM Y is flipped (maxY - vertex.y) because DOOM Y
     * increases northward but CSS Y increases downward within the element.
     */
    if (sector.hasHoles && sector.boundaries.length > 1) {
        const commands = [];
        for (const loop of sector.boundaries) {
            for (let i = 0; i < loop.length; i++) {
                const percentX = ((loop[i].x - minX) / boundingBoxWidth) * 100;
                const percentY = ((maxY - loop[i].y) / boundingBoxHeight) * 100;
                commands.push(`${i === 0 ? 'move to' : 'line to'} ${percentX}% ${percentY}%`);
            }
            commands.push('close');
        }
        surfaceElement.style.clipPath = `shape(evenodd from 0% 0%, ${commands.join(', ')})`;
    } else if (!isRectangular(outerBoundary, minX, maxX, minY, maxY)) {
        const clipPoints = outerBoundary.map(vertex => {
            const percentX = ((vertex.x - minX) / boundingBoxWidth) * 100;
            const percentY = ((maxY - vertex.y) / boundingBoxHeight) * 100;
            return `${percentX}% ${percentY}%`;
        }).join(', ');
        surfaceElement.style.clipPath = `polygon(${clipPoints})`;
    }

    /**
     * Texture positioning:
     * background-position is set to world-space coordinates (-minX, maxY) so
     * that the 64x64 flat textures tile seamlessly across adjacent sectors.
     */
    if (textureName && textureName !== NO_TEXTURE && textureName !== SKY_TEXTURE) {
        // background-image comes from textures.css via [data-texture]
        surfaceElement.dataset.texture = textureName;
    } else if (textureName === SKY_TEXTURE) {
        surfaceElement.style.backgroundColor = '#1a1a3a';
    } else {
        surfaceElement.style.backgroundColor = surfaceType === 'floor' ? '#444' : '#333';
    }

    const centerX = (minX + maxX) / 2;
    const centerY = (minY + maxY) / 2;
    surfaceElement._midX = centerX;
    surfaceElement._midY = centerY;
    surfaceElement._sectorIndex = sector.sectorIndex;
    if (surfaceType === 'floor') surfaceElement.dataset.sector = sector.sectorIndex;
    surfaceElement._type = surfaceType;
    surfaceElement._height = height;
    surfaceElement._minX = minX;
    surfaceElement._maxX = maxX;
    surfaceElement._minY = minY;
    surfaceElement._maxY = maxY;
    surfaceElement._bboxH = boundingBoxHeight;

    surfaceElement.hidden = true;
    appendToSector({ sceneState: ctx.sceneState, root: ctx.fragment }, surfaceElement, sector.sectorIndex);
    ctx.sceneState.surfaceElements.push(surfaceElement);
}
