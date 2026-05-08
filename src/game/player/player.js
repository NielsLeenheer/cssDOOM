/**
 * Player — per-player gameplay state.
 *
 * In single-player there is one Player at state.players[0]. In split-screen
 * deathmatch there are two, one per pane. World-level state (things,
 * projectiles, doors, lifts) lives on `state` directly; anything owned by an
 * individual player lives here.
 */

export class Player {
    constructor(index = 0) {
        this.index = index;
        this.viewportIndex = index;

        // ── Position & orientation ────────────────────────────────────────
        // World-space coordinates in DOOM units. X/Y are the horizontal plane;
        // Z is the vertical (eye height above the map origin).
        // angle is in radians: 0 = north, increasing = counter-clockwise.
        this.x = 0;
        this.y = 0;
        this.z = 0;
        this.angle = 0;
        // The floor height of the sector the player currently stands on.
        // z is derived from this plus the eye-height offset.
        this.floorHeight = 0;

        // ── Stats & combat ────────────────────────────────────────────────
        this.health = 100;
        this.armor = 0;
        // Armor type determines damage absorption ratio:
        //   0 = no armor, 1 = green armor (absorbs 1/3), 2 = blue armor (absorbs 1/2)
        // Based on: linuxdoom-1.10/p_inter.c:P_DamageMobj()
        this.armorType = 0;
        this.ammo = { bullets: 50, shells: 0, rockets: 0, cells: 0 };
        this.maxAmmo = { bullets: 200, shells: 50, rockets: 50, cells: 300 };
        this.hasBackpack = false;
        this.isDead = false;
        this.deathTime = 0;
        // Currently selected weapon slot number (1=Fist, 2=Pistol, 3=Shotgun, etc.)
        this.currentWeapon = 2;
        // Set of weapon slot numbers the player has picked up.
        this.ownedWeapons = new Set([1, 2]);  // Fist + Pistol
        // True while the weapon fire animation is playing, prevents re-firing.
        this.isFiring = false;
        // performance.now() timestamp at which the weapon-switch animation ends.
        // While now() < weaponSwitchUntil, fireWeapon refuses to fire. Set by
        // equipWeapon when the slot actually changes; matches the CSS animation
        // duration (WEAPON_SWITCH_MS in constants.js).
        this.weaponSwitchUntil = 0;
        // Accumulates time spent standing on a damaging sector (e.g. nukage).
        // Damage is applied once per second, then the timer resets.
        this.sectorDamageTimer = 0;
        // Collected key cards — set of color strings ('blue', 'yellow', 'red')
        this.collectedKeys = new Set();
        // Active powerups — each key is a powerup name, value is remaining
        // duration in seconds. Based on: linuxdoom-1.10/d_player.h:player_t.powers[]
        this.powerups = {};

        // Reference to this player's entry in state.things — set by
        // addPlayerThings() at scene-build time so canMoveTo's thing-collision
        // loop can skip self via excludeThing, and so AI / hitscan / projectile
        // code can find the player as a damageable target.
        this.thingRef = null;
        this.thingIndex = -1;

        // Deathmatch frag count. Reset to 0 by resetMatch() at the start of
        // each match; awardFrag(victim, killer) increments the killer (or
        // decrements the victim on suicide).
        this.score = 0;

        // Most-recent attacker, for kill attribution in awardFrag. Set by
        // damagePlayer; meaningful only between damage and death.
        this.lastDamagedBy = null;
        this.lastDamagedTime = 0;
    }
}
