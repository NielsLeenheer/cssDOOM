/**
 * Sectors — dissect a level into its surfaces for the talk's "anatomy of a
 * sector" build-up. Pure DOM toggles on the .sector#s{id} containers; the
 * motion / fade / highlight live in CSS (features/sectors.css + the surface
 * transforms). Spans every pane (per-pane DOM duplication is intentional).
 * With no id, hide / show / explode / … act on every sector.
 *
 * A shared feature: console exposes these as debug.sectors.*.
 */

const sectorEls = (id) =>
    document.querySelectorAll(id == null ? '.sector' : `.sector#s${id}`);
const allSectors = () => document.querySelectorAll('.sector');

/** Get a sector's DOM element (the `.sector#s{id}` container) to poke at
 *  directly — add classes, set custom props, etc. Returns the first match (the
 *  SP pane); for every pane use document.querySelectorAll(`.sector#s${id}`). */
export const get = (id) => sectorEls(id)[0] ?? null;

/** Hide a sector outright (display:none via the `hidden` attribute). */
export const hide = (id) => sectorEls(id).forEach(el => el.setAttribute('hidden', ''));

/** Reveal a sector — clears both hide() (the `hidden` attribute) and only()'s
 *  fade (the `.faded` class), so it shows regardless of how it was hidden. */
export const show = (id) => sectorEls(id).forEach(el => {
    el.removeAttribute('hidden');
    el.classList.remove('faded');
});

/** Animate a sector apart so its construction is visible — walls shrink in
 *  place while floors/ceilings shrink and slide apart (down/up). CSS handles
 *  the motion (per-surface --explode-scale / --explode-dist); call reset() to
 *  re-assemble. */
export const explode = (id) => sectorEls(id).forEach(el => el.classList.add('exploded'));

/** Reverse of explode — re-assemble the sector back to normal (animated). */
export const implode = (id) => sectorEls(id).forEach(el => el.classList.remove('exploded'));

/** Fade every sector EXCEPT the given one(s) to transparent, so they stand
 *  alone. Pass one or more ids — only(29) or only(29, 32). At least one id is
 *  required; surfaces fade via opacity (see sectors.css). */
export const only = (...ids) => {
    const keep = new Set(ids.map(id => `s${id}`));
    allSectors().forEach(el => el.classList.toggle('faded', !keep.has(el.id)));
};

/** Rotate a sector's walls, floors and ceilings to face the camera (animated).
 *  Meant to run after explode(id) — the surfaces billboard at their exploded
 *  positions. CSS handles the motion (transition on --billboard). */
export const billboard = (id) => sectorEls(id).forEach(el => el.classList.add('billboarded'));

// Restore a sector's renderer --light (saved by highlight()); no-op if it
// wasn't overridden.
const restoreSectorLight = (el) => {
    const saved = el.dataset.litLight;
    if (saved === undefined) return;
    if (saved) el.style.setProperty('--light', saved); else el.style.removeProperty('--light');
    delete el.dataset.litLight;
};

/** Highlight a sector — flood its walls / floors / ceilings with a solid accent
 *  (#F8BA00), drop their textures, and lift its base brightness to full so it
 *  pops. The light-fx animations (blink / glow / flicker) still drive --light,
 *  so dynamic lighting keeps playing — only the static dim level is overridden.
 *  With no id, every sector. (CSS: `.sector.highlighted` in sectors.css.) */
export const highlight = (id) => sectorEls(id).forEach(el => {
    el.classList.add('highlighted');
    // --light is set inline by the renderer; an fx animation (if any) overrides
    // the inline value, so setting it to 1 here keeps fx while flooring the base.
    if (el.dataset.litLight === undefined) el.dataset.litLight = el.style.getPropertyValue('--light');
    el.style.setProperty('--light', '1');
});

/** Remove a sector highlight (or all) — restores the renderer's brightness. */
export const unhighlight = (id) => sectorEls(id).forEach(el => {
    el.classList.remove('highlighted');
    restoreSectorLight(el);
});

/** Lay a grid copy of a sector's floor just BELOW the real (clipped, textured)
 *  one, with the clip removed so the whole bounding rectangle shows: the texture
 *  covers the sector polygon on top, the grid + dotted border reveal the
 *  clipped-away "negative" space around it. Fades in (the grid rides the sector's
 *  surface opacity transition, see sectors.css). With no id, every floor; calling
 *  again is a no-op where a grid already exists. */
export const showFloorGrid = (id) => {
    const realSel = id == null ? '.floor[data-sector]:not(.floor-grid)' : `.floor[data-sector="${id}"]:not(.floor-grid)`;
    document.querySelectorAll(realSel).forEach(floor => {
        // Don't stack a second grid on a floor that already has one.
        if (floor.previousElementSibling?.classList.contains('floor-grid')) return;
        const grid = floor.cloneNode(false);
        grid.classList.add('floor-grid');
        grid.dataset.gridFor = floor.dataset.sector;
        grid.removeAttribute('data-texture');          // no texture
        grid.style.clipPath = 'none';                  // ignore the clip → full rectangle
        const fz = parseFloat(floor.style.getPropertyValue('--floor-z')) || 0;
        grid.style.setProperty('--floor-z', fz - 0.1);
        grid.style.opacity = '0';                      // start transparent → fade in next frame
        floor.before(grid);
        requestAnimationFrame(() => { grid.style.opacity = '1'; });
    });
};

/** Fade out and remove the floor grid(s) laid by showFloorGrid. No id = all. */
export const hideFloorGrid = (id) => {
    const gridSel = id == null ? '.floor-grid' : `.floor-grid[data-grid-for="${id}"]`;
    document.querySelectorAll(gridSel).forEach(el => {
        const onEnd = (e) => {
            if (e.propertyName !== 'opacity') return;
            el.removeEventListener('transitionend', onEnd);
            el.remove();
        };
        el.addEventListener('transitionend', onEnd);
        el.style.opacity = '0';
    });
};

/** Undo explode / billboard / only / hide on every sector and drop any floor
 *  grids. Explode, fade and re-assembly animate; the billboard snaps back (its
 *  transform is class-gated), so for a graceful reverse drop .billboarded on its
 *  own first. */
export const reset = () => {
    allSectors().forEach(el => {
        el.classList.remove('exploded', 'faded', 'billboarded', 'highlighted');
        el.removeAttribute('hidden');
        restoreSectorLight(el);
    });
    document.querySelectorAll('.floor-grid').forEach(el => el.remove());
};
