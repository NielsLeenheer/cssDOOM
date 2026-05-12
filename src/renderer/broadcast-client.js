/**
 * BroadcastClient — the receiving end in the secondary window.
 *
 * Listens on the BroadcastChannel and dispatches incoming envelopes to a
 * local DomRenderer (per-pane commands) and the local Orchestrator (world
 * commands).
 *
 * Renderer-state mirroring (keeping `rendererState.cameras[i]` and
 * `rendererState.things[i]` in sync with the master so the local culling
 * loop sees current values) is handled inline below by calling the apply*
 * functions from [renderer-state.js](renderer-state.js) before forwarding
 * the command to the renderer.
 *
 * This class only handles message dispatch. Connection lifecycle
 * (announce, handshake, snapshot replay, heartbeat, disconnect) is
 * layered on top of this in a separate module.
 */

import { MSG } from './broadcast-protocol.js';
import {
    applyCameraUpdate,
    applyThingPositionUpdate,
    applyThingCollected,
} from './renderer-state.js';

export class BroadcastClient {
    /**
     * @param {BroadcastChannel} channel
     * @param {number} slotIndex   master-side slot this secondary represents
     * @param {object} domRenderer  the secondary's local DomRenderer
     * @param {object} orchestrator the secondary's local Orchestrator (for world commands)
     */
    constructor(channel, slotIndex, domRenderer, orchestrator) {
        this.channel = channel;
        this.slotIndex = slotIndex;
        this.domRenderer = domRenderer;
        this.orchestrator = orchestrator;
        this.channel.addEventListener('message', (event) => this._handle(event.data));
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
        if (method === 'updateCamera') {
            applyCameraUpdate(target, args[0]);
        }

        const fn = this.domRenderer[method];
        if (typeof fn === 'function') {
            fn.apply(this.domRenderer, args);
        } else {
            console.warn(`BroadcastClient: unknown pane method '${method}'`);
        }
    }

    _dispatchWorldCommand({ method, args }) {
        switch (method) {
            case 'updateThingPosition': {
                const [thingIndex, x, y, floorHeight] = args;
                applyThingPositionUpdate(thingIndex, x, y, floorHeight);
                break;
            }
            case 'collectItem':
            case 'killEnemy':
                applyThingCollected(args[0], true);
                break;
            case 'uncollectItem':
                applyThingCollected(args[0], false);
                break;
            default:
                break;
        }

        const fn = this.orchestrator[method];
        if (typeof fn === 'function') {
            fn.apply(this.orchestrator, args);
        } else {
            console.warn(`BroadcastClient: unknown world method '${method}'`);
        }
    }
}
