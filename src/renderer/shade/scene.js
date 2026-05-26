/**
 * Shade-shaded scene builder for ShadeRenderer — fourth step in the
 * talk's progression visual. Same cssDOOM walls / floors / ceilings
 * DOM as the full DomRenderer, but every wall painted pure white and
 * every floor / ceiling painted pure black. Sector lighting still
 * applies (the existing `filter: brightness(var(--light))` cascade
 * on `.wall` darkens white walls to grey-scale per sector). No
 * things, no doors that animate, no lifts, no crushers.
 *
 * Why post-process instead of forking the build pipeline? The full
 * scene builder owns all the geometry math (sector containers,
 * wall splits, floor/ceiling slicing) — duplicating any of that is
 * a maintenance trap. So we build the scene exactly like the
 * textured pane and then wipe the surface colors in a final pass.
 */

import { makeSceneState } from '../dom/renderer.js';
import { buildSectorContainers } from '../dom/scene/sectors.js';
import { buildWalls } from '../dom/scene/surfaces/walls.js';
import { buildFloors } from '../dom/scene/surfaces/floors.js';
import { buildCeilings } from '../dom/scene/surfaces/ceilings.js';
import { buildDoor } from '../dom/scene/mechanics/doors.js';
import { buildLift } from '../dom/scene/mechanics/lifts.js';
import { buildCrusher } from '../dom/scene/mechanics/crushers.js';

export async function buildShadeScene(mapData) {
    const ctx = {
        fragment: document.createDocumentFragment(),
        sceneState: makeSceneState(),
    };

    buildSectorContainers(ctx);
    buildWalls(ctx);
    buildFloors(ctx);
    buildCeilings(ctx);
    // Door / lift / crusher containers exist so the scene structure
    // matches the textured pane — but their CSS animations are
    // suppressed by .pane-shade rules so nothing visually moves.
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

    // Strip textures + force fixed colors. backgroundImage: 'none'
    // wins over cascading url() rules (e.g. NUKAGE animation
    // keyframes in floors.css) even before .pane-shade CSS overrides
    // animations, so the solid color reads through during the
    // transient frame between build and first composited paint.
    for (const el of ctx.fragment.querySelectorAll('.wall')) {
        el.style.backgroundImage = 'none';
        el.style.backgroundColor = '#fff';
    }
    for (const el of ctx.fragment.querySelectorAll('.floor')) {
        el.style.backgroundImage = 'none';
        el.style.backgroundColor = 'rgba(255, 0, 0, 0.5)';
    }

    for (const el of ctx.fragment.querySelectorAll('.ceiling')) {
        el.style.backgroundImage = 'none';
        el.style.backgroundColor = 'rgba(0, 255, 0, 0.5)';
    }

    return { fragment: ctx.fragment, sceneState: ctx.sceneState };
}
