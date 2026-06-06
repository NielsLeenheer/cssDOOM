/**
 * Sectors — dissect a level into its surfaces for the talk's "anatomy of a
 * sector" build-up. Pure DOM toggles on the .sector#s{id} containers; the
 * motion / fade / highlight live in CSS (features/sectors.css + the surface
 * transforms). Spans every pane (per-pane DOM duplication is intentional).
 * With no id, the per-sector commands act on every sector.
 *
 * Each visualisation is a { show, hide } pair (like debug.layers.*): explode,
 * highlight, billboard, grid. Plus the sector's own visibility (show / hide /
 * only), get (inspect), and reset (undo everything). A shared feature: console
 * exposes it as debug.sectors.*.
 */

const sectorEls = (id) =>
    document.querySelectorAll(id == null ? '.sector' : `.sector#s${id}`);
const allSectors = () => document.querySelectorAll('.sector');

/** A visualisation toggled by a single class on the sector container(s): show()
 *  adds it, hide() removes it. No id = every sector. */
const classViz = (cls) => ({
    show: (id) => sectorEls(id).forEach(el => el.classList.add(cls)),
    hide: (id) => sectorEls(id).forEach(el => el.classList.remove(cls)),
});

// Restore a sector's renderer --light (saved by highlight.show()); no-op if it
// wasn't overridden.
const restoreSectorLight = (el) => {
    const saved = el.dataset.litLight;
    if (saved === undefined) return;
    if (saved) el.style.setProperty('--light', saved); else el.style.removeProperty('--light');
    delete el.dataset.litLight;
};

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

/** Fade every sector EXCEPT the given one(s) to transparent, so they stand
 *  alone. Pass one or more ids — only(29) or only(29, 32). At least one id is
 *  required; surfaces fade via opacity (see sectors.css). Clear with show()/reset(). */
export const only = (...ids) => {
    const keep = new Set(ids.map(id => `s${id}`));
    allSectors().forEach(el => el.classList.toggle('faded', !keep.has(el.id)));
};

/** Explode a sector apart so its construction is visible — show() animates the
 *  walls/floors/ceilings apart (per-surface --explode-scale / --explode-dist in
 *  CSS), hide() re-assembles. */
export const explode = classViz('exploded');

/** Rotate a sector's walls, floors and ceilings to face the camera. show()
 *  billboards them (run after explode.show() so they rotate at their exploded
 *  positions); hide() rotates them back. CSS transitions --billboard. */
export const billboard = classViz('billboarded');

/** Highlight a sector — flood its walls / floors / ceilings with a solid accent
 *  (#F8BA00), drop their textures, and lift its base brightness to full so it
 *  pops; hide() restores the renderer's brightness. The light-fx animations
 *  (blink / glow / flicker) still drive --light, so dynamic lighting keeps
 *  playing — only the static dim level is overridden. (CSS: `.sector.highlighted`.) */
export const highlight = {
    show: (id) => sectorEls(id).forEach(el => {
        el.classList.add('highlighted');
        // --light is set inline by the renderer; an fx animation (if any) overrides
        // the inline value, so setting it to 1 here keeps fx while flooring the base.
        if (el.dataset.litLight === undefined) el.dataset.litLight = el.style.getPropertyValue('--light');
        el.style.setProperty('--light', '1');
    }),
    hide: (id) => sectorEls(id).forEach(el => {
        el.classList.remove('highlighted');
        restoreSectorLight(el);
    }),
};

/** Floor grid — show() lays a grid copy of a sector's floor just BELOW the real
 *  (clipped, textured) one, with the clip removed so the whole bounding rectangle
 *  shows: the texture covers the sector polygon on top, the grid + dotted border
 *  reveal the clipped-away "negative" space around it. Fades in (rides the
 *  sector's surface opacity transition). No id = every floor; calling show again
 *  is a no-op where a grid already exists. hide() fades it out and removes it. */
export const grid = {
    show: (id) => {
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
    },
    hide: (id) => {
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
    },
};

/** Undo explode / billboard / only / hide / highlight on every sector and drop
 *  any floor grids. Explode, fade and re-assembly animate; the billboard snaps
 *  back (its transform is class-gated), so for a graceful reverse call
 *  billboard.hide() on its own first. */
export const reset = () => {
    allSectors().forEach(el => {
        el.classList.remove('exploded', 'faded', 'billboarded', 'highlighted');
        el.removeAttribute('hidden');
        restoreSectorLight(el);
    });
    document.querySelectorAll('.floor-grid').forEach(el => el.remove());
};
