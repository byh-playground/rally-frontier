import { BASIC_MELEE, GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const BlackBean = defineUnit({
    id: 'black-bean',
    // 초안: 체력은 쌀과 같고, 공격력은 쌀의 절반 남짓, 이동속도는 쌀과 같다.
    // 재탑승 2.5초·복귀 이동 2배는 확정 규칙이고, 탑승 0.5초는 초안이다.
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
        // Each soldier runs to the nearest friendly cannon ahead of it (else the nearest one behind) and launches itself again.
        cannonRider: Object.freeze({
            reboardDelayMs: 2500,
            boardMs: 500,
            returnSpeedMultiplier: 2,
            // 초안: 대포를 고르는 직선거리 상한은 그 진영 발사 사거리의 2배다.
            cannonSearchReachMultiplier: 2,
        }),
    },
    // 비용·인원은 확정, 포탄 체력·위력·반경은 찹쌀과 같은 초안이다.
    // A soldier that launches itself again rides one of these shells alone (CannonRider).
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        // One soldier at a time, as it always lands (a cannon rider keeps the health it flew with).
        land: 'bundle',
        cost: 10 * RESOURCE_SCALE,
        premiumCost: 10 * RESOURCE_SCALE,
        count: 10,
        shellHp: 25,
        impact: 25,
        splash: 80,
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
        feature: '아군 대포를 연달아 타고 전선으로 날아감',
        land: '착지점에 한 명씩',
        fire: '단발',
        notes: [
            '적에게 떨어지면 2.5초 동안 싸우고, 그 뒤에는 싸우는 중이라도 자기보다 앞(적 본진 쪽)에 있는 가장 가까운 아군 대포로 두 배 속도로 달려가 올라타요. 앞에 대포가 없으면 가까운 뒤쪽 대포로 돌아가요.',
            '포구에서 0.5초 뒤 혼자 날아가요. 대포 사거리 안의 가장 가까운 적 병사, 없으면 적 건물을 노리고, 둘 다 없으면 적 본진에 더 가까운 아군 대포 곁에 내려 바로 다시 타요. 가장 앞 대포에서는 적 본진 쪽 사거리 끝으로 날아가요. 비용과 재장전은 쓰지 않아요.',
            '적을 노릴 때는 같은 대포에서 앞서 날아간 검은콩이 땅에 닿을 때까지 포구에서 기다렸다가, 밀려난 적을 다시 노려 날아가요.',
            '발사 사거리 2배 안의 대포만 골라요. 앞쪽 대포가 먼저고, 없을 때만 뒤쪽 대포로 가요. 찹쌀이 붙은 대포는 건너뛰고, 둘 다 없으면 다른 병사처럼 싸우며 나아가요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '검은콩의 재발사',
            paragraphs: [
                '검은콩은 한 번에 10명이 떨어져 근접으로 싸워요. 적에게 떨어지면 2.5초 동안 싸우고, 그 뒤에는 싸우던 중이어도 자기보다 앞쪽에 있는 가장 가까운 우리 대포로 두 배 빠르게 달려가요. 앞에 대포가 없으면 가까운 뒤쪽 대포로 돌아가요.',
                '대포에 올라탄 검은콩은 비용·재장전 없이 혼자 날아가요. 사거리 안의 가장 가까운 적 병사, 없으면 적 건물을 노리고, 둘 다 없으면 적 본진에 더 가까운 우리 대포 곁에 내려 곧바로 다시 타요. 이렇게 앞쪽 대포를 연달아 타고 가다가 가장 앞 대포에서는 적 본진 쪽으로 날아가요. 적을 노릴 때는 같은 대포에서 앞서 날아간 검은콩이 땅에 닿은 뒤에 표적을 다시 골라 날아가서, 밀려난 적을 놓치지 않아요. 앞뒤 어디에도 탈 대포가 없으면 다른 병사처럼 싸우며 나아가요. 찹쌀에 막힌 대포에는 타지 않아요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
