import { FP } from '../core/config.js';
import { LaunchImpactRules } from '../definitions/launch-impact-rules.js';
import { LaunchImpact } from './launch-impact.js';
import { HashUtil } from './map-generation.js';
import { UnitMotion } from './navigation.js';

// The unit owns the complete authoritative interval. The caller consumes its
// ordinary movement/target action while this returns true, without pinning the
// unit's position: external impulses and collision resolution remain active.
export class UnitSpinAttack {
    static validate(spec) {
        for (const key of ['radius', 'windupMs', 'activeMs', 'recoverMs', 'knockbackSpeed']) {
            if (!Number.isFinite(spec?.[key]) || spec[key] <= 0)
                throw new TypeError(`회전 공격 설정이 올바르지 않습니다: ${key}`);
        }
        if (spec.arcSweep) {
            if (!Number.isSafeInteger(spec.minTargets) || spec.minTargets < 1)
                throw new TypeError('회전 공격에 필요한 표적 수가 올바르지 않습니다.');
        } else if (!Number.isFinite(spec.pulseMs) || spec.pulseMs <= 0) {
            throw new TypeError('회전 공격 간격이 올바르지 않습니다.');
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
        let found = 0;
        const minTargets = spec.minTargets ?? 1;
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
                        !UnitMotion.isGrounded(target) ||
                        target.side === unit.side ||
                        !sim.canAttackEntity(unit.type, target)
                    )
                        continue;
                    if (!sim.canSeeCombatTarget(unit.side, target, vision)) continue;
                    if (!this.inReach(sim, unit, target, spec, z)) continue;
                    if (++found >= minTargets) break;
                }
            },
        );
        if (found >= minTargets) return true;
        if (spec.arcSweep) return false;
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
            ...(spec.arcSweep ? { hitIds: {} } : { nextPulseTick: activeStartTick }),
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
        if (spec.arcSweep) {
            if (
                sim.tick >= spin.activeStartTick &&
                sim.tick <= spin.activeEndTick &&
                UnitMotion.isGrounded(unit)
            )
                this.updateArcSweep(sim, unit, spec, damage);
            return { active: true, winner: null };
        }
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
                // Nearest target first; stable IDs resolve equal distances.
                indices.sort((a, b) => {
                    const da = (sim.units[a].x - unit.x) ** 2 + (sim.units[a].y - unit.y) ** 2;
                    const db = (sim.units[b].x - unit.x) ** 2 + (sim.units[b].y - unit.y) ** 2;
                    const left = String(sim.units[a].id),
                        right = String(sim.units[b].id);
                    return da - db || (left < right ? -1 : left > right ? 1 : 0);
                });
                for (const index of indices) {
                    const target = sim.units[index];
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
                    break;
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

    static inReach(sim, unit, target, spec, heightFP) {
        return (
            LaunchImpact.distanceToBody(sim, target, unit.x, unit.y, heightFP).surfaceDistance <=
                spec.radius &&
            (!spec.arcSweep ||
                sim.world.terrain.field.polygonSegmentClear(unit.x, unit.y, target.x, target.y, 0))
        );
    }

    static hitUnit(sim, unit, target, spec, damage) {
        const rx = target.x - unit.x,
            ry = target.y - unit.y,
            dx = rx - ry * spec.tangentRatio,
            dy = ry + rx * spec.tangentRatio;
        const capture = {};
        sim.applyDamage(unit.side, unit.type, target, false, damage, unit.id, { capture });
        if (!(capture.dealt > 0)) return false;
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
            // Lethal hits keep their impulse until the common corpse lifecycle retires the unit.
            const angle = ((HashUtil.hash(target.id + '|' + unit.id) % 8) * Math.PI) / 4;
            const distance = Math.hypot(dx, dy);
            const nx = distance ? dx / distance : Math.cos(angle);
            const ny = distance ? dy / distance : Math.sin(angle);
            const mass = LaunchImpactRules.referenceMass;
            sim.navigation.motion.applyImpulse(
                target,
                {
                    x: nx * spec.knockbackSpeed * mass,
                    y: ny * spec.knockbackSpeed * mass,
                    z: (spec.knockbackLift || 0) * mass,
                },
                {
                    kind: 'knockback',
                    sourceId: unit.id,
                    originX: unit.x,
                    originY: unit.y,
                },
            );
        }
        return true;
    }

    static updateArcSweep(sim, unit, spec, damage) {
        const spin = unit.spinAttack;
        const elapsed = sim.tick - spin.activeStartTick;
        const duration = spin.activeEndTick - spin.activeStartTick;
        const from = (Math.PI * Math.max(0, elapsed - 1)) / duration;
        const to = (Math.PI * elapsed) / duration;
        const midpoint = (from + to) / 2;
        const halfArc = (to - from) / 2;
        const heightFP = this.heightFP(sim, unit);
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
                        radius = sim.unitRadius(target.type),
                        angle = Math.atan2(dy, dx) - midpoint;
                    const padding = distance <= radius ? Math.PI : Math.asin(radius / distance);
                    // Doubling folds both opposing arm angles onto the same interval.
                    const offset =
                        Math.abs(Math.atan2(Math.sin(2 * angle), Math.cos(2 * angle))) / 2;
                    if (offset > halfArc + padding) continue;
                    spin.hitIds[target.id] = true;
                    this.hitUnit(sim, unit, target, spec, damage);
                }
            },
        );
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
