/**
 * Menu-toggle action — Escape on keyboard or Start on gamepad.
 */

import { isMenuOpen, toggleMenu } from '../ui/menu.js';
import * as A from '../input/actions.js';
import { on } from '../input/event-bus.js';

export function initMenuAction() {
    on(A.MENU_TOGGLE, () => {
        toggleMenu(!isMenuOpen());
    });
}
