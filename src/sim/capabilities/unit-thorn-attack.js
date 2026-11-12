// Contract (moved from the index.html Development Contract):
// - 밤톨 기본 가시는 발사 순간 목표 위치를 고정해 비행한다. 지정 목표와의 상대 sweep 및 높이 겹침이
//   있을 때만 피해를 주며, 공격자가 사망해도 발사된 가시는 유지한다. 투사체 상태는 저장·복원한다.
import { UnitMotion } from '../navigation.js';
import { FP } from '../../core/config.js';
import { RallyGamekit } from '../../core/gamekit.js';
import { BuildingDefinition } from '../../definitions/buildings.js';

const { SweptCircleContact } = RallyGamekit;
// Out buffer of the thorn's swept test; only whether it hit is read.
const CAST_HIT = { t: 0, nx: 0, ny: 0, degenerate: false };

// The base chestnut attack has a committed aim and checks only its original
// target. It is independent of cannon-deployment shells and corn explosives.
export class UnitThornAttack {
    static launch(sim, source, target, isBuilding, spec) {
        if (
            !source ||
            !target ||
            !Number.isFinite(spec?.durationMs) ||
            spec.durationMs <= 0 ||
            !Number.isFinite(spec?.radius) ||
            spec.radius < 0 ||
            !Number.isFinite(spec?.launchHeight) ||
            !Number.isFinite(spec?.targetHeight) ||
            !Number.isFinite(spec?.damage) ||
            spec.damage < 0
        )
            throw new Error('밤톨 가시 투사체 설정이 올바르지 않습니다.');
        if (!Array.isArray(sim.unitThornProjectiles))
            throw new Error('밤톨 투사체 상태가 초기화되지 않았습니다.');
        const radius = isBuilding
                ? BuildingDefinition.get(target.type)?.size || 30
                : sim.unitRadius(target.type),
            dx = target.x - source.x,
            dy = target.y - source.y,
            distance = Math.hypot(dx, dy) || 1,
            launchOffset = Math.min(sim.unitRadius(source.type), distance),
            travel = Math.max(0, distance - radius + spec.radius),
            terrain = sim.world.terrain.surfaces,
            startTick = sim.tick + 1,
            durationTicks = Math.max(1, sim.msTicks(spec.durationMs)),
            fromZ = UnitMotion.bottom(sim, source) + spec.launchHeight,
            targetZ =
                (isBuilding
                    ? terrain.heightAt(target.x, target.y)
                    : UnitMotion.bottom(sim, target)) + spec.targetHeight;
        const shot = {
            id: `thorn:${source.id}:${sim.tick}`,
            sourceId: source.id,
            sourceType: source.type,
            side: source.side,
            targetId: target.id,
            targetIsBuilding: !!isBuilding,
            startTick,
            durationTicks,
            fromFx: Math.round((source.x + (dx / distance) * launchOffset) * FP),
            fromFy: Math.round((source.y + (dy / distance) * launchOffset) * FP),
            fromZFP: Math.round(fromZ * FP),
            toFx: Math.round((source.x + (dx / distance) * travel) * FP),
            toFy: Math.round((source.y + (dy / distance) * travel) * FP),
            toZFP: Math.round(targetZ * FP),
            x: Math.round((source.x + (dx / distance) * launchOffset) * FP) / FP,
            y: Math.round((source.y + (dy / distance) * launchOffset) * FP) / FP,
            zFP: Math.round(fromZ * FP),
            radius: spec.radius,
            damage: spec.damage,
        };
        source.combat.thornAimX = target.x;
        source.combat.thornLaunchTick = startTick;
        sim.unitThornProjectiles.push(shot);
        return shot;
    }

    static position(shot, fraction) {
        const at = (a, b) => Math.round(a + (b - a) * fraction);
        return {
            x: at(shot.fromFx, shot.toFx) / FP,
            y: at(shot.fromFy, shot.toFy) / FP,
            zFP: at(shot.fromZFP, shot.toZFP),
        };
    }

    // Intersect the XY sweep interval and the target's vertical slab. The
    // target's XY movement is relative to its current-tick start position.
    static contact(sim, shot, from, to, target) {
        const index = shot.targetIsBuilding ? null : sim.unitIndexById.get(target.id),
            hasStart = index != null && index < sim.collisionStartCount,
            sx = hasStart ? sim.collisionStartFx[index] / FP : target.x,
            sy = hasStart ? sim.collisionStartFy[index] / FP : target.y,
            rx = from.x - sx,
            ry = from.y - sy,
            vx = to.x - from.x - (target.x - sx),
            vy = to.y - from.y - (target.y - sy),
            bodyRadius = shot.targetIsBuilding
                ? BuildingDefinition.get(target.type)?.size || 30
                : sim.unitRadius(target.type),
            radius = bodyRadius + shot.radius,
            inside = rx * rx + ry * ry <= radius * radius,
            cast = SweptCircleContact.cast(
                rx,
                ry,
                vx,
                vy,
                radius,
                SweptCircleContact.policies.relative,
                CAST_HIT,
            );
        if (!inside && !cast) return null;
        const a = vx * vx + vy * vy,
            b = rx * vx + ry * vy,
            c = rx * rx + ry * ry - radius * radius,
            disc = b * b - a * c;
        if (a > 1e-12 && disc < 0) return null;
        const root = a > 1e-12 ? Math.sqrt(Math.max(0, disc)) : 0,
            entry = inside ? 0 : Math.max(0, (-b - root) / a),
            exit = a > 1e-12 ? Math.min(1, (-b + root) / a) : 1;
        if (entry > exit || exit < 0 || entry > 1) return null;
        const bottom = shot.targetIsBuilding
                ? sim.world.terrain.surfaces.heightAt(target.x, target.y)
                : UnitMotion.bottom(sim, target),
            lower = bottom - shot.radius,
            upper = bottom + bodyRadius * 2 + shot.radius,
            z = from.zFP / FP,
            dz = (to.zFP - from.zFP) / FP;
        let verticalEntry = 0,
            verticalExit = 1;
        if (Math.abs(dz) < 1e-12) {
            if (z < lower || z > upper) return null;
        } else {
            const first = (lower - z) / dz,
                second = (upper - z) / dz;
            verticalEntry = Math.min(first, second);
            verticalExit = Math.max(first, second);
        }
        const time = Math.max(0, entry, verticalEntry),
            end = Math.min(1, exit, verticalExit);
        if (time > end) return null;
        return {
            x: from.x + (to.x - from.x) * time,
            y: from.y + (to.y - from.y) * time,
            zFP: Math.round(from.zFP + (to.zFP - from.zFP) * time),
        };
    }

    static update(sim) {
        if (!Array.isArray(sim.unitThornProjectiles))
            throw new Error('밤톨 투사체 상태가 초기화되지 않았습니다.');
        const survivors = [];
        for (const shot of sim.unitThornProjectiles) {
            if (sim.tick < shot.startTick) {
                survivors.push(shot);
                continue;
            }
            const elapsed = sim.tick - shot.startTick,
                from = this.position(shot, Math.min(1, elapsed / shot.durationTicks)),
                to = this.position(shot, Math.min(1, (elapsed + 1) / shot.durationTicks));
            if (elapsed === 0)
                sim.events.push({
                    type: 'unitThornLaunch',
                    side: shot.side,
                    sourceId: shot.sourceId,
                    projectileId: shot.id,
                    ...from,
                });
            const target = shot.targetIsBuilding
                ? sim.buildingById.get(shot.targetId)
                : sim.unitById.get(shot.targetId);
            const hit =
                target && target.alive !== false && target.hp > 0 && target.side !== shot.side
                    ? this.contact(sim, shot, from, to, target)
                    : null;
            if (hit) {
                sim.applyDamage(
                    shot.side,
                    shot.sourceType,
                    target,
                    shot.targetIsBuilding,
                    shot.damage,
                    shot.sourceId,
                    { suppressImpactFx: true },
                );
                sim.events.push({
                    type: 'unitThornHit',
                    side: shot.side,
                    sourceId: shot.sourceId,
                    targetId: shot.targetId,
                    projectileId: shot.id,
                    ...hit,
                });
                continue;
            }
            if (elapsed + 1 >= shot.durationTicks) {
                sim.events.push({
                    type: 'unitThornMiss',
                    side: shot.side,
                    sourceId: shot.sourceId,
                    projectileId: shot.id,
                    ...to,
                });
                continue;
            }
            shot.x = to.x;
            shot.y = to.y;
            shot.zFP = to.zFP;
            survivors.push(shot);
        }
        sim.unitThornProjectiles = survivors;
    }
}
