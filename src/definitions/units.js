// Simulation and visual definitions of every unit, read from the unit folders (src/units), plus
// runtime geometry and faction palettes.
import { COLLISION_RADIUS_SCALE } from './world-rules.js';
import { FP } from '../core/config.js';
import { UNITS } from '../units/index.js';

class UnitDefinition {
    static all = Object.fromEntries(UNITS.map((card) => [card.id, card.unit]));
    static get(type) {
        return this.all[type] || null;
    }
    static onlyAttacksBuildings(type) {
        const unit = this.get(type);
        return unit?.canAttackBuildings === true && !unit.canAttackGround;
    }
    static damageClass(type) {
        const d = this.get(type);
        if (!d) return 'normal';
        if (d.damageClass) return d.damageClass;
        if ((d.range || 0) >= 250) return 'ranged';
        return 'melee';
    }
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
    static all = Object.fromEntries(UNITS.map((card) => [card.id, card.visual]));
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
