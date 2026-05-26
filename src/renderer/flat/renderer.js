/**
 * FlatRenderer — stripped-down DomRenderer for the talk's progression
 * visual. Same cssDOOM scene transform / perspective / lighting,
 * walls / floors / ceilings painted in flat colors from
 * `scripts/precompute-flat-colors.js`, things rendered as
 * solid-color billboarded rectangles (see flat/styles.css). No HUD,
 * no weapon, no overlay screens.
 *
 * Implemented as a DomRenderer subclass so we inherit the pane DOM
 * construction, ResizeObserver-driven perspective, camera state,
 * spectator delegates, and the per-player / world commands. HUD /
 * weapon / overlay commands are suppressed at dispatch below.
 *
 * The flat pane lives at slot 2 in ?visualize mode (bottom-left of the
 * 2×2 layout). See `manager.js`.
 */

import { DomRenderer } from '../dom/renderer.js';
import { RendererBase } from '../base.js';
import { buildFlatScene } from './scene.js';
import * as maps from '../../shared/maps/index.js';

const IOS_GPU_RELEASE_DELAY_MS = 100;

export class FlatRenderer extends DomRenderer {
    constructor(options) {
        super(options);
        // CSS hook so anything we want to suppress purely visually
        // (e.g. the HUD inherited from the pane template) can target
        // `.pane.pane-flat`. The renderer-command no-ops below already
        // prevent the data side from updating, but the HUD template
        // chrome (status bar background, face widget) is static DOM
        // and needs CSS to hide.
        this.paneEl.classList.add('pane-flat');
    }

    /**
     * Override of scene.loadMap with the flat-scene builder swapped
     * in. Mirrors the original's teardown + iOS GPU-release yield
     * + camera prime; skips culling prime because there are no
     * things to cull (only walls/floors/ceilings, which the culler
     * walks via state.things → empty here).
     */
    async loadMap(name) {
        if (this.hasScene) {
            this.clear();
            await new Promise(resolve => setTimeout(resolve, IOS_GPU_RELEASE_DELAY_MS));
        }
        await maps.load(name);
        const { fragment, sceneState } = await buildFlatScene(maps.mapData);
        this.sceneEl.replaceChildren(fragment);
        Object.assign(this.sceneState, sceneState);
        this._lastLoadedMap = name;
        if (this.state.camera) {
            this.updateCamera(this.state.camera);
        }
    }

    // updateCulling inherited from DomRenderer. It walks
    // state.wallElements / sectorContainers / things; things is
    // empty here (no FlatRenderer entries created) and the wall /
    // floor / ceiling cull path is exactly what we need — without
    // it, every surface stays at `hidden = true` (their initial
    // state set in walls.js / horizontal.js) and the pane shows
    // only the viewport's sky background.
}

// Commands the flat renderer should ignore. HUD chrome, weapon
// visuals, overlay screens write to nodes that DO exist (inherited
// from the pane template) but are CSS-hidden in `.pane-flat`, so
// running them would just be wasted work. Thing / effect /
// projectile / sprite commands ARE allowed — buildFlatScene
// creates thingDom entries, and the .pane-flat CSS flattens the
// resulting sprite / img children into solid-color rectangles.
const SUPPRESSED = new Set([
    // Per-pane: HUD + weapons + effects + player visuals + pause tint
    'updateHud', 'triggerFlash', 'showPowerup', 'flickerPowerup',
    'hidePowerup', 'switchWeapon', 'startFiring', 'stopFiring',
    'setPlayerDead', 'setPlayerMoving', 'showPaused', 'hidePaused',
    // World: things we don't render geometry-wise.
    // setDoorState / setLiftState / setCrusherOffset are NOT in this
    // set — the flat scene builds those mechanic containers and the
    // data-state / --offset CSS animations work identically to the
    // textured pane.
    'toggleSwitchState', 'setFloorHeight',
    // World: overlay screens — don't belong in the talk visual.
    'showLobby', 'hideLobby', 'showIntermission', 'hideIntermission',
    'showResults', 'hideResults', 'showTimer', 'showAttract',
    'hideAttract', 'showLevelTransition', 'hideLevelTransition',
]);

FlatRenderer.prototype.dispatch = function (env) {
    if (SUPPRESSED.has(env.cmd)) return;
    return RendererBase.prototype.dispatch.call(this, env);
};
