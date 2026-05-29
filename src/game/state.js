/**
 * Mutable game state accessible by all modules.
 *
 * Shared world state (things, projectiles, doors, lifts) lives here directly.
 * Per-player state (position, health, ammo, weapons, keys, powerups) lives
 * on Player objects in `state.players`. SP has length 1; DM has length 2.
 *
 * ── Conceptual ownership ───────────────────────────────────────────────
 * The fields below live on this module-level singleton for cross-module
 * convenience — most consumers don't need to thread Game/Level
 * references through their callsites. Conceptually:
 *
 *   App owns:  gameMode, networkMode, skillLevel.
 *              (App.start / applyMode write these; they outlive any Game.)
 *
 *   Game owns: players (roster), match.
 *              (Game.start sizes the roster; resetMatch/endMatch manage
 *              match. Both persist across the held Game's lifetime —
 *              a new Game replaces the roster + match wholesale.)
 *
 *   Level owns: things, projectiles, doorState, liftState, crusherState.
 *               Level.tick mutates them every frame; Level.load
 *               constructs them; Level teardown / clearSceneState
 *               clears them.
 *
 *  The ownership map describes intent; storage stays on the singleton
 *  for now. Moving fields onto their owner instances would be a
 *  separate refactor.
 */

import { Player } from './player/player.js';

export const state = {
    // Skill level 1-5 (maps to DOOM flag bits for thing spawning)
    skillLevel: 1,

    // Gameplay rules: 'singleplayer' or 'deathmatch'. Drives game-side
    // behavior (spawn rules, item respawn, scoring, etc.). The menu
    // selects this; CSS layout reads `body[data-game-mode]`.
    gameMode: 'singleplayer',

    // Transport context: 'standalone' (no peers), 'host' (master with a
    // signaling room open accepting Network DM remotes), or 'client'
    // (this window is a remote / Local DM secondary connected to a
    // master). Orthogonal to gameMode — Network DM is
    // (gameMode='deathmatch', networkMode='host'); a remote joining a DM
    // host is (gameMode='deathmatch', networkMode='client'). CSS layout
    // reads `body[data-network-mode]` where relevant.
    networkMode: 'standalone',

    // Deathmatch match state. Null in SP. Set by resetMatch() to
    // { fragLimit, timeLimit, startTime, ended, winner }.
    match: null,

    // ── Players ───────────────────────────────────────────────────────
    // Length 1 in single-player, 2 in deathmatch. Per-player fields like
    // position, health, weapons, score live on each Player.
    players: [new Player(0)],

    // ── Doors & lifts ─────────────────────────────────────────────────
    // Maps from sector index → state object tracking open/close animation
    // progress, direction, and timing for each door/lift.
    doorState: new Map(),
    liftState: new Map(),
    crusherState: new Map(),

    // ── Things (entities) ──────────────────────────────────────────────
    // Array of entity objects for in-world sprites (enemies, pickups,
    // decorations) and the live player thing entries (kind:'player').
    // Each entry's array index serves as the thing ID for renderer
    // communication.
    things: [],

    // ── Projectiles ───────────────────────────────────────────────────
    // Active projectiles in flight (fireballs, rockets, etc.). Each entry
    // tracks position, velocity, and damage info. Each has an `id` field
    // used to reference the corresponding visual element in the renderer.
    projectiles: [],
    nextProjectileId: 0,

    // ── Player corpses ────────────────────────────────────────────────
    // Renderer-only decorations spawned by createCorpse when a player
    // dies — they aren't in state.things, so they don't drive collision
    // / AI / scoring. Tracked here so the world snapshot sent to a
    // reconnecting joiner can re-emit createCorpse for each one and
    // the joiner sees the bodies that piled up before it joined.
    // Cleared in clearSceneState (a fresh map drops every corpse).
    deathCorpses: [],
};

// ── Debug flags ──────────────────────────────────────────────────────
// Toggled from the debug menu at runtime.
export const debugFlags = {
    noEnemyAttack: false,
    noEnemyMove: false,
    noclip: false,
};
