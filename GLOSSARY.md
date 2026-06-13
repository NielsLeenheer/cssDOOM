# cssDOOM renderer — glossary & fundamentals

Shared vocabulary for the renderer refactor. Each concept is **pinned** only
after it's been verified against the map data, the existing renderer code, and
original DOOM behavior. Terms are locked one at a time; nothing here is a design
proposal — it describes the agreed model the design must satisfy.

Status:
- **Sectors** — locked (this doc).
- **Floors & ceilings** — in progress.
- Coordinate system, walls, things, movers (doors/lifts/crushers) — TBD.

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
