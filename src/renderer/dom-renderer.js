/**
 * DomRenderer — represents one pane's renderer target.
 *
 * Per-pane methods are generated from the command registry
 * ([commands.js](commands.js)) at module load. Each becomes a thin shim
 * that calls the registered impl with `this.paneIndex` baked in:
 *
 *     domRenderer.triggerFlash('damage')
 *       → COMMANDS.triggerFlash.impl(this.paneIndex, 'damage')
 *       → effects.triggerFlash(this.paneIndex, 'damage')
 *
 * World-level commands are NOT instance methods — they live on the
 * Orchestrator and call into the underlying renderer module once. Today
 * those helpers iterate every pane internally, so calling at the
 * orchestrator level updates every pane in lockstep.
 *
 * Implementation note: state (`dom.scenes`, `sceneStates`, etc.) still
 * lives at module scope in dom.js. A follow-on cleanup migrates that
 * state into the instance itself; for now this facade is enough to give
 * the orchestrator a swappable target abstraction (DomRenderer ↔
 * RenderSink) without rewriting twenty renderer files.
 */

import { PER_PANE_COMMANDS } from './commands.js';

export class DomRenderer {
    constructor(paneIndex) {
        this.paneIndex = paneIndex;
    }
}

for (const [name, { impl }] of Object.entries(PER_PANE_COMMANDS)) {
    DomRenderer.prototype[name] = function (...args) {
        return impl(this.paneIndex, ...args);
    };
}
