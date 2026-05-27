/**
 * App — the outermost layer in the lifecycle hierarchy.
 *
 * Holds a polymorphic `game`: a `Game` (host-side simulation) or a
 * `RemoteGame` (joining client). Owns the BOOT / IN_GAME / MENU /
 * ATTRACT state machine, writes `body.dataset.appState`, and resolves
 * the URL / sessionStorage / kiosk-default boot destination on start().
 *
 * Same on/_emit pattern as Game / Level — App is the top-level
 * subscriber for cross-cutting concerns (analytics, recording, etc.).
 */

/**
 * Kiosk boot lands directly in a Local DM lobby — DM is the
 * installation's headline feature, so attendees aren't asked to pick a
 * mode. Skill / startMap match what `mode-config.js::buildModeConfigFromUrl`
 * returns for the kiosk branch.
 */
const KIOSK_DEFAULT_MODE_CONFIG = {
    gameMode: 'deathmatch',
    networkMode: 'standalone',
    skillLevel: 1,
    rules: null,
    startMap: 'E1M1',
};

/**
 * sessionStorage key for the non-kiosk "last picked mode" autostart
 * hint. Session-scoped (cleared on tab close, restored on
 * reload-in-same-tab) so dev iteration lands back in whatever was
 * running, but a fresh tab opens to MENU.
 *
 * Distinct from `mode.js`'s `cssdoom-game-mode` localStorage key,
 * which stores only gameMode and persists across page reloads. Both
 * coexist: localStorage is the cross-reload default, sessionStorage
 * is the dev-iteration "stay in the same mode on reload."
 */
const LAST_USED_MODE_STORAGE_KEY = 'cssdoom:lastUsedMode';

/**
 * Read the saved modeConfig from sessionStorage. Returns null when
 * absent or malformed (defensive — never throws).
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

/**
 * Ensure a `?cid=` is present in the URL (the joiner's stable
 * identity for slot reattach on refresh). Generates one when absent
 * and rewrites the URL via history.replaceState so a reload picks it
 * up next time. Returns the cid for handing into RemoteGame.
 *
 * The cid lives ONLY in the URL — not sessionStorage, not
 * localStorage. Closing the tab and reopening the join link gives
 * the user a fresh identity; a hard reload of the same URL keeps it.
 * Short base36 string — collision risk is negligible compared to the
 * benefit of "the address bar is the truth."
 */
function ensureClientIdInUrl() {
    const url = new URL(location.href);
    const existing = url.searchParams.get('cid');
    if (existing && /^[a-z0-9]{4,16}$/i.test(existing)) return existing;
    const cid = Math.random().toString(36).slice(2, 10);
    url.searchParams.set('cid', cid);
    history.replaceState(history.state, '', url.toString());
    return cid;
}

import { Game } from './game/game.js';
import { RemoteGame } from './game/remote-game.js';
import { state } from './game/state.js';
import { orchestrator } from './orchestrator.js';
import { setActiveRoomCode } from './network-host.js';
import { applyMode } from './mode.js';

export class App {
    constructor() {
        this._state = 'BOOT';
        this._previousState = null;

        // Polymorphic: `Game` (local simulation — SP host or DM host)
        // or `RemoteGame` (wire receiver — client window). Set by
        // startLocalGame() / joinRemoteGame().
        this.game = null;

        // The last modeConfig handed to startLocalGame. Read by
        // closeMenu's ATTRACT branch (menu opened during attract → close
        // starts a fresh Game with whatever was most recently picked).
        // Currently unreachable since attract isn't routed through App;
        // kept so the attract-on-App rewire has the data it needs.
        this.lastModeConfig = null;

        this._listeners = new Map();
    }

    /**
     * Boot resolution:
     *
     *   ?join=ROOM      → joinRemoteGame(roomCode). Any platform.
     *   ?kiosk          → startLocalGame(KIOSK_DEFAULT_MODE_CONFIG).
     *                     Kiosk does NOT consult sessionStorage — every
     *                     kiosk reload is a fresh attendee.
     *   sessionStorage  → startLocalGame(stored). Non-kiosk only.
     *   state.gameMode  → startLocalGame seeded from current state.
     *                     This is the live non-kiosk first-boot path
     *                     (master.js's applyMode always seeds it).
     *   else            → transitionTo('MENU'). Unreachable today;
     *                     the cut-point for a future "first boot opens
     *                     MENU" UX.
     *
     * Called from master.js's initMaster and client.js's initClientWindow.
     */
    async start() {
        if (this._state !== 'BOOT') return;

        const params = new URLSearchParams(location.search);
        const joinParam = params.get('join');
        const serverParam = params.get('server');
        const isKiosk = document.body.dataset.layout === 'kiosk';

        if (joinParam !== null) {
            await this.joinRemoteGame(joinParam || null);
            return;
        }

        // `?server=CODE` boots directly into Network DM host with the
        // supplied room code. At the CSS Day installation this is the
        // production URL (combined with `?kiosk`) — picking a stable
        // code like `CSSD` means the room name on the lobby QR stays
        // memorable and survives kiosk reboots, instead of changing to
        // a random code each restart. Also works standalone for dev:
        // two browsers can agree on a code without scanning the QR.
        // setActiveRoomCode validates format and silently ignores
        // malformed input.
        //
        // applyMode MUST run before startLocalGame because applyMode is
        // what calls openRoom(), and openRoom reads the pre-set
        // activeRoomCode. Without this ordering, startLocalGame would
        // construct a host Game but no signaling room would ever open.
        if (serverParam) {
            setActiveRoomCode(serverParam.toUpperCase());
            applyMode('deathmatch', 'host');
            await this.startLocalGame({
                gameMode: 'deathmatch',
                networkMode: 'host',
                skillLevel: 1,
                rules: null,
                startMap: 'E1M1',
            });
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

        // master.js seeds state.gameMode via applyMode before App.start
        // runs, so this branch always wins on non-kiosk first boot
        // (defaulting to 'singleplayer' the very first time). Seeding
        // startLocalGame here means the user lands in a playable game
        // rather than an empty menu.
        //
        // A future UX where non-kiosk first boot opens MENU would drop
        // master.js's applyMode pre-seed so state.gameMode is falsy
        // here; the transitionTo('MENU') line below is the cut-point.
        if (state.gameMode) {
            await this.startLocalGame({
                gameMode: state.gameMode,
                networkMode: state.networkMode,
                skillLevel: state.skillLevel ?? 1,
                rules: null,
                startMap: 'E1M1',
            });
            return;
        }

        this.transitionTo('MENU');
    }
    destroy()                        { /* dev hot-reload teardown */ }
    /**
     * Force a state transition. Writes `body.dataset.appState` so CSS
     * can key off App state. This is a separate attribute from
     * `body.dataset.gameState`, which the parallel `game-state.js`
     * machine still owns with its own vocabulary; both coexist.
     *
     * Idempotent — a redundant transition to the current state is a
     * no-op and does NOT overwrite `_previousState`, since closeMenu
     * reads that to decide whether to resume the held Game or start
     * a fresh one.
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
     * `modeConfig`, persist it for next reload (non-kiosk only),
     * start it, and transition App into IN_GAME.
     */
    async startLocalGame(modeConfig) {
        if (this.game) await this.endGame();

        this.game = new Game(modeConfig);
        this._wireGameSubscriptions(this.game);
        this.lastModeConfig = modeConfig;

        // Persist the picked mode for dev iteration — a single-tab
        // reload should land back in the same mode. Kiosk skips so
        // every reload is a fresh attendee on the default. `?server`
        // skips because the URL itself carries the mode: reloading
        // without the param should revert to whatever was previously
        // running, not re-enter Network DM host.
        const params = new URLSearchParams(location.search);
        const isKioskLayout = document.body.dataset.layout === 'kiosk';
        const skipPersist = isKioskLayout || params.has('server');
        if (!skipPersist) {
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

    /**
     * Construct a RemoteGame for joining a remote master and enter
     * IN_GAME with it. Mirrors startLocalGame's shape (tear down any
     * existing game first, await game.start, transition state) but
     * holds a RemoteGame instance rather than a Game.
     *
     * roomCode null → Local DM secondary (BroadcastChannel transport
     * inside ClientConnection); non-null string → Network DM remote
     * (WebRTC transport via connectToNetworkRoom).
     *
     * For Network DM remotes the joiner identity (`cid`) is read or
     * generated here and written back into the URL so a hard refresh
     * reattaches to the same slot. Local DM secondary skips cid (its
     * peer identity is the 'local' constant — single peer, no slot
     * race).
     */
    async joinRemoteGame(roomCode) {
        if (this.game) await this.endGame();
        const cid = roomCode ? ensureClientIdInUrl() : null;
        this.game = new RemoteGame({ roomCode, cid, orchestrator });
        this._wireGameSubscriptions(this.game);
        await this.game.start();
        this.transitionTo('IN_GAME');
    }

    /**
     * Subscribe App to its held game's lifecycle events. Per the
     * outward = events architecture, App reacts to Game / RemoteGame
     * lifecycle through subscriptions rather than reaching inward to
     * inspect their state.
     *
     * `game-ended` fires from Game.stop / RemoteGame.stop when teardown
     * completes. The only path that triggers a stop today is the
     * "switch to new game" sequence in startLocalGame / joinRemoteGame
     * — and that path is entered from the menu, so App._state is
     * already MENU and the transitionTo below is a no-op. A future
     * "quit to menu" feature (no replacement game queued) would make
     * this subscription do real work.
     */
    _wireGameSubscriptions(game) {
        game.on('game-ended', () => this.transitionTo('MENU'));
    }

    /**
     * Clean teardown of the held Game (or RemoteGame). Safe to call
     * when no game is held — no-op. Used by startLocalGame's
     * "switch games" path.
     */
    async endGame() {
        if (!this.game) return;
        await this.game.stop();
        this.game = null;
    }

    /**
     * Open the menu overlay. Records the current state as
     * `_previousState` (so closeMenu knows where to return to) and
     * pauses the held Game. Idempotent. Called from
     * `ui/menu.js::toggleMenu`.
     */
    openMenu() {
        if (this._state === 'MENU') return;
        this.transitionTo('MENU');
        this.game?.pause();
    }

    /**
     * Close the menu overlay. Where to return to depends on what was
     * happening when the menu opened:
     *
     *   IN_GAME → resume the held Game.
     *   ATTRACT → start a fresh Game (menu opened during attract is a
     *             signal that the user wants to play). Currently
     *             unreachable since attract isn't routed through App;
     *             ready for a future attract-on-App rewire.
     *   BOOT    → no-op. Unreachable in practice.
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

/**
 * The single App instance for this window. Constructed at module-load
 * time — App's constructor is field-defaults only (no DOM access, no
 * state reads), so it's safe to evaluate before initMaster /
 * initClientWindow have run. Modules that need to reach App or its
 * held Game import this singleton directly.
 */
export const app = new App();
