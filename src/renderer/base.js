/**
 * RendererBase — common entry point for every renderer / sink target the
 * orchestrator dispatches to.
 *
 * The orchestrator calls `target.dispatch(env)` once per command per
 * target with an envelope object:
 *
 *   { type: 'player', slot, cmd, args }   — addressed to one player
 *   { type: 'world',         cmd, args }   — broadcast to all targets
 *
 * The envelope is the unit of work. The same object flows from
 * game-loop call → orchestrator → each target → (for sinks) wire →
 * receiving window's RenderClient → receiving orchestrator → its
 * targets, with no field renaming or repackaging at any step.
 *
 * Default routing: look up `this[env.cmd]` and call it with
 * `env.args`. A renderer that wants to support a command defines a
 * same-named method (e.g. `updateCamera(camera) { ... }`). Commands
 * the renderer doesn't implement silently no-op via the typeof
 * check.
 *
 * Sinks (or anything that needs the SAME behaviour for every command
 * — wire forwarding, logging, replay, telemetry) override `dispatch`
 * directly instead of defining per-command methods.
 */

export class RendererBase {
    // Rendering technology: 'dom' (CSS/DOM scene — most renderers) or 'canvas'
    // (a <canvas> framebuffer). The debug panel reads this (via the manager) to
    // disable CSS-only toggles when a 'canvas' renderer is active. Subclasses
    // that aren't DOM-based override it (LineRenderer, CanvasRenderer).
    static type = 'dom';

    dispatch(env) {
        const fn = this[env.cmd];
        if (typeof fn === 'function') return fn.apply(this, env.args);
    }
}
