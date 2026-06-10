# CSS Renderer — Improvements & Investigations

Working checklist for the CSS renderer (`src/renderer/css/**`). Each item is
investigated one by one; tick the box when an item is selected / done, or
strike it through when rejected.

Legend: `[ ]` open · `[x]` done · `[-]` rejected

---

## A. Likely bugs / real inconsistencies

### A1. Texture preloading broken since the `data-texture` refactor

- [ ] Investigate / fix

`preloadTextures()` in `src/renderer/css/scene/scene.js` collects wall/flat
URLs by regexing `el.style.backgroundImage` — but walls and flats no longer
get inline background images; they get a `data-texture` attribute and the URL
comes from the generated `textures.css`. The first loop therefore collects
nothing, and only sprite `<img>`s and SW2 switch textures are actually
preloaded.

Fix: resolve URLs from `el.dataset.texture` instead (walls →
`/assets/textures/`, floors/ceilings → `/assets/flats/`).

### A2. `transition: --floor-z` animates discretely (missing `@property`)

- [ ] Investigate / fix

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

- [ ] Investigate / fix

The two `@keyframes` blocks in `mechanics/lighting.css` are byte-identical;
only the `animation-duration` at the usage site differs. One keyframes block
suffices.

### A4. Doc/code drift in `surfaces/horizontal.js`

- [ ] Investigate / fix

The file header says sectors with holes use "`path()` with SVG evenodd fill
rule"; the code uses `shape(evenodd …)`. Update the header comment.

### A5. `sky.css` oddities

- [ ] Investigate / fix

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

- [ ] Investigate

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

- [ ] Investigate

The two files are the same ~26-line block except `--floor-z` vs
`--ceiling-z`. A shared `:is(.floor, .ceiling)` rule keyed on one
`--surface-z` variable (set by `horizontal.js`, which already takes
`surfaceType`) halves the code and guarantees the two never drift.

### B5. Distance-proportional door/lift speeds + shared "mover" pattern

- [ ] Investigate

`doors.css` / `lifts.css` use a fixed `transition: transform 1s` regardless of
`--offset`, so tall doors move faster than short ones — real DOOM movers run
at constant speed. `buildDoor` already knows `travelDistance`; set
`transition-duration: calc(var(--travel) * Nms)` per door/lift.

Also: doors' `.panel`, lifts' `.platform` (and crushers) implement the
identical "container translates by `--offset` on a data-state flip" pattern —
could share one `.mover` rule.

### B6. View Transitions / `@starting-style` for screen choreography

- [ ] Investigate

`pane-transition`, lobby/intermission/scoreboard swaps, and the spectator
ceiling fades are JS-orchestrated class toggles. Same-document
`document.startViewTransition()` could replace a chunk of that choreography.
`@starting-style` + `transition-behavior: allow-discrete` can replace
"insert element, force reflow, add `.visible`" patterns for overlays entering
from `display: none`.

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

- [ ] Investigate

Projectiles animate a `translate` keyframe pair between JS-computed start/end
points. Motion paths (`offset-path: ray(...)` + animated `offset-distance`)
would let JS set just origin + angle + range and lean on CSS for the flight —
more in the spirit of the project. Current approach works; this is a
"more CSS, less JS" option.

### B9. Consistent style conventions

- [ ] Investigate

Two mixed idioms worth standardizing:

- Individual transform properties (`translate:` / `rotate:`) are used in
  `.scene`, `.projectile`, and debug rules, while everything else uses long
  `transform:` strings. Fine where order matters (walls), but billboards /
  puffs / fog could move to individual properties.
- CSS nesting is used in some files (sprites, lighting, lifts) but not others
  (walls, things).
- `image-rendering: pixelated` is redundantly re-declared on
  `.fireball-explosion` / `.teleport-fog` (already applied via the
  `.scene *` rule).

### B10. Classes vs data attributes — pick one convention for state

- [ ] Investigate

The implicit convention today is: *category/identity → class*
(`.enemy`, `.pickup`, `.wall`, `.sprite`), *enumerated state → data attribute*
(`data-state="open|lowered|dead|attacking"`, `data-type`, `data-texture`).
Several places violate it:

- **Sector light effects** are five mutually exclusive classes
  (`light-glow`, `light-blink`, `light-blink-fast`, `light-flicker`,
  `light-fire-flicker`) — a textbook enum that would read better as
  `data-light="glow|blink|blink-fast|flicker|fire-flicker"` on the sector
  container (`sectors.js` LIGHT_EFFECT_CLASS becomes a value map).
- **Duplicated death state**: `killEnemy` sets a `.dead` class on the thing
  container *and* `data-state="dead"` on the sprite child.
- Boolean modifiers are a mixed bag: `.collected`, `.moving`, `.unpegged`,
  `.scroll-texture`, `.firing`, `.paused` as classes vs `data-active` as an
  attribute. Decide: booleans as classes, enums as data attributes (probably
  the least-churn rule), then normalize the outliers.

---

## C. Structural refactors

### C1. Deduplicate wall element creation

- [ ] Investigate

`buildWalls()` in `surfaces/walls.js` re-implements almost everything
`createWallElement()` does (delta math, custom properties,
`_midX/_angle/_length` expandos) with small divergences — e.g.
`createWallElement` unconditionally adds `unpegged`, `buildWalls` adds it
conditionally. Make `buildWalls` call `createWallElement` and layer on the
extras (switch button, scrolling class, id).

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

- [ ] Investigate

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
