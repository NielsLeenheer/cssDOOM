/**
 * Unified game-state machine.
 *
 * The game lives in exactly one of these states at any time:
 *
 *   ACTIVE       — Full simulation: SP play, DM match running.
 *   LOBBY        — DM lobby. Players claiming slots; world is rendered
 *                  but movement / fire / mechanics are suppressed.
 *   ENDED        — DM scoreboard. Match decided, awaiting restart input.
 *   ATTRACT      — Kiosk idle loop. Camera slow-rotates; no input
 *                  contribution to gameplay.
 *   INTERMISSION — SP level finished. Stats screen up, awaiting fire.
 *
 * Callers gate their work on `getGameState()` instead of the scattered
 * combinations of `state.match.started/ended`, `isAttractActive()`,
 * `isIntermissionActive()` that used to live across half a dozen
 * modules. Each transition flips `body.dataset.gameState` so CSS can
 * key off the current state too.
 *
 * Per-player concerns (`player.isDead`) stay separate — those aren't
 * game-wide. The master menu (`isMenuOpen()`) is also orthogonal: it
 * can overlay any of the states above without changing them.
 */

export const GAME_STATE = Object.freeze({
    ACTIVE: 'active',
    LOBBY: 'lobby',
    ENDED: 'ended',
    ATTRACT: 'attract',
    INTERMISSION: 'intermission',
});

let current = GAME_STATE.ACTIVE;
const listeners = new Set();

// Optional master-side broadcaster — set by index.js when the
// MasterConnection is up so every transition mirrors to clients.
// Null on a client (or on master before init); receivers should
// guard with `?.`.
let broadcastGameState = null;
export function setGameStateBroadcaster(fn) { broadcastGameState = fn; }

// Mirror the initial state to the body at module load so CSS / debug
// inspection see a sane starting attribute before any transition fires.
if (typeof document !== 'undefined' && document.body) {
    document.body.dataset.gameState = current;
}

/** Current canonical state. */
export function getGameState() {
    return current;
}

/**
 * Transition to a new state. Mirrors `body.dataset.gameState` so CSS
 * keys off the current state directly (selectors of the form
 * `body[data-game-state="attract"] …` etc. — see [ui/hud.css](../ui/hud.css)).
 *
 * Notifies subscribers AFTER the DOM is updated so handlers can read
 * the freshly-set attribute.
 */
export function transitionTo(next) {
    applyTransition(next);
    // Mirror to any connected client. The hook is a no-op on the
    // client side (no broadcaster registered) and on master when no
    // peer is alive (MasterConnection gates on peerAlive).
    broadcastGameState?.(next);
}

/**
 * Apply a remote game-state transition without re-broadcasting.
 * Called by a client when a GAME_STATE envelope arrives from master.
 * We intentionally bypass the broadcaster hook so we don't echo the
 * transition back into the channel.
 */
export function applyRemoteGameState(next) {
    applyTransition(next);
}

function applyTransition(next) {
    if (next === current) return;
    const prev = current;
    current = next;
    if (typeof document !== 'undefined') {
        document.body.dataset.gameState = next;
    }
    for (const cb of listeners) cb(next, prev);
}

// L6.5 — render-only impl for the setGameState renderer command. Master's
// transitionTo calls broadcastGameState(next) which fans through the
// renderer-command pipeline; the impl runs on every receiver (master's
// own DomRenderer + each RenderSink → client's DomRenderer). master's
// applyTransition already ran from the original transitionTo so it's a
// no-op there (current === next); on the client this is what writes
// body[data-game-state] so CSS gates stay synced.
import { registerOverlayImpl } from '../renderer/commands.js';
registerOverlayImpl('setGameState', applyRemoteGameState);

/**
 * Subscribe to state-change events. Returns an unsubscribe function.
 * The callback receives `(next, prev)`.
 */
export function onStateChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}
