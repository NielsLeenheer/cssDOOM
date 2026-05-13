/**
 * Entry point — initialization and main game loop.
 *
 * Two execution modes:
 *   - Master (default): full game loop, input, audio. Listens on the
 *     transport for client windows wanting to join.
 *   - Client (`?join` URL param): connects to master and renders the slot
 *     master assigns. Skips game loop. Runs `initClient` which wires a
 *     RenderClient that applies incoming renderer commands to a local
 *     DomRenderer + Orchestrator (and, for Network DM remotes, also
 *     wires the local input pipeline to forward input to master).
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
import { initKeyboardMouse } from './src/input/keyboard-mouse.js';
import { initTouchInput } from './src/input/touch.js';
import { initGamepadInput } from './src/input/gamepad.js';
import { initActions } from './src/actions/index.js';
import { initDebugMenu, updateDebugStats } from './src/ui/debug.js';
import { attractTick, isAttractActive } from './src/ui/attract.js';
import { spectatorActive } from './src/ui/spectator.js';
import './src/ui/spectator.js';

import { orchestrator } from './src/orchestrator.js';
import { isSlotClaimedLocally, onClaimChange } from './src/input/claim-registry.js';
import { initClient } from './src/client.js';
import { MasterConnection, ClientConnection } from './src/transport/peer-connection.js';
import { updatePerspective } from './src/renderer/scene/scene.js';
import { initRemoteInput, applyRemoteInput } from './src/input/remote.js';
import { initLobby, getCarriedOverClaims } from './src/ui/lobby.js';
import { setClientSlot, applyLobbyState } from './src/ui/client-lobby.js';
import { showScoreboard, hideScoreboard } from './src/ui/scoreboard.js';
import { isMatchLobby, setMatchEndBroadcaster } from './src/game/match.js';
import { setGameStateBroadcaster, applyRemoteGameState, getGameState } from './src/game/game-state.js';
import {
    rendererState,
    bindRendererStateToMaster,
    initClientRendererState,
} from './src/renderer/renderer-state.js';

const isClient = new URLSearchParams(location.search).has('join');
const isKiosk = new URLSearchParams(location.search).has('kiosk');
if (isKiosk) document.body.classList.add('kiosk');

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
 * may be empty (SP's pane 1, or DM's pane 1 after client teardown):
 * updateCamera / updateHud are routed through the orchestrator, and the
 * orchestrator's per-pane target may be a RenderSink that needs to
 * forward to a client regardless of local DOM state. Skipping here
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
 * renderer module) because it iterates the renderer-side world view —
 * rendererState.cameras for camera position, rendererState.things for live
 * thing positions, and the spectator toggle for ceiling-skip behavior.
 *
 * Same code runs on master and client: on master rendererState aliases
 * the live game state, on a client it's populated by inbound broadcast
 * envelopes. Culling can't tell the difference.
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
            const camera = rendererState.cameras[i] || rendererState.cameras[0];
            if (!camera) continue;
            updateCulling(camera, rendererState.things, spectatorActive, i);
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
 * client window can join and receive a streamed view of pane 1.
 */
async function initMaster() {
    if (import.meta.env.DEV) { debugEnabled = true; initDebugMenu(); }
    // Alias the renderer-state arrays directly onto the live game state so
    // master-side reads (culling, sprite billboard rotation) see the
    // authoritative simulation values with no copy step.
    bindRendererStateToMaster(state);
    // Wire action handlers BEFORE input modules emit anything. Inputs
    // produce events on the bus; handlers in src/actions/* subscribe to
    // them and dispatch into game functions.
    initActions();
    initKeyboardMouse();
    initTouchInput();
    initGamepadInput();
    // Register a player-1 input provider that's driven by remote input
    // events forwarded from a connected client. Provider stays registered
    // even when no client is connected — it just contributes zeros until
    // events arrive.
    initRemoteInput();

    // Lobby controller — manages the press-to-claim UX, watches input
    // claims to drive the join-prompt overlay, and auto-starts the
    // match when all slots are claimed in Local DM.
    //
    // Local DM has no "externally claimed" slots: a connected Local DM secondary
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

    // Resize: pane widths change → recompute perspective so FOV tracks
    // the new layout. Covers dev-window resizing and the kiosk's
    // single→split transitions as players join / drop.
    window.addEventListener('resize', updatePerspective);

    /* Start game loop */
    requestAnimationFrame(gameLoop);
    window.focus();
}

/**
 * Set up the master-side broadcast connection. Listens for a client
 * window's LOOKING announcement and routes join / leave events into the
 * orchestrator, which owns the slot lifecycle (target swap, pane
 * teardown, visibility). This function is now mostly wiring.
 */
let masterConnection = null;
function setupMasterBroadcast() {
    // Track the level we're transitioning to. `currentMap` from maps.js
    // doesn't get updated until partway through loadMap (after the fetch),
    // so a fast client reconnecting in the middle of a level change
    // would otherwise receive an ACK pointing at the OLD level — and end
    // up loading stale geometry while master streams new-level deltas at
    // it. Stashing the intended new level here means snapshotProvider
    // always reflects where master is heading, not where it just left.
    let pendingLevel = null;
    window.addEventListener('cssdoom:level-changing', (e) => {
        pendingLevel = e.detail?.level ?? null;
        masterConnection?.signalLevelChange();
    });
    window.addEventListener('cssdoom:level-loaded', () => {
        pendingLevel = null;
        masterConnection?.resumeAfterLevelLoad();
    });

    masterConnection = new MasterConnection({
        snapshotProvider: () => ({
            mode: state.mode,
            level: pendingLevel ?? currentMap,
            gameState: getGameState(),
            slotIndex: orchestrator.nextOrCurrentRemoteSlot(),
        }),
        onRemoteInput: applyRemoteInput,
        onJoin: (payload) => {
            const slot = payload.slotIndex;
            if (slot == null) {
                console.warn('[broadcast] client join refused — no free slots');
                return;
            }
            // Don't mark slot as externally claimed: the Local DM secondary
            // is display-only, master's local kbm-B / gamepad must still
            // be able to claim it. (Network DM will revisit.)
            orchestrator.bindRemoteSlot(slot, masterConnection.channel);
            // Send current lobby state right away so the freshly-
            // connected client's pane shows the correct prompt
            // immediately (instead of waiting for the next claim event).
            broadcastLobbyState();
        },
        onLeave: () => {
            orchestrator.unbindRemoteSlot();
        },
    });

    // Mirror master's lobby state onto any connected client. Fires on
    // every local claim add/remove (via the orchestrator's claim notify)
    // and on match-reset so the client's overlay tracks live.
    onClaimChange(broadcastLobbyState);
    window.addEventListener('cssdoom:match-reset', broadcastLobbyState);

    // Mirror match-end scoreboard onto any connected client. match.js
    // calls this from endMatch(); we just hand the payload to the
    // connection, which gates on peerAlive.
    setMatchEndBroadcaster((payload) => {
        masterConnection?.broadcastMatchEnd(payload);
    });

    // Mirror every game-state transition onto the client. game-state.js
    // calls this on each transitionTo. The connection gates on
    // peerAlive — no broadcast when nobody's listening.
    setGameStateBroadcaster((state) => {
        masterConnection?.broadcastGameState(state);
    });
}

/**
 * Build current lobby state and send it to all connected sinks. No-op
 * when no client is alive (the underlying broadcast is gated on
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
 * Client window boot. Runs in any window with `?join` in the URL —
 * a Local DM secondary today, a Network DM remote tomorrow. Opens a
 * ClientConnection; on ACK, syncs mode/level locally so the renderer
 * has the same scene as master, then stands up the client coordinator
 * ([src/client.js](src/client.js)) which wires the RenderClient half
 * (and, for Network DM remotes, the input forwarder).
 *
 * Disconnect handling: when master goes silent (closed, reloaded, crashed),
 * the connection's watchdog fires onLeave. We show a DISCONNECTED overlay
 * and the connection keeps sending LOOKING in the background. If a master
 * comes back, the simplest correct behavior is to reload this window —
 * any deltas that flowed through during the original session left the
 * scene out of sync with whatever the new master starts at.
 */
async function initClientWindow() {
    document.body.classList.add('client-window');

    // Stand up the renderer-state arrays sized for the client's two-pane
    // DOM. The mirror callbacks (declared in commands.js) populate them as
    // updates flow in from master; until then they sit at spawn-default zeros.
    initClientRendererState(sceneStates.length);

    const overlay = ensureDisconnectedOverlay();

    const conn = new ClientConnection({
        onLobbyState: (msg) => {
            // Per-pane claim-state mirror only — body[data-match-lobby]
            // is now driven by the GAME_STATE handler below.
            applyLobbyState(msg);
        },
        onMatchEnd: (msg) => {
            // body[data-match-ended] is driven by GAME_STATE; this
            // handler just paints the scoreboard DOM from the payload.
            showScoreboard(msg);
        },
        onGameState: ({ state }) => {
            // Mirror master's game-state machine — applyRemoteGameState
            // writes body[data-game-state]. We also clear the scoreboard
            // when leaving ENDED so a rematch doesn't keep the old DOM
            // behind the dim overlay.
            const wasEnded = document.body.dataset.gameState === 'ended';
            applyRemoteGameState(state);
            if (wasEnded && state !== 'ended') hideScoreboard();
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
            // Mirror master's current game-state immediately — without
            // this the client's body attributes would lag until the
            // master's next transition. Applies via applyRemoteGameState
            // (no echo back to the channel).
            if (payload.gameState) applyRemoteGameState(payload.gameState);

            // Master assigns us a slot; default to 1 if it's missing
            // (e.g., older master that doesn't include slotIndex). The
            // local DomRenderer always paints to pane 1 of the client's
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
            setClientSlot(slotIndex);

            // Local DM secondary is display-only: master sees the same
            // physical inputs directly and forwarding would double-
            // process every press. Network DM remotes drop the flag and
            // get the full input pipeline shipped over the wire.
            initClient(conn.channel, slotIndex, { forwardInput: false });
            console.log('[broadcast] client wired up at slot', slotIndex);
        },
        onLeave: () => {
            console.log('[broadcast] master went silent — showing DISCONNECTED');
            overlay.classList.add('visible');
        },
    });

    requestAnimationFrame(cullingLoop);
    window.addEventListener('resize', updatePerspective);
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

if (isClient) {
    initClientWindow();
} else {
    initMaster();
}
