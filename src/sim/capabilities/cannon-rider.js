// Contract (moved from the index.html Development Contract):
// - 검은콩(Unit Definition cannonRider)은 한 번에 10알을 싣는 묶음 투입탄이다. 착지(spawnUnit)할 때
//   Unit.cannonRide.readyTick(대포를 다시 고를 틱)을 정한다. 적(유닛·건물)을 노리고 떨어졌거나 플레이어가 쏜
//   경우는 재탑승 지연 뒤, 아군 대포로 건너뛰었거나 적진 방향으로 날아간 경우는 착지 즉시다. 그 전에는 일반 근접 AI로 싸운다.
// - 대포 고르기: 먼저 자기보다 앞(적 본진까지의 거리가 자기보다 짧은) 아군 발사 대포 중 찹쌀에 막히지 않았고
//   직선거리가 탐색 상한(발사 사거리 × cannonSearchReachMultiplier) 안인 가장 가까운 것(같으면 id 순).
//   고르는 때는 착지 뒤 readyTick이 지났을 때, 그 진영의 탈 수 있는 대포 목록(cannonListKey)이 바뀌었을 때,
//   고른 대포를 잃었을 때뿐이고 틱마다 고르지 않는다. 고른 결과와 그때의 목록 키가 Unit.cannonRide에 남는다.
//   앞에 탈 수 있는 대포가 없으면 같은 탐색 상한 안의 가장 가까운 뒤쪽 아군 대포로 돌아가 다시 탄다(앞쪽이 우선).
//   앞뒤 어디에도 없으면 일반 병종처럼 싸우며 행군한다.
// - 고른 대포로는 교전 중이어도 이동속도 배율을 곱해 달려간다(phase 'return'). 직선이 열려 있으면 직선, 막혔으면
//   그 대포의 탑승 고리를 목표로 하는 공용 고정 거리장(navigation field, 건물 배치가 바뀔 때만 다시 만듦)을 따른다.
//   도착하면 한 명씩 탑승(phase 'board')해 조준을 고정하고, 탑승 시간 뒤 공용 fireLaunchShell로 자기 한 명
//   (count 1, passengerHp=현재 체력, ride=비행 종류)을 비용·재장전 없이 쏜다. 탑승한 대포는 반드시 발사한다.
// - 비행 표적(대포 발사 사거리 안, 최소 사거리 없음): ① 보이는 가장 가까운 적 병사 ② 보이는 가장 가까운 적 건물
//   ('enemy') ③ 현재 대포보다 적 본진에 가까운 아군 발사 대포 중 현재 대포에서 가장 가까운 것의 탑승 고리 안
//   ('hop', 적 본진 반대쪽에 병사마다 결정론적으로 흩음) ④ 적 본진 방향 사거리 끝('front', 보정은 일반 발사와 같음).
//   포구에 너무 가까운 표적은 같은 방향으로 포구 밖 MIN_FLIGHT만큼 떨어진 곳을 노린다.
// - cannonRide 전체가 권위 상태다. 탑승 모습은 스냅샷의 cannonRide로 그리는 연출이며, 한 대포에 여러 명이면
//   가장 먼저 발사할 한 명만 그린다.
// Unit.cannonRide { readyTick, phase, cannonId, launchTick, aimX, aimY, flight, listKey } is the only state:
//   phase null     fights normally; once readyTick has passed it picks the nearest cannon ahead, at most once
//                  per change of its side's cannon list (listKey), ahead first and else the nearest behind;
//                  none means it marches like any grain,
//   phase 'return' runs to that cannon, faster than usual, even mid-fight,
//   phase 'board'  sits on the muzzle until launchTick, then rides a shell of its own to the locked aim.
// The flight reuses the ordinary launch path: shell, flight, impact and landing. Only the issuer differs,
// it costs nothing, ignores the cannon's reload, and the single passenger keeps its health (payload.passengerHp)
// and how it flew (payload.ride), which decides when it picks a cannon again.
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { LaunchRules } from '../launch-rules.js';
import { HashUtil } from '../map-generation.js';
import { NavigationGoal, UnitMotion } from '../navigation.js';

// Same margin as a returning hero: the bean stops just outside the cannon's body.
const BOARD_PADDING = 10;
// A shell aimed closer than this past the muzzle flies this far in the same direction instead.
const MIN_FLIGHT = 40;
// Hop landings fan out this far either side of the line from the next cannon away from the enemy base.
const HOP_SPREAD = Math.PI / 4;

const PHASES = Object.freeze([null, 'return', 'board']);
// enemy: aimed at an enemy (or launched by the player), fights before picking a cannon again.
// hop:   dropped beside a cannon further forward, picks a cannon again at once.
// front: thrown toward the enemy base from the frontmost cannon, picks a cannon again at once.
const FLIGHTS = Object.freeze(['enemy', 'hop', 'front']);

// Per tick and side: a key of the cannons a rider may pick. Derived from the state, never stored in it.
const LIST_KEYS = new WeakMap();

class CannonRider {
    static FLIGHTS = FLIGHTS;

    static initialState() {
        return {
            readyTick: 0,
            phase: null,
            cannonId: null,
            launchTick: 0,
            aimX: 0,
            aimY: 0,
            flight: null,
            listKey: null,
        };
    }

    static validateState(unit) {
        if (!UnitDefinition.get(unit.type)?.cannonRider) return;
        const ride = unit.cannonRide;
        if (
            !ride ||
            !PHASES.includes(ride.phase) ||
            !Number.isSafeInteger(ride.readyTick) ||
            !Number.isSafeInteger(ride.launchTick) ||
            !Number.isSafeInteger(ride.aimX) ||
            !Number.isSafeInteger(ride.aimY) ||
            (ride.phase === null) !== (ride.cannonId === null) ||
            (ride.cannonId !== null && typeof ride.cannonId !== 'string') ||
            (ride.phase === 'board') !== FLIGHTS.includes(ride.flight) ||
            (ride.phase !== 'board' && ride.flight !== null) ||
            (ride.listKey !== null && (!Number.isSafeInteger(ride.listKey) || ride.listKey < 0)) ||
            (ride.phase !== null && ride.listKey === null)
        )
            throw new Error('게임 snapshot의 검은콩 탑승 상태가 잘못되었습니다.');
    }

    // Every landing picks a cannon again: after the fight delay, or at once after a hop or a forward throw.
    static land(sim, unit, spec, flight = 'enemy') {
        unit.cannonRide = {
            ...this.initialState(),
            readyTick:
                sim.tick +
                (flight === 'hop' || flight === 'front' ? 0 : sim.msTicks(spec.reboardDelayMs)),
        };
    }

    static clear(ride) {
        ride.phase = null;
        ride.cannonId = null;
        ride.launchTick = 0;
        ride.aimX = 0;
        ride.aimY = 0;
        ride.flight = null;
    }

    // Works on the live simulation and on any snapshot: a friendly launch cannon nobody is jamming.
    // Riding never spends the cannon's reload, so a reloading cannon still counts.
    static rideable(state, unit, cannon) {
        return (
            !!cannon &&
            LaunchRules.isLaunchCannon(cannon, unit.side) &&
            !LaunchRules.jammed(state, cannon)
        );
    }

    static cannonOf(sim, unit) {
        const id = unit.cannonRide.cannonId;
        const cannon = id === null ? null : sim.buildingById.get(id);
        return this.rideable(sim, unit, cannon) ? cannon : null;
    }

    // The muzzle the snapshot shows this soldier riding, or null.
    static boardedCannon(state, unit) {
        const ride = unit.cannonRide;
        if (unit.alive === false || ride?.phase !== 'board') return null;
        const cannon = (state?.buildings || []).find((b) => b.id === ride.cannonId);
        return this.rideable(state, unit, cannon) ? cannon : null;
    }

    // The cannons a side's riders may pick, as one key: it changes when a cannon is built, lost or jammed.
    static cannonListKey(sim, side) {
        let memo = LIST_KEYS.get(sim);
        if (!memo || memo.tick !== sim.tick) {
            memo = { tick: sim.tick, keys: [null, null] };
            LIST_KEYS.set(sim, memo);
        }
        if (memo.keys[side] === null) {
            let text = '';
            for (const cannon of sim.launchCannons(side))
                if (!LaunchRules.jammed(sim, cannon)) text += cannon.id + '|';
            memo.keys[side] = HashUtil.hash(text);
        }
        return memo.keys[side];
    }

    // A squad crowds the muzzle: a soldier one body behind those already standing there has arrived too.
    // The walking goal keeps one shared distance field per cannon (fixed), used only when the straight line is closed.
    static goal(sim, unit, cannon) {
        const radius = sim.buildingClearanceDistance(unit, cannon) + BOARD_PADDING,
            body = UnitDefinition.get(unit.type).size * 2,
            goal = NavigationGoal.range(cannon.x, cannon.y, radius, 0, true);
        goal.fixed = true;
        return {
            goal,
            arrival: new NavigationGoal(cannon.x, cannon.y, radius + body, 0, true),
        };
    }

    static arrived(sim, unit, cannon) {
        return (
            sim.terrainLevelAt(unit.x, unit.y) === sim.terrainLevelAt(cannon.x, cannon.y) &&
            sim.navigation.acceptsGoalPoint(this.goal(sim, unit, cannon).arrival, unit.x, unit.y)
        );
    }

    static enemyBase(sim, side) {
        return (
            sim.buildings.find(
                (b) =>
                    b.side === 1 - side &&
                    b.alive !== false &&
                    BuildingDefinition.isMainBase(b.type),
            ) || null
        );
    }

    // The nearest friendly cannon ahead of the soldier (closer to the enemy main base than the soldier is),
    // within the search reach; ties by id. With none ahead, the nearest one behind it within the same reach, so
    // a soldier that flew past the frontmost cannon goes back to ride again. null: no cannon in reach, march like any grain.
    static findCannon(sim, unit, spec) {
        const base = this.enemyBase(sim, unit.side);
        if (!base) return null;
        const reach =
                LaunchRules.maxReachOf(unit.type, sim.launchRangeLevel[unit.side]) *
                spec.cannonSearchReachMultiplier,
            reach2 = reach * reach,
            ahead2 = (unit.x - base.x) ** 2 + (unit.y - base.y) ** 2;
        let ahead = null,
            aheadD2 = Infinity,
            behind = null,
            behindD2 = Infinity;
        for (const cannon of sim.launchCannons(unit.side)) {
            const d2 = (cannon.x - unit.x) ** 2 + (cannon.y - unit.y) ** 2;
            if (d2 > reach2) continue;
            if ((cannon.x - base.x) ** 2 + (cannon.y - base.y) ** 2 < ahead2) {
                if (d2 > aheadD2 || (d2 === aheadD2 && cannon.id > ahead.id)) continue;
                if (LaunchRules.jammed(sim, cannon)) continue;
                ahead = cannon;
                aheadD2 = d2;
            } else {
                if (d2 > behindD2 || (d2 === behindD2 && cannon.id > behind.id)) continue;
                if (LaunchRules.jammed(sim, cannon)) continue;
                behind = cannon;
                behindD2 = d2;
            }
        }
        return ahead || behind;
    }

    // Where a soldier on this cannon flies, always somewhere, within the cannon's launch range:
    // a. the nearest visible enemy soldier, b. the nearest visible enemy building, c. beside the nearest
    // friendly cannon closer to the enemy main base, d. toward the enemy main base at full range.
    static flightTarget(sim, unit, cannon, sources) {
        const side = unit.side,
            level = sim.launchRangeLevel[side],
            maxReach = LaunchRules.maxReachOf(unit.type, level),
            max2 = maxReach * maxReach;
        let best = null,
            bestD2 = Infinity;
        const consider = (entity) => {
            const d2 = (entity.x - cannon.x) ** 2 + (entity.y - cannon.y) ** 2;
            if (d2 > max2 || d2 > bestD2 || (d2 === bestD2 && entity.id > best.id)) return;
            best = entity;
            bestD2 = d2;
        };
        sim.forEachNearbyHostileUnit(side, cannon.x, cannon.y, maxReach, (enemy) => {
            if (sim.canSeeCombatTarget(side, enemy, sources)) consider(enemy);
        });
        if (!best)
            for (const building of sim.buildings)
                if (
                    sim.isHostileCombatBuilding(side, building) &&
                    sim.isVisible(side, building.x, building.y, sources)
                )
                    consider(building);
        const base = this.enemyBase(sim, side);
        if (best) return { ...this.pastMuzzle(sim, unit, cannon, best), flight: 'enemy' };

        if (base) {
            const front2 = (b) => (b.x - base.x) ** 2 + (b.y - base.y) ** 2,
                here = front2(cannon);
            let hop = null,
                hopD2 = Infinity,
                next = null;
            for (const candidate of sim.launchCannons(side)) {
                if (candidate === cannon || front2(candidate) >= here) continue;
                const d2 = (candidate.x - cannon.x) ** 2 + (candidate.y - cannon.y) ** 2;
                if (d2 > hopD2 || (d2 === hopD2 && candidate.id > next.id)) continue;
                if (LaunchRules.jammed(sim, candidate)) continue;
                const landing = this.hopLanding(sim, unit, cannon, candidate, base);
                if ((landing.x - cannon.x) ** 2 + (landing.y - cannon.y) ** 2 > max2) continue;
                next = candidate;
                hopD2 = d2;
                hop = landing;
            }
            if (hop) return { ...hop, flight: 'hop' };
        }

        const toward = base || sim.flags[1 - side] || sim.flags[side],
            aim = LaunchRules.target(
                cannon,
                toward.x,
                toward.y,
                LaunchRules.chargeMs,
                sim.world,
                sim.flags[side],
                unit.type,
                level,
            );
        return { x: aim.x, y: aim.y, flight: 'front' };
    }

    // An aim right at the muzzle still flies: it moves out along the same line to MIN_FLIGHT past the muzzle.
    static pastMuzzle(sim, unit, cannon, target) {
        const muzzle = LaunchRules.muzzleReach(cannon) + MIN_FLIGHT;
        let dx = target.x - cannon.x,
            dy = target.y - cannon.y,
            length = Math.hypot(dx, dy);
        if (length >= muzzle) return { x: Math.round(target.x), y: Math.round(target.y) };
        if (length < 1) {
            const toward = this.enemyBase(sim, unit.side) || sim.flags[unit.side];
            dx = toward.x - cannon.x;
            dy = toward.y - cannon.y;
            length = Math.hypot(dx, dy) || 1;
        }
        return {
            x: Math.round(cannon.x + (dx / length) * muzzle),
            y: Math.round(cannon.y + (dy / length) * muzzle),
        };
    }

    // Inside the next cannon's boarding ring, on its side away from the enemy base (so that cannon is ahead of
    // the soldier), each soldier at its own angle so a squad does not land on one point.
    static hopLanding(sim, unit, from, to, base) {
        let dx = to.x - base.x,
            dy = to.y - base.y,
            length = Math.hypot(dx, dy);
        if (length < 1) {
            dx = from.x - to.x;
            dy = from.y - to.y;
            length = Math.hypot(dx, dy) || 1;
        }
        const spread = ((HashUtil.hash(unit.id + '|hop') % 1001) / 500 - 1) * HOP_SPREAD,
            angle = Math.atan2(dy, dx) + spread,
            gap = sim.buildingClearanceDistance(unit, to) + BOARD_PADDING;
        return {
            x: Math.round(to.x + Math.cos(angle) * gap),
            y: Math.round(to.y + Math.sin(angle) * gap),
        };
    }

    // On the muzzle: lock the aim and launch after boardMs.
    static board(sim, unit, spec, cannon, target) {
        const ride = unit.cannonRide;
        ride.phase = 'board';
        ride.cannonId = cannon.id;
        ride.launchTick = sim.tick + sim.msTicks(spec.boardMs);
        ride.aimX = target.x;
        ride.aimY = target.y;
        ride.flight = target.flight;
        unit.combat.cancelWindup();
        unit.constructionWork = null;
        unit.target = null;
    }

    static launch(sim, unit, cannon) {
        const ride = unit.cannonRide,
            level = sim.launchRangeLevel[unit.side],
            holdMs = Math.round(
                LaunchRules.holdFor(
                    Math.hypot(ride.aimX - cannon.x, ride.aimY - cannon.y),
                    unit.type,
                    level,
                ),
            ),
            [shot] = LaunchRules.volleyStats(unit.type);
        sim.fireLaunchShell({
            side: unit.side,
            cannonId: cannon.id,
            type: unit.type,
            mode: LaunchRules.grain(unit.type).fire.mode,
            shot: 0,
            shots: 1,
            power: LaunchRules.power(holdMs),
            holdMs,
            arcDistance: null,
            x: ride.aimX,
            y: ride.aimY,
            count: 1,
            impact: shot.impact,
            splash: shot.splash,
            passengerHp: unit.hp,
            ride: ride.flight,
        });
        // The soldier is now the shell's passenger; it lands as a new soldier with the same health.
        unit.alive = false;
        unit.hp = 0;
        unit.impactMotion = null;
        sim.syncUnitSpatial(unit);
    }

    // True when the ride took this tick's combat action.
    static update(sim, unit, spec, sources) {
        const ride = unit.cannonRide;
        if (ride.phase === 'board') {
            const cannon = this.cannonOf(sim, unit);
            if (!cannon) {
                this.clear(ride);
                ride.listKey = null;
                return false;
            }
            unit.combat.cancelWindup();
            unit.target = null;
            if (sim.tick >= ride.launchTick) this.launch(sim, unit, cannon);
            return true;
        }
        if (sim.tick < ride.readyTick) return false;
        const key = this.cannonListKey(sim, unit.side);
        let cannon = ride.phase === 'return' ? this.cannonOf(sim, unit) : null;
        // Pick again only when there is no pick yet, the cannon list changed, or the picked cannon is gone.
        if (ride.listKey !== key || (ride.phase === 'return' && !cannon)) {
            this.clear(ride);
            ride.listKey = key;
            cannon = this.findCannon(sim, unit, spec);
            if (cannon) {
                ride.phase = 'return';
                ride.cannonId = cannon.id;
            }
        }
        if (!cannon) return false;
        return this.walk(sim, unit, spec, cannon, sources);
    }

    // The way to the cannon drops any fight; a cannon that cannot be reached is given up until the list changes.
    static walk(sim, unit, spec, cannon, sources) {
        unit.combat.cancelWindup();
        unit.constructionWork = null;
        unit.target = null;
        if (
            !UnitMotion.isGrounded(unit) ||
            (unit.impactMotion && sim.tick < unit.impactMotion.recoverUntilTick)
        )
            return true;
        if (this.arrived(sim, unit, cannon)) {
            this.board(sim, unit, spec, cannon, this.flightTarget(sim, unit, cannon, sources));
            return true;
        }
        const { goal } = this.goal(sim, unit, cannon);
        if (!sim.navigation.nextPoint(unit, goal, 'field')) {
            this.clear(unit.cannonRide);
            return false;
        }
        const definition = UnitDefinition.get(unit.type),
            speed =
                (definition.speed *
                    spec.returnSpeedMultiplier *
                    sim.timedModifierPct(unit, 'movePct')) /
                100;
        sim.moveToGoal(unit, goal, speed, { path: 'field' });
        return true;
    }
}

export { CannonRider };
