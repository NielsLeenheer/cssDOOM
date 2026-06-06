/**
 * Debug bootstrap chunk — the lazy-loaded entry that pulls in the whole debug
 * system. Dynamically imported by ./boot.js (immediately on the dev server, or
 * on first `debug` console access in production). Importing it bundles every
 * debug CSS + JS module into one async chunk that Vite injects only on load, so
 * none of it ships in the initial page.
 */

// CSS — Vite bundles these into this chunk's stylesheet, injected when it loads.
import './ui/panel.css';
import './features/sectors.css';
import './features/layers.css';
import './features/freeze.css';
import './features/isolate.css';
import './features/path-controls.css';
import './features/camera.css';
import './features/sprites.css';

// Side effect: wires window.debug + every debug.* command group.
import './console/console.js';
import { openDebugMenu } from './ui/panel.js';

/**
 * Run once after the chunk loads. On the dev server the menu opens
 * automatically; in production it opens only when the user calls debug().
 */
export function bootstrap() {
    if (import.meta.env.DEV) openDebugMenu();
}
