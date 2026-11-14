// The ways a ground unit can find its next point. TerrainNavigation.nextPoint is the one front door; the caller
// names the way (`path`) and every way answers the same question: where to head next, or null when unreachable.
//   field  : the shared flow field per goal key on the chunk/portal graph (every army unit).
//   route  : one A* search kept in Unit.route, searched again only when the goal changes or the building layout
//            changes under the remaining route (returning heroes).
//   direct : the straight line to the goal's closest point, or nothing; no field and no search.
// A clear straight ray inside the scan radius wins over both grid ways (field and route), unless it cuts across
// water from dry ground (TerrainNavigation.crossesSlowerGround): then the cost-aware grid way decides.
import { RallyGamekit } from '../core/gamekit.js';
import { GoalFields } from './navigation-field.js';
const { RouteFinder } = RallyGamekit;

class FieldPath {
    constructor(nav) {
        this.nav = nav;
    }
    // Every goal keeps its flow field across ticks under its key (GoalFields.keyA, NavigationGoal.keyB): fixed goals
    // by their quantized centre, chase goals by the cell their target stands in.
    nextPoint(u, goal) {
        const nav = this.nav,
            radius = nav.sim.unitRadius(u);
        const direct = nav.straightGoal(u, goal, radius);
        if (direct) return direct;
        const point = nav.fieldsFor(radius).next(u.x, u.y, goal, radius);
        if (!point) nav.metrics.unreachable++;
        return point;
    }
}

class DirectPath {
    constructor(nav) {
        this.nav = nav;
    }
    // The goal's closest point when the unit's body clears the straight line to it; otherwise unreachable.
    // How far a unit may look for such a goal is the caller's choice of goal.
    nextPoint(u, goal) {
        const nav = this.nav;
        nav.sync();
        return nav.directGoal(u.x, u.y, goal, nav.sim.unitRadius(u));
    }
}

const ROUTE_CELLS = [];
const ROUTE_OPTIONS = Object.freeze({});

// Unit.route = { goalA, goalB, layout, cells, index } is authoritative state: the goal key the unit is headed for, the
// building layout signature the route was checked against, its waypoint cells on the unit's radius grid and the
// waypoint the unit is heading for. `cells` is null while the goal is held by a straight ray (not searched yet)
// and empty when the goal was unreachable on that layout. Every search decision reads only that state, the unit's
// position and the layout, so peers, replays and restored saves search on the same ticks.
class RoutePath {
    // Half a grid cell: a waypoint this close counts as passed even when a wall corner hides the next one.
    static REACH = GoalFields.CELL / 2;

    constructor(nav) {
        this.nav = nav;
    }
    nextPoint(u, goal) {
        const nav = this.nav,
            radius = nav.sim.unitRadius(u);
        nav.sync();
        const direct = nav.straightGoal(u, goal, radius);
        if (direct) return direct;
        const fields = nav.fieldsFor(radius);
        let route = this.plan(u, goal, fields, radius);
        if (!route) {
            nav.metrics.unreachable++;
            return null;
        }
        const finder = fields.routes,
            clear = this.lineClear(radius);
        let index = finder.advance(
            route.cells,
            route.index,
            u.x,
            u.y,
            RoutePath.REACH,
            this.shortcutClear(radius),
        );
        // Pushed off the route (knockback, crowding): neither the waypoint ahead nor the one behind is in sight.
        if (!this.inSight(fields, route.cells, index, u, clear)) {
            route = this.search(u, goal, fields, radius);
            if (!route.cells.length) {
                nav.metrics.unreachable++;
                return null;
            }
            index = finder.advance(
                route.cells,
                0,
                u.x,
                u.y,
                RoutePath.REACH,
                this.shortcutClear(radius),
            );
        }
        route.index = index;
        const cell = route.cells[index];
        return { x: fields.grid.centerX(cell), y: fields.grid.centerY(cell) };
    }
    // Whether `goal` can be walked to now: a clear straight ray, or a kept or newly searched route. The goal
    // becomes the route's goal either way, so a caller choosing among goals keeps this one.
    reaches(u, goal) {
        const nav = this.nav,
            radius = nav.sim.unitRadius(u);
        nav.sync();
        const fields = nav.fieldsFor(radius);
        if (nav.straightGoal(u, goal, radius)) {
            if (!this.follows(u, goal, fields))
                u.route = {
                    goalA: fields.keyA(goal),
                    goalB: goal.keyB,
                    layout: nav.topology.signature,
                    cells: null,
                    index: 0,
                };
            return true;
        }
        return !!this.plan(u, goal, fields, radius);
    }
    // Whether the kept route was made for `goal` (the same two-integer key the flow fields use).
    follows(u, goal, fields = this.nav.fieldsFor(this.nav.sim.unitRadius(u))) {
        const route = u.route;
        return !!route && route.goalA === fields.keyA(goal) && route.goalB === goal.keyB;
    }
    // Whether the kept route already found `goal` unreachable on the current layout.
    knownUnreachable(u, goal) {
        const route = u.route;
        if (!this.follows(u, goal) || route.cells?.length !== 0) return false;
        this.nav.sync();
        return route.layout === this.nav.topology.signature;
    }
    // The kept route to `goal`, searched only when the goal changed or the layout changed under its remaining
    // part. Null when `goal` is unreachable.
    plan(u, goal, fields, radius) {
        const layout = this.nav.topology.signature;
        let route = u.route;
        if (!this.follows(u, goal, fields) || !route.cells)
            route = this.search(u, goal, fields, radius);
        else if (route.layout !== layout) {
            if (!route.cells.length || this.blocked(fields, route, u, radius))
                route = this.search(u, goal, fields, radius);
            else route.layout = layout;
        }
        return route.cells.length ? route : null;
    }
    search(u, goal, fields, radius) {
        this.nav.metrics.routeSearches++;
        const finder = fields.routes,
            start = this.entryCell(fields, u.x, u.y, radius),
            goalCells = start < 0 ? null : fields.goalSources(goal),
            // A goal in another connected component is unreachable without running A*.
            found =
                start < 0 || !fields.reachable(start, goalCells)
                    ? null
                    : finder.find(start, goalCells, ROUTE_OPTIONS, ROUTE_CELLS);
        return (u.route = {
            goalA: fields.keyA(goal),
            goalB: goal.keyB,
            layout: this.nav.topology.signature,
            cells: found ? finder.waypoints(found, this.shortcutClear(radius), []) : [],
            index: 0,
        });
    }
    // The remaining route from the last passed waypoint (or the unit, before the first) to its end.
    blocked(fields, route, u, radius) {
        const grid = fields.grid,
            from = route.index > 0 ? route.cells[route.index - 1] : -1;
        return !fields.routes.remainingClear(
            route.cells,
            route.index,
            from < 0 ? u.x : grid.centerX(from),
            from < 0 ? u.y : grid.centerY(from),
            this.lineClear(radius),
        );
    }
    inSight(fields, cells, index, u, clear) {
        const grid = fields.grid,
            seen = (cell) => clear(u.x, u.y, grid.centerX(cell), grid.centerY(cell));
        return seen(cells[index]) || (index > 0 && seen(cells[index - 1]));
    }
    // The route starts from an open cell whose centre the unit's body can actually reach in a straight line.
    entryCell(fields, x, y, radius) {
        const grid = fields.grid,
            cell = grid.cellAt(x, y),
            nearest = grid.nearestOpen(cell);
        if (nearest >= 0 && fields.clearCell(x, y, nearest, radius)) return nearest;
        const col = cell % grid.cols,
            row = Math.floor(cell / grid.cols);
        for (let ring = 1; ring <= GoalFields.ENTRY_RINGS; ring++)
            for (let dy = -ring; dy <= ring; dy++)
                for (let dx = -ring; dx <= ring; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                    const c = col + dx,
                        r = row + dy;
                    if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue;
                    const candidate = r * grid.cols + c;
                    if (grid.isOpen(candidate) && fields.clearCell(x, y, candidate, radius))
                        return candidate;
                }
        return -1;
    }
    lineClear(radius) {
        const field = this.nav.field;
        return (x0, y0, x1, y1) => field.segmentClear(x0, y0, x1, y1, radius, null, true, 0);
    }
    // A line that may replace part of the searched route: clear, and not cutting across water the route goes
    // around. Whether the unit still sees its route (inSight, blocked) stays the plain line test.
    shortcutClear(radius) {
        const nav = this.nav,
            field = nav.field;
        return (x0, y0, x1, y1) =>
            !nav.crossesSlowerGround(x0, y0, x1, y1) &&
            field.segmentClear(x0, y0, x1, y1, radius, null, true, 0);
    }
}

export { DirectPath, FieldPath, RoutePath };
