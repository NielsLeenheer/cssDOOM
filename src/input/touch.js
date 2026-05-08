/**
 * Touch Input
 *
 * Mobile/tablet controls: virtual joystick for movement + strafing (left),
 * drag-to-turn (right), use button, fire by tapping the weapon sprite,
 * and weapon cycling by tapping the ARMS panel.
 *
 * Uses pointer events with touch-action: none for consistent multi-touch
 * handling. Only activates on touch-capable devices.
 *
 * Registers an input provider that supplies moveX, moveY, and turnDelta
 * to the unified input system.
 */

import { input } from './index.js';
import { state } from '../game/state.js';
import { currentMap } from '../shared/maps.js';
import { isMenuOpen } from '../ui/menu.js';
import { tryOpenDoor } from '../game/mechanics/doors.js';
import { tryUseSwitch } from '../game/mechanics/switches.js';
import { tryUseLift } from '../game/mechanics/lifts.js';
import { fireWeapon, equipWeapon, stopAutoFire } from '../game/entities/weapons.js';
import { loadMap } from '../shared/maps.js';
import { registerInputProvider } from './index.js';

const JOYSTICK_MAX_RADIUS = 50;
const JOYSTICK_DEADZONE = 0.15;
const TOUCH_TURN_SENSITIVITY = 0.012;

// Track active pointers by ID so multi-touch works (joystick + look + fire)
const activePointers = new Map();

// Module-local analog state (not exposed to the game layer directly)
let moveX = 0, moveY = 0, turnDelta = 0;

// DOM references (created in createTouchUI)
let joystickZone, joystickBase, joystickKnob;
let lookZone;
let fireOverlay, useButton;
let touchControls;

/**
 * Initialise touch input. Only creates UI and attaches handlers on
 * touch-capable devices.
 */
export function initTouchInput() {
    if (!('ontouchstart' in window) && navigator.maxTouchPoints === 0) return;

    // Touch is single-player only — always targets slot 0.
    registerInputProvider(() => 0, getInput);
    createTouchUI();
    setupPointerHandlers();
}

// ============================================================================
// Input Provider
// ============================================================================

function getInput() {
    const td = turnDelta;
    turnDelta = 0;
    return { moveX, moveY, turnDelta: td };
}

// ============================================================================
// DOM Creation
// ============================================================================

function createTouchUI() {
    touchControls = document.createElement('div');
    touchControls.id = 'touch-controls';

    // Left joystick zone (invisible hit area, left 40% of screen)
    joystickZone = document.createElement('div');
    joystickZone.id = 'touch-joystick-zone';
    touchControls.appendChild(joystickZone);

    // Joystick base + knob (always visible, nested inside the zone)
    joystickBase = document.createElement('div');
    joystickBase.id = 'touch-joystick-base';
    joystickKnob = document.createElement('div');
    joystickKnob.id = 'touch-joystick-knob';
    joystickBase.appendChild(joystickKnob);
    joystickZone.appendChild(joystickBase);

    // Right look zone (invisible hit area, right 60% of screen)
    lookZone = document.createElement('div');
    lookZone.id = 'touch-look-zone';
    touchControls.appendChild(lookZone);

    // Invisible fire overlay (covers the weapon area)
    fireOverlay = document.createElement('button');
    fireOverlay.id = 'touch-fire';
    touchControls.appendChild(fireOverlay);

    // Use button
    useButton = document.createElement('button');
    useButton.id = 'touch-use';
    touchControls.appendChild(useButton);

    document.body.appendChild(touchControls);
}

// ============================================================================
// Pointer Handlers
// ============================================================================

function setupPointerHandlers() {
    // --- Joystick ---
    joystickZone.addEventListener('pointerdown', e => {
        if (isMenuOpen()) return;
        if (handleDeadRestart()) return;

        e.preventDefault();
        joystickZone.setPointerCapture(e.pointerId);
        joystickKnob.style.transform = 'translate(0, 0)';

        activePointers.set(e.pointerId, { type: 'joystick' });
    });

    joystickZone.addEventListener('pointermove', e => {
        const ptr = activePointers.get(e.pointerId);
        if (!ptr || ptr.type !== 'joystick') return;

        // Compute delta relative to the joystick base center
        const rect = joystickBase.getBoundingClientRect();
        const centerX = rect.left + rect.width / 2;
        const centerY = rect.top + rect.height / 2;
        const dx = e.clientX - centerX;
        const dy = e.clientY - centerY;
        const dist = Math.sqrt(dx * dx + dy * dy);
        const clamped = Math.min(dist, JOYSTICK_MAX_RADIUS);
        const angle = Math.atan2(dy, dx);

        const clampedX = Math.cos(angle) * clamped;
        const clampedY = Math.sin(angle) * clamped;

        joystickKnob.style.transform = `translate(${clampedX}px, ${clampedY}px)`;

        const normX = clampedX / JOYSTICK_MAX_RADIUS;
        const normY = -clampedY / JOYSTICK_MAX_RADIUS; // invert Y (screen down = backward)

        moveY = Math.abs(normY) > JOYSTICK_DEADZONE ? normY : 0;
        moveX = Math.abs(normX) > JOYSTICK_DEADZONE ? normX : 0;
    });

    const releaseJoystick = e => {
        const ptr = activePointers.get(e.pointerId);
        if (!ptr || ptr.type !== 'joystick') return;

        activePointers.delete(e.pointerId);
        moveX = 0;
        moveY = 0;
        joystickKnob.style.transform = 'translate(0, 0)';
    };
    joystickZone.addEventListener('pointerup', releaseJoystick);
    joystickZone.addEventListener('pointercancel', releaseJoystick);

    // --- Look (drag-to-turn) ---
    lookZone.addEventListener('pointerdown', e => {
        if (isMenuOpen()) return;
        if (handleDeadRestart()) return;

        e.preventDefault();
        lookZone.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, {
            type: 'look',
            lastX: e.clientX,
        });
    });

    lookZone.addEventListener('pointermove', e => {
        const ptr = activePointers.get(e.pointerId);
        if (!ptr || ptr.type !== 'look') return;

        const deltaX = e.clientX - ptr.lastX;
        ptr.lastX = e.clientX;
        turnDelta -= deltaX * TOUCH_TURN_SENSITIVITY;
    });

    const releaseLook = e => {
        const ptr = activePointers.get(e.pointerId);
        if (!ptr || ptr.type !== 'look') return;
        activePointers.delete(e.pointerId);
    };
    lookZone.addEventListener('pointerup', releaseLook);
    lookZone.addEventListener('pointercancel', releaseLook);

    // --- Fire overlay (invisible button covering the weapon area) ---
    fireOverlay.addEventListener('pointerdown', e => {
        if (isMenuOpen()) return;
        if (handleDeadRestart()) return;

        e.preventDefault();
        e.stopPropagation();
        fireOverlay.setPointerCapture(e.pointerId);
        activePointers.set(e.pointerId, { type: 'fire' });
        input.fireHeld = true;
        fireWeapon(state.players[0]);
    });

    const releaseFire = e => {
        const ptr = activePointers.get(e.pointerId);
        if (!ptr || ptr.type !== 'fire') return;

        activePointers.delete(e.pointerId);
        input.fireHeld = false;
        stopAutoFire(state.players[0]);
    };
    fireOverlay.addEventListener('pointerup', releaseFire);
    fireOverlay.addEventListener('pointercancel', releaseFire);

    // --- Use button ---
    useButton.addEventListener('pointerdown', e => {
        if (isMenuOpen()) return;
        if (handleDeadRestart()) return;

        e.preventDefault();
        tryOpenDoor(state.players[0]);
        tryUseSwitch(state.players[0]);
        tryUseLift(state.players[0]);
    });

    // --- Weapon cycling by tapping the ARMS panel ---
    const armsPanel = document.querySelector('.hud-section-arms');
    if (armsPanel) {
        armsPanel.style.touchAction = 'none';
        armsPanel.addEventListener('pointerdown', e => {
            e.preventDefault();
            e.stopPropagation();
            cycleWeapon(1);
        });
    }

    // --- Window blur: zero touch state ---
    window.addEventListener('blur', () => {
        moveX = 0;
        moveY = 0;
        turnDelta = 0;
        joystickKnob.style.transform = 'translate(0, 0)';
        activePointers.clear();
    });
}

// ============================================================================
// Helpers
// ============================================================================

function cycleWeapon(direction) {
    const owned = [...state.ownedWeapons].sort((a, b) => a - b);
    const currentIndex = owned.indexOf(state.currentWeapon);
    const nextIndex = (currentIndex + direction + owned.length) % owned.length;
    equipWeapon(state.players[0], owned[nextIndex]);
}

function handleDeadRestart() {
    if (!state.isDead) return false;
    if (performance.now() - state.deathTime > 4000) {
        loadMap(currentMap);
    }
    return true;
}
