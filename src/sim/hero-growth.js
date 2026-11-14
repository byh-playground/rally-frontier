// A hero's growth within one match: the enemy soldiers it struck the killing blow on (one each, whatever their
// kind) and the level they reach (HERO_LEVEL_KILLS). The record has one owner at a time: the deployed hero unit
// (`unit.heroGrowth`) while it is on the field, the deployment slot (`sim.heroGrowth[side][type]`) while it waits
// at the cannons. HeroDeployment hands it over on landing and on recovery; a fallen hero takes it with it.
// A hero Definition declares what each level unlocks in `growth { <level>: { <effect>: spec } }` (levels 2 to
// maxLevel); `unlocked` gives the spec of an effect once the hero's level reaches it. Levels raise no stats.
// The awakening (`awaken`, level 6) overrides blocks of the hero's own Definition (`spinAttack`, `fruitAttack`) and its
// body scale; ability code reads the block through `spec(hero, block)` (the effective spec for its level) and the body
// through `bodyScale`, so no ability branches on the awakening itself.
import { HERO_LEVEL_KILLS } from '../units/baseline.js';
import { UnitDefinition } from '../definitions/units.js';
import { LaunchRules } from './launch-rules.js';

const GROWTH_KEYS = 'kills,level';
// The Definition blocks an awakening may override, merged once per hero type on first use.
const AWAKEN_BLOCKS = Object.freeze(['spinAttack', 'fruitAttack']);
const AWAKENED = new Map();

// `base` with the fields of `patch` laid over it, nested plain objects merged field by field.
function overlay(base, patch) {
    const out = { ...base };
    for (const [key, value] of Object.entries(patch))
        out[key] =
            value && typeof value === 'object' && !Array.isArray(value) && base?.[key]
                ? overlay(base[key], value)
                : value;
    return Object.freeze(out);
}

export class HeroGrowth {
    static maxLevel = HERO_LEVEL_KILLS.length;

    static initial() {
        return { kills: 0, level: 1 };
    }

    static emptySlots(deck) {
        return Object.fromEntries(
            deck
                .filter((type) => LaunchRules.isHeroType(type))
                .map((type) => [type, this.initial()]),
        );
    }

    static levelFor(kills) {
        let level = 1;
        while (level < this.maxLevel && kills >= HERO_LEVEL_KILLS[level]) level++;
        return level;
    }

    // Kills needed for the next level, or null at the top level.
    static nextLevelKills(level) {
        return level < this.maxLevel ? HERO_LEVEL_KILLS[level] : null;
    }

    // The spec of `effect` the hero's current level has unlocked (the highest level up to it that declares it), or
    // null: a hero below that level, a unit that is not a deployed hero, or a Definition without it.
    static unlocked(hero, effect) {
        const growth = UnitDefinition.get(hero.type)?.growth,
            level = hero.heroGrowth?.level;
        if (!growth || !level) return null;
        for (let at = level; at >= 2; at--) {
            const spec = growth[at]?.[effect];
            if (spec) return spec;
        }
        return null;
    }

    // The spec of `effect` the Definition declares at any level (the state it needs), or null.
    static declared(type, effect) {
        const growth = UnitDefinition.get(type)?.growth;
        for (const level in growth) if (growth[level][effect]) return growth[level][effect];
        return null;
    }

    // The Definition block `block` (spinAttack, fruitAttack) as the hero's level has it: the awakened block once the
    // awakening is unlocked, the Definition's own otherwise (and for every unit that is not a deployed hero).
    static spec(unit, block) {
        const base = UnitDefinition.get(unit.type)?.[block];
        if (!unit.heroGrowth || !base) return base;
        const awaken = this.unlocked(unit, 'awaken');
        if (!awaken?.[block]) return base;
        let blocks = AWAKENED.get(unit.type);
        if (!blocks) {
            blocks = {};
            for (const key of AWAKEN_BLOCKS)
                if (awaken[key])
                    blocks[key] = overlay(UnitDefinition.get(unit.type)[key], awaken[key]);
            AWAKENED.set(unit.type, blocks);
        }
        return blocks[block];
    }

    // How much larger the hero's body is (drawing and collision) at its level: the awakening's `bodyScale`, else 1.
    // A unit that is not a deployed hero has no growth record and is 1 at once.
    static bodyScale(unit) {
        if (!unit?.heroGrowth) return 1;
        return this.unlocked(unit, 'awaken')?.bodyScale ?? 1;
    }

    // The largest body scale a type ever reaches (the collision grid's widest unit, the prepared path fields).
    static maxBodyScale(type) {
        return this.declared(type, 'awaken')?.bodyScale ?? 1;
    }

    // The killing blow on `target` came from the entity `sourceEntityId`. Only a living deployed hero of the other
    // side counts it; a blow from an ally beside it, or a building, gives the hero nothing. Returns the hero that
    // counted it (its level already raised), or null.
    static recordKill(sim, sourceEntityId, target) {
        if (!sourceEntityId) return;
        const hero = sim.liveEntityRefById(sourceEntityId, 'unit')?.entity;
        const growth = hero?.heroGrowth;
        if (!growth || hero.side !== 1 - target.side) return null;
        growth.kills++;
        this.levelUp(sim, hero, growth);
        return hero;
    }

    static levelUp(sim, hero, growth) {
        const level = this.levelFor(growth.kills);
        if (level === growth.level) return;
        growth.level = level;
        sim.events.push({
            type: 'heroLevelUp',
            side: hero.side,
            heroType: hero.type,
            unitId: hero.id,
            level,
            kills: growth.kills,
            x: hero.x,
            y: hero.y,
        });
    }

    static valid(growth) {
        return (
            !!growth &&
            Object.keys(growth).sort().join(',') === GROWTH_KEYS &&
            Number.isSafeInteger(growth.kills) &&
            growth.kills >= 0 &&
            growth.level === this.levelFor(growth.kills)
        );
    }
}
