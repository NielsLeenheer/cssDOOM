/**
 * Lifts
 *
 * Lifts (elevators) work via a dual-system approach:
 *   - Visual movement: The renderer smoothly animates the platform and its contents
 *     between upper and lower positions.
 *   - Physics sync: An ease-in-out interpolation runs each frame to keep
 *     `currentHeight` in sync with the visual animation, so collision detection
 *     and floor-height queries reflect the lift's position at all times.
 *
 * Shaft walls are static geometry spanning the gap between lowerHeight and upperHeight,
 * positioned at upperHeight so they are always visible behind the moving platform.
 *
 * Walk-over triggers use crossing detection: the trigger fires when the player
 * moves from one side of the trigger linedef to the other, matching the original
 * DOOM behaviour (linuxdoom-1.10/p_spec.c:P_CrossSpecialLine).
 *
 * Collision edges block the player from walking into the lift shaft from below when
 * the platform is raised, handled externally by the collision system.
 */

import { USE_RANGE, LIFT_RAISE_DELAY, LIFT_USE_SPECIAL } from '../../shared/constants.js';

import { state } from '../state.js';
import { mapData, sectorCenter } from '../../shared/maps/index.js';
import { pointInPolygon } from '../geometry.js';
import { orchestrator } from '../../orchestrator.js';
import { isMatchLobby } from '../match.js';

const LIFT_MOVE_DURATION = 1.0; // seconds — must match renderer animation duration

// Cached flat array of { sectorIndex, entry } for zero-alloc iteration in the hot path
let liftEntries = [];

export function initLiftsState() {
    state.liftState = new Map();
    if (!mapData.lifts) return;

    for (const lift of mapData.lifts) {
        const heightDelta = lift.upperHeight - lift.lowerHeight;
        if (heightDelta <= 0) continue;

        // Annotate each collision edge with the "inside sign" — which side
        // of the edge is inside the lift's footprint. Used by canMoveTo
        // so the edge only blocks moves that would enter the footprint,
        // not moves that just brush the edge from the outside. Without
        // this, a player stepping off a raised lift would be trapped
        // within PLAYER_RADIUS of the edge: blocked forward by the
        // circle/edge overlap, blocked backward by the step-up height.
        //
        // The interior side is found PER EDGE by probing just off the
        // edge midpoint and testing point-in-polygon against the lift
        // sector's own polygon(s). A single sector centroid (the previous
        // approach) cannot sit on the interior side of every edge of a
        // concave / multi-edge lift — for those, some edges got an
        // inverted sign and blocked the static foot area instead of the
        // shaft, trapping the player. Each collision edge is a boundary of
        // the lift sector, so one side is inside the polygon and the other
        // is the neighbour; point-in-polygon resolves it correctly for any
        // shape. (sectorPolygons is a list keyed by `.sectorIndex`, not
        // positionally indexed — a sector can span several entries.)
        const liftPolys = (mapData.sectorPolygons || [])
            .filter(p => p.sectorIndex === lift.sectorIndex)
            .map(p => p.boundaries?.[0])
            .filter(Boolean);
        const annotatedEdges = (lift.collisionEdges || []).map(e => {
            const dx = e.end.x - e.start.x;
            const dy = e.end.y - e.start.y;
            const len = Math.hypot(dx, dy) || 1;
            const nx = -dy / len, ny = dx / len; // unit normal to the edge
            const mx = (e.start.x + e.end.x) / 2, my = (e.start.y + e.end.y) / 2;
            let insideSign = 0;
            // Escalate the probe distance so a midpoint that sits in a
            // concave notch still resolves to one side in, one side out.
            for (const eps of [1, 4, 8]) {
                const aIn = liftPolys.some(poly => pointInPolygon(mx + nx * eps, my + ny * eps, poly));
                const bIn = liftPolys.some(poly => pointInPolygon(mx - nx * eps, my - ny * eps, poly));
                if (aIn === bIn) continue;
                const ix = aIn ? mx + nx * eps : mx - nx * eps;
                const iy = aIn ? my + ny * eps : my - ny * eps;
                const s = (ix - e.start.x) * dy - (iy - e.start.y) * dx;
                insideSign = s > 0 ? 1 : (s < 0 ? -1 : 0);
                break;
            }
            return { ...e, insideSign };
        });

        state.liftState.set(lift.sectorIndex, {
            sectorIndex: lift.sectorIndex,
            tag: lift.tag,
            upperHeight: lift.upperHeight,
            lowerHeight: lift.lowerHeight,
            collisionEdges: annotatedEdges,
            currentHeight: lift.upperHeight,
            targetHeight: lift.upperHeight,
            moving: false,
            timer: null,
            oneWay: lift.oneWay || false
        });
    }

    // Cache flat array for zero-alloc iteration in the per-frame hot path
    liftEntries = [];
    state.liftState.forEach((entry, sectorIndex) => {
        liftEntries.push({ sectorIndex, entry });
    });
}

/** Live accessor for the cached lift entries — used by the debug console. */
export function getLiftEntries() { return liftEntries; }

export function activateLift(sectorIndex) {
    const liftState = state.liftState.get(sectorIndex);
    if (!liftState) return;

    // Ignore if already lowered or moving down
    if (liftState.targetHeight === liftState.lowerHeight) return;

    // Begin lowering: set up interpolation state and trigger animation
    liftState.targetHeight = liftState.lowerHeight;
    liftState.moving = true;
    liftState.moveStart = performance.now() / 1000;
    liftState.moveFrom = liftState.currentHeight;
    orchestrator.dispatch({ type: 'world', cmd: 'setMoverState', args: ['lift', sectorIndex, 'lowered'] });
    const lowerCenter = sectorCenter(sectorIndex);
    if (lowerCenter) orchestrator.dispatch({ type: 'world', cmd: 'playSound', args: ['DSPSTART', lowerCenter] });

    // One-way lifts (e.g. type 36) stay lowered permanently
    if (!liftState.oneWay) {
        clearTimeout(liftState.timer);
        liftState.timer = setTimeout(() => raiseLift(sectorIndex), LIFT_RAISE_DELAY);
    }
}

function raiseLift(sectorIndex) {
    const liftState = state.liftState.get(sectorIndex);
    if (!liftState) return;

    // Begin raising: set up interpolation state and trigger animation
    liftState.targetHeight = liftState.upperHeight;
    liftState.moving = true;
    liftState.moveStart = performance.now() / 1000;
    liftState.moveFrom = liftState.currentHeight;
    orchestrator.dispatch({ type: 'world', cmd: 'setMoverState', args: ['lift', sectorIndex, 'raised'] });
    const raiseCenter = sectorCenter(sectorIndex);
    if (raiseCenter) orchestrator.dispatch({ type: 'world', cmd: 'playSound', args: ['DSPSTOP', raiseCenter] });
    liftState.timer = null;
}

/**
 * Called each frame to interpolate lift heights in sync with the renderer animation.
 * Uses an ease-in-out curve that matches the renderer's easing so that the
 * currentHeight closely tracks the visual position of the animated platform.
 */
export function updatePlayerFromLift(timestamp) {
    const currentTimeSeconds = timestamp / 1000;
    for (let index = 0, count = liftEntries.length; index < count; index++) {
        const liftState = liftEntries[index].entry;
        if (!liftState.moving) continue;

        const elapsedSeconds = currentTimeSeconds - liftState.moveStart;
        const interpolation = Math.min(1, elapsedSeconds / LIFT_MOVE_DURATION);

        // Renderer uses ease-in-out (cubic-bezier 0.42, 0, 0.58, 1).
        // Approximate with a cubic that closely matches for physics sync.
        const t = interpolation;
        const easedInterpolation = t * t * (3 - 2 * t);

        liftState.currentHeight = liftState.moveFrom + (liftState.targetHeight - liftState.moveFrom) * easedInterpolation;

        if (interpolation >= 1) {
            liftState.currentHeight = liftState.targetHeight;
            liftState.moving = false;
        }

        // Sync things standing on the lift sector to the new height. Live
        // enemies get this for free via their AI tick (which calls
        // getFloorHeightAt → currentHeight), but corpses stop ticking
        // after death and would otherwise hang in mid-air as the
        // platform descends or rises. Players are handled separately
        // by movement.updateHeight().
        // Keep the game-state floor of riders current (read by e.g. projectile
        // targeting). The renderer no longer needs a per-frame floor dispatch:
        // a rider lives in the lift sector and the renderer derives its height
        // from that sector (CSS inherits the sector's --floor-z + rides the
        // `.mover`; canvas/webgl read floorOf()).
        const sectorIndex = liftEntries[index].sectorIndex;
        const things = state.things;
        for (let i = 0, n = things.length; i < n; i++) {
            const thing = things[i];
            if (thing.sectorIndex !== sectorIndex) continue;
            thing.floorHeight = liftState.currentHeight;
        }
    }
}

/**
 * Check all walk-over trigger lines each frame.
 * Uses crossing detection: fires when any player moves from one side of the
 * trigger linedef to the other, matching the original DOOM behaviour
 * (linuxdoom-1.10/p_spec.c:P_CrossSpecialLine).
 * W1 types (10, 53) fire once across all players; WR types (88, 120) fire
 * on every crossing by any player.
 *
 * Each trigger maintains a per-player previousSide map so two players
 * can independently cross the same line without missing fires.
 */
export function checkWalkOverTriggers() {
    const triggers = mapData.triggers;
    if (!triggers) return;

    for (let index = 0, count = triggers.length; index < count; index++) {
        const trigger = triggers[index];

        // W1 triggers only fire once (across all players)
        if (trigger._triggered) continue;

        const dx = trigger.end.x - trigger.start.x;
        const dy = trigger.end.y - trigger.start.y;

        if (!trigger._previousSidePerPlayer) trigger._previousSidePerPlayer = new Map();

        for (const player of state.players) {
            // Compute which side of the trigger linedef the player is on.
            // sign > 0 → front side, sign < 0 → back side.
            const side = (player.x - trigger.start.x) * dy - (player.y - trigger.start.y) * dx;
            const currentSide = side > 0;

            const previousSide = trigger._previousSidePerPlayer.get(player.index);
            trigger._previousSidePerPlayer.set(player.index, currentSide);

            // First frame for this player: just record the side, don't fire
            if (previousSide === undefined) continue;

            // Fire when this player crosses from one side to the other
            if (previousSide !== currentSide) {
                // Mark W1 (one-shot) types so they don't fire again
                if (trigger.specialType === 10 || trigger.specialType === 53 || trigger.specialType === 36) {
                    trigger._triggered = true;
                }

                // Activate all lifts whose tag matches this trigger's sector tag
                for (let liftIndex = 0, liftCount = liftEntries.length; liftIndex < liftCount; liftIndex++) {
                    if (liftEntries[liftIndex].entry.tag === trigger.sectorTag) {
                        activateLift(liftEntries[liftIndex].sectorIndex);
                    }
                }

                // If this trigger is now exhausted, stop processing more players
                if (trigger._triggered) break;
            }
        }
    }
}

/**
 * Attempt to activate a lift in front of the player (triggered by the "use" key).
 * Checks nearby walls for linedefs with the lift-use special type (62: SR Lower
 * Lift Wait Raise) and activates any matching lifts.
 * Based on: linuxdoom-1.10/p_map.c:PTR_UseTraverse() → EV_DoPlat()
 */
export function tryUseLift(player) {
    if (isMatchLobby()) return;
    if (!liftEntries.length) return;

    const forwardX = -Math.sin(player.angle);
    const forwardY = Math.cos(player.angle);
    const checkX = player.x + forwardX * USE_RANGE / 2;
    const checkY = player.y + forwardY * USE_RANGE / 2;

    for (const wall of mapData.walls) {
        const linedef = mapData.linedefs[wall.linedefIndex];
        if (!linedef || linedef.specialType !== LIFT_USE_SPECIAL) continue;

        const dx = wall.end.x - wall.start.x;
        const dy = wall.end.y - wall.start.y;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) continue;

        let t = ((checkX - wall.start.x) * dx + (checkY - wall.start.y) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        const closestX = wall.start.x + t * dx;
        const closestY = wall.start.y + t * dy;
        const dist = Math.sqrt((checkX - closestX) ** 2 + (checkY - closestY) ** 2);

        if (dist < USE_RANGE) {
            for (let i = 0; i < liftEntries.length; i++) {
                if (liftEntries[i].entry.tag === linedef.sectorTag) {
                    activateLift(liftEntries[i].sectorIndex);
                }
            }
            return;
        }
    }
}
