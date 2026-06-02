/**
 * debug.custom — hand-authored talk scripts.
 *
 * The rest of the debug layer is building-block commands grouped by domain
 * (debug.path.*, debug.sectors.*, debug.layers.*, …). THIS file is the
 * scratchpad for the set pieces performed live during the CSS Day talk: each
 * function strings those commands together on a timeline — play a recorded
 * path, explode a sector, fade a layer, drop in a floor grid, and so on. Add
 * your own as custom.two, custom.three, …
 *
 * Wired by console.js via registerCustom(debug): it hands in the live `debug`
 * namespace, so a script just calls debug.path.play(...),
 * debug.sectors.explode(...), debug.layers.fadeOut(...) directly.
 */

import { one, two, three, four, downthestairs, spectator, door } from './recordings.js';

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function registerCustom(debug) {
    const custom = (debug.custom ??= {});

    
    custom.one = async () => {
        document.body.classList.add('hide-chrome');
        
        debug.game.noDamage(true);
        debug.game.noAttack(true);
        debug.game.noMove(true);

        /* Go to starting position and wait for a beat */
        await debug.path.seek(one, { segment: 0 });
        await delay(1000);

        /* Play the path to the first door */
        await debug.path.play(one, { trim: true, speed: 0.75, smooth: 7 });
    };
    
    custom.two = async () => {
        document.body.classList.add('hide-chrome');

        debug.game.noDamage(false);
        debug.game.noAttack(false);
        debug.game.noMove(false);

        /* Go to starting position and wait for a beat */
        await debug.path.seek(two, { segment: 0 });
        await delay(1000);

        /* Move towards the door */
        await debug.path.play(two, { 
            trim: true, speed: 0.75, smooth: 7, 
            end: { x: 1043, y: -3527, angle: 161 } 
        });

        /* Hide everthing except the door */
        debug.layers.fadeOut('sky');
        document.body.classList.add('hide-hud');
        document.body.classList.add('hide-enemies');
        await delay(1000);

        debug.sectors.only(40);
        await delay(1000);

        /* Explode the sector's walls */
        debug.sectors.explode(40);

        /* Delay to insert explanation in Keynote with looped light fx */
        await delay(10000);

        /* Re-assemble the sector */
        debug.sectors.implode(40);
        debug.sectors.show();
        await delay(1000);

        debug.layers.fadeIn('sky');

        /* Move up the stairs */
        let segment2 = debug.path.play(three, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: 1043, y: -3527, angle: 161 }, 
            end: { x: -17, y: -3128, angle: 121 } 
        });        
        
        await delay(5000);
        debug.layers.fadeOut('ceilings');
        debug.camera.offset(0, 60, -100, 2, 100);

        await segment2;

        /* Fade out falls and ceilings and hide other sectors */
        debug.layers.fadeOut('walls');
        debug.layers.fadeOut('sky')
        debug.layers.fadeOut('things')
        debug.sectors.only(29, 32);
        await delay(1000);

        /* Show floor grid on the current sector to reveal its structure */
        debug.sectors.showFloorGrid(29);
        debug.sectors.showFloorGrid(32);

        await delay(10000);

        /* Restore camera position */
        debug.camera.offset(0, 0, 0, 2, 100);

        /* Show enemies, things and hide the floor grid again. */
        document.body.classList.remove('hide-enemies');
        debug.layers.fadeIn('things')
        debug.sectors.hideFloorGrid(29);
        debug.sectors.hideFloorGrid(32);
        debug.sectors.show();
        
        await delay(1000);

        /* Show the sprite sheets for all things and enemies */
        debug.sprites.showSheet() 

        await debug.path.play(four, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: -17, y: -3128, angle: 121 } 
        });    
    };


    custom.three = async () => {
        debug.renderer('flat')

        document.body.classList.add('hide-chrome');
        document.body.classList.add('hide-hud');
        document.body.classList.add('hide-enemies');

        debug.layers.fadeOut('sky');
        debug.layers.fadeOut('things')




        /* Go to starting position and wait for a beat */
        await debug.path.seek(three, { 
            start: { x: 1043, y: -3527, angle: 210 }
        });

        await delay(1000);

        debug.sectors.only(40);
        debug.sectors.explode(40);

        // return;

        await delay(5000);

        /* Re-assemble the sector */
        debug.sectors.implode(40);
        debug.sectors.show();
        await delay(1000);

        // debug.layers.fadeIn('sky');

        /* Move up the stairs */
        let segment2 = debug.path.play(three, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: 1043, y: -3527, angle: 210 }, 
            end: { x: -17, y: -3128, angle: 121 } 
        });        
        
        debug.layers.fadeIn('things')

        await delay(5000);
        debug.layers.fadeOut('ceilings');
        debug.camera.offset(0, 60, -100, 2, 100);

        await segment2;

        /* Fade out falls and ceilings and hide other sectors */
        debug.layers.fadeOut('walls');
        debug.layers.fadeOut('sky')
        debug.layers.fadeOut('things')
        debug.sectors.only(29, 32);
        await delay(1000);
    };

    custom.four = async () => {
        debug.renderer('lighting')

        document.body.classList.add('hide-chrome');
        document.body.classList.add('hide-hud');
        document.body.classList.add('hide-enemies');

        debug.layers.fadeOut('sky');
        debug.layers.fadeOut('things')



        // x = 39
        // y = -3113
        // angle = 246

        debug.camera.offset(0, 60, -100, 2, 100);

        await debug.path.move({
            x: -17, y: -3128, angle: 121
        });

        await delay(5000);

        debug.camera.offset(0, 0, 0, 2, 100);

        await debug.path.transition({
            duration: 2,
            direction: 'anti-clockwise',
            start: { x: -17, y: -3128, angle: 121 },
            end:   { x: 39, y: -3113, angle: 246 },
        });
    };


    custom.five = async () => {
        debug.renderer('lighting')

        document.body.classList.add('hide-chrome');
        document.body.classList.add('hide-hud');
        document.body.classList.add('hide-enemies');

        debug.layers.fadeOut('sky');
        debug.layers.fadeOut('things')

        await debug.path.move({
            x: 39, y: -3113, angle: 246
        });

        await delay(2000);
    };


    custom.six = async () => {
        debug.renderer('cat')

        document.body.classList.add('hide-chrome');
        document.body.classList.add('hide-hud');
        document.body.classList.add('hide-enemies');

        debug.layers.fadeOut('sky');
        debug.layers.fadeOut('things')

        await debug.path.move({
            x: 39, y: -3113, angle: 246
        });

        await delay(2000);

        debug.path.play(downthestairs, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: 39, y: -3113, angle: 246 }, 
            end: { x: 997, y: -3276, angle: 308 } 
        })
    };


    custom.seven = async () => {
        debug.renderer('dom')
        debug.culling.all(false)

        document.body.classList.add('hide-chrome');
        document.body.classList.add('hide-hud');
        // document.body.classList.add('hide-enemies');

        // debug.layers.fadeOut('sky');
        // debug.layers.fadeOut('things')

        await debug.path.move({
            x: 997, y: -3276, angle: 308
        });

        await delay(2000);

        debug.spectator(true);

        await delay(2000);

        await debug.path.play(spectator, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: 997, y: -3276, angle: 308 }, 
            end: { x: 1520, y: -2496, angle: 278 },
            moving: true 
        })

        await debug.path.transition({
            duration: 1,
            direction: 'clockwise',
            start: { x: 1520, y: -2496, angle: 278 }, 
            end:   { x: 1520, y: -2496, angle: 246 }
        });

    };

    custom.eight = async () => {
        debug.renderer('dom')
        debug.culling.all(false)

        document.body.classList.add('hide-chrome');
        document.body.classList.add('hide-hud');

        await debug.path.move({
            x: 1520, y: -2496, angle: 246
        });

        await delay(2000);

        debug.spectator(true);

        await delay(5000);

        await debug.path.play(door, { 
        })
    };
}
