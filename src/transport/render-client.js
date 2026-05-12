/**
 * RenderClient — the receiving end in a secondary window (or, in future,
 * a network remote).
 *
 * Subscribes to a Transport and dispatches incoming envelopes to a
 * local DomRenderer (per-pane commands) and the local Orchestrator
 * (world commands).
 *
 * Renderer-state mirroring (keeping `rendererState.cameras[i]` and
 * `rendererState.things[i]` in sync with the master so the local culling
 * loop sees current values) is driven by the command registry: each
 * affected entry in [../renderer/commands.js](../renderer/commands.js)
 * declares an optional `mirror` callback that runs here before the
 * renderer dispatch. Adding a new mirrored command is one entry in
 * COMMANDS — no edits here.
 *
 * This class only handles message dispatch. Connection lifecycle
 * (announce, handshake, snapshot replay, heartbeat, disconnect) is
 * layered on top of this in [peer-connection.js](peer-connection.js).
 */

import { MSG } from './protocol.js';
import { PER_PANE_COMMANDS, WORLD_COMMANDS } from '../renderer/commands.js';

export class RenderClient {
    /**
     * @param {{onMessage: (cb: (msg: object) => void) => () => void}} channel
     *        Transport instance shared with the master-side connection.
     * @param {number} slotIndex    master-side slot this secondary represents
     * @param {object} domRenderer  the secondary's local DomRenderer
     * @param {object} orchestrator the secondary's local Orchestrator (for world commands)
     */
    constructor(channel, slotIndex, domRenderer, orchestrator) {
        this.channel = channel;
        this.slotIndex = slotIndex;
        this.domRenderer = domRenderer;
        this.orchestrator = orchestrator;
        this._unsubscribe = this.channel.onMessage((msg) => this._handle(msg));
    }

    _handle(msg) {
        if (!msg || typeof msg !== 'object') return;

        switch (msg.type) {
            case MSG.CMD_PANE:
                // Per-pane commands are addressed to a specific slot; ignore
                // messages for slots we don't represent. Future multi-remote
                // shares one channel across multiple secondaries — each
                // filters by its own slot.
                if (msg.target !== this.slotIndex) return;
                this._dispatchPaneCommand(msg);
                break;
            case MSG.CMD_WORLD:
                this._dispatchWorldCommand(msg);
                break;
            // Handshake / lifecycle messages are handled by a separate
            // connection manager that wraps this class.
            default:
                break;
        }
    }

    _dispatchPaneCommand({ target, method, args }) {
        const cmd = PER_PANE_COMMANDS[method];
        cmd?.mirror?.(target, ...args);

        const fn = this.domRenderer[method];
        if (typeof fn === 'function') {
            fn.apply(this.domRenderer, args);
        } else {
            console.warn(`RenderClient: unknown pane method '${method}'`);
        }
    }

    _dispatchWorldCommand({ method, args }) {
        const cmd = WORLD_COMMANDS[method];
        cmd?.mirror?.(...args);

        const fn = this.orchestrator[method];
        if (typeof fn === 'function') {
            fn.apply(this.orchestrator, args);
        } else {
            console.warn(`RenderClient: unknown world method '${method}'`);
        }
    }
}
