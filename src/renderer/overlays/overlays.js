/**
 * Overlay-impl side-effect anchor.
 *
 * Each module listed below registers a renderer-command handler
 * (`registerOverlayImpl` call at the bottom of the file) at module
 * load time. None of these modules' named exports are pulled in by
 * the boot path on their own merit — the registrations happen as a
 * pure side effect of the module being evaluated.
 *
 * Boot code (master.js, client.js) imports THIS file for that side
 * effect so the registry is wired up regardless of whether any of
 * the underlying modules happen to have named exports anyone else
 * uses.
 *
 * Migration in progress: screens are being moved off the
 * `registerOverlayImpl` registry and onto direct imports from
 * `commands.js`. When a screen's impls are imported directly by
 * commands.js, its side-effect import drops off this list (commands.js
 * already pulls the module into the bundle via the direct import).
 * intermission and scoreboard have been converted; lobby /
 * network-lobby / client-lobby / match-timer / game-state still use
 * the registry.
 */

import '../screens/lobby.js';
import '../screens/network-lobby.js';
import '../screens/client-lobby.js';
import '../hud/match-timer.js';
import '../../game/game-state.js';
