/**
 * Render-command player. Reads a recording captured by recorder.js
 * out of localStorage and re-dispatches the envelopes through the
 * orchestrator at their original relative timing. Targets fan-out
 * works exactly as it would for a live game — the dispatch path
 * doesn't care that envelopes came from a buffer instead of the
 * game loop.
 *
 * One rAF scheduler: each tick, dispatch every envelope whose
 * recorded timestamp has passed. Cheap O(n) cursor, sequential
 * order preserved (the recorder pushed in dispatch order).
 *
 * Invoked from `initMaster` when the boot path detects ?play=slot.
 */

import { orchestrator } from '../orchestrator.js';
import { load } from './recorder.js';

export async function play(slot) {
    const recording = await load(slot);
    if (!recording) {
        console.warn(`[play] no recording in slot "${slot}"`);
        return;
    }
    console.log(`[play] replaying ${recording.length} envelopes from slot "${slot}"`);

    const startTime = performance.now();
    let cursor = 0;

    function tick() {
        const elapsed = performance.now() - startTime;
        while (cursor < recording.length && recording[cursor].t <= elapsed) {
            orchestrator.dispatch(recording[cursor].env);
            cursor++;
        }
        if (cursor < recording.length) {
            requestAnimationFrame(tick);
        } else {
            console.log('[play] done');
        }
    }
    requestAnimationFrame(tick);
}
