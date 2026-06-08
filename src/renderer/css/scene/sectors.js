/**
 * Sector containers and light effects.
 *
 * Each sector gets a container div that groups all geometry (walls, floors,
 * ceilings, things) belonging to that sector. The CSS custom property --light
 * is set once on the container and inherited by all children.
 *
 * Per Phase B of the renderer refactor (see RENDERER_REFACTOR.md), the
 * build helpers here take a `ctx = { fragment, sceneState }` and operate
 * purely against it — the resulting fragment + sceneState are handed back
 * to a renderer in one shot by `buildScene`. `appendToSector` keeps the
 * same shape: callers pass a "scope" with `{ sceneState, root }` where
 * `root` is wherever non-sectored elements should go (the fragment during
 * build, a renderer's `.sceneEl` afterward).
 */

import { LIGHT_MINIMUM_BRIGHTNESS, DOOM_LIGHT_MAX, LIGHT_DISTANCE_OFFSET } from './constants.js';
import { mapData } from '../../../shared/maps/index.js';

/**
 * Maps DOOM sector special types to CSS animation classes for dynamic lighting effects.
 * These classes trigger flickering, glowing, or blinking animations in the stylesheet.
 */
const LIGHT_EFFECT_CLASS = {
    1: 'light-flicker',       // blink random
    2: 'light-blink-fast',    // blink 0.5s
    3: 'light-blink',         // blink 1.0s
    8: 'light-glow',          // oscillate
    12: 'light-blink-fast',   // blink 0.5s sync
    13: 'light-blink',        // blink 1.0s sync
    17: 'light-fire-flicker', // fire flicker
};

function applyLightEffect(element, specialType) {
    const className = LIGHT_EFFECT_CLASS[specialType];
    if (!className) return;
    element.classList.add(className);
}

/**
 * Converts a DOOM sector light level (0–255) to a CSS --light value (0–1).
 * Based on DOOM's R_InitLightTables: lightnum = lightLevel/16 selects from
 * 32 colormaps. LIGHT_DISTANCE_OFFSET compensates for DOOM's scalelight
 * close-range brightening effect.
 */
function doomLightToCSS(lightLevel) {
    const startmap = (15 - lightLevel / 16) * 4 - LIGHT_DISTANCE_OFFSET;
    const colormap = Math.max(0, Math.min(31, startmap));
    return Math.max(LIGHT_MINIMUM_BRIGHTNESS, 1 - colormap / 32);
}

/**
 * Build sector containers into the given build context. Reads
 * `mapData.sectors`, creates one `.sector` div per sector, appends it to
 * `ctx.fragment`, and pushes it into `ctx.sceneState.sectorContainers`.
 */
export function buildSectorContainers(ctx) {
    const sectors = mapData.sectors;
    if (!sectors) return;

    for (let i = 0; i < sectors.length; i++) {
        const sector = sectors[i];
        const container = document.createElement('div');
        container.className = 'sector';
        container.id = `s${i}`;

        container.style.setProperty('--light',
            doomLightToCSS(sector.lightLevel));

        if (sector.specialType) {
            applyLightEffect(container, sector.specialType);
        }

        ctx.fragment.appendChild(container);
        ctx.sceneState.sectorContainers.push(container);
    }
}

/** Converts a DOOM sector's light level to a CSS --light value (0–1). */
export function getSectorLight(sectorIndex) {
    const sectorData = mapData.sectors?.[sectorIndex];
    if (!sectorData) return 1;
    return doomLightToCSS(sectorData.lightLevel);
}

/**
 * Append `element` to the scope's sector container (or to its root if
 * `sectorIndex` is undefined / out of range).
 *
 * `scope` shape: `{ sceneState, root }`. During scene-building, root is
 * the DocumentFragment being assembled; after-the-fact callers (still-
 * legacy world commands) pass `{ sceneState: renderer.sceneState, root:
 * renderer.sceneEl }`. A build context also conforms — its `fragment` is
 * the root — but pass it as `{ sceneState: ctx.sceneState, root: ctx.fragment }`
 * for clarity.
 */
export function appendToSector(scope, element, sectorIndex) {
    if (sectorIndex !== undefined && scope.sceneState.sectorContainers[sectorIndex]) {
        scope.sceneState.sectorContainers[sectorIndex].appendChild(element);
    } else {
        scope.root.appendChild(element);
    }
}
