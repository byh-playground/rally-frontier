import { RESOURCE_SCALE, SINGLE_BUNDLE_SHELL } from '../baseline.js';
import { defineUnit } from '../define-unit.js';

export const SunflowerSeed = defineUnit({
    id: 'sunflower-seed',
    unit: {
        requiresContactTerrain: false,
        name: '해바라기씨',
        hp: 30,
        atk: 3,
        range: 300,
        speed: 30,
        attackWindupMs: 100,
        size: 10,
        sizeClass: 'light',
        role: 'ranged',
        canAttackAir: true,
        projectile: true,
        damageClass: 'ranged',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        // A sustained attack (SustainedAttack): after aiming (attackWindupMs) one seed every 0.2 s for 1.4 s (7 shots),
        // then 0.6 s to reload.
        sustain: Object.freeze({ durationMs: 1400, tickMs: 200, cooldownMs: 600 }),
        burstAttack: Object.freeze({
            airRange: 300,
            airDamageMultiplier: 2,
        }),
        sight: 325,
        // 캠페인 강화: 공중 표적을 쏘는 발마다 60도 부채꼴로 3발, 옆의 두 발은 부채꼴 안의 다른 공중 표적을 맞힌다.
        campaignUpgrade: {
            name: '요격 부채',
            summary: '공중의 적을 쏠 때 부채꼴로 3발씩 쏴 옆의 투입탄과 나는 적도 맞혀요.',
            interceptFan: { shots: 3, arcDegrees: 60 },
        },
    },
    payload: {
        ...SINGLE_BUNDLE_SHELL,
        shellHp: 25,
        cost: 30 * RESOURCE_SCALE,
        premiumCost: 10 * RESOURCE_SCALE,
        count: 10,
        impact: 10,
        splash: 50,
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.51, 0.38, 0.28, 1],
        fx: 'ranged',
    },
    card: {
        role: '대공 호위',
        feature: '투입탄 우선 · 씨앗 연사',
        land: '착지점에서 사방으로 튀어나옴',
        fire: '단발',
        notes: [],
        airNote: '적 투입탄과 나는 적을 먼저 연사하고, 공중에 적이 없으면 지상을 쏴요.',
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
