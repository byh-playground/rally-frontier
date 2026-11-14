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
        ],
    },
    help: [
        {
            section: 'hero',
            summary: '포도의 곡사탄',
            paragraphs: [
                '평타로 적 한 명을 맞혀요. 네 번째 평타에는 표적의 앞·중앙·뒤에 곡사탄을 한 알씩 더 던져 주변 적에게 피해를 줘요.',
                '착지하는 순간 송이가 터져 가운데 한 알과 둘레 일곱 알이 흩어져요. 알마다 반경 50 안의 적에게 피해 25를 주고, 반동으로 본진 쪽으로 100 튀어 빠져요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
