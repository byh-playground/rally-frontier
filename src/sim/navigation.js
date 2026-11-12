// Goals, interaction geometry, surface contacts and the navigation front door.
import { RangeUtil } from '../core/game-rules.js';
import { EntityKey, NavigationTopology } from './entities.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UNIT_RUNTIME_GEOMETRY, UnitDefinition } from '../definitions/units.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { COLLISION_RADIUS_SCALE } from '../definitions/world-rules.js';
import { GoalFields } from './navigation-field.js';
import { DirectPath, FieldPath, RoutePath } from './navigation-paths.js';
import { RallyGamekit } from '../core/gamekit.js';
const {
    ACTIVE,
    ContactEvent,
    ContactHit,
    ContactSolver,
    DYNAMIC,
    MotionResult,
    ObstacleField,
    PAIRS,
    RESPONSE_EXCHANGE,
    RESPONSE_REFLECT,
    RESPONSE_STICK,
    RESPONSE_STOP,
    SEPARATE,
    SurfaceMotion,
    VERTICAL,
} = RallyGamekit;
import { FP } from '../core/config.js';
import { LaunchImpactRules } from '../definitions/launch-impact-rules.js';
import { UnitLeapAttack } from './capabilities/unit-leap-attack.js';
import { HeroRollAttack } from './capabilities/hero-roll-attack.js';
import { FruitHeroAttack } from './capabilities/fruit-hero-attack.js';
import { RollingBody } from './capabilities/rolling-body.js';
import { UnitFlight } from './capabilities/unit-flight.js';

// Interaction geometry owns the legal arrival set; the flow field only leads units to it.
// Goal regions are continuous (discs/annuli), not a fixed number of radial probes.
class NavigationGoal {
    static EPS = 1e-7;
    static cross(a, b, c) {
        return (b.x - a.x) * (c.y - a.y) - (b.y - a.y) * (c.x - a.x);
    }
    static ARRIVAL_INSET = 5 / FP;
    // Each quantized coordinate or radius is a fixed-point integer clamped to [0, 2^20): the map is a few thousand
    // units wide (4200 · FP 100 = 420000 < 2^20), and a clamped value only moves a goal outside the map.
    static QUANTUM_LIMIT = 2 ** 20 - 1;
    static quantize(value) {
        return Math.min(NavigationGoal.QUANTUM_LIMIT, Math.max(0, Math.round(value * FP)));
    }
    // `fixed` marks a goal whose centre does not move (a place, a building, a cannon): its field is keyed by the
    // quantized centre. Other area goals chase a moving unit and are keyed by the cell it stands in (GoalFields).
    constructor(x, y, radius = 0, innerRadius = 0, terrainLine = false, fixed = false) {
        this.reset(x, y, radius, innerRadius, terrainLine, fixed);
    }
    // Makes this goal a new one in place. Nothing holds a goal across navigation calls (fields and routes keep only
    // its integer key), so a caller asking every tick may keep one goal and reset it instead of allocating.
    reset(x, y, radius = 0, innerRadius = 0, terrainLine = false, fixed = false) {
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
        this.fixed = fixed || radius === 0;
        this.xq = NavigationGoal.quantize(x);
        this.yq = NavigationGoal.quantize(y);
        this.rq = NavigationGoal.quantize(radius);
        this.iq = NavigationGoal.quantize(innerRadius);
        // The goal key is two safe integers (GoalFields.keyA gives the first): a fixed goal's first half is
        // xq · 2^20 + yq < 2^40. The second half packs ((rq · 2^20 + iq) · 2 + terrainLine) · 2 + kind < 2^42, where
        // kind 0 is fixed and 1 is chase, so the two kinds never share a key.
        this.pointKey = this.xq * 2 ** 20 + this.yq;
        this.keyB =
            ((this.rq * 2 ** 20 + this.iq) * 2 + (terrainLine ? 1 : 0)) * 2 + (this.fixed ? 0 : 1);
        return this;
    }
    static point(x, y) {
        return new NavigationGoal(x, y, 0, 0, false, true);
    }
    static range(x, y, radius, innerRadius = 0, terrainLine = false, fixed = false) {
        // Five fixed-point quanta prevent rounding a stopped unit outside gameplay
        // range. The gameplay reach itself is not changed.
        const inset = Math.min(this.ARRIVAL_INSET, Math.max(0, (radius - innerRadius) / 4));
        return new NavigationGoal(
            x,
            y,
            Math.max(0, radius - inset),
            innerRadius > 0 ? innerRadius + inset : 0,
            terrainLine,
            fixed,
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
        // A breath (UnitBreathAttack) is a flame along the ground: walls and cliffs stop it at any reach.
        return (
            kind === 'construction' ||
            (kind === 'attack' &&
                (!!d.breathAttack ||
                    (!d.projectile && Number(extra) <= 100 && d.requiresContactTerrain === true)))
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
            terrainLine = this.requiresTerrainLine(source, kind, extra),
            // Buildings stand still; a unit target moves and its goal chases the cell it stands in.
            fixed = !!BuildingDefinition.get(target?.type);
        return inset
            ? NavigationGoal.range(target.x, target.y, outer, inner, terrainLine, fixed)
            : new NavigationGoal(target.x, target.y, outer, inner, terrainLine, fixed);
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
                true,
            );
        return this.region(source, target, kind, extra, minRange, true);
    }
}

// A grain's motion: steering moves along the terrain, impulses live in the unit's own impactMotion record, and
// one tick's contacts go through the shared GameKit contact solver (solveContacts).
class UnitMotion {
    static isGrounded(unit) {
        const motion = unit.impactMotion;
        return (
            !UnitFlight.airborne(unit) && (!motion || (motion.heightFP <= 0 && motion.vzFP <= 0))
        );
    }
    // The single source of a body's height: its bottom above the ground under it (FP). The impact motion
    // (knockback, launch, leap) and a flight's altitude lift a body; every body-height reader goes through here.
    static heightFP(unit) {
        return (unit.impactMotion?.heightFP || 0) + (unit.flight?.altitudeFP || 0);
    }
    // The body's bottom in world height: the ground under it plus its lift.
    static bottom(sim, unit) {
        return sim.world.terrain.surfaces.heightAt(unit.x, unit.y) + this.heightFP(unit) / FP;
    }
    // The same in FP: the ground rounded first, the lift added whole.
    static bottomFP(sim, unit) {
        return (
            Math.round(sim.world.terrain.surfaces.heightAt(unit.x, unit.y) * FP) +
            this.heightFP(unit)
        );
    }
    // Hero rolls and boomerang throws keep their committed path: no impulse or contact bookkeeping touches them.
    static locked(unit) {
        return unit.heroRoll?.phase === 'roll' || FruitHeroAttack.blocksMovement(unit);
    }

    constructor(navigation) {
        this.navigation = navigation;
        this.surface = new SurfaceMotion(navigation.field, { sync: () => navigation.sync() });
        // Out buffers the surface solver writes into; read before the next call.
        this.result = new MotionResult();
        this.surfaceHit = new ContactHit();
        // Walls, buildings and the map edge are always solved; unit pairs up to the budget, in time order.
        // The solver keeps no state between ticks: every body is filled from its unit each tick.
        this.contacts = new ContactSolver({
            surface: this.surface,
            fixedPoint: FP,
            remainderScale: LaunchImpactRules.remainderScale,
            pairBudget: LaunchImpactRules.unitContactBudget,
            maxZeroTimeRepeats: LaunchImpactRules.maxZeroTimeContactIterations,
            restitution: LaunchImpactRules.restitution,
            cellSize: LaunchImpactRules.contactCellSize,
            softFraction: LaunchImpactRules.allySoftFraction,
            softPasses: LaunchImpactRules.allySoftPasses,
            hardPasses: LaunchImpactRules.hostileSeparationPasses,
        });
        this.contacts.setRelations(3, LaunchImpactRules.contactRelations);
        this.contactEvent = new ContactEvent();
    }
    commit(u, p) {
        u.fx = Math.round(p.x * FP);
        u.fy = Math.round(p.y * FP);
        u.x = u.fx / FP;
        u.y = u.fy / FP;
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
                EntityKey.number(u.id),
                this.result,
            ),
        );
    }
    // Adds an impulse to the unit's impact velocity (knockback, launch, leap). The contact solve does not come
    // here: it changes velocities in the solver's columns and records the same bookkeeping through markImpact.
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
        // A flying unit is out of every ground push (knockback, blasts, rolls, contacts).
        if (UnitMotion.locked(u) || UnitFlight.airborne(u)) return;
        const mass = this.navigation.sim.mass(u),
            m = this.impactRecord(u, initialHeightFP);
        m.vxFP += Math.round(((Number(impulse.x) || 0) / mass) * FP);
        m.vyFP += Math.round(((Number(impulse.y) || 0) / mass) * FP);
        m.vzFP += Math.round(((Number(impulse.z) || 0) / mass) * FP);
        this.markImpact(u, kind, sourceId, originX, originY);
        return m;
    }
    // The unit's impact record, made at rest when it has none.
    impactRecord(u, initialHeightFP = 0) {
        const tick = this.navigation.sim.tick;
        return (u.impactMotion ??= {
            kind: 'knockback',
            startTick: tick,
            endTick: tick,
            recoverUntilTick: tick,
            heightFP: Math.max(0, Math.round(initialHeightFP)),
            vzFP: 0,
            vxFP: 0,
            vyFP: 0,
            remainderX: 0,
            remainderY: 0,
            remainderZ: 0,
            originX: u.x,
            originY: u.y,
            sourceId: null,
        });
    }
    // What a change of impact velocity records: who caused it and from where, the flight and recovery window from
    // the current height and vertical speed, and the actions it interrupts.
    markImpact(u, kind, sourceId, originX, originY) {
        const sim = this.navigation.sim,
            m = this.impactRecord(u),
            flightSeconds =
                (m.vzFP / FP +
                    Math.sqrt(
                        (m.vzFP / FP) ** 2 + (2 * LaunchImpactRules.gravity * m.heightFP) / FP,
                    )) /
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
    // One tick's contacts. Every body moves in a straight line from its tick start (startX/startY, FP) along this
    // tick's steering plus its impact velocity. In time order: walls, buildings and the map edge always; enemy
    // pairs, walking or flying alike, up to LaunchImpactRules.unitContactBudget (later ones pass through); allies
    // never. A rolling body answers its own contacts (RollingBody.respond); every other contact takes the solver's
    // standard response. Then overlaps are separated: allies by a mass-weighted share, enemies by moving the body
    // that entered fully out, each stage kept out of the terrain. No allocation once the buffers have grown, except
    // the impact record of a steering body a contact sets moving (entity state).
    solveContacts(startX, startY) {
        const sim = this.navigation.sim,
            units = sim.units,
            n = units.length,
            solver = this.contacts,
            ev = this.contactEvent;
        this.navigation.sync();
        const bodies = solver.begin(n, 1 / sim.tps);
        let vertical = false;
        for (let i = 0; i < n && !vertical; i++) vertical = UnitLeapAttack.airborne(units[i]);
        for (let i = 0; i < n; i++)
            this.fillBody(bodies, i, units[i], startX[i], startY[i], vertical);
        while (solver.next(ev))
            if (!RollingBody.respond(this, ev)) {
                solver.resolve(ev);
                this.recordContact(ev);
            }
        solver.end();
        solver.separate();
        for (let i = 0; i < n; i++) this.commitBody(bodies, i, units[i]);
    }
    fillBody(bodies, i, u, startFx, startFy, vertical) {
        const sim = this.navigation.sim,
            m = u.impactMotion,
            definition = UnitDefinition.get(u.type),
            radius = sim.unitRadius(u.type),
            radiusFP = radius * FP,
            pairs = u.alive && !u.heroRoll && !FruitHeroAttack.blocksMovement(u),
            // A flying unit's own step already placed it; its body stays inactive where it is (no contacts).
            flying = UnitFlight.airborne(u);
        bodies.x[i] = flying ? u.fx : startFx;
        bodies.y[i] = flying ? u.fy : startFy;
        bodies.steerX[i] = u.fx;
        bodies.steerY[i] = u.fy;
        bodies.ivx[i] = m ? m.vxFP : 0;
        bodies.ivy[i] = m ? m.vyFP : 0;
        bodies.rx[i] = m ? m.remainderX : 0;
        bodies.ry[i] = m ? m.remainderY : 0;
        bodies.radius[i] = radius;
        bodies.mass[i] = sim.mass(u);
        bodies.key[i] = EntityKey.number(u.id);
        bodies.group[i] = u.side === 0 || u.side === 1 ? u.side : 2;
        bodies.z[i] = vertical ? UnitMotion.bottom(sim, u) : 0;
        bodies.softCap[i] = Math.max(
            1,
            Math.min(
                Math.round(radiusFP * LaunchImpactRules.allySoftMaxRadius),
                Math.max(
                    Math.round(radiusFP * LaunchImpactRules.allySoftIdleRadius),
                    Math.round(
                        (Math.max(0, Number(definition?.speed) || 0) / sim.tps) *
                            FP *
                            LaunchImpactRules.allySoftSpeed,
                    ),
                ),
            ),
        );
        bodies.flags[i] = flying
            ? 0
            : (u.alive || m ? ACTIVE : 0) |
              (m ? DYNAMIC : 0) |
              (pairs ? PAIRS : 0) |
              (pairs && definition?.crowdCollision !== false ? SEPARATE : 0) |
              (UnitLeapAttack.airborne(u) ? VERTICAL : 0);
    }
    // The bookkeeping of a standard response: a reflection or stop keeps the record's source; an exchange takes
    // the other body, from where it stands at the contact; sticking takes the other body, from the unit's own spot.
    recordContact(ev) {
        const bodies = this.contacts.bodies,
            units = this.navigation.sim.units,
            i = ev.i,
            j = ev.j,
            a = units[i];
        if (ev.response === RESPONSE_REFLECT || ev.response === RESPONSE_STOP) {
            const m = a.impactMotion;
            if (!m || UnitMotion.locked(a)) return;
            const rolled = !!a.heroRoll;
            this.markImpact(a, m.kind, m.sourceId, m.originX, m.originY);
            // A cancelled hero roll meets units again from its next cast on (it is in this group, so it recasts).
            if (rolled && !a.heroRoll && a.alive && !FruitHeroAttack.blocksMovement(a))
                bodies.flags[i] |=
                    UnitDefinition.get(a.type)?.crowdCollision !== false ? PAIRS | SEPARATE : PAIRS;
            return;
        }
        if (ev.response !== RESPONSE_EXCHANGE && ev.response !== RESPONSE_STICK) return;
        // Sticking two walking bodies sets neither moving.
        if (!(bodies.flags[i] & DYNAMIC)) return;
        const b = units[j],
            exchange = ev.response === RESPONSE_EXCHANGE;
        this.markContact(a, b.id, exchange ? j : i);
        this.markContact(b, a.id, exchange ? i : j);
    }
    // A unit-unit contact: the source is the other unit, the origin body k's position at the contact.
    markContact(u, sourceId, k) {
        const bodies = this.contacts.bodies;
        if (!UnitMotion.locked(u))
            this.markImpact(
                u,
                u.impactMotion?.kind || 'knockback',
                sourceId,
                bodies.x[k] / FP,
                bodies.y[k] / FP,
            );
    }
    commitBody(bodies, i, u) {
        const fx = bodies.x[i],
            fy = bodies.y[i],
            m = u.impactMotion;
        if (m) {
            m.vxFP = bodies.ivx[i];
            m.vyFP = bodies.ivy[i];
            m.remainderX = bodies.rx[i];
            m.remainderY = bodies.ry[i];
        }
        if (fx === u.fx && fy === u.fy) return;
        u.fx = fx;
        u.fy = fy;
        u.x = fx / FP;
        u.y = fy / FP;
        this.navigation.sim.syncUnitSpatial(u);
    }
    finishImpulseStep(u) {
        const sim = this.navigation.sim,
            m = u.impactMotion;
        // A rolling walnut's speed is its motor's: drive minus drag, applied before contacts.
        if (!m || RollingBody.rolling(u)) return;
        const drag =
            m.heightFP > 0 || m.vzFP > 0 ? LaunchImpactRules.airDrag : LaunchImpactRules.groundDrag;
        const factor = Math.max(0, 1 - drag / sim.tps);
        m.vxFP = Math.trunc(m.vxFP * factor);
        m.vyFP = Math.trunc(m.vyFP * factor);
        const settled = m.vxFP === 0 && m.vyFP === 0 && m.vzFP === 0 && m.heightFP === 0;
        if (settled && sim.tick >= m.recoverUntilTick) u.impactMotion = null;
    }
}

// Terrain and building obstacles, plus the flow fields units steer by.
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
            ignoreAll: { id: -1, keep: (b) => b.terrainBarrier },
        });
        this.motion = new UnitMotion(this);
        // One GoalFields per unit radius bucket: by bucket key, and in creation order for change notices.
        this.goalFields = new Map();
        this.fieldList = [];
        this.metrics = {
            fieldsBuilt: 0,
            fieldBuildMs: 0,
            localFields: 0,
            nextCalls: 0,
            rayHits: 0,
            unreachable: 0,
            routeSearches: 0,
        };
        this.paths = {
            field: new FieldPath(this),
            route: new RoutePath(this),
            direct: new DirectPath(this),
        };
    }
    sync(source = this.sim) {
        if (this.sceneTick === source.tick && this.sceneBuildings === source.buildings) return;
        this.sceneTick = source.tick;
        this.sceneBuildings = source.buildings;
        if (!this.topology.refresh(source.buildings)) return;
        this.field.setCircles(this.topology.records);
        // Every appeared, moved or removed building record reaches every radius grid as its own rectangle; the
        // graphs rebuild only the chunks those rectangles touch on their next query.
        const changes = this.topology.changes,
            fields = this.fieldList;
        for (let i = 0; i < changes.length; i++)
            for (let k = 0; k < fields.length; k++) fields[k].obstacleChanged(changes[i]);
    }
    // Loading step: builds every radius bucket's chunk and portal structure now, so the first queries of a match
    // only compute flow fields.
    prepare() {
        this.sync();
        for (const type in UNIT_RUNTIME_GEOMETRY)
            this.fieldsFor(UNIT_RUNTIME_GEOMETRY[type].radius).graph.prepare();
    }
    traceStraightTravel(x, y, dx, dy, distance, radius, source = this.sim) {
        this.sync(source);
        const hit = this.motion.surfaceHit,
            blocked = this.motion.surface.cast(
                x,
                y,
                dx * distance,
                dy * distance,
                radius,
                null,
                hit,
            );
        return {
            blocked,
            // Leave enough room to round the clipped position to world fixed-point.
            distance: blocked ? Math.max(0, hit.t * distance - 2 / FP) : distance,
        };
    }
    fieldsFor(radius) {
        this.sync();
        const key = Math.ceil((radius + 0.12) * 100) / 100;
        let fields = this.goalFields.get(key);
        if (!fields) {
            // A new grid starts empty and reads the current layout; only later changes are notified.
            this.goalFields.set(key, (fields = new GoalFields(this, key)));
            this.fieldList.push(fields);
        }
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
    // The closest goal point when it lies inside the scan radius and the straight ray to it is clear.
    straightGoal(u, goal, radius) {
        const near = goal.closest(u.x, u.y);
        if (!near || Math.hypot(near.x - u.x, near.y - u.y) > GoalFields.RAY_RANGE) return null;
        const direct = this.directGoal(u.x, u.y, goal, radius);
        if (direct) this.metrics.rayHits++;
        return direct;
    }
    // Where a unit heads next to reach `goal`, or null when it cannot. The caller picks the way
    // (navigation-paths.js): 'field' (shared flow field), 'route' (A* kept in Unit.route)
    // or 'direct' (straight line only).
    nextPoint(u, goal, path = 'field') {
        this.metrics.nextCalls++;
        return this.paths[path].nextPoint(u, goal);
    }
    // Whether every strategic point can be reached from `from` by a unit this wide.
    connected(from, points, radius) {
        return this.fieldsFor(radius).connected(from, points);
    }
}

export { InteractionGeometry, NavigationGoal, TerrainNavigation, UnitMotion };
