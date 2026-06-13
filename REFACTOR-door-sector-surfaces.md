# Refactor: Doors are sectors — animate the sector, delete the `.door` panel

Status: design proposal · Owner: TBD · Relates to: `CSS-RENDERER-IMPROVEMENTS.md`
items **B5** (movers), **C1** (wall-creation dedup). **Depends on**
`REFACTOR-sector-height-inheritance.md` (the `--ceiling` channel this doc
drives is defined there).

---

## Summary

A DOOM door **is a sector** — a thin slab sector whose ceiling drops to the
floor when closed and rises when open. The renderer already builds a
`.sector` container for it (every sector index gets one). Yet `buildDoor`
creates a *second* container, `.door > .panel`, and **moves the real
sector's surfaces into it** — gutting the sector div it already had.

This refactor deletes that duplication. The door's own `.sector` container
becomes the door: flip one attribute on it and animate its inherited
`--ceiling`; the ceiling flat and the door-face walls follow. This makes
doors, lifts, and crushers the **same shape** — "a sector with one animating
height channel" — and makes tagged multi-sector doors fall out for free.

> **A door = a `.sector` whose `--ceiling` animates.**
> **A lift = a `.sector` whose `--floor` animates.** (see sibling doc)
> No bespoke mover container for either.

---

## Anatomy of a real door (E1M1 sector 4)

Closed state: `floor = 0`, `ceiling = 0` (a zero-height slab). Open:
ceiling rises to `68`. Four linedefs — two "end" lines (the faces), two
"side" lines (the jambs):

| Component | Map sectorIndex | Built by | Container today | Moves? |
|---|---|---|---|---|
| Ceiling flat (`FLAT20`) | 4 (door) | `buildCeilings` | `#s4` → **moved into `.panel`** | rises 0→68 |
| Floor flat (`FLOOR4_8`) | 4 (door) | `buildFloors` | `#s4` (stays) | no |
| Face `BIGDOOR2` → room 3 | **3** (room) | `buildWalls` | `#s3` → **moved into `.panel`** | bottom rises |
| Face `BIGDOOR2` → room 0 | **0** (room) | `buildWalls` | `#s0` → **moved into `.panel`** | bottom rises |
| Two `DOORTRAK` jambs | 4 (door) | `buildDoor` (synth) | `.door` group (static) | no |

Two things the data makes clear:

1. **The visible face is lit by the *room*, not the door.** `BIGDOOR2` has
   `sectorIndex = 3` / `0` (front sidedef = the room), because DOOM lights an
   upper texture from its own sidedef's sector. So the faces live in the
   neighbour rooms' containers, not the door's.
2. **The `'-'` backface uppers and the `0/0` jambs are never built by
   `buildWalls`** — it skips no-texture and zero-height walls. The jambs are
   synthesised by `buildDoor` at `closedHeight..openHeight` (0..68) so the
   track frames the full opening.

So after `buildDoor` runs today, `#s4` is left holding only its floor flat;
its ceiling and both faces have been relocated into a parallel `.panel`,
each face carrying a **static `--light` copy** restated to compensate for
the inheritance the move severed.

---

## How it works today

`scene/mechanics/doors.js::buildDoor`:

1. Creates `.door > .panel`.
2. Moves the door sector's ceiling flat out of `#s{door}` into `.panel`
   (restates `--light`).
3. Moves the face walls (any upper wall with the door sector as front *or*
   back) out of their room containers into `.panel` (restates each one's own
   `--light`, adds `.unpegged`).
4. Synthesises the `DOORTRAK` jambs via `createWallElement` at
   `closedHeight..openHeight`, appends to the `.door` group (static).
5. Records `doorContainers: Map<sectorIndex, .door>`.

`setDoorState(sectorIndex, 'open'|'closed')` flips `data-state` on the
`.door`; `mechanics/doors.css` transitions `.panel`'s
`translateY(var(--offset))`, `--offset = -(openHeight - closedHeight)`.

Game-side `game/mechanics/doors.js` owns all *logic* — the forward use-cast
(`tryOpenDoor`), key checks, auto-close timer, the "player in the doorway →
reverse" guard, `passable` timing. None of that is in CSS, and none of it
changes here.

### Why the panel fights the architecture

- **It duplicates a container that already exists.** `buildSectorContainers`
  already made `#s{door}`. The panel is a second home for the same sector's
  surfaces.
- **It severs inheritance, then patches it by hand.** Moving surfaces out of
  their sector loses `--light` (hence the manual restating) and, after the
  height-inheritance refactor, would also lose `--floor`/`--ceiling`/
  `--sector-path`.
- **It encodes "one door = one panel."** Tagged/remote DOOM doors open every
  sector with a matching tag from a single trigger; the panel model needs N
  coordinated panels.

---

## Proposed design

### The door's own `.sector` is the door

Stop creating `.door`/`.panel`. Stop moving the door sector's ceiling out of
`#s{door}`. Opening the door = transitioning that sector's effective ceiling:

```css
/* the door sector animates its own ceiling; its contents inherit it */
.sector[data-door="open"] { --ceiling-offset: var(--door-travel); }
.sector { transition: --ceiling 1s ease-in-out; }
```

with `--door-travel = openHeight - closedHeight` set on the sector at build
time and `--ceiling = calc(var(--end-z) + var(--ceiling-offset, 0))` from the
height doc. `setDoorState(sectorIndex, state)` flips `data-door` on **`#s{sectorIndex}`**
— the door's own `.sector` — replacing the `doorContainers` lookup.

What follows for free, because they're genuine children of `#s{door}`:

- **Ceiling flat** — already reads `--ceiling` for its z (height doc), so it
  rises. Just don't move it into a panel anymore.
- **Floor flat** — reads `--floor` (a *separate* channel), so it stays put
  while the ceiling animates. The two channels never cross.

### The faces are the one cross-sector piece

The visible `BIGDOOR2` faces belong to the *room* sectors for lighting, so
they are **not** children of `#s{door}` and cannot inherit its `--ceiling`.
A door face is an upper wall whose **top** is its room's (static) ceiling and
whose **bottom** must track the door sector's rising ceiling:

```css
/* a door face: top fixed (its room ceiling), bottom rides the door sector */
.wall.door-face {
    --floor-z: var(--ceiling);   /* inherited door-sector ceiling = the wall's bottom */
    /* --ceiling-z stays the static room-ceiling top */
}
```

The wall sits at its fixed top vertex; its height is `top - var(--floor-z)`,
which shrinks as `--ceiling` rises; with `.unpegged` (texture pinned to the
bottom) the `BIGDOOR2` texture slides upward — exactly the motion the panel
`translateY` fakes today, now from the same inherited channel as everything
else.

For `--floor-z: var(--ceiling)` to resolve to the *door's* ceiling, the face
must be a child of `#s{door}`. **Reparent just the two faces into the door's
`.sector`, copying each face's own-room `--light` once at build.** This is
behaviourally identical to today — the current code already restates a static
`--light` on each face when it moves them into the panel — but now there is
no second container, and nothing moves per frame.

> **Alternative (no reparent):** leave the faces in their room containers and
> have `setDoorState` set the door's ceiling target on the face elements too.
> That preserves the room's *animated* light on the face (a one-time `--light`
> copy can't), at the cost of the trigger touching the faces as well as the
> sector. Pick the reparent model unless a door visibly needs its face to
> share an animated room light. Either way it's one write per open/close, not
> per frame.

### Jambs stay; they're just static sector walls

The `DOORTRAK` jambs (`sectorIndex = door`, currently synthesised in
`buildDoor`) are static and frame the opening across the full
`closedHeight..openHeight` span. They live in `#s{door}` naturally and need
no ceiling channel. Building them through the normal wall path (with proper
heights) retires the bespoke `createWallElement`-into-`.door` arm of **C1**.

---

## Unification: doors, lifts, crushers

All three collapse to "a sector with one animating height channel," driven by
a single attribute flip on the sector:

| Mechanic | Sector channel | Attribute | What inherits & moves |
|---|---|---|---|
| Lift | `--floor` (offset `--start-z`) | `data-lift` | floor flat + things in the sector |
| Door | `--ceiling` (offset `--end-z`) | `data-door` | ceiling flat + door faces |
| Crusher | `--ceiling` (offset down) | `data-crush`/`--ceiling-offset` | ceiling flat + upper walls |

Crushers fold in identically — `setCrusherOffset` writes the sector's
`--ceiling-offset` instead of translating a `.crusher` container; their upper
walls are the same cross-sector face case as doors.

---

## The "CSS-only trigger" question

**Animation: CSS-only, and now trivially so.** One attribute on the door's
own `.sector` drives the whole open/close through inheritance + transition.
No panel, no per-element JS, no per-frame work.

**Activation: stays in JS — it must.** Whether a door *may* open depends on
proximity + facing (the forward use-cast), key possession, the auto-close
timer, the "player in the doorway → reverse" guard, and multiplayer authority
(only the host simulates; clients receive `setDoorState` over the wire). CSS
selector hacks (`:has()`, `:target`, checkbox) can't read world distance,
inventory, or remote state and would desync from the authoritative sim. So:

> **JS decides *when*** — one `setDoorState(sectorIndex, state)` dispatch, as
> now — **CSS does *everything after*** via the sector's `--ceiling` channel.

The win isn't removing JS from the decision; it's that the decision flips one
attribute on the door's existing `.sector` and the rendering follows with no
further dispatch, across any number of grouped sectors.

### Tagged / multi-sector doors fall out for free

A remote trigger that opens every sector with a matching tag just dispatches
`setDoorState` per sector in the group. Each door sector is its own `.sector`
animating its own `--ceiling` from its own `--end-z`. **No grouping construct
in the renderer at all** — the per-sector model *is* the group model. (No
tagged doors exist in the shipped E1M1–E1M9 maps; add a synthetic test map to
exercise this.)

---

## What this deletes / simplifies

- **The `.door > .panel` container and all reparenting of the ceiling** — the
  ceiling flat stays in its sector and inherits the animating `--ceiling`.
- **`doorContainers: Map<sectorIndex, .door>`** — `setDoorState` targets
  `#s{sectorIndex}` directly.
- **The per-face `--light` restating** shrinks to a one-time copy on just the
  two reparented faces (or disappears entirely under the no-reparent
  alternative).
- **The grouped-door problem** — never constructed.
- **One arm of C1** — the `createWallElement`-into-`.door` jamb path retires;
  jambs become ordinary sector walls.
- **The `.crusher` container** — same collapse onto the sector's `--ceiling`.

---

## Migration phases

1. **Land the height-inheritance refactor first** (sibling doc) so
   `--ceiling`/`--ceiling-offset` exist and the ceiling flat already reads
   `--ceiling` from its sector.
2. **Tag the faces.** In `buildWalls` (or door enrichment) mark the upper
   walls bordering a door sector with `.door-face`, reparent each into the
   door's `#s{door}` with a one-time own-room `--light` copy, and have them
   read `--floor-z: var(--ceiling)`. Verify a *closed* door is pixel-identical
   to today (faces full-height, lit by their rooms).
3. **Drive the door from the sector.** Set `--door-travel` + `data-door` on
   `#s{door}`; delete `.door`/`.panel` and `doorContainers`; point
   `setDoorState` at the sector. Verify the open/close motion matches the old
   panel translate side-by-side on E1M1's first door (room-0 face top 72,
   room-3 face top 88).
4. **Jambs through the normal wall path** (retire the `buildDoor` synth);
   confirm the `DOORTRAK` track still frames the full 0..68 opening.
5. **Crushers** onto the same `--ceiling` channel; delete `.crusher`.
6. **Synthetic tagged-door map** to confirm grouped open/close.

Each phase is independently verifiable (screenshot diff) and revertible.

---

## Risks / open questions

- **Reparented-face light is static** (reparent model). A face moved into the
  door sector carries a one-time `--light` copy and won't follow its room's
  *animated* light effect. This is **identical to today** (the panel copy is
  also static), so no regression — but if a future door needs an animated room
  light on its face, use the no-reparent alternative.
- **Face bottom must inherit `--ceiling`, not `--floor`.** The door sector
  exposes both; the `.door-face` rule reads `--ceiling` for `--floor-z`
  (the wall's bottom). Keep the names distinct so a normal wall and a door
  face never get crossed wires.
- **Floor/ceiling channel independence.** Animating `--ceiling` must leave the
  door sector's floor flat and any thing in the doorway untouched — they read
  `--floor`. True by construction (`--floor`/`--floor-offset` vs
  `--ceiling`/`--ceiling-offset`), but verify a thing standing under a closing
  door doesn't twitch.
- **`passable` vs visual timing.** Game-side `DOOR_PASSABLE_DELAY` (0.8s) must
  still track the CSS transition (1s) as today; define both against a shared
  constant if possible.
- **Texture peg.** Confirm `BIGDOOR2` pins and slides correctly when the
  motion comes from a shrinking unpegged wall rather than a panel translate
  (lower-unpegged `background-position` math in `walls.css`).
- **Multiplayer catchup.** `catchup.js::appendDoorCmds` iterates
  `state.doorState` by sector and fires `setDoorState` per sector — already
  the per-sector shape; confirm the joiner-side apply now flips the `.sector`
  attribute (not a `.door`).
- **Closed-state geometry.** With `closed = 0` the door slab is zero-height;
  confirm the ceiling flat at `--ceiling = 0` doesn't z-fight the floor flat
  at `--floor = 0` (it does today inside the panel — same coplanar pair, so
  likely fine, but check backface culling on the coincident flats).
