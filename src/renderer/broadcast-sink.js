/**
 * BroadcastSink — a render target that forwards commands over a
 * BroadcastChannel instead of painting DOM.
 *
 * From the orchestrator's perspective, BroadcastSink and DomRenderer are
 * interchangeable for per-pane commands: same method names, same arity. The
 * sink serializes each call as `{ type: 'cmd-pane', target, method, args }`
 * and posts it to the channel. The receiving side (BroadcastClient running
 * in the secondary window) deserializes and dispatches to its local
 * DomRenderer.
 *
 * World commands are forwarded separately via `forwardWorld(method, args)` —
 * see Orchestrator.world*() for the call site. Today the master also
 * applies the world command locally (the underlying helpers iterate every
 * pane internally, including the one the sink stands in for); the sink
 * still forwards because the secondary window has its own DOM tree and
 * needs its own copy of the update.
 */

import { MSG } from './broadcast-protocol.js';

export class BroadcastSink {
    /**
     * @param {BroadcastChannel} channel  shared channel
     * @param {number} paneIndex          master-side pane this sink represents
     */
    constructor(channel, paneIndex) {
        this.channel = channel;
        this.paneIndex = paneIndex;
    }

    /** Post a per-pane command envelope. */
    _post(method, args) {
        this.channel.postMessage({
            type: MSG.CMD_PANE,
            target: this.paneIndex,
            method,
            args,
        });
    }

    /** Post a world-command envelope (called from the orchestrator). */
    forwardWorld(method, args) {
        this.channel.postMessage({
            type: MSG.CMD_WORLD,
            method,
            args,
        });
    }

    // ── Per-pane interface — must match DomRenderer's per-pane methods ────

    updateCamera(player) {
        // Camera reads many fields off the player. Strip to plain transform.
        const transform = {
            x: player.x, y: player.y, z: player.z,
            angle: player.angle, floorHeight: player.floorHeight ?? 0,
            isFiring: player.isFiring,
        };
        this._post('updateCamera', [transform]);
    }

    updateHud(player) {
        // Strip HUD-relevant fields. structured clone through postMessage
        // preserves Set, so we send ownedWeapons as a Set so the receiver's
        // updateHud can call .has() on it (Array would throw).
        const hudData = {
            currentWeapon: player.currentWeapon,
            ammo: { ...player.ammo },
            maxAmmo: { ...player.maxAmmo },
            health: player.health,
            armor: player.armor,
            ownedWeapons: new Set(player.ownedWeapons),
            score: player.score,
        };
        this._post('updateHud', [hudData]);
    }

    updateCulling(player, worldThings, spectatorActive) {
        // Culling needs live world thing positions. For MVP we serialize the
        // positions that actually move; static spawn positions live in the
        // secondary's local state.things-equivalent. Punt to next pass —
        // for now, send a marker the secondary translates locally.
        this._post('updateCulling', [{ playerX: player.x, playerY: player.y, angle: player.angle }, spectatorActive]);
    }

    triggerFlash(type) { this._post('triggerFlash', [type]); }
    showPowerup(name) { this._post('showPowerup', [name]); }
    flickerPowerup(name) { this._post('flickerPowerup', [name]); }
    hidePowerup(name) { this._post('hidePowerup', [name]); }

    switchWeapon(weaponName, fireRate) { this._post('switchWeapon', [weaponName, fireRate]); }
    startFiring() { this._post('startFiring', []); }
    stopFiring() { this._post('stopFiring', []); }

    setPlayerDead(...args) { this._post('setPlayerDead', args); }
    setPlayerMoving(isMoving) { this._post('setPlayerMoving', [isMoving]); }
    clearKeys() { this._post('clearKeys', []); }
    collectKey(...args) { this._post('collectKey', args); }
}
