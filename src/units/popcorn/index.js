import {
    BASIC_MELEE,
    GRAIN_LEAP,
    HEAVY_KNOCKBACK,
    RESOURCE_SCALE,
    SINGLE_BUNDLE_SHELL,
} from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Popcorn = defineUnit({
    id: 'popcorn',
    unit: {
        ...BASIC_MELEE,
        name: '팝콘',
        hp: 3,
        speed: 100,
        leapAttack: Object.freeze({
            ...GRAIN_LEAP,
            lift: GRAIN_LEAP.lift * Math.SQRT1_2,
        }),
        selfDestruct: Object.freeze({
            onLeapLanding: true,
            windupMs: 1000,
            radius: 80,
            damage: 40,
            ...HEAVY_KNOCKBACK,
        }),
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        shellHp: 15,
        impact: 15,
        splash: 60,
        fire: Object.freeze({
            mode: 'split',
            offsets: Object.freeze([0, 0]),
            lateralSpread: 160,
        }),
        cost: 35 * RESOURCE_SCALE,
        count: 10,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.95, 0.75, 0.25, 1],
        fx: 'melee',
    },
    card: {
        role: '자폭 근접',
        feature: '낮게 도약 · 착지 자폭',
        land: '좌우에 5명씩 투입',
        fire: '좌우 2발',
        notes: ['좌우에 착지한 뒤 적에게 뛰어들어 자폭해요.'],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
