/**
 * Menu — level / skill / mode selection overlay (UI only).
 *
 * Renders the buttons, owns menu open/close, and routes clicks into the
 * mode coordinator (`src/mode.js`) and the map loader (`shared/maps/index.js`).
 * No game-state, renderer, audio, or networking logic lives here.
 */

import { state } from '../game/state.js';
import { currentMap, MAPS } from '../shared/maps/index.js';
import { switchMode } from '../mode.js';
import { app } from '../app.js';

const menuLevelList = document.querySelector('.menu-level-list');
const menuButton = document.getElementById('menu-button');
const menuOverlay = document.getElementById('menu-overlay');

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
        // Route through app.startLocalGame so the held Game gets
        // properly torn down (Game.stop clears the intermission
        // overlay + onAdvance callback, hides results, etc.) and a
        // fresh Game is constructed with the picked map as mapCursor.
        app.startLocalGame({
            gameMode: state.gameMode,
            networkMode: state.networkMode,
            skillLevel: state.skillLevel ?? 1,
            rules: null,
            startMap: name,
        });
        updateMenuSelection();
        toggleMenu(false);
    });

    menuLevelList.appendChild(btn);
}

// Skill buttons. Like the level picker, route through
// app.startLocalGame so the held Game is reconstructed cleanly
// rather than leaving stale state around.
document.querySelectorAll('.menu-skill').forEach(btn => {
    btn.addEventListener('click', () => {
        state.skillLevel = parseInt(btn.dataset.skill);
        app.startLocalGame({
            gameMode: state.gameMode,
            networkMode: state.networkMode,
            skillLevel: state.skillLevel,
            rules: null,
            startMap: currentMap ?? 'E1M1',
        });
        updateMenuSelection();
        toggleMenu(false);
    });
});

// Mode buttons (Local section — singleplayer / deathmatch)
document.querySelectorAll('.menu-mode').forEach(btn => {
    btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === currentModeName()) {
            toggleMenu(false);
            return;
        }
        switchMode(mode);
        updateMenuSelection();
        toggleMenu(false);
    });
});

/**
 * Resolve the current (gameMode, networkMode) pair back to the menu's
 * single-string mode identifier ('singleplayer' / 'deathmatch' /
 * 'network'), so the menu's button data-mode strings stay the source
 * of truth for "is this button active".
 */
function currentModeName() {
    if (state.networkMode === 'host') return 'network';
    return state.gameMode;
}

// Network action buttons. These aren't persistent modes — they're
// one-shot actions on the master's session. START switches to network
// hosting; JOIN prompts for a room code and navigates the current
// window into client-window mode.
document.querySelectorAll('.menu-action').forEach(btn => {
    btn.addEventListener('click', () => {
        const action = btn.dataset.network;
        if (action === 'start') {
            switchMode('network');
            updateMenuSelection();
            toggleMenu(false);
        } else if (action === 'join') {
            const code = prompt('Enter room code:');
            if (code) {
                const cleaned = code.trim().toUpperCase();
                // Must match the Worker regex; we generate from a
                // 27-char subset of the same set, but a user typing a
                // code by hand could include any A-Z0-9. Accept the
                // broader set here.
                if (/^[A-Z0-9]{4,8}$/.test(cleaned)) {
                    // Navigate the current window into Network DM
                    // remote mode — index.js parses ?join=CODE and
                    // routes to initClientWindow with the room code.
                    location.href = `?join=${cleaned}`;
                    return;
                }
                alert('Invalid room code');
            }
            toggleMenu(false);
        }
    });
});

export function updateMenuSelection() {
    document.querySelectorAll('.menu-level').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.map === currentMap);
    });
    document.querySelectorAll('.menu-skill').forEach(btn => {
        btn.classList.toggle('active', parseInt(btn.dataset.skill) === state.skillLevel);
    });
    document.querySelectorAll('.menu-mode').forEach(btn => {
        btn.classList.toggle('active', btn.dataset.mode === currentModeName());
    });
}

// ============================================================================
// Menu state & toggle
// ============================================================================

/**
 * Single source of truth: App.MENU. Menu open/close state is owned by
 * the App state machine; this module only renders the overlay DOM in
 * response to toggleMenu and reads back from App when asked.
 */
export function isMenuOpen() {
    return app._state === 'MENU';
}

export function toggleMenu(show) {
    if (show === isMenuOpen()) return;

    if (show) {
        menuOverlay.hidden = false;
        menuOverlay.classList.add('showing');

        // Force layout so the browser captures the "before" state
        menuOverlay.offsetHeight;
        menuOverlay.classList.remove('showing');
        updateMenuSelection();

        // App.openMenu transitions App into MENU (which flips
        // isMenuOpen) and pauses the held Game. App.openMenu also
        // records previousState so closeMenu knows where to return to.
        app.openMenu();
    } else {
        menuOverlay.classList.add('hiding');
        menuOverlay.addEventListener('transitionend', function onEnd() {
            menuOverlay.removeEventListener('transitionend', onEnd);
            menuOverlay.hidden = true;
            menuOverlay.classList.remove('hiding');
        });

        // App.closeMenu resolves where to return to:
        //   previousState='IN_GAME' → resume the held Game.
        //   previousState='ATTRACT' → start a fresh Game (reserved;
        //                             not reachable today).
        //   previousState='BOOT'    → no-op.
        // Fire-and-forget; closeMenu is async only for the ATTRACT
        // branch's startLocalGame.
        app.closeMenu();
    }
}

menuButton.addEventListener('click', () => {
    toggleMenu(!isMenuOpen());
});

menuOverlay.addEventListener('click', (e) => {
    if (!e.target.closest('#menu-content') && !e.target.closest('#menu-about')) {
        toggleMenu(false);
    }
});
