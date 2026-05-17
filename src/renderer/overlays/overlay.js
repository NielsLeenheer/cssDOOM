/**
 * Loading overlay transitions.
 */

export async function showLevelTransition() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.add('level-transition', 'visible');
    await new Promise(r => setTimeout(r, 600));
}

export function hideLevelTransition() {
    const overlay = document.getElementById('loading-overlay');
    overlay.classList.remove('visible');
    overlay.addEventListener('transitionend', () => {
        overlay.classList.remove('level-transition');
    }, { once: true });
}

export function hideInitialOverlay() {
    document.getElementById('loading-overlay').classList.remove('visible');
}
