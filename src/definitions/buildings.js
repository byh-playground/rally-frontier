import { LaunchImpactRules } from './launch-impact-rules.js';

const TOWER_ATTACK = Object.freeze({
    canAttackGround: true,
    canAttackAir: true,
    range: 500,
    atk: 8,
    cooldownMs: 500,
    damageClass: 'normal',
    attackVisual: Object.freeze({ travel: 'hitscan', impact: 'light' }),
    mortar: Object.freeze({
        attackInterval: 5,
        damage: 20,
        damageClass: 'area',
        radius: 100,
        flightMs: 750,
        arcHeight: 150,
    }),
});
// A launch cannon: the player fires troops from it and its shells leave this far from the centre.
// Base and outpost share cannon.svg, whose muzzle socket sits LaunchImpactRules.muzzleReach out.
const CANNON_LAUNCH = Object.freeze({ muzzleReach: LaunchImpactRules.muzzleReach });

// Building definitions: each side's main base, the outposts spawned on captured points, the
// forward cannons that potatoes grow into and the blight's spore sacs.
class BuildingDefinition {
    static all = {
        base: {
            ...TOWER_ATTACK,
            name: '메인 거점',
            showsFactionPennant: true,
            visualCategory: 'base',
            isMainBase: true,
            launch: CANNON_LAUNCH,
            hp: 2400,
            size: 55,
            sight: 475,
        },
        outpost: {
            ...TOWER_ATTACK,
            name: '전진 거점',
            showsFactionPennant: true,
            visualCategory: 'outpost',
            isOutpost: true,
            launch: CANNON_LAUNCH,
            construction: {
                cost: 100,
                workRequired: 250,
                paymentWork: 5,
                initialHpRatio: 0.1,
            },
            hp: 500,
            size: 45,
            sight: 425,
        },
        // A launch cannon only: no turret, no production, no capture point, never under construction.
        // Its health drains from the moment it stands, so 150 lasts 15 seconds unless enemies cut it short.
        'forward-cannon': {
            name: '전진 대포',
            showsFactionPennant: true,
            visualCategory: 'forward-cannon',
            // forward-cannon.svg puts its muzzle socket 92 SVG units out, drawn at the cannon art scale (1/4).
            launch: Object.freeze({ muzzleReach: 23 }),
            decay: Object.freeze({ hpPerSecond: 10 }),
            hp: 150,
            // 초안: 받침이 거점 대포의 약 68%라 충돌 반경도 거점(45)의 같은 비율로 둔다.
            size: 30,
            // 초안: 감자 병사와 같은 시야.
            sight: 275,
        },
        // The blight's spore sac (sim/spore-sac.js): it does not attack, launch, produce or hold a capture point,
        // and it is no main base. Destroying it frees its captives: the bound blighted soldiers that are alive and
        // within `freeRadius` of it join the other side.
        'spore-sac': {
            name: '포자 주머니',
            visualCategory: 'spore-sac',
            sporeSac: Object.freeze({
                freeRadius: 150,
                // 초안: the captives stand in rings around the sac, the first this far out, `spacing` apart.
                ringRadius: 75,
                spacing: 34,
            }),
            hp: 100,
            // 초안: 전진 대포와 같은 몸 크기.
            size: 30,
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
