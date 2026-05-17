/**
 * Renders toggle checkboxes that add/remove CSS classes on <body>
 * to enable visual debug features (lighting, scrolling textures, etc.).
 * Also provides culling toggles with live stats.
 */

import { culling, cullingStats } from '../renderer/scene/culling.js';
import { state, debug } from '../game/state.js';
import { EYE_HEIGHT } from '../game/constants.js';
import { THING_NAMES } from '../renderer/scene/constants.js';
import { getFloorHeightAt, getSectorAt } from '../game/physics.js';
import { updateCamera } from '../renderer/index.js';
import { mapData, currentMap, getNextMap } from '../shared/maps/index.js';
import { swapLevel } from '../game/level.js';
import { forEachWallInAABB } from '../game/spatial-grid.js';
import { endMatch } from '../game/match.js';
import { enterAttract } from './attract.js';
import { showIntermission } from './intermission.js';

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
    updateCamera(player);
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
    updateCamera(player);
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

const DEBUG_TOGGLES = [
    { name: 'all-enemies-shadow', label: 'All enemies shadow', defaultOn: false },
    { name: 'show-sky-walls', label: 'Show sky walls', defaultOn: false },
    { name: 'show-wall-ids', label: 'Show wall IDs', defaultOn: false },
    { name: 'show-sector-ids', label: 'Show sector IDs', defaultOn: false },
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

export function initDebugMenu() {
    const details = document.createElement('details');
    details.id = 'debug-menu';

    const summary = document.createElement('summary');
    summary.textContent = 'Debug';
    details.appendChild(summary);

    // Visual toggles
    for (const toggle of TOGGLES) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = document.body.classList.contains(toggle.name);

        checkbox.addEventListener('change', () => {
            document.body.classList.toggle(toggle.name, checkbox.checked);
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${toggle.label}`));
        details.appendChild(label);
    }

    // Separator
    const hr = document.createElement('hr');
    hr.style.cssText = 'border:0;border-top:1px solid #444;margin:4px 0';
    details.appendChild(hr);

    // Culling toggles (in processing order) with per-step stats
    for (const toggle of CULLING_TOGGLES) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = culling[toggle.key];

        checkbox.addEventListener('change', () => {
            culling[toggle.key] = checkbox.checked;
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${toggle.label}`));
        details.appendChild(label);

        const stat = document.createElement('div');
        stat.style.cssText = 'font-size:11px;color:#888;padding-left:20px';
        details.appendChild(stat);
        cullingStatElements[toggle.statKey] = stat;
    }

    // CSS culling experiments
    for (const toggle of CSS_CULLING_TOGGLES) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = toggle.defaultOn;

        if (toggle.defaultOn) document.body.classList.add(toggle.name);

        checkbox.addEventListener('change', () => {
            document.body.classList.toggle(toggle.name, checkbox.checked);
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${toggle.label}`));
        details.appendChild(label);
    }

    // Separator
    const hr2 = document.createElement('hr');
    hr2.style.cssText = 'border:0;border-top:1px solid #444;margin:4px 0';
    details.appendChild(hr2);

    // Gameplay toggles
    const noAttackLabel = document.createElement('label');
    const noAttackCheckbox = document.createElement('input');
    noAttackCheckbox.type = 'checkbox';
    noAttackCheckbox.checked = false;
    noAttackCheckbox.addEventListener('change', () => {
        debug.noEnemyAttack = noAttackCheckbox.checked;
    });
    noAttackLabel.appendChild(noAttackCheckbox);
    noAttackLabel.appendChild(document.createTextNode(' No enemy attack'));
    details.appendChild(noAttackLabel);

    const noMoveLabel = document.createElement('label');
    const noMoveCheckbox = document.createElement('input');
    noMoveCheckbox.type = 'checkbox';
    noMoveCheckbox.checked = false;
    noMoveCheckbox.addEventListener('change', () => {
        debug.noEnemyMove = noMoveCheckbox.checked;
    });
    noMoveLabel.appendChild(noMoveCheckbox);
    noMoveLabel.appendChild(document.createTextNode(' No enemy movement'));
    details.appendChild(noMoveLabel);

    const noclipLabel = document.createElement('label');
    const noclipCheckbox = document.createElement('input');
    noclipCheckbox.type = 'checkbox';
    noclipCheckbox.checked = false;
    noclipCheckbox.addEventListener('change', () => {
        debug.noclip = noclipCheckbox.checked;
    });
    noclipLabel.appendChild(noclipCheckbox);
    noclipLabel.appendChild(document.createTextNode(' No collision (noclip)'));
    details.appendChild(noclipLabel);

    // Separator
    const hr3 = document.createElement('hr');
    hr3.style.cssText = 'border:0;border-top:1px solid #444;margin:4px 0';
    details.appendChild(hr3);

    // Debug visualization toggles
    for (const toggle of DEBUG_TOGGLES) {
        const label = document.createElement('label');
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = toggle.defaultOn;

        if (toggle.defaultOn) document.body.classList.add(toggle.name);

        checkbox.addEventListener('change', () => {
            document.body.classList.toggle(toggle.name, checkbox.checked);
        });

        label.appendChild(checkbox);
        label.appendChild(document.createTextNode(` ${toggle.label}`));
        details.appendChild(label);
    }

    // Separator
    const hr4 = document.createElement('hr');
    hr4.style.cssText = 'border:0;border-top:1px solid #444;margin:4px 0';
    details.appendChild(hr4);

    const buttonStyle = 'display:block;margin:4px 0;padding:4px 8px;font:inherit;background:#222;color:#ddd;border:1px solid #444;cursor:pointer';

    // End-match button — forces the post-match scoreboard up without
    // having to actually hit the frag limit or wait out the timer.
    const endBtn = document.createElement('button');
    endBtn.type = 'button';
    endBtn.textContent = 'End match';
    endBtn.style.cssText = buttonStyle;
    endBtn.addEventListener('click', () => endMatch());
    details.appendChild(endBtn);

    // Attract button — kicks the kiosk into attract mode immediately so
    // we don't have to wait out the idle timer to inspect attract visuals.
    const attractBtn = document.createElement('button');
    attractBtn.type = 'button';
    attractBtn.textContent = 'Enter attract';
    attractBtn.style.cssText = buttonStyle;
    attractBtn.addEventListener('click', () => enterAttract());
    details.appendChild(attractBtn);

    // SP intermission button — shows the level-finish stats screen so we
    // can inspect it without having to find an exit.
    const intermissionBtn = document.createElement('button');
    intermissionBtn.type = 'button';
    intermissionBtn.textContent = 'Show intermission';
    intermissionBtn.style.cssText = buttonStyle;
    intermissionBtn.addEventListener('click', () => {
        showIntermission(getNextMap(), (next) => { if (next) swapLevel(next); });
    });
    details.appendChild(intermissionBtn);

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
