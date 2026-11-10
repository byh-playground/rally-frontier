import { GRAIN_SIZE, RESOURCE_SCALE } from '../baseline.js';
import { defineUnit } from '../define-unit.js';
import { COLLISION_RADIUS_SCALE } from '../../definitions/world-rules.js';
import {
    DEFAULT_ATTACK_WINDUP_MS,
    DEFAULT_MELEE_MOVE_RECOVERY_MS,
} from '../../definitions/combat-rules.js';

const ACORN_SIZE = GRAIN_SIZE * 2;
const ACORN_SPIN_RADIUS = ACORN_SIZE * (55 / 20);

export const Acorn = defineUnit({
    id: 'acorn',
    unit: {
        requiresContactTerrain: true,
        construction: { range: 5, workPerHit: 1 },
        name: '도토리',
        hp: 75,
        atk: 13,
        range: ACORN_SPIN_RADIUS - ACORN_SIZE * COLLISION_RADIUS_SCALE,
        speed: 50,
        cooldownMs: 1000,
        size: ACORN_SIZE,
        mass: 900,
        sizeClass: 'heavy',
        role: 'bruiser',
        attackVisual: { sourceMotion: null, travel: 'none', impact: 'light' },
        sight: 275,
        // Damage, reach and impulse are trial values; cadence follows the reviewed motion.
        spinAttack: Object.freeze({
            radius: ACORN_SPIN_RADIUS,
            windupMs: DEFAULT_ATTACK_WINDUP_MS,
            activeMs: 1000,
            recoverMs: DEFAULT_MELEE_MOVE_RECOVERY_MS,
            pulseMs: 200,
            maxUnitHitsPerPulse: 3,
            knockbackSpeed: 400,
            knockbackLift: 300,
            tangentRatio: 0.5,
        }),
    },
    // 도토리는 한 발당 두 병사씩 세 발을 쏜다.
    payload: {
        shellHp: 35,
        cost: 35 * RESOURCE_SCALE,
        premiumCost: 10 * RESOURCE_SCALE,
        count: 6,
        reach: 0.85,
        speed: 750,
        impact: 25,
        splash: 100,
        land: 'bundle',
        fire: Object.freeze({
            mode: 'burst',
            shots: 3,
            gapMs: 450,
            impacts: Object.freeze([15, 25, 40]),
            splashes: Object.freeze([90, 60, 40]),
        }),
    },
    visual: {
        family: 'grain',
        billboard: true,
        visualScale: 0.85,
        accent: [0.62, 0.37, 0.18, 1],
        fx: 'melee',
    },
    card: {
        role: '범위 근접',
        feature: '회전 공격 · 밀쳐내기',
        land: '한 발당 두 명',
        fire: '범위가 좁아지는 3연사',
        notes: ['탄착 범위가 좁아지는 3연사 뒤 회전으로 적을 밀어요.'],
    },
    sprite: () => import('./sprite.js').then((art) => art.SPRITE),
});
