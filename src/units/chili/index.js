import { GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';
import { COLLISION_RADIUS_SCALE } from '../../definitions/world-rules.js';

// 확정 규칙: 불줄기 길이 175·각도 30°, 3명·체력 60, 한 명이 줄기 안의 적 모두에게 뿜는 동안 초당 20, 멈춰서 뿜고
// 천천히 돌린다, 지상 유닛만 태우고 건물은 절반, 가격 150+50. 지속 피해형 공격의 문법(sustain)을 따른다: 한 번에
// 1초 뿜고 그동안 0.2초마다 4(5회 20), 끝나면 1초 재사용 대기.
// 초안(되돌릴 수 있음): 방향 전환 초당 90°, 걷는 속도 50, 포탄은 단발 기본값.
// 피해 간격은 경기 10TPS의 틱(0.1초)에 맞춘다: 0.25초는 3틱(0.3초)으로 반올림된다.
const BREATH_LENGTH = 175;
const BREATH_DAMAGE_PER_SECOND = 20;
const BREATH_TICK_MS = 200;

export const Chili = defineUnit({
    id: 'chili',
    unit: {
        requiresContactTerrain: false,
        construction: { range: 5, workPerHit: 1 },
        name: '고추',
        hp: 60,
        // One burn of the flame per damage tick of the sustained attack (UnitBreathAttack, SustainedAttack).
        atk: (BREATH_DAMAGE_PER_SECOND * BREATH_TICK_MS) / 1000,
        sustain: Object.freeze({ durationMs: 1000, tickMs: BREATH_TICK_MS, cooldownMs: 1000 }),
        // The flame's tip is the attack reach, measured from the body's edge.
        range: BREATH_LENGTH - GRAIN_SIZE * COLLISION_RADIUS_SCALE,
        speed: 50,
        size: GRAIN_SIZE,
        sizeClass: 'light',
        role: 'ranged',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 275,
        breathAttack: Object.freeze({
            length: BREATH_LENGTH,
            arcDegrees: 30,
            turnDegreesPerSecond: 90,
            buildingDamageScale: 0.5,
        }),
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 30 * RESOURCE_SCALE,
        premiumCost: 10 * RESOURCE_SCALE,
        count: 3,
        shellHp: 25,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.86, 0.16, 0.12, 1],
        fx: 'ranged',
    },
    card: {
        role: '화염 방사',
        feature: '좁고 긴 불줄기 · 1초 뿜고 1초 쉼 · 안의 적 모두 태움',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [
            '멈춰 서서 앞쪽으로 길고 좁은 불줄기를 1초 동안 뿜고, 1초 쉬었다가 다시 뿜어요. 줄기 안의 적은 모두 함께 타요.',
            '방향을 천천히 돌려서 옆이나 뒤로 돌아오는 적, 빠른 적에 약해요.',
            '땅 위의 적만 태우고, 나는 적과 포탄에는 닿지 않아요. 건물에는 절반만 들어가요.',
        ],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
