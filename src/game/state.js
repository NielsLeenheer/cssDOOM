/**
 * Mutable game state accessible by all modules.
 *
 * Shared world state (things, projectiles, doors, lifts) lives here directly.
 * Per-player state (position, health, ammo, weapons, keys, powerups) lives
 * on Player objects in `state.players`. SP has length 1; DM has length 2.
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
};

// ── Debug flags ──────────────────────────────────────────────────────
// Toggled from the debug menu at runtime.
export const debug = {
    noEnemyAttack: false,
    noEnemyMove: false,
    noclip: false,
};
