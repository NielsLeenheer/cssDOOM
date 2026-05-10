/**
 * Renderer public API — game code's single entry point into rendering.
 *
 * The flat-namespace exports below mirror what was here before the
 * orchestrator refactor. Per-pane commands take `(paneIndex, ...args)`;
 * world commands take `(...args)`. Two helpers (`updateCamera`,
 * `updateHud`) accept the legacy `(player, paneIndex)` signature with
 * paneIndex falling back to `player.viewportIndex` when omitted —
 * preserved for callers like teleporters.js and debug.js.
 *
 * All re-exports are generated from the command registry
 * ([commands.js](commands.js)). Adding a renderer command is one entry
 * there; this file picks it up automatically.
 */

import { orchestrator } from './orchestrator.js';
import { COMMANDS } from './commands.js';

const exported = {};

for (const [name, { kind }] of Object.entries(COMMANDS)) {
    if (kind === 'per-pane') {
        exported[name] = (paneIndex, ...args) => orchestrator[name](paneIndex, ...args);
    } else {
        exported[name] = (...args) => orchestrator[name](...args);
    }
}

// Legacy callers pass (player, paneIndex) — and some omit paneIndex,
// relying on `player.viewportIndex`. Override the generated wrappers
// for these two so the public signature stays as it was.
exported.updateCamera = (player, paneIndex) =>
    orchestrator.updateCamera(paneIndex ?? player.viewportIndex, player);
exported.updateHud = (player, paneIndex) =>
    orchestrator.updateHud(paneIndex ?? player.viewportIndex, player);

// ── Camera & HUD ──────────────────────────────────────────────────────────
export const updateCamera = exported.updateCamera;
export const updateHud = exported.updateHud;

// ── Effects ───────────────────────────────────────────────────────────────
export const triggerFlash = exported.triggerFlash;
export const showPowerup = exported.showPowerup;
export const flickerPowerup = exported.flickerPowerup;
export const hidePowerup = exported.hidePowerup;

// ── Sprites & things (world commands) ─────────────────────────────────────
export const setEnemyState = exported.setEnemyState;
export const resetEnemy = exported.resetEnemy;
export const killEnemy = exported.killEnemy;
export const updateEnemyRotation = exported.updateEnemyRotation;
export const updateThingPosition = exported.updateThingPosition;
export const reparentThingToSector = exported.reparentThingToSector;
export const collectItem = exported.collectItem;
export const uncollectItem = exported.uncollectItem;
export const setThingMoving = exported.setThingMoving;
export const createPuff = exported.createPuff;
export const createExplosion = exported.createExplosion;
export const createTeleportFog = exported.createTeleportFog;
export const createProjectile = exported.createProjectile;
export const removeProjectile = exported.removeProjectile;
export const createPlayerSprite = exported.createPlayerSprite;
export const createCorpse = exported.createCorpse;
export const playPlayerAttack = exported.playPlayerAttack;

// ── Thing DOM construction ────────────────────────────────────────────────
export const buildThing = exported.buildThing;

// ── Player visuals ────────────────────────────────────────────────────────
export const setPlayerDead = exported.setPlayerDead;
export const clearKeys = exported.clearKeys;
export const setPlayerMoving = exported.setPlayerMoving;
export const collectKey = exported.collectKey;

// ── Weapon visuals ────────────────────────────────────────────────────────
export const switchWeapon = exported.switchWeapon;
export const startFiring = exported.startFiring;
export const stopFiring = exported.stopFiring;

// ── Mechanics ─────────────────────────────────────────────────────────────
export const buildDoor = exported.buildDoor;
export const setDoorState = exported.setDoorState;
export const buildLift = exported.buildLift;
export const setLiftState = exported.setLiftState;
export const buildCrusher = exported.buildCrusher;
export const setCrusherOffset = exported.setCrusherOffset;
export const toggleSwitchState = exported.toggleSwitchState;

// ── Surfaces ──────────────────────────────────────────────────────────────
export const lowerTaggedFloor = exported.lowerTaggedFloor;

// ── Scene controls (orchestrator-only) ────────────────────────────────────
export const clonePanes = (paneCount) => orchestrator.clonePanes(paneCount);
export const setMirrorMode = (value) => orchestrator.setMirrorMode(value);
export const isMirrorMode = () => orchestrator.isMirrorMode();
export const viewportsForEffect = (playerIndex) => orchestrator.viewportsForEffect(playerIndex);
export const setAttract = (active) => orchestrator.setAttract(active);

// Direct access for code that benefits from instance-shaped API
export { orchestrator };
