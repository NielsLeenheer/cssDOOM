/**
 * Master-side receiver for remote input forwarded from a secondary window.
 *
 * Hardcoded to player 1 (the secondary's slot). Translates the remote's
 * raw keydown/keyup/mousedown/mouseup/mousemove envelopes into the same
 * action pipeline keyboard.js + mouse.js use locally — they all share
 * [kbm-input-handler.js](kbm-input-handler.js).
 *
 * The master may have BOTH local input on player 0 (keyboard or gamepad)
 * AND remote input on player 1 simultaneously — they coexist via separate
 * kbm-input-handler instances + separate input slots.
 */

import { registerInputProvider } from '../renderer/orchestrator.js';
import { pingActivity } from '../ui/attract.js';
import { createKbmInputHandler } from './kbm-input-handler.js';

const SECONDARY_PLAYER = 1;
const REMOTE_DEVICE_ID = 'remote-1';

const remoteHandler = createKbmInputHandler({
    getSlot: () => SECONDARY_PLAYER,
    getDeviceId: () => REMOTE_DEVICE_ID,
});

/**
 * Register the input provider for player 1. Called once during master
 * init regardless of whether a secondary is connected — the provider
 * just contributes zeros until events arrive.
 */
export function initRemoteInputReceiver() {
    registerInputProvider(() => SECONDARY_PLAYER, remoteHandler.getInput);
}

/** Called by BroadcastConnection when an INPUT envelope arrives. */
export function applyRemoteInput(msg) {
    // Wake from attract on any discrete remote press; first wake-up press
    // doesn't propagate to game actions. Continuous events (mousemove)
    // still ping but never need to be suppressed (no discrete action).
    const isDiscretePress = msg.kind === 'keydown' || msg.kind === 'mousedown';
    if (pingActivity() && isDiscretePress) return;
    switch (msg.kind) {
        case 'keydown': remoteHandler.handleKeyDown(msg.code); break;
        case 'keyup': remoteHandler.handleKeyUp(msg.code); break;
        case 'mousedown': remoteHandler.handleMouseDown(msg.button); break;
        case 'mouseup': remoteHandler.handleMouseUp(msg.button); break;
        case 'mousemove': remoteHandler.addMouseTurn(msg.dx || 0); break;
        case 'blur': remoteHandler.resetKeys(); break;
    }
}
