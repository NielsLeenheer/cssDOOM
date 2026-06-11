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
import { GAME_STATE, getGameState } from './game/game-state.js';
import { mapData, currentMap } from './shared/maps/index.js';
import { getCurrentLevel, onLevel } from './game/level.js';
import { rendererManager } from './renderer/manager.js';
import { updateMenuSelection } from './ui/menu.js';
import { loadSavedGameMode, applyMode, ensurePlayerCount } from './mode.js';
import { app } from './app.js';
import { hideInitialOverlay } from './ui/initial-splash.js';
import { initKeyboardMouse } from './input/keyboard-mouse.js';
import { initTouchInput } from './input/touch.js';
import { initGamepadInput } from './input/gamepad.js';
import { initActions } from './actions/index.js';
import { installDebugTrigger } from './debug/boot.js';
import { attractTick, isAttractActive, setAttractWakeHandler } from './game/attract.js';
import { spectatorActive } from './ui/spectator.js';
import { orchestrator } from './orchestrator.js';
import { BroadcastChannelTransport } from './transport/transport.js';
import { BROADCAST_CHANNEL_NAME } from './transport/protocol.js';
import { initMasterConnection } from './network-host.js';
import { setNetworkSlotOccupant } from './game/lobby-state.js';
import { applyRemoteInput, clearRemoteSlot } from './input/remote.js';
import { ensureMatchSize } from './game/match.js';
import { buildCatchup, applyCatchupCmds } from './game/catchup.js';
import { spawnPlayer } from './game/player/spawn.js';
import { config } from '../config.js';


// ── Render-all-panes ───────────────────────────────────────────────────

/**
 * Push each player's camera + HUD through the orchestrator. The
 * orchestrator's per-player dispatch fans the call to every render
 * target (CSSRenderer or RenderSink) whose `playerIndex` matches —
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
            orchestrator.dispatch({ type: 'player', slot: player.viewportIndex, cmd: 'updateHud', args: [{
                currentWeapon: player.currentWeapon,
                ammo: { ...player.ammo },
                maxAmmo: { ...player.maxAmmo },
                health: player.health,
                armor: player.armor,
                // Sets don't survive JSON.stringify, so normalize to
                // Array on the wire. hud.js re-Sets on entry.
                ownedWeapons: [...player.ownedWeapons],
                collectedKeys: [...player.collectedKeys],
                score: player.score,
            }] });
            player._hudDirty = false;
        }
        orchestrator.dispatch({ type: 'player', slot: player.viewportIndex, cmd: 'updateCamera', args: [{
            x: player.x,
            y: player.y,
            z: player.z,
            angle: player.angle,
            floorHeight: player.floorHeight ?? 0,
            isFiring: player.isFiring,
        }] });
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
            orchestrator.dispatch({ type: 'player', slot: player.viewportIndex, cmd: 'updateCamera', args: [{
                x: player.x,
                y: player.y,
                z: player.z,
                angle: player.angle,
                floorHeight: player.floorHeight ?? 0,
                isFiring: player.isFiring,
            }] });
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
        // `await this.orchestrator.dispatch({ type: 'world', cmd: 'loadMap', args: [name] })` call (which fans
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

    // Use cid (the URL-derived stable identity) as the orchestrator
    // binding key for Network DM remotes; fall back to peerKey for
    // Local DM secondary ('local') and for any client that didn't
    // send a cid. Centralised here so all orchestrator calls speak
    // the same identity scheme.
    const bindingKey = (peerKey, cid) => cid ?? peerKey;

    // Two-stage grace for Network DM disconnects:
    //   - ALIVE_GRACE_MS: keep the player alive in-world during a brief
    //     blip (page reload, momentary signal loss). If the same cid
    //     reattaches inside this window, no death and no respawn — the
    //     match just continues.
    //   - BINDING_GRACE_MS: after the alive grace expires the player
    //     dies, but their cid → slot reservation lingers so a later
    //     reattach reclaims the same slot and respawns there. Past
    //     this point the cid is forgotten and a reconnect is treated
    //     as a brand-new joiner.
    const ALIVE_GRACE_MS = 1000;
    const BINDING_GRACE_MS = 30000;
    const aliveGraceTimers = new Map(); // cid → timeoutId

    masterConnection = initMasterConnection({
        snapshotProvider: (peerKey, cid) => {
            // Local DM secondary always gets a full payload — it lives
            // outside the wait/reserve flow (single peer, always one
            // slot, always lobby-eligible since Local DM doesn't have
            // the same mid-match wait semantics).
            if (peerKey === 'local') {
                return {
                    gameMode: state.gameMode,
                    level: getCurrentLevel() ? (pendingLevel ?? currentMap) : null,
                    slotIndex: orchestrator.nextOrCurrentRemoteSlot(peerKey),
                };
            }

            const key = bindingKey(peerKey, cid);
            // Allocate (or reuse) a slot on the first LOOKING and hold
            // onto it via orchestrator.reserveRemoteSlot. Doing the
            // reservation NOW — even in mid-match where the joiner
            // will be told to wait — means peers queue in connection
            // order rather than racing the LOOKING retry timer when
            // the next lobby phase opens. Returning slotIndex:null
            // here (allocator exhausted) is the cue MasterConnection
            // uses to send MSG.REFUSED room-full to overflow peers.
            // Keyed by `cid` so a refreshing joiner (signaling peerId
            // churns but URL cid persists) finds their previous slot.
            const isReattach = orchestrator.isBoundRemoteSlot(key);
            const slot = orchestrator.nextOrCurrentRemoteSlot(key);
            if (slot == null) return {}; // → REFUSED

            const inLobby = getGameState() === GAME_STATE.LOBBY;
            if (!inLobby && !isReattach && !config.network.allowMidGameJoin) {
                // Mid-match new joiner — reserve the slot but signal
                // the joiner to wait. When master returns to LOBBY,
                // the joiner's next LOOKING retry falls through to the
                // full-payload branch below; bindRemoteSlot upgrades
                // the reservation into a real binding (its `previous`
                // lookup picks up the placeholder entry and replaces
                // it). The isReattach guard lets a refreshing
                // already-active joiner bypass this and re-ACK
                // immediately: their old binding is still in
                // _remoteBindings (within RECONNECT_GRACE_MS), so we
                // want them seated again without a lobby-cycle wait.
                // The allowMidGameJoin config flag bypasses this gate
                // entirely — the full-payload branch below seats and
                // spawns the joiner into the running match.
                orchestrator.reserveRemoteSlot(slot, key);
                return { wait: true, slotIndex: slot };
            }

            return {
                gameMode: state.gameMode,
                // Only advertise a level if one is actually loaded. Without
                // this gate, a master that entered Network DM via menu from
                // another mode keeps `currentMap` set to the old level and
                // joiners would loadMap on it during the lobby phase (and
                // render the stale world instead of the lobby UI). Once the
                // host fires the match start, the Level registry populates
                // and joiners then arrive into the live level.
                level: getCurrentLevel() ? (pendingLevel ?? currentMap) : null,
                slotIndex: slot,
            };
        },
        onRemoteInput: (msg, _peerKey) => applyRemoteInput(msg),
        onJoin: (payload, peerKey, cid) => {
            const slot = payload.slotIndex;
            if (slot == null) {
                console.warn('[broadcast] client join refused — no free slots');
                return;
            }
            const key = bindingKey(peerKey, cid);
            // Cancel any pending alive-grace death for this cid — the
            // peer reattached inside the window, so the player should
            // keep walking instead of dying + respawning.
            const pendingDeath = aliveGraceTimers.get(key);
            if (pendingDeath != null) {
                clearTimeout(pendingDeath);
                aliveGraceTimers.delete(key);
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
            orchestrator.bindRemoteSlot(slot, transport, key, { suppressAudio });
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
        onReady: (peerKey, cid) => {
            // Client has confirmed its RenderClient is subscribed. NOW
            // it's safe to fire the initial-state catch-up — the
            // commands these produce land on a listening transport.
            const key = bindingKey(peerKey, cid);
            const slot = orchestrator.currentRemoteSlot(key);
            if (slot == null) return;

            // Catchup envelope: world (mechanics, things, corpses,
            // timer) + overlay (lobby/results if visible) + per-pane
            // state for the joiner's slot (HUD, camera, weapon, dead
            // flag). See src/game/catchup.js.
            const cmds = buildCatchup(slot);
            if (cmds.length) masterConnection.sendCatchup(peerKey, cmds);

            // The catchup carries the initial HUD, so clear the dirty
            // flag — otherwise renderAllActivePanes would redundantly
            // re-fire updateHud on the very next gameLoop frame.
            if (state.players[slot]) state.players[slot]._hudDirty = false;

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
            // Spawn the slot's player into the live world when either:
            //   - they're marked dead (the previous peer here
            //     disconnected and onLeave flagged isDead so the
            //     abandoned slot dropped out of the visible world), or
            //   - they have no thingRef yet (a fresh mid-match joiner
            //     under config.network.allowMidGameJoin — ensurePlayerCount
            //     just created a Player but hasn't placed it).
            // Without this, the gameLoop's "every player dead → freeze
            // world" gate stays engaged whenever the host happens to
            // also be dead, and the joiner sees nothing until the host
            // fires-to-respawn. Only meaningful once a match is live
            // (level loaded); pre-match the lobby still controls slot
            // assignment.
            const player = state.players[slot];
            if (player && getCurrentLevel() && (player.isDead || !player.thingRef)) {
                spawnPlayer(player);
            }
        },
        onLateReadyToPlay: (peerKey, cid) => {
            // This peer's scene rebuild outlasted beginPlay's
            // awaitAllReadyToPlay timeout, so the match-start fan-out
            // (spawnPlayer's world commands + broadcastPlayerSprites)
            // raced its loadMap. The joiner-side RenderClient queues
            // mid-load envelopes and replays them, but re-sending the
            // catchup here makes recovery independent of that replay
            // (and of any state the queue can't reconstruct, like
            // commands from before the peer's RenderClient existed).
            // Catchup commands are idempotent at the receiver — worst
            // case is a no-op re-apply.
            const key = bindingKey(peerKey, cid);
            const slot = orchestrator.currentRemoteSlot(key);
            if (slot == null) return;
            console.log('[broadcast] late READY_TO_PLAY from', key, '- re-sending catchup for slot', slot);
            const cmds = buildCatchup(slot);
            if (cmds.length) masterConnection.sendCatchup(peerKey, cmds);
            if (state.players[slot]) state.players[slot]._hudDirty = false;
        },
        onLeave: (peerKey, cid) => {
            const key = bindingKey(peerKey, cid);
            // Capture the slot before unbinding — the orchestrator
            // forgets the peer after unbindRemoteSlot, and we need
            // the slot index to clear its row in the network lobby UI.
            const slot = orchestrator.currentRemoteSlot(key);
            // Zero this slot's cached analog snapshot so the departed
            // peer's last movement values don't bleed into a rebound
            // slot (next peer to take it, or the host's local roster
            // reclaiming it). No-op if the slot never received ANALOG.
            if (slot != null) clearRemoteSlot(slot);
            // After the unbind's grace expires, the slot's restored
            // local CSSRenderer is brand-new — every pickup
            // uncollected, every enemy alive, no player billboards,
            // no corpses, default HUD and weapon sprite. Apply the
            // current catchup directly to that one renderer so
            // other already-in-sync local renderers and remote sinks
            // aren't disturbed by re-fired non-idempotent commands
            // like createCorpse.
            // For Network DM, keep the orchestrator binding alive for
            // BINDING_GRACE_MS so the cid → slot reservation survives
            // long enough for a reattach to reclaim the same slot
            // without going through the mid-match wait gate. Local DM
            // and any non-cid peer use the orchestrator default (the
            // short visual-rebuild window).
            const isNetworkRemote = state.networkMode === 'host' && peerKey !== 'local';
            orchestrator.unbindRemoteSlot(key, {
                onGraceRebuilt: (rebuiltRenderer) => {
                    applyCatchupCmds(rebuiltRenderer, buildCatchup(slot));
                },
                // Network DM: hold the cid → slot binding for the long
                // window so a late reattach reclaims the same slot. The
                // visual-rebuild grace uses the orchestrator default,
                // which is already aligned with ALIVE_GRACE_MS so a
                // mid-refresh peer's pane doesn't flash master's local
                // view before the player would die.
                ...(isNetworkRemote ? { bindingGraceMs: BINDING_GRACE_MS } : {}),
            });
            if (isNetworkRemote && slot != null) {
                // Two-stage grace: defer the player-dies / slot-empty
                // transition by ALIVE_GRACE_MS. A reattach inside that
                // window cancels this timer in onJoin above, so the
                // player never dies and no respawn happens. After it
                // fires, the slot is visibly empty but the cid still
                // owns it until BINDING_GRACE_MS — a later reattach
                // respawns into the same slot (onReady's spawn-if-dead
                // path).
                const prevTimer = aliveGraceTimers.get(key);
                if (prevTimer != null) clearTimeout(prevTimer);
                aliveGraceTimers.set(key, setTimeout(() => {
                    aliveGraceTimers.delete(key);
                    const player = state.players[slot];
                    if (player) {
                        player.isDead = true;
                        if (player.thingRef) player.thingRef.collected = true;
                    }
                    // setNetworkSlotOccupant emits a lobby-state change;
                    // Game's onLobbyChange subscriber repaints (the
                    // remaining connected joiners drop the departed
                    // peer's row to "WAITING FOR PLAYER" via that path).
                    setNetworkSlotOccupant(slot, 'empty');
                }, ALIVE_GRACE_MS));
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
    // orchestrator.dispatch({ type: 'world', cmd: 'showResults', args: [getResultsPayload()] }).
    // DM exit-switch
    // path funnels through the same endMatch.

}

// ── Boot ───────────────────────────────────────────────────────────────

/**
 * Master initialization — full game loop, plus the broadcast listener
 * that lets a client window join and receive a streamed view of one
 * pane.
 *
 * Layout (`?layout=kiosk | cad | visualize`, or `?kiosk` shorthand)
 * is read from `document.body.dataset.layout` rather than a parameter
 * so every consumer reads from the same place. Kiosk layout forces
 * deathmatch and bypasses the saved-mode restore — the installation
 * always boots into 2P split-screen regardless of what the last
 * interactive session left in localStorage.
 */
export async function initMaster({ playSlot = null, exportFormat = null } = {}) {
    const isKiosk = document.body.dataset.layout === 'kiosk';
    // DEV: load the debug system now (menu auto-opens). PROD: install the
    // window.debug accessor so it loads only when the user types `debug`.
    installDebugTrigger();

    // ?play=slot path — stand up the renderer infrastructure only,
    // then hand control to the recording player. We skip app.start
    // (which would create a Game, load a level, and start dispatching
    // its own envelopes) and the gameLoop kickoff at the end of this
    // function — the recording IS the envelope source, including the
    // initial loadMap that builds the scene. `exportFormat` (from
    // ?export=mp4 | webm) routes the player through MediaRecorder.
    if (playSlot) {
        applyMode('singleplayer', 'standalone');
        rendererManager.startCullingLoop({
            isAttract: () => false,
            getSpectatorActive: () => false,
        });
        hideInitialOverlay();
        // Player lives in the debug chunk — load it on demand for ?play=slot
        // so it never ships in the main bundle.
        const { play: playRecording } = await import('./debug/features/player.js');
        playRecording(playSlot, exportFormat);
        return;
    }

    // Wire action handlers BEFORE input modules emit anything. Inputs
    // produce events on the bus; handlers in src/actions/* subscribe to
    // them and dispatch into game functions.
    initActions();
    initKeyboardMouse();
    initTouchInput();
    initGamepadInput();
    // Remote input providers are registered lazily per slot on the first
    // ANALOG envelope from each peer — see [./input/remote.js](./input/remote.js).

    // Lobby controller — manages the press-to-claim UX, watches input
    // claims to drive the join-prompt overlay, and auto-starts the
    // match when all slots are claimed in Local DM.
    //
    // Local DM has no "externally claimed" slots: a connected Local DM secondary
    // is display-only and doesn't claim slot 1 — master's local kbm-B /
    // gamepad must do that explicitly. (The carried-over-claims
    // snapshot fires on every match-reset; see lobby-state.js.)

    // applyMode owns the cross-cutting "enter a mode" work that Game
    // doesn't replicate: state.gameMode/networkMode, body data
    // attributes, player count, audio config, signaling room, and
    // CSSRenderer reshaping. Game reads from state.gameMode (via the
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

    // Wake from attract through the Game's canonical restart path.
    // Read app.game at call time (not capture) so it stays correct
    // across game recreations on mode switches.
    setAttractWakeHandler((map) => app.game?.restartMatch(map));

    rendererManager.startCullingLoop({
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
