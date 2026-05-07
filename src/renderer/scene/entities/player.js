/**
 * Player entity — construction and visual state.
 *
 * Per-player: state classes (.dead, .moving, .has-{color}-key) are toggled on
 * each pane's .renderer in dom.renderers[playerIndex]. The spectator sprite
 * (#player) lives in dom.scenes[0] only; spectator mode is single-player and
 * is disabled in deathmatch.
 */

import { dom } from '../../dom.js';

export function buildPlayer() {
    const player = document.createElement('div');
    player.id = 'player';
    const marker = document.createElement('div');
    marker.className = 'marker';
    player.appendChild(marker);
    const playerSprite = document.createElement('div');
    playerSprite.className = 'sprite';
    player.appendChild(playerSprite);
    // Spectator-only sprite — single instance in pane 0.
    dom.scenes[0].appendChild(player);
}

export function setPlayerDead(playerIndex, dead) {
    dom.renderers[playerIndex].classList.toggle('dead', dead);
}

export function setPlayerMoving(playerIndex, moving) {
    dom.renderers[playerIndex].classList.toggle('moving', moving);
}

export function collectKey(playerIndex, color) {
    dom.renderers[playerIndex].classList.add(`has-${color}-key`);
}

export function clearKeys(playerIndex) {
    dom.renderers[playerIndex].classList.remove('has-blue-key', 'has-yellow-key', 'has-red-key');
}
