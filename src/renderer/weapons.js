/**
 * Weapon element rendering — switching animation, fire animation, sprite swaps.
 *
 * Per-player: each pane has its own weapon element in dom.weaponElements[i].
 * Each function takes a playerIndex so the right pane's weapon animates.
 * In mirror mode, viewportsForEffect() fans out player 0's weapon visuals to
 * pane 1 so both panes show the same weapon sprite/animation.
 */

import { dom } from './dom.js';
import { viewportsForEffect } from './scene/scene.js';

/**
 * Switch to a new weapon for the given player. If the weapon is different
 * from the current one and no switch is already in progress, plays a
 * lower-then-raise animation and swaps the sprite at the midpoint. Otherwise
 * applies immediately.
 */
export function switchWeapon(playerIndex, weaponName, fireRate) {
    for (const i of viewportsForEffect(playerIndex)) {
        const weaponElement = dom.weaponElements[i];
        const currentType = weaponElement.dataset.type;
        const needsAnimation = weaponName !== currentType
            && !weaponElement.classList.contains('switching');

        if (needsAnimation) {
            weaponElement.classList.remove('firing');
            weaponElement.classList.add('switching');

            setTimeout(() => applyWeaponVisuals(weaponElement, weaponName, fireRate), 200);

            weaponElement.addEventListener('animationend', function onEnd(event) {
                if (event.animationName === 'weapon-switch') {
                    weaponElement.classList.remove('switching');
                    weaponElement.removeEventListener('animationend', onEnd);
                }
            });
        } else {
            applyWeaponVisuals(weaponElement, weaponName, fireRate);
        }
    }
}

/** Apply the weapon visuals and fire-rate timing to the given weapon element. */
function applyWeaponVisuals(weaponElement, weaponName, fireRate) {
    weaponElement.classList.remove('firing');
    weaponElement.dataset.type = weaponName;
    weaponElement.style.setProperty('--fire-duration', `${fireRate}ms`);
}

/** Start the given player's weapon fire CSS animation (restart via forced reflow). */
export function startFiring(playerIndex) {
    for (const i of viewportsForEffect(playerIndex)) {
        const weaponElement = dom.weaponElements[i];
        weaponElement.classList.remove('firing');
        void weaponElement.offsetWidth;
        weaponElement.classList.add('firing');
    }
}

/** Remove the firing class from the given player's weapon element. */
export function stopFiring(playerIndex) {
    for (const i of viewportsForEffect(playerIndex)) {
        dom.weaponElements[i].classList.remove('firing');
    }
}

// Clean up the firing class when a CSS fire animation completes on any pane's
// weapon element, so the weapon returns to its idle sprite frame.
document.addEventListener('animationend', event => {
    if (event.animationName === 'weapon-fire') {
        const target = event.target;
        if (dom.weaponElements.includes(target)) {
            target.classList.remove('firing');
        }
    }
});
