/**
 * Post-match scoreboard.
 *
 * Built into every `.pane-win` element in the document — one per
 * pane (via the pane template). In normal / split-screen layouts pane
 * 0's `.pane-win` is `position: fixed; inset: 0` and covers the
 * viewport; pane 1's copy is hidden by the non-video-wall CSS rule.
 * In video-wall mode (≥24/9 aspect ratio) both copies become
 * `position: absolute` so each monitor gets its own bezel-safe overlay.
 * The same renderer paints every container.
 *
 * Visibility is driven by `body[data-game-state="ended"]` (set by
 * the game-state machine when `endMatch()` runs); this module only
 * owns the DOM structure inside the overlay.
 *
 * On a client window the same module renders the broadcasted snapshot
 * — the data shape is identical to what match.js produces, so there's
 * no master/client divergence here.
 *
 * Layout — CSS Grid, (N + 2) columns × (N + 1) rows:
 *
 *     [corner ]  [V₀ swatch] [V₁ swatch] ...  [TOTAL label]
 *     [K₀ swat]  [ k(0,0)  ] [ k(0,1)  ] ...  [  score₀  ]
 *     [K₁ swat]  [ k(1,0)  ] [ k(1,1)  ] ...  [  score₁  ]
 *     ...
 *
 * Diagonal cells `k(i,i)` are suicides — they display the count like any
 * other cell. They subtract from the row's TOTAL (matching original
 * DOOM scoring), so a player who suicides more than they frag ends up
 * with a negative total — that's intentional, not a bug.
 */

import { registerOverlayImpl } from '../renderer/commands.js';

const CELL_WIDTH = 2;
const TOTAL_WIDTH = 2;

/**
 * Slot index → display name. The scoreboard banner reads "RED WINS" /
 * "GREEN WINS" to match the visual identity each pane carries (STFB
 * swatches, sprite tint). The lobby's READY overlay used to follow the
 * same convention but is now a generic red "READY!" — keeping this
 * table local since only the banner reads it.
 */
const PLAYER_COLOR_NAME = ['GREEN', 'RED', 'INDIGO', 'BROWN'];

/**
 * Render the scoreboard into every `.pane-win` element in the DOM.
 * @param {{
 *   mapName: string,
 *   scores: number[],
 *   kills: number[][],
 *   winnerIndex: number,
 * }} data
 */
export function showScoreboard(data) {
    for (const container of document.querySelectorAll('.pane-win')) {
        container.replaceChildren(buildScoreboardNode(data));
    }
}

/** Clear the scoreboard out of every overlay. */
export function hideScoreboard() {
    for (const container of document.querySelectorAll('.pane-win')) {
        container.replaceChildren();
    }
}

// ── L2.8 renderer-command entry points ─────────────────────────────────
// Game pushes showResults / hideResults through the orchestrator
// (see src/renderer/commands.js). Same strangler-fig shape as L2.6 /
// L2.7: legacy match.js::endMatch still calls showScoreboard directly;
// Game's push runs in parallel once L2.9 wires it. L4 cuts over.

/** Renderer-command impl for showResults. Delegates to showScoreboard
 *  with whatever payload Game builds (typically scores, kills,
 *  winnerIndex, mapName). Idempotent against repeated calls — DOM is
 *  fully rebuilt each time via replaceChildren. Not exported — only
 *  the registry below ever calls it. */
function renderResults(payload) {
    showScoreboard(payload);
}

/** Renderer-command impl for hideResults. Delegates to hideScoreboard.
 *  Not exported — only the registry below ever calls it. */
function clearResults() {
    hideScoreboard();
}

// L4.2 — register with the late-binding overlay registry.
registerOverlayImpl('showResults', renderResults);
registerOverlayImpl('hideResults', clearResults);

function buildScoreboardNode({ scores, kills, winnerIndex }) {
    const root = document.createElement('div');
    root.className = 'scoreboard';

    const subtitle = document.createElement('img');
    subtitle.className = 'scoreboard-subtitle';
    subtitle.src = '/assets/intermission/WIF.png';
    subtitle.alt = 'FINISHED';
    root.appendChild(subtitle);

    const banner = document.createElement('div');
    banner.className = 'scoreboard-banner';
    banner.textContent = winnerIndex >= 0
        ? `${PLAYER_COLOR_NAME[winnerIndex] ?? `PLAYER ${winnerIndex + 1}`} WINS`
        : 'TIE';
    root.appendChild(banner);

    root.appendChild(buildGrid({ scores, kills }));
    return root;
}

function buildGrid({ scores, kills }) {
    const n = scores.length;
    const grid = document.createElement('div');
    grid.className = 'scoreboard-grid';
    grid.style.setProperty('--player-count', String(n));

    // Header row: empty corner, victim swatches, TOTAL label. The
    // `scoreboard-swatch-victim` class lets CSS overlay the bloody face
    // on the swatch matching the local pane's player.
    appendCell(grid, 'scoreboard-corner');
    for (let v = 0; v < n; v++) {
        appendCell(grid, `scoreboard-swatch scoreboard-swatch-victim player-${v}`);
    }
    const totalLabel = document.createElement('div');
    totalLabel.className = 'scoreboard-total-label';
    const totalImg = document.createElement('img');
    totalImg.src = '/assets/intermission/WIMSTT.png';
    totalImg.alt = 'TOTAL';
    totalLabel.appendChild(totalImg);
    grid.appendChild(totalLabel);

    // Per-killer rows. `scoreboard-swatch-killer` lets CSS overlay the
    // healthy face on the swatch matching the local pane's player.
    for (let k = 0; k < n; k++) {
        appendCell(grid, `scoreboard-swatch scoreboard-swatch-killer player-${k}`);
        for (let v = 0; v < n; v++) {
            appendCell(grid, 'scoreboard-cell', pad(kills[k][v], CELL_WIDTH));
        }
        appendCell(grid, 'scoreboard-cell scoreboard-total', pad(scores[k], TOTAL_WIDTH));
    }

    return grid;
}

function appendCell(parent, className, text) {
    const el = document.createElement('div');
    el.className = className;
    if (text != null) el.textContent = text;
    parent.appendChild(el);
}

function pad(n, width) {
    const sign = n < 0 ? '-' : '';
    const abs = Math.abs(n).toString().padStart(width - sign.length, '0');
    return sign + abs;
}
