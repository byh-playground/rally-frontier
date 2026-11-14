// Contract (moved from the index.html Development Contract):
// - 도토리 회전은 지속 피해형 공격이다(Definition `sustain`, SustainedAttack): 준비(sustain.windupMs) 뒤
//   sustain.durationMs 동안 sustain.tickMs마다 회전 타격, 회복(sustain.recoverMs) 뒤 sustain.cooldownMs 대기.
//   시간·단계는 Unit.sustain이 소유하고 이 능력은 범위 판정과 타격만 맡는다. 양손 회전·이펙트는 그 단계(phases)를
//   따른다. 도토리의 몸 크기와 회전 반경은 쌀 기준 크기에서 파생한다. 회전 타격마다 가까운 적 지상 병사를
//   최대 세 명 밀쳐낸다. 회전(준비~회복) 중 자발 이동을 멈추되 물리 충격은 정상 적용한다.
//   회복은 일반 근접 병종의 이동 회복과 같은 ms·같은 틱이다.
// - 수박은 병력에 맞힌 범위 평타를 공격당 한 번 센다. 네 번 뒤 다음 병력 공격으로 360도 휩쓸기를
//   시작하고 평타 기본 피해를 사용한다. 휩쓸기는 지속 피해가 아니라(대상마다 한 번) 자기 시간
//   (spinAttack.windupMs·activeMs·recoverMs)과 Unit.spinAttack 상태를 쓴다. 진행 횟수와 회전 상태는
//   저장·복원·리플레이에 포함한다.
import { FP } from '../../core/config.js';
import { KnockbackRules } from '../../definitions/knockback-rules.js';
import { UnitDefinition } from '../../definitions/units.js';
import { HeroGrowth } from '../hero-growth.js';
import { LaunchImpact } from '../launch-impact.js';
import { Knockback } from '../knockback.js';
import { UnitMotion } from '../navigation.js';
import { IndexList } from '../index-list.js';
import { SustainedAttack } from './sustained-attack.js';

// Query lists per call site: a pulse's hits can kill a bursting unit, whose blast queries its own lists.
const START_QUERY = new IndexList(),
    PULSE_QUERY = new IndexList(),
    SWEEP_QUERY = new IndexList();
const INACTIVE = Object.freeze({ active: false, winner: null });

// The unit owns the complete authoritative interval. The caller consumes its
// ordinary movement/target action while this returns true, without pinning the
// unit's position: external impulses and collision resolution remain active.
// A pulsing spin (the acorn) times itself with SustainedAttack (Unit.sustain); an arc sweep (the watermelon) keeps
// its own Unit.spinAttack.
export class UnitSpinAttack {
    // A pulsing spin takes its time from the Definition's sustain block; an arc sweep has its own.
    static validate(d) {
        const spec = d.spinAttack;
        const timing = spec?.arcSweep
            ? ['radius', 'windupMs', 'activeMs', 'recoverMs']
            : ['radius'];
        for (const key of timing) {
            if (!Number.isFinite(spec?.[key]) || spec[key] <= 0)
                throw new TypeError(`회전 공격 설정이 올바르지 않습니다: ${key}`);
        }
        if (!spec.arcSweep && !d.sustain)
            throw new TypeError('회전 타격에는 sustain(지속 피해형 공격의 시간)이 필요합니다.');
        if (
            !spec.arcSweep &&
            (!Number.isSafeInteger(spec.maxUnitHitsPerPulse) || spec.maxUnitHitsPerPulse < 1)
        )
            throw new TypeError('회전 타격의 병사 수 제한이 올바르지 않습니다.');
        if (!Number.isFinite(spec.tangentRatio) || spec.tangentRatio < 0)
            throw new TypeError('회전 공격의 접선 비율이 올바르지 않습니다.');
    }

    // The running spin's stages in ticks (startTick, activeStartTick, activeEndTick, endTick), or null; fills `out`.
    static phases(unit, d, tps, out) {
        if (d.spinAttack.arcSweep) return unit.spinAttack ?? null;
        const sustain = unit.sustain;
        if (!sustain?.active) return null;
        const stages = SustainedAttack.phases(sustain, d.sustain, tps, out);
        out.activeStartTick = stages.durationStartTick;
        out.activeEndTick = stages.durationEndTick;
        return out;
    }

    static heightFP(sim, unit) {
        return UnitMotion.bottomFP(sim, unit) + Math.round(sim.unitRadius(unit) * FP);
    }

    // The caller supplies the same per-side vision field as normal combat.
    // Presence of a hidden enemy alone never initiates an attack.
    static canStart(sim, unit, d, vision) {
        // The block as the hero's level has it (HeroGrowth.spec): the awakening may quicken the rhythm.
        const spec = HeroGrowth.spec(unit, 'spinAttack');
        if (!unit?.alive || !vision) return false;
        if (
            spec.arcSweep
                ? unit.spinAttack || unit.combat.cooldownActive(sim)
                : !SustainedAttack.ready(sim, unit.sustain)
        )
            return false;
        if (
            spec.rhythm &&
            (unit.spinAttackBasicHits < spec.rhythm.basicsPerSweep || !UnitMotion.isGrounded(unit))
        )
            return false;
        const z = this.heightFP(sim, unit);
        const unitCount = sim.nearbyUnits(
            unit.x,
            unit.y,
            spec.radius + sim.maxUnitRadius,
            1 - unit.side,
            START_QUERY,
        );
        for (let k = 0; k < unitCount; k++) {
            const target = sim.units[START_QUERY.items[k]];
            if (
                !target?.alive ||
                !UnitMotion.isGrounded(target) ||
                target.side === unit.side ||
                !sim.canAttackEntity(unit.type, target)
            )
                continue;
            if (!sim.canSeeCombatTarget(unit.side, target, vision)) continue;
            if (this.inReach(sim, unit, target, spec, z)) return true;
        }
        if (spec.arcSweep) return false;
        const buildingCount = sim.nearbyBuildingIndices(
            unit.x,
            unit.y,
            spec.radius + sim.maxBuildingRadius,
            START_QUERY,
        );
        for (let k = 0; k < buildingCount; k++) {
            const target = sim.buildings[START_QUERY.items[k]];
            if (
                !sim.isHostileCombatBuilding(unit.side, target) ||
                !sim.canAttackEntity(unit.type, target, true)
            )
                continue;
            if (!sim.canSeeCombatTarget(unit.side, target, vision)) continue;
            if (
                LaunchImpact.distanceToBody(sim, target, unit.x, unit.y, z, true).surfaceDistance <=
                spec.radius
            )
                return true;
        }
        return false;
    }

    static start(sim, unit, d, vision) {
        this.validate(d);
        if (!this.canStart(sim, unit, d, vision)) return false;
        const spec = d.spinAttack;
        if (spec.arcSweep) {
            const activeStartTick = sim.tick + Math.max(1, sim.msTicks(spec.windupMs));
            const activeEndTick = activeStartTick + Math.max(1, sim.msTicks(spec.activeMs));
            unit.spinAttack = {
                startTick: sim.tick,
                activeStartTick,
                activeEndTick,
                endTick: activeEndTick + Math.max(1, sim.msTicks(spec.recoverMs)),
                hitIds: {},
                lastUpdatedTick: sim.tick - 1,
            };
        } else SustainedAttack.start(sim, unit.sustain, d.sustain);
        sim.events.push({
            type: 'spinStart',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
        });
        return true;
    }

    // Runs a started spin for this tick: true (`active`) while it holds the unit's combat action.
    static update(sim, unit, d) {
        // A hero sweeps with its level's attack (HeroGrowth.atk).
        const spec = d.spinAttack,
            damage = HeroGrowth.atk(unit, d);
        if (!(spec.arcSweep ? unit?.spinAttack : unit?.sustain.active)) return INACTIVE;
        this.validate(d);
        if (!Number.isFinite(damage) || damage <= 0)
            throw new TypeError('회전 공격 피해가 올바르지 않습니다.');
        if (spec.arcSweep) return this.updateSweep(sim, unit, spec, damage);
        if (!unit.alive) {
            this.cancel(sim, unit);
            return INACTIVE;
        }
        // Knocked off its feet: the spin ends here and its cooldown counts in full from this tick.
        if (!UnitMotion.isGrounded(unit)) {
            this.cancel(sim, unit);
            return INACTIVE;
        }
        if (!SustainedAttack.advance(sim, unit.sustain)) {
            this.ended(sim, unit);
            return INACTIVE;
        }
        if (!SustainedAttack.takeTick(sim, unit.sustain, d.sustain))
            return { active: true, winner: null };
        return { active: true, winner: this.pulse(sim, unit, spec, damage) };
    }

    static updateSweep(sim, unit, spec, damage) {
        const spin = unit.spinAttack;
        if (!unit.alive || sim.tick >= spin.endTick) {
            this.cancel(sim, unit);
            return INACTIVE;
        }
        if (spin.lastUpdatedTick === sim.tick) return { active: true, winner: null };
        spin.lastUpdatedTick = sim.tick;
        if (
            sim.tick >= spin.activeStartTick &&
            sim.tick <= spin.activeEndTick &&
            UnitMotion.isGrounded(unit)
        )
            this.updateArcSweep(sim, unit, spec, damage);
        return { active: true, winner: null };
    }

    // One spin hit: the nearest enemy ground soldiers (up to the cap) and every hostile building in reach.
    static pulse(sim, unit, spec, damage) {
        const z = this.heightFP(sim, unit);
        let hits = 0;
        sim.nearbyUnits(
            unit.x,
            unit.y,
            spec.radius + sim.maxUnitRadius,
            1 - unit.side,
            PULSE_QUERY,
        );
        // Nearest target first; stable IDs resolve equal distances.
        PULSE_QUERY.sort((a, b) => {
            const da = (sim.units[a].x - unit.x) ** 2 + (sim.units[a].y - unit.y) ** 2;
            const db = (sim.units[b].x - unit.x) ** 2 + (sim.units[b].y - unit.y) ** 2;
            const left = String(sim.units[a].id),
                right = String(sim.units[b].id);
            return da - db || (left < right ? -1 : left > right ? 1 : 0);
        });
        for (let k = 0; k < PULSE_QUERY.count; k++) {
            const target = sim.units[PULSE_QUERY.items[k]];
            if (
                !target?.alive ||
                !UnitMotion.isGrounded(target) ||
                target.side === unit.side ||
                !sim.canAttackEntity(unit.type, target)
            )
                continue;
            if (!this.inReach(sim, unit, target, spec, z)) continue;
            if (!this.hitUnit(sim, unit, target, spec, damage)) continue;
            hits++;
            if (hits >= spec.maxUnitHitsPerPulse) break;
        }
        let winner = null;
        sim.nearbyBuildingIndices(unit.x, unit.y, spec.radius + sim.maxBuildingRadius, PULSE_QUERY);
        PULSE_QUERY.sort((a, b) => {
            const left = String(sim.buildings[a].id),
                right = String(sim.buildings[b].id);
            return left < right ? -1 : left > right ? 1 : 0;
        });
        for (let k = 0; k < PULSE_QUERY.count; k++) {
            const target = sim.buildings[PULSE_QUERY.items[k]];
            if (
                !sim.isHostileCombatBuilding(unit.side, target) ||
                !sim.canAttackEntity(unit.type, target, true)
            )
                continue;
            if (
                LaunchImpact.distanceToBody(sim, target, unit.x, unit.y, z, true).surfaceDistance >
                spec.radius
            )
                continue;
            const capture = {};
            winner =
                sim.applyDamage(unit.side, unit.type, target, true, damage, unit.id, {
                    capture,
                }) || winner;
            if (capture.dealt > 0) hits++;
        }
        sim.events.push({
            type: 'spinPulse',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
            hits,
        });
        return winner;
    }

    static inReach(sim, unit, target, spec, heightFP) {
        return (
            LaunchImpact.distanceToBody(sim, target, unit.x, unit.y, heightFP).surfaceDistance <=
                spec.radius &&
            (!spec.arcSweep ||
                sim.world.terrain.field.polygonSegmentClear(unit.x, unit.y, target.x, target.y, 0))
        );
    }

    // A basic hit that landed on a soldier (BasicSplash.hit) counts toward the next sweep.
    static countBasic(unit, rhythm) {
        unit.spinAttackBasicHits = Math.min(unit.spinAttackBasicHits + 1, rhythm.basicsPerSweep);
    }

    static hitUnit(sim, unit, target, spec, damage) {
        const rx = target.x - unit.x,
            ry = target.y - unit.y,
            dx = rx - ry * spec.tangentRatio,
            dy = ry + rx * spec.tangentRatio;
        const capture = {};
        sim.applyDamage(unit.side, unit.type, target, false, damage, unit.id, { capture });
        // A dodged swing throws nothing; a lethal one still throws the body.
        if (!(capture.dealt > 0)) return false;
        Knockback.hit(sim, target, {
            dx,
            dy,
            mass: sim.mass(unit),
            speed: KnockbackRules.swingSpeed,
            gain: KnockbackRules.gain.basic,
            sourceId: unit.id,
            originX: unit.x,
            originY: unit.y,
        });
        return true;
    }

    static updateArcSweep(sim, unit, spec, damage) {
        const rhythm = HeroGrowth.spec(unit, 'spinAttack').rhythm;
        if (rhythm && unit.spinAttackBasicHits >= rhythm.basicsPerSweep) {
            unit.spinAttackBasicHits = 0;
            sim.commitAttackTiming(unit, UnitDefinition.get(unit.type));
        }
        const spin = unit.spinAttack;
        const elapsed = sim.tick - spin.activeStartTick;
        const duration = spin.activeEndTick - spin.activeStartTick;
        const from = (Math.PI * Math.max(0, elapsed - 1)) / duration;
        const to = (Math.PI * elapsed) / duration;
        const midpoint = (from + to) / 2;
        const halfArc = (to - from) / 2;
        const heightFP = this.heightFP(sim, unit);
        const found = sim.nearbyUnits(
            unit.x,
            unit.y,
            spec.radius + sim.maxUnitRadius,
            1 - unit.side,
            SWEEP_QUERY,
        );
        for (let k = 0; k < found; k++) {
            const index = SWEEP_QUERY.items[k];
            const target = sim.units[index];
            if (
                !target?.alive ||
                target.side !== 1 - unit.side ||
                Object.hasOwn(spin.hitIds, target.id) ||
                !UnitMotion.isGrounded(target) ||
                !sim.canAttackEntity(unit.type, target) ||
                !this.inReach(sim, unit, target, spec, heightFP)
            )
                continue;
            const dx = target.x - unit.x,
                dy = target.y - unit.y,
                distance = Math.hypot(dx, dy),
                radius = sim.unitRadius(target),
                angle = Math.atan2(dy, dx) - midpoint;
            const padding = distance <= radius ? Math.PI : Math.asin(radius / distance);
            // Doubling folds both opposing arm angles onto the same interval.
            const offset = Math.abs(Math.atan2(Math.sin(2 * angle), Math.cos(2 * angle))) / 2;
            if (offset > halfArc + padding) continue;
            spin.hitIds[target.id] = true;
            this.hitUnit(sim, unit, target, spec, damage);
        }
    }

    // Stops a running spin early (a fall, death, a returning hero); a pulsing spin's cooldown counts from here.
    static cancel(sim, unit) {
        if (unit?.spinAttack) unit.spinAttack = null;
        else if (unit?.sustain?.active && UnitDefinition.get(unit.type).spinAttack)
            SustainedAttack.cut(sim, unit.sustain, UnitDefinition.get(unit.type).sustain);
        else return false;
        this.ended(sim, unit);
        return true;
    }

    static ended(sim, unit) {
        sim.events.push({
            type: 'spinEnd',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
        });
    }
}
