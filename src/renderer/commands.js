/**
 * Renderer command registry.
 *
 * Every renderer command is declared once here, then drives:
 *
 *   - Orchestrator   — public API game code calls (per-pane methods route
 *                       to a target by paneIndex; world methods invoke the
 *                       local impl + broadcast to all sinks).
 *   - DomRenderer    — per-pane methods baked against `this.paneIndex`.
 *   - RenderSink     — per-pane methods serialize args and post envelopes.
 *   - renderer/index — flat-namespace re-exports for backward compat.
 *
 * Adding a new command becomes one entry in COMMANDS. Forgetting to wire
 * it through the four files used to be a silent secondary-window desync;
 * with the registry it's impossible.
 *
 * Two kinds:
 *
 *   `per-pane`  — addressed to one pane. impl signature is
 *                 (paneIndex, ...args). For RenderSink, an optional
 *                 `serialize(...args)` strips non-cloneable refs (player
 *                 objects, etc.) before postMessage; defaults to identity.
 *
 *   `world`     — no pane. impl signature is (...args). The orchestrator
 *                 calls impl locally (existing helpers iterate panes
 *                 internally) and forwards the call to every sink so
 *                 secondary windows mirror the same world change.
 *
 * Optional `mirror` callback — runs on the receive side (RenderClient)
 * before dispatching to the local DomRenderer/Orchestrator. Keeps the
 * secondary's `rendererState` (camera positions, thing positions,
 * collected flags) in sync with the master so the secondary's culling
 * loop reads fresh values. Signature mirrors the wire-format args:
 *
 *   per-pane: mirror(paneIndex, ...serializedArgs)
 *   world:    mirror(...serializedArgs)
 *
 * Commands without renderer-state side-effects (most of them) omit
 * `mirror` entirely.
 */

import * as sprites from './scene/entities/sprites.js';
import * as doors from './scene/mechanics/doors.js';
import * as lifts from './scene/mechanics/lifts.js';
import * as crushers from './scene/mechanics/crushers.js';
import { toggleSwitchState } from './scene/mechanics/switches.js';
import { lowerTaggedFloor } from './scene/surfaces/floors.js';
import { buildThing as buildThingHelper } from './scene/entities/things.js';
import * as effects from './effects.js';
import * as weapons from './weapons.js';
import { updateHud } from './hud.js';
import { updateCamera } from './scene/camera.js';
import * as playerVisuals from './scene/entities/player.js';
import {
    applyCameraUpdate,
    applyThingPositionUpdate,
    applyThingCollected,
} from './renderer-state.js';

// Camera reads many fields off the player; strip to a plain transform
// before going over the transport.
const stripCameraTransform = (player) => [{
    x: player.x,
    y: player.y,
    z: player.z,
    angle: player.angle,
    floorHeight: player.floorHeight ?? 0,
    isFiring: player.isFiring,
}];

// HUD-relevant subset of the player. ownedWeapons is sent as a Set
// (structured clone preserves it) so the receiving updateHud can call
// .has() — Array would throw.
const stripHudData = (player) => [{
    currentWeapon: player.currentWeapon,
    ammo: { ...player.ammo },
    maxAmmo: { ...player.maxAmmo },
    health: player.health,
    armor: player.armor,
    ownedWeapons: new Set(player.ownedWeapons),
    score: player.score,
}];

export const COMMANDS = {
    // ── Per-pane: camera & HUD ────────────────────────────────────────────
    updateCamera: {
        kind: 'per-pane',
        impl: (pane, player) => updateCamera(player, pane),
        serialize: stripCameraTransform,
        mirror: (pane, transform) => applyCameraUpdate(pane, transform),
    },
    updateHud: { kind: 'per-pane', impl: (pane, player) => updateHud(player, pane), serialize: stripHudData },

    // ── Per-pane: effects ─────────────────────────────────────────────────
    triggerFlash: { kind: 'per-pane', impl: (pane, type) => effects.triggerFlash(pane, type) },
    showPowerup: { kind: 'per-pane', impl: (pane, name) => effects.showPowerup(pane, name) },
    flickerPowerup: { kind: 'per-pane', impl: (pane, name) => effects.flickerPowerup(pane, name) },
    hidePowerup: { kind: 'per-pane', impl: (pane, name) => effects.hidePowerup(pane, name) },

    // ── Per-pane: weapon visuals ──────────────────────────────────────────
    switchWeapon: { kind: 'per-pane', impl: (pane, name, rate) => weapons.switchWeapon(pane, name, rate) },
    startFiring: { kind: 'per-pane', impl: (pane) => weapons.startFiring(pane) },
    stopFiring: { kind: 'per-pane', impl: (pane) => weapons.stopFiring(pane) },

    // ── Per-pane: player visuals ──────────────────────────────────────────
    setPlayerDead: { kind: 'per-pane', impl: (pane, ...args) => playerVisuals.setPlayerDead(pane, ...args) },
    setPlayerMoving: { kind: 'per-pane', impl: (pane, isMoving) => playerVisuals.setPlayerMoving(pane, isMoving) },
    clearKeys: { kind: 'per-pane', impl: (pane) => playerVisuals.clearKeys(pane) },
    collectKey: { kind: 'per-pane', impl: (pane, ...args) => playerVisuals.collectKey(pane, ...args) },

    // ── World: enemies / things / projectiles / effects ───────────────────
    setEnemyState: { kind: 'world', impl: sprites.setEnemyState },
    resetEnemy: { kind: 'world', impl: sprites.resetEnemy },
    killEnemy: {
        kind: 'world',
        impl: sprites.killEnemy,
        mirror: (thingIndex) => applyThingCollected(thingIndex, true),
    },
    updateEnemyRotation: { kind: 'world', impl: sprites.updateEnemyRotation },
    updateThingPosition: {
        kind: 'world',
        impl: sprites.updateThingPosition,
        mirror: (thingIndex, x, y, floorHeight) =>
            applyThingPositionUpdate(thingIndex, x, y, floorHeight),
    },
    reparentThingToSector: { kind: 'world', impl: sprites.reparentThingToSector },
    collectItem: {
        kind: 'world',
        impl: sprites.collectItem,
        mirror: (thingIndex) => applyThingCollected(thingIndex, true),
    },
    uncollectItem: {
        kind: 'world',
        impl: sprites.uncollectItem,
        mirror: (thingIndex) => applyThingCollected(thingIndex, false),
    },
    setThingMoving: { kind: 'world', impl: sprites.setThingMoving },
    createPuff: { kind: 'world', impl: sprites.createPuff },
    createExplosion: { kind: 'world', impl: sprites.createExplosion },
    createTeleportFog: { kind: 'world', impl: sprites.createTeleportFog },
    createProjectile: { kind: 'world', impl: sprites.createProjectile },
    removeProjectile: { kind: 'world', impl: sprites.removeProjectile },
    createPlayerSprite: { kind: 'world', impl: sprites.createPlayerSprite },
    createCorpse: { kind: 'world', impl: sprites.createCorpse },
    playPlayerAttack: { kind: 'world', impl: sprites.playPlayerAttack },

    // ── World: thing / mechanics construction ─────────────────────────────
    buildThing: { kind: 'world', impl: buildThingHelper },
    buildDoor: { kind: 'world', impl: doors.buildDoor },
    setDoorState: { kind: 'world', impl: doors.setDoorState },
    buildLift: { kind: 'world', impl: lifts.buildLift },
    setLiftState: { kind: 'world', impl: lifts.setLiftState },
    buildCrusher: { kind: 'world', impl: crushers.buildCrusher },
    setCrusherOffset: { kind: 'world', impl: crushers.setCrusherOffset },
    toggleSwitchState: { kind: 'world', impl: toggleSwitchState },

    // ── World: surfaces ───────────────────────────────────────────────────
    lowerTaggedFloor: { kind: 'world', impl: lowerTaggedFloor },
};

export const PER_PANE_COMMANDS = Object.fromEntries(
    Object.entries(COMMANDS).filter(([, c]) => c.kind === 'per-pane'),
);

export const WORLD_COMMANDS = Object.fromEntries(
    Object.entries(COMMANDS).filter(([, c]) => c.kind === 'world'),
);
