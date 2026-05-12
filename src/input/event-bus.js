/**
 * Input event bus.
 *
 * Input modules (keyboard, mouse, gamepad, touch, remote-master) emit
 * logical action events here; handlers in `src/actions/*` subscribe to
 * route them into game-side calls. The point of the bus is to keep the
 * input layer free of game-function imports — input only knows about
 * key/button → action mapping, not what those actions do.
 *
 * Event shape (defined in [actions.js](actions.js)):
 *   { kind: <ACTION>, slot: number|null, deviceId: string, …extra }
 *
 *   `slot` is the player slot the source device currently drives
 *   (resolved via orchestrator.getDriverSlot at emit time). Unbound devices in a DM
 *   lobby emit slot=null so the claim handler can promote a fresh
 *   button-press into a slot claim.
 *
 * Handler chain: handlers run in registration order, sorted by
 * `priority` (higher first). A handler can stop propagation by
 * returning `true`. This implements the precedence rules — e.g. an
 * attract-wake handler runs before fire-handler, so the wake-up press
 * consumes the event and doesn't double as a weapon fire.
 *
 * Movement / turn analog input does NOT flow through this bus. It
 * stays in the `inputs[]` aggregation in [index.js](index.js) — it's
 * per-frame state, not event-driven.
 */

const handlers = new Map();   // kind → sorted array of { priority, handler }

/**
 * Subscribe a handler to a specific event kind. Higher-priority
 * handlers run first; ties resolve in subscription order. The handler
 * receives the event object and can return `true` to mark it consumed
 * (no further handlers fire for that emit).
 *
 * @param {string} kind          Action constant from `actions.js`.
 * @param {(event: object) => boolean | void} handler
 * @param {object} [options]
 * @param {number} [options.priority=0]  Higher = runs sooner.
 * @returns {() => void}         Unsubscribe function.
 */
export function on(kind, handler, { priority = 0 } = {}) {
    const list = handlers.get(kind) ?? [];
    list.push({ priority, handler });
    // Stable-sort by priority desc — Array.prototype.sort is stable in
    // modern engines, so ties keep subscription order.
    list.sort((a, b) => b.priority - a.priority);
    handlers.set(kind, list);
    return () => {
        const entries = handlers.get(kind);
        if (!entries) return;
        const i = entries.findIndex(e => e.handler === handler);
        if (i >= 0) entries.splice(i, 1);
    };
}

/**
 * Emit an event. Handlers run in priority order; the first to return
 * `true` consumes it and downstream handlers don't fire.
 */
export function emit(event) {
    const list = handlers.get(event.kind);
    if (!list || list.length === 0) return;
    for (const { handler } of list) {
        if (handler(event) === true) return;
    }
}
