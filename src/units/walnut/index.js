import {
    BASIC_MELEE,
    COCONUT_MASS,
    GRAIN_SIZE,
    RESOURCE_SCALE,
    SINGLE_BUNDLE_SHELL,
} from '../baseline.js';
import { defineUnit } from '../define-unit.js';

// 확정 규칙(D-419): 탱커. 식량 200·한 명, 체력 800, 이속 50, 받는 피해 절반(damageTaken, 참깨와 같은 계산).
// 공격은 수박 평타처럼 근접 0.5초 간격, 피해 5에 맞힌 자리 둘레 반경 25 범위 피해(BasicSplash): 최소한의 물량 대처.
// 도발·표적 규칙과 구르기는 없다. 몸 크기·질량은 코코넛과 같다. 주변 피해 비율 1은 초안이다.
export const Walnut = defineUnit({
    id: 'walnut',
    unit: {
        requiresContactTerrain: true,
        construction: BASIC_MELEE.construction,
        name: '호두',
        hp: 800,
        atk: 5,
        range: 25,
        speed: 50,
        attackIntervalMs: 500,
        size: GRAIN_SIZE * 2,
        mass: COCONUT_MASS,
        sizeClass: 'heavy',
        role: 'bruiser',
        attackVisual: { sourceMotion: 'smash', travel: 'none', impact: 'light' },
        sight: 275,
        damageTaken: Object.freeze({ scale: 0.5 }),
        basicSplash: Object.freeze({ radius: 25, damageRatio: 0.5 }),
    },
    // 포탄 체력·위력·반경은 코코넛과 같은 초안이다. 탄약은 식량 카드 기본값.
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 40 * RESOURCE_SCALE,
        count: 1,
        shellHp: 25,
        impact: 10,
        splash: 50,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.82, 0.62, 0.36, 1],
        fx: 'melee',
    },
    card: {
        role: '탱커',
        feature: '단단한 껍데기 · 받는 피해 절반',
        land: '착지점에 한 알',
        fire: '단발',
        notes: [
            '단단한 껍데기 덕분에 받는 피해가 절반으로 줄어요. 느리지만 오래 버티며 앞줄을 지켜요.',
            '0.5초마다 가까이 붙은 적을 치고, 맞은 적 둘레의 작은 범위에도 같은 피해를 줘요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '호두 탱커',
            paragraphs: [
                '호두는 한 명만 나오지만 체력이 많고 받는 피해가 절반이라 오래 버텨요(소수는 버리고 최소 1). 걸음은 느려요.',
                '0.5초마다 가까운 적을 치고, 맞은 적 둘레의 작은 범위에 있는 적 병사도 같은 피해를 받아요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
