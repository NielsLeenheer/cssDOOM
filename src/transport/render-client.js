/**
 * RenderClient — the receiving end in a client window (Local DM
 * secondary or Network DM remote).
 *
 * Subscribes to a Transport and delegates incoming envelopes through
 * the local Orchestrator: per-pane commands via the orchestrator's
 * per-pane prototype method (which fans to every target whose
 * playerIndex matches — the local CSSRenderer + the local
 * AudioRenderer if `updateCamera` is the call), world commands via
 * the world prototype method. `playSound` is one of the world
 * commands — the client window's AudioRenderers handle the playback;
 * the joiner has no sinks of its own, so the dispatch stops here.
 *
 * While a `loadMap` is rebuilding the local scene, every other
 * incoming command envelope is QUEUED and replayed once the rebuild
 * resolves. Without this, commands that arrive mid-rebuild apply
 * against the half-torn-down scene state and are then wiped by the
 * rebuild's absorb step (`sceneEl.replaceChildren` +
 * `Object.assign(sceneState)`). The canonical victim: master's
 * `awaitAllReadyToPlay` times out on a slow joiner and
 * `broadcastPlayerSprites`' createPlayerSprite envelopes land
 * mid-load — the joiner then permanently lacks the player billboards
 * (nothing re-fires createPlayerSprite during a match). The same
 * window exists on every non-coordinated load path (swapLevel via
 * attract / debug / match-restart fallback), which never waits for
 * joiners at all.
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
        // True while a loadMap dispatch is rebuilding the local scene.
        // Command envelopes arriving during the rebuild are buffered in
        // `_pending` and replayed (in arrival order) once it resolves.
        this._loading = false;
        this._pending = [];
        this._unsubscribe = this.channel.onMessage((msg) => this._handle(msg));
    }

    _handle(msg) {
        if (!msg || typeof msg !== 'object') return;
        if (msg.type !== MSG.CMD_PLAYER && msg.type !== MSG.CMD_WORLD) {
            // Handshake / lifecycle messages are handled by a separate
            // connection manager that wraps this class.
            return;
        }
        if (this._loading) {
            this._pending.push(msg);
            return;
        }
        this._apply(msg);
    }

    _apply(msg) {
        if (msg.type === MSG.CMD_PLAYER) {
            // Player-addressed commands are scoped to a specific
            // slot; ignore messages for slots we don't represent.
            // Future multi-remote shares one channel across
            // multiple secondaries — each filters by its own slot.
            if (msg.slot !== this.slotIndex) return;
            this.orchestrator.dispatch({
                type: 'player',
                slot: msg.slot,
                cmd: msg.cmd,
                args: msg.args,
            });
            return;
        }

        const result = this.orchestrator.dispatch({
            type: 'world',
            cmd: msg.cmd,
            args: msg.args,
        });
        // loadMap is the only world command on the joiner that
        // needs a follow-up: master's awaitAllReadyToPlay polls
        // session.readyToPlay, which the joiner satisfies by
        // sending MSG.READY_TO_PLAY after its local scene
        // rebuild resolves. orchestrator.dispatch returns the
        // Promise.all of per-target results — on the joiner
        // that's the single local CSSRenderer, so awaiting it
        // is awaiting scene.loadMap's clear + maps.load + build
        // + absorb + warmup chain. `.finally` so the signal
        // still fires on failure (master proceeds; joiner's
        // pane may be blank) — better than master timing out.
        //
        // Queued envelopes are replayed BEFORE READY_TO_PLAY goes
        // out: they were sent before master saw us ready, so
        // applying them first preserves master's send order.
        if (msg.cmd === 'loadMap') {
            this._loading = true;
            Promise.resolve(result)
                .catch((err) => console.warn('[render-client] loadMap failed:', err))
                .finally(() => {
                    this._loading = false;
                    this._drainPending();
                    this.channel.send({ type: MSG.READY_TO_PLAY });
                });
        }
    }

    /**
     * Replay envelopes buffered during a scene rebuild, in arrival
     * order. If the queue itself contains another loadMap, applying it
     * flips `_loading` back on — the loop stops and the remainder
     * stays queued until that rebuild's own drain.
     */
    _drainPending() {
        while (this._pending.length && !this._loading) {
            this._apply(this._pending.shift());
        }
    }
}
