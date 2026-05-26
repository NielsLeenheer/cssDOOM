/**
 * ShadeRenderer — black-and-white step in the talk's progression
 * visual (wireframe → shade → flat → fully textured). Walls render
 * white with sector lighting reading through as grey-scale shading;
 * floors / ceilings render pure black so room shapes read as
 * silhouetted planes against the wall surface.
 *
 * Implemented as a DomRenderer subclass for the same reason
 * FlatRenderer is: we inherit the pane DOM construction,
 * ResizeObserver-driven perspective, camera state, spectator
 * delegates, and the per-player / world commands we keep (chief
 * among them updateCamera). Things / effects / weapons / HUD
 * commands are suppressed at dispatch time below.
 *
 * The shade pane lives at slot 1 in ?visualize mode (top-right of the
 * 2×2 layout). See `manager.js`.
 */

import { DomRenderer } from '../dom/renderer.js';
import { RendererBase } from '../base.js';
import { buildShadeScene } from './scene.js';
import * as maps from '../../shared/maps/index.js';

const IOS_GPU_RELEASE_DELAY_MS = 100;

export class ShadeRenderer extends DomRenderer {
    constructor(options) {
        super(options);
        // CSS hook for `.pane.pane-shade` rules in viewport.css —
        // suppresses HUD chrome inherited from the pane template,
        // wipes light/door animations, recolors the viewport sky.
        this.paneEl.classList.add('pane-shade');
    }

    /**
     * Override of scene.loadMap with the shade-scene builder swapped
     * in. Mirrors the original's teardown + iOS GPU-release yield +
     * camera prime; skips culling prime because there are no things
     * to cull.
     */
    async loadMap(name) {
        if (this.hasScene) {
            this.clear();
            await new Promise(resolve => setTimeout(resolve, IOS_GPU_RELEASE_DELAY_MS));
        }
        await maps.load(name);
        const { fragment, sceneState } = await buildShadeScene(maps.mapData);
        this.sceneEl.replaceChildren(fragment);
        Object.assign(this.sceneState, sceneState);
        this._lastLoadedMap = name;
        if (this.state.camera) {
            this.updateCamera(this.state.camera);
        }
    }
}

// Same suppression set as FlatRenderer, with one addition: doors are
// also suppressed because the shade pane's CSS pins door panels in
// the closed position — propagating setDoorState would just churn
// the data-state attribute for no visible effect.
const SUPPRESSED = new Set([
    'updateHud', 'triggerFlash', 'showPowerup', 'flickerPowerup',
    'hidePowerup', 'switchWeapon', 'startFiring', 'stopFiring',
    'setPlayerDead', 'setPlayerMoving', 'showPaused', 'hidePaused',
    'setEnemyState', 'resetEnemy', 'killEnemy', 'updateEnemyRotation',
    'updateThingPosition', 'reparentThingToSector', 'collectItem',
    'uncollectItem', 'setThingMoving', 'createPuff', 'createExplosion',
    'createTeleportFog', 'createProjectile', 'removeProjectile',
    'createPlayerSprite', 'createCorpse', 'playPlayerAttack',
    'setDoorState', 'setLiftState', 'setCrusherOffset',
    'toggleSwitchState', 'setFloorHeight',
    'showLobby', 'hideLobby', 'showIntermission', 'hideIntermission',
    'showResults', 'hideResults', 'showTimer', 'showAttract',
    'hideAttract', 'showLevelTransition', 'hideLevelTransition',
]);

ShadeRenderer.prototype.dispatch = function (env) {
    if (SUPPRESSED.has(env.cmd)) return;
    return RendererBase.prototype.dispatch.call(this, env);
};
