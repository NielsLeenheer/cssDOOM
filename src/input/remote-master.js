/**
 * Master-side receiver for remote input forwarded from a secondary window.
 *
 * Mirrors the structure of keyboard.js + mouse.js but always routes to
 * player 1 (the secondary's player). Tracks key state from incoming
 * keydown/keyup events, accumulates mouse turn delta from forwarded
 * mousemove, and triggers discrete game actions (fire, use, weapon
 * switch, respawn) as keys arrive.
 *
 * Why a parallel implementation rather than dispatching synthetic events
 * into keyboard.js: keyboard.js routes by its active kbm virtual device,
 * which is global to the local kbm pair. Forcing remote events to a
 * different slot would race against any local kbm interaction. A
 * dedicated handler hardcoded to player 1 is cleaner and stays tidy when
 * keyboard.js evolves. Architecture cleanup #6 will collapse this back
 * once the input layer separates collection from action dispatch.
 *
 * The master may have BOTH local input on player 0 (keyboard or gamepad)
 * AND remote input on player 1 simultaneously — they coexist via separate
 * input slots and providers.
 */

import { state } from '../game/state.js';
import { inputs, registerInputProvider } from './index.js';
import { fireWeapon, equipWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { tryOpenDoor } from '../game/mechanics/doors.js';
import { tryUseSwitch } from '../game/mechanics/switches.js';
import { tryUseLift } from '../game/mechanics/lifts.js';
import { spawnPlayer } from '../game/player/spawn.js';
import { isMatchEnded, restartMatch } from '../game/match.js';
import { WEAPONS } from '../game/constants.js';
import { isMenuOpen } from '../ui/menu.js';
import { pingActivity } from '../ui/attract.js';

const SECONDARY_PLAYER = 1;
const DM_RESPAWN_COOLDOWN_MS = 2000;
// Same as mouse.js's MOUSE_SENSITIVITY so remote and local mouse-look feel
// identical when both are in play.
const MOUSE_SENSITIVITY = 0.003;

const keys = {
    up: false, down: false, left: false, right: false,
    strafeLeft: false, strafeRight: false, run: false, strafe: false,
};
let mouseTurnDelta = 0;

function remotePlayer() {
    return state.players[SECONDARY_PLAYER];
}

/**
 * Register the input provider for player 1. Called once during master
 * init regardless of whether a secondary is connected — the provider
 * just contributes zeros until events arrive.
 */
export function initRemoteInputReceiver() {
    registerInputProvider(() => SECONDARY_PLAYER, () => {
        let moveX = 0, moveY = 0, turn = 0;

        if (keys.up) moveY += 1;
        if (keys.down) moveY -= 1;

        if (keys.strafeLeft || (keys.strafe && keys.left)) moveX -= 1;
        if (keys.strafeRight || (keys.strafe && keys.right)) moveX += 1;

        if (keys.left && !keys.strafe) turn += 1;
        if (keys.right && !keys.strafe) turn -= 1;

        const turnDelta = mouseTurnDelta;
        mouseTurnDelta = 0;

        return { moveX, moveY, turn, turnDelta, run: keys.run };
    });
}

/** Called by BroadcastConnection when an INPUT envelope arrives. */
export function applyRemoteInput(msg) {
    pingActivity();
    switch (msg.kind) {
        case 'keydown': handleKeyDown(msg.code); break;
        case 'keyup': handleKeyUp(msg.code); break;
        case 'mousedown': handleMouseDown(msg.button); break;
        case 'mouseup': handleMouseUp(msg.button); break;
        case 'mousemove':
            // Negate to match the local mouse.js convention: rightward
            // mouse movement turns the player right (negative angle delta).
            mouseTurnDelta -= (msg.dx || 0) * MOUSE_SENSITIVITY;
            break;
        case 'blur':
            keys.up = keys.down = keys.left = keys.right = false;
            keys.strafeLeft = keys.strafeRight = keys.run = keys.strafe = false;
            break;
    }
}

function handleKeyDown(code) {
    if (isMenuOpen()) return;
    const player = remotePlayer();

    if (isMatchEnded()) {
        if (code === 'AltLeft' || code === 'AltRight' || code === 'KeyX' || code === 'Space') {
            restartMatch();
        }
        return;
    }

    if (player?.isDead) {
        if (state.mode === 'deathmatch'
            && performance.now() - player.deathTime > DM_RESPAWN_COOLDOWN_MS) {
            spawnPlayer(player);
        }
        return;
    }

    switch (code) {
        case 'ArrowUp': case 'KeyW': keys.up = true; break;
        case 'ArrowDown': case 'KeyS': keys.down = true; break;
        case 'ArrowLeft': keys.left = true; break;
        case 'ArrowRight': keys.right = true; break;
        case 'KeyA': case 'Comma': keys.strafeLeft = true; break;
        case 'KeyD': case 'Period': keys.strafeRight = true; break;
        case 'ShiftLeft': case 'ShiftRight': keys.run = true; break;
        case 'KeyZ': keys.strafe = true; break;
        case 'Space':
            tryOpenDoor(player);
            tryUseSwitch(player);
            tryUseLift(player);
            break;
        case 'AltLeft': case 'AltRight': case 'KeyX':
            inputs[SECONDARY_PLAYER].fireHeld = true;
            fireWeapon(player);
            break;
        case 'Digit1': case 'Digit2': case 'Digit3':
        case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': {
            const slot = parseInt(code[5]);
            if (WEAPONS[slot]) equipWeapon(player, slot);
            break;
        }
    }
}

function handleKeyUp(code) {
    const player = remotePlayer();
    switch (code) {
        case 'ArrowUp': case 'KeyW': keys.up = false; break;
        case 'ArrowDown': case 'KeyS': keys.down = false; break;
        case 'ArrowLeft': keys.left = false; break;
        case 'ArrowRight': keys.right = false; break;
        case 'KeyA': case 'Comma': keys.strafeLeft = false; break;
        case 'KeyD': case 'Period': keys.strafeRight = false; break;
        case 'ShiftLeft': case 'ShiftRight': keys.run = false; break;
        case 'KeyZ': keys.strafe = false; break;
        case 'AltLeft': case 'AltRight': case 'KeyX':
            inputs[SECONDARY_PLAYER].fireHeld = false;
            if (player) stopAutoFire(player);
            break;
    }
}

function handleMouseDown(button) {
    if (button !== 0) return;
    const player = remotePlayer();

    if (isMatchEnded()) { restartMatch(); return; }

    if (player?.isDead) {
        if (state.mode === 'deathmatch'
            && performance.now() - player.deathTime > DM_RESPAWN_COOLDOWN_MS) {
            spawnPlayer(player);
        }
        return;
    }

    inputs[SECONDARY_PLAYER].fireHeld = true;
    fireWeapon(player);
}

function handleMouseUp(button) {
    if (button !== 0) return;
    inputs[SECONDARY_PLAYER].fireHeld = false;
    const player = remotePlayer();
    if (player) stopAutoFire(player);
}
