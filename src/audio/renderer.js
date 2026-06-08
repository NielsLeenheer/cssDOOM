/**
 * AudioRenderer — an orchestrator render target alongside CSSRenderer
 * and RenderSink. Each instance represents one local listener (one
 * local player's pane).
 *
 * Per-player `updateCamera` dispatch lands on the renderer with the
 * matching `playerIndex` (orchestrator-side fan-out keeps its
 * `state.camera` current). World `playSound` dispatch fans to every
 * audio target locally (each runs its own distance / pan math) and
 * to every RenderSink over the wire (the receiving window's
 * orchestrator fans to its own audio targets).
 *
 * **Lifecycle is owned by the orchestrator.** `orchestrator.configureAudio`
 * (re)builds the local listener set; `orchestrator.setAudioEnabled`
 * toggles the master switch. This module only provides the class —
 * Web Audio plumbing (context, unlock, buffers, distance/pan math)
 * lives in [helpers.js](helpers.js).
 */

import { RendererBase } from '../renderer/base.js';
import { isAudioReady, playBuffer, distanceToVolume, bearingToPan } from './helpers.js';

export class AudioRenderer extends RendererBase {
    /**
     * @param {object} cfg
     * @param {number} cfg.slot        listener slot. Per-player
     *                                 updateCamera commands at this
     *                                 slot keep `this.state.camera`
     *                                 current via the orchestrator's
     *                                 playerIndex match.
     * @param {'left'|'right'|null} cfg.paneSide  if set, pan locks to
     *                                            this side; null =
     *                                            bearing-based.
     */
    constructor({ slot, paneSide }) {
        super();
        // Orchestrator target identity. `kind` distinguishes audio
        // targets from CSSRenderer ('dom') and RenderSink ('sink') in
        // dispatch sites that branch on the kind. `playerIndex` is
        // what per-player dispatch matches against.
        this.kind = 'audio';
        this.playerIndex = slot;

        this.paneSide = paneSide;
        // Per-listener world view. Only x/y/angle are read in
        // playSound; kept narrow rather than mirroring CSSRenderer's
        // full 6 fields. updateCamera below writes these from
        // incoming per-player command dispatches.
        this.state = { camera: { x: 0, y: 0, angle: 0 } };
    }

    /**
     * Per-player updateCamera dispatch addressed to this listener's
     * slot. Method name + payload shape match the wire-format args
     * RenderSink sends (stripped player transform), so a joiner's
     * local AudioRenderer receives the same call shape that master's
     * does.
     */
    updateCamera(transform) {
        if (!transform) return;
        const cam = this.state.camera;
        cam.x = transform.x;
        cam.y = transform.y;
        cam.angle = transform.angle;
    }

    /**
     * World playSound dispatch. Computes volume from distance and pan
     * from listener-bearing (or locked pane side in split-screen),
     * then schedules a Web Audio playback. Out-of-range sounds drop
     * silently. Disabled / suppressed-slot listeners aren't in the
     * orchestrator's target list at all, so this never fires for
     * them.
     */
    playSound(name, opts) {
        if (!isAudioReady() || !opts) return;
        const listener = this.state.camera;
        const dx = opts.x - listener.x;
        const dy = opts.y - listener.y;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const volume = distanceToVolume(dist);
        if (volume <= 0) return;
        const pan = this.paneSide === 'left' ? -1
                  : this.paneSide === 'right' ? 1
                  : bearingToPan(dx, dy, listener.angle);
        playBuffer(name, volume, pan);
    }
}
