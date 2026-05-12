/**
 * Action handler registration — call `initActions()` once at boot
 * after the input modules and game systems are imported. Order of
 * registration matters only via the `priority` arg each handler
 * passes to `on()`; the gates module runs first to claim the
 * high-priority slots so the per-action handlers come in after.
 */

import { initGates } from './gates.js';
import { initFireAction } from './fire.js';
import { initUseAction } from './use.js';
import { initWeaponAction } from './weapon.js';
import { initMenuAction } from './menu.js';

export function initActions() {
    initGates();
    initFireAction();
    initUseAction();
    initWeaponAction();
    initMenuAction();
}
