/**
 * Player spawn / respawn — used at the start of a deathmatch and whenever a
 * dead player presses fire after the death cooldown.
 *
 * Per the locked DM design rules:
 *   - Items respawn after 30s in DM (handled in pickups.js).
 *   - All players have all keys (no key collection in DM).
 *   - Telefrag is OFF — pick a different spawn rather than crushing whoever
 *     happens to be at the chosen spawn point.
 *   - Initial weapon load: fist + pistol with 50 bullets, 100 hp.
 */

import { EYE_HEIGHT, PLAYER_RADIUS } from '../../shared/constants.js';
import { state } from '../state.js';
import { mapData } from '../../shared/maps/index.js';
import { equipWeapon } from '../entities/weapons.js';
import { getFloorHeightAt, getSectorAt } from '../physics.js';
import { orchestrator } from '../../orchestrator.js';
import * as renderer from '../../renderer/dom/index.js';
import { getCurrentLevel } from '../level.js';
import { addPlayerThing } from './start.js';

// Don't spawn a player within this distance of any living player. Picked
// to be a generous safety radius — about 4× player radius so the spawning
// player materialises out of immediate combat range.
const SPAWN_AVOID_RADIUS_SQ = (PLAYER_RADIUS * 4) * (PLAYER_RADIUS * 4);

/**
 * Picks a deathmatch start (type 11 thing) for the respawning player and
 * resets their stats. Telefrags are disabled — if every spawn is occupied
 * by another player, fall back to whichever spawn is furthest from any
 * living player so we don't materialise on top of someone.
 */
export function spawnPlayer(player) {
    const dmStarts = (mapData.things || []).filter(t => t.type === 11);
    const spawn = dmStarts.length > 0
        ? pickDmSpawn(dmStarts, player)
        : mapDataPlayerStartFallback();

    if (spawn) {
        player.x = spawn.x;
        player.y = spawn.y;
        // DM start `angle` is degrees, 0=east. Convert to north-radians.
        player.angle = (spawn.angle * Math.PI / 180) - Math.PI / 2;
    }
    player.floorHeight = getFloorHeightAt(player.x, player.y);
    player.z = player.floorHeight + EYE_HEIGHT;

    // Reset stats to DM default loadout.
    player.health = 100;
    player.armor = 0;
    player.armorType = 0;
    player.ammo = { bullets: 50, shells: 0, rockets: 0, cells: 0 };
    player.maxAmmo = { bullets: 200, shells: 50, rockets: 50, cells: 300 };
    player.hasBackpack = false;
    player.currentWeapon = 2;
    player.ownedWeapons = new Set([1, 2]);
    player.isFiring = false;
    player.sectorDamageTimer = 0;
    // Clear any active powerup visuals carried over from the previous life.
    for (const name in player.powerups) renderer.hidePowerup(player.viewportIndex, name);
    player.powerups = {};
    player.collectedKeys.clear();
    player.isDead = false;
    player.deathTime = 0;
    player._hudDirty = true;

    // Mid-match joiner path: the player was created by ensurePlayerCount
    // after Level.load already ran, so they have no thing entry and no
    // sprite in any pane. Create both now — addPlayerThing pushes into
    // state.things; createPlayerSprite fans out via the world dispatch
    // so every existing renderer (master locals + already-connected
    // sinks) materialises the billboard. Both are idempotent at the
    // receiver, so the reposition/uncollect blocks below remain safe.
    if (!player.thingRef) {
        addPlayerThing(player);
        const sectorIndex = getSectorAt(player.x, player.y)?.sectorIndex;
        renderer.createPlayerSprite(
            player.thingIndex, player.index,
            player.x, player.y, player.floorHeight, sectorIndex,
        );
    }

    // Reactivate the player's thing entry: collisions / AI / hitscan see
    // them again; sprite is visible at the new position.
    if (player.thingRef) {
        player.thingRef.collected = false;
        player.thingRef.x = player.x;
        player.thingRef.y = player.y;
        player.thingRef.floorHeight = player.floorHeight;
        player.thingRef.facing = Math.PI / 2 + player.angle;
    }
    if (player.thingIndex >= 0) {
        // Reveal the live sprite (was hidden on death by collectItem),
        // clear the death animation state (data-state="dead" + .dead
        // class on container), and teleport it to the new spawn point.
        // The corpse decoration spawned at the death point is a separate
        // element and stays put.
        renderer.uncollectItem(player.thingIndex);
        renderer.resetEnemy(player.thingIndex, -1, player.x, player.y, player.floorHeight);
        const sector = getSectorAt(player.x, player.y);
        if (sector) renderer.reparentThingToSector(player.thingIndex, sector.sectorIndex);
    }

    // Drop the dead-cam class and equip the default weapon (which
    // sets the right sprite in this player's pane). Keys reflect
    // automatically via updateHud reading player.collectedKeys.
    renderer.setPlayerDead(player.viewportIndex, false);
    equipWeapon(player, player.currentWeapon);
    // DM rule: every respawn comes back with all three keys.
    if (state.gameMode === 'deathmatch') {
        for (const color of ['blue', 'yellow', 'red']) {
            player.collectedKeys.add(color);
        }
    }

    // Spawn-fog effect + sound, matching DOOM-authentic respawn feel.
    renderer.createTeleportFog(player.x, player.floorHeight, player.y);
    renderer.triggerFlash(player.viewportIndex, 'teleport-flash');
    orchestrator.playSound('DSTELEPT', { x: player.x, y: player.y });

    // Informational. Game subscribes via _subscribeLevel and uses this
    // to confirm a slot is live again so it can hide a respawn overlay
    // or update lobby state.
    getCurrentLevel()?._emit('player-spawned', {
        slot: player.index,
    });
}

/**
 * Picks a DM start avoiding spawns near any living player. Random shuffle
 * over candidates so a long match doesn't always reuse the same spot.
 */
function pickDmSpawn(dmStarts, respawningPlayer) {
    const livingOthers = state.players.filter(p => p !== respawningPlayer && !p.isDead);

    // Score each spawn by how far it is from the nearest living player.
    // Higher score = safer; spawns within the avoid radius are filtered out
    // unless every spawn is too close (in which case we use the safest one).
    const scored = dmStarts.map(start => {
        let minDistSq = Infinity;
        for (const p of livingOthers) {
            const dx = start.x - p.x;
            const dy = start.y - p.y;
            const d = dx * dx + dy * dy;
            if (d < minDistSq) minDistSq = d;
        }
        return { start, minDistSq };
    });

    const safe = scored.filter(s => s.minDistSq >= SPAWN_AVOID_RADIUS_SQ);
    const pool = safe.length > 0 ? safe : scored;
    // Random selection within the eligible pool — keeps spawns varied.
    const pick = pool[Math.floor(Math.random() * pool.length)];
    return pick.start;
}

function mapDataPlayerStartFallback() {
    if (!mapData.playerStart) return null;
    return {
        x: mapData.playerStart.x,
        y: mapData.playerStart.y,
        // playerStart.angle is already radians; convert to degrees so the
        // common conversion path in spawnPlayer() works.
        angle: (mapData.playerStart.angle * 180 / Math.PI),
    };
}
