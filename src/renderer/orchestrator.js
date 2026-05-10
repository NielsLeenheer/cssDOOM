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
        // sceneStates layout (always 2 in current HTML). Two-window mode
        // swaps one of these for a BroadcastSink via replaceTarget().
        this.targets = [new DomRenderer(0), new DomRenderer(1)];
    }

    /** Returns the target for a given pane index, or null if out of range. */
    target(paneIndex) {
        return this.targets[paneIndex] ?? null;
    }

    /**
     * Swap the target at a given pane index. Used to install a BroadcastSink
     * when a secondary window connects, and to swap back to a DomRenderer
     * when it disconnects. The replaced instance is returned in case the
     * caller wants to keep it around (e.g. to restore on disconnect).
     */
    replaceTarget(paneIndex, target) {
        const previous = this.targets[paneIndex];
        this.targets[paneIndex] = target;
        return previous;
    }

    /** All sink targets currently registered (used to fan out world commands). */
    _sinks() {
        const out = [];
        for (const t of this.targets) {
            if (t && typeof t.forwardWorld === 'function') out.push(t);
        }
        return out;
    }

    /** Forward a world command to all registered sinks (master local DOM is updated by _world). */
    _broadcastWorld(method, args) {
        const sinks = this._sinks();
        for (const sink of sinks) sink.forwardWorld(method, args);
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

    // ── World commands (one local call, plus forward to any sinks) ───────
    //
    // Each call: (1) invoke the underlying helper which iterates every
    // local pane internally — preserves existing behavior in single-window
    // mode; (2) forward an envelope to any registered sinks so secondary
    // windows can apply the same world change to their local DOM.

    setEnemyState(...args) { sprites.setEnemyState(...args); this._broadcastWorld('setEnemyState', args); }
    resetEnemy(...args) { sprites.resetEnemy(...args); this._broadcastWorld('resetEnemy', args); }
    killEnemy(...args) { sprites.killEnemy(...args); this._broadcastWorld('killEnemy', args); }
    updateEnemyRotation(...args) { sprites.updateEnemyRotation(...args); this._broadcastWorld('updateEnemyRotation', args); }
    updateThingPosition(...args) { sprites.updateThingPosition(...args); this._broadcastWorld('updateThingPosition', args); }
    reparentThingToSector(...args) { sprites.reparentThingToSector(...args); this._broadcastWorld('reparentThingToSector', args); }
    collectItem(...args) { sprites.collectItem(...args); this._broadcastWorld('collectItem', args); }
    uncollectItem(...args) { sprites.uncollectItem(...args); this._broadcastWorld('uncollectItem', args); }
    setThingMoving(...args) { sprites.setThingMoving(...args); this._broadcastWorld('setThingMoving', args); }
    createPuff(...args) { sprites.createPuff(...args); this._broadcastWorld('createPuff', args); }
    createExplosion(...args) { sprites.createExplosion(...args); this._broadcastWorld('createExplosion', args); }
    createTeleportFog(...args) { sprites.createTeleportFog(...args); this._broadcastWorld('createTeleportFog', args); }
    createProjectile(...args) { sprites.createProjectile(...args); this._broadcastWorld('createProjectile', args); }
    removeProjectile(...args) { sprites.removeProjectile(...args); this._broadcastWorld('removeProjectile', args); }
    createPlayerSprite(...args) { sprites.createPlayerSprite(...args); this._broadcastWorld('createPlayerSprite', args); }
    createCorpse(...args) { sprites.createCorpse(...args); this._broadcastWorld('createCorpse', args); }
    playPlayerAttack(...args) { sprites.playPlayerAttack(...args); this._broadcastWorld('playPlayerAttack', args); }

    buildThing(...args) { buildThingHelper(...args); this._broadcastWorld('buildThing', args); }
    buildDoor(...args) { doors.buildDoor(...args); this._broadcastWorld('buildDoor', args); }
    setDoorState(...args) { doors.setDoorState(...args); this._broadcastWorld('setDoorState', args); }
    buildLift(...args) { lifts.buildLift(...args); this._broadcastWorld('buildLift', args); }
    setLiftState(...args) { lifts.setLiftState(...args); this._broadcastWorld('setLiftState', args); }
    buildCrusher(...args) { crushers.buildCrusher(...args); this._broadcastWorld('buildCrusher', args); }
    setCrusherOffset(...args) { crushers.setCrusherOffset(...args); this._broadcastWorld('setCrusherOffset', args); }
    toggleSwitchState(...args) { toggleSwitchState(...args); this._broadcastWorld('toggleSwitchState', args); }
    lowerTaggedFloor(...args) { lowerTaggedFloor(...args); this._broadcastWorld('lowerTaggedFloor', args); }

    clonePanes(paneCount) { clonePanesHelper(paneCount); }
    setMirrorMode(value) { setMirrorModeHelper(value); }
    isMirrorMode() { return isMirrorModeHelper(); }
    viewportsForEffect(playerIndex) { return viewportsForEffect(playerIndex); }

    /**
     * Attract-mode toggle. Sets body[data-attract] locally (CSS uses it to
     * show the kiosk overlay and hide the HUD) and broadcasts to sinks so
     * the secondary window mirrors the visual state.
     */
    setAttract(active) {
        if (active) document.body.dataset.attract = 'true';
        else delete document.body.dataset.attract;
        this._broadcastWorld('setAttract', [active]);
    }
}

export const orchestrator = new Orchestrator();
