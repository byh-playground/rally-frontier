// Contract (moved from the index.html Development Contract):
// - 해바라기씨는 보이는 적 투입탄을 우선하고 지상 표적도 공격한다. 멈춰서 한 표적에 연사하고 재장전한다.
//   총과 두 손은 표적 방향을 공유한다. 표시 시각의 사격 횟수에 맞춰 총구가 반동하고 탄띠가 줄어든다.
import { FP } from '../../core/config.js';
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { LaunchImpact } from '../launch-impact.js';
import { LaunchInterception } from '../launch-interception.js';

// A burst commits to one target. The normal combat loop chooses and prepares
// its first shot; subsequent shots keep that target while it remains legal.
export class UnitBurstAttack {
    static start(sim, unit, target, targetKind, definition) {
        const burst = {
            targetId: target.id,
            targetKind,
            aimX: target.x,
            aimY: target.y,
            aimHeightFP: this.aimHeightFP(sim, target, targetKind),
            shotsFired: 0,
            nextShotTick: sim.tick,
            lastShotTick: null,
        };
        unit.combat.burstAttack = burst;
        return this.fire(sim, unit, target, burst, definition);
    }

    static update(sim, unit, definition, vision) {
        const burst = unit.combat.burstAttack;
        if (burst.nextShotTick === null) {
            if (!unit.combat.cooldownActive(sim)) delete unit.combat.burstAttack;
            return { active: false, winner: null };
        }
        const target = this.lockedTarget(sim, unit, burst, definition, vision);
        if (!target) {
            this.cancel(sim, unit, definition);
            return { active: false, winner: null };
        }
        burst.aimX = target.x;
        burst.aimY = target.y;
        burst.aimHeightFP = this.aimHeightFP(sim, target, burst.targetKind);
        const winner =
            sim.tick >= burst.nextShotTick ? this.fire(sim, unit, target, burst, definition) : null;
        return { active: true, winner };
    }

    static cancel(sim, unit, definition) {
        const burst = unit.combat.burstAttack;
        if (burst?.nextShotTick == null) return;
        burst.nextShotTick = null;
        unit.combat.cooldownUntil = sim.tick + Math.max(1, sim.msTicks(definition.cooldownMs));
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
            !sim.canAttackEntity(unit.type, target, isBuilding)
        )
            return null;
        const distance = Math.hypot(target.x - unit.x, target.y - unit.y);
        return distance <= sim.interactionDistance(unit, target, 'attack', definition.range)
            ? target
            : null;
    }

    static aimHeightFP(sim, target, kind) {
        if (kind === 'projectile')
            return Math.round(LaunchImpact.projectileHeight(sim, target, target.x, target.y) * FP);
        const ground = sim.world.terrain.surfaces.heightAt(target.x, target.y);
        if (kind === 'building')
            return Math.round((ground + (BuildingDefinition.get(target.type)?.size || 0) / 2) * FP);
        return (
            Math.round((ground + (UnitDefinition.get(target.type)?.size || 0)) * FP) +
            (target.impactMotion?.heightFP || 0)
        );
    }

    static fire(sim, unit, target, burst, definition) {
        const spec = definition.burstAttack;
        burst.shotsFired++;
        burst.lastShotTick = sim.tick;
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
            shot: burst.shotsFired,
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
        if (burst.shotsFired >= spec.shots || target.alive === false || target.hp <= 0)
            this.cancel(sim, unit, definition);
        else burst.nextShotTick = sim.tick + Math.max(1, sim.msTicks(spec.shotGapMs));
        return winner;
    }
}
