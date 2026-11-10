// Contract (moved from the index.html Development Contract):
// - 옥수수 병사의 알은 대포 투입탄과 별도의 권위 상태다. 기존 2D 접촉 기하와 지형·몸체의 높이를
//   함께 사용하며, 최초 지면 접촉 시각부터 1초 뒤 폭발한다. 지상 알끼리 충돌하고 공중 알끼리의
//   충돌은 처리하지 않는다. 알의 위치·속도와 착지·폭발 시각은 저장·복원·리플레이에 포함한다.
import { FP } from '../../core/config.js';
import { RallyGamekit } from '../../core/gamekit.js';
import { UnitLobPhysics } from './unit-lob-physics.js';
import { LaunchImpact } from '../launch-impact.js';

const {
    CONTACT_POLYGON,
    ContactHit,
    ContactList,
    MotionResult,
    SurfaceContactGeometry,
    SweptCircleContact,
    contactKey,
} = RallyGamekit;
// Shell pairs touch at the contact itself, without the relative policy's early stop.
const PAIR_POLICY = Object.freeze({ ...SweptCircleContact.policies.relative, retreat: 0 });
// Out buffers of the terrain and pair casts; read (or copied) right after each call.
const WALL_HIT = new ContactHit(),
    EDGE_HIT = new ContactHit(),
    PAIR_HIT = new ContactHit(),
    SURFACE_CONTACTS = new ContactList(),
    MOTION = new MotionResult();

// Projectile state is independent of artillery/deployment and remains authoritative after the shooter dies.
export class UnitLobAttack {
    static previous = new WeakMap();
    static groundedSpecs = new WeakMap();
    static physicsSpec(shot) {
        if (!shot.grounded) return shot.spec;
        let spec = this.groundedSpecs.get(shot.spec);
        if (!spec) {
            spec = { ...shot.spec, gravity: 0 };
            this.groundedSpecs.set(shot.spec, spec);
        }
        return spec;
    }
    static beginStep(sim) {
        if (!sim.unitLobProjectiles.length) return;
        const positions = new Map();
        for (const u of sim.units)
            if (u?.alive)
                positions.set(u.id, {
                    x: u.x,
                    y: u.y,
                    z:
                        sim.world.terrain.surfaces.heightAt(u.x, u.y) +
                        (u.impactMotion?.heightFP || 0) / FP,
                });
        this.previous.set(sim, positions);
    }
    static launch(sim, source, target, spec, attack) {
        source.combat.lobLaunchTick = sim.tick + 1;
        const count = Math.max(1, Math.trunc(spec.shots));
        const gap = Math.max(0, sim.msTicks(spec.shotGapMs));
        const direction = target.x < source.x ? -1 : 1;
        const launchX = source.x + direction * spec.launchOffsetX,
            launchY = source.y;
        const dx = target.x - launchX,
            dy = target.y - launchY,
            distance = Math.hypot(dx, dy) || 1;
        const duration = distance / spec.projectileSpeed;
        const ground = sim.world.terrain.surfaces.heightAt(source.x, source.y),
            targetGround = sim.world.terrain.surfaces.heightAt(target.x, target.y);
        const z = ground + spec.launchHeight,
            vz =
                (targetGround + spec.radius - z + 0.5 * spec.gravity * duration * duration) /
                duration;
        for (let slot = 0; slot < count; slot++)
            sim.unitLobProjectiles.push({
                id: `${source.id}|${sim.tick}|${slot}`,
                side: source.side,
                sourceId: source.id,
                sourceType: source.type,
                x: launchX,
                y: launchY,
                zFP: Math.round(z * FP),
                vxFP: Math.round((dx / duration) * FP),
                vyFP: Math.round((dy / duration) * FP),
                vzFP: Math.round(vz * FP),
                startTick: sim.tick + 1 + slot * gap,
                landedAtTick: null,
                landedAtSubtick: null,
                explodeTick: null,
                grounded: false,
                clearedSource: false,
                damage: Math.max(1, Math.round(attack * spec.explosionDamageScale)),
                spec: { ...spec },
            });
    }
    static registerGround(sim, shot, spec, elapsed) {
        if (shot.landedAtTick !== null) return;
        shot.landedAtTick = sim.tick;
        shot.landedAtSubtick = Math.max(0, Math.min(1000000, Math.round(elapsed * 1000000)));
        shot.explodeTick = sim.tick + sim.msTicks(spec.fuseMs);
        sim.events.push({
            type: 'unitLobLand',
            side: shot.side,
            sourceId: shot.sourceId,
            projectileId: shot.id,
            subtick: shot.landedAtSubtick,
            x: shot.x,
            y: shot.y,
            zFP: shot.zFP,
        });
    }
    static resolveContact(sim, shot, hit, spec, elapsed, bodyVelocities, emit = true) {
        const unit = hit.kind === 'body' && !hit.isBuilding ? sim.unitById.get(hit.id) : null;
        const body = (unit && bodyVelocities.get(unit.id)) || {
            x: hit.bodyVx || 0,
            y: hit.bodyVy || 0,
            z: hit.bodyVz || 0,
        };
        const targetMass = unit ? sim.mass(unit) : Infinity,
            vx = shot.vxFP / FP,
            vy = shot.vyFP / FP,
            vz = shot.vzFP / FP;
        const relative = (vx - body.x) * hit.nx + (vy - body.y) * hit.ny + (vz - body.z) * hit.nz;
        if (relative >= 0) {
            // A body already touching a floor with zero normal velocity is
            // supported, not a separating collision. Quantization can bring
            // it to rest exactly at the contact boundary before this callback.
            if (hit.kind === 'ground' && shot.vzFP === 0 && relative <= 1 / FP) {
                this.registerGround(sim, shot, spec, elapsed);
                shot.grounded = true;
                if (emit)
                    sim.events.push({
                        type: 'unitLobContact',
                        side: shot.side,
                        sourceId: shot.sourceId,
                        sourceType: shot.sourceType,
                        projectileId: shot.id,
                        targetId: null,
                        contactKind: 'ground',
                        x: shot.x,
                        y: shot.y,
                        zFP: shot.zFP,
                    });
                return true;
            }
            return false;
        }
        const impulse =
            (-(1 + spec.restitution) * relative) / (1 / spec.mass + (unit ? 1 / targetMass : 0));
        shot.vxFP = Math.round((vx + (impulse / spec.mass) * hit.nx) * FP);
        shot.vyFP = Math.round((vy + (impulse / spec.mass) * hit.ny) * FP);
        shot.vzFP = Math.round((vz + (impulse / spec.mass) * hit.nz) * FP);
        if (unit) {
            const previous = unit.impactMotion;
            sim.navigation.motion.applyImpulse(
                unit,
                {
                    x: (body.x - (previous?.vxFP || 0) / FP) * targetMass - impulse * hit.nx,
                    y: (body.y - (previous?.vyFP || 0) / FP) * targetMass - impulse * hit.ny,
                    z: (body.z - (previous?.vzFP || 0) / FP) * targetMass - impulse * hit.nz,
                },
                {
                    kind: 'knockback',
                    sourceId: shot.id,
                    originX: shot.x,
                    originY: shot.y,
                    initialHeightFP: Math.max(
                        0,
                        Math.round(
                            ((hit.bodyZ ?? 0) -
                                sim.world.terrain.surfaces.heightAt(unit.x, unit.y)) *
                                FP,
                        ),
                    ),
                },
            );
            // A unit mid-roll or mid-boomerang refuses impulses and keeps the velocity it had.
            const motion = unit.impactMotion;
            bodyVelocities.set(
                unit.id,
                motion ? { x: motion.vxFP / FP, y: motion.vyFP / FP, z: motion.vzFP / FP } : body,
            );
        }
        if (hit.kind === 'ground') {
            this.registerGround(sim, shot, spec, elapsed);
            if (shot.vzFP / FP < spec.settleSpeed) {
                shot.vzFP = 0;
                shot.grounded = true;
            } else shot.grounded = false;
        } else if (shot.vzFP > 0) shot.grounded = false;
        if (emit)
            sim.events.push({
                type: 'unitLobContact',
                side: shot.side,
                sourceId: shot.sourceId,
                sourceType: shot.sourceType,
                projectileId: shot.id,
                targetId: hit.id || null,
                contactKind: hit.kind,
                x: shot.x,
                y: shot.y,
                zFP: shot.zFP,
            });
        return true;
    }
    static resolvePair(
        sim,
        a,
        b,
        hit,
        elapsed,
        restitution = Math.min(a.spec.restitution, b.spec.restitution),
        emit = true,
    ) {
        const av = [a.vxFP / FP, a.vyFP / FP, a.vzFP / FP],
            bv = [b.vxFP / FP, b.vyFP / FP, b.vzFP / FP];
        const normal = [hit.nx, hit.ny, hit.nz],
            relative =
                (av[0] - bv[0]) * normal[0] +
                (av[1] - bv[1]) * normal[1] +
                (av[2] - bv[2]) * normal[2];
        if (relative >= 0) return false;
        const impulse = (-(1 + restitution) * relative) / (1 / a.spec.mass + 1 / b.spec.mass);
        for (const [shot, sign, v] of [
            [a, 1, av],
            [b, -1, bv],
        ]) {
            shot.vxFP = Math.round((v[0] + ((sign * impulse) / shot.spec.mass) * normal[0]) * FP);
            shot.vyFP = Math.round((v[1] + ((sign * impulse) / shot.spec.mass) * normal[1]) * FP);
            shot.vzFP = Math.round((v[2] + ((sign * impulse) / shot.spec.mass) * normal[2]) * FP);
            if (shot.vzFP !== 0) shot.grounded = false;
        }
        if (emit)
            sim.events.push({
                type: 'unitLobPairContact',
                projectileId: a.id,
                otherProjectileId: b.id,
                subtick: Math.round(elapsed * 1000000),
                x: a.x,
                y: a.y,
                zFP: a.zFP,
            });
        return true;
    }
    static explode(sim, shot) {
        const x = shot.x,
            y = shot.y,
            radius = shot.spec.explosionRadius,
            damage = shot.damage;
        sim.events.push({
            type: 'unitLobExplosion',
            side: shot.side,
            sourceId: shot.sourceId,
            sourceType: shot.sourceType,
            projectileId: shot.id,
            x,
            y,
            zFP: shot.zFP,
            subtick: shot.landedAtSubtick,
            radius,
        });
        sim.applyAreaDamage({
            sourceSide: shot.side,
            sourceType: shot.sourceType,
            sourceEntityId: shot.sourceId,
            x,
            y,
            radius,
            damage,
            damageClass: 'normal',
            impactHeightFP: shot.zFP,
            suppressImpactFx: true,
        });
        for (const i of sim.nearbyBuildingIndices(x, y, radius + sim.maxBuildingRadius)) {
            const b = sim.buildings[i];
            if (!b || b.alive === false || b.side === shot.side) continue;
            if (LaunchImpact.distanceToBody(sim, b, x, y, shot.zFP, true).surfaceDistance > radius)
                continue;
            sim.applyDamage(shot.side, shot.sourceType, b, true, damage, shot.sourceId, {
                damageClass: 'normal',
                sourceDamageResolved: true,
                suppressImpactFx: true,
            });
        }
    }
    static prepareProjectiles(sim) {
        const active = [];
        for (const shot of sim.unitLobProjectiles) {
            if (shot.startTick > sim.tick) continue;
            if (shot.startTick === sim.tick)
                sim.events.push({
                    type: 'unitLobLaunch',
                    side: shot.side,
                    sourceId: shot.sourceId,
                    sourceType: shot.sourceType,
                    projectileId: shot.id,
                    x: shot.x,
                    y: shot.y,
                    zFP: shot.zFP,
                });
            const source = sim.unitById.get(shot.sourceId);
            if (
                !source ||
                Math.hypot(shot.x - source.x, shot.y - source.y) >
                    sim.unitRadius(source.type) + shot.spec.radius + 1 / FP
            )
                shot.clearedSource = true;
            active.push(shot);
        }
        return active;
    }
    // Projectile-only scheduling: unit paths are fixed for this tick and unit
    // impulses are integrated by the existing motion solver on the next tick.
    static step(sim) {
        if (!sim.unitLobProjectiles.length) return;
        const shots = this.prepareProjectiles(sim).sort((a, b) =>
            String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0,
        );
        if (!shots.length) return;
        const dt = 1 / sim.tps,
            subdivisions = 4,
            slice = dt / subdivisions,
            previous = this.previous.get(sim) || new Map();
        const ends = new Map(),
            velocities = new Map(),
            feedback = new Set(),
            pairFeedback = new Set();
        for (const unit of sim.units) {
            const start = previous.get(unit.id);
            if (!unit.alive || !start) continue;
            const end = {
                x: unit.x,
                y: unit.y,
                z:
                    sim.world.terrain.surfaces.heightAt(unit.x, unit.y) +
                    (unit.impactMotion?.heightFP || 0) / FP,
            };
            ends.set(unit.id, end);
            velocities.set(unit.id, {
                x: (end.x - start.x) / dt,
                y: (end.y - start.y) / dt,
                z: (end.z - start.z) / dt,
            });
        }
        if (!this.terrainMotions) this.terrainMotions = new WeakMap();
        let terrainMotion = this.terrainMotions.get(sim.world.terrain);
        if (!terrainMotion) {
            terrainMotion = new RallyGamekit.SurfaceMotion(sim.world.terrain.field);
            this.terrainMotions.set(sim.world.terrain, terrainMotion);
        }
        if (!this.pairGrids) this.pairGrids = new WeakMap();
        let grid = this.pairGrids.get(sim.world.terrain);
        if (!grid) {
            grid = new RallyGamekit.BoundsGrid({
                cellSize: sim.unitSpatial.cellSize,
                width: sim.world.width,
                height: sim.world.height,
            });
            this.pairGrids.set(sim.world.terrain, grid);
        }
        if (!this.localMetrics) this.localMetrics = new WeakMap();
        const metrics = {
            tick: sim.tick,
            fallbacks: 0,
            pairFallbacks: 0,
            maxStoppedSpeed: 0,
            sweeps: 0,
            pairChecks: 0,
            events: 0,
        };
        this.localMetrics.set(sim, metrics);
        const less = (a, b) =>
            a.at < b.at - 1e-9 || (Math.abs(a.at - b.at) <= 1e-9 && a.key < b.key);
        for (let sub = 0; sub < subdivisions; sub++) {
            const states = shots.map((shot) => ({
                shot,
                time: 0,
                rev: 0,
                processed: new Set(),
                constraints: new Map(),
                contacts: 0,
                frozen: false,
            }));
            const heap = [],
                pairCounts = new Map(),
                blockedPairs = new Map(),
                candidates = [];
            const push = (e) => {
                let i = heap.length;
                heap.push(e);
                while (i > 0) {
                    let p = (i - 1) >> 1;
                    if (!less(heap[i], heap[p])) break;
                    [heap[i], heap[p]] = [heap[p], heap[i]];
                    i = p;
                }
            };
            const pop = () => {
                const first = heap[0],
                    last = heap.pop();
                if (heap.length) {
                    heap[0] = last;
                    let i = 0;
                    while (true) {
                        let l = i * 2 + 1,
                            r = l + 1,
                            b = i;
                        if (l < heap.length && less(heap[l], heap[b])) b = l;
                        if (r < heap.length && less(heap[r], heap[b])) b = r;
                        if (b === i) break;
                        [heap[i], heap[b]] = [heap[b], heap[i]];
                        i = b;
                    }
                }
                return first;
            };
            const motionAt = (fraction) => (unit) => {
                const start = previous.get(unit.id),
                    end = ends.get(unit.id);
                if (!start || !end) return null;
                return {
                    x: start.x + (end.x - start.x) * fraction,
                    y: start.y + (end.y - start.y) * fraction,
                    z: start.z + (end.z - start.z) * fraction,
                    vx: (end.x - start.x) / dt,
                    vy: (end.y - start.y) / dt,
                    vz: (end.z - start.z) / dt,
                };
            };
            const freeze = (state) => {
                if (state.frozen) return;
                state.frozen = true;
                metrics.fallbacks++;
                metrics.maxStoppedSpeed = Math.max(
                    metrics.maxStoppedSpeed,
                    Math.hypot(state.shot.vxFP, state.shot.vyFP) / FP,
                );
                state.shot.vxFP = state.shot.vyFP = 0;
            };
            const enqueueWorld = (i) => {
                const st = states[i],
                    shot = st.shot,
                    left = slice - st.time;
                if (shot.expired || left <= 1e-9) return;
                const fraction = (sub * slice + st.time) / dt,
                    source = sim.unitById.get(shot.sourceId);
                for (const [key, c] of st.constraints) {
                    const start = previous.get(c.id),
                        end = ends.get(c.id);
                    const tx = start && end ? start.x + (end.x - start.x) * fraction : c.tx;
                    const ty = start && end ? start.y + (end.y - start.y) * fraction : c.ty;
                    const tz = start && end ? start.z + (end.z - start.z) * fraction : c.tz;
                    const separation =
                        (shot.x - c.sx - (tx - c.tx)) * c.nx +
                        (shot.y - c.sy - (ty - c.ty)) * c.ny +
                        (shot.zFP / FP - c.sz - (tz - c.tz)) * c.nz;
                    if (separation > 2 / FP) {
                        st.constraints.delete(key);
                        st.processed.delete(key);
                    }
                }
                if (
                    !source ||
                    !source.alive ||
                    Math.hypot(shot.x - source.x, shot.y - source.y) >
                        sim.unitRadius(source.type) + shot.spec.radius + 1 / FP
                )
                    shot.clearedSource = true;
                const spec = this.physicsSpec(shot);
                metrics.sweeps++;
                let hit = UnitLobPhysics.sweep(
                    sim,
                    shot,
                    left,
                    fraction,
                    previous,
                    spec,
                    motionAt(fraction),
                    0,
                    false,
                    st.processed,
                );
                {
                    // Terrain contacts are keyed by their integer contact key; other contacts use strings.
                    let wall = terrainMotion.cast(
                        shot.x,
                        shot.y,
                        (shot.vxFP / FP) * left,
                        (shot.vyFP / FP) * left,
                        shot.spec.radius,
                        null,
                        WALL_HIT,
                    )
                        ? WALL_HIT
                        : null;
                    const eligibleWall = (candidate) => {
                        if (!candidate || st.processed.has(candidate.key)) return false;
                        const point = UnitLobPhysics.position(
                            shot,
                            left,
                            candidate.t,
                            spec.gravity,
                        );
                        const floor = sim.world.terrain.surfaces.heightAt(point.x, point.y);
                        return point.z - shot.spec.radius <= floor + shot.spec.radius;
                    };
                    if (wall && !eligibleWall(wall)) {
                        // The first 2D wall can be above or already processed.
                        // Check the other indexed edges for a later low contact.
                        wall = null;
                        const dx = (shot.vxFP / FP) * left,
                            dy = (shot.vyFP / FP) * left,
                            field = sim.world.terrain.field;
                        const polygons = field.polygons.query(
                                shot.x,
                                shot.y,
                                shot.x + dx,
                                shot.y + dy,
                                shot.spec.radius,
                            ),
                            found = field.polygons.found;
                        for (let k = 0; k < polygons.length; k++) {
                            const points = polygons[k].points,
                                base = contactKey(CONTACT_POLYGON, found[k]);
                            for (let edge = 0; edge < points.length; edge++) {
                                const a = points[edge],
                                    b = points[(edge + 1) % points.length];
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
                                        shot.spec.radius,
                                        base + edge * 4,
                                        field.quantum,
                                        EDGE_HIT,
                                    ) &&
                                    eligibleWall(EDGE_HIT) &&
                                    (!wall ||
                                        EDGE_HIT.t < wall.t - 1e-9 ||
                                        (Math.abs(EDGE_HIT.t - wall.t) <= 1e-9 &&
                                            EDGE_HIT.key < wall.key))
                                ) {
                                    WALL_HIT.t = EDGE_HIT.t;
                                    WALL_HIT.nx = EDGE_HIT.nx;
                                    WALL_HIT.ny = EDGE_HIT.ny;
                                    WALL_HIT.key = EDGE_HIT.key;
                                    wall = WALL_HIT;
                                }
                            }
                        }
                    }
                    if (eligibleWall(wall) && (!hit || wall.t < hit.t))
                        hit = {
                            t: wall.t,
                            nx: wall.nx,
                            ny: wall.ny,
                            key: wall.key,
                            kind: 'wall',
                            nz: 0,
                        };
                }
                let at = hit ? st.time + Math.max(0, Math.min(1, hit.t)) * left : slice,
                    kind = hit ? 'contact' : 'end';
                if (shot.explodeTick !== null && shot.explodeTick <= sim.tick) {
                    const tickAt =
                        shot.explodeTick < sim.tick ? 0 : (shot.landedAtSubtick / 1000000) * dt;
                    const fuse = tickAt - sub * slice;
                    if (fuse <= at + 1e-9) {
                        at = Math.max(st.time, fuse);
                        kind = 'fuse';
                    }
                }
                if (kind !== 'end')
                    push({
                        at,
                        key: shot.id + '|' + (kind === 'fuse' ? 'fuse' : hit.key),
                        kind,
                        i,
                        rev: st.rev,
                        hit,
                    });
            };
            const rebuildGrid = () => {
                grid.clear();
                for (let i = 0; i < states.length; i++) {
                    const st = states[i],
                        shot = st.shot;
                    if (shot.expired || !shot.grounded) continue;
                    const left = slice - st.time,
                        x = shot.x + (shot.vxFP / FP) * left,
                        y = shot.y + (shot.vyFP / FP) * left,
                        r = shot.spec.radius;
                    grid.insert(
                        i,
                        Math.min(shot.x, x) - r,
                        Math.min(shot.y, y) - r,
                        Math.max(shot.x, x) + r,
                        Math.max(shot.y, y) + r,
                    );
                }
            };
            const enqueuePairs = (i, initial = false) => {
                const a = states[i],
                    sa = a.shot;
                if (sa.expired || !sa.grounded) return;
                grid.queryOverlaps(i, candidates, -1, -1);
                for (const j of candidates) {
                    if (j === i || (initial && j < i)) continue;
                    let ai = Math.min(i, j),
                        bi = Math.max(i, j),
                        A = states[ai],
                        B = states[bi],
                        p = A.shot,
                        q = B.shot;
                    if (
                        p.expired ||
                        q.expired ||
                        !p.grounded ||
                        !q.grounded ||
                        (A.frozen && B.frozen) ||
                        Math.abs(p.zFP - q.zFP) > (p.spec.radius + q.spec.radius) * FP
                    )
                        continue;
                    const base = Math.max(A.time, B.time),
                        left = slice - base,
                        key = p.id + '|' + q.id;
                    if (left <= 1e-9 || blockedPairs.get(key) === A.rev + ':' + B.rev) continue;
                    const ax = p.x + (p.vxFP / FP) * (base - A.time),
                        ay = p.y + (p.vyFP / FP) * (base - A.time),
                        bx = q.x + (q.vxFP / FP) * (base - B.time),
                        by = q.y + (q.vyFP / FP) * (base - B.time);
                    metrics.pairChecks++;
                    if (
                        SweptCircleContact.cast(
                            ax - bx,
                            ay - by,
                            ((p.vxFP - q.vxFP) / FP) * left,
                            ((p.vyFP - q.vyFP) / FP) * left,
                            p.spec.radius + q.spec.radius,
                            PAIR_POLICY,
                            PAIR_HIT,
                        )
                    )
                        push({
                            at: base + PAIR_HIT.t * left,
                            key: 'pair|' + p.id + '|' + q.id,
                            kind: 'pair',
                            i: ai,
                            j: bi,
                            rev: A.rev,
                            revB: B.rev,
                        });
                }
            };
            for (let i = 0; i < states.length; i++) enqueueWorld(i);
            rebuildGrid();
            for (let i = 0; i < states.length; i++) enqueuePairs(i, true);
            while (heap.length) {
                const e = pop(),
                    a = states[e.i],
                    shot = a.shot;
                if (shot.expired || e.rev !== a.rev || e.at < a.time - 1e-9) continue;
                let b = e.kind === 'pair' ? states[e.j] : null;
                if (b && (b.shot.expired || e.revB !== b.rev || e.at < b.time - 1e-9)) continue;
                this.advanceProjectile(shot, Math.max(0, e.at - a.time));
                a.time = e.at;
                if (b) {
                    this.advanceProjectile(b.shot, Math.max(0, e.at - b.time));
                    b.time = e.at;
                }
                metrics.events++;
                if (e.kind === 'fuse') {
                    this.explode(sim, shot);
                    shot.expired = true;
                    a.rev++;
                    continue;
                }
                if (e.kind === 'contact') {
                    const hit = e.hit,
                        key = shot.id + '|' + hit.key;
                    a.processed.add(hit.key);
                    const target = motionAt((sub * slice + e.at) / dt)(
                        sim.unitById.get(hit.id) || {},
                    );
                    a.constraints.set(hit.key, {
                        nx: hit.nx,
                        ny: hit.ny,
                        nz: hit.nz,
                        id: hit.id,
                        sx: shot.x,
                        sy: shot.y,
                        sz: shot.zFP / FP,
                        tx: target?.x || 0,
                        ty: target?.y || 0,
                        tz: target?.z || 0,
                    });
                    const applied = this.resolveContact(
                        sim,
                        shot,
                        hit,
                        this.physicsSpec(shot),
                        (sub * slice + e.at) / dt,
                        velocities,
                        !feedback.has(key),
                    );
                    if (applied) {
                        feedback.add(key);
                        a.contacts++;
                        let vx = shot.vxFP / FP,
                            vy = shot.vyFP / FP,
                            vz = shot.vzFP / FP;
                        for (let pass = 0; pass < 4; pass++)
                            for (const c of a.constraints.values()) {
                                const v = velocities.get(c.id) || { x: 0, y: 0, z: 0 },
                                    n = (vx - v.x) * c.nx + (vy - v.y) * c.ny + (vz - v.z) * c.nz;
                                if (n < 0) {
                                    vx -= n * c.nx;
                                    vy -= n * c.ny;
                                    vz -= n * c.nz;
                                }
                            }
                        shot.vxFP = Math.round(vx * FP);
                        shot.vyFP = Math.round(vy * FP);
                        shot.vzFP = Math.round(vz * FP);
                        shot.x = Math.round((shot.x + hit.nx / FP) * FP) / FP;
                        shot.y = Math.round((shot.y + hit.ny / FP) * FP) / FP;
                        shot.zFP += Math.round(hit.nz);
                        if (shot.grounded)
                            shot.zFP = Math.max(
                                shot.zFP,
                                Math.round(
                                    (sim.world.terrain.surfaces.heightAt(shot.x, shot.y) +
                                        shot.spec.radius) *
                                        FP,
                                ),
                            );
                    }
                    if (a.contacts >= 8) freeze(a);
                    if (a.frozen) shot.vxFP = shot.vyFP = 0;
                    a.rev++;
                    enqueueWorld(e.i);
                    rebuildGrid();
                    enqueuePairs(e.i);
                } else {
                    const other = b.shot,
                        dx = shot.x - other.x,
                        dy = shot.y - other.y,
                        d = Math.hypot(dx, dy),
                        radius = shot.spec.radius + other.spec.radius,
                        key = shot.id + '|' + other.id;
                    let pairApplied = false;
                    if (d <= radius + 2 / FP) {
                        const hit = { nx: d > 1e-9 ? dx / d : 1, ny: d > 1e-9 ? dy / d : 0, nz: 0 },
                            count = (pairCounts.get(key) || 0) + 1;
                        pairCounts.set(key, count);
                        const specA = shot.spec,
                            specB = other.spec;
                        if (a.frozen) shot.spec = { ...specA, mass: Infinity };
                        if (b.frozen) other.spec = { ...specB, mass: Infinity };
                        let applied;
                        try {
                            applied = this.resolvePair(
                                sim,
                                shot,
                                other,
                                hit,
                                (sub * slice + e.at) / dt,
                                count >= 4 ? 0 : Math.min(specA.restitution, specB.restitution),
                                !pairFeedback.has(key),
                            );
                        } finally {
                            shot.spec = specA;
                            other.spec = specB;
                        }
                        if (applied) {
                            pairApplied = true;
                            pairFeedback.add(key);
                            shot.x = Math.round((shot.x + hit.nx / FP) * FP) / FP;
                            shot.y = Math.round((shot.y + hit.ny / FP) * FP) / FP;
                            other.x = Math.round((other.x - hit.nx / FP) * FP) / FP;
                            other.y = Math.round((other.y - hit.ny / FP) * FP) / FP;
                            if (count > 4) {
                                metrics.pairFallbacks++;
                                freeze(a);
                                freeze(b);
                            }
                        }
                    }
                    if (a.frozen) shot.vxFP = shot.vyFP = 0;
                    if (b.frozen) other.vxFP = other.vyFP = 0;
                    a.rev++;
                    b.rev++;
                    if (!pairApplied) blockedPairs.set(key, a.rev + ':' + b.rev);
                    enqueueWorld(e.i);
                    enqueueWorld(e.j);
                    rebuildGrid();
                    enqueuePairs(e.i);
                    enqueuePairs(e.j);
                }
            }
            for (const st of states)
                if (!st.shot.expired) this.advanceProjectile(st.shot, Math.max(0, slice - st.time));
            // Local 2D separation handles touching piles after individual sweeps.
            for (let pass = 0; pass < 4; pass++) {
                grid.clear();
                for (let i = 0; i < shots.length; i++) {
                    const shot = shots[i];
                    if (shot.expired || !shot.grounded) continue;
                    const r = shot.spec.radius;
                    grid.insert(i, shot.x - r, shot.y - r, shot.x + r, shot.y + r);
                }
                let overlaps = 0;
                for (let i = 0; i < shots.length; i++) {
                    const a = shots[i];
                    if (a.expired || !a.grounded) continue;
                    grid.queryOverlaps(i, candidates, -1, i);
                    for (const j of candidates) {
                        const b = shots[j];
                        if (
                            b.expired ||
                            !b.grounded ||
                            Math.abs(a.zFP - b.zFP) > (a.spec.radius + b.spec.radius) * FP
                        )
                            continue;
                        const dx = a.x - b.x,
                            dy = a.y - b.y,
                            distance = Math.hypot(dx, dy),
                            overlap = a.spec.radius + b.spec.radius - distance;
                        if (overlap <= 1 / FP) continue;
                        overlaps++;
                        const nx = distance > 1e-9 ? dx / distance : 1,
                            ny = distance > 1e-9 ? dy / distance : 0;
                        const inverseA = 1 / a.spec.mass,
                            inverseB = 1 / b.spec.mass,
                            amount = (overlap + 1 / FP) / (inverseA + inverseB);
                        for (let side = 0; side < 2; side++) {
                            // shots are sorted by id, so a shot's index is a steady integer tieKey.
                            const index = side === 0 ? i : j,
                                shot = shots[index],
                                sign = side === 0 ? 1 : -1,
                                inverse = side === 0 ? inverseA : inverseB;
                            const x = shot.x + sign * nx * amount * inverse,
                                y = shot.y + sign * ny * amount * inverse;
                            const resolved = terrainMotion.solve(
                                shot.x,
                                shot.y,
                                x,
                                y,
                                shot.spec.radius,
                                null,
                                'project',
                                index,
                                MOTION,
                            );
                            shot.x = Math.round(resolved.x * FP) / FP;
                            shot.y = Math.round(resolved.y * FP) / FP;
                        }
                        const key = a.id + '|' + b.id;
                        if (
                            this.resolvePair(
                                sim,
                                a,
                                b,
                                { nx, ny, nz: 0 },
                                (sub + 1) / subdivisions,
                                Math.min(a.spec.restitution, b.spec.restitution),
                                !pairFeedback.has(key),
                            )
                        )
                            pairFeedback.add(key);
                    }
                }
                for (let index = 0; index < shots.length; index++) {
                    const shot = shots[index];
                    if (
                        shot.expired ||
                        !shot.grounded ||
                        terrainMotion.clear(shot.x, shot.y, shot.x, shot.y, shot.spec.radius)
                    )
                        continue;
                    const resolved = terrainMotion.solve(
                        shot.x,
                        shot.y,
                        shot.x,
                        shot.y,
                        shot.spec.radius,
                        null,
                        'project',
                        index,
                        MOTION,
                    );
                    if (resolved.valid === false) continue;
                    shot.x = Math.round(resolved.x * FP) / FP;
                    shot.y = Math.round(resolved.y * FP) / FP;
                    const surfaces = terrainMotion.contacts(
                        shot.x,
                        shot.y,
                        shot.spec.radius,
                        null,
                        SURFACE_CONTACTS,
                    );
                    for (let k = 0; k < surfaces.count; k++) {
                        const surface = surfaces.items[k];
                        const n = (shot.vxFP / FP) * surface.nx + (shot.vyFP / FP) * surface.ny;
                        if (n < 0) {
                            shot.vxFP = Math.round((shot.vxFP / FP - n * surface.nx) * FP);
                            shot.vyFP = Math.round((shot.vyFP / FP - n * surface.ny) * FP);
                        }
                    }
                    overlaps++;
                }
                if (!overlaps) break;
            }
        }
        this.finishProjectiles(sim, shots);
    }
    static advanceProjectile(shot, dt) {
        const gravity = shot.grounded ? 0 : shot.spec.gravity;
        const quantum = 10000;
        const advance = (value, remainder) => {
            const whole = Math.trunc(value + (remainder || 0) / quantum);
            return [whole, Math.round((value + (remainder || 0) / quantum - whole) * quantum)];
        };
        let dx, dy, dz, dv;
        [dx, shot.remainderX] = advance(shot.vxFP * dt, shot.remainderX);
        [dy, shot.remainderY] = advance(shot.vyFP * dt, shot.remainderY);
        [dz, shot.remainderZ] = advance(
            shot.vzFP * dt - (gravity * FP * dt * dt) / 2,
            shot.remainderZ,
        );
        [dv, shot.remainderVz] = advance(-gravity * FP * dt, shot.remainderVz);
        shot.x = Math.round(shot.x * FP + dx) / FP;
        shot.y = Math.round(shot.y * FP + dy) / FP;
        shot.zFP += dz;
        shot.vzFP += dv;
    }
    static finishProjectiles(sim, active) {
        for (const shot of active) {
            if (shot.expired || !shot.grounded) continue;
            const floor = sim.world.terrain.surfaces.heightAt(shot.x, shot.y) + shot.spec.radius;
            if (shot.zFP / FP > floor + 1 / FP) shot.grounded = false;
            else {
                shot.zFP = Math.round(floor * FP);
                const drag = Math.max(0, 1 - shot.spec.groundFriction / sim.tps);
                shot.vxFP = Math.round(shot.vxFP * drag);
                shot.vyFP = Math.round(shot.vyFP * drag);
            }
        }
        sim.unitLobProjectiles = sim.unitLobProjectiles.filter((shot) => !shot.expired);
    }
    // Only bypass the unit solver if the entire current tick is provably free of
    // every event that can couple a projectile to units, terrain or another projectile.
}
