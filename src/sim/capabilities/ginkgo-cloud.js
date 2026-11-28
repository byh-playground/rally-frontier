import { FP } from '../../core/config.js';
import { UnitDefinition } from '../../definitions/units.js';
import { IndexList } from '../index-list.js';
import { UnitMotion } from '../navigation.js';

const CANDIDATES = new IndexList();

// The impact creates a ground area with one lifetime. Movement reads the active circle directly.
// Each cloud's first pulse is after one interval and its last is at expiry, before removal.
// One shared deadline for each target prevents simultaneous or staggered overlaps from dealing
// damage more often than the declared interval.
export class GinkgoCloud {
    static create(sim, shot) {
        const spec = UnitDefinition.get(shot.sourceType)?.ginkgoCloud;
        if (!spec) return;
        const { x, y } = shot;
        const surfaces = sim.world.terrain.surfaces;
        const effect = (sim.ginkgoEffect ||= { clouds: [], nextDamage: {} });
        effect.clouds.push({
            id: shot.id,
            sourceId: shot.sourceId,
            sourceType: shot.sourceType,
            side: shot.side,
            x,
            y,
            zFP: Math.round(surfaces.heightAt(x, y) * FP),
            level: surfaces.levelAt(x, y),
            radius: spec.radius,
            startTick: sim.tick,
            endTick: sim.tick + sim.time.ceilTicks(spec.durationMs),
        });
    }

    static contains(cloud, unit, surfaces) {
        return (
            unit.side !== cloud.side &&
            (unit.x - cloud.x) ** 2 + (unit.y - cloud.y) ** 2 <= cloud.radius ** 2 &&
            surfaces.levelAt(unit.x, unit.y) === cloud.level
        );
    }

    static moveScale(sim, unit) {
        const effect = sim.ginkgoEffect;
        if (!effect || !UnitMotion.isGrounded(unit)) return 1;
        const surfaces = sim.world.terrain.surfaces;
        let slowPct = 0;
        for (const cloud of effect.clouds) {
            if (sim.tick > cloud.endTick || !this.contains(cloud, unit, surfaces)) continue;
            slowPct = Math.max(slowPct, UnitDefinition.get(cloud.sourceType).ginkgoCloud.slowPct);
        }
        return 1 - slowPct / 100;
    }

    static update(sim) {
        const effect = sim.ginkgoEffect;
        if (!effect) return;
        // Keep the phase in tickTime's integer units to prevent rounding from
        // doubling or skipping a pulse at uncommon tick rates.
        const tickUnits = sim.time.start(1000) / sim.tps;
        const tickClock = sim.tick * tickUnits;
        const surfaces = sim.world.terrain.surfaces;
        const nextDamage = effect.nextDamage;
        for (const [targetId, deadline] of Object.entries(nextDamage))
            if (deadline <= tickClock - tickUnits) delete nextDamage[targetId];

        let write = 0;
        for (const cloud of effect.clouds) {
            const spec = UnitDefinition.get(cloud.sourceType).ginkgoCloud;
            const age = tickClock - cloud.startTick * tickUnits;
            const interval = sim.time.start(spec.tickMs);
            const pulse = Math.floor(age / interval);
            if (
                sim.tick <= cloud.endTick &&
                pulse > 0 &&
                pulse !== Math.floor((age - tickUnits) / interval)
            ) {
                const clock = cloud.startTick * tickUnits + pulse * interval;
                this.pulse(sim, cloud, spec, surfaces, clock, interval, nextDamage);
            }
            if (sim.tick < cloud.endTick) effect.clouds[write++] = cloud;
        }
        effect.clouds.length = write;
        if (!write) delete sim.ginkgoEffect;
    }

    static pulse(sim, cloud, spec, surfaces, clock, interval, nextDamage) {
        const { x, y, sourceId, sourceType, side, radius } = cloud;
        const damage = spec.totalDamage / 2 / (spec.durationMs / spec.tickMs);
        const count = sim.nearbyHostileUnits(side, x, y, radius, CANDIDATES);
        let announced = false;
        for (let i = 0; i < count; i++) {
            const unit = sim.units[CANDIDATES.items[i]];
            if (
                !unit?.alive ||
                nextDamage[unit.id] > clock ||
                !UnitMotion.isGrounded(unit) ||
                !this.contains(cloud, unit, surfaces)
            )
                continue;
            nextDamage[unit.id] = clock + interval;
            if (!announced) {
                sim.events.push({
                    type: 'ginkgoCloudPulse',
                    cloudId: cloud.id,
                    x,
                    y,
                    zFP: cloud.zFP,
                    radius,
                    side,
                    sourceId,
                    sourceType,
                });
                announced = true;
            }
            sim.applyDamage(side, sourceType, unit, false, damage, sourceId, {
                damageClass: 'normal',
                damageDelivery: 'continuous',
                deliverySeconds: spec.tickMs / 1000,
                sourceDamageResolved: true,
                suppressImpactFx: true,
                ambient: true,
            });
        }
    }

    static view(sim) {
        return sim.ginkgoEffect?.clouds.map((cloud) => ({ ...cloud })) || [];
    }

    static validate(state) {
        if (!Object.hasOwn(state, 'ginkgoEffect')) return;
        const effect = state.ginkgoEffect;
        if (
            !effect ||
            !Array.isArray(effect.clouds) ||
            !effect.clouds.length ||
            !effect.nextDamage ||
            typeof effect.nextDamage !== 'object' ||
            Array.isArray(effect.nextDamage) ||
            Object.values(effect.nextDamage).some((tick) => !Number.isSafeInteger(tick) || tick < 0)
        )
            throw new Error('은행 악취 장판 상태가 잘못되었습니다.');
        const ids = new Set();
        for (const cloud of effect.clouds) {
            if (
                !cloud ||
                typeof cloud.id !== 'string' ||
                ids.has(cloud.id) ||
                typeof cloud.sourceId !== 'string' ||
                UnitDefinition.get(cloud.sourceType)?.ginkgoCloud?.radius !== cloud.radius ||
                (cloud.side !== 0 && cloud.side !== 1) ||
                ![cloud.x, cloud.y, cloud.radius, cloud.zFP].every(Number.isFinite) ||
                ![cloud.level, cloud.startTick, cloud.endTick].every(Number.isSafeInteger) ||
                cloud.startTick < 0 ||
                cloud.startTick > state.tick ||
                cloud.endTick <= state.tick
            )
                throw new Error('은행 악취 장판의 위치나 시간이 잘못되었습니다.');
            ids.add(cloud.id);
        }
    }
}
