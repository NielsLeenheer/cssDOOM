/**
 * Master — boot routine + game loop for the authoritative window.
 *
 * Counterpart to [src/client.js](client.js). Where a client is "renderer
 * in + input out," master is "input from everything in + simulation +
 * renderer out to every pane (local DOM and remote sinks)."
 *
 * `initMaster()` wires:
 *
 *   - Game state binding: aliases rendererState to live game state so
 *     master-side reads see authoritative values with no copy step.
 *   - Action handlers: bus subscribers in `src/actions/*` that dispatch
 *     fire/use/weapon/menu events into game functions.
 *   - Input modules: keyboard+mouse, touch, gamepad, and the remote
 *     receiver (which feeds master's input pipeline from any connected
 *     client).
 *   - Lobby controller: press-to-claim UX in DM.
 *   - The game loop: per-frame update + render dispatch.
 *   - The culling loop: ~6 fps visibility passes per pane (lives in
 *     renderer/scene/culling.js).
 *   - Master broadcast: opens MasterConnection, routes join/leave into
 *     the orchestrator, mirrors lobby / match / game-state to clients.
 */

import { state } from './game/state.js';
import { mapData, currentMap, addPlayerThing } from './shared/maps.js';
import { loadMap } from './shared/maps.js';
import { getCurrentLevel } from './game/level.js';
import { updateCamera, updateHud } from './renderer/index.js';
import { startCullingLoop } from './renderer/scene/culling.js';
import { updatePerspective } from './renderer/scene/scene.js';
import { updateMenuSelection } from './ui/menu.js';
import { loadSavedGameMode, applyMode, ensurePlayerCount } from './mode.js';
import { spawnPlayer } from './game/player/spawn.js';
import { configureAudio } from './audio/audio.js';
import { hideInitialOverlay } from './ui/overlay.js';
import { initKeyboardMouse } from './input/keyboard-mouse.js';
import { initTouchInput } from './input/touch.js';
import { initGamepadInput } from './input/gamepad.js';
import { initActions } from './actions/index.js';
import { initDebugMenu, updateDebugStats } from './ui/debug.js';
import { attractTick, isAttractActive } from './ui/attract.js';
import { spectatorActive } from './ui/spectator.js';
import { orchestrator } from './orchestrator.js';
import { isSlotClaimedLocally, onClaimChange } from './input/claim-registry.js';
import { MasterConnection } from './transport/peer-connection.js';
import { BroadcastChannelTransport } from './transport/transport.js';
import { BROADCAST_CHANNEL_NAME } from './transport/protocol.js';
import { setMasterConnection } from './network-host.js';
import { setNetworkSlotState, getNetworkSlotOccupants } from './ui/network-lobby.js';
import { initRemoteInput, applyRemoteInput } from './input/remote.js';
import { initLobby, getCarriedOverClaims } from './ui/lobby.js';
import { isMatchLobby, setMatchEndBroadcaster } from './game/match.js';
import { setGameStateBroadcaster, getGameState } from './game/game-state.js';
import { bindRendererStateToMaster } from './renderer/renderer-state.js';

// ── Debug toggle ───────────────────────────────────────────────────────

let debugEnabled = false;

// Exposed at module load so the runtime debug-menu opener works even
// before initMaster runs (rare, but matches previous behavior).
window.debug = function () {
    if (!debugEnabled) {
        debugEnabled = true;
        initDebugMenu();
        console.log('Debug menu enabled');
    }
};

// ── Render-all-panes ───────────────────────────────────────────────────

/**
 * Push each player's camera + HUD through the orchestrator. The
 * orchestrator's per-player dispatch fans the call to every render
 * target (DomRenderer or RenderSink) whose `playerIndex` matches —
 * mirror SP fans player 0 to both panes, DM splits, Network DM
 * forwards via the sink to the client.
 */
function renderAllActivePanes() {
    for (const player of state.players) {
        updateHud(player, player.viewportIndex);
        updateCamera(player, player.viewportIndex);
    }
}

// ── Game loop ──────────────────────────────────────────────────────────

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
        for (const player of state.players) {
            updateCamera(player, player.viewportIndex);
        }
        requestAnimationFrame(gameLoop);
        return;
    }

    // The per-frame world step is driven through the current Level
    // instance, which internally no-ops if paused. The Level reference
    // lives in `src/game/level.js`'s module-level registry, written
    // by `shared/maps.js::loadMap` and read here via `getCurrentLevel`.
    // L2 replaces this with `app.game.level` once Game owns Level.
    getCurrentLevel()?.tick(timestamp);
    renderAllActivePanes();

    if (import.meta.env.DEV || debugEnabled) updateDebugStats();

    requestAnimationFrame(gameLoop);
}

// ── Master broadcast ───────────────────────────────────────────────────

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
        snapshotProvider: (peerKey) => ({
            gameMode: state.gameMode,
            level: pendingLevel ?? currentMap,
            gameState: getGameState(),
            slotIndex: orchestrator.nextOrCurrentRemoteSlot(peerKey),
        }),
        onRemoteInput: (msg, _peerKey) => applyRemoteInput(msg),
        onJoin: (payload, peerKey) => {
            const slot = payload.slotIndex;
            if (slot == null) {
                console.warn('[broadcast] client join refused — no free slots');
                return;
            }
            // Don't mark slot as externally claimed: the Local DM secondary
            // is display-only, master's local kbm-B / gamepad must still
            // be able to claim it. (Network DM will revisit.)
            const transport = masterConnection.transportFor(peerKey);
            // suppressAudio mirrors the peer's playsAudioLocally flag —
            // when the remote plays its own audio on its own device,
            // master skips that slot's listener to avoid double-playing.
            // Default false matches Local DM (secondary calls
            // setAudioEnabled(false), so master keeps playing both slots).
            const suppressAudio = masterConnection.playsAudioLocallyFor(peerKey);
            orchestrator.bindRemoteSlot(slot, transport, peerKey, { suppressAudio });
            // Mirror the connection into the network lobby UI when we're
            // in network mode and this is an actual remote (not the
            // Local DM 'local' BroadcastChannel peer).
            if (state.networkMode === 'host' && peerKey !== 'local') {
                setNetworkSlotState(slot, { occupant: 'remote' });
            }
            // Send current lobby state right away so the freshly-
            // connected client's pane shows the correct prompt
            // immediately (instead of waiting for the next claim event).
            broadcastLobbyState();
        },
        onReady: (peerKey) => {
            // Client has confirmed its RenderClient is subscribed. NOW
            // it's safe to spawn the player and fire the initial-state
            // burst — the switchWeapon / createPlayerSprite world
            // commands these produce land on a listening transport.
            if (state.networkMode !== 'host' || peerKey === 'local') return;
            const slot = orchestrator.currentRemoteSlot(peerKey);
            if (slot == null) return;
            ensurePlayerCount(slot + 1);
            const player = state.players[slot];
            spawnPlayer(player);
            addPlayerThing(player);
            // Reflect the new roster size in audio listener config — a
            // fresh AudioRenderer for the new slot if needed.
            configureAudio(state.players.length);
        },
        onLeave: (peerKey) => {
            // Capture the slot before unbinding — the orchestrator
            // forgets the peer after unbindRemoteSlot, and we need
            // the slot index to clear its row in the network lobby UI.
            const slot = orchestrator.currentRemoteSlot(peerKey);
            orchestrator.unbindRemoteSlot(peerKey);
            if (state.networkMode === 'host' && peerKey !== 'local' && slot != null) {
                // Mark the departed player as dead + collected so they
                // drop out of the visible world (no sprite, no collision)
                // but their state.players entry and scoreboard row stay
                // until match end. A reconnect at the same slot would
                // reuse the same Player and re-spawn them.
                const player = state.players[slot];
                if (player) {
                    player.isDead = true;
                    if (player.thingRef) player.thingRef.collected = true;
                }
                setNetworkSlotState(slot, { occupant: 'empty' });
                // Re-broadcast so any still-connected joiners drop
                // the departed peer's row to "WAITING FOR PLAYER".
                broadcastLobbyState();
            }
        },
    });

    // Hand the MasterConnection to the network-host module so its
    // openRoom() / closeRoom() (driven by applyMode in menu.js) can
    // wire signaling peers into it.
    setMasterConnection(masterConnection);

    // Register the Local DM secondary as a peer. The BroadcastChannel
    // transport is constructed here (not inside MasterConnection) so the
    // connection itself is transport-agnostic — Network DM peers are
    // added the same way, each with their own WebRTCDataChannelTransport.
    const localTransport = new BroadcastChannelTransport(BROADCAST_CHANNEL_NAME);
    masterConnection.addPeer(localTransport, 'local');

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
    setGameStateBroadcaster((s) => {
        masterConnection?.broadcastGameState(s);
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
        // Network DM joiners mirror the 4-slot list from this; Local
        // DM clients ignore the field (their lobby uses the per-pane
        // data-claim-state attribute fed from slotsClaimed).
        slotOccupants: getNetworkSlotOccupants(),
    });
}

// ── Boot ───────────────────────────────────────────────────────────────

/**
 * Master initialization — full game loop, plus the broadcast listener
 * that lets a client window join and receive a streamed view of one
 * pane.
 *
 * @param {object} [options]
 * @param {boolean} [options.isKiosk=false]  Kiosk forces deathmatch and
 *   bypasses the saved-mode restore so the installation always boots
 *   into 2P split-screen regardless of what the last interactive
 *   session left in localStorage.
 */
export async function initMaster({ isKiosk = false } = {}) {
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
    // Register a slot-1 input provider that's driven by remote input
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
    applyMode(isKiosk ? 'deathmatch' : loadSavedGameMode(), 'standalone');

    await loadMap('E1M1');
    startCullingLoop({
        isAttract: isAttractActive,
        getSpectatorActive: () => spectatorActive,
    });

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
