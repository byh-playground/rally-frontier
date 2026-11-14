import { HERO_MOVE_SPEED, HERO_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Grape = defineUnit({
    id: 'grape',
    hero: true,
    unit: {
        name: '포도',
        hp: 300,
        atk: 20,
        range: 175,
        speed: HERO_MOVE_SPEED,
        attackIntervalMs: 900,
        size: 25,
        sizeClass: 'medium',
        role: 'ranged',
        canAttackAir: true,
        damageClass: 'ranged',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 275,
        fruitAttack: Object.freeze({
            kind: 'grape',
            every: 4,
            basicMs: 300,
            radius: 5,
            lob: Object.freeze({ durationMs: 500, height: 100, radius: 50, damage: 20 }),
        }),
        // Level unlocks (HeroGrowth.unlocked). Level 2: a berry hops from each soldier it finishes to the nearest
        // enemy, on the lob's path (a hopped berry's own kill hops no further).
        // Level 3: each lobbed berry of the nth basic leaves a puddle of juice for 2 s that hurts the enemies on it
        // every 0.5 s (HeroPassive, the sustained-attack timing). Level 4: the allies within 150 (not the hero
        // itself, refreshed every 0.5 s) regain 2% of their health every second (HeroAllyAura).
        // Level 5: with more than 8 enemies packed within 75 of one in range, 60 berries rain over 250 around it for
        // 2 s, at most once every 20 s (HeroUltimate berryRain). Level 6: every basic is the nth one, with the three
        // lobbed berries (awaken).
        growth: Object.freeze({
            2: Object.freeze({
                killEffect: Object.freeze({ bounce: Object.freeze({ radius: 100, damage: 20 }) }),
            }),
            3: Object.freeze({
                passive: Object.freeze({
                    puddle: Object.freeze({ durationMs: 2000, tickMs: 500, radius: 50, damage: 3 }),
                }),
            }),
            4: Object.freeze({
                allyAura: Object.freeze({
                    radius: 150,
                    refreshMs: 500,
                    regen: Object.freeze({ intervalMs: 1000, percent: 2, min: 1 }),
                }),
            }),
            5: Object.freeze({
                ultimate: Object.freeze({
                    cooldownMs: 20000,
                    checkMs: 500,
                    berryRain: Object.freeze({
                        moreThan: 8,
                        clusterRadius: 75,
                        radius: 250,
                        berries: 60,
                        durationMs: 2000,
                        fallMs: 500,
                        dropHeight: 400,
                        berryRadius: 50,
                        damage: 25,
                    }),
                }),
            }),
            6: Object.freeze({
                awaken: Object.freeze({ fruitAttack: Object.freeze({ every: 1 }) }),
            }),
        }),
    },
    payload: {
        ...HERO_SHELL,
        shellHp: 55,
        // Landing (HeroLandingStrike): the bunch bursts into eight berries, one in the middle and seven on a ring,
        // and the recoil bounces the hero back.
        landingStrike: Object.freeze({
            radius: 50,
            damage: 25,
            scatter: Object.freeze({ ring: 100, count: 7 }),
            retreat: Object.freeze({ motion: 'hop', distance: 100 }),
        }),
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 1,
        accent: [0.53, 0.28, 0.72, 1],
        fx: 'melee',
    },
    card: {
        role: '곡사 원거리 영웅',
        feature: '네 번째 평타 · 곡사탄 3알',
        land: '영웅 한 명 출격',
        fire: '영웅 단발',
        notes: [
            '착지하면 송이가 터져 포도알 여덟 개가 흩어지고 반동으로 뒤로 튀어 빠져요.',
            '네 번째 평타마다 표적의 앞·중앙·뒤에 곡사탄을 던져요.',
            '2레벨: 막타를 치면 포도알이 튀어 근처 적 한 명에게 피해 20',
            '3레벨: 곡사탄 자리에 포도즙이 2초 남아 0.5초마다 피해 3',
            '4레벨: 주변 아군이 1초마다 최대 체력 2% 회복',
            '5레벨: 적이 뭉치면 스스로 2초 동안 포도알 60개의 비, 알마다 피해 25',
            '6레벨: 평타마다 곡사탄 3알',
        ],
    },
    help: [
        {
            section: 'hero',
            summary: '포도의 곡사탄',
            paragraphs: [
                '평타로 적 한 명을 맞혀요. 네 번째 평타에는 표적의 앞·중앙·뒤에 곡사탄을 한 알씩 더 던져 주변 적에게 피해를 줘요.',
                '착지하는 순간 송이가 터져 가운데 한 알과 둘레 일곱 알이 흩어져요. 알마다 반경 50 안의 적에게 피해 25를 주고, 반동으로 본진 쪽으로 100 튀어 빠져요.',
                '2레벨: 포도가 막타로 적 병력을 쓰러뜨리면 그 자리에서 포도알 하나가 튀어 반경 100 안의 가장 가까운 적 한 명에게 피해 20을 줘요. 튄 알이 쓰러뜨린 적은 처치로 세지만 다시 튀지 않아요.',
                '3레벨: 곡사탄이 떨어진 자리에 보라 포도즙이 2초 동안 남아 반경 50 안의 적 병력에게 0.5초마다 피해 3을 줘요.',
                '4레벨: 포도 둘레 150 안의 아군이 1초마다 최대 체력의 2%(최소 1)를 회복해요. 아군 발밑에 보라 고리가 보여요.',
                '5레벨: 사거리 안 한 자리의 반경 75에 적이 8명보다 많이 뭉쳐 있으면 스스로 그 자리를 중심으로 반경 250에 2초 동안 포도알 60개를 쏟아요. 알이 떨어질 자리에 원이 보이고, 알마다 반경 50 안의 적에게 피해 25를 줘요. 한 번 쓰면 20초 동안 다시 쓰지 않아요.',
                '6레벨: 평타마다 표적의 앞·중앙·뒤에 곡사탄 3알을 함께 던져요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
