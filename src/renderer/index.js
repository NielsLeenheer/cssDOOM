/**
 * Renderer public API — game code's single entry point into rendering.
 *
 * The flat-namespace exports below mirror what was here before the
 * orchestrator refactor. Each is a thin re-export of an Orchestrator method,
 * so existing call sites (`import * as renderer from '../renderer/index.js'`)
 * keep working unchanged. New call sites can also import the orchestrator
 * directly via `import { orchestrator } from '../renderer/orchestrator.js'`.
 *
 * The orchestrator owns the routing — per-player commands route to a single
 * DomRenderer target by paneIndex; world commands call the underlying
 * helpers once. Future targets (BroadcastSink for two-window mode) are
 * registered against the orchestrator without changing this file.
 */

import { orchestrator } from './orchestrator.js';

// ── Camera & HUD ──────────────────────────────────────────────────────────
export const updateCamera = (player, paneIndex) => orchestrator.updateCamera(player, paneIndex);

// ── Effects ───────────────────────────────────────────────────────────────
export const triggerFlash = (paneIndex, type) => orchestrator.triggerFlash(paneIndex, type);
export const showPowerup = (paneIndex, name) => orchestrator.showPowerup(paneIndex, name);
export const flickerPowerup = (paneIndex, name) => orchestrator.flickerPowerup(paneIndex, name);
export const hidePowerup = (paneIndex, name) => orchestrator.hidePowerup(paneIndex, name);

// ── Sprites & things (world commands) ─────────────────────────────────────
export const setEnemyState = (...args) => orchestrator.setEnemyState(...args);
export const resetEnemy = (...args) => orchestrator.resetEnemy(...args);
export const killEnemy = (...args) => orchestrator.killEnemy(...args);
export const updateEnemyRotation = (...args) => orchestrator.updateEnemyRotation(...args);
export const updateThingPosition = (...args) => orchestrator.updateThingPosition(...args);
export const reparentThingToSector = (...args) => orchestrator.reparentThingToSector(...args);
export const collectItem = (...args) => orchestrator.collectItem(...args);
export const uncollectItem = (...args) => orchestrator.uncollectItem(...args);
export const setThingMoving = (...args) => orchestrator.setThingMoving(...args);
export const createPuff = (...args) => orchestrator.createPuff(...args);
export const createExplosion = (...args) => orchestrator.createExplosion(...args);
export const createTeleportFog = (...args) => orchestrator.createTeleportFog(...args);
export const createProjectile = (...args) => orchestrator.createProjectile(...args);
export const removeProjectile = (...args) => orchestrator.removeProjectile(...args);
export const createPlayerSprite = (...args) => orchestrator.createPlayerSprite(...args);
export const createCorpse = (...args) => orchestrator.createCorpse(...args);
export const playPlayerAttack = (...args) => orchestrator.playPlayerAttack(...args);

// ── Thing DOM construction ────────────────────────────────────────────────
export const buildThing = (...args) => orchestrator.buildThing(...args);

// ── Player visuals ────────────────────────────────────────────────────────
export const setPlayerDead = (paneIndex, ...args) => orchestrator.setPlayerDead(paneIndex, ...args);
export const clearKeys = (paneIndex) => orchestrator.clearKeys(paneIndex);
export const setPlayerMoving = (paneIndex, isMoving) => orchestrator.setPlayerMoving(paneIndex, isMoving);
export const collectKey = (paneIndex, ...args) => orchestrator.collectKey(paneIndex, ...args);

// ── Weapon visuals ────────────────────────────────────────────────────────
export const switchWeapon = (paneIndex, weaponName, fireRate) => orchestrator.switchWeapon(paneIndex, weaponName, fireRate);
export const startFiring = (paneIndex) => orchestrator.startFiring(paneIndex);
export const stopFiring = (paneIndex) => orchestrator.stopFiring(paneIndex);

// ── Mechanics ─────────────────────────────────────────────────────────────
export const buildDoor = (...args) => orchestrator.buildDoor(...args);
export const setDoorState = (...args) => orchestrator.setDoorState(...args);
export const buildLift = (...args) => orchestrator.buildLift(...args);
export const setLiftState = (...args) => orchestrator.setLiftState(...args);
export const buildCrusher = (...args) => orchestrator.buildCrusher(...args);
export const setCrusherOffset = (...args) => orchestrator.setCrusherOffset(...args);
export const toggleSwitchState = (...args) => orchestrator.toggleSwitchState(...args);

// ── Surfaces ──────────────────────────────────────────────────────────────
export const lowerTaggedFloor = (...args) => orchestrator.lowerTaggedFloor(...args);

// ── Scene controls ────────────────────────────────────────────────────────
export const clonePanes = (paneCount) => orchestrator.clonePanes(paneCount);
export const setMirrorMode = (value) => orchestrator.setMirrorMode(value);
export const isMirrorMode = () => orchestrator.isMirrorMode();
export const viewportsForEffect = (playerIndex) => orchestrator.viewportsForEffect(playerIndex);

// Direct access for code that benefits from instance-shaped API
export { orchestrator };
