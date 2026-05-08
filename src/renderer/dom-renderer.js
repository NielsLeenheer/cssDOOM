/**
 * DomRenderer — represents one pane's renderer target.
 *
 * Per-pane commands (camera, HUD, weapon visuals, flash, key collect, player
 * dead state, etc.) are instance methods. They lose the paneIndex argument:
 * each instance owns one pane, so the index is implicit in `this`.
 *
 * World-level commands (enemy state, door state, thing positions, projectiles)
 * are NOT instance methods — they live on the Orchestrator and call into the
 * underlying renderer module once. The current implementation fans them out
 * across all panes inside the helper functions (sprites.js, doors.js, etc.),
 * so calling once at the orchestrator level updates every pane in lockstep.
 *
 * Implementation note: this is currently a facade over the existing
 * paneIndex-keyed renderer module. State (`dom.scenes`, `sceneStates`, etc.)
 * still lives at module scope in dom.js. A follow-on cleanup is to migrate
 * that state into the instance itself; for now the facade is enough to give
 * the orchestrator a swappable target abstraction (DomRenderer ↔ BroadcastSink
 * later) without rewriting twenty renderer files.
 */

import * as effects from './effects.js';
import * as weapons from './weapons.js';
import { updateHud } from './hud.js';
import { updateCamera } from './scene/camera.js';
import { updateCulling } from './scene/culling.js';
import * as playerVisuals from './scene/entities/player.js';

export class DomRenderer {
    constructor(paneIndex) {
        this.paneIndex = paneIndex;
    }

    // ── Camera / HUD / culling ─────────────────────────────────────────────

    updateCamera(player) {
        updateCamera(player, this.paneIndex);
    }

    updateHud(player) {
        updateHud(player, this.paneIndex);
    }

    updateCulling(player, worldThings, spectatorActive) {
        updateCulling(player, worldThings, spectatorActive, this.paneIndex);
    }

    // ── Effects (flash, powerups) ─────────────────────────────────────────

    triggerFlash(type) {
        effects.triggerFlash(this.paneIndex, type);
    }

    showPowerup(name) {
        effects.showPowerup(this.paneIndex, name);
    }

    flickerPowerup(name) {
        effects.flickerPowerup(this.paneIndex, name);
    }

    hidePowerup(name) {
        effects.hidePowerup(this.paneIndex, name);
    }

    // ── Weapon visuals ─────────────────────────────────────────────────────

    switchWeapon(weaponName, fireRate) {
        weapons.switchWeapon(this.paneIndex, weaponName, fireRate);
    }

    startFiring() {
        weapons.startFiring(this.paneIndex);
    }

    stopFiring() {
        weapons.stopFiring(this.paneIndex);
    }

    // ── Player visuals ─────────────────────────────────────────────────────

    setPlayerDead(...args) {
        playerVisuals.setPlayerDead(this.paneIndex, ...args);
    }

    setPlayerMoving(isMoving) {
        playerVisuals.setPlayerMoving(this.paneIndex, isMoving);
    }

    clearKeys() {
        playerVisuals.clearKeys(this.paneIndex);
    }

    collectKey(...args) {
        playerVisuals.collectKey(this.paneIndex, ...args);
    }
}
