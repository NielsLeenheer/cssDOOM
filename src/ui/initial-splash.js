/**
 * Initial boot splash — the black `#loading-overlay` with the DOOM
 * logo shown until App.start completes its boot sequence. Window-
 * level UI: no panes exist yet at boot, the splash covers the whole
 * window. Called once from master.js and remote-game.js after boot
 * is far enough that it's safe to reveal the scene.
 */

export function hideInitialOverlay() {
    document.getElementById('loading-overlay').classList.remove('visible');
}
