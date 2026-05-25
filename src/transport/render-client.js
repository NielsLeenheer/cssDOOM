/**
 * RenderClient — the receiving end in a client window (Local DM
 * secondary or Network DM remote).
 *
 * Subscribes to a Transport and delegates incoming envelopes through
 * the local Orchestrator: per-pane commands via the orchestrator's
 * per-pane prototype method (which fans to every target whose
 * playerIndex matches — the local DomRenderer + the local
 * AudioRenderer if `updateCamera` is the call), world commands via
 * the world prototype method. `playSound` is one of the world
 * commands — the client window's AudioRenderers handle the playback;
 * the joiner has no sinks of its own, so the dispatch stops here.
 *
 * This class only handles message dispatch. Connection lifecycle
 * (announce, handshake, heartbeat, disconnect) is layered on top of
 * this in [peer-connection.js](peer-connection.js).
 */

import { MSG } from './protocol.js';

export class RenderClient {
    /**
     * @param {{onMessage: (cb: (msg: object) => void) => () => void}} channel
     *        Transport instance shared with the master-side connection.
     * @param {number} slotIndex     master-side slot this client represents
     * @param {object} orchestrator  the client's local Orchestrator (fans
     *                               every dispatch to its targets)
     */
    constructor(channel, slotIndex, orchestrator) {
        this.channel = channel;
        this.slotIndex = slotIndex;
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
        // Delegate through the orchestrator so its per-pane fan-out
        // dispatches to every target at the addressed slot — the
        // local DomRenderer plus the local AudioRenderer for commands
        // both kinds answer (like updateCamera). Same mechanism master
        // uses when its own game code calls orchestrator.dispatch(...).
        this.orchestrator.dispatch('per-pane', method, target, ...args);
    }

    _dispatchWorldCommand({ method, args }) {
        const result = this.orchestrator.dispatch('world', method, ...args);

        // loadMap is the only world command on the joiner that needs a
        // follow-up: master's awaitAllReadyToPlay polls session.readyToPlay,
        // which the joiner satisfies by sending MSG.READY_TO_PLAY after
        // its local scene rebuild resolves. orchestrator.dispatch for
        // a world command returns Promise.all of per-target results —
        // on the joiner that's the single local DomRenderer, so awaiting
        // it is awaiting scene.loadMap's clear + maps.load + build +
        // absorb + warmup chain. `.finally` so the signal still fires
        // on failure (master proceeds; joiner's pane may be blank) —
        // better than master timing out.
        if (method === 'loadMap') {
            Promise.resolve(result)
                .catch((err) => console.warn('[render-client] loadMap failed:', err))
                .finally(() => this.channel.send({ type: MSG.READY_TO_PLAY }));
        }
    }
}
