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
import { mapData, currentMap } from './shared/maps.js';
import { loadMap } from './shared/maps.js';
import { getCurrentLevel, onLevel } from './game/level.js';
import { updateCamera, updateHud } from './renderer/index.js';
import { startCullingLoop } from './renderer/scene/culling.js';
import { updatePerspective } from './renderer/scene/scene.js';
import { updateMenuSelection } from './ui/menu.js';
import { loadSavedGameMode, applyMode, ensurePlayerCount } from './mode.js';
import { buildModeConfigFromUrl } from './game/mode-config.js';
import { Game } from './game/game.js';
import { App } from './app.js';
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
import { BroadcastChannelTransport } from './transport/transport.js';
import { BROADCAST_CHANNEL_NAME } from './transport/protocol.js';
import { initMasterConnection } from './network-host.js';
import { setNetworkSlotState, getNetworkSlotOccupants } from './ui/network-lobby.js';
import { initRemoteInput, applyRemoteInput } from './input/remote.js';
import { initLobby, getCarriedOverClaims } from './ui/lobby.js';
import { isMatchLobby, onMatch, ensureMatchSize } from './game/match.js';
import { setGameStateBroadcaster, getGameState, GAME_STATE } from './game/game-state.js';
import { bindRendererStateToMaster } from './renderer/renderer-state.js';

// Side-effect anchor for renderer-command overlay impls. See
// src/ui/overlays.js — without this import, modules whose only public
// surface is `registerOverlayImpl(...)` (today: scoreboard.js) can fall
// out of the bundle when their named imports get cleaned up elsewhere,
// silently breaking the corresponding renderer command.
import './ui/overlays.js';

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
    // instance, which internally no-ops if paused. Game owns the Level
    // via `app.game.level`, but the gameLoop reads through the legacy
    // singleton registry (`getCurrentLevel`) because the same registry
    // is what `shared/maps.js::loadMap` writes on map change — and
    // loadMap is still the entry point for several callers that don't
    // own a Level instance (see project_lifecycle_refactor_l7_deferred
    // on the deferred loadMap shim).
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
    onLevel('changing', ({ name }) => {
        pendingLevel = name ?? null;
        // L6.6 — broadcast a coordinated loadMap to every alive peer.
        // Peers stay alive across the load: they receive MSG.LOAD_MAP,
        // call loadMap locally without reloading the page, and reply
        // with MSG.READY_TO_PLAY. broadcastLoadMap also pauses LOOKING
        // for the duration of the handshake.
        //
        // For the coordinated host-fire-start path, Game.beginPlay
        // calls awaitAllReadyToPlay → broadcastPlay after this fires.
        // For uncoordinated paths (legacy switches.js DM exit-switch
        // setTimeout(loadMap)), there's no awaitAllReadyToPlay step —
        // master proceeds and clients catch up via the renderer-command
        // pipeline. onLevel('loaded') unpauses below regardless.
        masterConnection?.broadcastLoadMap(name);
    });
    onLevel('loaded', () => {
        pendingLevel = null;
        masterConnection?.resumeAfterLevelLoad();
    });

    masterConnection = initMasterConnection({
        snapshotProvider: (peerKey) => ({
            gameMode: state.gameMode,
            // Only advertise a level if one is actually loaded. Without
            // this gate, a master that entered Network DM via menu from
            // another mode keeps `currentMap` set to the old level and
            // joiners would loadMap on it during the lobby phase (and
            // render the stale world instead of the lobby UI). Once the
            // host fires the match start, the Level registry populates
            // and joiners then arrive into the live level.
            level: getCurrentLevel() ? (pendingLevel ?? currentMap) : null,
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
            // Keep state.match.kills sized to the roster so awardFrag
            // can index kills[killer.index][victim.index] and the
            // end-of-match scoreboard's buildGrid walk covers every
            // player. resetMatch sized the matrix to the master's
            // local-only roster; a Network DM remote joining later
            // (post-resetMatch) needs the matrix grown to match.
            ensureMatchSize(state.players.length);
            // Reflect the new roster size in audio listener config — a
            // fresh AudioRenderer for the new slot if needed.
            configureAudio(state.players.length);
            // L6.7 — late-join spawn workaround removed. Per §17, late
            // join during PLAYING isn't supported; the coordinated
            // match-start handshake (L6.6) guarantees every joiner is
            // in state.players before Game.beginPlay runs Level.load,
            // and Level.load's addPlayerThings + resetGameState seed
            // each roster slot's player thing + DM defaults. A joiner
            // that arrives mid-match has its slot tracked here but
            // its player thing isn't streamed into the existing world;
            // proper world-snapshot recovery lands in a future phase.
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
    onMatch('reset', broadcastLobbyState);

    // L6.5 — MSG.MATCH_END wire envelope deleted. match.js::endMatch
    // now pushes via orchestrator.showResults; the renderer-command
    // pipeline carries the scoreboard payload to master's own pane(s)
    // AND every connected client (Game._onLevelComplete already uses
    // the same renderer command for the DM exit-switch path, so both
    // match-end paths converge on showResults).

    // Mirror every game-state transition onto the client. game-state.js
    // calls this on each transitionTo. Routes through the renderer-
    // command pipeline (L6.5 — replaces the legacy MSG.GAME_STATE wire
    // envelope) which fans the call to every target including each
    // RenderSink → client's DomRenderer, where the registered impl
    // calls applyRemoteGameState to flip body[data-game-state].
    setGameStateBroadcaster((s) => {
        orchestrator.setGameState(s);
    });
}

/**
 * Build current lobby state and send it to all connected sinks. No-op
 * when no client is alive (the underlying broadcast is gated on
 * `peerAlive`).
 */
function broadcastLobbyState() {
    const slotsClaimed = state.players.map((_, i) => isSlotClaimedLocally(i));
    const carried = getCarriedOverClaims();
    const slotsCarriedOver = state.players.map((_, i) => carried.has(i));
    // L6.5 — pushes via the renderer-command pipeline instead of the
    // legacy MSG.LOBBY_STATE wire envelope. The payload carries
    // everything the pane-claim UI (Local DM) and the network slot list
    // (Network DM) need; each impl picks the fields relevant to its mode.
    orchestrator.updateLobbyState({
        inLobby: isMatchLobby(),
        slotsClaimed,
        slotsCarriedOver,
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

    // Pre-seed an App with a Game so `window.app.game` is inspectable
    // from the dev console before App.start runs. App.start will tear
    // this Game down and construct a fresh one via startLocalGame; the
    // pre-seed is purely for the dev-console handle's continuity.
    const modeConfig = buildModeConfigFromUrl();
    const game = new Game(modeConfig);
    const app = new App();
    app.game = game;
    window.app = app;

    // applyMode owns the cross-cutting "enter a mode" work that Game
    // doesn't replicate: state.gameMode/networkMode, body data
    // attributes, player count, audio config, signaling room, and
    // DomRenderer reshaping. Game reads from state.gameMode (via the
    // getter on Game) so once applyMode runs, Game sees the right mode.
    applyMode(isKiosk ? 'deathmatch' : loadSavedGameMode(), 'standalone');

    // Master broadcast must be set up BEFORE app.start because the
    // `?server=CODE` shortcut (and any Network-DM boot path that
    // calls openRoom during app.start) requires masterConnection to
    // exist — otherwise openRoom early-returns and the signaling
    // room is never opened.
    setupMasterBroadcast();

    // App.start owns the boot from here. For SP, it auto-finalizes
    // via game.beginPlay → Level.load. For Local DM, it enters LOBBY
    // and waits for Game._checkAutoStart to trigger beginPlay when
    // both slots are claimed. Kiosk-SP and Network-DM-host map to
    // the same paths.
    await app.start();
    startCullingLoop({
        isAttract: isAttractActive,
        getSpectatorActive: () => spectatorActive,
    });

    updateMenuSelection();
    renderAllActivePanes();

    await new Promise(resolve => setTimeout(resolve, 600));

    hideInitialOverlay();

    // Resize: pane widths change → recompute perspective so FOV tracks
    // the new layout. Covers dev-window resizing and the kiosk's
    // single→split transitions as players join / drop.
    window.addEventListener('resize', updatePerspective);

    /* Start game loop */
    requestAnimationFrame(gameLoop);
    window.focus();
}
