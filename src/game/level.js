/**
 * Level — one loaded map being simulated.
 *
 * Skeleton only. Method bodies land in subsequent L1 steps:
 *   L1.2 — load()
 *   L1.3 — start() + tick()
 *   L1.4 — pause() / resume()
 *   L1.5 — stop() / destroy()
 *   L1.6 — wires level-complete / player-died / player-spawned emits
 *           from existing callers
 *   L1.7 — _setCurrentLevel / getCurrentLevel registry helpers
 *
 * See LIFECYCLE_REFACTOR.md §5 (Level state machine) and §8 (Level API)
 * for the target contract.
 */

export class Level {
    constructor({ map, players, rules, orchestrator }) {
        this.map = map;
        this.players = players;
        this.rules = rules;
        this.orchestrator = orchestrator;

        this._listeners = new Map();
        this._state = 'unloaded'; // 'unloaded' | 'loaded-paused' | 'loaded-running'
    }

    async load()  { /* L1.2 */ }
    start()       { /* L1.3 */ }
    pause()       { /* L1.4 */ }
    resume()      { /* L1.4 */ }
    stop()        { /* L1.5 */ }
    destroy()     { /* L1.5 */ }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }

    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
