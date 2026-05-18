/**
 * Lobby screen — per-pane renderer for both Local DM and Network DM
 * variants.
 *
 * One world-kind command (showLobby) fans the master's
 * Game.getLobbyPayload() to every renderer on every window. Each
 * renderer's impl writes into its own pane (`renderer.paneEl`) using
 * `renderer.playerIndex` to know its slot. The impl branches on
 * `payload.variant`:
 *
 *   'local'   — Local DM. Writes `paneEl.dataset.claimState` to one
 *               of 'prompting' | 'ready' | 'waiting' | 'active'. CSS
 *               drives the `.join-prompt` / `.join-ready` overlay
 *               visibility off that attribute.
 *
 *   'network' — Network DM. Updates the `.pane-network-lobby`
 *               subtree inside the pane: per-slot `data-occupant`,
 *               labels, room code text + QR. Also writes
 *               `body.dataset.networkReady` when 2+ slots are
 *               occupied (per-pane impls write the same value
 *               idempotently in kiosk multi-pane mode).
 *
 * No game-side reads: the impl never imports state, claim-registry,
 * isMatchLobby, etc. Everything it needs is pre-derived in
 * Game.getLobbyPayload() and arrives via the payload. The match-reset
 * snapshot of carried-over claims lives in src/game/lobby-state.js;
 * the orchestrator.showLobby() trigger sites live in master.js / Game.
 */

import qrcode from 'qrcode-generator';

const MAX_SLOTS = 4;

/** showLobby world-command impl — per-pane via `renderer.paneEl`. */
export function showLobby(renderer, payload) {
    if (!payload) return;
    if (payload.variant === 'local') {
        renderLocalLobby(renderer, payload);
    } else if (payload.variant === 'network') {
        renderNetworkLobby(renderer, payload);
    }
}

/** hideLobby — no-op. CSS hides every lobby element when
 *  `body[data-game-state]` flips off LOBBY, so no per-pane teardown
 *  is needed today. Kept so the command has a real entry point. */
export function hideLobby(_renderer) {
    // intentionally empty
}

function renderLocalLobby(renderer, payload) {
    const slot = renderer.playerIndex;
    if (slot == null) return;

    let claimState;
    if (!payload.inLobby) {
        claimState = 'active';
    } else if (payload.slotsClaimed?.[slot]) {
        // Fresh claim (made this lobby session) gets the READY flash;
        // a claim that carried over from before match-reset behaves
        // like 'active' — no overlay, just normal scene.
        claimState = payload.slotsCarriedOver?.[slot] ? 'active' : 'ready';
    } else if (slot === payload.promptingSlot) {
        claimState = 'prompting';
    } else {
        claimState = 'waiting';
    }
    renderer.paneEl.dataset.claimState = claimState;
}

function renderNetworkLobby(renderer, payload) {
    const root = renderer.paneEl.querySelector('.pane-network-lobby');
    if (!root) return;

    // Level-name sprite (white WILV0N from the SP intermission set).
    // Same per-map source as the menu's level picker — empty src
    // hides the element via CSS for non-E1 episodes.
    const levelEl = root.querySelector('.network-lobby-level');
    if (levelEl) {
        const src = levelNameSpriteSrc(payload.mapCursor);
        if (src) {
            levelEl.src = src;
            levelEl.alt = payload.mapCursor ?? '';
        } else {
            levelEl.removeAttribute('src');
            levelEl.alt = '';
        }
    }

    for (let i = 0; i < MAX_SLOTS; i++) {
        const occupant = payload.slotOccupants?.[i] ?? 'empty';
        const row = root.querySelector(`.network-slot[data-slot="${i}"]`);
        if (row) row.dataset.occupant = occupant;
        const labelEl = root.querySelector(`.network-slot[data-slot="${i}"] .network-slot-label`);
        if (labelEl) labelEl.textContent = labelFor(occupant, i, payload.promptingSlot);
    }

    // Room code text + QR (master pane only; CSS hides on others).
    const codeEl = root.querySelector('.network-invite-code');
    if (codeEl) codeEl.textContent = payload.roomCode ?? '- - - -';
    const qrEl = root.querySelector('.network-invite-qr');
    if (qrEl) qrEl.innerHTML = payload.roomCode ? renderQrSvg(payload.roomCode) : '';

    // Window-level "PRESS FIRE TO START" gate. Per-pane impls write
    // the same value once each in kiosk multi-pane mode — idempotent.
    if (payload.canStart) {
        document.body.dataset.networkReady = 'true';
    } else {
        delete document.body.dataset.networkReady;
    }
}

function labelFor(occupant, slot, promptingSlot) {
    if (occupant !== 'empty') return `Player ${slot + 1} ready`;
    if (slot === promptingSlot) return 'Press button to join';
    return 'Waiting for player';
}

/** Map E1M{N} (N = 1..9) to its WILV0{N-1} sprite path. Returns null
 *  for map names that don't match the E1 episode (no sprite shipped).
 *  Same logic as src/renderer/screens/intermission.js. */
function levelNameSpriteSrc(mapName) {
    if (!mapName) return null;
    const match = /^E1M([1-9])$/.exec(mapName);
    if (!match) return null;
    const idx = Number(match[1]) - 1;
    return `/assets/intermission/WILV0${idx}.png`;
}

function renderQrSvg(code) {
    // Encode the join URL against the current location so the QR
    // points at the same Worker deployment (staging vs production).
    // scalable: true emits an SVG without fixed width/height so the
    // container's CSS sizing wins.
    const url = new URL(`?join=${encodeURIComponent(code)}`, location.href).href;
    const qr = qrcode(0, 'M'); // typeNumber=0 (auto), error level M
    qr.addData(url);
    qr.make();
    return qr.createSvgTag({ scalable: true, margin: 1 });
}
