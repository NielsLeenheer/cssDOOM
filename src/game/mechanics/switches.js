/**
 * Switch interaction and action triggering.
 *
 * How switch interaction works:
 * 1. When the player presses the "use" key, a forward ray is cast from the
 *    player's position along their facing direction, reaching a point at
 *    half the USE_RANGE distance ahead.
 * 2. Every wall element in the scene is checked. Walls whose texture name
 *    begins with the switch-on or switch-off prefix are switch candidates.
 * 3. For each candidate, we project the forward check-point onto the wall's
 *    line segment (clamped to the segment endpoints) and measure the distance.
 *    If the distance is within USE_RANGE, the switch is activated.
 * 4. Activation toggles the switch's visual state (on/off) and looks up the
 *    associated linedef to determine what action to trigger:
 *      - Exit specials: load the next map (or the secret exit map).
 *      - Sector-tagged linedefs: toggle any doors or activate any lifts
 *        whose sector matches the linedef's sector tag.
 * 5. Only the first matching switch is activated per use attempt (early return).
 */

import {
    USE_RANGE, SWITCH_ON_PREFIX, SWITCH_OFF_PREFIX,
    EXIT_SPECIAL, SECRET_EXIT_SPECIAL,
} from '../constants.js';

import { state } from '../state.js';
import { mapData } from '../../shared/maps.js';
import { toggleDoor } from './doors.js';
import { activateLift } from './lifts.js';
import { activateCrusher } from './crushers.js';
import { loadMap, getNextMap, getSecretExitMap } from '../../shared/maps.js';
import * as renderer from '../../renderer/index.js';
import { isMatchLobby } from '../match.js';

export function tryUseSwitch(player) {
    if (isMatchLobby()) return;
    // Cast a forward ray from the player's position along their facing direction.
    // The check-point is placed at half USE_RANGE ahead — the actual distance
    // threshold is USE_RANGE, so this samples the midpoint of the interaction zone.
    const forwardX = -Math.sin(player.angle);
    const forwardY = Math.cos(player.angle);
    const checkPointX = player.x + forwardX * USE_RANGE / 2;
    const checkPointY = player.y + forwardY * USE_RANGE / 2;

    // Iterate over map walls looking for switch textures.
    for (const wall of mapData.walls) {
        if (!wall.texture) continue;

        // Determine whether this wall's texture is a switch (on or off variant).
        const isSwitchOn = wall.texture.startsWith(SWITCH_ON_PREFIX);
        const isSwitchOff = wall.texture.startsWith(SWITCH_OFF_PREFIX);
        if (!isSwitchOn && !isSwitchOff) continue;

        // Project the check-point onto the wall segment to find the closest point.
        // Uses the standard point-to-segment projection: compute parameter t along
        // the segment direction vector, clamp t to [0,1], then evaluate.
        const deltaX = wall.end.x - wall.start.x;
        const deltaY = wall.end.y - wall.start.y;
        const segmentLengthSquared = deltaX * deltaX + deltaY * deltaY;
        if (segmentLengthSquared === 0) continue;

        let projectionParameter = ((checkPointX - wall.start.x) * deltaX + (checkPointY - wall.start.y) * deltaY) / segmentLengthSquared;
        projectionParameter = Math.max(0, Math.min(1, projectionParameter));

        const closestX = wall.start.x + projectionParameter * deltaX;
        const closestY = wall.start.y + projectionParameter * deltaY;
        const distance = Math.sqrt((checkPointX - closestX) ** 2 + (checkPointY - closestY) ** 2);

        if (distance < USE_RANGE) {
            // Toggle the switch's visual state between on and off.
            renderer.toggleSwitchState(wall.wallId);

            // Look up the linedef associated with this wall to determine what
            // action the switch triggers (exit, door, lift, etc.).
            const linedef = mapData.linedefs[wall.linedefIndex];
            if (linedef) {
                if (linedef.specialType === EXIT_SPECIAL || linedef.specialType === SECRET_EXIT_SPECIAL) {
                    // Exit switches: load the next map, or the secret exit map
                    // if the linedef has the secret exit special type.
                    const nextMap = linedef.specialType === SECRET_EXIT_SPECIAL
                        ? getSecretExitMap()
                        : getNextMap();
                    if (nextMap) setTimeout(() => loadMap(nextMap), 1000);
                } else if (linedef.sectorTag > 0) {
                    // Sector-tagged switches: find all doors and lifts whose
                    // sector tag matches and activate them.
                    for (const [sectorIndex, doorEntry] of state.doorState) {
                        if (mapData.sectors[sectorIndex].tag === linedef.sectorTag) {
                            toggleDoor(sectorIndex, player);
                        }
                    }
                    for (const [sectorIndex, liftEntry] of state.liftState) {
                        if (liftEntry.tag === linedef.sectorTag) {
                            activateLift(sectorIndex);
                        }
                    }
                    for (const [sectorIndex] of state.crusherState) {
                        if (mapData.sectors[sectorIndex].tag === linedef.sectorTag) {
                            activateCrusher(sectorIndex);
                        }
                    }
                }
            }
            // Only activate the first switch found within range, then stop.
            return;
        }
    }
}
