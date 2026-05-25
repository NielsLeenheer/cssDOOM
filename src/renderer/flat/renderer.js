/**
 * FlatRenderer — stripped-down DomRenderer for the talk's middle step
 * in the progression visual (wireframe → flat → fully textured). Same
 * cssDOOM scene transform / perspective / lighting; just no things,
 * no doors, no lifts, no HUD, no weapon, no effects. Walls / floors /
 * ceilings only, painted in flat colors from
 * `scripts/precompute-flat-colors.js`.
 *
 * Implemented as a DomRenderer subclass so we inherit the pane DOM
 * construction, ResizeObserver-driven perspective, camera state,
 * spectator delegates, and the auto-bound per-pane / world commands
 * that we keep (chief among them updateCamera, which writes the
 * scene-transform CSS vars and is identical to a textured pane).
 * Commands that operate on things / effects / weapons / HUD are
 * overridden to no-ops below so a dispatch addressed to a fresh-and-
 * empty scene doesn't blow up on missing thingDom entries.
 *
 * The flat pane lives at slot 1 in ?lines mode (top-right of the
 * 2×2 layout). See `dom-renderer-manager.js`.
 */

import { DomRenderer } from '../dom/dom-renderer.js';
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

// Commands the flat renderer should ignore. updateHud / switchWeapon /
// effect spawns / player visuals / lobby overlays etc. either operate
// on DOM nodes that don't exist in a flat pane (no .weapon child for
// switchWeapon, no thingDom entry for collectItem) or write text /
// classes we explicitly don't want surfaced (HUD digits, paused tint).
// Some of these would silently no-op against an empty sceneState;
// others would throw. Cheaper to blanket-disable them than to chase
// each impl's defensive-check pattern.
const NOOP_COMMANDS = [
    // Per-pane: HUD + weapons + effects + player visuals + pause tint
    'updateHud',
    'triggerFlash',
    'showPowerup',
    'flickerPowerup',
    'hidePowerup',
    'switchWeapon',
    'startFiring',
    'stopFiring',
    'setPlayerDead',
    'setPlayerMoving',
    'showPaused',
    'hidePaused',
    // World: enemies / things / projectiles / effects / player sprites
    'setEnemyState',
    'resetEnemy',
    'killEnemy',
    'updateEnemyRotation',
    'updateThingPosition',
    'reparentThingToSector',
    'collectItem',
    'uncollectItem',
    'setThingMoving',
    'createPuff',
    'createExplosion',
    'createTeleportFog',
    'createProjectile',
    'removeProjectile',
    'createPlayerSprite',
    'createCorpse',
    'playPlayerAttack',
    // World: mechanics state we don't render. switch toggles + raw
    // floor-height tweaks aren't represented in the flat aesthetic;
    // setDoorState / setLiftState / setCrusherOffset are inherited
    // from DomRenderer (the flat scene does build those mechanic
    // containers, so the data-state and --offset animations work
    // identically to the textured pane).
    'toggleSwitchState',
    'setFloorHeight',
    // World: overlay screens. Lobby / results / intermission / attract
    // / level-transition / timer don't belong in the talk visual.
    'showLobby',
    'hideLobby',
    'showIntermission',
    'hideIntermission',
    'showResults',
    'hideResults',
    'showTimer',
    'showAttract',
    'hideAttract',
    'showLevelTransition',
    'hideLevelTransition',
];
for (const name of NOOP_COMMANDS) {
    FlatRenderer.prototype[name] = function () {};
}
