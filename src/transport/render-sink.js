/**
 * RenderSink — a render target that forwards every command over a
 * `Transport` instead of painting DOM. Sinks live alongside
 * CSSRenderers in the orchestrator's target list and represent
 * remote clients (Network DM joiners, Local DM secondary).
 *
 * The orchestrator dispatches a command envelope to each target;
 * the sink ships that same envelope verbatim over the wire. The
 * receiving window's `RenderClient` reads it and dispatches into
 * its own orchestrator — same envelope shape, same routing.
 */

import { MSG } from './protocol.js';
import { RendererBase } from '../renderer/base.js';

export class RenderSink extends RendererBase {
    /**
     * @param {{send: (msg: object) => void}} channel  Transport instance
     *        shared with the corresponding Connection on the receiving
     *        side. Only `send` is used here — sinks never receive.
     * @param {number} paneIndex   master-side pane this sink represents.
     */
    constructor(channel, paneIndex) {
        super();
        // Explicit type marker. Orchestrator uses `target.kind` to
        // distinguish RenderSinks from local CSSRenderers instead of
        // duck-typing on method existence.
        this.kind = 'sink';

        this.channel = channel;
        this.paneIndex = paneIndex;
        // A sink represents one slot, which is one player position.
        // The orchestrator's per-player dispatch matches against this.
        this.playerIndex = paneIndex;
    }

    /**
     * Forward the dispatch envelope verbatim. The wire-level type
     * field is derived from the envelope's dispatch type — the
     * receiving RenderClient discriminates on it the same way our
     * other MSG.* envelopes do.
     */
    dispatch(env) {
        this.channel.send({
            type: env.type === 'player' ? MSG.CMD_PLAYER : MSG.CMD_WORLD,
            slot: env.slot,
            cmd: env.cmd,
            args: env.args,
        });
    }
}
