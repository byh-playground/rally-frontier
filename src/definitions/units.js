// Launch grain definitions, runtime geometry and visual definitions.
import { COLLISION_RADIUS_SCALE } from './world-rules.js';
import { FP } from '../core/config.js';

class UnitDefinition {
    static all = {
        rice: {
            requiresContactTerrain: true,
            construction: { range: 5, workPerHit: 1 },
            name: '쌀',
            hp: 25,
            atk: 5,
            range: 25,
            speed: 75,
            cooldownMs: 1000,
            size: 10,
            sizeClass: 'light',
            role: 'bruiser',
            attackVisual: { sourceMotion: 'slash', travel: 'none', impact: 'light' },
            sight: 275,
        },
        soybean: {
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
        rice: {
            family: 'grain',
            billboard: true,
            visualScale: 0.85,
            accent: [0.96, 0.94, 0.86, 1],
            fx: 'melee',
        },
        soybean: {
            family: 'grain',
            billboard: true,
            visualScale: 0.9,
            accent: [0.5, 0.69, 0.27, 1],
            fx: 'melee',
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
    UNIT_RUNTIME_GEOMETRY,
    UnitDefinition,
    UnitFactionPalette,
    UnitVisualDefinition,
};
