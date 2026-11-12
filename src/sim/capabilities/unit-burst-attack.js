// Contract (moved from the index.html Development Contract):
// - 해바라기씨 연사는 지속 피해형 공격이다(Definition `sustain`, SustainedAttack): 전투 준비(attackWindupMs)로
//   표적을 조준한 뒤 sustain.durationMs 동안 sustain.tickMs마다 한 발(첫 발은 시작한 틱), 연사가 끝나면
//   sustain.cooldownMs 재장전. 발 수는 durationMs/tickMs에서 나온다. 시간·발사 틱은 Unit.sustain이 소유하고 이
//   능력은 표적 고정·발사·피해만 맡는다.
// - 보이는 적 투입탄을 우선하고 지상 표적도 공격한다. 멈춰서 한 표적에 연사한다. 쏠 발이 남은 동안만 서 있고
//   마지막 발 뒤에는 (재장전 중이라도) 움직일 수 있다. 고정한 표적이 죽거나 보이지 않거나 사거리를 벗어나거나
//   넘어지면 연사를 거둔다(SustainedAttack.cut: 그 틱에 끝나고 재장전을 그 틱부터 처음부터 센다).
// - combat.burstAttack { targetId, targetKind, aimX, aimY, aimHeightFP }는 고정한 표적과 조준점이다(재장전이
//   끝나면 지운다). 총과 두 손은 표적 방향을 공유한다. 사격 수·마지막 사격 틱은 Unit.sustain에서 읽어 총구가
//   반동하고 탄띠가 줄어든다(SustainedAttack.tickCount·lastTick).
import { UnitMotion } from '../navigation.js';
import { FP } from '../../core/config.js';
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { LaunchImpact } from '../launch-impact.js';
import { LaunchInterception } from '../launch-interception.js';
import { SustainedAttack } from './sustained-attack.js';

const INACTIVE = Object.freeze({ active: false, winner: null });

// A burst commits to one target. The normal combat loop chooses and prepares
// its first shot; subsequent shots keep that target while it remains legal.
export class UnitBurstAttack {
    static start(sim, unit, target, targetKind, definition) {
        unit.combat.burstAttack = {
            targetId: target.id,
            targetKind,
            aimX: target.x,
            aimY: target.y,
            aimHeightFP: this.aimHeightFP(sim, target, targetKind),
        };
        SustainedAttack.start(sim, unit.sustain, definition.sustain);
        return this.shoot(sim, unit, target, definition);
    }

    // True (`active`) while shots remain: the unit stands and keeps its target.
    static update(sim, unit, definition, vision) {
        const sustain = unit.sustain;
        SustainedAttack.advance(sim, sustain);
        if (!SustainedAttack.ticking(sim, sustain, definition.sustain)) {
            if (SustainedAttack.ready(sim, sustain)) delete unit.combat.burstAttack;
            return INACTIVE;
        }
        const burst = unit.combat.burstAttack;
        const target = this.lockedTarget(sim, unit, burst, definition, vision);
        if (!target) {
            this.cancel(sim, unit, definition);
            return INACTIVE;
        }
        burst.aimX = target.x;
        burst.aimY = target.y;
        burst.aimHeightFP = this.aimHeightFP(sim, target, burst.targetKind);
        return { active: true, winner: this.shoot(sim, unit, target, definition) };
    }

    static cancel(sim, unit, definition) {
        SustainedAttack.cut(sim, unit.sustain, definition.sustain);
    }

    static lockedTarget(sim, unit, burst, definition, vision) {
        if (burst.targetKind === 'projectile') {
            const target = LaunchInterception.target(
                sim,
                unit,
                definition.burstAttack.airRange,
                vision,
                burst.targetId,
            );
            return target?.id === burst.targetId ? target : null;
        }
        const target = sim.liveEntityRefById(burst.targetId, burst.targetKind)?.entity,
            isBuilding = burst.targetKind === 'building';
        if (
            !sim.canSeeCombatTarget(unit.side, target, vision) ||
            !sim.canAttackEntity(unit.type, target, isBuilding) ||
            (!isBuilding && !sim.canTargetUnit(unit.side, target))
        )
            return null;
        const distance = Math.hypot(target.x - unit.x, target.y - unit.y);
        return distance <= sim.interactionDistance(unit, target, 'attack', definition.range)
            ? target
            : null;
    }

    static aimHeightFP(sim, target, kind) {
        // An air target is a shell or a flying unit; the flying unit aims like any unit body (its lift included).
        if (kind === 'projectile' && target.payload)
            return Math.round(LaunchImpact.projectileHeight(sim, target, target.x, target.y) * FP);
        const ground = sim.world.terrain.surfaces.heightAt(target.x, target.y);
        if (kind === 'building')
            return Math.round((ground + (BuildingDefinition.get(target.type)?.size || 0) / 2) * FP);
        return (
            Math.round((ground + (UnitDefinition.get(target.type)?.size || 0)) * FP) +
            UnitMotion.heightFP(target)
        );
    }

    // One shot on this tick's damage tick, if it is one.
    static shoot(sim, unit, target, definition) {
        if (!SustainedAttack.takeTick(sim, unit.sustain, definition.sustain)) return null;
        const spec = definition.burstAttack,
            burst = unit.combat.burstAttack;
        unit.attackFlash = 1;
        sim.events.push({
            type: 'unitBurstShot',
            sourceId: unit.id,
            sourceType: unit.type,
            side: unit.side,
            fromX: unit.x,
            fromY: unit.y,
            fromHeightFP: Math.round(
                (sim.world.terrain.surfaces.heightAt(unit.x, unit.y) + definition.size) * FP,
            ),
            x: burst.aimX,
            y: burst.aimY,
            heightFP: burst.aimHeightFP,
            targetId: burst.targetId,
            targetKind: burst.targetKind,
        });
        let winner = null;
        if (burst.targetKind === 'projectile')
            LaunchInterception.hit(sim, unit, target, definition.atk * spec.airDamageMultiplier);
        else
            winner = sim.applyDamage(
                unit.side,
                unit.type,
                target,
                burst.targetKind === 'building',
                Math.floor(definition.atk),
                unit.id,
                { damageClass: UnitDefinition.damageClass(unit.type) },
            );
        if (target.alive === false || target.hp <= 0) this.cancel(sim, unit, definition);
        return winner;
    }
}
