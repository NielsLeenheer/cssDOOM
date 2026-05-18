/**
 * RendererState — LEGACY shared singleton.
 *
 * **Transitional, to be removed.** See
 * docs/RENDERER_STATE_REFACTOR.md for the staged plan. This module
 * is kept alive in step 1 only because `src/audio/audio.js` still
 * reads `rendererState.cameras[slot]` out of band. It dies in step
 * 2, when AudioRenderer becomes a proper orchestrator target
 * (ARCHITECTURE_DEBT.md issue 8) and maintains its own per-instance
 * state.
 *
 * DomRenderer reads have moved to per-instance `renderer.state`
 * (set up in `dom-renderer.js`'s constructor); the impls in
 * `scene/camera.js` and `scene/entities/sprites.js` write to both
 * per-instance state AND this singleton (via the mirror callbacks
 * fired by the orchestrator dispatch) during the transition. The
 * singleton's only remaining reader is the audio module.
 *
 * --- (Original docstring kept for context until removal:) ---
 *
 * `cameras[slot]` and `things[index]` are independently-allocated
 * objects populated by the `mirror` callbacks declared on entries in
 * [commands.js](commands.js). The orchestrator's per-pane / world
 * dispatch loops fire the mirrors before fanning to render targets,
 * so the population mechanism is identical on master and joiner.
 *
 *   cameras[slot]: { x, y, z, angle, floorHeight, isFiring }
 *   things[index]: { x, y, floorHeight, collected }
 */

export const rendererState = {
    cameras: [],
    things: [],
};

function makeCamera() {
    return { x: 0, y: 0, z: 0, angle: 0, floorHeight: 0, isFiring: false };
}

function ensureCamera(slot) {
    let cam = rendererState.cameras[slot];
    if (!cam) {
        cam = makeCamera();
        rendererState.cameras[slot] = cam;
    }
    return cam;
}

function makeThing() {
    return { x: 0, y: 0, floorHeight: 0, collected: false };
}

/**
 * Apply an inbound camera update on a client. Mirrors the fields
 * the renderer's camera transform reads (`x/y/z/angle/floorHeight`)
 * plus `isFiring` for the spectator-marker firing class. Lazily extends
 * the cameras array so the very first update for a new slot still lands.
 */
export function applyCameraUpdate(slot, payload) {
    if (!payload) return;
    const cam = ensureCamera(slot);
    cam.x = payload.x;
    cam.y = payload.y;
    cam.z = payload.z;
    cam.angle = payload.angle;
    cam.floorHeight = payload.floorHeight ?? cam.floorHeight;
    cam.isFiring = payload.isFiring ?? false;
}

/**
 * Apply an inbound thing update on a client. Extends the things
 * array lazily so out-of-order arrivals (or thingIndex gaps) don't
 * lose the update.
 */
export function applyThingPositionUpdate(thingIndex, x, y, floorHeight) {
    const thing = ensureThing(thingIndex);
    thing.x = x;
    thing.y = y;
    if (floorHeight !== undefined) thing.floorHeight = floorHeight;
}

export function applyThingCollected(thingIndex, collected) {
    const thing = ensureThing(thingIndex);
    thing.collected = collected;
}

function ensureThing(thingIndex) {
    let thing = rendererState.things[thingIndex];
    if (!thing) {
        thing = makeThing();
        rendererState.things[thingIndex] = thing;
    }
    return thing;
}
