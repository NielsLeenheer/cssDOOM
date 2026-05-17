/**
 * RendererState — the explicit contract for everything the renderer
 * reads from the game world.
 *
 * `cameras[slot]` and `things[index]` are independently-allocated
 * objects populated by the `mirror` callbacks declared on entries in
 * [commands.js](commands.js). The orchestrator's per-pane / world
 * dispatch loops fire the mirrors before fanning to render targets,
 * so the population mechanism is identical on master and joiner:
 *
 *   Master: game code calls `renderer.updateCamera(player, slot)`
 *           → orchestrator runs the mirror (writes rendererState
 *           here) → fans to local DomRenderers + RenderSinks.
 *
 *   Joiner: wire envelope arrives → RenderClient delegates to local
 *           orchestrator → orchestrator runs the mirror (writes
 *           rendererState here) → fans to the local DomRenderer.
 *
 * The renderer (culling, camera transforms, sprite billboards,
 * scene.loadMap warmup) reads ONLY from this object. There is no
 * `state.*` import anywhere in `src/renderer/`, `src/transport/`,
 * or `src/orchestrator.js`.
 *
 * Field set is the minimum the renderer + culler actually read.
 * Adding a new render-time read means adding a field here AND
 * declaring it in the mirror callback for the relevant command(s).
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
