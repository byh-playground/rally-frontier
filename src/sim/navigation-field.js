// Grid distance fields: how a grain finds its way across terrain.
// A field is the integer walking distance to a goal over cells that clear the
// unit radius. Units only read it: step to the cheapest neighbour, then slide
// to the farthest cell on that descent they can still see. No unit keeps a route.
// Fixed goals (bases, flags, capture points) own a full field that is built once.
// A chase goal builds a field only while terrain blocks the straight ray, and
// only as far as the asking unit; units chasing the same point share it.
import { FP } from '../core/config.js';

const CELL = 24;
const STRAIGHT = 10;
const DIAGONAL = 14;
const UNREACHED = 0x7fffffff;
// Fixed order is the tie-break, so every peer descends the same way.
const DIRECTIONS = Object.freeze([
    [1, 0, STRAIGHT], [0, 1, STRAIGHT], [-1, 0, STRAIGHT], [0, -1, STRAIGHT],
    [1, 1, DIAGONAL], [-1, 1, DIAGONAL], [-1, -1, DIAGONAL], [1, -1, DIAGONAL],
]);

// Min-heap of (cost, cell) packed into one number, so ties resolve by cell index.
class CellHeap {
    constructor() {
        this.keys = [];
    }
    get size() {
        return this.keys.length;
    }
    clear() {
        this.keys.length = 0;
    }
    push(cost, cell) {
        const K = this.keys;
        let i = K.length;
        const key = cost * 65536 + cell;
        K.push(key);
        while (i > 0) {
            const parent = (i - 1) >> 1;
            if (K[parent] <= key) {
                break;
            }
            K[i] = K[parent];
            i = parent;
        }
        K[i] = key;
    }
    pop() {
        const K = this.keys,
            top = K[0],
            last = K.pop();
        if (K.length) {
            let i = 0;
            for (;;) {
                let child = 2 * i + 1;
                if (child >= K.length) {
                    break;
                }
                if (child + 1 < K.length && K[child + 1] < K[child]) {
                    child++;
                }
                if (K[child] >= last) {
                    break;
                }
                K[i] = K[child];
                i = child;
            }
            K[i] = last;
        }
        return top;
    }
}

class DistanceField {
    constructor(grid, sources) {
        this.grid = grid;
        this.dist = new Int32Array(grid.size).fill(UNREACHED);
        this.heap = new CellHeap();
        this.sources = new Set(sources);
        for (const cell of sources) {
            this.dist[cell] = 0;
            this.heap.push(0, cell);
        }
        this.done = !sources.length;
    }
    // Settles cells in distance order until `target` is final (or the map is exhausted).
    settle(target = -1) {
        const grid = this.grid,
            { cols, rows } = grid,
            dist = this.dist,
            heap = this.heap;
        while (heap.size) {
            // `target` is final once nothing cheaper than it remains in the heap.
            if (target >= 0 && dist[target] < Math.floor(heap.keys[0] / 65536)) {
                return;
            }
            const key = heap.pop(),
                cell = key % 65536,
                cost = (key - cell) / 65536;
            if (cost > dist[cell]) {
                continue;
            }
            const cx = cell % cols,
                cy = (cell - cx) / cols;
            for (const [dx, dy, step] of DIRECTIONS) {
                const nx = cx + dx,
                    ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) {
                    continue;
                }
                const next = ny * cols + nx;
                if (!grid.isOpen(next)) {
                    continue;
                }
                // No corner cutting: a diagonal needs both orthogonal cells open.
                if (dx && dy && (!grid.isOpen(cy * cols + nx) || !grid.isOpen(ny * cols + cx))) {
                    continue;
                }
                const total = cost + step;
                if (total < dist[next]) {
                    dist[next] = total;
                    heap.push(total, next);
                }
            }
        }
        this.done = true;
    }
    settled(cell) {
        return this.dist[cell] !== UNREACHED && (this.done || this.dist[cell] < Math.floor(this.heap.keys[0] / 65536));
    }
}

class NavigationGrid {
    static CELL = CELL;
    static RAY_RANGE = 360;
    static LOOKAHEAD = 8;
    static MAX_FIELDS = 24;

    constructor(nav, radius) {
        const geometry = nav.geometry;
        this.nav = nav;
        this.radius = radius;
        this.cols = Math.ceil(geometry.width / CELL);
        this.rows = Math.ceil(geometry.height / CELL);
        this.size = this.cols * this.rows;
        this.reset();
    }
    reset() {
        this.open = new Int8Array(this.size).fill(-1);
        this.fields = new Map();
        this.local = { tick: -1, fields: new Map() };
        this.version = this.nav.topology.version;
    }
    cellAt(x, y) {
        const cx = Math.min(this.cols - 1, Math.max(0, Math.floor(x / CELL))),
            cy = Math.min(this.rows - 1, Math.max(0, Math.floor(y / CELL)));
        return cy * this.cols + cx;
    }
    centerX(cell) {
        return ((cell % this.cols) + 0.5) * CELL;
    }
    centerY(cell) {
        return (Math.floor(cell / this.cols) + 0.5) * CELL;
    }
    isOpen(cell) {
        let open = this.open[cell];
        if (open < 0) {
            open = this.nav.field.segmentClear(this.centerX(cell), this.centerY(cell), this.centerX(cell), this.centerY(cell), this.radius) ? 1 : 0;
            this.open[cell] = open;
        }
        return open === 1;
    }
    // The closest open cell by growing square rings; ties resolve by scan order.
    nearestOpen(cell, maxRing = 12) {
        if (this.isOpen(cell)) {
            return cell;
        }
        const cx = cell % this.cols,
            cy = (cell - cx) / this.cols;
        for (let ring = 1; ring <= maxRing; ring++) {
            let best = -1,
                bestD = Infinity;
            for (let dy = -ring; dy <= ring; dy++) {
                for (let dx = -ring; dx <= ring; dx++) {
                    if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) {
                        continue;
                    }
                    const nx = cx + dx,
                        ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) {
                        continue;
                    }
                    const next = ny * this.cols + nx,
                        d = dx * dx + dy * dy;
                    if (d < bestD && this.isOpen(next)) {
                        best = next;
                        bestD = d;
                    }
                }
            }
            if (best >= 0) {
                return best;
            }
        }
        return -1;
    }
    // Cells a unit can stand on while satisfying the goal. The half-diagonal margin
    // keeps thin annuli from vanishing between cell centres; the final approach is
    // checked exactly against the goal, not against these cells.
    goalSources(goal) {
        const margin = CELL * 0.71,
            outer = goal.radius + margin,
            inner = Math.max(0, goal.innerRadius - margin),
            sources = [];
        const x0 = Math.max(0, Math.floor((goal.x - outer) / CELL)),
            x1 = Math.min(this.cols - 1, Math.floor((goal.x + outer) / CELL)),
            y0 = Math.max(0, Math.floor((goal.y - outer) / CELL)),
            y1 = Math.min(this.rows - 1, Math.floor((goal.y + outer) / CELL)),
            geometry = this.nav.geometry;
        for (let cy = y0; cy <= y1; cy++) {
            for (let cx = x0; cx <= x1; cx++) {
                const cell = cy * this.cols + cx,
                    x = this.centerX(cell),
                    y = this.centerY(cell),
                    d = Math.hypot(x - goal.x, y - goal.y);
                if (d > outer || d < inner || !this.isOpen(cell)) {
                    continue;
                }
                if (goal.terrainLine && !geometry.field.polygonSegmentClear(x, y, goal.x, goal.y, 0)) {
                    continue;
                }
                sources.push(cell);
            }
        }
        if (!sources.length) {
            const near = this.nearestOpen(this.cellAt(goal.x, goal.y), 24);
            if (near >= 0) {
                sources.push(near);
            }
        }
        return sources;
    }
    // A goal's field. Fixed goals keep theirs; chase goals share one per tick.
    field(goal, fixed) {
        if (fixed) {
            let field = this.fields.get(goal.key);
            if (!field) {
                if (this.fields.size >= NavigationGrid.MAX_FIELDS) {
                    this.fields.delete(this.fields.keys().next().value);
                }
                field = new DistanceField(this, this.goalSources(goal));
                this.fields.set(goal.key, field);
            }
            return field;
        }
        const tick = this.nav.sim.tick;
        if (this.local.tick !== tick) {
            this.local = { tick, fields: new Map() };
        }
        let field = this.local.fields.get(goal.key);
        if (!field) {
            field = new DistanceField(this, this.goalSources(goal));
            this.local.fields.set(goal.key, field);
        }
        return field;
    }
    // The next point to walk toward from (x, y), or null when the goal is unreachable.
    next(x, y, goal, fixed) {
        const field = this.field(goal, fixed),
            start = this.nearestOpen(this.cellAt(x, y));
        if (start < 0) {
            return null;
        }
        field.settle(start);
        if (field.dist[start] === UNREACHED) {
            return null;
        }
        const path = [];
        let cell = start;
        for (let i = 0; i < NavigationGrid.LOOKAHEAD && !field.sources.has(cell); i++) {
            const cx = cell % this.cols,
                cy = (cell - cx) / this.cols;
            let best = -1,
                bestDist = field.dist[cell];
            for (const [dx, dy] of DIRECTIONS) {
                const nx = cx + dx,
                    ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) {
                    continue;
                }
                const next = ny * this.cols + nx;
                // Anything cheaper than this cell is already settled by construction.
                if (field.dist[next] < bestDist && this.isOpen(next) && (!dx || !dy || (this.isOpen(cy * this.cols + nx) && this.isOpen(ny * this.cols + cx)))) {
                    best = next;
                    bestDist = field.dist[next];
                }
            }
            if (best < 0) {
                break;
            }
            path.push(best);
            cell = best;
        }
        if (!path.length) {
            return { x: this.centerX(start), y: this.centerY(start) };
        }
        // Take the farthest cell on the descent that is physically visible.
        for (let i = path.length - 1; i > 0; i--) {
            const px = this.centerX(path[i]),
                py = this.centerY(path[i]);
            if (this.nav.field.segmentClear(x, y, px, py, this.radius, null, true, 0)) {
                return { x: px, y: py };
            }
        }
        return { x: this.centerX(path[0]), y: this.centerY(path[0]) };
    }
    // Cells reachable from (x, y); used to prove a generated map is connected.
    reachableFrom(x, y) {
        const start = this.nearestOpen(this.cellAt(x, y), 4),
            reached = new Uint8Array(this.size);
        if (start < 0) {
            return reached;
        }
        const stack = [start];
        reached[start] = 1;
        while (stack.length) {
            const cell = stack.pop(),
                cx = cell % this.cols,
                cy = (cell - cx) / this.cols;
            for (const [dx, dy] of DIRECTIONS) {
                const nx = cx + dx,
                    ny = cy + dy;
                if (nx < 0 || ny < 0 || nx >= this.cols || ny >= this.rows) {
                    continue;
                }
                const next = ny * this.cols + nx;
                if (reached[next] || !this.isOpen(next) || (dx && dy && (!this.isOpen(cy * this.cols + nx) || !this.isOpen(ny * this.cols + cx)))) {
                    continue;
                }
                reached[next] = 1;
                stack.push(next);
            }
        }
        return reached;
    }
}

export { DistanceField, NavigationGrid, UNREACHED };
