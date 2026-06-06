/**
 * Dispatch command surface for the SoftwareRenderer (mixed onto the
 * prototype). This is the renderer's whole inbound contract with the game
 * loop: every world / per-player envelope the CanvasRenderer forwards ends
 * up here (the entity-state mutators, the HUD overlay setters, and the
 * full-screen-screen show/hide toggles). They only mutate renderer state;
 * the render passes read it.
 *
 * Door / lift commands live in sectors.js (next to their simulation), and
 * the screen *rendering* lives in screens.js — only the show/hide state
 * setters are here.
 */

import {
    TAU, WEAPON_INFO, FLASH_COLOR, PLAYER_ANIM, PLAYER_CORPSE_VARIANT,
    BARREL_FRAMES, PUFF_FRAMES, EXPLOSION_FRAMES, TFOG_FRAMES,
} from './tables.js';

export const commandMethods = {
    // ── Entity state (game loop → things / projectiles / effects) ────────

    updateThingPosition(i, x, y, floorZ) {
        const e = this.things.get(i);
        if (e) { e.x = x; e.y = y; e.floorZ = floorZ; }
    },

    reparentThingToSector(i, sectorIndex) {
        const e = this.things.get(i);
        const l = this._sectorLight[sectorIndex];
        if (e && l != null) e.light = l;
    },

    collectItem(i) { const e = this.things.get(i); if (e) e.collected = true; },
    uncollectItem(i) { const e = this.things.get(i); if (e) { e.collected = false; e.state = 'idle'; e.deathStart = 0; } },

    setEnemyState(i, _type, newState) {
        const e = this.things.get(i);
        if (!e || e.state === 'dead') return;
        e.state = newState === 'attacking' ? 'attack'
                : newState === 'idle' ? 'idle'
                : 'walk';
    },

    setThingMoving(i, moving) {
        const e = this.things.get(i);
        if (e && e.state !== 'dead') e.state = moving ? 'walk' : 'idle';
    },

    playPlayerAttack(i) {
        const e = this.things.get(i);
        if (e && e.state !== 'dead') e.state = 'attack';
    },

    killEnemy(i, _type, instant /* , gib */) {
        const e = this.things.get(i);
        if (!e) return;
        if (e.category === 'barrel') {
            // Barrels don't fall over — they detonate and vanish.
            this._spawnEffect(e.x, e.y, e.floorZ + 24, BARREL_FRAMES, 60, true);
            e.collected = true;
            return;
        }
        e.state = 'dead';
        e.deathStart = instant ? -1 : performance.now();
    },

    resetEnemy(i, _type, x, y, floorZ) {
        const e = this.things.get(i);
        if (!e) return;
        e.state = 'idle';
        e.deathStart = 0;
        e.collected = false;
        if (x !== undefined) { e.x = x; e.y = y; e.floorZ = floorZ; }
    },

    updateEnemyRotation(i, enemy, viewers) {
        const e = this.things.get(i);
        if (!e || !e.isEnemy) return;
        e.x = enemy.x; e.y = enemy.y; e.facing = enemy.facing;
        const v = viewers[this.viewerPlayerIndex] ?? viewers[0];
        if (!v) return;
        const toViewer = Math.atan2(v.y - enemy.y, v.x - enemy.x);
        let rel = toViewer - enemy.facing;
        rel = ((rel % TAU) + TAU) % TAU;
        e.rotation = (Math.floor((rel + Math.PI / 8) / (Math.PI / 4)) % 8) + 1;
    },

    createProjectile(id, spec) {
        this.projectiles.set(id, {
            sprite: spec.sprite,
            sx: spec.startX, sy: spec.startY, sz: spec.startZ,
            ex: spec.endX, ey: spec.endY, ez: spec.endZ,
            duration: spec.duration || 1,
            start: performance.now(),
        });
    },

    removeProjectile(id) { this.projectiles.delete(id); },

    // Note the argument orders: puff / teleport-fog are (x, z, y); the
    // explosion is (x, y, z) — matching the game's dispatch sites.
    createPuff(x, z, y) { this._spawnEffect(x, y, z, PUFF_FRAMES, 50, true); },
    createExplosion(x, y, z) { this._spawnEffect(x, y, z, EXPLOSION_FRAMES, 60, true); },
    createTeleportFog(x, z, y) { this._spawnEffect(x, y, z, TFOG_FRAMES, 45, false); },

    _spawnEffect(x, y, z, frames, frameMs, centered) {
        this.effects.push({ x, y, z, frames, frameMs, centered, start: performance.now() });
    },

    createCorpse(x, y, floorZ, sectorIndex, playerIndex, gib) {
        const variant = PLAYER_CORPSE_VARIANT[playerIndex] ?? '';
        this.statics.push({
            x, y, floorZ,
            light: this._sectorLight[sectorIndex] ?? 200,
            name: (gib ? 'PLAYW0' : 'PLAYN0') + variant,
        });
    },

    createPlayerSprite(thingIndex, playerIndex, x, y, floorZ /* , sectorIndex */) {
        if (this.things.has(thingIndex)) return;   // idempotent
        this.things.set(thingIndex, {
            type: -1,
            category: 'player',
            x, y, floorZ,
            light: 220,
            isEnemy: true,
            anim: PLAYER_ANIM,
            fixedName: 'PLAYA1',
            rotation: 1,
            facing: 0,
            state: 'idle',
            collected: false,
            deathStart: 0,
            walkPhase: Math.random() * 1000,
            playerIndex,
        });
    },

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
    // DomRenderer's showLobby does.
    showLobby(payload) { this.lobby = payload && payload.inLobby ? payload : null; },
    hideLobby() { this.lobby = null; },
};
