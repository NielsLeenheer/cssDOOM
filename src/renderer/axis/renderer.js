/**
 * AxisRenderer — CSSRenderer that places the camera perpendicular
 * to the player on a fixed world axis instead of behind the player's
 * eyes. Used by ?cad to assemble a top + two side + 3D quad-view
 * CAD-style layout.
 *
 * Three axes:
 *
 *   z — camera at (player.x, player.y, player.z + OFFSET), looking
 *       DOWN. The horizontal pitch (rotateX(-90deg)) is applied via
 *       a per-pane CSS override (axis/styles.css) because the
 *       CSSRenderer's scene transform doesn't carry pitch.
 *
 *   x — camera at (player.x + OFFSET, player.y, player.z), looking
 *       WEST toward the player. Yaw alone handles this — no CSS
 *       override needed.
 *
 *   y — camera at (player.x, player.y + OFFSET, player.z), looking
 *       SOUTH toward the player. Same as x but rotated 90°.
 *
 * The renderer's whole pipeline (culling, sprite billboarding,
 * scene transform) sees the virtual camera position via the
 * normal updateCamera path, so things like the FOV-arc player
 * marker and sector-light brightness all key off the off-axis
 * camera automatically.
 */

import { CSSRenderer } from '../css/renderer.js';
import { culling } from '../css/scene/culling.js';
import { state } from '../../game/state.js';
import { getSectorAt } from '../../game/physics.js';

// Distance from the player to the off-axis camera, in world
// units. Bigger = wider FOV but the player gets foreshortened
// smaller; smaller = more dramatic perspective but less map
// context around the player. 600 sits roughly one DOOM room
// away — close enough to read the player + immediate
// surroundings, far enough to see a useful slice of the level.
const OFFSET = 100;

// Angle convention follows camera.css's `rotateY(--player-angle * -1rad)`:
// 0 = north, π/2 = east, π = south, -π/2 = west.
const AXIS_VIEWS = {
    z: { dx: 0,        dy: 0,      dz: 3 * OFFSET, angle: 0            },
    // Convention from lighting.css: forward = (-sin(angle), cos(angle)).
    // 0 = north, π/2 = west, π = south, -π/2 = east. So camera west
    // of player looking east is dx=-OFFSET, angle=-π/2.
    x: { dx: -OFFSET,  dy: 0,      dz: 0,          angle: -Math.PI / 2 },
    y: { dx: 0,        dy: OFFSET, dz: 0,          angle: Math.PI      }, // camera north, looking south
};

export class AxisRenderer extends CSSRenderer {
    constructor({ axis, ...options }) {
        super(options);
        this.axis = axis;
        this.paneEl.classList.add('pane-axis', `pane-axis-${axis}`);
    }

    /**
     * Translate the player's reported camera state to a virtual
     * camera offset along this renderer's axis, then hand off to
     * the inherited CSSRenderer pipeline. Everything downstream
     * (culler, scene transform, marker arc) reads from the
     * virtual camera and stays oriented to the off-axis viewer.
     */
    updateCamera(player) {
        if (!player) return;
        const view = AXIS_VIEWS[this.axis];
        if (!view) return super.updateCamera(player);

        // Make sure the local player has an .enemy.player billboard
        // — Network DM's createPlayerSprite path is what gives us a
        // properly rotation-tracked sprite (heading row + mirror set
        // by updateEnemyRotation each frame). SP doesn't fire it
        // for the own player (you don't see yourself in first
        // person), so do it here. Idempotent — createPlayerSprite
        // no-ops when the thingIndex is already in thingDom.
        this._ensurePlayerBillboard();

        // --player-* drives camera.css's scene transform; we
        // overwrite it with the virtual axis-camera position so the
        // off-axis view is produced by the standard transform. The
        // ACTUAL player position + facing get stashed on a parallel
        // set of `--actor-*` custom properties so the in-scene
        // #player marker (positioned via axis/styles.css) still
        // renders at the real player location.
        super.updateCamera({
            x: player.x + view.dx,
            y: player.y + view.dy,
            z: player.z + view.dz,
            angle: view.angle,
            floorHeight: player.floorHeight ?? 0,
            isFiring: false,
        });
        const s = this.viewportEl.style;
        s.setProperty('--actor-x', player.x);
        s.setProperty('--actor-y', player.y);
        s.setProperty('--actor-z', player.z);
        s.setProperty('--actor-floor', player.floorHeight ?? 0);
        s.setProperty('--actor-angle', player.angle);

        // Cache the actual player position so updateEnemyRotation can
        // compute viewer-relative sprite cells without reaching into
        // state.players[0]. During envelope replay (?play=slot) the
        // game loop isn't running, so state.players[0] is stale/empty
        // and sprite rotations come out wrong; the camera envelope IS
        // replayed, so reading from here works in both live + replay.
        this._actorX = player.x;
        this._actorY = player.y;
    }

    /**
     * Substitute the axis camera position as the viewer so the
     * sprite cell + mirror picked by `updateEnemyRotation` track
     * the off-axis camera angle, not the player itself. Without
     * this, the local player's billboard always renders its
     * front-facing cell (the relative angle between the player
     * and themselves is 0) and other things misorient too.
     */
    updateEnemyRotation(thingIndex, enemy, viewers) {
        const view = AXIS_VIEWS[this.axis];
        if (this._actorX != null && view) {
            if (this.axis === 'z') {
                // Top-down camera sits directly above the player —
                // dx=dy=0 gives atan2(0, 0)=0 to the cell-selection
                // math, which ends up rotated wrong from what the
                // marker FOV shows. Shift the virtual viewer one
                // unit SOUTH of the player so cell 5 (back view)
                // lines up with the player facing north: we look
                // down on the player as if hovering behind them,
                // and the body always faces the FOV-arrow direction.
                viewers = [{ x: this._actorX, y: this._actorY - 1 }];
            } else {
                viewers = [{ x: this._actorX + view.dx, y: this._actorY + view.dy }];
            }
        }
        return super.updateEnemyRotation(thingIndex, enemy, viewers);
    }

    /**
     * Top-down (axis-z) looks straight down through a pitched scene.
     * The inherited culling reads from state.camera, which has the
     * player's horizontal yaw — frustum culling clips everything not
     * in front of the player's facing, and sky culling assumes the
     * camera is looking sideways past sky walls. Neither is meaningful
     * when we're looking down at the map, so disable both for this
     * pane. Distance + backface still apply normally.
     *
     * Culling flags are module-level globals; flip + run + restore
     * synchronously so other renderers in the same tick are unaffected
     * (the manager calls updateCulling one renderer at a time).
     */
    updateCulling(spectatorActive, collectStats) {
        if (this.axis !== 'z') return super.updateCulling(spectatorActive, collectStats);
        const savedFrustum = culling.frustum;
        const savedSky = culling.sky;
        culling.frustum = false;
        culling.sky = false;
        try {
            super.updateCulling(spectatorActive, collectStats);
        } finally {
            culling.frustum = savedFrustum;
            culling.sky = savedSky;
        }
    }

    _ensurePlayerBillboard() {
        const p = state.players[0];
        if (!p?.thingRef || p.thingIndex == null) return;
        // createPlayerSprite is itself a renderer method (bound from
        // the IMPLS in dom/renderer.js). Call it directly on `this`
        // so the sprite ends up in our sceneState.thingDom and
        // subsequent updateThingPosition / updateEnemyRotation
        // dispatches land correctly.
        this.createPlayerSprite(
            p.thingIndex,
            p.index,
            p.x,
            p.y,
            p.floorHeight,
            getSectorAt(p.x, p.y)?.sectorIndex,
        );
    }
}
