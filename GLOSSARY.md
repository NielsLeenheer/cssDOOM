# cssDOOM renderer — glossary & fundamentals

Shared vocabulary for the renderer refactor. Each concept is **pinned** only
after it's been verified against the map data, the existing renderer code, and
original DOOM behavior. Terms are locked one at a time; nothing here is a design
proposal — it describes the agreed model the design must satisfy.

Status:
- **Sectors** — locked.
- **Floors & ceilings** — locked.
- **Walls** — locked.
- **Movers (doors / lifts / crushers)** — locked.
- Things — partially covered under Movers (how they ride a moving floor); a full
  Things section is TBD.
- Coordinate system — covered in discussion; not separately documented here.

---

## Coordinate note (working assumption, not yet fully pinned)

DOOM map coordinates are used throughout: `x` east/west, `y` north/south, `z`
height. The DOOM→CSS axis mapping (X→X, Y→−Z, height→−Y) is described where it's
load-bearing but is pinned in its own section later.

---

## Sectors

A **sector** is the fundamental unit of level geometry. As of the regenerated
maps (one `sectorPolygons` entry per sector), the model is unambiguous:

> **A sector = one bounding box + one outline + zero-or-more holes + one
> floor-z + one ceiling-z + one light.**
> **It renders as one floor surface and one ceiling surface, each the bbox quad
> clipped to (outline − holes).**

### Verified invariants

- A sector has **exactly one** floor height and **one** ceiling height (data
  invariant: confirmed across all 1385 sectors in E1M1–E1M9).
- A sector maps to **exactly one** `sectorPolygons` entry. (Was violated by 6
  sectors pre-regen; fixed upstream — self-referencing trigger lines no longer
  split outlines, and hole detection uses a guaranteed-interior point.)
- A sector renders as **one floor + one ceiling** surface — never more.

### Terms

| Term | Definition |
|---|---|
| **Sector** | One floor height, one ceiling height, one light level, floor/ceiling textures, optional special (light effect / damage / etc.). Identified by `sectorIndex`. Not necessarily a simple convex shape — see Outline. |
| **Outline** | The sector's single outer boundary loop (`boundaries[0]`): one closed ring. May be **concave**, and may be **self-touching** (a pinched ring that visits a point twice — e.g. E1M2 sector 38, stitched from what used to be two touching pieces). |
| **Hole** | An inner loop (`boundaries[1..]`) where another sector is punched out — a pillar, a raised platform, a pool, or an open-sky courtyard (e.g. E1M6 sector 168 around the sky sector 167). Subtracted from the outline. |
| **Bounding box** | The single axis-aligned rectangle enclosing the outline (`--min-x/--max-x/--min-y/--max-y` in the current renderer). Drives each surface's size, position, and texture origin. |
| **Clip path** | The path applied to the floor and ceiling to carve the bbox quad down to the real shape. Built from the outline + holes as **even-odd** subpaths, in coordinates relative to the bounding box. Only present when the sector is non-rectangular or holed; a plain rectangular sector needs no clip path. |
| **Subpath** | One closed loop within the clip path — either the outline or a hole. |

### Retired terms

- **"Region"** and **"section"** — dropped. They implied a sector could be
  multiple separate filled pieces. After the regen no sector has more than one
  outline, so the concept doesn't exist. A sector is *one outline (possibly
  concave / self-touching) minus its holes*.

### Fill rule

Floors and ceilings are filled with the **even-odd** rule (the CSS renderer via
`clip-path` / `shape(evenodd …)`; WebGL via a stencil even-odd fan; software via
a scanline even-odd test). Under even-odd, the outline fills and each hole loop
(nested, opposite winding) punches — so one surface with `[outline, …holes]`
renders correctly. This is why a sector needs only one floor and one ceiling
element regardless of hole count.

---

## Floors & ceilings

A **flat** is a horizontal surface — a floor or a ceiling. Each sector produces
one floor and (usually) one ceiling.

> **A floor/ceiling is the sector's footprint — the bounding-box quad clipped to
> (outline − holes) — placed at the sector's floor-z / ceiling-z, textured with a
> world-aligned 64×64 flat, and lit by the sector. Floor and ceiling differ only
> in height, facing, and sky handling.**

### Terms

| Term | Definition |
|---|---|
| **Flat** | A horizontal surface (floor or ceiling), textured with a 64×64 DOOM flat **tiled in world space**, clipped to (outline − holes), lit by the sector's brightness. |
| **Floor surface** | The flat at the sector's `floor-z`, facing **up** (seen from above). |
| **Ceiling surface** | The flat at the sector's `ceiling-z`, facing **down** (seen from below). A **sky** ceiling (`F_SKY1`) produces **no** surface — the sky backdrop shows through. |

### How a flat is drawn (verified against current code)

1. A `<div>` sized to the sector's **bounding box** (`width = max-x − min-x`,
   `height = max-y − min-y`), laid flat by `rotateX(90deg)` and positioned at the
   surface height. The bbox (`--min-x/--max-x/--min-y/--max-y`) is **inherited
   from the parent `.sector`** — set once per sector, not per surface.
2. **Clipped** to the sector shape via `clip-path: var(--outline)`, also
   **inherited from the sector**: rectangular → no clip (`--outline` unset →
   `none`); concave → `polygon()`; holed → `shape(evenodd …)` with outline +
   holes as subpaths. Clip coordinates are bbox-relative percentages with DOOM Y
   flipped (`(maxY − y)/H`), since element-local Y points down.
3. **Textured** world-aligned: `background-size: 64px`, `background-repeat`,
   `background-position` in world coords (`−min-x`, `max-y`) so flats tile
   seamlessly across adjacent sectors and the clip reveals this sector's slice.
   (Matches vanilla DOOM, which cannot offset or rotate flats.)
4. **Lit** by `filter: brightness(var(--light))` from the sector.

### Floor vs ceiling — the only differences

| | Floor | Ceiling |
|---|---|---|
| Height | `floor-z` | `ceiling-z` |
| Facing | seen from above (`backface-visibility: hidden`; lift-platform floors are `visible`) | seen from below (`backface-visibility: visible`) |
| Sky | sky floor → dark fallback colour | **sky ceiling: not built** — backdrop shows |
| Extras | `data-sector` debug label; NUKAGE flat animation | — |

### Known wrinkles

- ~~bbox + clip-path duplicated per surface~~ — **resolved:** the bounding box
  (`--min-x/--max-x/--min-y/--max-y`) and clip (`--outline`) now live on the
  `.sector` and are inherited by its floor and ceiling, computed once per sector.
- **Movement is via the `.mover` translate** (implemented — see
  IMPLEMENTATION-PLAN-movers.md): door/crusher/lift surfaces ride a `.mover`
  group's transform, not an animated surface height. **`setFloorHeight`**
  (permanent floor specials — donut / floor-lower) is a **separate** path that
  still animates the surface's own `--floor-z` via an inline `transition`; it is
  out of scope for the mover refactor.
- A **sky floor** renders a dark fallback colour instead of showing sky below
  (rare; minor).

---

## Walls

A **wall** is a vertical quad along a linedef.

> **A wall spans from `--start-z` (bottom) to `--end-z` (top) between its two
> vertices (`--start-x/y` → `--end-x/y`). The renderer derives its width, angle,
> and position from the vertices; its height is `end-z − start-z`.**

### Linedefs & sidedefs

- A linedef has **one or two sidedefs** (front, optional back). One-sided = a
  solid wall against the void; two-sided = a portal between two sectors.

### Wall types (per sidedef)

| Type | Covers | Notes |
|---|---|---|
| **lower** | the step between the two sectors' **floors** | two-sided only |
| **upper** | the overhang between the two sectors' **ceilings** | two-sided only |
| **middle** | one-sided: the full floor→ceiling solid wall · two-sided: an *optional* see-through texture spanning only the opening (grates/bars), usually absent | — |

So a one-sided line uses **only** the middle (full-height) texture; a two-sided
line uses upper and/or lower (plus an optional middle).

### Which side renders which (verified ~95–99% in E1M1)

- **lower wall → the lower-floor sector** (you see the step *up* from the lower side).
- **upper wall → the higher-ceiling sector** (you see the overhang from the higher side).

Symmetry: each step is rendered from the side you can actually see it —
lower→lower-floor, upper→higher-ceiling.

### Sizing model

- **Horizontal:** `--start-x/--start-y` (start vertex) + `--end-x/--end-y` (end
  vertex). CSS derives `width = hypot(Δx, Δy)`, `angle = atan2(Δy, Δx)`, and
  positions the wall at the start vertex.
- **Vertical:** `--start-z` (bottom) + `--end-z` (top) — the wall's vertical
  span. `height = end-z − start-z`; the wall is anchored at its **top**
  (`--end-z`) and grows downward.
  - These were named `--floor-z`/`--ceiling-z`, which are only accurate for a
    one-sided full-height wall. For a **lower** wall the top is a *floor* (the
    higher sector's), for an **upper** wall the bottom is a *ceiling* (the lower
    sector's) — so the floor/ceiling names lie. `--start-z`/`--end-z` is a
    generic vertical span that's accurate for every wall type.
  - Deliberate asymmetry with the horizontal pair: `--start-x/y` and `--end-x/y`
    are the two *vertices*; `--start-z`/`--end-z` are span bounds shared by both
    vertices (a wall has one bottom and one top, not one per vertex).

### cssDOOM data representation (caveats)

- The generator emits a wall record **per portion, per side**: a two-sided line
  yields a *visible* (textured) wall and a `'-'` back-face counterpart. So
  `isUpperWall` ≈ openings × 2; same for lower.
- Only **`isUpperWall`** records carry `frontSectorIndex`/`backSectorIndex`;
  lower/middle/solid leave them null (infer the neighbour from heights).
- The `isSolid` / `isLowerWall` / `isUpperWall` / `isMiddleWall` flags **overlap**
  (`isSolid` is often set alongside the others); the flag semantics are messier
  than the clean DOOM upper/middle/lower model and should be pinned before any
  wall-classification work.

---

## Movers (doors, lifts, crushers)

A **mover** is a sector whose floor *or* ceiling animates along the vertical
(z) axis at runtime. Doors, lifts, and crushers are all movers.

> **A mover is a sector. Exactly one of its surfaces moves — never both — and it
> moves by a pure translate (the surface keeps its rest geometry). Things sitting
> on a moving floor ride it by sharing the same translated container.**

### Movers are sectors

A mover is **not** a special object grafted onto the scene — it is an ordinary
sector that happens to change height. It has the same anatomy as any sector:
one bounding box, one outline (± holes), one floor-z, one ceiling-z, one light,
one floor surface, one ceiling surface. The only addition is a runtime
translate on one surface.

This matters because the mover's motion is visible from its **neighbours**: the
surface that reads as "the door" from an adjoining room is that neighbour's
**upper wall** (the overhang down to the closed door), and the surface that
reads as "the lift" is the step (lower/upper wall) on its boundary. So animating
a mover means animating its own surface *and* the relevant walls of any
adjoining sector — see "Adjoining faces" below.

### Which surface moves (verified against E1M-series data)

| Mover | Surface that moves | Direction | Rest state | Verified |
|---|---|---|---|---|
| **Door** | ceiling | up to open, down to close | closed: ceiling-z == floor-z | doors closed ceiling==floor, open up — 115/115 |
| **Lift** | floor | down to lower, up to raise | raised: floor-z == upper neighbour's floor | lift floor down, rest == raised == upper height — 37/38 |
| **Crusher** | ceiling | down to crush, up to retract | retracted: ceiling at top of crush range | ceiling down, rest == top, floor static — 2/2 |

Two invariants fall out of this:

- **Only one surface moves.** A door/crusher never moves its floor; a lift never
  moves its ceiling. The static surface stays put.
- **The floor never moves on a door or crusher**, so things in a door/crusher
  sector never ride anything; only **lift** things ride.

cssDOOM caveats:

- A **crusher's stored ceiling-z is not its crush range.** The data's ceiling
  height is the *retracted* position; the crush bottom is computed separately.
  Don't assume `ceiling-z` bounds the animation.
- **Lifts currently use synthesized `shaftWalls`** (see `isLiftWall` handling in
  `walls.js`): the generator's lower walls on a lift boundary are skipped and
  replaced with shaft walls spanning the full travel. The target model removes
  that special case — see "Moving walls are fixed geometry" — but it's the
  current reality.

### Moving walls are fixed geometry, translated

A moving surface (and any moving wall) **never changes its height/geometry at
runtime.** It is generated once at its **fullest extent** (the rest/largest
state) and then *translated* between states. A pure translate has no gaps only
if the geometry already covers both endpoints, so:

- A **door's** moving ceiling-face wall is built to span the full open opening,
  then translated down to "close" it.
- A **lift's** moving floor and its shaft walls are built to span the full
  raised footprint / full travel, then translated down.

This is deliberate: animating `height` (or `--start-z`/`--end-z`) would force a
per-frame layout/clip recompute, and would fight the light filter for the same
animatable slots. Translating a fixed quad is cheap and composes cleanly with
nested transforms.

### DOM structure

A mover sector splits its children into a **static** group and one-or-more
**moving** groups:

```
<div class="sector">              ← carries --light, light-effect class,
  │                                 --base-floor-z / --base-ceiling-z (inherited)
  ├─ <div class="static">         ← non-moving surface + static walls
  │     ├─ <div class="ceiling|floor">   (whichever does NOT move)
  │     ├─ <div class="wall"> …           (walls that don't move)
  │     └─ things/enemies                  (only for NON-floor-movers)
  │
  └─ <div class="mover">          ← the moving group; transform: translate(…)
        ├─ <div class="floor|ceiling">   (the surface that moves)
        ├─ <div class="wall"> …           (walls that move with it)
        └─ things/enemies                  (only for LIFTS — they ride the floor)
```

- The **move is a `transform: translate3d(…)` on the `.mover` container.** Every
  child inherits the motion through one transform — guaranteeing the surface, its
  walls, and (for lifts) the things on it stay glued together with zero sync risk.
- A sector can hold **several `.mover` groups**: its own (if it's a mover) plus
  one per adjoining mover whose face it must animate (see below). Each group is
  **direct-driven** by its mechanic — there is no single shared driver, because a
  neighbour's group animates on a different schedule than the sector's own.

### Light vs motion — different elements, no conflict

- **Motion** runs as a `transform` on the `.mover` *container*.
- **Light** runs as `filter: brightness(var(--light))` on the **leaf** (the
  textured wall / flat / sprite) — exactly as the renderer already does, including
  animated-light effects via the `lighting.css` descendant pattern.

Because motion and light live on **different elements**, they never compete for
the same animation slot. This is why grouping is necessary: a single element
**cannot** simultaneously run a continuous light keyframe and a move keyframe (a
crusher is both lit and constantly moving). Splitting move-onto-parent /
light-onto-leaf resolves it structurally. Nested transforms compose correctly,
so a leaf inside a moving group still gets its filter and its inherited motion.

### Things ride the floor

Things and enemies standing on a **lift** must move with it. They do so by
living **inside the lift's `.mover` container** (option (a)): one transform
moves the floor and everything on it together — guaranteed sync, no second
animation to keep aligned.

- `sector.floorContainer` is set at build time: it points at `.mover` for a
  **lift**, and at `.static` (or the plain sector) otherwise. `reparentThingToSector`
  targets `sector.floorContainer`, so a thing always lands in the group that
  owns its floor.
- There is **no animated `--floor-z`.** Earlier designs animated an inherited
  `--floor-z` so things could read their height from the sector; that's dropped.
  Geometry and things move purely by the parent translate. (The sector may still
  expose a *static* `--base-floor-z` for initial placement, but it is not
  animated.)

### Adjoining faces

When a non-mover sector adjoins a mover, the mover's visible face in that sector
is one of that sector's own walls (e.g. the upper wall that hangs down to a
closed door). To animate it, the adjoining sector gets its **own `.mover`
group** holding just those boundary walls, direct-driven in lockstep with the
mover's surface. A sector adjoining **two** doors therefore carries **two**
`.mover` groups — one per door — plus its `.static` group.

### Firefox note (empirically de-risked, FF142)

The grouping above is a **structural** choice (clean light/motion separation +
the keyframe-slot conflict), **not** a Firefox workaround. Measured with
Playwright Firefox 142 at the pixel level: an inherited, animated, registered
custom property *does* repaint a descendant's `transform` **and** its `filter`
(both keyframe and transition). So animating on a parent and lighting on a leaf
is safe in Firefox; the structure is chosen for correctness and clarity, not to
dodge a browser bug.
