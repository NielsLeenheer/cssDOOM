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
import { isMatchEnded, restartMatch } from '../game/match.js';
import { isIntermissionActive, dismissIntermission } from '../ui/intermission.js';
import { spawnPlayer } from '../game/player/spawn.js';
import { orchestrator } from '../renderer/orchestrator.js';
import { currentMap, loadMap } from '../shared/maps.js';
import * as A from '../input/actions.js';
import { on } from '../input/event-bus.js';

const DM_RESPAWN_COOLDOWN_MS = 2000;
const SP_RESTART_COOLDOWN_MS = 4000;

export const GATE_PRIORITY = {
    INTERMISSION: 900,
    MATCH_END:    800,
    MENU_OPEN:    700,
    CLAIM:        600,
    DEAD_RESPAWN: 500,
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

    // ── Press-to-claim — first discrete press from an unbound device in
    // a DM lobby promotes the device into a slot. Consume so the same
    // press doesn't immediately fire or use.
    const tryClaim = (event) => {
        if (event.slot != null) return;             // already claimed → pass through
        if (state.mode !== 'deathmatch') return;    // SP uses default-slot fallback
        if (event.deviceId == null) return;
        if (isMatchEnded()) return;                  // match-end gate handles its own
        const claimed = orchestrator.tryClaimSlot(event.deviceId);
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
        const cooldown = state.mode === 'deathmatch'
            ? DM_RESPAWN_COOLDOWN_MS
            : SP_RESTART_COOLDOWN_MS;
        if (performance.now() - player.deathTime <= cooldown) return true;
        if (state.mode === 'deathmatch') {
            spawnPlayer(player);
        } else {
            loadMap(currentMap);
        }
        return true;
    }, { priority: GATE_PRIORITY.DEAD_RESPAWN });

}

