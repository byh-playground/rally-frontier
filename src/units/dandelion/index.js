import { BASIC_MELEE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Dandelion = defineUnit({
    id: 'dandelion',
    // 쌀처럼 약한 근접 떼. 투입 뒤 한 번만 솜털로 날아 적 앞에 내려앉는다(UnitFlight).
    unit: {
        ...BASIC_MELEE,
        name: '민들레씨',
        flight: Object.freeze({ speed: 200, altitude: 120, climbSpeed: 150 }),
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 30 * RESOURCE_SCALE,
        count: 20,
        shellHp: 20,
        impact: 10,
        splash: 45,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.98, 0.86, 0.3, 1],
        fx: 'melee',
    },
    card: {
        role: '비행 근접',
        feature: '한 번 날아 벽을 넘음 · 대공에만 맞음',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [
            '투입되면 솜털로 떠올라 벽·절벽·건물을 곧장 넘어가요.',
            '적이 사거리에 들어오면 내려앉아 끝까지 땅에서 싸워요.',
            '나는 동안엔 공격하지 않고, 투입탄을 쏘는 대공 병종과 포탑에만 맞아요.',
        ],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
