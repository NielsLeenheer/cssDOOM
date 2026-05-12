/**
 * Menu — level / skill / mode selection overlay.
 */

import { state } from '../game/state.js';
import { Player } from '../game/player/player.js';
import { currentMap } from '../shared/maps.js';
import { dom } from '../renderer/dom.js';
import { MAPS } from '../shared/maps.js';
import { loadMap } from '../shared/maps.js';
import { setMirrorMode } from '../renderer/scene/scene.js';
import { resetMatch, clearMatch } from '../game/match.js';
import { setDefaultSlot } from '../input/claim-registry.js';

const menuLevelList = document.querySelector('.menu-level-list');

// Build level buttons using the WILV0N intermission level-name sprites
// (HANGAR, NUCLEAR PLANT, …) — the same white sprites the SP intermission
// screen shows above FINISHED, so the menu and intermission stay
// visually consistent.
for (const name of MAPS) {
    const btn = document.createElement('button');
    btn.className = 'menu-level';
    btn.dataset.map = name;

    // E1M{N} → WILV0{N-1}.
    const levelNum = parseInt(name.slice(-1));
    const label = document.createElement('img');
    label.className = 'level-name';
    label.src = `/assets/intermission/WILV0${levelNum - 1}.png`;
    label.alt = name;
    btn.appendChild(label);

    btn.addEventListener('click', () => {
        loadMap(name);
        updateMenuSelection();
        toggleMenu(false);
    });

    menuLevelList.appendChild(btn);
}

// Skill buttons
document.querySelectorAll('.menu-skill').forEach(btn => {
    btn.addEventListener('click', () => {
        state.skillLevel = parseInt(btn.dataset.skill);
        loadMap(currentMap);
        updateMenuSelection();
        toggleMenu(false);
    });
});

// Mode buttons
document.querySelectorAll('.menu-mode').forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === state.mode) return;
        switchMode(mode);
        updateMenuSelection();
        toggleMenu(false);
    });
});

const MODE_STORAGE_KEY = 'cssdoom-mode';

/**
 * Reads the saved mode from localStorage, falling back to 'singleplayer'.
 * Called from boot (index.js) before the initial loadMap so the scene is
 * built with the right pane count from the start.
 */
export function loadSavedMode() {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    return saved === 'deathmatch' ? 'deathmatch' : 'singleplayer';
}

/**
 * Applies a mode to global state without triggering a map reload.
 * Shared between boot-time restore and runtime switching: switchMode
 * calls this and then loads the map; the init path calls this then runs
 * its own initial loadMap('E1M1').
 */
export function applyMode(mode) {
    state.mode = mode;
    document.body.dataset.mode = mode;

    // Resize the players array. SP keeps player 0, DM adds player 1.
    if (mode === 'deathmatch') {
        if (state.players.length < 2) state.players.push(new Player(1));
        resetMatch();
        // DM requires explicit press-to-claim; no default slot.
        setDefaultSlot(null);
    } else {
        state.players.length = 1;
        clearMatch();
        // SP: every input device drives player 0 without a claim ceremony.
        setDefaultSlot(0);
    }

    // Mirror pane 0 → pane 1 in kiosk SP so the right monitor isn't
    // dark. The mirror flag drives both the renderer's per-effect
    // viewport fanout AND the paneCount used at scene build time
    // (maps.js). DM never wants the mirror — pane 1 holds its own
    // player there. Outside kiosk, SP just hides pane 1 via CSS, so
    // mirroring would build an invisible second scene for nothing.
    const isKiosk = document.body.classList.contains('kiosk');
    setMirrorMode(isKiosk && mode === 'singleplayer');
}

/**
 * Switch between single-player and deathmatch at runtime. Persists the
 * choice to localStorage so a refresh restores it, then reloads the
 * current map with the new mode applied.
 */
function switchMode(mode) {
    // Spectator is single-player only — drop out of it before swapping
    // modes so its body classes and scene transforms don't bleed into DM.
    if (mode === 'deathmatch' && document.body.classList.contains('spectator')) {
        window.spectate?.();
    }

    applyMode(mode);
    localStorage.setItem(MODE_STORAGE_KEY, mode);

    // Force a full game state reset by marking player 0 dead before reload.
    // loadMap's resetGameState path then resets every player's stats.
    state.players[0].isDead = true;
    loadMap(currentMap);
}

export function updateMenuSelection() {
    document.querySelectorAll('.menu-level').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.map === currentMap);
    });
    document.querySelectorAll('.menu-skill').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.skill) === state.skillLevel);
    });
    document.querySelectorAll('.menu-mode').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === state.mode);
    });
}

// ============================================================================
// Menu state & toggle
// ============================================================================

let menuOpen = false;

/** Returns true if the menu overlay is currently open. */
export function isMenuOpen() {
    return menuOpen;
}

export function toggleMenu(show) {
    if (show === menuOpen) return;
    menuOpen = show;

    if (show) {
        dom.menuOverlay.hidden = false;
        dom.menuOverlay.classList.add('showing');

        // Force layout so the browser captures the "before" state
        dom.menuOverlay.offsetHeight;
        dom.menuOverlay.classList.remove('showing');
        updateMenuSelection();
    } else {
        dom.menuOverlay.classList.add('hiding');
        dom.menuOverlay.addEventListener('transitionend', function onEnd() {
            dom.menuOverlay.removeEventListener('transitionend', onEnd);
            dom.menuOverlay.hidden = true;
            dom.menuOverlay.classList.remove('hiding');
        });
    }
}

dom.menuButton.addEventListener('click', () => {
    toggleMenu(!menuOpen);
});

dom.menuOverlay.addEventListener('click', (e) => {
    if (e.target === dom.menuOverlay) toggleMenu(false);
});
