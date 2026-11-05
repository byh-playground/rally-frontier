// Grid distance fields: how a grain finds its way across terrain.
// GameKit's pathfield walks the grid; this file is the policy on top of it: which cells satisfy a goal, which
// fields are kept, and which cell of the descent a unit actually heads for.
// A field is the integer walking distance to a goal over cells that clear the unit radius. Units only read it:
// descend a few cells, then slide to the farthest cell on that descent they can still see. No unit keeps a route.
// Fixed goals (bases, flags, capture points) own a full field that is built once.
// A chase goal builds a field only while terrain blocks the straight ray, and only as far as the asking unit;
// units chasing the same point share it for the tick.
import { RallyGamekit } from '../core/gamekit.js';
const { DistanceField, FieldCache, PathGrid, UNREACHED } = RallyGamekit;

const CELL = 24;
// The half-diagonal margin keeps thin annuli from vanishing between cell centres; the final approach is
// checked exactly against the goal, not against these cells.
const GOAL_MARGIN = CELL * 0.71;
const DESCENT = [];

class GoalFields {
    static RAY_RANGE = 360;
    static LOOKAHEAD = 8;
    static MAX_FIXED = 24;

    constructor(nav, radius) {
        this.nav = nav;
        this.radius = radius;
        this.grid = new PathGrid({
            width: nav.geometry.width,
            height: nav.geometry.height,
            cellSize: CELL,
            passable: (x, y) => nav.field.pointClear(x, y, radius),
        });
        this.fixed = new FieldCache(this.grid, { capacity: GoalFields.MAX_FIXED });
        this.chase = new FieldCache(this.grid);
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
                goal.terrainLine ? (x, y) => geometry.field.polygonSegmentClear(x, y, goal.x, goal.y, 0) : null,
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
    next(x, y, goal, fixed) {
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
        const point = this.headingOf(x, y, field);
        if (begun) {
            metrics.fieldBuildMs += performance.now() - begun;
        }
        return point;
    }
    headingOf(x, y, field) {
        const grid = this.grid,
            start = grid.nearestOpen(grid.cellAt(x, y));
        if (start < 0 || field.distance(start) === UNREACHED) {
            return null;
        }
        const path = field.descend(start, GoalFields.LOOKAHEAD, DESCENT);
        if (!path.length) {
            return { x: grid.centerX(start), y: grid.centerY(start) };
        }
        // Take the farthest cell on the descent that is physically visible.
        for (let i = path.length - 1; i > 0; i--) {
            const px = grid.centerX(path[i]),
                py = grid.centerY(path[i]);
            if (this.nav.field.segmentClear(x, y, px, py, this.radius, null, true, 0)) {
                return { x: px, y: py };
            }
        }
        return { x: grid.centerX(path[0]), y: grid.centerY(path[0]) };
    }
    // Whether every point lies in the cells reachable from `from`; proves a generated map is connected.
    connected(from, points) {
        const grid = this.grid,
            reached = grid.reachableFrom(grid.nearestOpen(grid.cellAt(from.x, from.y), 4));
        return points.every(p => {
            const cell = grid.nearestOpen(grid.cellAt(p.x, p.y), 4);
            return cell >= 0 && reached[cell] === 1;
        });
    }
}

export { GoalFields };
