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
        outOfCombatMoveMultiplier: 2,
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
        deployTogether: true,
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
        feature: '비전투 이동 2배 · 몸통 돌진',
        land: '앞뒤로 10명씩 투입',
        fire: '앞뒤 2발',
        notes: ['앞뒤에 투입되어 빠르게 달리고 몸으로 부딪쳐요.'],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
