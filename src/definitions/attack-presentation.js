// Attack presentation: the attacker's source motion and the contact impact. Never used in damage math.
import { BuildingDefinition } from './buildings.js';
import { UnitDefinition } from './units.js';

class AttackPresentationDefinition {
    static sourceMotions = Object.freeze({
        // Source-motion scale is owned by the attacker. Target size/distance never changes it.
        slash: Object.freeze({
            kind: 'slash',
            lifeMs: 210,
            baseSize: 12,
            sourceRadiusScale: 1.15,
            maxSize: 42,
        }),
        smash: Object.freeze({
            kind: 'smash',
            lifeMs: 260,
            baseSize: 18,
            sourceRadiusScale: 1.3,
            maxSize: 52,
        }),
    });
    static impacts = Object.freeze({
        // Impact owns target/contact feedback. Its scale is semantic, never inherited from Source Motion.
        light: Object.freeze({ fx: 'meleeImpact', scale: 0.82 }),
    });
    static forSource(type) {
        const d = UnitDefinition.get(type) || BuildingDefinition.get(type) || {};
        const a = d.attackVisual;
        if (!a) return { sourceMotion: null, travel: 'none', impact: 'light' };
        return {
            sourceMotion: a.sourceMotion ?? null,
            travel: a.travel ?? 'none',
            impact: a.impact ?? 'light',
        };
    }
    static impactPreset(type) {
        return this.impacts[this.forSource(type).impact] || this.impacts.light;
    }
}

export { AttackPresentationDefinition };
