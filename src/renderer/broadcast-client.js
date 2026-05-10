/**
 * BroadcastClient — the receiving end in the secondary window.
 *
 * Listens on the BroadcastChannel and dispatches incoming envelopes to a
 * local DomRenderer (per-pane commands) and the local Orchestrator (world
 * commands).
 *
 * Bonus job: when an updateCamera message arrives, the client also writes
 * the transform fields back into state.players[target] on the secondary.
 * The secondary's cullingLoop reads state.players[i].x/y/angle for the
 * frustum check; without this sync, those fields would be frozen at the
 * spawn-time values and the secondary would cull as if the player never
 * moved.
 *
 * This class only handles message dispatch. Connection lifecycle (announce,
 * handshake, snapshot replay, heartbeat, disconnect) is layered on top of
 * this in a follow-on pass.
 */

import { MSG } from './broadcast-protocol.js';
import { state } from '../game/state.js';

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
            // Handshake / lifecycle messages are handled by a future
            // connection manager that wraps this class.
            default:
                break;
        }
    }

    _dispatchPaneCommand({ target, method, args }) {
        // Side-effect: keep the local game state's player position in sync
        // with the master's broadcasts, so the secondary's culling loop
        // (which reads state.players[i].x/y/angle for the frustum check)
        // sees current positions.
        if (method === 'updateCamera' && args[0] && state.players[target]) {
            const t = args[0];
            const player = state.players[target];
            player.x = t.x;
            player.y = t.y;
            player.z = t.z;
            player.angle = t.angle;
            player.floorHeight = t.floorHeight ?? player.floorHeight;
            player.isFiring = t.isFiring;
        }

        const fn = this.domRenderer[method];
        if (typeof fn === 'function') {
            fn.apply(this.domRenderer, args);
        } else {
            console.warn(`BroadcastClient: unknown pane method '${method}'`);
        }
    }

    _dispatchWorldCommand({ method, args }) {
        // Side-effects: apply known game-state mutations on the secondary
        // so the local culling loop sees the same world the master sees.
        // Without this, dynamic things (the opposing player's billboard,
        // moving enemies) get culled against their stale spawn position
        // and pop in/out as the master moves them.
        applyWorldStateSideEffect(method, args);

        const fn = this.orchestrator[method];
        if (typeof fn === 'function') {
            fn.apply(this.orchestrator, args);
        } else {
            console.warn(`BroadcastClient: unknown world method '${method}'`);
        }
    }
}

function applyWorldStateSideEffect(method, args) {
    switch (method) {
        case 'updateThingPosition': {
            const [thingIndex, x, y, floorHeight] = args;
            const thing = state.things[thingIndex];
            if (thing) {
                thing.x = x;
                thing.y = y;
                if (floorHeight !== undefined) thing.floorHeight = floorHeight;
            }
            break;
        }
        case 'collectItem':
        case 'killEnemy': {
            const [thingIndex] = args;
            const thing = state.things[thingIndex];
            if (thing) thing.collected = true;
            break;
        }
        case 'uncollectItem': {
            const [thingIndex] = args;
            const thing = state.things[thingIndex];
            if (thing) thing.collected = false;
            break;
        }
        default:
            break;
    }
}
