import { BASIC_MELEE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Millet = defineUnit({
    id: 'millet',
    unit: {
        ...BASIC_MELEE,
        name: '조',
        hp: 15,
        atk: 8,
        size: BASIC_MELEE.size * 0.75,
        speed: 125,
        // 선딜을 포함한 타격 간격이다(cooldownMs는 선딜 뒤에 더해져 더 길어진다). 10틱/초라 3틱과 4틱이 번갈아 평균 0.35초.
        attackIntervalMs: 350,
        contactMelee: true,
        attackVisual: { ...BASIC_MELEE.attackVisual, sourceMotion: null },
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        shellHp: 20,
        cost: 40 * RESOURCE_SCALE,
        count: 20,
        impact: 10,
        splash: 45,
        fire: Object.freeze({ mode: 'split', offsets: Object.freeze([-100, 0]) }),
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
        feature: '빠른 이동 · 빠른 몸통 돌진',
        land: '앞뒤로 10명씩 투입',
        fire: '앞뒤 2발',
        notes: ['앞뒤에 투입되어 빠르게 달려 몸으로 연달아 부딪쳐요.'],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
