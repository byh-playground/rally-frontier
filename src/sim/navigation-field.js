// Hierarchical flow fields: how a grain finds its way across terrain.
// GameKit's pathfield walks the grid; this file is the policy on top of it: which cells satisfy a goal, how a goal
// is keyed, which building changes reach the grid, and which cell of the descent a unit actually heads for.
// Per unit radius bucket one PathGrid (24px cells that clear the radius, river cells costing twice the time) carries one PortalGraph (16-cell chunks,
// portal nodes on chunk borders, connected components). The graph keeps a flow field per goal key; a field is the
// integer walking cost to the goal and is computed only for the chunks units ask about. Units only read it:
// descend a few cells, then slide to the farthest cell on that descent they can still see.
// The same grid also searches single routes (RouteFinder) for units that keep their own route (navigation-paths.js).
// Goals stay keyed across ticks: a fixed goal (place, building, cannon) by its quantized centre and radii, a goal
// chasing a moving unit by the cell the unit stands in, so a field is built again only when that key changes.
// A building change invalidates only its own rectangle; the graph rebuilds the chunks it touches and drops goals.
import { RallyGamekit } from '../core/gamekit.js';
import { FP } from '../core/config.js';
const { PathGrid, PortalGraph, RouteFinder, UNREACHED } = RallyGamekit;

const CELL = 24;
// The half-diagonal margin keeps thin annuli from vanishing between cell centres; the final approach is
// checked exactly against the goal, not against these cells.
const GOAL_MARGIN = CELL * 0.71;
const DESCENT = [];

class GoalFields {
    static CELL = CELL;
    static RAY_RANGE = 360;
    static LOOKAHEAD = 8;
    // Rings searched for an entry cell when a unit stands in the grid's extra clearance near a wall or map edge.
    static ENTRY_RINGS = 4;

    constructor(nav, radius) {
        this.nav = nav;
        this.radius = radius;
        nav.readCellCosts();
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
            // Water is slower, so the fields and routes take the way that arrives first (TerrainNavigation.cellCost).
            cellCost: nav.maxCellCost > 1 ? (x, y, cell) => nav.cellCost(x, y, cell) : null,
            maxCellCost: nav.maxCellCost,
        });
        this.graph = new PortalGraph(this.grid);
        this.routes = new RouteFinder(this.grid);
        // A circle obstacle changes `passable` for cell centres within radius + GOAL_MARGIN of it and `passableEdge`
        // for segments within radius; one more cell covers an edge whose nearer end lies just outside.
        this.pad = radius + GOAL_MARGIN + CELL;
        this.sources = [];
        // The terrain-line test of the goal being resolved; one bound method instead of a closure per goal.
        this.lineX = 0;
        this.lineY = 0;
        this.acceptLine = (x, y) =>
            nav.geometry.field.polygonSegmentClear(x, y, this.lineX, this.lineY, 0);
        // Read before the next call: the point headingOf answers.
        this.point = { x: 0, y: 0 };
    }
    // A building record (NavigationTopology change) appeared, moved or disappeared: only its padded rectangle of
    // this grid is stale.
    obstacleChanged(record) {
        const pad = this.pad;
        this.grid.invalidateRect(
            record.minX - pad,
            record.minY - pad,
            record.maxX + pad,
            record.maxY + pad,
        );
    }
    // First half of a goal's key. Fixed goals use their quantized centre (NavigationGoal.pointKey < 2^40); a chase
    // goal uses the cell its target stands in (< 2^22 cells), so moves inside one cell keep the same field.
    keyA(goal) {
        return goal.fixed ? goal.pointKey : this.grid.cellAt(goal.x, goal.y);
    }
    // Cells a unit can stand on while satisfying the goal, a function of the goal's key alone: the centre is the
    // quantized centre (fixed) or the target cell's centre (chase), and the radii are the quantized radii.
    goalSources(goal, out = this.sources) {
        const grid = this.grid,
            cell = goal.fixed ? -1 : grid.cellAt(goal.x, goal.y),
            x = goal.fixed ? goal.xq / FP : grid.centerX(cell),
            y = goal.fixed ? goal.yq / FP : grid.centerY(cell);
        this.lineX = x;
        this.lineY = y;
        // A chase target stands up to half a cell diagonal (GOAL_MARGIN) from its cell centre, so the snapped centre
        // already carries that slack; adding the margin again would let a unit settle a full cell short of its reach.
        grid.openCellsWithin(
            x,
            y,
            goal.rq / FP + (goal.fixed ? GOAL_MARGIN : 0),
            Math.max(0, goal.iq / FP - GOAL_MARGIN),
            goal.terrainLine ? this.acceptLine : null,
            out,
        );
        if (!out.length) {
            const near = grid.nearestOpen(grid.cellAt(x, y), 24);
            if (near >= 0) out.push(near);
        }
        return out;
    }
    // The next point to walk toward from (x, y), or null when the goal is unreachable. The field is taken from the
    // graph's goal store every call (a FlowField is a reused slot and is never held across ticks).
    next(x, y, goal, movementRadius) {
        const graph = this.graph,
            keyA = this.keyA(goal),
            keyB = goal.keyB;
        let field = graph.goal(keyA, keyB),
            begun = 0;
        if (!field) {
            begun = performance.now();
            field = graph.setGoal(keyA, keyB, this.goalSources(goal));
            this.nav.metrics[goal.fixed ? 'fieldsBuilt' : 'localFields']++;
        }
        const point = this.headingOf(x, y, field, movementRadius);
        if (begun) this.nav.metrics.fieldBuildMs += performance.now() - begun;
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
    toCell(cell) {
        const point = this.point;
        point.x = this.grid.centerX(cell);
        point.y = this.grid.centerY(cell);
        return point;
    }
    headingOf(x, y, field, movementRadius) {
        const grid = this.grid;
        const cell = grid.cellAt(x, y),
            start = grid.nearestOpen(cell);
        if (start >= 0 && field.distance(start) !== UNREACHED) {
            const path = field.descend(start, GoalFields.LOOKAHEAD, DESCENT);
            // The cell-to-cell route is obstacle-aware, but the unit can be at
            // any position within its current cell. Check its actual first step.
            // A farther cell reached by a line across water the descent goes around is skipped (crossesSlowerGround).
            for (let i = path.length - 1; i >= 0; i--) {
                const cell = path[i];
                if (
                    !this.nav.crossesSlowerGround(x, y, grid.centerX(cell), grid.centerY(cell)) &&
                    this.clearCell(x, y, cell, movementRadius)
                )
                    return this.toCell(cell);
            }
            if (this.clearCell(x, y, start, movementRadius)) return this.toCell(start);
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
            if (best >= 0) return this.toCell(best);
        }
        return null;
    }
    // Whether some goal cell lies in the connected component of `start` (O(1) per cell, nothing is searched).
    reachable(start, cells) {
        const graph = this.graph,
            component = graph.component(start);
        if (component < 0) return false;
        for (let i = 0; i < cells.length; i++)
            if (graph.component(cells[i]) === component) return true;
        return false;
    }
    // Whether every point lies in the component reachable from `from`; proves a generated map is connected.
    connected(from, points) {
        const grid = this.grid,
            graph = this.graph,
            component = graph.component(grid.nearestOpen(grid.cellAt(from.x, from.y), 4));
        return points.every((p) => {
            const cell = grid.nearestOpen(grid.cellAt(p.x, p.y), 4);
            return cell >= 0 && component >= 0 && graph.component(cell) === component;
        });
    }
}

export { GoalFields };
