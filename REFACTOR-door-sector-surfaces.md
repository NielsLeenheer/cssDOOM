# Refactor: Per-sector door surfaces (stop reparenting into a `.door` panel)

Status: design proposal · Owner: TBD · Relates to: `CSS-RENDERER-IMPROVEMENTS.md`
items **B5** (movers). **Depends on** `REFACTOR-sector-height-inheritance.md`
(the `--ceiling` channel this doc drives is defined there).

---

## Summary

Doors today are built by **pulling surfaces out of their sectors** into a
separate animated `.door > .panel` container. That severs every inheritance
relationship the sector provides — today just `--light` (which `buildDoor`
laboriously copies back onto each moved element), and after the height-
inheritance refactor it would also sever `--floor` / `--ceiling` /
`--sector-path`.

This refactor keeps door ceilings and face walls **inside their `.sector`**
and animates the door by transitioning the sector's inherited `--ceiling`.
The trigger stays a single attribute flip — it just moves from the `.door`
container onto the `.sector`, which also makes tagged doors that open several
sectors at once fall out for free.

---

## How it works today

`scene/mechanics/doors.js::buildDoor`:

1. Creates `.door > .panel`.
2. **Reparents** the door sector's ceiling surfaces into `.panel`, copying
   `--light` onto each (inheritance from the sector is now broken, so the
   value must be restated).
3. **Reparents** the face walls (upper walls bordering the door sector) into
   `.panel`, again restating `--light`, and adds `.unpegged`.
4. Builds the static **track walls** (jambs) via `createWallElement` and
   appends them to the `.door` group (not the moving panel).
5. Records `doorContainers: Map<sectorIndex, .door>`.

`setDoorState(sectorIndex, 'open'|'closed')` flips `data-state` on the
`.door`; `mechanics/doors.css` transitions `.panel`'s
`translateY(var(--offset))` where `--offset = -(openHeight - closedHeight)`.

Game side (`game/mechanics/doors.js`) owns all the *logic*: `tryOpenDoor`
(forward use-cast against walls bordering a door sector), key checks,
auto-close timer, the "player in the doorway → reverse" guard, and the
`passable` timing. None of that is in CSS.

### Why the panel model fights the architecture

- **Inheritance severed.** Moving a surface out of its `.sector` loses
  `--light` today (hence the manual copy) and would lose `--floor` /
  `--ceiling` / `--sector-path` after the height refactor — every one would
  need restating on the panel, multiplying the very inline writes that
  refactor removes.
- **One door = one sector assumption.** `buildDoor` runs per
  `mapData.doors[i]`, each with a single `sectorIndex`, and `doorContainers`
  is keyed by that index. DOOM **tagged/remote doors** open *every* sector
  with a matching tag from one trigger (none in the current E1M1–E1M9 set,
  but the engine should support them). The panel model would need either N
  panels driven together or one panel spanning sectors with mismatched
  geometry and light — both awkward.

---

## Proposed design

### Keep surfaces in the sector; animate `--ceiling`

Don't reparent. The door's ceiling flat and face walls stay children of
their `.sector`. Opening the door = transitioning the sector's effective
ceiling from `closedHeight` to `openHeight`:

```css
/* the door sector animates its own ceiling; contents inherit it */
.sector[data-door="open"] { --ceiling-offset: var(--door-travel); }
.sector { transition: --ceiling 1s ease-in-out; }
```

where `--door-travel = openHeight - closedHeight`, set on the sector at
build time, and `--ceiling = calc(var(--end-z) + var(--ceiling-offset, 0))`
from the height-inheritance refactor.

What inherits and moves:

- **Ceiling flat** — already reads `--ceiling` for its z (height doc), so it
  rises with the door. No special-casing.
- **Door face / upper walls** — their **bottom** is the door sector's
  effective ceiling and their **top** is the fixed room ceiling. So a face
  wall reads the inherited `--ceiling` for its bottom edge:

  ```css
  /* a door face wall: top fixed (room ceiling), bottom rides the door */
  .wall.door-face {
      --floor-z: var(--ceiling);   /* inherited from the door sector */
      /* --ceiling-z stays the static room-ceiling top */
  }
  ```

  The wall is positioned at its (fixed) top vertex and its height is
  `top - var(--floor-z)`, which shrinks as `--ceiling` rises; with
  `.unpegged` (texture pinned to the bottom) the door texture slides upward —
  exactly the DOOM behavior, and exactly what the panel `translateY`
  approximates today, but now driven by the same inherited channel as
  everything else.

### Trigger: one attribute on the sector

`setDoorState(sectorIndex, state)` flips `data-door` on the **`.sector`**
container (replacing the `doorContainers` lookup). The trigger is just as
simple as today's `.door[data-state]` — one attribute — it just lives on the
sector now.

**Tagged / multi-sector doors fall out for free:** the game dispatches
`setDoorState` to each sector in the tag group; each sector animates its own
`--ceiling` independently from its own `--end-z`. No grouping construct in
the renderer at all.

### Track walls stay as ordinary sector walls

The static jambs (`trackWalls`) are solid walls bordering the door; they
belong to their own sectors and are built by `buildWalls` like any other
wall. The special `createWallElement`-into-`.door` path is removed (this also
retires one arm of checklist item **C1**, the `buildWalls` /
`createWallElement` divergence).

---

## The "CSS-only trigger" question

The open question from the brief: *can the door be triggered with a simple
CSS-only mechanism?*

**Animation: yes, already CSS-only.** Flipping one attribute/property on the
sector drives the whole open/close through inheritance + transition — no
per-element JS, no panel. That's strictly simpler than today.

**Activation: no, and it shouldn't be.** Whether a door *may* open is game
logic that CSS can't express:

- proximity + facing (the forward use-cast in `tryOpenDoor`),
- key possession (`keyRequired` vs `player.collectedKeys`),
- auto-close timer and the "player in the doorway → reverse instead of
  crush" guard,
- multiplayer authority (only the host simulates; clients receive
  `setDoorState` over the wire).

Pure-CSS trigger hacks (`:has()`, `:target`, checkbox, `:hover`) can't read
world distance, inventory, or remote state, and would diverge from the
authoritative simulation in Network DM. So the boundary stays:

> **JS decides *when*** (one `setDoorState(sectorIndex, state)` dispatch,
> exactly as now) **— CSS does *everything after*** via the sector's
> `--ceiling` channel.

The win isn't removing JS from the decision; it's that the decision sets a
single inherited property and the rendering — ceiling flat, face walls, any
things in the doorway sector, lighting — all follow with no further dispatch,
across any number of grouped sectors.

(If a *non-gameplay* CSS-only demo door is ever wanted — e.g. an attract-mode
flourish — the same `--ceiling` channel can be driven by a keyframe animation
or a `:has(:checked)` toggle without touching the gameplay path. Noting it as
possible, not as the plan.)

---

## What this deletes / simplifies

- **The `.door > .panel` container and the reparenting** in `buildDoor`
  (ceiling + face-wall moves, and the `--light` restating that compensates
  for broken inheritance).
- **`doorContainers: Map<sectorIndex, .door>`** — `setDoorState` targets the
  `.sector` directly.
- **The grouped-door problem** — never constructed; per-sector dispatch
  handles tag groups.
- **One arm of C1** — door track walls become ordinary `buildWalls` output;
  the `createWallElement`-into-panel path retires.

---

## Migration phases

1. **Land the height-inheritance refactor first** (sibling doc) so
   `--ceiling` / `--ceiling-offset` exist and the ceiling flat already reads
   `--ceiling`.
2. **Mark door face walls.** In `buildWalls` (or door enrichment), tag the
   upper walls bordering a door sector with `.door-face` and have them read
   the inherited `--ceiling` for their bottom. Verify a closed door looks
   identical.
3. **Drive the door from the sector.** Set `--door-travel` + `data-door` on
   the `.sector`; delete the `.panel` reparenting and `doorContainers`.
   Point `setDoorState` at the sector container. Verify open/close animation
   matches the old panel motion (side-by-side on E1M1's first door).
4. **Crushers** share the `--ceiling-offset` channel (ceiling moving down) —
   fold `setCrusherOffset` onto the sector at the same time.
5. **Add a synthetic tagged-door test map** (or temporarily tag two adjacent
   door sectors) to confirm grouped open/close, since the shipped maps have
   no tagged doors.

---

## Risks / open questions

- **Door sector also has a floor + things.** Animating `--ceiling` must not
  disturb `--floor` or things standing in the doorway — they read `--floor`,
  a separate channel, so they stay put. Confirm the two channels are fully
  independent (they are by construction: `--floor`/`--floor-offset` vs
  `--ceiling`/`--ceiling-offset`).
- **Face-wall bottom inheriting `--ceiling`.** Walls otherwise set their own
  `--floor-z`; door faces must *not* set it and must inherit. Needs a clear
  rule so a normal wall and a door-face wall don't get crossed wires
  (registered `--floor-z` inherits, so an unset face wall would inherit the
  sector's `--floor-z` if one existed — make sure the sector exposes
  `--ceiling` under a distinct name and the face wall reads *that*, e.g.
  `--floor-z: var(--ceiling)`).
- **`passable` vs visual timing.** Game-side `DOOR_PASSABLE_DELAY` (0.8s)
  must still roughly track the CSS transition duration (1s) as it does today;
  keep them defined against a shared constant if possible.
- **Texture peg / unpegged.** Confirm the door texture still pins and slides
  correctly when the motion comes from a shrinking wall height rather than a
  panel translate (lower-unpegged background-position math in `walls.css`).
- **Multiplayer.** `setDoorState` already fans over the wire per sector; the
  per-sector model matches that exactly. Catchup (`catchup.js::appendDoorCmds`)
  iterates `state.doorState` by sector and would target sectors the same way —
  confirm the joiner-side apply hits the `.sector` attribute.
- **Light on the moving ceiling.** Today `buildDoor` copies the door sector's
  light onto the moved ceiling; once the ceiling stays in its sector it
  inherits `--light` natively, including light-effect animations — a small
  correctness improvement, but verify no door relied on the copied (possibly
  different) value.
