/**
 * All magic numbers and lookup tables in one place.
 */

// ============================================================================
// Player Movement & Physics
// Governs how the player moves, collides with walls, and interacts with the
// world geometry each frame.
// ============================================================================

// DOOM's standard eye height is 41 map units above the floor. This is used
// as the Y-offset for the camera.
export const EYE_HEIGHT = 41;

export const MOVE_SPEED = 300;             // Map units per second
export const RUN_MULTIPLIER = 2;           // Shift doubles movement and turn speed
export const TURN_SPEED = Math.PI;         // Radians per second (180 degrees)

export const PLAYER_RADIUS = 16;
export const PLAYER_HEIGHT = 56;           // Based on: linuxdoom-1.10/p_local.h:MAXRADIUS (player height for passage checks)
export const MAX_STEP_HEIGHT = 24;         // Tallest step the player can climb without jumping

// ============================================================================
// Rendering Limits
// Controls draw distance and frame timing for the renderer.
// ============================================================================

// Objects beyond this distance are not updated (enemy AI, sprite billboarding).
// Keeps per-frame work manageable.
export const MAX_RENDER_DISTANCE = 2250;

// Cap the per-frame delta time so a single long pause (e.g. tab switch)
// doesn't cause huge physics jumps.
export const MAX_FRAME_DELTA_TIME = 0.05;  // 50 ms = minimum 20 FPS equivalent

// ============================================================================
// Interaction — Switches, Doors, and Triggers
// Constants for the player's ability to activate linedefs (switches, doors)
// and walk-over triggers in the map.
// ============================================================================

export const USE_RANGE = 64;               // Max distance (map units) for activating a switch or door
export const WALK_TRIGGER_RANGE = 32;      // How close the player must be to a walk-over linedef to trigger it

export const SWITCH_ON_PREFIX = 'SW1';     // Texture prefix for an inactive (ready-to-press) switch
export const SWITCH_OFF_PREFIX = 'SW2';    // Texture prefix for an already-activated switch

export const EXIT_SPECIAL = 11;            // Linedef special type: normal level exit
export const SECRET_EXIT_SPECIAL = 51;     // Linedef special type: secret level exit
export const LIFT_USE_SPECIAL = 62;        // Linedef special type: SR Lower Lift Wait Raise (use-activated)

export const LIFT_RAISE_DELAY = 3000;      // Milliseconds a lift waits at the bottom before rising back up
export const DOOR_CLOSE_DELAY = 4000;      // Milliseconds a door stays open before auto-closing

// ============================================================================
// Thing Classification Sets
// Used to quickly check whether a thing type is an enemy or a collectible
// pickup, avoiding repeated array lookups at runtime.
// ============================================================================

export const ENEMIES = new Set([9, 58, 3001, 3002, 3003, 3004]);
export const PICKUPS = new Set([
    2001, 2002, 2003, 2004, 2005, 2006,           // weapons
    8,                                            // backpack
    2007, 2008, 2010, 2046, 2048, 2049,           // ammo
    2011, 2012, 2013, 2014, 2015, 2018, 2019,     // health/armor
    2022, 2023, 2024, 2025, 2026, 2045,           // powerups
    5, 6, 13, 38, 39, 40,                         // keys
]);

// ============================================================================
// Pickup Effects
// Defines what collecting each pickup does. `statType` is the player stat to
// modify ('health', 'armor', or 'ammo'); `amount` is the value added. Ammo
// pickups additionally specify which ammo pool (`ammoType`) they fill.
// ============================================================================

export const PICKUP_EFFECTS = {
    2011: { statType: 'health', amount: 10 },   // Stimpack
    2012: { statType: 'health', amount: 25 },   // Medikit
    2013: { statType: 'health', amount: 100 },  // Soul Sphere (sets health to 200)
    2014: { statType: 'health', amount: 1 },    // Health Bonus
    2015: { statType: 'armor',  amount: 1 },                    // Armor Bonus (+1, no class upgrade)
    2018: { statType: 'armor',  amount: 100, armorClass: 1 },  // Green Armor (skipped if armor >= 100)
    2019: { statType: 'armor',  amount: 200, armorClass: 2 },  // Blue Armor (skipped if armor >= 200)
    2007: { statType: 'ammo', ammoType: 'bullets', amount: 10 },   // Clip
    2048: { statType: 'ammo', ammoType: 'bullets', amount: 50 },   // Box of Ammo
    2008: { statType: 'ammo', ammoType: 'shells',  amount: 4 },    // Shells
    2049: { statType: 'ammo', ammoType: 'shells',  amount: 20 },   // Box of Shells
    2010: { statType: 'ammo', ammoType: 'rockets', amount: 1 },    // Rocket
    2046: { statType: 'ammo', ammoType: 'rockets', amount: 5 },    // Box of Rockets
    // Powerups
    2022: { statType: 'powerup', powerup: 'invulnerability' },  // Invulnerability
    2023: { statType: 'powerup', powerup: 'berserk' },          // Berserk
    2024: { statType: 'powerup', powerup: 'invisibility' },     // Partial Invisibility
    2025: { statType: 'powerup', powerup: 'radsuit' },          // Radiation Suit
    2045: { statType: 'powerup', powerup: 'lightamp' },         // Light Amp Visor
};

// ============================================================================
// Powerup Durations
// Based on: linuxdoom-1.10/p_user.c:P_PlayerThink() — INVULNTICS, INVISTICS,
// INFRATICS, IRONTICS. All defined as seconds (original DOOM uses 35 tics/sec).
// ============================================================================

export const POWERUP_DURATION = {
    invulnerability: 30,   // INVULNTICS = 30*35 tics = 30 seconds
    invisibility: 60,      // INVISTICS  = 60*35 tics = 60 seconds
    radsuit: 60,           // IRONTICS   = 60*35 tics = 60 seconds
    lightamp: 120,         // INFRATICS  = 120*35 tics = 120 seconds
    berserk: Infinity,     // Lasts entire level (strength boost is permanent)
};

// ============================================================================
// Keys
// Maps key thing-type numbers to their color. Both keycards and skull keys
// of the same color open the same doors.
// ============================================================================

export const KEY_TYPES = {
    5:  'blue',     // Blue Keycard
    6:  'yellow',   // Yellow Keycard
    13: 'red',      // Red Keycard
    38: 'red',      // Red Skull
    39: 'yellow',   // Yellow Skull
    40: 'blue',     // Blue Skull
};

// ============================================================================
// Player Stats & Limits
// ============================================================================

// Based on: linuxdoom-1.10/p_map.c:PIT_CheckThing() — blockdist = thing->radius + tmthing->radius.
// Most pickup things have radius 20, player radius 16, giving a box check of 36 on each axis.
// Using 40 with a circle check approximates DOOM's square check.
export const PICKUP_RANGE = 40;
export const MAX_HEALTH = 100;             // Normal health cap (Soul Sphere can exceed this)
export const MAX_ARMOR = 200;
export const MAX_AMMO = { bullets: 200, shells: 50, rockets: 50, cells: 300 };

// ============================================================================
// Weapon Pickups
// Maps thing-type numbers for weapon pickups to the weapon slot they unlock.
// Slot numbers correspond to keys in the WEAPONS table below.
// ============================================================================

// Based on: linuxdoom-1.10/p_inter.c:P_TouchSpecialThing() weapon cases
// Each weapon pickup also grants ammo (ammoType + amount).
export const WEAPON_PICKUPS = {
    2001: { slot: 3, ammoType: 'shells',  amount: 8 },   // Shotgun
    2002: { slot: 4, ammoType: 'bullets', amount: 20 },   // Chaingun
    2003: { slot: 5, ammoType: 'rockets', amount: 2 },    // Rocket Launcher
    2005: { slot: 6, ammoType: null,      amount: 0 },    // Chainsaw
};

// ============================================================================
// Weapon Definitions
//
// Stats based on linuxdoom-1.10/p_pspr.c weapon action functions and
// d_items.c:weaponinfo[]. Fire rates converted from tics (1/35s) to ms.
//
// Damage is either a fixed value (for simple weapons) or uses a damage
// function string that the combat code resolves at fire time:
//   'melee'   — (P_Random()%10+1)*2 = 2-20; ×10 with Berserk
//   'hitscan' — 5*(P_Random()%3+1)  = 5, 10, or 15
//   'pellets' — 7 pellets, each doing 'hitscan' damage (35-105 total)
//   'rocket'  — (P_Random()%8+1)*20 = 20-160 direct hit + radius 128 splash
//
// Accuracy: Approximation — fire rates are rounded from tic-based frame
// durations; the animation system cannot perfectly replicate DOOM's
// state machine frame timing.
// ============================================================================

export const WEAPONS = {
    // Based on: A_Punch — 22 tics ≈ 629ms. Range = MELEERANGE (64 in DOOM, 80 here for 3D perspective)
    1: { name: 'FIST',     ammoType: null,      ammoPerShot: 0,  fireRate: 629,  sound: 'DSPUNCH',  damageType: 'melee',   range: 80 },
    // Based on: A_FirePistol — 19 tics ≈ 543ms. Hitscan with P_GunShot damage
    2: { name: 'PISTOL',   ammoType: 'bullets',  ammoPerShot: 1,  fireRate: 543,  sound: 'DSPISTOL', damageType: 'hitscan', range: 2048, hitscan: true },
    // Based on: A_FireShotgun — 44 tics ≈ 1257ms. 7 pellets × hitscan damage
    3: { name: 'SHOTGUN',  ammoType: 'shells',   ammoPerShot: 1,  fireRate: 1257, sound: 'DSSHOTGN', damageType: 'pellets', range: 2048, hitscan: true, pellets: 7 },
    // Based on: A_FireCGun — 4 tics ≈ 114ms per bullet. Same damage as pistol
    4: { name: 'CHAINGUN', ammoType: 'bullets',  ammoPerShot: 1,  fireRate: 114,  sound: 'DSPISTOL', damageType: 'hitscan', range: 2048, hitscan: true, continuous: true },
    // Based on: A_FireMissile — 20 tics ≈ 571ms. Projectile with splash damage
    5: { name: 'ROCKET',   ammoType: 'rockets',  ammoPerShot: 1,  fireRate: 571,  sound: 'DSRLAUNC', damageType: 'rocket',  range: 2048 },
    // Based on: A_Saw — 8 tics ≈ 229ms. Same melee damage formula without berserk bonus
    6: { name: 'CHAINSAW', ammoType: null,       ammoPerShot: 0,  fireRate: 229,  sound: 'DSSAWHIT', damageType: 'melee',   range: 80 },
};

// ============================================================================
// Thing Health
// Hit points for shootable things. When reduced to zero the thing dies
// (enemies) or explodes (barrels).
// ============================================================================

export const THING_HEALTH = {
    3004: 20,    // Zombieman
    9:    30,    // Shotgun Guy
    3001: 60,    // Imp
    3002: 150,   // Demon
    58:   150,   // Spectre (invisible Demon, same health)
    3003: 1000,  // Baron of Hell
    2035: 20,    // Barrel
};

// Set of all thing types that can be damaged by the player's weapons.
export const SHOOTABLE = new Set([...ENEMIES, 2035]);

// ============================================================================
// Barrel (Explosive) Properties
// ============================================================================

export const BARREL_RADIUS = 16;               // Collision radius (map units)

// Maps DOOM thing types with MF_SOLID to their collision radius.
// Based on: linuxdoom-1.10/info.c — mobjinfo[].radius and MF_SOLID flag.
// Enemies and barrels are handled separately (ENEMY_AI_STATS.radius and BARREL_RADIUS).
export const SOLID_THING_RADIUS = {
    25: 16,     // Impaled Human
    26: 16,     // Twitching Impaled
    27: 16,     // Skull on Pole
    28: 16,     // Skulls and Candles
    29: 16,     // Skull on Stick
    35: 16,     // Candelabra
    43: 16,     // Burning Tree
    44: 16,     // Tall Blue Firestick
    45: 16,     // Tall Green Firestick
    46: 16,     // Tall Red Firestick
    47: 16,     // Brown Stump
    48: 16,     // Tall Tech Column
    54: 32,     // Big Tree
    55: 16,     // Short Blue Firestick
    56: 16,     // Short Green Firestick
    57: 16,     // Short Red Firestick
    70: 16,     // Burning Barrel
    2028: 16,   // Floor Lamp
};
export const BARREL_EXPLOSION_RADIUS = 128;    // Blast damage radius (map units)
export const BARREL_EXPLOSION_DAMAGE = 128;    // Maximum damage at point-blank; falls off linearly with distance

// Player rocket projectile properties.
// Based on: linuxdoom-1.10/info.c:mobjinfo[MT_ROCKET] and p_mobj.c
// Accuracy: Approximation — speed converted from fixed-point map units per tic.
export const PLAYER_ROCKET_SPEED = 700;        // Map units per second (DOOM: 20 * FRACUNIT per tic ≈ 700/s)
export const PLAYER_ROCKET_RADIUS = 11;        // Collision radius (DOOM: 11 * FRACUNIT)
export const ROCKET_SPLASH_RADIUS = 128;       // Blast radius (DOOM: 128 map units)
export const ROCKET_SPLASH_DAMAGE = 128;       // Max splash damage at center (DOOM: 128)

// ============================================================================
// Enemy AI
// Per-enemy-type stats that drive the AI behaviour loop: how fast they move,
// how far they can see and shoot, and how much damage they deal.
// ============================================================================

export const ENEMY_AI_STATS = {
    // Hitscan enemies: `pellets` is how many rays are fired per attack, `hitscanSound` is the
    // fire sound. Damage per pellet is rolled as ((random 0-4)+1)*3 = 3-15, matching original DOOM.
    // Based on: linuxdoom-1.10/p_enemy.c:A_PosAttack(), A_SPosAttack()
    //
    // painChance: probability (0-255) of entering pain state when hit.
    //   Based on: linuxdoom-1.10/info.c:mobjinfo[].painchance
    // reactionTime: delay in seconds before first attack after spotting the player.
    //   Based on: linuxdoom-1.10/info.c:mobjinfo[].reactiontime (in tics, converted to seconds)
    // attackDuration: seconds the enemy stays in its attack animation.
    //   Based on: linuxdoom-1.10/info.c state frame durations for attack sequences.
    // painDuration: seconds the enemy flinches when hit.
    //   Based on: linuxdoom-1.10/info.c state frame durations for pain sequences.
    // Speeds are effective map units/sec = mobjinfo.speed × (35 / chaseTics).
    // chaseTics is the tic count per chase animation frame (from info.c states[]).
    // Based on: linuxdoom-1.10/info.c mobjinfo[].speed and state tic counts.
    3004: { speed: 70,  chaseTics: 4, radius: 20, attackRange: 1500, damage: 0,  cooldown: 1.5, sightRange: 3000, melee: false, alertSound: 'DSPOSIT1', pellets: 1, hitscanSound: 'DSPISTOL', painChance: 200, reactionTime: 8/35, attackDuration: 0.457, painDuration: 0.171 },  // Zombieman (speed 8, 4-tic frames)
    9:    { speed: 93,  chaseTics: 3, radius: 20, attackRange: 1500, damage: 0,  cooldown: 2.0, sightRange: 3000, melee: false, alertSound: 'DSPOSIT2', pellets: 3, hitscanSound: 'DSSHOTGN', painChance: 170, reactionTime: 8/35, attackDuration: 0.457, painDuration: 0.171 },  // Shotgun Guy (speed 8, 3-tic frames)
    3001: { speed: 93,  chaseTics: 3, radius: 20, attackRange: 1500, damage: 15, cooldown: 2.0, sightRange: 3000, melee: false, meleeRange: 64, alertSound: 'DSBGSIT1', painChance: 200, reactionTime: 8/35, attackDuration: 0.457, painDuration: 0.171 },  // Imp (speed 8, 3-tic frames) — melee: A_TroopAttack claw
    3002: { speed: 175, chaseTics: 2, radius: 30, attackRange: 64,   damage: 0,  cooldown: 1.0, sightRange: 3000, melee: true,  meleeRange: 64, alertSound: 'DSSGTSIT', painChance: 180, reactionTime: 8/35, attackDuration: 0.343, painDuration: 0.171 },  // Demon (speed 10, 2-tic frames) — melee only: A_SargAttack
    58:   { speed: 175, chaseTics: 2, radius: 30, attackRange: 64,   damage: 0,  cooldown: 1.0, sightRange: 3000, melee: true,  meleeRange: 64, alertSound: 'DSSGTSIT', painChance: 180, reactionTime: 8/35, attackDuration: 0.343, painDuration: 0.171 },  // Spectre (speed 10, 2-tic frames) — melee only: A_SargAttack
    3003: { speed: 93,  chaseTics: 3, radius: 24, attackRange: 1500, damage: 60, cooldown: 2.5, sightRange: 3000, melee: false, meleeRange: 64, alertSound: 'DSPOSIT3', painChance: 50,  reactionTime: 8/35, attackDuration: 0.571, painDuration: 0.171 },  // Baron (speed 8, 3-tic frames) — melee: A_BruisAttack claw
};

// Defines projectile visuals and physics for enemies that fire projectiles
// instead of using hitscan attacks.
// missileDamage: base damage multiplier for impact, matching DOOM's mobjinfo.damage field.
// Impact damage is rolled as (P_Random()%8+1) * missileDamage.
// Based on: linuxdoom-1.10/info.c — MT_TROOPSHOT damage=3, MT_BRUISERSHOT damage=8
export const ENEMY_PROJECTILES = {
    3001: { sprite: 'BAL1A0', speed: 350, sound: 'DSFIRSHT', hitSound: 'DSFIRXPL', size: 15, missileDamage: 3 },  // Imp fireball: 10*FRACUNIT/tic × 35 = 350 units/s, 3–24 damage
    3003: { sprite: 'BAL7A1A5', speed: 525, sound: 'DSFIRSHT', hitSound: 'DSFIRXPL', size: 16, missileDamage: 8 }, // Baron fireball: 15*FRACUNIT/tic × 35 = 525 units/s, 8–64 damage
};

export const ENEMY_RADIUS = 20;               // Collision radius for all enemies (map units)
export const MELEE_RANGE = 80;                 // Distance at which melee enemies stop and attack
export const LINE_OF_SIGHT_CHECK_INTERVAL = 0.2; // Seconds between enemy line-of-sight recalculations

// Based on: linuxdoom-1.10/p_local.h — BASETHRESHOLD = 100 (tics).
// At 35 tics/second, 100 tics ≈ 2.86 seconds. We store in seconds directly.
export const INFIGHTING_THRESHOLD = 2.86;

// ============================================================================
// Sector Damage
// DOOM sector special types that hurt the player while standing on them.
// The value is damage per second applied to the player.
// ============================================================================

export const SECTOR_DAMAGE = {
    5: 10,    // Nukage (10 hp/s)
    7: 5,     // Light nukage (5 hp/s)
    16: 20,   // Super nukage (20 hp/s)
    4: 20,    // Strobe nukage (20 hp/s + strobe light effect)
};

// ============================================================================
// Map List
