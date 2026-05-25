/**
 * Teleporters
 *
 * Walk-over teleporter linedefs that instantly move the player to a destination
 * thing (type 14) in the target sector.
 *
 * Based on: linuxdoom-1.10/p_telept.c:EV_Teleport()
 * Accuracy: Approximation — same walk-over trigger + destination lookup, using
 * line-crossing detection matching DOOM's original behaviour.
 *
 * When the player crosses a teleporter linedef:
 * 1. Player position is set to the destination coordinates.
 * 2. Player angle is set to the destination thing's angle.
 * 3. A brief green flash is shown (teleport fog).
 * 4. One-shot teleporters (W1, type 39/125) are disabled after first use.
 */

import { EYE_HEIGHT, PLAYER_RADIUS, SHOOTABLE, BARREL_RADIUS } from '../../shared/constants.js';

import { state } from '../state.js';
import { mapData } from '../../shared/maps/index.js';
import { getFloorHeightAt } from '../physics.js';
import * as renderer from '../../renderer/dom/index.js';
import { orchestrator } from '../../orchestrator.js';
import { damageEnemy } from '../entities/combat.js';

/**
 * Checks all teleporter linedefs each frame. Uses crossing detection: fires
 * when any player moves from one side of the linedef to the other, matching
 * the original DOOM behaviour (linuxdoom-1.10/p_spec.c:P_CrossSpecialLine).
 *
 * Each teleporter maintains a per-player previousSide map so two players
 * can independently cross the same teleporter.
 */
export function checkTeleporters() {
    const teleporters = mapData.teleporters;
    if (!teleporters || teleporters.length === 0) return;

    for (let i = 0; i < teleporters.length; i++) {
        const tp = teleporters[i];
        if (tp.used) continue;

        const dx = tp.end.x - tp.start.x;
        const dy = tp.end.y - tp.start.y;

        if (!tp._previousSidePerPlayer) tp._previousSidePerPlayer = new Map();

        for (const player of state.players) {
            const side = (player.x - tp.start.x) * dy - (player.y - tp.start.y) * dx;
            const currentSide = side > 0;

            const previousSide = tp._previousSidePerPlayer.get(player.index);
            tp._previousSidePerPlayer.set(player.index, currentSide);

            // First frame for this player: just record the side, don't fire
            if (previousSide === undefined) continue;

            if (previousSide !== currentSide) {
                // Save departure position for fog
                const departX = player.x;
                const departY = player.y;
                const departZ = player.floorHeight;

                // Telefrag: kill anything shootable at the destination
                // Based on: linuxdoom-1.10/p_map.c:PIT_StompThing()
                const allThings = state.things;
                for (let j = 0, len = allThings.length; j < len; j++) {
                    const thing = allThings[j];
                    if (thing.collected) continue;
                    if (!SHOOTABLE.has(thing.type)) continue;
                    const thingRadius = thing.ai ? thing.ai.radius : BARREL_RADIUS;
                    const blockDist = PLAYER_RADIUS + thingRadius;
                    if (Math.abs(thing.x - tp.destX) < blockDist && Math.abs(thing.y - tp.destY) < blockDist) {
                        damageEnemy(thing, 10000, null);
                    }
                }

                // Teleport the moving player
                player.x = tp.destX;
                player.y = tp.destY;
                player.angle = (tp.destAngle - 90) * Math.PI / 180;
                player.floorHeight = getFloorHeightAt(player.x, player.y);
                player.z = player.floorHeight + EYE_HEIGHT;
                // Mark this player's previous-side as the destination side so we
                // don't immediately re-trigger the teleporter from the new position.
                const destSide = (player.x - tp.start.x) * dy - (player.y - tp.start.y) * dx;
                tp._previousSidePerPlayer.set(player.index, destSide > 0);

                // Spawn teleport fog at departure and arrival
                // Based on: linuxdoom-1.10/p_telept.c — spawns MT_TFOG at both ends
                renderer.createTeleportFog(departX, departZ, departY);
                renderer.createTeleportFog(player.x, player.floorHeight, player.y);
                renderer.triggerFlash(player.viewportIndex, 'teleport-flash');
                orchestrator.playSound('DSTELEPT', { x: player.x, y: player.y });

                // Update the moving player's camera immediately so there's no
                // frame of the old position.
                renderer.updateCamera(player.viewportIndex, {
                    x: player.x,
                    y: player.y,
                    z: player.z,
                    angle: player.angle,
                    floorHeight: player.floorHeight ?? 0,
                    isFiring: player.isFiring,
                });

                // Disable one-shot teleporters
                if (tp.oneShot) tp.used = true;
                return; // only one teleport per frame
            }
        }
    }
}

