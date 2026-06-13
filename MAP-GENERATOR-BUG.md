# Bug report: map generator emits sectors split across multiple `sectorPolygons` entries

**Component:** map generator (produces `public/maps/E1M*.json`) — *not present in the
cssDOOM app repo; this report is written against the JSON output contract.*

**Severity:** medium — one confirmed visible rendering bug (E1M6), plus redundant
geometry that complicates every renderer.

**Affected output field:** `sectorPolygons[]`

---

## Summary

A DOOM sector has exactly one floor height and one ceiling height. It should
therefore be represented by **exactly one** `sectorPolygons` entry: an outer
boundary plus zero or more hole loops. The generator currently emits **multiple
entries that share the same `sectorIndex`** in two distinct situations, both of
which should be fixed upstream so generated maps have **one entry per sector**:

1. **Contiguous sectors decomposed into pieces** — a single connected (often
   concave) sector is split into several polygons that merely *touch* along a
   shared edge. They should be one polygon (the sector's true outer boundary).
2. **A hole stored as a separate polygon** — a sector that surrounds another
   sector (a "hole") has that hole emitted as a *second positive polygon* with
   the same `sectorIndex`, instead of as an inner boundary loop of the outer
   polygon. In the one observed case the hole loop's vertices are also **not in
   ring order** (self-intersecting as stored).

Target invariant: **no `sectorIndex` appears in more than one `sectorPolygons`
entry; holes live in `boundaries[1..]`; every loop is a simple, correctly-ordered
ring.**

---

## Expected output contract

For each sector:

- Exactly **one** `sectorPolygons` entry, keyed by `sectorIndex`.
- `boundaries[0]` = the outer boundary, a **simple** (non-self-intersecting)
  closed ring in a consistent winding.
- `boundaries[1..]` = hole loops (areas belonging to other sectors punched out),
  each a simple closed ring, wound opposite to the outer (or relying on the
  even-odd fill the renderers already use).
- `hasHoles = true` iff `boundaries.length > 1`.
- All loops in correct ring order (consecutive vertices are edge-adjacent).

The renderers fill flats with an **even-odd** rule (WebGL stencil fan, software
scanline, CSS `clip-path` with `shape(evenodd …)`), so a single entry with
`boundaries = [outer, hole, …]` renders correctly. The current multi-entry output
does not, because every renderer iterates `sectorPolygons` and fills each entry
independently.

---

## Observed defects (verified against the shipped maps)

All 6 sectors in E1M1–E1M9 that have >1 `sectorPolygons` entry:

| Map · Sector | Entries | Relationship | Should be |
|---|---|---|---|
| E1M2 · 38 | 2 (entry 0 also has 1 internal hole) | touching (shared edge), same winding | one polygon: merged outer + the existing hole loop |
| E1M2 · 178 | 2 | touching (2 shared verts), same winding | one merged polygon |
| E1M3 · 32 | 2 | touching (2 shared verts), same winding | one merged polygon |
| E1M3 · 170 | 2 | touching (2 shared verts), same winding | one merged polygon |
| E1M7 · 134 | 2 | touching (2 shared verts), same winding | one merged polygon |
| **E1M6 · 168** | 2 | **nested, opposite winding → a HOLE** | outer + hole loop in one entry |

### Defect 1 — contiguous sectors split into touching pieces (5 sectors)

The two (or more) entries share an edge and form one connected area; they are a
polygon-decomposition artifact, not separate geometry. They have the **same
winding** and zero boundary gap. Example, E1M2 · 178:

- entry 0: bbox x[−1936..−1856] y[1024..1152]
- entry 1: bbox x[−1920..−1856] y[960..1024]
- shared edge at y=1024; both CW; one contiguous L/T-shape.

Impact: redundant work (each renderer fills the same sector N times); no visible
error for these because the pieces tile the same plane at the same height.

### Defect 2 — hole emitted as a separate, mis-ordered polygon (E1M6 · 168)

Sector 168 is a walkway that **wraps around the open-air sky courtyard, sector
167** (`ceilingTexture = F_SKY1`, ceiling 248). The courtyard should be a **hole**
in 168. Instead:

- 168 is emitted as **two** entries, both `hasHoles = false`.
- Entry 1's outer boundary is the courtyard's outline — its 12 vertices exactly
  match sector 167's boundary — but with **opposite winding** (entry 0 CW,
  entry 1 CCW) and **scrambled vertex order** (consecutive vertices are not
  edge-adjacent; the ring self-intersects as stored).

Impact (confirmed in-game): because entry 1 is a positive fill, every renderer
paints sector 168's floor (`FLAT5_4`, z=48) and **ceiling (`CEIL3_5`, z=120)**
over the courtyard region — i.e. a solid ceiling is drawn across part of the open
sky. Visible while standing in the courtyard. (The floor coincides with 167's own
floor at z=48 so the floor half is invisible; the ceiling half is the visible
bug.)

---

## Likely root cause (hypothesis — generator source not available here)

1. The sector polygonizer outputs each piece of its decomposition as a separate
   `sectorPolygons` entry rather than emitting the sector's true boundary
   (outer ring + holes). Touching pieces (defect 1) are decomposition fragments.
2. Holes that are *themselves* closed sub-sectors (defect 2) get classified as a
   second polygon for the same sector instead of as an inner boundary of the
   enclosing sector, and the inner loop is not canonicalized to ring order /
   consistent winding.

---

## Required fix

Produce **one `sectorPolygons` entry per `sectorIndex`**:

1. **Merge touching pieces.** When the decomposition produces multiple pieces for
   one sector that are edge-adjacent, emit the **union** as a single outer
   boundary (`boundaries[0]`). Equivalently: emit the sector's original linedef-
   derived boundary loop(s) and skip the convex/monotone decomposition in the
   output (the renderers don't need convex pieces — they fill via even-odd).
2. **Encode holes as inner boundaries.** When a sector encloses another sector,
   emit that inner sector's boundary as a **hole loop in `boundaries[1..]`** of
   the enclosing sector, not as a separate positive entry. Set `hasHoles = true`.
3. **Canonicalize every loop.** Each `boundaries[i]` must be a **simple**
   (non-self-intersecting) closed ring with vertices in edge-adjacent order;
   outer and hole loops in consistent (opposite) windings.

---

## Acceptance criteria

For every generated map:

- [ ] Every `sectorIndex` appears in **exactly one** `sectorPolygons` entry.
- [ ] `hasHoles === (boundaries.length > 1)` for every entry.
- [ ] Every boundary loop is a simple ring (no self-intersection; consecutive
      vertices are edge-adjacent).
- [ ] No entry's outer loop is fully nested inside another entry's outer loop
      (the nested-hole-as-polygon case is gone).
- [ ] E1M6 sector 168 renders with the sky courtyard open (no `CEIL3_5` slab over
      sector 167).

---

## Verification

Group `sectorPolygons` by `sectorIndex` and assert one entry each; for the
current (buggy) maps this lists exactly the 6 sectors above:

```js
import fs from 'node:fs';
for (const f of fs.readdirSync('public/maps')) {
  const d = JSON.parse(fs.readFileSync(`public/maps/${f}`));
  const byIdx = {};
  for (const p of d.sectorPolygons) (byIdx[p.sectorIndex] ??= []).push(p);
  const multi = Object.entries(byIdx).filter(([, ps]) => ps.length > 1);
  if (multi.length) console.log(f, 'multi-entry sectors:', multi.map(([i, ps]) => `${i}×${ps.length}`).join(', '));
}
```

Expected after the fix: no output (every sector has a single entry). A stronger
check should also flag self-intersecting loops and nested outer loops.

---

## Notes for the app side

Until the generator is fixed, the app could merge same-`sectorIndex` entries at
load time (union touching pieces; reclassify a nested opposite-winding loop as a
hole, re-ordering it from the enclosed sector's boundary). Fixing it upstream is
preferred so all renderers get clean, single-entry sectors and the E1M6 168
ceiling bug disappears for every renderer at once.
