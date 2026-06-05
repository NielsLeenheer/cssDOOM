# Debug commands

cssDOOM ships a developer/talk console hanging off a single global, `window.debug`,
plus an on-screen debug menu. None of it is part of the game proper — it lives
entirely under [`src/debug/`](src/debug/) and is wired up once at boot.

- **Console** — open your browser devtools and type `debug.<group>.<command>(…)`.
  Everything is grouped: `debug.position.*`, `debug.world.*`, `debug.sectors.*`, etc.
- **Menu** — call `debug()` (or click the cssDOOM logo) to open the debug menu, a
  panel of checkboxes/buttons in the top-left. The menu is declarative; its toggles
  live in [`src/debug/ui/registry.js`](src/debug/ui/registry.js).

The debug layer is organised as **features + two presenters**:

- [`features/`](src/debug/features/) — the actual capabilities (the visualisations,
  path record/replay, flag toggles, renderer swap, …), each a plain module.
- [`console/console.js`](src/debug/console/console.js) — wires each feature onto a
  `debug.*` group.
- [`ui/`](src/debug/ui/) — presents the same features as the menu.
- [`custom/`](src/debug/custom/) — the hand-authored talk set pieces + recordings.

---

## `debug.position` — player placement

| Command | Description |
| --- | --- |
| `teleport(x, y, angle?)` | Jump to exact coords; `angle` in **degrees** (optional). |
| `teleportTo(name)` | Jump to the first thing of a type, e.g. `teleportTo('spectre')`. |
| `save(slot = 0)` | Save the current map + pose to `localStorage`. |
| `load(slot = 0)` | Restore a saved pose (swaps level first if needed). |

## `debug.world` — inspect the level

| Command | Description |
| --- | --- |
| `dump()` | Log player position, angle, sector, health, map; returns the object. |
| `nearby(radius = 512)` | Console-table the walls / doors / lifts / things / projectiles around the player. |
| `triggers()` | List every map trigger (linedef special) with its tag and whether it fired. |
| `trigger(index)` | Fire a trigger by its index from `triggers()`. |
| `lifts()` | List every lift on the map (sector, tag, height, state). |
| `activateLift(sectorIndex)` | Activate the lift in a sector. |

## `debug.sectors` — "anatomy of a sector"

Pure DOM toggles on the `.sector#s{id}` containers; the motion/fade/highlight
lives in CSS ([`features/sectors.css`](src/debug/features/sectors.css)). They span
every pane. With **no `id`**, the per-sector commands act on every sector; `only`
takes one or more ids.

| Command | Description |
| --- | --- |
| `get(id)` | Return the sector's DOM element (first pane) to poke at directly. |
| `hide(id?)` | Hide a sector outright (`display:none`). |
| `show(id?)` | Reveal it — clears both `hide()` and `only()`'s fade. |
| `explode(id?)` | Animate the surfaces apart so the construction reads. |
| `implode(id?)` | Re-assemble (reverse of `explode`). |
| `only(...ids)` | Fade every sector **except** the given one(s) — `only(29)` or `only(29, 32)`. |
| `billboard(id?)` | Rotate the surfaces to face the camera (run after `explode`). |
| `highlight(id?)` | Flood the surfaces with a solid accent (`#F8BA00`), drop textures, lift brightness to full (light FX still play). |
| `unhighlight(id?)` | Remove the highlight and restore the renderer's brightness. |
| `showFloorGrid(id?)` | Fade in a grid copy of the floor showing its clipped-away space. |
| `hideFloorGrid(id?)` | Fade it back out and remove it. |
| `reset()` | Undo explode / billboard / fade / hide / highlight everywhere and drop floor grids. |

## `debug.sprites` — sprite-sheet stepped-animation viz

Lay a half-transparent clone of the **whole sprite sheet** over a sprite and
translate it in lockstep with the real stepped animation, so the active cell stays
pinned over the opaque original while the sheet slides — showing how the walk cycle
indexes the sheet. The original frame gets an outline.
([`features/sprites.css`](src/debug/features/sprites.css).)

| Command | Description |
| --- | --- |
| `showSheet(sectorId?)` | Ghost the sheet over every sprite in a sector (or all sprites). |
| `hideSheet(sectorId?)` | Remove the ghosts. |

Synced via the Web Animations API and follows state changes (walk → attack → die).
While active, the ghosted sprite is exempt from culling so it doesn't pop at screen
edges.

## `debug.layers` — cross-fade scene layers

Animated fades of a whole layer (vs the menu's instant hide toggles). Pass
`'walls'`, `'floors'`, `'ceilings'`, `'things'` (pickups / decorations / barrels),
`'enemies'`, or `'sky'`, or omit to act on all of them. `'corpses'` is an extra
sub-layer — just the map's dead-body / gore decorations (a subset of `'things'`,
not in the "all" set; pass it explicitly). Surfaces, things and enemies fade via
opacity;
`'sky'` fades a black layer in over the sky background (which can't transition) but
behind the scene. ([`features/layers.css`](src/debug/features/layers.css).)

| Command | Description |
| --- | --- |
| `fadeOut(layer?)` | Fade a layer (or all) out — surfaces/things to transparent, sky to black. |
| `fadeIn(layer?)` | Fade it back in. |

## `debug.camera` — view-relative orbit (talk shots)

A debug-only **orbit** of the render camera: shifts the eye *and* re-aims to keep
the target framed. `x / y / z` are right / up / back of where the camera faces
(world units); the view yaws/pitches back toward a pivot, so **move-right ⇒
turn-left, move-up ⇒ look-down**. It overrides the scene transform from
[`features/camera.css`](src/debug/features/camera.css) without touching the renderer.

| Command | Description |
| --- | --- |
| `offset(x, y, z, t = 0, pivot?)` | Orbit to a new vantage, easing over `t` seconds (0 = instant). `pivot` (default 512) is the re-aim distance — larger = gentler. |
| `reset(t = 0)` | Ease back to the player's eye. |

```js
debug.camera.offset(200, 120, 0, 2)        // orbit up & right over 2s, eyes on target
debug.camera.offset(0, 80, 300, 2, 800)    // rise + pull back, distant pivot
debug.camera.reset(1)
```

## `debug.path` — record & replay the player's path

Segment-based recording for hand-scripted camera moves. `record()` opens a
top-centre transport panel; replay moves the **player** along the path while the
game loop runs, so the camera follows and the world reacts — including the
**recorded actions** (doors / fire / weapon switches). See
[`features/path.js`](src/debug/features/path.js).

| Command | Description |
| --- | --- |
| `record()` | Start a recording session (opens the transport panel). |
| `mark()` | Cut the current segment and start the next, still recording. |
| `pause()` / `resume()` | Pause / resume; resume joins at the last segment's end. |
| `rewind()` | Jump to the start of the last segment (arms overwrite). |
| `review()` | Replay the last segment to check it. |
| `stop()` | End the session. |
| `save(slot)` / `load(slot)` | Persist / read a session in `localStorage`. |
| `export(slot?)` | Dump a session (last recorded, or a slot) as JSON → console + clipboard, for safekeeping. |
| `import(slot, json)` | Restore an exported session JSON back into a slot. |
| `seek(pathOrSlot, opts)` | Teleport to a segment's start frame (pre-position a shot). |
| `await play(pathOrSlot, opts)` | Replay a path (+ its actions); resolves when done. |
| `await transition(opts)` | Smoothly ease between two poses — for turns & tiny moves, no recording. |
| `move({ x, y, angle })` | Instantly snap the player to a pose (angle in **degrees**). |

A `pathOrSlot` can be a saved slot name, a session object (e.g. an imported
recording), or a path object.

**`opts`** (shared by `play` and `seek` unless noted): `{ speed, segment, trim, smooth, start, end, moving }`

- `speed` — playback rate (`play` only).
- `segment` — 0-based index to play just one segment.
- `trim` — drop non-moving frames at the start/end.
- `smooth` — box-blur window (frames) over x / y / angle to de-jitter the walk.
- `start` / `end` — `{ x?, y?, angle? }` (**angle in degrees**) to bend the path so
  it begins/lands exactly there, spread across the whole segment.
- `moving` — flag the player as moving so the walk cycle runs (spectator / 3rd-person
  view) + head/weapon bob; off by default (`play` only).

**`transition` opts**: `{ duration, direction, start, end }` — `duration` in seconds,
`direction` `'clockwise'` | `'anti-clockwise'` (which way the angle sweeps), `start`/`end`
`{ x, y, angle° }`.

```js
debug.path.play('test', { segment: 1, trim: true, speed: 0.75,
                          smooth: 7, end: { x: 512, y: -64, angle: 90 } });

await debug.path.transition({ duration: 2, direction: 'clockwise',
  start: { x: -17, y: -3128, angle: 121 }, end: { x: 39, y: -3113, angle: 246 } });
```

## `debug.game` — render-command recording + cheat flags

Capture every render envelope through the orchestrator from a clean level, save it,
and replay it deterministically; plus console toggles for the Game cheat flags
(same flags as the menu).

| Command | Description |
| --- | --- |
| `record()` | Restart the current level and start capturing. |
| `save(slot)` | Write the captured buffer to storage. |
| `noDamage(on?)` | Player takes no damage. No arg toggles; pass a boolean to set. |
| `noAttack(on?)` | Enemies don't attack. |
| `noMove(on?)` | Enemies don't move. |

Replay a captured slot by loading the page with **`?play=slot`**. Add
**`?export=mp4`** or **`?export=webm`** to capture the replay to a downloaded video
(uses screen capture, so it needs a click to start).

## `debug.culling` — toggle the renderer's culling passes

The same flags the menu's Culling section drives, live per-frame. No arg toggles;
pass a boolean to set.

| Command | Description |
| --- | --- |
| `distance(on?)` · `backface(on?)` · `frustum(on?)` · `sky(on?)` | Toggle one pass. |
| `all(on = true)` | Set every pass at once — `all(false)` disables culling (handy so nothing pops at the screen edge during a shot). |

## `debug.renderer(kind?)` — swap the SP renderer

Same swap as the menu's Renderer picker: tears down the SP pane, rebuilds it with
the chosen renderer, reloads the map + catches up world state. **SP only.** No arg
logs the current renderer and the options.

```js
debug.renderer('lighting')   // dom · flat · shade · lighting · line · cat
debug.renderer()             // show current + choices
```

The **lighting** renderer is shade with opaque white surfaces and no colour — a
pure black-and-white view of the per-sector lighting (dynamic light FX play).

## `debug.spectator(on?)` — spectator mode

Same as the binoculars button (which the Chrome toggle hides). **SP only** (refused
in deathmatch). No arg toggles; pass a boolean to set.

```js
debug.spectator()        // toggle
debug.spectator(true)    // force on
```

## `debug.custom` — hand-authored talk set pieces

Scripts that string the commands above together on a timeline — the actual shots
performed in the talk, using the recordings in
[`custom/recordings.js`](src/debug/custom/recordings.js). Authored in
[`custom/custom.js`](src/debug/custom/custom.js).

| Command | Description |
| --- | --- |
| `custom.one()` … `custom.eight()` | The talk's set pieces (path walks, explode/floor-grid, sprite sheets, renderer swaps, spectator orbit, …). |

---

## Debug menu toggles

Open with `debug()` or the logo button. Defined in
[`src/debug/ui/registry.js`](src/debug/ui/registry.js); grouped by section:

- **Game** — No enemy attack · No enemy movement · No collision (noclip) · No damage.
- **Culling** — Distance / Backface / Frustum / Sky culling (with live counts) ·
  CSS distance culling · CSS frustum culling.
- **Effects** (CSS render toggles) — Sector light effects · Light falloff ·
  Scrolling textures · Animated flats · Head bob · All enemies shadow.
- **Renderer** — renderer picker (`dom` / `flat` / `shade` / `lighting` / `line` /
  `cat`) · show/hide Floors · Ceilings · Walls · Things · Enemies · HUD · Sky · Chrome.
- **Debug** — Show sky walls · Show wall IDs · Show sector IDs.
- **State** — End level · End match (deathmatch only) · Enter attract (kiosk only).
