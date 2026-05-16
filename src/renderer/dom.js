/**
 * Global, never-per-pane UI element refs.
 *
 * Per-pane elements (scene, viewport, renderer, status, weapon) live on
 * each `DomRenderer` instance. The DomRenderer registry + lifecycle
 * lives on `domRendererManager` ([dom-renderer-manager.js]).
 */

export const dom = {
    menuButton: document.getElementById('menu-button'),
    menuOverlay: document.getElementById('menu-overlay'),
    ammoPanel: document.getElementById('ammo-panel'),
};
