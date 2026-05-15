/**
 * RemoteGame — the client-window analog of Game.
 *
 * Skeleton only. Bodies land in subsequent L6 steps:
 *   L6.2 — start() / stop() own the transport (ClientConnection +
 *          RenderClient + remote input forwarder).
 *   L6.3 — App.joinRemoteGame constructs RemoteGame; client.js
 *          routes through App.
 *   L6.6 — LOAD_MAP / READY_TO_PLAY handshake handlers.
 *
 * See LIFECYCLE_REFACTOR.md §7b (RemoteGame API) and §12 (Network
 * coordination — the start sequence) for the target contract.
 *
 * RemoteGame is a sibling of Game, not a subclass — they share the
 * same App-facing API surface (start / pause / resume / stop / on)
 * but the implementation behind each method is radically different.
 * RemoteGame owns:
 *   - the wire transport (WebRTC for Network DM, BroadcastChannel
 *     for Local DM secondary);
 *   - a RenderClient that applies inbound renderer commands;
 *   - a local input forwarder that ships gameplay actions over the
 *     wire to master.
 *
 * RemoteGame does NOT own:
 *   - a Level (no per-frame world simulation on the client);
 *   - a roster (state.players on the client is a placeholder for
 *     this remote's own slot);
 *   - a match struct (state.match stays null);
 *   - the gameLoop's updateGame (no world step).
 *
 * Same on/_emit pattern as Game and Level.
 */

export class RemoteGame {
    constructor({ roomCode, orchestrator }) {
        this.roomCode = roomCode;
        this.orchestrator = orchestrator;

        // State machine per §7b:
        //   CONNECTING   — transport opening; awaiting ACK.
        //   CONNECTED    — ACK received; rendering inbound commands.
        //   DISCONNECTED — transport went silent (peer dropped or
        //                  master shut down).
        //   FAILED       — transport never opened (e.g., signaling
        //                  room not found, max retries exhausted).
        this._state = 'CONNECTING';

        // Transport handle + receive-side dispatch + send-side
        // forwarder are populated in start() (L6.2). Null until then.
        this._transport = null;
        this._renderClient = null;
        this._inputForwarder = null;

        this._listeners = new Map();
    }

    async start() { /* L6.2 */ }

    /**
     * Local input gate. Stops the forwarder from shipping ACTION /
     * ANALOG envelopes upstream. Per §7b, RemoteGame.pause does NOT
     * touch the master's world — only the local input gate. The
     * master's broadcast keeps flowing and the visual scene
     * continues to update (paused-state overlays come from master's
     * own Game.pause renderer-command fan-out).
     */
    pause()  { /* L6.2 */ }
    resume() { /* L6.2 */ }

    async stop() { /* L6.2 */ }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
