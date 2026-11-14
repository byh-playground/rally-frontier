import { HERO_MOVE_SPEED, HERO_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

const BANANA_ATK = 24;

export const Banana = defineUnit({
    id: 'banana',
    hero: true,
    unit: {
        name: '바나나',
        hp: 350,
        atk: BANANA_ATK,
        range: 225,
        speed: HERO_MOVE_SPEED,
        attackIntervalMs: 750,
        size: 25,
        sizeClass: 'medium',
        role: 'ranged',
        canAttackAir: true,
        damageClass: 'ranged',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 325,
        fruitAttack: Object.freeze({
            kind: 'boomerang',
            every: 4,
            basicMs: 400,
            returnMs: 300,
            passiveFollowThrough: 75,
            radius: 10,
        }),
        // Level unlocks (HeroGrowth.unlocked). Level 2: a killing blow fills the n-hit counter at once. Level 3: a
        // boomerang that hits a soldier again on its way back deals double (HeroPassive). Level 4: the allies
        // within 150 (not the hero itself, refreshed every 0.5 s) move 1.3 times as fast (HeroAllyAura).
        growth: Object.freeze({
            2: Object.freeze({ killEffect: Object.freeze({ fillCombo: true }) }),
            3: Object.freeze({ passive: Object.freeze({ echoHit: Object.freeze({ ratio: 2 }) }) }),
            4: Object.freeze({
                allyAura: Object.freeze({ radius: 150, refreshMs: 500, movePct: 130 }),
            }),
        }),
    },
    payload: {
        ...HERO_SHELL,
        shellHp: 50,
        // Landing (HeroLandingStrike): one turn with the boomerang in hand at twice the basic hit, then a hop back.
        landingStrike: Object.freeze({
            radius: 100,
            damage: BANANA_ATK * 2,
            retreat: Object.freeze({ motion: 'hop', distance: 100 }),
        }),
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 1,
        accent: [0.91, 0.72, 0.24, 1],
        fx: 'melee',
    },
    card: {
        role: '왕복 원거리 영웅',
        feature: '네 번째 평타 · 왕복 관통',
        land: '영웅 한 명 출격',
        fire: '영웅 단발',
        notes: [
            '착지하면 부메랑을 들고 한 바퀴 돌아 주변 적을 베고 뒤로 뛰어 빠져요.',
            '네 번째 평타의 금빛 부메랑이 적을 왕복 관통해요.',
            '2레벨: 막타를 치면 다음 평타가 바로 금빛 부메랑',
            '3레벨: 갈 때 맞힌 적을 돌아오며 또 맞히면 피해 2배',
            '4레벨: 주변 아군 이동 속도 1.3배',
        ],
    },
    help: [
        {
            section: 'hero',
            summary: '바나나의 부메랑',
            paragraphs: [
                '작은 부메랑으로 적 한 명을 맞혀요. 네 번째 평타는 첫 표적 뒤까지 날아가며 나갈 때와 돌아올 때 경로의 적을 맞혀요.',
                '착지하는 순간 부메랑을 들고 한 바퀴 돌아 반경 100 안의 적에게 평타 두 배 피해를 준 뒤, 본진 쪽으로 100 뛰어 빠져요.',
                '2레벨: 바나나가 막타로 적 병력을 쓰러뜨리면 카드의 점이 모두 차서 다음 평타가 곧바로 금빛 부메랑이 돼요.',
                '3레벨: 부메랑이 갈 때 맞힌 적을 돌아올 때 또 맞히면 두 번째 피해가 2배가 되고 금빛으로 번쩍여요.',
                '4레벨: 바나나 둘레 150 안의 아군이 1.3배 빠르게 움직여요. 아군 발밑에 노란 고리가 보여요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
