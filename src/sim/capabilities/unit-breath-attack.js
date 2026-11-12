// Contract (index.html Development Contract에서 이 능력으로 옮긴 규칙):
// - 불 뿜기(Unit Definition `breathAttack`, 고추)는 지속 피해형 공격이다(`sustain`, SustainedAttack): 멈춰 서서
//   조준 방향으로 부채꼴 불줄기(길이 `length`, 전체 각 `arcDegrees`)를 `sustain.durationMs` 동안 뿜고, 그동안
//   `sustain.tickMs`마다 불줄기에 몸(원)이 닿은 적 모두에게 `atk`를 준다(건물은 `buildingDamageScale`배, 소수는
//   회차마다 누적해 내림). 끝나면 `sustain.cooldownMs` 동안 다시 뿜지 못한다.
// - 표적은 평소 표적 선택(가장 가까운 적)이 고르고, 그 표적이 공격 사거리 안이면 걷지 않고 조준을 초당
//   `turnDegreesPerSecond`로 돌린다. 재사용 대기가 끝났고 표적이 불줄기 안에 들어오면 뿜기 시작한다. 한 번 시작한
//   뿜기는 표적이 죽거나 사거리를 벗어나도 끝까지 서서 뿜는다(표적이 사거리 밖이면 그쪽으로 조준을 돌리고, 표적이
//   없으면 조준을 그대로 둔다). 대기 중에는 다른 원거리 병종의 쿨다운처럼 사거리 안이면 서서 조준만 돌리고, 밖이면
//   다가간다. 표적이 없으면 걸어갈 집결 지점 쪽으로 조준을 돌린다. 처음 조준이 정해지지 않았으면(0, 0) 처음 바라볼
//   방향으로 바로 정한다. 넘어지면(지면을 떠나면) 그 뿜기는 끝난다.
// - 불줄기의 반지름 방향 끝은 기존 공격 사거리(InteractionGeometry.reach, Definition range = length - 자기 반경)와
//   같고, 지형 선(벽·절벽)은 표적마다 기존 판정(sim.interactionDistance, requiresTerrainLine)을 다시 쓴다. 그래서
//   불줄기가 닿는 적과 "사거리 안" 표적이 같은 규칙이다.
// - 지상 적만 탄다: 적 진영의 지상 층(공간 격자 그룹)만 질의하고 canTargetUnit이 나는 유닛을 거른다. 아군·투입탄·
//   나는 적에는 닿지 않는다. 넉백은 없다. 피해는 applyDamage(피해 종류·출처·통계·숫자)를 지난다.
// - Unit.breath { aimX, aimY (AIM_UNIT 길이 정수 벡터), pulses }와 Unit.sustain(뿜는 중·남은 틱·대기)이 권위
//   상태다(저장·해시). 피해 틱마다 breathPulse 사건(불줄기 가운데 점, 맞힌 수)을 그 회차의 hit보다 먼저 낸다(피해
//   숫자 합치기).
// - 그림: 불줄기는 sprite 계약의 `breath.drawFlame`으로 main.js가 그린다(sustain.active인 동안, 보간한 조준).
//   대기 중(sustain.readyTick 전)에는 입을 다물고 연기를 낸다.
import { COLLISION_RADIUS_SCALE } from '../../definitions/world-rules.js';
import { InteractionGeometry } from '../navigation.js';
import { IndexList } from '../index-list.js';
import { SustainedAttack } from './sustained-attack.js';

// The aim is an integer vector of this length (about 0.006° per step).
const AIM_UNIT = 10000;
const DEGREE = Math.PI / 180;
const UNIT_QUERY = new IndexList(),
    BUILDING_QUERY = new IndexList();
// Every breath hit: no impact sparks per pulse (the flame itself shows the hit), the shared damage path otherwise.
const HIT = Object.freeze({ suppressImpactFx: true });

class UnitBreathAttack {
    static initialState() {
        return { aimX: 0, aimY: 0, pulses: 0 };
    }
    // A placed unit (debug and card scenes) starts aiming along its facing.
    static aim(unit, x, y) {
        if (unit.breath) this.setAim(unit.breath, x, y);
    }
    static setAim(breath, x, y) {
        const length = Math.sqrt(x * x + y * y);
        if (!length) return;
        breath.aimX = Math.round((x / length) * AIM_UNIT);
        breath.aimY = Math.round((y / length) * AIM_UNIT);
    }
    // Turns the aim toward (dx, dy) by at most one tick's turn; an unset aim takes it at once.
    static turnToward(sim, breath, spec, dx, dy) {
        const want2 = dx * dx + dy * dy;
        if (!want2) return;
        const ax = breath.aimX,
            ay = breath.aimY;
        if (!ax && !ay) {
            this.setAim(breath, dx, dy);
            return;
        }
        const step = (spec.turnDegreesPerSecond * DEGREE) / sim.tps,
            c = Math.cos(step),
            dot = ax * dx + ay * dy;
        if (dot > 0 && dot >= c * Math.sqrt((ax * ax + ay * ay) * want2)) {
            this.setAim(breath, dx, dy);
            return;
        }
        // Exactly behind turns counter-clockwise.
        const s = ax * dy - ay * dx < 0 ? -Math.sin(step) : Math.sin(step);
        this.setAim(breath, ax * c - ay * s, ax * s + ay * c);
    }
    // Not breathing and no target in reach: the aim follows where the unit is heading (a target, or its rally point).
    static idle(sim, unit, spec, x, y) {
        this.turnToward(sim, unit.breath, spec, x - unit.x, y - unit.y);
    }
    // Is a breath still running this tick (SustainedAttack)? It then stands and keeps breathing (burn) wherever its
    // target went.
    static burning(sim, unit) {
        return SustainedAttack.advance(sim, unit.sustain);
    }
    // A running breath without a target in reach: it keeps burning along its aim, turning toward (x, y) when given.
    static burn(sim, unit, d, x = null, y = null) {
        if (x !== null) this.turnToward(sim, unit.breath, d.breathAttack, x - unit.x, y - unit.y);
        return SustainedAttack.takeTick(sim, unit.sustain, d.sustain)
            ? this.pulse(sim, unit, d)
            : null;
    }
    // Knocked off its feet: the breath ends there (its cooldown keeps the time set when it started), no turning.
    static stop(unit) {
        SustainedAttack.interrupt(unit.sustain);
    }
    // The target is in attack reach: stand and turn toward it. A ready breath starts once the target is inside the
    // flame and then runs its whole duration; while it waits for its cooldown the unit only turns.
    static update(sim, unit, target, isBuilding, d) {
        const sustain = unit.sustain;
        this.turnToward(sim, unit.breath, d.breathAttack, target.x - unit.x, target.y - unit.y);
        if (!SustainedAttack.advance(sim, sustain)) {
            if (!SustainedAttack.ready(sim, sustain) || !this.touches(sim, unit, target, d))
                return null;
            SustainedAttack.start(sim, sustain, d.sustain);
        }
        return SustainedAttack.takeTick(sim, sustain, d.sustain) ? this.pulse(sim, unit, d) : null;
    }
    // Does `entity`'s body (a circle) touch the flame? Its radius here is its attack reach past the flame's length,
    // so a unit is its body radius and a building its reach envelope; a blocked terrain line never touches.
    static touches(sim, unit, entity, d) {
        const spec = d.breathAttack,
            px = entity.x - unit.x,
            py = entity.y - unit.y,
            reach = InteractionGeometry.reach(unit, entity, 'attack', d.range);
        if (px * px + py * py > reach * reach) return false;
        const breath = unit.breath,
            aim = Math.sqrt(breath.aimX * breath.aimX + breath.aimY * breath.aimY);
        if (!aim) return false;
        const half = (spec.arcDegrees * DEGREE) / 2;
        if (
            !this.sectorTouches(
                breath.aimX / aim,
                breath.aimY / aim,
                Math.cos(half),
                Math.sin(half),
                spec.length,
                px,
                py,
                reach - spec.length,
            )
        )
            return false;
        // The shared range check returns -1 when the terrain line to the target is blocked.
        return sim.interactionDistance(unit, entity, 'attack', d.range) >= 0;
    }
    // A circle at (px, py) of radius r against the sector from the origin along the unit vector (ux, uy), half-angle
    // with cosine c and sine s (below 90°), of radius `length`: inside the wedge it reaches length + r, outside it must
    // come within r of the nearer edge.
    static sectorTouches(ux, uy, c, s, length, px, py, r) {
        if (r < 0) return false;
        const lx = ux * c - uy * s,
            ly = ux * s + uy * c,
            rx = ux * c + uy * s,
            ry = uy * c - ux * s;
        if (rx * py - ry * px >= 0 && px * ly - py * lx >= 0) {
            const reach = length + r;
            return px * px + py * py <= reach * reach;
        }
        const r2 = r * r;
        return (
            this.edgeDistance2(px, py, lx, ly, length) <= r2 ||
            this.edgeDistance2(px, py, rx, ry, length) <= r2
        );
    }
    static edgeDistance2(px, py, ex, ey, length) {
        let t = px * ex + py * ey;
        t = t < 0 ? 0 : t > length ? length : t;
        const qx = px - ex * t,
            qy = py - ey * t;
        return qx * qx + qy * qy;
    }
    // One burn: every enemy ground unit and building the flame touches.
    static pulse(sim, unit, d) {
        const spec = d.breathAttack,
            breath = unit.breath,
            aim = Math.sqrt(breath.aimX * breath.aimX + breath.aimY * breath.aimY),
            pulse = breath.pulses++,
            // Fractional building damage carries over the pulses: floor((k + 1)·a·s) - floor(k·a·s).
            buildingDamage =
                Math.floor((pulse + 1) * d.atk * spec.buildingDamageScale) -
                Math.floor(pulse * d.atk * spec.buildingDamageScale);
        unit.attackFlash = 1;
        const event = {
            type: 'breathPulse',
            side: unit.side,
            sourceId: unit.id,
            x: unit.x + (breath.aimX / aim) * (spec.length / 2),
            y: unit.y + (breath.aimY / aim) * (spec.length / 2),
            hits: 0,
        };
        sim.events.push(event);
        let winner = null,
            hits = 0;
        const units = sim.nearbyUnits(
            unit.x,
            unit.y,
            spec.length + sim.maxUnitRadius,
            1 - unit.side,
            UNIT_QUERY,
        );
        for (let k = 0; k < units; k++) {
            const target = sim.units[UNIT_QUERY.items[k]];
            if (
                !target?.alive ||
                !sim.canTargetUnit(unit.side, target) ||
                !sim.canAttackEntity(unit.type, target) ||
                !this.touches(sim, unit, target, d)
            )
                continue;
            sim.applyDamage(unit.side, unit.type, target, false, d.atk, unit.id, HIT);
            hits++;
        }
        if (buildingDamage > 0) {
            // A building's attack reach scales its size like a body (InteractionGeometry.contact).
            const buildings = sim.nearbyBuildingIndices(
                unit.x,
                unit.y,
                spec.length + sim.maxBuildingRadius * COLLISION_RADIUS_SCALE,
                BUILDING_QUERY,
            );
            for (let k = 0; k < buildings; k++) {
                const target = sim.buildings[BUILDING_QUERY.items[k]];
                if (
                    !sim.isHostileCombatBuilding(unit.side, target) ||
                    !sim.canAttackEntity(unit.type, target, true) ||
                    !this.touches(sim, unit, target, d)
                )
                    continue;
                winner =
                    sim.applyDamage(
                        unit.side,
                        unit.type,
                        target,
                        true,
                        buildingDamage,
                        unit.id,
                        HIT,
                    ) || winner;
                hits++;
            }
        }
        event.hits = hits;
        return winner;
    }
}

export { UnitBreathAttack };
