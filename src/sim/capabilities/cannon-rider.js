// Contract (moved from the index.html Development Contract):
// - 검은콩(Unit Definition cannonRider)은 한 번에 10알을 싣는 묶음 투입탄이다. 착지(spawnUnit)할 때
//   Unit.cannonRide.readyTick(재탑승 가능 틱)을 정하고, 그 전에는 일반 근접 AI로 싸운다. readyTick 뒤에는
//   교전 중이어도 공용 교전 인식 거리(COMBAT_AGGRO_RANGE) 안에서 직선 경로가 열린 가장 가까운 탑승 가능 대포
//   (발사 대포 중 찹쌀에 막히지 않은 것, 재장전 중 포함, 같으면 id 순)로 이동속도 배율을 곱해 돌아간다(phase 'return').
//   대포가 없으면 계속 싸우며 주기적으로 다시 찾는다. 도착하면 한 명씩 탑승(phase 'board')해 조준을 고정하고,
//   탑승 시간 뒤 공용 fireLaunchShell로 자기 한 명(count 1, passengerHp=현재 체력)을 비용·재장전 없이 쏜다.
//   병사는 비행 중 투입탄 payload로만 존재하므로 인구는 그대로다. 비행 표적은 대포 사거리 안에서
//   ① 보이는 가장 가까운 적 병사 ② 보이는 가장 가까운 적 건물 ③ 현재 대포보다 적 본진에 가까운 아군 발사 대포 중
//   현재 대포에서 가장 가까운 것 앞 순서이고, 모두 없으면 그 대포 곁에서 기다리며 싸운다(phase 'wait').
//   타는 대포가 사라지거나 막히면 탑승을 취소한다. cannonRide 전체가 권위 상태다. 탑승 모습은 스냅샷의
//   cannonRide로 그리는 연출이며, 한 대포에 여러 명이면 가장 먼저 발사할 한 명만 그린다.
// A black-bean soldier walks back to a friendly cannon on its own and launches itself again.
// Unit.cannonRide { readyTick, phase, cannonId, launchTick, aimX, aimY } is the only state:
//   phase null     fights normally; once readyTick has passed it looks for a cannon to ride,
//   phase 'return' walks a straight line to that cannon, faster than usual, even mid-fight,
//   phase 'board'  sits on the muzzle until launchTick, then rides a shell of its own to the locked aim,
//   phase 'wait'   stands by the frontmost cannon and fights whatever comes near.
// The flight reuses the ordinary launch path: shell, flight, impact and landing. Only the issuer differs,
// it costs nothing, ignores the cannon's reload, and the single passenger keeps its health (payload.passengerHp).
import { BuildingDefinition } from '../../definitions/buildings.js';
import { UnitDefinition } from '../../definitions/units.js';
import { LaunchRules } from '../launch-rules.js';
import { NavigationGoal, UnitMotion } from '../navigation.js';

// Same margin as a returning hero: the bean stops just outside the cannon's body.
const BOARD_PADDING = 10;
// A hop to a forward cannon lands this far in front of that cannon's body, on the side it came from.
const HOP_LANDING_GAP = 30;

const PHASES = Object.freeze([null, 'return', 'board', 'wait']);

class CannonRider {
    static initialState() {
        return {
            readyTick: 0,
            phase: null,
            cannonId: null,
            launchTick: 0,
            aimX: 0,
            aimY: 0,
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
            (ride.cannonId !== null && typeof ride.cannonId !== 'string')
        )
            throw new Error('게임 snapshot의 검은콩 탑승 상태가 잘못되었습니다.');
    }

    // Every landing starts the wait again, including a hop to another cannon.
    static land(sim, unit, spec) {
        unit.cannonRide = {
            ...this.initialState(),
            readyTick: sim.tick + sim.msTicks(spec.reboardDelayMs),
        };
    }

    static clear(ride) {
        ride.phase = null;
        ride.cannonId = null;
        ride.launchTick = 0;
        ride.aimX = 0;
        ride.aimY = 0;
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

    // A squad crowds the muzzle: a soldier one body behind those already standing there has arrived too.
    static goal(sim, unit, cannon) {
        const radius = sim.buildingClearanceDistance(unit, cannon) + BOARD_PADDING,
            body = UnitDefinition.get(unit.type).size * 2;
        return {
            goal: NavigationGoal.range(cannon.x, cannon.y, radius, 0, true),
            arrival: new NavigationGoal(cannon.x, cannon.y, radius + body, 0, true),
        };
    }

    static arrived(sim, unit, cannon) {
        return (
            sim.terrainLevelAt(unit.x, unit.y) === sim.terrainLevelAt(cannon.x, cannon.y) &&
            sim.navigation.acceptsGoalPoint(this.goal(sim, unit, cannon).arrival, unit.x, unit.y)
        );
    }

    // Cannons within recognition range whose straight line is open; the nearest wins, ties by id.
    static findCannon(sim, unit) {
        const range = sim.combatTargetAggroRange(unit),
            range2 = range * range;
        let best = null,
            bestD2 = Infinity;
        for (const cannon of sim.launchCannons(unit.side)) {
            if (LaunchRules.jammed(sim, cannon)) continue;
            const d2 = (cannon.x - unit.x) ** 2 + (cannon.y - unit.y) ** 2;
            if (d2 > range2 || d2 > bestD2 || (d2 === bestD2 && cannon.id > best.id)) continue;
            if (
                !this.arrived(sim, unit, cannon) &&
                !sim.navigation.nextPoint(unit, this.goal(sim, unit, cannon).goal, 'direct')
            )
                continue;
            best = cannon;
            bestD2 = d2;
        }
        return best;
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

    // Where a soldier on this cannon flies, nearest first within the cannon's launch range:
    // a. a visible enemy soldier, b. a visible enemy building, c. a friendly cannon closer to the
    // enemy main base (the one nearest this cannon). null means this is the frontmost cannon: wait here.
    static flightTarget(sim, unit, cannon, sources) {
        const side = unit.side,
            minReach = LaunchRules.minReach,
            maxReach = LaunchRules.maxReachOf(unit.type, sim.launchRangeLevel[side]),
            min2 = minReach * minReach,
            max2 = maxReach * maxReach;
        const inReach = (x, y) => {
            const d2 = (x - cannon.x) ** 2 + (y - cannon.y) ** 2;
            return d2 >= min2 && d2 <= max2 ? d2 : -1;
        };
        let best = null,
            bestD2 = Infinity;
        const consider = (entity, x, y) => {
            const d2 = inReach(x, y);
            if (d2 < 0 || d2 > bestD2 || (d2 === bestD2 && entity.id > best.id)) return;
            best = entity;
            bestD2 = d2;
        };
        sim.forEachNearbyHostileUnit(side, cannon.x, cannon.y, maxReach, (enemy) => {
            if (sim.canSeeCombatTarget(side, enemy, sources)) consider(enemy, enemy.x, enemy.y);
        });
        if (best) return { x: best.x, y: best.y };
        for (const building of sim.buildings)
            if (
                sim.isHostileCombatBuilding(side, building) &&
                sim.isVisible(side, building.x, building.y, sources)
            )
                consider(building, building.x, building.y);
        if (best) return { x: best.x, y: best.y };

        const base = this.enemyBase(sim, side);
        if (!base) return null;
        const front2 = (b) => (b.x - base.x) ** 2 + (b.y - base.y) ** 2,
            here = front2(cannon);
        let hop = null;
        for (const next of sim.launchCannons(side)) {
            if (next === cannon || front2(next) >= here || LaunchRules.jammed(sim, next)) continue;
            const landing = this.hopLanding(sim, unit, cannon, next);
            if (inReach(landing.x, landing.y) < 0) continue;
            const d2 = (next.x - cannon.x) ** 2 + (next.y - cannon.y) ** 2;
            if (d2 > bestD2 || (d2 === bestD2 && next.id > best.id)) continue;
            best = next;
            bestD2 = d2;
            hop = landing;
        }
        return hop;
    }

    // In front of the next cannon's body, on the side the shell comes from.
    static hopLanding(sim, unit, from, to) {
        const dx = from.x - to.x,
            dy = from.y - to.y,
            length = Math.hypot(dx, dy) || 1,
            gap = sim.buildingClearanceDistance(unit, to) + HOP_LANDING_GAP;
        return { x: to.x + (dx / length) * gap, y: to.y + (dy / length) * gap };
    }

    // On the muzzle: lock the aim the way a held launch would, and launch after boardMs.
    static board(sim, unit, spec, cannon, target) {
        const level = sim.launchRangeLevel[unit.side],
            distance = Math.hypot(target.x - cannon.x, target.y - cannon.y),
            holdMs = Math.round(LaunchRules.holdFor(distance, unit.type, level)),
            aim = LaunchRules.target(
                cannon,
                target.x,
                target.y,
                holdMs,
                sim.world,
                sim.flags[unit.side],
                unit.type,
                level,
            );
        const ride = unit.cannonRide;
        ride.phase = 'board';
        ride.cannonId = cannon.id;
        ride.launchTick = sim.tick + sim.msTicks(spec.boardMs);
        ride.aimX = aim.x;
        ride.aimY = aim.y;
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
        });
        // The soldier is now the shell's passenger; it lands as a new soldier with the same health.
        unit.alive = false;
        unit.hp = 0;
        unit.impactMotion = null;
        sim.syncUnitSpatial(unit);
    }

    // On the cannon: fly to a target, hop forward, or stay as the frontmost guard.
    static decide(sim, unit, spec, cannon, sources) {
        const target = this.flightTarget(sim, unit, cannon, sources);
        if (target) {
            this.board(sim, unit, spec, cannon, target);
            return true;
        }
        const ride = unit.cannonRide;
        ride.phase = 'wait';
        ride.cannonId = cannon.id;
        return false;
    }

    // True when the ride took this tick's combat action.
    static update(sim, unit, spec, sources) {
        const ride = unit.cannonRide;
        if (ride.phase === null && sim.tick < ride.readyTick) return false;
        if (ride.phase === 'board') {
            const cannon = this.cannonOf(sim, unit);
            if (!cannon) {
                this.clear(ride);
                return false;
            }
            unit.combat.cancelWindup();
            unit.target = null;
            if (sim.tick >= ride.launchTick) this.launch(sim, unit, cannon);
            return true;
        }
        const cannon = ride.phase === null ? null : this.cannonOf(sim, unit);
        if (ride.phase !== null && !cannon) this.clear(ride);
        if (ride.phase === 'wait') {
            // A guard fights whatever comes near; only an idle guard back at its cannon looks again.
            if (unit.target !== null || !sim.combatTargetRefreshDue(unit)) return false;
            if (!this.arrived(sim, unit, cannon)) {
                if (!sim.navigation.nextPoint(unit, this.goal(sim, unit, cannon).goal, 'direct'))
                    this.clear(ride);
                return false;
            }
            return this.decide(sim, unit, spec, cannon, sources);
        }
        if (ride.phase === null) {
            if (!sim.combatTargetRefreshDue(unit)) return false;
            const found = this.findCannon(sim, unit);
            if (!found) return false;
            ride.phase = 'return';
            ride.cannonId = found.id;
            return this.walk(sim, unit, spec, found, sources);
        }
        return this.walk(sim, unit, spec, cannon, sources);
    }

    // The way back drops any fight and runs a straight line; a closed line gives the cannon up.
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
            this.decide(sim, unit, spec, cannon, sources);
            return true;
        }
        const { goal } = this.goal(sim, unit, cannon);
        if (!sim.navigation.nextPoint(unit, goal, 'direct')) {
            this.clear(unit.cannonRide);
            return false;
        }
        const definition = UnitDefinition.get(unit.type),
            speed =
                (definition.speed *
                    spec.returnSpeedMultiplier *
                    sim.timedModifierPct(unit, 'movePct')) /
                100;
        sim.moveToGoal(unit, goal, speed, { path: 'direct' });
        return true;
    }

    // An idle guard drifts back beside its cannon instead of marching to the rally point.
    static holdBeside(sim, unit, speed) {
        const ride = unit.cannonRide;
        if (ride?.phase !== 'wait') return false;
        const cannon = this.cannonOf(sim, unit);
        if (!cannon) return false;
        if (!this.arrived(sim, unit, cannon))
            sim.moveToGoal(unit, this.goal(sim, unit, cannon).goal, speed, { path: 'direct' });
        return true;
    }
}

export { CannonRider };
