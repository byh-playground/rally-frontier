import { BASIC_MELEE, GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

// 확정 규칙: 일꾼·건설 특화. 아주 작은 물량, 체력 아주 낮음, 공격은 최약(싸움 카드로 못 씀), 값이 쌈.
// 건설 속도 2배(한 번 칠 때 작업량 2), 건설 중(공사에 배정되어 그 공사가 진행 중인 동안)에는 받는 피해가 25%(75% 감소).
// 봇은 지을 거점이 있을 때만 일꾼으로 낸다(workerCard).
// 초안(주인이 써 보고 조정): 인원 30, 체력 8, 공격 1, 이속 100, 식량 20(기름 없음), 표시 높이는 조의 약 0.8배.
export const Sesame = defineUnit({
    id: 'sesame',
    unit: {
        ...BASIC_MELEE,
        construction: { range: 5, workPerHit: 2 },
        damageTaken: { scale: 0.25, whileBuilding: true },
        name: '참깨',
        hp: 8,
        atk: 1,
        speed: 100,
        size: GRAIN_SIZE * 0.6,
        workerCard: true,
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 20 * RESOURCE_SCALE,
        count: 30,
        shellHp: 20,
        impact: 10,
        splash: 45,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.92, 0.91, 0.8, 1],
        fx: 'melee',
    },
    card: {
        role: '건설 일꾼',
        feature: '건설 속도 2배 · 건설 중 받는 피해 75% 감소 · 싸움은 못 함',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [
            '작은 참깨 30명이 망치로 거점을 두 배 빠르게 지어요. 공격은 아주 약해서 싸움에는 쓰지 못해요.',
            '거점을 짓는 동안에는 받는 피해가 4분의 1로 줄어요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '참깨 일꾼',
            paragraphs: [
                '참깨는 한 번 부딪힐 때 2작업을 해서 같은 인원이면 다른 병사보다 두 배 빨리 지어요. 30명이 한 번에 나와요.',
                '공사에 배정되어 짓는 동안에는 받는 피해가 4분의 1로 줄어요(소수는 버리고 최소 1). 체력이 8뿐이고 공격은 1이라 싸움에는 쓰지 못해요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
