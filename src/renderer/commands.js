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
 * it through the four files used to be a silent client desync;
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
 *                 clients mirror the same world change.
 *
 * Optional `mirror` callback — runs on the receive side (RenderClient)
 * before dispatching to the local DomRenderer/Orchestrator. Keeps the
 * client's `rendererState` (camera positions, thing positions,
 * collected flags) in sync with the master so the client's culling
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
import * as scene from './scene/scene.js';
import { toggleSwitchState } from './scene/mechanics/switches.js';
import { lowerTaggedFloor } from './scene/surfaces/floors.js';
import * as effects from './hud/effects.js';
import * as weapons from './hud/weapons.js';
import { updateHud } from './hud/hud.js';
import { updateCamera } from './scene/camera.js';
import * as playerVisuals from './scene/entities/player.js';
import {
    applyCameraUpdate,
    applyThingPositionUpdate,
    applyThingCollected,
} from './renderer-state.js';
import { renderIntermission, clearIntermission } from './screens/intermission.js';
// Overlay-style commands (showLobby / hideLobby / showResults /
// hideResults / setMatchTimer / setGameState) currently dispatch
// through a late-binding registry: their impl is a thin
// `fireOverlay(name, ...)` wrapper that fans to any handler the
// screen modules have registered via `registerOverlayImpl`.
//
// Why the registry exists: the direct-import shape
// (`commands.js → screens/lobby.js → orchestrator.js → commands.js`)
// would be a cycle that crashed Firefox via TDZ on the COMMANDS
// export. The registry lets screen modules push their handlers in at
// their own module-eval time so commands.js never has to import them.
//
// Side-effect anchor for the still-registered screens lives at
// src/renderer/overlays/overlays.js — without it a module whose
// named exports are unused elsewhere can fall out of the bundle
// entirely and silently un-register its impls.
//
// Migration in progress: now that screens live under
// `src/renderer/screens/` and don't transitively import the
// orchestrator, commands.js can import each screen's impl directly
// and the registry indirection drops away one command at a time.
// intermission was first (see import below). LOBBY_REFACTOR_PLAN
// covers the lobby family; scoreboard / setMatchTimer / setGameState
// follow the same shape.

const overlayImpls = new Map();

/**
 * Register a render-only handler for an overlay command. Called by
 * ui/* modules at their own module-eval time. Multiple registrations
 * for the same command name accumulate — every registered handler
 * fires when the command is invoked.
 */
export function registerOverlayImpl(name, fn) {
    if (!overlayImpls.has(name)) overlayImpls.set(name, []);
    overlayImpls.get(name).push(fn);
}

/** Internal dispatcher used by the overlay command impls below. */
function fireOverlay(name, ...args) {
    const fns = overlayImpls.get(name);
    if (!fns) return;
    for (const fn of fns) fn(...args);
}

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

// HUD-relevant subset of the player. ownedWeapons goes on the wire as
// an Array because JSON.stringify (used by WebRTCDataChannelTransport)
// reduces a Set to `{}`; the Local-DM BroadcastChannel preserves Set
// via structured clone, but for parity we send Array on both transports
// and `updateHud` re-Sets it on entry.
const stripHudData = (player) => [{
    currentWeapon: player.currentWeapon,
    ammo: { ...player.ammo },
    maxAmmo: { ...player.maxAmmo },
    health: player.health,
    armor: player.armor,
    ownedWeapons: [...player.ownedWeapons],
    collectedKeys: [...player.collectedKeys],
    score: player.score,
}];

// Enemy rotation runs every frame for every visible enemy and every
// viewer. The impl only reads enemy.{x,y,facing} and viewer.{x,y}; the
// raw enemy / Player objects contain cyclic refs (ai.target, thingRef)
// and Set fields that JSON.stringify can't cleanly serialize. Strip to
// just what the renderer needs.
const stripEnemyRotation = (thingIndex, enemy, viewers) => [
    thingIndex,
    { x: enemy.x, y: enemy.y, facing: enemy.facing },
    viewers.map(p => ({ x: p.x, y: p.y })),
];

export const COMMANDS = {
    // ── Per-player: camera & HUD ──────────────────────────────────────────
    updateCamera: {
        kind: 'per-pane',
        impl: updateCamera,
        serialize: stripCameraTransform,
        mirror: (pane, transform) => applyCameraUpdate(pane, transform),
    },
    updateHud: { kind: 'per-pane', impl: updateHud, serialize: stripHudData },

    // ── Per-player: effects ───────────────────────────────────────────────
    triggerFlash: { kind: 'per-pane', impl: effects.triggerFlash },
    showPowerup: { kind: 'per-pane', impl: effects.showPowerup },
    flickerPowerup: { kind: 'per-pane', impl: effects.flickerPowerup },
    hidePowerup: { kind: 'per-pane', impl: effects.hidePowerup },

    // ── Per-player: weapon visuals ────────────────────────────────────────
    switchWeapon: { kind: 'per-pane', impl: weapons.switchWeapon },
    startFiring: { kind: 'per-pane', impl: weapons.startFiring },
    stopFiring: { kind: 'per-pane', impl: weapons.stopFiring },

    // ── Per-player: player visuals ────────────────────────────────────────
    setPlayerDead: { kind: 'per-pane', impl: playerVisuals.setPlayerDead },
    setPlayerMoving: { kind: 'per-pane', impl: playerVisuals.setPlayerMoving },

    // ── Per-player: pause tint ────────────────────────────────────────────
    // Host pushes showPaused/hidePaused per slot when Game.pause/resume
    // fires (i.e., when App.openMenu / closeMenu runs). Master applies a
    // class to its own pane's renderer element; the same command fans
    // over the wire to each connected client's RenderClient so a joiner
    // sees the same tint without needing to know host's App state.
    showPaused: { kind: 'per-pane', impl: (renderer) => renderer.rendererEl.classList.add('paused') },
    hidePaused: { kind: 'per-pane', impl: (renderer) => renderer.rendererEl.classList.remove('paused') },

    // ── World: per-renderer map load ──────────────────────────────────────
    // Impl lives in scene.js. The auto-binding at the bottom of this file
    // wires DomRenderer.prototype.loadMap → impl(this, name) and
    // RenderSink.prototype.loadMap → forwardWorld('loadMap', [name]).
    // Orchestrator.prototype.loadMap has a custom override in
    // orchestrator.js that returns Promise.all of per-target results so
    // callers can await every local renderer's build. No serialize (name
    // is wire-safe). No mirror (loadMap rebuilds the scene from scratch
    // — there's no rendererState field to update).
    loadMap: { kind: 'world', impl: scene.loadMap },

    // ── World: enemies / things / projectiles / effects ───────────────────
    setEnemyState: { kind: 'world', impl: sprites.setEnemyState },
    resetEnemy: { kind: 'world', impl: sprites.resetEnemy },
    killEnemy: {
        kind: 'world',
        impl: sprites.killEnemy,
        mirror: (thingIndex) => applyThingCollected(thingIndex, true),
    },
    updateEnemyRotation: { kind: 'world', impl: sprites.updateEnemyRotation, serialize: stripEnemyRotation },
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
    // Establishing a player thing in the world also creates its
    // rendererState entry — same semantics as updateThingPosition,
    // only at create-time. Without this mirror the culler's first
    // read (between addPlayerThings and the first per-frame
    // movement-update) sees `rendererState.things[i] === undefined`
    // and falls back to the thingContainer's spawn x/y. Correct
    // today, but reliance on the fallback path was a "works because
    // of lazy allocation" subtlety; the mirror makes the contract
    // explicit. `_playerIndex` and `_sectorIndex` are ignored here
    // — neither is rendererState territory.
    createPlayerSprite: {
        kind: 'world',
        impl: sprites.createPlayerSprite,
        mirror: (thingIndex, _playerIndex, x, y, floorHeight) =>
            applyThingPositionUpdate(thingIndex, x, y, floorHeight),
    },
    createCorpse: { kind: 'world', impl: sprites.createCorpse },
    playPlayerAttack: { kind: 'world', impl: sprites.playPlayerAttack },

    // ── World: mechanics state ────────────────────────────────────────────
    setDoorState: { kind: 'world', impl: doors.setDoorState },
    setLiftState: { kind: 'world', impl: lifts.setLiftState },
    setCrusherOffset: { kind: 'world', impl: crushers.setCrusherOffset },
    toggleSwitchState: { kind: 'world', impl: toggleSwitchState },

    // ── World: surfaces ───────────────────────────────────────────────────
    lowerTaggedFloor: { kind: 'world', impl: lowerTaggedFloor },

    // ── World: lobby / intermission / results overlays ───────────────────
    // Stateful overlays — the show* variants are signals; the
    // orchestrator pulls the actual payload from Game (the registered
    // payload provider) at dispatch time via its show* overrides (see
    // orchestrator.js OVERLAY_PULLERS). Callers (match.js::endMatch,
    // Game.{start, beginPlay, restartMatch, _onLevelComplete},
    // master.js's onJoin/onLeave/onClaimChange/onMatch.reset) just
    // signal — they don't carry data. World-kind so master fans the
    // same command to every client's RenderClient and the visual
    // stays in sync across master + remote panes without a
    // side-channel envelope. Each impl calls into multiple UI
    // modules; each module gates internally on state.networkMode /
    // body classes so only the right one paints.
    //
    // World-command impls are invoked by DomRenderer as
    // `impl(this, ...args)` — renderer first, then the orchestrator
    // caller's args. The overlay impls don't use the renderer (they
    // route through the registry which targets DOM globally), so the
    // first slot is named `_renderer` and ignored. Without this
    // convention the renderer was captured as `payload` and
    // showResults crashed in scoreboard.js with a DomRenderer object
    // where it expected `{scores, kills, winnerIndex, mapName}`.
    showLobby:        { kind: 'world', impl: (_renderer, payload) => fireOverlay('showLobby', payload) },
    hideLobby:        { kind: 'world', impl: (_renderer) => fireOverlay('hideLobby') },
    showIntermission: { kind: 'world', impl: renderIntermission },
    hideIntermission: { kind: 'world', impl: clearIntermission },
    showResults:      { kind: 'world', impl: (_renderer, payload) => fireOverlay('showResults', payload) },
    hideResults:      { kind: 'world', impl: (_renderer) => fireOverlay('hideResults') },
    setMatchTimer:    { kind: 'world', impl: (_renderer, text) => fireOverlay('setMatchTimer', text) },

    // game-state transitions. Master's game-state.js calls
    // `broadcastGameState(next)` on every transitionTo; this fans out
    // through the renderer-command pipeline. The impl is idempotent on
    // master (applyRemoteGameState early-returns when state hasn't
    // changed) and writes body[data-game-state] on the client so CSS gates
    // (`body[data-game-state="lobby"] ...`) stay aligned with master.
    setGameState:     { kind: 'world', impl: (_renderer, payload) => fireOverlay('setGameState', payload) },
};

export const PER_PANE_COMMANDS = Object.fromEntries(
    Object.entries(COMMANDS).filter(([, c]) => c.kind === 'per-pane'),
);

export const WORLD_COMMANDS = Object.fromEntries(
    Object.entries(COMMANDS).filter(([, c]) => c.kind === 'world'),
);

// ── Prototype binding ────────────────────────────────────────────────────
// commands.js owns the registry, so it also owns wiring the registry
// onto the renderer-side classes. Imports go at the bottom so the
// classes are loaded after the registry is defined and after all impl
// modules are fully evaluated — sidesteps the circular-import TDZ
// hazard that otherwise hits when a renderer impl (hud.js, scene.js,
// etc.) transitively pulls commands.js back through DomRenderer or
// RenderSink.
import { DomRenderer } from './dom-renderer.js';
import { RenderSink } from '../transport/render-sink.js';

// DomRenderer: each command method invokes its impl with `this`
// (the renderer) as the first arg. The orchestrator's per-player
// dispatch invokes per-pane methods on renderers whose playerIndex
// matches; its world dispatch invokes world methods on every target.
for (const [name, { impl }] of Object.entries(PER_PANE_COMMANDS)) {
    DomRenderer.prototype[name] = function (...args) {
        return impl(this, ...args);
    };
}
for (const [name, { impl }] of Object.entries(WORLD_COMMANDS)) {
    DomRenderer.prototype[name] = function (...args) {
        return impl(this, ...args);
    };
}

// RenderSink: each command method serializes its args (via the
// optional `serialize` to strip non-cloneable refs like player
// objects) and posts a wire envelope. Per-pane envelopes carry
// `target: paneIndex`; world envelopes don't.
for (const [name, { serialize }] of Object.entries(PER_PANE_COMMANDS)) {
    RenderSink.prototype[name] = function (...args) {
        const wireArgs = serialize ? serialize(...args) : args;
        this._post(name, wireArgs);
    };
}
for (const [name, { serialize }] of Object.entries(WORLD_COMMANDS)) {
    RenderSink.prototype[name] = function (...args) {
        const wireArgs = serialize ? serialize(...args) : args;
        this.forwardWorld(name, wireArgs);
    };
}
