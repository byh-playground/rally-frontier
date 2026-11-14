import { FP } from '../core/config.js';
import { LaunchImpact } from './launch-impact.js';
import { IndexList } from './index-list.js';
import { UnitMotion } from './navigation.js';
import { UnitFlight } from './capabilities/unit-flight.js';

// Enemy flying units near an air defender; read before the next call.
const FLYER_QUERY = new IndexList();
// The damage a flying-unit hit dealt (StrategySim.applyDamage capture).
const FLYER_HIT = { dealt: 0, blocked: false, damageClass: null };

// Air defense shares target priority and emergency deployment across units and buildings. Its targets are enemy
// shells first, then enemy flying units (UnitFlight): the only things in the air.
export class LaunchInterception {
    static target(sim, attacker, range, vision, lockedId = null) {
        const rangeSquared = range * range;
        let best = null,
            bestDistance = Infinity;
        for (const shell of sim.projectiles) {
            if (!shell.alive || !shell.payload || !(shell.hp > 0) || shell.side === attacker.side)
                continue;
            const distance = (shell.x - attacker.x) ** 2 + (shell.y - attacker.y) ** 2;
            if (distance > rangeSquared || !sim.canSeeCombatTarget(attacker.side, shell, vision))
                continue;
            if (shell.id === lockedId) return shell;
            if (sim.targetChoiceBetter(distance, shell.id, bestDistance, best)) {
                best = shell;
                bestDistance = distance;
            }
        }
        if (best || (attacker.side !== 0 && attacker.side !== 1)) return best;
        const count = sim.nearbyUnits(
                attacker.x,
                attacker.y,
                range,
                1 - attacker.side,
                FLYER_QUERY,
                true,
            ),
            items = FLYER_QUERY.items;
        for (let k = 0; k < count; k++) {
            const unit = sim.units[items[k]];
            if (!unit?.alive || !UnitFlight.airborne(unit)) continue;
            const distance = (unit.x - attacker.x) ** 2 + (unit.y - attacker.y) ** 2;
            if (distance > rangeSquared || !sim.canSeeCombatTarget(attacker.side, unit, vision))
                continue;
            if (unit.id === lockedId) return unit;
            if (sim.targetChoiceBetter(distance, unit.id, bestDistance, best)) {
                best = unit;
                bestDistance = distance;
            }
        }
        return best;
    }

    static hit(sim, attacker, target, attack) {
        if (!target.payload) {
            this.hitFlyer(sim, attacker, target, attack);
            return;
        }
        const shell = target,
            { x, y } = shell;
        const amount = Math.min(shell.hp, Math.floor(attack));
        shell.hp -= amount;
        const destroyed = shell.hp === 0;
        const heightFP = Math.round(LaunchImpact.projectileHeight(sim, shell, x, y) * FP);
        sim.events.push({
            type: 'antiAirHit',
            side: attacker.side,
            targetSide: shell.side,
            sourceId: attacker.id,
            sourceType: attacker.type,
            fromX: attacker.x,
            fromY: attacker.y,
            x,
            y,
            heightFP,
            projectileId: shell.id,
            amount,
            destroyed,
        });
        if (destroyed) {
            sim.retireProjectile(shell, x, y);
            LaunchImpact.enqueue(sim, shell, x, y, heightFP, { emergencyDrop: true });
        }
    }

    // A flying unit takes the hit as ordinary damage; killed, it falls from where it was (UnitFlight.onDeath).
    static hitFlyer(sim, attacker, unit, attack) {
        const x = unit.x,
            y = unit.y,
            heightFP = UnitMotion.bottomFP(sim, unit) + Math.round(sim.unitRadius(unit) * FP);
        FLYER_HIT.dealt = 0;
        sim.applyDamage(
            attacker.side,
            attacker.type,
            unit,
            false,
            Math.floor(attack),
            attacker.id,
            {
                damageDelivery: 'anti-air',
                sourceDamageResolved: true,
                // The antiAirHit flash marks the hit at the body's height; the ground impact flash would sit below it.
                suppressImpactFx: true,
                capture: FLYER_HIT,
            },
        );
        sim.events.push({
            type: 'antiAirHit',
            side: attacker.side,
            targetSide: unit.side,
            sourceId: attacker.id,
            sourceType: attacker.type,
            fromX: attacker.x,
            fromY: attacker.y,
            x,
            y,
            heightFP,
            projectileId: null,
            targetId: unit.id,
            amount: FLYER_HIT.dealt,
            destroyed: unit.alive === false,
        });
    }
}
