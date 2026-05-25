/**
 * Renderer command registry.
 *
 * Every renderer command is declared once here, then drives:
 *
 *   - Orchestrator   — public API game code calls (per-pane methods route
 *                       to a target by paneIndex; world methods invoke the
 *                       local impl + broadcast to all sinks).
 *   - DomRenderer    — per-pane methods baked against `this.paneIndex`.
 *   - RenderSink     — per-pane methods post args verbatim to the wire.
 *   - renderer/index — flat-namespace re-exports for backward compat.
 *
 * Adding a new command becomes one entry in COMMANDS. Forgetting to wire
 * it through the four files used to be a silent client desync;
 * with the registry it's impossible.
 *
 * Two kinds:
 *
 *   `per-pane`  — addressed to one pane. impl signature is
 *                 (renderer, ...args). Callers pass wire-safe args
 *                 already in the right shape — orchestrator and
 *                 RenderSink pass them through without rewriting.
 *
 *   `world`     — addressed to every pane in every window. impl signature
 *                 is (renderer, ...args). The orchestrator iterates all
 *                 targets: each local DomRenderer runs impl(self, ...args);
 *                 each RenderSink forwards to its joiner over the wire.
 *
 * Callers carry the shape responsibility — the registry doesn't strip
 * Player or thing objects. See e.g. master.js / game/level.js for what
 * `updateCamera` / `updateHud` payloads look like; the impls
 * (`renderer/scene/camera.js`, `renderer/hud/hud.js`, etc.) document
 * the fields they read.
 */

import * as sprites from './dom/scene/entities/sprites.js';
import * as doors from './dom/scene/mechanics/doors.js';
import * as lifts from './dom/scene/mechanics/lifts.js';
import * as crushers from './dom/scene/mechanics/crushers.js';
import * as scene from './dom/scene/scene.js';
import { toggleSwitchState } from './dom/scene/mechanics/switches.js';
import { setFloorHeight } from './dom/scene/surfaces/floors.js';
import * as effects from './dom/hud/effects.js';
import * as weapons from './dom/hud/weapons.js';
import { updateHud } from './dom/hud/hud.js';
import { updateCamera } from './dom/scene/camera.js';
import * as playerVisuals from './dom/scene/entities/player.js';
import { renderIntermission, clearIntermission } from './dom/screens/intermission.js';
import { renderResults, clearResults } from './dom/screens/scoreboard.js';
import { showLobby, hideLobby } from './dom/screens/lobby.js';
import { showAttract, hideAttract } from './dom/screens/attract.js';
import { showTimer } from './dom/hud/match-timer.js';
import { showLevelTransition, hideLevelTransition } from './dom/hud/level-transition.js';

export const COMMANDS = {
    // ── Per-player: camera & HUD ──────────────────────────────────────────
    // updateCamera fans to every target at the matching playerIndex:
    // the local DomRenderer transforms its scene; the local
    // AudioRenderer (audio.js) updates its listener position so the
    // next playSound math reflects the new viewpoint.
    updateCamera: { kind: 'per-pane', impl: updateCamera },
    updateHud: { kind: 'per-pane', impl: updateHud },

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
    // Impl is async (buildScene awaits) — the orchestrator's generic
    // world dispatch returns Promise.all of every target's call so
    // callers (Level.load) can await every local renderer's build. No
    // mirror needed — loadMap rebuilds the scene from scratch on each
    // renderer; subsequent updateCamera / updateThingPosition dispatches
    // populate per-renderer state.
    loadMap: { kind: 'world', impl: scene.loadMap },

    // ── World: enemies / things / projectiles / effects ───────────────────
    setEnemyState: { kind: 'world', impl: sprites.setEnemyState },
    resetEnemy: { kind: 'world', impl: sprites.resetEnemy },
    killEnemy: { kind: 'world', impl: sprites.killEnemy },
    updateEnemyRotation: { kind: 'world', impl: sprites.updateEnemyRotation },
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
    // Paint-only — game-side mechanics owns the mapData mutation;
    // this command animates the DOM for one sector per call.
    setFloorHeight: { kind: 'world', impl: setFloorHeight },

    // ── World: lobby / intermission / results overlays ───────────────────
    // Stateful overlays. Every caller passes a complete payload —
    // Game's subscribers (lobby-state's onLobbyChange, claim-registry's
    // onClaimChange, onMatch('ended'), _onLevelComplete) build the
    // payload via `this.getXPayload()` and fire. master.js's onReady
    // catch-up addresses one sink directly with the same payload.
    // World-kind so master fans the same command to every client's
    // RenderClient — the visual stays in sync across master + remote
    // panes without a side-channel envelope. Each impl is per-pane
    // in practice: it reads `renderer.paneEl` and `renderer.playerIndex`
    // to write into THIS pane only; multiple targets means the impl
    // fires once per pane.
    showLobby:        { kind: 'world', impl: showLobby },
    hideLobby:        { kind: 'world', impl: hideLobby },
    showIntermission: { kind: 'world', impl: renderIntermission },
    hideIntermission: { kind: 'world', impl: clearIntermission },
    showResults:      { kind: 'world', impl: renderResults },
    hideResults:      { kind: 'world', impl: clearResults },
    // Attract overlay — per-pane `.active` class + camera-rotation
    // animation. Impls live in src/renderer/screens/attract.js (no
    // game/ imports, so no init-time cycle through this file).
    showAttract:      { kind: 'world', impl: showAttract },
    hideAttract:      { kind: 'world', impl: hideAttract },
    showTimer:        { kind: 'world', impl: showTimer },
    // Per-pane level-transition fade. Fired by Level.load before /
    // after the scene rebuild so each pane covers itself for the
    // disruptive part of the load — no more shared body-level
    // overlay.
    showLevelTransition: { kind: 'world', impl: showLevelTransition },
    hideLevelTransition: { kind: 'world', impl: hideLevelTransition },
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
import { DomRenderer } from './dom/dom-renderer.js';
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

// RenderSink: each command method posts its args verbatim to the
// joiner's wire envelope. Per-pane envelopes carry `target: paneIndex`;
// world envelopes don't. Wire-shape construction happens at the call
// site — RenderSink trusts that whatever the caller passed is
// `structured-clone` / `JSON.stringify` safe (no cyclic refs, no Set
// fields, etc.).
for (const name of Object.keys(PER_PANE_COMMANDS)) {
    RenderSink.prototype[name] = function (...args) {
        this._post(name, args);
    };
}
for (const name of Object.keys(WORLD_COMMANDS)) {
    RenderSink.prototype[name] = function (...args) {
        this.forwardWorld(name, args);
    };
}
