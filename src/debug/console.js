/**
 * The single console surface. `window.debug` is a callable object: calling it
 * opens the debug panel; every console command hangs off it in grouped
 * sub-objects (debug.position.*, debug.world.*, debug.game.*). This module is
 * the sole owner — it imports implementations from the domain modules so
 * nothing else has to reach back into the debug layer (which would risk a
 * circular import). Loaded for its side effects at boot from master.js.
 */

import { state, debugFlags } from '../game/state.js';
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
import * as cameraModule from './camera.js';
import * as spritesModule from './sprites.js';
import { registerCustom } from './custom.js';
import { initDebugMenu, switchRenderer } from './panel.js';
import { spectate } from '../ui/spectator.js';

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

/** Get a sector's DOM element (the `.sector#s{id}` container) to poke at
 *  directly — add classes, set custom props, etc. Returns the first match (the
 *  SP pane); for every pane use document.querySelectorAll(`.sector#s${id}`). */
sectors.get = (id) => sectorEls(id)[0] ?? null;

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

/** Fade every sector EXCEPT the given one(s) to transparent, so they stand
 *  alone. Pass one or more ids — debug.sectors.only(29) or .only(29, 32).
 *  At least one id is required; surfaces fade via opacity (see sectors.css). */
sectors.only = (...ids) => {
    const keep = new Set(ids.map(id => `s${id}`));
    allSectors().forEach(el => el.classList.toggle('faded', !keep.has(el.id)));
};

/** Rotate a sector's walls, floors and ceilings to face the camera
 *  (animated). Meant to run after explode(id) — the surfaces billboard at
 *  their exploded positions. CSS handles the motion (transition on
 *  --billboard). */
sectors.billboard = (id) => sectorEls(id).forEach(el => el.classList.add('billboarded'));

// Restore a sector's renderer --light (saved by highlight()); no-op if it
// wasn't overridden.
const restoreSectorLight = (el) => {
    const saved = el.dataset.litLight;
    if (saved === undefined) return;
    if (saved) el.style.setProperty('--light', saved); else el.style.removeProperty('--light');
    delete el.dataset.litLight;
};

/** Highlight a sector — flood its walls / floors / ceilings with a solid accent
 *  (#F8BA00), drop their textures, and lift its base brightness to full so it
 *  pops. The light-fx animations (blink / glow / flicker) still drive --light,
 *  so dynamic lighting keeps playing — only the static dim level is overridden.
 *  With no id, every sector. (CSS: `.sector.highlighted` in sectors.css.) */
sectors.highlight = (id) => sectorEls(id).forEach(el => {
    el.classList.add('highlighted');
    // --light is set inline by the renderer; an fx animation (if any) overrides
    // the inline value, so setting it to 1 here keeps fx while flooring the base.
    if (el.dataset.litLight === undefined) el.dataset.litLight = el.style.getPropertyValue('--light');
    el.style.setProperty('--light', '1');
});
/** Remove a sector highlight (or all) — restores the renderer's brightness. */
sectors.unhighlight = (id) => sectorEls(id).forEach(el => {
    el.classList.remove('highlighted');
    restoreSectorLight(el);
});

/** Lay a grid copy of a sector's floor just BELOW the real (clipped, textured)
 *  one, with the clip removed so the whole bounding rectangle shows: the
 *  texture covers the sector polygon on top, the grid + dotted border reveal
 *  the clipped-away "negative" space around it. Fades in (the grid rides the
 *  sector's surface opacity transition, see sectors.css). With no id, every
 *  floor; calling again is a no-op where a grid already exists. */
sectors.showFloorGrid = (id) => {
    const realSel = id == null ? '.floor[data-sector]:not(.floor-grid)' : `.floor[data-sector="${id}"]:not(.floor-grid)`;
    document.querySelectorAll(realSel).forEach(floor => {
        // Don't stack a second grid on a floor that already has one.
        if (floor.previousElementSibling?.classList.contains('floor-grid')) return;
        const grid = floor.cloneNode(false);
        grid.classList.add('floor-grid');
        grid.dataset.gridFor = floor.dataset.sector;
        grid.removeAttribute('data-texture');          // no texture
        grid.style.clipPath = 'none';                  // ignore the clip → full rectangle
        const fz = parseFloat(floor.style.getPropertyValue('--floor-z')) || 0;
        grid.style.setProperty('--floor-z', fz - 0.1);
        grid.style.opacity = '0';                      // start transparent → fade in next frame
        floor.before(grid);
        requestAnimationFrame(() => { grid.style.opacity = '1'; });
    });
};

/** Fade out and remove the floor grid(s) laid by showFloorGrid. No id = all. */
sectors.hideFloorGrid = (id) => {
    const gridSel = id == null ? '.floor-grid' : `.floor-grid[data-grid-for="${id}"]`;
    document.querySelectorAll(gridSel).forEach(el => {
        const onEnd = (e) => {
            if (e.propertyName !== 'opacity') return;
            el.removeEventListener('transitionend', onEnd);
            el.remove();
        };
        el.addEventListener('transitionend', onEnd);
        el.style.opacity = '0';
    });
};

/** Undo explode / billboard / only / hide on every sector and drop any floor
 *  grids. Explode, fade and re-assembly animate; the billboard snaps back (its
 *  transform is class-gated), so for a graceful reverse drop .billboarded on
 *  its own first. */
sectors.reset = () => {
    allSectors().forEach(el => {
        el.classList.remove('exploded', 'faded', 'billboarded', 'highlighted');
        el.removeAttribute('hidden');
        restoreSectorLight(el);
    });
    document.querySelectorAll('.floor-grid').forEach(el => el.remove());
};

// ── debug.sprites — sprite-sheet stepped-animation viz (see sprites.css) ────
// Lay a half-transparent clone of the whole sheet over each sprite and translate
// it in lockstep with the real stepped animation, so the active cell stays put
// while the sheet slides — shows how the walk cycle indexes the sheet. Targets
// the sprites in a sector (id), or every sprite with no id.
//   debug.sprites.showSheet(29)  ·  debug.sprites.hideSheet(29)
const sprites = group('sprites');
sprites.showSheet = spritesModule.showSheet;
sprites.hideSheet = spritesModule.hideSheet;

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

// ── debug.camera — view-relative orbit for talk shots (see camera.css) ──────
// Offset the eye AND re-aim to keep the target framed: x = right, y = up,
// z = back (world units, relative to where the camera faces); the view yaws/
// pitches back toward a pivot so move-right ⇒ turn-left, move-up ⇒ look-down.
// Eases from the previous offset over t seconds (t = 0 instant). 5th arg sets
// the pivot distance (gentler re-aim = larger). Debug-only; never touches the
// renderer.
//   debug.camera.offset(200, 120, 0, 2)   — orbit up/right over 2s, eyes on target
//   debug.camera.offset(0, 80, 300, 2, 800) — rise & pull back, far pivot
//   debug.camera.reset(1)                 — ease back to the eye over 1s
const camera = group('camera');
camera.offset = cameraModule.offset;
camera.reset = cameraModule.reset;

// ── debug.custom — hand-authored talk set pieces (see src/debug/custom.js) ──
// Scripts that string the debug.* commands together on a timeline. Authored
// separately so the building-block commands above stay clean.
registerCustom(debug);

// ── debug.path — record / replay the player's path (position + angle) ──────
// Segment-based recording with a top-centre transport panel; replay moves the
// PLAYER along a path while the game loop runs, so the camera follows and the
// world reacts. The basis for hand-scripted talk shots — see src/debug/path.js.
//   debug.path.record()                       — start a session (opens panel)
//   .mark() .pause() .resume() .rewind() .review() .stop()  — transport
//   .save('slot') / .load('slot') / .export() — persist / dump (per segment)
//   .seek(pathOrSlot, opts)  — teleport to a segment's start frame
//   await debug.path.play(pathOrSlot, opts)  — replay it
//   opts: { speed, segment, trim, smooth, start, end } (seek shares trim/
//     smooth/start/end). trim: drop non-moving frames at the start/end.
//     smooth: box-blur window (frames). start/end: { x?, y?, angle° } to bend
//     the path so it begins/lands exactly there (angles in degrees).
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
path.transition = pathModule.transition;
path.move = pathModule.move;

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

// Console toggles for the Game debug flags (the same debugFlags the menu
// checkboxes drive). No arg toggles; pass a boolean to set. The menu checkbox
// won't redraw until reopened — the flag itself is the source of truth.
//   debug.game.noDamage()  ·  .noAttack()  ·  .noMove()
const flagToggle = (key, label) => (on = !debugFlags[key]) => {
    debugFlags[key] = on;
    console.log(`[debug] ${label} ${on ? 'ON' : 'OFF'}`);
    return on;
};
game.noDamage = flagToggle('noDamage', 'no damage');
game.noAttack = flagToggle('noEnemyAttack', 'no enemy attack');
game.noMove = flagToggle('noEnemyMove', 'no enemy movement');

// ── debug.renderer — swap the single-player renderer at runtime ─────────────
// Same swap as the menu's Renderer picker: tears down the SP pane, rebuilds it
// with the chosen renderer, reloads the map + catches up world state. SP only.
// No arg logs the current renderer and the options.
//   debug.renderer('flat')   ·   debug.renderer()  — show current + choices
const RENDERERS = ['dom', 'flat', 'shade', 'lighting', 'line', 'cat'];
debug.renderer = (kind) => {
    if (kind == null) {
        console.log(`renderer: ${document.body.dataset.renderer || RENDERERS[0]} — options: ${RENDERERS.join(', ')}`);
        return;
    }
    if (!RENDERERS.includes(kind)) { console.warn(`[debug] unknown renderer "${kind}" — try: ${RENDERERS.join(', ')}`); return; }
    return switchRenderer(kind);
};

// ── debug.spectator — toggle spectator mode from the console ────────────────
// Same toggle as the binoculars button (which the Chrome toggle hides). SP only
// — refused in deathmatch. Call again to exit.
debug.spectator = () => spectate();
