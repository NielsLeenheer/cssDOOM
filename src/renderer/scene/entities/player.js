/**
 * Player entity — construction and visual state.
 *
 * Per-player: state classes (.dead, .moving, .has-{color}-key) are toggled on
 * each pane's .renderer in dom.renderers[playerIndex]. In mirror mode,
 * viewportsForEffect() fans out player 0's state to pane 1 too so the
 * mirror pane's HUD/visuals match. The spectator sprite (#player) lives in
 * dom.scenes[0] only; spectator mode is single-player and is disabled in
 * deathmatch.
 */

import { dom } from '../../dom.js';
import { viewportsForEffect } from '../scene.js';

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
    for (const i of viewportsForEffect(playerIndex)) {
        dom.renderers[i].classList.toggle('dead', dead);
    }
}

export function setPlayerMoving(playerIndex, moving) {
    for (const i of viewportsForEffect(playerIndex)) {
        dom.renderers[i].classList.toggle('moving', moving);
    }
}

export function collectKey(playerIndex, color) {
    for (const i of viewportsForEffect(playerIndex)) {
        dom.renderers[i].classList.add(`has-${color}-key`);
    }
}

export function clearKeys(playerIndex) {
    for (const i of viewportsForEffect(playerIndex)) {
        dom.renderers[i].classList.remove('has-blue-key', 'has-yellow-key', 'has-red-key');
    }
}
