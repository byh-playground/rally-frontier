// Contract (HeroAllyAura):
// - 영웅 정의의 `growth[레벨].allyAura { radius, refreshMs, takenScale?, movePct?, regen? }`는 그 레벨부터 영웅 둘레
//   radius 안의 지상 아군 유닛(영웅 자신 제외)이 받는 버프다(HeroGrowth.unlocked, 정의 검사는 defineUnit).
// - 대상은 매 틱 다시 세지 않는다. 틱 처음(색인을 다시 만든 직후) refreshMs마다 한 번 아군 공간 색인
//   (StrategySim.nearbyUnits)으로 둘레를 질의해 id 순으로 정렬한 목록(`heroAura.allyIds`)에 담고, 다음 갱신까지 그
//   목록이 대상이다. 영웅이 전사·회수되면 목록을 비운다(HeroDeployment.endSortie).
// - `takenScale`: 대상이 적에게 받는 피해의 비율. 일반 필드 `damageTaken`(참깨·호두)과 같은 계산 지점에서 곱해
//   한 번만 내림한다(StrategySim.applyDamage, 최소 1). `movePct`: 대상의 이동 속도 백분율. 시한 효과의 이동 속도
//   (StrategySim.timedModifierPct 'movePct')와 같은 자리에서 가장 큰 값을 쓴다. `regen { intervalMs, percent, min }`:
//   intervalMs마다(처음은 켜진 틱) 대상이 최대 체력의 percent%(내림, 최소 min)를 최대 체력까지 회복한다.
// - 회복마다 `heroAuraHeal` 사건을 낸다. 발밑 표시는 영웅 상태의 `allyIds`를 읽는다.
import { UnitDefinition } from '../../definitions/units.js';
import { HeroGrowth } from '../hero-growth.js';
import { IndexList } from '../index-list.js';
import { LaunchRules } from '../launch-rules.js';

const ALLY_QUERY = new IndexList();
const STATE_KEYS = 'allyIds,refreshTick,regenTick';
const MAX_ALLIES = 4096;

function hasId(sorted, id) {
    let low = 0,
        high = sorted.length - 1;
    while (low <= high) {
        const mid = (low + high) >> 1,
            value = sorted[mid];
        if (value === id) return true;
        if (value < id) low = mid + 1;
        else high = mid - 1;
    }
    return false;
}

export class HeroAllyAura {
    static declared(type) {
        const growth = UnitDefinition.get(type)?.growth;
        return Object.values(growth || {}).some((unlocks) => unlocks.allyAura);
    }

    static initialState() {
        return { refreshTick: 0, regenTick: 0, allyIds: [] };
    }

    static endSortie(unit) {
        if (unit.heroAura) unit.heroAura = this.initialState();
    }

    // Once per tick, right after the runtime indexes are rebuilt: each deployed hero with its aura unlocked
    // refreshes its targets when due, and heals them when its regen is due.
    static update(sim) {
        for (const heroes of sim.heroes)
            for (const type of LaunchRules.heroTypes) {
                const unitId = heroes[type]?.unitId;
                if (unitId == null) continue;
                const unit = sim.unitById.get(unitId);
                if (!unit?.alive || !unit.heroAura) continue;
                const spec = HeroGrowth.unlocked(unit, 'allyAura');
                if (!spec) continue;
                const aura = unit.heroAura;
                if (sim.tick >= aura.refreshTick) {
                    aura.allyIds = this.query(sim, unit, spec.radius);
                    aura.refreshTick = sim.tick + sim.msTicks(spec.refreshMs);
                }
                if (spec.regen && sim.tick >= aura.regenTick) {
                    this.regen(sim, unit, aura.allyIds, spec.regen);
                    aura.regenTick = sim.tick + sim.msTicks(spec.regen.intervalMs);
                }
            }
    }

    static query(sim, unit, radius) {
        const found = sim.nearbyUnits(unit.x, unit.y, radius, unit.side, ALLY_QUERY);
        const ids = [];
        for (let k = 0; k < found; k++) {
            const ally = sim.units[ALLY_QUERY.items[k]];
            if (!ally?.alive || ally === unit) continue;
            if ((ally.x - unit.x) ** 2 + (ally.y - unit.y) ** 2 <= radius * radius)
                ids.push(ally.id);
        }
        return ids.sort();
    }

    static regen(sim, unit, allyIds, { percent, min }) {
        const healed = [];
        for (const id of allyIds) {
            const ally = sim.unitById.get(id);
            if (!ally?.alive || ally.hp <= 0) continue;
            // The body's full health: a hero ally's rises with its level (HeroGrowth.maxHp).
            const maxHp = ally.maxHp,
                before = ally.hp;
            ally.hp = Math.min(maxHp, ally.hp + Math.max(min, Math.floor((maxHp * percent) / 100)));
            if (ally.hp > before) healed.push({ id, x: ally.x, y: ally.y, heal: ally.hp - before });
        }
        if (healed.length)
            sim.events.push({
                type: 'heroAuraHeal',
                side: unit.side,
                sourceId: unit.id,
                unit: unit.type,
                healed,
            });
    }

    // The aura spec of each living hero of `u`'s side whose current targets include `u`, folded by `fold`.
    static fold(sim, u, field, initial, fold) {
        let value = initial;
        const heroes = sim.heroes[u.side];
        if (!heroes) return value;
        for (const type of LaunchRules.heroTypes) {
            const unitId = heroes[type]?.unitId;
            if (unitId == null || unitId === u.id) continue;
            const hero = sim.unitById.get(unitId);
            const ids = hero?.heroAura?.allyIds;
            if (!ids?.length || !hero.alive || !hasId(ids, u.id)) continue;
            const spec = HeroGrowth.unlocked(hero, 'allyAura');
            if (spec?.[field] !== undefined) value = fold(value, spec[field]);
        }
        return value;
    }

    // The share of enemy damage `u` takes from the auras around it (1 without one).
    static takenScale(sim, u) {
        return this.fold(sim, u, 'takenScale', 1, (a, b) => a * b);
    }

    // The move speed percentage the auras around `u` give it (100 without one).
    static movePct(sim, u) {
        return this.fold(sim, u, 'movePct', 100, Math.max);
    }

    static validateState(unit, state) {
        const aura = unit.heroAura;
        if (!this.declared(unit.type) && aura === undefined) return;
        const deployed = unit.alive && state.heroes?.[unit.side]?.[unit.type]?.unitId === unit.id;
        const ids = aura?.allyIds;
        if (
            !this.declared(unit.type) ||
            !aura ||
            Object.keys(aura).sort().join(',') !== STATE_KEYS ||
            !Number.isSafeInteger(aura.refreshTick) ||
            aura.refreshTick < 0 ||
            !Number.isSafeInteger(aura.regenTick) ||
            aura.regenTick < 0 ||
            !Array.isArray(ids) ||
            ids.length > MAX_ALLIES ||
            ids.some(
                (id, i) =>
                    typeof id !== 'string' || !id || id === unit.id || (i > 0 && ids[i - 1] >= id),
            ) ||
            (!deployed && (ids.length || aura.refreshTick || aura.regenTick))
        )
            throw new Error('게임 snapshot의 영웅 주변 버프 상태가 잘못되었습니다.');
    }
}
