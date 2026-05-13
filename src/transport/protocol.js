/**
 * Broadcast protocol constants and message types.
 *
 * Both master (game-running window) and secondary (renderer-only window)
 * open a BroadcastChannel of the same name and exchange messages.
 *
 * Master → secondary:
 *   { type: 'cmd-pane', target, method, args }   per-pane renderer command,
 *                                                 `target` is master's paneIndex
 *                                                 the sink represents
 *   { type: 'cmd-world', method, args }          world renderer command, fan-out
 *   { type: 'snapshot', levelId, state }         initial state on join (TBD)
 *   { type: 'ack', for: 'looking-for-session' }  master accepts a join
 *   { type: 'pong', t }                          heartbeat reply
 *
 * Secondary → master:
 *   { type: 'looking-for-session' }              announce on load
 *   { type: 'ready', target }                    snapshot applied, ready for deltas
 *   { type: 'leaving', target }                  graceful disconnect
 *   { type: 'input', slot, kind, data }          controller input forwarded back
 *   { type: 'ping', t }                          heartbeat
 *
 * `target` identifies which master-side pane slot the secondary represents.
 * Most installs only ever have one secondary; multi-secondary support is a
 * future concern.
 */

export const BROADCAST_CHANNEL_NAME = 'cssdoom-mp';

// Message type tags — keep them as constants so the linter catches typos.
export const MSG = {
    CMD_PANE: 'cmd-pane',
    CMD_WORLD: 'cmd-world',
    SNAPSHOT: 'snapshot',
    ACK: 'ack',
    PONG: 'pong',
    LOOKING: 'looking-for-session',
    READY: 'ready',
    LEAVING: 'leaving',
    INPUT: 'input',
    PING: 'ping',
    // Master is about to teardown + rebuild the scene (initial load,
    // level transition, attract entry). Secondary should reload itself
    // so the next reconnect arrives after master's loadMap has settled
    // on a fresh state.
    LEVEL_CHANGE: 'level-change',
    // Master → secondary: current lobby state. Secondary mirrors it onto
    // the per-pane data-claim-state attribute so the existing CSS shows
    // the same PRESS BUTTON TO JOIN / READY / waiting visuals as the
    // local split-screen pane would. (Lobby vs. active mode itself is
    // mirrored separately via the GAME_STATE envelope below.)
    LOBBY_STATE: 'lobby-state',
    // Master → secondary: match has ended. Carries the kill matrix,
    // per-player scores, map name, and winner so the secondary renders
    // the same scoreboard. resetMatch / restartMatch implicitly clear
    // by re-broadcasting LOBBY_STATE on the cssdoom:match-reset event.
    MATCH_END: 'match-end',
    // Master → secondary: game-state transition. Secondary mirrors
    // master's game-state machine so its body[data-game-state] attribute
    // stays in sync — keeping all the attract/match-end/lobby/intermission
    // CSS gates unified under a single namespaced attribute.
    GAME_STATE: 'game-state',
};

// Heartbeat: master pings every PING_INTERVAL_MS; if no pong arrives within
// PING_TIMEOUT_MS, assume the secondary is gone and rebuild pane locally.
export const PING_INTERVAL_MS = 500;
export const PING_TIMEOUT_MS = 2000;
