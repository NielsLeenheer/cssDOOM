/**
 * Disconnected overlay — full-window red banner shown when a client
 * loses contact with master.
 *
 * Tiny single-purpose module: lazily creates the overlay element (and
 * its one CSS rule) on first call, returns the element so the caller
 * can toggle `.visible` to show/hide. Styled inline because there's no
 * other consumer and adding a CSS file for one element is overkill.
 *
 * Sole caller today: `initClientWindow` in `src/client.js`.
 */

export function ensureDisconnectedOverlay() {
    let el = document.getElementById('disconnected-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'disconnected-overlay';
    el.textContent = 'DISCONNECTED — RECONNECTING…';
    Object.assign(el.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,0.85)',
        color: '#ff4444',
        font: 'bold 32px monospace',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '9999',
        letterSpacing: '0.05em',
        textShadow: '0 2px 0 #220000',
        pointerEvents: 'none',
    });
    document.body.appendChild(el);
    const styleId = 'disconnected-overlay-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = '#disconnected-overlay.visible { display: flex; }';
        document.head.appendChild(style);
    }
    return el;
}
