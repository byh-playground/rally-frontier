// Contract (index.html Development Contract에서 능력 모듈로 옮긴 형식):
// - 호두(Unit Definition rolling)는 한 번에 한 알을 싣는 묶음 투입탄이다(인구 예외 없음).
//   일반 교전·이동 AI를 쓰지 않고 RollingBody가 매 틱 impactMotion 속도를 직접 쓴다.
//   착지 충격이 끝나면(땅에 닿고 XY 속도 0) 발사 방향으로 최고 속도×launchSpeedRatio로 차고 나간다(kicked).
//   속도는 speed += (top·drag·max(0, 진행 방향·목표 방향) − drag·speed)/tps로, 구동−저항의 평형이 최고 속도다.
//   목표는 시야 안의 가장 가까운 적 병사·건물(같으면 id), 없으면 적 본진, 없으면 깃발이며 길찾기는 없다.
//   회전 한도는 turnRateSlow에서 turnRateTop으로 속도 비율에 따라 선형으로 줄어든다(빠를수록 크게 돈다).
//   접촉은 기존 충격량 접촉(UnitMotion.solveImpulseContact)을 쓴다. 적과는 질량·반발 e의 운동량 교환
//   J=−(1+e)·v_n/(1/M+1/m)로 양쪽 속도가 바뀌고, 맞은 적은 넉백 비율만큼 띄워지며
//   피해는 round(J·damagePerImpulse)다. 아군은 충격량 접촉이 아니다: 모든 몸이 움직인 뒤 겹친 지상 아군을
//   호두 밖으로 위치만 밀어낸다(pushAllies). 아군은 피해·속도 변화가 없고 호두 속도도 그대로다.
//   같은 표적 재타격은 rehitMs 뒤에만, 연쇄 피해는 없다(맞은 적끼리의 충돌은 일반 충격량 접촉이다).
//   벽·건물은 removeInwardVelocity에 wallRestitution을 넘겨 반사하고, 적 건물은 진입 속도에 비례한 피해
//   (최고 속도 정면에서 buildingDamageAtTop)를 받는다. 벽에 맞은 뒤 slideMs 동안은 목표가 벽 안쪽이면
//   벽을 따라 한쪽(wallSide)으로 미끄러진다. 0시간 접촉이 반복되면(맵 끝에 눌린 적 등) 함께 멈추지 않고
//   한 번 벽처럼 튕기고(bounceStuck), 그래도 반복되면 일반 몸처럼 붙는다. 피해는 접촉 해소 뒤 flushHits에서 한 번에 적용하고 rollingImpact 이벤트를 낸다.
//   Unit.rolling 전체가 권위 상태다. 껍데기 회전 θ·속도 단계·표정·늘어남은 렌더가 위치 변화로 누적하는
//   연출(스프라이트 계약 rolling)이며 권위 상태가 아니다. 봇은 일반 지상 병력과 같은 규칙으로 쏜다.
// A walnut never stops: after landing it rolls, speeds up and bowls enemies over.
// Unit.rolling { kicked, dx, dy, hits, bumpTick, wallTick, wallNx, wallNy, wallSide } is its only
// own state. The rolling velocity lives in the shared impulse motion (impactMotion, kind 'roll'), so UnitMotion moves it,
// casts it against walls, buildings and units and exchanges momentum exactly like a knocked body.
// The extension to that motion is small: a rolling body keeps its motion record while it lives,
// gets its velocity from this motor instead of the ground drag, bounces with its own restitution,
// bounces off a contact that would otherwise stick, and moves overlapping allies aside afterwards.
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { FP } from '../../core/config.js';
import { LaunchImpactRules } from '../../definitions/launch-impact-rules.js';

const DEGREE = Math.PI / 180;
// A struck enemy also leaves the ground in the proportion of the shared knockback (lift per speed),
// so it flies off ahead of the walnut instead of being shoved along in front of it.
const KNOCKBACK_LIFT_RATIO = LaunchImpactRules.knockbackLift / LaunchImpactRules.knockbackSpeed;
// Hits waiting for the end of the contact solve, per simulation. Damage changes hit points and
// deaths, so it is applied once every body has moved for the tick.
const pendingHits = new WeakMap();

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
            wallNx: 0,
            wallNy: 0,
            wallSide: 0,
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
    // Nearest visible enemy unit or building in sight; with none, the enemy main base.
    static goal(sim, unit, spec, vision) {
        const sight = UnitDefinition.get(unit.type).sight;
        let best = null,
            bestDistance = Infinity,
            bestId = '';
        const consider = (entity, id) => {
            const distance = (entity.x - unit.x) ** 2 + (entity.y - unit.y) ** 2;
            if (distance > sight * sight) return;
            if (distance < bestDistance || (distance === bestDistance && id < bestId)) {
                best = entity;
                bestDistance = distance;
                bestId = id;
            }
        };
        sim.withNearbyUnits(unit.x, unit.y, sight, 1 - unit.side, (indices) => {
            for (const index of indices) {
                const other = sim.units[index];
                if (other?.alive && sim.canSeeCombatTarget(unit.side, other, vision))
                    consider(other, String(other.id));
            }
        });
        for (const building of sim.buildings)
            if (
                sim.isHostileCombatBuilding(unit.side, building) &&
                sim.isVisible(unit.side, building.x, building.y, vision)
            )
                consider(building, String(building.id));
        if (best) return best;
        return (
            sim.buildings.find(
                (b) =>
                    b.side === 1 - unit.side &&
                    b.alive !== false &&
                    BuildingDefinition.isMainBase(b.type),
            ) || sim.flags[unit.side]
        );
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
        const goal = this.goal(sim, unit, spec, vision);
        let gx = (goal?.x ?? unit.x) - unit.x,
            gy = (goal?.y ?? unit.y) - unit.y;
        let goalLength = Math.hypot(gx, gy);
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
        // For a while after bouncing off a wall the goal's share into that wall is dropped, so the
        // walnut runs along it instead of butting it again. No path is searched.
        const nx = state.wallNx,
            ny = state.wallNy;
        if (
            (nx || ny) &&
            state.wallTick !== null &&
            sim.tick < state.wallTick + sim.msTicks(spec.slideMs) &&
            goalLength > 1e-9
        ) {
            const into = gx * nx + gy * ny;
            if (into < 0) {
                // One side per wall, chosen once, so the next bounce does not undo it: the goal's side
                // when it clearly has one, otherwise the side the walnut is already moving along.
                const along = gx * -ny + gy * nx;
                if (!state.wallSide)
                    state.wallSide =
                        Math.abs(along) > 0.25 ? Math.sign(along) : hx * -ny + hy * nx < 0 ? -1 : 1;
                gx = -ny * state.wallSide;
                gy = nx * state.wallSide;
                goalLength = 1;
            }
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
        const hits = state.hits,
            since = sim.tick - sim.msTicks(spec.rehitMs);
        let write = 0;
        for (const hit of hits) if (hit.tick > since) hits[write++] = hit;
        hits.length = write;
    }
    static mayHit(sim, unit, key) {
        const spec = this.spec(unit),
            since = sim.tick - sim.msTicks(spec.rehitMs);
        if (unit.rolling.hits.some((hit) => hit.key === key && hit.tick > since)) return false;
        unit.rolling.hits.push({ key, tick: sim.tick });
        return true;
    }
    static queue(sim, hit) {
        let list = pendingHits.get(sim);
        if (!list) pendingHits.set(sim, (list = []));
        list.push(hit);
    }
    // Contact with an enemy unit, at least one side rolling. Normal n points from b to a, relative < 0
    // closes. The bodies exchange momentum with the unit restitution, the struck one leaves the ground
    // in the shared knockback proportion, and the impulse sets the damage.
    static collide(motion, a, b, nx, ny, totalA, totalB) {
        const sim = motion.navigation.sim;
        const relative = (totalA.x - totalB.x) * nx + (totalA.y - totalB.y) * ny;
        if (relative >= 0) return false;
        const rollingA = this.rolling(a),
            rollingB = this.rolling(b),
            spec = this.spec(rollingA ? a : b),
            massA = sim.mass(a),
            massB = sim.mass(b);
        // A motor-driven participant becomes dynamic at contact, as in solveImpulseContact.
        for (const [unit, total] of [
            [a, totalA],
            [b, totalB],
        ]) {
            const m = unit.impactMotion,
                mass = sim.mass(unit);
            motion.applyImpulse(
                unit,
                {
                    x: (total.x - (m?.vxFP || 0) / FP) * mass,
                    y: (total.y - (m?.vyFP || 0) / FP) * mass,
                },
                {
                    sourceId: unit === a ? b.id : a.id,
                    originX: unit.x,
                    originY: unit.y,
                    kind: m?.kind || 'knockback',
                },
            );
        }
        const impulse = (-(1 + spec.unitRestitution) * relative) / (1 / massA + 1 / massB),
            lift = impulse * KNOCKBACK_LIFT_RATIO;
        for (const [unit, source, sign, rolls] of [
            [a, b, 1, rollingA],
            [b, a, -1, rollingB],
        ])
            motion.applyImpulse(
                unit,
                { x: sign * impulse * nx, y: sign * impulse * ny, z: rolls ? 0 : lift },
                {
                    sourceId: source.id,
                    originX: source.x,
                    originY: source.y,
                    kind: rolls ? unit.impactMotion?.kind : 'knockback',
                },
            );
        for (const [source, target, sign] of [
            [a, b, -1],
            [b, a, 1],
        ]) {
            if (!(source === a ? rollingA : rollingB)) continue;
            const own = this.spec(source);
            source.rolling.bumpTick = sim.tick;
            if (!this.mayHit(sim, source, 'unit:' + target.id)) continue;
            this.queue(sim, {
                sourceId: source.id,
                targetId: target.id,
                building: false,
                amount: Math.round(impulse * own.damagePerImpulse),
                x: (source.x + target.x) / 2,
                y: (source.y + target.y) / 2,
                nx: sign * nx,
                ny: sign * ny,
            });
        }
        return true;
    }
    // Allies are not impulse contacts: once every body has moved, a ground ally overlapping a rolling
    // body is moved straight out of it. No velocity is exchanged, so the walnut keeps its speed and the
    // ally takes no damage and is not flung through its own crowd.
    static pushAllies(sim) {
        const units = sim.units,
            motion = sim.navigation.motion;
        for (const u of units) {
            if (!this.rolling(u)) continue;
            const radius = sim.unitRadius(u.type);
            sim.withNearbyUnits(u.x, u.y, radius + sim.maxUnitRadius, u.side, (indices) => {
                for (const j of indices) {
                    const other = units[j];
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
                    other.fx += Math.round(dx * (reach - distance) * FP);
                    other.fy += Math.round(dy * (reach - distance) * FP);
                    other.x = other.fx / FP;
                    other.y = other.fy / FP;
                    motion.constrain(other);
                    sim.syncUnitSpatial(other);
                }
            });
        }
    }
    // A contact that keeps recurring in zero time, such as a unit pinned against the map edge,
    // would stick both bodies together. A rolling body bounces off it as off a wall instead, and the
    // pinned body keeps its own velocity. n points from b to a. Returns false when neither rolls.
    // The velocities are updated in place, unrounded, so the solver's next cast sees them separate.
    static bounceStuck(motion, a, b, nx, ny, velocityA, velocityB) {
        const rollingA = this.rolling(a),
            rollingB = this.rolling(b);
        if (!rollingA && !rollingB) return false;
        // The closing speed is reflected relative to the other body, so the pair always separates.
        // Two rolling bodies share the change; a rolling body alone takes all of it.
        const closing = (velocityA.x - velocityB.x) * nx + (velocityA.y - velocityB.y) * ny;
        if (closing >= 0) return true;
        const share = rollingA && rollingB ? 0.5 : 1;
        for (const [unit, velocity, sign] of [
            [a, velocityA, 1],
            [b, velocityB, -1],
        ]) {
            if (!(unit === a ? rollingA : rollingB)) continue;
            const m = unit.impactMotion,
                mass = motion.navigation.sim.mass(unit),
                change = -(1 + this.spec(unit).wallRestitution) * closing * share * sign;
            velocity.x += change * nx;
            velocity.y += change * ny;
            motion.applyImpulse(
                unit,
                {
                    x: (velocity.x - m.vxFP / FP) * mass,
                    y: (velocity.y - m.vyFP / FP) * mass,
                },
                { kind: m.kind, sourceId: m.sourceId, originX: m.originX, originY: m.originY },
            );
        }
        return true;
    }
    static surfaceRestitution(unit) {
        return this.rolling(unit) ? this.spec(unit).wallRestitution : null;
    }
    // A wall or building contact, before the bounce removes the inward speed.
    static hitSurface(sim, unit, obstacleId, nx, ny, inwardSpeed) {
        const spec = this.spec(unit),
            state = unit.rolling;
        const building = obstacleId == null ? null : sim.buildingById.get(obstacleId),
            hostile = !!building && sim.isHostileCombatBuilding(unit.side, building);
        // The same wall again, soon: keep running the same way along it.
        const sameWall =
            state.wallTick !== null &&
            sim.tick < state.wallTick + 2 * sim.msTicks(spec.slideMs) &&
            state.wallNx * nx + state.wallNy * ny > 0.9;
        if (!sameWall) state.wallSide = 0;
        state.wallTick = sim.tick;
        // An enemy building is a target to strike again, so only other surfaces are run along.
        state.wallNx = hostile ? 0 : nx;
        state.wallNy = hostile ? 0 : ny;
        if (!hostile || !this.mayHit(sim, unit, 'building:' + building.id)) return;
        this.queue(sim, {
            sourceId: unit.id,
            targetId: building.id,
            building: true,
            amount: Math.round((spec.buildingDamageAtTop * inwardSpeed) / spec.topSpeed),
            x: unit.x - nx * sim.unitRadius(unit.type),
            y: unit.y - ny * sim.unitRadius(unit.type),
            nx: -nx,
            ny: -ny,
        });
    }
    // After every body has moved for the tick: allies step aside, then damage lands. Struck units
    // already carry their knockback.
    static flushHits(sim) {
        this.pushAllies(sim);
        const list = pendingHits.get(sim);
        if (!list?.length) return;
        for (const hit of list) {
            const source = sim.unitById.get(hit.sourceId);
            const target = hit.building
                ? sim.buildingById.get(hit.targetId)
                : sim.unitById.get(hit.targetId);
            if (!source || !target || target.alive === false || hit.amount <= 0) continue;
            sim.applyDamage(source.side, source.type, target, hit.building, hit.amount, source.id, {
                sourceDamageResolved: true,
                suppressImpactFx: true,
            });
            sim.events.push({
                type: 'rollingImpact',
                side: source.side,
                sourceId: source.id,
                targetId: target.id,
                isBuilding: hit.building,
                amount: hit.amount,
                x: hit.x,
                y: hit.y,
                nx: hit.nx,
                ny: hit.ny,
            });
        }
        list.length = 0;
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
            Object.keys(rolling).sort().join(',') !==
                'bumpTick,dx,dy,hits,kicked,wallNx,wallNy,wallSide,wallTick' ||
            ![-1, 0, 1].includes(rolling.wallSide) ||
            !Number.isFinite(rolling.wallNx) ||
            !Number.isFinite(rolling.wallNy) ||
            Math.hypot(rolling.wallNx, rolling.wallNy) > 1 + 1e-9 ||
            typeof rolling.kicked !== 'boolean' ||
            !Number.isFinite(rolling.dx) ||
            !Number.isFinite(rolling.dy) ||
            Math.hypot(rolling.dx, rolling.dy) > 1 + 1e-9 ||
            !tickOrNull(rolling.bumpTick) ||
            !tickOrNull(rolling.wallTick) ||
            !Array.isArray(rolling.hits) ||
            rolling.hits.some(
                (hit) =>
                    !hit ||
                    typeof hit.key !== 'string' ||
                    !hit.key ||
                    hit.key.length > 256 ||
                    !tickOrNull(hit.tick),
            )
        )
            throw new Error('게임 snapshot의 구르기 상태가 잘못되었습니다.');
    }
}

export { RollingBody };
