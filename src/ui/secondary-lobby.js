/**
 * Secondary-window lobby state mirror.
 *
 * In the master+secondary host layout (Local DM today, Network DM later)
 * the secondary window is **display-only** — it renders the slot held by
 * the host's second local player but contributes no input. The press-to-
 * claim ceremony happens entirely on master.
 *
 * The secondary still needs to *show* the lobby prompt for that slot, so
 * the player sitting at the secondary's screen knows when to press their
 * button on master. Master broadcasts a `LOBBY_STATE` envelope on every
 * lobby-relevant change, and this module reflects it onto the secondary's
 * DOM via `body[data-match-lobby]` + the secondary pane's `data-claim-
 * state` attribute. The same CSS that drives master's split-screen
 * lobby prompts (`.join-prompt` / `.join-ready`) then renders correctly.
 *
 * `setSecondarySlot` is called from `initSecondary`'s onAck once master
 * has assigned a slot. Until then, any incoming `LOBBY_STATE` is buffered
 * and replayed when the slot becomes known — necessary because onAck has
 * an `await loadMap` and `LOBBY_STATE` may arrive in the meantime.
 */

let mySlot = null;
let pendingLobbyState = null;

/**
 * Tell this module which slot the secondary represents. Called from
 * initSecondary after master's ACK assigns us a slot.
 */
export function setSecondarySlot(slot) {
    mySlot = slot;
    if (pendingLobbyState) {
        const buffered = pendingLobbyState;
        pendingLobbyState = null;
        applyLobbyState(buffered);
    }
}

/**
 * Apply an incoming `LOBBY_STATE` from master. Sets body + pane attributes
 * so the existing lobby CSS does the right thing on the secondary window.
 *
 * @param {{ inLobby: boolean, slotsClaimed: boolean[] }} msg
 */
export function applyLobbyState(msg) {
    if (mySlot == null) {
        pendingLobbyState = msg;
        return;
    }

    if (msg.inLobby) {
        document.body.dataset.matchLobby = 'true';
    } else {
        delete document.body.dataset.matchLobby;
    }

    // Same algorithm as lobby.js's updateLobbyUI: lowest unclaimed slot
    // is the one currently 'prompting'; lower-indexed claimed slots are
    // 'ready'; higher-indexed unclaimed slots are 'waiting'; outside the
    // lobby every slot is 'active'.
    let claimState;
    if (!msg.inLobby) {
        claimState = 'active';
    } else if (msg.slotsClaimed[mySlot]) {
        claimState = 'ready';
    } else {
        const promptingSlot = msg.slotsClaimed.findIndex(c => !c);
        claimState = (mySlot === promptingSlot) ? 'prompting' : 'waiting';
    }

    const paneEl = document.querySelector(`.pane[data-player="${mySlot}"]`);
    if (paneEl) {
        paneEl.dataset.claimState = claimState;
        // Mirror master's "PLAYER N READY" overlay text. Player names
        // are one-based in UX; slot indices are zero-based internally.
        const readyEl = paneEl.querySelector('.join-ready');
        if (readyEl) readyEl.textContent = `PLAYER ${mySlot + 1} READY`;
    }
}
