import { FP } from '../core/config.js';
import { LaunchImpact } from './launch-impact.js';
import { UnitDefinition } from '../definitions/units.js';

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
        if (sim.tick >= unit.selfDestruct.endTick) {
            this.commit(sim, unit, spec);
            sim.emitUnitDeath(unit, null, null);
            this.drain(sim);
        }
        return true;
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
                    { x, y, side, sourceId, sourceType, heightFP, spec } = burst;
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
                LaunchImpact.radialImpulse(sim, {
                    side,
                    sourceId,
                    x,
                    y,
                    radius: spec.radius,
                    impactHeightFP: heightFP,
                    scale: spec.impulseScale,
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
                for (const index of sim.nearbyBuildingIndices(
                    x,
                    y,
                    spec.radius + sim.maxBuildingRadius,
                )) {
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
