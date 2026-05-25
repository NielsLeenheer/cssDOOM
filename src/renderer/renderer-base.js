/**
 * RendererBase — common entry point for every renderer / sink target the
 * orchestrator dispatches to. The orchestrator calls
 * `target.dispatch(kind, command, args)` once per command per target;
 * implementations decide what to do with it.
 *
 * Default routing: look up `this[command]` and call it with `args`. A
 * renderer that wants to support a command defines a same-named method
 * (e.g. `updateCamera(camera) { ... }`) — that's it. Commands the
 * renderer doesn't implement silently no-op via the typeof check.
 *
 * Sinks (and any other target that needs the SAME behavior for every
 * command — record-and-forward, logging, telemetry) override `dispatch`
 * directly instead of defining per-command methods.
 *
 * `kind` is passed through as `'per-pane' | 'world'` so targets that
 * care (the wire sink picks a per-pane vs world envelope shape) can
 * branch on it. Targets that don't care ignore the arg.
 */

export class RendererBase {
    dispatch(kind, command, args) {
        const fn = this[command];
        if (typeof fn === 'function') fn.apply(this, args);
    }
}
