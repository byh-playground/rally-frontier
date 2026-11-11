import { BASIC_MELEE, GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const StickyRice = defineUnit({
    id: 'sticky-rice',
    // 초안: 체력·공격력·이동은 기존 병종 수치 체계의 임시값이다. 붙기 시간·재사용 대기는 확정 규칙이다.
    unit: {
        // Body-slams buildings like millet: no rebound, a short retreat after each hit.
        requiresContactTerrain: true,
        contactMelee: true,
        canAttackBuildings: true,
        canAttackGround: false,
        range: BASIC_MELEE.range,
        name: '찹쌀',
        hp: 60,
        atk: 10,
        speed: 75,
        attackIntervalMs: 1500,
        size: GRAIN_SIZE,
        sizeClass: 'light',
        role: 'bruiser',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 275,
        // One soldier at a time holds a completed enemy outpost's muzzle shut.
        stickyCling: Object.freeze({ durationMs: 1000, cooldownMs: 5000 }),
    },
    // 비용·인원은 확정, 포탄 성능은 땅콩의 초안을 따른다.
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 20 * RESOURCE_SCALE,
        premiumCost: 5 * RESOURCE_SCALE,
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
        visualScale: 0.85,
        accent: [0.93, 0.44, 0.58, 1],
        fx: 'melee',
    },
    card: {
        role: '거점 봉쇄',
        feature: '적 거점 포구에 붙어 발사·포탑 정지',
        land: '착지점에서 좌우로 넓게 튀어나옴',
        fire: '단발',
        notes: [
            '착지하면 시야에 들어온 가까운 적 건물로 달려가 몸통박치기로 공격해요. 완공된 적 거점에 닿으면 한 명이 포구에 1초 붙어요.',
            '붙어 있는 동안 그 거점은 발사와 포탑 공격을 못 해요. 붙었던 병사는 5초 뒤 다시 붙을 수 있어요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '찹쌀의 포구 막기',
            paragraphs: [
                '찹쌀은 적 건물로 달려가요. 완공된 적 전진 거점에 닿으면 한 명이 포구를 1초 동안 감싸요. 그동안 그 거점은 대포를 쏘지 못하고 포탑도 공격하지 않지만 자원은 계속 생산해요. 본진과 짓는 중인 거점에는 붙지 않아요.',
                '한 거점에는 한 명씩만 붙고, 붙었던 병사는 5초 뒤에 다시 붙을 수 있어요. 붙은 찹쌀이 쓰러지면 바로 풀려요. 우리 대포가 막혀 있으면 그 대포로는 발사할 수 없어요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
