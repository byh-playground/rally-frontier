import { LaunchRules } from '../sim/launch-rules.js';
import { VIEW_W } from './world-rules.js';
// Building definitions: each side's main base and the outposts spawned on captured points.
class BuildingDefinition {
    static all = {
        base: {
            name: '메인 거점',
            showsFactionPennant: true,
            visualCategory: 'base',
            isMainBase: true,
            hp: 2400,
            size: 55,
            sight: 475,
        },
        outpost: {
            name: '전진 거점',
            showsFactionPennant: true,
            visualCategory: 'outpost',
            isOutpost: true,
            construction: {
                cost: 15 * LaunchRules.resourceScale,
                workRequired: 375,
                initialHpRatio: 0.1,
            },
            hp: 1400,
            size: 45,
            sight: 425,
            canAttackGround: true,
            range: 500,
            atk: 8,
            cooldownMs: 500,
            damageClass: 'normal',
            attackVisual: { travel: 'hitscan', impact: 'light' },
            mortar: Object.freeze({
                attackInterval: 5,
                damage: 20,
                damageClass: 'area',
                radius: VIEW_W / 6,
                flightMs: 750,
                arcHeight: 150,
            }),
        },
    };
    static get(type) {
        return this.all[type] || null;
    }
    static isMainBase(type) {
        return !!this.get(type)?.isMainBase;
    }
    static byRole = Object.freeze({ mainBase: 'base', outpost: 'outpost' });
    static forRole(role) {
        return this.byRole[role] || null;
    }
}

export { BuildingDefinition };
