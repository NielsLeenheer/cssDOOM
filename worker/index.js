/**
 * cssDOOM Worker — serves the static site and the Network DM signaling
 * endpoint from a single deployment.
 *
 * Routing:
 *   /signaling/connect?room=ABCD&role=master|join   WebSocket → RoomDO
 *   anything else                                    static asset (env.ASSETS)
 *
 * The signaling logic itself lives in [signaling.js](signaling.js).
 * Most requests pass straight through to the static-asset binding
 * unchanged from the pre-Worker setup.
 */

export { RoomDO } from './signaling.js';

export default {
    async fetch(request, env) {
        const url = new URL(request.url);

        if (url.pathname === '/signaling/connect') {
            return routeToRoom(request, env);
        }

        // Everything else — cssDOOM itself — served by the assets binding.
        return env.ASSETS.fetch(request);
    },
};

/**
 * Route a signaling WebSocket-upgrade request to the Durable Object
 * instance for its room. Each room code maps to exactly one DO via
 * `idFromName(roomCode)`, so two browsers using the same code reach
 * the same DO (which then refuses the second master — see
 * `signaling.js` collision handling).
 */
function routeToRoom(request, env) {
    const url = new URL(request.url);
    const roomCode = url.searchParams.get('room');
    if (!roomCode || !/^[A-Z0-9]{4,8}$/.test(roomCode)) {
        return new Response('missing or malformed room code', { status: 400 });
    }
    const id = env.ROOMS.idFromName(roomCode);
    const stub = env.ROOMS.get(id);
    return stub.fetch(request);
}
