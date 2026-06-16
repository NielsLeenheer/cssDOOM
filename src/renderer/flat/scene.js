/**
 * Flat-shaded scene builder for FlatRenderer — the middle step in the
 * talk's progression visual (wireframe → flat → fully textured). Same
 * cssDOOM walls / floors / ceilings DOM as the full CSSRenderer, but
 * with every surface painted in the texture's average RGB instead of
 * the actual texture image. The colours live in texture-override.css
 * (generated; selected by the `[data-texture]` attribute every surface
 * carries) — this builder just emits the same DOM the CSSRenderer does
 * and lets CSS recolour it. No things, no doors, no lifts, no crushers,
 * no player sprite — just the room shells.
 *
 * Lighting reuses cssDOOM's existing `--light` CSS custom property
 * (set per sector container by buildSectorContainers, applied via
 * `filter: brightness(...)` in walls.css / horizontal.css)
 * — no extra work needed; the inherited CSS rules attach
 * automatically because the elements still carry their `.wall` /
 * `.floor` / `.ceiling` classes.
 */

import { makeSceneState } from '../css/renderer.js';
import { buildSectorContainers } from '../css/scene/sectors.js';
import { buildWalls } from '../css/scene/surfaces/walls.js';
import { buildFloors } from '../css/scene/surfaces/floors.js';
import { buildCeilings } from '../css/scene/surfaces/ceilings.js';
import { buildThing } from '../css/scene/entities/things.js';

export function buildFlatScene(mapData) {
    const ctx = {
        fragment: document.createDocumentFragment(),
        sceneState: makeSceneState(),
    };

    buildSectorContainers(ctx);
    buildWalls(ctx);
    buildFloors(ctx);
    buildCeilings(ctx);
    // Things (enemies, barrels, pickups, decorations). Same builder
    // the textured pane uses — we want the same DOM shape so runtime
    // dispatches (updateThingPosition, setEnemyState, collectItem,
    // …) land on the same `thingDom` entries the dom renderer would
    // see. The .pane-flat CSS in styles.css flattens the resulting
    // sprite / img children into solid-color billboarded rectangles.
    if (mapData?.things) {
        for (const thing of mapData.things) {
            if (thing.category === undefined) continue;
            buildThing(ctx, thing);
        }
    }
    // Doors / lifts / crushers have no build step — every wall (mover faces
    // included) is born in its final `.static` / `.mover` group during the
    // wall/surface build above. The mechanics' CSS rules (data-state
    // animations, `.mover` offset translations) ride on the .pane-flat clone
    // just as on the textured pane — wall-background animations are suppressed
    // by .pane.pane-flat .wall, but the `.mover` transform animations are
    // untouched, so doors still open and lifts still travel.

    // Surfaces are painted in their texture's average colour by
    // texture-override.css, keyed on the [data-texture] attribute every
    // wall / floor / ceiling carries (mover faces included — buildWalls sets
    // it on every wall). No per-element JS repaint needed.
    return { fragment: ctx.fragment, sceneState: ctx.sceneState };
}
