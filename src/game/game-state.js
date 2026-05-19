/**
 * Window-local game-state machine — pure state, no DOM, no transport.
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
 * combinations of `state.match.started/ended` + per-screen `isXActive()`
 * helpers that used to live across half a dozen modules.
 *
 * `setGameState(value)` is the only mutator. It writes the local
 * `current` and returns. **There is no cross-window sync** — each
 * window (master + each joiner) has its own `current`. In practice
 * only master code reads `current` (match.js, game.js, gates.js,
 * etc.); joiners are render-only and never consult the value. CSS
 * visibility on every window derives from per-pane `.active` classes
 * on the overlay containers, not from this state.
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

/** Current canonical state. */
export function getGameState() {
    return current;
}

/**
 * Write the local state. Same-value writes early-return. No
 * notification, no DOM, no transport — callers fire any companion
 * renderer commands (showLobby, showResults, etc.) themselves.
 */
export function setGameState(next) {
    if (next === current) return;
    current = next;
}
