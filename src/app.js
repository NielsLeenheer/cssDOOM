/**
 * App — the outermost layer in the lifecycle hierarchy.
 *
 * Skeleton only. Bodies land in subsequent L3 steps:
 *   L3.2 — start() reads URL / sessionStorage / kiosk default and
 *          resolves the boot destination per §3 + Q12.
 *   L3.3 — startLocalGame() + endGame() construct + tear down a
 *          held Game.
 *   L3.4 — transitionTo() implements the App state machine and
 *          writes body.dataset.appState. game-state.js gets deleted
 *          at the same step.
 *   L3.5 — menu open/close integration; previousState resolution
 *          per §3c.
 *   L3.6 — attract integration (warm path only; cold attract is
 *          documented but unreached in the current flow).
 *   L3.7 — master.js shrinks to `new App().start()`.
 *   L6   — joinRemoteGame() constructs a RemoteGame for the client
 *          window.
 *
 * See LIFECYCLE_REFACTOR.md §3 (App state machine), §3b (when does the
 * Level load), §3c (menu close behavior), §6 (App API), and §16
 * (attract mode) for the target contract.
 *
 * Same on/_emit pattern as Game / Level. App will be the top-level
 * subscriber: every Game and Level event eventually surfaces through
 * App for any cross-cutting concerns (analytics, recording, etc.).
 */

export class App {
    constructor() {
        this._state = 'BOOT';
        this._previousState = null;

        // Polymorphic: `Game` (local simulation — SP host or DM host)
        // or `RemoteGame` (wire receiver — client window). Set by
        // startLocalGame() / joinRemoteGame() (L3.3 / L6).
        this.game = null;

        // The last modeConfig handed to startLocalGame. Used by the
        // attract → menu → close fall-through (§3c) — that path
        // starts a fresh Game with whatever was most recently picked.
        // Kiosk-only in practice (non-kiosk has no attract).
        this.lastModeConfig = null;

        this._listeners = new Map();
    }

    async start()                    { /* L3.2 */ }
    destroy()                        { /* dev hot-reload teardown */ }
    transitionTo(state)              { /* L3.4 */ }
    async startLocalGame(modeConfig) { /* L3.3 */ }
    async joinRemoteGame(roomCode)   { /* L6 */ }
    async endGame()                  { /* L3.3 */ }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
