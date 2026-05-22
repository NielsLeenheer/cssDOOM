/**
 * Initial boot splash — the black `#loading-overlay` with the DOOM
 * logo shown until App.start completes its boot sequence. Window-
 * level UI: no panes exist yet at boot, the splash covers the whole
 * window. Called once from master.js and remote-game.js after boot
 * is far enough that it's safe to reveal the scene.
 *
 * `setLoadingStatus` paints a single line of text beneath the logo —
 * used by the joiner's connect phase to communicate progress / failure
 * while the splash is still up (CONNECTING, WAITING FOR HOST,
 * CONNECTION FAILED). Pass `''` (or nothing) to clear.
 */

export function hideInitialOverlay() {
    document.getElementById('loading-overlay').classList.remove('visible');
}

export function setLoadingStatus(text = '') {
    const el = document.getElementById('loading-status');
    if (el) el.textContent = text;
}
