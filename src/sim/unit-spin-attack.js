import { FP } from '../core/config.js';
import { LaunchImpactRules } from '../definitions/launch-impact-rules.js';
import { LaunchImpact } from './launch-impact.js';
import { HashUtil } from './map-generation.js';

// The unit owns the complete authoritative interval. The caller consumes its
// ordinary movement/target action while this returns true, without pinning the
// unit's position: external impulses and collision resolution remain active.
export class UnitSpinAttack {
    static validate(spec) {
        for (const key of [
            'radius',
            'windupMs',
            'activeMs',
            'recoverMs',
            'pulseMs',
            'knockbackSpeed',
        ]) {
            if (!Number.isFinite(spec?.[key]) || spec[key] <= 0)
                throw new TypeError(`회전 공격 설정이 올바르지 않습니다: ${key}`);
        }
        if (!Number.isFinite(spec.tangentRatio) || spec.tangentRatio < 0)
            throw new TypeError('회전 공격의 접선 비율이 올바르지 않습니다.');
        if (
            spec.knockbackLift != null &&
            (!Number.isFinite(spec.knockbackLift) || spec.knockbackLift < 0)
        )
            throw new TypeError('회전 공격의 수직 충격량이 올바르지 않습니다.');
    }

    static heightFP(sim, unit) {
        return (
            Math.round(sim.world.terrain.surfaces.heightAt(unit.x, unit.y) * FP) +
            (Number(unit.impactMotion?.heightFP) || 0) +
            Math.round(sim.unitRadius(unit.type) * FP)
        );
    }

    // The caller supplies the same per-side vision field as normal combat.
    // Presence of a hidden enemy alone never initiates an attack.
    static canStart(sim, unit, spec, vision) {
        if (!unit?.alive || !vision || unit.spinAttack || unit.combat.cooldownActive(sim))
            return false;
        const z = this.heightFP(sim, unit);
        let found = false;
        sim.withNearbyUnits(
            unit.x,
            unit.y,
            spec.radius + sim.maxUnitRadius,
            1 - unit.side,
            (indices) => {
                for (const index of indices) {
                    const target = sim.units[index];
                    if (
                        !target?.alive ||
                        target.side === unit.side ||
                        !sim.canAttackEntity(unit.type, target)
                    )
                        continue;
                    if (!sim.canSeeCombatTarget(unit.side, target, vision)) continue;
                    if (
                        LaunchImpact.distanceToBody(sim, target, unit.x, unit.y, z)
                            .surfaceDistance <= spec.radius
                    ) {
                        found = true;
                        break;
                    }
                }
            },
        );
        if (found) return true;
        for (const index of sim.nearbyBuildingIndices(
            unit.x,
            unit.y,
            spec.radius + sim.maxBuildingRadius,
        )) {
            const target = sim.buildings[index];
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

    static start(sim, unit, spec, vision) {
        this.validate(spec);
        if (!this.canStart(sim, unit, spec, vision)) return false;
        const activeStartTick = sim.tick + Math.max(1, sim.msTicks(spec.windupMs));
        const activeEndTick = activeStartTick + Math.max(1, sim.msTicks(spec.activeMs));
        unit.spinAttack = {
            startTick: sim.tick,
            activeStartTick,
            activeEndTick,
            endTick: activeEndTick + Math.max(1, sim.msTicks(spec.recoverMs)),
            nextPulseTick: activeStartTick,
            lastUpdatedTick: sim.tick - 1,
        };
        sim.events.push({
            type: 'spinStart',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
        });
        return true;
    }

    static update(sim, unit, spec, damage) {
        const spin = unit?.spinAttack;
        if (!spin) return { active: false, winner: null };
        this.validate(spec);
        if (!Number.isFinite(damage) || damage <= 0)
            throw new TypeError('회전 공격 피해가 올바르지 않습니다.');
        if (!unit.alive || sim.tick >= spin.endTick) {
            unit.spinAttack = null;
            sim.events.push({
                type: 'spinEnd',
                side: unit.side,
                sourceId: unit.id,
                x: unit.x,
                y: unit.y,
            });
            return { active: false, winner: null };
        }
        if (spin.lastUpdatedTick === sim.tick) return { active: true, winner: null };
        spin.lastUpdatedTick = sim.tick;
        if (sim.tick < spin.nextPulseTick || sim.tick >= spin.activeEndTick)
            return { active: true, winner: null };

        const z = this.heightFP(sim, unit);
        let hits = 0;
        sim.withNearbyUnits(
            unit.x,
            unit.y,
            spec.radius + sim.maxUnitRadius,
            1 - unit.side,
            (indices) => {
                // Tie-break by entity ID so equal-tick deaths and emitted events do
                // not depend on grid traversal order.
                indices.sort((a, b) => {
                    const left = String(sim.units[a].id),
                        right = String(sim.units[b].id);
                    return left < right ? -1 : left > right ? 1 : 0;
                });
                for (const index of indices) {
                    const target = sim.units[index];
                    if (
                        !target?.alive ||
                        target.side === unit.side ||
                        !sim.canAttackEntity(unit.type, target)
                    )
                        continue;
                    const body = LaunchImpact.distanceToBody(sim, target, unit.x, unit.y, z);
                    if (body.surfaceDistance > spec.radius) continue;
                    const rx = target.x - unit.x,
                        ry = target.y - unit.y,
                        dx = rx - ry * spec.tangentRatio,
                        dy = ry + rx * spec.tangentRatio;
                    const capture = {};
                    sim.applyDamage(unit.side, unit.type, target, false, damage, unit.id, {
                        capture,
                    });
                    if (!(capture.dealt > 0)) continue;
                    hits++;
                    if (target.alive) {
                        LaunchImpact.start(sim, target, {
                            dx,
                            dy,
                            speed: spec.knockbackSpeed,
                            lift: spec.knockbackLift || 0,
                            sourceId: unit.id,
                            originX: unit.x,
                            originY: unit.y,
                        });
                    } else {
                        // Preserve physical momentum for a lethal hit as the existing
                        // corpse lifecycle keeps units that still have impactMotion.
                        const angle =
                            ((HashUtil.hash(target.id + '|' + unit.id) % 8) * Math.PI) / 4;
                        const distance = Math.hypot(dx, dy);
                        const nx = distance ? dx / distance : Math.cos(angle);
                        const ny = distance ? dy / distance : Math.sin(angle);
                        sim.navigation.motion.applyImpulse(
                            target,
                            {
                                x: nx * spec.knockbackSpeed * LaunchImpactRules.referenceMass,
                                y: ny * spec.knockbackSpeed * LaunchImpactRules.referenceMass,
                                z: (spec.knockbackLift || 0) * LaunchImpactRules.referenceMass,
                            },
                            {
                                kind: 'knockback',
                                sourceId: unit.id,
                                originX: unit.x,
                                originY: unit.y,
                            },
                        );
                    }
                }
            },
        );
        let winner = null;
        const buildings = sim
            .nearbyBuildingIndices(unit.x, unit.y, spec.radius + sim.maxBuildingRadius)
            .slice();
        buildings.sort((a, b) => {
            const left = String(sim.buildings[a].id),
                right = String(sim.buildings[b].id);
            return left < right ? -1 : left > right ? 1 : 0;
        });
        for (const index of buildings) {
            const target = sim.buildings[index];
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
        spin.nextPulseTick = sim.tick + Math.max(1, sim.msTicks(spec.pulseMs));
        sim.events.push({
            type: 'spinPulse',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
            hits,
        });
        return { active: true, winner };
    }

    static cancel(sim, unit) {
        if (!unit?.spinAttack) return false;
        unit.spinAttack = null;
        sim.events.push({
            type: 'spinEnd',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
        });
        return true;
    }
}
