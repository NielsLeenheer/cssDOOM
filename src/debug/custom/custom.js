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
 * debug.sectors.explode(...), debug.layers.walls.hide() directly.
 */

// The talk path recordings (recordings.js) are a large data blob — the player's
// recorded walks for the CSS Day talk, not part of the regular debug toolkit.
// Load them on demand the first time a set piece needs one, so they form their
// own chunk and never weigh down the debug bootstrap. Memoised: the dynamic
// import is cached after the first call. A set piece grabs what it needs with
// `const { spectator } = await recordings();` at the top.
let _recordings = null;
const recordings = () => (_recordings ??= import('./recordings.js'));

const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));

export function registerCustom(debug) {
    const custom = (debug.custom ??= {});

    
    custom.one = async () => {
        const { one } = await recordings();
        debug.layers.chrome.hide();
        
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
        const { two, three, four } = await recordings();
        debug.layers.chrome.hide();

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
        debug.layers.sky.hide();
        debug.layers.hud.hide();
        debug.layers.enemies.hide();
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

        debug.layers.sky.show();

        /* Move up the stairs */
        let segment2 = debug.path.play(three, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: 1043, y: -3527, angle: 161 }, 
            end: { x: -17, y: -3128, angle: 121 } 
        });        
        
        await delay(5000);
        debug.layers.ceilings.hide();
        debug.camera.offset(0, 60, -100, 2, 100);

        await segment2;

        /* Fade out falls and ceilings and hide other sectors */
        debug.layers.walls.hide();
        debug.layers.sky.hide()
        debug.layers.things.hide()
        debug.sectors.only(29, 32);
        await delay(1000);

        /* Show floor grid on the current sector to reveal its structure */
        debug.sectors.showFloorGrid(29);
        debug.sectors.showFloorGrid(32);

        await delay(10000);

        /* Restore camera position */
        debug.camera.offset(0, 0, 0, 2, 100);

        /* Show enemies, things and hide the floor grid again. */
        debug.layers.enemies.show();
        debug.layers.things.show()
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
        const { three } = await recordings();
        debug.view.renderer('flat')

        debug.layers.chrome.hide();
        debug.layers.hud.hide();
        debug.layers.enemies.hide();

        debug.layers.sky.hide();
        debug.layers.things.hide()




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

        // debug.layers.sky.show();

        /* Move up the stairs */
        let segment2 = debug.path.play(three, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: 1043, y: -3527, angle: 210 }, 
            end: { x: -17, y: -3128, angle: 121 } 
        });        
        
        debug.layers.things.show()

        await delay(5000);
        debug.layers.ceilings.hide();
        debug.camera.offset(0, 60, -100, 2, 100);

        await segment2;

        /* Fade out falls and ceilings and hide other sectors */
        debug.layers.walls.hide();
        debug.layers.sky.hide()
        debug.layers.things.hide()
        debug.sectors.only(29, 32);
        await delay(1000);
    };

    custom.four = async () => {
        debug.view.renderer('lighting')

        debug.layers.chrome.hide();
        debug.layers.hud.hide();
        debug.layers.enemies.hide();

        debug.layers.sky.hide();
        debug.layers.things.hide()



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
        debug.view.renderer('lighting')

        debug.layers.chrome.hide();
        debug.layers.hud.hide();
        debug.layers.enemies.hide();

        debug.layers.sky.hide();
        debug.layers.things.hide()

        await debug.path.move({
            x: 39, y: -3113, angle: 246
        });

        await delay(2000);

        debug.sectors.highlight(42);
        await delay(500);
        debug.sectors.reset();

        debug.sectors.highlight(43);
        await delay(500);
        debug.sectors.reset();

        debug.sectors.highlight(25);
        await delay(500);
        debug.sectors.reset();

        debug.sectors.highlight(26);
        await delay(500);
        debug.sectors.reset();

        debug.sectors.highlight(27);
        await delay(500);
        debug.sectors.reset();

        debug.sectors.highlight(36);
        await delay(500);

        // debug.sectors.highlight(27);
        // await delay(500);

        debug.sectors.highlight(26);
        await delay(500);
        
        // debug.sectors.highlight(25);
        // await delay(500);

        debug.sectors.highlight(43);
        await delay(500);

        // debug.sectors.highlight(42);
        // await delay(500);

        // debug.sectors.reset();
    };


    custom.six = async () => {
        const { downthestairs } = await recordings();
        debug.view.renderer('cat')

        debug.layers.chrome.hide();
        debug.layers.hud.hide();
        debug.layers.enemies.hide();

        debug.layers.sky.hide();
        debug.layers.things.hide()

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
        const { spectator } = await recordings();
        debug.view.renderer('dom')
        debug.culling.all(false)

        debug.layers.chrome.hide();
        debug.layers.hud.hide();
        // debug.layers.enemies.hide();

        // debug.layers.sky.hide();
        // debug.layers.things.hide()

        await debug.path.move({
            x: 997, y: -3276, angle: 308
        });

        await delay(2000);

        debug.view.spectator(true);

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

    custom.sevenAltStart = async () => {
        const { spectatorStart } = await recordings();
        debug.view.renderer('dom')
        debug.culling.all(false)

        debug.layers.chrome.hide();
        debug.layers.hud.hide();
        // debug.layers.enemies.hide();

        // debug.layers.sky.hide();
        // debug.layers.things.hide()

        await debug.path.move({
            x: 997, y: -3276, angle: 308
        });

        await delay(2000);

        debug.view.spectator(true);

        await delay(2000);

        await debug.path.play(spectatorStart, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: 997, y: -3276, angle: 308 }, 
            end: { x: 1212, y: -3265, angle: 276 },
            moving: true 
        })

        // await debug.path.transition({
        //     duration: 1,
        //     direction: 'anti-clockwise',
        //     start: { x: 1212, y: -3265, angle: 276 }, 
        //     end:   { x: 1226, y: -3304, angle: 294 }
        // });


        // await debug.path.transition({
        //     duration: 1,
        //     direction: 'clockwise',
        //     start: { x: 1226, y: -3304, angle: 294 }, 
        //     end:   { x: 1244, y: -3168, angle: 218 }
        // });

        // await debug.path.transition({
        //     duration: 1,
        //     direction: 'anti-clockwise',
        //     start: { x: 1244, y: -3168, angle: 218 }, 
        //     end:   { x: 1212, y: -3265, angle: 276 }
        // });
    };

    custom.sevenAltWiggle = async () => {
        debug.view.renderer('dom')
        debug.culling.all(false)

        debug.layers.chrome.hide();
        debug.layers.hud.hide();
        // debug.layers.enemies.hide();

        // debug.layers.sky.hide();
        // debug.layers.things.hide()

        await debug.path.move({
            x: 1212, y: -3265, angle: 276
        });

        await delay(2000);

        debug.view.spectator(true);

        await delay(2000);

        /* */

        await debug.path.transition({
            duration: 0.6,
            direction: 'anti-clockwise',
            start: { x: 1212, y: -3265, angle: 276 }, 
            end:   { x: 1238, y: -3314, angle: 303 },
            moving: true 
        });


        await debug.path.transition({
            duration: 1,
            direction: 'clockwise',
            start: { x: 1238, y: -3314, angle: 303 }, 
            end:   { x: 1244, y: -3168, angle: 218 },
            moving: true 
        });

        await debug.path.transition({
            duration: 1,
            direction: 'anti-clockwise',
            start: { x: 1244, y: -3168, angle: 218 }, 
            end:   { x: 1238, y: -3314, angle: 303 },
            moving: true 
        });


        await debug.path.transition({
            duration: 1,
            direction: 'clockwise',
            start: { x: 1238, y: -3314, angle: 303 }, 
            end:   { x: 1244, y: -3168, angle: 218 },
            moving: true 
        });

        await debug.path.transition({
            duration: 1,
            direction: 'anti-clockwise',
            start: { x: 1244, y: -3168, angle: 218 }, 
            end:   { x: 1212, y: -3265, angle: 276 },
            moving: true 
        });
    };

    custom.sevenAltEnd = async () => {
        const { spectatorEnd } = await recordings();
        debug.view.renderer('dom')
        debug.culling.all(false)

        debug.layers.chrome.hide();
        debug.layers.hud.hide();
        // debug.layers.enemies.hide();

        // debug.layers.sky.hide();
        // debug.layers.things.hide()

        await debug.path.move({
            x: 1212, y: -3265, angle: 276
        });

        await delay(2000);

        debug.view.spectator(true);

        await delay(2000);

        await debug.path.play(spectatorEnd, { 
            trim: true, speed: 0.75, smooth: 7, 
            start: { x: 1212, y: -3265, angle: 276 }, 
            end:   { x: 1520, y: -2496, angle: 278 },
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
        const { door } = await recordings();
        debug.view.renderer('dom')
        debug.culling.all(false)

        debug.layers.chrome.hide();
        debug.layers.hud.hide();

        await debug.path.move({
            x: 1520, y: -2496, angle: 246
        });

        await delay(2000);

        debug.view.spectator(true);

        await delay(5000);

        await debug.path.play(door, { 
        })
    };

    custom.nine = async () => {
        debug.view.renderer('dom')
        debug.culling.all(false)

        debug.view.spectator(true);
        debug.layers.chrome.hide();
        debug.layers.hud.hide();

        await debug.path.move({
            x: 1520, y: -2496, angle: 246
        });

        await delay(3000);


        debug.view.spectator(false);

        await delay(2000);

        debug.sprites.showSheet()


        let fight = debug.path.play('fight', { 
            trim: true, 
            start: { x: 1520, y: -2496, angle: 246 }, 
        })
        
        await delay(1000);
        
        debug.layers.hud.show();

        await delay(28000);

        debug.game.noAttack(true);

        await fight;

        await delay(1000);

        let fight2 = debug.path.play('fight2', { 
            trim: true,
        })

        await delay(2000);

        await delay(1000);

        await delay(8000);

        debug.layers.sky.hide();

        let fight4 = debug.path.play('fight4', { 
            trim: true,
        })

        await delay(1500);

        debug.layers.hud.hide();

        await delay(2000);


        debug.layers.walls.hide();
        debug.layers.enemies.hide();
        debug.layers.corpses.hide();

        await delay(1000);

        debug.layers.ceilings.hide();

        await fight4;
        
    };

    

    custom.ten = async () => {
        debug.view.renderer('dom')
        debug.culling.all(false)

        debug.view.spectator(true);
        debug.layers.chrome.hide();
        debug.layers.hud.hide();

        await debug.path.move({
            x: 1520, y: -2496, angle: 246
        });

        await delay(3000);


        debug.view.spectator(false);

        await delay(2000);

        debug.sprites.showSheet()


        let fight = debug.path.play('alt-fight-3', { 
            trim: true, 
            start: { x: 1520, y: -2496, angle: 246 }, 
            end: { x: 2192, y: -2380, angle: 293 },
        })
        
        await delay(1000);
        
        // debug.layers.sky.hide();
        debug.layers.hud.show();

        await fight;

        debug.game.peaceful(true);

        await delay(1000);

        debug.layers.hud.hide();

        // debug.layers.walls.hide();
        // debug.layers.ceilings.hide();
        // debug.layers.floors.hide();
        // debug.layers.enemies.hide();

        await delay(2000);
    };

    custom.tenAlt = async () => {
        debug.view.renderer('dom')
        debug.culling.all(false)

        debug.view.spectator(true);
        debug.layers.chrome.hide();
        debug.layers.hud.hide();

        await debug.path.move({
            x: 1520, y: -2496, angle: 246
        });

        await delay(3000);


        debug.view.spectator(false);

        await delay(2000);

        debug.sprites.showSheet()


        let fight = debug.path.play('alt-fight-3', { 
            trim: true, 
            start: { x: 1520, y: -2496, angle: 246 }, 
            end: { x: 2172, y: -2388, angle: 293 },
        })
        
        await delay(1000);
        
        // debug.layers.sky.hide();
        debug.layers.hud.show();

        await fight;

        debug.game.peaceful(true);
        debug.layers.hud.hide();

        await delay(1000);

        // debug.layers.hud.hide();

        // debug.layers.walls.hide();
        // debug.layers.ceilings.hide();
        // debug.layers.floors.hide();
        // debug.layers.enemies.hide();

        await delay(2000);
    };


    custom.tenAltEnd = async () => {
        debug.view.renderer('dom')
        debug.culling.all(false)

        await debug.path.move({
            x: 2172, y: -2388, angle: 293
        });

        debug.sprites.hideSheet()
    };    


    custom.swing = async () => {
        await debug.path.transition({
            duration: 1,
            direction: 'anti-clockwise',
            start:  { x: 2192, y: -2380, angle: 293 },
            end:    { x: 2192, y: -2380, angle: 356 },
        });

        await debug.path.transition({
            duration: 2,
            direction: 'clockwise',
            start:  { x: 2192, y: -2380, angle: 356 },
            end:    { x: 2192, y: -2380, angle: 279 },
        });

        await debug.path.transition({
            duration: 2,
            direction: 'anti-clockwise',
            start:  { x: 2192, y: -2380, angle: 279 },
            end:    { x: 2192, y: -2380, angle: 356 },
        });

        await debug.path.transition({
            duration: 2,
            direction: 'clockwise',
            start:  { x: 2192, y: -2380, angle: 356 },
            end:    { x: 2192, y: -2380, angle: 279 },
        });

        await debug.path.transition({
            duration: 1,
            direction: 'anti-clockwise',
            start:  { x: 2192, y: -2380, angle: 279 },
            end:    { x: 2192, y: -2380, angle: 293 },
        });
    };

    custom.eleven = async () => {
        await debug.path.move({
            x: 2192, y: -2380, angle: 293
        });

        debug.layers.walls.show();
        debug.layers.ceilings.show();
        debug.layers.floors.show();
        debug.layers.enemies.show();

        debug.layers.hud.show();
        debug.sprites.hideSheet()

        await delay(1000);

        debug.layers.sky.show();

        debug.game.peaceful(false);
        debug.game.noDamage(true);

        let fight = debug.path.play('fireball-1', { 
            trim: true, 
            start: { x: 2192, y: -2380, angle: 293 }, 
            end: { x: 3020, y: -3066, angle: 218 },
        })
    };

    custom.elevenAlt = async () => {
        await debug.path.move({
            x: 2172, y: -2388, angle: 293
        });

        // debug.layers.walls.show();
        // debug.layers.ceilings.show();
        // debug.layers.floors.show();
        // debug.layers.enemies.show();

        debug.layers.hud.show();
        debug.sprites.hideSheet()

        await delay(1000);

        debug.layers.sky.show();

        debug.game.peaceful(false);
        debug.game.noDamage(true);

        let fight = debug.path.play('fireball-1', { 
            trim: true, 
            start: { x: 2172, y: -2388, angle: 293 }, 
            end: { x: 3020, y: -3066, angle: 218 },
        })
    };

    custom.twelve = async () => {
        await debug.path.move({
            x: 3020, y: -3066, angle: 218
        });
        

        let fight = debug.path.play('fireball-3', { 
            trim: true, 
            start: { x: 3020, y: -3066, angle: 218 }, 
            end: { x: 2996, y: -3752, angle: 348 },
        })

        await delay(3000);

        debug.layers.enemies.hide();
        debug.game.peaceful(true);
    };


    custom.thirteen = async () => {
        await debug.path.transition({
            duration: 2,
            direction: 'clockwise',
            start:  { x: 2996, y: -3752, angle: 348 },
            end:    { x: 2996, y: -3752, angle: 188 },
        });

        debug.layers.enemies.show();
        debug.game.peaceful(false);
    };
}
