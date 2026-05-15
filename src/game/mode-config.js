/**
 * modeConfig builder for master.js's boot path. Packages the current
 * window's mode choice (gameMode + networkMode + rules + skill +
 * start map) into a plain object for `new Game(...)`. Game doesn't
 * look at URL params / localStorage / kiosk class itself.
 *
 *   - `?kiosk`  → Local DM standalone (forces deathmatch).
 *   - otherwise → `loadSavedGameMode()` + standalone.
 *
 * App.start handles the richer boot tree (`?join`, `?server`,
 * sessionStorage, etc.); this helper only covers the subset master
 * needs to construct the boot-time Game placeholder.
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
        // defaults to 1 on state.js and is changed only via the skill
        // picker. Mirror that here.
        skillLevel: 1,
        // DM rules (fragLimit / timeLimit) live in `game/match.js`'s
        // resetMatch defaults; this struct carries them as null so
        // Game stays mode-agnostic.
        rules: null,
        startMap: 'E1M1',
    };
}
