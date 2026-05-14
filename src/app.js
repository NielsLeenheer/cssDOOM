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

/**
 * Kiosk default modeConfig per Q12 — Local DM. DM is the installation's
 * headline feature, so kiosk boots straight into a DM lobby rather
 * than asking the attendee to pick a mode. Skill / startMap defaults
 * match what `mode-config.js::buildModeConfigFromUrl` already returns
 * for the kiosk branch.
 */
const KIOSK_DEFAULT_MODE_CONFIG = {
    gameMode: 'deathmatch',
    networkMode: 'standalone',
    skillLevel: 1,
    rules: null,
    startMap: 'E1M1',
};

/**
 * sessionStorage key the App uses for the non-kiosk "last picked mode"
 * autostart hint per Q12. Session-scoped (cleared on tab close,
 * restored on reload-in-same-tab) so dev iteration lands back in
 * whatever was running, but a fresh tab opens to MENU.
 *
 * Distinct from `mode.js`'s legacy `cssdoom-game-mode` localStorage
 * key — the legacy stores only gameMode and persists across page
 * reloads. Both keys will coexist until L3.7 cuts master.js over to
 * App.start; at that point the legacy key can be retired or migrated.
 */
const LAST_USED_MODE_STORAGE_KEY = 'cssdoom:lastUsedMode';

/**
 * Read the saved modeConfig from sessionStorage. Returns null when
 * absent or malformed (defensive — never throws). The shape is
 * whatever startLocalGame writes back in L3.3; for now that's the
 * full Q12 modeConfig.
 */
function readLastUsedMode() {
    try {
        const raw = sessionStorage.getItem(LAST_USED_MODE_STORAGE_KEY);
        if (!raw) return null;
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object' && parsed.gameMode) {
            return parsed;
        }
        return null;
    } catch {
        return null;
    }
}

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

    /**
     * Boot resolution per LIFECYCLE_REFACTOR.md §3 + Q12:
     *
     *   ?join=ROOM      → joinRemoteGame(roomCode). Any platform.
     *   ?kiosk          → startLocalGame(kiosk default = Local DM).
     *                     Q12 kiosk default is
     *                     { gameMode: 'deathmatch', networkMode: 'standalone' }.
     *   sessionStorage  → startLocalGame(stored). Non-kiosk only —
     *                     kiosk does NOT write sessionStorage (every
     *                     kiosk reload is a fresh attendee).
     *   else            → transitionTo('MENU'). Non-kiosk first boot.
     *
     * No caller wires this yet. L3.7 replaces master.js's procedural
     * boot with `await new App().start()`. Until then, the only effect
     * of running App.start() from the dev console is to no-op through
     * the stubbed inner methods (startLocalGame / joinRemoteGame /
     * transitionTo all land in L3.3+).
     */
    async start() {
        if (this._state !== 'BOOT') return;

        const params = new URLSearchParams(location.search);
        const joinParam = params.get('join');
        const isKiosk = params.has('kiosk');

        if (joinParam !== null) {
            await this.joinRemoteGame(joinParam || null);
            return;
        }

        if (isKiosk) {
            await this.startLocalGame(KIOSK_DEFAULT_MODE_CONFIG);
            return;
        }

        const stored = readLastUsedMode();
        if (stored) {
            await this.startLocalGame(stored);
            return;
        }

        this.transitionTo('MENU');
    }
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
