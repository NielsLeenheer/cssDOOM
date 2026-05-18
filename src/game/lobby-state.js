/**
 * Lobby state — the per-slot occupant roster + lobby-session metadata
 * that both the Local DM and Network DM lobby screens read from
 * (via Game.getLobbyPayload).
 *
 * Pure data + accessors; no DOM. Mutation sites (mode.js,
 * network-host.js, master.js's onJoin/onLeave handlers) update
 * through the setters here and then trigger `orchestrator.showLobby()`
 * so the next render reflects the change.
 *
 * The match-reset hook below snapshots which slots were already
 * claimed at the start of the current lobby session into
 * `carriedOverClaims` so back-to-back rematches don't re-flash READY
 * on claims the player kept across the reset.
 */

import { state } from './state.js';
import { onMatch } from './match.js';
import { isSlotClaimedLocally } from '../input/claim-registry.js';

const MAX_SLOTS = 4;

// ── Local DM carried-over claims ──
// Snapshot of which slots were already claimed at the start of the
// current lobby session (refreshed on match.js's 'reset' event).
// Slots in this set are "carried over" — they shouldn't flash READY
// when the new lobby begins because nobody just pressed a button for
// them. Slots claimed AFTER the session started are the "fresh" ones
// that get the READY overlay.
let carriedOverClaims = new Set();

export function getCarriedOverClaims() {
    return carriedOverClaims;
}

export function setCarriedOverClaims(s) {
    carriedOverClaims = s;
}

// ── Network DM slot state ──
// One record per slot. `occupant` is who's in this slot;
// `labelOverride` optionally replaces the auto-computed label text.
//
//   occupant: 'empty' | 'host' | 'local' | 'remote'
//     - empty:  no one's there yet
//     - host:   master's slot-0 player (kept around for future styling
//               hooks even though the label is now the same as 'local')
//     - local:  a local player on master (kiosk's second local at slot 1
//               post-claim)
//     - remote: a Network DM remote connected to this slot
let slotState = [];

/** Lazy-initialize slotState to MAX_SLOTS empty records. Idempotent. */
export function ensureNetworkSlotStateInitialized() {
    if (slotState.length === 0) {
        for (let i = 0; i < MAX_SLOTS; i++) {
            slotState.push({ occupant: 'empty', labelOverride: null });
        }
    }
}

/** Mutable per-slot record array. Renderer reads `.occupant` and
 *  `.labelOverride`; mutations go through the setters below so all
 *  writes land in one place. */
export function getNetworkSlotState() {
    return slotState;
}

/** Per-slot occupant strings ('empty'|'host'|'local'|'remote'), used
 *  by getLobbyPayload() when building the wire envelope so the
 *  network-lobby view propagates to joiners. */
export function getNetworkSlotOccupants() {
    return slotState.map(s => s.occupant);
}

/** Reset every slot to 'empty' with no label override. */
export function resetNetworkSlotState() {
    for (let i = 0; i < MAX_SLOTS; i++) {
        slotState[i] = { occupant: 'empty', labelOverride: null };
    }
}

/** Set a single slot's occupant + label override. Caller is expected
 *  to also push DOM updates and trigger the next showLobby render. */
export function setNetworkSlotOccupant(slot, occupant, labelOverride = null) {
    if (!slotState[slot]) return;
    slotState[slot].occupant = occupant;
    slotState[slot].labelOverride = labelOverride;
}

/** Number of slots currently occupied (anything other than 'empty'). */
export function countOccupied() {
    let n = 0;
    for (const s of slotState) if (s.occupant !== 'empty') n++;
    return n;
}

// ── Network DM locally-claimable slots ──
// Which slots can be claimed by a locally-bound input device.
//   kiosk Network DM: [0, 1] (both local slots use press-to-claim)
//   non-kiosk Network DM: [] (slot 0 auto-claims via setDefaultSlot,
//     no claim ceremony shows; remote-only slots never claim locally)
// Drives the "PRESS BUTTON TO JOIN" prompt to the next empty
// locally-claimable slot.
let locallyClaimableSlots = new Set();

export function getLocallyClaimableSlots() {
    return locallyClaimableSlots;
}

export function setLocallyClaimableSlotsState(slots) {
    locallyClaimableSlots = new Set(slots);
}

// ── Network DM room code ──
let roomCode = null;

export function getRoomCode() {
    return roomCode;
}

export function setRoomCodeState(code) {
    roomCode = code;
}

// ── Match-reset hook ──
// Snapshots already-claimed slots into carriedOverClaims at the
// start of every match cycle. Claims made AFTER this fires (i.e.,
// during the new lobby session) are the "fresh" ones that get the
// READY overlay flash; carried-over claims don't re-flash.
//
// Subscribed at module load. Game.restartMatch / match.js::resetMatch
// emit 'reset' which triggers this; the next orchestrator.showLobby
// (fired by master.js's onMatch('reset') subscriber) renders the
// updated state.
onMatch('reset', () => {
    const carried = new Set();
    for (let i = 0; i < state.players.length; i++) {
        if (isSlotClaimedLocally(i)) carried.add(i);
    }
    carriedOverClaims = carried;
});
