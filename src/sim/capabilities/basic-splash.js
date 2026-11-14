// Contract:
// - Definition `basicSplash { radius, damageRatio }`: a basic melee hit on a grounded soldier also hits the grounded
//   enemy soldiers whose bodies are within `radius` of the struck one, with a clear line from it, for
//   max(1, floor(damage · damageRatio)) each and a small shove away from it (KnockbackRules.gain.splash). Buildings
//   take the plain basic hit. The watermelon's basic attack and the walnut's use it.
import { KnockbackRules } from '../../definitions/knockback-rules.js';
import { LaunchImpact } from '../launch-impact.js';
import { Knockback } from '../knockback.js';
import { UnitMotion } from '../navigation.js';
import { IndexList } from '../index-list.js';
// The body-centre height a melee strike measures from (shared with the spin's reach).
import { UnitSpinAttack } from './unit-spin-attack.js';

const SPLASH_QUERY = new IndexList();

export class BasicSplash {
    // The basic hit on `target` and its splash. Returns whether the hit dealt damage to a grounded soldier
    // (only then does the splash land).
    static hit(sim, unit, target, spec, damage) {
        const grounded = UnitMotion.isGrounded(target),
            x = target.x,
            y = target.y,
            heightFP = UnitSpinAttack.heightFP(sim, target),
            capture = {};
        sim.applyDamage(unit.side, unit.type, target, false, damage, unit.id, { capture });
        if (!grounded || !(capture.dealt > 0)) return false;

        sim.events.push({
            type: 'basicSplashImpact',
            side: unit.side,
            sourceId: unit.id,
            targetId: target.id,
            x,
            y,
            radius: spec.radius,
        });
        const splashDamage = Math.max(1, Math.floor(damage * spec.damageRatio));
        const found = sim.nearbyUnits(
            x,
            y,
            spec.radius + sim.maxUnitRadius,
            1 - unit.side,
            SPLASH_QUERY,
        );
        for (let k = 0; k < found; k++) {
            const index = SPLASH_QUERY.items[k];
            const other = sim.units[index];
            if (!other?.alive || other === target || !UnitMotion.isGrounded(other)) continue;
            const body = LaunchImpact.distanceToBody(sim, other, x, y, heightFP);
            if (
                body.surfaceDistance > spec.radius ||
                !sim.world.terrain.field.polygonSegmentClear(x, y, other.x, other.y, 0)
            )
                continue;
            // The splash shoves away from the struck body, a small area hit by the swinging arm.
            Knockback.hit(sim, other, {
                dx: other.x - x,
                dy: other.y - y,
                mass: sim.mass(unit),
                speed: KnockbackRules.swingSpeed,
                gain: KnockbackRules.gain.splash,
                strength: KnockbackRules.strength(
                    body.falloffDistance,
                    spec.radius + sim.unitRadius(other),
                ),
                sourceId: unit.id,
                originX: x,
                originY: y,
            });
            sim.applyDamage(unit.side, unit.type, other, false, splashDamage, unit.id, {
                sourceDamageResolved: true,
            });
        }
        return true;
    }
}
