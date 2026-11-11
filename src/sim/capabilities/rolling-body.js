// Contract (index.html Development Contract에서 능력 모듈로 옮긴 형식):
// - 호두(Unit Definition rolling)는 한 번에 한 알을 싣는 묶음 투입탄이다(인구 예외 없음).
//   일반 교전·이동 AI를 쓰지 않고 RollingBody가 매 틱 impactMotion 속도를 직접 쓴다.
//   착지 충격이 끝나면(땅에 닿고 XY 속도 0) 발사 방향으로 최고 속도×launchSpeedRatio로 차고 나간다(kicked).
//   속도는 speed += (top·drag·max(0, 진행 방향·목표 방향) − drag·speed)/tps로, 구동−저항의 평형이 최고 속도다.
//   목표는 시야 안의 가장 가까운 적 병사·건물(같으면 id 번호, 병사 먼저), 없으면 적 본진, 없으면 깃발이다.
//   조향 방향은 목표 직선이 아니라 공용 흐름장(TerrainNavigation.nextPoint, 'field')이 주는 다음 지점이다:
//   목표의 접촉 원(병사는 접촉 거리, 건물은 공격 도달 거리)까지 직선이 열려 있으면 직선, 막혔으면 호두 반경
//   묶음의 흐름장. 건물·깃발은 고정 목표라 같은 목표로 가는 호두가 흐름장을 함께 쓰고, 병사는 선 칸 단위의
//   추격 목표다. 원 안에 들면 목표 자체를 향한다. 보이는 적에게 땅으로 닿을 수 없으면 적 본진(없으면 깃발)으로
//   가는 길을 따르고, 그것도 없으면 목표를 곧장 향한다. 길찾기는 조향 방향만 정하고 물리는 그대로다.
//   회전 한도는 turnRateSlow에서 turnRateTop으로 속도 비율에 따라 선형으로 줄어든다(빠를수록 크게 돈다).
//   접촉은 공용 접촉 풀이(GameKit contact-solver, UnitMotion.solveContacts)가 시간순으로 내주고 respond가 답한다.
//   적과는 질량·반발 e의 운동량 교환 J=−(1+e)·v_n/(1/M+1/m)로 양쪽 속도가 바뀌고, 맞은 적은 넉백 비율만큼 띄워지며
//   (재타격 대기 밖의 첫 타격은 knockback배의 속도·띄움, 같은 접촉의 반복은 1배)
//   피해는 round(J·damagePerImpulse)다. 호두가 낀 쌍도 다른 몸끼리와 같은 틱당 접촉 예산을 쓴다(넘치면 겹쳐 지나감).
//   아군은 접촉이 아니다: 모든 몸이 움직이고 겹침 풀기까지 끝난 뒤 겹친 지상 아군을
//   호두 밖으로 위치만 밀어낸다(pushAllies). 아군은 피해·속도 변화가 없고 호두 속도도 그대로다.
//   같은 표적 재타격은 rehitMs 뒤에만, 연쇄 피해는 없다(맞은 적끼리의 충돌은 일반 접촉이다).
//   벽·건물은 wallRestitution으로 반사하고, 적 건물은 진입 속도에 비례한 피해
//   (최고 속도 정면에서 buildingDamageAtTop)를 받는다. 0시간 접촉이 반복되면(맵 끝에 눌린 적 등) 함께 멈추지 않고
//   한도에서 한 번 벽처럼 튕기고, 그래도 반복되면 일반 몸처럼 붙는다. 피해는 접촉 해소 뒤 flushHits에서 한 번에 적용하고 rollingImpact 이벤트를 낸다.
//   Unit.rolling 전체가 권위 상태다. 껍데기 회전 θ·속도 단계·표정·늘어남은 렌더가 위치 변화로 누적하는
//   연출(스프라이트 계약 rolling)이며 권위 상태가 아니다. 봇은 일반 지상 병력과 같은 규칙으로 쏜다.
// A walnut never stops: after landing it rolls, speeds up and bowls enemies over.
// Unit.rolling { kicked, dx, dy, hits, bumpTick, wallTick } is its only own state. The rolling velocity lives in
// the shared impact motion (impactMotion, kind 'roll'), so the contact solve moves it and casts it against walls,
// buildings and units like a knocked body. The walnut's own rules are small: it keeps its motion record while it
// lives, gets its velocity from this motor instead of the ground drag, answers its contacts here (strike gain,
// rehit window, damage queue, its own restitution, one bounce off a stuck contact), and moves overlapping allies
// aside afterwards.
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { FP } from '../../core/config.js';
import { LaunchImpactRules } from '../../definitions/launch-impact-rules.js';
import { EntityKey } from '../entities.js';
import { InteractionGeometry, NavigationGoal } from '../navigation.js';
import { RallyGamekit } from '../../core/gamekit.js';
import { IndexList } from '../index-list.js';
const { RESPONSE_BOUNCE } = RallyGamekit;

const DEGREE = Math.PI / 180;
// A struck enemy also leaves the ground in the proportion of the shared knockback (lift per speed),
// so it flies off ahead of the walnut instead of being shoved along in front of it.
const KNOCKBACK_LIFT_RATIO = LaunchImpactRules.knockbackLift / LaunchImpactRules.knockbackSpeed;
// Hits waiting for the end of the contact solve, per simulation. Damage changes hit points and deaths, so it is
// applied once every body has moved for the tick. A hit is two references (source unit, target unit or building)
// and HIT_NUMBERS numbers (amount, x, y, nx, ny, building 0/1); the arrays only grow, `count` is the live length.
const pendingHits = new WeakMap();
const HIT_NUMBERS = 6;
// Reused every step: the unit indices near a walnut, and the goal it asks the flow field about
// (made on first use, since this module and navigation.js import each other).
const NEARBY = new IndexList();
let steerGoal = null;
// Rehit window keys: the entity's EntityKey number (< 2^50, entities.js) times two, plus 0 for a unit and 1 for a
// building, so every key is a distinct integer below 2^51, exact in a double.
const unitHitKey = (unit) => EntityKey.number(unit.id) * 2;
const buildingHitKey = (building) => EntityKey.number(building.id) * 2 + 1;

class RollingBody {
    static spec(unit) {
        return UnitDefinition.get(unit?.type)?.rolling || null;
    }
    static initialState() {
        return {
            kicked: false,
            dx: 0,
            dy: 0,
            hits: [],
            bumpTick: null,
            wallTick: null,
        };
    }
    static grounded(unit) {
        const m = unit.impactMotion;
        return !m || (m.heightFP <= 0 && m.vzFP <= 0);
    }
    // A live walnut on the ground, rolling under its own drive. A push that does not lift it keeps it
    // rolling; the motor marks the motion 'roll' again on its next step.
    static rolling(unit) {
        return (
            !!unit?.alive && !!unit.rolling?.kicked && !!unit.impactMotion && this.grounded(unit)
        );
    }
    // The launch direction, from the shell's flight, is the first heading.
    static aim(unit, dx, dy) {
        const length = Math.hypot(dx, dy);
        if (!unit.rolling || !(length > 0)) return;
        unit.rolling.dx = dx / length;
        unit.rolling.dy = dy / length;
    }
    // Nearest visible enemy unit or building in sight (ties by id number, units before buildings).
    static nearestEnemy(sim, unit, vision) {
        const sight = UnitDefinition.get(unit.type).sight,
            count = sim.nearbyUnits(unit.x, unit.y, sight, 1 - unit.side, NEARBY);
        let best = null,
            bestDistance = sight * sight,
            bestKey = Infinity;
        for (let i = 0; i < count; i++) {
            const other = sim.units[NEARBY.items[i]];
            if (!other?.alive || !sim.canSeeCombatTarget(unit.side, other, vision)) continue;
            const distance = (other.x - unit.x) ** 2 + (other.y - unit.y) ** 2,
                key = EntityKey.number(other.id) * 2;
            if (distance < bestDistance || (distance === bestDistance && key < bestKey)) {
                best = other;
                bestDistance = distance;
                bestKey = key;
            }
        }
        const buildings = sim.buildings;
        for (let i = 0; i < buildings.length; i++) {
            const building = buildings[i];
            if (
                !sim.isHostileCombatBuilding(unit.side, building) ||
                !sim.isVisible(unit.side, building.x, building.y, vision)
            )
                continue;
            const distance = (building.x - unit.x) ** 2 + (building.y - unit.y) ** 2,
                key = EntityKey.number(building.id) * 2 + 1;
            if (distance < bestDistance || (distance === bestDistance && key < bestKey)) {
                best = building;
                bestDistance = distance;
                bestKey = key;
            }
        }
        return best;
    }
    static enemyBase(sim, unit) {
        const buildings = sim.buildings;
        for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i];
            if (
                b.side === 1 - unit.side &&
                b.alive !== false &&
                BuildingDefinition.isMainBase(b.type)
            )
                return b;
        }
        return null;
    }
    // Where to steer: the way to the nearest visible enemy; when there is none or it cannot be reached
    // over the ground, the way to the enemy main base (or, without one, the flag); when neither can be
    // reached, straight at whichever exists.
    static steerPoint(sim, unit, vision) {
        const enemy = this.nearestEnemy(sim, unit, vision),
            way = enemy && this.wayTo(sim, unit, enemy);
        if (way) return way;
        const home = this.enemyBase(sim, unit) || sim.flags[unit.side];
        return (home && this.wayTo(sim, unit, home)) || enemy || home;
    }
    // The next point of the shared flow field to the target's contact disc (a clear straight line in the
    // ray range is taken straight, as for every army unit); the target itself once inside the disc; null
    // when the ground does not lead there. A unit's disc is a chase goal keyed by the cell it stands in;
    // a building's disc and the flag's point are fixed, so every walnut heading there shares one field.
    static wayTo(sim, unit, target) {
        const goal = (steerGoal ??= NavigationGoal.point(0, 0)).reset(
                target.x,
                target.y,
                target.type ? InteractionGeometry.reach(unit, target, 'attack') : 0,
                0,
                false,
                !!BuildingDefinition.get(target.type),
            ),
            point = sim.navigation.nextPoint(unit, goal, 'field');
        if (point && Math.abs(point.x - unit.x) < 1e-6 && Math.abs(point.y - unit.y) < 1e-6)
            return target;
        return point;
    }
    // The motor, once per tick before contacts: turn toward the goal, then drive minus drag.
    // The heading is the direction of travel, so a bounce turns the walnut with it.
    static step(sim, unit, vision) {
        const spec = this.spec(unit),
            state = unit.rolling;
        if (!spec || !state || !this.grounded(unit)) return;
        const tps = sim.tps,
            mass = sim.mass(unit);
        const m = unit.impactMotion;
        // A knocked walnut coasts on the shared drag until it has settled from its own landing.
        if (!state.kicked && m && (m.vxFP || m.vyFP || sim.tick < m.endTick)) return;
        let vx = (m?.vxFP || 0) / FP,
            vy = (m?.vyFP || 0) / FP,
            speed = Math.hypot(vx, vy);
        const goal = this.steerPoint(sim, unit, vision);
        let gx = (goal?.x ?? unit.x) - unit.x,
            gy = (goal?.y ?? unit.y) - unit.y;
        const goalLength = Math.hypot(gx, gy);
        if (goalLength > 1e-9) {
            gx /= goalLength;
            gy /= goalLength;
        }
        let hx = state.dx,
            hy = state.dy;
        if (speed > 1e-9) {
            hx = vx / speed;
            hy = vy / speed;
        } else if (!(Math.hypot(hx, hy) > 0)) {
            hx = goalLength > 1e-9 ? gx : 1;
            hy = goalLength > 1e-9 ? gy : 0;
        }
        if (!state.kicked) {
            // Landing: half the top speed along the launch direction.
            state.kicked = true;
            speed = spec.topSpeed * spec.launchSpeedRatio;
        } else if (goalLength > 1e-9) {
            // The turn rate falls from turnRateSlow at rest to turnRateTop at full speed. The rotation
            // is the rational half-angle form, so it uses only basic arithmetic.
            const ratio = Math.min(1, speed / spec.topSpeed),
                limit =
                    ((spec.turnRateSlow + (spec.turnRateTop - spec.turnRateSlow) * ratio) *
                        DEGREE) /
                    tps,
                t = limit / 2,
                cos = (1 - t * t) / (1 + t * t),
                sin = (2 * t) / (1 + t * t),
                cross = hx * gy - hy * gx,
                dot = hx * gx + hy * gy;
            if (dot > 0 && Math.abs(cross) * cos <= dot * sin) {
                hx = gx;
                hy = gy;
            } else {
                const turn = cross >= 0 ? sin : -sin,
                    nx = hx * cos - hy * turn,
                    ny = hx * turn + hy * cos,
                    length = Math.hypot(nx, ny);
                hx = nx / length;
                hy = ny / length;
            }
            // Drive pushes only along the heading's share of the goal: a walnut facing away coasts
            // and turns, it never drives away from what it chases.
            const along = Math.max(0, hx * gx + hy * gy),
                drive = spec.topSpeed * spec.drag * along;
            speed = Math.max(0, speed + (drive - spec.drag * speed) / tps);
        }
        state.dx = hx;
        state.dy = hy;
        const tx = Math.round(hx * speed * FP),
            ty = Math.round(hy * speed * FP);
        if (!m)
            sim.navigation.motion.applyImpulse(
                unit,
                { x: (tx / FP) * mass, y: (ty / FP) * mass },
                { kind: 'roll', sourceId: unit.id },
            );
        else {
            m.vxFP = tx;
            m.vyFP = ty;
            m.kind = 'roll';
        }
        // hits is a flat list of (key, tick) pairs; drop the ones past the rehit window.
        const hits = state.hits,
            since = sim.tick - sim.msTicks(spec.rehitMs);
        let write = 0;
        for (let k = 0; k < hits.length; k += 2)
            if (hits[k + 1] > since) {
                hits[write++] = hits[k];
                hits[write++] = hits[k + 1];
            }
        hits.length = write;
    }
    // A strike on `key` outside the rehit window is recorded and counts; one inside it does not.
    static mayHit(sim, unit, key) {
        const hits = unit.rolling.hits,
            since = sim.tick - sim.msTicks(this.spec(unit).rehitMs);
        for (let k = 0; k < hits.length; k += 2)
            if (hits[k] === key && hits[k + 1] > since) return false;
        hits.push(key, sim.tick);
        return true;
    }
    static queue(sim, source, target, building, amount, x, y, nx, ny) {
        let list = pendingHits.get(sim);
        if (!list) pendingHits.set(sim, (list = { count: 0, refs: [], numbers: [] }));
        const k = list.count++,
            numbers = list.numbers,
            at = k * HIT_NUMBERS;
        list.refs[2 * k] = source;
        list.refs[2 * k + 1] = target;
        numbers[at] = amount;
        numbers[at + 1] = x;
        numbers[at + 2] = y;
        numbers[at + 3] = nx;
        numbers[at + 4] = ny;
        numbers[at + 5] = building ? 1 : 0;
    }
    // A contact the solver hands over with at least one rolling body; false leaves it to the standard response.
    // Walls and buildings: hostile building damage from the entry speed, then a bounce with the walnut's own
    // restitution. A zero-time repeat at the limit bounces the rolling body once; later repeats stick as usual.
    // An enemy: momentum exchange with the unit restitution, the struck body thrown by `knockback` times the
    // impulse on a strike outside the rehit window (the walnut loses speed from the plain exchange only), lifted
    // in the shared knockback proportion, and the impulse sets the damage. The normal points from j to i.
    static respond(motion, ev) {
        const sim = motion.navigation.sim,
            solver = motion.contacts,
            bodies = solver.bodies,
            units = sim.units,
            i = ev.i,
            j = ev.j,
            a = units[i],
            b = j >= 0 ? units[j] : null,
            rollingA = this.rolling(a),
            rollingB = b !== null && this.rolling(b);
        if (!rollingA && !rollingB) return false;
        if (b === null) {
            if (ev.stuck) return false;
            this.hitSurface(
                sim,
                a,
                ev.obstacle ? ev.obstacle.buildingId : null,
                ev.nx,
                ev.ny,
                solver.closing(ev),
                bodies.x[i] / FP,
                bodies.y[i] / FP,
            );
            solver.reflect(ev, this.spec(a).wallRestitution);
            motion.recordContact(ev);
            return true;
        }
        if (ev.stuck) {
            if (ev.repeats !== solver.maxZeroTimeRepeats) return false;
            solver.bounce(
                ev,
                rollingA,
                rollingB,
                rollingA ? this.spec(a).wallRestitution : 0,
                rollingB ? this.spec(b).wallRestitution : 0,
            );
            if (ev.response === RESPONSE_BOUNCE)
                for (let side = 0; side < 2; side++) {
                    const unit = side === 0 ? a : b,
                        m = unit.impactMotion;
                    if (side === 0 ? rollingA : rollingB)
                        motion.markImpact(unit, m.kind, m.sourceId, m.originX, m.originY);
                }
            return true;
        }
        if (!(solver.closing(ev) > 0)) return false;
        // A strike is the first hit on a target outside the rolling body's rehit window.
        const strikeB = rollingA && this.mayHit(sim, a, unitHitKey(b)),
            strikeA = rollingB && this.mayHit(sim, b, unitHitKey(a));
        if (rollingA) a.rolling.bumpTick = sim.tick;
        if (rollingB) b.rolling.bumpTick = sim.tick;
        const gainA = !rollingA && strikeA ? this.spec(b).knockback : 1,
            gainB = !rollingB && strikeB ? this.spec(a).knockback : 1,
            impulse = solver.exchange(
                ev,
                this.spec(rollingA ? a : b).unitRestitution,
                gainA,
                gainB,
            ),
            ax = bodies.x[i] / FP,
            ay = bodies.y[i] / FP,
            bx = bodies.x[j] / FP,
            by = bodies.y[j] / FP;
        // The struck body leaves the ground too; the rolling one keeps its kind 'roll'.
        for (let side = 0; side < 2; side++) {
            const unit = side === 0 ? a : b,
                rolls = side === 0 ? rollingA : rollingB,
                m = motion.impactRecord(unit);
            if (!rolls)
                m.vzFP += Math.round(
                    ((impulse * KNOCKBACK_LIFT_RATIO * (side === 0 ? gainA : gainB)) /
                        sim.mass(unit)) *
                        FP,
                );
            motion.markImpact(
                unit,
                rolls ? m.kind : 'knockback',
                side === 0 ? b.id : a.id,
                side === 0 ? bx : ax,
                side === 0 ? by : ay,
            );
        }
        if (strikeB)
            this.queue(
                sim,
                a,
                b,
                false,
                Math.round(impulse * this.spec(a).damagePerImpulse),
                (ax + bx) / 2,
                (ay + by) / 2,
                -ev.nx,
                -ev.ny,
            );
        if (strikeA)
            this.queue(
                sim,
                b,
                a,
                false,
                Math.round(impulse * this.spec(b).damagePerImpulse),
                (ax + bx) / 2,
                (ay + by) / 2,
                ev.nx,
                ev.ny,
            );
        return true;
    }
    // Allies are not contacts: once every body has moved and separated, a ground ally overlapping a rolling body is
    // moved straight out of it, along the terrain. No velocity is exchanged, so the walnut keeps its speed and the
    // ally takes no damage and is not flung through its own crowd. The solver's ally separation splits by mass and
    // is capped per pass, so it would leave allies inside a fast walnut; this rule stays the walnut's own.
    static pushAllies(sim) {
        const units = sim.units,
            motion = sim.navigation.motion;
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (!this.rolling(u)) continue;
            const radius = sim.unitRadius(u.type),
                count = sim.nearbyUnits(u.x, u.y, radius + sim.maxUnitRadius, u.side, NEARBY);
            for (let k = 0; k < count; k++) {
                const other = units[NEARBY.items[k]];
                if (
                    other === u ||
                    !other?.alive ||
                    this.rolling(other) ||
                    !this.grounded(other) ||
                    other.heroRoll
                )
                    continue;
                const reach = radius + sim.unitRadius(other.type);
                let dx = other.x - u.x,
                    dy = other.y - u.y;
                const distance = Math.hypot(dx, dy);
                if (distance >= reach) continue;
                if (distance > 1e-9) {
                    dx /= distance;
                    dy /= distance;
                } else {
                    // Dead centre: aside, to the walnut's left.
                    dx = -u.rolling.dy;
                    dy = u.rolling.dx;
                }
                motion.move(
                    other,
                    (other.fx + Math.round(dx * (reach - distance) * FP)) / FP,
                    (other.fy + Math.round(dy * (reach - distance) * FP)) / FP,
                    'project',
                );
            }
        }
    }
    // A wall or building contact, before the bounce removes the inward speed. (x, y) is the walnut at the contact.
    static hitSurface(sim, unit, obstacleId, nx, ny, inwardSpeed, x, y) {
        const spec = this.spec(unit);
        const building = obstacleId == null ? null : sim.buildingById.get(obstacleId),
            hostile = !!building && sim.isHostileCombatBuilding(unit.side, building);
        // The bump the sprite shows (sprite contract rolling).
        unit.rolling.wallTick = sim.tick;
        if (!hostile || !this.mayHit(sim, unit, buildingHitKey(building))) return;
        this.queue(
            sim,
            unit,
            building,
            true,
            Math.round((spec.buildingDamageAtTop * inwardSpeed) / spec.topSpeed),
            x - nx * sim.unitRadius(unit.type),
            y - ny * sim.unitRadius(unit.type),
            -nx,
            -ny,
        );
    }
    // After every body has moved for the tick: allies step aside, then damage lands. Struck units
    // already carry their knockback.
    static flushHits(sim) {
        this.pushAllies(sim);
        const list = pendingHits.get(sim);
        if (!list?.count) return;
        const refs = list.refs,
            numbers = list.numbers;
        for (let k = 0; k < list.count; k++) {
            const source = refs[2 * k],
                target = refs[2 * k + 1],
                at = k * HIT_NUMBERS,
                amount = numbers[at],
                building = numbers[at + 5] === 1;
            refs[2 * k] = null;
            refs[2 * k + 1] = null;
            if (target.alive === false || amount <= 0) continue;
            sim.applyDamage(source.side, source.type, target, building, amount, source.id, {
                sourceDamageResolved: true,
                suppressImpactFx: true,
            });
            sim.events.push({
                type: 'rollingImpact',
                side: source.side,
                sourceId: source.id,
                targetId: target.id,
                isBuilding: building,
                amount,
                x: numbers[at + 1],
                y: numbers[at + 2],
                nx: numbers[at + 3],
                ny: numbers[at + 4],
            });
        }
        list.count = 0;
    }
    static validateState(unit, state) {
        const spec = this.spec(unit),
            rolling = unit.rolling;
        if (!spec) {
            if (rolling !== undefined)
                throw new Error('게임 snapshot의 구르기 상태가 잘못되었습니다.');
            return;
        }
        const tickOrNull = (tick) =>
            tick === null || (Number.isSafeInteger(tick) && tick >= 0 && tick <= state.tick);
        if (
            !rolling ||
            Object.keys(rolling).sort().join(',') !== 'bumpTick,dx,dy,hits,kicked,wallTick' ||
            typeof rolling.kicked !== 'boolean' ||
            !Number.isFinite(rolling.dx) ||
            !Number.isFinite(rolling.dy) ||
            Math.hypot(rolling.dx, rolling.dy) > 1 + 1e-9 ||
            !tickOrNull(rolling.bumpTick) ||
            !tickOrNull(rolling.wallTick) ||
            !Array.isArray(rolling.hits) ||
            rolling.hits.length % 2 !== 0 ||
            rolling.hits.some((value, k) =>
                k % 2 === 0
                    ? !Number.isSafeInteger(value) || value < 0
                    : value === null || !tickOrNull(value),
            )
        )
            throw new Error('게임 snapshot의 구르기 상태가 잘못되었습니다.');
    }
}

export { RollingBody };
