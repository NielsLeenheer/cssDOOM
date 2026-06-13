# Refactor: Sector-inherited floor / ceiling heights (and clip-path)

Status: design proposal · Owner: TBD · Relates to: `CSS-RENDERER-IMPROVEMENTS.md`
items **C5** (z-inheritance), **A2** (`@property --floor-z`), **B5** (movers).
Sibling doc: `REFACTOR-door-sector-surfaces.md` (depends on this one).

---

## Summary

Today every scene element carries its own vertical position as an inline
custom property, and the game loop pushes new heights to each element by
hand whenever a floor/lift/door moves. The sector container already exists
purely so its children can **inherit** `--light` — this refactor extends
that same pattern to vertical geometry:

- The `.sector` div carries `--start-z` (floor) and `--end-z` (ceiling),
  set once at build time, plus a derived, animatable `--floor`.
- Floors, ceilings, things — and eventually door/lift surfaces — read those
  inherited values instead of their own inline copies.
- A lift or floor move becomes **one property write on the sector
  container**; every surface and thing standing in it rides along for free
  via CSS inheritance + transition.

The payoff is deleting a whole class of per-frame, per-element renderer
dispatches from the game loop and removing the "manually keep N elements'
heights in sync" hazard.

---

## How it works today

### Sector container — light only

`scene/sectors.js::buildSectorContainers` creates one `.sector` div per
sector and sets `--light` (plus an optional light-effect animation class).
Children inherit `--light`; the sector has no size and no transform
(`scene.css`: `.sector { top:0; left:0; width:0; height:0 }`). Vertical
geometry is **not** on the sector.

### Every element carries its own z

- **Floors / ceilings** (`surfaces/horizontal.js`): each surface gets inline
  `--min-x/--max-x/--min-y/--max-y` plus `--floor-z` *or* `--ceiling-z`, and
  an inline `clip-path` (`polygon(...)` for simple shapes, `shape(evenodd …)`
  for sectors with holes). `surfaces/horizontal.css` builds the transform
  from `--surface-z` (bridged from `--floor-z`/`--ceiling-z` per class).
- **Things** (`entities/things.js`, `entities/sprites.js`): each container
  gets inline `--x`, `--y`, `--floor-z`; `entities/things.css` translates by
  `--floor-z`. `.enemy` has `transition: --floor-z 0.4s` to smooth lift
  rides (now interpolable since `--floor-z` was registered in A2).
- **Walls** (`surfaces/walls.js`): each wall gets inline `--floor-z`
  (bottomHeight) and `--ceiling-z` (topHeight). These are **wall-specific** —
  derived from *both* adjacent sectors — so a wall does not map 1:1 onto a
  single sector's floor/ceiling. (See "Scope" below.)

### The game loop pushes heights by hand

Three separate code paths keep heights in sync, all by dispatching
per-element renderer commands every time something moves:

1. **Lifts** — `game/mechanics/lifts.js::updatePlayerFromLift` runs every
   frame while a lift moves, interpolates `currentHeight`, then loops
   `state.things` and fires `updateThingPosition(i, x, y, currentHeight)`
   for each thing in the lift sector (corpses especially — live enemies get
   it via their AI tick instead). The renderer-side `.platform` div is a
   *separate* container that floor surfaces are reparented into, animated by
   a `translateY(--offset)` transition (`mechanics/lifts.css`).
2. **Live enemies** — `game/entities/ai.js::updateEnemyPosition` calls
   `getFloorHeightAt` every tick and dispatches `updateThingPosition`
   (plus `reparentThingToSector` for `--light`).
3. **Permanent floor changes** — `game/mechanics/floors.js::lowerFloorsWithTag`
   mutates `sectorPolygons[*].floorHeight`, then the caller fans a
   `setFloorHeight` per sector; the renderer impl
   (`surfaces/floors.js::setFloorHeight`) loops `surfaceElements`, finds the
   sector's floor, and writes inline `transition` + `--floor-z`.

So the floor height of a sector lives in **four** places that must agree:
`sectorPolygons[].floorHeight` (physics), `state.things[].floorHeight`
(culler / corpses), each thing element's inline `--floor-z` (DOM), and the
lift `.platform` transform (DOM). The game loop's job is to keep them
marching together.

---

## Proposed design

### 1. Sector carries the vertical geometry

In `buildSectorContainers`, set on each `.sector`:

```js
container.style.setProperty('--start-z', sector.floorHeight);   // static map floor
container.style.setProperty('--end-z',   sector.ceilingHeight); // static map ceiling
```

Derive the **effective, animatable** heights from those bases plus an
offset that mechanics drive:

```css
.sector {
    /* effective floor = static floor + lift/floor offset */
    --floor:   calc(var(--start-z) + var(--floor-offset, 0));
    /* effective ceiling = static ceiling + door/crusher offset */
    --ceiling: calc(var(--end-z) + var(--ceiling-offset, 0));
}
```

`--floor`, `--ceiling`, `--floor-offset`, `--ceiling-offset` are all
registered with `@property` (`syntax:"<number>"`, `inherits:true`) so they
**interpolate** under a transition — same requirement that made A2
necessary for `--floor-z`.

### 2. Floors, ceilings, things read the inherited value

```css
.floor   { --surface-z: var(--floor); }     /* was: inline --floor-z   */
.ceiling { --surface-z: var(--ceiling); }    /* was: inline --ceiling-z */

.enemy, .barrel, .pickup, .decoration {
    transform: translate3d(calc(var(--x) * 1px),
                           calc(var(--floor) * -1px),   /* was --floor-z */
                           calc(var(--y) * -1px));
}
```

Things stop setting their own `--floor-z`. They set only `--x` / `--y`;
the vertical comes from the parent sector. Airborne entities add an offset
on top of the inherited floor:

```css
transform: translate3d(…, calc((var(--floor) + var(--air-z, 0)) * -1px), …);
```

### 3. `--sector-path`: inherit the clip-path too

A sector's floor and ceiling share the same bounding box and the same
polygon outline, so the clip-path computed in `horizontal.js` is **identical
for both**. Today it's computed and set inline twice. Instead set it once on
the sector and let both surfaces read it:

```js
// horizontal.js / sectors.js — compute once per sector
container.style.setProperty('--sector-path', `polygon(${clipPoints})`);
// or  `shape(evenodd from 0% 0%, …)` for sectors with holes
```
```css
:is(.floor, .ceiling) { clip-path: var(--sector-path, none); }
```

`clip-path: var(...)` works without `@property` registration — it's a plain
substitution, resolved against each child's own border box (the percentages
are box-relative, and floor/ceiling boxes match). Rectangular sectors set no
`--sector-path` and fall back to `none`.

### 4. Lifts, floors, crushers become one property write

A lift move stops being a per-frame per-thing fan-out. The sector's
`--floor-offset` transitions once; **every floor surface and thing in the
sector rides along** because they inherit `--floor`:

```css
/* the lift sector animates its own floor; contents inherit it */
.sector[data-lift="lowered"] { --floor-offset: var(--lift-travel); }
:is(.floor, .enemy, .barrel, .pickup, .decoration) { transition: --floor 1s ease-in-out; }
```

`setLiftState(sectorIndex, state)` flips `data-lift` on the **sector**
container instead of a separate `.platform`. `setFloorHeight(sectorIndex,h)`
writes `--start-z` (or a `--floor-offset`) on the sector. Crushers /
doors drive `--ceiling-offset` (see sibling doc).

---

## What this deletes / simplifies

- **`updatePlayerFromLift`'s per-thing loop** (`lifts.js:182-189`) — the
  `updateThingPosition` fan-out for things on a moving platform disappears.
  Things inherit the sector's animating `--floor`; corpses ride for free
  without ticking.
- **`updateEnemyPosition`'s floor dispatch** (`ai.js:269`) — enemies still
  need `--x/--y` updates when they walk, but the `floorHeight` argument and
  its `getFloorHeightAt` call per tick go away on the render side; the only
  vertical signal needed is *which sector* (already handled by
  `reparentThingToSector`).
- **`setFloorHeight`'s `surfaceElements` loop** — becomes a single property
  write on the sector container.
- **The `.lift > .platform` reparenting** in `buildLift` — floor surfaces
  stay in their `.sector`; the platform container is no longer needed for
  vertical motion (shaft walls still built as today). This is the lift
  analogue of the door change in the sibling doc.
- **One of the four "floor height" copies** — the DOM no longer stores a
  per-thing floor; it's derived from the sector. (`sectorPolygons` for
  physics and `state.things[].floorHeight` for the culler stay; those are
  JS-side and read by non-CSS consumers.)

---

## Scope & non-goals

- **Walls do not fully fold in.** A wall's top/bottom is the *visible
  portion between two sectors*, not a single sector's floor/ceiling. Only
  one-sided (solid, void-bordering) walls span exactly `--start-z`..`--end-z`
  of their sector and could inherit; two-sided upper/lower walls cannot.
  Door **face/upper walls** are the interesting animated exception and are
  handled in the sibling door doc, not here. This refactor leaves
  `buildWalls`' inline `--floor-z`/`--ceiling-z` as-is.
- **The JS culler keeps reading JS state**, not the CSS custom properties.
  `culling.js` reads `state.things[].floorHeight` / element expandos, which
  are maintained game-side independently. No change needed there.
- **Physics is untouched** — `getFloorHeightAt` already reads
  `sectorPolygons[].floorHeight` and `liftState.currentHeight`. The
  game-side interpolation in `updatePlayerFromLift` still runs for collision
  / camera height; what's removed is only the *renderer* fan-out.

---

## Migration phases

1. **Add sector geometry, keep the old path.** Set `--start-z`/`--end-z`/
   `--sector-path` on `.sector`; register the `@property` values. Nothing
   reads them yet. Pure addition, no behavior change.
2. **Switch floors + ceilings to `--floor`/`--ceiling` + `--sector-path`.**
   Delete the inline `--floor-z`/`--ceiling-z`/`clip-path` on surfaces.
   Verify pixel-identical static render (screenshot diff, as in the A/B
   commits).
3. **Switch things to inherit `--floor`.** Drop per-thing `--floor-z`; add
   `--air-z` for projectiles/airborne. Verify enemies/pickups sit correctly,
   including on the E1M1 imp platform.
4. **Move lifts onto the sector.** `data-lift` on `.sector`, `--floor-offset`
   transition; delete the `.platform` reparenting and the
   `updatePlayerFromLift` thing-loop. Verify a lift ride carries an enemy +
   a corpse + a pickup smoothly.
5. **Move permanent floor changes** (`lowerFloorsWithTag`) onto the sector
   property. Verify E1M8 post-boss floor lower.
6. **Crushers** onto `--ceiling-offset` (shares the door channel; coordinate
   with sibling doc).

Each phase is independently verifiable and revertible.

---

## Risks / open questions

- **Step-between-sectors smoothing.** Today `.enemy { transition: --floor-z }`
  smooths *every* height change, including walking from a low sector to a
  high one. With inheritance, only the sector's own `--floor` transitions
  (lift/floor moves); a thing crossing a sector boundary via
  `reparentThingToSector` **snaps** to the new sector's floor. This is closer
  to DOOM (instant step-up) but is a behavior change for enemies on stairs —
  confirm it reads acceptably, or add a short transition on the thing's own
  translate as well.
- **`@property` interpolation on `calc()` of inherited values.** `--floor`
  is `calc(var(--start-z) + var(--floor-offset))`. We transition the
  *registered* `--floor`/offset; confirm browsers interpolate the registered
  custom property (they do for registered props) rather than the raw calc.
  May be cleaner to transition `--floor-offset` directly and leave `--floor`
  as a pure derived read.
- **Multi-polygon sectors.** A few maps have one `sectorIndex` spanning
  several `sectorPolygons` entries (disjoint regions / holes). There's one
  `.sector` container per sector index, so they share one `--floor` — which
  is correct (a sector has one floor height). `--sector-path` for a
  multi-polygon sector needs the combined shape; today each *surface* is
  built per polygon. Decide whether `--sector-path` lives per-surface
  (keep current granularity, lose nothing) or per-sector (only valid when
  one polygon). Safest: keep clip-path per-surface for hole/disjoint
  sectors, use `--sector-path` only for the simple 1:1 case.
- **Things whose floor ≠ their sector's floor.** DOOM's thing floorHeight is
  the highest floor it *overlaps*, which at a boundary can differ from the
  sector the centroid is in. Verify no visible cases (corpse half on a
  step). The culler already has this nuance in JS.
- **Reparent timing.** `reparentThingToSector` uses `moveBefore()` to
  preserve running animations; confirm an inherited `--floor` transition
  isn't interrupted/restarted by the move.
