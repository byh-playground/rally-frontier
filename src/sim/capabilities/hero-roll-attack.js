// Contract (moved from the index.html Development Contract):
// - 수박의 굴러가기 명령은 출격 식별자와 자원·대상을 검증한 뒤 시작한다. 제자리 도약을 마치고
//   착지한 틱부터 월드 이동과 충돌을 판정하며, 정지하면 몸을 편다. 각 단계와 이미 맞힌 대상은
//   저장·복원·리플레이에 포함한다.
import { FP } from '../../core/config.js';
import { RallyGamekit } from '../../core/gamekit.js';
import { SimulationTiming } from '../../core/simulation-timing.js';
import { UnitDefinition } from '../../definitions/units.js';
import { LaunchImpact } from '../launch-impact.js';
import { HashUtil } from '../map-generation.js';
import { UnitMotion } from '../navigation.js';

const { SweptCircleContact } = RallyGamekit;
const CONTACT = { ...SweptCircleContact.policies.relative, retreat: 0 };
const STOP_EPSILON = 1e-8;

export class HeroRollAttack {
    static canDrive(unit, tick) {
        const motion = unit.impactMotion;
        return (
            UnitMotion.isGrounded(unit) &&
            (!motion || (tick >= motion.recoverUntilTick && !motion.vxFP && !motion.vyFP))
        );
    }

    static cancel(unit) {
        if (unit.heroRoll) unit.heroRoll = null;
    }

    static endSortie(unit) {
        this.cancel(unit);
        unit.heroRollQueued = false;
    }

    static canStart(unit, tick) {
        return (
            !unit.heroRoll &&
            !unit.spinAttack &&
            !unit.combat.attackWindupUntil &&
            this.canDrive(unit, tick)
        );
    }

    static reject(sim, side, sortieId, reason) {
        sim.events.push({ type: 'heroSkillRejected', side, sortieId, reason });
        return false;
    }

    static activate(sim, unit, sortieId) {
        if (unit.heroRollQueued) return true;
        unit.heroRollQueued = true;
        this.tryQueued(sim, unit, sortieId);
        return true;
    }

    static tryQueued(sim, unit, sortieId, vision) {
        if (!unit.heroRollQueued || !this.canStart(unit, sim.tick)) return false;
        const { side } = unit;
        const spec = UnitDefinition.get(unit.type).heroActive;
        if (sim.wallet[side] < spec.cost) return false;
        const sources = vision ?? sim.visionSources(side);
        let target = null;
        let bestDistance = spec.range ** 2;
        sim.withNearbyUnits(unit.x, unit.y, spec.range, 1 - side, (indices) => {
            for (const index of indices) {
                const candidate = sim.units[index];
                const distance = (candidate.x - unit.x) ** 2 + (candidate.y - unit.y) ** 2;
                if (
                    sim.targetChoiceBetter(distance, candidate.id, bestDistance, target) &&
                    candidate.hp > 0 &&
                    UnitMotion.isGrounded(candidate) &&
                    sim.canAttackEntity(unit.type, candidate) &&
                    sim.canSeeCombatTarget(side, candidate, sources)
                ) {
                    target = candidate;
                    bestDistance = distance;
                }
            }
        });
        if (!target) return false;
        unit.heroRollQueued = false;

        const distance = Math.sqrt(bestDistance);
        const angle = (HashUtil.hash(unit.id + '|' + target.id) % 8) * (Math.PI / 4);
        unit.heroRoll = {
            startTick: sim.tick,
            phase: 'hop',
            phaseStartTick: sim.tick,
            phaseEndTick: sim.tick + sim.msTicks(spec.hopMs),
            distance: 0,
            targetId: target.id,
            dx: distance ? (target.x - unit.x) / distance : Math.cos(angle),
            dy: distance ? (target.y - unit.y) / distance : Math.sin(angle),
            hitIds: [],
        };
        unit.combat.attackArcTargetId = null;
        unit.combat.attackArcUntilTick = 0;
        unit.constructionWork = null;
        unit.target = null;
        sim.wallet[side] -= spec.cost;
        sim.events.push({
            type: 'heroSkillStarted',
            side,
            sortieId,
            heroType: unit.type,
            cost: spec.cost,
        });
        return true;
    }

    static advance(sim, unit) {
        const roll = unit.heroRoll;
        if (!this.canDrive(unit, sim.tick)) {
            this.cancel(unit);
            return;
        }

        if (roll.phase === 'unfold') {
            if (sim.tick >= roll.phaseEndTick) this.cancel(unit);
            return;
        }
        if (roll.phase === 'hop') {
            if (sim.tick < roll.phaseEndTick) return;
            roll.phase = 'roll';
            roll.phaseStartTick = sim.tick;
            roll.phaseEndTick = null;
            // Touchdown is the shared boundary between a stationary hop and the first roll interval.
            this.land(sim, unit);
            return;
        }

        const definition = UnitDefinition.get(unit.type);
        const spec = definition.heroActive;
        const { x, y } = unit;
        const { dx, dy } = roll;
        const terrainRadius = sim.unitRadius(unit.type);
        const { rollHitRadius } = spec;
        const step = Math.min(spec.rollSpeed / sim.tps, spec.rollDistance - roll.distance);
        const vx = dx * step;
        const vy = dy * step;
        const motion = sim.navigation.motion;
        // Round from the total travel so fractional steps do not shorten the roll.
        const originX = x - Math.round(dx * roll.distance * FP) / FP;
        const originY = y - Math.round(dy * roll.distance * FP) / FP;
        const advanceTo = (distance) => {
            if (distance <= 0) return;
            const travel = roll.distance + distance;
            motion.commit(unit, { x: originX + dx * travel, y: originY + dy * travel });
            unit.movement.lastMoveTick = sim.tick;
        };
        const { blocked, distance: wallDistance } = sim.navigation.traceStraightTravel(
            x,
            y,
            dx,
            dy,
            step,
            terrainRadius,
        );
        const contacts = [];
        sim.withNearbyUnits(
            x,
            y,
            wallDistance + rollHitRadius + sim.maxUnitRadius,
            1 - unit.side,
            (indices) => {
                for (const index of indices) {
                    const target = sim.units[index];
                    if (
                        !target?.alive ||
                        roll.hitIds.includes(target.id) ||
                        !UnitMotion.isGrounded(target) ||
                        !sim.canAttackEntity(unit.type, target)
                    )
                        continue;

                    const rx = x - target.x;
                    const ry = y - target.y;
                    const reach = rollHitRadius + sim.unitRadius(target.type);
                    const hitTime =
                        rx ** 2 + ry ** 2 <= reach ** 2
                            ? 0
                            : SweptCircleContact.cast(rx, ry, vx, vy, reach, CONTACT)?.t;
                    if (hitTime == null) continue;
                    const distance = hitTime * step;
                    if (distance > wallDistance + STOP_EPSILON) continue;
                    const hitX = x + dx * distance;
                    const hitY = y + dy * distance;
                    if (!sim.navigation.field.segmentClear(hitX, hitY, target.x, target.y, 0))
                        continue;
                    contacts.push({ target, distance, hitX, hitY });
                }
            },
        );
        contacts.sort((a, b) => a.distance - b.distance || (a.target.id < b.target.id ? -1 : 1));
        for (const { target, distance, hitX, hitY } of contacts) {
            if (!target.alive || !UnitMotion.isGrounded(target)) continue;
            roll.hitIds.push(target.id);
            advanceTo(distance);
            this.hit(sim, unit, target, definition, hitX, hitY);
            // Detonating a primed enemy can still kill the hero.
            if (!unit.heroRoll) return;
        }

        advanceTo(wallDistance);
        roll.distance = Math.min(spec.rollDistance, roll.distance + wallDistance);
        if (blocked || roll.distance >= spec.rollDistance - STOP_EPSILON) {
            if (!blocked) roll.distance = spec.rollDistance;
            roll.phase = 'unfold';
            roll.phaseStartTick = sim.tick;
            roll.phaseEndTick = sim.tick + sim.msTicks(spec.unfoldMs);
        }
    }

    static land(sim, unit) {
        const definition = UnitDefinition.get(unit.type);
        const { radius, damageRatio } = definition.heroActive.landing;
        const { x, y, side } = unit;
        const { hits } = sim.applyAreaDamage({
            sourceSide: side,
            sourceType: unit.type,
            sourceEntityId: unit.id,
            x,
            y,
            radius,
            damage: definition.atk * damageRatio,
            damageClass: UnitDefinition.damageClass(unit.type),
            impactHeightFP: Math.round(sim.world.terrain.surfaces.heightAt(x, y) * FP),
        });
        sim.events.push({ type: 'heroRollLand', side, sourceId: unit.id, x, y, radius, hits });
    }

    static hit(sim, unit, target, definition, x, y) {
        const spec = definition.heroActive;
        const { dx, dy } = unit.heroRoll;
        const side = dx * (target.y - y) - dy * (target.x - x);
        const sign = Math.sign(side) || (HashUtil.hash(target.id + '|' + unit.id) % 2 ? -1 : 1);
        sim.applyDamage(
            unit.side,
            unit.type,
            target,
            false,
            definition.atk * spec.damageRatio,
            unit.id,
            {
                suppressImpactFx: true,
            },
        );
        LaunchImpact.start(sim, target, {
            dx: -dy * sign + dx * 0.25,
            dy: dx * sign + dy * 0.25,
            speed: spec.knockbackSpeed,
            lift: spec.knockbackLift,
            sourceId: unit.id,
            originX: x,
            originY: y,
        });
        sim.events.push({
            type: 'heroRollHit',
            side: unit.side,
            sourceId: unit.id,
            targetId: target.id,
            x: target.x,
            y: target.y,
        });
    }

    static validateState(unit, state, tps) {
        const spec = UnitDefinition.get(unit.type).heroActive;
        const roll = unit.heroRoll;
        const deployed = unit.alive && state.heroes?.[unit.side]?.[unit.type]?.unitId === unit.id;
        if (
            spec
                ? typeof unit.heroRollQueued !== 'boolean' || (unit.heroRollQueued && !deployed)
                : unit.heroRollQueued !== undefined
        )
            throw new Error('게임 snapshot의 영웅 스킬 예약 상태가 잘못되었습니다.');
        if (spec ? roll === null : roll === undefined) return;
        if (
            !spec ||
            !roll ||
            Object.keys(roll).sort().join(',') !==
                'distance,dx,dy,hitIds,phase,phaseEndTick,phaseStartTick,startTick,targetId' ||
            !deployed ||
            !this.canDrive(unit, state.tick) ||
            unit.spinAttack ||
            !Number.isSafeInteger(roll.startTick) ||
            roll.startTick < 0 ||
            !Number.isSafeInteger(roll.phaseStartTick) ||
            roll.phaseStartTick < roll.startTick ||
            roll.phaseStartTick > state.tick ||
            !['hop', 'roll', 'unfold'].includes(roll.phase) ||
            !Number.isFinite(roll.distance) ||
            roll.distance < 0 ||
            roll.distance > spec.rollDistance ||
            !Number.isFinite(roll.dx) ||
            !Number.isFinite(roll.dy) ||
            Math.abs(Math.hypot(roll.dx, roll.dy) - 1) > STOP_EPSILON ||
            typeof roll.targetId !== 'string' ||
            !roll.targetId ||
            roll.targetId.length > 256 ||
            !Array.isArray(roll.hitIds) ||
            roll.hitIds.some((id) => typeof id !== 'string' || !id || id.length > 256) ||
            new Set(roll.hitIds).size !== roll.hitIds.length
        )
            throw new Error('게임 snapshot의 영웅 구르기 상태가 잘못되었습니다.');

        const landingTick = roll.startTick + SimulationTiming.msToTicks(spec.hopMs, tps);
        const { phase, phaseStartTick, phaseEndTick, distance } = roll;
        if (
            (phase === 'hop' &&
                (phaseStartTick !== roll.startTick ||
                    phaseEndTick !== landingTick ||
                    state.tick >= phaseEndTick ||
                    distance !== 0 ||
                    roll.hitIds.length)) ||
            (phase === 'roll' &&
                (phaseStartTick !== landingTick ||
                    phaseEndTick !== null ||
                    distance >= spec.rollDistance - STOP_EPSILON)) ||
            (phase === 'unfold' &&
                (phaseStartTick < landingTick ||
                    phaseEndTick !==
                        phaseStartTick + SimulationTiming.msToTicks(spec.unfoldMs, tps) ||
                    state.tick >= phaseEndTick))
        )
            throw new Error('게임 snapshot의 영웅 구르기 단계가 잘못되었습니다.');
    }
}
