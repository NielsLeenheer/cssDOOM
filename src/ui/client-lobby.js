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
 * button. Master broadcasts a `LOBBY_STATE` envelope on every
 * lobby-relevant change, and this module reflects it onto the client's
 * DOM via the pane's `data-claim-state` attribute. (`body[data-game-state]`
 * is mirrored separately by the GAME_STATE envelope — see index.js's
 * initClient onGameState handler.) The same CSS that drives master's
 * split-screen lobby prompts (`.join-prompt` / `.join-ready`) then
 * renders correctly.
 *
 * `setClientSlot` is called from `initClient`'s onAck once master has
 * assigned a slot. Until then, any incoming `LOBBY_STATE` is buffered
 * and replayed when the slot becomes known — necessary because onAck
 * has an `await loadMap` and `LOBBY_STATE` may arrive in the meantime.
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

    // body[data-game-state] is mirrored by the GAME_STATE envelope (see
    // index.js initClient's onGameState handler). This module only
    // updates the per-pane data-claim-state attribute.

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
