/**
 * RenderSink — a render target that forwards commands over a `Transport`
 * instead of painting DOM.
 *
 * Per-pane methods are generated from the command registry
 * ([../renderer/commands.js](../renderer/commands.js)) at module load.
 * Each method serializes its args (via the registry's optional
 * `serialize`, used to strip non-cloneable refs like player objects)
 * and posts a `cmd-pane` envelope. The receiving side (`RenderClient`)
 * deserializes and dispatches to its local DomRenderer.
 *
 * From the orchestrator's perspective, RenderSink and DomRenderer are
 * interchangeable for per-pane commands: same method names, same arity.
 *
 * World commands are forwarded separately via `forwardWorld(method, args)`
 * — see Orchestrator's world dispatch for the call site. The master also
 * applies the world command locally (helpers iterate every pane); the
 * sink still forwards because the secondary window has its own DOM tree
 * and needs its own copy of the update.
 */

import { MSG } from './protocol.js';
import { PER_PANE_COMMANDS } from '../renderer/commands.js';

export class RenderSink {
    /**
     * @param {{send: (msg: object) => void}} channel  Transport instance
     *        shared with the corresponding Connection on the receiving
     *        side. Only `send` is used here — sinks never receive.
     * @param {number} paneIndex   master-side pane this sink represents.
     */
    constructor(channel, paneIndex) {
        this.channel = channel;
        this.paneIndex = paneIndex;
    }

    /** Post a per-pane command envelope. */
    _post(method, args) {
        this.channel.send({
            type: MSG.CMD_PANE,
            target: this.paneIndex,
            method,
            args,
        });
    }

    /** Post a world-command envelope (called from the orchestrator). */
    forwardWorld(method, args) {
        this.channel.send({
            type: MSG.CMD_WORLD,
            method,
            args,
        });
    }
}

for (const [name, { serialize }] of Object.entries(PER_PANE_COMMANDS)) {
    RenderSink.prototype[name] = function (...args) {
        const wireArgs = serialize ? serialize(...args) : args;
        this._post(name, wireArgs);
    };
}
