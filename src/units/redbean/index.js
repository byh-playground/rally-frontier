import { GRAIN_LEAP, RESOURCE_SCALE } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Redbean = defineUnit({
    id: 'redbean',
    unit: {
        requiresContactTerrain: true,
        construction: { range: 5, workPerHit: 1 },
        name: '팥',
        hp: 50,
        atk: 15,
        range: 25,
        speed: 50,
        cooldownMs: 1000,
        size: 10,
        sizeClass: 'light',
        role: 'bruiser',
        attackVisual: { sourceMotion: 'smash', travel: 'none', impact: 'light' },
        sight: 275,
        // Trial values; retain the existing bundle size while balancing combat.
        leapAttack: Object.freeze({
            ...GRAIN_LEAP,
            impact: Object.freeze({
                radius: 50,
                damageScale: 1,
                // The ring is about the body itself: everyone under the landing is thrown alike.
                knockbackFalloff: false,
            }),
        }),
    },
    // 연사: 같은 곳에 시간차로 세 번 떨어진다.
    payload: {
        cost: 60 * RESOURCE_SCALE,
        count: 10,
        shellHp: 18,
        reach: 0.75,
        speed: 750,
        impact: 20,
        splash: 95,
        land: 'burst',
        rushMs: 2000,
        rushPct: 150,
        fire: Object.freeze({ mode: 'burst', shots: 3, gapMs: 300 }),
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.9,
        accent: [0.66, 0.2, 0.23, 1],
        fx: 'melee',
        husk: ['#c76a60', '#8a393a'],
    },
    card: {
        role: '돌격 근접',
        feature: '높이 뛰어 내려찍기 · 착지 충격파',
        land: '착지 후 돌격',
        fire: '한 지점을 덮는 3연사',
        notes: ['시간차로 투입되어 적에게 뛰어들어 내려찍어요.'],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
