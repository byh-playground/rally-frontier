import { FRONT_LINE_BUNDLE_COST, RESOURCE_SCALE } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Pea = defineUnit({
    id: 'pea',
    unit: {
        requiresContactTerrain: true,
        construction: { range: 5, workPerHit: 1 },
        name: '콩',
        mass: 225,
        hp: 75,
        atk: 10,
        range: 25,
        speed: 50,
        cooldownMs: 1000,
        size: 10,
        sizeClass: 'medium',
        role: 'bruiser',
        attackVisual: { sourceMotion: 'smash', travel: 'none', impact: 'light' },
        sight: 275,
    },
    // 단발: 폭발이 크고 중심 강타가 가장 세다.
    payload: {
        cost: FRONT_LINE_BUNDLE_COST * RESOURCE_SCALE,
        count: 12,
        shellHp: 40,
        reach: 0.85,
        speed: 750,
        impact: 40,
        splash: 80,
        land: 'burst',
        fire: Object.freeze({ mode: 'single' }),
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.9,
        accent: [0.5, 0.69, 0.27, 1],
        fx: 'melee',
        husk: ['#a7c466', '#698b38'],
    },
    card: {
        role: '전열 근접',
        feature: '높은 체력 · 중심 강타',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발 · 중심 강타',
        notes: ['좁은 착탄점에 큰 피해를 주고 전열을 잡아요.'],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
