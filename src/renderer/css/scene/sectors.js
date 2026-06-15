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

import { LIGHT_MINIMUM_BRIGHTNESS, DOOM_LIGHT_MAX, LIGHT_DISTANCE_OFFSET, KIOSK_LIGHT_BOOST } from './constants.js';
import { mapData } from '../../../shared/maps/index.js';
import { sectorBounds, sectorClipValue } from './surfaces/clip.js';

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
 *
 * `boost` scales the final value (kiosk-mode ambient compensation, default 1).
 */
function doomLightToCSS(lightLevel, boost = 1) {
    const startmap = (15 - lightLevel / 16) * 4 - LIGHT_DISTANCE_OFFSET;
    const colormap = Math.max(0, Math.min(31, startmap));
    return Math.max(LIGHT_MINIMUM_BRIGHTNESS, 1 - colormap / 32) * boost;
}

/**
 * Build sector containers into the given build context. Reads
 * `mapData.sectors`, creates one `.sector` div per sector, appends it to
 * `ctx.fragment`, and pushes it into `ctx.sceneState.sectorContainers`.
 *
 * The container also carries the sector's horizontal footprint —
 * `--min-x/--max-x/--min-y/--max-y` (bounding box) and `--outline` (clip
 * path) — so its floor and ceiling inherit them instead of each computing
 * and storing its own copy. Assumes one `sectorPolygons` entry per sector
 * (guaranteed by the regenerated maps; see GLOSSARY.md).
 */
export function buildSectorContainers(ctx) {
    const sectors = mapData.sectors;
    if (!sectors) return;

    // Layout is fixed at boot, so read the kiosk flag once for the whole build.
    const lightBoost = document.body.dataset.layout === 'kiosk' ? KIOSK_LIGHT_BOOST : 1;

    // One polygon per sector index — pick the first if (legacy) duplicates exist.
    const polyByIndex = new Map();
    for (const poly of mapData.sectorPolygons || []) {
        if (!polyByIndex.has(poly.sectorIndex)) polyByIndex.set(poly.sectorIndex, poly);
    }

    for (let i = 0; i < sectors.length; i++) {
        const sector = sectors[i];
        const container = document.createElement('div');
        container.className = 'sector';
        container.id = `s${i}`;

        // Non-moving geometry + things live in a `.static` child; movers add
        // `.mover` siblings beside it (see IMPLEMENTATION-PLAN-movers.md). The
        // sector keeps carrying --light / bbox / --outline, inherited by both
        // groups. `_staticGroup` is the default append target for the sector.
        const staticGroup = document.createElement('div');
        staticGroup.className = 'static';
        container.appendChild(staticGroup);
        container._staticGroup = staticGroup;

        container.style.setProperty('--light',
            doomLightToCSS(sector.lightLevel, lightBoost));

        if (sector.specialType) {
            applyLightEffect(container, sector.specialType);
        }

        // Footprint inherited by this sector's floor + ceiling.
        const poly = polyByIndex.get(i);
        const outer = poly?.boundaries?.[0];
        if (outer && outer.length >= 3) {
            const b = sectorBounds(outer);
            if (b.maxX - b.minX >= 1 && b.maxY - b.minY >= 1) {
                container.style.setProperty('--min-x', b.minX);
                container.style.setProperty('--max-x', b.maxX);
                container.style.setProperty('--min-y', b.minY);
                container.style.setProperty('--max-y', b.maxY);
                const clip = sectorClipValue(poly, b);
                if (clip) container.style.setProperty('--outline', clip);
            }
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
    const target = sectorContentTarget(scope.sceneState, sectorIndex);
    if (target) {
        target.appendChild(element);
    } else {
        scope.root.appendChild(element);
    }
}

/**
 * Resolve where a sector's children should be appended: its `.static` group
 * (falls back to the `.sector` container itself if, for any reason, the group
 * is missing). Returns null when `sectorIndex` is undefined / out of range so
 * callers can route to a scene-root fallback. Shared by build-time
 * (`appendToSector`) and runtime (sprite placement / reparenting) so both
 * agree on the target.
 */
export function sectorContentTarget(sceneState, sectorIndex) {
    if (sectorIndex === undefined || sectorIndex === null) return null;
    const sector = sceneState.sectorContainers[sectorIndex];
    if (!sector) return null;
    return sector._staticGroup || sector;
}
