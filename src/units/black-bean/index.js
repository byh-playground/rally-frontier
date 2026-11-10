import { BASIC_MELEE, GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const BlackBean = defineUnit({
    id: 'black-bean',
    // 초안: 체력은 쌀과 같고, 공격력은 쌀의 절반 남짓, 이동속도는 쌀과 같다.
    // 재탑승 5초·복귀 이동 2배는 확정 규칙이고, 탑승 0.5초는 초안이다.
    unit: {
        requiresContactTerrain: true,
        name: '검은콩',
        hp: 25,
        atk: 3,
        range: BASIC_MELEE.range,
        speed: 75,
        cooldownMs: 1000,
        size: GRAIN_SIZE,
        sizeClass: 'light',
        role: 'bruiser',
        attackVisual: { sourceMotion: 'slash', travel: 'none', impact: 'light' },
        sight: 275,
        // Each soldier walks back to a friendly cannon on its own and launches itself again.
        cannonRider: Object.freeze({
            reboardDelayMs: 5000,
            boardMs: 500,
            returnSpeedMultiplier: 2,
        }),
    },
    // 비용·인원은 확정, 포탄 체력·위력·반경은 찹쌀과 같은 초안이다.
    // A soldier that launches itself again rides one of these shells alone (CannonRider).
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 10 * RESOURCE_SCALE,
        premiumCost: 10 * RESOURCE_SCALE,
        count: 10,
        shellHp: 25,
        impact: 10,
        splash: 50,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.2, 0.18, 0.22, 1],
        fx: 'melee',
    },
    card: {
        role: '재발사 근접',
        feature: '착지 5초 뒤 아군 대포로 돌아가 스스로 재발사',
        land: '착지점에 한 명씩',
        fire: '단발',
        notes: [
            '착지하면 근처 적과 싸우다가, 5초가 지나면 싸우는 중이라도 가까운 아군 대포로 두 배 속도로 달려가 올라타요.',
            '포구에서 0.5초 뒤 혼자 날아가요. 대포 사거리 안의 가장 가까운 적 병사, 없으면 적 건물, 둘 다 없으면 적 본진에 더 가까운 아군 대포 곁으로 날아가요. 비용과 재장전은 쓰지 않아요.',
            '시야 거리 안에서 곧게 걸어갈 수 있는 아군 대포만 골라요. 찹쌀이 붙은 대포는 건너뛰고, 가장 앞 대포에서는 곁에 머물며 다가오는 적과 싸워요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '검은콩의 재발사',
            paragraphs: [
                '검은콩은 한 번에 10명이 떨어져 근접으로 싸워요. 떨어지고 5초가 지나면 싸우던 중이어도 가까운 우리 대포로 두 배 빠르게 달려가요.',
                '대포에 올라탄 검은콩은 비용·재장전 없이 혼자 날아가요. 사거리 안의 가장 가까운 적 병사, 없으면 적 건물을 노리고, 둘 다 없으면 적 본진에 더 가까운 우리 대포로 옮겨 타요. 갈 곳이 없으면 대포 곁에서 싸우며 기다려요. 찹쌀에 막힌 대포에는 타지 않아요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
