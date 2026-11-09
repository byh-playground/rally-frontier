// Artillery contact and deployment policy. Distances/seconds are world units; authority stores FP integers.
class LaunchImpactRules {
    static launchHeight = 60;
    static muzzleReach = 38;
    static gravity = 1000;
    static referenceMass = 100;
    static restitution = 0;
    static maxZeroTimeContactIterations = 32;
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
