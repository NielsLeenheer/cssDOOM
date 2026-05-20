/**
 * Catch-up envelope for a freshly-attached peer (Local DM secondary
 * or Network DM remote). One envelope carries everything a joiner
 * needs to reach current master state: world (mechanics + things +
 * corpses + timer), overlay (lobby/results if visible), and per-pane
 * state for the joiner's own slot (HUD + camera + weapon + dead flag).
 *
 * Shape:
 *
 *   { cmds: [
 *       { name: 'createPlayerSprite',  args: [[ti,pi,x,y,fh,si], ...] },
 *       { name: 'updateThingPosition', args: [[gid,x,y,fh], ...] },
 *       ...
 *       { name: 'showLobby',           args: [[payload]] },
 *       { name: 'updateHud',           args: [[hudData]] },
 *       ...
 *   ]}
 *
 * Every entry is `{name, args}` where `args` is an array of arg
 * tuples. Single invocations are length-1; bulk applies (doors,
 * things) group under one `name`. Apply is one nested loop:
 *
 *   for (const {name, args} of cmds)
 *       for (const tuple of args) target[name](...tuple);
 *
 * One builder, two call sites:
 *
 *   - master onReady → buildCatchup(slot) → sendCatchup over the
 *     wire to a freshly-attached joiner. Receiver applies against
 *     its local DomRenderer.
 *   - master grace-rebuild (Local DM secondary detach) →
 *     buildCatchup(slot) → applyCatchupCmds directly to the rebuilt
 *     local DomRenderer. The rebuilt pane is a brand-new DomRenderer
 *     with no state; it needs the same HUD / camera / weapon / overlay
 *     catch-up as a wire joiner. Locally-applied catch-up is free
 *     (no wire), so there's no cost reason to skip any section.
 *
 * Wire envelope rides MSG.CATCHUP — see src/transport/protocol.js.
 */

import { state } from './state.js';
import { PICKUPS, ENEMIES, WEAPONS } from '../shared/constants.js';
import { getFloorHeightAt, getSectorAt } from './physics.js';
import { getCurrentTimerText } from './match.js';
import { getCurrentLevel } from './level.js';
import { GAME_STATE, getGameState } from './game-state.js';
import { COMMANDS } from '../renderer/commands.js';

// ── Public API ─────────────────────────────────────────────────────────

/** Full catchup envelope addressed to the given slot's pane. */
export function buildCatchup(slot) {
    const cmds = [];
    appendWorldCmds(cmds);
    appendOverlayCmds(cmds);
    appendPerPaneCmds(cmds, slot);
    return cmds;
}

/**
 * Apply a catchup cmd list to a DomRenderer. Both world and per-pane
 * impls are auto-bound onto DomRenderer.prototype by
 * renderer/commands.js, so the same target shape covers every
 * command in the envelope. Animations are CSS-suppressed during the
 * apply via the `snapshot-applying` class on the pane element.
 * Per-tuple try/catch isolates failure so one bad entry doesn't
 * abort the rest.
 */
export function applyCatchupCmds(target, cmds) {
    if (!target || !cmds?.length) return;

    const paneEl = target.paneEl ?? null;
    paneEl?.classList.add('snapshot-applying');
    try {
        for (const { name, args } of cmds) {
            const fn = target[name];
            if (typeof fn !== 'function') {
                console.warn('[catchup] unknown command', name);
                continue;
            }
            for (const tuple of args) {
                try {
                    fn.apply(target, tuple);
                } catch (err) {
                    console.warn('[catchup] command failed', name, tuple, err);
                }
            }
        }
    } finally {
        // Two frames: one for style flushes (data-state flips, class
        // adds), one safety frame so the no-animation rule covers any
        // transition started by those changes.
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                paneEl?.classList.remove('snapshot-applying');
            });
        });
    }
}

// ── World section ──────────────────────────────────────────────────────

function appendWorldCmds(out) {
    // No level loaded yet (lobby with no map / pre-bootstrap) →
    // there's no world to catch up. Joiner will receive subsequent
    // loadMap + per-frame deltas through the live command pipeline.
    if (!getCurrentLevel()) return;

    appendPlayerSpriteCmds(out);
    appendThingCmds(out);
    appendDoorCmds(out);
    appendLiftCmds(out);
    appendCrusherCmds(out);
    appendCorpseCmds(out);
    appendTimerCmd(out);
}

/**
 * Each live player's billboard, addressed by the thingIndex assigned
 * in addPlayerThings. createPlayerSprite is idempotent — no-op when
 * the sprite already exists in the receiver's sceneState, so panes
 * that already have the billboard are not disturbed.
 */
function appendPlayerSpriteCmds(out) {
    const tuples = [];
    for (const player of state.players) {
        if (!player?.thingRef || player.thingIndex == null) continue;
        tuples.push([
            player.thingIndex,
            player.index,
            player.x,
            player.y,
            player.floorHeight,
            getSectorAt(player.x, player.y)?.sectorIndex,
        ]);
    }
    if (tuples.length) out.push({ name: 'createPlayerSprite', args: tuples });
}

function appendThingCmds(out) {
    const positionTuples = [];
    const reparentTuples = [];
    const killTuples = [];
    const collectTuples = [];

    for (let gameId = 0; gameId < state.things.length; gameId++) {
        const t = state.things[gameId];
        if (!t) continue;
        // Player billboards go through createPlayerSprite above.
        if (t.kind === 'player') continue;

        // t.floorHeight is only updated at init / by lifts. Resolve
        // live from coords so a wandered-then-killed enemy lands on
        // the floor it's actually standing on. Mirrors ai.js's
        // updateThingPosition tick.
        const floorHeight = getFloorHeightAt(t.x, t.y);

        if (t.collected) {
            positionTuples.push([gameId, t.x, t.y, floorHeight]);
            if (t.sectorIndex != null) reparentTuples.push([gameId, t.sectorIndex]);
            // Discriminate "dead enemy" (killEnemy path) from
            // "collected pickup" (collectItem path). Barrels go down
            // the killEnemy path so their explosion-corpse renders.
            if (ENEMIES.has(t.type) || t.type === 2035) {
                killTuples.push([gameId, t.type, true]);
            } else if (PICKUPS.has(t.type)) {
                collectTuples.push([gameId]);
            }
        } else if (t.x != null && t.y != null) {
            positionTuples.push([gameId, t.x, t.y, floorHeight]);
            if (t.sectorIndex != null) reparentTuples.push([gameId, t.sectorIndex]);
        }
    }

    // Order matters across groups: position before reparent before
    // kill/collect, so the dying sprite lands on the right floor /
    // in the right sector container before its state flips.
    if (positionTuples.length) out.push({ name: 'updateThingPosition', args: positionTuples });
    if (reparentTuples.length) out.push({ name: 'reparentThingToSector', args: reparentTuples });
    if (killTuples.length)     out.push({ name: 'killEnemy',           args: killTuples });
    if (collectTuples.length)  out.push({ name: 'collectItem',         args: collectTuples });
}

function appendDoorCmds(out) {
    const tuples = [];
    for (const [sectorIndex, entry] of state.doorState) {
        tuples.push([sectorIndex, entry.open ? 'open' : 'closed']);
    }
    if (tuples.length) out.push({ name: 'setDoorState', args: tuples });
}

function appendLiftCmds(out) {
    const tuples = [];
    for (const [sectorIndex, entry] of state.liftState) {
        // Derive a stable resting state from the target so a lift
        // mid-animation snaps to its endpoint when the joiner applies.
        const liftState = entry.targetHeight === entry.upperHeight ? 'raised' : 'lowered';
        tuples.push([sectorIndex, liftState]);
    }
    if (tuples.length) out.push({ name: 'setLiftState', args: tuples });
}

function appendCrusherCmds(out) {
    const tuples = [];
    for (const [sectorIndex, entry] of state.crusherState) {
        tuples.push([sectorIndex, entry.currentOffset ?? 0]);
    }
    if (tuples.length) out.push({ name: 'setCrusherOffset', args: tuples });
}

function appendCorpseCmds(out) {
    if (!state.deathCorpses.length) return;
    const tuples = state.deathCorpses.map(c => [
        c.x, c.y, c.floorHeight, c.sectorIndex, c.playerIndex,
    ]);
    out.push({ name: 'createCorpse', args: tuples });
}

function appendTimerCmd(out) {
    // The per-pane match timer envelope only fires when the displayed
    // second changes — a joiner arriving mid-countdown would wait up
    // to a second otherwise. Always push so the readout lands
    // immediately.
    out.push({ name: 'showTimer', args: [[getCurrentTimerText() ?? null]] });
}

// ── Overlay section ────────────────────────────────────────────────────

function appendOverlayCmds(out) {
    const game = window.app?.game;
    if (!game) return;
    const gs = getGameState();
    if (gs === GAME_STATE.LOBBY) {
        out.push({ name: 'showLobby', args: [[game.getLobbyPayload()]] });
    } else if (gs === GAME_STATE.ENDED) {
        out.push({ name: 'showResults', args: [[game.getResultsPayload()]] });
    }
    // INTERMISSION is SP-only so it never reaches a joiner; ATTRACT
    // is kiosk-only and kiosks don't accept joiners.
}

// ── Per-pane section ───────────────────────────────────────────────────

function appendPerPaneCmds(out, slot) {
    const player = state.players[slot];
    if (!player) return;

    // HUD digits. Goes through the registry's serializer to strip
    // the player object to the wire-safe subset (ammo, health,
    // weapons, …) — same shape the runtime updateHud receives.
    const hudArgs = COMMANDS.updateHud.serialize(player);
    out.push({ name: 'updateHud', args: [hudArgs] });

    // Camera transform so the pane's first paint is at the player's
    // actual position, not at-origin.
    const camArgs = COMMANDS.updateCamera.serialize(player);
    out.push({ name: 'updateCamera', args: [camArgs] });

    // Current weapon sprite + fire-rate timing.
    const weapon = WEAPONS[player.currentWeapon];
    if (weapon) {
        out.push({ name: 'switchWeapon', args: [[weapon.name, weapon.fireRate]] });
    }

    // Death-cam state — only when actually dead so a freshly spawned
    // pane doesn't see a death-cam frame.
    if (player.isDead) {
        out.push({ name: 'setPlayerDead', args: [[true]] });
    }

    // TODO: showPaused catch-up — Game has no public isPaused()
    // getter today. See ARCHITECTURE_DEBT.md issue 12.
}

