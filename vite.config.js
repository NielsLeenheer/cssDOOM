/**
 * Vite dev-server config — primarily exists to proxy the WebSocket
 * signaling endpoint to the deployed Cloudflare Worker so Network DM
 * can be tested end-to-end during local dev.
 *
 * Production / staging: the cssDOOM page is served BY the Worker
 * itself, so `ws://{location.host}/signaling/connect` resolves to the
 * Worker's signaling endpoint directly — no proxy needed.
 *
 * Local dev (`vite dev` on http://localhost:5173): Vite serves the
 * static assets but there's no Worker running, so the same-origin
 * `ws://localhost:5173/signaling/connect` 404s. The proxy below
 * forwards /signaling/* upgrades to the staging Worker. WebRTC peers
 * still connect directly to each other via STUN — the signaling hop
 * is only for SDP / ICE candidate exchange during the join handshake.
 *
 * If the staging worker URL changes, edit the `target` here. The
 * Worker hostname is the only environment-specific config in this
 * file; the rest is generic dev-server setup.
 */

import { defineConfig } from 'vite';

export default defineConfig({
    server: {
        proxy: {
            '/signaling': {
                target: 'https://doomcss-staging.niels-leenheer.workers.dev',
                ws: true,
                changeOrigin: true,
                secure: true,
            },
        },
    },
});
