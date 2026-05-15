/**
 * Wire-protocol constants and message types.
 *
 * Master and each client (Local DM secondary, or a Network DM remote)
 * share a Transport (see [transport.js](transport.js)) and exchange
 * envelopes using the constants below.
 *
 * Master → client:
 *   { type: 'cmd-pane', target, method, args }   per-pane renderer command,
 *                                                 `target` is master's paneIndex
 *                                                 the sink represents
 *   { type: 'cmd-world', method, args }          world renderer command, fan-out
 *   { type: 'ack', payload: { mode, level,        master accepts a join; carries
 *                              gameState,           the snapshot a freshly-joined
 *                              slotIndex } }       client needs to bootstrap
 *   { type: 'pong', t }                          heartbeat reply
 *
 * Client → master:
 *   { type: 'looking-for-session' }              announce on load
 *   { type: 'leaving', target }                  graceful disconnect
 *   { type: 'action', kind, slot, deviceId, …}   logical action event already
 *                                                 interpreted by the client
 *                                                 (FIRE_DOWN, USE, …) — master
 *                                                 just re-emits on its bus
 *   { type: 'analog', slot, moveX, moveY,         per-tick analog snapshot
 *           turn, turnDelta, run }                 (movement + look)
 *   { type: 'ping', t }                          heartbeat
 *
 * `target` identifies which master-side pane slot the client represents.
 * Most installs only ever have one client; multi-client support is a
 * future concern.
 *
 * No mid-match join — every Network DM remote joins during the lobby
 * phase, so the ACK payload is enough to bootstrap. A heavier
 * `snapshot` envelope (door states, scores, things in flight) would
 * only be needed for late joining, which is intentionally out of scope.
 */

export const BROADCAST_CHANNEL_NAME = 'cssdoom-mp';

// Message type tags — keep them as constants so the linter catches typos.
export const MSG = {
    CMD_PANE: 'cmd-pane',
    CMD_WORLD: 'cmd-world',
    ACK: 'ack',
    PONG: 'pong',
    LOOKING: 'looking-for-session',
    // Client → master: "I've processed your ACK, my RenderClient is
    // subscribed to the wire, and I'm ready to receive renderer
    // commands." Master defers the spawn / initial-state burst until
    // this arrives so the burst doesn't fire into a not-yet-subscribed
    // transport (commands would be dropped on the client otherwise).
    READY: 'ready',
    LEAVING: 'leaving',
    // Remote → master: a logical action event the remote already
    // interpreted on its own event bus (FIRE_DOWN, USE, WEAPON_NEXT,
    // …). Master re-emits on its bus; its `src/actions/*` handlers
    // run as if the action were local. Carries `kind, slot, deviceId`
    // plus any action-specific extras (e.g. `weapon` for WEAPON_SELECT).
    ACTION: 'action',
    // Remote → master: per-tick analog snapshot ({ slot, moveX, moveY,
    // turn, turnDelta, run }). Updates the receiver's latest-snapshot
    // cache which orchestrator.collectInputs polls each frame via the
    // registered input provider.
    ANALOG: 'analog',
    PING: 'ping',
    // Master is about to teardown + rebuild the scene (initial load,
    // level transition, attract entry). Client should reload itself so
    // the next reconnect arrives after master's loadMap has settled on
    // a fresh state.
    //
    // L6.6 introduced LOAD_MAP + READY_TO_PLAY + PLAY as the coordinated
    // replacement; LEVEL_CHANGE stays in Phase 1 of L6.6 as a fallback
    // for any code paths not yet routed through the coordinated handshake
    // (notably the legacy switches.js DM exit-switch path that bypasses
    // Game.beginPlay). Phase 2 deletes it.
    LEVEL_CHANGE: 'level-change',
    // L6.6 — coordinated level-load handshake.
    //
    // Master → clients: "rebuild your scene to this map name." Clients
    // call loadMap locally (no page reload), then send READY_TO_PLAY
    // back so master knows when every joiner has the new scene up.
    LOAD_MAP: 'load-map',
    // Client → master: "I've finished loadMap; the new scene is built
    // and I'm ready to receive renderer commands." Master gates the
    // match-start (PLAY broadcast + level.start) on receiving this from
    // every alive peer.
    READY_TO_PLAY: 'ready-to-play',
    // Master → clients: "every peer is ready; start ticking." Today
    // it's a synchronization signal; clients don't act on it directly
    // beyond logging (renderer commands continue to drive the visual
    // state). Future expansion may flip a local PLAYING flag for input
    // gating on the joiner.
    PLAY: 'play',
    // Master → client: world sound trigger. Carries `name` (sound asset)
    // and `opts` ({x, y} only — UI sounds are local and never broadcast).
    // The client's orchestrator re-plays it through its own AudioRenderers.
    SOUND: 'sound',
};

// Heartbeat: master pings every PING_INTERVAL_MS; if no pong arrives within
// PING_TIMEOUT_MS, assume the client is gone and rebuild pane locally.
export const PING_INTERVAL_MS = 500;
export const PING_TIMEOUT_MS = 2000;
