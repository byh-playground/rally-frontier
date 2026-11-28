import { GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const PineNut = defineUnit({
    id: 'pine-nut',
    unit: {
        name: '잣',
        hp: 15,
        atk: 2,
        range: 250,
        sight: 275,
        speed: 50,
        size: GRAIN_SIZE,
        sizeClass: 'light',
        role: 'ranged',
        requiresContactTerrain: false,
        construction: { range: 5, workPerHit: 1 },
        damageClass: 'normal',
        attackIntervalMs: 400,
        rapidHitscan: true,
        attackVisual: { sourceMotion: null, travel: 'hitscan', impact: 'light' },
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 35 * RESOURCE_SCALE,
        premiumCost: 5 * RESOURCE_SCALE,
        count: 14,
        shellHp: 25,
        impact: 10,
        splash: 50,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.9,
        accent: [0.81, 0.69, 0.43, 1],
        fx: 'ranged',
    },
    card: {
        role: '물량 사수',
        feature: '빠른 단발 · 발사 즉시 명중',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [
            '쏘는 순간 적에게 피해를 줘요. 앞선 사격에 표적이 쓰러지면, 발사할 차례인 잣은 곧바로 다른 적을 겨눠요.',
            '한 발은 약해요. 여럿이 모이면 사거리 안에 들어온 앞줄부터 빠르게 쓰러뜨려요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '잣의 즉시 사격',
            paragraphs: [
                '잣의 탄은 쏘는 순간 맞아요. 사격할 적이 쓰러지면 발사할 차례인 잣은 사거리 안의 살아 있는 적을 다시 겨눠요.',
                '여럿을 앞줄 뒤에 모으면, 적이 가까이 오기 전에 짧은 단발을 집중할 수 있어요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
