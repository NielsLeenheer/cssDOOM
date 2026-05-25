/**
 * Doors
 *
 * Handles door initialization, toggling, and player interaction.
 *
 * How doors work:
 * - Visual animation: The renderer smoothly animates the door's face walls and
 *   ceiling surfaces between open and closed positions.
 * - State tracking: A Map (state.doorState) tracks each door by sector index,
 *   storing whether it is open/closed and its auto-close timer.
 * - Physics/collision: The door's closedHeight and openHeight are used elsewhere
 *   for collision detection. The `open` boolean lets movement code know whether
 *   the doorway is passable.
 * - Door types: DOOM doors are upper-texture walls that slide up into the ceiling.
 *   The "face walls" are the textured front faces that move, while "track walls"
 *   are the static side jambs that frame the doorway opening.
 * - Auto-close: After opening, a timer schedules automatic closing. If the player
 *   activates an already-open door, the timer resets.
 */

import { USE_RANGE, DOOR_CLOSE_DELAY } from '../../shared/constants.js';

import { state } from '../state.js';
import { mapData } from '../../shared/maps/index.js';
import { getSectorAt } from '../physics.js';
import { orchestrator } from '../../orchestrator.js';
import { sectorCenter } from '../../shared/maps/index.js';
import { isMatchLobby } from '../match.js';

const DOOR_PASSABLE_DELAY = 0.8; // seconds — slightly before fully open to allow ducking under

/**
 * Returns the door entry for a door wall, or null if not a door.
 */
export function getDoorEntry(wall) {
    if (!wall.isUpperWall) return null;
    return state.doorState.get(wall.frontSectorIndex) || state.doorState.get(wall.backSectorIndex) || null;
}

/**
 * Returns true if the given wall is a door that is currently closed.
 */
export function isDoorClosed(wall) {
    const doorEntry = getDoorEntry(wall);
    return doorEntry ? !doorEntry.open : false;
}

/**
 * Initialize all doors from map data — populates state.doorState and
 * annotates each door with its computed `trackWalls` so buildScene can
 * draw the door container with its static track side walls. No renderer
 * commands; buildScene reads mapData.doors directly.
 */
/**
 * State-side init for doors. Reads `mapData.doors` (with
 * `door.trackWalls` already annotated by
 * `src/shared/maps/doors.js::initDoors`) and populates
 * `state.doorState` with the per-door runtime entry the simulation
 * mutates during play.
 */
export function initDoorsState() {
    state.doorState = new Map();
    if (!mapData.doors) return;

    for (const door of mapData.doors) {
        state.doorState.set(door.sectorIndex, {
            open: false,
            sectorIndex: door.sectorIndex,
            passable: false,
            timer: null,
            passableTimer: null,
            keyRequired: door.keyRequired || null,
        });
    }
}

/**
 * Toggle a door open. If already open, reset the auto-close timer.
 * The renderer handles the open/close animation. The `player` parameter is
 * the player attempting to use the door — checked against their collected
 * keys for locked doors.
 */
export function toggleDoor(sectorIndex, player) {
    const doorEntry = state.doorState.get(sectorIndex);
    if (!doorEntry) return;

    // Check key requirement — block if player doesn't have the required key
    // Based on: linuxdoom-1.10/p_doors.c:EV_VerticalDoor()
    if (doorEntry.keyRequired && !doorEntry.open) {
        if (!player.collectedKeys.has(doorEntry.keyRequired)) {
            orchestrator.playSound('DSOOF', { x: player.x, y: player.y });
            return;
        }
    }

    if (doorEntry.open) {
        // Already open -- reset the auto-close timer so it stays open longer
        clearTimeout(doorEntry.timer);
        doorEntry.timer = setTimeout(() => closeDoor(sectorIndex), DOOR_CLOSE_DELAY);
        return;
    }

    doorEntry.open = true;
    doorEntry.passable = false;
    clearTimeout(doorEntry.passableTimer);
    doorEntry.passableTimer = setTimeout(() => { doorEntry.passable = true; }, DOOR_PASSABLE_DELAY * 1000);
    orchestrator.setDoorState(sectorIndex, 'open');
    const openCenter = sectorCenter(sectorIndex);
    if (openCenter) orchestrator.playSound('DSDOROPN', openCenter);
    doorEntry.timer = setTimeout(() => closeDoor(sectorIndex), DOOR_CLOSE_DELAY);
}

/**
 * Close a door by resetting its state and triggering the close animation.
 * If any player is inside the door sector, reverse the door (reopen) to avoid
 * crushing them — matching DOOM's T_VerticalDoor() blocked-check behavior.
 * Based on: linuxdoom-1.10/p_doors.c:T_VerticalDoor()
 */
function closeDoor(sectorIndex) {
    const doorEntry = state.doorState.get(sectorIndex);
    if (!doorEntry || !doorEntry.open) return;

    // Check if any player is inside the door sector — if so, reverse
    for (const player of state.players) {
        const playerSector = getSectorAt(player.x, player.y);
        if (playerSector && playerSector.sectorIndex === sectorIndex) {
            // A player is in the doorway — keep open and retry closing later
            doorEntry.timer = setTimeout(() => closeDoor(sectorIndex), DOOR_CLOSE_DELAY);
            return;
        }
    }

    doorEntry.open = false;
    doorEntry.passable = false;
    clearTimeout(doorEntry.passableTimer);
    doorEntry.timer = null;
    orchestrator.setDoorState(sectorIndex, 'closed');
    const closeCenter = sectorCenter(sectorIndex);
    if (closeCenter) orchestrator.playSound('DSDORCLS', closeCenter);
}

/**
 * Attempt to open a door in front of the player (triggered by the "use" key).
 * Casts a point forward from the player's position and checks if it is within
 * USE_RANGE of any wall that borders a door sector.
 * In DOOM, doors can be opened by pressing any wall adjacent to the door sector,
 * not just walls whose linedef has a door special type.
 * Based on: linuxdoom-1.10/p_map.c:PTR_UseTraverse()
 */
export function tryOpenDoor(player) {
    if (isMatchLobby()) return;
    if (!state.doorState.size) return;

    // Calculate a check point in front of the player (halfway to USE_RANGE)
    const forwardX = -Math.sin(player.angle);
    const forwardY = Math.cos(player.angle);
    const checkPointX = player.x + forwardX * USE_RANGE / 2;
    const checkPointY = player.y + forwardY * USE_RANGE / 2;

    for (const wall of mapData.walls) {
        if (!wall.isUpperWall) continue;
        // Skip walls whose linedef targets a remote sector by tag — those
        // trigger a specific action (switch, walk-over, etc.) and should not
        // also open the adjacent door generically.
        const linedef = mapData.linedefs[wall.linedefIndex];
        if (linedef?.sectorTag > 0) continue;
        // Check if this wall borders any door sector
        const doorSectorIndex = state.doorState.has(wall.frontSectorIndex) ? wall.frontSectorIndex
            : state.doorState.has(wall.backSectorIndex) ? wall.backSectorIndex
            : null;
        if (doorSectorIndex === null) continue;

        // Find the closest point on the wall segment to the check point
        const segmentDeltaX = wall.end.x - wall.start.x;
        const segmentDeltaY = wall.end.y - wall.start.y;
        const segmentLengthSquared = segmentDeltaX * segmentDeltaX + segmentDeltaY * segmentDeltaY;
        if (segmentLengthSquared === 0) continue;

        // Project checkPoint onto the wall segment, clamped to [0, 1]
        let projectionParameter = ((checkPointX - wall.start.x) * segmentDeltaX + (checkPointY - wall.start.y) * segmentDeltaY) / segmentLengthSquared;
        projectionParameter = Math.max(0, Math.min(1, projectionParameter));

        const closestPointX = wall.start.x + projectionParameter * segmentDeltaX;
        const closestPointY = wall.start.y + projectionParameter * segmentDeltaY;
        const distanceToWall = Math.sqrt((checkPointX - closestPointX) ** 2 + (checkPointY - closestPointY) ** 2);

        if (distanceToWall < USE_RANGE) {
            toggleDoor(doorSectorIndex, player);
            return;
        }
    }
}
