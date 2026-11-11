// Contract (moved from the index.html Development Contract):
// - 팥은 적 병사가 평타 거리 밖이면서 점프 사거리 안에 있을 때 높이 뛰어올라 적 쪽으로 내려찍는다.
//   표현은 물리 높이를 따르고, 착지에 주변 적 병사에게 피해와 수평·수직 충격을 준다. 착지부터 재사용 대기
//   시간을 적용하며 비행·대기 상태는 저장·복원·해시에 포함한다.
import { FP } from '../../core/config.js';
import { LaunchImpactRules } from '../../definitions/launch-impact-rules.js';
import { KnockbackRules } from '../../definitions/knockback-rules.js';
import { LaunchImpact } from '../launch-impact.js';
import { Knockback } from '../knockback.js';
import { IndexList } from '../index-list.js';

const IMPACT_QUERY = new IndexList();

// Uses the same physical motion as other impulses; the unit owns the leap state.
export class UnitLeapAttack {
    // A leaping body only meets a body whose vertical interval overlaps its own: the contact solve marks it
    // VERTICAL and compares bottoms (terrain height plus flight height) against diameters.
    static airborne(unit) {
        return unit.leapAttack?.phase === 'airborne';
    }
    static bottom(sim, unit) {
        return (
            sim.world.terrain.surfaces.heightAt(unit.x, unit.y) +
            (unit.impactMotion?.heightFP || 0) / FP
        );
    }
    static start(sim, unit, target, spec, attackDistance) {
        const state = unit.leapAttack;
        const dx = target.x - unit.x;
        const dy = target.y - unit.y;
        const distance = Math.hypot(dx, dy);
        if (
            !state ||
            state.phase !== 'ready' ||
            sim.tick < state.cooldownUntil ||
            unit.impactMotion ||
            !target.alive ||
            distance <= attackDistance ||
            distance > attackDistance + spec.range
        )
            return false;
        // Aim short of the target so physical contact remains authoritative.
        const travel = Math.max(
            0,
            distance - sim.interactionDistance(unit, target, 'combat-contact'),
        );
        const flightSeconds = (2 * spec.lift) / LaunchImpactRules.gravity;
        const speed = travel / flightSeconds;
        state.phase = 'launchPending';
        state.velocityX = (dx / distance) * speed;
        state.velocityY = (dy / distance) * speed;
        unit.combat.cancelWindup();
        return true;
    }

    // Commit impulses after collision so XYZ integration starts together. Report completed landings.
    static flush(sim, unit, spec, damage) {
        const state = unit.leapAttack;
        if (!state || !unit.alive) return;
        if (state.phase === 'landPending') {
            this.land(sim, unit, spec, damage);
            return true;
        }
        if (state.phase !== 'launchPending') return;
        const mass = sim.mass(unit);
        sim.navigation.motion.applyImpulse(
            unit,
            {
                x: state.velocityX * mass,
                y: state.velocityY * mass,
                z: spec.lift * mass,
            },
            { kind: 'leap', sourceId: unit.id },
        );
        state.phase = 'airborne';
        state.startTick = sim.tick;
        delete state.velocityX;
        delete state.velocityY;
    }

    static update(sim, unit) {
        const state = unit.leapAttack;
        if (!state || state.phase !== 'airborne') return false;
        const motion = unit.impactMotion;
        if (sim.tick === state.startTick || (motion && (motion.heightFP > 0 || motion.vzFP > 0)))
            return true;
        state.phase = 'landPending';
        return true;
    }

    static land(sim, unit, spec, damage) {
        const state = unit.leapAttack;
        state.phase = 'ready';
        state.cooldownUntil = sim.tick + sim.msTicks(spec.cooldownMs);
        const impact = spec.impact;
        if (!impact) return;
        const heightFP = Math.round(sim.world.terrain.surfaces.heightAt(unit.x, unit.y) * FP);
        // The body comes down at the speed it leapt up with and throws the grounded enemies around it first.
        if (sim.canAttackEntity(unit.type, null))
            Knockback.area(sim, {
                side: unit.side,
                sourceId: unit.id,
                x: unit.x,
                y: unit.y,
                radius: impact.radius,
                impactHeightFP: heightFP,
                mass: sim.mass(unit),
                speed: spec.lift,
                gain: KnockbackRules.gain.area,
                falloff: impact.knockbackFalloff,
            });
        const found = sim.nearbyUnits(
            unit.x,
            unit.y,
            impact.radius + sim.maxUnitRadius,
            1 - unit.side,
            IMPACT_QUERY,
        );
        for (let k = 0; k < found; k++) {
            const index = IMPACT_QUERY.items[k];
            const target = sim.units[index];
            if (
                !target?.alive ||
                target.side === unit.side ||
                !sim.canAttackEntity(unit.type, target)
            )
                continue;
            if (
                LaunchImpact.distanceToBody(sim, target, unit.x, unit.y, heightFP).surfaceDistance >
                impact.radius
            )
                continue;
            sim.applyDamage(
                unit.side,
                unit.type,
                target,
                false,
                Math.floor(damage * impact.damageScale),
                unit.id,
            );
        }
        sim.events.push({
            type: 'leapLand',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
            radius: impact.radius,
        });
    }
}
