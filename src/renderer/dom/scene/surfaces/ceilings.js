/**
 * Ceiling surface construction.
 */

import { SKY_TEXTURE } from '../constants.js';

import { mapData } from '../../../../shared/maps/index.js';
import { buildHorizontalSurface } from './horizontal.js';

export function buildCeilings(ctx) {
    if (!mapData.sectorPolygons) return;

    for (const sector of mapData.sectorPolygons) {
        if (sector.ceilingTexture && sector.ceilingTexture !== SKY_TEXTURE) {
            buildHorizontalSurface(ctx, sector, sector.ceilingHeight, sector.ceilingTexture, 'ceiling');
        }
    }
}
