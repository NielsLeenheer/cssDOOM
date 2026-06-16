# Implementation Plan: Unify the spectator player sprite with the DM billboard

## Problem

There are two DOM representations of a player's body, built and driven by
two separate code paths:

1. **The DM billboard** — `createPlayerSprite` in
   [src/renderer/css/scene/entities/sprites.js](src/renderer/css/scene/entities/sprites.js).
   A `.enemy.player > .sprite` element, parented into the player's
   **sector container** (so it inherits `--floor-z`/`--light` and, after
   the movers refactor, rides lifts). Rotation is computed per-pane by
   `updateEnemyRotation` from the viewing camera; walk/attack/death/gib
   states and per-player colour variants are all handled. Created for
   every player with a `thingRef` via the world dispatch fan-out
   ([start.js:163](src/game/player/start.js#L163),
   [spawn.js:86](src/game/player/spawn.js#L86)). Hidden in the owner's own
   pane by [enemies.css:136-139](src/renderer/css/scene/entities/enemies.css#L136-L139).

2. **The spectator sprite** — `#player > .sprite`, built by `buildPlayer`
   in [src/renderer/css/scene/entities/player.js](src/renderer/css/scene/entities/player.js)
   into every renderer's scene **fragment root** (not a sector). Positioned
   by [spectator.css:99-111](src/renderer/css/scene/spectator.css#L99-L111)
   from `--player-x/y/floor`. Rotation is computed in **JS** by
   `updatePlayerSprite` in [src/ui/spectator.js:67-102](src/ui/spectator.js#L67-L102).
   No attack/death, single colour, fixed 150ms/frame walk.

Both render the same `PLAY.png` sheet with the same 8-way DOOM rotation
bucketing and the same paused/running walk cycle. The second sprite exists
only because, in SP, the local player's billboard is hidden in their own
pane — so spectator builds a *second* body to look at. The rotation math,
the sprite-sheet metadata, and the walk-cycle wiring are duplicated.

## The pattern already exists

The **axis renderer** ([src/renderer/axis/renderer.js](src/renderer/axis/renderer.js))
already solved this. It does NOT use `#player > .sprite` as the body. Instead:

- `_ensurePlayerBillboard()` ([axis/renderer.js:167](src/renderer/axis/renderer.js#L167))
  calls `createPlayerSprite` for the local player so SP gets the same
  billboard DM does (idempotent — no-op if it already exists).
- It overrides `updateEnemyRotation`
  ([axis/renderer.js:120](src/renderer/axis/renderer.js#L120)) to substitute
  the off-axis camera position as the viewer, so the unified billboard
  tracks the camera angle instead of always showing its front cell.
- `#player` is kept **only** for the marker/FOV-arc chrome, positioned from
  a parallel `--actor-*` property set.

This plan generalises that pattern to spectator mode and deletes the
duplicate sprite path.

## End state

- The player **body** in spectator mode is the standard `createPlayerSprite`
  billboard — sector-parented, floor inherited, rotation via
  `updateEnemyRotation`. It rides lifts for free (movers refactor) instead
  of being hand-positioned via `--player-floor`.
- `#player` survives as **marker + FOV arc only** — no `.sprite` child and no
  ground shadow. It stays the observer chrome, positioned from camera
  properties.
- `buildPlayer`, `updatePlayerSprite` (the JS rotation math), the
  `#player > .sprite` CSS, and the `#player::before` shadow are gone.
- The owner's-own-pane self-hide rule gains a spectator exception so the
  body is visible to its own spectator camera.

## Principles (hard invariants)

1. **One billboard.** A player's body is rendered by exactly one mechanism
   (`createPlayerSprite` + `updateEnemyRotation`) in every mode — DM, SP,
   spectator, axis. No second sprite, no JS-side rotation math.
2. **The sector positions the body.** The body inherits floor/light from
   its sector container and is moved by `updateThingPosition` +
   `reparentThingToSector`, exactly like an enemy. No `--player-floor` on
   the body.
3. **`#player` is chrome, not a body.** It carries the top-down marker and the
   FOV arc only — things that have no analogue on an enemy billboard. It is
   not a sprite, and it carries no ground shadow.
4. **No new special-casing.** Reuse the axis renderer's substituted-viewer
   approach for rotation; do not fork a spectator-only rotation path.

## Phases

Each item: implement → correctness agent → design-conformance agent (per the
established two-agent process). Halt and report if either fails.

### Phase A — Audit & confirm (no code changes)

- **A1. RESOLVED — the billboard already exists in SP.** `addPlayerThings`
  ([start.js:142](src/game/player/start.js#L142)) gives player 0 a `thingRef`
  in every mode, and `beginPlay` calls `broadcastPlayerSprites`
  **unconditionally** ([game.js:470](src/game/game.js#L470), outside the
  `deathmatch` branch), which fires `createPlayerSprite` for every player
  with a `thingRef`. So SP player 0 *does* get a billboard — it's just
  hidden in the owner's own pane by the self-hide rule. The axis comment
  ("SP doesn't fire it for the own player") is **stale/misleading**: what
  axis actually compensates for is being a **late-attached render target**
  that joined after the one-shot `broadcastPlayerSprites` fan-out (see the
  orchestrator note at [master.js:531](src/master.js#L531)), not an
  SP-vs-DM gap. Spectator reuses the **existing primary renderer**
  (`startSpectatorMode` → `findTarget(0, 'dom')`,
  [orchestrator.js:244](src/orchestrator.js#L244)), which already has the
  billboard from `beginPlay`. ⇒ Phase B shrinks to a confirmation + an
  idempotent robustness guard (renderer-rebuild case).
- **A2.** Confirm the self-hide rule
  ([enemies.css:136-139](src/renderer/css/scene/entities/enemies.css#L136-L139))
  is what hides the body in the owner's pane, and identify every layout that
  relies on it (kiosk mirror SP at [enemies.css:148](src/renderer/css/scene/entities/enemies.css#L148)).
- **A3.** Confirm `updateEnemyRotation`'s viewer parameter is the only input
  that differs between "see another player" and "see myself" — i.e. feeding
  the spectator camera as the viewer is sufficient (no other state reads
  `state.players[0]` for the body).

### Phase B — Ensure the body exists in spectator mode

Per A1 the body already exists on the primary renderer that spectator uses,
so this phase is mostly confirmation:

- **B1.** Confirm the billboard is present when spectator is entered, and add
  an idempotent guard (share the axis `_ensurePlayerBillboard` helper rather
  than copy it) to cover the renderer-rebuild / late-attach edge.
- **B2.** Verify the body is parented to the correct sector container on
  spawn and reparented as the player moves (the existing
  `movement.js` → `reparentThingToSector` path already covers player 0).

### Phase C — Route rotation through the dispatch path

- **C1.** Feed the spectator camera position/angle as the viewer to
  `updateEnemyRotation` for the local player's thingIndex — the same
  substitution axis does in its `updateEnemyRotation` override. Follow mode
  (camera behind player → back view) and top mode (body faces FOV direction)
  must both fall out of the viewer geometry, matching today's `forceBack`
  and top-down behaviour.
- **C2.** Delete `updatePlayerSprite` from [spectator.js](src/ui/spectator.js)
  and its two call sites in `spectatorLoop` ([spectator.js:46,54](src/ui/spectator.js#L46));
  replace with whatever drives the dispatch-based rotation.

### Phase D — Reduce `#player` to chrome

- **D1.** `buildPlayer` ([player.js:14](src/renderer/css/scene/entities/player.js#L14))
  drops the `.sprite` child; keeps the `.marker`. Keep the `#player`
  container for the marker/FOV-arc/shadow.
- **D2.** Remove `#player > .sprite` rules from
  [spectator.css](src/renderer/css/scene/spectator.css#L117-L195)
  (the sprite block, the follow-mode billboard override, the
  `.renderer.moving #player > .sprite` walk toggle) **and the
  `#player::before` ground shadow**. Keep `#player` and `#player > .marker`
  only. Check the axis renderer's `#player::before` handling
  ([axis/styles.css:35](src/renderer/axis/styles.css#L35)) isn't relying on
  the shadow.
- **D3.** Add the spectator exception to the self-hide rule so the body is
  visible to the spectating camera in its own pane, while still hidden in
  normal first-person SP play.

### Phase E — Walk cycle & visual parity

The DM billboard is the reference for all visual behaviour — it is the most
complete and accurate representation. Spectator conforms to it; we do not
preserve spectator-only deviations.

- **E1.** Drive the unified body's `.moving` walk cycle from the existing
  `setThingMoving`/`.moving`-on-container mechanism (the DM path), not the
  `.renderer.moving` selector. Confirm head-bob/weapon-bob (which legitimately
  key off `.renderer.moving`) are unaffected.
- **E2. DECIDED — adopt the DM walk duration (120ms/frame).** Drop
  spectator's 150ms; the DM billboard is authoritative.
- **E3. DECIDED — attack/death/gib frames show in spectator.** The unified
  body uses the DM states verbatim; SP attack/death dispatched to the own
  thing now renders (more faithful, and the reference path). No suppression.
- **E4.** Visual diff in follow mode and top mode: heading correctness through
  a full turn, lift riding (the win), marker arc still tracks. (Shadow is
  removed — confirm its absence reads fine in both modes.)

### Phase F — Cleanup

- **F1.** If `buildPlayer` is now trivial, fold it or rename to reflect it
  builds chrome, not a player sprite.
- **F2.** Grep for orphaned `--player-floor` reads on the body, dead
  `--spectator-angle`/`--mirror`-on-`#player`-sprite props, and any remaining
  `#player > .sprite` references.
- **F3.** Confirm the axis renderer still works (it shares the billboard and
  the marker path) — ideally it now shares the B1 helper.

## Open questions — all resolved

- **Q1. RESOLVED.** The local player *does* have a `thingRef`/billboard in
  plain SP (`broadcastPlayerSprites` is unconditional). The body already
  exists on the renderer spectator uses; Phase B is confirmation + an
  idempotent guard, not new construction. See A1.
- **Q2. RESOLVED.** DM is the reference — attack/death frames **show** in
  spectator. See E3.
- **Q3. RESOLVED.** DM is the reference — walk duration standardises on
  **120ms/frame**. See E2.

Guiding rule from these answers: **the DM player billboard leads.** It is the
most complete and accurate representation; every other mode (SP, spectator,
axis) conforms to it rather than carrying its own variant.

## Out of scope

- Network DM behaviour of the billboard (unchanged — it's already the
  unified path).
- The axis renderer's existing overrides (they stay; this plan brings
  spectator up to the same model).
- Projectiles, corpses, and non-player things.

## Process note

Per project convention, refactor work — including the spec/plan commit —
happens in a git worktree, not on the working branch directly. Create the
worktree before committing this plan or any implementation.
