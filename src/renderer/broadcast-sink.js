/**
 * BroadcastSink — a render target that forwards commands over a
 * BroadcastChannel instead of painting DOM.
 *
 * Per-pane methods are generated from the command registry
 * ([commands.js](commands.js)) at module load. Each method serializes
 * its args (via the registry's optional `serialize`, used to strip
 * non-cloneable refs like player objects) and posts a `cmd-pane`
 * envelope. The receiving side (`BroadcastClient`) deserializes and
 * dispatches to its local DomRenderer.
 *
 * From the orchestrator's perspective, BroadcastSink and DomRenderer are
 * interchangeable for per-pane commands: same method names, same arity.
 *
 * World commands are forwarded separately via `forwardWorld(method, args)`
 * — see Orchestrator's world dispatch for the call site. The master also
 * applies the world command locally (helpers iterate every pane); the
 * sink still forwards because the secondary window has its own DOM tree
 * and needs its own copy of the update.
 */

import { MSG } from './broadcast-protocol.js';
import { PER_PANE_COMMANDS } from './commands.js';

export class BroadcastSink {
    /**
     * @param {BroadcastChannel} channel  shared channel
     * @param {number} paneIndex          master-side pane this sink represents
     */
    constructor(channel, paneIndex) {
        this.channel = channel;
        this.paneIndex = paneIndex;
    }

    /** Post a per-pane command envelope. */
    _post(method, args) {
        this.channel.postMessage({
            type: MSG.CMD_PANE,
            target: this.paneIndex,
            method,
            args,
        });
    }

    /** Post a world-command envelope (called from the orchestrator). */
    forwardWorld(method, args) {
        this.channel.postMessage({
            type: MSG.CMD_WORLD,
            method,
            args,
        });
    }
}

for (const [name, { serialize }] of Object.entries(PER_PANE_COMMANDS)) {
    BroadcastSink.prototype[name] = function (...args) {
        const wireArgs = serialize ? serialize(...args) : args;
        this._post(name, wireArgs);
    };
}
