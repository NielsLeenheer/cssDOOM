/**
 * Master — boot routine + game loop for the authoritative window.
 *
 * Counterpart to [src/client.js](client.js). Where a client is "renderer
 * in + input out," master is "input from everything in + simulation +
 * renderer out to every pane (local DOM and remote sinks)."
 *
 * `initMaster()` wires:
 *
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
import { mapData, currentMap } from './shared/maps/index.js';
import { getCurrentLevel, onLevel } from './game/level.js';
import { updateCamera, updateHud } from './renderer/index.js';
import { domRendererManager } from './renderer/dom-renderer-manager.js';
import { updateMenuSelection } from './ui/menu.js';
import { loadSavedGameMode, applyMode, ensurePlayerCount } from './mode.js';
import { buildModeConfigFromUrl } from './game/mode-config.js';
import { Game } from './game/game.js';
import { App } from './app.js';
import { hideInitialOverlay } from './renderer/overlays/overlay.js';
import { initKeyboardMouse } from './input/keyboard-mouse.js';
import { initTouchInput } from './input/touch.js';
import { initGamepadInput } from './input/gamepad.js';
import { initActions } from './actions/index.js';
import { initDebugMenu, updateDebugStats } from './renderer/hud/debug.js';
import { attractTick, isAttractActive } from './game/attract.js';
import { spectatorActive } from './ui/spectator.js';
import { orchestrator } from './orchestrator.js';
import { BroadcastChannelTransport } from './transport/transport.js';
import { BROADCAST_CHANNEL_NAME } from './transport/protocol.js';
import { initMasterConnection } from './network-host.js';
import { setNetworkSlotOccupant } from './game/lobby-state.js';
import { initRemoteInput, applyRemoteInput } from './input/remote.js';
import { ensureMatchSize } from './game/match.js';
import { GAME_STATE, getGameState } from './game/game-state.js';
import { getWorldSnapshot, applyWorldSnapshot } from './game/snapshot.js';
import { spawnPlayer } from './game/player/spawn.js';


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
        // updateHud is event-driven — mutation sites set player._hudDirty,
        // we fire + clear here. Skipping the call avoids the orchestrator
        // fan-out (and on Network DM, the per-frame wire envelope per
        // slot) when nothing changed.
        if (player._hudDirty) {
            updateHud(player, player.viewportIndex);
            player._hudDirty = false;
        }
        updateCamera(player, player.viewportIndex);
    }
}

// ── Game loop ──────────────────────────────────────────────────────────

function gameLoop(timestamp) {
    if (!mapData) {
        requestAnimationFrame(gameLoop);
        return;
    }

    attractTick(timestamp);
    if (isAttractActive()) {
        // World is frozen and every per-pane camera rotation runs
        // inside the renderer-side attract animation (see
        // src/renderer/screens/attract.js — self-throttled to ~20 fps
        // to keep idle GPU load down). Master has no per-frame work
        // until input wakes us, so just yield to the next RAF.
        requestAnimationFrame(gameLoop);
        return;
    }

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
    // via `app.game.level`, but the gameLoop reads through the
    // singleton registry (`getCurrentLevel`) because that's what
    // `game/level.js::swapLevel` writes on map change — and swapLevel
    // is the entry point for the callers (attract, debug,
    // gates SP-respawn, match.restartMatch fallback) that don't hold
    // a Level instance themselves.
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
    // Track the level we're transitioning to. `currentMap` from
    // shared/maps/index.js doesn't get updated until partway through
    // `maps.load` (after the fetch + parse, before the enrichment),
    // so a fast client reconnecting in the middle of a level change
    // would otherwise receive an ACK pointing at the OLD level — and
    // end up loading stale geometry while master streams new-level
    // deltas at it. Stashing the intended new level here means
    // snapshotProvider always reflects where master is heading, not
    // where it just left.
    let pendingLevel = null;
    onLevel('changing', ({ name }) => {
        pendingLevel = name ?? null;
        // Prepare the coordinated multi-peer handshake: reset every
        // alive session's readyToPlay flag, capture _loadInFlight, pause
        // LOOKING. Bookkeeping only — the actual `cmd-world loadMap`
        // envelope is fired by Level.load's own
        // `await this.orchestrator.loadMap(name)` call (which fans
        // through every RenderSink to every alive peer). This must run
        // BEFORE that fan-out so a fast joiner's READY_TO_PLAY can't
        // race the reset — JS execution order guarantees this because
        // the subscriber is synchronous.
        //
        // For the coordinated host-fire-start path, Game.beginPlay
        // calls awaitAllReadyToPlay → broadcastPlay after Level.load
        // returns. For uncoordinated paths (swapLevel via attract /
        // debug / gates / match-restart fallback), there's no
        // awaitAllReadyToPlay step — master proceeds and clients catch
        // up via the renderer-command pipeline. onLevel('loaded')
        // unpauses LOOKING below regardless.
        masterConnection?.beginCoordinatedLoad();
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
                // setNetworkSlotOccupant emits a lobby-state change;
                // Game's onLobbyChange subscriber repaints. No explicit
                // showLobby needed here.
                setNetworkSlotOccupant(slot, 'remote');
            }
        },
        onReady: (peerKey) => {
            // Client has confirmed its RenderClient is subscribed. NOW
            // it's safe to fire the initial-state catch-up — the
            // commands these produce land on a listening transport.
            const slot = orchestrator.currentRemoteSlot(peerKey);
            if (slot == null) return;

            // updateHud is event-driven (gated on player._hudDirty),
            // so we mark this slot's player dirty here. The next
            // gameLoop frame fires updateHud through the per-pane
            // dispatch which reaches the newly-attached pane via its
            // RenderSink. Without this, any peer would stare at blank
            // HUD digits until the next damage / ammo / weapon-switch
            // event. (HUD isn't in the world snapshot because it's
            // per-pane derived state, not world state.) Harmless when
            // state.players[slot] is undefined (Network DM remote at
            // a slot not yet sized — ensurePlayerCount below handles
            // that and the next frame flushes via the same gate.)
            if (state.players[slot]) state.players[slot]._hudDirty = true;

            // World-state snapshot. The freshly-attached pane's scene
            // has every pickup uncollected, every enemy alive, every
            // door at its map-default state, no corpses, and no
            // cross-pane player billboards. Master sends its
            // authoritative state so the receiver reconciles. Applies
            // to ANY peer with a wire (Local DM secondary OR Network
            // DM remote). Skip if no map is loaded yet (still in
            // lobby) — the joiner's upcoming orchestrator.loadMap
            // will build a fresh scene against the new map and a
            // following snapshot (if mid-match) catches it up then.
            if (getCurrentLevel()) {
                masterConnection.sendSnapshot(peerKey, getWorldSnapshot());
            }

            // Overlay catch-up — if master is currently in a state
            // that has a visible overlay (LOBBY, ENDED), send the
            // current payload directly to this peer's sink only.
            // Same shape as the world-snapshot send above (per-target
            // post-READY catch-up); content depends on which state
            // master is in. INTERMISSION is SP-only so it never
            // reaches a joiner; ATTRACT is kiosk-only and kiosks
            // don't accept joiners.
            const sink = orchestrator.findTarget(slot, 'sink');
            const game = window.app?.game;
            if (sink && game) {
                const gs = getGameState();
                if (gs === GAME_STATE.LOBBY) {
                    sink.showLobby(game.getLobbyPayload());
                } else if (gs === GAME_STATE.ENDED) {
                    sink.showResults(game.getResultsPayload());
                }
            }

            // Everything below is Network-DM-host-specific: roster
            // sizing for late-joining remotes, audio listener config
            // for a new physical machine, spawn-if-dead for the
            // previous peer's abandoned slot. Local DM secondary
            // shares master's roster + audio + level, so it doesn't
            // need any of this.
            if (state.networkMode !== 'host' || peerKey === 'local') return;
            ensurePlayerCount(slot + 1);
            // Keep state.match.kills sized to the roster so awardFrag
            // can index kills[killer.index][victim.index] and the
            // end-of-match scoreboard's buildGrid walk covers every
            // player. resetMatch sized the matrix to the master's
            // local-only roster; a Network DM remote joining later
            // (post-resetMatch) needs the matrix grown to match.
            ensureMatchSize(state.players.length);
            // Reflect the new roster size in audio listener config — a
            // fresh AudioRenderer for the new slot if needed
            // (suppressed slots get filtered out inside the rebuild).
            orchestrator.configureAudio([...state.players.keys()]);
            // If this slot's player is currently marked dead (typically
            // because the previous peer here disconnected — onLeave
            // flags isDead so the abandoned slot drops out of the
            // visible world), respawn them now. Without this, the
            // gameLoop's "every player dead → freeze world" gate stays
            // engaged whenever the host happens to also be dead, and
            // the joiner sees nothing until the host fires-to-respawn.
            // Only meaningful once a match is live (level loaded);
            // pre-match the lobby still controls slot assignment.
            const player = state.players[slot];
            if (player && player.isDead && getCurrentLevel()) {
                spawnPlayer(player);
            }
        },
        onLeave: (peerKey) => {
            // Capture the slot before unbinding — the orchestrator
            // forgets the peer after unbindRemoteSlot, and we need
            // the slot index to clear its row in the network lobby UI.
            const slot = orchestrator.currentRemoteSlot(peerKey);
            // After the unbind's grace expires, the slot's restored
            // local DomRenderer rebuilds its scene from scratch
            // (just-built = every pickup uncollected, every enemy
            // alive, no player billboards, no corpses). Catch it up
            // by applying the current world snapshot directly to
            // that one renderer — direct dispatch (not via
            // orchestrator) so other already-in-sync local
            // renderers + remote sinks aren't disturbed by
            // re-fired non-idempotent commands like createCorpse.
            orchestrator.unbindRemoteSlot(peerKey, {
                onGraceRebuilt: (rebuiltRenderer) => {
                    if (getCurrentLevel()) {
                        applyWorldSnapshot(rebuiltRenderer, getWorldSnapshot());
                    }
                },
            });
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
                // setNetworkSlotOccupant emits a lobby-state change;
                // Game's onLobbyChange subscriber repaints (the
                // remaining connected joiners drop the departed peer's
                // row to "WAITING FOR PLAYER" via that path).
                setNetworkSlotOccupant(slot, 'empty');
            }
        },
    });

    // Register the Local DM secondary as a peer. The BroadcastChannel
    // transport is constructed here (not inside MasterConnection) so the
    // connection itself is transport-agnostic — Network DM peers are
    // added the same way, each with their own WebRTCDataChannelTransport.
    const localTransport = new BroadcastChannelTransport(BROADCAST_CHANNEL_NAME);
    masterConnection.addPeer(localTransport, 'local');

    // Lobby repaint triggers live in the state owners now:
    //   - Local-DM claim changes → Game's onClaimChange subscriber
    //   - Network-DM roster / room-code → Game's onLobbyChange
    //     subscriber (fired from lobby-state.js setters)
    //   - Match reset → match.js's 'reset' emit → lobby-state's
    //     setCarriedOverClaims → onLobbyChange → Game
    // master.js used to host duplicate onClaimChange + onMatch('reset')
    // subscribers that called orchestrator.showLobby; both are gone.

    // Scoreboard fan-out to clients is handled by the renderer-command
    // pipeline: match.js::endMatch's _emitMatchEvent('ended') triggers
    // Game's onMatch('ended') subscriber, which fires
    // orchestrator.showResults(getResultsPayload()). DM exit-switch
    // path funnels through the same endMatch.

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
    // gamepad must do that explicitly. (The carried-over-claims
    // snapshot fires on every match-reset; see lobby-state.js.)

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
    domRendererManager.startCullingLoop({
        isAttract: isAttractActive,
        getSpectatorActive: () => spectatorActive,
    });

    updateMenuSelection();
    renderAllActivePanes();

    await new Promise(resolve => setTimeout(resolve, 600));

    hideInitialOverlay();

    /* Start game loop */
    requestAnimationFrame(gameLoop);
    window.focus();
}
