import { FP } from '../../core/config.js';
import { SimulationTiming } from '../../core/simulation-timing.js';
import { BuildingDefinition } from '../../definitions/buildings.js';
import { fruitProjectilePosition } from '../../definitions/fruit-hero-trajectory.js';
import { UnitDefinition } from '../../definitions/units.js';
import { HeroGrowth } from '../hero-growth.js';
import { HashUtil } from '../map-generation.js';
import { UnitMotion } from '../navigation.js';
import { UnitThornAttack } from './unit-thorn-attack.js';
import { IndexList } from '../index-list.js';

const SWEEP_QUERY = new IndexList();
const BOUNCE_QUERY = new IndexList();

const STATE_KEYS = 'combo,projectiles';
const SHOT_KEYS =
    'backHitIds,curve,endTick,from,height,id,kind,mode,outHitIds,radius,returnTo,startTick,targetId,targetIsBuilding,to,turnTick';
// Kill-effect bounces in flight at once (a landing strike can kill a crowd); the rest of the kills throw none.
const MAX_BOUNCES = 32;
const MAX_SHOTS = 16 + MAX_BOUNCES;
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
    const bottom = isBuilding
        ? sim.world.terrain.surfaces.heightAt(entity.x, entity.y)
        : UnitMotion.bottom(sim, entity);
    return {
        x: entity.x,
        y: entity.y,
        z: bottom + radius,
    };
}

function impactPoint(sim, x, y) {
    const { width, height, terrain } = sim.world;
    const px = Math.max(0, Math.min(width, Math.round(x * FP) / FP));
    const py = Math.max(0, Math.min(height, Math.round(y * FP) / FP));
    return { x: px, y: py, z: terrain.surfaces.heightAt(px, py) };
}

export class FruitHeroAttack {
    static initialState() {
        return { combo: 0, projectiles: [] };
    }

    static endSortie(unit) {
        if (unit.fruitAttack) unit.fruitAttack = this.initialState();
    }

    static canBasic(unit) {
        return !unit.fruitAttack?.projectiles.some((shot) => shot.kind === 'boomerang');
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
        index = null,
    }) {
        return {
            id: `${unit.id}|${startTick}|${mode}${index === null ? '' : `|${index}`}`,
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
        const definition = UnitDefinition.get(unit.type);
        const spec = definition.fruitAttack;
        const fruit = unit.fruitAttack;
        const startTick = sim.tick;
        const impactTick = startTick + sim.msTicks(spec.basicMs);
        const from = worldPoint(sim, unit);
        fruit.combo = (fruit.combo + 1) % spec.every;
        const proc = fruit.combo === 0;
        const boomerang = spec.kind === 'boomerang';
        const piercing = boomerang && proc;
        const to = piercing
            ? this.boomerangTurnPoint(
                  sim,
                  unit,
                  target,
                  Math.max(
                      definition.range,
                      Math.hypot(target.x - unit.x, target.y - unit.y) + spec.passiveFollowThrough,
                  ),
              )
            : worldPoint(sim, target, isBuilding);
        fruit.projectiles.push(
            this.makeShot({
                unit,
                kind: boomerang ? 'boomerang' : 'berry',
                mode: piercing ? 'passive' : 'basic',
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
            const heading = Math.atan2(target.y - unit.y, target.x - unit.x);
            const dx = Math.cos(heading) * spec.lob.radius;
            const dy = Math.sin(heading) * spec.lob.radius;
            for (const offset of [-1, 0, 1]) {
                const impact = impactPoint(sim, target.x + dx * offset, target.y + dy * offset);
                fruit.projectiles.push(
                    this.lobBerry(sim, unit, from, impact, spec, 'passive', offset + 1),
                );
            }
        }
        sim.events.push({ type: 'fruitThrow', side: unit.side, sourceId: unit.id, ...from });
    }

    static lobBerry(sim, unit, from, to, spec, mode, index = null) {
        return this.makeShot({
            unit,
            kind: 'berry',
            mode,
            index,
            from,
            to,
            startTick: sim.tick,
            endTick: sim.tick + sim.msTicks(spec.lob.durationMs),
            radius: spec.radius,
            height: spec.lob.height,
        });
    }

    // A kill effect (HeroKillEffect `fillCombo`): the n-hit counter is full, so the next basic is the nth one.
    static fillCombo(unit) {
        unit.fruitAttack.combo = UnitDefinition.get(unit.type).fruitAttack.every - 1;
        return true;
    }

    // A kill effect (HeroKillEffect `bounce`): one berry hops from where `fallen` died, on the lob's path and time,
    // to the nearest living ground enemy within `radius`, and hits it alone when it comes down (the path follows
    // the target). Returns the target id, or null when there is none (or no room for another shot).
    static bounce(sim, unit, fallen, { radius }) {
        const fruit = unit.fruitAttack;
        if (fruit.projectiles.filter((shot) => shot.mode === 'bounce').length >= MAX_BOUNCES)
            return null;
        const found = sim.nearbyUnits(fallen.x, fallen.y, radius, 1 - unit.side, BOUNCE_QUERY);
        let target = null,
            best = Infinity;
        for (let k = 0; k < found; k++) {
            const candidate = sim.units[BOUNCE_QUERY.items[k]];
            if (!candidate?.alive || !sim.canAttackEntity(unit.type, candidate, false)) continue;
            const d2 = (candidate.x - fallen.x) ** 2 + (candidate.y - fallen.y) ** 2;
            if (d2 > radius * radius) continue;
            if (d2 < best || (d2 === best && candidate.id < target.id)) {
                target = candidate;
                best = d2;
            }
        }
        if (!target) return null;
        const spec = UnitDefinition.get(unit.type).fruitAttack;
        // Shots of one hero started this tick are told apart by their order; none ends in its first tick.
        const index = fruit.projectiles.filter(
            (shot) => shot.mode === 'bounce' && shot.startTick === sim.tick,
        ).length;
        fruit.projectiles.push(
            this.makeShot({
                unit,
                kind: 'berry',
                mode: 'bounce',
                index,
                from: worldPoint(sim, fallen),
                to: worldPoint(sim, target),
                startTick: sim.tick,
                endTick: sim.tick + sim.msTicks(spec.lob.durationMs),
                radius: spec.radius,
                height: spec.lob.height,
                targetId: target.id,
            }),
        );
        return target.id;
    }

    // A bounce berry in flight: it follows its target, and hits it alone (no kill effect) when it comes down.
    static advanceBounce(sim, unit, shot) {
        const target = sim.liveEntityRefById(shot.targetId, 'unit')?.entity;
        if (target) shot.to = worldPoint(sim, target);
        if (sim.tick < shot.endTick) return true;
        const bounce = HeroGrowth.unlocked(unit, 'killEffect')?.bounce;
        if (!target || !bounce) return false;
        const capture = {};
        sim.applyDamage(unit.side, unit.type, target, false, bounce.damage, unit.id, {
            capture,
            heroKillEffect: false,
        });
        if (capture.dealt > 0)
            sim.events.push({
                type: 'fruitProjectileHit',
                side: unit.side,
                sourceId: unit.id,
                targetId: target.id,
                projectileId: shot.id,
                ...shot.to,
            });
        return false;
    }

    static boomerangTurnPoint(sim, unit, target, reach) {
        const dx = target.x - unit.x;
        const dy = target.y - unit.y;
        const distance = Math.hypot(dx, dy);
        const angle = (HashUtil.hash(unit.id + '|' + target.id) % 8) * (Math.PI / 4);
        const ux = distance ? dx / distance : Math.cos(angle);
        const uy = distance ? dy / distance : Math.sin(angle);
        const { width, height, terrain } = sim.world;
        const limitX = ux > 0 ? (width - unit.x) / ux : ux < 0 ? -unit.x / ux : Infinity;
        const limitY = uy > 0 ? (height - unit.y) / uy : uy < 0 ? -unit.y / uy : Infinity;
        const length = Math.max(0, Math.min(reach, limitX, limitY));
        const x = unit.x + ux * length;
        const y = unit.y + uy * length;
        return { x, y, z: terrain.surfaces.heightAt(x, y) + sim.unitRadius(unit.type) };
    }

    static update(sim, unit) {
        const fruit = unit.fruitAttack;
        const definition = UnitDefinition.get(unit.type);
        const projectiles = [];
        for (const shot of fruit.projectiles) {
            if (this.advanceShot(sim, unit, shot, definition)) projectiles.push(shot);
            if (!unit.alive) return;
        }
        fruit.projectiles = projectiles;
    }

    static advanceShot(sim, unit, shot, definition) {
        if (sim.tick <= shot.startTick) return true;
        const spec = definition.fruitAttack;
        if (shot.mode === 'bounce') return this.advanceBounce(sim, unit, shot);
        if (shot.kind === 'berry' && shot.mode !== 'basic') {
            if (sim.tick < shot.endTick) return true;
            this.landBerry(sim, unit, shot, spec.lob.radius, spec.lob.damage);
            return false;
        }

        const from = fruitProjectilePosition(shot, sim.tick - 1);
        const returning = shot.turnTick !== null && sim.tick > shot.turnTick;
        if (returning) shot.returnTo = worldPoint(sim, unit);
        const to = fruitProjectilePosition(shot, sim.tick);
        if (shot.mode !== 'basic') this.sweep(sim, unit, shot, from, to, returning, definition.atk);
        if (
            unit.alive &&
            !returning &&
            (shot.mode === 'basic' || shot.targetIsBuilding) &&
            !shot.outHitIds.includes(shot.targetId)
        ) {
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
        const found = sim.nearbyUnits(from.x, from.y, length + radius, 1 - unit.side, SWEEP_QUERY);
        for (let k = 0; k < found; k++) {
            const index = SWEEP_QUERY.items[k];
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
            !Array.isArray(fruit.projectiles) ||
            fruit.projectiles.length > MAX_SHOTS ||
            ((!unit.alive || state.heroes?.[unit.side]?.[unit.type]?.unitId !== unit.id) &&
                (fruit.projectiles.length || fruit.combo)) ||
            fruit.projectiles.filter((shot) => shot.mode === 'bounce').length > MAX_BOUNCES ||
            fruit.projectiles.some((shot) => !this.validShot(shot, spec, state.tick, tps)) ||
            new Set(fruit.projectiles.map((shot) => shot.id)).size !== fruit.projectiles.length
        )
            throw new Error('게임 snapshot의 과일 영웅 공격 상태가 잘못되었습니다.');
    }

    static validShot(shot, spec, tick, tps) {
        if (
            !shot ||
            Object.keys(shot).sort().join(',') !== SHOT_KEYS ||
            !validId(shot.id) ||
            !validPoint(shot.from) ||
            !validPoint(shot.to) ||
            !Number.isSafeInteger(shot.startTick) ||
            shot.startTick < 0 ||
            shot.startTick > tick ||
            !Number.isSafeInteger(shot.endTick) ||
            shot.endTick <= tick ||
            !validHits(shot.outHitIds) ||
            !validHits(shot.backHitIds) ||
            typeof shot.targetIsBuilding !== 'boolean'
        )
            return false;
        // A kill-effect bounce (HeroKillEffect): one berry on the lob's path and time at one ground target.
        if (shot.mode === 'bounce')
            return (
                !!spec.lob &&
                shot.kind === 'berry' &&
                shot.radius === spec.radius &&
                shot.curve === 0 &&
                shot.height === spec.lob.height &&
                shot.turnTick === null &&
                shot.endTick ===
                    shot.startTick + SimulationTiming.msToTicks(spec.lob.durationMs, tps) &&
                validId(shot.targetId) &&
                !shot.targetIsBuilding &&
                shot.returnTo === null &&
                !shot.outHitIds.length &&
                !shot.backHitIds.length
            );
        const boomerang = spec.kind === 'boomerang';
        const lob = !boomerang && shot.mode === 'passive';
        const duration = lob ? spec.lob.durationMs : spec.basicMs;
        const outbound = SimulationTiming.msToTicks(duration, tps);
        const returning = boomerang ? SimulationTiming.msToTicks(spec.returnMs, tps) : 0;
        return (
            shot.kind === (boomerang ? 'boomerang' : 'berry') &&
            (shot.mode === 'basic' || shot.mode === 'passive' || lob) &&
            shot.radius === spec.radius &&
            shot.curve === (boomerang ? spec.radius : 0) &&
            shot.height === (lob ? spec.lob.height : 0) &&
            shot.turnTick === (boomerang ? shot.startTick + outbound : null) &&
            shot.endTick === shot.startTick + outbound + returning &&
            (lob
                ? shot.targetId === null && !shot.targetIsBuilding && !shot.outHitIds.length
                : validId(shot.targetId) &&
                  (shot.mode === 'passive' || shot.outHitIds.length <= 1)) &&
            (shot.returnTo === null ||
                (boomerang && tick > shot.turnTick && validPoint(shot.returnTo))) &&
            (tick > shot.startTick || !shot.outHitIds.length) &&
            (!shot.backHitIds.length ||
                (boomerang && tick > shot.turnTick && shot.mode === 'passive'))
        );
    }
}
