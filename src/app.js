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
 * reloads. Both keys coexist: legacy is the kiosk-default fallback,
 * this one is the dev-iteration "stay in the same mode on reload."
 */
const LAST_USED_MODE_STORAGE_KEY = 'cssdoom:lastUsedMode';

/**
 * Read the saved modeConfig from sessionStorage. Returns null when
 * absent or malformed (defensive — never throws). The shape is the
 * full Q12 modeConfig as written by startLocalGame.
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

        // The last modeConfig handed to startLocalGame. Reserved
        // for the attract → menu → close fall-through (§3c) — that
        // path would start a fresh Game with whatever was most
        // recently picked. Attract isn't routed through App today
        // (legacy ui/attract.js owns the kiosk attract flow); see
        // closeMenu's ATTRACT branch.
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
     * Called from master.js's initMaster and client.js's initClientWindow.
     */
    async start() {
        if (this._state !== 'BOOT') return;

        const params = new URLSearchParams(location.search);
        const joinParam = params.get('join');
        const serverParam = params.get('server');
        const isKiosk = params.has('kiosk');

        if (joinParam !== null) {
            await this.joinRemoteGame(joinParam || null);
            return;
        }

        // `?server=CODE` — symmetric dev shortcut to `?join=CODE`. Boots
        // directly into Network DM host with the supplied room code
        // (instead of a randomly generated one), so two browsers can
        // agree on a code without scanning the lobby QR / typing the
        // auto-generated value. setActiveRoomCode validates the format
        // and silently ignores malformed input.
        //
        // applyMode does the cross-cutting "enter Network DM host"
        // work — body data attrs, roster sizing, resetMatch,
        // setLocallyClaimableSlots, AND openRoom() — and it MUST run
        // before startLocalGame because openRoom is what reads the
        // pre-set activeRoomCode. Without this, startLocalGame would
        // construct a Game whose Game.start network-DM branch is a
        // no-op (per L6, host-fire-start owns level load), so no
        // signaling room would ever open. Skill / start map mirror
        // the kiosk default.
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

        // Live non-kiosk first-boot path. master.js calls
        // applyMode(loadSavedGameMode(), 'standalone') before App.start,
        // so state.gameMode is always set here (defaults to
        // 'singleplayer' on first ever boot). We seed startLocalGame
        // with that mode so the user lands in a playable game rather
        // than an empty menu.
        //
        // Q12 specifies a different UX — non-kiosk first boot should
        // land in MENU, not a default Game. Wiring that requires
        // dropping master.js's applyMode pre-seed (so state.gameMode
        // would be falsy here) and reworking menu.js's mode-switch
        // to take the boot path. Deferred; the transitionTo('MENU')
        // line below is the cut-point.
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
     * Force a state transition. Used by start(), startLocalGame(),
     * the menu open/close handlers, and the attract idle timeout / wake.
     *
     * Writes `body.dataset.appState = state` — separate from the
     * `body.dataset.gameState` attribute that the legacy `game-state.js`
     * machine writes. Both coexist: legacy CSS keys on the gameState
     * attribute and stays correct; new CSS that wants App-level state
     * has its own attribute. game-state.js is kept alive on purpose
     * (re-homing the state machine to Game/RemoteGame is an L8-scope
     * follow-up — see project_lifecycle_refactor_l7_deferred.md).
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
     */
    async startLocalGame(modeConfig) {
        if (this.game) await this.endGame();

        this.game = new Game(modeConfig);
        this.lastModeConfig = modeConfig;

        // Q12: kiosk does NOT persist — every kiosk reload is a fresh
        // attendee, defaults always win. Non-kiosk persists to
        // sessionStorage so dev iteration / single-tab reload lands
        // back in the same mode. ?server=CODE also opts out: it's a
        // URL-only dev signal, and reloading without ?server should
        // revert to whatever was set before, not Network DM host.
        const params = new URLSearchParams(location.search);
        const skipPersist = params.has('kiosk') || params.has('server');
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
     */
    async joinRemoteGame(roomCode) {
        if (this.game) await this.endGame();
        this.game = new RemoteGame({ roomCode, orchestrator });
        await this.game.start();
        this.transitionTo('IN_GAME');
    }

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
     * MENU is a no-op. Called from `ui/menu.js::toggleMenu`.
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
     *   previousState='ATTRACT' → reserved (§3c "menu opened during
     *                             attract is a signal to play"). Not
     *                             reachable today because legacy
     *                             ui/attract.js owns the attract
     *                             lifecycle; if attract is ever
     *                             rewired through App, this branch
     *                             becomes live.
     *   previousState='BOOT'    → unreachable per §3c. No-op.
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
