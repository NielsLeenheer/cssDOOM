/**
 * Orchestrator — the renderer-side dispatcher that game code talks to.
 *
 * Owns a list of render targets (DomRenderer instances; future: BroadcastSink).
 * Routing model:
 *
 *   Per-player commands (triggerFlash, switchWeapon, updateCamera, updateHud,
 *   setPlayerDead, etc.) — game code passes a paneIndex; the orchestrator
 *   forwards to the matching target. The target's per-pane methods don't
 *   take a paneIndex (it's `this.paneIndex` inside).
 *
 *   World commands (setEnemyState, setDoorState, updateThingPosition, etc.) —
 *   no paneIndex. The orchestrator calls the underlying renderer-module
 *   helper once. Today those helpers iterate every pane internally, so a
 *   single call updates the world in every pane in lockstep. This is the
 *   current behavior; once instance-state migration happens, these will fan
 *   out across registered targets at the orchestrator layer.
 *
 * The public API surface mirrors what `src/renderer/index.js` exported
 * before this refactor — flat function names, paneIndex/playerIndex as the
 * first argument for per-player commands. Game code is unchanged.
 */

import { DomRenderer } from './dom-renderer.js';

import * as sprites from './scene/entities/sprites.js';
import * as doors from './scene/mechanics/doors.js';
import * as lifts from './scene/mechanics/lifts.js';
import * as crushers from './scene/mechanics/crushers.js';
import { toggleSwitchState } from './scene/mechanics/switches.js';
import { lowerTaggedFloor } from './scene/surfaces/floors.js';
import { buildThing as buildThingHelper } from './scene/entities/things.js';
import { clonePanes as clonePanesHelper, setMirrorMode as setMirrorModeHelper, isMirrorMode as isMirrorModeHelper, viewportsForEffect } from './scene/scene.js';

class Orchestrator {
    constructor() {
        // Default registration: one DomRenderer per pane in the current
        // sceneStates layout (always 2 in current HTML). The eventual
        // two-window mode will swap one of these for a BroadcastSink.
        this.targets = [new DomRenderer(0), new DomRenderer(1)];
    }

    /** Returns the target for a given pane index, or null if out of range. */
    target(paneIndex) {
        return this.targets[paneIndex] ?? null;
    }

    // ── Per-player commands (paneIndex first) ─────────────────────────────

    updateCamera(player, paneIndex = player.viewportIndex) {
        this.targets[paneIndex]?.updateCamera(player);
    }

    updateHud(player, paneIndex = player.viewportIndex) {
        this.targets[paneIndex]?.updateHud(player);
    }

    triggerFlash(paneIndex, type) {
        this.targets[paneIndex]?.triggerFlash(type);
    }

    showPowerup(paneIndex, name) {
        this.targets[paneIndex]?.showPowerup(name);
    }

    flickerPowerup(paneIndex, name) {
        this.targets[paneIndex]?.flickerPowerup(name);
    }

    hidePowerup(paneIndex, name) {
        this.targets[paneIndex]?.hidePowerup(name);
    }

    switchWeapon(paneIndex, weaponName, fireRate) {
        this.targets[paneIndex]?.switchWeapon(weaponName, fireRate);
    }

    startFiring(paneIndex) {
        this.targets[paneIndex]?.startFiring();
    }

    stopFiring(paneIndex) {
        this.targets[paneIndex]?.stopFiring();
    }

    setPlayerDead(paneIndex, ...args) {
        this.targets[paneIndex]?.setPlayerDead(...args);
    }

    setPlayerMoving(paneIndex, isMoving) {
        this.targets[paneIndex]?.setPlayerMoving(isMoving);
    }

    clearKeys(paneIndex) {
        this.targets[paneIndex]?.clearKeys();
    }

    collectKey(paneIndex, ...args) {
        this.targets[paneIndex]?.collectKey(...args);
    }

    // ── World commands (one call, helpers fan out across panes) ───────────

    setEnemyState(...args) { sprites.setEnemyState(...args); }
    resetEnemy(...args) { sprites.resetEnemy(...args); }
    killEnemy(...args) { sprites.killEnemy(...args); }
    updateEnemyRotation(...args) { sprites.updateEnemyRotation(...args); }
    updateThingPosition(...args) { sprites.updateThingPosition(...args); }
    reparentThingToSector(...args) { sprites.reparentThingToSector(...args); }
    collectItem(...args) { sprites.collectItem(...args); }
    uncollectItem(...args) { sprites.uncollectItem(...args); }
    setThingMoving(...args) { sprites.setThingMoving(...args); }
    createPuff(...args) { sprites.createPuff(...args); }
    createExplosion(...args) { sprites.createExplosion(...args); }
    createTeleportFog(...args) { sprites.createTeleportFog(...args); }
    createProjectile(...args) { sprites.createProjectile(...args); }
    removeProjectile(...args) { sprites.removeProjectile(...args); }
    createPlayerSprite(...args) { sprites.createPlayerSprite(...args); }
    createCorpse(...args) { sprites.createCorpse(...args); }
    playPlayerAttack(...args) { sprites.playPlayerAttack(...args); }

    buildThing(...args) { buildThingHelper(...args); }
    buildDoor(...args) { doors.buildDoor(...args); }
    setDoorState(...args) { doors.setDoorState(...args); }
    buildLift(...args) { lifts.buildLift(...args); }
    setLiftState(...args) { lifts.setLiftState(...args); }
    buildCrusher(...args) { crushers.buildCrusher(...args); }
    setCrusherOffset(...args) { crushers.setCrusherOffset(...args); }
    toggleSwitchState(...args) { toggleSwitchState(...args); }
    lowerTaggedFloor(...args) { lowerTaggedFloor(...args); }

    clonePanes(paneCount) { clonePanesHelper(paneCount); }
    setMirrorMode(value) { setMirrorModeHelper(value); }
    isMirrorMode() { return isMirrorModeHelper(); }
    viewportsForEffect(playerIndex) { return viewportsForEffect(playerIndex); }
}

export const orchestrator = new Orchestrator();
