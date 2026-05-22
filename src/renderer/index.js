/**
 * Renderer public API — game code's single entry point into rendering.
 *
 * Per-player commands take `(playerIndex, ...args)` — the orchestrator
 * iterates render targets and dispatches to every renderer whose
 * `playerIndex` matches (mirror SP has two renderers sharing playerIndex
 * 0; Network DM has a RenderSink at each remote player's slot). World
 * commands take `(...args)`.
 *
 * Callers build the payload in the right shape at the call site — the
 * orchestrator passes it through unchanged. See each command's impl
 * for the fields it reads (e.g. `updateCamera` impl in
 * `scene/camera.js` reads `x, y, z, angle, floorHeight, isFiring`).
 *
 * All re-exports are generated from the command registry
 * ([commands.js](commands.js)). Adding a renderer command is one entry
 * there; this file picks it up automatically.
 */

import { orchestrator } from '../orchestrator.js';
import { COMMANDS } from './commands.js';

const exported = {};

for (const [name, { kind }] of Object.entries(COMMANDS)) {
    if (kind === 'per-pane') {
        exported[name] = (playerIndex, ...args) => orchestrator[name](playerIndex, ...args);
    } else {
        exported[name] = (...args) => orchestrator[name](...args);
    }
}

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

// ── Player visuals ────────────────────────────────────────────────────────
export const setPlayerDead = exported.setPlayerDead;
export const setPlayerMoving = exported.setPlayerMoving;

// ── Weapon visuals ────────────────────────────────────────────────────────
export const switchWeapon = exported.switchWeapon;
export const startFiring = exported.startFiring;
export const stopFiring = exported.stopFiring;

// ── Mechanics ─────────────────────────────────────────────────────────────
export const setDoorState = exported.setDoorState;
export const setLiftState = exported.setLiftState;
export const setCrusherOffset = exported.setCrusherOffset;
export const toggleSwitchState = exported.toggleSwitchState;

// ── Surfaces ──────────────────────────────────────────────────────────────
export const setFloorHeight = exported.setFloorHeight;

// ── Overlay commands re-exported for snapshot apply paths ────────────────
// Most overlay commands (showLobby/showResults/setGameState) are only
// invoked from master game code via `orchestrator.X(...)` and don't need
// a named export. showTimer is the exception — the joiner's snapshot
// apply path imports renderer as a namespace and fires it alongside
// renderer.setDoorState etc., so we surface it explicitly.
export const showTimer = exported.showTimer;

// Direct access for code that benefits from instance-shaped API
export { orchestrator };
