/**
 * View-side dispatch commands for the SoftwareRenderer (mixed onto the
 * prototype). These mutate *presentation* state that lives on the
 * renderer, not on the Scene: the held weapon, the damage / pickup screen
 * flash, the HUD readout, and the full-screen intermission / results /
 * lobby screens. They're per-pane — two panes viewing the same world show
 * different weapons and HUDs — which is exactly why they don't belong on
 * the shared world model.
 *
 * World commands (move / kill / collect a thing, open a door, …) live on
 * the Scene (scene.js); the renderer forwards those to `this.scene`.
 */

import { WEAPON_INFO, FLASH_COLOR } from './tables.js';

export const commandMethods = {
    // ── HUD overlay state (weapon, screen flash, status-bar readout) ─────

    switchWeapon(name, fireRate) {
        const info = WEAPON_INFO[name];
        if (!info) { this.weapon = null; return; }
        this.weapon = { name, info, fireRate: fireRate || 400, firing: false, fireStart: 0 };
    },

    startFiring() {
        if (this.weapon) { this.weapon.firing = true; this.weapon.fireStart = performance.now(); }
    },

    stopFiring() {
        if (this.weapon) this.weapon.firing = false;
    },

    triggerFlash(color) {
        const rgb = FLASH_COLOR[color];
        if (rgb) this.flash = { r: rgb[0], g: rgb[1], b: rgb[2], start: performance.now() };
    },

    updateHud(player) {
        if (!player) return;
        this.hud = {
            health: Math.round(player.health ?? 0),
            armor: Math.round(player.armor ?? 0),
            ammo: player.ammo || {},
            maxAmmo: player.maxAmmo || {},
            currentWeapon: player.currentWeapon ?? 2,
            ownedWeapons: new Set(player.ownedWeapons || []),
            keys: new Set(player.collectedKeys || []),
        };
    },

    // ── Full-screen screen toggles (rendering lives in screens.js) ───────

    showIntermission(payload) {
        if (!payload?.stats) return;
        this.intermission = {
            mapName: payload.mapName ?? null,
            stats: payload.stats,
            startTime: performance.now(),
        };
    },

    hideIntermission() {
        this.intermission = null;
    },

    showResults(payload) { this.results = payload || null; },
    hideResults() { this.results = null; },

    // The Game re-fires showLobby AFTER it has transitioned to PLAYING
    // (with inLobby:false) so the DM lobby's per-pane claim overlays can
    // flip 'ready'→'active' — see Game.beginPlay. For this renderer that
    // late fire would otherwise latch the lobby panel back on top of the
    // running world, so treat inLobby:false as a hide, exactly like the
    // CSSRenderer's showLobby does.
    showLobby(payload) { this.lobby = payload && payload.inLobby ? payload : null; },
    hideLobby() { this.lobby = null; },
};
