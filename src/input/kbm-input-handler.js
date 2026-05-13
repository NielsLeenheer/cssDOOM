/**
 * Keyboard + mouse input pipeline.
 *
 * The heart of [keyboard.js](keyboard.js), [mouse.js](mouse.js), and
 * [remote.js](remote.js) — they all need the same
 * key→action mapping and analog movement, differing only in *which
 * slot* the input drives.
 *
 * Each call returns a fresh handler instance with its own `keys`
 * shadow state and accumulated mouseTurnDelta. Three instances exist
 * at runtime:
 *
 *   - Local kbm — slot resolved from the active virtual kbm device
 *     (keyboard.js owns this; mouse.js shares the same instance).
 *   - Remote kbm — slot 1, fed from a client's forwarded
 *     events (remote.js).
 *   - (future, multi-remote) one per remote.
 *
 * The handler emits logical action events on the input event bus
 * (`emit(...)` from `event-bus.js`) — no direct game-function imports
 * here. Subscribers in `src/actions/*` route the events into
 * fire/use/weapon-select. Per-frame analog movement still flows
 * through the `inputs[]` aggregation via the `getInput()` callback the
 * factory returns.
 */

import { WEAPONS } from '../game/constants.js';
import { emit } from './event-bus.js';
import * as A from './actions.js';

// Same value as the local mouse module used previously, kept in sync so
// remote and local mouse-look feel identical when both are in play.
export const MOUSE_SENSITIVITY = 0.003;

/**
 * Create a kbm input pipeline bound to one slot.
 *
 * @param {() => number|null} getSlot      Current slot for this handler.
 * @param {() => string} getDeviceId       The device id reported on each
 *                                          emit. A function (not a constant)
 *                                          because the active virtual kbm
 *                                          can flip at runtime via Tab.
 *
 * @returns {{
 *   getInput: () => object,
 *   handleKeyDown: (code: string) => boolean,
 *   handleKeyUp: (code: string) => void,
 *   handleMouseDown: (button: number) => boolean,
 *   handleMouseUp: (button: number) => void,
 *   addMouseTurn: (dx: number) => void,
 *   resetKeys: () => void,
 *   clearFireHeld: () => void,
 * }}
 */
export function createKbmInputHandler({ getSlot, getDeviceId }) {
    const keys = {
        up: false, down: false, left: false, right: false,
        strafeLeft: false, strafeRight: false, run: false, strafe: false,
    };
    let mouseTurnDelta = 0;

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

    function handleKeyDown(code) {
        const slot = getSlot();
        switch (code) {
            case 'ArrowUp': case 'KeyW': keys.up = true; return true;
            case 'ArrowDown': case 'KeyS': keys.down = true; return true;
            case 'ArrowLeft': keys.left = true; return true;
            case 'ArrowRight': keys.right = true; return true;
            case 'KeyA': case 'Comma': keys.strafeLeft = true; return true;
            case 'KeyD': case 'Period': keys.strafeRight = true; return true;
            case 'ShiftLeft': case 'ShiftRight': keys.run = true; return true;
            case 'KeyZ': keys.strafe = true; return true;
            case 'Space':
                emit({ kind: A.USE, slot, deviceId: getDeviceId() });
                return true;
            case 'AltLeft': case 'AltRight': case 'KeyX':
                emit({ kind: A.FIRE_DOWN, slot, deviceId: getDeviceId() });
                return true;
            case 'Digit1': case 'Digit2': case 'Digit3':
            case 'Digit4': case 'Digit5': case 'Digit6': case 'Digit7': {
                const ws = parseInt(code[5]);
                if (WEAPONS[ws]) emit({ kind: A.WEAPON_SELECT, slot, deviceId: getDeviceId(), weapon: ws });
                return true;
            }
            default: return false;
        }
    }

    function handleKeyUp(code) {
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
                emit({ kind: A.FIRE_UP, slot: getSlot(), deviceId: getDeviceId() });
                break;
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
        emit({ kind: A.FIRE_DOWN, slot: getSlot(), deviceId: getDeviceId() });
        return true;
    }

    function handleMouseUp(button) {
        if (button !== 0) return;
        emit({ kind: A.FIRE_UP, slot: getSlot(), deviceId: getDeviceId() });
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
        if (slot != null) emit({ kind: A.FIRE_UP, slot, deviceId: getDeviceId() });
    }

    return {
        getInput,
        handleKeyDown, handleKeyUp,
        handleMouseDown, handleMouseUp,
        addMouseTurn, resetKeys, clearFireHeld,
    };
}
