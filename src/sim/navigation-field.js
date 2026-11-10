// Grid distance fields: how a grain finds its way across terrain.
// GameKit's pathfield walks the grid; this file is the policy on top of it: which cells satisfy a goal, which
// fields are kept, and which cell of the descent a unit actually heads for.
// A field is the integer walking distance to a goal over cells that clear the unit radius. Units only read it:
// descend a few cells, then slide to the farthest cell on that descent they can still see.
// The same grid also searches single routes (RouteFinder) for units that keep their own route (navigation-paths.js).
// Fixed goals (bases, flags, capture points) own a full field that is built once.
// A chase goal builds a field only while terrain blocks the straight ray, and only as far as the asking unit;
// units chasing the same point share it for the tick.
import { RallyGamekit } from '../core/gamekit.js';
const { DistanceField, FieldCache, PathGrid, RouteFinder, UNREACHED } = RallyGamekit;

const CELL = 24;
// The half-diagonal margin keeps thin annuli from vanishing between cell centres; the final approach is
// checked exactly against the goal, not against these cells.
const GOAL_MARGIN = CELL * 0.71;
const DESCENT = [];

class GoalFields {
    static CELL = CELL;
    static RAY_RANGE = 360;
    static LOOKAHEAD = 8;
    static MAX_FIXED = 24;
    // Rings searched for an entry cell when a unit stands in the grid's extra clearance near a wall or map edge.
    static ENTRY_RINGS = 4;

    constructor(nav, radius) {
        this.nav = nav;
        this.radius = radius;
        const safe = new Uint8Array(
            Math.ceil(nav.geometry.width / CELL) * Math.ceil(nav.geometry.height / CELL),
        );
        this.grid = new PathGrid({
            width: nav.geometry.width,
            height: nav.geometry.height,
            cellSize: CELL,
            passable: (x, y, cell) => {
                const band = nav.field.pointClearanceBand(x, y, radius, radius + GOAL_MARGIN);
                safe[cell] = band === 2 ? 1 : 0;
                return band !== 0;
            },
            passableEdge: (x, y, tx, ty, cell, nextCell) =>
                (safe[cell] === 1 && safe[nextCell] === 1) ||
                nav.field.segmentClear(x, y, tx, ty, radius, null, true, 0),
        });
        this.fixed = new FieldCache(this.grid, { capacity: GoalFields.MAX_FIXED });
        this.chase = new FieldCache(this.grid);
        this.routes = new RouteFinder(this.grid);
    }
    // Cells a unit can stand on while satisfying the goal.
    goalSources(goal) {
        const grid = this.grid,
            geometry = this.nav.geometry,
            sources = grid.openCellsWithin(
                goal.x,
                goal.y,
                goal.radius + GOAL_MARGIN,
                Math.max(0, goal.innerRadius - GOAL_MARGIN),
                goal.terrainLine
                    ? (x, y) => geometry.field.polygonSegmentClear(x, y, goal.x, goal.y, 0)
                    : null,
            );
        if (!sources.length) {
            const near = grid.nearestOpen(grid.cellAt(goal.x, goal.y), 24);
            if (near >= 0) {
                sources.push(near);
            }
        }
        return sources;
    }
    // The next point to walk toward from (x, y), or null when the goal is unreachable.
    next(x, y, goal, fixed, movementRadius) {
        const grid = this.grid,
            metrics = this.nav.metrics,
            cache = fixed ? this.fixed : this.chase;
        if (!fixed) {
            cache.sync(this.nav.sim.tick);
        }
        let field = cache.get(goal.key),
            begun = 0;
        if (!field) {
            begun = fixed ? performance.now() : 0;
            field = cache.set(goal.key, new DistanceField(grid, this.goalSources(goal)));
            metrics[fixed ? 'fieldsBuilt' : 'localFields']++;
        }
        const point = this.headingOf(x, y, field, movementRadius);
        if (begun) {
            metrics.fieldBuildMs += performance.now() - begun;
        }
        return point;
    }
    clearCell(x, y, cell, movementRadius) {
        return this.nav.field.segmentClear(
            x,
            y,
            this.grid.centerX(cell),
            this.grid.centerY(cell),
            movementRadius,
            null,
            true,
            0,
        );
    }
    headingOf(x, y, field, movementRadius) {
        const grid = this.grid;
        const cell = grid.cellAt(x, y),
            start = grid.nearestOpen(cell);
        if (start >= 0 && field.distance(start) !== UNREACHED) {
            const path = field.descend(start, GoalFields.LOOKAHEAD, DESCENT);
            // The cell-to-cell route is obstacle-aware, but the unit can be at
            // any position within its current cell. Check its actual first step.
            for (let i = path.length - 1; i >= 0; i--) {
                if (this.clearCell(x, y, path[i], movementRadius))
                    return { x: grid.centerX(path[i]), y: grid.centerY(path[i]) };
            }
            if (this.clearCell(x, y, start, movementRadius))
                return { x: grid.centerX(start), y: grid.centerY(start) };
        }
        // A unit can occupy the grid's extra clearance near a wall or map edge.
        // Find a physically reachable entry cell, not an unchecked nearest centre.
        const col = cell % grid.cols,
            row = Math.floor(cell / grid.cols);
        for (let ring = 1; ring <= GoalFields.ENTRY_RINGS; ring++) {
            let best = -1,
                bestCost = Infinity;
            for (let dy = -ring; dy <= ring; dy++)
                for (let dx = -ring; dx <= ring; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue;
                    const c = col + dx,
                        r = row + dy;
                    if (c < 0 || r < 0 || c >= grid.cols || r >= grid.rows) continue;
                    const candidate = r * grid.cols + c;
                    if (!grid.isOpen(candidate) || !this.clearCell(x, y, candidate, movementRadius))
                        continue;
                    const cost = field.distance(candidate);
                    if (cost !== UNREACHED && cost < bestCost) {
                        best = candidate;
                        bestCost = cost;
                    }
                }
            if (best >= 0) return { x: grid.centerX(best), y: grid.centerY(best) };
        }
        return null;
    }
    // Whether every point lies in the cells reachable from `from`; proves a generated map is connected.
    connected(from, points) {
        const grid = this.grid,
            reached = grid.reachableFrom(grid.nearestOpen(grid.cellAt(from.x, from.y), 4));
        return points.every((p) => {
            const cell = grid.nearestOpen(grid.cellAt(p.x, p.y), 4);
            return cell >= 0 && reached[cell] === 1;
        });
    }
}

export { GoalFields };
