import { GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

// 확정 규칙: 연쇄 번개, 사거리 250, 첫 표적에서 튀는 거리 안의 가까운 적으로 튀어 모두 4명까지(감쇠 없음), 채널링은 지속
// 피해형 공격의 문법(sustain)을 따른다: 1초 동안 0.2초마다 피해(5회) → 재사용 대기 1초, 넘어지면 끊기고 대기를 다시 센다.
// 채널링 중 끊긴 줄은 그 줄부터 뒤를 끊고 다시 잇는다. 나는 적에도 닿고 땅↔공중으로 튄다(투입탄은 노리지 않음). 4명, 물몸,
// 기름을 쓰는 고급 카드.
// 초안(주인이 써 보고 조정): 틱 피해 3, 체력 30, 이속 50, 시야 275(사거리 + 25), 가격 식량 30 + 기름 10, 건물 피해 절반,
// 튀는 거리 100, 포탄은 단발 기본값.
export const Cotton = defineUnit({
    id: 'cotton',
    unit: {
        requiresContactTerrain: false,
        construction: { range: 5, workPerHit: 1 },
        name: '목화솜',
        hp: 30,
        // One damage tick of the channel on every link (UnitChainAttack, SustainedAttack).
        atk: 3,
        sustain: Object.freeze({ durationMs: 1000, tickMs: 200, cooldownMs: 1000 }),
        range: 250,
        speed: 50,
        size: GRAIN_SIZE,
        sizeClass: 'light',
        role: 'ranged',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 275,
        chainAttack: Object.freeze({
            links: 4,
            bounceRange: 100,
            buildingDamageScale: 0.5,
        }),
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 30 * RESOURCE_SCALE,
        premiumCost: 10 * RESOURCE_SCALE,
        count: 4,
        shellHp: 25,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.36, 0.56, 1, 1],
        fx: 'ranged',
    },
    card: {
        role: '연쇄 번개',
        feature: '번개가 가까운 적으로 튀어 4명까지 · 1초 잇고 1초 쉼 · 나는 적도 맞힘',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [
            '멈춰 서서 사거리 안의 적에게 번개를 잇고, 그 옆의 적으로 튀어 모두 4명까지 1초 동안 감전시켜요. 나는 적에게도 닿아요.',
            '튀어도 피해는 같아요. 이어진 적이 쓰러지거나 멀어지면 가까운 다른 적으로 다시 이어요. 1초 감전시킨 뒤 1초 쉬어요.',
            '대공: 나는 적에게도 번개가 닿고, 땅과 공중 사이로도 튀어요. 투입탄은 노리지 않아요.',
            '몸이 약해서 넘어지면 번개가 끊겨요. 건물에는 절반만 들어가요.',
        ],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
