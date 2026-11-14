// A hero's growth within one match: the enemy soldiers it struck the killing blow on (one each, whatever their
// kind) and the level they reach (HERO_LEVEL_KILLS). The record has one owner at a time: the deployed hero unit
// (`unit.heroGrowth`) while it is on the field, the deployment slot (`sim.heroGrowth[side][type]`) while it waits
// at the cannons. HeroDeployment hands it over on landing and on recovery; a fallen hero takes it with it.
import { HERO_LEVEL_KILLS } from '../units/baseline.js';
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

    // The killing blow on `target` came from the entity `sourceEntityId`. Only a living deployed hero of the other
    // side counts it; a blow from an ally beside it, or a building, gives the hero nothing.
    static recordKill(sim, sourceEntityId, target) {
        if (!sourceEntityId) return;
        const hero = sim.liveEntityRefById(sourceEntityId, 'unit')?.entity;
        const growth = hero?.heroGrowth;
        if (!growth || hero.side !== 1 - target.side) return;
        growth.kills++;
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
