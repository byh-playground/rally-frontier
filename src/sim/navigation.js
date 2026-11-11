// Goals, interaction geometry, surface contacts and the navigation front door.
import { RangeUtil } from '../core/game-rules.js';
import { EntityKey, NavigationTopology } from './entities.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UNIT_RUNTIME_GEOMETRY, UnitDefinition } from '../definitions/units.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { COLLISION_RADIUS_SCALE, COLLISION_NORMAL } from '../definitions/world-rules.js';
import { GoalFields } from './navigation-field.js';
import { DirectPath, FieldPath, RoutePath } from './navigation-paths.js';
import { RallyGamekit } from '../core/gamekit.js';
const {
    ContactHit,
    ContactList,
    MotionResult,
    ObstacleField,
    SurfaceMotion,
    SweptCircleContact,
    SurfaceContactGeometry,
} = RallyGamekit;
import { FP } from '../core/config.js';
import { LaunchImpactRules } from '../definitions/launch-impact-rules.js';
import { UnitLeapAttack } from './capabilities/unit-leap-attack.js';
import { HeroRollAttack } from './capabilities/hero-roll-attack.js';
import { FruitHeroAttack } from './capabilities/fruit-hero-attack.js';
import { RollingBody } from './capabilities/rolling-body.js';

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

// The contacts UnitMotion.solveImpulseStep knows about. Every body keeps the contacts of its own
// trajectory that are tied at its earliest time, in absolute seconds of the tick, as a linked list in
// pooled typed columns; a body is recast only when it or a partner of one of its contacts changes.
class ImpulseContacts {
    constructor() {
        this.capacity = 0;
        this.free = -1;
        this.obstacle = [];
        this.head = new Int32Array(0);
        this.earliest = new Float64Array(0);
        this.grow(256);
        this.group = [];
        // Same-time contacts resolve surfaces first (by unit, then contact key), then unit pairs (by lower, then
        // higher index), then by the moving unit.
        this.compare = (a, b) =>
            (this.j[a] < 0 ? 0 : 1) - (this.j[b] < 0 ? 0 : 1) ||
            this.sortA[a] - this.sortA[b] ||
            this.sortB[a] - this.sortB[b] ||
            this.i[a] - this.i[b];
        // Zero-time repeat counts, keyed by integers: a unit pair under -(lo * n + hi) - 1 < 0, a surface contact
        // under slot * n + i >= 0, where slot numbers each surface contact key met this step. |key| < n^2 * slots,
        // far inside 2^53.
        this.repeats = new Map();
        this.surfaceSlots = new Map();
        this.units = 0;
    }
    grow(capacity) {
        const columns = [
            ['t', Float64Array],
            ['i', Int32Array],
            ['j', Int32Array],
            ['nx', Float64Array],
            ['ny', Float64Array],
            ['key', Float64Array],
            ['sortA', Float64Array],
            ['sortB', Float64Array],
            ['next', Int32Array],
        ];
        for (const [name, Type] of columns) {
            const next = new Type(capacity);
            if (this[name]) next.set(this[name]);
            this[name] = next;
        }
        for (let c = capacity - 1; c >= this.capacity; c--) {
            this.next[c] = this.free;
            this.free = c;
        }
        this.capacity = capacity;
    }
    beginStep(units) {
        if (this.head.length < units) {
            this.head = new Int32Array(units * 2);
            this.earliest = new Float64Array(units * 2);
        }
        this.head.fill(-1, 0, units);
        this.earliest.fill(Infinity, 0, units);
        this.free = -1;
        for (let c = this.capacity - 1; c >= 0; c--) {
            this.next[c] = this.free;
            this.free = c;
        }
        this.units = units;
        this.repeats.clear();
        this.surfaceSlots.clear();
    }
    clearRepeats() {
        this.repeats.clear();
    }
    // Forgets the contacts kept for body b.
    release(b) {
        for (let c = this.head[b]; c >= 0;) {
            const next = this.next[c];
            this.obstacle[c] = null;
            this.next[c] = this.free;
            this.free = c;
            c = next;
        }
        this.head[b] = -1;
        this.earliest[b] = Infinity;
    }
    // Keeps a contact for body b when it is b's earliest so far (within 1e-9 s), dropping every later one.
    keep(b, t, i, j, nx, ny, key, obstacle) {
        if (t < this.earliest[b] - 1e-9) {
            this.release(b);
            this.earliest[b] = t;
        } else if (Math.abs(t - this.earliest[b]) > 1e-9) return;
        if (this.free < 0) this.grow(this.capacity * 2);
        const c = this.free;
        this.free = this.next[c];
        this.t[c] = t;
        this.i[c] = i;
        this.j[c] = j;
        this.nx[c] = nx;
        this.ny[c] = ny;
        this.key[c] = key;
        this.obstacle[c] = obstacle;
        this.sortA[c] = j < 0 ? i : Math.min(i, j);
        this.sortB[c] = j < 0 ? key : Math.max(i, j);
        this.next[c] = this.head[b];
        this.head[b] = c;
    }
    // The earliest time any body knows a contact at, Infinity when none.
    first() {
        let first = Infinity;
        for (let b = 0; b < this.units; b++)
            if (this.head[b] >= 0 && this.earliest[b] < first) first = this.earliest[b];
        return first;
    }
    // Every kept contact at the time `first`, in resolution order. A pair kept by both of its bodies
    // appears twice, next to each other.
    gather(first) {
        const group = this.group;
        group.length = 0;
        for (let b = 0; b < this.units; b++)
            if (this.head[b] >= 0 && this.earliest[b] <= first + 1e-9)
                for (let c = this.head[b]; c >= 0; c = this.next[c]) group.push(c);
        return group.sort(this.compare);
    }
    // Whether body b keeps a contact with a body marked `stamp`.
    touches(b, marks, stamp) {
        for (let c = this.head[b]; c >= 0; c = this.next[c])
            if (marks[this.i[c]] === stamp || (this.j[c] >= 0 && marks[this.j[c]] === stamp))
                return true;
        return false;
    }
    // How many zero-time passes in a row have met this contact, this one included.
    repeat(c) {
        const n = this.units;
        let key;
        if (this.j[c] >= 0) key = -(this.sortA[c] * n + this.sortB[c]) - 1;
        else {
            let slot = this.surfaceSlots.get(this.key[c]);
            if (slot === undefined)
                this.surfaceSlots.set(this.key[c], (slot = this.surfaceSlots.size));
            key = slot * n + this.i[c];
        }
        const count = (this.repeats.get(key) || 0) + 1;
        this.repeats.set(key, count);
        return count;
    }
}

// Local contacts share one solver; the flow field only chooses where to head.
// A grain's own motion record: checkpoints, fixed-point commit and the unit's radius sit around the shared contact solver.
class UnitMotion {
    static isGrounded(unit) {
        const motion = unit.impactMotion;
        return !motion || (motion.heightFP <= 0 && motion.vzFP <= 0);
    }

    constructor(navigation) {
        this.navigation = navigation;
        this.surface = new SurfaceMotion(navigation.field, { sync: () => navigation.sync() });
        // Out buffers the contact solver writes into; read before the next call.
        this.result = new MotionResult();
        this.surfaceHit = new ContactHit();
        this.pairHit = new ContactHit();
        this.slideContacts = new ContactList();
        this.slideVelocity = { x: 0, y: 0 };
        this.slideSafe = { vxFP: 0, vyFP: 0 };
        this.velocityA = { x: 0, y: 0 };
        this.velocityB = { x: 0, y: 0 };
        this.pairCandidates = [];
        this.contacts = new ImpulseContacts();
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
                EntityKey.number(u.id),
                this.result,
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
    removeInwardVelocity(m, nx, ny, restitution = LaunchImpactRules.restitution) {
        const inward = m.vxFP * nx + m.vyFP * ny;
        if (inward >= 0) return;
        const factor = 1 + restitution;
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
        let moving = false;
        for (let i = 0; i < n && !moving; i++) moving = !!units[i].impactMotion;
        if (!moving) return;
        this.solvedImpulseTick = sim.tick;
        if (!this.impulseFrame || this.impulseFrame.capacity < n) {
            const capacity = Math.max(n, this.impulseFrame?.capacity * 2 || 64);
            this.impulseFrame = {
                capacity,
                vx: new Float64Array(capacity),
                vy: new Float64Array(capacity),
                rx: new Float64Array(capacity),
                ry: new Float64Array(capacity),
                // Each body's position is exact at its own time base; it moves on in a straight line from there.
                base: new Float64Array(capacity),
                involved: new Int32Array(capacity),
                recast: new Int32Array(capacity),
                stamp: 0,
            };
        }
        const frame = this.impulseFrame,
            { vx, vy, rx: remaindersX, ry: remaindersY, base, involved, recast } = frame,
            dt = 1 / sim.tps,
            contacts = this.contacts;
        remaindersX.fill(0, 0, n);
        remaindersY.fill(0, 0, n);
        base.fill(0, 0, n);
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
        contacts.beginStep(n);
        // Unit-unit contacts this tick may resolve: rolling bodies have their own share, so a crowd's
        // contacts never starve the strikes. The rest pass through each other and are separated later.
        // Surface contacts are never limited.
        this.unitContactsLeft = LaunchImpactRules.unitContactBudget;
        this.rollingContactsLeft = LaunchImpactRules.rollingContactBudget;
        this.skippedUnitContacts = 0;
        // The fastest speed any body has had this tick; it bounds how far a body has moved from its grid cell.
        this.speedBound = 0;
        for (let i = 0; i < n; i++)
            if (units[i].alive || units[i].impactMotion)
                this.speedBound = Math.max(this.speedBound, Math.hypot(vx[i], vy[i]));
        for (let i = 0; i < n; i++) this.castImpulseBody(i, 0, dt);
        // Event time: only the bodies of the earliest contacts move up to it and resolve; they and every
        // body that kept a contact with them are recast. Everything else keeps its cast.
        let now = 0;
        for (;;) {
            const first = contacts.first();
            if (first === Infinity) break;
            const elapsed = first - now;
            now = first;
            if (elapsed > 1e-9) contacts.clearRepeats();
            const stamp = ++frame.stamp,
                order = contacts.gather(first);
            for (let q = 0; q < order.length; q++) {
                const i = contacts.i[order[q]],
                    j = contacts.j[order[q]];
                involved[i] = stamp;
                this.advanceImpulseBody(i, now);
                if (j >= 0) {
                    involved[j] = stamp;
                    this.advanceImpulseBody(j, now);
                }
            }
            let lastI = -1,
                lastJ = -1;
            for (let q = 0; q < order.length; q++) {
                const c = order[q],
                    i = contacts.i[c],
                    j = contacts.j[c],
                    nx = contacts.nx[c],
                    ny = contacts.ny[c],
                    u = units[i];
                if (j >= 0) {
                    // Kept by both bodies: resolve it once.
                    if (i === lastI && j === lastJ) continue;
                    lastI = i;
                    lastJ = j;
                    if (!this.takeUnitContact(u, units[j])) continue;
                }
                const repeats = elapsed <= 1e-9 ? contacts.repeat(c) : 0;
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
                const velocityA = this.velocityA,
                    velocityB = this.velocityB;
                if (j >= 0 && repeats >= LaunchImpactRules.maxZeroTimeContactIterations) {
                    // A degenerate zero-time contact sticks locally. Unrelated bodies and the world clock keep advancing.
                    const other = units[j];
                    velocityA.x = vx[i];
                    velocityA.y = vy[i];
                    velocityB.x = vx[j];
                    velocityB.y = vy[j];
                    // A rolling body bounces off once instead of sticking (RollingBody.bounceStuck); a
                    // contact that still recurs after that sticks like any other.
                    if (
                        repeats === LaunchImpactRules.maxZeroTimeContactIterations &&
                        RollingBody.bounceStuck(this, u, other, nx, ny, velocityA, velocityB)
                    ) {
                        vx[i] = velocityA.x;
                        vy[i] = velocityA.y;
                        vx[j] = velocityB.x;
                        vy[j] = velocityB.y;
                        continue;
                    }
                    const ma = sim.mass(u),
                        mb = sim.mass(other),
                        commonX = (vx[i] * ma + vx[j] * mb) / (ma + mb),
                        commonY = (vy[i] * ma + vy[j] * mb) / (ma + mb);
                    for (let side = 0; side < 2; side++) {
                        const index = side === 0 ? i : j,
                            body = side === 0 ? u : other,
                            m = body.impactMotion,
                            mass = sim.mass(body);
                        this.applyImpulse(
                            body,
                            {
                                x: (commonX - (m?.vxFP || 0) / FP) * mass,
                                y: (commonY - (m?.vyFP || 0) / FP) * mass,
                            },
                            {
                                sourceId: side === 0 ? other.id : u.id,
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
                    velocityA.x = vx[i];
                    velocityA.y = vy[i];
                    velocityB.x = vx[j];
                    velocityB.y = vy[j];
                    const applied = this.solveImpulseContact(
                        u,
                        other,
                        nx,
                        ny,
                        velocityA,
                        velocityB,
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
                    const m = u.impactMotion,
                        restitution = RollingBody.surfaceRestitution(u),
                        obstacle = contacts.obstacle[c];
                    if (restitution !== null)
                        RollingBody.hitSurface(
                            sim,
                            u,
                            obstacle ? obstacle.buildingId : null,
                            nx,
                            ny,
                            -(vx[i] * nx + vy[i] * ny),
                        );
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
                    this.removeInwardVelocity(m, nx, ny, restitution ?? undefined);
                    vx[i] = m.vxFP / FP;
                    vy[i] = m.vyFP / FP;
                } else {
                    const list = this.slideContacts.clear(),
                        safe = this.slideSafe;
                    list.add(nx, ny, 0, contacts.key[c]);
                    const slide = SurfaceContactGeometry.slide(
                        vx[i],
                        vy[i],
                        list,
                        Math.hypot(vx[i], vy[i]),
                        true,
                        vx[i],
                        vy[i],
                        EntityKey.number(u.id),
                        null,
                        this.slideVelocity,
                    );
                    safe.vxFP = Math.round(slide.x * FP);
                    safe.vyFP = Math.round(slide.y * FP);
                    this.removeInwardVelocity(safe, nx, ny);
                    vx[i] = safe.vxFP / FP;
                    vy[i] = safe.vyFP / FP;
                }
            }
            for (let b = 0; b < n; b++)
                recast[b] =
                    involved[b] === stamp || contacts.touches(b, involved, stamp) ? stamp : 0;
            for (let b = 0; b < n; b++)
                if (recast[b] === stamp) {
                    this.advanceImpulseBody(b, now);
                    this.castImpulseBody(b, now, dt);
                }
        }
        for (let i = 0; i < n; i++) this.advanceImpulseBody(i, dt);
        // Residual overlap correction remains separate; it never invents a velocity or replaces contact momentum.
        for (const u of units) if (u.alive || u.impactMotion) this.constrain(u);
    }
    // Moves body i along its velocity from its time base up to `time`. Coordinate commits are exclusively
    // velocity*time integration; remainders retain sub-FP displacement.
    advanceImpulseBody(i, time) {
        const sim = this.navigation.sim,
            u = sim.units[i],
            { vx, vy, rx: remaindersX, ry: remaindersY, base } = this.impulseFrame,
            elapsed = time - base[i];
        base[i] = time;
        if (!(elapsed > 0) || (!u.alive && !u.impactMotion)) return;
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
    // Casts body i, which is at its time base `now`, over the rest of the tick and keeps its earliest
    // contacts: surfaces, then enemy bodies of which at least one moves dynamically. A pair is cast as
    // (moving body, other), the lower index first when both move, whichever body casts it.
    castImpulseBody(i, now, end) {
        const sim = this.navigation.sim,
            units = sim.units,
            u = units[i],
            { vx, vy, base } = this.impulseFrame,
            contacts = this.contacts,
            surfaceHit = this.surfaceHit,
            pairHit = this.pairHit,
            candidates = this.pairCandidates;
        contacts.release(i);
        const span = end - now;
        if ((!u.alive && !u.impactMotion) || span <= 1e-9) return;
        const speed = Math.hypot(vx[i], vy[i]);
        if (speed > this.speedBound) this.speedBound = speed;
        const dx = vx[i] * span,
            dy = vy[i] * span;
        if (
            Math.abs(dx) + Math.abs(dy) > 1e-9 &&
            this.surface.cast(u.x, u.y, dx, dy, sim.unitRadius(u.type), null, surfaceHit) &&
            vx[i] * surfaceHit.nx + vy[i] * surfaceHit.ny < -1e-7
        )
            contacts.keep(
                i,
                now + Math.max(0, Math.min(1, surfaceHit.t)) * span,
                i,
                -1,
                surfaceHit.nx,
                surfaceHit.ny,
                surfaceHit.key,
                surfaceHit.obstacle,
            );
        if (
            (this.unitContactsLeft <= 0 && this.rollingContactsLeft <= 0) ||
            !u.alive ||
            u.heroRoll ||
            FruitHeroAttack.blocksMovement(u)
        )
            return;
        // Another body sits in the grid where it was at its own time base and has moved at most
        // speedBound * end since.
        const reach =
            speed * span + this.speedBound * end + sim.unitRadius(u.type) + sim.maxUnitRadius;
        sim.nearbyUnits(u.x, u.y, reach, 1 - u.side, candidates);
        for (let k = 0; k < candidates.length; k++) {
            const j = candidates[k],
                other = units[j];
            if (
                !other?.alive ||
                (!u.impactMotion && !other.impactMotion) ||
                other.heroRoll ||
                FruitHeroAttack.blocksMovement(other) ||
                sim.isAlliedCollisionUnit(u, other) ||
                UnitLeapAttack.separated(sim, u, other)
            )
                continue;
            const a = u.impactMotion && (!other.impactMotion || i < j) ? i : j,
                b = a === i ? j : i;
            if (!this.mayTakeUnitContact(units[a], units[b])) continue;
            const ax = units[a].x + vx[a] * (now - base[a]),
                ay = units[a].y + vy[a] * (now - base[a]),
                bx = units[b].x + vx[b] * (now - base[b]),
                by = units[b].y + vy[b] * (now - base[b]);
            if (
                !SweptCircleContact.cast(
                    ax - bx,
                    ay - by,
                    (vx[a] - vx[b]) * span,
                    (vy[a] - vy[b]) * span,
                    sim.unitRadius(units[a].type) + sim.unitRadius(units[b].type),
                    SweptCircleContact.policies.relative,
                    pairHit,
                )
            )
                continue;
            if (pairHit.degenerate) {
                const normal = sim.fallbackNormal(units[a], units[b]);
                pairHit.nx = normal[0] / COLLISION_NORMAL;
                pairHit.ny = normal[1] / COLLISION_NORMAL;
            }
            if ((vx[a] - vx[b]) * pairHit.nx + (vy[a] - vy[b]) * pairHit.ny < -1e-7)
                contacts.keep(
                    i,
                    now + Math.max(0, Math.min(1, pairHit.t)) * span,
                    a,
                    b,
                    pairHit.nx,
                    pairHit.ny,
                    0,
                    null,
                );
        }
    }
    // Whether the unit-unit budget still has room for a contact of a and b.
    mayTakeUnitContact(a, b) {
        return RollingBody.rolling(a) || RollingBody.rolling(b)
            ? this.rollingContactsLeft > 0
            : this.unitContactsLeft > 0;
    }
    // Spends the budget on a contact of a and b; a contact past it is skipped and counted.
    takeUnitContact(a, b) {
        if (!this.mayTakeUnitContact(a, b)) {
            this.skippedUnitContacts++;
            return false;
        }
        if (RollingBody.rolling(a) || RollingBody.rolling(b)) this.rollingContactsLeft--;
        else this.unitContactsLeft--;
        return true;
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
    solveImpulseContact(a, b, nx, ny, velocityA, velocityB) {
        const sim = this.navigation.sim;
        if (!a.impactMotion && !b.impactMotion) return;
        // A motor-driven participant becomes dynamic at contact. Its current motor velocity is captured once,
        // then normal impulse is added; recovery prevents the motor from overwriting that momentum next tick.
        const av = a.impactMotion,
            bv = b.impactMotion;
        const totalA = velocityA || { x: (av?.vxFP || 0) / FP, y: (av?.vyFP || 0) / FP };
        const totalB = velocityB || { x: (bv?.vxFP || 0) / FP, y: (bv?.vyFP || 0) / FP };
        if (RollingBody.rolling(a) || RollingBody.rolling(b))
            return RollingBody.collide(this, a, b, nx, ny, totalA, totalB);
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
            oldY = u.fy;
        if (
            this.surface.constrain(
                u,
                u.x,
                u.y,
                this.navigation.sim.unitRadius(u.type),
                null,
                EntityKey.number(u.id),
                this.result,
            )
        )
            this.commit(u, this.result);
        return u.fx !== oldX || u.fy !== oldY;
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
