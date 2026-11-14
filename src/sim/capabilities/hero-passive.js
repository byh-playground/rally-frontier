// Contract (HeroPassive):
// - 영웅 정의의 `growth[레벨].passive`는 그 레벨부터 늘 켜지는 패시브다(HeroGrowth.unlocked). 필드 하나가 하나의 패시브다
//   (정의 검사는 defineUnit). 레벨이 낮으면 아무것도 세거나 남기지 않는다.
// - `seedBurst { takenPerBurst, seeds, radius, damage, flightMs }`: 영웅이 받은 피해(실제로 줄어든 체력, 정수)를
//   `heroPassive.taken`에 쌓고, takenPerBurst가 찰 때마다 그만큼 빼고(나머지 이월) 씨앗 seeds알을 던진다. 씨앗은 메밀
//   씨앗과 같은 단발 투사체(UnitThornAttack)로 반경 radius 안의 지상 적 병력에게 날아가 알마다 damage를 준다. 표적은
//   가까운 순서로 서로 다른 적부터 고르고, 적이 씨앗보다 적으면 다시 가까운 적부터 돈다. 적이 없으면 던지지 않는다.
//   영웅이 그 피해로 쓰러지면 던지지 않는다.
// - `echoHit { ratio }`: 부메랑(평타 왕복·n번째 평타의 금빛 부메랑)이 갈 때 맞힌 적 병력을 같은 부메랑이 돌아올 때 또
//   맞히면 그 피해가 ratio배다(FruitHeroAttack). 평타 부메랑은 갈 때 맞힌 표적만 돌아올 때 다시 맞힐 수 있다.
// - `puddle { durationMs, tickMs, radius, damage }`: n번째 평타의 곡사탄(fruitAttack.lob)이 떨어진 자리에 웅덩이가
//   durationMs 남고, 지속 피해형 공격의 시간 문법(SustainedAttack, 재사용 대기 없음)으로 tickMs마다(첫 틱은 떨어진
//   틱) 반경 radius 안의 지상 적 병력에게 damage를 준다. 웅덩이는 영웅의 상태(`heroPassive.puddles`)라 영웅이
//   전사·회수되면 함께 사라진다.
// - 패시브의 처치도 영웅의 막타다(HeroGrowth). 실행마다 사건(`heroSeedBurst`·`heroPuddlePulse`, 부메랑은
//   `fruitProjectileHit`의 `echo`)을 낸다. 연출은 이 사건과 웅덩이 상태를 읽는다.
import { UnitDefinition } from '../../definitions/units.js';
import { HeroGrowth } from '../hero-growth.js';
import { IndexList } from '../index-list.js';
import { SustainedAttack } from './sustained-attack.js';
import { UnitThornAttack } from './unit-thorn-attack.js';

const SEED_QUERY = new IndexList();
// The seed shot's flight, as the buckwheat's seed (thornAttack) flies: thin, low from the body to the target.
const SEED_SHOT = Object.freeze({ radius: 2, launchHeight: 12, targetHeight: 8 });
const MAX_PUDDLES = 16;
const SUSTAIN_KEYS = Object.keys(SustainedAttack.initialState()).sort().join(',');

export class HeroPassive {
    // The passive a hero Definition declares at any level (its state shape), or null.
    static declared(type) {
        const growth = UnitDefinition.get(type)?.growth;
        for (const level of Object.keys(growth || {}))
            if (growth[level].passive) return growth[level].passive;
        return null;
    }

    // The state a hero body keeps for its passive, or null when it needs none.
    static initialState(type) {
        const spec = this.declared(type);
        if (spec?.seedBurst) return { taken: 0 };
        if (spec?.puddle) return { puddles: [] };
        return null;
    }

    static endSortie(unit) {
        if (unit.heroPassive) unit.heroPassive = this.initialState(unit.type);
    }

    // The hero `unit` just lost `dealt` health to an enemy (StrategySim.applyDamage).
    static onDamaged(sim, unit, dealt) {
        const burst = HeroGrowth.unlocked(unit, 'passive')?.seedBurst;
        if (!burst || !(dealt > 0)) return;
        const state = unit.heroPassive;
        state.taken += dealt;
        while (state.taken >= burst.takenPerBurst) {
            state.taken -= burst.takenPerBurst;
            if (unit.alive && unit.hp > 0) this.seedBurst(sim, unit, burst);
        }
    }

    // Seeds fly from the hero to the nearest ground enemy soldiers within the radius, distinct ones first.
    static seedBurst(sim, unit, burst) {
        const { radius } = burst;
        const found = sim.nearbyUnits(unit.x, unit.y, radius, 1 - unit.side, SEED_QUERY);
        const targets = [];
        for (let k = 0; k < found; k++) {
            const candidate = sim.units[SEED_QUERY.items[k]];
            if (!candidate?.alive || !sim.canAttackEntity(unit.type, candidate, false)) continue;
            const d2 = (candidate.x - unit.x) ** 2 + (candidate.y - unit.y) ** 2;
            if (d2 <= radius * radius) targets.push({ candidate, d2 });
        }
        targets.sort((a, b) => a.d2 - b.d2 || (a.candidate.id < b.candidate.id ? -1 : 1));
        if (targets.length) {
            // Shots this hero already started this tick (an earlier burst) keep their ids apart.
            let index = 0;
            for (const shot of sim.unitThornProjectiles)
                if (shot.sourceId === unit.id && shot.startTick === sim.tick + 1) index++;
            const shot = {
                durationMs: burst.flightMs,
                radius: SEED_SHOT.radius,
                launchHeight: SEED_SHOT.launchHeight,
                targetHeight: SEED_SHOT.targetHeight,
                damage: burst.damage,
            };
            for (let i = 0; i < burst.seeds; i++)
                UnitThornAttack.launch(
                    sim,
                    unit,
                    targets[i % targets.length].candidate,
                    false,
                    shot,
                    {
                        index: index++,
                        aim: false,
                    },
                );
        }
        sim.events.push({
            type: 'heroSeedBurst',
            side: unit.side,
            sourceId: unit.id,
            unit: unit.type,
            x: unit.x,
            y: unit.y,
            seeds: targets.length ? burst.seeds : 0,
        });
    }

    // How much a boomerang's return hit on a soldier it struck on the way out is multiplied (null: no echo).
    static echoRatio(unit) {
        return HeroGrowth.unlocked(unit, 'passive')?.echoHit?.ratio ?? null;
    }

    // A lobbed berry of the nth basic came down at (x, y): a puddle stays there.
    static lobLanded(sim, unit, x, y, zFP) {
        const spec = HeroGrowth.unlocked(unit, 'passive')?.puddle;
        if (!spec || unit.heroPassive.puddles.length >= MAX_PUDDLES) return;
        const sustain = SustainedAttack.initialState();
        SustainedAttack.start(sim, sustain, spec);
        unit.heroPassive.puddles.push({ x, y, zFP, sustain });
    }

    // The puddles' damage ticks; a puddle whose time is up dries.
    static update(sim, unit) {
        const puddles = unit.heroPassive?.puddles;
        if (!puddles?.length) return;
        const spec = this.declared(unit.type).puddle;
        const kept = [];
        for (const puddle of puddles) {
            if (!SustainedAttack.advance(sim, puddle.sustain)) continue;
            kept.push(puddle);
            if (!SustainedAttack.takeTick(sim, puddle.sustain, spec)) continue;
            const { hits } = sim.applyAreaDamage({
                sourceSide: unit.side,
                sourceType: unit.type,
                sourceEntityId: unit.id,
                x: puddle.x,
                y: puddle.y,
                radius: spec.radius,
                damage: spec.damage,
                impactHeightFP: puddle.zFP,
                // The hero's own damage class (as its landing strike), not the splash class: 3 is 3 on any body.
                damageClass: UnitDefinition.damageClass(unit.type),
                suppressImpactFx: true,
            });
            sim.events.push({
                type: 'heroPuddlePulse',
                side: unit.side,
                sourceId: unit.id,
                unit: unit.type,
                x: puddle.x,
                y: puddle.y,
                hits,
            });
            if (!unit.alive) return;
        }
        unit.heroPassive.puddles = kept;
    }

    static validateState(unit, state) {
        const initial = this.initialState(unit.type);
        const passive = unit.heroPassive;
        if (!initial && passive === undefined) return;
        const deployed = unit.alive && state.heroes?.[unit.side]?.[unit.type]?.unitId === unit.id;
        const valid =
            initial &&
            passive &&
            Object.keys(passive).sort().join(',') === Object.keys(initial).sort().join(',') &&
            (initial.taken === undefined ||
                (Number.isSafeInteger(passive.taken) &&
                    passive.taken >= 0 &&
                    passive.taken < this.declared(unit.type).seedBurst.takenPerBurst &&
                    (deployed || passive.taken === 0))) &&
            (initial.puddles === undefined ||
                (Array.isArray(passive.puddles) &&
                    passive.puddles.length <= MAX_PUDDLES &&
                    (deployed || !passive.puddles.length) &&
                    passive.puddles.every(
                        (puddle) =>
                            puddle &&
                            Object.keys(puddle).sort().join(',') === 'sustain,x,y,zFP' &&
                            Number.isFinite(puddle.x) &&
                            Number.isFinite(puddle.y) &&
                            Number.isSafeInteger(puddle.zFP) &&
                            puddle.sustain &&
                            Object.keys(puddle.sustain).sort().join(',') === SUSTAIN_KEYS &&
                            puddle.sustain.active === true &&
                            Number.isSafeInteger(puddle.sustain.endTick) &&
                            puddle.sustain.endTick > state.tick,
                    )));
        if (!valid) throw new Error('게임 snapshot의 영웅 패시브 상태가 잘못되었습니다.');
    }
}
