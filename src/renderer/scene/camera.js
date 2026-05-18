/**
 * Camera Module — Updates the CSS 3D camera transform.
 *
 * CSS has no native "camera" concept. To simulate one, we apply an inverse
 * transform to the entire scene container (.scene). Instead of moving a camera
 * forward, we move the whole world backward. Instead of rotating the camera
 * right, we rotate the whole world left. This is the standard trick for
 * first-person 3D in CSS.
 *
 * The scene transform chain (defined in style.css) is:
 *
 *   1. translateZ(var(--perspective))
 *      CSS `perspective` places the viewer at z = +perspective relative to the
 *      element's plane (z = 0). This initial translateZ pushes the scene
 *      forward by exactly the perspective distance, effectively moving the
 *      scene's origin to the viewer's eye. Without this offset, the world
 *      would appear too far away, because the perspective vanishing point
 *      would be at the wrong depth.
 *
 *   2. rotateY(calc(var(--player-angle) * -1rad))
 *      Applies the inverse of the player's yaw rotation. The negation is key:
 *      when the player looks right (+angle), the world rotates left (-angle).
 *
 *   3. translate3d(-playerX, +playerZ, +playerY)
 *      Applies the inverse of the player's position. Negating X and using the
 *      DOOM-to-CSS coordinate mapping:
 *        - DOOM X (east/west)   → CSS X axis (negate for inverse)
 *        - DOOM Y (north/south) → CSS -Z axis (positive here because inverse)
 *        - DOOM Z (height)      → CSS -Y axis (positive here because CSS Y
 *          points down, but the state already stores the negated value)
 *
 * Per-renderer: each renderer owns a `.viewport` element. updateCamera writes
 * its `--player-x/y/z/floor/angle` custom properties so the scene transform
 * reads its own values via CSS variable inheritance.
 */

/**
 * Pushes the given player's position and viewing angle to CSS custom
 * properties on the renderer's viewport element. The CSS transform on
 * the pane's `.scene` reads these properties to compute the inverse
 * camera transform each frame.
 */
export function updateCamera(renderer, player) {
    // Per-renderer world-view state — the culler / scene warmup read
    // from here. AudioRenderer maintains its own state.camera in
    // parallel (driven by the orchestrator's updateCamera mirror).
    const cam = renderer.state.camera;
    cam.x = player.x;
    cam.y = player.y;
    cam.z = player.z;
    cam.angle = player.angle;
    cam.floorHeight = player.floorHeight ?? 0;
    cam.isFiring = player.isFiring ?? false;

    const viewportStyle = renderer.viewportEl.style;

    // Horizontal position along the east-west axis
    viewportStyle.setProperty('--player-x', player.x);

    // Horizontal position along the north-south axis
    viewportStyle.setProperty('--player-y', player.y);

    // Vertical position / height
    viewportStyle.setProperty('--player-z', player.z);

    // Floor height at player position
    viewportStyle.setProperty('--player-floor', player.floorHeight || 0);

    // Viewing angle in radians (0 = north, increasing clockwise)
    viewportStyle.setProperty('--player-angle', player.angle);

    // Toggle firing class on player marker for spectator mode visual feedback.
    // Spectator is single-player only (will be disabled in DM), so reading
    // player 0's firing flag here is correct. Each renderer has its own
    // marker (built into its own scene fragment), so query within it.
    const marker = renderer.sceneEl.querySelector('#player > .marker');
    if (marker) {
        marker.classList.toggle('firing', player.isFiring);
    }
}
