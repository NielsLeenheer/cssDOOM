/**
 * Lobby controller — owns the press-to-claim UX for Local DM.
 *
 * Responsibilities:
 *   - Drives per-pane `[data-claim-state]` attributes so each pane's
 *     join prompt knows whether its slot is prompting / ready / waiting /
 *     active. (Lobby vs. active mode itself is driven by
 *     `body[data-game-state="lobby"]`, set by the game-state machine
 *     when `resetMatch()` runs.)
 *   - Auto-starts the match when all expected slots are claimed.
 *
 * Listens to:
 *   - `onClaimChange` from input/claim-registry — fires when a device
 *     claims or releases a slot, or when external (remote) slot
 *     occupancy changes via setExternallyClaimedSlots.
 *   - `cssdoom:match-reset` — dispatched by maps.js / menu.js when a
 *     fresh match begins so we can re-enter lobby state.
 *
 * Network DM (future) will use the same claim mechanism but a different
 * match-start trigger (host button instead of all-claimed). The lobby
 * UI logic here is mostly mode-agnostic; only enterLobby's set-up and
 * checkAutoStart's "auto-start" decision need a mode branch.
 */

import { state } from '../game/state.js';
import { orchestrator } from '../orchestrator.js';
import { onClaimChange, isSlotClaimedLocally } from '../input/claim-registry.js';
import { startMatch, isMatchLobby, resetMatch } from '../game/match.js';
import { registerOverlayImpl } from '../renderer/commands.js';

let externalSlotsRef = () => new Set();

// Snapshot of which slots were already claimed at the start of the
// current lobby session (set on cssdoom:match-reset). Slots in this set
// are "carried over" — they shouldn't flash READY when the new lobby
// begins, because nobody just pressed a button for them. Slots claimed
// AFTER the session started (i.e., during the current lobby) are the
// "fresh" ones that get the READY overlay.
let carriedOverClaims = new Set();

/** Slots carried over from the previous match — used by index.js to
 *  broadcast the same fresh-vs-carried distinction to clients so
 *  it suppresses its own READY flash on a back-to-back rematch. */
export function getCarriedOverClaims() {
    return carriedOverClaims;
}

/**
 * Wire up listeners. Pass a getter that returns the set of slots
 * currently occupied by remote sinks — needed so panes whose slot is
 * remotely claimed don't show a join prompt to local users.
 */
export function initLobby({ getExternallyClaimedSlots }) {
    externalSlotsRef = getExternallyClaimedSlots;
    onClaimChange(updateLobbyUI);
    window.addEventListener('cssdoom:match-reset', () => {
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
    // Network DM has its own lobby UI in src/ui/network-lobby.js — a
    // 4-slot list instead of per-pane PRESS FIRE TO JOIN prompts. Skip
    // the per-pane attribute work entirely; the local-DM-flavoured
    // overlay is hidden in network mode by CSS anyway.
    if (state.networkMode === 'host') return;

    const inLobby = isMatchLobby();
    // body[data-game-state] is owned by game-state's transitionTo — we
    // don't write it here. updateLobbyUI fires on every claim change,
    // after match transitions are already settled.

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

    // Auto-start trigger for Local DM: when all slots in the player
    // roster are claimed, formally start the match.
    if (inLobby) checkAutoStart();
}

// How long to keep showing the "PLAYER N READY" overlays after the last
// player claims before formally starting the match. Gives the last
// player a beat to see their READY appear in their color before the
// world wakes up.
const READY_FLASH_MS = 1000;
let autoStartTimer = null;

function allSlotsClaimedNow() {
    const externalSlots = externalSlotsRef();
    for (let i = 0; i < state.players.length; i++) {
        if (!isSlotClaimedLocally(i) && !externalSlots.has(i)) return false;
    }
    return true;
}

/**
 * Auto-start the match if every player slot has a claim (local or
 * external). Local DM only — Network DM will use a manual host trigger
 * and skip this check (TODO: gate on mode when Network DM is added).
 *
 * The actual `startMatch()` call is deferred by READY_FLASH_MS so the
 * last-to-claim player's "PLAYER N READY" overlay is visible briefly
 * before the world unfreezes. If someone un-claims during the delay,
 * the pending timer is cancelled.
 */
function checkAutoStart() {
    if (!allSlotsClaimedNow()) {
        if (autoStartTimer) {
            clearTimeout(autoStartTimer);
            autoStartTimer = null;
        }
        return;
    }
    if (autoStartTimer) return;  // already pending
    autoStartTimer = setTimeout(() => {
        autoStartTimer = null;
        // Re-verify state at fire time — someone may have un-claimed,
        // or the match could have ended/reset while waiting.
        if (!isMatchLobby() || !allSlotsClaimedNow()) return;
        startMatch();
        updateLobbyUI();
    }, READY_FLASH_MS);
}

/**
 * Enter lobby state — called when DM mode is entered or the previous
 * match ended and we're cycling back to a new one. The match clock,
 * scoring, and frag-tracking are all gated by the game-state machine
 * (`getGameState() === ACTIVE`), which resetMatch() leaves at LOBBY.
 * This function just refreshes the lobby UI.
 */
export function enterLobby() {
    if (state.gameMode !== 'deathmatch') return;
    if (!state.match) resetMatch();
    updateLobbyUI();
}

// ── L2.6 renderer-command entry points ─────────────────────────────────
// Game pushes showLobby / updateLobbyState / hideLobby through the
// orchestrator (see src/renderer/commands.js). The impls below are the
// per-window render-only handlers — they re-derive from current globals
// (state.players, claim-registry, isMatchLobby) rather than reading the
// payload, matching today's updateLobbyUI behavior. The payload
// argument exists for the future cutover (L4) when Game becomes the
// authoritative source of lobby state and re-derivation moves off
// global lookups.
//
// Until L4, the legacy onClaimChange / cssdoom:match-reset subscriptions
// in initLobby() above still drive the same DOM mutations. These new
// entry points fire in addition; both compute the same data-claim-state
// from the same globals, so no DOM conflict.

/** Renderer-command impl for showLobby + updateLobbyState (same body —
 *  the distinction is which Game lifecycle event triggered the push). */
export function renderLobbyState(_payload) {
    updateLobbyUI();
}

/** Renderer-command impl for hideLobby. Today's lobby UI disappears via
 *  CSS when body[data-game-state] flips off LOBBY; explicit per-pane
 *  teardown isn't needed until L4 removes the body-class side effect. */
export function clearLobby() {
    // No-op for now; CSS handles dismissal.
}

// L4.2 — register render-only handlers with the late-binding registry
// on src/renderer/commands.js. Game's orchestrator pushes
// (orchestrator.showLobby etc.) fan out via the registry to whatever's
// registered. network-lobby.js registers parallel handlers; each gates
// on state.networkMode internally so only one paints per call.
registerOverlayImpl('showLobby',        renderLobbyState);
registerOverlayImpl('updateLobbyState', renderLobbyState);
registerOverlayImpl('hideLobby',        clearLobby);
