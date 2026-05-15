/**
 * cssDOOM Worker — serves the static site and the Network DM signaling
 * endpoint from a single deployment.
 *
 * Routing:
 *   /signaling/connect?room=ABCD&role=master|join   WebSocket → RoomDO
 *   /signaling/turn-credentials                     fetch ICE servers (TURN)
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

        if (url.pathname === '/signaling/turn-credentials') {
            return mintTurnCredentials(env);
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

/**
 * Mint short-lived TURN credentials from Cloudflare Realtime TURN.
 *
 * The browser needs `iceServers` for RTCPeerConnection. STUN is
 * trivial (free public servers, no auth). TURN requires a username +
 * credential pair that's time-limited and signed by Cloudflare.
 * Cloudflare's API mints these on demand, but the API call itself
 * needs a bearer token (CLOUDFLARE_TURN_API_TOKEN) that MUST stay
 * server-side — anyone holding it could mint unlimited credentials
 * against our account. So this Worker proxies the mint call: browser
 * fetches `/signaling/turn-credentials`, Worker calls Cloudflare with
 * the secret, returns the ICE-servers JSON to the browser.
 *
 * `CLOUDFLARE_TURN_TOKEN_ID` identifies which key project to mint
 * against. It's not a secret — set as a plain Wrangler var.
 *
 * If the secret isn't configured (e.g. local dev), we return STUN-only
 * so Network DM still works on same-LAN cases. Same for any upstream
 * failure — TURN is a fallback for symmetric NAT, not a hard
 * requirement on conference WiFi.
 */
async function mintTurnCredentials(env) {
    const STUN_ONLY_FALLBACK = {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun.cloudflare.com:3478' },
        ],
    };

    if (!env.CLOUDFLARE_TURN_API_TOKEN || !env.CLOUDFLARE_TURN_TOKEN_ID) {
        return Response.json(STUN_ONLY_FALLBACK);
    }

    try {
        const url = `https://rtc.live.cloudflare.com/v1/turn/keys/${env.CLOUDFLARE_TURN_TOKEN_ID}/credentials/generate-ice-servers`;
        const upstream = await fetch(url, {
            method: 'POST',
            headers: {
                'Authorization': `Bearer ${env.CLOUDFLARE_TURN_API_TOKEN}`,
                'Content-Type': 'application/json',
            },
            // 24h TTL — long enough for a kiosk run, short enough that
            // a leaked credential ages out the same day.
            body: JSON.stringify({ ttl: 86400 }),
        });
        if (!upstream.ok) {
            console.warn('[turn] cloudflare API returned', upstream.status);
            return Response.json(STUN_ONLY_FALLBACK);
        }
        const payload = await upstream.json();
        return Response.json(payload, {
            headers: {
                // Browser may cache for slightly less than the TTL so a
                // long-lived page doesn't keep using a credential that's
                // about to expire mid-connection.
                'Cache-Control': 'private, max-age=72000',
            },
        });
    } catch (err) {
        console.warn('[turn] mint failed:', err);
        return Response.json(STUN_ONLY_FALLBACK);
    }
}
