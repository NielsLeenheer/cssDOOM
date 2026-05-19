/**
 * Mode coordinator — "we are now playing in gameMode X with networkMode Y."
 *
 * Two orthogonal axes:
 *
 *   gameMode    — 'singleplayer' | 'deathmatch'
 *                  The rules of play. Everything game-side (spawn, respawn,
 *                  scoring, item respawn, all-keys-on-DM-spawn, etc.) keys
 *                  off this.
 *
 *   networkMode — 'standalone' | 'host' | 'client'
 *                  The transport context. 'standalone' = no signaling room
 *                  open; the BroadcastChannel for a same-machine Local DM
 *                  secondary is always available regardless. 'host' = master
 *                  with a Network DM signaling room open accepting WebRTC
 *                  remotes. 'client' = this window is connected to a master
 *                  (Local DM secondary OR Network DM remote, both come
 *                  through the same code path).
 *
 * Network DM is just deathmatch + host. A Network DM remote is deathmatch
 * + client. The user-facing menu still calls them "Single Player" /
 * "Deathmatch" / "Network DM" — `MODE_PRESETS` below maps those button
 * names onto the two-axis representation.
 *
 * applyMode() owns the cross-cutting work of entering a mode: writes
 * `state.gameMode` + `state.networkMode` + `body.dataset.gameMode` +
 * `body.dataset.networkMode`, sizes `state.players`, resets / clears the
 * match struct, picks the default input-slot routing, configures audio,
 * opens / closes the network signaling room, asks the renderer to
 * reshape its DomRenderer set. Called from boot (master.js / client.js)
 * and from menu mode-switch handlers (ui/menu.js's switchMode).
 *
 * Nothing here is UI: the menu just exposes `switchMode(name)` via buttons.
 */

import { state } from './game/state.js';
import { Player } from './game/player/player.js';
import { currentMap } from './shared/maps/index.js';
import { domRendererManager } from './renderer/dom-renderer-manager.js';
import { resetMatch, clearMatch } from './game/match.js';
import { setDefaultSlot, unclaimSlotsNotIn } from './input/claim-registry.js';
import {
    resetNetworkSlotState,
    setNetworkSlotOccupant,
    setLocallyClaimableSlotsState,
} from './game/lobby-state.js';
import { openRoom, closeRoom } from './network-host.js';
import { orchestrator } from './orchestrator.js';

const MODE_STORAGE_KEY = 'cssdoom-game-mode';

/**
 * Translation from the menu's three logical mode names to the two-axis
 * representation. The menu still calls them by their user-facing names
 * (the strings on the buttons), so `switchMode('network')` does the
 * right thing.
 */
const MODE_PRESETS = {
    singleplayer: { gameMode: 'singleplayer', networkMode: 'standalone' },
    deathmatch:   { gameMode: 'deathmatch',   networkMode: 'standalone' },
    network:      { gameMode: 'deathmatch',   networkMode: 'host'       },
};

/**
 * Reads the saved gameMode from localStorage, falling back to
 * 'singleplayer'. networkMode is intentionally not persisted — Network
 * DM rooms don't survive a reload, so persisting 'host' would leave the
 * user in a useless empty network lobby on next boot.
 */
export function loadSavedGameMode() {
    const saved = localStorage.getItem(MODE_STORAGE_KEY);
    return saved === 'deathmatch' ? 'deathmatch' : 'singleplayer';
}

/**
 * Grow state.players to at least `n` entries by constructing real
 * Player instances for any missing slot. Idempotent — never shrinks,
 * never overwrites an existing Player. Callers that also want to shrink
 * follow with `state.players.length = n`.
 */
export function ensurePlayerCount(n) {
    while (state.players.length < n) {
        state.players.push(new Player(state.players.length));
    }
    for (let i = 0; i < n; i++) {
        if (!state.players[i]) state.players[i] = new Player(i);
    }
}

/**
 * Apply a mode to global state without triggering a map reload. Shared
 * between boot-time restore (master.js / client.js initMaster /
 * initClientWindow) and runtime mode switches (menu.js switchMode).
 */
export function applyMode(gameMode, networkMode = 'standalone') {
    state.gameMode = gameMode;
    state.networkMode = networkMode;
    document.body.dataset.gameMode = gameMode;
    document.body.dataset.networkMode = networkMode;

    // Close any signaling room that was open if we're not the host now.
    // closeRoom is idempotent / no-op when nothing is open.
    if (networkMode !== 'host') closeRoom();

    // Size the local roster + configure lobby state per mode.
    if (gameMode === 'singleplayer') {
        // SP keeps exactly one local player; SP devices auto-route to slot 0.
        state.players.length = 1;
        clearMatch();
        setDefaultSlot(0);
    } else if (gameMode === 'deathmatch' && networkMode === 'standalone') {
        // Local DM: 2-player split-screen on one machine. Both slots are
        // press-to-claim — no default.
        ensurePlayerCount(2);
        state.players.length = 2;
        resetMatch();
        setDefaultSlot(null);
    } else if (gameMode === 'deathmatch' && networkMode === 'host') {
        // Network DM host: kiosk shows 2 local press-to-claim slots
        // (locals at 0+1, remotes at 2+3); non-kiosk shows 1 auto-claimed
        // local at slot 0 (remotes at 1..3). Remote slots grow
        // state.players on bind — see master.js onReady.
        const isKiosk = document.body.classList.contains('kiosk');
        const localCount = isKiosk ? 2 : 1;
        ensurePlayerCount(localCount);
        state.players.length = localCount;
        resetMatch();
        setDefaultSlot(isKiosk ? null : 0);
        // Lobby state setup for a fresh Network DM session. The
        // claim-registry purge drops any sessionStorage claim bound
        // to a slot outside the allowed set, so a kiosk-DM session
        // that claimed gamepad-1 → slot 1 can't leak into a
        // subsequent non-kiosk Network DM where slot 1 is remote-only.
        const claimable = isKiosk ? [0, 1] : [];
        resetNetworkSlotState();
        setLocallyClaimableSlotsState(claimable);
        unclaimSlotsNotIn(claimable);
        if (!isKiosk) setNetworkSlotOccupant(0, 'host');
        // Tell the orchestrator which slot is the FIRST a joining
        // remote may take — without this it defaults to 1, which on
        // kiosk Network DM (locals at 0+1) would steal slot 1 from
        // the second local pane the first time a joiner connects.
        orchestrator.setMinRemoteSlot(localCount);
        // Push the new lobby state out to every renderer (master's
        // local panes + any sinks that are already up).
        orchestrator.showLobby();
        openRoom();
    } else if (gameMode === 'deathmatch' && networkMode === 'client') {
        // Client window. The remote's actual identity (its slot) is set
        // by client.js after the join handshake; here we just shape the
        // mode globally. Local player count stays at 1 — the client's
        // simulation only needs a placeholder for its own slot.
        state.players.length = 1;
        resetMatch();
        setDefaultSlot(0);
    }

    // Reshape the master's local DomRenderers + audio listeners for
    // this mode. Client windows skip both: they manage exactly one
    // DomRenderer for their master-assigned slot (handled by
    // RemoteGame._onAck → domRendererManager.resetToJoinerSlot), and
    // their audio listener also lives at that slot (set by _onAck
    // after the slot is known — applyMode runs BEFORE the join
    // handshake assigns one, so configureAudio here would land at the
    // wrong index).
    if (!document.body.classList.contains('client-window')) {
        domRendererManager.reshape(gameMode, networkMode);
        // Master plays audio for every local player. SP gets one
        // bearing-pan listener; DM gets two pane-side-locked listeners
        // (slot 0 left, slot 1 right). Suppressed slots (Network DM
        // remotes that play their own audio) are filtered inside
        // _rebuildAudioTargets.
        orchestrator.configureAudio([...state.players.keys()]);
    }
}

/**
 * Switch modes at runtime via a user-facing mode name. Persists local
 * gameplay modes (singleplayer / deathmatch) to localStorage so a
 * refresh restores them; 'network' is session-only.
 */
export async function switchMode(name) {
    const preset = MODE_PRESETS[name];
    if (!preset) {
        console.warn('switchMode: unknown mode name', name);
        return;
    }

    // Spectator is single-player only — drop out of it before swapping
    // away so its body classes and scene transforms don't bleed elsewhere.
    if (preset.gameMode !== 'singleplayer'
        && document.body.classList.contains('spectator')) {
        window.spectate?.();
    }

    applyMode(preset.gameMode, preset.networkMode);
    if (preset.networkMode === 'standalone') {
        localStorage.setItem(MODE_STORAGE_KEY, preset.gameMode);
    }

    // Force a full game state reset by marking player 0 dead before reload.
    // Level.load's resetGameState path then resets every player's stats.
    state.players[0].isDead = true;

    // Replace the held Game with a fresh one for the new mode. Without
    // this the boot Game keeps its original gameMode and Level
    // subscription — leading to Game._onLevelComplete branching the
    // wrong way on subsequent level transitions (e.g. kiosk-boot DM
    // → menu SP would still fire showResults on SP exit, because
    // Game.gameMode stays 'deathmatch'). Reconstructing via
    // app.startLocalGame:
    //   - tears down the old Game (Game.stop nulls level, hides
    //     overlays, transitions to ENDED);
    //   - constructs a new Game with gameMode/networkMode matching
    //     the menu pick;
    //   - kicks off Game.start which for SP awaits beginPlay (loads
    //     a fresh Level for currentMap) and for Local DM awaits
    //     _preloadLevel.
    // applyMode above still runs for its side effects (renderer
    // reshape, audio reconfig, network signaling room, body data
    // attributes, state.players sizing) — Game doesn't replicate
    // those today.
    // window.app is set in app.js's boot, before any UI / menu code
    // can run. If it's missing here, that's a boot-order bug we want
    // to surface with a real TypeError rather than mask with a
    // fallback that constructs a Level outside Game's lifecycle.
    await window.app.startLocalGame({
        gameMode: preset.gameMode,
        networkMode: preset.networkMode,
        skillLevel: state.skillLevel ?? 1,
        rules: null,
        startMap: currentMap ?? 'E1M1',
    });
}
