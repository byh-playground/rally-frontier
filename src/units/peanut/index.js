import { FRONT_LINE_BUNDLE_COST, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

// A peanut starts its contact charge this far from a building and rebounds the same distance away.
const PEANUT_CHARGE_REACH = 150;

export const Peanut = defineUnit({
    id: 'peanut',
    unit: {
        requiresContactTerrain: true,
        contactMelee: true,
        contactChargeSpeedMultiplier: 2,
        contactRebound: Object.freeze({ distance: PEANUT_CHARGE_REACH, lift: 200 }),
        canAttackBuildings: true,
        canAttackGround: false,
        range: PEANUT_CHARGE_REACH,
        name: '땅콩',
        mass: 225,
        hp: 75,
        atk: 50,
        speed: 100,
        attackIntervalMs: 1500,
        size: 10,
        sizeClass: 'medium',
        role: 'bruiser',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 275,
        // 캠페인 강화: 들이받아 건물을 부수면 그 건물을 노리던 땅콩이 모두 튀거나 쉬지 않고 다음 건물까지
        // 돌진 속도(걸음의 2배, 200)로 달려 선딜 없이 들이받는다.
        campaignUpgrade: {
            name: '연쇄 돌진',
            summary: '건물을 부수면 쉬지 않고 다음 건물로 내달려요.',
            chainCharge: { approachSpeedScale: 2 },
        },
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: FRONT_LINE_BUNDLE_COST * RESOURCE_SCALE,
        count: 5,
        shellHp: 25,
        impact: 10,
        splash: 50,
        land: 'burst',
        spreadAcross: 1.5,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.9,
        accent: [0.77, 0.5, 0.24, 1],
        fx: 'melee',
    },
    card: {
        role: '건물 돌격',
        feature: '건물만 몸통으로 공격',
        land: '착지점에서 좌우로 넓게 튀어나옴',
        fire: '단발',
        notes: [
            '착지하면 시야에 들어온 가까운 적 건물에 달려가 들이받아요.',
            '적 병사가 길을 막으면 아군의 엄호가 필요해요.',
        ],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
