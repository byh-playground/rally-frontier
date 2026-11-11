// Artillery contact and deployment policy. Distances/seconds are world units; authority stores FP integers.
import { RallyGamekit } from '../core/gamekit.js';
const { SOFT, SOLID } = RallyGamekit;
class LaunchImpactRules {
    static launchHeight = 60;
    static muzzleReach = 38;
    static gravity = 1000;
    static referenceMass = 100;
    static restitution = 0;
    static maxZeroTimeContactIterations = 32;
    // One tick's contact solve (GameKit contact-solver, UnitMotion.solveContacts). Walls, buildings and the map
    // edge are always solved. Unit-unit contacts, walking or flying alike, are solved in time order up to this
    // many a tick; later ones pass through each other and the overlap separation pulls them apart afterwards.
    static unitContactBudget = 64;
    // Contact groups by side (0, 1, any other): allies are not contacts and separate by a mass-weighted share
    // (SOFT), everyone else is solid (SOLID). The table is groups x groups, row = one body's group.
    static contactRelations = Object.freeze([
        SOFT,
        SOLID,
        SOLID,
        SOLID,
        SOFT,
        SOLID,
        SOLID,
        SOLID,
        SOLID,
    ]);
    // Candidate grid cell of the contact solve, world units. Cost only, never the result.
    static contactCellSize = 64;
    // Ally separation (SOFT): each pass moves a body by this share of its overlaps, at most allySoftPasses
    // passes; one pass moves a body at most max(1, min(radius·allySoftMaxRadius,
    // max(radius·allySoftIdleRadius, tick speed·allySoftSpeed))) (Jacobi, A011·A012).
    static allySoftFraction = 0.8;
    static allySoftPasses = 4;
    static allySoftIdleRadius = 0.08;
    static allySoftMaxRadius = 0.25;
    static allySoftSpeed = 0.75;
    // Enemy separation (SOLID): passes that move the body that entered the other fully out.
    static hostileSeparationPasses = 4;
    static remainderScale = 10000;
    static airDrag = 0.4;
    static groundDrag = 5;
    static recoveryMs = 250;
    static deploymentGapMs = 50;
    static deploymentRetryMs = 100;
    static deploymentSpeed = 250;
    static deploymentLift = 250;
    static knockbackSpeed = 400;
    static knockbackLift = 250;
    static projectileRadius = 10;
    static interceptFall = Object.freeze({
        safeHeight: 50,
        maxDamageHeight: 250,
        maxDamageRatio: 0.5,
    });
    // Integer-quantized parabola shared by collision and presentation, including the physical muzzle height.
    static flightHeight(progress, arcHeight) {
        const t = Math.max(0, Math.min(10000, Math.round(progress * 10000))),
            remaining = 10000 - t;
        return (
            Math.round(
                (4 * Math.round(arcHeight * 100) * t * remaining +
                    this.launchHeight * 100 * remaining * remaining) /
                    100000000,
            ) / 100
        );
    }
    // Horizontal travel of one impulse per unit of launch speed, using the same per-tick gravity and drag
    // as impact motion. Drag is linear, so travel is proportional to speed. The impulse tick only applies drag.
    static travelPerSpeed(lift, tps) {
        let x = 0,
            vx = 1,
            z = 0,
            vz = lift;
        const applyDrag = () => {
            const drag = z > 0 || vz > 0 ? this.airDrag : this.groundDrag;
            vx *= Math.max(0, 1 - drag / tps);
        };
        applyDrag();
        for (let tick = 0; tick < tps * 20 && vx > 1e-9; tick++) {
            x += vx / tps;
            if (z > 0 || vz > 0) {
                z = Math.max(0, z + vz / tps);
                vz -= this.gravity / tps;
                if (z === 0 && vz < 0) vz = 0;
            }
            applyDrag();
        }
        return x;
    }
    // Impulse speed that carries a body `distance` away before it settles.
    static speedForDistance(distance, lift, tps) {
        return distance / this.travelPerSpeed(lift, tps);
    }
}
export { LaunchImpactRules };
