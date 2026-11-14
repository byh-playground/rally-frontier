import { UnitDefinition } from '../definitions/units.js';
import { HeroRollAttack } from './capabilities/hero-roll-attack.js';
import { FruitHeroAttack } from './capabilities/fruit-hero-attack.js';
import { HeroAllyAura } from './capabilities/hero-ally-aura.js';
import { HeroPassive } from './capabilities/hero-passive.js';
import { HeroGrowth } from './hero-growth.js';
import { LaunchRules } from './launch-rules.js';
import { NavigationGoal, UnitMotion } from './navigation.js';

const RETURN_PADDING = 10;
const LANDING_GRACE_MS = 2000;
const FULL_HEAL_SECONDS = 10;

export class HeroDeployment {
    static emptySlots(deck) {
        return Object.fromEntries(
            deck.filter((type) => LaunchRules.isHeroType(type)).map((type) => [type, null]),
        );
    }

    static begin(sim, side, type, sortieId) {
        const hp = this.reserveHp(sim, side, type);
        sim.heroRecovery[side][type] =
            hp < UnitDefinition.get(type).hp ? { hp, startedAtTick: null } : null;
        sim.heroes[side][type] = { sortieId, mode: 'advance', unitId: null };
    }

    static reserveHp(sim, side, type) {
        if (sim.heroes[side][type]?.mode === 'dead') return 0;
        const maxHp = UnitDefinition.get(type).hp;
        const recovery = sim.heroRecovery[side][type];
        if (!recovery) return maxHp;
        if (recovery.startedAtTick === null) return recovery.hp;
        const fullHealTicks = FULL_HEAL_SECONDS * sim.tps;
        const elapsed = Math.min(fullHealTicks, sim.tick - recovery.startedAtTick);
        const healed = Math.floor((elapsed * maxHp) / fullHealTicks);
        return Math.min(maxHp, recovery.hp + healed);
    }

    static dock(sim, side, type, hp) {
        sim.heroes[side][type] = null;
        sim.heroRecovery[side][type] =
            hp < UnitDefinition.get(type).hp ? { hp, startedAtTick: sim.tick } : null;
    }

    static launchRejection(hero) {
        if (!hero) return null;
        return hero.mode === 'dead' ? 'hero-unavailable' : 'hero-already-deployed';
    }

    static validSortieId(id) {
        return typeof id === 'string' && /^p[1-9][0-9]{0,15}$/.test(id);
    }

    static findSortie(sim, side, sortieId) {
        return (
            Object.values(sim.heroes[side] || {}).find(
                (hero) => hero && hero.sortieId === sortieId,
            ) || null
        );
    }

    static validate(state) {
        if (!Array.isArray(state.heroes) || state.heroes.length !== 2)
            throw new Error('게임 snapshot의 영웅 슬롯이 잘못되었습니다.');
        if (!Array.isArray(state.heroRecovery) || state.heroRecovery.length !== 2)
            throw new Error('게임 snapshot의 영웅 회복 상태가 잘못되었습니다.');
        if (!Array.isArray(state.heroGrowth) || state.heroGrowth.length !== 2)
            throw new Error('게임 snapshot의 영웅 성장 상태가 잘못되었습니다.');
        const sortieIds = new Set();
        for (const [side, heroes] of state.heroes.entries()) {
            const types = state.decks[side].filter((type) => LaunchRules.isHeroType(type));
            for (const slots of [heroes, state.heroRecovery[side], state.heroGrowth[side]]) {
                if (
                    !slots ||
                    typeof slots !== 'object' ||
                    Array.isArray(slots) ||
                    Object.keys(slots).length !== types.length ||
                    types.some((type) => !Object.hasOwn(slots, type))
                )
                    throw new Error('게임 snapshot의 영웅 슬롯이 경기 덱과 다릅니다.');
            }
            for (const type of types) this.validateSlot(state, side, type, sortieIds);
        }
        for (const unit of state.units) {
            if (!LaunchRules.isHeroType(unit.type)) {
                if (unit.heroGrowth !== undefined)
                    throw new Error('게임 snapshot의 영웅 성장 상태가 잘못되었습니다.');
                continue;
            }
            const deployed = state.heroes[unit.side]?.[unit.type]?.unitId === unit.id;
            if (unit.alive && !deployed)
                throw new Error('게임 snapshot에 출격 슬롯 없는 영웅이 있습니다.');
            // The deployed hero holds its growth record; every other hero body holds none.
            if (
                unit.alive && deployed
                    ? !HeroGrowth.valid(unit.heroGrowth)
                    : unit.heroGrowth !== null
            )
                throw new Error('게임 snapshot의 영웅 성장 상태가 잘못되었습니다.');
        }
        const landingIds = new Set();
        const validateArrival = (side, type, sortieId) => {
            const hero = state.heroes[side]?.[type];
            if (
                !hero ||
                hero.sortieId !== sortieId ||
                hero.unitId !== null ||
                landingIds.has(sortieId)
            )
                throw new Error(
                    '게임 snapshot에 중복되거나 출격 슬롯 없는 영웅 발사체가 있습니다.',
                );
            landingIds.add(sortieId);
        };
        for (const projectile of state.projectiles) {
            if (projectile.alive && LaunchRules.isHeroType(projectile.payload?.type))
                validateArrival(projectile.side, projectile.payload.type, projectile.id);
        }
        for (const group of state.launchDeployments) {
            if (LaunchRules.isHeroType(group.type))
                validateArrival(group.side, group.type, group.projectileId);
        }
    }

    static validateSlot(state, side, type, sortieIds) {
        const hero = state.heroes[side][type];
        // The slot keeps the growth record unless the hero is on the field or has fallen.
        const growth = state.heroGrowth[side][type];
        if (
            hero?.unitId != null || hero?.mode === 'dead'
                ? growth !== null
                : !HeroGrowth.valid(growth)
        )
            throw new Error('게임 snapshot의 영웅 성장 상태가 잘못되었습니다.');
        const maxHp = UnitDefinition.get(type).hp;
        const recovery = state.heroRecovery[side][type];
        if (
            recovery !== null &&
            (!recovery ||
                Object.keys(recovery).sort().join(',') !== 'hp,startedAtTick' ||
                !Number.isFinite(recovery.hp) ||
                recovery.hp <= 0 ||
                recovery.hp >= maxHp ||
                (hero === null
                    ? !Number.isSafeInteger(recovery.startedAtTick) ||
                      recovery.startedAtTick < 0 ||
                      recovery.startedAtTick > state.tick
                    : hero?.mode === 'dead' ||
                      hero?.unitId !== null ||
                      recovery.startedAtTick !== null))
        )
            throw new Error('게임 snapshot의 영웅 회복 상태가 잘못되었습니다.');
        if (hero === null) return;
        if (
            !hero ||
            Object.keys(hero).sort().join(',') !== 'mode,sortieId,unitId' ||
            !this.validSortieId(hero.sortieId) ||
            sortieIds.has(hero.sortieId) ||
            !['advance', 'return', 'dead'].includes(hero.mode) ||
            (hero.mode === 'dead' && hero.unitId !== null)
        )
            throw new Error('게임 snapshot의 영웅 출격이 잘못되었습니다.');
        sortieIds.add(hero.sortieId);
        if (hero.mode === 'dead') return;
        const belongsToHero = (entity) => entity.side === side && entity.type === type;
        const valid =
            hero.unitId === null
                ? state.projectiles.some(
                      (p) =>
                          p.id === hero.sortieId &&
                          p.alive &&
                          belongsToHero(p) &&
                          p.payload?.type === p.type &&
                          p.payload.count === 1,
                  ) ||
                  state.launchDeployments.some(
                      (group) =>
                          group.projectileId === hero.sortieId &&
                          belongsToHero(group) &&
                          group.count === 1,
                  )
                : state.units.some((u) => u.id === hero.unitId && u.alive && belongsToHero(u));
        if (!valid) throw new Error('게임 snapshot의 영웅 출격 대상이 없습니다.');
    }

    static toggle(sim, side, sortieId) {
        const hero = this.findSortie(sim, side, sortieId);
        if (!hero || hero.mode === 'dead') return false;
        hero.mode = hero.mode === 'advance' ? 'return' : 'advance';
        return true;
    }

    static land(sim, group, unit) {
        const { side, type } = group;
        const hero = sim.heroes[side][type];
        if (!hero || hero.sortieId !== group.projectileId || unit.type !== type) return false;
        unit.hp = this.reserveHp(sim, side, type);
        sim.heroRecovery[side][type] = null;
        hero.unitId = unit.id;
        // The growth record goes with the hero onto the field.
        unit.heroGrowth = sim.heroGrowth[side][type];
        sim.heroGrowth[side][type] = null;
        return true;
    }

    static landingFailed(sim, group) {
        const { side, type } = group;
        const hero = sim.heroes[side][type];
        if (!hero || hero.sortieId !== group.projectileId) return false;
        group.heroRetryUntil ??= sim.tick + sim.msTicks(LANDING_GRACE_MS);
        if (sim.tick < group.heroRetryUntil) return false;
        this.dock(sim, side, type, this.reserveHp(sim, side, type));
        return true;
    }

    static unitDied(sim, unit) {
        const hero = sim.heroes[unit.side][unit.type];
        if (hero?.unitId !== unit.id) return;
        this.endSortie(unit);
        hero.mode = 'dead';
        hero.unitId = null;
    }

    // The hero body leaves the field (fallen or recovered): its attacks stop and it holds no growth record.
    static endSortie(unit) {
        if (unit.fruitAttack) FruitHeroAttack.endSortie(unit);
        else if (Object.hasOwn(unit, 'heroRollQueued')) HeroRollAttack.endSortie(unit);
        HeroPassive.endSortie(unit);
        HeroAllyAura.endSortie(unit);
        unit.heroGrowth = null;
    }

    static returnSites(sim, unit) {
        const unitLevel = sim.terrainLevelAt(unit.x, unit.y);
        return sim
            .launchCannons(unit.side)
            .map((cannon) => {
                const distance = Math.hypot(cannon.x - unit.x, cannon.y - unit.y);
                const radius = sim.buildingClearanceDistance(unit, cannon) + RETURN_PADDING;
                const goal = NavigationGoal.range(cannon.x, cannon.y, radius, 0, true, true);
                // Stop slightly inside the actual recovery radius so fixed-point rounding can
                // never strand the unit just outside the threshold it is aiming for.
                const arrival = new NavigationGoal(cannon.x, cannon.y, radius, 0, true);
                const arrived =
                    unitLevel === sim.terrainLevelAt(cannon.x, cannon.y) &&
                    sim.navigation.acceptsGoalPoint(arrival, unit.x, unit.y);
                return { cannon, goal, distance, arrived };
            })
            .sort(
                (a, b) =>
                    a.distance - b.distance ||
                    (a.cannon.id < b.cannon.id ? -1 : a.cannon.id > b.cannon.id ? 1 : 0),
            );
    }

    static moveReturningUnit(sim, unit, definition) {
        const hero = sim.heroes[unit.side][unit.type];
        if (hero?.unitId !== unit.id || hero.mode !== 'return') {
            if (unit.route) unit.route = null;
            return false;
        }
        unit.combat.cancelWindup();
        unit.constructionWork = null;
        unit.target = null;
        if (
            !UnitMotion.isGrounded(unit) ||
            (unit.impactMotion && sim.tick < unit.impactMotion.recoverUntilTick)
        )
            return true;
        const site = this.returnSite(sim, unit);
        if (site && !site.arrived) {
            const speed = (definition.speed * sim.timedModifierPct(unit, 'movePct')) / 100;
            sim.moveToGoal(unit, site.goal, speed, { path: 'route' });
        }
        return true;
    }

    // The cannon a returning hero walks to. The cannon its route leads to is kept while it stands and stays
    // reachable, so a nearer cannon never steals the target mid-way. Only when it is gone or cut off are the
    // others tried, nearest first, one route search each. When none was reachable the route remembers it, and
    // nothing is searched again until the building layout changes.
    static returnSite(sim, unit) {
        const sites = this.returnSites(sim, unit);
        const arrived = sites.find((site) => site.arrived);
        if (arrived) return arrived;
        const routes = sim.navigation.paths.route,
            kept = sites.find((site) => routes.follows(unit, site.goal));
        if (kept) {
            if (routes.knownUnreachable(unit, kept.goal)) return null;
            if (routes.reaches(unit, kept.goal)) return kept;
        }
        return sites.find((site) => site !== kept && routes.reaches(unit, site.goal)) || null;
    }

    static settle(sim) {
        for (const [side, heroes] of sim.heroes.entries())
            for (const type of LaunchRules.heroTypes) {
                const hero = heroes[type];
                if (hero && hero.mode !== 'dead') this.settleSlot(sim, side, type, hero);
            }
    }

    static settleSlot(sim, side, type, hero) {
        if (hero.unitId === null) {
            if (
                !sim.projectiles.some((p) => p.id === hero.sortieId && p.alive) &&
                !sim.launchDeployments.some((group) => group.projectileId === hero.sortieId)
            )
                this.dock(sim, side, type, this.reserveHp(sim, side, type));
            return;
        }
        const unit = sim.liveEntityRefById(hero.unitId, 'unit')?.entity;
        if (!unit) {
            hero.mode = 'dead';
            hero.unitId = null;
            return;
        }
        if (hero.mode !== 'return' || unit.heroRoll || !UnitMotion.isGrounded(unit)) return;
        const site = this.returnSites(sim, unit).find(({ arrived }) => arrived);
        if (!site) return;

        sim.heroGrowth[side][type] = unit.heroGrowth;
        this.endSortie(unit);
        this.dock(sim, side, type, unit.hp);
        unit.alive = false;
        unit.hp = 0;
        unit.impactMotion = null;
        sim.syncUnitSpatial(unit);
        sim.events.push({
            type: 'heroRecovered',
            side,
            heroType: type,
            sortieId: hero.sortieId,
            unitId: unit.id,
            cannonId: site.cannon.id,
            x: unit.x,
            y: unit.y,
        });
    }
}
