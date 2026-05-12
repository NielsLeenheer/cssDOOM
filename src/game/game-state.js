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
 * (and hidden DOM rules like `body[data-game-state="lobby"]`) follows.
 *
 * Also keeps the legacy per-state body attributes in sync so existing
 * CSS rules (`body[data-attract="true"]`, `body[data-match-ended]`,
 * `body[data-intermission]`, `body[data-match-lobby]`) continue to
 * work without touching every selector. We'll collapse those into a
 * single `data-game-state` selector in a follow-up CSS pass.
 *
 * Notifies subscribers AFTER the DOM is updated so handlers can read
 * the freshly-set attribute.
 */
export function transitionTo(next) {
    if (next === current) return;
    const prev = current;
    current = next;
    if (typeof document !== 'undefined') {
        const body = document.body;
        body.dataset.gameState = next;
        // Legacy mirror. Cleared first, then re-set for the one matching
        // state — keeps `:not([data-attract="true"])`-style guards working.
        body.removeAttribute('data-attract');
        body.removeAttribute('data-match-ended');
        body.removeAttribute('data-intermission');
        body.removeAttribute('data-match-lobby');
        if (next === GAME_STATE.ATTRACT) body.dataset.attract = 'true';
        else if (next === GAME_STATE.ENDED) body.dataset.matchEnded = 'true';
        else if (next === GAME_STATE.INTERMISSION) body.dataset.intermission = 'true';
        else if (next === GAME_STATE.LOBBY) body.dataset.matchLobby = 'true';
    }
    for (const cb of listeners) cb(next, prev);
}

/**
 * Subscribe to state-change events. Returns an unsubscribe function.
 * The callback receives `(next, prev)`.
 */
export function onStateChange(callback) {
    listeners.add(callback);
    return () => listeners.delete(callback);
}
