# CSS Renderer — Improvements & Investigations

Working checklist for the CSS renderer (`src/renderer/css/**`). Each item is
investigated one by one; tick the box when an item is selected / done, or
strike it through when rejected.

Legend: `[ ]` open · `[x]` done · `[~]` partially done · `[-]` rejected

---

## A. Likely bugs / real inconsistencies

### A1. Texture preloading broken since the `data-texture` refactor

- [x] Fixed

`preloadTextures()` in `src/renderer/css/scene/scene.js` collected wall/flat
URLs by regexing `el.style.backgroundImage` — but walls and flats no longer
get inline background images; they get a `data-texture` attribute and the URL
comes from the generated `textures.css`. The first loop therefore collected
nothing, and only sprite `<img>`s and SW2 switch textures were actually
preloaded.

**Fixed:** URLs now resolve from `el.dataset.texture` (walls →
`/assets/textures/`, floors/ceilings → `/assets/flats/`), with a guard for
DOOM's `-` no-texture marker and all three NUKAGE frames preloaded for the
animated flats. Verified on E1M1: 33 wall textures + 23 flats collected,
no 404s.

### A2. `transition: --floor-z` animates discretely (missing `@property`)

- [x] Fixed — `--floor-z` registered as `<number>` in scene.css (commit
  `3ba04d6`); audit found `--player-z` already registered and no other
  transitioned/animated custom properties missing registration.
- Follow-up: the `.enemy { transition: --floor-z }` this item targeted was
  later **removed entirely** by the movers refactor (see **C5**) — an easing
  transition fought the instant reparent across a lift edge (dip/jump
  artifact). Floor height now changes by reparenting between sectors (instant,
  DOOM-correct); lift riding is smooth via the `.mover` transform transition.

`things.css` has `.enemy { transition: --floor-z 0.4s ease-out; }`, but
`--floor-z` is never registered with `@property`. Unregistered custom
properties can't interpolate — they flip at the 50% point of the transition.
Registering it as `syntax: "<number>"` (like `--player-z` in `scene.css`)
makes enemies actually ride moving floors smoothly.

Also: audit all other transitioned/animated custom properties for missing
registrations.

Note: overlaps with **C5** (z-inheritance) — if things inherit z from the
sector, this transition may move or disappear.

### A3. Duplicate keyframes: `light-blink` vs `light-blink-fast`

- [x] Fixed upstream

The two `@keyframes` blocks in `mechanics/lighting.css` were byte-identical;
only the `animation-duration` at the usage site differed.

**Fixed on `multiplayer-doom`** (commit `8f9297e`, merged into this branch):
the `light-blink-fast` keyframes are gone and `.light-blink-fast` reuses
`light-blink` at 0.5s. The same commit also de-duplicated the redundant
start/end percentages in the flicker keyframes.

### A4. Doc/code drift in `surfaces/horizontal.js`

- [x] Fixed (commit `4351484`).

The file header says sectors with holes use "`path()` with SVG evenodd fill
rule"; the code uses `shape(evenodd …)`. Update the header comment.

### A5. `sky.css` oddities

- [x] Fixed (commit `8869345`) — scroll factor now derived as
  `calc(var(--player-angle) / (2 * pi) * 1024px)` (163px was 1024/2π in
  disguise: four repeats of the 256px SKY1 texture per revolution), and the
  stray second `background-position-x` layer value is gone.

`background-position-x: calc(var(--player-angle) * 163px), 0;` declares two
layer values for a single background layer (the trailing `0` is ignored), and
`163px` is an underived magic number. It should fall out of the sky texture
width and the FOV — e.g. `calc(var(--player-angle) * 1rad / 1turn * <px-per-
revolution>)` now that angle/`turn` math is available in `calc()`.

---

## B. Modern CSS opportunities

### B1. `@layer` instead of import-order comments

- [ ] Investigate

`index.css` has several "must come after X so the cascade wins" comments
(renderer overlay styles, generated override files). Cascade layers
(`@layer base, renderer, overrides;` + layered `@import`s) make that ordering
explicit and immune to import shuffling. Textbook use case.

### B2. `abs()` and `sign()` in the CSS culler

- [x] Done (commit `5aad71a`) — `abs()` replaces `max(x, -x)`,
  `max(0, sign(expr))` replaces the `clamp(0, expr * 1000, 1)` boolean
  trick. Verified identical cull counts before/after.

`culling.css` hand-rolls absolute value
(`max(var(--cull-lateral), calc(var(--cull-lateral) * -1))`) and booleans via
`clamp(0, calc(x * 1000), 1)`. `abs(var(--cull-lateral))` and
`max(0, sign(x))` express the same thing directly. The file already requires
bleeding-edge support for `if()`, so there's no compat reason to keep the
tricks (the type-grinding fallback path can stay as-is).

### B3. Typed `@property` for the camera angle

- [ ] Investigate

`--player-angle` is an untyped number, so every consumer does
`calc(var(--player-angle) * 1rad)` or `* -1rad` (camera.css, things.css,
projectiles.css, culling.css, lighting.css — 10+ sites). Registering it as
`syntax: "<angle>"` and writing `1.23rad` from JS removes all that noise.

Caveat: positions must stay unitless numbers — the culler multiplies them
together and `calc()` can't do length × length. Angle-only change.

### B4. Merge `floors.css` and `ceilings.css`

- [x] Done (commit `99df6d9`) — merged into `surfaces/horizontal.css`
  (named after its JS counterpart) with a `--surface-z` bridge per class.
  Pure CSS change; verified pixel-identical render.

The two files are the same ~26-line block except `--floor-z` vs
`--ceiling-z`. A shared `:is(.floor, .ceiling)` rule keyed on one
`--surface-z` variable (set by `horizontal.js`, which already takes
`surfaceType`) halves the code and guarantees the two never drift.

### B5. Distance-proportional door/lift speeds + shared "mover" pattern

- [~] Partially done — the shared pattern landed with the movers refactor
  (commit `6843fc1`); two sub-items remain.

**Done:** doors/lifts/crushers are unified under one `.mover` group + `--offset`
+ `data-state` model, driven by a single `setMoverState`. The "container
translates by `--offset` on a data-state flip" mechanism is now one shared
concept (no per-mechanism build functions, no reparenting).

**Remaining:**

- *CSS rule dedup.* `mechanics/doors.css` and `mechanics/lifts.css` are now
  byte-identical except the type selector and state value (`open` vs
  `lowered`) — they could collapse into one shared `.mover` rule. (Crushers
  legitimately differ: live `--crusher-offset`, no transition.)
- *Distance-proportional speed.* Both still use a fixed
  `transition: transform 1s`, so tall doors move faster than short ones — real
  DOOM movers run at constant speed. `--offset` is already baked per group
  (`movers.js`), so `transition-duration: calc(...)` is now a trivial add.

### B6. View Transitions / `@starting-style` for screen choreography

- [-] Rejected

`pane-transition`, lobby/intermission/scoreboard swaps, and the spectator
ceiling fades are JS-orchestrated class toggles. Same-document
`document.startViewTransition()` could replace a chunk of that choreography.

**Rejected:** view transitions capture the old and new states as flat
rasterized snapshots — the `preserve-3d` scene gets flattened during the
transition, and there's no way to capture a live before/after 3D view.
Any transition that overlaps a visible scene would visibly collapse the
perspective mid-fade. (`@starting-style` + `transition-behavior:
allow-discrete` for 2D overlays entering from `display: none` remains
viable on its own, but isn't worth a standalone item.)

### B7. CSS-computed perspective via container query units

- [ ] Investigate

`updatePerspective()` in `scene/scene.js` computes
`max(paneWidth / 2, max(30vw, 350px))` in JS via ResizeObserver. The pane is
already a named container (`@container pane` in hud.css), so CSS could own
it: `--perspective: max(50cqw, 30vw, 350px)`. The JS culler still needs the
numeric value, so either keep the observer just to read `getComputedStyle`
(single source of truth in CSS), or leave as-is. Listed because it's the one
remaining JS-computed style CSS can now express.

### B8. `offset-path: ray()` for projectiles

- [-] Rejected

Projectiles animate a `translate` keyframe pair between JS-computed start/end
points. Motion paths (`offset-path: ray(...)` + animated `offset-distance`)
would let JS set just origin + angle + range.

**Rejected:** `offset-path` operates in the element's 2D containing-block
plane, but projectiles move in 3D — the current keyframes interpolate height
(`--start-z` → `--end-z`) too, e.g. a fireball aimed at a player on a ledge.
Splitting into a 2D ray plus a separate vertical animation would be more
complex than the current single keyframe pair.

### B9. Consistent style conventions

- [ ] Investigate

Two mixed idioms worth standardizing:

- Individual transform properties (`translate:` / `rotate:`) are used in
  `.scene`, `.projectile`, and debug rules, while everything else uses long
  `transform:` strings. Fine where order matters (walls), but billboards /
  puffs / fog could move to individual properties.
  **Note (from `multiplayer-doom` commit `e4a7e54`):** the mixing is
  sometimes deliberate — weapons.css uses `translate` (bob/switch
  keyframes) and `transform` (hide states) as two independent channels so
  the animations don't clobber each other; camera.css does the same for
  head-bob. The item is about *unintentional* mixing only — any
  standardization pass must preserve the two-channel trick where it's
  load-bearing.
- CSS nesting is used in some files (sprites, lighting, lifts) but not others
  (walls, things).
- `image-rendering: pixelated` is redundantly re-declared on
  `.fireball-explosion` / `.teleport-fog` (already applied via the
  `.scene *` rule).

### B10. Classes vs data attributes — pick one convention for state

- [~] Partially done — light-effect enum converted; death-state cleanup
  pending; booleans confirmed already conformant.

The convention is: *category/identity → class* (`.enemy`, `.pickup`, `.wall`,
`.sprite`), *enumerated state → data attribute*
(`data-state="open|lowered|dead|attacking"`, `data-type`, `data-texture`).
The investigation (against current code) found:

- **Sector light effects → DONE.** Were five mutually-exclusive classes
  (`light-glow` …); now `data-light="glow|blink|blink-fast|flicker|fire-flicker"`
  on the sector container (`sectors.js` LIGHT_EFFECT map writes `dataset.light`;
  `lighting.css` + `shade/styles.css` select `[data-light="…"]`). Keyframe
  names + `animation:` references keep the old `light-*` names — only the
  selectors changed; specificity is 1:1.
- **Death state → not a duplication, it's dead code (pending deletion).**
  `killEnemy` sets a `.dead` class on the thing *container* and
  `data-state="dead"` on the sprite child — but the container `.dead` has
  **zero consumers** (no CSS selector matches `.enemy.dead`; the only `.dead`
  rules are `.renderer.dead`, a different element). The real death visuals are
  the sprite's `data-state` + the `collected` flag. Fix is to delete the two
  vestigial `.dead` writes (`sprites.js` killEnemy + resetEnemy), leaving the
  sprite `data-state` as the single source.
- **Boolean modifiers → already conformant; leave as-is.** `.collected`,
  `.moving`, `.unpegged`, `.scroll-texture`, `.firing`, `.paused`, `.active`,
  `.renderer.dead` are genuine booleans and correctly read as classes. The one
  cross-convention item, `data-active="true|false"` on the pane, is
  load-bearing — `hud.css` keys off the explicit `[data-active="false"]` state,
  which a class (absence = false) can't express. Convention: booleans → class,
  enums → data attribute.

### B11. Projectiles: convert inline background-image to `data-type` + CSS

- [ ] Investigate

Projectiles are the last scene elements styled with direct
`style.backgroundImage` — `createProjectile`
(`scene/entities/sprites.js`) sets `backgroundImage`, `backgroundSize`,
`width`, and `height` inline from the wire spec. Every other scene sprite
goes through a declarative mechanism (`data-texture` → generated
textures.css, `data-type` → enemies.css/things.css, or class-based
keyframes).

Projectile types are a small fixed set (enemy fireball, player rocket), so
this can become `data-type="fireball|rocket"` with the sprite URL, size,
and `background-size` defined per type in `projectiles.css` — matching the
sprite convention everywhere else. Only the genuinely per-shot values
(`--start-*`, `--end-*`, `--duration`) stay inline.

Side benefit: slims the wire envelope — master currently ships
`width`/`height`/`sprite` over the network on every shot for what is
static per-type data (check what RenderSink forwards in the
createProjectile args and trim the spec at the game side).

Related to B10 (classes vs data attributes convention).

---

## C. Structural refactors

### C1. Deduplicate wall element creation

- [x] Done — resolved by deletion (commit `375bd15`).

The premise inverted once the movers refactor landed. `createWallElement`
existed only as the shared helper the old `mechanics/{doors,lifts,crushers}.js`
build functions called to synthesize door panels / lift platforms / track
jambs. Those callers were deleted (a wall is now born in its final
`.static`/`.mover` container by `buildWalls`), leaving `createWallElement`
orphaned — nothing imported or called it. So there was no live duplication to
consolidate; `createWallElement` was deleted and the four comments that still
named it as the active mechanics helper were reworded.

### C2. Replace DOM expandos with culler records

- [ ] Investigate

Scene metadata lives as `el._wall`, `el._midX`, `el._sectorIndex`, etc. on
the elements themselves, and the culler iterates elements reading those.
Restructuring `sceneState` to hold plain records
(`{ el, midX, midY, angle, ... }`) — as `thingContainers` already half-does —
keeps metadata out of the DOM, is friendlier to the JIT in the hot culling
loop, and makes the culler testable without DOM.

### C3. Single shared per-element geometry vars

- [ ] Investigate

The JS culler and the CSS `light-falloff` / CSS-culling experiments each
independently derive "position relative to camera" (JS dot products vs CSS
`--cull-x/--cull-y` calc chains; `lighting.css` and `culling.css` duplicate
the camera-vector math). If the CSS culling experiments graduate, define one
canonical set of registered per-element vars (`--rel-x`, `--rel-y`,
`--view-depth`) that culling, fog, and future effects all read.

### C4. Shared constants between JS and CSS

- [ ] Investigate

`MAX_RENDER_DISTANCE` (2500) lives in `shared/constants.js` but is hardcoded
as `calc(2500 * 2500)` in `culling.css`; kiosk perspective, fog falloff
distance, and sky-cull margins are similarly scattered. A tiny build step (or
one JS write of `:root` custom properties at boot) gives a single source of
truth.

### C5. Things inherit z from their sector (drop per-thing `--floor-z`)

- [x] Done — landed via the movers refactor
  ([`IMPLEMENTATION-PLAN-movers.md`](IMPLEMENTATION-PLAN-movers.md), commit
  `6843fc1`).

The sector is now the unit of height. The sector container carries
`@property`-registered `--floor-z`/`--ceiling-z` (`sectors.js`), and floors,
ceilings, things, and enemies inherit them — the per-thing `--floor-z`
fan-out (`updateThingPosition`, `resetEnemy`, `createPlayerSprite`,
`createCorpse`) is gone; `updateThingPosition` writes only `--x`/`--y`. A lift
moves its `.mover` group via one `translateY`, and everything parented into
that group rides it automatically; reparenting between sectors
(`reparentThingToSector` + `moveBefore()`) is the only per-thing mechanism on
a sector crossing, inheriting both `--light` and height from the new parent.

(The earlier design docs `REFACTOR-sector-as-geometry.md` and
`REFACTOR-sector-height-inheritance.md` are superseded — the work shipped
through the movers plan instead, which also covered A2, the mover parts of
B5, and one arm of C1.)

Original notes (realized by the movers refactor):

Today every thing carries its own inline `--floor-z`, pushed by game-side
dispatches (`updateThingPosition`, `resetEnemy`, `createPlayerSprite`,
`createCorpse`, …), while sector containers exist purely for `--light`
inheritance. Idea: the sector container also carries an inherited,
`@property`-registered `--floor-z`; things only set `--x` / `--y` and pick up
z from their parent sector. Then:

- A lift/floor move is **one** property write on the sector container, and
  every thing standing in that sector rides it automatically — no per-thing
  floorHeight fan-out from game code.
- `setFloorHeight` stops looping `surfaceElements` and just writes the
  sector property; the floor surface reads the same inherited var.
- `reparentThingToSector` (already implemented, with `moveBefore()` to
  preserve animations) becomes the *only* mechanism needed when a thing
  crosses sectors — it inherits both `--light` and `--floor-z` from the new
  parent.

Things to verify during investigation:

- Lifts currently move a separate `.platform` div via `translateY`
  transform (floor surfaces are reparented into it), not via `--floor-z` on
  the sector. Unifying means the platform's motion becomes a `--floor-z`
  animation on the sector container — check transform-transition smoothness
  vs custom-property transition (requires A2's `@property` registration to
  interpolate).
- Airborne entities (projectiles have explicit z; lost souls/cacodemons
  don't exist in E1M1 but keep the door open) need an additive offset on top
  of the inherited floor: `translateY(calc((var(--floor-z) + var(--air-z, 0)) * -1px))`.
- DOOM semantics: a thing's floorHeight is the highest floor it overlaps,
  which can differ from "its" sector at boundaries — check whether the game
  sim relies on that anywhere visible (corpses half on a step, etc.).
- Doors reparent *ceilings* into their panel; crushers similar. Make sure
  the inherited `--floor-z` on the sector doesn't fight the door/crusher
  panel transforms.

---

## D. Deliberately skipped (already modern / not worth it)

- `hypot()`, `atan2()`, `@property`, container queries, anchor positioning,
  `if()` + type-grinding fallback, `random()` behind `@supports` — already in
  use.
- Generated `textures.css`: typed `attr()` can't be used inside `url()` (spec
  forbids it for security), so the generated attribute→image map stays the
  right approach.
