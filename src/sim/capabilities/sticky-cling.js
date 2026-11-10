// Contract (moved from the index.html Development Contract):
// - 찹쌀은 조처럼 건물만 몸통박치기로 공격한다(사거리 25, 기본 접촉 돌진, 반동 없이 짧게 후퇴). 완공된 적 전진 거점(본진·건설 중 제외)에 접촉 판정이
//   성립하면 피해 대신 그 포구에 붙는다(Unit.stickyCling의 buildingId·endTick만 권위 상태). 한 거점에는 한 명만
//   붙고, 붙은 병사만 붙기 시간 동안 멈추며 붙기가 끝난 뒤 재사용 대기 동안 다시 붙지 않는다(시간은 Unit Definition).
//   거점의 정지는 별도 상태 없이 살아 있는 붙은 병사로 계산한다(StickyCling.clingerOf). 정지된 거점은 발사·일제사격
//   참여·대기 연사·포탑 공격을 하지 않고 생산은 계속한다. 병사 사망·거점 파괴·소유 변화로 즉시 풀린다.
//   붙은 병사는 판정 위치를 유지하고 그림만 포구 소켓에 감싼 모습으로 표시하며, 포탑 조준은 붙은 순간의 방향에 고정한다.
//   감싼 모습은 쏘지 못하는 이유를 알리는 유일한 신호라 거점 점령 표식·이름 라벨 위(2D 오버레이)에 그린다.
// A sticky-rice soldier wraps a completed enemy outpost's muzzle for a short time.
// Unit.stickyCling { buildingId, endTick } is the only authoritative state. Whether an outpost
// is jammed is always computed from its living clinger, so death, destruction, capture and
// construction changes release it without a second record.
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';

class StickyCling {
    static initialState() {
        return { buildingId: null, endTick: 0 };
    }
    // Completed enemy outposts only; the main base and construction sites cannot be held.
    static canHold(unit, building) {
        return (
            !!building &&
            building.alive !== false &&
            !building.construction &&
            building.side !== unit.side &&
            BuildingDefinition.get(building.type)?.isOutpost === true
        );
    }
    static holds(state, unit, building) {
        const cling = unit.stickyCling;
        return (
            unit.alive !== false &&
            cling?.buildingId === building.id &&
            Number(state.tick) < cling.endTick &&
            this.canHold(unit, building)
        );
    }
    // Works on the live simulation and on any snapshot: the soldier currently holding this cannon.
    static clingerOf(state, building) {
        if (!building) return null;
        for (const unit of state?.units || []) if (this.holds(state, unit, building)) return unit;
        return null;
    }
    static heldBuilding(state, unit) {
        const id = unit.stickyCling?.buildingId;
        if (id == null) return null;
        const building = (state?.buildings || []).find((candidate) => candidate.id === id);
        return building && this.holds(state, unit, building) ? building : null;
    }
    // A confirmed building contact becomes a cling when the soldier is ready and the muzzle is free.
    static tryBegin(sim, unit, building) {
        const spec = UnitDefinition.get(unit.type)?.stickyCling;
        if (!spec || !this.canHold(unit, building) || this.clingerOf(sim, building)) return false;
        const cling = unit.stickyCling;
        if (cling.buildingId != null && sim.tick < cling.endTick + sim.msTicks(spec.cooldownMs))
            return false;
        unit.stickyCling = {
            buildingId: building.id,
            endTick: sim.tick + sim.msTicks(spec.durationMs),
        };
        unit.contactAttack = null;
        return true;
    }
}

// Bot launch rule (src/sim/capabilities/bot-launch-rules.js): right after threat defense, fire sticky
// rice straight at a completed enemy outpost in range.
StickyCling.botLaunch = Object.freeze({
    capability: 'stickyCling',
    stage: 'opening',
    shot({ state, side, units, cannons, hostile, level, nearestShot }) {
        const outpost = BuildingDefinition.forRole('outpost');
        const clingers = units.filter(
            ({ cost, premiumCost }) =>
                cost <= state.wallet[side] && premiumCost <= state.premiumWallet[side],
        );
        const cling =
            clingers.length &&
            nearestShot(
                cannons,
                hostile.filter((b) => b.type === outpost && !b.construction),
                clingers,
                level,
            );
        return cling ? { shot: cling, unit: cling.units[0] } : null;
    },
});

export { StickyCling };
