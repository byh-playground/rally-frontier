// Contract (moved from the index.html Development Contract):
// - 수박의 구르는 몸은 Definition `rollAttack { speed, hitRadius, unfoldMs, damageRatio }`이다. 구르기는 두 가지다.
//   착지 공격(HeroLandingStrike)의 빠지기(`mode: 'retreat'`)는 도약 없이 바로 구르고, 길 위 적 병력에게
//   공격력 × damageRatio를 준다. 5레벨 자동 한 방의 공성 구르기(`mode: 'siege'`, HeroUltimate `siegeRoll`)는 제자리
//   도약(hopMs)을 마치고 착지한 틱에 둘레를 울린 뒤(landing) 몸을 bodyScale배로 키운 채 siegeRoll.speed로
//   distance만큼 굴러, 길 위 적 병력에게 damage를 주고 쳐 내며, 처음 부딪힌 적 건물에 buildingDamage를 주고 멈춘다.
// - 착지한 틱부터 월드 이동과 충돌을 판정하며, 정지하면 몸을 편다. 한 번 구르는 거리는 구르기 상태의 `length`다.
//   각 단계와 이미 맞힌 대상은 저장·복원·리플레이에 포함한다.
import { FP } from '../../core/config.js';
import { RallyGamekit } from '../../core/gamekit.js';
import { SimulationTiming } from '../../core/simulation-timing.js';
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { KnockbackRules } from '../../definitions/knockback-rules.js';
import { Knockback } from '../knockback.js';
import { HeroGrowth } from '../hero-growth.js';
import { HeroLandingStrike } from './hero-landing-strike.js';
import { UnitMotion } from '../navigation.js';
import { IndexList } from '../index-list.js';

const SWEEP_QUERY = new IndexList(),
    BUILDING_QUERY = new IndexList();
const ROLL_KEYS =
    'buildingHitIds,distance,dx,dy,hitIds,length,mode,phase,phaseEndTick,phaseStartTick,startTick';

const { SweptCircleContact } = RallyGamekit;
const CONTACT = { ...SweptCircleContact.policies.relative, retreat: 0 };
// Out buffer of the roll's swept contact test; read right after each cast.
const CONTACT_HIT = { t: 0, nx: 0, ny: 0, degenerate: false };
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

    static canStart(unit, tick) {
        return (
            !unit.heroRoll &&
            !unit.spinAttack &&
            !unit.combat.attackWindupUntil &&
            this.canDrive(unit, tick)
        );
    }

    // The level-5 siege roll (HeroUltimate `siegeRoll`): a hop in place, then a roll along (dx, dy).
    static siege(sim, unit, dx, dy, spec) {
        this.start(sim, unit, 'siege', dx, dy, spec.distance);
        unit.heroRoll.phase = 'hop';
        unit.heroRoll.phaseEndTick = sim.tick + sim.msTicks(spec.hopMs);
        unit.combat.attackArcTargetId = null;
        unit.combat.attackArcUntilTick = 0;
    }

    // A roll with no hop, straight along (dx, dy) for `length` (the landing strike's retreat).
    static retreat(sim, unit, dx, dy, length) {
        this.start(sim, unit, 'retreat', dx, dy, length);
    }

    static start(sim, unit, mode, dx, dy, length) {
        unit.heroRoll = {
            mode,
            startTick: sim.tick,
            phase: 'roll',
            phaseStartTick: sim.tick,
            phaseEndTick: null,
            distance: 0,
            length,
            dx,
            dy,
            hitIds: [],
            buildingHitIds: [],
        };
        unit.combat.cancelWindup();
        unit.constructionWork = null;
        unit.target = null;
    }

    // What the rolling body is in this roll: its speed, hit radius, unit damage and building damage (0: none).
    static rollSpec(unit, roll, definition) {
        const body = definition.rollAttack;
        if (roll.mode !== 'siege')
            return {
                speed: body.speed,
                hitRadius: body.hitRadius * HeroGrowth.bodyScale(unit),
                damage: definition.atk * body.damageRatio,
                buildingDamage: 0,
            };
        const siege = HeroGrowth.declared(unit.type, 'ultimate').siegeRoll;
        return {
            speed: siege.speed,
            hitRadius: body.hitRadius * HeroGrowth.bodyScale(unit) * siege.bodyScale,
            damage: siege.damage,
            buildingDamage: siege.buildingDamage,
        };
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
        const spec = this.rollSpec(unit, roll, definition);
        const { x, y } = unit;
        const { dx, dy } = roll;
        const terrainRadius = sim.unitRadius(unit);
        const rollHitRadius = spec.hitRadius;
        const step = Math.min(spec.speed / sim.tps, roll.length - roll.distance);
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
        const { blocked, distance: traced } = sim.navigation.traceStraightTravel(
            x,
            y,
            dx,
            dy,
            step,
            terrainRadius,
        );
        // A siege roll stops at the first enemy building its body meets, and hits it.
        const building = spec.buildingDamage
            ? this.buildingContact(sim, unit, roll, x, y, vx, vy, step, rollHitRadius)
            : null;
        const struck = !!building && building.distance <= traced;
        const wallDistance = struck ? building.distance : traced;
        const contacts = [];
        const found = sim.nearbyUnits(
            x,
            y,
            wallDistance + rollHitRadius + sim.maxUnitRadius,
            1 - unit.side,
            SWEEP_QUERY,
        );
        for (let k = 0; k < found; k++) {
            const index = SWEEP_QUERY.items[k];
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
            const reach = rollHitRadius + sim.unitRadius(target);
            const hitTime =
                rx ** 2 + ry ** 2 <= reach ** 2
                    ? 0
                    : SweptCircleContact.cast(rx, ry, vx, vy, reach, CONTACT, CONTACT_HIT)
                      ? CONTACT_HIT.t
                      : null;
            if (hitTime == null) continue;
            const distance = hitTime * step;
            if (distance > wallDistance + STOP_EPSILON) continue;
            const hitX = x + dx * distance;
            const hitY = y + dy * distance;
            if (!sim.navigation.field.segmentClear(hitX, hitY, target.x, target.y, 0)) continue;
            contacts.push({ target, distance, hitX, hitY });
        }
        contacts.sort((a, b) => a.distance - b.distance || (a.target.id < b.target.id ? -1 : 1));
        for (const { target, distance, hitX, hitY } of contacts) {
            if (!target.alive || !UnitMotion.isGrounded(target)) continue;
            roll.hitIds.push(target.id);
            advanceTo(distance);
            this.hit(sim, unit, target, spec, hitX, hitY);
            // Detonating a primed enemy can still kill the hero.
            if (!unit.heroRoll) return;
        }

        advanceTo(wallDistance);
        roll.distance = Math.min(roll.length, roll.distance + wallDistance);
        if (struck) {
            roll.buildingHitIds.push(building.target.id);
            this.hitBuilding(sim, unit, building.target, spec.buildingDamage);
            if (!unit.heroRoll) return;
        }
        if (blocked || struck || roll.distance >= roll.length - STOP_EPSILON) {
            if (!blocked && !struck) roll.distance = roll.length;
            roll.phase = 'unfold';
            roll.phaseStartTick = sim.tick;
            roll.phaseEndTick = sim.tick + sim.msTicks(definition.rollAttack.unfoldMs);
        }
    }

    // The nearest living enemy building the rolling body touches within this step (its swept circle against the
    // building's footprint): { target, distance } or null.
    static buildingContact(sim, unit, roll, x, y, vx, vy, step, hitRadius) {
        const found = sim.nearbyBuildingIndices(
            x,
            y,
            step + hitRadius + sim.maxBuildingRadius,
            BUILDING_QUERY,
        );
        let best = null;
        for (let k = 0; k < found; k++) {
            const target = sim.buildings[BUILDING_QUERY.items[k]];
            if (
                !target ||
                target.alive === false ||
                target.side !== 1 - unit.side ||
                roll.buildingHitIds.includes(target.id)
            )
                continue;
            const rx = x - target.x,
                ry = y - target.y,
                reach = hitRadius + (BuildingDefinition.get(target.type)?.size || 30);
            const hitTime =
                rx ** 2 + ry ** 2 <= reach ** 2
                    ? 0
                    : SweptCircleContact.cast(rx, ry, vx, vy, reach, CONTACT, CONTACT_HIT)
                      ? CONTACT_HIT.t
                      : null;
            if (hitTime == null) continue;
            const distance = hitTime * step;
            if (
                !best ||
                distance < best.distance ||
                (distance === best.distance && target.id < best.target.id)
            )
                best = { target, distance };
        }
        return best;
    }

    static hitBuilding(sim, unit, target, damage) {
        const capture = {};
        sim.applyDamage(unit.side, unit.type, target, true, damage, unit.id, { capture });
        sim.events.push({
            type: 'heroRollBuildingHit',
            side: unit.side,
            sourceId: unit.id,
            mode: unit.heroRoll.mode,
            targetId: target.id,
            building: target.type,
            x: target.x,
            y: target.y,
            dealt: capture.dealt ?? 0,
        });
    }

    // The siege roll's touchdown after its hop: the ground shakes around the hero.
    static land(sim, unit) {
        const { radius, damage } = HeroGrowth.declared(unit.type, 'ultimate').siegeRoll.landing;
        const { x, y, side } = unit;
        // The landing shock shoves the enemies around a little before it hurts them.
        const hits = HeroLandingStrike.blast(sim, unit, {
            x,
            y,
            radius,
            damage,
            knockback: 'splash',
            impactHeightFP: Math.round(sim.world.terrain.surfaces.heightAt(x, y) * FP),
        });
        sim.events.push({ type: 'heroRollLand', side, sourceId: unit.id, x, y, radius, hits });
    }

    // The rolling body strikes the target along the contact normal (from where it touched to the target) before
    // the damage, so a target the hit kills is thrown too.
    static hit(sim, unit, target, spec, x, y) {
        Knockback.hit(sim, target, {
            dx: target.x - x,
            dy: target.y - y,
            mass: sim.mass(unit),
            speed: spec.speed,
            gain: KnockbackRules.gain.roll,
            sourceId: unit.id,
            originX: x,
            originY: y,
        });
        const capture = {};
        sim.applyDamage(unit.side, unit.type, target, false, spec.damage, unit.id, {
            suppressImpactFx: true,
            capture,
        });
        sim.events.push({
            type: 'heroRollHit',
            side: unit.side,
            sourceId: unit.id,
            mode: unit.heroRoll?.mode ?? null,
            targetId: target.id,
            x: target.x,
            y: target.y,
            dealt: capture.dealt ?? 0,
        });
    }

    static validateState(unit, state, tps) {
        const body = UnitDefinition.get(unit.type).rollAttack;
        const roll = unit.heroRoll;
        if (body ? roll === null : roll === undefined) return;
        const deployed = unit.alive && state.heroes?.[unit.side]?.[unit.type]?.unitId === unit.id;
        const siege = HeroGrowth.declared(unit.type, 'ultimate')?.siegeRoll;
        const validIds = (ids) =>
            Array.isArray(ids) &&
            !ids.some((id) => typeof id !== 'string' || !id || id.length > 256) &&
            new Set(ids).size === ids.length;
        if (
            !body ||
            !roll ||
            Object.keys(roll).sort().join(',') !== ROLL_KEYS ||
            !deployed ||
            !this.canDrive(unit, state.tick) ||
            unit.spinAttack ||
            !Number.isSafeInteger(roll.startTick) ||
            roll.startTick < 0 ||
            !Number.isSafeInteger(roll.phaseStartTick) ||
            roll.phaseStartTick < roll.startTick ||
            roll.phaseStartTick > state.tick ||
            !['hop', 'roll', 'unfold'].includes(roll.phase) ||
            !(roll.mode === 'retreat' || (roll.mode === 'siege' && siege)) ||
            !Number.isFinite(roll.distance) ||
            roll.distance < 0 ||
            !(roll.length > 0) ||
            roll.distance > roll.length ||
            (roll.mode === 'siege' && roll.length !== siege.distance) ||
            !Number.isFinite(roll.dx) ||
            !Number.isFinite(roll.dy) ||
            Math.abs(Math.hypot(roll.dx, roll.dy) - 1) > STOP_EPSILON ||
            // Only a siege roll hops, and only it hits a building (one, then it stops).
            (roll.phase === 'hop' && roll.mode !== 'siege') ||
            !validIds(roll.hitIds) ||
            !validIds(roll.buildingHitIds) ||
            roll.buildingHitIds.length > (roll.mode === 'siege' ? 1 : 0)
        )
            throw new Error('게임 snapshot의 영웅 구르기 상태가 잘못되었습니다.');

        // The tick the roll itself began: after the hop, or at once for a retreat roll.
        const rollStartTick =
            roll.mode === 'siege'
                ? roll.startTick + SimulationTiming.msToTicks(siege.hopMs, tps)
                : roll.startTick;
        const { phase, phaseStartTick, phaseEndTick, distance } = roll;
        if (
            (phase === 'hop' &&
                (phaseStartTick !== roll.startTick ||
                    phaseEndTick !== rollStartTick ||
                    state.tick >= phaseEndTick ||
                    distance !== 0 ||
                    roll.hitIds.length)) ||
            (phase === 'roll' &&
                (phaseStartTick !== rollStartTick ||
                    phaseEndTick !== null ||
                    distance >= roll.length - STOP_EPSILON)) ||
            (phase === 'unfold' &&
                (phaseStartTick < rollStartTick ||
                    phaseEndTick !==
                        phaseStartTick + SimulationTiming.msToTicks(body.unfoldMs, tps) ||
                    state.tick >= phaseEndTick))
        )
            throw new Error('게임 snapshot의 영웅 구르기 단계가 잘못되었습니다.');
    }
}
