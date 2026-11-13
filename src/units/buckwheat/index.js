import { BASIC_MELEE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

// 확정 규칙: 체력 낮은 물량 중거리, 조의 원거리 버전. 20명, 사거리 125(원거리 중 가장 짧음), 체력 15(조와 같음),
// 이속 100. 각자 가장 가까운 적에게 작은 세모 씨앗을 0.5초마다 하나씩 던진다(일반 공격 주기, 지속 피해 문법 아님).
// 대공 없음. 투사체는 밤톨의 단발 투사체(thornAttack)를 쓰고, 보이는 탄은 몸과 같은 작은 메밀알이다.
// 초안(주인이 써 보고 조정): 한 발 피해 4, 식량 40(조와 같음, 기름 없음).
export const Buckwheat = defineUnit({
    id: 'buckwheat',
    unit: {
        requiresContactTerrain: false,
        construction: { range: 5, workPerHit: 1 },
        name: '메밀',
        hp: 15,
        atk: 4,
        range: 125,
        speed: 100,
        // 선딜(attackWindupMs)을 포함한 던지기 간격이다. 10틱/초면 5틱.
        attackIntervalMs: 500,
        attackWindupMs: 200,
        size: BASIC_MELEE.size * 0.75,
        sizeClass: 'light',
        role: 'ranged',
        projectile: true,
        damageClass: 'ranged',
        attackVisual: { sourceMotion: null, travel: 'thorn', impact: 'light' },
        thornAttack: Object.freeze({
            durationMs: 250,
            radius: 2,
            launchHeight: 12,
            targetHeight: 8,
        }),
        sight: 275,
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 40 * RESOURCE_SCALE,
        count: 20,
        shellHp: 20,
        impact: 10,
        splash: 45,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.75, 0.57, 0.42, 1],
        fx: 'ranged',
    },
    card: {
        role: '물량 중거리',
        feature: '20명이 가까운 적에게 씨앗을 0.5초마다 던짐 · 대공 없음',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [
            '착지하면 20명이 각자 가장 가까운 적에게 작은 메밀알을 0.5초마다 던져요. 원거리 병종 중 사거리가 가장 짧아요.',
            '몸이 약하고 나는 적은 맞히지 못해요.',
        ],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
