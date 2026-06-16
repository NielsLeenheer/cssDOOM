/**
 * Player entity — construction and visual state.
 *
 * Each runtime function takes a renderer instance and toggles classes on
 * its `rendererEl`. Mirror-mode fan-out (pane 1 mirroring player 0's
 * dead/moving/keys state) is handled at the orchestrator dispatch layer —
 * every renderer whose `playerIndex` matches the called playerIndex
 * receives the call.
 *
 * `#player` is observer chrome only — the top-down FOV-arc marker. It is
 * built into every renderer's scene fragment by buildPlayer; each pane has
 * its own copy. The player's BODY is the standard DM billboard
 * (createPlayerSprite), revealed in spectator/axis panes — `#player` carries
 * no sprite of its own.
 */

export function buildPlayer(ctx) {
    const player = document.createElement('div');
    player.id = 'player';
    const marker = document.createElement('div');
    marker.className = 'marker';
    player.appendChild(marker);
    ctx.fragment.appendChild(player);
}

export function setPlayerDead(renderer, dead) {
    renderer.rendererEl.classList.toggle('dead', dead);
}

export function setPlayerMoving(renderer, moving) {
    renderer.rendererEl.classList.toggle('moving', moving);
}

