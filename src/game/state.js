/**
 * Mutable game state accessible by all modules.
 *
 * This is the shared data bridge between game logic and renderer.
 * Game logic writes gameplay fields (positions, health, AI).
 * Renderer reads them and updates visuals accordingly.
 */

export const state = {
    // Skill level 1-5 (maps to DOOM flag bits for thing spawning)
    skillLevel: 1,

    // ── Player position & orientation ─────────────────────────────────
    // World-space coordinates in DOOM units. X/Y are the horizontal plane;
    // Z is the vertical (eye height above the map origin).
    // playerAngle is in radians: 0 = north, increasing = counter-clockwise.
    playerX: 0,
    playerY: 0,
    playerZ: 0,
    playerAngle: 0,
    // The floor height of the sector the player currently stands on.
    // playerZ is derived from this plus the eye-height offset.
    floorHeight: 0,

    // ── Player stats & combat ─────────────────────────────────────────
    // Current health, armor, and ammo counts — displayed in the HUD
    // and modified by pickups, damage, and weapon fire.
    health: 100,
    armor: 0,
    // Armor type determines damage absorption ratio:
    //   0 = no armor, 1 = green armor (absorbs 1/3), 2 = blue armor (absorbs 1/2)
    // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj()
    armorType: 0,
    ammo: { bullets: 50, shells: 0, rockets: 0, cells: 0 },
    maxAmmo: { bullets: 200, shells: 50, rockets: 50, cells: 300 },
    hasBackpack: false,
    isDead: false,
    deathTime: 0,
    // Currently selected weapon slot number (1=Fist, 2=Pistol, 3=Shotgun, etc.)
    currentWeapon: 2,
    // Set of weapon slot numbers the player has picked up.
    ownedWeapons: new Set([1, 2]),  // Fist + Pistol
    // True while the weapon fire animation is playing, prevents re-firing.
    isFiring: false,
    // Accumulates time spent standing on a damaging sector (e.g. nukage).
    // Damage is applied once per second, then the timer resets.
    sectorDamageTimer: 0,
    // Collected key cards — set of color strings ('blue', 'yellow', 'red')
    collectedKeys: new Set(),
    // Active powerups — each key is a powerup name, value is remaining duration
    // in seconds. Based on: linuxdoom-1.10/d_player.h:player_t.powers[]
    powerups: {},

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

// ── Debug flags ──────────────────────────────────────────────────────
// Toggled from the debug menu at runtime.
export const debug = {
    noEnemyAttack: false,
    noEnemyMove: false,
    noclip: false,
};
