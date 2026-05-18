/**
 * Lobby controller — owns the press-to-claim UX for Local DM.
 *
 * Responsibilities:
 *   - Drives per-pane `[data-claim-state]` attributes (master side)
 *     so each pane's join prompt knows whether its slot is prompting
 *     / ready / waiting / active. Lobby vs. active mode itself is
 *     driven by `body[data-game-state="lobby"]`, written by the
 *     setGameState window-command impl.
 *   - Owns the match-reset hook that snapshots already-claimed
 *     slots into `carriedOverClaims` so back-to-back matches don't
 *     re-flash READY on claims a player kept across the reset.
 *
 * Repaint trigger: Game and master.js push `showLobby` through the
 * orchestrator on every claim change (and on lobby entry / exit).
 * The orchestrator pulls the current payload from Game (the
 * registered payload provider) so what lands on every renderer
 * matches Game's truth at dispatch time. This impl reads the payload
 * only — no claim-registry / state.players / isMatchLobby
 * re-derivation. Auto-start is owned by Game._checkAutoStart.
 *
 * Network DM lobby UI lives in src/renderer/screens/network-lobby.js —
 * a 4-slot list rather than per-pane prompts. Both modules register
 * impls on the same showLobby command; this one early-returns when
 * payload.variant !== 'local'. Local DM secondaries (detached
 * windows) get their data-claim-state from client-lobby.js's impl
 * — this module's first gate (.client-window) keeps them out.
 */

import { state } from '../../game/state.js';
import { orchestrator } from '../../orchestrator.js';
import { isSlotClaimedLocally } from '../../input/claim-registry.js';
import { onMatch } from '../../game/match.js';
import { setCarriedOverClaims } from '../../game/lobby-state.js';
import { registerOverlayImpl } from '../commands.js';

let externalSlotsRef = () => new Set();

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
        const carried = new Set();
        const ext = externalSlotsRef();
        for (let i = 0; i < state.players.length; i++) {
            if (isSlotClaimedLocally(i) || ext.has(i)) carried.add(i);
        }
        setCarriedOverClaims(carried);
        // No explicit repaint call: Game.restartMatch (the caller that
        // triggers match-reset) pushes showLobby via orchestrator
        // immediately after, which fires updateLobbyUI through the
        // renderer-command impl below.
    });
}

// ── Renderer-command entry points ──────────────────────────────────────
// Game / master.js push showLobby / hideLobby through the orchestrator
// (see src/renderer/commands.js). The impl below is the master-side
// handler for the Local DM variant. It reads the payload only; all
// per-slot state (claim status, carry-over flags, the prompting slot)
// is pre-derived by Game.getLobbyPayload().

/** Renderer-command impl for showLobby.
 *  Master-only, Local-DM variant — Local DM secondaries get their
 *  data-claim-state from client-lobby.js's impl; Network DM uses
 *  network-lobby.js's impl. Each pane on this window gets its slot's
 *  claim state written.
 *
 *  Per-pane `data-claim-state` is one of:
 *    "prompting" — this pane's slot is the next to claim. Shows
 *                   PRESS BUTTON TO JOIN. Only one pane has this
 *                   state at a time (sequential join, left → right).
 *    "ready"     — this pane's slot is claimed but match hasn't
 *                   started. Shows READY overlay.
 *    "waiting"   — pane is later in the sequence than the currently-
 *                   prompting one. Dimmed; no overlay.
 *    "active"    — match has started; no overlay, normal gameplay.
 */
function renderLobbyState(payload) {
    if (document.body.classList.contains('client-window')) return;
    if (payload?.variant !== 'local') return;

    for (const paneEl of document.querySelectorAll('.pane')) {
        const slot = parseInt(paneEl.dataset.player ?? '-1', 10);
        if (!Number.isFinite(slot) || slot < 0) continue;

        let claimState;
        if (!payload.inLobby) {
            claimState = 'active';
        } else if (payload.slotsClaimed[slot]) {
            // Fresh claim (made this lobby session) gets the READY flash;
            // a claim that carried over from before match-reset behaves
            // like 'active' — no overlay, just normal scene.
            claimState = payload.slotsCarriedOver[slot] ? 'active' : 'ready';
        } else if (slot === payload.promptingSlot) {
            claimState = 'prompting';
        } else {
            claimState = 'waiting';
        }
        paneEl.dataset.claimState = claimState;
    }
}

/** Renderer-command impl for hideLobby. CSS hides the lobby overlay
 *  when body[data-game-state] flips off LOBBY; no explicit per-pane
 *  teardown is needed today. */
function clearLobby() {
    // No-op; CSS handles dismissal.
}

registerOverlayImpl('showLobby', renderLobbyState);
registerOverlayImpl('hideLobby', clearLobby);
