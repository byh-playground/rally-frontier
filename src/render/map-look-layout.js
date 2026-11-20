// A themed map's layout: everything the look draws, derived from the map's own geometry (size, spawns, lanes, capture
// points, blockers) by a theme's rules (definitions/map-themes.js). Pure data, no canvas and no renderer.
// Coordinates are WORLD coordinates: the layout is built once per map and is the same for both players; only the
// projection turns it for the guest. Anything that must look the same way up for both (shadows, height, highlights)
// is expressed by the drawing code as a screen-space offset, never baked into these positions.
// Every random choice comes from a hash of the map id, the theme id and a tag: the same map draws the same picture.
import { TerrainSurfaceAtlas } from '../sim/terrain.js';

const TAU = Math.PI * 2;
export const lerp = (a, b, t) => a + (b - a) * t;
export const clamp = (value, low, high) => Math.max(low, Math.min(high, value));

function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i++) {
        hash ^= text.charCodeAt(i);
        hash = Math.imul(hash, 16777619);
    }
    return hash >>> 0;
}

// One independent stream of numbers in [0, 1) per tag.
export function randomSource(seedText) {
    return (tag) => {
        let a = hashText(`${seedText}:${tag}`);
        return () => {
            a = (a + 0x6d2b79f5) | 0;
            let t = Math.imul(a ^ (a >>> 15), 1 | a);
            t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
            return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
        };
    };
}

// The part of a map descriptor the look reads.
export function mapGeometry(descriptor) {
    return {
        width: descriptor.width,
        height: descriptor.height,
        spawns: ['host', 'guest'].map((role) => ({ role, ...descriptor.spawns[role] })),
        lanes: Object.entries(descriptor.laneControlPoints).map(([key, points]) => ({
            key,
            points,
        })),
        capturePoints: descriptor.capturePoints,
        blockers: descriptor.terrain?.blockers || [],
        // Raised ground, as the simulation builds it from the map's layers and ramps: tops, cliff faces, ramps.
        surfaces: TerrainSurfaceAtlas.fromMap(descriptor),
    };
}

// A wobbly closed outline around (x, y): [[x, y], ...].
export function blobPoints(x, y, rx, ry, rotation, R, wobble = 1, count = 22) {
    const p1 = R() * TAU,
        p2 = R() * TAU,
        p3 = R() * TAU,
        a1 = 0.16 * wobble * (0.6 + R() * 0.8),
        a2 = 0.1 * wobble * (0.6 + R() * 0.8),
        a3 = 0.06 * wobble,
        cos = Math.cos(rotation),
        sin = Math.sin(rotation),
        points = [];
    for (let i = 0; i < count; i++) {
        const t = (i / count) * TAU,
            k =
                1 +
                a1 * Math.sin(2 * t + p1) +
                a2 * Math.sin(3 * t + p2) +
                a3 * Math.sin(5 * t + p3),
            lx = Math.cos(t) * rx * k,
            ly = Math.sin(t) * ry * k;
        points.push([x + lx * cos - ly * sin, y + lx * sin + ly * cos]);
    }
    return points;
}

export function pointInPolygon(x, y, points) {
    let inside = false;
    for (let i = 0, j = points.length - 1; i < points.length; j = i++) {
        const [xi, yi] = points[i],
            [xj, yj] = points[j];
        if (yi > y !== yj > y && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

function segmentDistance(px, py, ax, ay, bx, by) {
    const vx = bx - ax,
        vy = by - ay,
        t = clamp(((px - ax) * vx + (py - ay) * vy) / (vx * vx + vy * vy || 1), 0, 1);
    return Math.hypot(px - ax - vx * t, py - ay - vy * t);
}

// Raised ground as the look paints it, from the terrain atlas of the map (sim/terrain.js): the flat tops and the
// ramps as triangles with a height at each corner, the vertical faces between two heights, and the rims (the top
// lines of those faces, joined into runs) a theme lines with a wall. A face on the map's own edge has no rim: the
// boundary stands there. Heights are world heights, as units and buildings stand on them.
function raisedGround(surfaces, W, H) {
    const onBorder = (a, b) =>
        (a.x === b.x && (a.x === 0 || a.x === W)) || (a.y === b.y && (a.y === 0 || a.y === H));
    const triangles = [];
    for (const patch of surfaces.renderSurfaceMesh) {
        if (patch.kind === 'cliff' || patch.id === 'low-ground') continue;
        for (const indices of patch.triangles) {
            const corners = indices.map((i) => patch.vertices[i]);
            triangles.push({
                ramp: patch.kind === 'ramp',
                points: corners.map((v) => [v.x, v.z]),
                heights: corners.map((v) => v.y),
            });
        }
    }
    const faces = surfaces.renderFaces.map((face) => ({
        a: [face.a.x, face.a.y],
        b: [face.b.x, face.b.y],
        low: [face.lowA, face.lowB],
        high: [face.highA ?? face.high, face.highB ?? face.high],
    }));
    // Faces come in order round each layer: one that starts where the last ended continues its rim.
    const rims = [];
    let rim = null,
        end = null;
    for (const face of surfaces.renderFaces) {
        if (onBorder(face.a, face.b)) {
            rim = end = null;
            continue;
        }
        const height = Math.max(face.highA ?? face.high, face.highB ?? face.high);
        if (!rim || end !== face.a || rim.height !== height)
            rims.push((rim = { height, points: [[face.a.x, face.a.y]] }));
        rim.points.push([face.b.x, face.b.y]);
        end = face.b;
    }
    const ramps = surfaces.ramps.map((ramp) => ({
        low: [ramp.lowA, ramp.lowB].map((p) => [p.x, p.y]),
        high: [ramp.highA, ramp.highB].map((p) => [p.x, p.y]),
        outline: [ramp.lowA, ramp.lowB, ramp.highB, ramp.highA].map((p) => [p.x, p.y]),
    }));
    return { triangles, faces, rims, ramps, heightAt: (x, y) => surfaces.heightAt(x, y) };
}

function polygonEdgeDistance(x, y, points) {
    let distance = Infinity;
    for (let i = 0; i < points.length; i++) {
        const a = points[i],
            b = points[(i + 1) % points.length];
        distance = Math.min(distance, segmentDistance(x, y, a[0], a[1], b[0], b[1]));
    }
    return distance;
}

// A lane as a smooth road: a Catmull-Rom curve through every control point, with a slow sideways wander.
function laneCurve(control, R, wobble) {
    const points = control.map((p) => [p.x, p.y]),
        out = [];
    for (let i = 0; i < points.length - 1; i++) {
        const p0 = points[Math.max(0, i - 1)],
            p1 = points[i],
            p2 = points[i + 1],
            p3 = points[Math.min(points.length - 1, i + 2)],
            steps = Math.max(4, Math.ceil(Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) / 40));
        for (let k = 0; k < steps; k++) {
            const t = k / steps,
                t2 = t * t,
                t3 = t2 * t,
                at = (a, b, c, d) =>
                    0.5 *
                    (2 * b +
                        (-a + c) * t +
                        (2 * a - 5 * b + 4 * c - d) * t2 +
                        (-a + 3 * b - 3 * c + d) * t3);
            out.push([at(p0[0], p1[0], p2[0], p3[0]), at(p0[1], p1[1], p2[1], p3[1])]);
        }
    }
    out.push(points[points.length - 1]);
    const phase1 = R() * TAU,
        phase2 = R() * TAU;
    let travelled = 0;
    return out.map((p, i) => {
        if (i) travelled += Math.hypot(p[0] - out[i - 1][0], p[1] - out[i - 1][1]);
        const a = out[Math.max(0, i - 1)],
            b = out[Math.min(out.length - 1, i + 1)],
            tx = b[0] - a[0],
            ty = b[1] - a[1],
            length = Math.hypot(tx, ty) || 1,
            // The road still starts and ends exactly on its end points.
            fade = Math.min(1, i / 6, (out.length - 1 - i) / 6),
            offset =
                wobble *
                fade *
                (Math.sin(travelled / 260 + phase1) * 0.7 +
                    Math.sin(travelled / 113 + phase2) * 0.3);
        return [p[0] - (ty / length) * offset, p[1] + (tx / length) * offset];
    });
}

const angleDifference = (a, b) => Math.abs(((a - b + Math.PI * 3) % TAU) - Math.PI);

// The directions in which lanes leave a base.
function exitAngles(base, lanes) {
    const out = [];
    for (const { points } of lanes)
        for (const [end, next] of [
            [points[0], points[1]],
            [points[points.length - 1], points[points.length - 2]],
        ])
            if (Math.hypot(end.x - base.x, end.y - base.y) < 1)
                out.push(Math.atan2(next.y - base.y, next.x - base.x));
    return out;
}

// The arcs of a full turn that stay `gap` radians clear of every exit: [[start, end], ...].
function arcsClearOf(exits, gap) {
    const out = [];
    let start = null;
    for (let a = 0; a <= TAU + 0.001; a += 0.02) {
        const free = !exits.some((exit) => angleDifference(a, exit) < gap);
        if (free && start === null) start = a;
        if ((!free || a >= TAU) && start !== null) {
            out.push([start, a]);
            start = null;
        }
    }
    return out;
}

// The map boundary as four sides, each walked from `from` along `along`, with its outward normal.
function boundarySides(W, H) {
    return [
        { from: [0, 0], along: [1, 0], normal: [0, -1], length: W },
        { from: [W, 0], along: [0, 1], normal: [1, 0], length: H },
        { from: [W, H], along: [-1, 0], normal: [0, 1], length: W },
        { from: [0, H], along: [0, -1], normal: [-1, 0], length: H },
    ];
}

export function buildMapLook(geometry, theme, seedText) {
    const random = randomSource(seedText),
        { width: W, height: H } = geometry,
        area = (W * H) / 1e6,
        sides = boundarySides(W, H),
        edge = 2 * (W + H),
        blockerPolygons = geometry.blockers.map((b) => b.points.map((p) => [p.x, p.y]));
    const insideMap = (x, y, inset = 0) => x > inset && y > inset && x < W - inset && y < H - inset;
    const insideBlocker = (x, y) => blockerPolygons.some((points) => pointInPolygon(x, y, points));
    // ---- raised ground ----
    const terrain = raisedGround(geometry.surfaces, W, H),
        { heightAt } = terrain;
    const onRamp = (x, y) => terrain.ramps.some((ramp) => pointInPolygon(x, y, ramp.outline));
    // Distance to the nearest cliff, ramp wall or ramp: decoration keeps clear of them.
    const terrainEdgeDistance = (x, y) => {
        if (onRamp(x, y)) return 0;
        let distance = Infinity;
        for (const { a, b } of terrain.faces)
            distance = Math.min(distance, segmentDistance(x, y, a[0], a[1], b[0], b[1]));
        for (const ramp of terrain.ramps)
            distance = Math.min(distance, polygonEdgeDistance(x, y, ramp.outline));
        return distance;
    };
    // A point `t` (0..1) of the way round the boundary, pushed `out` units outward.
    const boundaryPoint = (t, out) => {
        let left = (((t % 1) + 1) % 1) * edge;
        for (const side of sides) {
            if (left <= side.length)
                return [
                    side.from[0] + side.along[0] * left + side.normal[0] * out,
                    side.from[1] + side.along[1] * left + side.normal[1] * out,
                ];
            left -= side.length;
        }
        return [0, -out];
    };

    // ---- roads ----
    const laneRandom = random('lanes');
    const lanes = geometry.lanes.map(({ key, points }) => ({
        key,
        width: theme.lanes.width[key] ?? theme.lanes.width.side,
        points: laneCurve(points, laneRandom, theme.lanes.wobble),
    }));
    // Distance from the nearest road's centre line, and from its edge (negative on the road).
    const laneCentreDistance = (x, y) => {
        let distance = Infinity;
        for (const lane of lanes)
            for (let i = 0; i < lane.points.length - 1; i++)
                distance = Math.min(
                    distance,
                    segmentDistance(x, y, ...lane.points[i], ...lane.points[i + 1]),
                );
        return distance;
    };
    const laneDistance = (x, y) => {
        let distance = Infinity;
        for (const lane of lanes)
            for (let i = 0; i < lane.points.length - 1; i++)
                distance = Math.min(
                    distance,
                    segmentDistance(x, y, ...lane.points[i], ...lane.points[i + 1]) -
                        lane.width / 2,
                );
        return distance;
    };

    // ---- bases ----
    const bases = geometry.spawns.map((spawn, index) => {
        const R = random('base:' + spawn.role),
            { radius, ruts, band, flags } = theme.base,
            exits = exitAngles(spawn, geometry.lanes),
            // Flags stand on the rim opposite the exits (away from the map centre when no lane leaves the base).
            back = exits.length
                ? Math.atan2(
                      exits.reduce((sum, a) => sum + Math.sin(a), 0),
                      exits.reduce((sum, a) => sum + Math.cos(a), 0),
                  ) + Math.PI
                : Math.atan2(spawn.y - H / 2, spawn.x - W / 2);
        return {
            role: spawn.role,
            side: index,
            x: spawn.x,
            y: spawn.y,
            height: heightAt(spawn.x, spawn.y),
            radius,
            rim: blobPoints(spawn.x, spawn.y, radius + 22, radius + 22, 0, R, 0.35),
            fill: blobPoints(spawn.x, spawn.y, radius, radius, 0, R, 0.25),
            ruts: ruts.flatMap((rutRadius, ring) =>
                arcsClearOf(exits, 0.5).map(([start, end]) => ({
                    ring,
                    radius: rutRadius,
                    start: start + R() * 0.18,
                    end: end - 0.1,
                })),
            ),
            band: arcsClearOf(exits, band.exitGap).map(([start, end]) => ({
                radius: radius - band.inset,
                width: band.width,
                start: start + 0.05,
                end: end - 0.05,
            })),
            flags: Array.from({ length: flags.count }, (_, i) => {
                const offset = flags.count > 1 ? (i / (flags.count - 1)) * 2 - 1 : 0,
                    angle = back + offset * flags.spread;
                const x = spawn.x + Math.cos(angle) * (radius - flags.inset),
                    y = spawn.y + Math.sin(angle) * (radius - flags.inset);
                return { x, y, height: heightAt(x, y), scale: offset === 0 ? 0.85 : 0.72 };
            }),
        };
    });

    // ---- capture point yards ----
    // Yards of one kind cycle through its variants in hash order, so neighbours rarely match and every variant shows.
    const variantOf = new Map();
    for (const [resource, rule] of Object.entries(theme.yards)) {
        if (!rule.variants) continue;
        geometry.capturePoints
            .filter((point) => point.resourceType === resource)
            .map((point) => ({ id: point.id, order: hashText(`${seedText}:variant:${point.id}`) }))
            .sort((a, b) => a.order - b.order)
            .forEach(({ id }, index) => variantOf.set(id, index % rule.variants));
    }
    const yards = geometry.capturePoints.map((point) => {
        const rule = theme.yards[point.resourceType],
            R = random('yard:' + point.id),
            { x, y } = point;
        if (rule.kind === 'straw') {
            const radius = rule.radius;
            return {
                kind: 'straw',
                x,
                y,
                radius,
                variant: variantOf.get(point.id),
                rim: blobPoints(x, y, radius + 18, radius + 16, R() * 3, R, 0.45),
                fill: blobPoints(x, y, radius, radius * 0.96, R() * 3, R, 0.35),
            };
        }
        // A point no side starts with (stage 0) is the contested one: its own size and outline.
        const contested = point.stage === 0 ? rule.contested : null,
            radius = contested?.radius ?? rule.radius,
            rings = (
                contested
                    ? [
                          [0.31, 0.63, 10],
                          [0.65, 0.97, 18],
                      ]
                    : [
                          [0.34, 0.66, 9],
                          [0.68, 0.97, 15],
                      ]
            ).map(([inner, outer, count]) => ({
                inner: inner * radius,
                outer: outer * radius,
                stones: Array.from({ length: count }, () => Math.floor(R() * 3)),
            }));
        return { kind: 'paving', x, y, radius, sides: contested?.sides ?? 0, rings };
    });

    // Where decoration must not go: on or beside a road, a base, a yard, a cliff or a ramp.
    const terrainClearance = theme.terrain.decorClearance;
    const reserved = (x, y, pad = 0) =>
        laneDistance(x, y) < 40 + pad ||
        terrainEdgeDistance(x, y) < terrainClearance + pad ||
        bases.some((b) => Math.hypot(x - b.x, y - b.y) < b.radius + 70 + pad) ||
        yards.some((yard) => Math.hypot(x - yard.x, y - yard.y) < yard.radius + 75 + pad);

    // ---- blockers: a bed of bare earth and a pile of stones that stays inside the polygon ----
    const rockRandom = random('rocks');
    const rocks = blockerPolygons.map((points, index) => {
        const cx = points.reduce((sum, p) => sum + p[0], 0) / points.length,
            cy = points.reduce((sum, p) => sum + p[1], 0) / points.length,
            // The pile stands on the ground its middle is on: where the polygon runs into a hill, no stone.
            height = heightAt(cx, cy),
            ux = points[1][0] - points[0][0],
            uy = points[1][1] - points[0][1],
            length = Math.hypot(ux, uy) || 1,
            // Half extents along the first edge and across it.
            along = points.map((p) => ((p[0] - cx) * ux + (p[1] - cy) * uy) / length),
            across = points.map((p) => (-(p[0] - cx) * uy + (p[1] - cy) * ux) / length),
            half = (values) => (Math.max(...values) - Math.min(...values)) / 2,
            xs = points.map((p) => p[0]),
            ys = points.map((p) => p[1]),
            minX = Math.min(...xs),
            maxX = Math.max(...xs),
            minY = Math.min(...ys),
            maxY = Math.max(...ys),
            stones = [];
        const bed = blobPoints(
            cx,
            cy,
            half(along) + 95,
            half(across) + 95,
            Math.atan2(uy, ux),
            rockRandom,
            0.8,
        );
        for (const target of theme.blockers.stoneRadii)
            for (let attempt = 0; attempt < 260; attempt++) {
                const x = lerp(minX, maxX, rockRandom()),
                    y = lerp(minY, maxY, rockRandom()),
                    r = target * (0.9 + rockRandom() * 0.2);
                if (!pointInPolygon(x, y, points) || polygonEdgeDistance(x, y, points) < r)
                    continue;
                if (heightAt(x, y) !== height || terrainEdgeDistance(x, y) < r) continue;
                if (stones.some((s) => Math.hypot(s.x - x, s.y - y) < (s.r + r) * 0.62)) continue;
                stones.push({ x, y, r, lift: 0, height: r * (0.62 + rockRandom() * 0.3) });
                break;
            }
        // Smaller stones resting on the biggest ones; their footprint is still inside the polygon.
        for (const under of [...stones]
            .sort((a, b) => b.r - a.r)
            .slice(0, theme.blockers.stacked)) {
            const r = under.r * (0.48 + rockRandom() * 0.12),
                x = under.x + (rockRandom() - 0.5) * under.r * 0.5,
                y = under.y - under.r * 0.15;
            if (pointInPolygon(x, y, points) && polygonEdgeDistance(x, y, points) >= r)
                stones.push({ x, y, r, lift: under.height * 0.7, height: r * 0.7 });
        }
        for (const stone of stones) {
            stone.seed = Math.floor(rockRandom() * 0xffffffff);
            // Draw order, as a distance towards the viewer from the stone's centre: its front edge, a stacked
            // stone just after the one under it.
            stone.front = stone.r * 0.3 + (stone.lift ? 1 : 0);
        }
        // A tool leaning among the stones: the free spot nearest the polygon's edge.
        const tool = theme.blockers.tools[index];
        let lean = null;
        if (tool)
            for (let attempt = 0; attempt < 200; attempt++) {
                const x = lerp(minX, maxX, rockRandom()),
                    y = lerp(minY, maxY, rockRandom());
                if (!pointInPolygon(x, y, points) || heightAt(x, y) !== height) continue;
                const distance = polygonEdgeDistance(x, y, points);
                if (distance > 26 && (!lean || distance < lean.distance)) lean = { x, y, distance };
            }
        return {
            points,
            bed,
            stones,
            tool: lean && {
                kind: tool,
                x: lean.x,
                y: lean.y,
                // In front of every stone of the pile, whichever way up the map is seen: [host, guest].
                front: [
                    Math.max(...stones.map((s) => s.y + s.front), lean.y) + 1 - lean.y,
                    lean.y - Math.min(...stones.map((s) => s.y - s.front), lean.y) + 1,
                ],
            },
        };
    });

    // ---- ground texture inside the map ----
    const grassRandom = random('grass');
    const blotches = Array.from(
        { length: Math.round(theme.grass.blotchesPerMillion * area) },
        () => {
            const x = grassRandom() * W,
                y = grassRandom() * H,
                [low, high] = theme.grass.blotchRadius,
                r = lerp(low, high, grassRandom());
            return {
                points: blobPoints(
                    x,
                    y,
                    r,
                    r * (0.6 + grassRandom() * 0.5),
                    grassRandom() * 3,
                    grassRandom,
                    1.3,
                ),
                light: grassRandom() < 0.5,
            };
        },
    );
    const bladeRandom = random('blades'),
        blades = [],
        spacing = theme.grass.bladeSpacing;
    for (let gx = 0; gx < W; gx += spacing)
        for (let gy = 0; gy < H; gy += spacing) {
            const x = gx + bladeRandom() * spacing,
                y = gy + bladeRandom() * spacing,
                light = bladeRandom() < 0.55,
                size = (0.7 + bladeRandom() * 0.6) * 0.72;
            if (laneDistance(x, y) >= 30 && !onRamp(x, y)) blades.push({ x, y, light, size });
        }

    const dirtRandom = random('dirt'),
        dirtRule = theme.dirt,
        dirtCentres = [],
        dirt = [];
    for (
        let attempt = 0;
        dirtCentres.length < Math.round(dirtRule.patchesPerMillion * area) && attempt < 600;
        attempt++
    ) {
        // Beside the roads, where the ground is trodden dry.
        const lane = lanes[Math.floor(dirtRandom() * lanes.length)],
            p = lane.points[Math.floor(dirtRandom() * lane.points.length)],
            x = clamp(p[0] + (dirtRandom() - 0.5) * dirtRule.laneSpread, 150, W - 150),
            y = clamp(p[1] + (dirtRandom() - 0.5) * dirtRule.laneSpread, 150, H - 150);
        if (dirtCentres.some((q) => Math.hypot(q[0] - x, q[1] - y) < dirtRule.spacing)) continue;
        if (insideBlocker(x, y) || terrainEdgeDistance(x, y) < dirtRule.terrainClearance) continue;
        if (
            bases.some((b) => Math.hypot(x - b.x, y - b.y) < b.radius + dirtRule.baseClearance) ||
            yards.some(
                (yard) => Math.hypot(x - yard.x, y - yard.y) < yard.radius + dirtRule.yardClearance,
            )
        )
            continue;
        dirtCentres.push([x, y]);
    }
    for (const [x, y] of dirtCentres) {
        const direction = dirtRandom() * Math.PI,
            count = 2 + Math.floor(dirtRandom() * 2),
            parts = [];
        for (let k = 0; k < count; k++) {
            const step = (k - (count - 1) / 2) * (70 + dirtRandom() * 50),
                px = x + Math.cos(direction) * step + (dirtRandom() - 0.5) * 40,
                py = y + Math.sin(direction) * step + (dirtRandom() - 0.5) * 40,
                r = lerp(dirtRule.radius[0], dirtRule.radius[1], dirtRandom()),
                rotation = direction + (dirtRandom() - 0.5),
                fill = blobPoints(px, py, r, r * 0.62, rotation, dirtRandom, 1.4);
            parts.push({
                x: px,
                y: py,
                r,
                fill,
                // A few pebbly flecks, kept well inside the lobe.
                flecks: Array.from({ length: 3 + Math.floor(dirtRandom() * 3) }, () => {
                    const angle = dirtRandom() * TAU,
                        reach = dirtRandom() * 0.5;
                    return {
                        x: px + Math.cos(angle + rotation) * r * reach,
                        y: py + Math.sin(angle + rotation) * r * reach * 0.6,
                        size: 5 + dirtRandom() * 7,
                        light: dirtRandom() < 0.4,
                    };
                }),
                // The same outline a little larger: a thin darker rim instead of a blurred halo.
                rim: fill.map(([fx, fy]) => [px + (fx - px) * 1.07, py + (fy - py) * 1.09]),
                light:
                    dirtRandom() < 0.7
                        ? blobPoints(
                              px - r * 0.2,
                              py - r * 0.12,
                              r * 0.5,
                              r * 0.28,
                              rotation,
                              dirtRandom,
                              1.6,
                          )
                        : null,
            });
        }
        dirt.push(parts);
    }

    // ---- small ground decoration, in clusters ----
    const decorRandom = random('decor'),
        decorRule = theme.decor,
        clusterTotal = Math.round((decorRule.clustersPer1000Edge * edge) / 1000),
        small = [],
        clusterCounts = { outside: 0, blockers: 0, field: 0 };
    const cluster = (x, y, region) => {
        const count = 3 + Math.floor(decorRandom() * 3);
        let roll = decorRandom(),
            kind = null;
        for (const [name, share] of Object.entries(decorRule.kinds)) {
            kind = name;
            if ((roll -= share) < 0) break;
        }
        for (let k = 0; k < count; k++)
            small.push({
                kind,
                x: x + (decorRandom() - 0.5) * 70,
                y: y + (decorRandom() - 0.5) * 50,
                size: 0.7 + decorRandom() * 0.6,
                tone: decorRandom(),
            });
        clusterCounts[region]++;
    };
    const place = (region, wanted, sample) => {
        for (let attempt = 0; clusterCounts[region] < wanted && attempt < 3000; attempt++) {
            const point = sample();
            if (point) cluster(point[0], point[1], region);
        }
    };
    // On the bank, at its foot and in the grass beyond it.
    place('outside', Math.round(clusterTotal * decorRule.share.outside), () => {
        const [x, y] = boundaryPoint(decorRandom(), -60 + decorRandom() * 330);
        return insideMap(x, y) &&
            (laneDistance(x, y) < 60 || terrainEdgeDistance(x, y) < terrainClearance)
            ? null
            : [x, y];
    });
    // Around the blockers, never on walkable-looking ground further than their bed.
    if (blockerPolygons.length)
        place('blockers', Math.round(clusterTotal * decorRule.share.blockers), () => {
            const points = blockerPolygons[clusterCounts.blockers % blockerPolygons.length],
                xs = points.map((p) => p[0]),
                ys = points.map((p) => p[1]),
                x = lerp(Math.min(...xs) - 150, Math.max(...xs) + 150, decorRandom()),
                y = lerp(Math.min(...ys) - 150, Math.max(...ys) + 150, decorRandom()),
                distance = polygonEdgeDistance(x, y, points);
            if (pointInPolygon(x, y, points) ? distance > 30 : distance > 150) return null;
            return !insideMap(x, y, 40) || reserved(x, y, 10) ? null : [x, y];
        });
    // A few low tufts in the open field.
    place('field', Math.round(clusterTotal * decorRule.share.field), () => {
        const x = 200 + decorRandom() * (W - 400),
            y = 200 + decorRandom() * (H - 400);
        return reserved(x, y, 120) ||
            blockerPolygons.some(
                (points) => pointInPolygon(x, y, points) || polygonEdgeDistance(x, y, points) < 300,
            )
            ? null
            : [x, y];
    });

    // ---- standing props beyond the boundary ----
    const props = [];
    // One landmark behind each base: straight out from the map edge its base backs onto.
    geometry.spawns.forEach((spawn, index) => {
        const dx = spawn.x - W / 2 || 1e-6,
            dy = spawn.y - H / 2 || 1e-6,
            // Where the ray from the map centre through the base leaves the map.
            tx = (dx > 0 ? W - spawn.x : spawn.x) / Math.abs(dx),
            ty = (dy > 0 ? H - spawn.y : spawn.y) / Math.abs(dy),
            { kinds, offset, inset } = theme.landmarks,
            kind = kinds[index % kinds.length];
        if (tx < ty)
            props.push({
                kind,
                x: dx > 0 ? W + offset : -offset,
                y: clamp(spawn.y + dy * tx, inset, H - inset),
                scale: 1,
            });
        else
            props.push({
                kind,
                x: clamp(spawn.x + dx * ty, inset, W - inset),
                y: dy > 0 ? H + offset : -offset,
                scale: 1,
            });
    });
    const propRandom = random('props');
    for (const rule of theme.outside.props) {
        const count = rule.count ?? Math.max(1, Math.round((rule.per1000Edge * edge) / 1000)),
            phase = propRandom();
        for (let i = 0; i < count; i++)
            for (let attempt = 0; attempt < 20; attempt++) {
                const [x, y] = boundaryPoint(
                    phase + (i + 0.2 + 0.6 * propRandom()) / count,
                    lerp(rule.distance[0], rule.distance[1], propRandom()),
                );
                if (props.some((other) => Math.hypot(other.x - x, other.y - y) < 190)) continue;
                props.push({
                    kind: rule.kind,
                    x,
                    y,
                    scale: lerp(rule.scale[0], rule.scale[1], propRandom()),
                });
                break;
            }
    }

    // ---- fences: on each side of the map, the stretch farthest from every road ----
    const fenceRule = theme.boundary.fences;
    const fences = sides.map((side) => {
        const length = side.length * fenceRule.length,
            at = (distance, out = 0) => [
                side.from[0] + side.along[0] * distance + side.normal[0] * out,
                side.from[1] + side.along[1] * distance + side.normal[1] * out,
            ];
        let best = 0,
            bestScore = -Infinity;
        for (let start = 100; start <= side.length - length - 100; start += 50) {
            let score = Infinity;
            for (let d = start; d <= start + length; d += 100)
                score = Math.min(score, laneCentreDistance(...at(d)));
            if (score > bestScore) {
                bestScore = score;
                best = start;
            }
        }
        const posts = Math.max(2, Math.round(length / fenceRule.postSpacing));
        return Array.from({ length: posts + 1 }, (_, i) =>
            at(best + (length * i) / posts, fenceRule.offset),
        );
    });

    // ---- paddies beyond the bank ----
    const paddyRandom = random('paddies'),
        paddyRule = theme.outside.paddy,
        { margin } = theme.outside,
        columns = [],
        rows = [],
        paddies = [];
    for (
        let x = -margin.side - 300;
        x < W + margin.side + 300;
        x += lerp(paddyRule.width[0], paddyRule.width[1], paddyRandom())
    )
        columns.push(x);
    for (
        let y = -margin.far - 300;
        y < H + margin.far + 300;
        y += lerp(paddyRule.depth[0], paddyRule.depth[1], paddyRandom())
    )
        rows.push(y);
    const jitters = new Map();
    const jitter = (i, j) => {
        const key = i * 1000 + j;
        if (!jitters.has(key))
            jitters.set(key, [(paddyRandom() - 0.5) * 50, (paddyRandom() - 0.5) * 40]);
        return jitters.get(key);
    };
    const clear = paddyRule.clearance + 40;
    for (let i = 0; i < columns.length - 1; i++)
        for (let j = 0; j < rows.length - 1; j++) {
            const x0 = columns[i],
                x1 = columns[i + 1],
                y0 = rows[j],
                y1 = rows[j + 1];
            if (x1 > -clear && x0 < W + clear && y1 > -clear && y0 < H + clear) continue;
            const g = paddyRule.bund,
                quad = [
                    [x0, y0, i, j],
                    [x1, y0, i + 1, j],
                    [x1, y1, i + 1, j + 1],
                    [x0, y1, i, j + 1],
                ].map(([x, y, ci, cj]) => {
                    const [jx, jy] = jitter(ci, cj);
                    return [x + jx, y + jy];
                }),
                roll = paddyRandom(),
                kind =
                    roll < paddyRule.water
                        ? 'water'
                        : roll > 1 - paddyRule.fallow
                          ? 'fallow'
                          : 'green',
                wide = x1 - x0 > y1 - y0;
            paddies.push({
                quad,
                inner: [
                    [quad[0][0] + g, quad[0][1] + g],
                    [quad[1][0] - g, quad[1][1] + g],
                    [quad[2][0] - g, quad[2][1] - g],
                    [quad[3][0] + g, quad[3][1] - g],
                ],
                x0,
                x1,
                y0,
                y1,
                kind,
                // Seedling rows run along the long side more often than not.
                rowsAcross: kind === 'fallow' || paddyRandom() < (wide ? 0.7 : 0.3),
            });
        }

    return {
        width: W,
        height: H,
        margin,
        lanes,
        bases,
        yards,
        rocks,
        blotches,
        blades,
        dirt,
        small,
        props,
        fences,
        paddies,
        terrain,
        counts: {
            clusters: clusterCounts,
            small: small.length,
            stones: rocks.reduce((sum, rock) => sum + rock.stones.length, 0),
            dirt: dirt.length,
            paddies: paddies.length,
        },
    };
}
