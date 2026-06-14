# cssDOOM renderer — glossary & fundamentals

Shared vocabulary for the renderer refactor. Each concept is **pinned** only
after it's been verified against the map data, the existing renderer code, and
original DOOM behavior. Terms are locked one at a time; nothing here is a design
proposal — it describes the agreed model the design must satisfy.

Status:
- **Sectors** — locked.
- **Floors & ceilings** — locked.
- **Coordinate system** — in progress.
- Walls, things, movers (doors/lifts/crushers) — TBD.

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
- **Two animation paths** exist: a permanent floor lower animates via an inline
  `transition: transform` on the surface, separate from the registered
  `@property --floor-z`. The parked refactor unifies these.
- A **sky floor** renders a dark fallback colour instead of showing sky below
  (rare; minor).
