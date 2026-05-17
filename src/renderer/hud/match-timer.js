/**
 * Match countdown timer — m:ss readout shown in the last 60 s of a DM
 * match. Master computes the value in match.js and fans it through the
 * `setMatchTimer` overlay command so every connected client mirrors
 * the same readout without each running its own clock (and risking
 * drift over a multi-minute match).
 *
 * Payload is the text to display, or null to hide. Hiding also clears
 * `body[data-timer-active]` which the CSS uses to fade the readout
 * in/out.
 */

import { registerOverlayImpl } from '../commands.js';

export function applyMatchTimer(text) {
    if (text) {
        for (const el of document.querySelectorAll('.pane-timer')) el.textContent = text;
        if (document.body.dataset.timerActive !== 'true') {
            document.body.dataset.timerActive = 'true';
        }
    } else {
        if (document.body.dataset.timerActive === 'true') {
            delete document.body.dataset.timerActive;
        }
        for (const el of document.querySelectorAll('.pane-timer')) el.textContent = '';
    }
}

registerOverlayImpl('setMatchTimer', applyMatchTimer);
