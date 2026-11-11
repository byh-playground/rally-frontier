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
