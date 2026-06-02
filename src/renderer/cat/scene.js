/**
 * Cat-shaded scene builder. Same skeleton as the flat scene
 * (sectors + walls + floors + ceilings + mechanic containers),
 * but every wall's background is swapped from a flat color to a
 * random pick from a pool of 10 cat photos. Floors and ceilings
 * keep the flat-color treatment so the room shape is still
 * legible while the walls turn into a feline blast.
 *
 * Cat source: cataas.com. The 10 URLs each carry a unique `i`
 * query parameter so the browser caches them as distinct
 * resources (without it, every request hits the same cache key
 * and you get one cat repeated). After first load the browser's
 * HTTP cache holds them, so subsequent recordings reuse the same
 * cats.
 */

import { makeSceneState } from '../dom/renderer.js';
import { buildSectorContainers } from '../dom/scene/sectors.js';
import { buildWalls } from '../dom/scene/surfaces/walls.js';
import { buildFloors } from '../dom/scene/surfaces/floors.js';
import { buildCeilings } from '../dom/scene/surfaces/ceilings.js';
import { buildDoor } from '../dom/scene/mechanics/doors.js';
import { buildLift } from '../dom/scene/mechanics/lifts.js';
import { buildCrusher } from '../dom/scene/mechanics/crushers.js';

const CAT_URLS = Array.from(
    { length: 10 },
    (_, i) => `https://cataas.com/cat?width=256&height=256&i=${i + 1}`,
);

export function buildCatScene(mapData) {
    const ctx = {
        fragment: document.createDocumentFragment(),
        sceneState: makeSceneState(),
    };

    buildSectorContainers(ctx);
    buildWalls(ctx);
    buildFloors(ctx);
    buildCeilings(ctx);
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

    // Walls — random cat per surface. setProperty with 'important'
    // so this beats the catch-all `background-image: none !important`
    // the .pane-cat CSS uses to suppress NUKAGE / scrolling-wall
    // keyframes (those animations would otherwise re-impose their
    // texture url via @keyframes and erase the cat).
    for (const el of ctx.fragment.querySelectorAll('.wall,.ceiling,.floor')) {
        const cat = CAT_URLS[Math.floor(Math.random() * CAT_URLS.length)];
        el.style.setProperty('background-image', `url('${cat}')`, 'important');
        el.style.backgroundSize = 'cover';
        el.style.backgroundRepeat = 'no-repeat';
        el.style.backgroundPosition = 'center';
    }

    // Floors + ceilings keep the flat-color treatment — solid texture
    // colours so the room shape reads cleanly without competing with the
    // wall cats. Applied by texture-override.css via [data-texture]
    // (image suppressed by cat/styles.css); no per-element JS repaint.
    return { fragment: ctx.fragment, sceneState: ctx.sceneState };
}
