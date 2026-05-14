# Lifecycle Refactor — App / Game / Level Separation

A design document, locked before implementation. Every section is a
decision, not a suggestion. Open questions are explicitly called out as
"OPEN" — those get answered here before any code is touched.

---

## 1. Goal

Today the per-frame `gameLoop` in `master.js` runs continuously from
boot, gated only by a few ad-hoc checks. It ticks during the lobby,
during the intermission, during the results screen, during the menu.
"What state are we in" is spread across `state.gameMode`,
`state.networkMode`, a `gameState` machine, body classes, and the
loop's own implicit checks. Bugs live at the seams between those.

The refactor introduces an explicit layered split. Each layer has one
job. The boundaries are sharp: no layer reaches across more than one
level of containment.

**App is universal — every window has one.** App is the persistent
shell that owns menu, attract, fullscreen, debug. Whether the window
is "hosting a game" or "joining a remote game" is a polymorphic choice
at the layer App holds: `Game` (local simulation) or `RemoteGame`
(wire receiver). Both implement the same `start / pause / resume /
stop / on` interface so App treats them identically.

A window can switch between Game and RemoteGame **without reloading the
page** — menu's "Start Game" calls `App.startLocalGame(modeConfig)`,
menu's "Join" calls `App.joinRemoteGame(roomCode)`. The `?join=CODE`
URL is a boot-time shortcut for the latter, not a separate window
type.

```
EVERY WINDOW
─────────────────────────────────────────────────────────────────────
App
  - persistent shell (lives for the page's lifetime)
  - menu, attract reel, fullscreen / debug UI
  - reads URL + saved prefs at boot
  - constructs / tears down exactly one of: Game OR RemoteGame
  - state: BOOT / ATTRACT / MENU / IN_GAME

App holds ONE of:

┌─────────────────────────────┐    ┌──────────────────────────────┐
│  Game (local simulation)    │    │  RemoteGame (wire receiver)  │
│                             │    │                              │
│  - SP or DM host            │    │  - joined a remote master    │
│  - owns roster              │    │  - owns wire transport       │
│    (state.players persists  │    │    + input forwarder         │
│    across Levels)           │    │  - on LOAD_MAP envelope:     │
│  - owns match struct        │    │    fetch + decorate mapData  │
│    (score/frags/kill matrix)│    │    via shared singleton,     │
│  - owns mode (gameMode +    │    │    then DomRenderer rebuilds │
│    networkMode='standalone' │    │  - dispatches incoming       │
│    or 'host')               │    │    CMD_* envelopes into      │
│  - lobby/intermission/      │    │    orchestrator → DomRenderer│
│    results UI STATE —       │    │  - owns its OWN local        │
│    pushed via orchestrator  │    │    transport-state UI        │
│    commands, never touches  │    │    (connecting / disconnected│
│    DOM directly             │    │    / failed overlays) —      │
│  - owns network transport   │    │    window-level chrome, for  │
│    (MasterConnection when   │    │    this window only, no      │
│    hosting)                 │    │    fan-out                   │
│  - constructs / tears down  │    │  - NO Level, NO state.*,     │
│    a Level                  │    │    NO simulation. Visual is  │
│  - state: LOBBY / LOADING / │    │    whatever renderer commands│
│    PLAYING / INTERMISSION / │    │    set it to.                │
│    RESULTS / ENDED          │    │  - state: CONNECTING /       │
│                             │    │    CONNECTED / DISCONNECTED /│
│  Contains a Level:          │    │    FAILED                    │
│  ┌──────────────────────┐   │    └──────────────────────────────┘
│  │ Level                │   │
│  │  - one loaded map    │   │
│  │  - uses mapData       │   │
│  │    (shared singleton)│   │
│  │  - owns state.things,│   │
│  │    doorState,        │   │
│  │    liftState,        │   │
│  │    crusherState,     │   │
│  │    projectiles,      │   │
│  │    spatial grid      │   │
│  │  - per-frame tick:   │   │
│  │    collectInputs →   │   │
│  │    updateGame →      │   │
│  │    render            │   │
│  │  - state: unloaded / │   │
│  │    loaded-paused /   │   │
│  │    loaded-running    │   │
│  │  - emits:            │   │
│  │    level-complete,   │   │
│  │    player-died,      │   │
│  │    player-spawned    │   │
│  └──────────────────────┘   │
└─────────────────────────────┘
```

Both Game and RemoteGame are constructed by App and torn down by App.
Menu UI calls `app.joinRemoteGame(code)` or `app.startLocalGame(cfg)`
which internally:
1. If a game is currently held, `app.game.stop()`.
2. `app.game = new Game(...)` or `app.game = new RemoteGame(...)`.
3. `await app.game.start()`.
4. `app.transitionTo('IN_GAME')`.

App never reaches into `app.game` for transport / simulation details.
App listens for events (`game-ended`) and reacts via its own state
transitions.

**Non-negotiable boundaries:**

- App never reads `state.things` / `state.players`. App never owns a
  RAF for game logic. App never touches the orchestrator directly.
- Game never runs `updateGame`. Game never reads `state.things`. Game
  owns the roster (`state.players`) but doesn't simulate.
- Level never knows about menus, lobbies, intermissions, results,
  attract, or transport. Level emits events; never asks.

---

## 2. Vocabulary

- **App** — the outer shell singleton. Module: `src/app.js`. Class: `App`.
- **Game** — a match/session. Module: `src/game/game.js`. Class: `Game`.
- **Level** — a loaded map + simulation. Module: `src/game/level.js`.
  Class: `Level`.
- **Mode** — the (gameMode, networkMode) pair from the recent
  `state.mode` split. Configuration handed App → Game at construction.
- **Roster** — the list of players (slot, kind, deviceId / peerKey,
  color) that the Game has committed to. Built up during LOBBY,
  frozen on PLAYING entry, handed Level → constructor.
- **App state / Game state / Level state** — the value of each layer's
  state machine at any instant. There is exactly one of each.
- **`state.*`** — the existing global game-side `state` singleton. Its
  ownership is split:
  - `state.players` → owned by Game (persists across Levels).
  - `state.things` / `doorState` / `liftState` / `crusherState` /
    `projectiles` → owned by Level (reset per Level).
  - `state.skillLevel`, `state.match` → owned by Game.
  - `state.gameMode` / `state.networkMode` → mode config, set by App,
    read by everyone. Configuration, not state.

---

## 3. App state machine

The outermost layer. Persists for the page's lifetime.

```
BOOT     — startup, before initial transition
ATTRACT  — idle reel (kiosk only); App rotates a camera externally
           via DomRenderers with a decorated mapData loaded. No Game,
           no Level, no state.players. See §16.
MENU     — menu overlay open; current Game (if any) is paused
IN_GAME  — a Game is active and driving everything beneath
```

Transitions (each is `app.transitionTo('X')`):

```
BOOT → IN_GAME      (kiosk boot — autostart with kiosk default
                     modeConfig (currently Local DM). Game enters
                     LOBBY which loads the Level immediately (§3b),
                     so the scene is populated from the first frame.
                     ATTRACT is not entered on boot — see §16 + Q12.)
BOOT → IN_GAME      (?join URL → autostart a RemoteGame; any platform)
BOOT → IN_GAME      (non-kiosk boot, sessionStorage.lastUsedMode set
                     → autostart a Game in that mode; lands in its
                     mode-appropriate LOBBY — see Q12)
BOOT → MENU         (non-kiosk boot, no sessionStorage and no
                     ?mode=… URL param)

ATTRACT → MENU      (menu button wakes attract; App records
                     previousState='ATTRACT' so menu-close falls
                     through to IN_GAME, not back to attract — see §3c)
ATTRACT → IN_GAME   (fire/use wakes attract → app.startLocalGame(lastModeConfig);
                     new Game enters LOBBY which resolves per mode — see §3b.
                     Also kiosk DM auto-start when claims complete.)

MENU → IN_GAME      (menu close — App resolves the destination by
                     previousState:
                     'IN_GAME' → resume held Game;
                     'ATTRACT' → start fresh Game with lastModeConfig.
                     Also reachable via a menu option that calls
                     app.startLocalGame (tears down any existing Game,
                     constructs fresh). See §3c.)
MENU → ATTRACT      (idle timeout in kiosk; never via menu close)

IN_GAME → MENU      (user opens menu — App tells the Game to pause)
IN_GAME → ATTRACT   (Game ends + idle, in kiosk; renderer scenes are
                     preserved across the transition — see §13b / §16)
IN_GAME → MENU      (Game ends, in non-kiosk)
```

There is **at most one Game alive at a time**, held by App.
Transitioning IN_GAME → MENU does NOT destroy the Game — it pauses it
so MENU → IN_GAME resumes. Transitioning IN_GAME → ATTRACT (or
explicit "End game") destroys it.

Body class derivation: `body.dataset.appState = state`.

---

## 3b. When does the Level load? Depends on the mode.

The Level (the loaded map) is constructed at different points in
Game's lifecycle depending on whether the roster is known up front:

- **SP (`networkMode='standalone'`, `gameMode='singleplayer'`):**
  Roster is always `[Player 0]`. Game auto-finalizes at LOBBY entry
  and constructs Level immediately. LOBBY is a one-tick passthrough
  to LOADING → PLAYING. The user boots straight into the game with no
  lobby UI shown.

- **Local DM (`networkMode='standalone'`, `gameMode='deathmatch'`):**
  Roster is fixed at 2 players. Game constructs Level immediately at
  LOBBY entry and fires `Level.load()` in the background while the
  claim UI is up. The lobby overlay renders via a renderer command on
  top of the (eventually-paused) scene. Lobby's job is press-to-claim
  — bind each input device to a slot. Both slots claimed →
  `game.beginPlay()`:
  - **Happy path** — load already resolved: Game calls Level.start()
    directly; transition LOBBY → PLAYING. No visible LOADING phase.
  - **Fallback** — load still in flight: Game transitions LOBBY →
    LOADING and shows the loading splash until load resolves, then
    LOADING → PLAYING. Rare on local hardware (map fetch is fast
    relative to two attendees claiming devices), but the state
    machine handles it cleanly.

- **Network DM (`networkMode='host'`, `gameMode='deathmatch'`):**
  Roster is unknown until host fires start. Game enters LOBBY with
  **no Level**. The lobby overlay shows on a blank background (the
  DomRenderer's `.scene` element is empty because nothing's loaded).
  As remotes join, Game updates the roster + pushes lobby-state
  renderer commands. Host fires start → roster freezes → Game
  constructs Level → LOBBY → LOADING → PLAYING. **LOADING phase
  exists** for the map fetch + scene build on master and clients.

- **RemoteGame (client window):** Master sends LOAD_MAP envelope when
  master's Level is loading; client fetches+decorates the shared
  `mapData` singleton and tells its DomRenderer to rebuild the scene.
  Until that envelope arrives, the client's DomRenderer scene is empty.
  Client is NOT involved in roster gathering — that's master-side only.

So the LOBBY → LOADING transition only happens for Network DM. Local
DM and SP skip it (Level is already loaded by the time the user could
press start).

---

## 3c. Menu close behavior

The menu is just an overlay. Opening and closing it carry no payload
of their own — close is a no-op event. The interesting question is
*what is underneath* when the overlay vanishes, and that depends on
the state the App was in when the menu opened. App records
`previousState` on MENU entry and uses it to resolve close:

- **previousState='IN_GAME'** → resume. App transitions MENU → IN_GAME
  and calls `game.resume()`. Game is unchanged; the paused-state
  renderer command clears. The user sees the menu vanish and the scene
  resume.

- **previousState='ATTRACT'** → start a Game. App calls
  `app.startLocalGame(lastModeConfig)` and lands in IN_GAME with the
  new Game in LOBBY (resolves per mode per §3b). The user does NOT
  return to the demo reel — opening the menu signaled intent to
  interact, and dropping them back into attract after they dismiss the
  menu is hostile. The "lobby" they land in is the normal LOBBY of a
  fresh Game (instant pass-through for SP, claim prompts for Local DM,
  etc.).

- **previousState='BOOT'** → not reachable in practice. BOOT → MENU
  only happens on non-kiosk boot with no mode preference in the URL,
  and that menu has no close affordance — the only way forward is
  picking a mode (an option effect — see below).

**Menu options are independent of close.** Picking a menu option
(e.g., "New Game", or changing skill/rules) triggers the option's
effect — typically `app.startLocalGame(newConfig)`, which tears down
any existing Game and lands in IN_GAME with a fresh one. That effect
is what causes the MENU → IN_GAME transition in that case, not the
close. Whether the option handler also auto-closes the overlay as a
UX nicety is an implementation detail, not state-machine business.

In particular, opening the menu during IN_GAME and changing a setting
behaves the same as "New Game from the menu": the option's effect
restarts the Game with the new config. The previousState='IN_GAME'
resume path only kicks in when the user opened the menu, picked
nothing, and closed it.

**`lastModeConfig`** lives on App in-memory. Seeded at boot from
(in order of precedence) URL params → kiosk default. Overwritten in
memory every time a mode is picked or a Game is started. The only
path that reads it is the attract → menu → close fall-through (kiosk
only — non-kiosk doesn't have attract). Kiosk default is
`{ gameMode: 'deathmatch', networkMode: 'standalone' }` — DM is the
installation's headline feature.

`lastModeConfig` is **not** the same field as
`sessionStorage.lastUsedMode` (see Q12). The two have different
audiences:

- `lastModeConfig` (in-memory, kiosk): the attract-menu-close
  fallback. Kiosk never persists it — every page reload restarts at
  the kiosk default, because a reload may be the venue resetting
  for a new attendee.
- `sessionStorage.lastUsedMode` (session-scoped, non-kiosk only):
  the non-kiosk boot autostart hint. Lets dev iteration land back in
  whatever mode was last running, until the tab closes.

The non-kiosk boot path doesn't touch `lastModeConfig` because
non-kiosk has no attract and no attract-menu-close fall-through.

---

## 4. Game state machine

Per match/session. Constructed by App with a mode config. Lives until
the App tears it down.

```
LOBBY        — gathering players; no Level loaded
LOADING      — Game has decided to start; Level.load() is in flight
PLAYING      — Level is loaded-running; per-frame tick is active
INTERMISSION — between Levels (SP only); current Level paused,
               next Level not loaded yet
RESULTS      — terminal scoreboard for the just-completed segment.
               SP: campaign-complete end screen (only after the last
               level). DM: match scoreboard between rounds.
ENDED        — terminal; the App will tear this Game down imminently
```

**Game lifetime, by mode:**

- **SP**: A Game spans the entire campaign as a sequence of Levels.
  LOBBY auto-finalizes the 1-player roster, LOADING / PLAYING cycles
  through E1M1 → E1M2 → … → E1M8 (or → E1M9 via secret exit). Player
  death does NOT transition out of PLAYING — it's an in-Level event
  (Level emits `player-died`; Game shows a respawn overlay; player
  fires → Game stops + reloads the same Level; same Game, fresh Level
  state, persistent score / progress on the Player). RESULTS is
  reached exactly once, after the last level's INTERMISSION
  (campaign-complete end screen). From there only RESULTS → ENDED;
  App tears the Game down. A new playthrough = a new Game.

- **DM**: A Game has no terminal-by-design state. After each match,
  RESULTS → LOBBY cycles back for the next match. The Game keeps
  running until the user explicitly exits to MENU (RESULTS → ENDED).
  In-match death is internal to the Level (Level handles respawn at
  a DM start; no Game transition). See §4b for the match-end + level
  cycling rules.

Transitions (each is `game.transitionTo('X')`):

```
new Game() → LOBBY                  (always — SP auto-finalizes the
                                     1-player roster and proceeds
                                     immediately; DM waits for claims
                                     or host-start)

LOBBY → LOADING                     (roster finalized AND Level.load()
                                     is still in flight. Hit by:
                                     - SP: auto-finalize on LOBBY entry
                                       constructs Level + fires load();
                                       LOBBY exits same tick, LOADING
                                       holds the user on the load splash.
                                     - Network DM: load() doesn't start
                                       until host-fire-start, so this
                                       edge is always taken.
                                     - Local DM: fallback edge if the
                                       background load (fired at LOBBY
                                       entry) hasn't resolved by the
                                       time both slots claim — rare.)
LOBBY → PLAYING                     (Local DM happy path: Level.load()
                                     was fired in background at LOBBY
                                     entry while the claim UI was up;
                                     both slots claimed AFTER load
                                     already resolved → Game calls
                                     Level.start() directly. No
                                     visible LOADING phase.)
LOADING → PLAYING                   (level.load() resolved + started)
LOADING → LOBBY                     (load failed or canceled — rare)

PLAYING → INTERMISSION              (Level emits 'level-complete', SP
                                     only — DM treats level-complete
                                     as match-end; see §4b)
PLAYING → RESULTS                   (DM only: match-end conditions hit
                                     — frag limit / time limit (kiosk) /
                                     exit. SP never enters RESULTS via
                                     PLAYING; SP death is in-Level.)
PLAYING → LOBBY                     (host explicitly restarts a DM
                                     match mid-game — rare / debug)

INTERMISSION → LOADING              (SP: advance to next map)
INTERMISSION → RESULTS              (SP: last level's intermission →
                                     campaign-complete end screen)

RESULTS → LOBBY                     (DM only: restart match — same
                                     Game, fresh roster confirmation,
                                     map advances per §4b)
RESULTS → ENDED                     (user exits to menu, in either
                                     mode — SP after campaign complete,
                                     DM at any time)

* → ENDED                           (App tears down this Game)
```

Body class derivation: `body.dataset.gameState = state`.

---

## 4b. DM match-end + level-cycling rules

DM follows vanilla DOOM by default. Kiosk adds a time limit for player
throughput (so attendees waiting to play don't watch one match run
forever).

**Match-end triggers (any of these ends a match):**
- **Exit hit** — a player crosses an exit line. (Vanilla DOOM DM
  behavior: the exit ends the level / match for everyone.) The
  player who triggered the exit gets credit; the Game observes
  `level-complete` and treats it as match-end in DM mode (different
  from SP, which transitions to INTERMISSION).
- **Frag limit reached** — any player's score hits the configured
  frag limit (default 20). Game observes via `player-died` event
  payload and the running kill-matrix.
- **Time limit reached** — match clock exceeded the configured time
  limit. **Kiosk only by default**, since non-kiosk DM is presumed
  one-off local play. Configurable via `rules.timeLimit` in the
  Game's modeConfig; null/undefined = no time limit.

When any trigger fires:
- Game observes (via Level event or its own match-clock tick).
- Game calls `level.stop()`, sets `level = null`.
- Game transitions PLAYING → RESULTS.
- Game pushes `showResults({ scores, killMatrix, ... })` via the
  orchestrator → fans to local DomRenderers + sinks.

**Map cycling** (only matters between DM matches):

Game holds a `mapCursor` for the cycle. The cycle is sequential
through the same map sequence SP uses: E1M1 → E1M2 → … → E1M8 →
(loop back to E1M1). Secret exits are honored (E1M3 secret exit →
E1M9, then back to E1M4). Same flow logic as SP.

- The first match of a Game starts at whatever map the lobby was
  configured for (host can pick a starting map in the lobby UI;
  default is E1M1).
- On RESULTS → LOBBY, the cursor advances to the next map per the
  flow logic. The new lobby's map is the next one in the cycle.
- Host can also override the next map from the lobby UI before
  starting the next match.

**Modeled in code:**
- `rules.fragLimit: number` — default 20.
- `rules.timeLimit: number | null` — default null in non-kiosk DM,
  set to a kiosk-default (e.g., 5 minutes) in kiosk DM.
- `Game.mapCursor: string` — current map for the active / next
  match. Initialized from the lobby's start-map choice. Advances on
  match-end per the flow logic.
- Match clock tick lives in Game (not Level — the clock is
  match-scoped, not level-scoped). Game increments it each frame
  (or via `setInterval`) while in PLAYING and checks the time limit.

---

## 5. Level state machine

Innermost layer. Constructed by Game with a map name and the player
roster. Has the tightest API.

```
unloaded       — constructed, no map loaded
loaded-paused  — load() resolved; updateGame is NOT ticking
loaded-running — start() called; per-frame tick is active
```

Transitions are method calls:

```
unloaded       → loaded-paused   : await level.load()
loaded-paused  → loaded-running  : level.start()
loaded-running → loaded-paused   : level.pause()
loaded-paused  → loaded-running  : level.resume()
*              → unloaded        : level.stop()
```

There is no body class for Level state — that's an implementation
detail invisible to UI.

---

## 6. App API

```js
class App {
    constructor()

    /** Called once at boot — reads URL flags, sessionStorage, and
     *  the kiosk default, then transitions BOOT → initial state
     *  (IN_GAME or MENU — see Q12). ATTRACT is never the boot
     *  destination in the current flow. */
    async start()

    /** Tear down everything. Only used in tests / dev hot-reload. */
    destroy()

    /** Force a state transition. Internal callers (menu open, attract
     *  wake, etc.) use this. */
    transitionTo(state)

    /** Construct a Game (local simulation — SP or DM host) and enter
     *  IN_GAME with it. Tears down any existing game first. */
    startLocalGame(modeConfig)

    /** Construct a RemoteGame (joining a remote master) and enter
     *  IN_GAME with it. Tears down any existing game first. */
    joinRemoteGame(roomCode)

    /** Cleanly end the current game (Game or RemoteGame) and return to
     *  MENU / ATTRACT. */
    endGame()

    /** Subscribe to App state transitions. */
    on(eventName, handler)
}
```

App emits: `state-changed { from, to }`, `game-ended`.

App's held game (`this.game`) is polymorphic — either a `Game`
instance (§7) or a `RemoteGame` instance (§7b). App treats them
identically through the shared interface:

```
.start()      — begin (no-op if already running)
.pause()      — see below; semantics differ between Game / RemoteGame
.resume()     — reverse of pause
.stop()       — tear down
.on(event)    — subscribe; both emit 'game-ended' (App listens)
```

**`pause` / `resume` mean different things on Game vs RemoteGame.**
App is polymorphic on the call; the underlying behavior is asymmetric
because the two layers have different responsibilities for "paused":

- **`Game.pause()`** (host or SP): pauses the held Level (stops
  updateGame ticking) AND broadcasts a paused-state renderer command
  via the orchestrator. The render command fans to local DomRenderers
  (master's panes show "paused" overlay) and to every sink (each
  connected client's DomRenderer shows the same paused overlay; each
  client's local input forwarder gates). Only the host can pause for
  everyone — it's the world that's paused.

- **`RemoteGame.pause()`** (client window): stops the local input
  forwarder. Does NOT pause anything on the master and does NOT pause
  the visual scene — the master keeps simulating and the client keeps
  receiving render commands behind the local menu overlay. When the
  client closes its menu and calls `resume()`, the forwarder turns
  back on and the player continues seamlessly. This is a purely local
  input gate.

App's menu open/close handler calls `app.game.pause()` /
`app.game.resume()` without caring which kind it holds. The right
thing happens on each side.

---

## 7. Game API

```js
class Game {
    /**
     * @param {object} modeConfig
     * @param {'singleplayer' | 'deathmatch'} modeConfig.gameMode
     * @param {'standalone' | 'host' | 'client'} modeConfig.networkMode
     * @param {number} modeConfig.skillLevel
     * @param {object} [modeConfig.rules]      DM-specific knobs (frag/time limit)
     * @param {string} modeConfig.startMap     map to load when first PLAYING
     */
    constructor(modeConfig)

    /** Called by App after construction. Sets up the transport (host or
     *  client), registers network handlers, transitions to LOBBY. */
    async start()

    /** Pause the world. Pauses the held Level (updateGame stops) AND
     *  pushes a paused-state renderer command via the orchestrator,
     *  which fans to local DomRenderers + every sink — every client's
     *  DomRenderer shows the paused overlay and gates its local input
     *  forwarder. Only the host can pause for everyone; this is the
     *  authoritative pause. No-op if no Level or not in PLAYING. */
    pause()

    /** Reverse — resume the Level and push the un-paused renderer
     *  command so every client clears its paused overlay. */
    resume()

    /** Tear down. Stops + drops the current Level, closes the network
     *  transport, clears state.players. */
    async stop()

    /** Add / remove / claim players in LOBBY. App calls these in
     *  response to lobby UI events; Game updates the roster + broadcasts
     *  lobby state to peers. Only legal in LOBBY. */
    claimSlot({ slot, deviceId })
    releaseSlot(slot)

    /** Host triggers start of the first level. Only legal in LOBBY when
     *  the roster meets the start conditions (>= 2 players in DM). */
    async beginPlay()

    /** Subscribe to Game events. */
    on(eventName, handler)
}
```

Game emits: `state-changed`, `lobby-updated`, `roster-updated`,
`match-ended { winner, scores, killMatrix }`, `game-ended` (App
listens; App's response is to transition IN_GAME → MENU / ATTRACT).

Internally Game owns:
- The roster (`state.players`).
- Match struct (`state.match`).
- The current Level instance (or null if in LOBBY / RESULTS / ENDED).
- The transport for host mode (MasterConnection — accepts incoming
  remotes; null in SP).
- The lobby / intermission / results UI state. Game does NOT touch
  DOM directly — it pushes renderer commands through the same
  orchestrator that Level uses. World commands fan to local
  DomRenderers + sinks, so client DomRenderers display the same
  overlay state automatically via the existing wire fan-out. See §14.

---

## 7b. RemoteGame API

```js
class RemoteGame {
    /**
     * @param {object} config
     * @param {string|null} config.roomCode  — null for Local DM secondary
     *                                          (BroadcastChannel), set for
     *                                          Network DM remote
     * @param {Orchestrator} config.orchestrator
     */
    constructor(config)

    /** Open transport, send LOOKING, wait for ACK. Resolves once we
     *  have a slot assignment from master. */
    async start()

    /** Gate the local input forwarder OFF. Master is unaware; the
     *  master's simulation continues; the visual scene continues
     *  receiving renderer commands behind the local menu overlay.
     *  This is purely a local input concern — RemoteGame doesn't
     *  "pause" anything else, because there's nothing else to pause. */
    pause()

    /** Reverse — gate the local input forwarder ON again. */
    resume()

    /** Close transport, drop the assigned slot, clear DomRenderer.
     *  RemoteGame is back to constructible state. */
    async stop()

    /** Subscribe to events. */
    on(eventName, handler)
}
```

RemoteGame emits: `state-changed`, `connected`, `disconnected`,
`game-ended` (App listens for the last one — fires when master ends
the session).

Internally RemoteGame owns:
- The transport (ClientConnection — initiates LOOKING / receives ACK).
- The RenderClient (subscribes to incoming `CMD_PANE` / `CMD_WORLD` /
  `SOUND` and dispatches into the orchestrator).
- The input forwarder (registers local input devices with the
  orchestrator and ships them over the wire).
- The assigned slot (from master's ACK).
- A small state machine: `CONNECTING / CONNECTED / DISCONNECTED /
  FAILED`.
- **Its own local UI** for transport-state events:
  `connecting` / `connection-failed` / `disconnected` /
  `reconnecting` overlays. These are window-level DOM elements
  RemoteGame creates and toggles directly — they are NOT renderer
  commands (no fan-out needed; the master doesn't care about this
  window's connection state, only this window does) and NOT App-level
  chrome (App doesn't subscribe to transport events). They live next
  to App's chrome (menu, attract) in the body, outside any pane.
  RemoteGame is allowed to touch DOM for these because they're
  purely local-window concerns with no peer that needs to see them.

RemoteGame does NOT own:
- A roster. The visual state of "who else is in the lobby" comes
  through renderer commands; RemoteGame doesn't track it as data.
- A Level. There is no local simulation.
- `state.players` / `state.things` / `state.doorState` / etc. None of
  these exist on a window holding a RemoteGame.
- `state.match`. Scoring state arrives via renderer commands and
  lives only in the displayed DOM.

When master sends a `LOAD_MAP { name }` envelope, RemoteGame:
1. `await loadMapForRender(name)` — fetch the JSON, decorate the
   shared `mapData` singleton.
2. Tell its DomRenderer to `loadMap()` — rebuilds the scene from
   the now-decorated mapData.

That's the only non-renderer-command thing the master sends.
Everything else is `CMD_PANE` / `CMD_WORLD` / `SOUND`.

---

## 8. Level API

```js
class Level {
    /**
     * @param {object} config
     * @param {string} config.map             — map name
     * @param {Player[]} config.players       — roster reference (live)
     * @param {object} config.rules           — gameMode + DM tunables
     * @param {Orchestrator} config.orchestrator
     */
    constructor(config)

    /** Fetch JSON, init mapData, run init* helpers, build scene in
     *  every renderer, position players, addPlayerThing for each.
     *  Resolves once renderer scene is up. State: unloaded → loaded-paused. */
    async load()

    /** Begin the per-frame tick (collectInputs → updateGame →
     *  renderAllActivePanes → RAF). State: loaded-paused → loaded-running. */
    start()

    /** Skip updateGame each frame but keep rendering (so overlays
     *  don't freeze visually). State: loaded-running → loaded-paused. */
    pause()

    /** Reverse of pause. State: loaded-paused → loaded-running. */
    resume()

    /** Cancel RAF, clear state.things / doorState / liftState /
     *  crusherState / projectiles, clear every renderer's scene.
     *  State: any → unloaded. */
    stop()

    on(eventName, handler)
}
```

Level emits:
- `level-complete { reason: 'normal' | 'secret-exit', stats }` — a
  player crossed the exit. SP: Game enters INTERMISSION; DM: Game
  enters RESULTS (match-end via exit, vanilla DOOM behavior; see §4b).
- `player-died { playerIndex, killerIndex?, cause }` — fires once per
  death. Game observes for: SP respawn-overlay flow, DM score / kill
  matrix / frag-limit check.
- `player-spawned { playerIndex }` — informational.

There is no `level-failed` event. SP "all dead" is just one
`player-died` (SP has 1 player); Game shows the respawn overlay and
the player fires to reload the same Level. Campaign-complete is
reached via INTERMISSION → RESULTS, not via PLAYING → RESULTS.

Level does NOT know about networks, lobbies, or the App. It receives a
roster reference from Game; mutates the players' positions / health /
ammo / weapons; the persistent slots (score, ownedWeapons in SP) are
preserved because Level only resets fields that are per-level.

Level holds:
- `mapData` (fetched at load time; not the global singleton — Level's
  own reference).
- The slice of `state` it owns (things / doorState / liftState /
  crusherState / projectiles). On `load()` it clears + repopulates;
  on `stop()` it clears.

---

## 9. Event flow between layers

```
Level ───events──▶ Game ───events──▶ App

Level.level-complete    → Game: stop Level. In SP: transition
                          PLAYING → INTERMISSION (next-level flow).
                          In DM: it's a match-end via exit (vanilla
                          DOOM behavior); transition PLAYING → RESULTS,
                          advance mapCursor. See §4b.
Level.player-died       → Game: in SP, show respawn overlay; player
                          fires → Game stops + reloads the same Level.
                          In DM, update score / kill matrix; start
                          respawn cooldown for that player. Level
                          handles in-Level respawn internally (no
                          state transition on Game). If frag limit
                          hits, Game ends match (PLAYING → RESULTS).
Level.player-spawned    → Game: informational.

(There's no `level-failed` event. SP death is handled via
player-died and an in-Level respawn flow that reloads the Level
without leaving PLAYING. Campaign-complete RESULTS is reached via
INTERMISSION → RESULTS after the last level, not via PLAYING →
RESULTS.)

Game.match-ended        → App: shows nothing on its own (Game owns
                          the results UI); App listens for tracking /
                          analytics / nothing.
Game.game-ended         → App: transition IN_GAME → MENU / ATTRACT.
```

Direction is strictly inward → outward via events. Outer → inner is
method calls only:

```
App ───method calls──▶ Game ───method calls──▶ Level

App.menu opens          → game.pause()
App.menu closes         → game.resume()
App.endGame()           → game.stop() then drop reference
Game.lobby start fires  → level = new Level(...); await level.load(); level.start()
Game.level-complete     → level.stop(); level = null; show intermission
                          overlay; on dismiss: level = new Level(nextMap, ...);
                          load + start
Game.match-ended (DM)   → level.stop(); level = null; show results overlay
Game.RESULTS → LOBBY    → no level teardown (already null since match-end);
                          reset roster ready flags; show lobby overlay
```

No reverse method calls. No `level.askGameForX()`. Levels emit; Games
emit; Apps subscribe.

---

## 10. Player roster — how Lobby fills the Game

This is the answer to "how are users added to the game from the lobby."

The roster lives on the Game throughout LOBBY:

```js
// game.roster is the same array as state.players
[
    { slot: 0, kind: 'local', deviceId: 'kbm-A',  ready: true,  player: Player(0) },
    { slot: 1, kind: 'local', deviceId: 'gpad-1', ready: false, player: Player(1) },
    { slot: 2, kind: 'remote', peerKey: 'p-abc',  ready: true,  player: Player(2) },
    { slot: 3, kind: 'empty', ... no player },
]
```

The Player object is constructed when the slot is claimed (not at
match start) so it can be referenced immediately for the lobby UI's
sprite color, etc. `state.players[slot]` equals `roster[slot].player`.

**SP:** Game constructor immediately claims slot 0 as the host; the
roster is finalized after construction; LOBBY transitions straight to
LOADING → PLAYING. Lobby UI never shows.

**Local DM:** Game enters LOBBY. Lobby UI shows press-to-claim prompts
in panes 0 + 1. Input → App routes to Game.claimSlot(...). When both
slots are ready, Game auto-fires `beginPlay()`.

**Network DM kiosk:** Game enters LOBBY, opens signaling room (since
networkMode='host'). Local slots 0+1 are press-to-claim; slots 2+3 are
remote-only. A remote's LOOKING → Game.claimSlot(slot, peerKey)
(orchestrator.bindRemoteSlot happens here as a side effect). Host fires
`beginPlay()` manually when ≥ 2 slots are filled.

**Network DM non-kiosk:** Game enters LOBBY, slot 0 auto-claimed by
host (auto-routes all local devices); slots 1/2/3 remote-only.

**Client window:** Game enters LOBBY in receive-only mode. App
constructs the Game with networkMode='client'; Game opens transport,
sends LOOKING, waits for master's `start` envelope (carries the
finalized roster + map). On receipt, Game.LOBBY → LOADING → PLAYING.

**Roster freeze and Level construction:** When LOBBY → LOADING fires:
1. Game freezes the roster (rejects further claims).
2. Game broadcasts to remotes (host only) the `start` envelope with
   the full roster + map + rules.
3. Game constructs Level with the roster + map + rules.
4. Game awaits `level.load()`.
5. (Host) Game waits for `ready-to-play` from every connected client.
6. Game broadcasts `play`.
7. Game calls `level.start()`. Transition LOADING → PLAYING.

The Level receives a **live reference** to the roster, not a snapshot.
DM respawns / damage / etc. happen on the live Player objects. Game
observes via `player-died` events.

---

## 11. Mode config — what each layer receives

App holds the configuration choices:
- gameMode: 'singleplayer' | 'deathmatch' (set by menu)
- networkMode: 'standalone' | 'host' | 'client' (set by menu / URL)
- skillLevel: 1..5
- startMap: 'E1M1'
- rules: { fragLimit, timeLimit } (DM only)

App passes the full config to `new Game(modeConfig)`.

Game holds: gameMode, networkMode, skillLevel, rules.

Game passes a Level-relevant subset to `new Level({ map, players, rules, orchestrator })`:
- `map` — the specific map to load (changes per Level).
- `players` — the live roster (Game's `state.players`).
- `rules` — needed by spawn / respawn / scoring code in updateGame.
- `orchestrator` — the renderer command sink.

Level does **not** receive networkMode. Level is transport-agnostic;
the orchestrator + sinks handle the wire side.

---

## 12. Network coordination — the start sequence

Master has the full stack (App + Game + Level). Client is a wire
receiver — no Game, no Level (see §7b for the RemoteGame shape). Master's
Game pushes renderer commands through the orchestrator; sinks forward
to clients; clients apply via RenderClient → orchestrator → DomRenderer.

The one thing master needs to send the client outside the renderer
pipeline is the **map name** when a new map needs loading — the client
fetches its own `mapData` via the shared singleton and tells its
DomRenderer to build the scene. That's a single small envelope
(`MSG.LOAD_MAP { name }`). Everything else is renderer commands.

### Lobby phase

```
Master App boot → app.startGame({ gameMode:'dm', networkMode:'host', ... })
  → master.game = new Game(...)
  → master.game.start()
    → opens MasterConnection (signaling room)
    → master.game.LOBBY
  → master.game pushes showLobby({ slots, roomCode, ... }) via orchestrator
    → fans to master's local DomRenderers (master's panes show lobby)

Client App boot → app.startClientShell({ roomCode })
  → opens ClientConnection, sends LOOKING
  → client shows "connecting" overlay (App-side; no Game on client)

Master receives LOOKING
  → master.game.claimSlot(slot, peerKey)
    → orchestrator.bindRemoteSlot(slot, transport, peerKey)
    → roster updated
    → master.game pushes the new lobby state via orchestrator
    → fans to local DomRenderers AND to every sink
    → freshly-bound sink forwards over wire → client RenderClient
      dispatches → client orchestrator → client DomRenderer →
      client's pane shows the lobby overlay with current roster
  → master.game sends ACK to client (just acknowledges the LOOKING; the
    visual sync already happened via the renderer-command fan-out)
  → client sends READY (transport-level: my RenderClient is subscribed)
  → master Game marks peer ready
```

### Start of first level

```
Host fires start
  → master.game.beginPlay()
    → freeze roster
    → master.game.LOBBY → LOADING
    → master broadcasts MSG.LOAD_MAP { name } to all peers
      (clients use this to fetch + decorate mapData via shared singleton,
      then each client's DomRenderer.loadMap() rebuilds the static scene
      from the new mapData)
    → master.level = new Level({...})
    → await master.level.load()  // also rebuilds master's DomRenderer scenes
    → master Game pushes hideLobby() + Level's initial HUD/camera commands
    → fans to local DomRenderers + sinks

Each client receives MSG.LOAD_MAP
  → loadMapForRender(name) — fetch JSON, decorate mapData singleton
  → each client DomRenderer.loadMap() — build scene from new mapData
  → client sends 'ready-to-play' back

Master Game waits for 'ready-to-play' from every peer
  → master.level.start()
  → master.game.LOADING → PLAYING
  → master Game continues pushing per-frame renderer commands;
    sinks forward; clients see live PLAYING
```

State is identical on both sides because master's Game emitted the same
renderer commands to both local DomRenderers and clients via sinks.
The map's mapData is identical because both sides fetched the same
JSON.

### Match end

```
Any of:
  - Level emits 'level-complete' (a player crossed an exit; vanilla
    DOOM DM behavior — match ends via exit)
  - Game's match-clock tick detects time limit reached (kiosk DM only)
  - Game's player-died handler detects frag limit reached

  → master.level.stop()
  → master.level = null
  → master.game.PLAYING → RESULTS
  → master.game advances its mapCursor for the next match (per §4b)
  → master Game pushes showResults({ scores, killMatrix }) via
    orchestrator → fans to local DomRenderers + sinks → clients see
    scoreboard on blank background (no scene)
  → master.game.emit('match-ended', ...) for App-side observers
```

### Restart (RESULTS → LOBBY)

`master.level` is already `null` on entry to RESULTS (Match end did
the teardown when leaving PLAYING — see above). Restart does NOT
re-run stop/null:

```
Host fires restart
  → master.game.RESULTS → LOBBY
  → reset roster ready flags
  → master.game.mapCursor already advanced at Match end, so the next
    LOBBY's map is correct without any additional bookkeeping here
  → master Game pushes showLobby({ slots, roomCode, ... }) → fans to
    local DomRenderers + sinks → clients see lobby overlay reappear
```

Invariant: across the PLAYING → RESULTS → LOBBY chain, the Level
teardown happens exactly once, at the PLAYING → RESULTS edge.

Every transition that needs to be visible to clients goes through
renderer commands. The only non-renderer envelopes are
**transport-level handshake** (`LOOKING` / `ACK` / `READY` / `PING` /
`PONG` / `LEAVING`) and the **`LOAD_MAP` envelope** (since a fresh
map needs the JSON fetched on each side before the renderer scene
can be built).

### Level transition (SP only — DM is single-map)

```
Level emits 'level-complete' with stats
  → Master Game.level.stop()
  → Master Game.level = null
  → Master Game.PLAYING → INTERMISSION
  → Intermission UI shows stats on blank background

User fires (or auto-advance timer)
  → Master Game.INTERMISSION → LOADING
  → Master Game.level = new Level({ map: nextMap, ... })
  → await load() + start()
  → Master Game.LOADING → PLAYING

(SP has no client, so no wire coordination needed for level transition.)
```

---

## 13. Orchestrator's role — the two-channel hub

Orchestrator is a passive hub between Level (renderer commands +
inputs) and the render targets / device providers. Nothing calls into
Level — Level pulls inputs when it ticks and pushes commands when it
needs to draw.

```
DOWNSTREAM (Level → render):
  Level ──renderer commands──▶ Orchestrator ──▶ DomRenderers + RenderSinks
                                                     │
                                                     └──▶ wire to clients

UPSTREAM (devices → Level):
  Devices ──providers──▶ Orchestrator.inputs ──read──▶ Level
            (registered                  (Level polls
             at App boot)                 at tick top)
```

Orchestrator's responsibilities (same as today, post-renderer-refactor):
- Holds `this.targets[slot]` (DomRenderer or RenderSink per slot).
- Per-player command dispatch (matches `playerIndex`).
- World command dispatch (fans to every target).
- Sound broadcast (local + sinks).
- Remote-slot binding lifecycle (`bindRemoteSlot` / `unbindRemoteSlot`).
- Per-frame input collection (`collectInputs()`).

**Who calls `bindRemoteSlot` / `unbindRemoteSlot`?** Game does. Game
owns the roster and the transport, so Game owns the slot lifecycle.
App and Level never touch the orchestrator's slot API.

**Who calls `collectInputs()`?** Level does, every tick. Reads
`inputs[player.index]` per player.

**Who calls `playSound`?** Level for world sounds (weapon fire,
monsters), Game for UI-related world sounds (none today, but reserved),
App for menu beeps + UI feedback.

Orchestrator is constructed once at boot (by App, before any Game
exists) and passed down: App → Game → Level.

---

## 13b. Renderer lifecycle across mode switches

DomRenderers are owned by the App-level renderer registry (today
`renderer/dom.js`'s `domRenderers` array + `reshapeMasterRenderers`).
They persist across mode switches — the registry diffs current state
against the new mode's needs and only adds / removes / re-flags the
delta. The DOM, the cached element refs, the sceneState arrays,
event listeners — all survive the diff.

Reshape input is a small spec describing what the new mode needs:

```js
{
    renderers: [
        { slot: 0, playerIndex: 0 },
        { slot: 1, playerIndex: 0 },   // mirror SP example
    ]
}
```

The reshape:
1. For each desired entry, find an existing renderer at that slot
   (if any) and update its `playerIndex` + pane `data-player`
   attribute in place.
2. Create renderers for slots that don't have one.
3. Destroy renderers whose slot is no longer in the spec (their
   `paneEl` is removed from the DOM; their orchestrator target slot
   becomes null).

Concrete examples of what changes:

```
SP                  → 1 renderer  (slot 0, playerIndex 0)
Local DM            → 2 renderers (slots 0+1, playerIndex 0+1)
Mirror SP (kiosk)   → 2 renderers (slots 0+1, both playerIndex 0)
Network DM, kiosk   → 2 local renderers (+ sinks at slots 2..3 as
                      remotes bind)
Network DM, non-k   → 1 local renderer  (+ sinks at slots 1..3 as
                      remotes bind)
```

Diffs (delta only):

```
SP             → Local DM         : +1 renderer
Local DM       → SP               : -1 renderer
SP             → Mirror SP        : +1 renderer (new at slot 1, pIdx 0)
Mirror SP      → SP               : -1 renderer
Local DM       → Mirror SP        : 0 net (slot 1's playerIndex flips
                                          1 → 0 in place)
Mirror SP      → Local DM         : 0 net (slot 1's playerIndex flips
                                          0 → 1 in place)
SP             → Network DM kiosk : +1 renderer
SP             → Network DM non-k : 0 net
Local DM       → Network DM kiosk : 0 net (already 2)
Local DM       → Network DM non-k : -1 renderer (slot 1 gets reserved
                                                 for a sink later)
```

**Who calls reshape:**

- **Master (App holds a Game)**: App reshapes BEFORE constructing a
  new Game, using `modeConfig` to compute the spec. `Game.start()`
  then assumes the renderers are already in place; Game.beginPlay
  triggers Level.load which builds scenes into them.

- **Client (App holds a RemoteGame)**: RemoteGame triggers reshape
  AFTER receiving its slot in the ACK envelope — the spec is
  `[{ slot: assignedSlot, playerIndex: assignedSlot }]`. Before
  ACK arrives, the client window has zero DomRenderers (just App's
  chrome and RemoteGame's transport-state overlays). When the slot
  is known, one renderer is constructed at exactly that slot.

- **Attract**: App reshapes to `[{ slot: 0, playerIndex: 0 },
  { slot: 1, playerIndex: 0 }]` on kiosk-attract entry (same mirror
  shape as kiosk SP). Non-kiosk doesn't have attract, so no reshape
  needed there.

**Scene reuse on IN_GAME → ATTRACT.** When the kiosk idle-timeout
fires during an active Game, the visual scene in each DomRenderer is
preserved across the transition:

1. App captures the active player's pose (position + angle) from
   `state.players[0]` BEFORE tearing down the Game.
2. App calls `game.stop()` — Level.unload(); `state.things`, door
   state, roster, etc. all clear.
3. App pushes `hideHud` / `hideWeapon` / `hidePlayerBillboards`
   renderer commands.
4. App seeds the attract camera object with the captured pose (not
   the map's playerStart — continuity from where the user was) and
   starts the rotation RAF.

The DomRenderer scenes (walls, things, lights, world DOM) survive
because Level teardown only clears `state.*`, not the renderer's
internal scene DOM. First attract frame's camera matches the last
gameplay frame → no visual jump; HUD fades, view begins to glide.

For cold attract (BOOT → ATTRACT) there's no prior scene — App loads
the default attract map fresh via §16.

This means renderer scenes have a slightly longer lifecycle than
Level: scenes persist across `Level.unload` only when the next App
state is ATTRACT. Everywhere else (IN_GAME → MENU, Game cycling
maps, mode-class switches), `Level.unload` is followed by scene
rebuild on the next `Level.load`. Do not add a "clear scene on level
unload" call anywhere — it would break this.

**RenderSinks are not in the spec.** Sinks are managed separately by
the orchestrator's `bindRemoteSlot` / `unbindRemoteSlot` lifecycle
(driven by Game's transport hooks when remotes join / leave). The
reshape spec covers DomRenderers only — the local panes master is
responsible for painting itself.

---

## 14. Renderer commands

Renderer commands are the single channel for any visual that needs to
appear in a pane — on master AND on every connected client. The
orchestrator's fan-out (world commands → all DomRenderers + all sinks
→ wire → client's RenderClient → client's orchestrator → client's
DomRenderer) is the only way visuals reach clients. Anything that
bypasses it is invisible to clients.

**Both Game and Level push renderer commands.** They use the same
orchestrator. Neither knows the other exists.

- **Level pushes scene + HUD commands** every frame and per-event:
  `updateCamera`, `updateHud`, `createPuff`, `setEnemyState`, etc.
- **Game pushes UI-overlay commands** on its state transitions —
  each overlay has a show / update / hide pair, all independent of
  whether a scene is rendered behind it:
  - `showLobby({ slots, roomCode, ... })` / `updateLobbyState({ ... })`
    / `hideLobby()`
  - `showIntermission({ stats })` / `hideIntermission()`
  - `showResults({ scores, killMatrix })` / `hideResults()`
  - `showPaused()` / `hidePaused()` — host-broadcast pause
  Overlays stack on top of whatever the scene is currently rendering
  (the scene may be a fully-loaded Level, or it may be empty — Network
  DM lobby has an empty scene with only the lobby overlay; Local DM
  lobby has a paused scene with the lobby overlay on top). The exact
  command names are decided when Game is implemented; the rule is
  Game pushes through the orchestrator and never touches DOM directly.

  Note: the paused-state command is host-broadcast only. A
  RemoteGame's local `pause()` (App menu opens on a client window)
  is purely a local input-forwarder gate — it does NOT push a
  paused-state command, because the master is still simulating and
  other clients aren't paused. See §6 + §7b for the asymmetry.

The DomRenderer owns **every visible thing in its pane** — the 3D
scene, the HUD, AND the lobby / intermission / results overlays. The
existing pane template already has the overlay DOM (`.pane-lobby`,
`.pane-network-lobby`, `.pane-intermission`, `.pane-win`, etc.) inside
each pane; the impls that toggle them just need to live as DomRenderer
methods called by the new renderer commands instead of as standalone
helpers in `ui/lobby.js` / `ui/network-lobby.js` / `ui/scoreboard.js`.

Today's `ui/lobby.js` / `ui/network-lobby.js` / `ui/scoreboard.js` /
`ui/intermission.js` shrink dramatically: their DOM-toggle code becomes
DomRenderer impl helpers (per-pane functions called by the new
renderer commands); their state-management code moves into Game (Game
owns *when* to show / hide / update); the wire envelopes they invented
(`LOBBY_STATE`, `MATCH_END`, `GAME_STATE`) are deleted, replaced by
ordinary `CMD_WORLD` envelopes for the new renderer commands.

App-only overlays (menu, attract, debug, loading splash) are the only
visuals that do NOT go through the orchestrator. They are master-only
window chrome with no client equivalent — pure App-managed CSS
overlays on the master window's body, outside any pane. Nothing about
them needs to reach a client.

The **attract camera rotation** (§16) is the single layer-violation:
App writes `state.players[0].angle` and the rendered camera follows.
Acceptable because attract is fundamentally fake animation, and
attract is master-only so no wire concern.

---

## 15. Input routing

Devices register input providers with the orchestrator at App boot.
Lifetime = page (provider registration outlives Games).

Per-frame: Level calls `orchestrator.collectInputs()`. Inputs land in
`inputs[slot]`. Level reads.

Action events (`FIRE_DOWN`, `USE`, `MENU_TOGGLE`, etc.) flow on the
event bus. Handlers in `actions/*.js` subscribe and gate based on
**App state and Game state combined**. Full per-state table — every
Game state has explicit behavior for every relevant action, so there
are no gaps the user can fall into:

```
                      | MENU_TOGGLE | FIRE_DOWN / USE / weapon
─────────────────────────────────────────────────────────────────
App.MENU              | toggles     | dropped
App.ATTRACT           | wake → MENU | wake → IN_GAME (start Game)
Game.LOBBY            | allowed     | claim-slot / beginPlay
Game.LOADING          | allowed     | dropped (see below)
Game.PLAYING          | allowed     | passes through to Level
Game.INTERMISSION     | allowed     | Game advances to next level (SP)
Game.RESULTS          | allowed     | Game restarts match (→ LOBBY)
Game.ENDED            | dropped     | dropped (terminal, tear-down imminent)
```

`MENU_TOGGLE` is allowed in every non-terminal Game state because the
menu is a pure overlay (§3c) — opening it during LOADING just stacks
the menu on top of the loading splash; closing it returns to LOADING
unchanged. `Game.pause()` during LOADING is a no-op on the Level
(there's no Level tick to pause yet), but the paused-state renderer
command still fans to local DomRenderers + sinks so the loading
splash visibly tints "paused" and any clients in LOADING see the
host opened a menu.

**`LOADING` input policy — explicit:**
- All gameplay actions (FIRE_DOWN / USE / weapon select / movement /
  turn) are **dropped**, not queued. A press during LOADING vanishes;
  the user must press again after LOADING resolves.
- Queuing was considered and rejected: it leaks transient input
  state across a state transition, invites surprise auto-fires the
  moment PLAYING starts, and conflates "user wants to do X now"
  with "user wanted to do X seconds ago." Drop is simpler and
  matches vanilla DOOM behavior on loading screens.
- **Load cancellation is not supported** (Q8). FIRE_DOWN during
  LOADING does NOT abort the load — it just gets dropped.
- `MENU_TOGGLE` is the one exception (handled above).

`actions/gates.js` becomes the single place that interprets input
events against the layered state. Gate reads `app.state` and
`app.game?.state` to decide. Any state not listed above (future
additions) **must** be added to the table explicitly — silent
fall-through is a bug, not a default.

---

## 16. Attract mode

App.ATTRACT is render-only camera idle. Kiosk only. ATTRACT is
**reached only via IN_GAME idle timeout** — the warm path. Kiosk
boots into a Game (LOBBY), not into ATTRACT (see §3 + Q12).

Cold attract (BOOT → ATTRACT) is documented below for completeness
but is **not part of the current boot flow** — kept in the spec so
the path remains available if we later add an explicit "boot to
screensaver" option. With the current kiosk default of Local DM,
the boot-into-LOBBY path also dodges the cold-attract scene
inconsistency noted in §13b: Local DM LOBBY loads the Level
immediately, so the renderer scene is populated from the first
frame. **When the kiosk default switches to Network DM, that
lobby has no loaded Level → bare scene returns; revisit then.**

What attract owns:
- The orchestrator + DomRenderers App already constructed at boot
  (kiosk has 2; both DomRenderers share `playerIndex = 0` so the
  orchestrator's per-player dispatch fans every command to both —
  same mirror configuration kiosk SP uses).
- A camera state object owned by App: `{ x, y, z, angle, floorHeight }`.
  Plain object, not a Player. Lives on App.
- A RAF loop App owns that ticks `camera.angle` each frame and pushes
  `orchestrator.updateCamera(0, camera)` — a normal per-player renderer
  command. The orchestrator fans to every target with
  `playerIndex === 0`, which is both DomRenderers in mirror config.
  Same code path the in-game updateCamera uses; attract just supplies
  a synthetic camera object instead of a Player.

What attract does NOT own:
- No Game.
- No Level.
- No `state.players`. The Game's roster doesn't exist during attract;
  the camera object is App-local.
- No `state.things` / `state.doorState` / etc. The Level's state
  doesn't exist either.

Setup at ATTRACT entry — two paths:

**Cold attract (BOOT → ATTRACT):**
1. Load `mapData` via the shared singleton (fetch JSON).
2. Call `decorateMapData(mapData)` — fills `thingRenderSpecs`,
   `door.trackWalls`, etc. Pure decoration, no `state.*` writes.
3. For each DomRenderer: `domRenderer.loadMap()` builds the scene
   from decorated `mapData`.
4. Initialize the camera object at `mapData.playerStart` (or a
   scripted attract camera path).
5. Start the rotation RAF.

**Warm attract (IN_GAME → ATTRACT, kiosk idle-timeout):**
1. Capture the active player's pose from `state.players[0]` BEFORE
   tearing down the Game.
2. `app.endGame()` — `game.stop()` → `level.unload()`. `state.*`
   clears but the DomRenderer scenes persist (see §13b).
3. Push `hideHud` / `hideWeapon` / `hidePlayerBillboards` renderer
   commands.
4. Seed the attract camera object with the captured pose (NOT the
   map's playerStart — we want continuity from where the user was).
5. Start the rotation RAF.

First warm-attract frame's camera matches the last gameplay frame
→ seamless visual transition; HUD fades, view begins to glide.

Wake from attract — uniform path: pressing any gameplay input
(fire/use/weapon) signals "I want to play" and triggers a Game
start. Pressing the menu button instead signals "I want to fiddle
with settings first" but ultimately still leads to a Game start
(via §3c). Attract never returns to itself from a wake.

- **ATTRACT → IN_GAME** (fire/use; also kiosk DM auto-start when
  claims complete): App stops the rotation RAF, calls
  `app.startLocalGame(lastModeConfig)`. The new Game enters LOBBY
  (resolves per mode per §3b). DomRenderers are reused; the Level
  rebuilds scenes via `domRenderer.loadMap()` (Option A — no
  same-map scene-reuse optimization, see §13b).

- **ATTRACT → MENU** (menu button): App stops the rotation RAF,
  opens the menu. DomRenderers retain their scenes (the user sees
  the menu over the still scene). App records previousState='ATTRACT';
  menu close resolves per §3c (falls through to IN_GAME with
  `lastModeConfig`, not back to ATTRACT).

**Menu button during attract is NOT inert.** Earlier this section
considered making the menu button ignored during attract (to prevent
attendees from opening settings). The decision is the opposite:
menu button DOES wake attract, but only into MENU; the menu close
path (§3c) guarantees attendees still end up playing a Game rather
than being trapped back in the demo reel.

**DomRenderers persist across attract transitions.** Entering / leaving
attract on kiosk is always at the 2-renderer count, so reshape is a
no-op — only what's *inside* the renderers changes (`loadMap` rebuilds
the scene). The reshape only fires at mode-class boundaries (SP ↔ DM,
kiosk vs non-kiosk), not attract boundaries. See §13b.

**No layer-violation.** App talks only to its DomRenderers + the
shared `mapData` singleton + the orchestrator's `updateCamera`
command. It doesn't reach into a Level (because there isn't one)
or into a Game (because there isn't one).

This requires a small split of today's init code:
- `decorateMapData(mapData)` — pure side-effect on `mapData` only.
  Fills `thingRenderSpecs`, `door.trackWalls`. Called by attract,
  Level, and client (RemoteGame on LOAD_MAP).
- `initLevelState(mapData, state, roster)` — fills `state.things`,
  `state.doorState`, etc. Called only by Level on master.

---

## 17. Mid-match join — out of scope

Locked: neither Game nor Level supports adding players once the roster
is frozen. The roster is frozen across **every Game state except
LOBBY** (frozen at LOBBY → LOADING per §10; unfrozen at RESULTS → LOBBY
or whenever a fresh Game's constructor enters LOBBY).

LOOKING handling per Game state:

```
Game.LOBBY        : accept (existing claim flow — §10)
Game.LOADING      : reject with REJECT_REASON.MATCH_IN_PROGRESS
Game.PLAYING      : reject with REJECT_REASON.MATCH_IN_PROGRESS
Game.INTERMISSION : reject with REJECT_REASON.MATCH_IN_PROGRESS
Game.RESULTS      : reject with REJECT_REASON.MATCH_IN_PROGRESS
                    (client may retry; if RESULTS → LOBBY happens
                     before the retry, the retry lands in LOBBY and
                     is accepted normally — no server-side queueing)
Game.ENDED        : reject with REJECT_REASON.MATCH_OVER (host is
                    tearing down — the room is going away)
```

The reject envelope is the same shape regardless of which non-LOBBY
state the LOOKING hit. Clients show a generic "match in progress —
please retry" UI; they don't need to know the master's internal Game
state.

**No server-side queueing of late LOOKINGs.** A client that arrives
during RESULTS doesn't get a "wait, lobby is reopening" hold —
they're rejected like every other non-LOBBY state. The retry is on
them. This keeps master-side state simple: roster only mutates in
LOBBY, period.

Phase 9 (Cloudflare TURN + spectator) revisits late-join with
state-snapshot replay; until then, the rule is "join in LOBBY or
don't join."

---

## 18. Migration phases

Each phase ends with a working build and a smoke test:
- SP boots and is playable.
- Local DM lobby + match.
- Kiosk SP (mirror).
- Network DM host + client (basic connect, play, results).

### Phase L1 — Level class
- Create `src/game/level.js` with class `Level` implementing §8's API.
- Wraps today's `gameLoop`'s `updateGame` + `renderAllActivePanes` + RAF.
- Owns `mapData`, `state.things`, `state.doorState`, `state.liftState`,
  `state.crusherState`, `state.projectiles`. (These move OFF the
  module-level singleton conceptually — though for migration the
  singleton stays and Level just owns the lifecycle.)
- master.js still constructs the simulation directly. The functions
  `loadMap`, `gameLoop`, `addPlayerThing` etc. are reworked to delegate
  to a Level instance held in a global module for now.
- Smoke test: SP, Local DM, kiosk SP, Network DM all behave as today.

### Phase L2 — Game class
- Create `src/game/game.js` with class `Game` implementing §7's API.
- Game owns the roster (`state.players` access) + match struct + the
  current Level.
- Game receives modeConfig at construction.
- master.js constructs a Game at boot; Game constructs Levels.
- Move lobby UI ownership into Game (today's `ui/lobby.js` +
  `ui/network-lobby.js` become Game-driven; their event handlers call
  `game.claimSlot` / `game.beginPlay`).
- Move intermission UI ownership into Game.
- Move results / scoreboard UI ownership into Game.
- Move network handshake (MasterConnection setup + onJoin / onReady /
  onLeave) into Game.
- Smoke test: same.

### Phase L3 — App class
- Create `src/app.js` with class `App` implementing §6's API.
- App owns menu + attract + fullscreen + debug.
- master.js shrinks to `new App().start()` plus URL parsing.
- App state machine lights up; body class derived from it.
- The old `gameState` machine (`game/game-state.js`) is deleted —
  replaced by App state + Game state + Level state.
- Smoke test: same.

### Phase L4 — Event-driven transitions
- Level emits `level-complete` / `player-died` /
  `player-spawned`. Game subscribes; transitions accordingly.
- Game emits `match-ended` / `game-ended` / `lobby-updated` /
  `roster-updated`. App subscribes; transitions accordingly.
- Window-event channels (`cssdoom:level-changing`,
  `cssdoom:level-loaded`, `cssdoom:match-reset`) are deleted —
  explicit method calls + events now.
- Smoke test: SP level transitions, DM match end + restart.

### Phase L5 — Pause / resume semantics
- App.MENU pauses Game (Game.pause → Level.pause).
- App's attract uses a separate Level instance, no Game.
- INTERMISSION / RESULTS stop the Level (Level is done; not coming back
  in the same form). MENU is the only state that pauses — user wants
  to resume the exact same Level on menu close.
- LOADING entry calls Level.stop() before Level.load() of next map.
- Verify: open menu mid-match, scene frozen but rendered, close menu
  resumes.
- Smoke test: menu open/close mid-game, intermission advance.

### Phase L6 — Network start coordination
- Master Game + client wire-shell coordinate per §12. Master's Game
  drives all visual transitions (lobby / playing / intermission /
  results) via renderer commands; sinks fan them to clients
  automatically. Clients render whatever the master sends.
- Only non-renderer envelopes left: transport handshake (LOOKING /
  ACK / READY / PING / PONG / LEAVING) and `LOAD_MAP { name }` so
  clients know which map JSON to fetch + decorate before the
  renderer scene can be rebuilt.
- `MSG.READY` (the transport handshake "my RenderClient is
  subscribed") stays.
- Old wire envelopes are deleted: `LOBBY_STATE`, `MATCH_END`,
  `GAME_STATE` — replaced by ordinary CMD_WORLD renderer commands.
- Drop the snapshot-style onJoin spawn that was a workaround for the
  un-coordinated start.
- Smoke test: Network DM client connect, lobby flow, host fires start,
  both sides PLAYING in sync, match ends, scoreboard both sides,
  restart back to lobby.

### Phase L7 — Cleanups
- Delete the `cssdoom:*` window events (already done in L4 ideally).
- Delete `game/game-state.js` (replaced by 3-machine model).
- Delete `setMasterConnection` / `setMatchEndBroadcaster` / etc.
  side-door setters — App / Game own the wiring directly.
- Audit `actions/gates.js` to read App + Game state only; no more
  ad-hoc `state.gameMode` checks.
- Audit `state.things` / `state.doorState` etc. — formalize ownership
  on Level (could move them to be properties of Level rather than
  global singletons, but keep the singleton for compat for now).

---

## 19. What this fixes / what it unblocks

**Fixes:**
- Game loop ticks in lobby / intermission / results → impossible
  (those are Game states with Level paused).
- Network state drift on late join → impossible (Level not loaded
  during LOBBY; load happens in lockstep at PLAYING entry).
- `state.mode === 'X'` checks → don't exist; gates read App + Game
  state.
- Body classes derived from 5 things → derived from 3 (App, Game,
  Level state — and Level state isn't exposed).
- Spawn-on-fire-vs-loadMap-on-fire bug → gone; Level handles in-match
  respawn, Game handles inter-level transition, App handles
  inter-Game transitions.
- "Where do I add a remote player?" → Game.claimSlot in LOBBY.

**Unblocks:**
- Spectator mode (App constructs a spectator Game with no player
  Players).
- Saved games (Game serialization is one layer; Level serialization
  is another).
- Replay (record + replay Level events + inputs; Game / App can be
  reconstructed from saved roster + mode).
- Pause-on-window-blur (App pauses Game).
- Future game modes — adding "coop" or "horde" is a new Game subclass
  / variant, no Level changes.

---

## 20. Open questions — locked answers

- **Q1. Game on the client.** Does the Game class exist on the client
  window? **No.** Client is wire receiver + DomRenderer + AudioRenderer
  + input forwarder. It has no Game, no Level, no `state.players`,
  no `state.things`, no `updateGame`. Per-frame state comes from wire
  commands that the orchestrator fans into the client's single
  DomRenderer. UI overlays (lobby / intermission / results) arrive
  the same way — they're renderer commands like any other. The client
  has a small UI overlay state machine (driven by the renderer
  commands it receives) for input gating and disconnect handling, and
  loads `mapData` via the shared `shared/maps.js` singleton when its
  DomRenderer needs to build a new scene (triggered by a wire envelope
  telling it which map to load). No game logic ever lives on the client.

- **Q2. RESULTS pauses vs stops the Level.** **Stops.** RESULTS means
  the match is over — the Level's job is done. Game stops the Level
  and drops the reference (`game.level = null`). Scoreboard overlay
  renders without a scene behind it. The pause primitive is only for
  transient interruptions where the user expects to resume the same
  Level (menu opens / closes during PLAYING). INTERMISSION also stops
  the Level for the same reason: a new Level is coming.

- **Q3. State machines on both sides.** Both windows have an **App**
  with the same state machine (BOOT / ATTRACT / MENU / IN_GAME). What
  App holds differs:
  - Master holds a **Game** (its own state machine: LOBBY / LOADING /
    PLAYING / INTERMISSION / RESULTS / ENDED) which holds a **Level**
    (its own state machine: unloaded / loaded-paused / loaded-running).
  - Client holds a **RemoteGame** with its own (much simpler) state
    machine (CONNECTING / CONNECTED / DISCONNECTED / FAILED) tracking
    only the wire transport. RemoteGame does NOT mirror master's
    Game state — it doesn't try to be LOBBY/PLAYING/etc. on its own.

  The client's "what's currently happening in the game" surfaces
  entirely as renderer commands applied to its DomRenderer:
  - When the client's DomRenderer is showing the lobby overlay
    (because master pushed `showLobby(...)`), it's in lobby visually.
  - When showing scoreboard, it's in results visually.
  - When showing only the scene + HUD, it's playing.
  - When showing the paused overlay, the host paused.

  Input gating on the client follows the same principle: action gates
  read which overlays are currently active on the client's DomRenderer
  (a derived flag the renderer commands set). The client doesn't
  duplicate master's Game state machine.

- **Q4. ATTRACT needs a Level loaded.** **No.** Attract only needs
  DomRenderers + a decorated `mapData` + an App-driven camera-rotation
  loop. No Level, no Game, no `state.players`. App calls
  `decorateMapData` against the shared singleton, then triggers each
  DomRenderer's `loadMap()` (which builds the scene from decorated
  `mapData`). App holds a plain camera object
  (`{ x, y, z, angle, floorHeight }`) and per-frame pushes
  `orchestrator.updateCamera(0, camera)` — the renderer command goes
  through the orchestrator's normal per-player fan-out (both
  DomRenderers have `playerIndex = 0` in mirror config, so both
  receive the camera update). ATTRACT → IN_GAME constructs a Game
  which builds its own Level (re-decorating mapData and additionally
  running `initLevelState`); attract's DomRenderers are reused without
  teardown.

- **Q5. Where does `currentMap` live?** **On Game.** Game tracks the
  current map for the active match. Level holds it too (immutable
  per Level). App's menu's "reload current" delegates to
  `app.game?.restartCurrentLevel()`.

- **Q6. MENU → LOADING transitions.** **No.** Going from the menu to
  a different map / mode means MENU → IN_GAME with a NEW Game (App
  tears down old, constructs new). LOADING is a Game-internal
  transition (LOBBY → LOADING → PLAYING).

- **Q7. Game subscribes to its own events for DM respawn.** **No.**
  In-match player input flows through `actions/gates.js`. The gate
  for FIRE_DOWN during PLAYING + dead player + DM rules calls
  `spawnPlayer(player)` directly on the Player object — Game observes
  the resulting state change via Level emitting `player-spawned`.

- **Q8. LOADING cancellation.** **Not supported.** LOADING is
  short-lived. Action gates reject input during LOADING.

- **Q9. Single SP game vs new-Game-per-level.** **One Game.** A SP
  playthrough is one Game that constructs multiple Levels as the
  player progresses. Score / weapons / ammo persist on the Player
  objects (Game's roster) across levels.

- **Q10. Roster lifecycle within a Game.** A roster is built during
  LOBBY (slot claims), frozen at LOBBY → LOADING. During PLAYING the
  roster identity is stable but Player fields mutate (position,
  health, score). RESULTS → LOBBY may reset some fields (`isDead`,
  score, etc.) but keeps the roster identity (same Player objects,
  same slot assignments).

- **Q11. Network host promotion / migration.** **Out of scope.** If
  the host drops, clients disconnect and need to re-host. Phase 9+.

- **Q12. Boot paths + ATTRACT in non-kiosk.** ATTRACT is **kiosk-only**,
  and it is **not** the kiosk boot destination — kiosk boots straight
  into a Game.

  **Kiosk boot:**
  → BOOT → IN_GAME with the kiosk default modeConfig (currently
  `{ gameMode: 'deathmatch', networkMode: 'standalone' }` — Local DM).
  Game enters LOBBY which constructs + loads the Level immediately
  (§3b), so the scene is populated from the first frame and the
  cold-attract scene-inconsistency in §13b is avoided. ATTRACT is
  only reached later, via an IN_GAME idle-timeout (warm path).
  *If the kiosk default later flips to Network DM, the LOBBY has no
  loaded Level → bare scene returns and we'll need to revisit
  (probably one of C/D from the §13b discussion).*

  **Non-kiosk boot resolves directly to a Game:**

  1. If a `?join=<room>` URL param is present → BOOT → IN_GAME with
     a RemoteGame (joining a remote master).
  2. Otherwise, App reads `sessionStorage.lastUsedMode` for the
     `{ gameMode, networkMode }` pair last started in this session:
     - 'singleplayer/standalone' → BOOT → IN_GAME, Game enters LOBBY
       which instant-passes-through to PLAYING (SP).
     - 'deathmatch/standalone'   → BOOT → IN_GAME, Game enters
       LOBBY with press-to-claim prompts (Local DM lobby).
     - 'deathmatch/host'         → BOOT → IN_GAME, Game enters
       LOBBY and opens the signaling room (Network DM lobby).
  3. If sessionStorage has no value (first load in this session) →
     BOOT → MENU. URL params (`?mode=…`) take precedence over
     sessionStorage when present.

  Every Game start writes the chosen `{ gameMode, networkMode }`
  back to `sessionStorage.lastUsedMode`. Session-scoped: closing the
  tab clears it; reloads within the same tab restore it (which is
  what makes dev iteration ergonomic). Kiosk does NOT write
  sessionStorage — reloads on kiosk always restart from defaults
  (a fresh attendee shouldn't inherit the previous one's choices).

- **Q13. ATTRACT wake — uniform LOBBY entry.** **Yes.** All wake
  paths land the user in a Game in LOBBY state (resolving per mode
  per §3b). Fire/use takes the direct path (`app.startLocalGame(lastModeConfig)`).
  Menu button takes the detour through MENU but still ends in a
  Game start: either the user picks a different mode (start with
  new config) or closes the menu (start with `lastModeConfig` —
  see §3c). Attract never returns to itself from a wake.

- **Q14. Menu close from attract.** **Goes to IN_GAME, not back to
  ATTRACT.** Opening the menu during attract is a signal the user
  wants to interact; sending them back to the demo reel after they
  close the menu would be hostile. App tracks `previousState` when
  entering MENU; if it was ATTRACT, menu-close calls
  `app.startLocalGame(lastModeConfig)` rather than
  `app.transitionTo('ATTRACT')`. See §3c.

- **Q15. Scene reuse on IN_GAME → ATTRACT.** **Yes.** The DomRenderer's
  scene survives the IN_GAME → ATTRACT transition; the attract camera
  is seeded from the player's last in-game pose so there's no visual
  jump. Cold attract (BOOT → ATTRACT) still loads a fresh map. The
  reverse (attract → game) does NOT reuse the attract scene — Option
  A locked, scene rebuild on Level.load. See §13b and §16.

---

## 21. Sequence diagrams

### SP single Game, two levels, die, fire-respawn

```
App.BOOT
  → app.startGame({ gameMode:'sp', networkMode:'standalone',
                    startMap:'E1M1', ... })
    → game = new Game(config)
    → game.start()
    → game.LOBBY (auto-finalizes 1-player roster)
    → game.beginPlay()
      → game.LOADING
      → level = new Level({ map:'E1M1', players, rules })
      → await level.load()
      → level.start()
      → game.PLAYING
  → app.IN_GAME

[player plays, reaches exit]
  → level emits 'level-complete' { stats }
  → level.stop()
  → level = null
  → game receives event, game.PLAYING → INTERMISSION
  → intermission UI shows on blank background

[user fires]
  → action gate: game.state === INTERMISSION → game.advanceToNextLevel()
    → game.INTERMISSION → LOADING
    → level = new Level({ map:'E1M2', players, rules })
    → await level.load() + level.start()
    → game.LOADING → PLAYING

[player dies in SP — there's only one player, so "all dead"]
  → level emits 'player-died'
  → game stays in PLAYING (this is NOT a state transition)
  → game shows "you died, press fire to respawn" overlay (renderer
    command, fans through orchestrator to local DomRenderer)
  → cooldown timer ticks

[user fires after cooldown]
  → action gate: game.state === PLAYING + player.isDead → game reloads
    current level
    → level.stop(); level = null
    → level = new Level({ map: game.currentMap, players (full reset),
      rules })
    → await load + start
    → still in game.PLAYING (no state transition)

[player completes the LAST level (E1M8)]
  → level emits 'level-complete' { stats, isLastLevel: true }
  → level.stop(); level = null
  → game.PLAYING → INTERMISSION (last intermission with final stats)
[user fires]
  → game.INTERMISSION → RESULTS (campaign-complete end screen)
[user fires]
  → game.RESULTS → ENDED → app tears down the Game → MENU
```

### Network DM lobby + start + match end + restart

```
Master App boots → app.startGame({ gameMode:'dm', networkMode:'host', ... })
  → master.game = new Game(...)
  → master.game.start()
    → opens MasterConnection (signaling room)
    → master.game.LOBBY
    → master.game pushes showLobby({ slots, roomCode, ... })
      → orchestrator fans to master's local DomRenderers
      → master's panes show lobby overlay

Client App boots (?join=CODE) → app.startClientShell({ roomCode })
  → opens ClientConnection
  → sends LOOKING
  → client shows local "connecting" overlay (App-side only)

[ master receives LOOKING ]
  → master.game.claimSlot(slot=2, peerKey='p-abc')
    → orchestrator.bindRemoteSlot(2, transport, 'p-abc')
    → roster updated
    → master.game pushes updateLobbyState({ slots, ... }) via orchestrator
      → fans to master's local DomRenderers AND to the new sink
      → sink forwards to client → client's RenderClient dispatches
        → client's orchestrator → client's DomRenderer shows the
          lobby overlay with the current roster
  → master.game sends ACK to client
  → client RenderClient subscribes → client sends READY
  → master.game marks peer ready

[ local kbm-A claims master slot 0; master fires start when ready ]
  → master.game.beginPlay()
    → freeze roster
    → master broadcasts LOAD_MAP { name: 'E1M1' } to all peers
    → master.game.LOBBY → LOADING
    → master.level = new Level(...)
    → await master.level.load()
      (this also fans DomRenderer.loadMap commands to sinks → clients
       rebuild their scenes from the JSON they just fetched)

[ client receives LOAD_MAP ]
  → loadMapForRender('E1M1') — fetch JSON, decorate mapData singleton
  → client's DomRenderer.loadMap() — build scene from mapData
  → client sends 'ready-to-play' back

[ master.game receives 'ready-to-play' from all peers ]
  → master.level.start()
  → master.game.LOADING → PLAYING
  → master.game pushes hideLobby() + Level's initial HUD/camera
    → fans to local DomRenderers + sinks → clients see PLAYING

[ play, frags accumulate, frag limit hit ]
  → master.level emits internal hit + score; master.game observes
  → master.game detects frag limit; master.level.stop(); level = null
  → master.game.PLAYING → RESULTS
  → master.game pushes showResults({ scores, killMatrix })
    → fans to local DomRenderers + sinks → clients show scoreboard
  → master.game.emit('match-ended', ...) for App-side observers

[ host fires restart ]
  → master.game.RESULTS → LOBBY
  → master.level.stop(); master.level = null
  → reset roster ready flags
  → master.game pushes showLobby({ slots, roomCode, ... }) + hideResults()
    → fans to local DomRenderers + sinks → clients see lobby return
```

The client never has a Game or Level. Its DOM state is entirely a
function of the renderer commands it has received. On a client window
the only sources of UI are: (1) App's chrome (menu, etc.), (2)
RemoteGame's local transport-state overlays (connecting / disconnected
/ failed), (3) DomRenderer overlays driven by show*/hide* renderer
commands from master. The client's input forwarder gates on its own
RemoteGame transport state — if not CONNECTED, it doesn't forward.
Beyond that, master-side gates decide what input means in each Game
state and the client's forwarder doesn't need to know.

---

## 22. Non-goals

- Game-state save/load (the architecture supports it; not built).
- Spectator (would be a no-player Game; Phase 9+).
- Mid-match join (Phase 9+).
- Server authority / cheat prevention (current model trusts the host).
- Renderer command batching / compression on the wire (orthogonal).
- Host migration on disconnect (Phase 9+).
- AI / weapon balance changes (none).

---

End of document. No code changes until every Open Question above has
an answer in this doc and the user has confirmed.
