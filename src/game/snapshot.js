/**
 * World-state snapshot for late-joining / reconnecting Network DM
 * clients.
 *
 * The joiner's own loadMap rebuilds the scene from scratch — every
 * pickup looks uncollected, every enemy alive, every door at its
 * map-default state. This snapshot lets master tell the joiner "here's
 * what actually happened since match start": dead enemies stay dead,
 * collected pickups stay collected, doors / lifts / crushers at their
 * current state, and player corpses appear at their original death
 * points.
 *
 * The joiner applies the snapshot via existing renderer commands
 * (killEnemy / collectItem / setDoorState / setLiftState /
 * setCrusherOffset / createCorpse / updateThingPosition /
 * reparentThingToSector). Animations are CSS-suppressed during the
 * apply so the catch-up doesn't visibly re-play every death and
 * door-open since match start.
 */

import { state } from './state.js';
import { PICKUPS, ENEMIES } from './constants.js';
import { currentMap } from '../shared/maps/index.js';
import { getFloorHeightAt, getSectorAt } from './physics.js';
import { getCurrentTimerText } from './match.js';

/**
 * Build a snapshot of master's current world state. Returns a
 * JSON-cloneable plain object — primitives only, no Map/Set/refs.
 */
export function getWorldSnapshot() {
    return {
        map: currentMap,
        playerSprites: snapshotPlayerSprites(),
        things: snapshotThings(),
        doors: snapshotDoors(),
        lifts: snapshotLifts(),
        crushers: snapshotCrushers(),
        corpses: snapshotCorpses(),
        timerText: getCurrentTimerText(),
    };
}

/**
 * Each player's billboard, addressed by the thingIndex assigned in
 * addPlayerThings. The applying side fires createPlayerSprite for
 * every entry — createPlayerSprite is idempotent (no-op when the
 * sprite already exists in this renderer's sceneState.thingDom), so
 * panes that already have the billboard are not disturbed.
 *
 * Skips players without a thingRef (no live billboard yet —
 * pre-match peer attach has nothing to catch up).
 */
function snapshotPlayerSprites() {
    const out = [];
    for (const player of state.players) {
        if (!player?.thingRef || player.thingIndex == null) continue;
        out.push({
            thingIndex: player.thingIndex,
            playerIndex: player.index,
            x: player.x,
            y: player.y,
            floorHeight: player.floorHeight,
            sectorIndex: getSectorAt(player.x, player.y)?.sectorIndex,
        });
    }
    return out;
}

function snapshotThings() {
    const out = [];
    for (let gameId = 0; gameId < state.things.length; gameId++) {
        const t = state.things[gameId];
        if (!t) continue;
        // Player thing entries are handled by `playerSprites` above —
        // createPlayerSprite (not the killEnemy/collectItem flow that
        // the rest of this list goes through) — so skip them here.
        if (t.kind === 'player') continue;

        // `t.floorHeight` is only updated at init / by lifts, NOT by the
        // AI as enemies chase across sectors. Resolve live from coords so
        // a wandered-then-killed enemy lands on the floor it's actually
        // standing on, not the one it spawned over. Matches what ai.js
        // ticks into the renderer via updateThingPosition.
        out.push({
            gameId,
            type: t.type,
            x: t.x,
            y: t.y,
            floorHeight: getFloorHeightAt(t.x, t.y),
            sectorIndex: t.sectorIndex,
            collected: !!t.collected,
            // Differentiates "dead enemy" (killEnemy path) from
            // "collected pickup" (collectItem path) on the joiner.
            category: ENEMIES.has(t.type) ? 'enemy'
                    : t.type === 2035    ? 'barrel'
                    : PICKUPS.has(t.type) ? 'pickup'
                    : 'decoration',
            // Enemy-only — null for everything else.
            facing: t.facing,
        });
    }
    return out;
}

function snapshotDoors() {
    const out = [];
    for (const [sectorIndex, entry] of state.doorState) {
        out.push({ sectorIndex, state: entry.open ? 'open' : 'closed' });
    }
    return out;
}

function snapshotLifts() {
    const out = [];
    for (const [sectorIndex, entry] of state.liftState) {
        // Derive a stable resting state from the target so a lift mid-
        // animation snaps to its endpoint when the joiner applies.
        const liftState = entry.targetHeight === entry.upperHeight ? 'raised' : 'lowered';
        out.push({ sectorIndex, state: liftState });
    }
    return out;
}

function snapshotCrushers() {
    const out = [];
    for (const [sectorIndex, entry] of state.crusherState) {
        out.push({ sectorIndex, offset: entry.currentOffset ?? 0 });
    }
    return out;
}

function snapshotCorpses() {
    // state.deathCorpses is populated by damage.js when a player dies.
    // Each entry is already a plain object suitable for sending over
    // the wire, but copy to insulate against future shape changes.
    return state.deathCorpses.map(c => ({
        x: c.x,
        y: c.y,
        floorHeight: c.floorHeight,
        sectorIndex: c.sectorIndex,
        playerIndex: c.playerIndex,
    }));
}

/**
 * Apply a world snapshot to a render `target` — either a specific
 * DomRenderer (direct dispatch: fires only on that renderer, no
 * orchestrator fan-out) or an Orchestrator (fans to every local
 * target on that window, runs mirrors so rendererState gets
 * populated).
 *
 * Two callers:
 *
 *   - Master post-grace pane rebuild (onGraceRebuilt → applies to
 *     the freshly-rebuilt DomRenderer directly; other local
 *     renderers and remote sinks are not touched because they're
 *     already in sync, and re-firing non-idempotent commands like
 *     createCorpse on them would create duplicates).
 *
 *   - Joiner side (RemoteGame's onSnapshot → applies via the
 *     joiner's Orchestrator; mirrors fire to populate
 *     rendererState; fan-out reaches the joiner's single local
 *     DomRenderer).
 *
 * Animations are CSS-suppressed during the apply (via
 * `body.snapshot-applying` — see touch-controls.css / viewport.css)
 * so the catch-up doesn't visibly re-play every death and door open
 * since match start.
 *
 * Both DomRenderer.prototype and Orchestrator.prototype carry the
 * same auto-bound world-command method names from
 * `renderer/commands.js`, so the same call sites work for either
 * target shape.
 */
export function applyWorldSnapshot(target, snapshot) {
    if (!target || !snapshot) return;

    document.body.classList.add('snapshot-applying');
    try {
        for (const sprite of snapshot.playerSprites ?? []) {
            target.createPlayerSprite(
                sprite.thingIndex,
                sprite.playerIndex,
                sprite.x,
                sprite.y,
                sprite.floorHeight,
                sprite.sectorIndex,
            );
        }
        for (const t of snapshot.things ?? []) {
            if (t.collected) {
                // Apply visual position first so dead things land at
                // wherever they actually fell (lifts can carry corpses).
                target.updateThingPosition(t.gameId, t.x, t.y, t.floorHeight);
                if (t.sectorIndex != null) {
                    target.reparentThingToSector(t.gameId, t.sectorIndex);
                }
                if (t.category === 'enemy' || t.category === 'barrel') {
                    target.killEnemy(t.gameId, t.type, true);
                } else {
                    target.collectItem(t.gameId);
                }
            } else if (t.x != null && t.y != null) {
                // Alive but possibly off-spawn (wandered enemy).
                target.updateThingPosition(t.gameId, t.x, t.y, t.floorHeight);
                if (t.sectorIndex != null) {
                    target.reparentThingToSector(t.gameId, t.sectorIndex);
                }
            }
        }
        for (const d of snapshot.doors ?? []) {
            target.setDoorState(d.sectorIndex, d.state);
        }
        for (const l of snapshot.lifts ?? []) {
            target.setLiftState(l.sectorIndex, l.state);
        }
        for (const c of snapshot.crushers ?? []) {
            target.setCrusherOffset(c.sectorIndex, c.offset);
        }
        for (const corpse of snapshot.corpses ?? []) {
            target.createCorpse(
                corpse.x, corpse.y, corpse.floorHeight,
                corpse.sectorIndex, corpse.playerIndex,
            );
        }
        // If a joiner reconnects mid-countdown, the per-pane match
        // timer envelope only fires when the displayed second changes —
        // they'd wait up to a second to see the readout otherwise.
        // Apply the value carried in the snapshot so it lands immediately.
        target.showTimer(snapshot.timerText ?? null);
    } finally {
        // Wait two animation frames before removing the suppressor: one
        // for the style changes (data-state flips, class adds) to flush,
        // one safety frame so the no-animation rule has covered any
        // transition that would otherwise have started on those changes.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                document.body.classList.remove('snapshot-applying');
            });
        });
    }
}
