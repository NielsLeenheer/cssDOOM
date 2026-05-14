/**
 * Pre-action gates — high-priority handlers that consume FIRE_DOWN /
 * USE events when the game is in a transient state (scoreboard,
 * intermission, lobby press-to-claim, dead respawn). Each gate returns
 * `true` to stop downstream handlers (fire / use / etc.) from running.
 *
 * Priority order (highest runs first):
 *
 *   INTERMISSION    — fire dismisses the SP intermission.
 *   MATCH_END       — fire restarts the DM match after scoreboard.
 *   MENU_OPEN       — block all gameplay actions when the menu is up.
 *   NETWORK_START   — host's fire starts a Network DM match once ≥ 2 slots filled.
 *   CLAIM           — first press from an unbound device claims a slot in DM lobby.
 *   DEAD_RESPAWN    — fire respawns / restarts after the death cooldown.
 *
 * Attract wake-up is handled INSIDE each input module (`pingActivity()`
 * at the top of every event listener) rather than as a gate here — the
 * input module returns early without emitting, so the bus never sees
 * the wakeup press.
 *
 * Numerical priority values are spread out so future gates can slot in
 * without renumbering everything.
 */

import { state } from '../game/state.js';
import { isMenuOpen } from '../ui/menu.js';
import { isMatchEnded, restartMatch, startMatch, isMatchLobby } from '../game/match.js';
import { isIntermissionActive, dismissIntermission } from '../ui/intermission.js';
import { spawnPlayer } from '../game/player/spawn.js';
import { tryClaimSlot } from '../input/claim-registry.js';
import { currentMap, loadMap } from '../shared/maps.js';
import { countOccupied as countNetworkLobbyOccupied } from '../ui/network-lobby.js';
import * as A from '../input/actions.js';
import { on } from '../input/event-bus.js';

const DM_RESPAWN_COOLDOWN_MS = 2000;
const SP_RESTART_COOLDOWN_MS = 4000;

export const GATE_PRIORITY = {
    INTERMISSION:  900,
    MATCH_END:     800,
    MENU_OPEN:     700,
    NETWORK_START: 650,
    CLAIM:         600,
    DEAD_RESPAWN:  500,
};

export function initGates() {
    // ── Intermission dismiss — SP only.
    on(A.FIRE_DOWN, () => {
        if (!isIntermissionActive()) return;
        dismissIntermission();
        return true;
    }, { priority: GATE_PRIORITY.INTERMISSION });

    // ── Match-end restart — DM only.
    on(A.FIRE_DOWN, () => {
        if (!isMatchEnded()) return;
        restartMatch();
        return true;
    }, { priority: GATE_PRIORITY.MATCH_END });

    // ── Menu open — block gameplay actions while the menu is up. The
    // MENU_TOGGLE action skips this gate; otherwise the player couldn't
    // close the menu with the same button.
    const menuBlock = () => {
        if (isMenuOpen()) return true;
    };
    on(A.FIRE_DOWN,     menuBlock, { priority: GATE_PRIORITY.MENU_OPEN });
    on(A.FIRE_UP,       menuBlock, { priority: GATE_PRIORITY.MENU_OPEN });
    on(A.USE,           menuBlock, { priority: GATE_PRIORITY.MENU_OPEN });
    on(A.WEAPON_PREV,   menuBlock, { priority: GATE_PRIORITY.MENU_OPEN });
    on(A.WEAPON_NEXT,   menuBlock, { priority: GATE_PRIORITY.MENU_OPEN });
    on(A.WEAPON_SELECT, menuBlock, { priority: GATE_PRIORITY.MENU_OPEN });

    // ── Network DM host-fire-to-start — when ≥ 2 slots are filled in
    // the network lobby and slot 0's input fires, transition LOBBY →
    // ACTIVE. Must run BEFORE the CLAIM gate so a host who already
    // owns slot 0 doesn't get a phantom claim attempt. Must also run
    // after MENU_OPEN so an open menu can't trigger the start.
    on(A.FIRE_DOWN, ({ slot }) => {
        if (state.networkMode !== 'host') return;
        if (!isMatchLobby()) return;
        if (slot !== 0) return;
        if (countNetworkLobbyOccupied() < 2) return;
        startMatch();
        return true;
    }, { priority: GATE_PRIORITY.NETWORK_START });

    // ── Press-to-claim — first discrete press from an unbound device in
    // a DM lobby promotes the device into a slot. Also active for Network
    // DM's kiosk variant (slots 0 and 1 claimable; non-kiosk uses
    // setDefaultSlot(0) so event.slot is never null there and the
    // function passes through). Consume so the same press doesn't
    // immediately fire or use.
    const tryClaim = (event) => {
        if (event.slot != null) return;             // already claimed → pass through
        if (state.gameMode !== 'deathmatch') return;
        if (event.deviceId == null) return;
        if (isMatchEnded()) return;                  // match-end gate handles its own
        const claimed = tryClaimSlot(event.deviceId);
        // Whether or not the claim succeeded (slot full → null), consume
        // so the wake-up press doesn't fire weapons or open doors.
        return true;
    };
    on(A.FIRE_DOWN,     tryClaim, { priority: GATE_PRIORITY.CLAIM });
    on(A.USE,           tryClaim, { priority: GATE_PRIORITY.CLAIM });
    on(A.WEAPON_PREV,   tryClaim, { priority: GATE_PRIORITY.CLAIM });
    on(A.WEAPON_NEXT,   tryClaim, { priority: GATE_PRIORITY.CLAIM });
    on(A.WEAPON_SELECT, tryClaim, { priority: GATE_PRIORITY.CLAIM });

    // ── Dead respawn — fire after the cooldown respawns the player
    // (DM) or reloads the level (SP). Consume so the same press doesn't
    // also fire a phantom weapon.
    on(A.FIRE_DOWN, ({ slot }) => {
        if (slot == null) return;
        const player = state.players[slot];
        if (!player?.isDead) return;
        const cooldown = state.gameMode === 'deathmatch'
            ? DM_RESPAWN_COOLDOWN_MS
            : SP_RESTART_COOLDOWN_MS;
        if (performance.now() - player.deathTime <= cooldown) return true;
        if (state.gameMode === 'deathmatch') {
            spawnPlayer(player);
        } else {
            loadMap(currentMap);
        }
        return true;
    }, { priority: GATE_PRIORITY.DEAD_RESPAWN });

}

