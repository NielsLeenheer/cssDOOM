/**
 * Per-frame HUD updates via CSS custom properties on each pane's status bar.
 *
 * All HUD values (health, armor, ammo, face row, per-type ammo counts and
 * maximums) are set as custom properties on the pane's status container. CSS
 * then inherits these down to the digit elements, which use calc() to derive
 * individual digit sprite offsets. This keeps all per-element rendering in
 * CSS — JavaScript only touches one DOM element per frame per player.
 *
 * Per-player: each pane has its own status element in dom.statusElements[i]
 * and its own .renderer in dom.renderers[i]. updateHud(player) writes that
 * player's stats to their pane. The prev cache is keyed by player index so
 * unchanged values are skipped per-pane.
 */

import { dom } from './dom.js';
import { WEAPONS } from '../game/constants.js';

const AMMO_TYPES = ['bullets', 'shells', 'rockets', 'cells'];

// Previous values per viewport — only touch the DOM when something changes.
// Keyed by viewportIndex (the destination pane), not player.index, so mirror
// mode (writing player 0's stats to two panes) tracks each pane's own
// last-written values independently.
const prevByViewport = new Map();

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

export function updateHud(player, viewportIndex = player.viewportIndex) {
    const style = dom.statusElements[viewportIndex].style;
    const rendererEl = dom.renderers[viewportIndex];

    let prev = prevByViewport.get(viewportIndex);
    if (!prev) {
        prev = freshPrev();
        prevByViewport.set(viewportIndex, prev);
    }

    const weapon = WEAPONS[player.currentWeapon];
    const currentAmmo = weapon.ammoType ? Math.round(player.ammo[weapon.ammoType]) : 0;
    const currentHealth = Math.round(player.health);
    const currentArmor = Math.round(player.armor);

    if (currentAmmo !== prev.ammo) {
        prev.ammo = currentAmmo;
        style.setProperty('--ammo', currentAmmo);
    }

    if (currentHealth !== prev.health) {
        prev.health = currentHealth;
        style.setProperty('--health', currentHealth);

        const faceRow = currentHealth >= 80 ? 0 : currentHealth >= 60 ? 1 : currentHealth >= 40 ? 2 : currentHealth >= 20 ? 3 : 4;
        if (faceRow !== prev.faceRow) {
            prev.faceRow = faceRow;
            style.setProperty('--face-row', faceRow);
        }
    }

    if (currentArmor !== prev.armor) {
        prev.armor = currentArmor;
        style.setProperty('--armor', currentArmor);
    }

    // Per-type ammo counts and maximums
    for (const type of AMMO_TYPES) {
        const cur = Math.round(player.ammo[type]);
        if (cur !== prev[type]) {
            prev[type] = cur;
            style.setProperty(`--ammo-${type}`, cur);
        }

        const max = player.maxAmmo[type];
        const maxKey = `max${type[0].toUpperCase()}${type.slice(1)}`;
        if (max !== prev[maxKey]) {
            prev[maxKey] = max;
            style.setProperty(`--max-${type}`, max);
        }
    }

    // Weapon ownership — per-pane, reflecting this player's weapons
    for (let weaponSlot = 2; weaponSlot <= 7; weaponSlot++) {
        rendererEl.classList.toggle(WEAPON_CLASSES[weaponSlot], player.ownedWeapons.has(weaponSlot));
    }

    // DM frags counter (only meaningful in deathmatch; cheap to update
    // unconditionally — display clamps to -9..99 even though player.score
    // is uncapped).
    if (player.score !== prev.frags) {
        prev.frags = player.score;
        updateFragsDisplay(viewportIndex, player.score);
    }
}

function updateFragsDisplay(viewportIndex, score) {
    const display = Math.max(-9, Math.min(99, score));
    const isNeg = display < 0;
    const abs = Math.abs(display);
    const tens = Math.floor(abs / 10);
    const ones = abs % 10;

    const status = dom.statusElements[viewportIndex];
    const tensEl = status.querySelector('.frags-tens');
    const onesEl = status.querySelector('.frags-ones');
    if (!tensEl || !onesEl) return;

    if (isNeg) {
        tensEl.dataset.glyph = 'minus';
        tensEl.style.backgroundImage = `url('/assets/hud/STTMINUS.png')`;
    } else if (tens > 0) {
        tensEl.dataset.glyph = 'digit';
        tensEl.style.backgroundImage = `url('/assets/hud/STTNUM${tens}.png')`;
    } else {
        // Single-digit positive — leave the tens slot blank.
        tensEl.dataset.glyph = '';
        tensEl.style.backgroundImage = '';
    }
    onesEl.style.backgroundImage = `url('/assets/hud/STTNUM${ones}.png')`;
}

export function clearWeaponSlots() {
    // Clear weapon ownership classes on every pane.
    for (const rendererEl of dom.renderers) {
        rendererEl.classList.remove(
            'has-weapon-2', 'has-weapon-3', 'has-weapon-4',
            'has-weapon-5', 'has-weapon-6', 'has-weapon-7'
        );
    }
}
