/**
 * The single console surface. `window.debug` is a callable object: calling it
 * opens the debug panel; every console command hangs off it in grouped
 * sub-objects (debug.position.*, debug.world.*, debug.game.*). This module is
 * the sole owner — it imports implementations from the domain modules so
 * nothing else has to reach back into the debug layer (which would risk a
 * circular import). Loaded for its side effects at boot from master.js.
 */

import { state } from '../game/state.js';
import { EYE_HEIGHT } from '../shared/constants.js';
import { THING_NAMES } from '../renderer/dom/scene/constants.js';
import { getFloorHeightAt, getSectorAt } from '../game/physics.js';
import { orchestrator } from '../orchestrator.js';
import { mapData, currentMap } from '../shared/maps/index.js';
import { swapLevel } from '../game/level.js';
import { forEachWallInAABB } from '../game/spatial-grid.js';
import { activateLift, getLiftEntries } from '../game/mechanics/lifts.js';
import * as recorder from './recorder.js';
import * as pathModule from './path.js';
import { initDebugMenu } from './panel.js';

// ── Panel open state ──────────────────────────────────────────────────────
let menuOpen = false;
export function openDebugMenu() {
    if (menuOpen) return;
    menuOpen = true;
    initDebugMenu();
    console.log('Debug menu enabled');
}
export const isDebugMenuOpen = () => menuOpen;

// ── Callable namespace ────────────────────────────────────────────────────
function debug() { openDebugMenu(); }
window.debug = debug;
/** Get (or lazily create) a command group on the debug namespace. */
function group(name) { return (debug[name] ??= {}); }

// ── debug.position — player placement & position save/load ────────────────
const position = group('position');

/** Teleport to exact coords (+ optional angle in degrees). */
position.teleport = (x, y, angleDegrees) => {
    const player = state.players[0];
    player.x = x;
    player.y = y;
    if (angleDegrees !== undefined) player.angle = angleDegrees * Math.PI / 180;
    player.floorHeight = getFloorHeightAt(player.x, player.y);
    player.z = player.floorHeight + EYE_HEIGHT;
    orchestrator.updateCamera(player.viewportIndex, {
        x: player.x, y: player.y, z: player.z, angle: player.angle,
        floorHeight: player.floorHeight ?? 0, isFiring: player.isFiring,
    });
};

/** Teleport to a thing by type name (e.g. debug.position.teleportTo('spectre')). */
position.teleportTo = (name) => {
    const thing = state.things.find(t => (THING_NAMES[t.type] || '') === name);
    if (!thing) { console.log(`No "${name}" found on this map`); return; }
    const player = state.players[0];
    player.x = thing.x;
    player.y = thing.y;
    console.log(`Teleported to ${name} at (${thing.x}, ${thing.y})`);
};

position.save = (slot = 0) => {
    const player = state.players[0];
    const data = { map: currentMap, x: player.x, y: player.y, angle: player.angle };
    localStorage.setItem(`cssdoom-save-${slot}`, JSON.stringify(data));
    console.log(`Saved slot ${slot}: ${currentMap} (${Math.round(data.x)}, ${Math.round(data.y)})`);
};

position.load = async (slot = 0) => {
    const json = localStorage.getItem(`cssdoom-save-${slot}`);
    if (!json) { console.log(`Slot ${slot} is empty`); return; }
    const data = JSON.parse(json);
    if (data.map !== currentMap) {
        console.log(`Switching to ${data.map}...`);
        await swapLevel(data.map);
    }
    const player = state.players[0];
    player.x = data.x;
    player.y = data.y;
    player.angle = data.angle;
    player.floorHeight = getFloorHeightAt(player.x, player.y);
    player.z = player.floorHeight + EYE_HEIGHT;
    orchestrator.updateCamera(player.viewportIndex, {
        x: player.x, y: player.y, z: player.z, angle: player.angle,
        floorHeight: player.floorHeight ?? 0, isFiring: player.isFiring,
    });
    console.log(`Loaded slot ${slot}: ${data.map} (${Math.round(data.x)}, ${Math.round(data.y)})`);
};

// ── debug.world — inspect the current level ───────────────────────────────
const world = group('world');

/** Dump player position, angle, sector, and current map. */
world.dump = () => {
    const player = state.players[0];
    const sector = getSectorAt(player.x, player.y);
    const angleDeg = ((player.angle * 180 / Math.PI) % 360 + 360) % 360;
    const info = {
        map: currentMap,
        position: { x: Math.round(player.x), y: Math.round(player.y), z: Math.round(player.z) },
        floorHeight: player.floorHeight,
        angle: Math.round(angleDeg) + '°',
        lookDir: { x: +(-Math.sin(player.angle)).toFixed(3), y: +Math.cos(player.angle).toFixed(3) },
        sector: sector ? {
            index: sector.sectorIndex, floor: sector.floorHeight,
            ceiling: sector.ceilingHeight, light: sector.lightLevel,
        } : null,
        health: player.health, armor: player.armor,
        weapon: player.currentWeapon, isDead: player.isDead,
    };
    console.table ? console.table(info.position) : null;
    console.log(info);
    return info;
};

/** Dump all walls, doors, lifts, things, and projectiles near the player. */
world.nearby = (radius = 512) => {
    const player = state.players[0];
    const px = player.x, py = player.y;
    const eyeZ = player.floorHeight + EYE_HEIGHT;
    const r = radius;

    const walls = [];
    forEachWallInAABB(px - r, py - r, px + r, py + r, wall => {
        const cx = (wall.start.x + wall.end.x) / 2;
        const cy = (wall.start.y + wall.end.y) / 2;
        const dist = Math.sqrt((cx - px) ** 2 + (cy - py) ** 2);
        if (dist > r) return;
        walls.push({
            wallId: wall.wallId, texture: wall.texture,
            bottom: wall.bottomHeight, top: wall.topHeight,
            isSolid: !!wall.isSolid, isUpper: !!wall.isUpperWall,
            isLower: !!wall.isLowerWall, isMiddle: !!wall.isMiddleWall,
            isDoor: !!wall.isDoor, sector: wall.sectorIndex, dist: Math.round(dist),
            from: `${wall.start.x},${wall.start.y}`, to: `${wall.end.x},${wall.end.y}`,
        });
    });
    walls.sort((a, b) => a.dist - b.dist);

    const doors = [];
    for (const [sectorIndex, door] of state.doorState) {
        const sector = mapData.sectors[sectorIndex];
        if (!sector) continue;
        doors.push({
            sectorIndex, tag: sector.tag, open: door.open, passable: door.passable,
            height: door.currentHeight, openHeight: door.openHeight,
        });
    }

    const lifts = [];
    for (const [sectorIndex, lift] of state.liftState) {
        lifts.push({ sectorIndex, tag: lift.tag, currentHeight: lift.currentHeight, active: lift.active });
    }

    const things = [];
    for (let i = 0; i < state.things.length; i++) {
        const t = state.things[i];
        const dist = Math.sqrt((t.x - px) ** 2 + (t.y - py) ** 2);
        if (dist > r) continue;
        things.push({
            index: i, type: t.type, name: THING_NAMES[t.type] || '?',
            x: Math.round(t.x), y: Math.round(t.y), collected: !!t.collected,
            hp: t.hp, aiState: t.ai?.state, dist: Math.round(dist),
        });
    }
    things.sort((a, b) => a.dist - b.dist);

    const projectiles = state.projectiles.map(p => ({
        id: p.id, x: Math.round(p.x), y: Math.round(p.y), z: Math.round(p.z), source: p.source,
    }));

    console.log(`--- nearby(${radius}) at (${Math.round(px)}, ${Math.round(py)}) eyeZ=${Math.round(eyeZ)} ---`);
    console.log(`Walls (${walls.length}):`);
    console.table(walls);
    if (doors.length) { console.log('Doors:'); console.table(doors); }
    if (lifts.length) { console.log('Lifts:'); console.table(lifts); }
    console.log(`Things (${things.length}):`);
    console.table(things);
    if (projectiles.length) { console.log('Projectiles:'); console.table(projectiles); }

    return { walls, doors, lifts, things, projectiles };
};

/** List all map triggers (linedef specials). */
world.triggers = () => {
    const triggers = mapData.triggers || [];
    triggers.forEach((t, i) => {
        console.log(`[${i}] type=${t.specialType} tag=${t.sectorTag} (${t.start.x},${t.start.y})→(${t.end.x},${t.end.y})${t._triggered ? ' [FIRED]' : ''}`);
    });
    console.log(`${triggers.length} trigger(s). Use debug.world.trigger(index) to fire one.`);
};

/** Fire a specific trigger linedef by index (from debug.world.triggers()). */
world.trigger = (index) => {
    const triggers = mapData.triggers || [];
    const trigger = triggers[index];
    if (!trigger) { console.error(`No trigger at index ${index}. Use debug.world.triggers() to see available.`); return; }
    console.log(`Firing trigger [${index}] type=${trigger.specialType} tag=${trigger.sectorTag}`);
    const entries = getLiftEntries();
    for (let i = 0; i < entries.length; i++) {
        if (entries[i].entry.tag === trigger.sectorTag) activateLift(entries[i].sectorIndex);
    }
};

/** Activate a lift in a specific sector. */
world.activateLift = activateLift;

/** List all lifts on the current map. */
world.lifts = () => {
    getLiftEntries().forEach(({ sectorIndex, entry }) => {
        console.log(`sector=${sectorIndex} tag=${entry.tag} height=${entry.currentHeight} (${entry.lowerHeight}..${entry.upperHeight}) moving=${entry.moving} oneWay=${entry.oneWay}`);
    });
};

// ── debug.sectors — dissect the level for the talk's "anatomy of a
// sector" animation. Pure DOM toggles on the .sector#s{id} containers;
// the actual motion / fade lives in CSS (debug/sectors.css + the
// surface transforms). Spans every pane (per-pane DOM duplication is
// intentional). With no id, hide/show/explode act on every sector.
const sectors = group('sectors');
const sectorEls = (id) =>
    document.querySelectorAll(id == null ? '.sector' : `.sector#s${id}`);
const allSectors = () => document.querySelectorAll('.sector');

/** Hide a sector outright (display:none via the `hidden` attribute). */
sectors.hide = (id) => sectorEls(id).forEach(el => el.setAttribute('hidden', ''));
/** Reveal a sector — clears both hide() (the `hidden` attribute) and only()'s
 *  fade (the `.faded` class), so it shows regardless of how it was hidden. */
sectors.show = (id) => sectorEls(id).forEach(el => {
    el.removeAttribute('hidden');
    el.classList.remove('faded');
});

/** Animate a sector apart so its construction is visible — walls shrink in
 *  place while floors/ceilings shrink and slide apart (down/up). CSS
 *  handles the motion (per-surface --explode-scale / --explode-dist); call
 *  reset() to re-assemble. */
sectors.explode = (id) => sectorEls(id).forEach(el => el.classList.add('exploded'));

/** Reverse of explode — re-assemble the sector back to normal (animated). */
sectors.implode = (id) => sectorEls(id).forEach(el => el.classList.remove('exploded'));

/** Fade every sector EXCEPT the given one to transparent, so it stands
 *  alone. id is required; surfaces fade via opacity (see debug/sectors.css). */
sectors.only = (id) => allSectors().forEach(el =>
    el.classList.toggle('faded', el.id !== `s${id}`));

/** Rotate a sector's walls, floors and ceilings to face the camera
 *  (animated). Meant to run after explode(id) — the surfaces billboard at
 *  their exploded positions. CSS handles the motion (transition on
 *  --billboard). */
sectors.billboard = (id) => sectorEls(id).forEach(el => el.classList.add('billboarded'));

/** Lay a grid copy of a sector's floor just BELOW the real (clipped, textured)
 *  one, with the clip removed so the whole bounding rectangle shows: the
 *  texture covers the sector polygon on top, the grid + dotted border reveal
 *  the clipped-away "negative" space around it. Toggles; with no id, every
 *  floor. (CSS: `.floor.floor-grid` in sectors.css.) */
sectors.floorGrid = (id) => {
    const realSel = id == null ? '.floor[data-sector]:not(.floor-grid)' : `.floor[data-sector="${id}"]:not(.floor-grid)`;
    const gridSel = id == null ? '.floor-grid' : `.floor-grid[data-grid-for="${id}"]`;
    const grids = document.querySelectorAll(gridSel);
    if (grids.length) { grids.forEach(el => el.remove()); return; }  // toggle off
    document.querySelectorAll(realSel).forEach(floor => {
        const grid = floor.cloneNode(false);
        grid.classList.add('floor-grid');
        grid.dataset.gridFor = floor.dataset.sector;
        grid.removeAttribute('data-texture');          // no texture
        grid.style.clipPath = 'none';                  // ignore the clip → full rectangle
        const fz = parseFloat(floor.style.getPropertyValue('--floor-z')) || 0;
        grid.style.setProperty('--floor-z', fz - 0.1);
        floor.before(grid);
    });
};

/** Undo explode / billboard / only / hide on every sector and drop any floor
 *  grids. Explode, fade and re-assembly animate; the billboard snaps back (its
 *  transform is class-gated), so for a graceful reverse drop .billboarded on
 *  its own first. */
sectors.reset = () => {
    allSectors().forEach(el => {
        el.classList.remove('exploded', 'faded', 'billboarded');
        el.removeAttribute('hidden');
    });
    document.querySelectorAll('.floor-grid').forEach(el => el.remove());
};

// ── debug.layers — cross-fade whole scene layers in / out ──────────────────
// Opacity fade of every wall / floor / ceiling / thing (pickups, decorations,
// barrels) vs the panel's instant hide-* toggles; 'sky' fades the sky
// background to black behind the scene. Pass a layer name, or omit for all.
//   debug.layers.fadeOut('walls')  ·  debug.layers.fadeIn('sky')
const layers = group('layers');
const LAYER_NAMES = ['walls', 'floors', 'ceilings', 'sky', 'things'];
const eachLayer = (layer) => layer ? [layer] : LAYER_NAMES;

/** Fade a scene layer ('walls' | 'floors' | 'ceilings', or all) to transparent. */
layers.fadeOut = (layer) => eachLayer(layer).forEach(l => document.body.classList.add(`fade-${l}`));
/** Fade a scene layer (or all) back in. */
layers.fadeIn = (layer) => eachLayer(layer).forEach(l => document.body.classList.remove(`fade-${l}`));

// ── debug.fx — composed, timed set pieces for the talk ─────────────────────
const fx = group('fx');
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

/** Talk set piece: strip the chrome (HUD, sky, things, enemies), then
 *  explode a sector and billboard it to the camera on a timeline. Pass a
 *  sector id, or omit to act on every sector. */
fx.billboard = async (id) => {
    document.body.classList.add('hide-hud', 'hide-sky', 'hide-things', 'hide-enemies');
    await delay(1000);

    if (id != null) {
        sectors.only(id);
        await delay(1000);
    }

    sectors.explode(id);
    await delay(3000);
    // sectors.billboard(id);
};

// ── debug.path — record / replay the player's path (position + angle) ──────
// Segment-based recording with a top-centre transport panel; replay moves the
// PLAYER along a path while the game loop runs, so the camera follows and the
// world reacts. The basis for hand-scripted talk shots — see src/debug/path.js.
//   debug.path.record()                       — start a session (opens panel)
//   .mark() .pause() .resume() .rewind() .review() .stop()  — transport
//   .save('slot') / .load('slot') / .export() — persist / dump (per segment)
//   .seek(pathOrSlot, { segment })  — teleport to a segment's start frame
//   await debug.path.play(pathOrSlot, { speed, segment })  — replay it
const path = group('path');
path.record = pathModule.record;
path.mark = pathModule.mark;
path.pause = pathModule.pause;
path.resume = pathModule.resume;
path.rewind = pathModule.rewind;
path.review = pathModule.review;
path.stop = pathModule.stop;
path.save = pathModule.save;
path.load = pathModule.load;
path.export = pathModule.exportPath;
path.seek = pathModule.seek;
path.play = pathModule.play;

// ── debug.game — render-command recording ─────────────────────────────────
// Capture every envelope through orchestrator.dispatch from a clean level
// state, save to storage, replay via ?play=slot.
//   debug.game.record()    — restart current level, start capturing
//   debug.game.save('slot') — write buffer to storage
const game = group('game');
game.record = async () => {
    recorder.start();
    await swapLevel(currentMap);
};
game.save = (slot) => recorder.save(slot);
