/**
 * Renders toggle checkboxes that add/remove CSS classes on <body>
 * to enable visual debug features (lighting, scrolling textures, etc.).
 * Also provides culling toggles with live stats.
 */

import { culling, cullingStats } from '../scene/culling.js';
import { state, debug } from '../../../game/state.js';
import { EYE_HEIGHT } from '../../../shared/constants.js';
import { THING_NAMES } from '../scene/constants.js';
import { getFloorHeightAt, getSectorAt } from '../../../game/physics.js';
import { orchestrator } from '../../../orchestrator.js';
import { mapData, currentMap } from '../../../shared/maps/index.js';
import { swapLevel } from '../../../game/level.js';
import { forEachWallInAABB } from '../../../game/spatial-grid.js';
import { endMatch } from '../../../game/match.js';
import { enterAttract } from '../../../game/attract.js';
import { app } from '../../../app.js';
import { rendererManager } from '../../manager.js';
import { buildCatchup, applyCatchupCmds } from '../../../game/catchup.js';

/** Teleport player to a thing by type name (e.g. teleportTo('spectre')) */

window.teleportTo = function(name) {
    const thing = state.things.find(t => {
        const typeName = THING_NAMES[t.type] || '';
        return typeName === name;
    });
    if (!thing) { console.log(`No "${name}" found on this map`); return; }
    const player = state.players[0];
    player.x = thing.x;
    player.y = thing.y;
    console.log(`Teleported to ${name} at (${thing.x}, ${thing.y})`);
};

window.teleport = (positionX, positionY, angleDegrees) => {
    const player = state.players[0];
    player.x = positionX;
    player.y = positionY;
    if (angleDegrees !== undefined) player.angle = angleDegrees * Math.PI / 180;
    player.floorHeight = getFloorHeightAt(player.x, player.y);
    player.z = player.floorHeight + EYE_HEIGHT;
    orchestrator.updateCamera(player.viewportIndex, {
        x: player.x,
        y: player.y,
        z: player.z,
        angle: player.angle,
        floorHeight: player.floorHeight ?? 0,
        isFiring: player.isFiring,
    });
};

window.save = function (slot = 0) {
    const player = state.players[0];
    const data = {
        map: currentMap,
        x: player.x,
        y: player.y,
        angle: player.angle,
    };
    localStorage.setItem(`cssdoom-save-${slot}`, JSON.stringify(data));
    console.log(`Saved slot ${slot}: ${currentMap} (${Math.round(data.x)}, ${Math.round(data.y)})`);
};

window.load = async function (slot = 0) {
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
        x: player.x,
        y: player.y,
        z: player.z,
        angle: player.angle,
        floorHeight: player.floorHeight ?? 0,
        isFiring: player.isFiring,
    });
    console.log(`Loaded slot ${slot}: ${data.map} (${Math.round(data.x)}, ${Math.round(data.y)})`);
};

/** Dump player position, angle, sector, and current map */
window.dump = function () {
    const player = state.players[0];
    const sector = getSectorAt(player.x, player.y);
    const angleDeg = ((player.angle * 180 / Math.PI) % 360 + 360) % 360;
    const lookX = -Math.sin(player.angle);
    const lookY = Math.cos(player.angle);
    const info = {
        map: currentMap,
        position: { x: Math.round(player.x), y: Math.round(player.y), z: Math.round(player.z) },
        floorHeight: player.floorHeight,
        angle: Math.round(angleDeg) + '°',
        lookDir: { x: +lookX.toFixed(3), y: +lookY.toFixed(3) },
        sector: sector ? {
            index: sector.sectorIndex,
            floor: sector.floorHeight,
            ceiling: sector.ceilingHeight,
            light: sector.lightLevel,
        } : null,
        health: player.health,
        armor: player.armor,
        weapon: player.currentWeapon,
        isDead: player.isDead,
    };
    console.table ? console.table(info.position) : null;
    console.log(info);
    return info;
};

/** Dump all walls, doors, things, and projectiles near the player */
window.nearby = function (radius = 512) {
    const player = state.players[0];
    const px = player.x, py = player.y;
    const eyeZ = player.floorHeight + EYE_HEIGHT;
    const r = radius;

    // Walls
    const walls = [];
    forEachWallInAABB(px - r, py - r, px + r, py + r, wall => {
        const cx = (wall.start.x + wall.end.x) / 2;
        const cy = (wall.start.y + wall.end.y) / 2;
        const dist = Math.sqrt((cx - px) ** 2 + (cy - py) ** 2);
        if (dist > r) return;
        walls.push({
            wallId: wall.wallId,
            texture: wall.texture,
            bottom: wall.bottomHeight,
            top: wall.topHeight,
            isSolid: !!wall.isSolid,
            isUpper: !!wall.isUpperWall,
            isLower: !!wall.isLowerWall,
            isMiddle: !!wall.isMiddleWall,
            isDoor: !!wall.isDoor,
            sector: wall.sectorIndex,
            dist: Math.round(dist),
            from: `${wall.start.x},${wall.start.y}`,
            to: `${wall.end.x},${wall.end.y}`,
        });
    });
    walls.sort((a, b) => a.dist - b.dist);

    // Doors
    const doors = [];
    for (const [sectorIndex, door] of state.doorState) {
        const sector = mapData.sectors[sectorIndex];
        if (!sector) continue;
        doors.push({
            sectorIndex,
            tag: sector.tag,
            open: door.open,
            passable: door.passable,
            height: door.currentHeight,
            openHeight: door.openHeight,
        });
    }

    // Lifts
    const lifts = [];
    for (const [sectorIndex, lift] of state.liftState) {
        lifts.push({
            sectorIndex,
            tag: lift.tag,
            currentHeight: lift.currentHeight,
            active: lift.active,
        });
    }

    // Things
    const things = [];
    for (let i = 0; i < state.things.length; i++) {
        const t = state.things[i];
        const dist = Math.sqrt((t.x - px) ** 2 + (t.y - py) ** 2);
        if (dist > r) continue;
        things.push({
            index: i,
            type: t.type,
            name: THING_NAMES[t.type] || '?',
            x: Math.round(t.x),
            y: Math.round(t.y),
            collected: !!t.collected,
            hp: t.hp,
            aiState: t.ai?.state,
            dist: Math.round(dist),
        });
    }
    things.sort((a, b) => a.dist - b.dist);

    // Projectiles
    const projectiles = state.projectiles.map(p => ({
        id: p.id,
        x: Math.round(p.x),
        y: Math.round(p.y),
        z: Math.round(p.z),
        source: p.source,
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


const TOGGLES = [
    { name: 'sector-lights', label: 'Sector light effects', defaultOn: true },
    { name: 'light-falloff', label: 'Light falloff', defaultOn: false },
    { name: 'scroll-textures', label: 'Scrolling textures', defaultOn: true },
    { name: 'animated-flats', label: 'Animated flats', defaultOn: true },
    { name: 'head-bob', label: 'Head bob', defaultOn: true },
];

// Apply default feature toggles immediately so they work without the debug menu
for (const toggle of TOGGLES) {
    if (toggle.defaultOn) document.body.classList.add(toggle.name);
}

// Geometry / entity hide toggles — used to dissect scenes for the
// talk visuals (e.g. show just the walls, then add floors, then
// ceilings). CSS rules in debug.css hook each `body.hide-…` class
// to its `display: none` selector.
// Renderer-layer toggles. Labels are the positive ("Floors") and
// the checkbox-checked state means "visible" — the `hide-…` class
// is added when the user UNCHECKS the box. Reads more naturally
// for the talk's geometry walk-through ("turn off floors" =
// uncheck Floors).
const HIDE_TOGGLES = [
    { name: 'hide-floors',   label: 'Floors'   },
    { name: 'hide-ceilings', label: 'Ceilings' },
    { name: 'hide-walls',    label: 'Walls'    },
    { name: 'hide-things',   label: 'Things'   },
    { name: 'hide-enemies',  label: 'Enemies'  },
    { name: 'hide-hud',      label: 'HUD'      },
    { name: 'hide-sky',      label: 'Sky'      },
];

// Ordered to match processing order in updateCulling()
const CULLING_TOGGLES = [
    { key: 'distance', label: 'Distance culling', statKey: 'afterDistance' },
    { key: 'backface', label: 'Backface culling', statKey: 'afterBackface' },
    { key: 'frustum', label: 'Frustum culling', statKey: 'afterFrustum' },
    { key: 'sky', label: 'Sky culling', statKey: 'afterSky' },
];

const CSS_CULLING_TOGGLES = [
    { name: 'css-distance-culling', label: 'CSS distance culling', defaultOn: false },
    { name: 'css-frustum-culling', label: 'CSS frustum culling', defaultOn: false },
];

const cullingStatElements = {};

/**
 * Swap the SP renderer at runtime. Tears down the existing pane,
 * builds a fresh one via manager.create() (which reads
 * body.dataset.renderer), reloads the current map, then replays a
 * world-state catchup so the new renderer arrives with the same
 * door / lift / thing state the old one had. The first renderer in
 * the manager's list is the SP pane; the loop body skips if there
 * isn't one (e.g. in a join-only client window).
 */
async function switchRenderer(kind) {
    const old = rendererManager.all[0];
    if (!old) return;

    const playerIndex = old.playerIndex;
    const savedSlot = old.paneEl.dataset.slot;
    const savedCamera = old.state?.camera ? { ...old.state.camera } : null;

    orchestrator.removeTarget(old);
    rendererManager.destroy(old);

    document.body.dataset.renderer = kind;
    const fresh = rendererManager.create(kind, playerIndex);
    if (savedSlot !== undefined) fresh.paneEl.dataset.slot = savedSlot;
    orchestrator.addTarget(fresh);

    if (currentMap && typeof fresh.loadMap === 'function') {
        await fresh.loadMap(currentMap);
        applyCatchupCmds(fresh, buildCatchup(playerIndex));
        if (savedCamera && typeof fresh.updateCamera === 'function') {
            fresh.updateCamera(savedCamera);
        }
    }
}

// ── Small helpers — keep initDebugMenu readable as a flat list of
//    sections + items. Each helper appends one row to the parent.

function appendHeader(parent, title) {
    const h = document.createElement('div');
    h.className = 'debug-section';
    h.textContent = title;
    parent.appendChild(h);
}

/** Body-class toggle — checkbox flips a class on document.body.
 *  Default state read from whether the class is already present
 *  (set at module load for TOGGLES). */
function appendClassToggle(parent, name, label) {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = document.body.classList.contains(name);
    cb.addEventListener('change', () => {
        document.body.classList.toggle(name, cb.checked);
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(` ${label}`));
    parent.appendChild(lbl);
}

/** Inverted body-class toggle — checked = class absent, so the
 *  user reads it as "Floors are visible" rather than "Hide
 *  floors". Used by the renderer hide-toggles which all map to
 *  `hide-…` classes. */
function appendInvertedClassToggle(parent, name, label) {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !document.body.classList.contains(name);
    cb.addEventListener('change', () => {
        document.body.classList.toggle(name, !cb.checked);
    });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(` ${label}`));
    parent.appendChild(lbl);
}

/** debug-flag toggle — checkbox flips a boolean on the `debug`
 *  state object (read by game logic each tick). */
function appendFlagToggle(parent, flag, label) {
    const lbl = document.createElement('label');
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = !!debug[flag];
    cb.addEventListener('change', () => { debug[flag] = cb.checked; });
    lbl.appendChild(cb);
    lbl.appendChild(document.createTextNode(` ${label}`));
    parent.appendChild(lbl);
}

function appendButton(parent, label, onClick, extraClass = '') {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.className = `debug-button${extraClass ? ' ' + extraClass : ''}`;
    btn.addEventListener('click', onClick);
    parent.appendChild(btn);
}

export function initDebugMenu() {
    const details = document.createElement('details');
    details.id = 'debug-menu';

    const summary = document.createElement('summary');
    summary.textContent = 'Debug';
    details.appendChild(summary);

    // ── Game ──────────────────────────────────────────────────
    appendHeader(details, 'Game');
    appendFlagToggle(details, 'noEnemyAttack', 'No enemy attack');
    appendFlagToggle(details, 'noEnemyMove',   'No enemy movement');
    appendFlagToggle(details, 'noclip',        'No collision (noclip)');

    // ── Culling ───────────────────────────────────────────────
    // CULLING_TOGGLES drive the `culling` flags directly (not
    // body classes) and each gets a stats element below it for
    // the per-frame "in → out" readout.
    appendHeader(details, 'Culling');
    for (const toggle of CULLING_TOGGLES) {
        const lbl = document.createElement('label');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = culling[toggle.key];
        cb.addEventListener('change', () => { culling[toggle.key] = cb.checked; });
        lbl.appendChild(cb);
        lbl.appendChild(document.createTextNode(` ${toggle.label}`));
        details.appendChild(lbl);

        const stat = document.createElement('div');
        stat.className = 'debug-stat';
        details.appendChild(stat);
        cullingStatElements[toggle.statKey] = stat;
    }
    for (const toggle of CSS_CULLING_TOGGLES) {
        appendClassToggle(details, toggle.name, toggle.label);
    }

    // ── Effects ───────────────────────────────────────────────
    appendHeader(details, 'Effects');
    for (const toggle of TOGGLES) {
        appendClassToggle(details, toggle.name, toggle.label);
    }
    appendClassToggle(details, 'all-enemies-shadow', 'All enemies shadow');

    // ── Renderer ──────────────────────────────────────────────
    // Dropdown swaps the SP renderer at runtime while keeping
    // camera + world state in place (catchup-replay covers the
    // doors / lifts / things the fresh renderer would otherwise
    // be missing). Hide-toggles let you peel layers off the
    // scene one at a time — useful for the talk's geometry walk-
    // through.
    appendHeader(details, 'Renderer');
    const rendererLabel = document.createElement('label');
    rendererLabel.appendChild(document.createTextNode('Renderer: '));
    const rendererSelect = document.createElement('select');
    rendererSelect.className = 'debug-select';
    for (const kind of ['dom', 'flat', 'shade', 'line', 'cat']) {
        const opt = document.createElement('option');
        opt.value = kind;
        opt.textContent = kind;
        rendererSelect.appendChild(opt);
    }
    rendererSelect.value = document.body.dataset.renderer || 'dom';
    rendererSelect.addEventListener('change', () => switchRenderer(rendererSelect.value));
    rendererLabel.appendChild(rendererSelect);
    details.appendChild(rendererLabel);
    // Two-column grid of layer toggles. Inverted semantics —
    // checked = visible — so reading the menu matches reading
    // the scene.
    const layerGrid = document.createElement('div');
    layerGrid.className = 'debug-grid';
    for (const toggle of HIDE_TOGGLES) {
        appendInvertedClassToggle(layerGrid, toggle.name, toggle.label);
    }
    details.appendChild(layerGrid);

    // ── Debug ─────────────────────────────────────────────────
    appendHeader(details, 'Debug');
    appendClassToggle(details, 'show-sky-walls',   'Show sky walls');
    appendClassToggle(details, 'show-wall-ids',    'Show wall IDs');
    appendClassToggle(details, 'show-sector-ids',  'Show sector IDs');

    // ── State ─────────────────────────────────────────────────
    // End-level fires the same level-complete event the exit
    // switch fires (always shown). End-match forces the post-
    // match scoreboard up without hitting the frag limit; only
    // meaningful in DM, hidden via CSS in SP. Attract kicks the
    // kiosk into attract mode immediately so we don't have to
    // wait out the idle timer; only meaningful in kiosk mode.
    appendHeader(details, 'State');
    appendButton(details, 'End level',     () => app.game?.endCurrentLevel());
    appendButton(details, 'End match',     () => endMatch(),     'debug-button-dm');
    appendButton(details, 'Enter attract', () => enterAttract(), 'debug-button-kiosk');

    document.body.appendChild(details);
}

/** Update the stats text. Called each frame from the game loop. */
export function updateDebugStats() {
    const { total } = cullingStats;
    const anyCulling = culling.frustum || culling.distance || culling.backface;

    // Per-step stats: show "input → output" for each enabled step
    let prev = total;
    for (const toggle of CULLING_TOGGLES) {
        const el = cullingStatElements[toggle.statKey];
        if (!el) continue;
        if (anyCulling && culling[toggle.key]) {
            const after = cullingStats[toggle.statKey];
            el.textContent = `${prev} → ${after}`;
            prev = after;
        } else {
            el.textContent = '';
        }
    }
}
