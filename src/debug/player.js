/**
 * Render-command player. Reads a recording captured by recorder.js
 * out of IndexedDB and re-dispatches the envelopes through the
 * orchestrator at their original relative timing. Targets fan-out
 * works exactly as it would for a live game — the dispatch path
 * doesn't care that envelopes came from a buffer instead of the
 * game loop.
 *
 * One rAF scheduler: each tick, dispatch every envelope whose
 * recorded timestamp has passed. Cheap O(n) cursor, sequential
 * order preserved (the recorder pushed in dispatch order).
 *
 * Optional `exportFormat` ('mp4' / 'webm') captures the page via
 * `getDisplayMedia` + `MediaRecorder` and downloads the result
 * when the recording ends. `getDisplayMedia` needs a user gesture,
 * so we paint a click-to-start overlay before kicking off capture.
 *
 * Invoked from `initMaster` when the boot path detects ?play=slot.
 */

import { orchestrator } from '../orchestrator.js';
import { load } from './recorder.js';

export async function play(slot, exportFormat = null) {
    const recording = await load(slot);
    if (!recording) {
        console.warn(`[play] no recording in slot "${slot}"`);
        return;
    }
    console.log(`[play] replaying ${recording.length} envelopes from slot "${slot}"`);

    // Pin the inner viewport to 1920×1080 so the playback geometry
    // (perspective is computed from pane width) matches a known
    // size — important for the recorded MP4 to land at a clean
    // resolution. Best-effort: some browsers / fullscreen states
    // ignore resizeTo on the main tab. Allow a frame so the
    // resulting ResizeObserver tick updates the renderer's cached
    // pane width before the first envelope dispatches.
    resizeInnerTo(1920, 1080);
    await new Promise((r) => requestAnimationFrame(r));

    if (exportFormat) {
        await waitForUserGesture();
        await playWithExport(slot, recording, exportFormat);
        return;
    }
    runReplay(recording);
}

function resizeInnerTo(targetW, targetH) {
    const chromeW = window.outerWidth - window.innerWidth;
    const chromeH = window.outerHeight - window.innerHeight;
    window.resizeTo(targetW + chromeW, targetH + chromeH);
}

/** Schedule the recorded envelope stream. Resolves when the buffer
 *  is exhausted. */
function runReplay(recording) {
    return new Promise((resolve) => {
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
                resolve();
            }
        }
        requestAnimationFrame(tick);
    });
}

/** Open a screen-capture stream, start a MediaRecorder, run the
 *  replay, stop, and trigger a download. */
async function playWithExport(slot, recording, format) {
    const mimeType = pickMimeType(format);
    if (!mimeType) {
        console.error(`[play] no MediaRecorder mime type available for "${format}"`);
        runReplay(recording);
        return;
    }

    let stream;
    try {
        stream = await navigator.mediaDevices.getDisplayMedia({
            video: {
                displaySurface: 'browser',
                // Advisory constraints — most browsers honour
                // these for tab/window capture so the stream isn't
                // down-sampled before it reaches MediaRecorder.
                width:     { ideal: 1920 },
                height:    { ideal: 1080 },
                frameRate: { ideal: 60 },
            },
            // Tab-audio capture. Chrome shows a "Share audio"
            // checkbox in the screen-capture dialog when this is
            // true and the user picks a tab; tick it to include
            // playSound output in the encoded file. Firefox
            // doesn't support display-media audio capture, so it
            // silently produces a video-only stream there.
            audio: true,
        });
    } catch (err) {
        console.error('[play] screen capture refused:', err.message);
        runReplay(recording);
        return;
    }

    const chunks = [];
    // 25 Mbps is the bitrate that consumer 1080p60 capture cards
    // settle on for near-lossless output. MediaRecorder's default
    // is ~2.5 Mbps which is why uninstrumented captures look
    // blocky on detailed scenes. Bump 4× for footage that holds up
    // when projected.
    const mediaRecorder = new MediaRecorder(stream, {
        mimeType,
        videoBitsPerSecond: 25_000_000,
    });
    mediaRecorder.ondataavailable = (e) => { if (e.data.size) chunks.push(e.data); };

    const stopped = new Promise((resolve) => {
        mediaRecorder.onstop = resolve;
    });

    mediaRecorder.start();
    console.log(`[play] export started (${mimeType})`);

    await runReplay(recording);

    mediaRecorder.stop();
    await stopped;
    stream.getTracks().forEach((t) => t.stop());

    const extension = mimeType.includes('mp4') ? 'mp4' : 'webm';
    const blob = new Blob(chunks, { type: mimeType });
    downloadBlob(blob, `cssdoom-${slot}.${extension}`);
    console.log(`[play] export saved (${(blob.size / 1024 / 1024).toFixed(2)} MB)`);
}

/** Walk a preference order for the requested container, falling
 *  back from mp4 to webm if the browser can't encode mp4 (Firefox
 *  historically). VP9 is preferred over VP8 within webm — at the
 *  same bitrate it's noticeably sharper on detailed scenes, which
 *  matters at 25 Mbps for 1080p. Returns '' if even the fallbacks
 *  are unsupported. */
function pickMimeType(format) {
    const candidates = format === 'mp4'
        ? ['video/mp4;codecs=avc1.640033', 'video/mp4;codecs=avc1', 'video/mp4',
           'video/webm;codecs=vp9', 'video/webm']
        : ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'];
    for (const m of candidates) {
        if (MediaRecorder.isTypeSupported(m)) return m;
    }
    return '';
}

function downloadBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/** getDisplayMedia must run inside a user activation (page-load
 *  invocation throws). Paint a black overlay with a prompt;
 *  resolve on the first click. */
function waitForUserGesture() {
    return new Promise((resolve) => {
        const overlay = document.createElement('div');
        overlay.style.cssText = `
            position: fixed; inset: 0; z-index: 99999;
            background: #000; color: #ddd;
            display: flex; align-items: center; justify-content: center;
            font: 600 24px/1.4 system-ui, sans-serif;
            cursor: pointer; user-select: none;
            text-align: center; padding: 32px;
        `;
        overlay.textContent = 'Click to start recording.\nPick this tab in the screen-capture dialog\nand tick "Share audio".';
        overlay.style.whiteSpace = 'pre-line';
        overlay.addEventListener('click', () => {
            overlay.remove();
            resolve();
        }, { once: true });
        document.body.appendChild(overlay);
    });
}
