/**
 * modeConfig builder.
 *
 * Packages the current window's mode choice (gameMode + networkMode +
 * rules + skill + start map) into a plain object suitable for passing
 * to `new Game(...)`. Game (and later App in L3.2) take this struct
 * and never look at URL params / localStorage / kiosk class themselves.
 *
 * L2.2 only mirrors today's boot-time resolution from
 * `master.js::initMaster`:
 *
 *   - `?kiosk` URL param  → Local DM standalone (forces deathmatch,
 *                            ignores localStorage).
 *   - otherwise           → `loadSavedGameMode()` + standalone.
 *
 * The Q12 boot-resolution tree from LIFECYCLE_REFACTOR.md (sessionStorage
 * lastUsedMode, ?join routing to a RemoteGame, kiosk default DM, etc.)
 * lands in App.start() in L3.2. Until then, this helper covers only the
 * subset master needs.
 *
 * No caller wired yet — L2.9 hands the returned config to `new Game(...)`.
 */

import { loadSavedGameMode } from '../mode.js';

export function buildModeConfigFromUrl() {
    const params = new URLSearchParams(location.search);
    const isKiosk = params.has('kiosk');

    const gameMode = isKiosk ? 'deathmatch' : loadSavedGameMode();
    const networkMode = 'standalone';

    return {
        gameMode,
        networkMode,
        // skillLevel isn't currently read from URL or storage — it
        // defaults on `state.js` to 1 and is changed only via the
        // (not-yet-wired) skill picker. Mirror that here so today's
        // behavior is preserved.
        skillLevel: 1,
        // DM rules (fragLimit / timeLimit) are populated by `resetMatch`
        // in `game/match.js` today. L2.5 hands that responsibility to
        // Game.beginPlay; until then `rules` stays null and DM behavior
        // is unchanged.
        rules: null,
        startMap: 'E1M1',
    };
}
