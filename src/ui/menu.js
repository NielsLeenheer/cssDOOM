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

const menuLevelList = document.querySelector('.menu-level-list');

// Build level buttons with HUD digit sprites
for (const name of MAPS) {
    const btn = document.createElement('button');
    btn.className = 'menu-level';
    btn.dataset.map = name;

    // Level number is the last character (e.g. "1" from "E1M1")
    const levelNum = parseInt(name.slice(-1));
    const digit = document.createElement('span');
    digit.className = 'level-digit';
    digit.style.setProperty('--level', levelNum);
    btn.appendChild(digit);

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

/**
 * Switch between single-player and deathmatch. Resizes state.players,
 * updates body[data-mode] (drives split-screen CSS), turns off the debug
 * pane-1 mirror (incompatible with real DM), and reloads the current map
 * so the scene rebuilds with the right number of panes.
 */
function switchMode(mode) {
    // Spectator is single-player only — drop out of it before swapping
    // modes so its body classes and scene transforms don't bleed into DM.
    if (mode === 'deathmatch' && document.body.classList.contains('spectator')) {
        window.spectate?.();
    }

    state.mode = mode;
    document.body.dataset.mode = mode;

    // Resize the players array. SP keeps player 0, DM adds player 1.
    if (mode === 'deathmatch') {
        if (state.players.length < 2) state.players.push(new Player(1));
        resetMatch();
    } else {
        state.players.length = 1;
        clearMatch();
    }

    // The Phase 3 debug mirror is incompatible with real DM (it forces a
    // mirror of player 0 into pane 1; DM wants player 1's own view there).
    setMirrorMode(false);

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
