import { UnitDefinition } from '../../definitions/units.js';
import { IndexList } from '../index-list.js';
import { UnitMotion } from '../navigation.js';

const CANDIDATES = new IndexList();
const ACID_HIT = Object.freeze({
    damageClass: 'normal',
    sourceDamageResolved: true,
    suppressImpactFx: true,
});

// Each landed drop contributes one independently timed stack. At capacity, the next drop displaces
// the oldest stack. The attacking side owns the mark, even after the shooter has been removed.
export class PlumAcid {
    static splash(sim, shot, spec) {
        const { x, y, sourceType, sourceId, side, damage } = shot;
        const level = sim.terrainLevelAt(x, y);
        const radiusSquared = spec.radius ** 2;
        const count = sim.nearbyHostileUnits(side, x, y, spec.radius, CANDIDATES);
        const capture = {};
        const impact = { ...ACID_HIT, capture };
        for (let index = 0; index < count; index++) {
            const target = sim.units[CANDIDATES.items[index]];
            if (
                !sim.isHostileCombatUnit(side, target) ||
                !UnitMotion.isGrounded(target) ||
                (target.x - x) ** 2 + (target.y - y) ** 2 > radiusSquared ||
                sim.terrainLevelAt(target.x, target.y) !== level
            )
                continue;
            capture.dealt = 0;
            sim.applyDamage(side, sourceType, target, false, damage, sourceId, impact);
            if (capture.dealt > 0) this.mark(sim, target, sourceType, side);
        }
    }

    static mark(sim, target, sourceType, side) {
        const spec = UnitDefinition.get(sourceType)?.plumAcid;
        if (!spec || !sim.isHostileCombatUnit(side, target) || !UnitMotion.isGrounded(target))
            return;
        const state = (sim.plumAcid ||= {});
        const current = Object.hasOwn(state, target.id) ? state[target.id] : null;
        const mark =
            current?.side === side && current.sourceType === sourceType
                ? current
                : (state[target.id] = { side, sourceType, expires: [] });
        this.expire(mark.expires, sim.tick);
        if (mark.expires.length >= spec.maxStacks) mark.expires.shift();
        mark.expires.push(sim.tick + sim.time.ceilTicks(spec.durationMs));
    }

    static expire(expires, now) {
        while (expires.length && expires[0] <= now) expires.shift();
    }

    static count(sim, target) {
        const mark = sim.plumAcid?.[target.id];
        if (!mark || target.side !== 1 - mark.side) return 0;
        return mark.expires.reduce((count, tick) => count + (tick > sim.tick ? 1 : 0), 0);
    }

    static bonus(sim, target, sourceSide, sourceType, options) {
        const mark = sim.plumAcid?.[target.id];
        if (
            !mark ||
            mark.side !== sourceSide ||
            options?.ambient ||
            options?.damageDelivery === 'continuous' ||
            options?.damageDelivery === 'status' ||
            options?.damageDelivery === 'launch-shell' ||
            UnitDefinition.get(sourceType)?.plumAcid
        )
            return 0;
        return this.count(sim, target) * UnitDefinition.get(mark.sourceType).plumAcid.bonusPerStack;
    }

    static update(sim) {
        const state = sim.plumAcid;
        if (!state) return;
        for (const [id, mark] of Object.entries(state)) {
            this.expire(mark.expires, sim.tick);
            if (!mark.expires.length || !sim.isHostileCombatUnit(mark.side, sim.unitById.get(id)))
                delete state[id];
        }
        if (!Object.keys(state).length) delete sim.plumAcid;
    }

    static view(sim) {
        const marks = [];
        for (const [targetId, mark] of Object.entries(sim.plumAcid || {})) {
            const target = sim.unitById.get(targetId);
            if (!sim.isHostileCombatUnit(mark.side, target)) continue;
            const expires = mark.expires.filter((tick) => tick > sim.tick);
            if (!expires.length) continue;
            marks.push({
                id: targetId,
                targetId,
                side: mark.side,
                x: target.x,
                y: target.y,
                zFP: UnitMotion.bottomFP(sim, target),
                count: expires.length,
                expires,
            });
        }
        return marks;
    }

    static validate(state) {
        if (!Object.hasOwn(state, 'plumAcid')) return;
        const marks = state.plumAcid;
        if (
            !marks ||
            typeof marks !== 'object' ||
            Array.isArray(marks) ||
            !Object.keys(marks).length ||
            !Array.isArray(state.units)
        )
            throw new Error('매실 산성 표식 상태가 잘못되었습니다.');
        const targets = new Map(state.units.map((target) => [target?.id, target]));
        for (const [id, mark] of Object.entries(marks)) {
            const spec = UnitDefinition.get(mark?.sourceType)?.plumAcid;
            const target = targets.get(id);
            if (
                !spec ||
                (mark.side !== 0 && mark.side !== 1) ||
                !target?.alive ||
                target.side !== 1 - mark.side ||
                target.sporeSac !== undefined ||
                target.subdued === true ||
                !Array.isArray(mark.expires) ||
                !mark.expires.length ||
                mark.expires.length > spec.maxStacks ||
                mark.expires.some(
                    (tick, index) =>
                        !Number.isSafeInteger(tick) ||
                        tick <= state.tick ||
                        (index > 0 && tick < mark.expires[index - 1]),
                )
            )
                throw new Error('매실 산성 표식의 진영이나 시간이 잘못되었습니다.');
        }
    }
}
