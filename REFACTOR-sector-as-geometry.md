# Refactor: Sector-as-geometry — inherited heights, single-toggle movers, no reparenting

Status: design proposal · Owner: TBD · Supersedes the earlier split docs
`REFACTOR-sector-height-inheritance.md` + `REFACTOR-door-sector-surfaces.md`
(merged here because they're interdependent). Relates to
`CSS-RENDERER-IMPROVEMENTS.md` items **C5**, **A2**, **B5**, **C1**.

---

## 0. The one idea

Today the renderer treats every wall, floor, ceiling, and thing as an
independent element that carries its own absolute geometry inline, and the
game loop keeps their heights in sync by pushing per-element updates every
frame. Movers (doors, lifts, crushers) go further: they **reparent** surfaces
out of their sectors into a bespoke animated container (`.door > .panel`,
`.lift > .platform`, `.crusher`), which severs the inheritance the sector
provides and forces values to be restated by hand.

This refactor makes the **sector the unit of geometry**. A sector owns its
shape, its floor/ceiling heights, and its light; its surfaces become thin
presentational children that *inherit* those values. A mover becomes "a
sector with one animating offset," driven by a single state flip — no
reparenting, no per-frame fan-out.

> **Sector = shape (`bbox` + `--sector-path`) + `--start-z`/`--end-z` +
> `--light`. Floors, ceilings, things, and (in-sector) walls read those by
> inheritance. A mover animates one `--offset` routed onto `--floor` or
> `--ceiling`.**

---

## 1. Vocabulary (the shared custom-property model)

A consistent z-span language across sectors and walls:

| Property | On | Meaning |
|---|---|---|
| `--start-z` | sector, wall | low bound (floor / wall bottom) |
| `--end-z` | sector, wall | high bound (ceiling / wall top) |
| `--offset` | sector (+ direct on out-of-sector faces) | animated `0 → --travel`; sign = direction |
| `--travel` | mover sector, door face | the move magnitude (build-time constant) |
| `--floor` | sector (derived) | `calc(var(--start-z) + …)` — effective floor |
| `--ceiling` | sector (derived) | `calc(var(--end-z) + …)` — effective ceiling |
| `--surface-z` | floor/ceiling | which channel that plane reads (`--floor` or `--ceiling`) |
| `--sector-path` | sector | compound clip-path (regions + holes), see §5 |
| `--light` | sector | already inherited today; unchanged |

Notes:

- **Rename `--floor-z`/`--ceiling-z` → `--start-z`/`--end-z` on walls.**
  Floor/ceiling is sector vocabulary leaking onto wall geometry and is wrong
  for the two-sided cases (an *upper* wall's "floor-z" is really a ceiling; a
  *lower* wall's "ceiling-z" is really a floor). A wall is just a vertical
  span `[start-z, end-z]`. This also disambiguates today's overload where
  `--floor-z` means *both* a wall's bottom and a thing's floor height.
  - Caveat: `--start-z` reads as "the z of vertex `(--start-x, --start-y)`,"
    but it isn't — both vertices share one top/bottom. Document that the
    z-bounds are independent of the x/y vertices, or use `--low-z`/`--high-z`
    if the collision bothers you. The doc assumes `--start-z`/`--end-z` for
    sector↔wall consistency.
- `--floor-z` is already `@property`-registered (item A2). `--offset`,
  `--floor`, `--ceiling` must be registered too (`syntax:"<number>"`) so they
  interpolate under a transition — unregistered custom properties animate
  discretely.

---

## 2. Sectors carry the geometry

`buildSectorContainers` sets, per sector:

```js
container.style.setProperty('--start-z', sector.floorHeight);
container.style.setProperty('--end-z',   sector.ceilingHeight);
// shape — single-region sectors only (see §5):
//   --min-x/--max-x/--min-y/--max-y, --sector-path
```

and the stylesheet derives the effective heights, routing a single `--offset`
onto the bound that moves for this mover type:

```css
.sector {
    --floor:   var(--start-z);
    --ceiling: var(--end-z);
    transition: --offset var(--dur, 1s) ease-in-out;
}
.sector[data-mover="lift"]                                  { --floor:   calc(var(--start-z) + var(--offset, 0)); }
.sector[data-mover="door"], .sector[data-mover="crusher"]   { --ceiling: calc(var(--end-z)   + var(--offset, 0)); }
.sector[data-state="active"]                                { --offset: var(--travel); }
```

`data-mover` is the "where the offset is applied" selector — it routes the one
`--offset` onto floor (lifts) or ceiling (doors/crushers), leaving the other
bound at its base. A sector is only ever one mover type, so this is
unambiguous. Static sectors leave `--offset` at its initial `0`, so `--floor`
= `--start-z` and `--ceiling` = `--end-z`.

---

## 3. Floors & ceilings become bare elements

Floor and ceiling of a sector share everything except which height they sit
at, so the element collapses to "which plane + which texture":

```html
<div class="floor"   data-texture="FLOOR4_8"></div>
<div class="ceiling" data-texture="FLAT20"></div>
```

```css
.floor   { --surface-z: var(--floor);   }
.ceiling { --surface-z: var(--ceiling); }

:is(.floor, .ceiling) {
    width:  calc((var(--max-x) - var(--min-x)) * 1px);
    height: calc((var(--max-y) - var(--min-y)) * 1px);
    clip-path: var(--sector-path, none);
    background-size: 64px 64px;
    background-position: calc(var(--min-x) * -1px) calc(var(--max-y) * 1px);
    transform: translate3d(calc(var(--min-x) * 1px),
                           calc((var(--surface-z) + (var(--max-y) - var(--min-y))/2) * -1px),
                           calc((var(--min-y) + var(--max-y))/2 * -1px))
               rotateX(90deg);
}
```

bbox, path, light, and z all inherited from the sector. The **only** per-element
datum is `data-texture` (floor and ceiling textures differ). When a mover
animates the sector's channel, the relevant plane follows automatically:
a door's ceiling flat rises (reads `--ceiling`), its floor flat stays (reads
`--floor`, which `data-mover="door"` left untouched).

---

## 4. Things inherit the floor

Things set only `--x` / `--y` and read the sector's `--floor` for z:

```css
.enemy, .barrel, .pickup, .decoration {
    transform: translate3d(calc(var(--x) * 1px),
                           calc((var(--floor) + var(--air-z, 0)) * -1px),
                           calc(var(--y) * -1px));
}
```

A thing standing in a sector rides that sector's `--floor` for free — a lift
move is *one* property write on the sector, and every thing on it follows.
Airborne entities (projectiles; future lost souls/cacodemons) add `--air-z`
on top of the inherited floor. Crossing into another sector is handled by
`reparentThingToSector` (already implemented, with `moveBefore()` to preserve
running animations), which picks up the new sector's `--floor` and `--light`.

This deletes the per-frame, per-thing height fan-out:

- `lifts.js::updatePlayerFromLift`'s `updateThingPosition` loop for things on
  a moving platform.
- `ai.js::updateEnemyPosition`'s `floorHeight` dispatch (enemies still need
  `--x/--y` when they walk, but no z push).
- `floors.js::setFloorHeight`'s `surfaceElements` loop (becomes one sector
  write).

(Physics keeps its own JS floor state — `sectorPolygons[].floorHeight`,
`liftState.currentHeight` — read by `getFloorHeightAt` for collision/camera;
the culler keeps `state.things[].floorHeight`. Those are non-CSS consumers and
are unchanged. What's removed is only the *renderer* fan-out.)

---

## 5. One floor + one ceiling per sector via a compound clip-path

A sector's footprint may be: one region; one region with holes; or several
disjoint regions (same sector index, shared properties). The clip-path
mechanism already handles holes (multiple subpaths under `evenodd`); disjoint
regions are simply *more* subpaths. So **every** sector — regardless of shape —
is **one** floor + **one** ceiling element:

> `--sector-path` = every region's outer loop **plus** every hole loop, as
> `evenodd` subpaths, in coordinates relative to the **union** bbox of all the
> sector's regions.

### Terminology

- **Sector** — a property set (floor z, ceiling z, light, special, textures)
  identified by an index. Not necessarily one shape.
- **Region** — one connected footprint (`sectorPolygons` entry). Usually 1 per
  sector; occasionally N.
- **Boundary loop** — `boundaries[0]` outer ring; `boundaries[1..]` holes.

### Why it's safe (verified against all 6 multi-region sectors)

Multi-region sectors are rare — **6 total across E1M1–E1M9, max 2 regions
each** (holes don't count: a holed sector is one region with inner loops,
~10 in E1M3). `evenodd` handles every one:

- **E1M6 sector 168** is a *hole mis-encoded as a separate polygon*: region 1
  has the opposite winding (CW outer, CCW inner) and is fully nested in
  region 0. Under one `evenodd` path it punches the hole correctly. Note this
  is likely a **current bug** — built as a separate filled surface, region 1
  paints a floor where the hole should be; unifying *fixes* it.
- **The other 5** (E1M2 38/178, E1M3 32/170, E1M7 134) are adjacent
  same-winding pieces — a partition touching at an edge/corner. DOOM maps are
  planar subdivisions, so same-sector regions never genuinely overlap; under
  `evenodd` each piece fills correctly (interior ray-crossing counts come out
  odd). Possible sub-pixel seam at the coincident shared edge — cosmetic,
  almost certainly invisible on a tiled flat; verify with a screenshot.

This gives multi-region sectors **fewer** DOM nodes than today (1 surface vs
N), removes the only exception to "geometry on the sector," and corrects the
168-style case.

---

## 6. Movers: one `--offset`, one state flip

A mover is a sector with `data-mover` (which bound moves) + `--travel`
(magnitude, build-time) + a runtime `data-state` toggle. `--offset` = `active −
rest`, so its sign encodes direction: a door/crusher ceiling rises (`+travel`),
a lift floor drops (`lowerHeight − upperHeight`, negative). The single toggle
flips `data-state` on the sector; the CSS transition animates `--offset`; all
in-sector surfaces follow by inheritance.

- **Lift** — `--offset` → `--floor`. All moving parts (floor flat, things) are
  *in* the lift sector, so a lift is **pure sector-toggle, no out-of-sector
  work**. It's the degenerate case of the model.
- **Door / crusher** — `--offset` → `--ceiling`. The ceiling flat is in-sector
  and follows by inheritance. But the *faces* are not (see §7).

---

## 7. Doors: the faces are the one cross-sector piece

### Anatomy (E1M1 door, sector 4)

Closed: `floor = ceiling = 0`; open: ceiling → 68. Four linedefs:

| Component | Map sectorIndex | Moves? | Where it lives |
|---|---|---|---|
| Ceiling flat (`FLAT20`) | 4 (door) | rises 0→68 | door sector — **in-sector** |
| Floor flat (`FLOOR4_8`) | 4 (door) | no | door sector |
| Face `BIGDOOR2` → room 3 | **3 (room)** | bottom rises | room sector — **out-of-sector** |
| Face `BIGDOOR2` → room 0 | **0 (room)** | bottom rises | room sector — **out-of-sector** |
| Two `DOORTRAK` jambs | 4 (door) | no | door sector (static walls) |

The visible face is an **upper wall**, and DOOM lights an upper from its own
sidedef's sector — so each face belongs to (and is lit by) the neighbouring
*room*, not the door. There are one or more faces per door, each with its own
room ceiling as its (fixed) top.

### Why we do NOT reparent the faces

The original plan was to reparent faces into a container and restate light
statically (what the current `.panel` does). But a face needs **two masters**:
*light* from its room and *ceiling* (its moving bottom) from the door. CSS
gives one parent. Keeping faces in their room sector (correct light) and
direct-driving their bottom is the right trade — confirmed by data:

> **29 of 279 door faces (~10%) sit in animated-light sectors** (E1M2/3/5/6/7;
> glow/blink/flicker), including literal `BIGDOOR2`/`BIGDOOR4` faces in
> blinking rooms. Reparenting freezes their light — and the current `.panel`
> code *already* freezes these 29 (static `--light` copy). So no-reparent
> isn't just avoiding a regression; it **fixes a pre-existing frozen-light
> bug**.

### How the face is driven — fully in CSS

The face stays a **normal wall** in its room sector. Its top (`--end-z`) is the
fixed room ceiling; its bottom is `--start-z + --offset`. It carries its **own**
`--travel` (build-time constant — it knows its door) and responds to its own
`data-state` token. JS only flips the token; the CSS transition does the motion:

```css
/* generic wall — offset defaults to 0, so static walls are unaffected */
.wall {
    height: calc((var(--end-z) - (var(--start-z) + var(--offset, 0))) * 1px);
    transform: translate3d(calc(var(--start-x) * 1px),
                           calc(var(--end-z) * -1px),
                           calc(var(--start-y) * -1px))
               rotateY(atan2(var(--delta-y), var(--delta-x)));
}
.wall.door-face {
    --offset: 0;
    transition: --offset var(--dur, 1s) ease-in-out;
}
.wall.door-face[data-state="open"] { --offset: var(--travel); }
```

For the real `BIGDOOR2` (`--start-z 0`, `--end-z 88`, `--travel 68`): closed
height `88−0 = 88`; open `88−(0+68) = 20`, pinned at the fixed top, with
`.unpegged` sliding the texture up. **`--door-open`/`--door-closed` are gone** —
the face is just a wall whose `--offset` is toggled, identical mechanism to the
sector.

### The in-sector vs out-of-sector split — one mechanism, two travel sources

| | gets `--offset` | gets `--travel` | reason |
|---|---|---|---|
| In-sector flat / things | inherit `--floor`/`--ceiling` from sector | from the sector (shared) | contents are **dynamic** (things come and go) — must inherit |
| Out-of-sector face | own `--offset`, own `data-state` | own inline constant (build) | static, belongs to one known door — self-carries |

Both run the *same* `data-state → --offset → transition`; only the source of
`--travel` differs. `setDoorState(sectorIndex, state)` flips `data-state` on
the door's `.sector` **and** on each face in a `doorFaces` registry. Lifts have
an empty out-of-sector set, so they need no registry.

**Two sync requirements** (the cost of not-reparenting, which got sync for free
from a single panel element):

1. A `doorFaces: Map<sectorIndex, faceEl[]>` registry so the toggle can reach
   the out-of-sector faces (built where the door's faces are already
   identified).
2. A shared `--dur` so the sector-driven flat and the direct-driven faces stay
   locked (they're separate transitions on separate elements, started by the
   same flip).

---

## 8. The single-toggle question (and why we did not build a slot pool)

A genuine single *DOM* listen-point across subtrees would require a per-door
scalar on the common ancestor (`.scene`) — `--door-N` 0→1 read by every
surface — which needs a registered slot **pool** (`CSS.registerProperty` is
once-per-name-forever, so register `--door-0…--door-31` once at boot; max
doors per level is **20**, E1M5). That was judged **too much machinery for the
payoff** — it turns "~3 writes per toggle" into "1 write," on an event that
fires a few times per second.

Resolution: the single toggle lives at the **dispatch** level (the game already
fires one `setDoorState`), and the renderer fans it to the sector + the door's
1–3 faces (one E1M3 outlier has 22). No pool, no generated stylesheet, no
per-door names. The slot pool is documented here only as a rejected option.

---

## 9. Generalizing the build — no per-mover build command

With no reparenting, a door/lift/crusher has **no special DOM** — its flats,
faces, and jambs are ordinary sector/wall/surface geometry. So the generic
builders (`buildSectorContainers` + `buildWalls` + the merged horizontal
surface builder) construct *all* of it with zero mover knowledge. What remains
is **annotation**, not construction, and belongs in **map enrichment** (where
`initDoors` already finds door walls), consumed via per-record flags:

- sector record: `isDoor`/`isLift`/`isCrusher` + `travel` → `buildSectorContainers`
  sets `data-mover` + `--travel`.
- wall record: `isDoorFace` + `doorSector` + `openHeight` → `buildWalls` adds
  `.door-face`, `--travel`, `.unpegged`, pushes to `doorFaces`.

`buildDoor` / `buildLift` / `buildCrusher` as DOM builders **disappear**; the
runtime keeps only the tiny `setXState` impls (flip the sector attr, walk the
registry).

The one upstream prerequisite: **normalize synthesized geometry into the
standard arrays.** Today door jambs are stored at `0/0` (collapsed-when-closed,
skipped by `buildWalls`) and lift shaft walls live in a `lift.shaftWalls`
sub-array — both forcing per-mover synthesis. Have the exporter emit them as
ordinary walls (jambs at `floor..openHeight`, shaft walls in `mapData.walls`)
and the generic build handles them with no special case.

---

## 10. Firefox: the one gating spike

The whole "animate a property on the sector, descendants consume it in
`transform`/`calc`" pattern is the same one `lighting.css` had to **abandon**
for Firefox (it applies the glow animation to descendant `.wall/.floor/.ceiling`
directly because animating `--light` on the parent sector didn't re-evaluate
the children). So before relying on §2–§4:

> **Spike: animate `--offset`/`--floor` on a sector in Firefox and confirm a
> child's `transform`/height re-evaluates each frame.** (`@property`
> registration may or may not fix it — `--light` is registered and still
> needed the workaround.)

Fallbacks if it fails, both pool-free and single-toggle-preserving:

- **In-sector** surfaces: move the animation onto the descendants via a
  same-subtree descendant selector — `.sector[data-state="active"] :is(.floor,
  .ceiling) { animation: … }` — the exact `lighting.css` trick.
- **Out-of-sector faces** are *inherently* Firefox-safe already: direct-drive
  animates `--offset` *on the element*, not via inheritance.

So the out-of-sector half carries no Firefox risk; only the in-sector half
depends on the spike, with a known escape.

---

## 11. Migration phases

1. **Add sector geometry, keep old paths.** Set `--start-z`/`--end-z`/
   `--sector-path`/bbox on `.sector`; register `--offset`/`--floor`/`--ceiling`.
   Nothing reads them yet. Pure addition.
2. **Bare floors/ceilings.** Switch surfaces to inherit `--floor`/`--ceiling` +
   bbox + `--sector-path`; collapse to one surface per sector via the compound
   path. Verify pixel-identical static render (screenshot diff); verify the
   E1M6-168 hole and an E1M2-178 adjacency.
3. **Things inherit `--floor`.** Drop per-thing z; add `--air-z`. Verify
   enemies/pickups, including the E1M1 imp platform.
4. **Lifts onto the sector.** `data-mover="lift"` + `data-state`; delete
   `.platform` reparent and the `updatePlayerFromLift` thing-loop. Verify a
   ride carries an enemy + corpse + pickup.
5. **Doors.** Rename wall `--floor-z/--ceiling-z` → `--start-z/--end-z`; tag
   `.door-face` + `doorFaces` registry; drive faces by `data-state`; drive the
   ceiling flat by the sector; delete `.panel`/`doorContainers`. Verify motion
   matches the old panel on E1M1; verify a `BIGDOOR2`-in-blink face (E1M6)
   now animates its light.
6. **Crushers** onto the same `--ceiling` channel; delete `.crusher`.
7. **Generalize the build** (§9) once the exporter normalizes jambs/shaft
   walls: retire `buildDoor`/`buildLift`/`buildCrusher`.

Run the **Firefox spike (§10) before phase 4.** Each phase is independently
verifiable and revertible.

---

## 12. What this deletes

- `.door > .panel`, `.lift > .platform`, `.crusher` containers + all
  reparenting and the per-element `--light` restating.
- `doorContainers` / per-mover container maps (→ `doorFaces` registry +
  sector attrs).
- The per-frame per-thing height fan-out (`updatePlayerFromLift` loop,
  `updateEnemyPosition` z-push, `setFloorHeight` surface loop).
- One DOM surface per *extra* region in multi-region sectors (N → 1).
- `--door-open`/`--door-closed` (→ shared `--offset`).
- Eventually `buildDoor`/`buildLift`/`buildCrusher` as DOM builders (§9).
- One arm of **C1** (the `createWallElement`-into-container jamb path).

## 13. Open questions / risks

- **Firefox propagation (§10)** — the gating spike; everything in §2–§4 rides
  on it.
- **Step-between-sectors smoothing** — with inheritance, only a sector's own
  `--floor` transitions (mover moves); a thing crossing a boundary via
  `reparentThingToSector` **snaps** to the new floor. Closer to DOOM, but a
  behavior change for enemies on stairs — confirm it reads acceptably.
- **Flat ↔ face sync** — shared `--dur`; verify no drift on a slow door.
- **Adjacency seam** (§5) — screenshot an E1M2-178-style sector.
- **Union-bbox build** (§5) — subpaths must be measured against the union bbox,
  not each region's own.
- **Coplanar closed-door flats** — door closed has `floor = ceiling = 0`;
  confirm the ceiling flat at `--ceiling = 0` doesn't z-fight the floor flat at
  `--floor = 0` (coincident today inside the panel, so likely fine).
- **`--offset` accidental inheritance** — registered `inherits:true` on the
  sector; a door face sets its own so it overrides, and a normal wall doesn't
  read `--offset` — but keep an eye on a face whose room is itself a mover.
- **Multiplayer** — `setDoorState` already fans per sector over the wire;
  catchup (`appendDoorCmds`) iterates by sector. Confirm the joiner-side apply
  flips the `.sector` + faces, not a `.panel`.
