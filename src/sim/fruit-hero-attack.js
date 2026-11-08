import { FP } from '../core/config.js';
import { SimulationTiming } from '../core/simulation-timing.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { fruitProjectilePosition } from '../definitions/fruit-hero-trajectory.js';
import { UnitDefinition } from '../definitions/units.js';
import { HashUtil } from './map-generation.js';
import { UnitMotion } from './navigation.js';
import { UnitThornAttack } from './unit-thorn-attack.js';

const STATE_KEYS = 'active,combo,projectiles,queued';
const SHOT_KEYS =
    'backHitIds,curve,endTick,from,height,id,kind,mode,outHitIds,radius,returnTo,startTick,targetId,targetIsBuilding,to,turnTick';
const MAX_SHOTS = 16;
const MAX_HITS = 1024;
const MAX_POSITION = 1_000_000;

function validId(id) {
    return typeof id === 'string' && id.length > 0 && id.length <= 256;
}

function validPoint(point) {
    return (
        point &&
        Object.keys(point).sort().join(',') === 'x,y,z' &&
        [point.x, point.y, point.z].every((n) => Number.isFinite(n) && Math.abs(n) < MAX_POSITION)
    );
}

function validHits(ids) {
    return (
        Array.isArray(ids) &&
        ids.length <= MAX_HITS &&
        ids.every(validId) &&
        new Set(ids).size === ids.length
    );
}

function worldPoint(sim, entity, isBuilding = false) {
    const radius = isBuilding
        ? BuildingDefinition.get(entity.type)?.size || 30
        : sim.unitRadius(entity.type);
    const ground = sim.world.terrain.surfaces.heightAt(entity.x, entity.y);
    return {
        x: entity.x,
        y: entity.y,
        z: ground + (isBuilding ? 0 : (entity.impactMotion?.heightFP || 0) / FP) + radius,
    };
}

export class FruitHeroAttack {
    static initialState() {
        return { combo: 0, queued: false, active: null, projectiles: [] };
    }

    static endSortie(unit) {
        if (unit.fruitAttack) unit.fruitAttack = this.initialState();
    }

    static canBasic(unit) {
        const fruit = unit.fruitAttack;
        return !fruit?.active && !fruit?.projectiles.some((shot) => shot.kind === 'boomerang');
    }

    static blocksMovement(unit) {
        return unit.fruitAttack?.active?.kind === 'boomerang';
    }

    static canStart(unit, tick) {
        const motion = unit.impactMotion;
        return (
            unit.alive &&
            this.canBasic(unit) &&
            !unit.combat.attackWindupUntil &&
            UnitMotion.isGrounded(unit) &&
            (!motion || (tick >= motion.recoverUntilTick && !motion.vxFP && !motion.vyFP))
        );
    }

    static makeShot({
        unit,
        kind,
        mode,
        from,
        to,
        startTick,
        turnTick = null,
        endTick,
        radius,
        curve = 0,
        height = 0,
        targetId = null,
        targetIsBuilding = false,
    }) {
        return {
            id: `${unit.id}|${startTick}|${mode}`,
            kind,
            mode,
            from,
            to,
            startTick,
            turnTick,
            endTick,
            radius,
            curve,
            height,
            targetId,
            targetIsBuilding,
            returnTo: null,
            outHitIds: [],
            backHitIds: [],
        };
    }

    static basic(sim, unit, target, isBuilding) {
        const spec = UnitDefinition.get(unit.type).fruitAttack;
        const fruit = unit.fruitAttack;
        const startTick = sim.tick;
        const impactTick = startTick + sim.msTicks(spec.basicMs);
        const from = worldPoint(sim, unit);
        const to = worldPoint(sim, target, isBuilding);
        fruit.combo = (fruit.combo + 1) % spec.every;
        const proc = fruit.combo === 0;
        const boomerang = spec.kind === 'boomerang';
        fruit.projectiles.push(
            this.makeShot({
                unit,
                kind: boomerang ? 'boomerang' : 'berry',
                mode: boomerang && proc ? 'passive' : 'basic',
                from,
                to,
                startTick,
                turnTick: boomerang ? impactTick : null,
                endTick: boomerang ? impactTick + sim.msTicks(spec.returnMs) : impactTick,
                radius: spec.radius,
                curve: boomerang ? spec.radius : 0,
                targetId: target.id,
                targetIsBuilding: isBuilding,
            }),
        );
        if (proc && spec.lob) {
            const impact = {
                x: target.x,
                y: target.y,
                z: sim.world.terrain.surfaces.heightAt(target.x, target.y),
            };
            fruit.projectiles.push(this.lobBerry(sim, unit, from, impact, spec, 'passive'));
        }
        sim.events.push({ type: 'fruitThrow', side: unit.side, sourceId: unit.id, ...from });
    }

    static lobBerry(sim, unit, from, to, spec, mode) {
        return this.makeShot({
            unit,
            kind: 'berry',
            mode,
            from,
            to,
            startTick: sim.tick,
            endTick: sim.tick + sim.msTicks(spec.lob.durationMs),
            radius: spec.radius,
            height: spec.lob.height,
        });
    }

    static activate(sim, unit, sortieId) {
        const fruit = unit.fruitAttack;
        if (!this.canStart(unit, sim.tick)) {
            fruit.queued = true;
            return true;
        }
        fruit.queued = false;
        return this.start(sim, unit, sortieId);
    }

    static reject(sim, unit, sortieId, reason) {
        sim.events.push({ type: 'heroSkillRejected', side: unit.side, sortieId, reason });
        return false;
    }

    static target(sim, unit, range) {
        const vision = sim.visionSources(unit.side);
        let target = null;
        let best = range ** 2;
        sim.withNearbyUnits(unit.x, unit.y, range, 1 - unit.side, (indices) => {
            for (const index of indices) {
                const candidate = sim.units[index];
                if (!candidate?.alive || candidate.hp <= 0) continue;
                const distance = (candidate.x - unit.x) ** 2 + (candidate.y - unit.y) ** 2;
                if (
                    sim.targetChoiceBetter(distance, candidate.id, best, target) &&
                    sim.canSeeCombatTarget(unit.side, candidate, vision)
                ) {
                    target = candidate;
                    best = distance;
                }
            }
        });
        return target;
    }

    static start(sim, unit, sortieId) {
        const spec = UnitDefinition.get(unit.type).fruitAttack;
        const { cost, range, windupMs } = spec.active;
        if (sim.wallet[unit.side] < cost)
            return this.reject(sim, unit, sortieId, 'insufficient-basic-resources');
        const target = this.target(sim, unit, range);
        if (!target) return this.reject(sim, unit, sortieId, 'hero-no-target');
        const launchTick = sim.tick + sim.msTicks(windupMs);
        unit.fruitAttack.active =
            spec.kind === 'boomerang'
                ? {
                      kind: 'boomerang',
                      shot: this.activeBoomerang(sim, unit, target, launchTick, spec.active),
                  }
                : {
                      kind: 'grape',
                      startTick: sim.tick,
                      nextTick: launchTick,
                      strike: 0,
                      impacts: this.clusterImpacts(sim, unit, target, spec),
                  };
        unit.combat.attackArcTargetId = null;
        unit.combat.attackArcUntilTick = 0;
        unit.constructionWork = null;
        unit.target = null;
        sim.wallet[unit.side] -= cost;
        sim.events.push({
            type: 'heroSkillStarted',
            side: unit.side,
            sortieId,
            heroType: unit.type,
            cost,
        });
        return true;
    }

    static clusterImpacts(sim, unit, target, spec) {
        const { width, height, terrain } = sim.world;
        const point = (x, y) => {
            const px = Math.max(0, Math.min(width, Math.round(x * FP) / FP));
            const py = Math.max(0, Math.min(height, Math.round(y * FP) / FP));
            return { x: px, y: py, z: terrain.surfaces.heightAt(px, py) };
        };
        const heading = Math.atan2(target.y - unit.y, target.x - unit.x);
        const impacts = [point(target.x, target.y)];
        for (let index = 0; index < spec.active.shots - 1; index++) {
            const angle = heading + (2 * Math.PI * index) / (spec.active.shots - 1);
            impacts.push(
                point(
                    target.x + Math.cos(angle) * spec.lob.radius,
                    target.y + Math.sin(angle) * spec.lob.radius,
                ),
            );
        }
        return impacts;
    }

    static activeBoomerang(sim, unit, target, startTick, spec) {
        const from = worldPoint(sim, unit);
        const dx = target.x - unit.x;
        const dy = target.y - unit.y;
        const distance = Math.hypot(dx, dy);
        const angle = (HashUtil.hash(unit.id + '|' + target.id) % 8) * (Math.PI / 4);
        const ux = distance ? dx / distance : Math.cos(angle);
        const uy = distance ? dy / distance : Math.sin(angle);
        const { width, height, terrain } = sim.world;
        const limitX = ux > 0 ? (width - from.x) / ux : ux < 0 ? -from.x / ux : Infinity;
        const limitY = uy > 0 ? (height - from.y) / uy : uy < 0 ? -from.y / uy : Infinity;
        const length = Math.max(0, Math.min(spec.length, limitX, limitY));
        const x = from.x + ux * length;
        const y = from.y + uy * length;
        const z = terrain.surfaces.heightAt(x, y) + sim.unitRadius(unit.type);
        const travel = sim.msTicks(spec.travelMs);
        return this.makeShot({
            unit,
            kind: 'boomerang',
            mode: 'active',
            from,
            to: { x, y, z },
            startTick,
            turnTick: startTick + travel,
            endTick: startTick + 2 * travel,
            radius: spec.radius,
            curve: spec.curve,
        });
    }

    static update(sim, unit, sortieId) {
        const fruit = unit.fruitAttack;
        const definition = UnitDefinition.get(unit.type);
        const projectiles = [];
        for (const shot of fruit.projectiles) {
            if (this.advanceShot(sim, unit, shot, definition)) projectiles.push(shot);
            if (!unit.alive) return;
        }
        fruit.projectiles = projectiles;
        const active = fruit.active;
        if (active?.kind === 'boomerang') {
            if (active.shot.startTick === sim.tick)
                sim.events.push({
                    type: 'fruitThrow',
                    side: unit.side,
                    sourceId: unit.id,
                    ...active.shot.from,
                });
            if (!this.advanceShot(sim, unit, active.shot, definition)) fruit.active = null;
        } else if (active) {
            this.advanceBarrage(sim, unit, active, definition.fruitAttack);
        }
        if (fruit.queued && this.canStart(unit, sim.tick)) this.activate(sim, unit, sortieId);
    }

    static advanceBarrage(sim, unit, active, spec) {
        if (sim.tick < active.nextTick) return;
        const from = worldPoint(sim, unit);
        const shot = this.lobBerry(
            sim,
            unit,
            from,
            active.impacts[active.strike++],
            spec,
            'active',
        );
        unit.fruitAttack.projectiles.push(shot);
        sim.events.push({
            type: 'fruitThrow',
            side: unit.side,
            sourceId: unit.id,
            projectileId: shot.id,
            mode: 'active',
            ...from,
        });
        if (active.strike === spec.active.shots) unit.fruitAttack.active = null;
        else active.nextTick += sim.msTicks(spec.active.intervalMs);
    }

    static advanceShot(sim, unit, shot, definition) {
        if (sim.tick <= shot.startTick) return true;
        const spec = definition.fruitAttack;
        if (shot.kind === 'berry' && shot.mode !== 'basic') {
            if (sim.tick < shot.endTick) return true;
            const damage = spec.lob.damage * (shot.mode === 'active' ? spec.active.damageRatio : 1);
            this.landBerry(sim, unit, shot, spec.lob.radius, damage);
            return false;
        }

        const from = fruitProjectilePosition(shot, sim.tick - 1);
        const returning = shot.turnTick !== null && sim.tick > shot.turnTick;
        if (returning && shot.mode !== 'active') shot.returnTo = worldPoint(sim, unit);
        const to = fruitProjectilePosition(shot, sim.tick);
        if (shot.mode === 'active' || (returning && shot.mode === 'passive')) {
            const damage = definition.atk * (shot.mode === 'active' ? spec.active.damageRatio : 1);
            this.sweep(sim, unit, shot, from, to, returning, damage);
        } else if (!returning && !shot.outHitIds.length) {
            const target = sim.liveEntityRefById(
                shot.targetId,
                shot.targetIsBuilding ? 'building' : 'unit',
            )?.entity;
            const point =
                target && this.contact(sim, shot, from, to, target, shot.targetIsBuilding);
            if (point) {
                shot.outHitIds.push(target.id);
                this.hit(sim, unit, shot, target, point, shot.targetIsBuilding, definition.atk);
            }
        }
        return sim.tick < shot.endTick;
    }

    static contact(sim, shot, from, to, target, targetIsBuilding) {
        return UnitThornAttack.contact(
            sim,
            { radius: shot.radius, targetIsBuilding },
            { x: from.x, y: from.y, zFP: Math.round(from.z * FP) },
            { x: to.x, y: to.y, zFP: Math.round(to.z * FP) },
            target,
        );
    }

    static sweep(sim, unit, shot, from, to, returning, damage) {
        const hits = returning ? shot.backHitIds : shot.outHitIds;
        const contacts = [];
        const length = Math.hypot(to.x - from.x, to.y - from.y);
        const radius = shot.radius + sim.maxUnitRadius + sim.collisionMaxStepMovementFP / FP;
        sim.withNearbyUnits(from.x, from.y, length + radius, 1 - unit.side, (indices) => {
            for (const index of indices) {
                const target = sim.units[index];
                if (!target?.alive || hits.includes(target.id)) continue;
                const point = this.contact(sim, shot, from, to, target, false);
                if (!point) continue;
                contacts.push({
                    target,
                    point,
                    distance: Math.hypot(point.x - from.x, point.y - from.y),
                });
            }
        });
        contacts.sort((a, b) => a.distance - b.distance || (a.target.id < b.target.id ? -1 : 1));
        for (const { target, point } of contacts) {
            if (!unit.alive) return;
            if (!target.alive) continue;
            hits.push(target.id);
            this.hit(sim, unit, shot, target, point, false, damage);
        }
    }

    static damage(sim, unit, target, isBuilding, amount) {
        const capture = {};
        sim.applyDamage(unit.side, unit.type, target, isBuilding, amount, unit.id, { capture });
        return capture.dealt > 0;
    }

    static hit(sim, unit, shot, target, point, isBuilding, damage) {
        if (this.damage(sim, unit, target, isBuilding, damage))
            sim.events.push({
                type: 'fruitProjectileHit',
                side: unit.side,
                sourceId: unit.id,
                targetId: target.id,
                projectileId: shot.id,
                ...point,
            });
    }

    static landBerry(sim, unit, shot, radius, damage) {
        const { x, y, z } = shot.to;
        const impactHeightFP = Math.round(z * FP);
        const { hits } = sim.applyAreaDamage({
            sourceSide: unit.side,
            sourceType: unit.type,
            sourceEntityId: unit.id,
            x,
            y,
            radius,
            damage,
            impactHeightFP,
        });
        sim.events.push({
            type: 'fruitBerryLand',
            side: unit.side,
            sourceId: unit.id,
            x,
            y,
            zFP: impactHeightFP,
            radius,
            hits,
        });
    }

    static validateState(unit, state, tps) {
        const spec = UnitDefinition.get(unit.type).fruitAttack;
        const fruit = unit.fruitAttack;
        if (!spec && fruit === undefined) return;
        if (
            !spec ||
            !fruit ||
            Object.keys(fruit).sort().join(',') !== STATE_KEYS ||
            !Number.isInteger(fruit.combo) ||
            fruit.combo < 0 ||
            fruit.combo >= spec.every ||
            typeof fruit.queued !== 'boolean' ||
            !Array.isArray(fruit.projectiles) ||
            fruit.projectiles.length > MAX_SHOTS ||
            ((!unit.alive || state.heroes?.[unit.side]?.[unit.type]?.unitId !== unit.id) &&
                (fruit.queued ||
                    fruit.active !== null ||
                    fruit.projectiles.length ||
                    fruit.combo)) ||
            fruit.projectiles.some((shot) => !this.validShot(shot, spec, state.tick, tps, false)) ||
            new Set(fruit.projectiles.map((shot) => shot.id)).size !== fruit.projectiles.length ||
            !this.validActive(fruit.active, spec, state.tick, tps)
        )
            throw new Error('게임 snapshot의 과일 영웅 공격 상태가 잘못되었습니다.');
    }

    static validActive(active, spec, tick, tps) {
        if (active === null) return true;
        if (active?.kind !== spec.kind) return false;
        const keys = Object.keys(active).sort().join(',');
        const windup = SimulationTiming.msToTicks(spec.active.windupMs, tps);
        if (active.kind === 'boomerang')
            return (
                keys === 'kind,shot' &&
                this.validShot(active.shot, spec, tick, tps, true) &&
                active.shot.startTick - windup >= 0 &&
                active.shot.startTick - windup <= tick
            );
        return (
            keys === 'impacts,kind,nextTick,startTick,strike' &&
            Array.isArray(active.impacts) &&
            active.impacts.length === spec.active.shots &&
            active.impacts.every(validPoint) &&
            active.impacts.every(
                ({ x, y }) =>
                    Math.hypot(x - active.impacts[0].x, y - active.impacts[0].y) <=
                    spec.lob.radius + 2 / FP,
            ) &&
            Number.isSafeInteger(active.startTick) &&
            active.startTick >= 0 &&
            active.startTick <= tick &&
            Number.isInteger(active.strike) &&
            active.strike >= 0 &&
            active.strike < spec.active.shots &&
            active.nextTick ===
                active.startTick +
                    windup +
                    active.strike * SimulationTiming.msToTicks(spec.active.intervalMs, tps) &&
            active.nextTick > tick
        );
    }

    static validShot(shot, spec, tick, tps, active) {
        if (
            !shot ||
            Object.keys(shot).sort().join(',') !== SHOT_KEYS ||
            !validId(shot.id) ||
            !validPoint(shot.from) ||
            !validPoint(shot.to) ||
            !Number.isSafeInteger(shot.startTick) ||
            shot.startTick < 0 ||
            (!active && shot.startTick > tick) ||
            !Number.isSafeInteger(shot.endTick) ||
            shot.endTick <= tick ||
            !validHits(shot.outHitIds) ||
            !validHits(shot.backHitIds) ||
            typeof shot.targetIsBuilding !== 'boolean'
        )
            return false;
        const boomerang = spec.kind === 'boomerang';
        const lob = !boomerang && (shot.mode === 'passive' || shot.mode === 'active');
        const duration = active ? spec.active.travelMs : lob ? spec.lob.durationMs : spec.basicMs;
        const outbound = SimulationTiming.msToTicks(duration, tps);
        const returning = boomerang
            ? SimulationTiming.msToTicks(active ? spec.active.travelMs : spec.returnMs, tps)
            : 0;
        return (
            shot.kind === (boomerang ? 'boomerang' : 'berry') &&
            (active
                ? shot.mode === 'active'
                : shot.mode === 'basic' || shot.mode === 'passive' || lob) &&
            shot.radius === (active ? spec.active.radius : spec.radius) &&
            shot.curve === (active ? spec.active.curve : boomerang ? spec.radius : 0) &&
            shot.height === (lob ? spec.lob.height : 0) &&
            shot.turnTick === (boomerang ? shot.startTick + outbound : null) &&
            shot.endTick === shot.startTick + outbound + returning &&
            (active || lob
                ? shot.targetId === null &&
                  !shot.targetIsBuilding &&
                  (!lob || !shot.outHitIds.length)
                : validId(shot.targetId) && shot.outHitIds.length <= 1) &&
            (shot.returnTo === null ||
                (!active && boomerang && tick > shot.turnTick && validPoint(shot.returnTo))) &&
            (tick > shot.startTick || !shot.outHitIds.length) &&
            (!shot.backHitIds.length ||
                (boomerang && tick > shot.turnTick && (active || shot.mode === 'passive')))
        );
    }
}
