/**
 * RenderSink — a render target that forwards every command over a
 * `Transport` instead of painting DOM. Sinks live alongside
 * DomRenderers in the orchestrator's target list and represent
 * remote clients (Network DM joiners, Local DM secondary).
 *
 * Sinks override `dispatch` once instead of defining a method per
 * command. The override picks the wire envelope shape based on
 * `kind` — per-pane envelopes carry `target: paneIndex` so the
 * receiver knows which pane to apply against; world envelopes don't.
 * The receiving side (`RenderClient`) reads the envelope and calls
 * the matching method on its local DomRenderer.
 */

import { MSG } from './protocol.js';
import { RendererBase } from '../renderer/renderer-base.js';

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
        // distinguish RenderSinks from local DomRenderers instead of
        // duck-typing on method existence.
        this.kind = 'sink';

        this.channel = channel;
        this.paneIndex = paneIndex;
        // A sink represents one slot, which is one player position.
        // The orchestrator's per-player dispatch matches against this.
        this.playerIndex = paneIndex;
    }

    /**
     * Orchestrator entry point — forwards every command verbatim to
     * the wire. Per-pane envelopes carry `target: paneIndex` so the
     * receiver routes to the right pane; world envelopes don't.
     */
    dispatch(kind, command, args) {
        if (kind === 'per-pane') {
            this.channel.send({
                type: MSG.CMD_PANE,
                target: this.paneIndex,
                method: command,
                args,
            });
        } else {
            this.channel.send({
                type: MSG.CMD_WORLD,
                method: command,
                args,
            });
        }
    }
}
