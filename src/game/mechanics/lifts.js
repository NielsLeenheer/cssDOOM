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

import { USE_RANGE, LIFT_RAISE_DELAY, LIFT_USE_SPECIAL } from '../constants.js';

import { state } from '../state.js';
import { mapData } from '../../shared/maps.js';
import { playSound } from '../../audio/audio.js';
import * as renderer from '../../renderer/index.js';

const LIFT_MOVE_DURATION = 1.0; // seconds — must match renderer animation duration

// Cached flat array of { sectorIndex, entry } for zero-alloc iteration in the hot path
let liftEntries = [];

export function initLifts() {
    state.liftState = new Map();
    if (!mapData.lifts) return;

    for (const lift of mapData.lifts) {
        const heightDelta = lift.upperHeight - lift.lowerHeight;
        if (heightDelta <= 0) continue;

        // Build the visual representation via the renderer
        renderer.buildLift(lift);

        state.liftState.set(lift.sectorIndex, {
            sectorIndex: lift.sectorIndex,
            tag: lift.tag,
            upperHeight: lift.upperHeight,
            lowerHeight: lift.lowerHeight,
            collisionEdges: lift.collisionEdges || [],
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

    // Debug console commands
    window.listTriggers = () => {
        const triggers = mapData.triggers || [];
        triggers.forEach((t, i) => {
            console.log(`[${i}] type=${t.specialType} tag=${t.sectorTag} (${t.start.x},${t.start.y})→(${t.end.x},${t.end.y})${t._triggered ? ' [FIRED]' : ''}`);
        });
        console.log(`${triggers.length} trigger(s). Use triggerLinedef(index) to fire one.`);
    };

    window.triggerLinedef = (index) => {
        const triggers = mapData.triggers || [];
        const trigger = triggers[index];
        if (!trigger) { console.error(`No trigger at index ${index}. Use listTriggers() to see available.`); return; }
        console.log(`Firing trigger [${index}] type=${trigger.specialType} tag=${trigger.sectorTag}`);
        for (let i = 0; i < liftEntries.length; i++) {
            if (liftEntries[i].entry.tag === trigger.sectorTag) {
                activateLift(liftEntries[i].sectorIndex);
            }
        }
    };

    window.activateLift = activateLift;

    window.listLifts = () => {
        liftEntries.forEach(({ sectorIndex, entry }) => {
            console.log(`sector=${sectorIndex} tag=${entry.tag} height=${entry.currentHeight} (${entry.lowerHeight}..${entry.upperHeight}) moving=${entry.moving} oneWay=${entry.oneWay}`);
        });
    };
}

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
    renderer.setLiftState(sectorIndex, 'lowered');
    playSound('DSPSTART');

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
    renderer.setLiftState(sectorIndex, 'raised');
    playSound('DSPSTOP');
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
    }
}

/**
 * Check all walk-over trigger lines each frame.
 * Uses crossing detection: fires when the player moves from one side of the
 * trigger linedef to the other, matching the original DOOM behaviour
 * (linuxdoom-1.10/p_spec.c:P_CrossSpecialLine).
 * W1 types (10, 53) fire once; WR types (88, 120) fire on every crossing.
 */
export function checkWalkOverTriggers() {
    const triggers = mapData.triggers;
    if (!triggers) return;

    for (let index = 0, count = triggers.length; index < count; index++) {
        const trigger = triggers[index];

        // W1 triggers only fire once
        if (trigger._triggered) continue;

        // Compute which side of the trigger linedef the player is on.
        // sign > 0 → front side, sign < 0 → back side.
        const dx = trigger.end.x - trigger.start.x;
        const dy = trigger.end.y - trigger.start.y;
        const side = (state.playerX - trigger.start.x) * dy - (state.playerY - trigger.start.y) * dx;
        const currentSide = side > 0;

        const previousSide = trigger._previousSide;
        trigger._previousSide = currentSide;

        // First frame: just record the side, don't fire
        if (previousSide === undefined) continue;

        // Fire when the player crosses from one side to the other
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
        }
    }
}

/**
 * Attempt to activate a lift in front of the player (triggered by the "use" key).
 * Checks nearby walls for linedefs with the lift-use special type (62: SR Lower
 * Lift Wait Raise) and activates any matching lifts.
 * Based on: linuxdoom-1.10/p_map.c:PTR_UseTraverse() → EV_DoPlat()
 */
export function tryUseLift() {
    if (!liftEntries.length) return;

    const forwardX = -Math.sin(state.playerAngle);
    const forwardY = Math.cos(state.playerAngle);
    const checkX = state.playerX + forwardX * USE_RANGE / 2;
    const checkY = state.playerY + forwardY * USE_RANGE / 2;

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
