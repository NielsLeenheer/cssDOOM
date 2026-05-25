/**
 * Flat-shaded scene builder for FlatRenderer — the middle step in the
 * talk's progression visual (wireframe → flat → fully textured). Same
 * cssDOOM walls / floors / ceilings DOM as the full DomRenderer, but
 * with every surface painted in the texture's average RGB (precomputed
 * by `scripts/precompute-flat-colors.js`) instead of the actual
 * texture image. No things, no doors, no lifts, no crushers, no
 * player sprite — just the room shells.
 *
 * Lighting reuses cssDOOM's existing `--light` CSS custom property
 * (set per sector container by buildSectorContainers, applied via
 * `filter: brightness(...)` in walls.css / floors.css / ceilings.css)
 * — no extra work needed; the inherited CSS rules attach
 * automatically because the elements still carry their `.wall` /
 * `.floor` / `.ceiling` classes.
 */

import { makeSceneState } from '../dom/dom-renderer.js';
import { buildSectorContainers } from '../dom/scene/sectors.js';
import { buildWalls } from '../dom/scene/surfaces/walls.js';
import { buildFloors } from '../dom/scene/surfaces/floors.js';
import { buildCeilings } from '../dom/scene/surfaces/ceilings.js';
import { buildDoor } from '../dom/scene/mechanics/doors.js';
import { buildLift } from '../dom/scene/mechanics/lifts.js';
import { buildCrusher } from '../dom/scene/mechanics/crushers.js';

let _colors = null;
async function loadColors() {
    if (_colors) return _colors;
    const response = await fetch('/assets/flat-colors.json');
    _colors = await response.json();
    return _colors;
}

export async function buildFlatScene(mapData) {
    const colors = await loadColors();
    const ctx = {
        fragment: document.createDocumentFragment(),
        sceneState: makeSceneState(),
    };

    buildSectorContainers(ctx);
    buildWalls(ctx);
    buildFloors(ctx);
    buildCeilings(ctx);
    // Doors / lifts / crushers re-parent existing wall+ceiling/floor
    // elements into mechanic containers AND create new track / shaft
    // walls via createWallElement. The mechanics' CSS rules
    // (data-state animations, lift offset translations) ride on the
    // .pane-flat clone just as on the textured pane — animations on
    // wall background are suppressed by .pane.pane-flat .wall, but
    // the transform animations on .door > .panel / .lift > .platform
    // are untouched, so doors still open and lifts still travel.
    if (mapData?.doors) {
        for (const door of mapData.doors) buildDoor(ctx, door, door.trackWalls || []);
    }
    if (mapData?.lifts) {
        for (const lift of mapData.lifts) {
            if (lift.upperHeight - lift.lowerHeight > 0) buildLift(ctx, lift);
        }
    }
    if (mapData?.crushers) {
        for (const crusher of mapData.crushers) {
            if (crusher.topHeight - crusher.crushHeight > 0) buildCrusher(ctx, crusher);
        }
    }

    // Repaint every surface from texture image → flat color. Walls
    // built by buildWalls and floors/ceilings built by
    // buildHorizontalSurface carry `dataset.texture`; walls built by
    // createWallElement (door / lift / crusher track walls) don't,
    // but they do stash the source wall data as `el._wall`. Fall
    // back to that so door jambs render with the right flat color.
    // Setting backgroundImage to 'none' wins over any cascading
    // url() rule (e.g. animated NUKAGE keyframes in floors.css).
    for (const el of ctx.fragment.querySelectorAll('.wall, .floor, .ceiling')) {
        const tex = el.dataset.texture || el._wall?.texture;
        const color = tex && colors[tex];
        if (!color) continue;
        el.style.backgroundImage = 'none';
        el.style.backgroundColor = color;
    }

    return { fragment: ctx.fragment, sceneState: ctx.sceneState };
}
