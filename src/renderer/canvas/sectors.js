/**
 * Moving-sector behaviour for the SoftwareRenderer (mixed onto the
 * prototype): doors and lifts. Each groups its command setter
 * (`setDoorState` / `setLiftState`), its per-frame simulation
 * (`_updateDoors` / `_updateLifts`, called from render()), and — for
 * lifts — the shaft-wall render pass that draws the moving platform.
 *
 * Doors animate a sector's ceiling (and slide the upper-face panel walls
 * up with it) via `_ceilOverride` / `_wallBottomOffset`; lifts animate a
 * sector's floor via `_floorOverride`. The override maps are read by the
 * wall and flat passes so a single source of truth drives the geometry.
 */

import { getWallTexture } from './textures.js';
import { DOOR_SPEED, LIFT_SPEED } from './tables.js';

export const sectorMethods = {
    setDoorState(sectorIndex, doorState) {
        const door = this.doors.get(sectorIndex);
        if (door) door.target = doorState === 'open' ? door.open : door.closed;
    },

    /** Advance door animations and refresh the wall / ceiling overrides
     *  they drive. Called once per frame with the elapsed seconds. */
    _updateDoors(dt) {
        for (const door of this.doors.values()) {
            if (door.current !== door.target) {
                const dir = Math.sign(door.target - door.current);
                door.current += dir * DOOR_SPEED * dt;
                if ((dir > 0 && door.current > door.target)
                    || (dir < 0 && door.current < door.target)) {
                    door.current = door.target;
                }
                const offset = door.current - door.closed;
                for (const w of door.faceWalls) this._wallBottomOffset.set(w, offset);
                if (door.sectorPoly) this._ceilOverride.set(door.sectorPoly, door.current);
            }
        }
    },

    setLiftState(sectorIndex, liftState) {
        const lift = this.lifts.get(sectorIndex);
        if (lift) lift.target = liftState === 'lowered' ? lift.lower : lift.upper;
    },

    /** Advance lift animations: move the platform floor toward its target
     *  and refresh the floor-height override that drives the visplane. */
    _updateLifts(dt) {
        for (const lift of this.lifts.values()) {
            if (lift.current === lift.target) continue;
            const dir = Math.sign(lift.target - lift.current);
            lift.current += dir * LIFT_SPEED * dt;
            if ((dir > 0 && lift.current > lift.target)
                || (dir < 0 && lift.current < lift.target)) {
                lift.current = lift.target;
            }
            if (lift.sectorPoly) this._floorOverride.set(lift.sectorPoly, lift.current);
        }
    },

    /**
     * Draw lift shaft walls. The platform-face walls span from the
     * platform's current height to the floor they face (so they grow as
     * the lift drops); the static shaft sides span the full travel so the
     * shaft isn't see-through once the platform has moved away.
     */
    _renderLiftWalls(cam) {
        for (const lift of this.lifts.values()) {
            for (const wall of lift.shaftWalls) {
                const tex = getWallTexture(wall.texture);
                if (!tex || tex.width <= 1) continue;
                let bottom, top;
                if (wall.isPlatformFace) {
                    const nf = wall.neighborFloor ?? lift.lower;
                    bottom = Math.min(lift.current, nf);
                    top = Math.max(lift.current, nf);
                } else {
                    bottom = wall.neighborFloor !== undefined
                        ? Math.min(wall.neighborFloor, lift.lower) : lift.lower;
                    top = lift.upper;
                }
                if (top - bottom < 0.5) continue;
                const light = wall.lightLevel ?? lift.light;
                this._drawWall(cam, wall, tex, bottom, top, wall.yOffset || 0, light, true);
            }
        }
    },
};
