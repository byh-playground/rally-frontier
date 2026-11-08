import { UnitDefinition } from '../definitions/units.js';
import { HeroRollAttack } from './hero-roll-attack.js';
import { LaunchRules } from './launch-rules.js';
import { NavigationGoal, UnitMotion } from './navigation.js';

const RETURN_PADDING = 10;
const LANDING_GRACE_MS = 2000;
const FULL_HEAL_SECONDS = 10;

export class HeroDeployment {
    static begin(sim, side, sortieId) {
        const hp = this.reserveHp(sim, side);
        sim.heroRecovery[side] =
            hp < UnitDefinition.get(LaunchRules.heroCard).hp ? { hp, startedAtTick: null } : null;
        sim.heroes[side] = { sortieId, mode: 'advance', unitId: null };
    }

    static reserveHp(sim, side) {
        if (sim.heroes[side]?.mode === 'dead') return 0;
        const maxHp = UnitDefinition.get(LaunchRules.heroCard).hp;
        const recovery = sim.heroRecovery[side];
        if (!recovery) return maxHp;
        if (recovery.startedAtTick === null) return recovery.hp;
        const fullHealTicks = FULL_HEAL_SECONDS * sim.tps;
        const elapsed = Math.min(fullHealTicks, sim.tick - recovery.startedAtTick);
        const healed = Math.floor((elapsed * maxHp) / fullHealTicks);
        return Math.min(maxHp, recovery.hp + healed);
    }

    static dock(sim, side, hp) {
        const maxHp = UnitDefinition.get(LaunchRules.heroCard).hp;
        sim.heroes[side] = null;
        sim.heroRecovery[side] = hp < maxHp ? { hp, startedAtTick: sim.tick } : null;
    }

    static launchRejection(hero) {
        if (!hero) return null;
        return hero.mode === 'dead' ? 'hero-unavailable' : 'hero-already-deployed';
    }

    static validSortieId(id) {
        return typeof id === 'string' && /^p[1-9][0-9]{0,15}$/.test(id);
    }

    static validate(state) {
        if (!Array.isArray(state.heroes) || state.heroes.length !== 2)
            throw new Error('게임 snapshot의 영웅 슬롯이 잘못되었습니다.');
        if (!Array.isArray(state.heroRecovery) || state.heroRecovery.length !== 2)
            throw new Error('게임 snapshot의 영웅 회복 상태가 잘못되었습니다.');
        const maxHp = UnitDefinition.get(LaunchRules.heroCard).hp;
        for (const [side, hero] of state.heroes.entries()) {
            const recovery = state.heroRecovery[side];
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
            if (hero === null) continue;
            if (
                !hero ||
                Object.keys(hero).sort().join(',') !== 'mode,sortieId,unitId' ||
                !this.validSortieId(hero.sortieId) ||
                !['advance', 'return', 'dead'].includes(hero.mode) ||
                (hero.mode === 'dead' && hero.unitId !== null)
            )
                throw new Error('게임 snapshot의 영웅 출격이 잘못되었습니다.');
            if (hero.mode === 'dead') continue;
            const belongsToHero = (entity) =>
                entity.side === side && entity.type === LaunchRules.heroCard;
            const valid =
                hero.unitId === null
                    ? state.projectiles.some(
                          (p) => p.id === hero.sortieId && p.alive && belongsToHero(p),
                      ) ||
                      state.launchDeployments.some(
                          (group) => group.projectileId === hero.sortieId && belongsToHero(group),
                      )
                    : state.units.some((u) => u.id === hero.unitId && u.alive && belongsToHero(u));
            if (!valid) throw new Error('게임 snapshot의 영웅 출격 대상이 없습니다.');
        }
    }

    static toggle(sim, side, sortieId) {
        const hero = sim.heroes[side];
        if (!hero || hero.mode === 'dead' || hero.sortieId !== sortieId) return false;
        hero.mode = hero.mode === 'advance' ? 'return' : 'advance';
        return true;
    }

    static land(sim, group, unit) {
        const hero = sim.heroes[group.side];
        if (!hero || hero.sortieId !== group.projectileId) return false;
        unit.hp = this.reserveHp(sim, group.side);
        sim.heroRecovery[group.side] = null;
        hero.unitId = unit.id;
        return true;
    }

    static landingFailed(sim, group) {
        const hero = sim.heroes[group.side];
        if (!hero || hero.sortieId !== group.projectileId) return false;
        group.heroRetryUntil ??= sim.tick + sim.msTicks(LANDING_GRACE_MS);
        if (sim.tick < group.heroRetryUntil) return false;
        this.dock(sim, group.side, this.reserveHp(sim, group.side));
        return true;
    }

    static unitDied(sim, unit) {
        const hero = sim.heroes[unit.side];
        if (hero?.unitId !== unit.id) return;
        HeroRollAttack.endSortie(unit);
        hero.mode = 'dead';
        hero.unitId = null;
    }

    static returnSites(sim, unit) {
        const unitLevel = sim.terrainLevelAt(unit.x, unit.y);
        return sim
            .launchCannons(unit.side)
            .map((cannon) => {
                const distance = Math.hypot(cannon.x - unit.x, cannon.y - unit.y);
                const radius = sim.buildingClearanceDistance(unit, cannon) + RETURN_PADDING;
                const goal = NavigationGoal.range(cannon.x, cannon.y, radius, 0, true);
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
        const hero = sim.heroes[unit.side];
        if (hero?.unitId !== unit.id || hero.mode !== 'return') return false;
        unit.combat.cancelWindup();
        unit.constructionWork = null;
        unit.target = null;
        if (
            !UnitMotion.isGrounded(unit) ||
            (unit.impactMotion && sim.tick < unit.impactMotion.recoverUntilTick)
        )
            return true;
        const site = this.returnSites(sim, unit).find(
            ({ arrived, goal }) => arrived || sim.navigation.nextPoint(unit, goal, true),
        );
        if (site && !site.arrived) {
            const speed = (definition.speed * sim.timedModifierPct(unit, 'movePct')) / 100;
            sim.moveToGoal(unit, site.goal, speed, { fixedGoal: true });
        }
        return true;
    }

    static settle(sim) {
        for (const [side, hero] of sim.heroes.entries()) {
            if (!hero || hero.mode === 'dead') continue;
            if (hero.unitId === null) {
                if (
                    !sim.projectiles.some((p) => p.id === hero.sortieId && p.alive) &&
                    !sim.launchDeployments.some((group) => group.projectileId === hero.sortieId)
                )
                    this.dock(sim, side, this.reserveHp(sim, side));
                continue;
            }
            const unit = sim.liveEntityRefById(hero.unitId, 'unit')?.entity;
            if (!unit) {
                hero.mode = 'dead';
                hero.unitId = null;
                continue;
            }
            if (hero.mode !== 'return' || unit.heroRoll || !UnitMotion.isGrounded(unit)) continue;
            const site = this.returnSites(sim, unit).find(({ arrived }) => arrived);
            if (!site) continue;

            HeroRollAttack.endSortie(unit);
            this.dock(sim, side, unit.hp);
            unit.alive = false;
            unit.hp = 0;
            unit.impactMotion = null;
            sim.syncUnitSpatial(unit);
            sim.events.push({
                type: 'heroRecovered',
                side,
                unitId: unit.id,
                cannonId: site.cannon.id,
                x: unit.x,
                y: unit.y,
            });
        }
    }
}
