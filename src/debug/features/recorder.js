/**
 * Render-command recorder. When active, captures every envelope
 * passed to `orchestrator.dispatch` along with a relative timestamp
 * so the sequence can be saved to IndexedDB and later replayed by
 * ?play=slot.
 *
 * Hook: start() subscribes `capture` to the orchestrator's 'dispatch'
 * event (and stop() unsubscribes), so capturing only costs anything
 * while a recording is running and the orchestrator never imports
 * debug. Envelopes are JSON-cloned at capture so any mutation after
 * dispatch (e.g. the `{...player.ammo}` payload going stale or being
 * recycled) is frozen at the dispatch moment. JSON round-trip is the
 * same serialisation RenderSink uses for the wire, so any envelope
 * safe to ship to a remote is safe to capture here.
 *
 * Storage: IndexedDB, not localStorage. A modest recording
 * (updateCamera at 60Hz alone is ~30 KB/s of JSON) exceeds the
 * 5 MB localStorage quota in seconds; IDB's quota typically scales
 * with available disk, so multi-minute recordings fit.
 *
 * Public surface is exposed on `debug.view.record / save` in
 * debug/console.js — this module only holds state + helpers.
 */

import { orchestrator } from '../../orchestrator.js';

const DB_NAME = 'cssdoom-recordings';
const STORE = 'recordings';

let dbPromise = null;
function getDB() {
    if (dbPromise) return dbPromise;
    dbPromise = new Promise((resolve, reject) => {
        const req = indexedDB.open(DB_NAME, 1);
        req.onupgradeneeded = () => req.result.createObjectStore(STORE);
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
    return dbPromise;
}

async function idbPut(slot, value) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(value, String(slot));
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
    });
}

async function idbGet(slot) {
    const db = await getDB();
    return new Promise((resolve, reject) => {
        const tx = db.transaction(STORE, 'readonly');
        const req = tx.objectStore(STORE).get(String(slot));
        req.onsuccess = () => resolve(req.result);
        req.onerror = () => reject(req.error);
    });
}

let active = false;
let t0 = 0;
let buffer = [];

export function start() {
    active = true;
    t0 = performance.now();
    buffer = [];
    orchestrator.on('dispatch', capture);
    console.log('[record] capturing envelopes…');
}

export function stop() {
    active = false;
    orchestrator.off('dispatch', capture);
}

export function isRecording() {
    return active;
}

export function capture(env) {
    if (!active) return;
    buffer.push({
        t: performance.now() - t0,
        env: JSON.parse(JSON.stringify(env)),
    });
}

export async function save(slot) {
    if (slot == null) {
        console.warn('[record] save(slot) — pass a slot name');
        return;
    }
    active = false;
    try {
        // IDB structured-clones the value directly — no JSON cost
        // and no double-storage of the serialised string.
        await idbPut(slot, buffer);
    } catch (err) {
        console.error('[record] IndexedDB write failed:', err.message);
        return;
    }
    console.log(`[record] saved slot "${slot}" — ${buffer.length} envelopes`);
}

export async function load(slot) {
    return idbGet(slot);
}
