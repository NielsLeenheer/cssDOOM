/**
 * Network DM — master-side signaling-room lifecycle.
 *
 * Owns: room-code generation, the WebSocket connection to the
 * Cloudflare-Worker signaling endpoint, and the per-peer `addPeer` /
 * `removePeer` calls into `MasterConnection`. UI sync (network-lobby
 * slot rows, room-code display) is partly here (the code) and partly
 * in master.js (the slot rows fire from the same onJoin/onLeave path
 * Local DM uses, so this module doesn't need to duplicate that wiring).
 *
 * Wiring order at boot:
 *   1. master.js constructs MasterConnection
 *   2. master.js calls setMasterConnection(masterConnection) here
 *   3. menu.js's applyMode('network') calls openRoom() to actually
 *      start signaling; applyMode for any other mode calls closeRoom().
 *
 * Phase 5d: master-side only. The remote-side connect helper lives in
 * src/transport/webrtc-transport.js (`connectToNetworkRoom`) and gets
 * wired up in Phase 6.
 */

import { listenForNetworkClients } from './transport/webrtc-transport.js';
import { setNetworkRoomCode } from './ui/network-lobby.js';

// 32-char alphabet without visually-ambiguous glyphs (no 0/O, 1/I/L,
// B/8 swap-prone shapes), 4 chars per code — that's ~1M unique codes,
// plenty for the kiosk + occasional collision retry. Matches the
// Worker's `^[A-Z0-9]{4,8}$` regex (the alphabet is a strict subset).
const ROOM_CODE_CHARS = 'ACDEFGHJKMNPQRTUVWXYZ234679';
const ROOM_CODE_LEN = 4;

let masterConnection = null;
let roomController = null; // { close } from listenForNetworkClients
let activeRoomCode = null;

/** Called by master.js after the MasterConnection is created. */
export function setMasterConnection(mc) {
    masterConnection = mc;
}

/** Currently-open room code, or null if no room is open. */
export function getActiveRoomCode() {
    return activeRoomCode;
}

/**
 * Open a Network DM signaling room. Idempotent — calling while a room
 * is already open is a no-op (the existing code stays in use). The
 * generated code is pushed into the network-lobby UI here; per-peer
 * UI updates (slot rows) fire from the onJoin/onLeave callbacks
 * already registered on MasterConnection in master.js.
 *
 * Signaling-WebSocket reconnect on transient drops is handled INSIDE
 * `listenForNetworkClients` — when the WS drops, only the WS is
 * reopened; existing peer RTCDataChannels (which are P2P, independent
 * of the WS) are not disturbed. Without this, an idle-eviction of the
 * Cloudflare DO's WebSocket would cascade into kicking every connected
 * player every few minutes.
 */
export function openRoom() {
    if (!masterConnection) {
        console.warn('[network-host] openRoom called before MasterConnection ready');
        return;
    }
    if (roomController) return;
    if (!activeRoomCode) activeRoomCode = generateRoomCode();
    setNetworkRoomCode(activeRoomCode);
    roomController = listenForNetworkClients({
        roomCode: activeRoomCode,
        onPeerConnected: (transport, peerId) => {
            // Network DM remotes play their own audio on their own
            // device — master suppresses its AudioRenderer for that
            // slot (see orchestrator bindRemoteSlot suppressAudio).
            masterConnection.addPeer(transport, peerId, { playsAudioLocally: true });
        },
        onPeerLeft: (peerId) => {
            masterConnection.removePeer(peerId);
        },
    });
    console.log('[network-host] listening on room', activeRoomCode);
}

/** Close the signaling room and tear down every active peer. */
export function closeRoom() {
    if (roomController) {
        try { roomController.close(); } catch {}
        roomController = null;
    }
    if (activeRoomCode) {
        activeRoomCode = null;
        setNetworkRoomCode(null);
    }
    console.log('[network-host] room closed');
}

function generateRoomCode() {
    let out = '';
    for (let i = 0; i < ROOM_CODE_LEN; i++) {
        out += ROOM_CODE_CHARS[Math.floor(Math.random() * ROOM_CODE_CHARS.length)];
    }
    return out;
}
