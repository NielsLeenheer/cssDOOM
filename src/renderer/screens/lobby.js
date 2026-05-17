/**
 * Lobby controller — owns the press-to-claim UX for Local DM.
 *
 * Responsibilities:
 *   - Drives per-pane `[data-claim-state]` attributes so each pane's
 *     join prompt knows whether its slot is prompting / ready / waiting /
 *     active. (Lobby vs. active mode itself is driven by
 *     `body[data-game-state="lobby"]`, written by the legacy
 *     game-state.js machine when `resetMatch()` runs.)
 *
 * Repaint trigger: Game and master.js push `showLobby` through the
 * orchestrator on every claim change (and on lobby entry / exit). The
 * orchestrator pulls the current payload from Game (the registered
 * payload provider) so what lands on every renderer matches Game's
 * truth at dispatch time. The renderer-command impl below is the
 * sole driver; the legacy direct `onClaimChange(updateLobbyUI)`
 * subscription is gone. Auto-start is owned by Game._checkAutoStart
 * (same READY_FLASH delay as before).
 *
 * Network DM lobby UI lives in src/renderer/screens/network-lobby.js — a 4-slot
 * list rather than per-pane prompts. Both modules register impls on
 * the same showLobby command and each gates on state.networkMode
 * internally so only one paints per call.
 */

import { state } from '../../game/state.js';
import { orchestrator } from '../../orchestrator.js';
import { isSlotClaimedLocally } from '../../input/claim-registry.js';
import { isMatchLobby, onMatch } from '../../game/match.js';
import { registerOverlayImpl } from '../commands.js';

let externalSlotsRef = () => new Set();

// Snapshot of which slots were already claimed at the start of the
// current lobby session (refreshed on match.js's 'reset' event).
// Slots in this set are "carried over" — they shouldn't flash READY
// when the new lobby begins because nobody just pressed a button for
// them. Slots claimed AFTER the session started (i.e., during the
// current lobby) are the "fresh" ones that get the READY overlay.
let carriedOverClaims = new Set();

/** Slots carried over from the previous match — used by master broadcast
 *  to communicate the fresh-vs-carried distinction to clients so they
 *  can suppress their own READY flash on a back-to-back rematch. */
export function getCarriedOverClaims() {
    return carriedOverClaims;
}

/**
 * Wire the externally-claimed-slots getter (so panes whose slot is
 * remotely claimed don't show a join prompt to local users) and the
 * match-reset hook (where carriedOverClaims gets refreshed). The
 * UI repaint itself is driven by Game's renderer-command pushes,
 * not by subscriptions here.
 */
export function initLobby({ getExternallyClaimedSlots }) {
    externalSlotsRef = getExternallyClaimedSlots;
    onMatch('reset', () => {
        // New match: clear any transient held-input from the previous
        // match (a fire key still down from the kill that ended it
        // would otherwise blow through the lobby into the next match)
        // but keep device→slot claims so a player on a given monitor
        // keeps their controller→pane assignment across back-to-back
        // games. The kiosk loop is players standing side-by-side — we
        // do NOT want their assignments to shuffle between matches.
        orchestrator.resetTransientInputs();
        // Snapshot already-claimed slots so they're treated as carried
        // over (no READY flash) in the new lobby session. Any claim
        // added AFTER this point is "fresh" and will flash READY.
        carriedOverClaims = new Set();
        const ext = externalSlotsRef();
        for (let i = 0; i < state.players.length; i++) {
            if (isSlotClaimedLocally(i) || ext.has(i)) carriedOverClaims.add(i);
        }
        // No explicit repaint call: Game.restartMatch (the caller that
        // triggers match-reset) pushes showLobby via orchestrator
        // immediately after, which fires updateLobbyUI through the
        // renderer-command impl below.
    });
}

/**
 * Update per-pane DOM attributes from current claim/match state.
 * Called by the renderer-command impl in response to Game's
 * showLobby / updateLobbyState pushes.
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
function updateLobbyUI() {
    // Network DM has its own lobby UI in src/renderer/screens/network-lobby.js.
    if (state.networkMode === 'host') return;

    const inLobby = isMatchLobby();
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
            // Fresh claim (made this lobby session) gets the READY flash;
            // a claim that carried over from before match-reset behaves
            // like 'active' — no overlay, just normal scene.
            claimState = carriedOverClaims.has(slot) ? 'active' : 'ready';
        } else if (slot === promptingSlot) {
            claimState = 'prompting';
        } else {
            claimState = 'waiting';
        }
        paneEl.dataset.claimState = claimState;
    }
}

// ── Renderer-command entry points ──────────────────────────────────────
// Game / master.js push showLobby / hideLobby through the orchestrator
// (see src/renderer/commands.js). The impls below are the per-window
// render-only handlers — they re-derive from current globals
// (state.players, claim-registry, isMatchLobby) rather than reading the
// payload. Future work could move re-derivation off globals and onto
// the payload so the carriedOverClaims state can also migrate into
// Game; today the carriedOverClaims tracking still lives in the
// onMatch('reset') handler above.

/** Renderer-command impl for showLobby.
 *  Master-only — derives data-claim-state from local claim-registry,
 *  which doesn't exist on a client. Local DM secondaries get their
 *  data-claim-state from client-lobby.js's impl (payload-driven);
 *  Network DM clients use network-lobby.js's impl. */
function renderLobbyState(_payload) {
    if (document.body.classList.contains('client-window')) return;
    updateLobbyUI();
}

/** Renderer-command impl for hideLobby. CSS hides the lobby overlay
 *  when body[data-game-state] flips off LOBBY; no explicit per-pane
 *  teardown is needed today. */
function clearLobby() {
    // No-op; CSS handles dismissal.
}

registerOverlayImpl('showLobby', renderLobbyState);
registerOverlayImpl('hideLobby', clearLobby);
