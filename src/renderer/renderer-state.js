/**
 * RendererState — the explicit contract for everything the renderer
 * reads from the game world.
 *
 * Two windows, two shapes of backing storage, one read-side API:
 *
 *   Master: each entry in `cameras` / `things` aliases the same object
 *   in `state.players` / `state.things` so the renderer reads the
 *   authoritative simulation values directly. No copy step.
 *
 *   Client: there is no `state.players` / `state.things` worth speaking
 *   of — only spawn-time defaults. `cameras` and `things` are
 *   independent objects populated by inbound broadcast envelopes
 *   (`updateCamera`, `updateThingPosition`, `killEnemy`, `collectItem`,
 *   `uncollectItem`) via the `mirror` callbacks declared in
 *   [commands.js](commands.js). The renderer can't tell the difference.
 *
 * Field set is the minimum the renderer + culler actually read. Adding
 * a new render-time read means adding a field here AND updating the
 * broadcast mirror in `applyCameraUpdate` / `applyThingUpdate` below.
 *
 *   cameras[slot]: { x, y, z, angle, floorHeight, isFiring }
 *   things[index]: { x, y, floorHeight, collected }
 */

export const rendererState = {
    cameras: [],
    things: [],
};

/**
 * Master-side init: alias the live game state directly. No copy — the
 * renderer reads the same object the simulation mutates. Called once from
 * `initMaster`, before any rendering loop starts. The aliased arrays are
 * stable — `state.players` / `state.things` are mutated in place (push,
 * length=0) and never reassigned, so this binding stays valid for the
 * lifetime of the page.
 */
export function bindRendererStateToMaster(state) {
    rendererState.cameras = state.players;
    rendererState.things = state.things;
}

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
