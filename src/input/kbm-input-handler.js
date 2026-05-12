/**
 * Keyboard + mouse input handler factory.
 *
 * The heart of [keyboard.js](keyboard.js), [mouse.js](mouse.js), and
 * [remote-master.js](remote-master.js) — they all need the same
 * key→action mapping (movement keys → analog input, fire/use/weapon
 * select, isMatchEnded restart, dead-respawn cooldown), differing only
 * in *which slot* the input drives.
 *
 * Each call returns a fresh handler instance with its own `keys` shadow
 * state and accumulated mouseTurnDelta. Three instances exist at
 * runtime:
 *
 *   - Local kbm — slot resolved from the active virtual kbm device
 *     (keyboard.js owns this; mouse.js shares the same instance).
 *   - Remote kbm — slot 1, fed from a secondary window's forwarded
 *     events (remote-master.js).
 *   - (future, multi-remote) one per remote.
 *
 * The factory does NOT handle:
 *   - Escape / menu toggle (master-window concern)
 *   - Tab debug swap (kbm-specific affordance, dev-only)
 *   - press-to-claim on first key/click (caller decides whether/when)
 *   - event.repeat suppression (no concept for forwarded remote events)
 *
 * Those wrappers stay in keyboard.js / mouse.js / remote-master.js.
 */

import { state } from '../game/state.js';
import { currentMap, loadMap } from '../shared/maps.js';
import { WEAPONS } from '../game/constants.js';
import { tryOpenDoor } from '../game/mechanics/doors.js';
import { tryUseSwitch } from '../game/mechanics/switches.js';
import { tryUseLift } from '../game/mechanics/lifts.js';
import { fireWeapon, equipWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { spawnPlayer } from '../game/player/spawn.js';
import { isMatchEnded, restartMatch } from '../game/match.js';
import { isIntermissionActive, dismissIntermission } from '../ui/intermission.js';
import { isMenuOpen } from '../ui/menu.js';

const DM_RESPAWN_COOLDOWN_MS = 2000;
const SP_RESTART_COOLDOWN_MS = 4000;

// Same value as the local mouse module used previously, kept in sync so
// remote and local mouse-look feel identical when both are in play.
export const MOUSE_SENSITIVITY = 0.003;

/**
 * Create a kbm input pipeline bound to one slot.
 *
 * @param {() => number|null} getSlot   Returns the slot the handler currently
 *                                       drives, or null if unbound.
 * @param {Array} inputs                 The shared `inputs[]` array — used
 *                                       to set/clear `fireHeld`.
 *
 * @returns {{
 *   getInput: () => object,         // For registerInputProvider
 *   handleKeyDown: (code: string) => boolean,   // Returns true if handled
 *   handleKeyUp: (code: string) => void,
 *   handleMouseDown: (button: number) => boolean,
 *   handleMouseUp: (button: number) => void,
 *   addMouseTurn: (dx: number) => void,
 *   resetKeys: () => void,
 *   clearFireHeld: () => void,
 * }}
 */
export function createKbmInputHandler({ getSlot, inputs }) {
    const keys = {
        up: false, down: false, left: false, right: false,
        strafeLeft: false, strafeRight: false, run: false, strafe: false,
    };
    let mouseTurnDelta = 0;

    function currentPlayer() {
        const slot = getSlot();
        return slot != null ? state.players[slot] : null;
    }

    function getInput() {
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
    }

    /**
     * Pre-action gates — match-end restart, dead-respawn cooldown.
     * Returns true if the gate consumed the input (caller should stop).
     */
    function applyGates(player, code) {
        if (isMenuOpen()) return true;

        if (isIntermissionActive()) {
            if (code === 'AltLeft' || code === 'AltRight' || code === 'KeyX' || code === 'Space') {
                dismissIntermission();
            }
            return true;
        }

        if (isMatchEnded()) {
            if (code === 'AltLeft' || code === 'AltRight' || code === 'KeyX' || code === 'Space') {
                restartMatch();
            }
            return true;
        }

        if (player?.isDead) {
            const cooldown = state.mode === 'deathmatch'
                ? DM_RESPAWN_COOLDOWN_MS
                : SP_RESTART_COOLDOWN_MS;
            if (performance.now() - player.deathTime > cooldown) {
                if (state.mode === 'deathmatch') {
                    spawnPlayer(player);
                } else {
                    loadMap(currentMap);
                }
            }
            return true;
        }

        return false;
    }

    function handleKeyDown(code) {
        const player = currentPlayer();
        if (applyGates(player, code)) return false;

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
            case 'AltLeft': case 'AltRight': case 'KeyX': {
                const slot = getSlot();
                if (slot != null) inputs[slot].fireHeld = true;
                fireWeapon(player);
                break;
            }
            case 'Digit1': case 'Digit2': case 'Digit3':
            case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': {
                const ws = parseInt(code[5]);
                if (WEAPONS[ws]) equipWeapon(player, ws);
                break;
            }
            default: return false;
        }
        return true;
    }

    function handleKeyUp(code) {
        const player = currentPlayer();
        switch (code) {
            case 'ArrowUp': case 'KeyW': keys.up = false; break;
            case 'ArrowDown': case 'KeyS': keys.down = false; break;
            case 'ArrowLeft': keys.left = false; break;
            case 'ArrowRight': keys.right = false; break;
            case 'KeyA': case 'Comma': keys.strafeLeft = false; break;
            case 'KeyD': case 'Period': keys.strafeRight = false; break;
            case 'ShiftLeft': case 'ShiftRight': keys.run = false; break;
            case 'KeyZ': keys.strafe = false; break;
            case 'AltLeft': case 'AltRight': case 'KeyX': {
                const slot = getSlot();
                if (slot != null) inputs[slot].fireHeld = false;
                if (player) stopAutoFire(player);
                break;
            }
            // Meta release: clear movement to avoid stuck keys on macOS,
            // where keyup is suppressed while Meta is held.
            case 'MetaLeft': case 'MetaRight':
                keys.up = keys.down = keys.left = keys.right = false;
                keys.strafeLeft = keys.strafeRight = false;
                break;
        }
    }

    function handleMouseDown(button) {
        if (button !== 0) return false;
        const player = currentPlayer();

        if (isIntermissionActive()) { dismissIntermission(); return true; }
        if (isMatchEnded()) { restartMatch(); return true; }

        if (player?.isDead) {
            if (state.mode === 'deathmatch'
                && performance.now() - player.deathTime > DM_RESPAWN_COOLDOWN_MS) {
                spawnPlayer(player);
            }
            return true;
        }

        const slot = getSlot();
        if (slot == null || !player) return false;
        inputs[slot].fireHeld = true;
        fireWeapon(player);
        return true;
    }

    function handleMouseUp(button) {
        if (button !== 0) return;
        const slot = getSlot();
        if (slot != null) inputs[slot].fireHeld = false;
        const player = currentPlayer();
        if (player) stopAutoFire(player);
    }

    function addMouseTurn(dx) {
        mouseTurnDelta -= dx * MOUSE_SENSITIVITY;
    }

    function resetKeys() {
        keys.up = keys.down = keys.left = keys.right = false;
        keys.strafeLeft = keys.strafeRight = keys.run = keys.strafe = false;
    }

    function clearFireHeld() {
        const slot = getSlot();
        if (slot != null && inputs[slot]) inputs[slot].fireHeld = false;
    }

    return {
        getInput,
        handleKeyDown, handleKeyUp,
        handleMouseDown, handleMouseUp,
        addMouseTurn, resetKeys, clearFireHeld,
    };
}
