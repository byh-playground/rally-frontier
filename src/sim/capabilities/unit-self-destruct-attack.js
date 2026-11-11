// Contract (moved from the index.html Development Contract):
// - 팝콘은 팥의 도약 이동을 사용하되 정점 높이는 약 절반이다. 착지하면 자폭 한 번을 처리하고,
//   이미 가까운 적에게는 기존 준비 동작으로 자폭한다.
// - 자폭은 터지는 몸(자기 질량, KnockbackRules.impactSpeed)의 폭발(gain.burst) 넉백이다. 거리 감쇠는 정의의
//   `knockbackFalloff`가 정한다. 팝콘은 false라 반경 안의 땅에 있는 적이 모두 중심에서 바깥쪽으로 같은 세기로 날아간다.
import { FP } from '../../core/config.js';
import { KnockbackRules } from '../../definitions/knockback-rules.js';
import { LaunchImpact } from '../launch-impact.js';
import { Knockback } from '../knockback.js';
import { UnitDefinition } from '../../definitions/units.js';
import { IndexList } from '../index-list.js';

// drain never runs inside itself (_drainingSelfDestruct), so one list serves every burst.
const BURST_BUILDING_QUERY = new IndexList();

// Each commitment is queued before applying damage. Chain reactions are drained
// synchronously in simulation order, without recursive damage calls.
export class UnitSelfDestructAttack {
    static start(sim, unit, spec) {
        unit.selfDestruct = {
            phase: 'windup',
            startTick: sim.tick,
            endTick: sim.tick + sim.msTicks(spec.windupMs),
        };
        unit.combat.cancelWindup();
        unit.constructionWork = null;
    }

    static update(sim, unit, spec) {
        if (unit.selfDestruct?.phase !== 'windup') return false;
        unit.constructionWork = null;
        if (sim.tick >= unit.selfDestruct.endTick) this.detonate(sim, unit, spec);
        return true;
    }

    static detonate(sim, unit, spec) {
        if (!unit.selfDestruct) this.start(sim, unit, spec);
        this.commit(sim, unit, spec);
        sim.emitUnitDeath(unit, null, null);
        this.drain(sim);
    }

    static onDeath(sim, unit) {
        const spec = UnitDefinition.get(unit.type)?.selfDestruct;
        if (spec && unit.selfDestruct?.phase === 'windup') {
            this.commit(sim, unit, spec);
            this.drain(sim);
        }
    }

    static commit(sim, unit, spec) {
        if (unit.selfDestruct?.phase !== 'windup') return;
        unit.selfDestruct.phase = 'committed';
        (sim._selfDestructQueue ||= []).push({
            x: unit.x,
            y: unit.y,
            side: unit.side,
            sourceId: unit.id,
            sourceType: unit.type,
            mass: sim.mass(unit),
            heightFP:
                Math.round(sim.world.terrain.surfaces.heightAt(unit.x, unit.y) * FP) +
                (unit.impactMotion?.heightFP || 0),
            spec,
        });
    }

    static drain(sim) {
        if (sim._drainingSelfDestruct) return;
        sim._drainingSelfDestruct = true;
        try {
            const queue = sim._selfDestructQueue || [];
            for (let i = 0; i < queue.length; i++) {
                const burst = queue[i],
                    { x, y, side, sourceId, sourceType, mass, heightFP, spec } = burst;
                sim.events.push({
                    type: 'unitSelfDestruct',
                    side,
                    sourceId,
                    sourceType,
                    x,
                    y,
                    zFP: heightFP,
                    radius: spec.radius,
                });
                Knockback.area(sim, {
                    side,
                    sourceId,
                    x,
                    y,
                    radius: spec.radius,
                    impactHeightFP: heightFP,
                    mass,
                    speed: KnockbackRules.impactSpeed,
                    gain: KnockbackRules.gain.burst,
                    falloff: spec.knockbackFalloff,
                });
                sim.applyAreaDamage({
                    sourceSide: side,
                    sourceType,
                    sourceEntityId: sourceId,
                    x,
                    y,
                    radius: spec.radius,
                    damage: spec.damage,
                    damageClass: 'normal',
                    impactHeightFP: heightFP,
                    suppressImpactFx: true,
                });
                const buildingCount = sim.nearbyBuildingIndices(
                    x,
                    y,
                    spec.radius + sim.maxBuildingRadius,
                    BURST_BUILDING_QUERY,
                );
                for (let k = 0; k < buildingCount; k++) {
                    const index = BURST_BUILDING_QUERY.items[k];
                    const building = sim.buildings[index];
                    if (!sim.isHostileCombatBuilding(side, building)) continue;
                    if (
                        LaunchImpact.distanceToBody(sim, building, x, y, heightFP, true)
                            .surfaceDistance > spec.radius
                    )
                        continue;
                    sim.applyDamage(side, sourceType, building, true, spec.damage, sourceId, {
                        damageClass: 'normal',
                        sourceDamageResolved: true,
                        suppressImpactFx: true,
                    });
                }
            }
            queue.length = 0;
        } finally {
            sim._drainingSelfDestruct = false;
        }
    }
}
