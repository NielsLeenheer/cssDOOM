/**
 * Console — the `window.debug` command surface.
 *
 * `window.debug` is a callable object: calling it opens the debug menu; every
 * command hangs off it in grouped sub-objects (debug.position.*, debug.sectors.*,
 * debug.path.*, …). This module is a thin PRESENTER — it imports each capability
 * from ../features/* and wires it onto a debug.* group; the menu (../ui) presents
 * the same features as checkboxes/buttons. Loaded for its side effects at boot
 * from master.js.
 */

import { currentMap } from '../../shared/maps/index.js';     // for debug.view.record()
import { swapLevel } from '../../game/level.js';
import * as recorder from '../features/recorder.js';
import * as pathModule from '../features/path.js';
import * as cameraModule from '../features/camera.js';
import * as spritesModule from '../features/sprites.js';
import * as sectorsModule from '../features/sectors.js';
import * as layersModule from '../features/layers.js';
import * as flags from '../features/flags.js';
import * as freeze from '../features/freeze.js';
import { position as positionCmds, world as worldCmds } from '../features/world.js';
import { openDebugMenu } from '../ui/panel.js';
import { switchRenderer } from '../features/renderer.js';
import { setSpectator } from '../features/spectator.js';
import * as loadout from '../features/loadout.js';

// ── Callable namespace ────────────────────────────────────────────────────
// Calling debug() opens the menu (the UI owns that — see ui/panel.js).
function debug() { openDebugMenu(); }
window.debug = debug;
/** Get (or lazily create) a command group on the debug namespace. */
function group(name) { return (debug[name] ??= {}); }

// ── debug.position / debug.world — placement + level inspection (see
// features/world.js). Teleport / save-load the player, dump player + nearby
// geometry / triggers / lifts.
Object.assign(group('position'), positionCmds);
Object.assign(group('world'), worldCmds);

// ── debug.sectors — dissect the level for the talk's "anatomy of a sector"
// animation (see features/sectors.js + features/sectors.css). Pure DOM toggles
// on the .sector#s{id} containers, spanning every pane.
Object.assign(group('sectors'), sectorsModule);

// ── debug.sprites — sprite-sheet stepped-animation viz (see sprites.css) ────
// Lay a half-transparent clone of the whole sheet over each sprite and translate
// it in lockstep with the real stepped animation, so the active cell stays put
// while the sheet slides — shows how the walk cycle indexes the sheet. Targets
// the sprites in a sector (id), or every sprite with no id.
//   debug.sprites.showSheet(29)  ·  debug.sprites.hideSheet(29)
const sprites = group('sprites');
sprites.showSheet = spritesModule.showSheet;
sprites.hideSheet = spritesModule.hideSheet;

// ── debug.layers — per-layer visibility, one object per layer (see
// features/layers.js + .css). Scene layers cross-fade; hud / chrome hide
// instantly; hud also isolates (fade the scene to grey, keep the HUD).
//   debug.layers.walls.hide()  ·  debug.layers.walls.show()
//   debug.layers.hud.hide()    ·  debug.layers.hud.isolate(true)
//   debug.layers.chrome.hide() — menu buttons / spectator overlay
Object.assign(group('layers'), layersModule.layers);

// ── debug.camera — view-relative orbit for talk shots (see camera.css) ──────
// Offset the eye AND re-aim to keep the target framed: x = right, y = up,
// z = back (world units, relative to where the camera faces); the view yaws/
// pitches back toward a pivot so move-right ⇒ turn-left, move-up ⇒ look-down.
// Eases from the previous offset over t seconds (t = 0 instant). 5th arg sets
// the pivot distance (gentler re-aim = larger). Debug-only; never touches the
// renderer.
//   debug.camera.offset(200, 120, 0, 2)   — orbit up/right over 2s, eyes on target
//   debug.camera.offset(0, 80, 300, 2, 800) — rise & pull back, far pivot
//   debug.camera.reset(1)                 — ease back to the eye over 1s
const camera = group('camera');
camera.offset = cameraModule.offset;
camera.reset = cameraModule.reset;

// ── debug.custom — hand-authored talk set pieces (see custom/custom.js) ──
// Scripts that string the debug.* commands together on a timeline. DEV-only:
// dynamically imported behind import.meta.env.DEV so the talk scratchpad — and
// the large recordings.js data it pulls — is dead-code-eliminated from the
// production build entirely. Registration is async (a microtask later); the
// commands are only ever invoked by hand, so that's fine.
if (import.meta.env.DEV) {
    import('../custom/custom.js').then(({ registerCustom }) => registerCustom(debug));
}

// ── debug.path — record / replay the player's path (position + angle) ──────
// Segment-based recording with a top-centre transport panel; replay moves the
// PLAYER along a path while the game loop runs, so the camera follows and the
// world reacts. The basis for hand-scripted talk shots — see features/path.js.
//   debug.path.record()                       — start a session (opens panel)
//   .mark() .pause() .resume() .rewind() .review() .stop()  — transport
//   .save('slot') / .load('slot')  — persist / read a session in localStorage
//   .export('slot'?) / .import('slot', json)  — dump a session as JSON for
//     safekeeping (last recorded, or a saved slot) and restore it later
//   .seek(pathOrSlot, opts)  — teleport to a segment's start frame
//   await debug.path.play(pathOrSlot, opts)  — replay it
//   opts: { speed, segment, trim, smooth, start, end } (seek shares trim/
//     smooth/start/end). trim: drop non-moving frames at the start/end.
//     smooth: box-blur window (frames). start/end: { x?, y?, angle° } to bend
//     the path so it begins/lands exactly there (angles in degrees).
const path = group('path');
path.record = pathModule.record;
path.mark = pathModule.mark;
path.pause = pathModule.pause;
path.resume = pathModule.resume;
path.rewind = pathModule.rewind;
path.review = pathModule.review;
path.stop = pathModule.stop;
path.save = pathModule.save;
path.load = pathModule.load;
path.export = pathModule.exportPath;
path.import = pathModule.importPath;
path.seek = pathModule.seek;
path.play = pathModule.play;
path.transition = pathModule.transition;
path.move = pathModule.move;

// ── debug.game — freeze-frame + cheat flags (see features/freeze.js + flags.js).
// pause() stops the world tick + all CSS animations (freeze a fireball mid-air);
// play() resumes both. noDamage / noAttack / noMove toggle cheats; peaceful()
// flips all three at once. (Render-command recording lives in debug.view.)
const game = group('game');
game.pause = freeze.pause;
game.play = freeze.resume;
game.noDamage = flags.noDamage;
game.noAttack = flags.noAttack;
game.noMove = flags.noMove;
game.peaceful = flags.peaceful;

// ── debug.culling — toggle the renderer's culling passes (see features/flags.js).
// No arg toggles; pass a boolean to set. all(false) disables every pass — handy
// to stop things popping at the screen edge during a talk shot.
const cull = group('culling');
cull.distance = flags.cullDistance;
cull.backface = flags.cullBackface;
cull.frustum = flags.cullFrustum;
cull.sky = flags.cullSky;
cull.all = flags.cullAll;

// ── debug.view — renderer + camera/view controls (see features/renderer.js,
// spectator.js, recorder.js).
//   renderer('flat')  — swap the SP renderer; tears down the pane, rebuilds with
//     the chosen renderer, reloads the map + catches up world state. SP only.
//     No arg logs the current renderer and the options.
//   spectator(true)   — toggle spectator mode (SP only, refused in DM; no arg toggles).
//   record() / save('slot')  — capture the renderer-command envelope stream from
//     a clean level (record() restarts the current level) and write it to storage;
//     replay via ?play=slot. Records the RENDERER's commands, not game state.
const view = group('view');
const RENDERERS = ['dom', 'flat', 'shade', 'lighting', 'line', 'cat'];
view.renderer = (kind) => {
    if (kind == null) {
        console.log(`renderer: ${document.body.dataset.renderer || RENDERERS[0]} — options: ${RENDERERS.join(', ')}`);
        return;
    }
    if (!RENDERERS.includes(kind)) { console.warn(`[debug] unknown renderer "${kind}" — try: ${RENDERERS.join(', ')}`); return; }
    return switchRenderer(kind);
};
view.spectator = setSpectator;
view.record = async () => {
    recorder.start();
    await swapLevel(currentMap);
};
view.save = (slot) => recorder.save(slot);

// ── debug.player — set the slot-0 player's vitals for talk shots (see
// features/loadout.js). Mutates the live player + flags the HUD dirty.
//   debug.player.health(100)      ·  debug.player.armor(200)
//   debug.player.armor(100, 1)    — green (1/3 absorb) instead of blue
//   debug.player.ammo('shells', 50)  ·  ammo(50) all pools  ·  ammo() fill to max
const player = group('player');
player.health = loadout.setHealth;
player.armor = loadout.setArmor;
player.ammo = loadout.setAmmo;
