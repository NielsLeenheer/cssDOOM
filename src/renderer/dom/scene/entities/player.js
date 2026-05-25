/**
 * Player entity — construction and visual state.
 *
 * Each runtime function takes a renderer instance and toggles classes on
 * its `rendererEl`. Mirror-mode fan-out (pane 1 mirroring player 0's
 * dead/moving/keys state) is handled at the orchestrator dispatch layer —
 * every renderer whose `playerIndex` matches the called playerIndex
 * receives the call.
 *
 * The spectator sprite (#player) is built into every renderer's scene
 * fragment by buildPlayer; each pane has its own copy.
 */

export function buildPlayer(ctx) {
    const player = document.createElement('div');
    player.id = 'player';
    const marker = document.createElement('div');
    marker.className = 'marker';
    player.appendChild(marker);
    const playerSprite = document.createElement('div');
    playerSprite.className = 'sprite';
    player.appendChild(playerSprite);
    ctx.fragment.appendChild(player);
}

export function setPlayerDead(renderer, dead) {
    renderer.rendererEl.classList.toggle('dead', dead);
}

export function setPlayerMoving(renderer, moving) {
    renderer.rendererEl.classList.toggle('moving', moving);
}

