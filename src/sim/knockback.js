// Every attack that throws a body goes through here with the mass and speed of what hit and the kind of hit
// (KnockbackRules.gain). The struck body takes J/m along the ground away from the hit and KnockbackRules.liftRatio
// of that upward, added to the velocity it already has (UnitMotion.applyImpulse). A target that dies from the
// same hit is thrown too: the knockback does not look at hit points.
import { KnockbackRules } from '../definitions/knockback-rules.js';
import { HashUtil } from './map-generation.js';
import { IndexList } from './index-list.js';
import { LaunchImpact } from './launch-impact.js';
import { UnitMotion } from './navigation.js';

// Reused by every call: the bodies an area reaches, and the impulse and record handed to applyImpulse
// (read there before it returns).
const AREA_QUERY = new IndexList();
const IMPULSE = { x: 0, y: 0, z: 0 };
const IMPACT = { kind: 'knockback', sourceId: null, originX: 0, originY: 0 };

class Knockback {
    // One body (mass `mass`, at `speed`) striking `target` along (dx, dy). `strength` scales an area hit.
    static hit(
        sim,
        target,
        { dx, dy, mass, speed, gain, strength = 1, sourceId, originX, originY },
    ) {
        this.push(
            sim,
            target,
            dx,
            dy,
            KnockbackRules.impulse(mass, speed, sim.mass(target), gain, strength),
            sourceId,
            originX,
            originY,
        );
    }
    // A body landing or bursting at (x, y): every grounded living enemy of `side` within `radius` of the centre
    // (at height impactHeightFP) is thrown away from it, fading with distance unless `falloff` is false. A body
    // already in the air is not thrown again.
    static area(
        sim,
        { side, x, y, radius, impactHeightFP, mass, speed, gain, falloff = true, sourceId },
    ) {
        const found = sim.nearbyUnits(x, y, radius + sim.maxUnitRadius, 1 - side, AREA_QUERY);
        for (let k = 0; k < found; k++) {
            const u = sim.units[AREA_QUERY.items[k]];
            if (!u?.alive || u.side !== 1 - side || !UnitMotion.isGrounded(u)) continue;
            const body = LaunchImpact.distanceToBody(sim, u, x, y, impactHeightFP);
            if (body.surfaceDistance > radius) continue;
            const strength = falloff
                ? KnockbackRules.strength(body.falloffDistance, radius + sim.unitRadius(u.type))
                : 1;
            this.push(
                sim,
                u,
                u.x - x,
                u.y - y,
                KnockbackRules.impulse(mass, speed, sim.mass(u), gain, strength),
                sourceId,
                x,
                y,
            );
        }
    }
    // Impulse J along (dx, dy) and J·liftRatio upward. A hit with no direction picks one of eight from the ids.
    static push(sim, target, dx, dy, impulse, sourceId, originX, originY) {
        let length = Math.hypot(dx, dy);
        if (length < 0.001) {
            const angle = ((HashUtil.hash(target.id + '|' + sourceId) % 8) * Math.PI) / 4;
            dx = Math.cos(angle);
            dy = Math.sin(angle);
            length = 1;
        }
        IMPULSE.x = (dx / length) * impulse;
        IMPULSE.y = (dy / length) * impulse;
        IMPULSE.z = impulse * KnockbackRules.liftRatio;
        IMPACT.sourceId = sourceId;
        IMPACT.originX = originX;
        IMPACT.originY = originY;
        sim.navigation.motion.applyImpulse(target, IMPULSE, IMPACT);
    }
}

export { Knockback };
