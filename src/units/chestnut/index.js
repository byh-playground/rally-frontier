import { RESOURCE_SCALE } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Chestnut = defineUnit({
    id: 'chestnut',
    unit: {
        requiresContactTerrain: false,
        construction: { range: 5, workPerHit: 1 },
        name: '밤톨',
        hp: 25,
        atk: 10,
        range: 200,
        minRange: 40,
        speed: 75,
        cooldownMs: 1000,
        attackWindupMs: 300,
        size: 10,
        sizeClass: 'light',
        role: 'ranged',
        canAttackAir: true,
        projectile: true,
        damageClass: 'ranged',
        attackVisual: { sourceMotion: null, travel: 'thorn', impact: 'light' },
        thornAttack: Object.freeze({
            durationMs: 300,
            radius: 2,
            launchHeight: 15,
            targetHeight: 10,
        }),
        sight: 275,
        // 캠페인 강화: 병사마다 3번째 가시가 두 배 굵고, 맞은 적 병사 하나를 뒤로 민다(피해는 그대로 10).
        // 미는 세기는 밤톨 한 알이 속도 200으로 친 것: 막힘 없이 밀린 쌀이 57쯤 물러난다.
        campaignUpgrade: {
            name: '굵은 가시',
            summary: '세 번째 가시마다 굵은 가시가 나가 맞은 적을 뒤로 밀어요.',
            heavyThorn: { every: 3, radiusScale: 2, knockbackSpeed: 200 },
        },
    },
    payload: {
        shellHp: 25,
        cost: 25 * RESOURCE_SCALE,
        premiumCost: 5 * RESOURCE_SCALE,
        count: 10,
        reach: 0.85,
        speed: 1000,
        arcScale: 0.65,
        impact: 10,
        splash: 50,
        land: 'burst',
        fire: Object.freeze({ mode: 'single' }),
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.55, 0.28, 0.18, 1],
        fx: 'ranged',
        husk: ['#a5aa55', '#6f7834'],
    },
    card: {
        role: '단일 원거리',
        feature: '가시로 먼 적 공격',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '낮고 빠른 단발',
        notes: ['착지점에서 흩어져 거리를 두고 가시를 쏴요.'],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
