/**
 * Entry point — initialization and main game loop.
 *
 * Two execution modes:
 *   - Master (default): full game loop, input, audio. Listens on the
 *     broadcast channel for secondary windows wanting to join.
 *   - Secondary (`?join` URL param): renderer-only mirror of the master.
 *     Skips game loop and input, runs a BroadcastClient that applies
 *     incoming renderer commands to a local DomRenderer + Orchestrator.
 */

import { state } from './src/game/state.js';
import { mapData, currentMap } from './src/shared/maps.js';
import { updateGame } from './src/game/index.js';
import { loadMap } from './src/shared/maps.js';
import { updateCulling, CULLING_INTERVAL } from './src/renderer/scene/culling.js';
import { updateCamera, updateHud } from './src/renderer/index.js';
import { sceneStates } from './src/renderer/dom.js';
import { updateMenuSelection, loadSavedMode, applyMode } from './src/ui/menu.js';
import { hideInitialOverlay } from './src/ui/overlay.js';
import { initKeyboardInput } from './src/input/keyboard.js';
import { initMouseInput } from './src/input/mouse.js';
import { initTouchInput } from './src/input/touch.js';
import { initGamepadInput } from './src/input/gamepad.js';
import { initDebugMenu, updateDebugStats } from './src/ui/debug.js';
import { attractTick, isAttractActive } from './src/ui/attract.js';
import { spectatorActive } from './src/ui/spectator.js';
import './src/ui/spectator.js';

import { orchestrator } from './src/renderer/orchestrator.js';
import { DomRenderer } from './src/renderer/dom-renderer.js';
import { BroadcastSink } from './src/renderer/broadcast-sink.js';
import { BroadcastClient } from './src/renderer/broadcast-client.js';
import { MasterConnection, SecondaryConnection } from './src/renderer/broadcast-connection.js';
import { tearDownPane, rebuildPane } from './src/renderer/scene/scene.js';
import { initRemoteInputReceiver, applyRemoteInput } from './src/input/remote-master.js';
import { isSlotClaimedLocally, onClaimChange } from './src/input/claim-registry.js';
import { initLobby, getCarriedOverClaims } from './src/ui/lobby.js';
import { setSecondarySlot, applyLobbyState } from './src/ui/secondary-lobby.js';
import { showScoreboard, hideScoreboard } from './src/ui/scoreboard.js';
import { isMatchLobby, setMatchEndBroadcaster } from './src/game/match.js';

const isSecondary = new URLSearchParams(location.search).has('join');
const isKiosk = new URLSearchParams(location.search).has('kiosk');
if (isKiosk) document.body.classList.add('kiosk');
// Master's renderable panes. Slot 0 is always the host's local view.
// Slots 1, 2, 3 can be filled by either a Local-on-master player (rendered
// to master's pane 1) or a Remote (BroadcastSink → secondary). Allocation
// is dynamic — see setupMasterBroadcast.
const MAX_SLOTS = 4;

let debugEnabled = false;

window.debug = function() {
    if (!debugEnabled) {
        debugEnabled = true;
        initDebugMenu();
        console.log('Debug menu enabled');
    }
};

/**
 * Render every pane. Pane index i uses state.players[i] when present;
 * panes beyond the player count (mirror mode) fall back to player 0.
 *
 * No `wallElements.length === 0` early-exit here even though some panes
 * may be empty (SP's pane 1, or DM's pane 1 after secondary teardown):
 * updateCamera / updateHud are routed through the orchestrator, and the
 * orchestrator's per-pane target may be a BroadcastSink that needs to
 * forward to a secondary regardless of local DOM state. Skipping here
 * would starve the sink. Writing CSS variables on a hidden / empty pane
 * is harmless.
 */
function renderAllActivePanes() {
    for (let i = 0; i < sceneStates.length; i++) {
        const player = state.players[i] || state.players[0];
        if (!player) continue;
        updateHud(player, i);
        updateCamera(player, i);
    }
}

/**
 * Culling loop. Runs every CULLING_INTERVAL frames per pane, hiding
 * off-screen elements. Lives at the orchestration layer (not inside the
 * renderer module) because it iterates game state — state.players for the
 * camera position, state.things for live thing positions, and the spectator
 * toggle for ceiling-skip behavior.
 *
 * During attract mode the camera rotates so slowly (~12°/sec) that we
 * can afford to cull much less often. Drops culling work to ~10 Hz from
 * the in-match 20 Hz, freeing up more idle headroom on the kiosk.
 */
const CULLING_INTERVAL_ATTRACT = 6; // ~10 Hz at 60 Hz RAF
let cullingFrameCount = 0;
function cullingLoop() {
    cullingFrameCount++;
    const interval = isAttractActive() ? CULLING_INTERVAL_ATTRACT : CULLING_INTERVAL;
    if (cullingFrameCount >= interval) {
        cullingFrameCount = 0;
        for (let i = 0; i < sceneStates.length; i++) {
            if (sceneStates[i].wallElements.length === 0) continue;
            const player = state.players[i] || state.players[0];
            updateCulling(player, state.things, spectatorActive, i);
        }
    }
    requestAnimationFrame(cullingLoop);
}

/**
 * Game Loop
 */
// During attract mode we don't need 60Hz rendering — the rotation is
// slow enough that 20 fps looks visually identical. Throttling here
// significantly reduces the kiosk's GPU compositor work (every render
// re-composites the perspective-transformed scene tree), which is what
// was spinning the cooling fans during idle attract.
const ATTRACT_RENDER_INTERVAL_MS = 50;
let lastAttractRenderAt = 0;

function gameLoop(timestamp) {
    if (!mapData) {
        requestAnimationFrame(gameLoop);
        return;
    }

    attractTick(timestamp);
    if (isAttractActive()) {
        // Skip game logic in attract mode — attractTick is rotating the
        // camera; just render the current scene state and idle the world.
        // Render at ~20 fps instead of 60 fps to keep idle GPU load down.
        if (timestamp - lastAttractRenderAt >= ATTRACT_RENDER_INTERVAL_MS) {
            renderAllActivePanes();
            lastAttractRenderAt = timestamp;
        }
        requestAnimationFrame(gameLoop);
        return;
    }
    // Reset the throttle on attract exit so the first post-attract frame
    // renders immediately rather than waiting for the next interval.
    lastAttractRenderAt = 0;

    // Freeze game logic only when EVERY player is dead. In DM with one
    // player alive, the world (enemies, doors, etc.) keeps ticking and the
    // alive player keeps playing; the dead player's camera shows the
    // death-cam view at their corpse until they fire to respawn.
    if (state.players.every(p => p.isDead)) {
        for (let i = 0; i < sceneStates.length; i++) {
            const player = state.players[i] || state.players[0];
            if (!player) continue;
            updateCamera(player, i);
        }
        requestAnimationFrame(gameLoop);
        return;
    }

    updateGame(timestamp);
    renderAllActivePanes();

    if (import.meta.env.DEV || debugEnabled) updateDebugStats();

    requestAnimationFrame(gameLoop);
}


/**
 * Master initialization — full game loop, plus a broadcast listener so a
 * secondary window can join and receive a streamed view of pane 1.
 */
async function initMaster() {
    if (import.meta.env.DEV) { debugEnabled = true; initDebugMenu(); }
    initKeyboardInput();
    initMouseInput();
    initTouchInput();
    initGamepadInput();
    // Register a player-1 input provider that's driven by remote input
    // events forwarded from a connected secondary window. Provider stays
    // registered even when no secondary is connected — it just contributes
    // zeros until events arrive.
    initRemoteInputReceiver();

    // Lobby controller — manages the press-to-claim UX, watches input
    // claims to drive the join-prompt overlay, and auto-starts the
    // match when all slots are claimed in Local DM.
    //
    // Local DM has no "externally claimed" slots: a connected secondary
    // is display-only and doesn't claim slot 1 — master's local kbm-B /
    // gamepad must do that explicitly. Network DM will swap in a getter
    // returning remote-occupied slots.
    initLobby({ getExternallyClaimedSlots: () => new Set() });

    // Restore the previously chosen mode (default singleplayer) before the
    // initial map load so the scene is built with the right pane count and
    // DM gets player 2 + match state from the first frame.
    // Kiosk forces deathmatch and bypasses the saved-mode restore so the
    // installation always boots into 2P split-screen regardless of what the
    // last interactive session left in localStorage.
    applyMode(isKiosk ? 'deathmatch' : loadSavedMode());

    await loadMap('E1M1');
    requestAnimationFrame(cullingLoop);

    updateMenuSelection();
    renderAllActivePanes();

    await new Promise(resolve => setTimeout(resolve, 600));

    hideInitialOverlay();

    setupMasterBroadcast();

    /* Start game loop */
    requestAnimationFrame(gameLoop);
    window.focus();
}

/**
 * Set up the master-side broadcast connection. Listens for a secondary
 * window's LOOKING announcement, swaps target[1] for a BroadcastSink so
 * subsequent renderer commands stream to the secondary, and watches a
 * heartbeat to detect disconnection.
 */
let masterConnection = null;
let savedSecondaryTarget = null;
// When a secondary disconnects, defer the visual "show pane 1 again" toggle
// for this many ms. Lets a quickly-reloading secondary reconnect without
// the user seeing master's pane 1 flash visible. The target-swap (sink →
// DomRenderer) still happens immediately so the local DOM stays current.
const RECONNECT_GRACE_MS = 500;
let secondaryActiveGraceTimer = null;
// Slots currently occupied by a remote sink. Master picks the next free
// one when a secondary joins. With one secondary at most (today's Local
// DM use case), this practically always returns 1; the dynamic structure
// is here so multi-remote (Network DM) can extend it without surgery.
const occupiedRemoteSlots = new Set();
let currentSecondarySlot = null; // for the single-secondary case
function allocateRemoteSlot() {
    for (let i = 1; i < MAX_SLOTS; i++) {
        if (!occupiedRemoteSlots.has(i)) return i;
    }
    return null;
}
function setupMasterBroadcast() {
    // Track the level we're transitioning to. `currentMap` from maps.js
    // doesn't get updated until partway through loadMap (after the fetch),
    // so a fast secondary reconnecting in the middle of a level change
    // would otherwise receive an ACK pointing at the OLD level — and end
    // up loading stale geometry while master streams new-level deltas at
    // it. Stashing the intended new level here means snapshotProvider
    // always reflects where master is heading, not where it just left.
    let pendingLevel = null;
    window.addEventListener('cssdoom:level-changing', (e) => {
        pendingLevel = e.detail?.level ?? null;
        masterConnection?.signalLevelChange();
    });
    // After loadMap settles, clear the pending level and resume accepting
    // secondary handshakes. Without this, a secondary that hits LOOKING
    // mid-loadMap would receive an ACK pointing at a half-built scene.
    window.addEventListener('cssdoom:level-loaded', () => {
        pendingLevel = null;
        masterConnection?.resumeAfterLevelLoad();
    });

    masterConnection = new MasterConnection({
        snapshotProvider: () => {
            // Allocate (or re-use) a slot for the joiner. If a secondary is
            // already alive (this LOOKING is a duplicate retry from the
            // same peer), give it back the slot it already has rather than
            // allocating a new one.
            const slotIndex = currentSecondarySlot ?? allocateRemoteSlot();
            return {
                mode: state.mode,
                level: pendingLevel ?? currentMap,
                attract: isAttractActive(),
                slotIndex,
            };
        },
        onRemoteInput: applyRemoteInput,
        onJoin: (payload) => {
            // A reconnecting secondary cancels any pending "show pane 1
            // again" timer so the user doesn't see a flash during reload.
            if (secondaryActiveGraceTimer) {
                clearTimeout(secondaryActiveGraceTimer);
                secondaryActiveGraceTimer = null;
            }
            const slot = payload.slotIndex;
            if (slot == null) {
                console.warn('[broadcast] secondary join refused — no free slots');
                return;
            }
            occupiedRemoteSlots.add(slot);
            currentSecondarySlot = slot;
            // Don't mark slot as externally claimed: secondary is
            // display-only, master's local kbm-B / gamepad must still be
            // able to claim it. (Network DM will revisit.)
            const sink = new BroadcastSink(masterConnection.channel, slot);
            savedSecondaryTarget = orchestrator.replaceTarget(slot, sink);
            // Tear down master's local DOM for this slot — the secondary
            // is rendering it now. World commands and the culling loop
            // both early-exit on the now-empty sceneStates[slot] arrays,
            // so master skips the wasted work on an invisible subtree.
            tearDownPane(slot);
            // Hide master's local copy of the pane — the secondary is now
            // showing it. CSS rule lives in viewport.css.
            document.body.classList.add('secondary-active');
            console.log('[broadcast] secondary joined at slot', slot, '- pane torn down');
            // Send current lobby state right away so the freshly-
            // connected secondary's pane shows the correct prompt
            // immediately (instead of waiting for the next claim event).
            broadcastLobbyState();
        },
        onLeave: () => {
            const slot = currentSecondarySlot;
            // Restore the DomRenderer immediately so master's per-frame
            // commands keep the pane's DOM in sync. Visual unhide is
            // deferred so a reloading secondary doesn't flash the pane.
            if (slot != null) {
                orchestrator.replaceTarget(slot, savedSecondaryTarget ?? new DomRenderer(slot));
                occupiedRemoteSlots.delete(slot);
            }
            savedSecondaryTarget = null;
            currentSecondarySlot = null;
            if (secondaryActiveGraceTimer) clearTimeout(secondaryActiveGraceTimer);
            secondaryActiveGraceTimer = setTimeout(() => {
                secondaryActiveGraceTimer = null;
                // Rebuild the pane DOM from pane 0's current state before
                // unhiding it — without this, the user would see a brief
                // flash of an empty .scene before the next gameLoop frame
                // would have a chance to repopulate it (and frankly,
                // there's no path that would repopulate without this).
                if (slot != null) rebuildPane(slot);
                document.body.classList.remove('secondary-active');
            }, RECONNECT_GRACE_MS);
            console.log('[broadcast] secondary left slot', slot);
        },
    });

    // Mirror master's lobby state onto any connected secondary. Fires on
    // every local claim add/remove (via claim-registry's notify) and on
    // match-reset so the secondary's overlay tracks live.
    onClaimChange(broadcastLobbyState);
    window.addEventListener('cssdoom:match-reset', broadcastLobbyState);

    // Mirror match-end scoreboard onto any connected secondary. match.js
    // calls this from endMatch(); we just hand the payload to the
    // connection, which gates on peerAlive.
    setMatchEndBroadcaster((payload) => {
        masterConnection?.broadcastMatchEnd(payload);
    });
}

/**
 * Build current lobby state and send it to all connected sinks. No-op
 * when no secondary is alive (the underlying broadcast is gated on
 * `peerAlive`).
 */
function broadcastLobbyState() {
    if (!masterConnection) return;
    const slotsClaimed = state.players.map((_, i) => isSlotClaimedLocally(i));
    const carried = getCarriedOverClaims();
    const slotsCarriedOver = state.players.map((_, i) => carried.has(i));
    masterConnection.broadcastLobbyState({
        inLobby: isMatchLobby(),
        slotsClaimed,
        slotsCarriedOver,
    });
}

/**
 * Secondary initialization — renderer-only mode. Open a BroadcastConnection
 * in the secondary role; on ACK, sync mode/level locally so the renderer
 * has the same scene as the master, and start a BroadcastClient to apply
 * incoming renderer commands.
 *
 * Disconnect handling: when master goes silent (closed, reloaded, crashed),
 * the connection's watchdog fires onLeave. We show a DISCONNECTED overlay
 * and the connection keeps sending LOOKING in the background. If a master
 * comes back, the simplest correct behavior is to reload the secondary —
 * any deltas that flowed through during the original session left the
 * scene out of sync with whatever the new master starts at.
 */
async function initSecondary() {
    document.body.classList.add('secondary-window');

    const overlay = ensureDisconnectedOverlay();

    let client = null;
    const conn = new SecondaryConnection({
        onLobbyState: (msg) => {
            applyLobbyState(msg);
            // Re-entering the lobby = match no longer ended on this peer.
            // Master clears its data-match-ended attribute in resetMatch;
            // mirror that here so the scoreboard hides on a restart.
            if (msg.inLobby && document.body.dataset.matchEnded) {
                delete document.body.dataset.matchEnded;
                hideScoreboard();
            }
        },
        onMatchEnd: (msg) => {
            document.body.dataset.matchEnded = 'true';
            showScoreboard(msg);
        },
        onAck: async (payload, isReconnect) => {
            console.log('[broadcast] master accepted, syncing', payload, isReconnect ? '(reconnect)' : '');
            if (isReconnect) {
                // Master came back after a disconnect. The simplest way to
                // guarantee a consistent scene is to reload — clean local
                // state, run the join handshake again from scratch.
                location.reload();
                return;
            }
            overlay.classList.remove('visible');
            if (payload.mode) applyMode(payload.mode);
            if (payload.level) {
                await loadMap(payload.level);
            }
            // Mirror master's attract state immediately — without this the
            // secondary HUD would show through during a kiosk-idle period
            // until the master's next attract toggle.
            if (payload.attract) document.body.dataset.attract = 'true';

            // Master assigns us a slot; default to 1 if it's missing
            // (e.g., older master that doesn't include slotIndex). The
            // local DomRenderer always paints to pane 1 of secondary's
            // HTML; the data-player attribute is set to match the slot
            // so the "hide own billboard" CSS keys correctly even if the
            // assigned slot isn't 1.
            const slotIndex = payload.slotIndex ?? 1;
            const visiblePane = document.querySelectorAll('.pane')[1];
            if (visiblePane) visiblePane.dataset.player = String(slotIndex);

            // Tell the lobby mirror which slot we represent — it'll use
            // this to pick our slot's bit out of incoming LOBBY_STATE
            // broadcasts. Replays any LOBBY_STATE that arrived during
            // onAck's await loadMap.
            setSecondarySlot(slotIndex);

            client = new BroadcastClient(conn.channel, slotIndex, orchestrator.target(1), orchestrator);
            console.log('[broadcast] client wired up at slot', slotIndex);
        },
        onLeave: () => {
            console.log('[broadcast] master went silent — showing DISCONNECTED');
            overlay.classList.add('visible');
        },
    });

    // Local DM: secondary is display-only. Input always comes from
    // master's keyboard / gamepads; no forwarding needed. Network DM
    // (future) will wire input forwarding via a different code path —
    // `initRemoteInputForwarder` stays in `src/input/remote-secondary.js`
    // as scaffolding for that.

    requestAnimationFrame(cullingLoop);
    hideInitialOverlay();
}

/**
 * Lazily create a fullscreen overlay that announces a disconnection from
 * the master. CSS lives inline because there's no other consumer.
 */
function ensureDisconnectedOverlay() {
    let el = document.getElementById('disconnected-overlay');
    if (el) return el;
    el = document.createElement('div');
    el.id = 'disconnected-overlay';
    el.textContent = 'DISCONNECTED — RECONNECTING…';
    Object.assign(el.style, {
        position: 'fixed',
        inset: '0',
        background: 'rgba(0,0,0,0.85)',
        color: '#ff4444',
        font: 'bold 32px monospace',
        display: 'none',
        alignItems: 'center',
        justifyContent: 'center',
        zIndex: '9999',
        letterSpacing: '0.05em',
        textShadow: '0 2px 0 #220000',
        pointerEvents: 'none',
    });
    document.body.appendChild(el);
    const styleId = 'disconnected-overlay-style';
    if (!document.getElementById(styleId)) {
        const style = document.createElement('style');
        style.id = styleId;
        style.textContent = '#disconnected-overlay.visible { display: flex; }';
        document.head.appendChild(style);
    }
    return el;
}

if (isSecondary) {
    initSecondary();
} else {
    initMaster();
}
