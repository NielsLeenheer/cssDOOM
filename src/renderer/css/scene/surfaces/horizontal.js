/**
 * Shared helper for building horizontal (floor/ceiling) surface elements.
 *
 * Surfaces are divs rotated into the horizontal plane via rotateX(90deg) in
 * the stylesheet. Their size, position, texture origin, and clip shape all
 * come from the parent `.sector` container by inheritance — sectors.js sets
 * `--min-x/--max-x/--min-y/--max-y` and `--outline` once per sector (one bbox +
 * one clip, instead of duplicating them on every floor and ceiling). This
 * builder only sets the surface's own height channel, texture, and the bbox
 * expandos the JS culler reads.
 */

import { NO_TEXTURE, SKY_TEXTURE } from '../constants.js';

import { appendToSector } from '../sectors.js';
import { sectorBounds } from './clip.js';

/**
 * Builds a horizontal floor or ceiling surface for a sector. Size + position
 * + clip are inherited from the parent `.sector` (see sectors.js); this sets
 * only `--floor-z`/`--ceiling-z`, the texture, and the culler expandos.
 */
export function buildHorizontalSurface(ctx, sector, height, textureName, surfaceType) {
    const outerBoundary = sector.boundaries[0];
    if (!outerBoundary || outerBoundary.length < 3) return;

    const { minX, maxX, minY, maxY } = sectorBounds(outerBoundary);
    const boundingBoxWidth = maxX - minX;
    const boundingBoxHeight = maxY - minY;
    if (boundingBoxWidth < 1 || boundingBoxHeight < 1) return;

    const surfaceElement = document.createElement('div');
    surfaceElement.className = surfaceType;

    // Only the height channel is per-surface; bbox + clip are inherited from
    // the `.sector` container (set in sectors.js).
    surfaceElement.style.setProperty(surfaceType === 'floor' ? '--floor-z' : '--ceiling-z', height);

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

