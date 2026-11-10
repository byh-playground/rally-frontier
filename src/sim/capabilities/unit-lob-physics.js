import { RallyGamekit } from '../../core/gamekit.js';
import { LaunchImpact } from '../launch-impact.js';
import { FP } from '../../core/config.js';
import { BuildingDefinition } from '../../definitions/buildings.js';

const { ContactHit, SweptCircleContact, SurfaceContactGeometry } = RallyGamekit;
const EPS = 1e-7;
// Out buffers of the body and wall casts; read right after each call.
const BODY_HIT = new ContactHit(),
    EDGE_HIT = new ContactHit();
// Names of an edge cast's contact part (key & 3) in a wall contact key.
const EDGE_PARTS = Object.freeze(['edge', 'a', 'b']);

// Continuous projectile motion over a single sub-step, with fixed-point state at tick boundaries.
export class UnitLobPhysics {
    static height(shot, dt, fraction, gravity) {
        const time = dt * fraction;
        return shot.zFP / FP + (shot.vzFP / FP) * time - (gravity * time * time) / 2;
    }
    static position(shot, dt, fraction, gravity) {
        const time = dt * fraction;
        return {
            x: shot.x + (shot.vxFP / FP) * time,
            y: shot.y + (shot.vyFP / FP) * time,
            z: this.height(shot, dt, fraction, gravity),
        };
    }
    static earlier(best, hit) {
        if (!hit || hit.t < -EPS || hit.t > 1 + EPS) return best;
        if (
            !best ||
            hit.t < best.t - EPS ||
            (Math.abs(hit.t - best.t) <= EPS && String(hit.key) < String(best.key))
        )
            return hit;
        return best;
    }
    // Horizontal intersection interval of the swept point and a moving circle.
    static circleInterval(rx, ry, dx, dy, radius) {
        const c = rx * rx + ry * ry - radius * radius;
        const a = dx * dx + dy * dy;
        if (a < EPS) return c <= 0 ? [0, 1] : null;
        const b = rx * dx + ry * dy,
            disc = b * b - a * c;
        if (disc < 0) return null;
        const root = Math.sqrt(disc),
            start = Math.max(0, (-b - root) / a),
            end = Math.min(1, (-b + root) / a);
        return start <= end ? [start, end] : null;
    }
    // Earliest intersection with the target's moving vertical cylinder (expanded by shot radius).
    static bodyContact(
        sim,
        shot,
        entity,
        isBuilding,
        previous,
        tickStart,
        tickSpan,
        dt,
        spec,
        motion = null,
    ) {
        const currentGround = motion ? 0 : sim.world.terrain.surfaces.heightAt(entity.x, entity.y);
        const prev = previous.get(entity.id) || {
            x: entity.x,
            y: entity.y,
            z: currentGround + (entity.impactMotion?.heightFP || 0) / FP,
        };
        const endZ = currentGround + (entity.impactMotion?.heightFP || 0) / FP;
        const px = motion ? (motion.x ?? entity.x) : prev.x + (entity.x - prev.x) * tickStart,
            py = motion ? (motion.y ?? entity.y) : prev.y + (entity.y - prev.y) * tickStart;
        const pz = motion ? motion.z : prev.z + (endZ - prev.z) * tickStart;
        const tx = motion ? motion.vx * dt : (entity.x - prev.x) * tickSpan,
            ty = motion ? motion.vy * dt : (entity.y - prev.y) * tickSpan,
            tz = motion ? motion.vz * dt : (endZ - prev.z) * tickSpan;
        const end = this.position(shot, dt, 1, spec.gravity),
            dx = end.x - shot.x,
            dy = end.y - shot.y;
        const bodyRadius = isBuilding
            ? BuildingDefinition.get(entity.type)?.size || 30
            : sim.unitRadius(entity.type);
        const radius = bodyRadius + spec.radius,
            rx = shot.x - px,
            ry = shot.y - py;
        const interval = this.circleInterval(rx, ry, dx - tx, dy - ty, radius);
        if (!interval) return null;
        const [entry, exit] = interval,
            lower = -spec.radius,
            upper = bodyRadius * 2 + spec.radius;
        const bodyGravity = motion?.gravity || 0;
        const relativeHeight = (t) =>
            this.height(shot, dt, t, spec.gravity) -
            (pz + tz * t - (bodyGravity * dt * dt * t * t) / 2);
        const gravityDiff = spec.gravity - bodyGravity;
        const apex =
            dt > 0 && Math.abs(gravityDiff) > EPS
                ? ((shot.vzFP / FP) * dt - tz) / (gravityDiff * dt * dt)
                : -1;
        const cuts = apex > entry && apex < exit ? [entry, apex, exit] : [entry, exit];
        let time = null;
        for (let j = 1; j < cuts.length; j++) {
            const start = cuts[j - 1],
                stop = cuts[j],
                a = relativeHeight(start),
                b = relativeHeight(stop);
            if (a >= lower && a <= upper) {
                time = start;
                break;
            }
            if (!((a < lower && b >= lower) || (a > upper && b <= upper))) continue;
            let lo = start,
                hi = stop;
            for (let k = 0; k < 20; k++) {
                const mid = (lo + hi) / 2,
                    z = relativeHeight(mid);
                if (a < lower ? z < lower : z > upper) lo = mid;
                else hi = mid;
            }
            time = hi;
            break;
        }
        if (time === null) return null;
        const point = this.position(shot, dt, time, spec.gravity),
            relZ = relativeHeight(time);
        const relX = rx + (dx - tx) * time,
            relY = ry + (dy - ty) * time,
            length = Math.hypot(relX, relY);
        const cast = SweptCircleContact.cast(
            rx,
            ry,
            dx - tx,
            dy - ty,
            radius,
            SweptCircleContact.policies.relative,
            BODY_HIT,
        )
            ? BODY_HIT
            : null;
        let nx = length ? relX / length : cast?.nx || 1,
            ny = length ? relY / length : cast?.ny || 0,
            nz = 0;
        if (Math.abs(relZ - upper) < 0.03) {
            nx = 0;
            ny = 0;
            nz = 1;
        } else if (Math.abs(relZ - lower) < 0.03) {
            nx = 0;
            ny = 0;
            nz = -1;
        }
        const bodyVx = motion ? motion.vx : (entity.x - prev.x) * sim.tps,
            bodyVy = motion ? motion.vy : (entity.y - prev.y) * sim.tps,
            bodyVz = motion ? motion.vz - bodyGravity * dt * time : (endZ - prev.z) * sim.tps;
        const inward =
            (shot.vxFP / FP - bodyVx) * nx +
            (shot.vyFP / FP - bodyVy) * ny +
            (shot.vzFP / FP - spec.gravity * dt * time - bodyVz) * nz;
        if (inward >= -0.01) return null;
        return {
            t: time,
            key: `body:${entity.id}`,
            kind: 'body',
            id: entity.id,
            isBuilding,
            nx,
            ny,
            nz,
            bodyVx,
            bodyVy,
            bodyVz,
            bodyZ: pz + tz * time - (bodyGravity * dt * dt * time * time) / 2,
            point,
        };
    }
    static groundContact(sim, shot, dt, spec) {
        const end = this.position(shot, dt, 1, spec.gravity),
            dx = end.x - shot.x,
            dy = end.y - shot.y;
        // The surface atlas certifies cells untouched by any layer, ramp or bridge edge.
        // A segment contained in one such cell has a single constant floor, so it
        // needs no polygon/segment-cut allocations. Boundary cells keep the exact path.
        const surfaceAtlas = sim.world.terrain.surfaces,
            table = surfaceAtlas.sampleCells || surfaceAtlas.sampleCellTable();
        const cx = Math.floor(shot.x / table.cell),
            cy = Math.floor(shot.y / table.cell),
            ex = Math.floor(end.x / table.cell),
            ey = Math.floor(end.y / table.cell);
        const flat =
            cx === ex && cy === ey && cx >= 0 && cy >= 0 && cx < table.cols && cy < table.rows
                ? table.cells[cy * table.cols + cx]
                : null;
        if (flat) {
            const floor = flat.elevation + spec.radius,
                z = shot.zFP / FP,
                vz = shot.vzFP / FP,
                g = spec.gravity;
            const height = (t) => z + vz * dt * t - (g * dt * dt * t * t) / 2;
            let t = null;
            if (height(0) <= floor && (vz * dt < -EPS || (Math.abs(vz * dt) <= EPS && g > 0)))
                t = 0;
            else if (height(0) > floor && height(1) <= floor) {
                let lo = 0,
                    hi = 1;
                for (let k = 0; k < 20; k++) {
                    const m = (lo + hi) / 2;
                    if (height(m) > floor) lo = m;
                    else hi = m;
                }
                t = hi;
            }
            return t === null
                ? null
                : {
                      t,
                      key: 'ground',
                      kind: 'ground',
                      nx: 0,
                      ny: 0,
                      nz: 1,
                      point: this.position(shot, dt, t, spec.gravity),
                  };
        }
        const { atlas, cuts, polygons } = LaunchImpact.terrainSweep(
            sim,
            shot.x,
            shot.y,
            end.x,
            end.y,
        );
        let best = null;
        for (let i = 1; i < cuts.length; i++) {
            const lo = cuts[i - 1],
                hi = cuts[i],
                mid = (lo + hi) / 2,
                surface = atlas.sample(shot.x + dx * mid, shot.y + dy * mid),
                g = surface.gradient || { x: 0, z: 0 };
            const floor = (t) => surface.elevation + g.x * dx * (t - mid) + g.z * dy * (t - mid);
            const gap = (t) => this.height(shot, dt, t, spec.gravity) - floor(t) - spec.radius;
            let time = null;
            const gapVelocity =
                (shot.vzFP / FP) * dt - spec.gravity * dt * dt * lo - g.x * dx - g.z * dy;
            if (
                gap(lo) <= 0 &&
                (gapVelocity < -EPS || (Math.abs(gapVelocity) <= EPS && spec.gravity > 0) || lo > 0)
            )
                time = lo;
            else if (gap(lo) > 0 && gap(hi) <= 0) {
                let a = lo,
                    b = hi;
                for (let j = 0; j < 20; j++) {
                    const m = (a + b) / 2;
                    if (gap(m) > 0) a = m;
                    else b = m;
                }
                time = b;
            }
            if (time === null) continue;
            const point = this.position(shot, dt, time, spec.gravity),
                ground = floor(time),
                prior = atlas.heightAt(
                    shot.x + dx * Math.max(0, time - 1e-5),
                    shot.y + dy * Math.max(0, time - 1e-5),
                );
            if (time > 0 && ground > prior + 0.01 && point.z - spec.radius < ground - 0.01) {
                let wall = null,
                    wallEdge = 0,
                    wallPart = 0,
                    wallT = Infinity,
                    wallNx = 0,
                    wallNy = 0;
                for (const polygon of polygons)
                    for (let j = 0; j < polygon.points.length; j++) {
                        const a = polygon.points[j],
                            b = polygon.points[(j + 1) % polygon.points.length];
                        if (
                            SurfaceContactGeometry.edgeCast(
                                shot.x,
                                shot.y,
                                dx,
                                dy,
                                a.x,
                                a.y,
                                b.x,
                                b.y,
                                spec.radius,
                                j * 4,
                                0,
                                EDGE_HIT,
                            ) &&
                            EDGE_HIT.t <= time + 0.01 &&
                            EDGE_HIT.t < wallT
                        ) {
                            wall = polygon;
                            wallEdge = j;
                            wallPart = EDGE_HIT.key & 3;
                            wallT = EDGE_HIT.t;
                            wallNx = EDGE_HIT.nx;
                            wallNy = EDGE_HIT.ny;
                        }
                    }
                if (wall)
                    best = this.earlier(best, {
                        t: wallT,
                        key: 'wall:' + wall.id + ':' + wallEdge + ':' + EDGE_PARTS[wallPart],
                        kind: 'wall',
                        nx: wallNx,
                        ny: wallNy,
                        nz: 0,
                        point: this.position(shot, dt, wallT, spec.gravity),
                    });
                continue;
            }
            const length = Math.hypot(g.x, g.z, 1);
            best = this.earlier(best, {
                t: time,
                key: 'ground',
                kind: 'ground',
                nx: -g.x / length,
                ny: -g.z / length,
                nz: 1 / length,
                point,
            });
        }
        return best;
    }
    static sweep(
        sim,
        shot,
        dt,
        elapsed,
        previous,
        spec,
        motionOf = null,
        maxBodySpeed = 0,
        skipUnits = false,
        ignoredContacts = null,
    ) {
        const end = this.position(shot, dt, 1, spec.gravity),
            dx = end.x - shot.x,
            dy = end.y - shot.y;
        let best = null;
        const consider = (hit) => {
            if (hit && !ignoredContacts?.has(hit.key)) best = this.earlier(best, hit);
        };
        consider(this.groundContact(sim, shot, dt, spec));
        for (const wall of [
            {
                start: shot.x,
                delta: dx,
                limit: spec.radius,
                nx: 1,
                ny: 0,
                key: 'world:left',
                outward: dx < 0,
            },
            {
                start: shot.x,
                delta: dx,
                limit: sim.world.width - spec.radius,
                nx: -1,
                ny: 0,
                key: 'world:right',
                outward: dx > 0,
            },
            {
                start: shot.y,
                delta: dy,
                limit: spec.radius,
                nx: 0,
                ny: 1,
                key: 'world:top',
                outward: dy < 0,
            },
            {
                start: shot.y,
                delta: dy,
                limit: sim.world.height - spec.radius,
                nx: 0,
                ny: -1,
                key: 'world:bottom',
                outward: dy > 0,
            },
        ]) {
            if (!wall.outward) continue;
            const t = (wall.limit - wall.start) / wall.delta;
            if (t >= 0 && t <= 1)
                consider({
                    t,
                    key: wall.key,
                    kind: 'wall',
                    nx: wall.nx,
                    ny: wall.ny,
                    nz: 0,
                    point: this.position(shot, dt, t, spec.gravity),
                });
        }
        const reach =
            Math.hypot(dx, dy) / 2 +
            sim.maxUnitRadius +
            spec.radius +
            (sim.collisionMaxStepMovementFP || 0) / FP +
            maxBodySpeed * dt;
        const xMin = Math.min(shot.x, end.x),
            xMax = Math.max(shot.x, end.x),
            yMin = Math.min(shot.y, end.y),
            yMax = Math.max(shot.y, end.y);
        const zStart = shot.zFP / FP,
            zEnd = end.z,
            apex = spec.gravity > 0 ? shot.vzFP / FP / spec.gravity : -1;
        const zMin = Math.min(zStart, zEnd),
            zMax = Math.max(
                zStart,
                zEnd,
                apex > 0 && apex < dt ? this.height(shot, dt, apex / dt, spec.gravity) : -Infinity,
            );
        if (!skipUnits)
            sim.withNearbyUnits((shot.x + end.x) / 2, (shot.y + end.y) / 2, reach, (indices) => {
                for (const i of indices) {
                    const unit = sim.units[i];
                    if (!unit?.alive || (unit.id === shot.sourceId && !shot.clearedSource))
                        continue;
                    const radius = sim.unitRadius(unit.type),
                        pad = radius + spec.radius;
                    const coarse =
                        pad + (sim.collisionMaxStepMovementFP || 0) / FP + maxBodySpeed * dt;
                    if (
                        unit.x < xMin - coarse ||
                        unit.x > xMax + coarse ||
                        unit.y < yMin - coarse ||
                        unit.y > yMax + coarse
                    )
                        continue;
                    const motion = motionOf?.(unit) || null;
                    if (motion) {
                        const mx = motion.x ?? unit.x,
                            my = motion.y ?? unit.y,
                            ux = mx + motion.vx * dt,
                            uy = my + motion.vy * dt;
                        if (
                            xMax + pad < Math.min(mx, ux) ||
                            xMin - pad > Math.max(mx, ux) ||
                            yMax + pad < Math.min(my, uy) ||
                            yMin - pad > Math.max(my, uy)
                        )
                            continue;
                        const gravity = motion.gravity || 0,
                            uz = motion.z + motion.vz * dt - (gravity * dt * dt) / 2,
                            peak = gravity > 0 ? motion.vz / gravity : -1;
                        const uzMin = Math.min(motion.z, uz),
                            uzMax = Math.max(
                                motion.z,
                                uz,
                                peak > 0 && peak < dt
                                    ? motion.z + motion.vz * peak - (gravity * peak * peak) / 2
                                    : -Infinity,
                            );
                        if (zMax + spec.radius < uzMin || zMin - spec.radius > uzMax + radius * 2)
                            continue;
                    } else {
                        const current =
                            sim.world.terrain.surfaces.heightAt(unit.x, unit.y) +
                            (unit.impactMotion?.heightFP || 0) / FP;
                        const start = previous.get(unit.id)?.z ?? current;
                        if (
                            zMax + spec.radius < Math.min(start, current) ||
                            zMin - spec.radius > Math.max(start, current) + radius * 2
                        )
                            continue;
                    }
                    consider(
                        this.bodyContact(
                            sim,
                            shot,
                            unit,
                            false,
                            previous,
                            elapsed,
                            dt * sim.tps,
                            dt,
                            spec,
                            motion,
                        ),
                    );
                }
            });
        for (const i of sim.nearbyBuildingIndices(
            (shot.x + end.x) / 2,
            (shot.y + end.y) / 2,
            Math.hypot(dx, dy) / 2 + sim.maxBuildingRadius + spec.radius,
        )) {
            const building = sim.buildings[i];
            if (building?.alive === false) continue;
            consider(
                this.bodyContact(
                    sim,
                    shot,
                    building,
                    true,
                    previous,
                    elapsed,
                    dt * sim.tps,
                    dt,
                    spec,
                ),
            );
        }
        return best;
    }
}
