import { GRAIN_SIZE, RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const Potato = defineUnit({
    id: 'potato',
    // 초안: 체력·크기·시야. 착지 5초 뒤 전진 대포가 되는 규칙과 대포 수치(Building Definition)는 확정이다.
    // A rooting potato neither moves nor attacks; it can be hit, and dying first leaves no cannon.
    unit: {
        requiresContactTerrain: true,
        name: '감자',
        hp: 60,
        atk: 0,
        range: 0,
        speed: 0,
        size: GRAIN_SIZE,
        sizeClass: 'light',
        role: 'support',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 275,
        // digMs: the art shows digging in until then, rooting after it, until the cannon stands.
        growsCannon: Object.freeze({ delayMs: 5000, digMs: 2000, building: 'forward-cannon' }),
    },
    // 비용·사거리(일반의 75%)·대포당 한 명은 확정, 포탄 체력·위력·반경은 찹쌀과 같은 초안이다.
    // Every cannon in a volley carries its own potato, so the volley grows one cannon per participant.
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 5 * RESOURCE_SCALE,
        premiumCost: 15 * RESOURCE_SCALE,
        reach: 0.75,
        count: 1,
        perCannonLoad: true,
        shellHp: 25,
        impact: 10,
        splash: 50,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.71, 0.53, 0.35, 1],
        fx: 'melee',
    },
    card: {
        role: '전진 대포',
        feature: '착지 5초 뒤 그 자리에 전진 대포',
        land: '대포마다 한 명, 착지점에 바로',
        fire: '단발 · 사거리 75%',
        notes: [
            '착지한 자리에 파고들어 5초 뒤 전진 대포가 돼요. 뿌리 내리는 동안 공격받아 쓰러지면 대포는 생기지 않아요.',
            '전진 대포는 거점 대포처럼 발사하지만 포탑·생산·점령이 없고, 체력이 초당 10씩 줄어 약 15초 뒤 사라져요.',
            '일제 발사에 참여한 대포마다 감자가 한 명씩 나가 그만큼 전진 대포가 생겨요. 비용은 한 번만 내요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '감자의 전진 대포',
            paragraphs: [
                '감자는 대포마다 한 알씩만 쏠 수 있고, 최대 사거리는 다른 병력의 75%예요. 떨어진 감자는 땅을 파고 뿌리를 내린 뒤 5초 만에 전진 대포가 돼요. 그 전에 쓰러지면 대포는 생기지 않아요.',
                '전진 대포는 거점 대포처럼 병력을 쏠 수 있지만 포탑·생산·점령은 없어요. 체력이 1초에 10씩 줄어 15초쯤 버티고, 적에게 맞으면 더 빨리 무너져요. 낡을수록 대포가 시들어 보여요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
