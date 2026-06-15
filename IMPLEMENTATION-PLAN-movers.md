# Implementation plan — static / mover containers

**Status: Phases 1–5 implemented, verified on E1M1, and pushed.** (Chromium
throughout; Firefox cross-check in Phase 5.) The one deferred item is the lift
`shaftWalls` / `isLiftWall` synthesis — see Phase 5 note.

Turns the mover model pinned in `GLOSSARY.md` ("Movers") into code. The goal:
**every mover is a sector** whose `.sector` holds a `.static` group and
one-or-more `.mover` groups; nothing is reparented into a *different* sector;
the move is a `transform` translate on the `.mover` container; light stays on
the leaf.

This replaces the current model, where `buildDoor`/`buildLift`/`buildCrusher`
create a freestanding `.door`/`.lift`/`.crusher` element at the **fragment root**
(a *sibling* of `.sector`) and reparent the moving surface + face walls *out* of
their sectors into it. That sibling-container approach is exactly what we delete.

## Naming

- The moving group is **`.mover`** (not `.moving` — that class already drives
  walk-cycle / weapon-bob via `.renderer.moving`, `.enemy.player.moving`,
  `.moving .scene`). GLOSSARY.md's `.moving` references are renamed to `.mover`.
- The non-moving group is **`.static`**.

## Why bbox/outline/light "just work"

A mover sector already has its own `.sector` (one per index, from
`buildSectorContainers`), carrying `--light`, the light-effect class, and
`--min-x/--max-x/--min-y/--max-y/--outline`. Because the `.mover` group is a
**child of that `.sector`** (the mover *is* the sector), its moving surface
inherits all of them — no manual re-set. The current `--light` re-set in
`doors.js:29` exists only because today the surface is reparented *out* of the
sector; once it stays in, that line is deleted.

## Scope

CSS-family renderers only (`css`, `cat`, `flat`, `shade` all import these
mechanics modules — one set of edits covers them). `canvas`/`webgl` have their
own non-DOM paths and are untouched. The permanent floor-special path
(`setFloorHeight`, donut/lower) is **out of scope** — separate animation path.

---

## Phase 0 — Baseline
1. Capture an E1M1 visual baseline: closed→open door, lift down/up, crusher
   cycle. This is the regression guard for every later phase. (Re-establish a
   Playwright harness in this container if needed; single pane is enough.)

## Phase 1 — `.static` inside every sector (behavior-neutral)
2. In `buildSectorContainers`, give each `.sector` a `.static` child; store it
   (`sceneState.sectorStatic[i]`) and expose a per-sector content target.
3. Point `appendToSector`'s sector branch at the `.static` child. Walls, floors,
   ceilings, and things now land in `.static`.
4. **Verify** pixel-identical to Phase 0 (custom props inherit through the extra
   div; `.sector .wall` descendant selectors still match). Pure nesting.

## Phase 2 — Mover groups become `.mover` children of their own sector
5. Delete the freestanding `.door`/`.lift`/`.crusher` root containers. In
   `buildDoor`/`buildLift`/`buildCrusher`, create a `.mover` group as a child of
   `sceneState.sectorContainers[sectorIndex]` (the mover's own `.sector`).
6. Put the moving surface (door/crusher ceiling, lift floor) in `.mover`. It now
   inherits `--light`, bbox, and `--outline` from its sector → **delete the
   `--light` re-set in `doors.js`**.
7. Port the drivers' CSS so the translate lives on `.mover` (door/lift via
   `data-state` transition; crusher via `--crusher-offset`).
8. **Verify** against baseline: doors/lifts/crushers still animate; moving
   surface is correctly shaped + lit.

## Phase 3 — Adjoining faces stay in their own sector
9. Split the face-wall loops by ownership: a wall with
   `_sectorIndex === mover.sectorIndex` → the mover's own `.mover`; a face wall
   owned by a **neighbour** sector → a `.mover` group created inside *that
   neighbour's* `.sector` (reparented within its own sector — never into the
   mover's). No more pulling neighbour walls into the mover's container.
10. Tag each group with the owning mover (`data-mover="door:<idx>"`); store all
    groups for a mover as an array (`doorContainers.get(idx)` → `[own, ...nbrs]`).
11. Update `setDoorState`/`setLiftState`/`setCrusherOffset` to drive **every**
    group for that mover in lockstep.
12. **Verify**: the face moves with the door but now inherits its neighbour's
    light; a sector adjoining two doors shows two independent `.mover` groups.

## Phase 4 — Things ride lifts
13. Per-sector floor-content target: `sector.floorContainer` = the lift's
    `.mover` for **lifts**, `.static` otherwise. Set at mover-build time (lifts
    build after things → reparent already-placed things in that sector into the
    lift `.mover`).
14. Route `reparentThingToSector` (`sprites.js`) and initial `buildThing`
    placement through `floorContainer`. Door/crusher sectors keep things in
    `.static` (no ride).
15. No animated `--floor-z` — things ride purely by the parent translate.
    (`updateThingPosition`'s `--floor-z` is placement, not ride; left alone.)
16. **Verify**: a thing/enemy on a lift rides it; a thing in a door/crusher
    sector stays put; `moveBefore` preserves walk-cycle across the reparent.

## Phase 5 — Cleanup & docs
17. Remove dead code (root-container assumptions; the `--light` hack — done in
    P2). Re-evaluate the lift `shaftWalls`/`isLiftWall` special case against the
    generic fixed-geometry-translate; remove or leave a TODO if it still closes
    one-way-lift gaps.
18. Update GLOSSARY.md wrinkles for movers; confirm `setFloorHeight` is noted as
    a separate, out-of-scope path.
19. Final pass across E1M1 in Chromium **and** Firefox 142 (pixel-level), diffed
    against the Phase 0 baseline.

---

## Risks / call-outs
- **Driving N groups (P3):** mover→groups is one-to-many; driver maps hold
  arrays, not single elements.
- **Cross-renderer blast radius:** verify at least one non-`css` family member
  still builds.
- **Order dependency (P4):** lifts build after things → rider reparenting at
  lift-build time *and* on later `reparentThingToSector`.

Each phase is independently verifiable and revertible. P1–P2 are plumbing; P3 is
the real behavioral change; P4 is the things-ride-lift payoff.
