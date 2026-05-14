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

import { Game } from './game/game.js';

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
    /**
     * Force a state transition. Used by start(), startLocalGame(),
     * the menu open/close handlers (L3.5), and the attract idle
     * timeout / wake (L3.6).
     *
     * Writes `body.dataset.appState = state`, which is a NEW attribute
     * — separate from `body.dataset.gameState` that the legacy
     * `game-state.js` machine writes. Both coexist for L3.4: CSS that
     * keys on the legacy attribute stays correct, and any future CSS
     * (or JS) that wants the App-level state has its own attribute.
     * Per the L3.4 scoping decision, deleting `game-state.js` and the
     * CSS audit are deferred to L7 (or a dedicated cleanup step) so
     * L3 lands in a working state.
     *
     * Idempotent — a redundant transition to the current state is a
     * no-op (does NOT overwrite _previousState, which would break the
     * §3c menu close fall-through that reads _previousState to decide
     * whether to resume or start fresh).
     */
    transitionTo(state) {
        const from = this._state;
        if (from === state) return;
        this._previousState = from;
        this._state = state;
        document.body.dataset.appState = state;
        this._emit('state-changed', { from, to: state });
    }
    /**
     * Tear down any existing held Game, construct a fresh one with
     * `modeConfig`, persist it for next reload (non-kiosk only per
     * Q12), start it, and transition App into IN_GAME.
     *
     * Note: `Game.stop()` is still a stub from L2.1 — so a switch
     * between Games doesn't yet fully tear the first one down. Fine
     * for L3.3 because startLocalGame is unreachable until L3.7
     * cuts master.js over; Game.stop gets fleshed out before then.
     *
     * `transitionTo('IN_GAME')` is also a stub (lands in L3.4) — no
     * observable body-class write until then.
     */
    async startLocalGame(modeConfig) {
        if (this.game) await this.endGame();

        this.game = new Game(modeConfig);
        this.lastModeConfig = modeConfig;

        // Q12: kiosk does NOT persist — every kiosk reload is a fresh
        // attendee, defaults always win. Non-kiosk persists to
        // sessionStorage so dev iteration / single-tab reload lands
        // back in the same mode.
        const isKiosk = new URLSearchParams(location.search).has('kiosk');
        if (!isKiosk) {
            try {
                sessionStorage.setItem(
                    LAST_USED_MODE_STORAGE_KEY,
                    JSON.stringify(modeConfig),
                );
            } catch {
                // Quota / private-mode block — non-fatal.
            }
        }

        await this.game.start();
        this.transitionTo('IN_GAME');
    }

    async joinRemoteGame(roomCode)   { /* L6 */ }

    /**
     * Clean teardown of the held Game (or RemoteGame). Safe to call
     * when no game is held — no-op. Used by startLocalGame's
     * "switch games" path and by App's external "End game" affordance
     * once that lands.
     */
    async endGame() {
        if (!this.game) return;
        await this.game.stop();
        this.game = null;
    }

    /**
     * Open the menu overlay. Captures the current state as
     * _previousState (so closeMenu can resolve per §3c) and pauses
     * the held Game. Idempotent — calling openMenu while already in
     * MENU is a no-op.
     *
     * Game.pause() is still a stub from L2.1 / L5; it'll grow real
     * pause-broadcast semantics in L5. For L3.5 the call is plumbing.
     *
     * No caller yet — menu.js still owns its own open/close logic
     * and talks to legacy game-state.js. L3.7 (or a later cutover
     * step) wires the menu UI to call this.
     */
    openMenu() {
        if (this._state === 'MENU') return;
        // transitionTo records _previousState automatically.
        this.transitionTo('MENU');
        this.game?.pause();
    }

    /**
     * Close the menu overlay. Resolves the destination per §3c using
     * the previously-recorded state:
     *
     *   previousState='IN_GAME' → resume the held Game.
     *   previousState='ATTRACT' → start a fresh Game with
     *                             lastModeConfig (the §3c "menu
     *                             opened during attract is a signal
     *                             to play" rule). Falls back to the
     *                             kiosk default when lastModeConfig
     *                             is null (shouldn't happen in
     *                             practice — attract is kiosk-only
     *                             and kiosk seeded lastModeConfig
     *                             on boot).
     *   previousState='BOOT'    → unreachable per §3c (BOOT→MENU
     *                             only happens when MENU has no
     *                             close affordance). Fallback: do
     *                             nothing.
     *
     * Idempotent against being called when not in MENU.
     */
    async closeMenu() {
        if (this._state !== 'MENU') return;
        const prev = this._previousState;
        if (prev === 'IN_GAME') {
            this.transitionTo('IN_GAME');
            this.game?.resume();
            return;
        }
        if (prev === 'ATTRACT') {
            const cfg = this.lastModeConfig ?? KIOSK_DEFAULT_MODE_CONFIG;
            await this.startLocalGame(cfg);
            return;
        }
        // BOOT or other — see §3c. No-op fallback.
    }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
