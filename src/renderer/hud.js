/**
 * Per-frame HUD updates.
 *
 * Big HUD numbers (ammo, health, armor, frags) render via the STBIG color
 * font — see `generate/build-stbig-color-font.py` and `@font-face` in
 * reset.css. Update path is straightforward: stringify the value and
 * write it to the .hud-number element's textContent. The font handles
 * digit shapes, the dark-red outline, and the % / minus glyphs.
 *
 * Per-type ammo counts and maximums still use CSS custom properties on
 * the pane's status container (separate sprite-based rendering for the
 * small yellow STYSNUM digits — different font, not yet migrated).
 *
 * Each renderer caches its previously-written values in `renderer._hudPrev`
 * so unchanged values skip DOM touches.
 */

import { WEAPONS } from '../game/constants.js';

const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'];
const KEY_COLORS = ['blue', 'yellow', 'red'];
const KEY_CLASSES = { blue: 'has-blue-key', yellow: 'has-yellow-key', red: 'has-red-key' };

function freshPrev() {
    return {
        ammo: -1, health: -1, armor: -1, faceRow: -1,
        bullets: -1, shells: -1, rockets: -1, cells: -1,
        maxBullets: -1, maxShells: -1, maxRockets: -1, maxCells: -1,
        // NaN sentinel — different from any real score so the first
        // updateHud always writes the digit elements.
        frags: NaN,
    };
}

// Pre-built class name strings to avoid per-frame template literal allocation
const WEAPON_CLASSES = { 2: 'has-weapon-2', 3: 'has-weapon-3', 4: 'has-weapon-4', 5: 'has-weapon-5', 6: 'has-weapon-6', 7: 'has-weapon-7' };

export function updateHud(renderer, player) {
    const statusEl = renderer.statusEl;
    const style = statusEl.style;
    const rendererEl = renderer.rendererEl;

    let prev = renderer._hudPrev;
    if (!prev) {
        prev = freshPrev();
        renderer._hudPrev = prev;
    }

    const weapon = WEAPONS[player.currentWeapon];
    const currentAmmo = weapon.ammoType ? Math.round(player.ammo[weapon.ammoType]) : 0;
    const currentHealth = Math.round(player.health);
    const currentArmor = Math.round(player.armor);

    if (currentAmmo !== prev.ammo) {
        prev.ammo = currentAmmo;
        const ammoEl = statusEl.querySelector('.hud-section-ammo .hud-number');
        if (ammoEl) ammoEl.textContent = String(currentAmmo);
    }

    if (currentHealth !== prev.health) {
        prev.health = currentHealth;
        const healthEl = statusEl.querySelector('.hud-section-health .hud-number');
        if (healthEl) healthEl.textContent = `${currentHealth}%`;

        const faceRow = currentHealth >= 80 ? 0 : currentHealth >= 60 ? 1 : currentHealth >= 40 ? 2 : currentHealth >= 20 ? 3 : 4;
        if (faceRow !== prev.faceRow) {
            prev.faceRow = faceRow;
            style.setProperty('--face-row', faceRow);
        }
    }

    if (currentArmor !== prev.armor) {
        prev.armor = currentArmor;
        const armorEl = statusEl.querySelector('.hud-section-armor .hud-number');
        if (armorEl) armorEl.textContent = `${currentArmor}%`;
    }

    // Per-type ammo counts and maximums — rendered with the STYSN font
    // via textContent on the per-row .ammo-cur / .ammo-max output elements.
    for (const type of AMMO_TYPES) {
        const cur = Math.round(player.ammo[type]);
        if (cur !== prev[type]) {
            prev[type] = cur;
            const curEl = statusEl.querySelector(`.ammo-row[data-ammo="${type}"] .ammo-cur`);
            if (curEl) curEl.textContent = String(cur);
        }

        const max = player.maxAmmo[type];
        const maxKey = `max${type[0].toUpperCase()}${type.slice(1)}`;
        if (max !== prev[maxKey]) {
            prev[maxKey] = max;
            const maxEl = statusEl.querySelector(`.ammo-row[data-ammo="${type}"] .ammo-max`);
            if (maxEl) maxEl.textContent = String(max);
        }
    }

    // Weapon ownership — per-pane, reflecting this player's weapons.
    // Master passes the live Player (ownedWeapons is a Set); a client
    // receives the same field as an Array off the wire (Set doesn't
    // survive JSON.stringify — see commands.js stripHudData). Normalize
    // here so both calling conventions work.
    const owned = player.ownedWeapons instanceof Set
        ? player.ownedWeapons
        : new Set(player.ownedWeapons ?? []);
    for (let weaponSlot = 2; weaponSlot <= 7; weaponSlot++) {
        rendererEl.classList.toggle(WEAPON_CLASSES[weaponSlot], owned.has(weaponSlot));
    }

    // Collected keys — same Set-or-Array normalization, then toggle
    // the per-color CSS class so the status-bar key icons appear.
    const keys = player.collectedKeys instanceof Set
        ? player.collectedKeys
        : new Set(player.collectedKeys ?? []);
    for (const color of KEY_COLORS) {
        rendererEl.classList.toggle(KEY_CLASSES[color], keys.has(color));
    }

    // DM frags counter (only meaningful in deathmatch; cheap to update
    // unconditionally — display clamps to -9..99 even though player.score
    // is uncapped).
    if (player.score !== prev.frags) {
        prev.frags = player.score;
        updateFragsDisplay(statusEl, player.score);
    }
}

function updateFragsDisplay(statusEl, score) {
    // Display range clamped to -9..99 (the slot is 2 chars wide + an
    // optional leading minus). Underlying player.score is uncapped.
    const display = Math.max(-9, Math.min(99, score));
    const fragsEl = statusEl.querySelector('.frags-display');
    if (!fragsEl) return;
    fragsEl.textContent = String(display);
}

