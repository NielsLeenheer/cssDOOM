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
 *                 (renderer, ...args). For RenderSink, an optional
 *                 `serialize(...args)` strips non-cloneable refs (player
 *                 objects, etc.) before postMessage; defaults to identity.
 *
 *   `world`     — addressed to every pane in every window. impl signature
 *                 is (renderer, ...args). The orchestrator iterates all
 *                 targets: each local DomRenderer runs impl(self, ...args);
 *                 each RenderSink forwards to its joiner over the wire.
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
import { renderIntermission, clearIntermission } from './screens/intermission.js';
import { renderResults, clearResults } from './screens/scoreboard.js';
import { showLobby, hideLobby } from './screens/lobby.js';
import { showTimer } from './hud/match-timer.js';

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
    // updateCamera fans to every target at the matching playerIndex:
    // the local DomRenderer transforms its scene; the local
    // AudioRenderer (audio.js) updates its listener position so the
    // next playSound math reflects the new viewpoint.
    updateCamera: {
        kind: 'per-pane',
        impl: updateCamera,
        serialize: stripCameraTransform,
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
    // is wire-safe). No mirror needed — loadMap rebuilds the scene from
    // scratch on each renderer; subsequent updateCamera /
    // updateThingPosition dispatches populate per-renderer state.
    loadMap: { kind: 'world', impl: scene.loadMap },

    // ── World: enemies / things / projectiles / effects ───────────────────
    setEnemyState: { kind: 'world', impl: sprites.setEnemyState },
    resetEnemy: { kind: 'world', impl: sprites.resetEnemy },
    killEnemy: { kind: 'world', impl: sprites.killEnemy },
    updateEnemyRotation: { kind: 'world', impl: sprites.updateEnemyRotation, serialize: stripEnemyRotation },
    updateThingPosition: { kind: 'world', impl: sprites.updateThingPosition },
    reparentThingToSector: { kind: 'world', impl: sprites.reparentThingToSector },
    collectItem: { kind: 'world', impl: sprites.collectItem },
    uncollectItem: { kind: 'world', impl: sprites.uncollectItem },
    setThingMoving: { kind: 'world', impl: sprites.setThingMoving },
    createPuff: { kind: 'world', impl: sprites.createPuff },
    createExplosion: { kind: 'world', impl: sprites.createExplosion },
    createTeleportFog: { kind: 'world', impl: sprites.createTeleportFog },
    createProjectile: { kind: 'world', impl: sprites.createProjectile },
    removeProjectile: { kind: 'world', impl: sprites.removeProjectile },
    // Establishing a player thing in the world also creates its
    // per-renderer state entry — the impl populates
    // renderer.state.things[thingIndex] alongside the DOM creation
    // so the culler's first read (between addPlayerThings and the
    // first per-frame movement-update) sees a real position rather
    // than an undefined entry.
    createPlayerSprite: { kind: 'world', impl: sprites.createPlayerSprite },
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
    // orchestrator pulls the actual payload from Game (the
    // registered payload provider) at dispatch time via its show*
    // overrides (see orchestrator.js OVERLAY_PULLERS). Callers
    // (match.js::endMatch, Game.{start, beginPlay, restartMatch,
    // _onLevelComplete}, master.js's
    // onJoin/onLeave/onClaimChange/onMatch.reset) just signal — they
    // don't carry data. World-kind so master fans the same command
    // to every client's RenderClient and the visual stays in sync
    // across master + remote panes without a side-channel envelope.
    // Each impl is per-pane in practice: it reads `renderer.paneEl`
    // and `renderer.playerIndex` to write into THIS pane only;
    // multiple targets means the impl fires once per pane.
    showLobby:        { kind: 'world', impl: showLobby },
    hideLobby:        { kind: 'world', impl: hideLobby },
    showIntermission: { kind: 'world', impl: renderIntermission },
    hideIntermission: { kind: 'world', impl: clearIntermission },
    showResults:      { kind: 'world', impl: renderResults },
    hideResults:      { kind: 'world', impl: clearResults },
    // Attract overlay is one static element per pane (logo + "PRESS
    // TO START" text in the pane template). Visibility is a per-pane
    // `.active` class toggled by these impls. Inlined here (same
    // shape as showPaused/hidePaused above) because the real attract
    // module imports `game/level.js` and would create an init-time
    // cycle (commands → attract → match → movement → renderer/index
    // → commands) that breaks COMMANDS initialization.
    showAttract:      { kind: 'world', impl: (r) => r.paneEl.querySelector('.pane-attract')?.classList.add('active') },
    hideAttract:      { kind: 'world', impl: (r) => r.paneEl.querySelector('.pane-attract')?.classList.remove('active') },
    showTimer:        { kind: 'world', impl: showTimer },
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
