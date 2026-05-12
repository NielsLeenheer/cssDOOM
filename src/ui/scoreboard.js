/**
 * Post-match scoreboard.
 *
 * Built into the existing `.dm-win-overlay` containers — one global
 * `#dm-win-overlay` for normal/split-screen layouts, plus per-pane
 * `.pane-win` copies that take over in video-wall mode (≥24/9 aspect
 * ratio) so each monitor gets its own copy instead of one straddling
 * the bezel. The same renderer paints every container.
 *
 * Visibility is driven by `body[data-match-ended="true"]` (set in
 * match.js); this module only owns the DOM structure inside the
 * overlay.
 *
 * On the secondary window the same module renders the broadcasted
 * snapshot — the data shape is identical to what match.js produces, so
 * there's no master/secondary divergence here.
 *
 * Layout — CSS Grid, (N + 2) columns × (N + 1) rows:
 *
 *     [corner ]  [V₀ swatch] [V₁ swatch] ...  [TOTAL label]
 *     [K₀ swat]  [ k(0,0)  ] [ k(0,1)  ] ...  [  score₀  ]
 *     [K₁ swat]  [ k(1,0)  ] [ k(1,1)  ] ...  [  score₁  ]
 *     ...
 *
 * Diagonal cells (suicides) are dimmed via `.scoreboard-diagonal`.
 */

const CELL_WIDTH = 2;
const TOTAL_WIDTH = 2;

/**
 * Slot index → display name. UX refers to players by color rather than
 * slot number ("RED WINS", "GREEN READY") to match the visual identity
 * each pane already carries — STFB swatches in the HUD, color-tinted
 * READY overlays, color-tinted sprite billboards. Exported so lobby
 * code can use the same names.
 */
export const PLAYER_COLOR_NAME = ['GREEN', 'RED', 'INDIGO', 'BROWN'];

/**
 * Render the scoreboard into every `.dm-win-overlay` element in the DOM.
 * @param {{
 *   mapName: string,
 *   scores: number[],
 *   kills: number[][],
 *   winnerIndex: number,
 * }} data
 */
export function showScoreboard(data) {
    for (const container of document.querySelectorAll('.dm-win-overlay')) {
        container.replaceChildren(buildScoreboardNode(data));
    }
}

/** Clear the scoreboard out of every overlay. */
export function hideScoreboard() {
    for (const container of document.querySelectorAll('.dm-win-overlay')) {
        container.replaceChildren();
    }
}

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

    // Header row: empty corner, victim swatches, TOTAL label.
    appendCell(grid, 'scoreboard-corner');
    for (let v = 0; v < n; v++) {
        appendCell(grid, `scoreboard-swatch player-${v}`);
    }
    const totalLabel = document.createElement('div');
    totalLabel.className = 'scoreboard-total-label';
    const totalImg = document.createElement('img');
    totalImg.src = '/assets/intermission/WIMSTT.png';
    totalImg.alt = 'TOTAL';
    totalLabel.appendChild(totalImg);
    grid.appendChild(totalLabel);

    // Per-killer rows.
    for (let k = 0; k < n; k++) {
        appendCell(grid, `scoreboard-swatch player-${k}`);
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
