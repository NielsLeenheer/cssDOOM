/**
 * CatRenderer — FlatRenderer's silly twin. Same DomRenderer
 * subclass structure (inherited pane DOM, ResizeObserver-driven
 * perspective, spectator delegates, per-player / world commands),
 * same suppressed-command set as FlatRenderer (HUD / weapon /
 * overlay screens stay off), only difference is walls render with
 * a random pick from 10 cat photos instead of a flat color. Built
 * for the talk's "you can swap renderers on the fly" demo.
 */

import { DomRenderer } from '../dom/renderer.js';
import { RendererBase } from '../base.js';
import { buildCatScene } from './scene.js';
import * as maps from '../../shared/maps/index.js';

const IOS_GPU_RELEASE_DELAY_MS = 100;

export class CatRenderer extends DomRenderer {
    constructor(options) {
        super(options);
        this.paneEl.classList.add('pane-cat');
    }

    async loadMap(name) {
        if (this.hasScene) {
            this.clear();
            await new Promise(resolve => setTimeout(resolve, IOS_GPU_RELEASE_DELAY_MS));
        }
        await maps.load(name);
        const { fragment, sceneState } = await buildCatScene(maps.mapData);
        this.sceneEl.replaceChildren(fragment);
        Object.assign(this.sceneState, sceneState);
        this._lastLoadedMap = name;
        if (this.state.camera) {
            this.updateCamera(this.state.camera);
        }
    }
}

// Same suppression set as FlatRenderer — keep the renderer focused
// on the room shells while combat / overlay clutter stays out.
const SUPPRESSED = new Set([
    'updateHud', 'triggerFlash', 'showPowerup', 'flickerPowerup',
    'hidePowerup', 'switchWeapon', 'startFiring', 'stopFiring',
    'setPlayerDead', 'setPlayerMoving', 'showPaused', 'hidePaused',
    'toggleSwitchState', 'setFloorHeight',
    'showLobby', 'hideLobby', 'showIntermission', 'hideIntermission',
    'showResults', 'hideResults', 'showTimer', 'showAttract',
    'hideAttract', 'showLevelTransition', 'hideLevelTransition',
]);

CatRenderer.prototype.dispatch = function (env) {
    if (SUPPRESSED.has(env.cmd)) return;
    return RendererBase.prototype.dispatch.call(this, env);
};
