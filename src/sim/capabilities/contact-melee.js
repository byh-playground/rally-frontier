// Contract (moved from the index.html Development Contract):
// - 조의 공격은 기존 충돌 해소 후 실제 접근·병사 또는 건물 외곽 접촉 시에만 피해를 준다.
//   타격 뒤 후퇴하고 재돌진하며, 후퇴·충전 상태와 타격 시각은 저장·복원·리플레이에 포함한다.
// - 땅콩은 시야에 들어온 가까운 적 건물만 지상 공격 대상으로 삼고, 사거리 150에서 접촉 돌진을 시작하며 돌진 중에는 기본 이동속도(100)의 두 배로 움직인다. 유효타 뒤 반동은 속도가 아니라 돌진 시작 거리와 같은 목표 거리(150)로 정의하고, 속도는 공용 중력·감쇠로 계산한다.
//   건물 외곽에 유효타를 내면 공용 물리 임펄스로 건물 반대 방향 위로 튀고, 착지하고 회복한 위치에서 다시 접근한다.
//   적 병사와는 공용 충돌을 적용한다.
//   병력 투입탄은 일반 착탄과 공중 격추·비상 착지를 따른다. 공성 피해는 지상에서 건물에 닿을 때만 적용한다.
// Contact melee (Definition `contactMelee`): the soldier winds up, charges into its target's body,
// strikes on contact, then backs off (or rebounds with `contactRebound`). Millet, peanuts and sticky rice.
// Contact attacks commit after the shared motion solver, in the same stable unit order as target
// selection (StrategySim collects them in `pending`); pending entries never cross a tick boundary.
import { FP } from '../../core/config.js';
import { LaunchImpactRules } from '../../definitions/launch-impact-rules.js';
import { UnitDefinition } from '../../definitions/units.js';
import { ConstructionRules } from '../construction-rules.js';
import { InteractionGeometry, NavigationGoal } from '../navigation.js';
import { StickyCling } from './sticky-cling.js';

export class ContactMelee {
    // A soldier backing off after a hit keeps retreating until its recovery ends.
    static recover(sim, u, d) {
        if (u.contactAttack?.phase !== 'recover') return false;
        if (sim.tick < u.contactAttack.untilTick) {
            const speed = (d.speed * sim.timedModifierPct(u, 'movePct')) / 100;
            sim.moveToward(u, u.contactAttack.retreatX, u.contactAttack.retreatY, speed, {
                allowContactRecovery: true,
            });
            // The next wind-up runs while backing off, so a short interval (millet's 3.5 ticks) is not
            // stretched by the retreat; the windup waits for the same cooldown as everywhere else.
            if (!u.combat.windupPending() && !u.combat.cooldownActive(sim)) {
                const ref = u.target ? sim.liveEntityRefById(u.target) : null;
                if (ref)
                    sim.startAttackWindup(u, ref.entity, ref.isBuilding ? 'building' : 'unit', d);
            }
            return true;
        }
        u.contactAttack = null;
        return false;
    }
    static cancelCharge(u) {
        if (u.contactAttack?.phase === 'charge') u.contactAttack = null;
    }
    static charge(sim, u, t, found, d, dist, moveSpeed, cooldown, pending) {
        if (!u.combat.windupPending() && !u.combat.cooldownActive(sim))
            sim.startAttackWindup(u, t, found.isBuilding ? 'building' : 'unit', d);
        const contact = found.isBuilding
            ? sim.buildingClearanceDistance(u, t)
            : InteractionGeometry.contact(u, t);
        const readyToCharge = sim.tickAttackWindup(u);
        if (readyToCharge) {
            if (u.contactAttack?.phase !== 'charge' || u.contactAttack.targetId !== t.id)
                u.contactAttack = {
                    phase: 'charge',
                    targetId: t.id,
                    untilTick: sim.tick + sim.msTicks(ConstructionRules.chargeTimeoutMs),
                };
            if (sim.tick >= u.contactAttack.untilTick) {
                u.combat.cancelWindup();
                u.contactAttack = null;
                u.target = null;
                return null;
            }
        }
        const fromX = u.x,
            fromY = u.y;
        if (readyToCharge && dist > contact)
            sim.moveToGoal(
                u,
                NavigationGoal.range(
                    t.x,
                    t.y,
                    contact + NavigationGoal.ARRIVAL_INSET,
                    0,
                    false,
                    found.isBuilding,
                ),
                moveSpeed *
                    (d.contactChargeSpeedMultiplier ?? ConstructionRules.chargeSpeedMultiplier),
            );
        if (readyToCharge)
            pending?.push({
                unit: u,
                targetId: t.id,
                isBuilding: found.isBuilding,
                cooldown,
                beforeDistance: dist,
                fromX,
                fromY,
            });
        return null;
    }
    static beginRecovery(sim, u, target, cooldownMs, rebound = null) {
        const dx = u.x - target.x,
            dy = u.y - target.y,
            length = Math.hypot(dx, dy) || 1;
        if (rebound) {
            const mass = sim.mass(u),
                speed = LaunchImpactRules.speedForDistance(rebound.distance, rebound.lift, sim.tps);
            u.contactAttack = null;
            sim.navigation.motion.applyImpulse(
                u,
                {
                    x: (dx / length) * speed * mass,
                    y: (dy / length) * speed * mass,
                    z: rebound.lift * mass,
                },
                { sourceId: target.id },
            );
            return;
        }
        u.contactAttack = {
            phase: 'recover',
            retreatX: u.x + (dx / length) * ConstructionRules.retreatDistance,
            retreatY: u.y + (dy / length) * ConstructionRules.retreatDistance,
            untilTick:
                sim.tick +
                // At least two ticks: the first one is the step back, so a short interval still separates the pair.
                Math.max(
                    2,
                    Math.round(sim.msTicks(cooldownMs) * ConstructionRules.phaseRatios.recoverEnd),
                ),
        };
    }
    static resolve(sim, pending, vision) {
        let winner = null;
        for (const attack of pending) {
            const u = attack.unit;
            if (
                !u.alive ||
                u.combat.attackWindupTargetId !== attack.targetId ||
                !sim.tickAttackWindup(u)
            )
                continue;
            const target = sim.liveEntityRefById(
                attack.targetId,
                attack.isBuilding ? 'building' : 'unit',
            )?.entity;
            if (!target) {
                u.combat.cancelWindup();
                continue;
            }
            if (
                !sim.canAttackEntity(u.type, target, attack.isBuilding) ||
                (!attack.isBuilding &&
                    (!sim.canTargetUnit(u.side, target) ||
                        !sim.canSeeCombatTarget(u.side, target, vision[u.side])))
            ) {
                u.combat.cancelWindup();
                continue;
            }
            const contact = attack.isBuilding
                ? sim.buildingClearanceDistance(u, target)
                : InteractionGeometry.contact(u, target);
            const afterDistance = Math.hypot(target.x - u.x, target.y - u.y);
            if (
                sim.interactionDistance(u, target, 'attack', 0) < 0 ||
                afterDistance > contact + ConstructionRules.contactTolerance
            )
                continue;
            u.combat.cancelWindup();
            if (attack.isBuilding && StickyCling.tryBegin(sim, u, target)) continue;
            const definition = UnitDefinition.get(u.type);
            const dx = target.x - attack.fromX,
                dy = target.y - attack.fromY,
                length = Math.hypot(dx, dy) || 1,
                sourceApproach = ((u.x - attack.fromX) * dx + (u.y - attack.fromY) * dy) / length;
            if (attack.beforeDistance - afterDistance < 1 / FP || sourceApproach < 1 / FP) {
                ContactMelee.beginRecovery(
                    sim,
                    u,
                    target,
                    definition.attackIntervalMs ?? definition.cooldownMs,
                );
                continue;
            }
            sim.commitAttackTiming(u, definition, attack.cooldown);
            u.combat.contactHitTick = sim.tick;
            ContactMelee.beginRecovery(
                sim,
                u,
                target,
                definition.attackIntervalMs ?? definition.cooldownMs,
                definition.contactRebound,
            );
            winner =
                sim.applyDamage(
                    u.side,
                    u.type,
                    target,
                    attack.isBuilding,
                    Math.floor(definition.atk),
                    u.id,
                    { damageClass: UnitDefinition.damageClass(u.type) },
                ) || winner;
        }
        return winner;
    }
}
