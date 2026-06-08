/**
 * Match countdown timer — m:ss readout shown in the last 60 s of a DM
 * match. Master computes the value in match.js and fans it through the
 * `showTimer` world command so every connected client mirrors the same
 * readout without each running its own clock (and risking drift over a
 * multi-minute match).
 *
 * Text is the value to display, or null/empty to hide. The CSS reads
 * the text presence directly (`.pane-timer:not(:empty)`) — no
 * separate visibility flag needed.
 */

export function showTimer(renderer, text) {
    const el = renderer.paneEl.querySelector('.pane-timer');
    if (el) el.textContent = text || '';
}
