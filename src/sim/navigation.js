// Goals, interaction geometry, surface contacts and the navigation front door.
import { RangeUtil } from '../core/game-rules.js';
import { NavigationTopology } from './entities.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UNIT_RUNTIME_GEOMETRY, UnitDefinition } from '../definitions/units.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { COLLISION_RADIUS_SCALE, COLLISION_NORMAL } from '../definitions/world-rules.js';
import { GoalFields } from './navigation-field.js';
import { RallyGamekit } from '../core/gamekit.js';
const { ObstacleField, SurfaceMotion, SweptCircleContact, SurfaceContactGeometry } = RallyGamekit;
import { FP } from '../core/config.js';
import { LaunchImpactRules } from '../definitions/launch-impact-rules.js';
import { UnitLeapAttack } from './unit-leap-attack.js';
import { HeroRollAttack } from './hero-roll-attack.js';
import { FruitHeroAttack } from './fruit-hero-attack.js';

// Interaction geometry owns the legal arrival set; the distance field only leads units to it.
// Goal regions are continuous (discs/annuli), not a fixed number of radial probes.
class NavigationGoal {
    static EPS = 1e-7;
    static cross(a, b, c) {
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    static ARRIVAL_INSET = 5 / FP;
    constructor(x, y, radius = 0, innerRadius = 0, terrainLine = false, project = false) {
        if (
            ![x, y, radius, innerRadius].every(Number.isFinite) ||
            radius < 0 ||
            innerRadius < 0 ||
            innerRadius > radius
        )
            throw new Error('Invalid navigation goal');
        this.x = x;
        this.y = y;
        this.radius = radius;
        this.innerRadius = innerRadius;
        this.terrainLine = terrainLine;
        this.project = project;
        this.key = [x, y, radius, innerRadius, terrainLine ? 1 : 0, project ? 1 : 0].join(':');
    }
    static point(x, y, project = true) {
        return new NavigationGoal(x, y, 0, 0, false, project);
    }
    static range(x, y, radius, innerRadius = 0, terrainLine = false) {
        // Five fixed-point quanta prevent rounding a stopped unit outside gameplay
        // range. The gameplay reach itself is not changed.
        const inset = Math.min(this.ARRIVAL_INSET, Math.max(0, (radius - innerRadius) / 4));
        return new NavigationGoal(
            x,
            y,
            Math.max(0, radius - inset),
            innerRadius > 0 ? innerRadius + inset : 0,
            terrainLine,
            false,
        );
    }
    contains(x, y) {
        const d = Math.hypot(x - this.x, y - this.y);
        return d <= this.radius + NavigationGoal.EPS && d >= this.innerRadius - NavigationGoal.EPS;
    }
    interior(x, y) {
        const dx = x - this.x,
            dy = y - this.y,
            d = Math.hypot(dx, dy) || 1,
            r = this.innerRadius > 0 ? (this.innerRadius + this.radius) / 2 : 0;
        return { x: this.x + ((dx || (!dy ? 1 : 0)) / d) * r, y: this.y + (dy / d) * r };
    }
    static polygonContains(points, x, y) {
        if (points.length < 3) return false;
        for (let i = 0; i < points.length; i++)
            if (
                NavigationGoal.cross(points[i], points[(i + 1) % points.length], { x, y }) <
                -this.EPS
            )
                return false;
        return true;
    }
    static clipPolygon(points, clip) {
        let out = points;
        for (let i = 0; i < clip.length && out.length; i++) {
            const a = clip[i],
                b = clip[(i + 1) % clip.length],
                input = out;
            out = [];
            let p = input[input.length - 1],
                pd = NavigationGoal.cross(a, b, p);
            for (const q of input) {
                const qd = NavigationGoal.cross(a, b, q);
                if (pd >= 0 !== qd >= 0) {
                    const t = pd / (pd - qd);
                    out.push({ x: p.x + (q.x - p.x) * t, y: p.y + (q.y - p.y) * t });
                }
                if (qd >= 0) out.push(q);
                p = q;
                pd = qd;
            }
        }
        return out;
    }
    segmentIntervals(a, b) {
        const dx = b.x - a.x,
            dy = b.y - a.y,
            fx = a.x - this.x,
            fy = a.y - this.y,
            A = dx * dx + dy * dy;
        if (A < 1e-16) return this.contains(a.x, a.y) ? [[0, 1]] : [];
        const B = fx * dx + fy * dy,
            C = fx * fx + fy * fy,
            disc = B * B - A * (C - this.radius * this.radius);
        if (disc < -NavigationGoal.EPS) return [];
        const root = Math.sqrt(Math.max(0, disc)),
            lo = Math.max(0, (-B - root) / A),
            hi = Math.min(1, (-B + root) / A);
        if (lo > hi + NavigationGoal.EPS) return [];
        if (this.innerRadius <= 0) return [[lo, hi]];
        const innerDisc = B * B - A * (C - this.innerRadius * this.innerRadius);
        if (innerDisc <= 0) return [[lo, hi]];
        const ir = Math.sqrt(innerDisc),
            il = (-B - ir) / A,
            ih = (-B + ir) / A,
            out = [];
        if (lo <= Math.min(hi, il)) out.push([lo, Math.min(hi, il)]);
        if (Math.max(lo, ih) <= hi) out.push([Math.max(lo, ih), hi]);
        return out;
    }
    closest(x, y, polygon = null) {
        let best = null;
        const eps = NavigationGoal.EPS;
        const add = (px, py) => {
            if (
                !this.contains(px, py) ||
                (polygon && !NavigationGoal.polygonContains(polygon, px, py))
            )
                return;
            const d2 = (px - x) ** 2 + (py - y) ** 2;
            if (
                !best ||
                d2 < best.d2 - eps ||
                (Math.abs(d2 - best.d2) <= eps &&
                    (px < best.x - eps || (Math.abs(px - best.x) <= eps && py < best.y)))
            )
                best = { x: px, y: py, d2 };
        };
        if (this.radius === 0) {
            add(this.x, this.y);
            return best;
        }
        const dx = x - this.x,
            dy = y - this.y,
            len = Math.hypot(dx, dy),
            ux = len > eps ? dx / len : 1,
            uy = len > eps ? dy / len : 0;
        const radial = RangeUtil.clamp(len, this.innerRadius, this.radius);
        add(this.x + ux * radial, this.y + uy * radial);
        if (polygon)
            for (let i = 0; i < polygon.length; i++) {
                const a = polygon[i],
                    b = polygon[(i + 1) % polygon.length],
                    ex = b.x - a.x,
                    ey = b.y - a.y,
                    den = ex * ex + ey * ey;
                for (const [lo, hi] of this.segmentIntervals(a, b)) {
                    const t = RangeUtil.clamp(
                        den ? ((x - a.x) * ex + (y - a.y) * ey) / den : 0,
                        lo,
                        hi,
                    );
                    add(a.x + ex * t, a.y + ey * t);
                }
            }
        return best;
    }
}
class InteractionGeometry {
    static unitRadius(type) {
        return UNIT_RUNTIME_GEOMETRY[type]?.radius || Math.max(1, 10 * COLLISION_RADIUS_SCALE);
    }
    static buildingClearance(source, target) {
        const st = typeof source === 'string' ? source : source?.type,
            tt = typeof target === 'string' ? target : target?.type;
        return this.unitRadius(st) + (BuildingDefinition.get(tt)?.size || 35) + NAV_BUILDING_MARGIN;
    }
    static contact(source, target) {
        const st = typeof source === 'string' ? source : source?.type,
            tt = typeof target === 'string' ? target : target?.type,
            building = BuildingDefinition.get(tt);
        if (building)
            return (
                (((UnitDefinition.get(st) || {}).size || 10) + (building.size || 30)) *
                COLLISION_RADIUS_SCALE
            );
        return this.unitRadius(st) + this.unitRadius(tt);
    }
    static requiresTerrainLine(source, kind, extra = 0) {
        const st = typeof source === 'string' ? source : source?.type,
            d = UnitDefinition.get(st) || {};
        return (
            kind === 'construction' ||
            (kind === 'attack' &&
                !d.projectile &&
                Number(extra) <= 100 &&
                d.requiresContactTerrain === true)
        );
    }
    static reach(source, target, kind, extra = 0) {
        if (kind === 'building-clearance') return this.buildingClearance(source, target);
        if (kind === 'combat-contact') return this.contact(source, target);
        // Construction reaches the physical building envelope with only its
        // configured tool tolerance; combat contact scaling stays attack-only.
        if (kind === 'construction')
            return this.buildingClearance(source, target) + Math.max(0, Number(extra) || 0);
        if (kind === 'attack') {
            const nominal = this.contact(source, target) + Math.max(0, Number(extra) || 0);
            return BuildingDefinition.get(target?.type)
                ? Math.max(nominal, this.buildingClearance(source, target))
                : nominal;
        }
        return Math.max(0, Number(extra) || 0);
    }
    static region(source, target, kind, extra = 0, minRange = null, inset = false) {
        let inner = 0;
        if (kind === 'attack') {
            const minimum = minRange ?? UnitDefinition.get(source.type)?.minRange ?? 0;
            if (minimum > 0) inner = this.contact(source, target) + minimum;
        }
        const outer = this.reach(source, target, kind, extra),
            terrainLine = this.requiresTerrainLine(source, kind, extra);
        return inset
            ? NavigationGoal.range(target.x, target.y, outer, inner, terrainLine)
            : new NavigationGoal(target.x, target.y, outer, inner, terrainLine);
    }
    static goal(source, target, kind, extra = 0, minRange = null) {
        // Workers approach the physical building envelope. Their body-charge reach
        // is a contact allowance, not the stopping boundary: crowd separation can
        // otherwise keep every worker just outside the work region forever.
        if (kind === 'construction')
            return NavigationGoal.range(
                target.x,
                target.y,
                this.buildingClearance(source, target) + NavigationGoal.ARRIVAL_INSET,
                0,
                true,
            );
        return this.region(source, target, kind, extra, minRange, true);
    }
}

// Local contacts share one solver; the distance field only chooses where to head.
// A grain's own motion record: checkpoints, fixed-point commit and the unit's radius sit around the shared contact solver.
class UnitMotion {
    static isGrounded(unit) {
        const motion = unit.impactMotion;
        return !motion || (motion.heightFP <= 0 && motion.vzFP <= 0);
    }

    constructor(navigation) {
        this.navigation = navigation;
        this.surface = new SurfaceMotion(navigation.field, { sync: () => navigation.sync() });
    }
    beginStep() {
        this.surface.forgetAll();
        for (const u of this.navigation.sim.units || []) this.remember(u, false);
    }
    remember(u, verified = true) {
        this.surface.remember(u, u.fx / FP, u.fy / FP, verified, null);
    }
    commit(u, p) {
        u.fx = Math.round(p.x * FP);
        u.fy = Math.round(p.y * FP);
        u.x = u.fx / FP;
        u.y = u.fy / FP;
        this.remember(u, p.valid !== false);
        this.navigation.sim.syncUnitSpatial(u);
        return p;
    }
    move(u, tx, ty, mode = 'steer') {
        return this.commit(
            u,
            this.surface.solve(
                u.x,
                u.y,
                tx,
                ty,
                this.navigation.sim.unitRadius(u.type),
                null,
                mode,
                String(u.id),
            ),
        );
    }
    applyImpulse(
        u,
        impulse,
        {
            kind = 'knockback',
            sourceId = null,
            originX = u.x,
            originY = u.y,
            initialHeightFP = 0,
        } = {},
    ) {
        // An active roll keeps its committed path through nonlethal hits.
        if (u.heroRoll?.phase === 'roll' || FruitHeroAttack.blocksMovement(u)) return;
        const sim = this.navigation.sim,
            mass = sim.mass(u);
        let m = u.impactMotion;
        if (!m)
            m = u.impactMotion = {
                kind,
                startTick: sim.tick,
                endTick: sim.tick,
                recoverUntilTick: sim.tick,
                heightFP: Math.max(0, Math.round(initialHeightFP)),
                vzFP: 0,
                vxFP: 0,
                vyFP: 0,
                remainderX: 0,
                remainderY: 0,
                remainderZ: 0,
                originX,
                originY,
                sourceId,
            };
        m.vxFP += Math.round(((Number(impulse.x) || 0) / mass) * FP);
        m.vyFP += Math.round(((Number(impulse.y) || 0) / mass) * FP);
        m.vzFP += Math.round(((Number(impulse.z) || 0) / mass) * FP);
        const flightSeconds =
            (m.vzFP / FP +
                Math.sqrt((m.vzFP / FP) ** 2 + (2 * LaunchImpactRules.gravity * m.heightFP) / FP)) /
            LaunchImpactRules.gravity;
        m.kind = kind;
        m.sourceId = sourceId;
        m.originX = originX;
        m.originY = originY;
        m.startTick = sim.tick;
        m.endTick = sim.tick + sim.msTicks(Math.max(250, Math.round(flightSeconds * 1000)));
        m.recoverUntilTick = m.endTick + sim.msTicks(LaunchImpactRules.recoveryMs);
        if (u.heroRoll) HeroRollAttack.cancel(u);
        if (!UnitMotion.isGrounded(u)) {
            u.combat.cancelWindup();
            u.combat.attackArcTargetId = null;
            u.combat.attackArcUntilTick = 0;
        }
        return m;
    }
    removeInwardVelocity(m, nx, ny) {
        const inward = m.vxFP * nx + m.vyFP * ny;
        if (inward >= 0) return;
        const factor = 1 + LaunchImpactRules.restitution;
        m.vxFP = Math.round(m.vxFP - factor * inward * nx);
        m.vyFP = Math.round(m.vyFP - factor * inward * ny);
        // Rounding may leave a sub-quantum inward component. Round conservatively along the dominant normal axis.
        const residual = m.vxFP * nx + m.vyFP * ny;
        if (residual < 0) {
            if (Math.abs(nx) >= Math.abs(ny))
                m.vxFP += Math.sign(nx) * Math.ceil(-residual / Math.abs(nx));
            else m.vyFP += Math.sign(ny) * Math.ceil(-residual / Math.abs(ny));
        }
        const remainder = (m.remainderX || 0) * nx + (m.remainderY || 0) * ny;
        if (remainder < 0) {
            m.remainderX = Math.round((m.remainderX || 0) - remainder * nx);
            m.remainderY = Math.round((m.remainderY || 0) - remainder * ny);
        }
    }
    integrateImpulse(u) {
        const sim = this.navigation.sim,
            m = u.impactMotion;
        if (!m) return;
        const flying = m.heightFP > 0 || m.vzFP > 0;
        if (flying) {
            const numerator = m.vzFP + (m.remainderZ || 0),
                step = Math.trunc(numerator / sim.tps);
            m.remainderZ = numerator - step * sim.tps;
            m.heightFP = Math.max(0, m.heightFP + step);
            m.vzFP -= Math.round((LaunchImpactRules.gravity * FP) / sim.tps);
            if (m.heightFP === 0 && m.vzFP < 0) {
                m.vzFP = 0;
                m.remainderZ = 0;
                m.endTick = sim.tick;
                m.recoverUntilTick = sim.tick + sim.msTicks(LaunchImpactRules.recoveryMs);
            }
        }
        if (m.heightFP === 0 && m.vzFP < 0) {
            m.vzFP = 0;
            m.remainderZ = 0;
        }
    }
    solveImpulseStep(startX, startY) {
        const sim = this.navigation.sim,
            units = sim.units,
            n = units.length;
        if (!units.some((u) => u.impactMotion)) return;
        this.solvedImpulseTick = sim.tick;
        if (!this.impulseFrame || this.impulseFrame.capacity < n) {
            const capacity = Math.max(n, this.impulseFrame?.capacity * 2 || 64);
            this.impulseFrame = {
                capacity,
                vx: new Float64Array(capacity),
                vy: new Float64Array(capacity),
                rx: new Float64Array(capacity),
                ry: new Float64Array(capacity),
            };
        }
        const { vx, vy, rx: remaindersX, ry: remaindersY } = this.impulseFrame,
            dt = 1 / sim.tps;
        remaindersX.fill(0, 0, n);
        remaindersY.fill(0, 0, n);
        this.navigation.sync();
        for (let i = 0; i < n; i++) {
            const u = units[i],
                m = u.impactMotion,
                sx = i < startX.length ? startX[i] : u.fx,
                sy = i < startY.length ? startY[i] : u.fy;
            vx[i] = (u.fx - sx) / FP / dt + (m?.vxFP || 0) / FP;
            vy[i] = (u.fy - sy) / FP / dt + (m?.vyFP || 0) / FP;
            u.fx = sx;
            u.fy = sy;
            u.x = sx / FP;
            u.y = sy / FP;
            this.remember(u, false);
            sim.syncUnitSpatial(u);
        }
        let remaining = dt;
        const zeroTimeContacts = this.zeroTimeContacts || (this.zeroTimeContacts = new Map());
        zeroTimeContacts.clear();
        // Global event time: even uninvolved bodies advance only to the first contact, then all casts are rebuilt.
        while (remaining > 1e-9) {
            let first = 1,
                contacts = [];
            const keep = (contact) => {
                if (contact.t < first - 1e-9) {
                    first = contact.t;
                    contacts = [contact];
                } else if (Math.abs(contact.t - first) <= 1e-9) contacts.push(contact);
            };
            let maxSpeed = 0;
            for (let i = 0; i < n; i++)
                if (units[i].alive || units[i].impactMotion)
                    maxSpeed = Math.max(maxSpeed, Math.hypot(vx[i], vy[i]));
            for (let i = 0; i < n; i++) {
                const u = units[i];
                if (!u.alive && !u.impactMotion) continue;
                const dx = vx[i] * remaining,
                    dy = vy[i] * remaining;
                if (Math.abs(dx) + Math.abs(dy) > 1e-9) {
                    const hit = this.surface.cast(u.x, u.y, dx, dy, sim.unitRadius(u.type));
                    if (hit && vx[i] * hit.nx + vy[i] * hit.ny < -1e-7)
                        keep({
                            t: Math.max(0, Math.min(1, hit.t)),
                            i,
                            j: -1,
                            nx: hit.nx,
                            ny: hit.ny,
                            key: 'surface:' + u.id + ':' + String(hit.key || 'surface'),
                        });
                }
                if (!u.alive || !u.impactMotion || u.heroRoll) continue;
                const reach =
                    (Math.hypot(vx[i], vy[i]) + maxSpeed) * remaining +
                    sim.unitRadius(u.type) +
                    sim.maxUnitRadius;
                sim.withNearbyUnits(u.x, u.y, reach, 1 - u.side, (indices) => {
                    for (const j of indices) {
                        const other = units[j];
                        if (
                            !other?.alive ||
                            other.heroRoll ||
                            sim.isAlliedCollisionUnit(u, other) ||
                            UnitLeapAttack.separated(sim, u, other) ||
                            (other.impactMotion && j < i)
                        )
                            continue;
                        const rx = (vx[i] - vx[j]) * remaining,
                            ry = (vy[i] - vy[j]) * remaining;
                        const hit = SweptCircleContact.cast(
                            u.x - other.x,
                            u.y - other.y,
                            rx,
                            ry,
                            sim.unitRadius(u.type) + sim.unitRadius(other.type),
                            SweptCircleContact.policies.relative,
                            () => {
                                const v = sim.fallbackNormal(u, other);
                                return { x: v[0] / COLLISION_NORMAL, y: v[1] / COLLISION_NORMAL };
                            },
                        );
                        if (hit && (vx[i] - vx[j]) * hit.nx + (vy[i] - vy[j]) * hit.ny < -1e-7)
                            keep({
                                t: Math.max(0, Math.min(1, hit.t)),
                                i,
                                j,
                                nx: hit.nx,
                                ny: hit.ny,
                                key: 'unit:' + Math.min(i, j) + ':' + Math.max(i, j),
                            });
                    }
                });
            }
            const elapsed = remaining * first;
            for (let i = 0; i < n; i++) {
                const u = units[i];
                if (!u.alive && !u.impactMotion) continue;
                // Coordinate commits are exclusively velocity*time integration. Remainders retain sub-FP displacement.
                const m = u.impactMotion,
                    quantum = LaunchImpactRules.remainderScale,
                    rx = m ? (m.remainderX || 0) / quantum : remaindersX[i],
                    ry = m ? (m.remainderY || 0) / quantum : remaindersY[i];
                const dx = vx[i] * FP * elapsed + rx,
                    dy = vy[i] * FP * elapsed + ry;
                const sx = Math.trunc(dx),
                    sy = Math.trunc(dy);
                if (m) {
                    m.remainderX = Math.round((dx - sx) * quantum);
                    m.remainderY = Math.round((dy - sy) * quantum);
                } else {
                    remaindersX[i] = dx - sx;
                    remaindersY[i] = dy - sy;
                }
                u.fx += sx;
                u.fy += sy;
                u.x = u.fx / FP;
                u.y = u.fy / FP;
                this.remember(u, false);
                sim.syncUnitSpatial(u);
            }
            remaining -= elapsed;
            if (elapsed > 1e-9) zeroTimeContacts.clear();
            if (!contacts.length) break;
            contacts.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : a.i - b.i));
            for (const contact of contacts) {
                const { i, j, nx, ny } = contact,
                    u = units[i];
                const repeats = elapsed <= 1e-9 ? (zeroTimeContacts.get(contact.key) || 0) + 1 : 0;
                if (repeats) zeroTimeContacts.set(contact.key, repeats);
                if (j < 0 && repeats >= LaunchImpactRules.maxZeroTimeContactIterations) {
                    const m = u.impactMotion;
                    if (m)
                        this.applyImpulse(
                            u,
                            { x: (-m.vxFP / FP) * sim.mass(u), y: (-m.vyFP / FP) * sim.mass(u) },
                            {
                                kind: m.kind,
                                sourceId: m.sourceId,
                                originX: m.originX,
                                originY: m.originY,
                            },
                        );
                    vx[i] = 0;
                    vy[i] = 0;
                    continue;
                }
                if (j >= 0 && repeats >= LaunchImpactRules.maxZeroTimeContactIterations) {
                    // A degenerate zero-time contact sticks locally. Unrelated bodies and the world clock keep advancing.
                    const other = units[j],
                        ma = sim.mass(u),
                        mb = sim.mass(other),
                        commonX = (vx[i] * ma + vx[j] * mb) / (ma + mb),
                        commonY = (vy[i] * ma + vy[j] * mb) / (ma + mb);
                    for (const [index, body] of [
                        [i, u],
                        [j, other],
                    ]) {
                        const m = body.impactMotion,
                            mass = sim.mass(body);
                        this.applyImpulse(
                            body,
                            {
                                x: (commonX - (m?.vxFP || 0) / FP) * mass,
                                y: (commonY - (m?.vyFP || 0) / FP) * mass,
                            },
                            {
                                sourceId: index === i ? other.id : u.id,
                                originX: body.x,
                                originY: body.y,
                                kind: m?.kind || 'knockback',
                            },
                        );
                        vx[index] = commonX;
                        vy[index] = commonY;
                    }
                    continue;
                }
                if (j >= 0) {
                    const other = units[j];
                    const hadA = !!u.impactMotion,
                        hadB = !!other.impactMotion;
                    const applied = this.solveImpulseContact(
                        u,
                        other,
                        nx,
                        ny,
                        { x: vx[i], y: vy[i] },
                        { x: vx[j], y: vy[j] },
                    );
                    if (!applied) continue;
                    if (!hadA) {
                        u.impactMotion.remainderX = Math.round(
                            remaindersX[i] * LaunchImpactRules.remainderScale,
                        );
                        u.impactMotion.remainderY = Math.round(
                            remaindersY[i] * LaunchImpactRules.remainderScale,
                        );
                    }
                    if (!hadB) {
                        other.impactMotion.remainderX = Math.round(
                            remaindersX[j] * LaunchImpactRules.remainderScale,
                        );
                        other.impactMotion.remainderY = Math.round(
                            remaindersY[j] * LaunchImpactRules.remainderScale,
                        );
                    }
                    vx[i] = (u.impactMotion?.vxFP || 0) / FP;
                    vy[i] = (u.impactMotion?.vyFP || 0) / FP;
                    vx[j] = (other.impactMotion?.vxFP || 0) / FP;
                    vy[j] = (other.impactMotion?.vyFP || 0) / FP;
                } else if (u.impactMotion) {
                    const m = u.impactMotion;
                    this.applyImpulse(
                        u,
                        {
                            x: (vx[i] - m.vxFP / FP) * sim.mass(u),
                            y: (vy[i] - m.vyFP / FP) * sim.mass(u),
                        },
                        {
                            kind: m.kind,
                            sourceId: m.sourceId,
                            originX: m.originX,
                            originY: m.originY,
                        },
                    );
                    this.removeInwardVelocity(m, nx, ny);
                    vx[i] = m.vxFP / FP;
                    vy[i] = m.vyFP / FP;
                } else {
                    const speed = Math.hypot(vx[i], vy[i]),
                        slide = SurfaceContactGeometry.slide(vx[i], vy[i], [contact], speed, {
                            steer: true,
                            goalX: vx[i],
                            goalY: vy[i],
                            tieKey: String(u.id),
                        });
                    const safe = { vxFP: Math.round(slide.x * FP), vyFP: Math.round(slide.y * FP) };
                    this.removeInwardVelocity(safe, nx, ny);
                    vx[i] = safe.vxFP / FP;
                    vy[i] = safe.vyFP / FP;
                }
            }
            // Recast even when an earlier simultaneous impulse made a queued contact separating.
            // Never discard the unconsumed time of the entire world because one contact is degenerate.
        }
        // Residual overlap correction remains separate; it never invents a velocity or replaces contact momentum.
        for (const u of units) if (u.alive || u.impactMotion) this.constrain(u);
    }
    finishImpulseStep(u) {
        const sim = this.navigation.sim,
            m = u.impactMotion;
        if (!m) return;
        const drag =
            m.heightFP > 0 || m.vzFP > 0 ? LaunchImpactRules.airDrag : LaunchImpactRules.groundDrag;
        const factor = Math.max(0, 1 - drag / sim.tps);
        m.vxFP = Math.trunc(m.vxFP * factor);
        m.vyFP = Math.trunc(m.vyFP * factor);
        const settled = m.vxFP === 0 && m.vyFP === 0 && m.vzFP === 0 && m.heightFP === 0;
        if (settled && sim.tick >= m.recoverUntilTick) u.impactMotion = null;
    }
    solveImpulseContact(a, b, nx, ny, velocityA, velocityB) {
        const sim = this.navigation.sim;
        if (!a.impactMotion && !b.impactMotion) return;
        // A motor-driven participant becomes dynamic at contact. Its current motor velocity is captured once,
        // then normal impulse is added; recovery prevents the motor from overwriting that momentum next tick.
        const av = a.impactMotion,
            bv = b.impactMotion;
        const totalA = velocityA || { x: (av?.vxFP || 0) / FP, y: (av?.vyFP || 0) / FP };
        const totalB = velocityB || { x: (bv?.vxFP || 0) / FP, y: (bv?.vyFP || 0) / FP };
        const relative = (totalA.x - totalB.x) * nx + (totalA.y - totalB.y) * ny;
        if (relative >= 0) return;
        for (const [unit, total] of [
            [a, totalA],
            [b, totalB],
        ]) {
            const mass = sim.mass(unit),
                m = unit.impactMotion;
            this.applyImpulse(
                unit,
                {
                    x: (total.x - (m?.vxFP || 0) / FP) * mass,
                    y: (total.y - (m?.vyFP || 0) / FP) * mass,
                },
                {
                    sourceId: unit === a ? b.id : a.id,
                    originX: unit.x,
                    originY: unit.y,
                    kind: m?.kind || 'knockback',
                },
            );
        }
        const inverseA = 1 / sim.mass(a),
            inverseB = 1 / sim.mass(b);
        const impulse = (-(1 + LaunchImpactRules.restitution) * relative) / (inverseA + inverseB);
        this.applyImpulse(
            a,
            { x: impulse * nx, y: impulse * ny },
            { sourceId: b.id, originX: b.x, originY: b.y, kind: av?.kind || 'knockback' },
        );
        this.applyImpulse(
            b,
            { x: -impulse * nx, y: -impulse * ny },
            { sourceId: a.id, originX: a.x, originY: a.y, kind: bv?.kind || 'knockback' },
        );
        return true;
    }
    constrain(u) {
        const oldX = u.fx,
            oldY = u.fy,
            result = this.surface.constrain(
                u,
                u.x,
                u.y,
                this.navigation.sim.unitRadius(u.type),
                null,
                String(u.id),
            );
        if (result) this.commit(u, result);
        return u.fx !== oldX || u.fy !== oldY;
    }
}

// Terrain and building obstacles, plus the distance fields units steer by.
class TerrainNavigation {
    constructor(sim) {
        this.sim = sim;
        this.geometry = sim.world.terrain;
        this.topology = new NavigationTopology();
        this.sceneTick = -1;
        this.field = new ObstacleField({
            width: this.geometry.width,
            height: this.geometry.height,
            fixedPoint: FP,
            polygons: this.geometry.index,
            circles: [],
            ignoreAll: { id: '*', keep: (b) => b.terrainBarrier },
        });
        this.motion = new UnitMotion(this);
        this.goalFields = new Map();
        this.metrics = {
            fieldsBuilt: 0,
            fieldBuildMs: 0,
            localFields: 0,
            nextCalls: 0,
            rayHits: 0,
            unreachable: 0,
        };
    }
    sync(source = this.sim) {
        if (this.sceneTick === source.tick && this.sceneBuildings === source.buildings) return;
        this.sceneTick = source.tick;
        this.sceneBuildings = source.buildings;
        if (!this.topology.refresh(source.buildings)) return;
        // A changed obstacle layout makes every grid stale; fieldsFor() notices by version.
        this.field.setCircles(this.topology.records);
    }
    traceStraightTravel(x, y, dx, dy, distance, radius, source = this.sim) {
        this.sync(source);
        const contact = this.motion.surface.cast(x, y, dx * distance, dy * distance, radius);
        return {
            blocked: !!contact,
            // Leave enough room to round the clipped position to world fixed-point.
            distance: contact ? Math.max(0, contact.t * distance - 2 / FP) : distance,
        };
    }
    fieldsFor(radius) {
        this.sync();
        const key = Math.ceil((radius + 0.12) * 100) / 100;
        let fields = this.goalFields.get(key);
        if (!fields) this.goalFields.set(key, (fields = new GoalFields(this, key)));
        fields.grid.sync(this.topology.version);
        return fields;
    }
    acceptsGoalPoint(goal, x, y) {
        return (
            goal.contains(x, y) &&
            (!goal.terrainLine || this.geometry.field.polygonSegmentClear(x, y, goal.x, goal.y, 0))
        );
    }
    directGoal(x, y, goal, radius) {
        const p = goal.closest(x, y);
        if (!p || !this.acceptsGoalPoint(goal, p.x, p.y)) return null;
        return this.field.segmentClear(x, y, p.x, p.y, radius, null, true, 0) ? p : null;
    }
    // Where a unit heads next to reach `goal`. A clear straight ray inside the scan
    // radius wins; otherwise the unit reads the goal's distance field. Point goals are
    // fixed places (bases, flags, capture points) and keep their field.
    nextPoint(u, goal, fixed = goal.radius === 0) {
        this.metrics.nextCalls++;
        const radius = this.sim.unitRadius(u.type);
        const near = goal.closest(u.x, u.y);
        if (near && Math.hypot(near.x - u.x, near.y - u.y) <= GoalFields.RAY_RANGE) {
            const direct = this.directGoal(u.x, u.y, goal, radius);
            if (direct) {
                this.metrics.rayHits++;
                return direct;
            }
        }
        const point = this.fieldsFor(radius).next(u.x, u.y, goal, fixed, radius);
        if (!point) this.metrics.unreachable++;
        return point;
    }
    // Whether every strategic point can be reached from `from` by a unit this wide.
    connected(from, points, radius) {
        return this.fieldsFor(radius).connected(from, points);
    }
}

export { InteractionGeometry, NavigationGoal, TerrainNavigation, UnitMotion };
