// Contract (index.html Development Contract에서 이 능력으로 옮긴 규칙):
// - 나는 병종(Unit Definition `flight`)은 투입 뒤 한 번만 난다. 땅에 떨어진 투입 넉백이 끝나면 떠올라 지상 유닛이
//   걸어갈 목표(교전 목표, 없으면 집결 지점)로 맵 안에서 곧장 날아간다. 벽·절벽·건물·유닛에 막히지 않는다.
// - 적(유닛·건물)이 자기 공격 사거리에 들어오거나 날아갈 목적지(교전 목표 점·집결 지점 + 자기 대형 차이)에 닿으면
//   그 자리에 내려앉는다. 사거리 판정(지형 선 등)이 거짓이어도 목적지에 닿으면 내려앉는다. 그 자리가 벽·건물에
//   막혔으면 가장 가까운 빈 땅으로 날아가 내려앉고, 빈 땅이 없으면 그 자리에 내려앉는다. 내려앉으면 끝까지 지상
//   유닛이고 다시 뜨지 않는다(걸어가 싸운다). 투입 직후 이미 적이 사거리 안이면 뜨지 않는다.
// - 대형: 투입 묶음의 중심(UnitFlight.formation, 터진 자리)과 이륙 시점 자기 위치의 차이를 들고 간다. 묶음
//   전체의 목표는 그 차이를 뺀 자리에서 고르고, 각자 목표 + 차이로 같은 속도로 곧장 난다. 공중 충돌 해소는
//   없다(결정적). 표적이 달라 갈라지는 것과 맵 가장자리에서 눌리는 것은 그대로 둔다. 표적이 없는 동안은 매 틱
//   표적을 골라, 무리가 각자의 갱신 틱이 아니라 함께 적 쪽으로 꺾는다.
// - 나는 동안(`fly`·`alight`)은 땅의 표적 선택·공격·범위 피해·넉백·충돌·점령·건설에서 빠지고, 대공(canAttackAir:
//   LaunchInterception, 적 투입탄 다음 순위)만 맞는다. 공격하지 않는다.
// - Unit.flight { phase, altitudeFP, landFx, landFy, originFx, originFy, offFx, offFy }만 권위 상태다(저장·해시).
//   고도는 지면 위 몸 높이에 더해진다(UnitMotion.heightFP). 내려앉기와 나는 동안의 죽음은 고도를 넉백 높이(impactMotion)로 바꿔 공용 중력으로
//   떨어뜨린다. 그래서 낙하·죽은 몸 표현(DeadUnitLook)이 지상 넉백과 같다.
import { FP } from '../../core/config.js';
import { UnitMotion } from '../navigation.js';

// Phases: 'wait' (on the ground after the launch, not flown yet), 'fly', 'alight' (flying to the open spot it lands on),
// 'landed' (a ground unit for good).
const WAIT = 'wait',
    FLY = 'fly',
    ALIGHT = 'alight',
    LANDED = 'landed';
// Out point of a flight step and of the open-spot search; read before the next call.
const SPOT = { x: 0, y: 0 };

class UnitFlight {
    static initialState() {
        return {
            phase: WAIT,
            altitudeFP: 0,
            landFx: 0,
            landFy: 0,
            originFx: null,
            originFy: null,
            offFx: 0,
            offFy: 0,
        };
    }
    // The centre of the launch group a flier came out of (the burst point, or a placed block's centre): the
    // formation it keeps in the air is its takeoff position's difference from here.
    static formation(unit, x, y) {
        if (!unit.flight) return;
        unit.flight.originFx = Math.round(x * FP);
        unit.flight.originFy = Math.round(y * FP);
    }
    // In the air: out of ground targeting, damage, knockback, contacts, capture and construction.
    static airborne(unit) {
        const phase = unit?.flight?.phase;
        return phase === FLY || phase === ALIGHT;
    }
    // One tick of a flight-capable unit, before its ordinary combat. True when the flight used the tick.
    static step(sim, unit, spec, vision) {
        const flight = unit.flight;
        if (flight.phase === LANDED) return false;
        if (flight.phase === WAIT) {
            // Thrown out of the shell: the ordinary ground code waits for the throw to settle.
            if (!UnitMotion.isGrounded(unit)) return false;
            const found = this.target(sim, unit, vision);
            if (found && sim.combatTargetInAttackRange(unit, found)) {
                flight.phase = LANDED;
                return false;
            }
            if (unit.impactMotion) return false;
            flight.phase = FLY;
            if (flight.originFx != null) {
                flight.offFx = unit.fx - flight.originFx;
                flight.offFy = unit.fy - flight.originFy;
            }
            unit.combat.cancelWindup();
            unit.constructionWork = null;
            sim.syncUnitSpatial(unit);
        }
        flight.altitudeFP = Math.min(
            spec.altitude * FP,
            flight.altitudeFP + Math.round((spec.climbSpeed * FP) / sim.tps),
        );
        if (flight.phase === ALIGHT) {
            if (this.flyToward(sim, unit, flight.landFx / FP, flight.landFy / FP, spec.speed))
                this.land(sim, unit);
            return true;
        }
        const found = this.target(sim, unit, vision);
        unit.target = found ? found.entity.id : null;
        if (found && sim.combatTargetInAttackRange(unit, found)) {
            this.alight(sim, unit);
            return true;
        }
        // The group's goal is picked from where the group's centre would be, then each flier heads for its own
        // place in the formation. Reaching it lands the flier even when the range check stays false (a terrain
        // line, or a goal point outside the range): it walks the rest as a ground unit.
        const ox = (flight.offFx || 0) / FP,
            oy = (flight.offFy || 0) / FP;
        let gx, gy;
        if (found) {
            const point = sim
                .engagementGoal(unit, found.entity, sim.basicAttackRange(unit))
                .closest(unit.x - ox, unit.y - oy);
            gx = point ? point.x : found.entity.x;
            gy = point ? point.y : found.entity.y;
        } else {
            // Nobody to fight: it lands where it would have walked to (a hold point, or the enemy base).
            const rally = sim.unitRallyPoint(unit);
            gx = rally.x;
            gy = rally.y;
        }
        if (this.flyToward(sim, unit, gx + ox, gy + oy, spec.speed)) this.alight(sim, unit);
        return true;
    }
    // The walking soldier's own choice: a full pick on its refresh tick, the kept target otherwise. A flier holding
    // no target picks every tick, so a flock turns toward the enemy together instead of one by one on each
    // flier's own refresh tick (which would bend the formation it keeps).
    static target(sim, unit, vision) {
        return sim.combatTargetRefreshDue(unit) || (unit.target == null && this.airborne(unit))
            ? sim.pickCombatTarget(unit, vision)
            : sim.retainedCombatTarget(unit, vision);
    }
    // Straight toward (tx, ty), first kept inside the map by the body's radius, at `speed`. True on arrival.
    static flyToward(sim, unit, tx, ty, speed) {
        const radius = sim.unitRadius(unit),
            dx = Math.min(sim.world.width - radius, Math.max(radius, tx)) - unit.x,
            dy = Math.min(sim.world.height - radius, Math.max(radius, ty)) - unit.y,
            distance = Math.hypot(dx, dy),
            step = speed / sim.tps,
            t = distance <= step ? 1 : step / distance;
        SPOT.x = unit.x + dx * t;
        SPOT.y = unit.y + dy * t;
        const oldX = unit.fx,
            oldY = unit.fy;
        sim.navigation.motion.commit(unit, SPOT);
        if (unit.fx !== oldX || unit.fy !== oldY) unit.movement.lastMoveTick = sim.tick;
        return distance <= step;
    }
    // Lands here when the ground is open (walls, cliffs and buildings), else flies to the nearest open spot first;
    // with no open spot near, it lands here anyway rather than staying up.
    static alight(sim, unit) {
        const radius = sim.unitRadius(unit),
            navigation = sim.navigation;
        navigation.sync();
        if (navigation.field.pointClear(unit.x, unit.y, radius)) {
            this.land(sim, unit);
            return;
        }
        if (!navigation.field.nearestExterior(unit.x, unit.y, radius, null, SPOT)) {
            this.land(sim, unit);
            return;
        }
        const flight = unit.flight;
        flight.phase = ALIGHT;
        flight.landFx = Math.round(SPOT.x * FP);
        flight.landFy = Math.round(SPOT.y * FP);
    }
    // The fluff comes off: the altitude becomes a fall under the shared gravity and the unit is on the ground for good.
    static land(sim, unit) {
        const heightFP = this.drop(sim, unit);
        sim.syncUnitSpatial(unit);
        sim.events.push({
            type: 'flightLand',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x,
            y: unit.y,
            heightFP,
        });
    }
    // A unit killed in the air falls from where it was hit (the shared flying-corpse fall and look).
    static onDeath(sim, unit) {
        if (this.airborne(unit)) this.drop(sim, unit);
    }
    static drop(sim, unit) {
        const flight = unit.flight,
            heightFP = flight.altitudeFP,
            motion = sim.navigation.motion;
        flight.phase = LANDED;
        flight.altitudeFP = 0;
        if (heightFP > 0) {
            motion.impactRecord(unit, heightFP);
            motion.markImpact(unit, 'landing', unit.id, unit.x, unit.y);
        }
        return heightFP;
    }
}

export { UnitFlight };
