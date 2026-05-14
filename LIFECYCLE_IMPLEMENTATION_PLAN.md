# Lifecycle Implementation Plan

Operationalizes `LIFECYCLE_REFACTOR.md` against the current codebase on
branch `orchestrator-refactor`. Each step lists the files it touches,
what changes, what stays untouched, and a concrete verification check.
After every step the build must work and the four headline paths must
still run:

- **SP** (non-kiosk) — boots into E1M1, plays through.
- **Local DM** — two devices claim slots, match runs.
- **Kiosk SP** — mirror mode renders pane 0 on both panes.
- **Network DM** — host opens room, one client joins, both see lobby,
  host fires start, both reach PLAYING in lockstep, match end shows
  scoreboard on both, restart returns to lobby on both.

If a step's smoke test fails, the plan is wrong (or the step description
was wrong); pause and revise the plan before continuing.

---

## 0. Working principles

1. **Strangler fig, not big-bang.** Add new alongside old; flip callers
   gradually; delete old at the end of each phase.
2. **Every step ends with a working build.** No "this commit doesn't run
   but the next one will." If a logical change spans two files that have
   to flip together, that's one step, one commit.
3. **No new behavior in this refactor.** If the plan introduces behavior
   not in `LIFECYCLE_REFACTOR.md`, the plan is wrong. Pause and revise.
4. **Singletons move LAST.** `state.things`, `state.doorState`, etc. stay
   as module-level singletons throughout phases L1–L6. Phase L7 formalizes
   ownership on Level without necessarily relocating the storage.
5. **Renderer (Phases A–E) is done.** `DomRenderer`, `commands.js`,
   `renderer-state.js`, orchestrator-side dispatch are already in their
   target shape. This plan touches them only to add new commands
   (lobby/intermission/results overlays) and only via
   `src/renderer/commands.js`.
6. **Body classes track the new state machines as they come online.**
   `body.dataset.appState`, `body.dataset.gameState` are written by App
   and Game respectively the moment those classes start managing the
   state. CSS that reads them updates in lockstep.
7. **Smoke-test before committing.** The four headline paths are quick
   to run by hand. If you only test SP, you'll regress DM. Run all four
   between any non-trivial step.

---

## 1. Starting state (as of writing)

This survey is the baseline. If reality drifts from it before L1
begins, update this section first.

### Boot + globals
- `src/index.js` — 11-line URL-param dispatch:
  `?join=` → `initClientWindow()`; else → `initMaster()`.
- `src/master.js` — `initMaster()` is procedural: wires inputs,
  registers providers, calls `loadMap('E1M1')`, kicks
  `requestAnimationFrame(gameLoop)`. **No App, no Game, no Level
  class today.**
- `src/client.js` — `initClientWindow()` is the client mirror: opens
  `ClientConnection`, constructs a single `DomRenderer`, wires
  `RenderClient` for inbound, `remoteInput` for outbound.

### State containers
- `src/game/state.js` — the global `state` singleton. Holds
  `gameMode`, `networkMode`, `players`, `things`, `doorState`,
  `liftState`, `crusherState`, `projectiles`, `match`, `skillLevel`.
- `src/game/game-state.js` — separate state machine with states
  `ACTIVE / LOBBY / ENDED / ATTRACT / INTERMISSION`; writes
  `body.dataset.gameState`. Has `setGameStateBroadcaster(fn)` setter.
  **This module is replaced by App+Game+Level state machines in L3.**

### Game-loop + map loading
- `src/master.js::gameLoop(timestamp)` — the only RAF loop. Throttles
  to 20 Hz in attract; runs full speed otherwise.
- `src/game/index.js::updateGame(timestamp)` — per-frame world step;
  early-returns on `GAME_STATE.ENDED`.
- `src/shared/maps.js::loadMap(name)` — fetches JSON, calls
  `initThings/Doors/Lifts/Crushers`, asks each DomRenderer to
  `loadMap()`, builds spatial grid, adds player things. Side-effects
  go to `state.*` and dispatches `cssdoom:level-loaded`.

### Match + UI ownership
- `src/game/match.js` — `resetMatch / startMatch / endMatch /
  matchTick`. Has `setMatchEndBroadcaster(fn)` setter. Dispatches
  `cssdoom:match-reset` window event.
- `src/ui/lobby.js` — Local DM press-to-claim. Listens to
  `onClaimChange`, auto-starts when both slots claim.
- `src/ui/network-lobby.js` — Network DM slot UI + QR.
- `src/ui/intermission.js` — SP level-complete overlay.
- `src/ui/scoreboard.js` — DM match-end scoreboard.
- `src/ui/menu.js`, `src/ui/mode.js`, `src/ui/attract.js` — already
  reasonably partitioned (attract is gated inside the game loop, not
  a separate App state).

### Orchestrator + renderer
- `src/orchestrator.js` — passive hub; `inputs[]`, `replaceTarget`,
  `bindRemoteSlot`, per-pane and world dispatch generated from
  `src/renderer/commands.js`.
- `src/renderer/dom.js` — registry: `domRenderers[]`,
  `createDomRenderer`, `destroyDomRenderer`,
  `reshapeMasterRenderers`. Already aligned with the target.
- `src/renderer/dom-renderer.js` — one pane, one player view; owns
  sceneState; methods generated from `commands.js`.
- `src/renderer/renderer-state.js` — `rendererState.cameras[]` /
  `things[]` — read-side contract for the renderer; aliased to
  `state.*` on master, mirrored from envelopes on client.

### Network
- `src/network-host.js` — owns the signaling room; has
  `setMasterConnection(mc)` setter.
- `src/transport/peer-connection.js` — `MasterConnection`,
  `ClientConnection`.
- `src/transport/render-sink.js` / `render-client.js` — fan-out of
  renderer commands over the wire.
- `src/transport/protocol.js` — `MSG.*` envelope types. Today
  includes `LOBBY_STATE`, `MATCH_END` (legacy wire envelopes the
  refactor will delete) plus the renderer-command envelopes.

### Side-door setters to remove (L7)
1. `setMasterConnection(mc)` in `src/network-host.js`.
2. `setMatchEndBroadcaster(fn)` in `src/game/match.js`.
3. `setGameStateBroadcaster(fn)` in `src/game/game-state.js`.

### Window events to remove (L4)
1. `cssdoom:level-changing` — dispatched from `maps.js` pre-fade.
2. `cssdoom:level-loaded` — dispatched from `maps.js` post-scene.
3. `cssdoom:match-reset` — dispatched from `match.js`.

### Known broken behaviors the refactor fixes (see §19 in REFACTOR doc)
- Game-loop keeps ticking during intermission (no real pause).
- Network state drift on late join (no coordinated start handshake).
- `state.mode === X` checks scattered across gates (now obsolete
  because `state.mode` was already split, but the gate audit isn't
  done yet).
- Spawn-on-fire-vs-loadMap-on-fire ambiguity in DM respawn.

---

## 2. Phase overview

```
L1: Level class       — wraps current map+loop logic; no external API change yet.
L2: Game class        — wraps roster + match + lobby/intermission/results UI ownership.
L3: App class         — wraps boot + menu + attract; replaces game-state.js.
L4: Events            — Level→Game→App events replace window CustomEvents.
L5: Pause/resume      — semantics formalize; menu pause fans out via orchestrator.
L6: RemoteGame + net  — client window's symmetric layer; coordinated start.
L7: Cleanups          — delete dead modules + setters; finalize Level state ownership.
```

Each phase is broken into independently verifiable steps below.

---

## 3. Phase L1 — Level class

**Goal:** introduce `src/game/level.js` and make it the single thing
that owns "a loaded map being simulated." No external behavior change
visible to the user; structurally, `loadMap()` and `gameLoop()` move
inside Level.

**Pre-phase check:**
- All four smoke paths run on `main` baseline.
- No uncommitted edits to `src/game/`, `src/shared/maps.js`, or
  `src/master.js`. (Stash any work-in-progress; this phase touches
  those heavily.)

### Step L1.1 — Create Level skeleton
**Goal:** Class exists, importable, does nothing yet.

**Files:**
- **New:** `src/game/level.js`.

**Contents:**
```js
// src/game/level.js — skeleton; will be filled in over L1.2–L1.6.
export class Level {
    constructor({ map, players, rules, orchestrator }) {
        this.map = map;
        this.players = players;
        this.rules = rules;
        this.orchestrator = orchestrator;
        this._listeners = new Map();
        this._state = 'unloaded'; // 'unloaded' | 'loaded-paused' | 'loaded-running'
    }

    async load() { /* L1.2 */ }
    start()     { /* L1.3 */ }
    pause()     { /* L1.4 */ }
    resume()    { /* L1.4 */ }
    stop()      { /* L1.5 */ }
    destroy()   { /* L1.5 */ }

    on(event, handler) {
        if (!this._listeners.has(event)) this._listeners.set(event, new Set());
        this._listeners.get(event).add(handler);
    }
    _emit(event, payload) {
        const set = this._listeners.get(event);
        if (set) for (const h of set) h(payload);
    }
}
```

**Untouched:** Everything else. `master.js` still calls `loadMap`
directly; `Level` is dead code at this point.

**Verify:**
1. Build runs.
2. SP, Local DM, Kiosk SP, Network DM all behave identically to
   pre-step.
3. `grep -r "from.*level\.js"` returns no callers (intentional —
   nothing imports it yet).

---

### Step L1.2 — Implement `Level.load()`
**Goal:** Move the load-and-init pipeline out of `shared/maps.js` into
`Level.load()`. Keep `loadMap(name)` in `shared/maps.js` as a thin
backward-compat wrapper that constructs a Level under the hood — so no
caller has to change yet.

**Files:**
- `src/game/level.js` — fill in `load()`.
- `src/shared/maps.js` — extract the JSON-fetch + decorate path into a
  pure function `decorateMapData(mapData)` (no `state.*` writes).
  `loadMap(name)` becomes:
  ```js
  // shared/maps.js — transitional shim
  export async function loadMap(name) {
      const lvl = new Level({
          map: name,
          players: state.players,
          rules: state.match?.rules ?? null,
          orchestrator,
      });
      await lvl.load();
      // L1.7 will hand this Level to a real owner; for now stash globally:
      window.__currentLevel = lvl;
  }
  ```
- **Touched:** `src/game/things/init.js`, `src/game/doors/init.js`,
  `src/game/lifts/init.js`, `src/game/crushers/init.js` — these are
  already pure module-level functions writing to `state.*`; they get
  called from inside `Level.load()` instead of from `loadMap()`. **No
  changes to the functions themselves.**

**Specifically `Level.load()` does:**
1. `mapData = await fetchMapJson(this.map)` (from `shared/maps.js`'s
   internal fetcher).
2. `decorateMapData(mapData)` — pure decoration.
3. Set `currentMap` singleton in `shared/maps.js` (compat).
4. `initThings(mapData)`, `initDoors`, `initLifts`, `initCrushers` —
   the existing functions; they write to `state.things` /
   `state.doorState` / etc.
5. For each `domRenderer in orchestrator.targets`: tell it to
   `loadMap()` (rebuild scene).
6. `buildSpatialGrid()`, `addPlayerThings()`,
   `buildSectorAdjacency()` — existing helpers.
7. `this._state = 'loaded-paused'`.

**Untouched:**
- `gameLoop` in `master.js`. Still drives the RAF.
- `updateGame` in `game/index.js`.
- `cssdoom:level-loaded` dispatch (will be removed in L4).

**Verify:**
1. Build runs.
2. SP boots into E1M1 (this exercises the `loadMap` shim → new
   `Level.load()`).
3. SP level transition (walk to exit) works — `loadMap('E1M2')` runs
   the new code path.
4. `window.__currentLevel` exists and has `_state === 'loaded-paused'`
   in dev console after boot.
5. Local DM, Kiosk SP, Network DM still run.

---

### Step L1.3 — Implement `Level.start()`
**Goal:** Move the per-frame world step ownership onto Level. The RAF
itself stays in `master.js` for now (it'll move to App in L3); but
the RAF callback delegates to `Level.tick()` instead of calling
`updateGame()` directly.

**Files:**
- `src/game/level.js`:
  - Add `start()` — sets `this._state = 'loaded-running'`.
  - Add `tick(timestamp)` — calls existing `updateGame(timestamp)`
    when `this._state === 'loaded-running'`, no-op otherwise.
- `src/master.js::gameLoop(timestamp)`:
  ```js
  function gameLoop(timestamp) {
      requestAnimationFrame(gameLoop);
      const level = window.__currentLevel;
      if (level) level.tick(timestamp);
      // (attract throttling logic stays here for now)
      renderAllActivePanes();
  }
  ```
- `src/shared/maps.js::loadMap` — after `lvl.load()`, call
  `lvl.start()` to preserve current "load → immediately playing"
  behavior.

**Untouched:** `updateGame` itself. Attract throttling logic stays in
`gameLoop` (moves in L3 to App).

**Verify:**
1. Build runs.
2. SP plays as before.
3. Toggle pause via dev console: `window.__currentLevel.pause()`
   freezes the world; `resume()` unfreezes. (Pause/resume bodies are
   still empty stubs — they'll be implemented in L1.4. This verify
   step is for **after** L1.4. For L1.3 itself, verify the smoke
   paths only.)

**Smoke:** Same four paths.

---

### Step L1.4 — Implement `Level.pause()` / `Level.resume()`
**Goal:** Pause flips the running flag; tick becomes no-op. State is
preserved (no destruction).

**Files:**
- `src/game/level.js`:
  - `pause()` — `this._state = 'loaded-paused'`.
  - `resume()` — `this._state = 'loaded-running'`.

**Untouched:** Nothing else. No caller flips these yet.

**Verify:**
1. Build runs.
2. SP plays. From dev console: `window.__currentLevel.pause()`,
   movement freezes (no input processed, no per-frame world step).
   `resume()` unfreezes.
3. Local DM same.

---

### Step L1.5 — Implement `Level.stop()` / `Level.destroy()`
**Goal:** Provide a clean teardown path. `stop()` halts the tick;
`destroy()` clears `state.things`, `state.doorState`, etc., so the
next Level starts from a known empty baseline.

**Files:**
- `src/game/level.js`:
  - `stop()` — `this._state = 'loaded-paused'`, no state-clearing.
  - `destroy()` — `state.things.length = 0`, clear the door / lift /
    crusher Maps, clear `state.projectiles`. Then
    `this._state = 'unloaded'`.

**Pattern:** caller does `oldLevel.stop()`, `oldLevel.destroy()`, then
constructs new Level. (L2's Game will own this sequencing.)

**Untouched:** No callers wire destroy yet — `loadMap`'s existing
"reset-then-init" sequence still runs, which double-clears (harmless).

**Verify:**
1. Build runs.
2. SP level transition (E1M1 → E1M2 via exit) still works.
3. Local DM reset (frag limit hit, scoreboard, restart) still works.

---

### Step L1.6 — Wire Level events
**Goal:** Level emits `level-complete`, `player-died`,
`player-spawned`. No subscriber yet (Game will subscribe in L2). The
emit calls replace nothing — they're additive alongside existing
window-event dispatches, which still fire and are still listened to
until L4.

**Files:**
- `src/game/level.js` — already has `_emit`/`on` from L1.1.
- `src/game/player/damage.js` — where exit lines trigger the level
  end today. Add `window.__currentLevel?._emit('level-complete', { ... })`
  alongside the existing transition.
- `src/game/player/damage.js` — where player death is detected. Add
  `window.__currentLevel?._emit('player-died', { slot, ... })`.
- `src/game/player/spawn.js` — where `spawnPlayer` finishes. Add
  `window.__currentLevel?._emit('player-spawned', { slot })`.

**Untouched:** All existing logic, including the `cssdoom:*`
dispatches.

**Verify:**
1. Build runs.
2. In dev console, before walking to E1M1's exit:
   `window.__currentLevel.on('level-complete', e => console.log('LEVEL-COMPLETE', e))`.
   Walk to exit → log fires.
3. Die in SP → `'player-died'` logs (subscribe similarly).
4. Smoke paths all run.

---

### Step L1.7 — Hand the Level to a real owner
**Goal:** Drop the `window.__currentLevel` placeholder. Replace with a
real module-level reference in `src/game/level.js`:

```js
// src/game/level.js
let _currentLevel = null;
export function getCurrentLevel() { return _currentLevel; }
export function _setCurrentLevel(lvl) { _currentLevel = lvl; }
```

Update `shared/maps.js::loadMap` and `master.js::gameLoop` to use
these helpers. Yes, this is still a module-level singleton (transient
— Game will replace it in L2.9). The point is to stop polluting
`window`.

**Files:**
- `src/game/level.js` — add helpers above.
- `src/shared/maps.js` — `_setCurrentLevel(lvl)` after `lvl.load()`.
- `src/master.js` — `gameLoop` reads `getCurrentLevel()` instead of
  `window.__currentLevel`.
- `src/game/player/damage.js`, `src/game/player/spawn.js` — import
  `getCurrentLevel` instead of `window.__currentLevel`.

**Verify:**
1. Build runs.
2. `window.__currentLevel` no longer exists.
3. `getCurrentLevel()` works from dev console (after importing it).
4. All smoke paths.

---

### Phase L1 checkpoint
- `Level` class exists, has the full §8 API surface, and owns the
  load-init-tick-pause-stop-destroy lifecycle.
- No external behavior change.
- `state.things` etc. still live on the global singleton (deferred to
  L7).
- Existing `loadMap` / `gameLoop` are thin shims over Level.
- `cssdoom:*` window events still dispatch (deferred to L4).

**Commit boundary:** end of L1.7. Single phase commit message:
"L1: introduce Level class; loadMap and gameLoop delegate to it."

---

## 4. Phase L2 — Game class

**Goal:** introduce `src/game/game.js` and move roster + match + UI
ownership inside it. After L2, the master window has Game →
Level layering; App is still missing (boot is still procedural).

**Pre-phase check:**
- L1 checkpoint complete and committed.
- `getCurrentLevel()` reachable from anywhere it's needed.

### Step L2.1 — Create Game skeleton
**Goal:** Class exists, importable, dead code.

**Files:**
- **New:** `src/game/game.js`:
```js
import { Level, _setCurrentLevel } from './level.js';

export class Game {
    constructor(modeConfig) {
        this.modeConfig = modeConfig;
        this.gameMode = modeConfig.gameMode;
        this.networkMode = modeConfig.networkMode;
        this.rules = modeConfig.rules ?? null;
        this.skillLevel = modeConfig.skillLevel ?? 3;
        this.roster = []; // L2.3
        this.level = null;
        this.mapCursor = modeConfig.startMap ?? 'E1M1';
        this._state = 'LOBBY';
        this._listeners = new Map();
    }

    async start()       { /* L2.x */ }
    pause()             { /* L5 */ }
    resume()            { /* L5 */ }
    async stop()        { /* L2.x */ }
    claimSlot(...)      { /* L2.3 */ }
    beginPlay()         { /* L2.6 */ }
    restartMatch()      { /* L2.5 */ }
    advance()           { /* L2.7 */ }

    on(event, handler) { /* same emitter as Level */ }
    _emit(event, payload) { /* ditto */ }
    _transitionTo(newState) {
        const from = this._state;
        this._state = newState;
        document.body.dataset.gameState = newState;
        this._emit('state-changed', { from, to: newState });
    }
}
```

**Untouched:** Everything else.

**Verify:** build runs; nothing imports `Game` yet.

---

### Step L2.2 — modeConfig source
**Goal:** define where modeConfig comes from. Until App exists (L3),
`master.js` builds it from existing globals.

**Files:**
- **New:** `src/game/mode-config.js` (a tiny helper):
```js
export function buildModeConfigFromUrl() {
    // returns { gameMode, networkMode, skillLevel, startMap, rules }
    // reads sessionStorage.lastUsedMode + URL params + kiosk default.
    // For now: returns the same defaults state.js already sets.
}
```
- `src/master.js` — call `buildModeConfigFromUrl()` and stash on a
  local var. **Don't construct Game yet** — L2.9 wires it in.

**Untouched:** `state.gameMode` / `state.networkMode` still set by the
existing `mode.js` flow; modeConfig is parallel data.

**Verify:** build runs; smoke paths all run; `buildModeConfigFromUrl()`
returns a sensible object when called from dev console.

---

### Step L2.3 — Roster ownership
**Goal:** Game.roster is the authoritative roster. Initially: alias
to `state.players` (no copy). `claimSlot(slot, deviceId)` mutates the
roster + writes `state.players[slot]` to keep compat.

**Files:**
- `src/game/game.js` — implement:
  - `this.roster = state.players` (alias).
  - `claimSlot(slot, deviceId)` — creates Player via existing
    `addPlayerThing` flow if not present, writes claim binding,
    emits `roster-updated`.
- `src/input/claim-registry.js` — already exists; Game calls
  `tryClaimSlot(deviceId)` from inside its `claimSlot` for the
  device-binding side, and writes the roster entry for the
  Game-side. The two are kept consistent.

**Untouched:** `state.players` still works as before.

**Verify:**
1. Build runs.
2. From dev console, construct a Game manually:
   `g = new Game({ gameMode: 'singleplayer', networkMode: 'standalone' })`
   then `g.claimSlot(0, 'kbm-A')` → `g.roster[0]` populated.
3. Smoke paths still run (Game instance is dead-code; not wired into
   loop).

---

### Step L2.4 — Game subscribes to Level events
**Goal:** Game.on-Level-`level-complete` → in SP: PLAYING →
INTERMISSION + show intermission overlay; in DM: PLAYING → RESULTS +
show scoreboard. Game.on-Level-`player-died` → DM scoring; SP
respawn-ready flag.

**Files:**
- `src/game/game.js`:
  - In `start()`, after constructing Level: `this.level.on(...)`.
  - Add `_onLevelComplete(payload)`, `_onPlayerDied(payload)`,
    `_onPlayerSpawned(payload)` handlers.
- **Important:** Do **not** delete the existing inline handlers in
  `ui/intermission.js` etc. yet. Game's handlers are additive;
  cleanup happens in L4 when window events are torn down.

**Verify:** build runs. Game-internal logging traces fire on
level-complete and player-died (instrument with `console.log` while
verifying, then remove).

---

### Step L2.5 — Move match.js logic into Game
**Goal:** match.js becomes a thin façade. The actual lobby-active /
match-active / match-end logic moves into Game methods.

**Files:**
- `src/game/game.js`:
  - `beginPlay()` — implements §10's roster freeze + Level
    construction + load + start sequence (for SP and Local DM only;
    Network DM extension lands in L6).
  - `restartMatch()` — RESULTS → LOBBY transition.
- `src/game/match.js`:
  - `startMatch()` — becomes
    `export function startMatch() { app.game?.beginPlay(); }`
    (App reference resolved via a setter for now; L7 cleans up.)
  - `endMatch()` — becomes `app.game?._endMatch()`.
  - `resetMatch()` — kept temporarily; called by lobby.js, which
    L2.6 will rewire.
  - `isMatchLobby()`, `isMatchEnded()` — return derived predicates
    on `app.game?.state`.

**Untouched:** Public API of `match.js` (its exports stay) so all
existing callers compile.

**Verify:**
1. Build runs.
2. Local DM still works end-to-end (claim → match → frag limit →
   scoreboard → restart).
3. SP still works (matchless).

---

### Step L2.6 — Move lobby UI ownership
**Goal:** `ui/lobby.js` and `ui/network-lobby.js` stop listening to
input directly; instead, Game pushes lobby state as renderer commands
via the orchestrator, and the UI modules become pure renderers of that
state.

**Files:**
- `src/renderer/commands.js` — add new commands:
  - `showLobby({ slots, roomCode })` (per-pane).
  - `hideLobby()` (per-pane).
  - `updateLobbyState({ slots })` (per-pane).
- `src/renderer/dom-renderer.js` — implement the impls (call into
  `ui/lobby.js`'s render-only functions).
- `src/ui/lobby.js` — split: keep render-only DOM mutations
  (set slot occupancy class, prompt text). Remove direct event
  subscriptions. Expose
  `renderLobbyState({ slots, roomCode })` and `clearLobby()`.
- `src/ui/network-lobby.js` — same split.
- `src/game/game.js`:
  - In `start()` LOBBY entry: `orchestrator.showLobby(slot, { slots: this.roster, ... })`.
  - On `claimSlot()`: `orchestrator.updateLobbyState(slot, { slots: this.roster })`.
  - On `beginPlay()`: `orchestrator.hideLobby(slot)`.
- `src/actions/gates.js` — already handles CLAIM gate; verify it
  still calls into `tryClaimSlot()` and Game's `claimSlot()` is
  notified (today it works via `onClaimChange`; that hook stays).

**Verify:**
1. Build runs.
2. Local DM lobby shows correctly: both panes show claim prompt;
   first press claims slot 0, second press claims slot 1, match
   starts.
3. Network DM lobby shows QR + slots on master pane; remote join
   populates slot 2.

---

### Step L2.7 — Move intermission UI ownership
**Goal:** Same pattern: intermission becomes a renderer command;
overlay module renders the command's payload.

**Files:**
- `src/renderer/commands.js` — add:
  - `showIntermission({ stats })`.
  - `hideIntermission()`.
- `src/renderer/dom-renderer.js` — impls call into `ui/intermission.js`'s
  render-only function.
- `src/ui/intermission.js`:
  - Keep DOM rendering of stats.
  - Remove `isIntermissionActive()` / `dismissIntermission()` direct
    dispatch — Game handles "fire to advance" via the existing
    gates.
- `src/game/game.js`:
  - On `level-complete` (SP): `orchestrator.showIntermission(slot, payload)`.
  - `advance()` — called from the intermission gate; loads next map.

**Verify:** SP level transition shows intermission overlay; firing
dismisses + loads next map.

---

### Step L2.8 — Move scoreboard / results UI ownership
**Goal:** Same pattern.

**Files:**
- `src/renderer/commands.js` — add `showResults({ scores, killMatrix })`,
  `hideResults()`.
- `src/renderer/dom-renderer.js` — impls.
- `src/ui/scoreboard.js` — keep DOM rendering.
- `src/game/game.js`:
  - On match-end (DM): transition to RESULTS;
    `orchestrator.showResults(slot, payload)`.
  - On `restartMatch()`: hide, transition to LOBBY.

**Verify:** DM match-end → scoreboard on both panes; fire → restart →
lobby.

---

### Step L2.9 — `master.js` constructs Game
**Goal:** Drop the bare-`loadMap` boot path; `master.js` builds a
Game with modeConfig and calls `game.start()`. Game owns Level
construction.

**Files:**
- `src/master.js::initMaster()`:
  ```js
  const modeConfig = buildModeConfigFromUrl();
  const game = new Game(modeConfig);
  await game.start();
  // (gameLoop already drives via getCurrentLevel())
  ```
- `src/shared/maps.js::loadMap` — keep as compat for any caller still
  using it directly (the intermission advance path in pre-L2.7
  code). After L2.7, only Game calls it; eventually we delete it in
  L7.
- `src/game/level.js::_setCurrentLevel` — called from inside
  `Game.beginPlay()` now, not from `loadMap`.

**Verify:** All four smoke paths run identically to pre-L2.

---

### Phase L2 checkpoint
- `Game` class exists with full §7 API surface.
- Game owns roster, match state, lobby/intermission/results UI
  triggering.
- `master.js` constructs Game; Game constructs Levels.
- `match.js`, `ui/lobby.js`, `ui/intermission.js`, `ui/scoreboard.js`
  are reduced to render-only.
- `cssdoom:*` events still dispatch (deferred to L4).
- `game-state.js` machine still exists in parallel (deferred to L3).

**Commit boundary:** end of L2.9.

---

## 5. Phase L3 — App class

**Goal:** introduce `src/app.js` and move boot-and-mode resolution
inside. Delete `src/game/game-state.js`. After L3, `master.js` is
~10 lines.

### Step L3.1 — Create App skeleton
**Files:**
- **New:** `src/app.js`:
```js
export class App {
    constructor() {
        this._state = 'BOOT';
        this._previousState = null;
        this.game = null; // Game | RemoteGame
        this.lastModeConfig = null;
        this._listeners = new Map();
    }

    async start() { /* L3.2 */ }
    destroy()     { /* dev hot-reload */ }
    transitionTo(state) { /* L3.4 */ }

    async startLocalGame(modeConfig) { /* L3.3 */ }
    async joinRemoteGame(roomCode)   { /* L6 */ }
    async endGame()                   { /* L3.3 */ }

    on(event, handler) { /* same emitter */ }
    _emit(event, payload) { /* ditto */ }
}
```

**Verify:** build runs.

---

### Step L3.2 — App.start() resolves boot destination
**Goal:** Implement §3 / Q12 boot resolution.

**Files:**
- `src/app.js`:
  - `start()` reads URL params, sessionStorage.lastUsedMode, kiosk
    flag.
  - Routes:
    - `?join=` → `this.joinRemoteGame(room)` (stub for L6).
    - kiosk → `this.startLocalGame(kioskDefault)`.
    - sessionStorage → `this.startLocalGame(stored)`.
    - else → `this.transitionTo('MENU')`.
- `src/master.js::initMaster()` — becomes:
  ```js
  const app = new App();
  await app.start();
  window.app = app; // dev convenience
  ```

**Verify:**
1. Build runs.
2. Kiosk boot → Local DM lobby (because kiosk default in `app.js` =
   DM standalone).
3. Non-kiosk boot with no sessionStorage → menu opens (mode-pick).
4. Non-kiosk boot after picking SP from menu (sessionStorage now set)
   → SP starts.
5. `?join=ABCD` → currently stub-throws; tested in L6.

---

### Step L3.3 — `startLocalGame` / `endGame`
**Files:**
- `src/app.js`:
  - `startLocalGame(cfg)` — `this.endGame()` if game exists; construct
    `new Game(cfg)`; `await game.start()`; transition to IN_GAME;
    write `sessionStorage.lastUsedMode` (non-kiosk only).
  - `endGame()` — if `this.game` exists, `await this.game.stop()`,
    `this.game = null`.

**Verify:** sequence of menu picks works: pick SP, play, menu → "New
Game" picks DM, transitions cleanly with no leftovers.

---

### Step L3.4 — App state machine + body class
**Files:**
- `src/app.js`:
  - `transitionTo(state)` — sets `this._previousState = this._state`,
    `this._state = state`, writes `body.dataset.appState`,
    emits.
- Delete `src/game/game-state.js`.
- Anything that read `getGameState()` / `onStateChange()` —
  re-route to `app.state` or `app.game?.state`. (The survey found
  these usages in `actions/gates.js`, `ui/attract.js`,
  `ui/menu.js`, possibly `ui/intermission.js`.)
- CSS that read `body[data-game-state]` (legacy machine) — repoint
  to `body[data-game-state]` written by Game (L2) or
  `body[data-app-state]` (App). Audit `*.css` for selector usage.

**Verify:** body has both `data-app-state` and `data-game-state`
attributes; values change correctly through SP boot, menu open, etc.

---

### Step L3.5 — Menu integration
**Goal:** App.MENU is the only "menu open" state; menu.js is render-only.

**Files:**
- `src/ui/menu.js`:
  - On menu button: `app.transitionTo('MENU')`.
  - On close: App resolves per §3c (previousState lookup).
- `src/app.js`:
  - On entering MENU: `this.game?.pause()` (host or SP).
  - On leaving MENU: per §3c.

**Verify:**
1. Menu open in SP → game pauses (no motion).
2. Menu close → resume.
3. Menu open in attract (post-L3.6) → close lands in Game start.

---

### Step L3.6 — Attract integration (kiosk warm path only)
**Goal:** Move idle-detection + attract camera RAF onto App.

**Files:**
- `src/app.js`:
  - `transitionTo('ATTRACT')` — `await this.endGame()`, capture last
    player pose, hide HUD/weapon/billboards via renderer commands,
    start rotation RAF.
  - `transitionTo('IN_GAME')` from ATTRACT — stop RAF, call
    `startLocalGame(lastModeConfig)`.
- `src/ui/attract.js`:
  - Strip the in-loop throttle.
  - Idle-detection moves to App (timer + `pingActivity()` calls
    still come from input modules).

**Cold attract**: still documented in §16 of the refactor doc but
unused — implement only the warm path now per the recent decision.

**Verify:**
1. Kiosk SP, sit idle 60s → IN_GAME → ATTRACT, view rotates.
2. Press fire → IN_GAME → new Game starts.

---

### Step L3.7 — `master.js` shrinks
**Goal:** Final form of `master.js`:
```js
import { App } from './app.js';
import { initInputs } from './input/index.js';

export async function initMaster() {
    initInputs();
    const app = new App();
    await app.start();
    window.app = app;
}
```
Anything that doesn't fit moves to App (inputs registration may
warrant staying procedural in `index.js` if it's truly side-effect-free
on App state).

**Verify:** all four smoke paths.

---

### Phase L3 checkpoint
- `App` class exists, drives boot.
- `master.js` is a thin entry point.
- `game-state.js` deleted.
- Body classes track App + Game state.
- Menu pauses Game; attract is an App state.

**Commit boundary:** end of L3.7.

---

## 6. Phase L4 — Event-driven transitions

**Goal:** Delete `cssdoom:*` window CustomEvents and replace with
direct Level → Game → App event subscriptions (already added in L1.6
and L2.4 but parallel to the window events; now we make them
authoritative).

### Step L4.1 — Delete `cssdoom:level-changing`
- Remove dispatch in `src/shared/maps.js`.
- Remove listeners (audio fade-out, UI fade, etc.) — repoint them to
  subscribe to `Level.on('about-to-unload')` (a new event Level emits
  *before* `destroy()`). Add this event to Level.
- **Files affected:** any file with `cssdoom:level-changing` —
  grep and list before doing.

**Verify:** SP level transition triggers fade-out as before.

### Step L4.2 — Delete `cssdoom:level-loaded`
- Remove dispatch in `src/shared/maps.js`.
- Repoint listeners to `Level.on('loaded')` (added to Level).

**Verify:** post-load UI updates as before.

### Step L4.3 — Delete `cssdoom:match-reset`
- Remove dispatch in `src/game/match.js`.
- Repoint listeners to `Game.on('match-restarted')`.

**Verify:** DM restart still resets per-slot HUD state.

### Step L4.4 — Gate audit
- `src/actions/gates.js` — every `state.gameMode === X` check
  replaced with `app.game?.gameMode === X`. Every `state.matchEnded`
  / `getGameState()` check replaced with `app.game?.state === X`.
- Match the §15 input routing table exactly.

**Verify:** full §15 table by hand — go through each (App state ×
Game state) and assert input behavior matches.

---

### Phase L4 checkpoint
- No `cssdoom:*` window events anywhere in `src/`.
- Gates read App + Game state only.
- The §15 input table is the live contract.

**Commit boundary:** end of L4.4.

---

## 7. Phase L5 — Pause / resume semantics

**Goal:** Per §7 + §14, host pause fans out via renderer commands.

### Step L5.1 — Add paused-state renderer commands
**Files:**
- `src/renderer/commands.js` — add `showPaused()` / `hidePaused()`
  (per-pane).
- `src/renderer/dom-renderer.js` — impls (toggle a paused overlay
  class on the pane).

### Step L5.2 — Game.pause() emits + Level.pause()
**Files:**
- `src/game/game.js`:
  - `pause()` — `this.level?.pause()`, then
    `for (slot) orchestrator.showPaused(slot)` to fan to local
    panes + sinks.
  - `resume()` — reverse.

### Step L5.3 — Verify Level.pause is no-op during LOADING
Per §15 ("`Game.pause()` during LOADING is a no-op on Level"). The
showPaused command still fans out so the loading splash tints
"paused" but no Level method is called.

**Files:**
- `src/game/game.js` — guard: only call `this.level?.pause()` if
  `this.level && this._state === 'PLAYING'`.

**Verify:**
1. Open menu mid-PLAYING → both panes (and any connected clients)
   tint paused.
2. Open menu during LOADING (rare: trigger via slow network throttle
   in Network DM) → splash tints paused, no errors.

---

### Phase L5 checkpoint
- Pause/resume work end-to-end across master and clients (clients
  verified in L6).
- LOADING-pause is safe.

**Commit boundary:** end of L5.3.

---

## 8. Phase L6 — RemoteGame + Network start coordination

**Goal:** client window gets a symmetric `App + RemoteGame` shape; the
network start handshake matches §12.

### Step L6.1 — Create RemoteGame skeleton
**Files:**
- **New:** `src/game/remote-game.js`:
```js
export class RemoteGame {
    constructor({ roomCode, orchestrator }) {
        this.roomCode = roomCode;
        this.orchestrator = orchestrator;
        this._state = 'CONNECTING';
        this._transport = null;
        this._listeners = new Map();
    }
    async start() { /* L6.2 */ }
    pause()       { /* local input gate */ }
    resume()      { /* local input gate */ }
    async stop()  { /* L6.2 */ }
    on(...)       { /* same emitter */ }
}
```

### Step L6.2 — RemoteGame owns transport
- `start()`:
  1. Construct ClientConnection.
  2. Send LOOKING.
  3. On ACK: extract slot assignment, reshape DomRenderers,
     transition to CONNECTED.
  4. Wire RenderClient → orchestrator → DomRenderer.
  5. Wire remote-input forwarder.
- `stop()`: close transport, tear down RenderClient.

### Step L6.3 — Client window App
**Files:**
- `src/client.js` — replace `initClientWindow()` procedure with
  `App.joinRemoteGame()`.
- `src/app.js::joinRemoteGame(roomCode)` — construct
  `new RemoteGame({ roomCode, orchestrator })`, store as `this.game`,
  transition IN_GAME.

**Note:** App on client doesn't have ATTRACT; menu open on client
calls `RemoteGame.pause()` which just gates local input (per §7b).

### Step L6.4 — Game broadcasts UI via renderer commands
Already wired in L2.6–L2.8 (showLobby/Intermission/Results). Now
verify they fan to clients automatically (sinks already in place
from current code).

**Verify:** Network DM client sees lobby overlay during lobby phase.

### Step L6.5 — Delete legacy wire envelopes
- `src/transport/protocol.js` — delete `LOBBY_STATE`, `MATCH_END`,
  `GAME_STATE` from `MSG`.
- Master code that sent them → already replaced with renderer
  commands in L2.6/L2.8.
- Client code that received them → delete the handlers.

**Verify:** Network DM lobby → start → results → restart all work
without those envelopes.

### Step L6.6 — Add MSG.LOAD_MAP + ready-to-play handshake
Per §12 start-of-first-level:
- `protocol.js` — keep `MSG.LOAD_MAP` if already present; otherwise add.
- Add `MSG.READY_TO_PLAY` (client → master after scene rebuild).
- Add `MSG.PLAY` (master → all clients to start ticking).
- `Game.beginPlay()`:
  1. Freeze roster.
  2. Broadcast `LOAD_MAP { name }`.
  3. Construct + load master Level.
  4. Push `hideLobby` + initial HUD/camera.
  5. Wait for `READY_TO_PLAY` from every client.
  6. Broadcast `PLAY`.
  7. `level.start()` + transition to PLAYING.
- `RemoteGame` on receive `LOAD_MAP`:
  1. `decorateMapData` via shared singleton.
  2. Tell DomRenderer to rebuild scene.
  3. Send `READY_TO_PLAY`.
- `RemoteGame` on receive `PLAY`:
  1. Local PLAYING flag (no Level on client — it's still just
     receiving renderer commands).

### Step L6.7 — Delete onJoin snapshot spawn workaround
- `src/network-host.js` (or wherever the current "broadcast world
  snapshot on join" logic lives) — delete. With the coordinated
  start, late join doesn't exist (§17).

**Verify:** Network DM full flow:
1. Host opens room.
2. Client joins → both see lobby in sync.
3. Host fires start → both see LOADING splash → both reach PLAYING
   with the same world.
4. Match ends → both see scoreboard.
5. Host restarts → both see lobby.

---

### Phase L6 checkpoint
- Client window has App + RemoteGame; no Game/Level on client.
- Legacy wire envelopes deleted.
- Coordinated start handshake live.

**Commit boundary:** end of L6.7.

---

## 9. Phase L7 — Cleanups

### Step L7.1 — Delete side-door setters
- `setMasterConnection(mc)` — replace with constructor DI on
  whatever owns MasterConnection (likely Game).
- `setMatchEndBroadcaster(fn)` — gone; Game emits via orchestrator
  renderer commands now.
- `setGameStateBroadcaster(fn)` — gone with game-state.js (L3.4).

### Step L7.2 — Formalize Level state ownership
- Audit `state.things` / `state.doorState` / etc. access. Add
  comments in `src/game/state.js` documenting that these are
  Level-owned conceptually (Level constructs and destroys them).
- **Don't move the storage** unless trivial. The refactor doc says
  "for migration the singleton stays."

### Step L7.3 — Delete `loadMap` if unused
- After L2, only Game calls `loadMap`. Refactor Game to call
  `new Level(...).load()` directly and delete the shim.

### Step L7.4 — Audit unused exports
- Grep each module for orphaned exports. Delete them.
- Particular candidates: `getCarriedOverClaims` in `ui/lobby.js` if
  Game owns claim transfer now; `resetMatch` in `match.js`.

### Step L7.5 — CSS body-class audit
- Search all `.css` files for `body[data-game-state]` / `body.kiosk`
  / `body[data-game-mode]` / `body[data-network-mode]` /
  `body[data-app-state]` — make sure every used selector is still
  written by some live code path.
- Delete any selectors keyed on the deleted gameState values
  (`ACTIVE` etc.) — they should now read PLAYING / LOBBY / etc.

### Step L7.6 — Delete remaining dead modules
- `src/game/match.js` — if every export is now a thin façade, delete
  the file and update imports.
- `src/ui/attract.js` — likely just a render helper for App now;
  inline if trivial.

**Verify after each L7 step:** full four-path smoke + visual check.
L7 is the highest-risk phase for silent regression because we're
deleting things.

---

### Phase L7 checkpoint
- No side-door setters in `src/`.
- No `cssdoom:*` window events.
- No `game-state.js`.
- No legacy wire envelopes.
- Body class consumers all match live attribute writers.
- §18 of the refactor doc is fully reflected in the code.

**Commit boundary:** end of L7.6.

---

## 10. Cross-cutting verification

After each phase commits, run this matrix manually:

| Path           | Boot → first frame | Mid-game pause | Level transition / match end | Restart |
|----------------|--------------------|----------------|------------------------------|---------|
| SP (non-kiosk) | OK?                | OK?            | E1M1 → E1M2 via exit         | n/a     |
| Local DM       | OK?                | OK?            | Frag limit → scoreboard      | OK?     |
| Kiosk SP       | OK? + mirror       | OK?            | E1M1 → E1M2 via exit         | n/a     |
| Network DM     | OK? + client join  | OK? both sides | Frag limit → scoreboard both | OK?     |

Plus for L3.6 onward:
- Kiosk idle → attract → wake → IN_GAME.
- Menu open during attract → close → IN_GAME (per §3c).

---

## 11. Risks + abort signals

**Stop the phase and re-plan if:**
- A step's verify-check fails and the cause isn't an obvious typo
  (e.g. SP regresses during L2 — that means Game's ownership of
  some piece broke a path that didn't exist on `main`).
- A "cleanup" step in L7 reveals a caller you didn't know about and
  the refactor doc doesn't say what should own it. Don't invent the
  ownership — pause and add to the refactor doc.
- Network DM behavior diverges between master and clients after L6.
  Renderer-command parity is the contract; if it breaks, the
  problem is in the orchestrator fan-out or the protocol, not in
  Game.

**Known fragile spots:**
- Attract entry / exit involves DomRenderer scene continuity (per
  §13b). Easy to break by accidentally introducing a "clear scene on
  Level.unload" call. Don't.
- The `state.players` aliasing on Game.roster means a Game replacement
  doesn't automatically clear `state.players`. Make sure `endGame()`
  walks the roster and clears Player entries to avoid carryover.
- Input registration in `master.js` runs once at boot; if App
  rebuilds inputs on game switches, providers might double-register.
  Keep input providers registered for the page lifetime.

---

## 12. Out of scope for this plan

- Network DM mid-match join (§17 — Phase 9 territory).
- Spectator mode (Q3 future).
- Saved games / replay (Q-not-yet).
- The cold-attract scene-inconsistency (deferred per the recent
  decision; only matters if kiosk default flips to Network DM).
- Cloudflare TURN fallback (existing todo, post-refactor).
