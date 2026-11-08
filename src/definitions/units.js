// Launch grain definitions, runtime geometry and visual definitions.
import { COLLISION_RADIUS_SCALE, VIEW_W } from './world-rules.js';
import { FP } from '../core/config.js';
import { DEFAULT_ATTACK_WINDUP_MS, DEFAULT_MELEE_MOVE_RECOVERY_MS } from './combat-rules.js';
const RICE_SIZE = 10;
const UNIT_RENDER_RADIUS_SCALE = 1.56;
const GRAIN_SPRITE_BASE_SCALE = 2.7 / 260;
const WATERMELON_SIZE = RICE_SIZE * 3.5;
const WATERMELON_VISUAL_SCALE = 1;
const WATERMELON_RIND_RADIUS_X = 118;
const WATERMELON_RIND_WORLD_RADIUS =
    WATERMELON_SIZE *
    UNIT_RENDER_RADIUS_SCALE *
    GRAIN_SPRITE_BASE_SCALE *
    WATERMELON_VISUAL_SCALE ** 2 *
    WATERMELON_RIND_RADIUS_X;
const ACORN_SIZE = RICE_SIZE * 3;
const ACORN_SPIN_RADIUS = ACORN_SIZE * (55 / 20);
const RICE_MELEE = {
    requiresContactTerrain: true,
    construction: { range: 5, workPerHit: 1 },
    name: '쌀',
    hp: 25,
    atk: 5,
    range: 25,
    speed: 75,
    cooldownMs: 1000,
    size: RICE_SIZE,
    sizeClass: 'light',
    role: 'bruiser',
    attackVisual: { sourceMotion: 'slash', travel: 'none', impact: 'light' },
    sight: 275,
};

class UnitDefinition {
    static all = {
        rice: RICE_MELEE,
        watermelon: {
            requiresContactTerrain: true,
            name: '수박',
            hp: 500,
            atk: 10,
            range: 25,
            speed: 50,
            attackIntervalMs: 500,
            size: WATERMELON_SIZE,
            sizeClass: 'heavy',
            role: 'bruiser',
            attackVisual: { sourceMotion: 'smash', travel: 'none', impact: 'light' },
            sight: 275,
            heroActive: Object.freeze({
                cost: 100,
                range: 250,
                hopMs: 500,
                hopHeight: WATERMELON_SIZE * 3,
                landing: Object.freeze({ radius: VIEW_W / 6, damageRatio: 1 }),
                speedMultiplier: 5,
                rollHitRadius: WATERMELON_RIND_WORLD_RADIUS,
                rollDistance: WATERMELON_RIND_WORLD_RADIUS * 2 * 3,
                unfoldMs: 100,
                damageRatio: 1,
                knockbackSpeed: 400,
                knockbackLift: 300,
            }),
            spinAttack: Object.freeze({
                radius: 150,
                windupMs: 500,
                activeMs: 500,
                recoverMs: 250,
                arcSweep: true,
                rhythm: Object.freeze({
                    basicsPerSweep: 4,
                    splashRadius: 25,
                    splashDamageRatio: 0.5,
                }),
                knockbackSpeed: 400,
                knockbackLift: 300,
                tangentRatio: 0,
            }),
        },
        millet: {
            ...RICE_MELEE,
            name: '조',
            hp: 15,
            atk: 8,
            size: RICE_MELEE.size * 0.75,
            outOfCombatMoveMultiplier: 2,
            contactMelee: true,
            attackVisual: { ...RICE_MELEE.attackVisual, sourceMotion: null },
        },
        pea: {
            requiresContactTerrain: true,
            construction: { range: 5, workPerHit: 1 },
            name: '콩',
            mass: 225,
            hp: 75,
            atk: 10,
            range: 25,
            speed: 50,
            cooldownMs: 1000,
            size: 10,
            sizeClass: 'medium',
            role: 'bruiser',
            attackVisual: { sourceMotion: 'smash', travel: 'none', impact: 'light' },
            sight: 275,
        },
        acorn: {
            requiresContactTerrain: true,
            construction: { range: 5, workPerHit: 1 },
            name: '도토리',
            hp: 75,
            atk: 13,
            range: ACORN_SPIN_RADIUS - ACORN_SIZE * COLLISION_RADIUS_SCALE,
            speed: 50,
            cooldownMs: 1000,
            size: ACORN_SIZE,
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
                knockbackSpeed: 400,
                knockbackLift: 300,
                tangentRatio: 0.5,
            }),
        },
        // Health is confirmed; remaining combat tuning is provisional.
        corn: {
            requiresContactTerrain: false,
            construction: { range: 5, workPerHit: 1 },
            name: '옥수수',
            hp: 25,
            atk: 8,
            range: 200,
            minRange: 40,
            speed: 50,
            cooldownMs: 1500,
            attackWindupMs: 380,
            size: 10,
            sizeClass: 'light',
            role: 'ranged',
            attackVisual: { sourceMotion: null, travel: 'lob', impact: 'light' },
            lobAttack: Object.freeze({
                shots: 1,
                shotGapMs: 100,
                projectileSpeed: 300,
                launchOffsetX: 15.3,
                launchHeight: 10.2,
                gravity: 1000,
                radius: 5,
                mass: 5,
                restitution: 0.2,
                settleSpeed: 15,
                groundFriction: 8,
                fuseMs: 1000,
                explosionDamageScale: 0.5,
                explosionRadius: 50,
            }),
            sight: 275,
        },
        popcorn: {
            ...RICE_MELEE,
            name: '팝콘',
            hp: 3,
            speed: 100,
            selfDestruct: Object.freeze({
                windupMs: 1000,
                radius: 80,
                damage: 15,
                impulseScale: 0.5,
            }),
        },
        chestnut: {
            requiresContactTerrain: false,
            construction: { range: 5, workPerHit: 1 },
            name: '밤톨',
            hp: 25,
            atk: 5,
            range: 200,
            minRange: 40,
            speed: 75,
            cooldownMs: 1000,
            attackWindupMs: 280,
            size: 10,
            sizeClass: 'light',
            role: 'ranged',
            projectile: true,
            damageClass: 'ranged',
            attackVisual: { sourceMotion: null, travel: 'thorn', impact: 'light' },
            thornAttack: Object.freeze({
                durationMs: 300,
                radius: 2,
                launchHeight: 15,
                targetHeight: 10,
            }),
            sight: 275,
        },
        redbean: {
            requiresContactTerrain: true,
            construction: { range: 5, workPerHit: 1 },
            name: '팥',
            hp: 50,
            atk: 15,
            range: 25,
            speed: 50,
            cooldownMs: 1000,
            size: 10,
            sizeClass: 'light',
            role: 'bruiser',
            attackVisual: { sourceMotion: 'smash', travel: 'none', impact: 'light' },
            sight: 275,
            // Trial values; retain the existing bundle size while balancing combat.
            leapAttack: Object.freeze({
                range: 150,
                lift: 500,
                radius: 50,
                damageScale: 1,
                knockbackSpeed: 250,
                knockbackLift: 250,
                cooldownMs: 3000,
            }),
        },
    };
    static get(type) {
        return this.all[type] || null;
    }
    static damageClass(type) {
        const d = this.get(type);
        if (!d) return 'normal';
        if (d.damageClass) return d.damageClass;
        if ((d.range || 0) >= 250) return 'ranged';
        return 'melee';
    }
}
for (const d of Object.values(UnitDefinition.all)) {
    if (Number.isFinite(Number(d.cooldownMs))) d.cooldown = Number(d.cooldownMs) / 1000;
    if (d.canAttackGround == null) d.canAttackGround = (d.atk || 0) > 0;
}

const UNIT_RUNTIME_GEOMETRY = Object.freeze(
    Object.fromEntries(
        Object.entries(UnitDefinition.all).map(([type, d]) => [
            type,
            Object.freeze({
                radius: Math.max(1, (d?.size || 10) * COLLISION_RADIUS_SCALE),
                radiusFP: Math.max(FP, Math.round((d?.size || 10) * COLLISION_RADIUS_SCALE * FP)),
                mass: Math.max(1, Number(d?.mass) || (d?.size || 10) * (d?.size || 10)),
            }),
        ]),
    ),
);

class UnitVisualDefinition {
    static all = {
        watermelon: {
            family: 'grain',
            billboard: true,
            visualScale: WATERMELON_VISUAL_SCALE,
            accent: [0.26, 0.69, 0.38, 1],
            fx: 'melee',
        },
        acorn: {
            family: 'grain',
            billboard: true,
            visualScale: 0.85,
            accent: [0.62, 0.37, 0.18, 1],
            fx: 'melee',
        },
        rice: {
            family: 'grain',
            billboard: true,
            visualScale: 0.85,
            accent: [0.96, 0.94, 0.86, 1],
            fx: 'melee',
        },
        millet: {
            family: 'grain',
            billboard: true,
            visualScale: 0.85,
            accent: [0.96, 0.94, 0.86, 1],
            fx: 'melee',
        },
        pea: {
            family: 'grain',
            billboard: true,
            visualScale: 0.9,
            accent: [0.5, 0.69, 0.27, 1],
            fx: 'melee',
        },
        corn: {
            family: 'grain',
            billboard: true,
            visualScale: 0.85,
            accent: [0.95, 0.75, 0.25, 1],
            fx: 'melee',
        },
        popcorn: {
            family: 'grain',
            billboard: true,
            visualScale: 0.85,
            accent: [0.95, 0.75, 0.25, 1],
            fx: 'melee',
        },
        chestnut: {
            family: 'grain',
            billboard: true,
            visualScale: 0.85,
            accent: [0.55, 0.28, 0.18, 1],
            fx: 'ranged',
        },
        redbean: {
            family: 'grain',
            billboard: true,
            visualScale: 0.9,
            accent: [0.66, 0.2, 0.23, 1],
            fx: 'melee',
        },
    };
    static get(id) {
        return this.all[id] || null;
    }
}

// Faction supplies colors only; species owns body geometry, scale and materials.
class UnitFactionPalette {
    static all = {
        friendly: {
            body: [0.18, 0.43, 0.93, 1],
            dark: [0.07, 0.19, 0.46, 1],
            light: [0.48, 0.68, 1, 1],
            ring: [0.32, 0.58, 1, 0.58],
        },
        enemy: {
            body: [0.89, 0.28, 0.28, 1],
            dark: [0.48, 0.08, 0.1, 1],
            light: [1, 0.55, 0.55, 1],
            ring: [1, 0.35, 0.35, 0.58],
        },
        neutral: {
            body: [0.48, 0.35, 0.22, 1],
            dark: [0.25, 0.18, 0.12, 1],
            light: [0.72, 0.57, 0.34, 1],
            ring: [0.76, 0.61, 0.28, 0.46],
        },
    };
    static get(relation) {
        return this.all[relation];
    }
}

// Faces baked into the shared face atlas: the grains only ever show these three.
const GRAIN_FACE_IDS = Object.freeze(['neutral', 'attack', 'hurt']);

export {
    GRAIN_FACE_IDS,
    GRAIN_SPRITE_BASE_SCALE,
    UNIT_RENDER_RADIUS_SCALE,
    UNIT_RUNTIME_GEOMETRY,
    WATERMELON_RIND_RADIUS_X,
    UnitDefinition,
    UnitFactionPalette,
    UnitVisualDefinition,
};
