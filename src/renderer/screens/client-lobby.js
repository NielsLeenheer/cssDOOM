/**
 * Client-side lobby state mirror.
 *
 * Runs on any client window (the Local DM secondary today, Network DM
 * remotes later). The client renders the slot it owns but contributes
 * input only when the forwarder is wired (Network DM remotes); the
 * Local DM secondary is display-only and master handles its claim
 * locally.
 *
 * The client still needs to *show* the lobby prompt for its slot, so
 * the player sitting at the client's screen knows when to press their
 * button. Master pushes the lobby state via the `showLobby` renderer
 * command on every lobby-relevant change (master / Game both signal
 * it; the orchestrator pulls the payload from Game), and this module
 * reflects it onto the client's DOM via the pane's `data-claim-state`
 * attribute. `body[data-game-state]` is mirrored separately by the
 * `setGameState` renderer command (impl in game-state.js). The same
 * CSS that drives master's split-screen lobby prompts (`.join-prompt`
 * / `.join-ready`) then renders correctly.
 *
 * `setClientSlot` is called from RemoteGame._onAck once master has
 * assigned a slot. Until then, any incoming lobby state is buffered
 * and replayed when the slot becomes known — necessary because _onAck
 * has an `await loadMap` and the renderer-command lobby push may
 * arrive in the meantime.
 */

let mySlot = null;
let pendingLobbyState = null;

/**
 * Tell this module which slot the client represents. Called from
 * initClient after master's ACK assigns us a slot.
 */
export function setClientSlot(slot) {
    mySlot = slot;
    if (pendingLobbyState) {
        const buffered = pendingLobbyState;
        pendingLobbyState = null;
        applyLobbyState(buffered);
    }
}

/**
 * Apply an incoming `LOBBY_STATE` from master. Sets the pane's
 * data-claim-state attribute so the existing lobby CSS does the right
 * thing on the client window.
 *
 * @param {{ inLobby: boolean, slotsClaimed: boolean[] }} msg
 */
export function applyLobbyState(msg) {
    if (mySlot == null) {
        pendingLobbyState = msg;
        return;
    }

    // body[data-game-state] is mirrored by the setGameState renderer
    // command (impl in game-state.js). This module only updates the
    // per-pane data-claim-state attribute.

    // Same algorithm as lobby.js's updateLobbyUI: lowest unclaimed slot
    // is the one currently 'prompting'; freshly-claimed slots get
    // 'ready' (READY flash); slots whose claim carried over from the
    // previous match behave like 'active' (no flash, since nobody just
    // pressed a button for them); higher-indexed unclaimed slots are
    // 'waiting'; outside the lobby every slot is 'active'.
    let claimState;
    if (!msg.inLobby) {
        claimState = 'active';
    } else if (msg.slotsClaimed[mySlot]) {
        claimState = msg.slotsCarriedOver?.[mySlot] ? 'active' : 'ready';
    } else {
        const promptingSlot = msg.slotsClaimed.findIndex(c => !c);
        claimState = (mySlot === promptingSlot) ? 'prompting' : 'waiting';
    }

    const paneEl = document.querySelector(`.pane[data-player="${mySlot}"]`);
    if (paneEl) paneEl.dataset.claimState = claimState;
}

// Register applyLobbyState as a renderer-command impl. Gates on
// .client-window so master's own pane[data-claim-state] (which
// lobby.js's updateLobbyUI derives locally from claim-registry) isn't
// double-written here. Also gates against .network-client because
// Network DM remotes don't use the per-pane press-to-claim overlay —
// network-lobby.js's renderLobbyState handles their slot list instead.
import { registerOverlayImpl } from '../commands.js';
function applyLobbyStatePayload(payload) {
    if (!document.body.classList.contains('client-window')) return;
    if (document.body.classList.contains('network-client')) return;
    if (!payload || !Array.isArray(payload.slotsClaimed)) return;
    applyLobbyState(payload);
}
registerOverlayImpl('showLobby', applyLobbyStatePayload);
