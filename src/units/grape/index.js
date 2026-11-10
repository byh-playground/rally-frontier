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
            active: Object.freeze({
                cost: 100,
                range: 250,
                windupMs: 500,
                intervalMs: 100,
                shots: 8,
                damageRatio: 1,
            }),
        }),
    },
    payload: { ...HERO_SHELL, shellHp: 55 },
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
            '네 번째 평타마다 표적의 앞·중앙·뒤에 곡사탄을 던져요.',
            '스킬로 포도알 여덟 알을 곡사 연사해요.',
        ],
    },
    help: [
        {
            section: 'hero',
            summary: '포도의 곡사탄과 포도알 연사',
            paragraphs: [
                '평타로 적 한 명을 맞혀요. 네 번째 평타에는 표적의 앞·중앙·뒤에 곡사탄을 한 알씩 더 던져 주변 적에게 피해를 줘요. 카드를 길게 누르면 적 주변의 착탄 지점을 예고하고 포도알 여덟 알을 차례로 높이 던져요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
