/**
 * Spectator — set/toggle spectator mode, the SP-only follow/top camera the
 * binoculars button drives (refused in deathmatch). A shared feature: the
 * console exposes it as debug.spectator(); the menu's binoculars button calls
 * the same underlying spectate() in src/ui/spectator.js.
 */

import { spectate, spectatorActive } from '../../ui/spectator.js';

/** No arg toggles spectator mode; pass a boolean to set it on/off (no-op if it's
 *  already in that state). */
export function setSpectator(on) {
    if (on === undefined || !!on !== spectatorActive) spectate();
}
