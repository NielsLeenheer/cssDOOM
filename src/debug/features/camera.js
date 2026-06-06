/**
 * debug.view.camera — a view-relative camera ORBIT for hand-scripted talk shots.
 *
 * Pure debug overlay: it never touches the renderer. offset() adds the
 * `debug-camera` class to <body> (which activates the override in
 * debug/camera.css) and sets the --cam-offset-* custom properties plus the
 * transition duration --cam-offset-t. The override re-states the scene
 * transform with a view-relative dolly AND a compensating re-aim, so the move
 * orbits the thing you were looking at rather than panning off it: x / y / z
 * shift the eye right / up / back of where the camera faces, while the view
 * yaws / pitches back toward a pivot --cam-pivot units ahead (move right ⇒ turn
 * left, move up ⇒ look down). The whole move eases from the previous offset
 * over t seconds (t = 0 = instant).
 *
 * Single-player talk tool: the props go on <body>, so every pane's .scene
 * inherits them. Exposed as debug.view.camera.* in console.js.
 */

/** Orbit the camera to (x right, y up, z back) world units, re-aiming at a
 *  point `pivot` units ahead so the target stays framed, easing from the
 *  current offset over t seconds (0 = instant). pivot is optional — omit to
 *  keep the current/default distance; larger = gentler re-aim. */
export function offset(x = 0, y = 0, z = 0, t = 0, pivot) {
    const s = document.body.style;
    document.body.classList.add('debug-camera');
    s.setProperty('--cam-offset-t', `${t}s`);
    s.setProperty('--cam-offset-x', x);
    s.setProperty('--cam-offset-y', y);
    s.setProperty('--cam-offset-z', z);
    if (pivot != null) s.setProperty('--cam-pivot', pivot);
}

/** Ease the orbit back to the player's eye over t seconds (0 = instant). */
export function reset(t = 0) {
    offset(0, 0, 0, t);
}
