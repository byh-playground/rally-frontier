import {
    BASIC_MELEE,
    GRAIN_SIZE,
    RESOURCE_SCALE,
    SINGLE_BUNDLE_SHELL,
    WALNUT_MASS,
} from '../baseline.js';
import { defineUnit } from '../define-unit.js';
import { KnockbackRules } from '../../definitions/knockback-rules.js';

// 초안: the walnut's rolling numbers. Its top speed is four times a plain soldier's walk.
const WALNUT_TOP_SPEED = BASIC_MELEE.speed * 4;
// A plain soldier's mass (UnitDefinition's light default).
const SOLDIER_MASS = 100;
// The momentum exchange of a head-on hit on a standing plain soldier at 80 % of the top speed
// takes all of its health, so a hit at full speed always kills it.
const SOLDIER_KILL_IMPULSE = KnockbackRules.impulse(
    WALNUT_MASS,
    WALNUT_TOP_SPEED * 0.8,
    SOLDIER_MASS,
    1,
);

export const Walnut = defineUnit({
    id: 'walnut',
    // 초안: 체력·크기·rolling 수치. 한 번에 하나, 멈추지 않고 구르며 닿는 적을 쳐 내는 규칙은 확정이다.
    // It never attacks the usual way: RollingBody (src/sim/capabilities/rolling-body.js) drives it,
    // and its contacts deal the damage.
    unit: {
        requiresContactTerrain: true,
        name: '호두',
        hp: 300,
        atk: 0,
        range: 0,
        speed: WALNUT_TOP_SPEED,
        size: GRAIN_SIZE * 2,
        mass: WALNUT_MASS,
        sizeClass: 'heavy',
        role: 'bruiser',
        canAttackGround: true,
        canAttackBuildings: true,
        // Crowd separation leaves it alone; the impulse contacts carry it through a crowd.
        crowdCollision: false,
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 275,
        rolling: Object.freeze({
            topSpeed: WALNUT_TOP_SPEED,
            // Lands at half the top speed along the launch direction.
            launchSpeedRatio: 0.5,
            // Drive minus linear drag: speed = top - (top - v0)·e^(-drag·t), 95 % of top by 4 s.
            drag: 0.6,
            // Degrees per second at rest and at top speed, linear in between.
            turnRateSlow: 180,
            turnRateTop: 45,
            wallRestitution: 0.6,
            damagePerImpulse: BASIC_MELEE.hp / SOLDIER_KILL_IMPULSE,
            // Damage to an enemy building hit straight on at the top speed.
            buildingDamageAtTop: 40,
            rehitMs: 500,
        }),
    },
    // 비용(식량 50·기름 75)·한 발에 하나는 확정, 포탄 체력·위력·반경은 찹쌀과 같은 초안이다.
    // The shell's flight direction becomes the walnut's first rolling heading.
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        cost: 10 * RESOURCE_SCALE,
        premiumCost: 15 * RESOURCE_SCALE,
        count: 1,
        shellHp: 25,
        impact: 10,
        splash: 50,
    },
    // 초안: visualScale.
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.82, 0.62, 0.36, 1],
        fx: 'melee',
    },
    card: {
        role: '구르는 볼링공',
        feature: '멈추지 않고 가속하며 닿는 적을 쳐 냄',
        land: '착지점에 한 알, 발사 방향으로 굴러감',
        fire: '단발',
        notes: [
            '착지하면 발사 방향으로 굴러가며 약 4초 동안 최고 속도까지 빨라져요. 멈춰서 싸우지 않아요.',
            '시야 안의 가장 가까운 적을 향해 방향을 틀지만 빠를수록 크게 돌아요. 적이 없으면 적 본진으로 굴러가요. 벽이 가로막으면 돌아가는 길을 따라 굴러가요.',
            '닿은 적은 부딪힌 세기만큼 피해를 입고 멀리 날아가요. 가벼운 적일수록 더 멀리 날아가고, 무거운 적일수록 호두가 더 많이 느려지고, 같은 적은 0.5초 안에 다시 맞지 않아요.',
            '벽과 건물에서는 튕겨 나오고, 적 건물은 속도만큼 피해를 입어요. 아군은 피해 없이 옆으로 밀려나고 호두는 느려지지 않아요.',
        ],
    },
    help: [
        {
            section: 'construction',
            summary: '호두의 구르기',
            paragraphs: [
                '호두는 한 번에 하나만 떨어져 멈추지 않고 굴러요. 구를수록 빨라져 4초쯤 지나면 최고 속도에 가까워지고, 빠를수록 크게 돌아요. 가장 가까운 적을 향해 굴러가고, 벽이 가로막으면 돌아가는 길을 따라가요.',
                '닿은 적은 빠를수록 세게 튕겨 나가며 피해를 받아요. 같은 적은 0.5초 뒤에야 다시 칠 수 있어요. 우리 병사는 다치지 않고 옆으로 밀려나요. 벽과 건물에는 튕겨 나오고, 적 건물은 빠를수록 큰 피해를 받아요.',
            ],
        },
    ],
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
