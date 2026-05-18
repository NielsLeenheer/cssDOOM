/**
 * Network DM lobby UI.
 *
 * The lobby DOM lives inside the pane template, so every pane (master's
 * panes + each remote's single pane) gets its own copy of the layout.
 * This module keeps the slot-row labels and the room-code text in sync
 * across every copy. The per-pane action prompt ("PRESS FIRE TO START"
 * vs "WAITING FOR GAME TO START") is driven purely by CSS, so we just
 * toggle `body[data-network-ready]` when the player count crosses 2.
 *
 * Each slot row has an `occupant` and a `label`:
 *
 *   occupant: 'empty' | 'host' | 'local' | 'remote'
 *     - empty:  no one's there yet
 *     - host:   master's slot-0 player (kept around for future styling
 *               hooks even though the label is now the same as 'local')
 *     - local:  a local player on master (kiosk's second local at slot 1
 *               post-claim)
 *     - remote: a Network DM remote connected to this slot
 *
 *   label: 'WAITING FOR PLAYER' | 'PRESS BUTTON TO JOIN' | 'PLAYER N READY'
 *     The label is computed from occupant + whether this slot is the
 *     next locally-claimable slot. The lobby module owns this logic;
 *     callers only set the occupant (and optionally override the label
 *     for special cases).
 *
 * The "next locally-claimable" rule:
 *   - lowest slot in [0..MAX_SLOTS-1] that is `empty` AND in the
 *     locally-claimable set. The caller (menu.js) sets the set when
 *     entering network mode: kiosk → [0, 1], non-kiosk → [] (slot 0
 *     auto-claims via setDefaultSlot, so no claim ceremony is ever
 *     shown). When no slots are locally claimable (non-kiosk or all
 *     filled), no row shows PRESS BUTTON TO JOIN.
 */

import qrcode from 'qrcode-generator';
import { state } from '../../game/state.js';
import { isSlotClaimedLocally, onClaimChange, unclaimSlotsNotIn } from '../../input/claim-registry.js';
import {
    ensureNetworkSlotStateInitialized,
    getNetworkSlotState,
    resetNetworkSlotState,
    setNetworkSlotOccupant,
    getLocallyClaimableSlots,
    setLocallyClaimableSlotsState,
    getRoomCode,
    setRoomCodeState,
} from '../../game/lobby-state.js';
import { registerOverlayImpl } from '../commands.js';

const MAX_SLOTS = 4;

let allLobbyRoots = []; // every .pane-network-lobby in the DOM

/** Apply an incoming LOBBY_STATE's slotOccupants array (joiner side).
 *  Mirrors master's slot rows into this window's network-lobby UI. */
export function applyNetworkLobbyState(occupants) {
    if (!Array.isArray(occupants)) return;
    for (let i = 0; i < MAX_SLOTS && i < occupants.length; i++) {
        setNetworkSlotState(i, { occupant: occupants[i] });
    }
}

// Lazy DOM discovery — modules import this before the lobby DOM is
// guaranteed to be in the DOM (pane template clone happens in dom.js
// during init). refreshDom() rescans; called from public APIs and
// from a one-shot DOMContentLoaded if available.
function refreshDom() {
    allLobbyRoots = Array.from(document.querySelectorAll('.pane-network-lobby'));
    ensureNetworkSlotStateInitialized();
}

/**
 * Declare which slots can be claimed by a locally-bound input device.
 * Called by applyMode when entering network mode:
 *   - kiosk: [0, 1] (both local slots use press-to-claim)
 *   - non-kiosk: [] (slot 0 is auto-claimed via setDefaultSlot, no
 *     claim ceremony ever shows; remote-only slots never claim locally)
 *
 * Side effect: re-syncs the lobby UI against the current claim-registry
 * state so any pre-existing claims (e.g. a controller persisted via
 * sessionStorage from a previous Local DM session, applied by the
 * input modules at boot) light up as PLAYER N READY on entry.
 */
export function setLocallyClaimableSlots(slots) {
    setLocallyClaimableSlotsState(slots);
    // Drop any persistent sessionStorage claim bound to a slot
    // outside this set. Without this, a kiosk-DM session that
    // claimed gamepad-1 → slot 1 would leak that binding into a
    // subsequent non-kiosk Network DM where slot 1 is remote-only —
    // the lobby would render slot 1 as 'local' before any remote
    // joins, confusing the join-flow.
    unclaimSlotsNotIn(slots);
    syncFromClaims();
    renderAllLabels();
}

/**
 * Read the claim-registry and reflect any locally-claimed slots into
 * the lobby UI as `'local'` occupants. Only touches slots that aren't
 * already remote-owned (the orchestrator owns those via onJoin/onLeave).
 * Exposed as part of the on-entry path; the `onClaimChange` subscriber
 * below calls the same function on every change while in network mode.
 */
function syncFromClaims() {
    refreshDom();
    const slotState = getNetworkSlotState();
    for (let i = 0; i < MAX_SLOTS; i++) {
        const cur = slotState[i]?.occupant;
        if (cur === 'remote') continue;
        const isClaimed = isSlotClaimedLocally(i);
        if (isClaimed && cur !== 'local' && cur !== 'host') {
            setNetworkSlotOccupant(i, 'local', slotState[i].labelOverride);
            for (const root of allLobbyRoots) {
                const row = root.querySelector(`.network-slot[data-slot="${i}"]`);
                if (row) row.dataset.occupant = 'local';
            }
        } else if (!isClaimed && (cur === 'local')) {
            setNetworkSlotOccupant(i, 'empty', slotState[i].labelOverride);
            for (const root of allLobbyRoots) {
                const row = root.querySelector(`.network-slot[data-slot="${i}"]`);
                if (row) row.dataset.occupant = 'empty';
            }
        }
    }
    updateReadyAttribute();
}

/**
 * Reset every slot row + clear the room code. Called when entering
 * Network mode so a previous session's state doesn't linger.
 */
export function resetNetworkLobby() {
    refreshDom();
    resetNetworkSlotState();
    setNetworkRoomCode(null);
    renderAllLabels();
    updateReadyAttribute();
}

/**
 * Set a slot's occupant. `occupant` is one of:
 *   'empty' | 'host' | 'local' | 'remote'
 * Optional `label` overrides the auto-computed text (used for special
 * cases; normal flow leaves it null).
 */
export function setNetworkSlotState(slot, { occupant = 'empty', label = null } = {}) {
    refreshDom();
    const slotState = getNetworkSlotState();
    if (!slotState[slot]) return;
    setNetworkSlotOccupant(slot, occupant, label);
    for (const root of allLobbyRoots) {
        const row = root.querySelector(`.network-slot[data-slot="${slot}"]`);
        if (row) row.dataset.occupant = occupant;
    }
    renderAllLabels();
    updateReadyAttribute();
}

/** Populate room-code display in every pane copy. Null shows placeholder. */
export function setNetworkRoomCode(code) {
    refreshDom();
    setRoomCodeState(code);
    const text = code ?? '- - - -';
    const svg = code ? renderQrSvg(code) : '';
    for (const root of allLobbyRoots) {
        const codeEl = root.querySelector('.network-invite-code');
        if (codeEl) codeEl.textContent = text;
        const qrEl = root.querySelector('.network-invite-qr');
        if (qrEl) qrEl.innerHTML = svg;
    }
}

/**
 * Render the join URL as an SVG QR. The URL is computed against the
 * current page's location so the QR points back at the same Worker
 * deployment (staging vs production) — scanning it on a phone opens
 * the cssDOOM URL with `?join=CODE` and routes straight into the
 * Network DM remote path. `scalable: true` produces an SVG without
 * fixed width/height so CSS sizing on the container wins.
 */
function renderQrSvg(code) {
    const url = new URL(`?join=${encodeURIComponent(code)}`, location.href).href;
    const qr = qrcode(0, 'M'); // typeNumber=0 (auto), error level M
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ scalable: true, margin: 1 });
}

// ── Internal: label + ready-attribute rendering ─────────────────────────

function nextClaimableSlot() {
    const slotState = getNetworkSlotState();
    const locallyClaimableSlots = getLocallyClaimableSlots();
    for (let i = 0; i < MAX_SLOTS; i++) {
        if (slotState[i]?.occupant !== 'empty') continue;
        if (locallyClaimableSlots.has(i)) return i;
    }
    return -1;
}

function labelFor(slot) {
    const s = getNetworkSlotState()[slot];
    if (!s) return '';
    if (s.labelOverride) return s.labelOverride;
    if (s.occupant !== 'empty') return `Player ${slot + 1} ready`;
    if (slot === nextClaimableSlot()) return 'Press button to join';
    return 'Waiting for player';
}

function renderAllLabels() {
    if (allLobbyRoots.length === 0) return;
    for (let i = 0; i < MAX_SLOTS; i++) {
        const text = labelFor(i);
        for (const root of allLobbyRoots) {
            const labelEl = root.querySelector(`.network-slot[data-slot="${i}"] .network-slot-label`);
            if (labelEl) labelEl.textContent = text;
        }
    }
}

function updateReadyAttribute() {
    const slotState = getNetworkSlotState();
    let n = 0;
    for (const s of slotState) if (s.occupant !== 'empty') n++;
    if (n >= 2) {
        document.body.dataset.networkReady = 'true';
    } else {
        delete document.body.dataset.networkReady;
    }
}

// ── Claim-registry → lobby slot sync ────────────────────────────────────
// When a local device claims (or un-claims) a slot, mirror that into the
// lobby UI. Only fires while we're in network mode; in any other mode the
// network lobby isn't visible and the claim semantics are different
// (Local DM has its own per-pane prompts). `'remote'` occupants are never
// overwritten — they represent connected peers owned by the orchestrator.

onClaimChange(() => {
    if (state.networkMode !== 'host') return;
    syncFromClaims();
    renderAllLabels();
});

// ── Renderer-command entry points ──────────────────────────────────────
// Network DM impl for showLobby. Same code on master and on a Network
// DM remote (.network-client body class) — both apply the payload's
// slot occupants to the .pane-network-lobby DOM. Local DM (variant:
// 'local') is handled by lobby.js / client-lobby.js. Local DM
// secondaries don't have .network-client and the variant guard keeps
// them out either way.

export function renderLobbyState(payload) {
    if (!payload || payload.variant !== 'network') return;
    if (!Array.isArray(payload.slotOccupants)) return;

    applyNetworkLobbyState(payload.slotOccupants);

    // body[data-network-ready] gates the "PRESS FIRE TO START" CSS
    // selector for the host pane. Written from payload.canStart so
    // master and joiner stay aligned without each running their own
    // count loop.
    if (payload.canStart) {
        document.body.dataset.networkReady = 'true';
    } else {
        delete document.body.dataset.networkReady;
    }
}

/** Renderer-command impl for hideLobby — no-op for now (CSS dismisses
 *  the panel based on body[data-game-state]). */
export function clearLobby() {
    // No-op; CSS-driven for now.
}

// Register render-only handlers. Parallel with lobby.js;
// renderLobbyState() above gates on payload.variant === 'network' so
// only the network branch paints when the master is in Network DM.
registerOverlayImpl('showLobby', renderLobbyState);
registerOverlayImpl('hideLobby', clearLobby);
