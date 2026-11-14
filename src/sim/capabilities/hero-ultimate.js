// Contract (HeroUltimate):
// - 영웅 정의의 `growth[레벨].ultimate { cooldownMs, checkMs, <한 방>: spec }`은 그 레벨부터 영웅이 스스로 쓰는 한
//   방이다(HeroGrowth.unlocked, 정의 검사는 defineUnit). 플레이어 명령·자원 비용이 없다. 한 방 필드 하나가 한 방이다.
// - 계기는 매 틱 세지 않는다. 출격 중(`advance`) 땅 위의 영웅이 checkMs마다 한 번(해금된 첫 틱부터) 적 공간
//   색인(StrategySim.nearbyUnits)으로 보이는 지상 적 병력을 세고, 계기가 되면 그 틱에 쓴다. 쓴 틱부터 cooldownMs
//   동안은 다시 쓰지 않는다(내부 재발동 대기, `heroUltimate.readyTick`). 해금 직후엔 대기가 없다.
// - `siegeRoll { reach, moreThan, hopMs, hopHeight, landing { radius, damage }, distance, speed, bodyScale, damage,
//   buildingDamage }`(수박): 적 본진 쪽 반원(영웅 둘레 reach) 안의 적 병력이 moreThan명보다 많으면 그 무리 중심
//   쪽으로 공성 구르기(HeroRollAttack `siege`)를 시작한다. 구르는 중·휩쓸기·평타 준비 중이면 다음 확인으로 미룬다.
// - `boomerang { moreThan, length, radius, travelMs, damage }`(바나나): 사거리 안의 적(가까운 16명)마다 그 쪽으로
//   length(맵 끝에서 멈춤)만큼 폭 반경 radius의 띠를 그어 띠 안의 적을 세고, 가장 많은 띠가 moreThan명보다 많으면
//   그 쪽으로 초대형 부메랑(FruitHeroAttack `ultimate`)을 던진다. 부메랑은 갈 때·올 때 travelMs씩 곧게 날며 띠의
//   적을 모두 관통해 damage를 주고, 던진 자리로 돌아온다. 날고 있는 평타 부메랑과는 따로 난다.
// - `berryRain { moreThan, clusterRadius, radius, berries, durationMs, fallMs, dropHeight, berryRadius, damage }`
//   (포도): 사거리 안의 적(가까운 16명)마다 둘레 clusterRadius 안의 적을 세어 가장 많은 자리가 moreThan명보다
//   많으면 그 적의 자리를 중심으로 durationMs 동안 berries알을 고르게(해바라기씨 나선, 무작위 없음) 반경 radius
//   안에 떨어뜨린다. 알은 dropHeight에서 fallMs 동안 곧게 떨어져(FruitHeroAttack `ultimate` 열매) 반경
//   berryRadius 안의 지상 적에게 damage를 준다. 떨어질 자리에 예고 원을 그린다. 비는 영웅 상태(`heroUltimate.rain`)라
//   영웅이 전사·회수되면 함께 그친다.
// - 한 방의 처치도 영웅의 막타다(HeroGrowth). 쓸 때마다 `heroUltimate` 사건을 낸다.
import { UnitDefinition } from '../../definitions/units.js';
import { HeroGrowth } from '../hero-growth.js';
import { IndexList } from '../index-list.js';
import { UnitMotion } from '../navigation.js';
import { FruitHeroAttack } from './fruit-hero-attack.js';
import { HeroLandingStrike } from './hero-landing-strike.js';
import { HeroRollAttack } from './hero-roll-attack.js';

const ENEMY_QUERY = new IndexList();
const STATE_KEYS = 'checkTick,rain,readyTick';
const RAIN_KEYS = 'dropped,endTick,startTick,x,y';
// The nearest enemies a boomerang line or a berry rain is aimed at, at most.
const MAX_CANDIDATES = 16;
// The rain's berries fall on a sunflower spiral: even over the disc, the same every time.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

function nearer(a, b) {
    return a.d2 - b.d2 || (a.unit.id < b.unit.id ? -1 : 1);
}

export class HeroUltimate {
    static declared(type) {
        return HeroGrowth.declared(type, 'ultimate');
    }

    static initialState() {
        return { checkTick: 0, readyTick: 0, rain: null };
    }

    static endSortie(unit) {
        if (unit.heroUltimate) unit.heroUltimate = this.initialState();
    }

    // Once per tick for each deployed hero (`hero` its slot), before its roll and shots advance.
    static update(sim, unit, hero) {
        const state = unit.heroUltimate;
        if (!state || !unit.alive) return;
        const spec = HeroGrowth.unlocked(unit, 'ultimate');
        if (!spec) return;
        if (state.rain) this.advanceRain(sim, unit, state, spec.berryRain);
        if (sim.tick < state.checkTick) return;
        state.checkTick = sim.tick + sim.msTicks(spec.checkMs);
        if (sim.tick < state.readyTick || hero.mode !== 'advance' || !UnitMotion.isGrounded(unit))
            return;
        const kind = spec.siegeRoll ? 'siegeRoll' : spec.boomerang ? 'boomerang' : 'berryRain';
        const aim = this[kind](sim, unit, spec[kind], state);
        if (!aim) return;
        state.readyTick = sim.tick + sim.msTicks(spec.cooldownMs);
        sim.events.push({
            type: 'heroUltimate',
            side: unit.side,
            sourceId: unit.id,
            unit: unit.type,
            kind,
            level: unit.heroGrowth.level,
            x: unit.x,
            y: unit.y,
            count: aim.count,
            aimX: aim.x,
            aimY: aim.y,
        });
    }

    // The visible living ground enemy soldiers the hero can hit within `radius` of (x, y), with their squared
    // distance from (x, y).
    static enemies(sim, unit, x, y, radius, sources) {
        const found = sim.nearbyUnits(x, y, radius, 1 - unit.side, ENEMY_QUERY);
        const out = [];
        for (let k = 0; k < found; k++) {
            const candidate = sim.units[ENEMY_QUERY.items[k]];
            if (
                !candidate?.alive ||
                candidate.hp <= 0 ||
                !UnitMotion.isGrounded(candidate) ||
                !sim.canAttackEntity(unit.type, candidate)
            )
                continue;
            const d2 = (candidate.x - x) ** 2 + (candidate.y - y) ** 2;
            if (d2 > radius * radius || !sim.canSeeCombatTarget(unit.side, candidate, sources))
                continue;
            out.push({ unit: candidate, d2 });
        }
        return out.sort(nearer);
    }

    // The enemies a boomerang or a rain is aimed at: the nearest within the hero's attack range.
    static candidates(sim, unit, enemies) {
        const range = UnitDefinition.get(unit.type).range,
            out = [];
        for (const enemy of enemies) {
            if (enemy.d2 > range * range) break;
            out.push(enemy.unit);
            if (out.length === MAX_CANDIDATES) break;
        }
        return out;
    }

    static siegeRoll(sim, unit, spec) {
        if (!HeroRollAttack.canStart(unit, sim.tick)) return null;
        const home = HeroLandingStrike.homeDirection(sim, unit.side, unit.x, unit.y);
        const sources = sim.visionSources(unit.side);
        let count = 0,
            sx = 0,
            sy = 0;
        for (const { unit: enemy } of this.enemies(
            sim,
            unit,
            unit.x,
            unit.y,
            spec.reach,
            sources,
        )) {
            const rx = enemy.x - unit.x,
                ry = enemy.y - unit.y;
            // In front: on the enemy base's side of the hero.
            if (rx * home.dx + ry * home.dy > 0) continue;
            count++;
            sx += rx;
            sy += ry;
        }
        if (count <= spec.moreThan) return null;
        const length = Math.hypot(sx, sy);
        const dx = length ? sx / length : -home.dx,
            dy = length ? sy / length : -home.dy;
        HeroRollAttack.siege(sim, unit, dx, dy, spec);
        return { count, x: unit.x + dx * spec.distance, y: unit.y + dy * spec.distance };
    }

    static boomerang(sim, unit, spec) {
        // A basic boomerang in flight does not hold it back (the banana throws one nearly all the time).
        if (unit.fruitAttack.projectiles.some((shot) => shot.mode === 'ultimate')) return null;
        const sources = sim.visionSources(unit.side);
        const enemies = this.enemies(
            sim,
            unit,
            unit.x,
            unit.y,
            spec.length + spec.radius + sim.maxUnitRadius,
            sources,
        );
        let best = null;
        for (const target of this.candidates(sim, unit, enemies)) {
            const end = FruitHeroAttack.boomerangTurnPoint(sim, unit, target, spec.length);
            const ex = end.x - unit.x,
                ey = end.y - unit.y,
                length = Math.hypot(ex, ey);
            if (!length) continue;
            const ux = ex / length,
                uy = ey / length;
            let count = 0;
            for (const { unit: enemy } of enemies) {
                const rx = enemy.x - unit.x,
                    ry = enemy.y - unit.y,
                    along = rx * ux + ry * uy,
                    reach = spec.radius + sim.unitRadius(enemy);
                if (along < -reach || along > length + reach) continue;
                if (Math.abs(rx * uy - ry * ux) <= reach) count++;
            }
            if (!best || count > best.count) best = { target, count, end };
        }
        if (!best || best.count <= spec.moreThan) return null;
        FruitHeroAttack.ultimateBoomerang(sim, unit, best.target, spec);
        return { count: best.count, x: best.end.x, y: best.end.y };
    }

    static berryRain(sim, unit, spec, state) {
        if (state.rain) return null;
        const sources = sim.visionSources(unit.side);
        const range = UnitDefinition.get(unit.type).range;
        const enemies = this.enemies(
            sim,
            unit,
            unit.x,
            unit.y,
            range + spec.clusterRadius,
            sources,
        );
        let best = null;
        for (const target of this.candidates(sim, unit, enemies)) {
            let count = 0;
            for (const { unit: enemy } of enemies)
                if (
                    (enemy.x - target.x) ** 2 + (enemy.y - target.y) ** 2 <=
                    spec.clusterRadius ** 2
                )
                    count++;
            if (!best || count > best.count) best = { target, count };
        }
        if (!best || best.count <= spec.moreThan) return null;
        const { x, y } = best.target;
        state.rain = {
            x,
            y,
            startTick: sim.tick,
            endTick: sim.tick + Math.max(1, sim.msTicks(spec.durationMs)),
            dropped: 0,
        };
        this.advanceRain(sim, unit, state, spec);
        return { count: best.count, x, y };
    }

    // The berries due by this tick fall, spread over the rain's time; the rain stops once all have fallen (the
    // berries still in the air land on their own).
    static advanceRain(sim, unit, state, spec) {
        const rain = state.rain;
        const span = rain.endTick - rain.startTick;
        const due = Math.min(
            spec.berries,
            Math.floor(((sim.tick - rain.startTick) * spec.berries) / span) + 1,
        );
        for (; rain.dropped < due; rain.dropped++) {
            const k = rain.dropped,
                r = spec.radius * Math.sqrt((k + 0.5) / spec.berries),
                angle = k * GOLDEN_ANGLE;
            FruitHeroAttack.rainBerry(
                sim,
                unit,
                rain.x + Math.cos(angle) * r,
                rain.y + Math.sin(angle) * r,
                spec,
                k,
            );
        }
        if (rain.dropped >= spec.berries) state.rain = null;
    }

    static validateState(unit, state) {
        const spec = this.declared(unit.type);
        const ultimate = unit.heroUltimate;
        if (!spec && ultimate === undefined) return;
        const deployed = unit.alive && state.heroes?.[unit.side]?.[unit.type]?.unitId === unit.id;
        const rain = ultimate?.rain;
        const valid =
            spec &&
            ultimate &&
            Object.keys(ultimate).sort().join(',') === STATE_KEYS &&
            Number.isSafeInteger(ultimate.checkTick) &&
            ultimate.checkTick >= 0 &&
            Number.isSafeInteger(ultimate.readyTick) &&
            ultimate.readyTick >= 0 &&
            (deployed || (!ultimate.checkTick && !ultimate.readyTick && rain === null)) &&
            (rain === null ||
                (!!spec.berryRain &&
                    !!rain &&
                    Object.keys(rain).sort().join(',') === RAIN_KEYS &&
                    Number.isFinite(rain.x) &&
                    Number.isFinite(rain.y) &&
                    Number.isSafeInteger(rain.startTick) &&
                    rain.startTick >= 0 &&
                    rain.startTick <= state.tick &&
                    Number.isSafeInteger(rain.endTick) &&
                    rain.endTick > rain.startTick &&
                    Number.isInteger(rain.dropped) &&
                    rain.dropped > 0 &&
                    rain.dropped < spec.berryRain.berries));
        if (!valid) throw new Error('게임 snapshot의 영웅 자동 한 방 상태가 잘못되었습니다.');
    }
}
