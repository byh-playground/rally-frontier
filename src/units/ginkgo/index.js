import { GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

const cloud = Object.freeze({
    radius: 75,
    durationMs: 2000,
    tickMs: 200,
    totalDamage: 40,
    slowPct: 25,
});

export const Ginkgo = defineUnit({
    id: 'ginkgo',
    unit: {
        name: '은행',
        hp: 25,
        atk: cloud.totalDamage / 2,
        range: 450,
        minRange: 100,
        sight: 275,
        speed: 30,
        size: GRAIN_SIZE,
        sizeClass: 'light',
        role: 'ranged',
        requiresContactTerrain: false,
        construction: { range: 5, workPerHit: 1 },
        damageClass: 'normal',
        attackIntervalMs: 5000,
        attackWindupMs: 500,
        attackVisual: { sourceMotion: null, travel: 'lob', impact: 'light' },
        lobAttack: Object.freeze({
            shots: 1,
            shotGapMs: 100,
            projectileSpeed: 325,
            launchOffsetX: 15,
            launchHeight: 25,
            gravity: 500,
            radius: 5,
            mass: 5,
            restitution: 0,
            settleSpeed: 15,
            groundFriction: 8,
            fuseMs: 0,
            explosionRadius: 50,
            explosionDamageScale: 1,
        }),
        ginkgoCloud: cloud,
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 60 * RESOURCE_SCALE,
        premiumCost: 10 * RESOURCE_SCALE,
        count: 5,
        shellHp: 25,
        impact: 10,
        splash: 50,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.9,
        accent: [0.82, 0.61, 0.18, 1],
        fx: 'ranged',
    },
    card: {
        role: '장거리 곡사',
        feature: '높은 새총 곡사 · 감속과 지속 피해',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [
            '새총으로 은행알을 멀리 쏴요. 떨어진 자리에 남은 악취가 적의 발을 느리게 해요.',
            '악취는 범위 안의 적 지상 병력에게만 피해를 줘요. 구름이 겹쳐도 피해와 감속은 한 번씩만 적용돼요.',
            '앞줄이 시야를 열어 주면 멀리서 쏠 수 있어요. 적이 너무 가까이 붙으면 쏘지 못해요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '은행의 새총과 악취',
            paragraphs: [
                '은행알이 땅에 떨어지면 노란 겉껍질이 터져요. 남은 악취는 잠시 적 지상 병력을 느리게 하고 다치게 해요. 구름에서 벗어나면 효과가 끝나요.',
                '아군 앞줄이나 거점으로 시야를 확보한 뒤, 먼 길목이나 적이 모인 자리를 노려요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
