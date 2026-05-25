/**
 * Renderer command registry — metadata only.
 *
 * Every renderer command is declared here with its `kind`:
 *
 *   `player` — addressed to one slot. Game code constructs the envelope
 *              `{ type: 'player', slot, cmd, args }` and hands it to
 *              `orchestrator.dispatch(env)`. The orchestrator iterates
 *              targets whose `playerIndex` matches `slot` and calls
 *              `target.dispatch(env)` on each.
 *
 *   `world`  — broadcast to every target. Game code constructs
 *              `{ type: 'world', cmd, args }` and hands it to
 *              `orchestrator.dispatch(env)`. The orchestrator iterates
 *              every target and calls `target.dispatch(env)` on each.
 *
 * The orchestrator no longer reads this file at runtime — envelope
 * type drives routing directly. This registry is documentation: the
 * authoritative list of valid `cmd` strings plus their kind, useful
 * when wiring a new command or auditing the surface.
 *
 * Impl wiring lives in the renderer that owns the impl (DomRenderer's
 * bottom block imports impl modules and binds methods to its own
 * prototype). Each target type decides what `dispatch(env)` does —
 * see `renderer-base.js`, `dom/dom-renderer.js`, `flat/renderer.js`,
 * `line/renderer.js`, `transport/render-sink.js`.
 */

export const COMMANDS = {
    // ── Per-player: camera & HUD ─────────────────────────────────────────
    updateCamera: 'player',
    updateHud: 'player',
    // ── Per-player: effects ─────────────────────────────────────────────
    triggerFlash: 'player',
    showPowerup: 'player',
    flickerPowerup: 'player',
    hidePowerup: 'player',
    // ── Per-player: weapon visuals ──────────────────────────────────────
    switchWeapon: 'player',
    startFiring: 'player',
    stopFiring: 'player',
    // ── Per-player: player visuals ──────────────────────────────────────
    setPlayerDead: 'player',
    setPlayerMoving: 'player',
    // ── Per-player: pause tint ──────────────────────────────────────────
    showPaused: 'player',
    hidePaused: 'player',
    // ── World: per-renderer map load ────────────────────────────────────
    loadMap: 'world',
    // ── World: enemies / things / projectiles / effects ─────────────────
    setEnemyState: 'world',
    resetEnemy: 'world',
    killEnemy: 'world',
    updateEnemyRotation: 'world',
    updateThingPosition: 'world',
    reparentThingToSector: 'world',
    collectItem: 'world',
    uncollectItem: 'world',
    setThingMoving: 'world',
    createPuff: 'world',
    createExplosion: 'world',
    createTeleportFog: 'world',
    createProjectile: 'world',
    removeProjectile: 'world',
    createPlayerSprite: 'world',
    createCorpse: 'world',
    playPlayerAttack: 'world',
    // ── World: mechanics state ──────────────────────────────────────────
    setDoorState: 'world',
    setLiftState: 'world',
    setCrusherOffset: 'world',
    toggleSwitchState: 'world',
    // ── World: surfaces ─────────────────────────────────────────────────
    setFloorHeight: 'world',
    // ── World: audio ────────────────────────────────────────────────────
    // Only AudioRenderers act on it — DomRenderer / LineRenderer /
    // FlatRenderer have no playSound method, so the base dispatch
    // routing no-ops them automatically. RenderSink forwards over the
    // wire; the receiving window's AudioRenderers handle playback.
    playSound: 'world',
    // ── World: lobby / intermission / results / attract / etc. ──────────
    showLobby: 'world',
    hideLobby: 'world',
    showIntermission: 'world',
    hideIntermission: 'world',
    showResults: 'world',
    hideResults: 'world',
    showAttract: 'world',
    hideAttract: 'world',
    showTimer: 'world',
    showLevelTransition: 'world',
    hideLevelTransition: 'world',
};
