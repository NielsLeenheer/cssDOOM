/**
 * Renderer public API — the single entry point for the game layer.
 *
 * Every renderer function that the game layer needs is re-exported here.
 * Game code should never import from renderer sub-modules directly.
 */

// Camera
export { updateCamera } from './scene/camera.js';

// Effects
export { triggerFlash, showPowerup, flickerPowerup, hidePowerup } from './effects.js';

// Sprites & things
export {
    setEnemyState, resetEnemy, killEnemy,
    updateEnemyRotation, updateThingPosition, reparentThingToSector,
    collectItem,
    createPuff, createExplosion, createTeleportFog, createProjectile, removeProjectile,
} from './scene/entities/sprites.js';

// Player visuals
export { setPlayerDead, clearKeys, setPlayerMoving, collectKey } from './scene/entities/player.js';

// Weapon visuals
export { isWeaponSwitching, switchWeapon, startFiring, stopFiring } from './weapons.js';

// Doors
export { buildDoor, setDoorState } from './scene/mechanics/doors.js';

// Lifts
export { buildLift, setLiftState } from './scene/mechanics/lifts.js';

// Crushers
export { buildCrusher, setCrusherOffset } from './scene/mechanics/crushers.js';

// Switches
export { toggleSwitchState } from './scene/mechanics/switches.js';

// Surfaces
export { lowerTaggedFloor } from './scene/surfaces/floors.js';
