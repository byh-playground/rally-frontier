const TOWER_ATTACK = Object.freeze({
    canAttackGround: true,
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

// Building definitions: each side's main base and the outposts spawned on captured points.
class BuildingDefinition {
    static all = {
        base: {
            ...TOWER_ATTACK,
            name: '메인 거점',
            showsFactionPennant: true,
            visualCategory: 'base',
            isMainBase: true,
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
