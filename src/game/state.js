/**
 * Mutable game state accessible by all modules.
 *
 * Shared world state (things, projectiles, doors, lifts) lives here directly.
 * Per-player state (position, health, ammo, weapons, keys, powerups) lives
 * on Player objects in `state.players`.
 *
 * During the multiplayer migration, `state.playerX`, `state.health`, etc. are
 * defined as getters/setters that forward to `state.players[0]` (see proxy
 * block at the end of this file). Once all call sites take an explicit
 * `player` parameter, those proxies will be removed.
 */

import { Player } from './player/player.js';

export const state = {
    // Skill level 1-5 (maps to DOOM flag bits for thing spawning)
    skillLevel: 1,

    // Game mode. Currently 'singleplayer' or 'deathmatch'. The menu sets
    // this when starting a match; CSS layout (body[data-mode]) follows.
    mode: 'singleplayer',

    // Deathmatch match state. Null in SP. Set by resetMatch() to
    // { fragLimit, timeLimit, startTime, ended, winner }.
    match: null,

    // Runtime-mutable keyboard+mouse target slot (which player they drive).
    // Default is player 0. The dev Tab handler toggles this between 0 and 1
    // when `import.meta.env.DEV && state.mode === 'deathmatch' && no gamepads`.
    kbmTargetPlayer: 0,

    // ── Players ───────────────────────────────────────────────────────
    // Length 1 in single-player, 2 in deathmatch. Per-player fields like
    // position, health, weapons live here. Legacy `state.playerX` etc.
    // proxy to `players[0]` via the Object.defineProperty block below.
    players: [new Player(0)],

    // ── Doors & lifts ─────────────────────────────────────────────────
    // Maps from sector index → state object tracking open/close animation
    // progress, direction, and timing for each door/lift.
    doorState: new Map(),
    liftState: new Map(),
    crusherState: new Map(),

    // ── Things (entities) ──────────────────────────────────────────────
    // Array of entity objects for in-world sprites (enemies, pickups,
    // decorations). Each entry holds gameplay metadata (position, hp, AI).
    // The array index serves as the thing ID for renderer communication.
    things: [],

    // ── Projectiles ───────────────────────────────────────────────────
    // Active projectiles in flight (fireballs, rockets, etc.). Each entry
    // tracks position, velocity, and damage info. Each has an `id` field
    // used to reference the corresponding visual element in the renderer.
    projectiles: [],
    nextProjectileId: 0,
};

// ── Backwards-compat proxies (Phase 1 multiplayer migration) ─────────
// Forward legacy `state.playerX`/`state.health`/etc. to `state.players[0]`.
// To be removed once all call sites take an explicit `player` parameter.
const PLAYER_FIELD_MAP = {
    playerX: 'x',
    playerY: 'y',
    playerZ: 'z',
    playerAngle: 'angle',
    floorHeight: 'floorHeight',
    health: 'health',
    armor: 'armor',
    armorType: 'armorType',
    ammo: 'ammo',
    maxAmmo: 'maxAmmo',
    hasBackpack: 'hasBackpack',
    isDead: 'isDead',
    deathTime: 'deathTime',
    currentWeapon: 'currentWeapon',
    ownedWeapons: 'ownedWeapons',
    isFiring: 'isFiring',
    sectorDamageTimer: 'sectorDamageTimer',
    collectedKeys: 'collectedKeys',
    powerups: 'powerups',
};

for (const [stateName, playerField] of Object.entries(PLAYER_FIELD_MAP)) {
    Object.defineProperty(state, stateName, {
        get() { return state.players[0][playerField]; },
        set(value) { state.players[0][playerField] = value; },
        enumerable: true,
        configurable: true,
    });
}

// ── Debug flags ──────────────────────────────────────────────────────
// Toggled from the debug menu at runtime.
export const debug = {
    noEnemyAttack: false,
    noEnemyMove: false,
    noclip: false,
};
