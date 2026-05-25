/**
 * Renderer command registry — metadata only.
 *
 * Every renderer command is declared here with its `kind`:
 *
 *   `per-pane` — addressed to one pane. Orchestrator iterates targets
 *                whose `playerIndex` matches the addressed slot and
 *                calls `target.dispatch('per-pane', command, args)`.
 *
 *   `world`    — broadcast to every target. Orchestrator iterates all
 *                targets and calls `target.dispatch('world', command,
 *                args)`.
 *
 * The orchestrator generates one per-pane / world method per entry
 * here (so game code can call `orchestrator.updateCamera(slot, ...)`).
 * Each target type decides what `dispatch` does — see
 * `renderer-base.js`, `dom/dom-renderer.js`, `flat/renderer.js`,
 * `line/renderer.js`, `transport/render-sink.js`.
 *
 * Impl wiring lives in the renderer that owns the impl (DomRenderer's
 * bottom block imports the impl modules and binds methods to its own
 * prototype). This file owns only the cross-cutting kind metadata
 * the orchestrator needs to pick a dispatch path.
 */

export const COMMANDS = {
    // ── Per-player: camera & HUD ─────────────────────────────────────────
    updateCamera: 'per-pane',
    updateHud: 'per-pane',
    // ── Per-player: effects ─────────────────────────────────────────────
    triggerFlash: 'per-pane',
    showPowerup: 'per-pane',
    flickerPowerup: 'per-pane',
    hidePowerup: 'per-pane',
    // ── Per-player: weapon visuals ──────────────────────────────────────
    switchWeapon: 'per-pane',
    startFiring: 'per-pane',
    stopFiring: 'per-pane',
    // ── Per-player: player visuals ──────────────────────────────────────
    setPlayerDead: 'per-pane',
    setPlayerMoving: 'per-pane',
    // ── Per-player: pause tint ──────────────────────────────────────────
    showPaused: 'per-pane',
    hidePaused: 'per-pane',
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

export const PER_PANE_COMMANDS = Object.fromEntries(
    Object.entries(COMMANDS).filter(([, kind]) => kind === 'per-pane'),
);

export const WORLD_COMMANDS = Object.fromEntries(
    Object.entries(COMMANDS).filter(([, kind]) => kind === 'world'),
);
