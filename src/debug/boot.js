/**
 * Debug bootstrap shim — the ONLY debug code in the main bundle.
 *
 * Everything else (features, console commands, menu, CSS) lives in the lazily
 * imported ./bootstrap.js chunk, so a production page that never opens the debug
 * menu downloads none of it. On the dev server we bootstrap immediately; in
 * production we install a `window.debug` accessor that bootstraps the first time
 * the user types `debug` in the console.
 */

let bootPromise = null;
/** Idempotently load + run the debug chunk. Returns the cached promise. */
export function bootstrapDebug() {
    if (!bootPromise) bootPromise = import('./bootstrap.js').then((m) => m.bootstrap());
    return bootPromise;
}

// Callable placeholder returned by the window.debug getter before the real
// console surface has loaded. Invoking debug() during the load queues the menu
// to open once ready; a bare `debug` prints the hint via toString. Declared as a
// hoisted function so the getter can reference it with no temporal-dead-zone risk.
function debugStub() {
    return bootstrapDebug().then(() => window.debug());
}
debugStub.toString = () => '[debug] loading… run debug() again once it is ready.';

/**
 * Wire up bootstrapping. DEV: load the debug chunk now (the menu auto-opens).
 * PROD: install a `window.debug` accessor whose getter triggers the load on
 * first access and returns the stub; console.js's top-level `window.debug = …`
 * then hits the setter, which redefines the property to the real callable (a
 * plain value descriptor), so later access skips the accessor entirely.
 */
export function installDebugTrigger() {
    if (import.meta.env.DEV) {
        bootstrapDebug();
        return;
    }
    try {
        Object.defineProperty(window, 'debug', {
            configurable: true,
            get() {
                console.log('[debug] loading…');
                bootstrapDebug();
                return debugStub;
            },
            set(value) {
                Object.defineProperty(window, 'debug', { value, configurable: true, writable: true });
            },
        });
    } catch {
        // window locked down in some environment — fall back to eager bootstrap
        // so debug stays reachable.
        bootstrapDebug();
    }
}
