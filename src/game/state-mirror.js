/**
 * State mirror — keeps the secondary window's local game state in sync
 * with the master's authoritative state, by translating incoming
 * renderer-command broadcasts into the equivalent state mutations.
 *
 * The secondary runs its own culling loop and game-side reads against
 * `state.players[i].x/y/angle` and `state.things[i].x/y/collected`. If
 * these stayed frozen at spawn-time values, dynamic things (the
 * opposing player's billboard, moving enemies, picked-up items) would
 * cull against stale positions and pop in/out as the master moves them.
 *
 * Pure game-state surgery — no DOM, no rendering. The corresponding
 * visual updates happen separately via the renderer commands the
 * BroadcastClient dispatches to the local DomRenderer / Orchestrator.
 */

import { state } from './state.js';

/**
 * Apply a per-pane command's state mutation. Called by BroadcastClient
 * when a `cmd-pane` envelope arrives addressed to one of our slots.
 */
export function applyPaneCommand(method, args, slotIndex) {
    if (method === 'updateCamera' && args[0] && state.players[slotIndex]) {
        const t = args[0];
        const player = state.players[slotIndex];
        player.x = t.x;
        player.y = t.y;
        player.z = t.z;
        player.angle = t.angle;
        player.floorHeight = t.floorHeight ?? player.floorHeight;
        player.isFiring = t.isFiring;
    }
}

/**
 * Apply a world command's state mutation. Called by BroadcastClient
 * when a `cmd-world` envelope arrives. Without these mirrors, the
 * secondary's culling loop checks against frozen spawn coordinates and
 * dynamic things flicker.
 */
export function applyWorldCommand(method, args) {
    switch (method) {
        case 'updateThingPosition': {
            const [thingIndex, x, y, floorHeight] = args;
            const thing = state.things[thingIndex];
            if (thing) {
                thing.x = x;
                thing.y = y;
                if (floorHeight !== undefined) thing.floorHeight = floorHeight;
            }
            break;
        }
        case 'collectItem':
        case 'killEnemy': {
            const [thingIndex] = args;
            const thing = state.things[thingIndex];
            if (thing) thing.collected = true;
            break;
        }
        case 'uncollectItem': {
            const [thingIndex] = args;
            const thing = state.things[thingIndex];
            if (thing) thing.collected = false;
            break;
        }
        default:
            break;
    }
}
