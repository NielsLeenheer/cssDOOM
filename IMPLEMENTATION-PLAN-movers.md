# Implementation plan — static / mover containers

**Status: RESET (2026-06-15).** The previous version claimed "Phases 1–5
implemented." That was wrong: the implementation — and the plan itself —
violated two stated goals (no synthesized walls; one unified mechanism). This
revision re-derives the work from the goals and turns them into **hard per-phase
acceptance gates**. A phase is not "done" until every invariant below holds for
it; "deferred item" / "leave a TODO" is not an allowed outcome.

Turns the mover model pinned in `GLOSSARY.md` ("Movers") into code: every mover
is a sector whose `.sector` holds a `.static` group and one-or-more `.mover`
groups; the move is a `transform` on the `.mover`; light **and floor height** stay
on the sector and are read by its contents via inheritance.

**The whole point of the exercise (invariant 6):** the sector defines the floor
height; things and enemies inherit it and are rendered at the sector floor with
**no floor set on the thing and no per-thing floor dispatched**. Reparenting a
thing between sectors (`.static` for doors/crushers, the `.mover` for lifts) gives
it the correct height automatically. The wall/build/driver work below (Phases
A–E, done) is the groundwork; **Phase F is that payoff** and was missing from the
earlier revision of this plan.

---

## Goals → Invariants (hard gates)

These are not aspirations; each is a checklist item that fails the phase if false.

1. **A wall is a wall — no specials.** Every wall is a single, uniform kind of
   record in `mapData.walls`, owned by a sector (`sectorIndex`), with a height
   span. There are **no** per-mover wall types, arrays, or flags: `shaftWalls`,
   `trackWalls`, `isLiftWall`/`liftSectorIndex` are all **deleted**. A wall is
   not special because it belongs to a mover. The **only** mover-related data on
   a wall is an optional `{ moverType, moverSector }` tag, present iff the wall
   moves with that mover. There is no render-time wall fabrication. Walls on a
   mover sector's boundary are generated spanning the moving surface's **full
   range of motion**, so the geometry that becomes visible as the mover travels
   already exists as real walls.

2. **No reparenting — ever.** A wall element is created as a child of its
   **final** container and is never moved afterwards. The build decides the
   container up front from the wall's own data. No `appendChild`-ing existing
   elements out of `.static` into a `.mover`; no moving a surface from the
   fragment root into a sector. Walls are *born in the right container*.

3. **One unified mechanism.** Door, lift, and crusher share **one** build path
   and **one** driver. They differ only in (axis, trigger, offset source),
   expressed as data/parameters — never as separate hand-rolled code. No
   bespoke per-type element construction (the hand-rolled lift `.mover` is out).

4. **Walls live in their own sector.** A wall is always inside (a group within)
   its owning sector's `.sector`. A moving face owned by sector N is built into
   a `.mover` group **inside sector N** — never relocated across a sector
   boundary. Light/bbox/outline therefore inherit correctly with no re-set.

5. **Mover linkage is data.** Each `.mover` group is tagged
   `data-mover="<type>:<controllingSectorIndex>"`. The driver finds and moves
   every group for a mover by that tag. One mover ⇒ many groups (its own sector
   plus each adjoining sector that owns a face it drives).

6. **The sector defines the floor; things inherit it — this is the whole point.**
   A sector carries its floor height (`--floor-z` on the `.sector`, alongside
   `--light`/bbox/`--outline`). Floors, things, and enemies in that sector are
   rendered at that height **purely by inheritance** — **nothing sets a floor on
   a thing/enemy, and no per-thing floor is dispatched.** A thing rides a moving
   floor only by *living in the moving container*: reparented into `.static` for
   door/crusher sectors (floor static) and into the lift `.mover` for lift sectors
   (rides the translate). Crossing into another sector is a `reparentThingToSector`
   only — it re-inherits the new sector's floor automatically, no height value
   travels with the thing.

## Scope

CSS-family renderers only (`css`, `cat`, `flat`, `shade` import the same
`css/scene/mechanics/*` modules — one set of edits covers them). `canvas`/`webgl`
have their own non-DOM paths and are untouched. The permanent floor-special path
(`setFloorHeight`, donut/lower) is a separate animation path and out of scope.

---

## Current state vs. the invariants (what's actually broken)

- **Inv 1 (no synthesized walls): FAIL.** `extract-maps.js` synthesizes
  `lift.shaftWalls`; the real lift boundary walls are skipped at render time
  (`walls.js:58 if (wall.isLiftWall) continue;`). Doors synthesize static side
  walls via `door.trackWalls` → `createWallElement`. Both fabricate geometry.
- **Inv 2 (no reparenting): FAIL.** `buildDoor`/`buildCrusher` build walls into
  `.static`, then `appendChild` the face walls into `.mover` groups. Moving
  surfaces (ceiling/floor) are likewise reparented into the mover.
- **Inv 3 (one mechanism): FAIL.** `buildLift` hand-rolls its `.mover`
  (`document.createElement` + `className` + `dataset.mover`) instead of the
  shared helper; the lift face path (`shaftWalls`) is entirely different from the
  door/crusher face path (real `wallElements`).
- **Inv 4 (own sector): PARTIAL.** Phase-3 door/crusher faces go in their own
  sector; lift faces go into the lift's own mover (wrong sector → wrong light).
- **Inv 5 (data linkage): PARTIAL.** Groups are tagged `data-mover="door"` /
  `"lift"` / `"crusher"` — **without** the `:<idx>` controlling-sector suffix;
  drivers look up by sector key in a Map, not by the tag.

---

## Phase A — Map-data audit (FIRST; no code changes)

Goal: prove the map JSON carries, **per wall**, everything needed to place that
wall in its final container at creation time, with zero synthesis and zero
reparenting. For every wall we must be able to answer from data alone:

  (a) owning sector index, and
  (b) does it ride a mover — and if so, which mover **type** and which
      **controlling sector index**?

A1. Confirm every wall in `mapData.walls` carries its owner `sectorIndex`.
A2. For each mover type, determine how a face wall is linked to its mover:
    - Lift: `isLiftWall` + `liftSectorIndex` (already present?).
    - Door / crusher: is there an explicit controlling-sector field, or only
      `isUpperWall` + `front/backSectorIndex` adjacency to a door/crusher sector?
A3. Enumerate every wall currently produced **only** via synthesis
    (`lift.shaftWalls`, `door.trackWalls`) and check whether an equivalent real
    wall already exists in `mapData.walls` (match by linedef/geometry). The gap
    list = walls the generator must start emitting (or annotating) so they can be
    real.
A4. Inspect the geometry the synthesis adds that a naive real wall lacks — full
    travel-range height span, both sidedef faces, and the one-way-lift gap
    extension (E1M1 type-36). Decide what the generator must emit as real
    geometry to cover each.
A5. Output: a concrete gap list per map driving Phase B. **No edits in Phase A.**

### Phase A — Results (audited 2026-06-15, all 9 E1 maps)

Of 209 synthesized lift `shaftWalls`, a **height-aware** check (endpoints +
texture **+ does a real wall actually cover the shaftWall's `[bottom..top]`
band**) gives:

| shaftWall kind | count | real wall fully covers band | partial / wrong band | none |
|---|---|---|---|---|
| platform face (moving riser) | 108 | 102 | 6 (one-way span, G2) | 0 |
| well wall (sides/backs)      | 101 | 2 | 70 | 29 |

**Correction (2026-06-15):** an earlier endpoint-only match wrongly reported
"only 29" well-wall gaps. Height-aware, **99 of 101 well walls are NOT real** —
the real wall at those endpoints covers only the band *above* the resting
platform; the well lining *below* it (revealed on descent) is synthesized. The
platform faces, however, are genuinely real (102 exact + 6 needing span).

Real platform-face walls carry owner sector, `isLiftWall` + `liftSectorIndex`,
and the **correct** light (e.g. E1M2 lift 137 → `ld178`, owner sector 121, light
112 — the synthesized shaftWall wrongly stamps 255).

Doors: faces + jambs are all real walls (filtered in `shared/maps/doors.js`).
Crushers: **none in E1.** The two former entries (E1M3·73, E1M7·152) were doors
mis-classified by a type-set overlap — linedef type 63 ("SR Door Open-Wait-Close")
was wrongly in `CRUSHER_TYPES`. Fixed in Phase B (63 removed); `mapData.crushers`
is now empty for E1, so the crusher tag path is implemented but unexercised here.

**Gaps for Phase B (generator):**
- **G1 — well lining (~99, was mis-counted as 29):** the static well walls
  revealed as a platform descends are almost entirely synthesized — 29 have no
  real wall at all, 70 have a real wall only in the band *above* the resting
  platform. Emit the below-platform well lining as **real static walls** spanning
  the travel range (owner = lift sector). The safe, low-risk route is to *promote
  the existing (correct, battle-tested) shaftWall computation* into real walls in
  `mapData.walls` rather than re-derive geometry from linedefs.
- **G2 — one-way-lift face span (6):** where the platform descends below the
  neighbour floor (type 36), emit the riser spanning the **full travel** to
  `lowerHeight`, not just the static step.
- **G3 — moving-face linkage: DECIDED (2026-06-15) — add explicit tags.** Every
  moving face wall gets a uniform `{ moverType, moverSector }` pair in the
  generator (`moverType` ∈ door|lift|crusher; `moverSector` = controlling sector
  index). Lifts normalise onto the same fields (replacing the ad-hoc
  `isLiftWall`/`liftSectorIndex`). This lets the renderer build each wall directly
  into `data-mover="<moverType>:<moverSector>"` inside its own sector with one
  code path and no adjacency computation.

**Conclusion:** the map data is ~86% sufficient; the only true generator work is
G1 + G2 (lift well/one-way geometry) and the G3 linkage decision. No door/crusher
geometry gap.

## Phase B — Generator emits all walls real, uniformly (clean replace)

One generic generation path for all movers; no per-type specials. After this
phase `mapData.walls` is the single source of every wall and the app's render may
be broken until Phase C — that is acceptable; **clean, consistent data is the
goal, not a working product mid-refactor.** (Generator lives in the separate
`generate/` repo; ship there and regenerate `public/maps/*.json`.)

Generic rule: a **mover** is a sector with one moving horizontal surface over a
range — lift = floor `[lowerHeight..upperHeight]`; door = ceiling
`[closedHeight..openHeight]`; crusher = ceiling `[crushHeight..topHeight]`. For
each boundary of a mover sector, generate the lower/upper walls spanning that
**range of motion** (not just the static rest position), as ordinary walls:
  - the wall that **moves with** the surface (the face/riser) → tag
    `{ moverType, moverSector }`, owner = the sector whose sidedef texture it is;
  - the wall **revealed behind** it (well lining / jamb) → ordinary static wall,
    owner = its own sector, **no** tag.

B1. Add the generic `{ moverType, moverSector }` tag to moving faces — lift
    risers (`'lift'`), door upper faces (`'door'`), crusher upper faces
    (`'crusher'`). `moverSector` = the controlling mover sector index.
B2. Generate the lift well lining (the ~99 below-platform walls) as ordinary
    static walls spanning `[lowerHeight..upperHeight]`, owner = lift sector.
B3. Generate the 6 one-way-lift faces spanning the full travel to `lowerHeight`.
B4. **Delete the specials**: stop emitting `lift.shaftWalls`; remove
    `isLiftWall`/`liftSectorIndex`. (`door.trackWalls` is a runtime filter, not
    generator output — removed when Phase C reads the tag instead.)
B5. Regenerate maps; re-run the height-aware audit — expect: no `shaftWalls`/
    `isLiftWall` anywhere, every wall a uniform record, every moving face tagged,
    and the previously-synthesized well lining present as ordinary walls.

## Phase C — Build every element into its final container (no reparenting)

Goal: the renderer reads the uniform Phase-B `mapData.walls` (+ floors / ceilings
/ things) and places each element into its **final** DOM container at creation —
either its sector's `.static` group or a `.mover[data-mover="type:idx"]` group
inside its **own** sector — with **no reparenting** and **one** code path for
door / lift / crusher. The per-type `buildDoor`/`buildLift`/`buildCrusher`
reparenting and the `shared/maps` `trackWalls` helper are deleted.

**New shared piece — mover-group registry** (`mechanics/movers.js`):
- `sceneState.moverGroups: Map<"type:idx", HTMLElement[]>` — every group for a
  mover (its own sector + each neighbour sector that owns a face), for the driver.
- `getMoverGroup(ctx, ownerSectorIndex, moverType, moverSector)`:
  key = `${moverType}:${moverSector}`; deduped per (ownerSector, key). Creates a
  `.mover`, sets `dataset.mover = key`, sets the offset var (`--offset` for
  lift/door from travel distance, crusher base from `--crusher-offset`) by looking
  the mover up in `mapData.{lifts,doors,crushers}` by `moverSector`, appends to
  `sectorContainers[ownerSectorIndex]` (sibling of `.static`), and registers it in
  `moverGroups` + a per-build cache. Replaces `createMoverGroup` and the three
  per-type container Maps (`doorContainers`/`liftContainers`/`crusherContainers`).

**C1 — Walls route themselves** (`surfaces/walls.js`):
- Delete the `isLiftWall` skip (line 58) — lift walls are ordinary walls now.
- In `buildWalls`, pick the target per wall: `wall.moverType` →
  `getMoverGroup(ctx, wall.sectorIndex, wall.moverType, wall.moverSector)`,
  else static via `appendToSector`. Element creation is otherwise unchanged.
  (Door faces get `.unpegged` from `wall.isUnpegged`, already handled.)

**C2 — Moving surfaces born in the mover** (`surfaces/horizontal.js`, `floors.js`,
`ceilings.js`):
- Build a moving-plane lookup from mapData: lift sectors move the **floor**,
  door + crusher sectors move the **ceiling**.
- In `buildHorizontalSurface`, if this sector's moving plane == this surface type,
  append to `getMoverGroup(ctx, sectorIndex, type, sectorIndex)` instead of
  static. Lift floor → `lift:idx`; door/crusher ceiling → `door:idx`/`crusher:idx`.
  No reparent (deletes the surface-reparent loops in the mechanics files).

**C3 — Things ride lifts, no reparenting** (`sectors.js`, `entities/things.js`):
- `sectorFloorTarget` returns the lift's mover group (`lift:idx`) for lift
  sectors, else `.static`. (Replaces the `sector.floorContainer = mover`
  reparent in `buildLift`.) Door/crusher things stay static.

**C4 — Delete the per-type build functions** (`mechanics/{doors,lifts,crushers}.js`,
`scene.js`):
- With C1–C3, geometry self-routes; `buildDoor`/`buildLift`/`buildCrusher` have
  nothing left to reparent. Remove them and the loop at `scene.js:154-163` (and
  the same loops in `cat`/`flat`/`shade` `scene.js`). Confirm no mover lacks any
  of its own geometry (a group is created on demand by its first wall/surface).

**C5 — Remove `trackWalls`** (`shared/maps/doors.js`, `game/level.js`):
- Door jambs are ordinary static walls; faces carry tags. Delete `initDoors`'
  trackWalls computation, the `door.trackWalls || []` args in the four
  `scene.js` files, and the `game/level.js` enrichment note.

**C6 — Physics** (`game/physics.js:216`):
- Replace `wall.isLiftWall` / `wall.liftSectorIndex` with
  `wall.moverType === 'lift'` / `wall.moverSector`; animated-height logic is
  unchanged. (Door face passability already keys off `isUpperWall` + door lookup.)

**C7 — canvas / webgl (non-DOM). DECIDED: migrate them, don't leave broken.**
They read `lift.shaftWalls` / `isLiftWall` (`canvas/passes/walls.js:22,70`,
`webgl/passes/walls.js:53,78`, `canvas/scene.js:167,186`). Rework them to render
lift walls straight from `mapData.walls` (lift walls are ordinary walls now),
dropping the `isLiftWall` skip and the `shaftWalls` loop, and animate a wall by
`moverType==='lift'` + the mover's current height from game state (same height
logic as physics C6).

**Verify:** per CSS-family renderer — E1M1 door open/close, E1M2 lift 137 up/down
(riser now lit by sector 121, light 112), a thing riding a lift; assert every
element is appended exactly once (no `appendChild` of an existing node) and all
`data-mover="type:idx"` groups move in lockstep. Diff vs the Phase-0 baseline.

## Phase D — One generic driver

Replace `setDoorState` / `setLiftState` / `setCrusherOffset` with a single
`setMoverState(renderer, moverType, sectorIndex, value)` that reads
`sceneState.moverGroups.get(\`${moverType}:${sectorIndex}\`)` and applies to every
group: lift/door → `dataset.state = value`; crusher → `--crusher-offset = value`.
Touches the world-command registry (`renderer.js` + the command lists in
canvas/webgl/shade/flat/cat) and dispatch sites (`game/mechanics/{lifts,doors}.js`,
`game/catchup.js`). **DECIDED: rename to a single `setMoverState` everywhere** —
no wrappers; update all command registries and dispatch sites.

## Phase E — Cleanup & verify

Delete `shaftWalls`/`trackWalls`/`isLiftWall` synthesis and dead container code.
Pixel-verify E1M1 (closed→open door, lift down/up, crusher cycle) in Chromium
**and** Firefox against a Phase-0 baseline. Update `GLOSSARY.md`.

## Phase F — Sectors carry the floor; things & enemies inherit it (invariant 6)

The payoff phase. A thing is rendered at its sector's floor purely by
inheritance; nothing sets a floor on the thing and no floor height is dispatched
per move. **Current state: not done** — the sector sets no `--floor-z`, every
thing writes its own `--floor-z`, and `floorHeight` is dispatched on every
player/enemy move and every lift frame. The reparent-into-the-right-group half is
already in place (`sectorFloorTarget`, C3).

F1. **Sector carries `--floor-z` AND `--ceiling-z`.** `buildSectorContainers`
   sets `--floor-z = sector.floorHeight` and `--ceiling-z = sector.ceilingHeight`
   on the `.sector` (joining `--light`/bbox/`--outline` as inherited sector
   geometry). The **floor surface, ceiling surface, and things** all read these
   by inheritance — drop the per-surface `--floor-z`/`--ceiling-z` writes in
   `horizontal.js` (and the per-thing writes, F2). For a mover, the moving
   surface lives in the `.mover` and reads the sector's **rest** height while the
   `.mover` translate adds the motion (lift floor rides `--floor-z` rest;
   door/crusher ceiling rides `--ceiling-z` rest) — so surfaces and things alike
   compose inherited-rest-height + the translate.
F2. **Things stop setting their own floor.** Remove every per-thing `--floor-z`
   write for floor-standing entities (`sprites.js` `updateThingPosition` /
   `resetEnemy` / `createPlayerSprite` / `createCorpse`); the thing transform
   reads the inherited `--floor-z`. **Projectiles are out of scope and unchanged**
   — they are spawned with explicit start/end xyz and animate their own
   transform, are not reparented into a sector, and inherit nothing. **Also
   remove the `.enemy { transition: --floor-z 0.4s }`** (`things.css`): floor now
   changes by reparenting (instant), so an easing transition fights the instant
   reparent + `.mover` translate (dip-into-ground / jump-in-air when an enemy
   crosses a lift edge). Enemies snap to the inherited floor (DOOM-correct); lift
   riding stays smooth via the `.mover` transform, not `--floor-z`.
F3. **Reparent is the only floor mechanism.** A thing lands in its sector's group
   via `sectorFloorTarget` — `.static` for static/door/crusher sectors, the lift
   `.mover` for lift sectors (done, C3). `reparentThingToSector` (already
   dispatched on sector change — `movement.js`, `ai.js`) moves it so it inherits
   the new sector's `--floor-z`. No floor value travels with the move.
F4. **Delete the floor fan-out — wider than first written.** The dispatched
   `floorHeight` is consumed by **non-CSS consumers that cannot inherit**; each
   must re-source the thing's floor from the sector *before* the arg is dropped:
   - **CSS culler** (`culling.js` sky-wall test, `gameEntry.floorHeight`) → read
     `mapData.sectors[t.sectorIndex].floorHeight` (it already has `t.sectorIndex`).
   - **canvas / webgl** (`Scene.updateThingPosition(i,x,y,floorZ)`,
     `canvas/scene.js`) — already derive static-thing floor from the sector poly
     (`scene.js:215`); add `scene.lifts.get(sectorIndex).current` for lift riders,
     drop the dispatched `floorZ`.
   Then drop `floorHeight` from `updateThingPosition` (dispatch in `movement.js`
   player + `ai.js` enemy; impls in css/canvas/webgl), delete the per-frame lift
   thing-loop (`lifts.js` `updateThingPosition [i,x,y,currentHeight]` — riders ride
   the `.mover` / read `lifts.current`), drop `floorHeight` from the catch-up
   position tuples, and remove the now-dead renderer `thing.floorHeight` writes.
   (Physics keeps its own JS floor state — `getFloorHeightAt`,
   `liftState.currentHeight` — unchanged; only the **renderer** fan-out goes.)
F5. **Verify.** Pickup/enemy/corpse at the right height in a static sector with
   zero per-thing floor writes; an enemy walking across a step snaps to the new
   floor on reparent (DOOM-correct — see risk); enemy + pickup + corpse ride the
   sector-59 lift down with no per-thing floor updates; a joiner gets correct
   thing heights from catch-up via inheritance alone.

Risks specific to F: **Firefox** must re-evaluate a child's `transform` when
`--floor-z` changes on the parent sector (the `--light` animation needed a
descendant-selector workaround — but `--floor-z` here is *set once per sector*,
not animated, and lift motion is a `transform` on the `.mover`, not a `--floor-z`
animation, so this is lower-risk than the animated case). **Step smoothing:** a
thing crossing a boundary now snaps to the new floor on reparent instead of
easing — closer to DOOM, but confirm it reads acceptably for enemies on stairs.

---

## Risks / call-outs

- **Generator is a separate repo** (`generate/`); Phase B changes ship there and
  require regenerating `public/maps/*.json`.
- **One-way lifts** (type 36): the gap the old `shaftWalls` extension closed must
  be reproduced by **real** generated geometry, not render-time fabrication.
- **Cross-renderer blast radius:** `css`/`cat`/`flat`/`shade` share the mechanics
  modules — verify at least one non-`css` member still builds.
- **Pixel parity:** the end state must match the pre-refactor render exactly
  except where the old output was itself wrong (e.g. lift face light).
