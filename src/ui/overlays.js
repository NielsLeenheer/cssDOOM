/**
 * Overlay-impl side-effect anchor.
 *
 * Every module listed below registers a renderer-command handler
 * (`registerOverlayImpl` calls at the bottom of each file) at module
 * load time. None of these modules' named exports are pulled in by the
 * boot path on their own merit anymore — the registrations happen as a
 * pure side effect of the module being evaluated.
 *
 * Boot code (master.js, client.js) imports THIS file for that side
 * effect so the registry is wired up regardless of whether any of the
 * underlying modules happen to have named exports anyone else uses.
 *
 * The previous arrangement relied on each overlay module being
 * incidentally imported by something for an unrelated named export.
 * That meant cleaning up an "unused" named import could silently
 * orphan the module from the bundle and break the corresponding
 * overlay command — exactly what happened when scoreboard.js lost its
 * anchors during the lifecycle-refactor pre-upstream cleanup.
 *
 * KNOWN SMELL: the late-binding registry pattern in
 * src/renderer/commands.js was introduced to break a renderer→ui
 * import cycle that crashed Firefox via TDZ. The cost is that overlay
 * impls now live in a side-effect-driven indirection layer for a set
 * of overlays that is otherwise statically known. A future refactor
 * should consider routing overlay impls through commands.js directly
 * — once the cycle hazard is gone, the registry's only purpose
 * (decouple loading order) goes with it. Documented as deferred work.
 */

import './lobby.js';
import './network-lobby.js';
import './client-lobby.js';
import './intermission.js';
import './scoreboard.js';
import './match-timer.js';
import '../game/game-state.js';
