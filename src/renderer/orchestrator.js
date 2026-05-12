/**
 * Orchestrator — the renderer-side dispatcher that game code talks to.
 *
 * Owns a list of render targets (DomRenderer instances; future:
 * BroadcastSink). All command methods are generated from the registry
 * in [commands.js](commands.js):
 *
 *   Per-pane commands — game code passes a paneIndex; the orchestrator
 *   forwards to the matching target. The target's per-pane methods don't
 *   take a paneIndex (it's `this.paneIndex` inside).
 *
 *   World commands — no paneIndex. The orchestrator calls the registered
 *   impl once. Today those helpers iterate every pane internally, so a
 *   single call updates the world in every pane in lockstep. The
 *   orchestrator additionally fans out to every registered sink so
 *   secondary windows can mirror the same world change.
 *
 * The public API surface mirrors what `src/renderer/index.js` exported
 * before the orchestrator refactor — flat function names, paneIndex /
 * playerIndex as the first argument for per-player commands. Game code
 * is unchanged.
 */

import { DomRenderer } from './dom-renderer.js';
import { PER_PANE_COMMANDS, WORLD_COMMANDS } from './commands.js';
import {
    clonePanes as clonePanesHelper,
    setMirrorMode as setMirrorModeHelper,
    isMirrorMode as isMirrorModeHelper,
    viewportsForEffect as viewportsForEffectHelper,
} from './scene/scene.js';

class Orchestrator {
    constructor() {
        // Default registration: one DomRenderer per pane in the current
        // sceneStates layout (always 2 in current HTML). Two-window mode
        // swaps one of these for a BroadcastSink via replaceTarget().
        this.targets = [new DomRenderer(0), new DomRenderer(1)];
    }

    /** Returns the target for a given pane index, or null if out of range. */
    target(paneIndex) {
        return this.targets[paneIndex] ?? null;
    }

    /**
     * Swap the target at a given pane index. Used to install a BroadcastSink
     * when a secondary window connects, and to swap back to a DomRenderer
     * when it disconnects. The replaced instance is returned in case the
     * caller wants to keep it around (e.g. to restore on disconnect).
     */
    replaceTarget(paneIndex, target) {
        const previous = this.targets[paneIndex];
        this.targets[paneIndex] = target;
        return previous;
    }

    /** All sink targets currently registered (used to fan out world commands). */
    _sinks() {
        const out = [];
        for (const t of this.targets) {
            if (t && typeof t.forwardWorld === 'function') out.push(t);
        }
        return out;
    }

    /** Forward a world command to all registered sinks. */
    _broadcastWorld(method, args) {
        for (const sink of this._sinks()) sink.forwardWorld(method, args);
    }

    // ── Scene controls (orchestrator-only, no per-target dispatch) ───────

    clonePanes(paneCount) { clonePanesHelper(paneCount); }
    setMirrorMode(value) { setMirrorModeHelper(value); }
    isMirrorMode() { return isMirrorModeHelper(); }
    viewportsForEffect(playerIndex) { return viewportsForEffectHelper(playerIndex); }

}

// Per-pane commands: route to one target by paneIndex. Target's method
// (DomRenderer or BroadcastSink) is responsible for everything past the
// paneIndex argument.
for (const name of Object.keys(PER_PANE_COMMANDS)) {
    Orchestrator.prototype[name] = function (paneIndex, ...args) {
        this.targets[paneIndex]?.[name](...args);
    };
}

// World commands: invoke local impl, then fan out to every sink so
// secondary windows mirror the change.
for (const [name, { impl }] of Object.entries(WORLD_COMMANDS)) {
    Orchestrator.prototype[name] = function (...args) {
        impl(...args);
        this._broadcastWorld(name, args);
    };
}

export const orchestrator = new Orchestrator();
