/**
 * Lobby controller — owns the press-to-claim UX for Local DM.
 *
 * Responsibilities:
 *   - Drives the `body[data-match-lobby]` attribute (CSS keys off this
 *     to show join prompts and hide HUD numbers in lobby state).
 *   - Drives per-pane `[data-claimed]` attributes so each pane's join
 *     prompt knows whether its slot has an input bound to it.
 *   - Auto-starts the match when all expected slots are claimed.
 *
 * Listens to:
 *   - `onClaimChange` from input/index.js — fires when a device claims
 *     or releases a slot, or when external (remote) slot occupancy
 *     changes via setExternallyClaimedSlots.
 *   - `cssdoom:match-reset` — dispatched by maps.js / menu.js when a
 *     fresh match begins so we can re-enter lobby state.
 *
 * Network DM (future) will use the same claim mechanism but a different
 * match-start trigger (host button instead of all-claimed). The lobby
 * UI logic here is mostly mode-agnostic; only enterLobby's set-up and
 * checkAutoStart's "auto-start" decision need a mode branch.
 */

import { state } from '../game/state.js';
import { onClaimChange, isSlotClaimedLocally, clearAllClaims } from '../input/index.js';
import { startMatch, isMatchLobby, resetMatch } from '../game/match.js';

let externalSlotsRef = () => new Set();

/**
 * Wire up listeners. Pass a getter that returns the set of slots
 * currently occupied by remote sinks — needed so panes whose slot is
 * remotely claimed don't show a join prompt to local users.
 */
export function initLobby({ getExternallyClaimedSlots }) {
    externalSlotsRef = getExternallyClaimedSlots;
    onClaimChange(updateLobbyUI);
    window.addEventListener('cssdoom:match-reset', () => {
        // New match → drop all claims so each player has to press fire
        // to join again, even if it's a back-to-back rematch with the
        // same controllers. Matches the installation flow where new
        // players might be standing at the kiosk.
        clearAllClaims();
        updateLobbyUI();
    });
}

/**
 * Update body and pane DOM attributes from current claim/match state.
 * Called whenever something might affect lobby UI (claims, match-reset,
 * external slot occupancy changes).
 *
 * Per-pane `data-claim-state` is one of:
 *   "prompting" — this pane's slot is the next to claim. Shows PRESS
 *                  BUTTON TO JOIN. Only one pane has this state at a
 *                  time (sequential join, left → right).
 *   "ready"     — this pane's slot is claimed but match hasn't started.
 *                  Shows READY overlay; bound player can warm up.
 *   "waiting"   — pane is later in the sequence than the currently-
 *                  prompting one. Dimmed; no overlay.
 *   "active"    — match has started; no overlay, normal gameplay.
 *
 * The "next to claim" rule is: a pane is prompting iff its slot is
 * unclaimed AND every lower-numbered slot is already claimed.
 */
export function updateLobbyUI() {
    const inLobby = isMatchLobby();
    if (inLobby) {
        document.body.dataset.matchLobby = 'true';
    } else {
        delete document.body.dataset.matchLobby;
    }

    const externalSlots = externalSlotsRef();
    const isClaimed = (slot) => isSlotClaimedLocally(slot) || externalSlots.has(slot);

    // Find the lowest unclaimed slot — that's the one currently prompting.
    // Slots below it are 'ready' (claimed); slots above are 'waiting'.
    let promptingSlot = -1;
    for (let i = 0; i < state.players.length; i++) {
        if (!isClaimed(i)) { promptingSlot = i; break; }
    }

    for (const paneEl of document.querySelectorAll('.pane')) {
        const slot = parseInt(paneEl.dataset.player ?? '-1', 10);
        if (!Number.isFinite(slot) || slot < 0) continue;

        let claimState;
        if (!inLobby) {
            claimState = 'active';
        } else if (isClaimed(slot)) {
            claimState = 'ready';
        } else if (slot === promptingSlot) {
            claimState = 'prompting';
        } else {
            claimState = 'waiting';
        }
        paneEl.dataset.claimState = claimState;
    }

    // Auto-start trigger for Local DM: when all slots in the player
    // roster are claimed, formally start the match.
    if (inLobby) checkAutoStart();
}

/**
 * Auto-start the match if every player slot has a claim (local or
 * external). Local DM only — Network DM will use a manual host trigger
 * and skip this check (TODO: gate on mode when Network DM is added).
 */
function checkAutoStart() {
    const externalSlots = externalSlotsRef();
    for (let i = 0; i < state.players.length; i++) {
        if (!isSlotClaimedLocally(i) && !externalSlots.has(i)) return;
    }
    startMatch();
    updateLobbyUI();
}

/**
 * Enter lobby state — called when DM mode is entered or the previous
 * match ended and we're cycling back to a new one. The match clock,
 * scoring, and frag-tracking are all gated by `state.match.started`,
 * which resetMatch() leaves false. This function just refreshes the UI.
 */
export function enterLobby() {
    if (state.mode !== 'deathmatch') return;
    if (!state.match) resetMatch();
    updateLobbyUI();
}
