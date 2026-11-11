import { BASIC_MELEE, RESOURCE_SCALE } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Rice = defineUnit({
    id: 'rice',
    unit: { ...BASIC_MELEE, name: '쌀' },
    // 산탄: 한 번에 여러 갈래, 갈래마다 폭발은 작다.
    payload: {
        cost: 35 * RESOURCE_SCALE,
        count: 20,
        shellHp: 10,
        reach: 1,
        speed: 600,
        impact: 10,
        splash: 180,
        land: 'burst',
        fire: Object.freeze({
            mode: 'shotgun',
            pellets: 5,
            spread: 400,
            impactScale: 0.6,
            splashScale: 0.7,
        }),
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.96, 0.94, 0.86, 1],
        fx: 'melee',
    },
    card: {
        role: '기동 근접',
        feature: '빠른 이동 · 산탄 투입',
        land: '넓게 흩어짐',
        fire: '5갈래 산탄',
        notes: ['산탄 다섯 발로 좌우 전열을 훑어요.'],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
