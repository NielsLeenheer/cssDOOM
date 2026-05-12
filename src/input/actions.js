/**
 * Logical action constants emitted on the input event bus.
 *
 * Each action describes a *meaning* (FIRE_DOWN, USE, WEAPON_SELECT)
 * rather than a key code or button index — input modules map their
 * raw device events to these constants so action handlers in
 * `src/actions/*` stay device-agnostic. Slot resolution + the
 * `deviceId` happen at emit time so handlers don't need to know
 * about the claim registry.
 */

export const FIRE_DOWN     = 'fire-down';
export const FIRE_UP       = 'fire-up';
export const USE           = 'use';
export const WEAPON_PREV   = 'weapon-prev';
export const WEAPON_NEXT   = 'weapon-next';
export const WEAPON_SELECT = 'weapon-select';  // event.weapon = 1..7
export const MENU_TOGGLE   = 'menu-toggle';
export const KBM_SWAP      = 'kbm-swap';        // dev-only Tab on keyboard
