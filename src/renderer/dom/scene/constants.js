/**
 * Renderer constants — visual thresholds, DOOM-to-CSS conversion values,
 * texture identifiers, and sprite lookup tables.
 */

// ============================================================================
// Lighting
// ============================================================================

// Floors of even the darkest sectors never go fully black — a small minimum
// keeps geometry visible and avoids "invisible wall" surprises.
export const LIGHT_MINIMUM_BRIGHTNESS = 0.12;

export const DOOM_LIGHT_MAX = 255;         // Upper bound of DOOM's sector light range

// DOOM's R_InitLightTables maps sector lightlevel to colormaps (0=bright, 31=black).
// The formula: startmap = (15 - lightLevel/16) * 4, offset by a medium-distance
// brightening factor to approximate DOOM's scalelight close-range boost.
export const LIGHT_DISTANCE_OFFSET = 4;   // Medium-distance scalelight compensation

// ============================================================================
// Sky & Special Textures
// ============================================================================

export const SKY_TEXTURE = 'F_SKY1';       // DOOM flat name used on sky ceilings/floors
export const NO_TEXTURE = '-';             // DOOM's marker meaning "no texture on this sidedef"

// ============================================================================
// Thing Sprites
// Maps DOOM thing-type numbers to the sprite lump name (without .png) used
// as the visual representation. Frame letter "A" = first frame; rotation
// digit "1" = front-facing, "0" = rotation-independent.
// ============================================================================

export const THING_SPRITES = {
    // Enemies (frame A, rotation 1 = front-facing)
    9:    'SPOSA1',   // Shotgun Guy
    3001: 'TROOA1',   // Imp
    3002: 'SARGA1',   // Demon
    58:   'SARGA1',   // Spectre (invisible Demon, same sprite)
    3003: 'BOSSA1',   // Baron of Hell
    3004: 'POSSA1',   // Zombieman
    3005: 'HEADA1',   // Cacodemon
    3006: 'SKULA1',   // Lost Soul
    // Pickups — weapons
    2001: 'SHOTA0',   // Shotgun
    2002: 'MGUNA0',   // Chaingun
    2003: 'LAUNA0',   // Rocket Launcher
    2004: 'PLASA0',   // Plasma Rifle
    2005: 'CSAWA0',   // Chainsaw
    2006: 'BFUGA0',   // BFG
    // Pickups — ammo
    2007: 'CLIPA0',   // Clip
    2008: 'SHELA0',   // Shells
    2010: 'ROCKA0',   // Rocket
    2046: 'BROKA0',   // Box of Rockets
    2048: 'AMMOA0',   // Box of Ammo
    2049: 'SBOXA0',   // Box of Shells
    8:    'BPAKA0',   // Backpack
    // Pickups — health & armor
    2011: 'STIMA0',   // Stimpack
    2012: 'MEDIA0',   // Medikit
    2013: 'SOULA0',   // Soul Sphere
    2014: 'BON1A0',   // Health Bonus
    2015: 'BON2A0',   // Armor Bonus
    2018: 'ARM1A0',   // Green Armor
    2019: 'ARM2A0',   // Blue Armor
    // Pickups — powerups
    2022: 'PINVA0',   // Invulnerability
    2023: 'PSTRA0',   // Berserk
    2024: 'PINSA0',   // Partial Invisibility
    2025: 'SUITA0',   // Radiation Suit
    2026: 'PMAPA0',   // Computer Map
    2045: 'PVISA0',   // Light Amp Visor
    // Keys
    5:  'BKEYA0',     // Blue Keycard
    6:  'YKEYA0',     // Yellow Keycard
    13: 'RKEYA0',     // Red Keycard
    38: 'RSKUA0',     // Red Skull
    39: 'YSKUA0',     // Yellow Skull
    40: 'BSKUA0',     // Blue Skull
    // Decorations & props
    10: 'PLAYW0',     // Bloody Mess
    12: 'PLAYW0',     // Bloody Mess 2
    15: 'PLAYN0',     // Dead Player
    24: 'POL5A0',     // Pool of Blood
    25: 'POL1A0',     // Impaled Human
    26: 'POL6A0',     // Twitching Impaled
    27: 'POL4A0',     // Skull on Pole
    28: 'POL2A0',     // Skulls and Candles
    29: 'POL3A0',     // Skull on Stick
    34: 'CANDA0',     // Candle
    35: 'CBRAA0',     // Candelabra
    43: 'TRE1A0',     // Burning Tree
    44: 'TBLUA0',     // Tall Blue Firestick
    45: 'TGRNA0',     // Tall Green Firestick
    46: 'TREDA0',     // Tall Red Firestick
    47: 'SMITA0',     // Brown Stump
    48: 'ELECA0',     // Tall Tech Column
    54: 'TRE2A0',     // Big Tree
    55: 'SMBLA0',     // Short Blue Firestick
    56: 'SMGNA0',     // Short Green Firestick
    57: 'SMRDA0',     // Short Red Firestick
    70: 'FCANA0',     // Burning Barrel
    2028: 'COLUA0',   // Floor Lamp
    2035: 'BAR1A0',   // Barrel
};

// ============================================================================
// Thing Display Names
// Maps thing-type numbers to kebab-case names used as CSS class selectors
// in sprites.css for animation and styling.
// ============================================================================

export const THING_NAMES = {
    3004: 'zombieman',    9: 'shotgun-guy',   3001: 'imp',
    3002: 'demon',        58: 'spectre',      3003: 'baron',
    2035: 'barrel',
    2013: 'soulsphere',   2014: 'health-bonus', 2015: 'armor-bonus',
    2024: 'invisibility', 2018: 'green-armor',  2019: 'blue-armor',
    46:   'red-torch',
};
