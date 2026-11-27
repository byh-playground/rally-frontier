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
//   그 대포의 탑승 고리를 목표로 하는 공용 고정 흐름장(navigation field, 대포 중심이 키라 건물 배치가 바뀔 때만 다시 만듦)을 따른다.
//   도착하면 한 명씩 탑승(phase 'board')해 조준을 고정하고, 탑승 시간 뒤 공용 fireLaunchShell로 자기 한 명
//   (count 1, passengerHp=현재 체력, ride=비행 종류)을 비용·재장전 없이 쏜다. 탑승한 대포는 반드시 발사한다.
// - 검은콩 상태는 'march'(일반 교전·재탑승 대기), 'return'(대포로 복귀), 'board'(탑승해 발사 준비),
//   'wait'(앞서 발사한 적 조준탄이 끝나길 기다림) 중 하나다. 'board'와 'wait'가 포구를 점유하며,
//   대포 하나에 한 명만 들어간다. 렌더와 발사 판정이 같은 점유 상태를 읽는다.
// - 적을 노린 포탄이 남아 있으면 포구에서 기다린다. 앞 포탄이 착탄하거나 요격되면 조준을 다시 정하고 탑승 시간 뒤 쏜다.
//   'hop'과 'front'는 앞서 쏜 포탄의 착탄을 기다리지 않는다.
// - 비행 표적(대포 사거리 안)은 보이는 적 병사 → 보이는 적 건물 → 더 앞쪽 아군 대포('hop') → 적진 방향('front') 순이다.
//   포구보다 너무 가까운 표적은 같은 방향으로 포구 밖 MIN_FLIGHT만큼 떨어진 곳을 노린다.
// - 재발사는 공용 발사·비행·착지 경로를 쓰고 대포의 비용·재장전을 쓰지 않는다. 탄은 검은콩 한 명의 현재 체력을 보관한다.
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { LaunchRules } from '../launch-rules.js';
import { HashUtil } from '../map-generation.js';
import { NavigationGoal, UnitMotion } from '../navigation.js';
import { IndexList } from '../index-list.js';
import { EntityKey } from '../entities.js';

const ENEMY_QUERY = new IndexList();

// Same margin as a returning hero: the bean stops just outside the cannon's body.
const BOARD_PADDING = 10;
// A shell aimed closer than this past the muzzle flies this far in the same direction instead.
const MIN_FLIGHT = 40;
// Hop landings fan out this far either side of the line from the next cannon away from the enemy base.
const HOP_SPREAD = Math.PI / 4;

const PHASE_FIELDS = Object.freeze({
    march: ['phase', 'readyTick', 'listKey'],
    return: ['phase', 'listKey', 'cannonId'],
    board: ['phase', 'cannonId', 'launchTick', 'aimX', 'aimY', 'flight'],
    wait: ['phase', 'cannonId', 'aimX', 'aimY'],
});
const MUZZLES = new WeakMap();
// enemy: aimed at an enemy (or launched by the player), fights before picking a cannon again.
// hop:   dropped beside a cannon further forward, picks a cannon again at once.
// front: thrown toward the enemy base from the frontmost cannon, picks a cannon again at once.
const FLIGHTS = Object.freeze(['enemy', 'hop', 'front']);

// Per tick and side: a key of the cannons a rider may pick. Derived from the state, never stored in it.
const LIST_KEYS = new WeakMap();
// Per tick: the cannons with an enemy-bound rider shell still in the air. Derived from the projectiles, never stored.
const IN_FLIGHT = new WeakMap();

class CannonRider {
    static FLIGHTS = FLIGHTS;

    static initialState(readyTick = 0, listKey = null) {
        return { phase: 'march', readyTick, listKey };
    }

    static occupiesMuzzle(ride) {
        return ride?.phase === 'board' || ride?.phase === 'wait';
    }

    static validateState(unit, occupiedMuzzles) {
        if (!UnitDefinition.get(unit.type)?.cannonRider) return;
        const ride = unit.cannonRide;
        const fields = ride && Object.hasOwn(PHASE_FIELDS, ride.phase) && PHASE_FIELDS[ride.phase];
        if (
            !fields ||
            Object.keys(ride).length !== fields.length ||
            !fields.every((field) => Object.hasOwn(ride, field)) ||
            (fields.includes('listKey') &&
                !(ride.listKey === null && ride.phase === 'march') &&
                (!Number.isSafeInteger(ride.listKey) || ride.listKey < 0)) ||
            (ride.phase === 'march'
                ? !Number.isSafeInteger(ride.readyTick) || ride.readyTick < 0
                : typeof ride.cannonId !== 'string' || !ride.cannonId) ||
            (this.occupiesMuzzle(ride) &&
                (!Number.isSafeInteger(ride.aimX) || !Number.isSafeInteger(ride.aimY))) ||
            (ride.phase === 'board' &&
                (!Number.isSafeInteger(ride.launchTick) ||
                    ride.launchTick < 0 ||
                    !FLIGHTS.includes(ride.flight)))
        )
            throw new Error('게임 snapshot의 검은콩 탑승 상태가 잘못되었습니다.');

        if (!unit.alive || !this.occupiesMuzzle(ride)) return;
        if (occupiedMuzzles.has(ride.cannonId))
            throw new Error('게임 snapshot에서 한 포구에 검은콩이 중복 탑승했습니다.');
        occupiedMuzzles.add(ride.cannonId);
    }

    // Enemy drops fight before seeking another ride; hops and forward throws can seek immediately.
    static land(sim, unit, spec, flight = 'enemy') {
        const delay = flight === 'enemy' ? sim.time.ceilTicks(spec.reboardDelayMs) : 0;
        unit.cannonRide = this.initialState(sim.tick + delay);
    }

    // Derived from the unit phases. Preserve the index through this tick's claims, and rebuild it
    // if rollback/import replaces the unit list at the same tick.
    static muzzleOwners(sim) {
        let memo = MUZZLES.get(sim);
        if (memo?.tick === sim.tick && memo.units === sim.units) return memo.owners;
        const owners = new Map();
        for (const unit of sim.units)
            if (unit.alive && this.occupiesMuzzle(unit.cannonRide))
                owners.set(unit.cannonRide.cannonId, unit);
        MUZZLES.set(sim, { tick: sim.tick, units: sim.units, owners });
        return owners;
    }

    // True while a shell this cannon fired with an enemy-bound rider has neither struck nor been shot down.
    static shellInFlight(sim, cannon) {
        let memo = IN_FLIGHT.get(sim);
        if (!memo) IN_FLIGHT.set(sim, (memo = { tick: -1, projectiles: null, ids: new Set() }));
        if (memo.tick !== sim.tick || memo.projectiles !== sim.projectiles) {
            memo.tick = sim.tick;
            memo.projectiles = sim.projectiles;
            memo.ids.clear();
            for (const p of sim.projectiles)
                if (p.alive && p.payload?.ride === 'enemy') memo.ids.add(p.owner);
        }
        return memo.ids.has(cannon.id);
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
        const cannon = sim.buildingById.get(unit.cannonRide.cannonId);
        return this.rideable(sim, unit, cannon) ? cannon : null;
    }

    // The muzzle the snapshot shows this soldier riding, or null.
    static boardedCannon(state, unit) {
        const ride = unit.cannonRide;
        if (unit.alive === false || !this.occupiesMuzzle(ride)) return null;
        const cannon = (state?.buildings || []).find((b) => b.id === ride.cannonId);
        return this.rideable(state, unit, cannon) ? cannon : null;
    }

    // The cannons a side's riders may pick, as one key: it changes when a cannon is built, lost or jammed.
    static cannonListKey(sim, side) {
        let memo = LIST_KEYS.get(sim);
        if (!memo) LIST_KEYS.set(sim, (memo = { tick: -1, keys: [null, null] }));
        if (memo.tick !== sim.tick) {
            memo.tick = sim.tick;
            memo.keys[0] = memo.keys[1] = null;
        }
        if (memo.keys[side] === null) {
            // One word per open cannon in building order: its id's sequence number · 2, plus 1 for the main base
            // (whose id ends in its side, which a sequence number can repeat). Sequence numbers stay below 2^31, so
            // every word is below 2^32; the hash is below 2^32, a safe integer for the saved listKey.
            let h = HashUtil.OFFSET;
            for (const cannon of sim.buildings)
                if (LaunchRules.isLaunchCannon(cannon, side) && !LaunchRules.jammed(sim, cannon))
                    h = HashUtil.word(
                        h,
                        EntityKey.number(cannon.id) * 2 +
                            (BuildingDefinition.get(cannon.type)?.isMainBase ? 1 : 0),
                    );
            memo.keys[side] = HashUtil.finish(h);
        }
        return memo.keys[side];
    }

    // A squad crowds the muzzle: a soldier one body behind those already standing there has arrived too.
    // The walking goal keeps one shared flow field per cannon (fixed goal key), used only when the straight line is closed.
    static goal(sim, unit, cannon) {
        const radius = sim.buildingClearanceDistance(unit, cannon) + BOARD_PADDING,
            body = UnitDefinition.get(unit.type).size * 2,
            goal = NavigationGoal.range(cannon.x, cannon.y, radius, 0, true, true);
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
        const count = sim.nearbyHostileUnits(side, cannon.x, cannon.y, maxReach, ENEMY_QUERY);
        for (let k = 0; k < count; k++) {
            const enemy = sim.units[ENEMY_QUERY.items[k]];
            if (sim.canSeeCombatTarget(side, enemy, sources)) consider(enemy);
        }
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

    // The claimed muzzle holds one rider and one locked aim until its preparation is complete.
    static board(sim, unit, spec, cannon, target) {
        unit.cannonRide = {
            phase: 'board',
            cannonId: cannon.id,
            launchTick: sim.tick + sim.time.ceilTicks(spec.boardMs),
            aimX: target.x,
            aimY: target.y,
            flight: target.flight,
        };
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
        // A rider boarded behind this one on the same tick sees the shell that just left.
        const memo = IN_FLIGHT.get(sim);
        if (ride.flight === 'enemy' && memo?.tick === sim.tick) memo.ids.add(cannon.id);
        // The soldier is now the shell's passenger; it lands as a new soldier with the same health.
        unit.alive = false;
        unit.hp = 0;
        unit.impactMotion = null;
        sim.syncUnitSpatial(unit);
    }

    // True when the ride took this tick's combat action.
    static update(sim, unit, spec, sources) {
        const ride = unit.cannonRide;
        if (this.occupiesMuzzle(ride)) {
            const cannon = this.cannonOf(sim, unit);
            if (!cannon) {
                unit.cannonRide = this.initialState();
                return false;
            }
            unit.combat.cancelWindup();
            unit.target = null;
            if (ride.phase === 'wait') {
                // Aim again after the preceding enemy shot has struck or been intercepted.
                if (!this.shellInFlight(sim, cannon))
                    this.board(
                        sim,
                        unit,
                        spec,
                        cannon,
                        this.flightTarget(sim, unit, cannon, sources),
                    );
            } else if (sim.tick >= ride.launchTick) {
                if (ride.flight === 'enemy' && this.shellInFlight(sim, cannon))
                    unit.cannonRide = {
                        phase: 'wait',
                        cannonId: ride.cannonId,
                        aimX: ride.aimX,
                        aimY: ride.aimY,
                    };
                else this.launch(sim, unit, cannon);
            }
            return true;
        }

        if (ride.phase === 'march' && sim.tick < ride.readyTick) return false;
        const key = this.cannonListKey(sim, unit.side);
        let cannon = ride.phase === 'return' ? this.cannonOf(sim, unit) : null;
        // Pick again only when there is no pick yet, the cannon list changed, or the picked cannon is gone.
        if (ride.listKey !== key || (ride.phase === 'return' && !cannon)) {
            cannon = this.findCannon(sim, unit, spec);
            unit.cannonRide = cannon
                ? { phase: 'return', listKey: key, cannonId: cannon.id }
                : this.initialState(0, key);
        }
        return cannon ? this.walk(sim, unit, spec, cannon, sources) : false;
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
            const owners = this.muzzleOwners(sim),
                owner = owners.get(cannon.id);
            if (
                owner?.alive &&
                owner.side === cannon.side &&
                this.occupiesMuzzle(owner.cannonRide) &&
                owner.cannonRide.cannonId === cannon.id
            )
                return true;
            this.board(sim, unit, spec, cannon, this.flightTarget(sim, unit, cannon, sources));
            owners.set(cannon.id, unit);
            return true;
        }
        const { goal } = this.goal(sim, unit, cannon);
        if (!sim.navigation.nextPoint(unit, goal, 'field')) {
            unit.cannonRide = this.initialState(0, unit.cannonRide.listKey);
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
