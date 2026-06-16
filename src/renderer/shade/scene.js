/**
 * Shade-shaded scene builder for ShadeRenderer — fourth step in the
 * talk's progression visual. Same cssDOOM walls / floors / ceilings
 * DOM as the full CSSRenderer; the surface colours (white walls, green
 * floors, blue ceilings) are applied by shade/styles.css, keyed on the
 * .wall / .floor / .ceiling classes. Sector lighting still applies (the
 * existing `filter: brightness(var(--light))` cascade on `.wall`
 * darkens white walls to grey-scale per sector). No things, no doors
 * that animate, no lifts, no crushers.
 *
 * We build the scene exactly like the textured pane — the full builder
 * owns all the geometry math (sector containers, wall splits,
 * floor/ceiling slicing) and duplicating it would be a maintenance
 * trap — then let CSS recolour it. No per-element JS pass needed.
 */

import { makeSceneState } from '../css/renderer.js';
import { buildSectorContainers } from '../css/scene/sectors.js';
import { buildWalls } from '../css/scene/surfaces/walls.js';
import { buildFloors } from '../css/scene/surfaces/floors.js';
import { buildCeilings } from '../css/scene/surfaces/ceilings.js';

export function buildShadeScene(mapData) {
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
    // Doors / lifts / crushers have no build step — their geometry self-routes
    // into the correct `.static` / `.mover` group during the wall/surface build
    // above (Phase C).

    // Surface colours (white walls, green floors, blue ceilings) and
    // texture suppression are handled by shade/styles.css — no
    // per-element JS pass needed.
    return { fragment: ctx.fragment, sceneState: ctx.sceneState };
}
