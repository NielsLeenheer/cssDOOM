/**
 * Network DM — master-side signaling-room lifecycle.
 *
 * Owns: the MasterConnection instance itself (constructed via
 * `initMasterConnection` during boot), room-code generation, the
 * WebSocket connection to the Cloudflare-Worker signaling endpoint,
 * and the per-peer `addPeer` / `removePeer` calls into the
 * connection. UI sync (network-lobby slot rows, room-code display)
 * is partly here (the room code) and partly in master.js (the slot
 * rows fire from the same onJoin/onLeave path Local DM uses, so this
 * module doesn't need to duplicate that wiring).
 *
 * Wiring order at boot:
 *   1. master.js calls initMasterConnection(callbacks) here to
 *      construct the connection and register the game-specific
 *      callbacks (snapshotProvider, onJoin, onReady, onLeave,
 *      onRemoteInput).
 *   2. master.js (or any caller) gets the connection back from
 *      initMasterConnection / via getMasterConnection().
 *   3. menu.js's applyMode('network') calls openRoom() to actually
 *      start signaling; applyMode for any other mode calls closeRoom().
 */

import { listenForNetworkClients } from './transport/webrtc-transport.js';
import { setNetworkRoomCode } from './ui/network-lobby.js';
import { MasterConnection } from './transport/peer-connection.js';

// 32-char alphabet without visually-ambiguous glyphs (no 0/O, 1/I/L,
// B/8 swap-prone shapes), 4 chars per code — that's ~1M unique codes,
// plenty for the kiosk + occasional collision retry. Matches the
// Worker's `^[A-Z0-9]{4,8}$` regex (the alphabet is a strict subset).
const ROOM_CODE_CHARS = 'ACDEFGHJKMNPQRTUVWXYZ234679';
const ROOM_CODE_LEN = 4;

let masterConnection = null;
let roomController = null; // { close } from listenForNetworkClients
let activeRoomCode = null;

/**
 * Construct the master-side MasterConnection with the supplied
 * game-specific callbacks. This module owns construction; callers
 * (master.js's setupMasterBroadcast) pass the callbacks rather than
 * building the MasterConnection themselves.
 *
 * Idempotent — a second call warns and returns the existing instance.
 */
export function initMasterConnection(callbacks) {
    if (masterConnection) {
        console.warn('[network-host] initMasterConnection: already initialized');
        return masterConnection;
    }
    masterConnection = new MasterConnection(callbacks);
    return masterConnection;
}

/**
 * Read-only accessor for the held MasterConnection. Used by
 * Game.beginPlay so it can drive the coordinated handshake
 * (broadcastLoadMap / awaitAllReadyToPlay / broadcastPlay) without
 * needing the connection in its constructor — preserves Game's
 * modeConfig-only API while letting it talk to the wire when it has
 * to. Returns null on a client window (initMasterConnection never
 * ran) and during the brief boot window before setupMasterBroadcast.
 */
export function getMasterConnection() {
    return masterConnection;
}

/** Currently-open room code, or null if no room is open. */
export function getActiveRoomCode() {
    return activeRoomCode;
}

/**
 * Preset the room code that the next `openRoom()` will use. Without
 * this the room code is randomly generated. Used by the `?server=CODE`
 * dev shortcut so master + joiner can agree on a fixed code without
 * round-tripping the auto-generated one through the lobby UI.
 *
 * Must be called before openRoom — once a room is open the code is
 * locked in. Re-call after closeRoom to use a different code.
 *
 * Validated against the same regex the Worker enforces; an invalid
 * code is silently ignored (caller can check getActiveRoomCode to
 * confirm).
 */
export function setActiveRoomCode(code) {
    if (typeof code !== 'string') return;
    if (!/^[A-Z0-9]{4,8}$/.test(code)) return;
    activeRoomCode = code;
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
