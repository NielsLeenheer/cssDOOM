/**
 * Unified game-state machine — pure state, no DOM.
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
 * modules.
 *
 * To CHANGE the state, call `orchestrator.setGameState(value)` — that's
 * a window-kind renderer command (see src/renderer/commands.js) which
 * updates `current` here AND writes `body.dataset.gameState` AND fans
 * to every joiner so their game-state stays aligned. This module
 * never touches the DOM and never imports the renderer; the only
 * mutator is `applyGameState`, which the renderer command impl calls.
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
 * Pure state mutator — called by the renderer-side setGameState
 * window-command impl. Not for direct use by game code; call
 * `orchestrator.setGameState(value)` instead so master and joiner
 * both update.
 */
export function applyGameState(next) {
    if (next === current) return;
    current = next;
}
