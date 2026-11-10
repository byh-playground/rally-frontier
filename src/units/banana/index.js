import { HERO_MOVE_SPEED, HERO_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Banana = defineUnit({
    id: 'banana',
    hero: true,
    unit: {
        name: '바나나',
        hp: 350,
        atk: 24,
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
            active: Object.freeze({
                cost: 100,
                range: 325,
                windupMs: 500,
                length: 400,
                curve: 50,
                radius: 20,
                travelMs: 500,
                damageRatio: 2,
            }),
        }),
    },
    payload: { ...HERO_SHELL, shellHp: 50 },
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
            '네 번째 평타의 금빛 부메랑이 적을 왕복 관통해요.',
            '스킬은 더 멀리 날아가는 큰 부메랑을 던져요.',
        ],
    },
    help: [
        {
            section: 'hero',
            summary: '바나나의 부메랑',
            paragraphs: [
                '작은 부메랑으로 적 한 명을 맞혀요. 네 번째 평타는 첫 표적 뒤까지 날아가며 나갈 때와 돌아올 때 경로의 적을 맞혀요. 카드를 길게 누르면 길고 좁은 두 경로를 예고하고, 그 경로로 큰 부메랑을 던져요. 나갈 때와 돌아올 때 적 병력에 각각 한 번 피해를 주며, 바나나는 부메랑을 받을 때까지 제자리에 있어요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
