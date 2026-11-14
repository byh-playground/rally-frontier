// A hero's growth within one match: the enemy soldiers it struck the killing blow on (one each, whatever their
// kind) and the level they reach (HERO_LEVEL_KILLS). The record has one owner at a time: the deployed hero unit
// (`unit.heroGrowth`) while it is on the field, the deployment slot (`sim.heroGrowth[side][type]`) while it waits
// at the cannons. HeroDeployment hands it over on landing and on recovery; a fallen hero takes it with it.
// A hero Definition declares what each level unlocks in `growth { <level>: { <effect>: spec } }` (levels 2 to
// maxLevel); `unlocked` gives the spec of an effect once the hero's level reaches it. Levels raise no stats.
import { HERO_LEVEL_KILLS } from '../units/baseline.js';
import { UnitDefinition } from '../definitions/units.js';
import { LaunchRules } from './launch-rules.js';

const GROWTH_KEYS = 'kills,level';

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
