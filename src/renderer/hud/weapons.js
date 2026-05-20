/**
 * Weapon element rendering — switching animation, fire animation, sprite swaps.
 *
 * Each function takes a renderer instance and animates its `weaponEl`.
 * Mirror-mode fan-out is handled at the orchestrator dispatch layer — every
 * renderer whose `playerIndex` matches receives the call.
 */

/**
 * Switch to a new weapon. If the weapon is different from the current one
 * and no switch is already in progress, plays a lower-then-raise animation
 * and swaps the sprite at the midpoint. Otherwise applies immediately.
 */
export function switchWeapon(renderer, weaponName, fireRate) {
    const weaponElement = renderer.weaponEl;
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

/** Apply the weapon visuals and fire-rate timing to the given weapon element. */
function applyWeaponVisuals(weaponElement, weaponName, fireRate) {
    weaponElement.classList.remove('firing');
    weaponElement.dataset.type = weaponName;
    weaponElement.style.setProperty('--fire-duration', `${fireRate}ms`);
}

/** Start this renderer's weapon fire CSS animation (restart via forced reflow). */
export function startFiring(renderer) {
    const weaponElement = renderer.weaponEl;
    weaponElement.classList.remove('firing');
    void weaponElement.offsetWidth;
    weaponElement.classList.add('firing');
}

/** Remove the firing class from this renderer's weapon element. */
export function stopFiring(renderer) {
    renderer.weaponEl.classList.remove('firing');
}

/**
 * Wire per-renderer weapon-element event listeners. Called once per
 * DomRenderer at construction (the only point the renderer's
 * weaponEl exists and is final). The listener lives with the
 * element — when the pane is destroyed and the element is removed
 * from the DOM, the listener is GC'd with it.
 *
 * Removes the firing class when a fire animation completes so the
 * weapon returns to its idle sprite frame.
 */
export function wireWeaponEvents(weaponEl) {
    weaponEl.addEventListener('animationend', event => {
        if (event.animationName !== 'weapon-fire') return;
        weaponEl.classList.remove('firing');
    });
}
