// Builds a themed map's ground (map-look-layout.js) as ONE static triangle mesh, once when the map loads: grass, dirt,
// roads, yards, the boundary bank, the paddies outside, low decoration and the shadows of standing props. Every shape
// is flat-coloured or shaded by its vertex colours: hard edges stay sharp at any zoom, soft things (colour drift,
// shadows, highlights) are gradients between vertices, and nothing is rasterised into a texture.
// A vertex is [x, y, ox, oy, r, g, b, a]: a WORLD ground point plus an offset in SCREEN space (world units, x right,
// y down). The offset is how height, shadow direction and highlights stay the same way up for both players: the
// renderer turns the ground point for the guest and adds the offset afterwards.
import { PROP_SHADOWS } from './map-look-props.js';
import { clamp, lerp, pointInPolygon } from './map-look-layout.js';

const TAU = Math.PI * 2;
export const GROUND_VERTEX_FLOATS = 8;

const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);
const rgba = (hex, alpha = 1) => [...channels(hex), alpha];
const mix = (from, to, t, alpha = 1) => {
    const a = channels(from),
        b = channels(to);
    return [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t), alpha];
};
const clear = (color) => [color[0], color[1], color[2], 0];

// A closed curve through the midpoints of `points`, as a polyline.
function smooth(points, steps = 4) {
    const n = points.length,
        out = [];
    for (let i = 0; i < n; i++) {
        const before = points[(i + n - 1) % n],
            p = points[i],
            after = points[(i + 1) % n],
            ax = (before[0] + p[0]) / 2,
            ay = (before[1] + p[1]) / 2,
            bx = (p[0] + after[0]) / 2,
            by = (p[1] + after[1]) / 2;
        for (let k = 0; k < steps; k++) {
            const t = k / steps,
                u = 1 - t;
            out.push([
                u * u * ax + 2 * u * t * p[0] + t * t * bx,
                u * u * ay + 2 * u * t * p[1] + t * t * by,
            ]);
        }
    }
    return out;
}
const centroid = (points) => [
    points.reduce((sum, p) => sum + p[0], 0) / points.length,
    points.reduce((sum, p) => sum + p[1], 0) / points.length,
];
// `points` scaled about (cx, cy).
const scaled = (points, cx, cy, k) =>
    points.map(([x, y]) => [cx + (x - cx) * k, cy + (y - cy) * k]);
// The part of a polygon where nx·x + ny·y <= limit.
function clipHalfPlane(points, nx, ny, limit) {
    const out = [];
    for (let i = 0; i < points.length; i++) {
        const a = points[i],
            b = points[(i + 1) % points.length],
            da = nx * a[0] + ny * a[1] - limit,
            db = nx * b[0] + ny * b[1] - limit;
        if (da <= 0) out.push(a);
        if (da <= 0 !== db <= 0) {
            const t = da / (da - db);
            out.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
        }
    }
    return out;
}
function arcPoints(cx, cy, rx, ry, start, end, rotation = 0, step = 0.12) {
    const count = Math.max(2, Math.ceil(Math.abs(end - start) / step)),
        cos = Math.cos(rotation),
        sin = Math.sin(rotation),
        out = [];
    for (let i = 0; i <= count; i++) {
        const a = start + ((end - start) * i) / count,
            x = Math.cos(a) * rx,
            y = Math.sin(a) * ry;
        out.push([cx + x * cos - y * sin, cy + x * sin + y * cos]);
    }
    return out;
}

class GroundMesh {
    constructor() {
        this.data = [];
        // Screen-space offset of the vertices being added, and the world rectangle they are clipped to.
        this.ox = 0;
        this.oy = 0;
        this.clip = null;
        // Upright mode: every vertex sits on this ground point and the shape's own coordinates are its offset.
        this.anchor = null;
    }
    vertex(x, y, color) {
        return this.anchor
            ? [this.anchor[0], this.anchor[1], x, y, color[0], color[1], color[2], color[3]]
            : [x, y, this.ox, this.oy, color[0], color[1], color[2], color[3]];
    }
    triangle(a, b, c) {
        if (!this.clip) return this.data.push(...a, ...b, ...c);
        // Clip to the rectangle, carrying colour across each cut.
        let polygon = [a, b, c];
        const [x0, y0, x1, y1] = this.clip;
        for (const [axis, sign, limit] of [
            [0, -1, -x0],
            [0, 1, x1],
            [1, -1, -y0],
            [1, 1, y1],
        ]) {
            const out = [];
            for (let i = 0; i < polygon.length; i++) {
                const p = polygon[i],
                    q = polygon[(i + 1) % polygon.length],
                    dp = sign * p[axis] - limit,
                    dq = sign * q[axis] - limit;
                if (dp <= 0) out.push(p);
                if (dp <= 0 !== dq <= 0) {
                    const t = dp / (dp - dq);
                    out.push(p.map((value, k) => value + (q[k] - value) * t));
                }
            }
            polygon = out;
            if (polygon.length < 3) return 0;
        }
        for (let i = 1; i < polygon.length - 1; i++)
            this.data.push(...polygon[0], ...polygon[i], ...polygon[i + 1]);
        return 0;
    }
    // Runs `build` with every vertex offset on screen by (ox, oy).
    offset(ox, oy, build) {
        const px = this.ox,
            py = this.oy;
        this.ox = ox;
        this.oy = oy;
        build();
        this.ox = px;
        this.oy = py;
    }
    clipped(rect, build) {
        this.clip = rect;
        build();
        this.clip = null;
    }
    // Runs `build` in upright coordinates above the ground point (x, y): shapes there are not squashed.
    upright(x, y, build) {
        this.anchor = [x, y];
        build();
        this.anchor = null;
    }
    quad(a, b, c, d, ca, cb = ca, cc = cb, cd = ca) {
        const va = this.vertex(a[0], a[1], ca),
            vc = this.vertex(c[0], c[1], cc);
        this.triangle(va, this.vertex(b[0], b[1], cb), vc);
        this.triangle(va, vc, this.vertex(d[0], d[1], cd));
    }
    // A closed outline filled from a point it is star-shaped about (its centroid unless given); `centre` may
    // carry its own colour, which shades the fill from the middle out.
    fill(points, color, centre = centroid(points), centreColor = color) {
        const middle = this.vertex(centre[0], centre[1], centreColor);
        for (let i = 0; i < points.length; i++) {
            const a = points[i],
                b = points[(i + 1) % points.length];
            this.triangle(middle, this.vertex(a[0], a[1], color), this.vertex(b[0], b[1], color));
        }
    }
    // A blurred shape: solid inside `points` shrunk by `feather`, fading to nothing as far outside.
    soft(points, color, feather, centre = centroid(points)) {
        const radius =
                points.reduce((sum, p) => sum + Math.hypot(p[0] - centre[0], p[1] - centre[1]), 0) /
                points.length,
            k = clamp(feather / (radius || 1), 0, 0.95),
            inner = scaled(points, centre[0], centre[1], 1 - k),
            outer = scaled(points, centre[0], centre[1], 1 + k),
            none = clear(color);
        this.fill(inner, color, centre);
        for (let i = 0; i < points.length; i++) {
            const j = (i + 1) % points.length;
            this.quad(inner[i], inner[j], outer[j], outer[i], color, color, none, none);
        }
    }
    softEllipse(x, y, rx, ry, color, core = 0.35) {
        const none = clear(color),
            ring = arcPoints(x, y, rx, ry, 0, TAU, 0, TAU / 20).slice(0, -1),
            inner = scaled(ring, x, y, core);
        this.fill(inner, color, [x, y]);
        for (let i = 0; i < ring.length; i++) {
            const j = (i + 1) % ring.length;
            this.quad(inner[i], inner[j], ring[j], ring[i], color, color, none, none);
        }
    }
    // A line of `width` along `points`, mitred at every bend; `feather` adds a fade to nothing on both sides.
    stroke(points, width, color, { closed = false, feather = 0 } = {}) {
        const n = points.length,
            half = width / 2,
            left = [],
            right = [],
            farLeft = [],
            farRight = [];
        for (let i = 0; i < n; i++) {
            const before = points[closed ? (i + n - 1) % n : Math.max(0, i - 1)],
                after = points[closed ? (i + 1) % n : Math.min(n - 1, i + 1)],
                p = points[i];
            let ax = p[0] - before[0],
                ay = p[1] - before[1],
                bx = after[0] - p[0],
                by = after[1] - p[1];
            const al = Math.hypot(ax, ay),
                bl = Math.hypot(bx, by);
            if (!al) [ax, ay] = [bx / (bl || 1), by / (bl || 1)];
            else [ax, ay] = [ax / al, ay / al];
            if (!bl) [bx, by] = [ax, ay];
            else [bx, by] = [bx / bl, by / bl];
            let nx = -(ay + by),
                ny = ax + bx;
            const length = Math.hypot(nx, ny) || 1;
            nx /= length;
            ny /= length;
            // The mitre grows with the bend; capped so a hairpin cannot spike.
            const mitre = Math.min(2, 1 / Math.max(0.2, nx * -ay + ny * ax));
            left.push([p[0] + nx * half * mitre, p[1] + ny * half * mitre]);
            right.push([p[0] - nx * half * mitre, p[1] - ny * half * mitre]);
            if (feather) {
                farLeft.push([
                    p[0] + nx * (half + feather) * mitre,
                    p[1] + ny * (half + feather) * mitre,
                ]);
                farRight.push([
                    p[0] - nx * (half + feather) * mitre,
                    p[1] - ny * (half + feather) * mitre,
                ]);
            }
        }
        const none = clear(color);
        for (let i = 0; i < (closed ? n : n - 1); i++) {
            const j = (i + 1) % n;
            if (half) this.quad(left[i], left[j], right[j], right[i], color);
            if (feather) {
                this.quad(farLeft[i], farLeft[j], left[j], left[i], none, none, color, color);
                this.quad(right[i], right[j], farRight[j], farRight[i], color, color, none, none);
            }
        }
    }
    // The part of a ring between two radii and two angles.
    band(x, y, inner, outer, start, end, color) {
        const a = arcPoints(x, y, inner, inner, start, end),
            b = arcPoints(x, y, outer, outer, start, end);
        for (let i = 0; i < a.length - 1; i++) this.quad(a[i], a[i + 1], b[i + 1], b[i], color);
    }
}

// The ground mesh of a themed map: Float32Array of GROUND_VERTEX_FLOATS per vertex, three vertices a triangle,
// in paint order.
export function buildGroundMesh(look, theme, projection) {
    const GS = projection.groundScale,
        HS = projection.heightScale,
        pal = theme.palette,
        mesh = new GroundMesh(),
        { width: W, height: H } = look,
        { side, far } = look.margin,
        map = [0, 0, W, H];
    // Aerial perspective beyond the boundary: the further out, the closer to the haze colour.
    const hazeAt = (x, y) =>
        clamp(Math.hypot(Math.max(0, -x, x - W), Math.max(0, -y, y - H)) / 3000, 0, 0.72);
    const hazed = (hex, x, y, alpha = 1) => mix(hex, pal.haze, hazeAt(x, y), alpha);
    // The rectangle `mx` beyond the map's sides and `my` beyond its top and bottom, clockwise from the top left.
    const around = (mx, my) => [
        [-mx, -my],
        [W + mx, -my],
        [W + mx, H + my],
        [-mx, H + my],
    ];
    // The frame between two such rectangles, shaded from the inner colour to the outer one.
    const frame = (inner, outer, innerColor, outerColor) => {
        for (let i = 0; i < 4; i++) {
            const j = (i + 1) % 4;
            mesh.quad(
                inner[i],
                inner[j],
                outer[j],
                outer[i],
                innerColor,
                innerColor,
                outerColor,
                outerColor,
            );
        }
    };

    // ---- beyond the boundary: the haze the far distance dissolves into, grass, then the paddies ----
    const haze = rgba(pal.haze),
        reach = 1e5;
    mesh.quad(...around(reach, reach), haze);
    let ringColor = rgba(pal.outside.grass),
        ringAt = 0;
    mesh.quad(...around(0, 0), ringColor);
    for (let ring = 0; ring < 6; ring++) {
        const m = 200 + ring * 380,
            color = mix(pal.outside.ring, pal.haze, clamp(m / 2200, 0, 0.6));
        frame(around(ringAt, ringAt), around(m, m), ringColor, color);
        ringColor = color;
        ringAt = m;
    }
    frame(
        around(ringAt, ringAt),
        around(Math.max(side, ringAt) + 40, far + 40),
        ringColor,
        ringColor,
    );
    for (const paddy of look.paddies) {
        const { x0, x1, y0, y1, kind, inner } = paddy,
            mx = (x0 + x1) / 2,
            my = (y0 + y1) / 2,
            o = pal.outside,
            face = hazed(
                kind === 'water' ? o.water : kind === 'fallow' ? o.fallow : o.green,
                mx,
                my,
            );
        mesh.quad(...paddy.quad, hazed(o.bund, mx, my));
        // Flooded paddies carry the sky, brighter towards one corner.
        if (kind === 'water') {
            const glint = hazed(o.waterGlint, mx, my);
            mesh.quad(
                ...inner,
                face.map((v, i) => lerp(v, glint[i], 0.55)),
                face,
                face,
                face,
            );
        } else mesh.quad(...inner, face);
        // Rows: unbroken stripes, so they never read as dots.
        const row =
                kind === 'fallow'
                    ? hazed(o.fallowRow, mx, my, 0.45)
                    : kind === 'water'
                      ? hazed(o.waterRow, mx, my, 0.42)
                      : hazed(o.greenRow, mx, my, 0.5),
            width = kind === 'fallow' ? 7 : kind === 'water' ? 8 : 12,
            gap = kind === 'fallow' ? 52 : 40,
            // The inner quad, as the half planes a stripe is cut to.
            cut = (stripe) => {
                for (let i = 0; i < 4 && stripe.length >= 3; i++) {
                    const a = inner[i],
                        b = inner[(i + 1) % 4],
                        nx = b[1] - a[1],
                        ny = a[0] - b[0];
                    stripe = clipHalfPlane(stripe, nx, ny, nx * a[0] + ny * a[1]);
                }
                return stripe;
            };
        if (paddy.rowsAcross)
            for (let y = y0 + gap; y < y1 - 24; y += gap) {
                const stripe = cut([
                    [x0 - 30, y - width / 2],
                    [x1 + 30, y - width / 2],
                    [x1 + 30, y + width / 2],
                    [x0 - 30, y + width / 2],
                ]);
                if (stripe.length >= 3) mesh.fill(stripe, row);
            }
        else
            for (let x = x0 + gap; x < x1 - 24; x += gap) {
                const stripe = cut([
                    [x - width / 2, y0 - 30],
                    [x + width / 2, y0 - 30],
                    [x + width / 2, y1 + 30],
                    [x - width / 2, y1 + 30],
                ]);
                if (stripe.length >= 3) mesh.fill(stripe, row);
            }
        // A shaded strip under the bund's far edge gives it a little height.
        mesh.stroke(
            [
                [inner[0][0], inner[0][1] + 4],
                [inner[1][0], inner[1][1] + 4],
            ],
            6,
            hazed(o.bundShade, mx, my, 0.35),
        );
    }
    frame(around(side * 0.45, far * 0.3), around(side, far), clear(haze), haze);
    frame(around(side, far), around(reach, reach), haze, haze);

    // ---- the field: grass, slow colour drift, a few brushed blades ----
    mesh.quad(...around(0, 0), rgba(pal.grass.base));
    mesh.clipped(map, () => {
        for (const blotch of look.blotches)
            mesh.soft(
                smooth(blotch.points, 2),
                blotch.light ? rgba(pal.grass.light, 0.42) : rgba(pal.grass.dark, 0.36),
                110,
            );
    });
    // Blades are upright on the screen for both players: drawn above their ground point, not on the ground plane.
    for (const { x, y, light, size: k } of look.blades) {
        const color = light ? rgba(pal.grass.bladeLight, 0.22) : rgba(pal.grass.bladeDark, 0.18);
        mesh.upright(x, y, () => {
            for (const [fx, cx, cy, tx, ty] of [
                [-10, -8, -20, -16, -34],
                [2, 4, -22, 12, -38],
            ]) {
                const blade = [[fx * k, 0]];
                for (let i = 1; i <= 3; i++) {
                    const t = i / 3,
                        u = 1 - t;
                    blade.push([
                        (u * u * fx + 2 * u * t * cx + t * t * tx) * k,
                        (2 * u * t * cy + t * t * ty) * k * GS,
                    ]);
                }
                mesh.stroke(blade, 3.6 * k * GS, color);
            }
        });
    }

    // ---- dry dirt patches: a crisp rim and fill, then a little shading and a few flecks inside ----
    mesh.clipped(map, () => {
        const rim = mix(pal.grass.base, pal.dirt.rim, 0.6),
            fill = rgba(pal.dirt.fill);
        for (const parts of look.dirt) {
            // Every lobe's rim first, then every fill: overlapping lobes read as one shape.
            for (const part of parts) mesh.fill(smooth(part.rim), rim, [part.x, part.y]);
            for (const part of parts) mesh.fill(smooth(part.fill), fill, [part.x, part.y]);
            for (const part of parts) {
                // Darker towards the lower right, lighter towards the upper left (on screen, for both players).
                mesh.offset(part.r * 0.16, part.r * 0.1, () =>
                    mesh.softEllipse(
                        part.x,
                        part.y,
                        part.r * 0.62,
                        part.r * 0.36,
                        rgba(pal.dirt.rim, 0.32),
                        0.2,
                    ),
                );
                if (part.light)
                    mesh.fill(smooth(part.light), rgba(pal.dirt.light, 0.7), centroid(part.light));
                for (const fleck of part.flecks)
                    mesh.fill(
                        arcPoints(
                            fleck.x,
                            fleck.y,
                            fleck.size,
                            fleck.size * 0.6,
                            0,
                            TAU,
                            0,
                            TAU / 8,
                        ).slice(0, -1),
                        fleck.light ? rgba(pal.dirt.light, 0.75) : rgba(pal.dirt.rim, 0.5),
                    );
            }
        }
    });

    // ---- roads: soft shoulder, edge, dirt, a lighter crown, two wheel ruts ----
    const road = pal.road,
        lanes = look.lanes;
    for (const lane of lanes)
        mesh.stroke(lane.points, lane.width, rgba(road.shoulder, 0.5), {
            feather: theme.lanes.shoulder / 2,
        });
    for (const lane of lanes) mesh.stroke(lane.points, lane.width + 14, rgba(road.edge));
    for (const lane of lanes) mesh.stroke(lane.points, lane.width, rgba(road.fill));
    for (const lane of lanes)
        mesh.stroke(lane.points, lane.width * 0.2, rgba(road.crown, 0.6), {
            feather: lane.width * 0.2,
        });
    for (const lane of lanes)
        for (const rutSide of [-0.2, 0.2])
            mesh.stroke(
                lane.points.map((p, i) => {
                    const a = lane.points[Math.max(0, i - 1)],
                        b = lane.points[Math.min(lane.points.length - 1, i + 1)],
                        tx = b[0] - a[0],
                        ty = b[1] - a[1],
                        length = Math.hypot(tx, ty) || 1;
                    return [
                        p[0] - (ty / length) * rutSide * lane.width,
                        p[1] + (tx / length) * rutSide * lane.width,
                    ];
                }),
                5,
                rgba(road.rut, 0.28),
            );

    // ---- the boundary: a low earth bank, its top raised above its side on screen ----
    {
        const { offset: o, width, height } = theme.boundary.bank,
            bank = pal.bank;
        const rounded = (inset, radius) => [
            ...arcPoints(W + inset - radius, -inset + radius, radius, radius, -Math.PI / 2, 0),
            ...arcPoints(W + inset - radius, H + inset - radius, radius, radius, 0, Math.PI / 2),
            ...arcPoints(-inset + radius, H + inset - radius, radius, radius, Math.PI / 2, Math.PI),
            ...arcPoints(-inset + radius, -inset + radius, radius, radius, Math.PI, Math.PI * 1.5),
        ];
        const closed = { closed: true };
        mesh.offset(0, 30 * GS, () =>
            mesh.stroke(rounded(o + 40, 120), 30, rgba(bank.shadow, 0.22), {
                closed: true,
                feather: 30,
            }),
        );
        mesh.stroke(rounded(o, 90), width + 8, rgba(bank.side), closed);
        mesh.offset(0, -HS * height, () => {
            mesh.stroke(rounded(o, 90), width, rgba(bank.top), closed);
            mesh.stroke(rounded(o + 12, 100), 22, rgba(bank.lip, 0.85), closed);
            mesh.stroke(rounded(o - 14, 80), 12, rgba(bank.light, 0.55), closed);
        });
        // The bank's faint shadow on the field at its foot.
        mesh.clipped(map, () =>
            mesh.stroke(around(0, 0), 0, rgba(bank.foot, 0.25), { closed: true, feather: 44 }),
        );
    }

    // Moves the centre vertex of every fan triangle added since `from` by a screen offset.
    function shiftCentres(from, ox, oy) {
        for (let i = from; i < mesh.data.length; i += GROUND_VERTEX_FLOATS * 3) {
            mesh.data[i + 2] += ox;
            mesh.data[i + 3] += oy;
        }
    }
    // Light from the upper left of the screen: the highlight's middle is offset, its edge is the shape's own.
    const highlight = (outline, centre, color, ox, oy) => {
        const from = mesh.data.length;
        mesh.fill(outline, clear(color), centre, color);
        shiftCentres(from, ox, oy);
    };

    // ---- base yards: packed earth with the cannon's wheel ruts ----
    for (const base of look.bases) {
        const c = pal.base,
            centre = [base.x, base.y],
            outline = smooth(base.fill);
        mesh.soft(smooth(base.rim), rgba(c.rim, 0.5), 14, centre);
        mesh.fill(outline, rgba(c.fill), centre);
        highlight(outline, centre, rgba(c.light, 0.6), -80, -90 * GS);
        for (const rut of base.ruts)
            mesh.stroke(
                arcPoints(
                    base.x + rut.ring * 4,
                    base.y - rut.ring * 3,
                    rut.radius,
                    rut.radius * 0.97,
                    rut.start,
                    rut.end,
                    0.2 * rut.ring,
                ),
                6,
                rgba(c.rut, rut.ring === 2 ? 0.18 : 0.3),
            );
    }
    // ---- capture point yards ----
    for (const yard of look.yards) {
        if (yard.kind === 'straw') strawYard(yard);
        else pavingYard(yard);
    }

    function strawYard(yard) {
        const c = pal.straw,
            { x, y, radius } = yard,
            centre = [x, y],
            outline = smooth(yard.fill),
            span = radius + 60,
            light = rgba(c.bandLight, 0.35),
            dark = rgba(c.bandDark, 0.18),
            weave = rgba(c.weave, 0.32),
            inside = (px, py) => pointInPolygon(px, py, outline);
        // A strip of the yard between two parallel lines `across` a direction, and a stitch kept inside it.
        const strip = (nx, ny, from, to, color) => {
            const part = clipHalfPlane(clipHalfPlane(outline, nx, ny, to), -nx, -ny, -from);
            if (part.length >= 3) mesh.fill(part, color);
        };
        const stitch = (ax, ay, bx, by) => {
            if (inside(ax, ay) && inside(bx, by))
                mesh.stroke(
                    [
                        [ax, ay],
                        [bx, by],
                    ],
                    4,
                    weave,
                );
        };
        mesh.soft(smooth(yard.rim), rgba(c.rim, 0.5), 12, centre);
        mesh.fill(outline, rgba(c.fill), centre);
        if (yard.variant === 1) {
            // Coiled mat: rings of straw rope, the stitches leaning the other way on every other ring.
            const edge = (angle) => {
                // The yard's radius along `angle`, by bisection on its outline.
                let low = 0,
                    high = span;
                for (let i = 0; i < 12; i++) {
                    const mid = (low + high) / 2;
                    if (inside(x + Math.cos(angle) * mid, y + Math.sin(angle) * mid)) low = mid;
                    else high = mid;
                }
                return low;
            };
            const spokes = Array.from({ length: 48 }, (_, i) => {
                const angle = (i / 48) * TAU;
                return [Math.cos(angle), Math.sin(angle), edge(angle)];
            });
            for (let ring = 0, inner = 36; inner < span; ring++, inner += 44) {
                for (let i = 0; i < spokes.length; i++) {
                    const [ac, as, ar] = spokes[i],
                        [bc, bs, br] = spokes[(i + 1) % spokes.length],
                        a0 = Math.min(inner, ar),
                        a1 = Math.min(inner + 44, ar),
                        b0 = Math.min(inner, br),
                        b1 = Math.min(inner + 44, br);
                    if (a1 > a0 || b1 > b0)
                        mesh.quad(
                            [x + ac * a0, y + as * a0],
                            [x + bc * b0, y + bs * b0],
                            [x + bc * b1, y + bs * b1],
                            [x + ac * a1, y + as * a1],
                            ring % 2 ? light : dark,
                        );
                }
                const count = Math.round((TAU * (inner + 22)) / 30),
                    lean = ((ring % 2 ? 1 : -1) * 16) / (inner + 22);
                for (let k = 0; k < count; k++) {
                    const a = (k / count) * TAU;
                    stitch(
                        x + Math.cos(a) * (inner + 7),
                        y + Math.sin(a) * (inner + 7),
                        x + Math.cos(a + lean) * (inner + 37),
                        y + Math.sin(a + lean) * (inner + 37),
                    );
                }
            }
        } else if (yard.variant === 2) {
            // Plaited mat: diagonal strips one way, thin seams the other.
            const cos = Math.cos(-0.62),
                sin = Math.sin(-0.62),
                base = -sin * x + cos * y,
                cross = sin * x + cos * y;
            for (let k = -7; k <= 7; k++) {
                strip(-sin, cos, base + k * 44 - 22, base + k * 44 + 22, k % 2 ? light : dark);
                strip(sin, cos, cross + k * 44 - 2, cross + k * 44 + 2, weave);
            }
        } else {
            // Laid straw: wide bands, the stalks slanting the other way on every other band.
            for (let band = -6; band <= 6; band++) {
                const by = y + band * 44,
                    lean = band % 2 ? 1 : -1;
                strip(0, 1, by - 22, by + 22, band % 2 ? light : dark);
                for (let dx = -span; dx < span; dx += 26)
                    stitch(x + dx, by - 16, x + dx + lean * 18, by + 16);
            }
        }
        highlight(outline, centre, rgba(c.light, 0.5), -70, -80 * GS);
        // The border: one plaited straw rope, its strands as dashes.
        mesh.stroke(outline, 9, rgba(c.rope, 0.6), { closed: true });
        const strand = rgba(c.ropeLight, 0.6);
        let run = 0;
        for (let i = 0; i < outline.length; i++) {
            const a = outline[i],
                b = outline[(i + 1) % outline.length],
                length = Math.hypot(b[0] - a[0], b[1] - a[1]);
            // 16 on, 12 off, measured along the outline.
            for (let d = (28 - (run % 28)) % 28; d < length; d += 28) {
                const t0 = d / length,
                    t1 = Math.min(1, (d + 16) / length);
                mesh.stroke(
                    [
                        [a[0] + (b[0] - a[0]) * t0, a[1] + (b[1] - a[1]) * t0],
                        [a[0] + (b[0] - a[0]) * t1, a[1] + (b[1] - a[1]) * t1],
                    ],
                    4,
                    strand,
                );
            }
            run += length;
        }
        // A grain mark in the middle, under the building.
        mesh.upright(x, y, () => {
            for (let k = 0; k < 5; k++) {
                const a = (k / 5) * TAU - Math.PI / 2;
                mesh.fill(
                    arcPoints(
                        Math.cos(a) * 30 * GS,
                        Math.sin(a) * 30 * GS,
                        22 * GS,
                        10 * GS,
                        0,
                        TAU,
                        a,
                        TAU / 12,
                    ).slice(0, -1),
                    rgba(c.mark, 0.45),
                );
            }
        });
    }

    function pavingYard(yard) {
        const c = pal.paving,
            { x, y, radius, sides: corners } = yard,
            centre = [x, y];
        const outline = (r) =>
            corners
                ? Array.from({ length: corners }, (_, k) => {
                      const a = (k / corners) * TAU + Math.PI / corners;
                      return [x + Math.cos(a) * r, y + Math.sin(a) * r];
                  })
                : arcPoints(x, y, r, r, 0, TAU, 0, TAU / 40).slice(0, -1);
        // A low paved step: its shadow, its rim, then the stones.
        mesh.offset(12, 12 * GS, () =>
            mesh.soft(outline(radius + 9), rgba(c.shadow, 0.24), 10, centre),
        );
        mesh.fill(outline(radius + 9), rgba(c.rim), centre);
        mesh.fill(outline(radius), rgba(c.fill), centre);
        for (const ring of yard.rings) {
            const count = ring.stones.length,
                gap = 5 / ring.outer,
                phase = ring.inner / 40;
            ring.stones.forEach((tone, k) => {
                const start = (k / count) * TAU + phase,
                    end = ((k + 1) / count) * TAU + phase;
                mesh.band(
                    x,
                    y,
                    ring.inner + 3,
                    ring.outer - 3,
                    start + gap,
                    end - gap,
                    rgba(c.stones[tone]),
                );
                mesh.band(
                    x,
                    y,
                    ring.outer - 7.5,
                    ring.outer - 4.5,
                    start + gap * 2,
                    end - gap * 2,
                    rgba(c.stoneLight, 0.4),
                );
            });
        }
        highlight(outline(radius), centre, rgba(c.light, 0.22), -radius * 0.5, -radius * 0.5 * GS);
        mesh.stroke(outline(radius - 4), 5, rgba(c.light, 0.45), { closed: true });
        // An oil-drop mark in the middle, under the building.
        mesh.fill(
            arcPoints(x, y, radius * 0.3, radius * 0.3, 0, TAU, 0, TAU / 24).slice(0, -1),
            rgba(c.markBed, 0.22),
        );
        const drop = (cx, cy, s, color) => {
            mesh.fill(
                [
                    [cx, cy - s * 1.25],
                    [cx + s * 0.3, cy - s * 0.7],
                    ...arcPoints(cx, cy + s * 0.3, s * 0.85, s * 0.85, 0, Math.PI, 0, 0.4),
                    [cx - s * 0.3, cy - s * 0.7],
                ],
                color,
                [cx, cy + s * 0.2],
            );
        };
        mesh.upright(x, y, () => {
            drop(0, 4, radius * 0.125, rgba(c.mark, 0.5));
            drop(-5, -2, radius * 0.042, rgba(c.markLight, 0.45));
        });
    }

    // ---- blockers: a bed of bare earth, and the stone pile's shadow towards the lower right of the screen ----
    for (const rock of look.rocks) {
        const centre = centroid(rock.points);
        mesh.soft(smooth(rock.bed), rgba(pal.rock.bed, 0.55), 26, centre);
        mesh.offset(30, 26 * GS, () =>
            mesh.soft(
                scaled(rock.points, centre[0], centre[1], 0.92),
                rgba(pal.rock.shadow, 0.34),
                22,
                centre,
            ),
        );
    }

    // ---- low decoration lying on the ground, and the shadows of the standing props ----
    for (const item of [...look.small].sort((a, b) => a.y - b.y)) {
        const s = item.size * 0.75,
            tone = item.tone < 0.5 ? 0 : 1,
            d = pal.decor;
        mesh.upright(item.x, item.y, () => {
            if (item.kind === 'tuft') {
                const color = hazed(d.tuft[tone], item.x, item.y);
                for (const [dx, h] of [
                    [-6, 14],
                    [0, 20],
                    [6, 15],
                    [-2, 11],
                ])
                    mesh.stroke(
                        [
                            [dx * 0.4 * s, 0],
                            [dx * 0.75 * s, -h * 0.55 * s],
                            [dx * 1.3 * s, -h * s],
                        ],
                        2.4 * s,
                        color,
                    );
            } else if (item.kind === 'straw') {
                const color = hazed(d.straw[tone], item.x, item.y);
                for (let k = 0; k < 3; k++) {
                    const a = item.tone * 6 + k * 0.7;
                    mesh.stroke(
                        [
                            [-Math.cos(a) * 10 * s, -Math.sin(a) * 4 * s],
                            [Math.cos(a) * 10 * s, Math.sin(a) * 4 * s],
                        ],
                        2.2 * s,
                        color,
                    );
                }
            } else {
                const oval = (cx, cy, rx, ry, color) =>
                    mesh.fill(arcPoints(cx, cy, rx, ry, 0, TAU, 0, TAU / 10).slice(0, -1), color);
                oval(2 * s, 1.2 * s, 6 * s, 3 * s, rgba(pal.rock.shadow, 0.25));
                oval(0, -1.5 * s, 6 * s, 4 * s, hazed(d.pebble[tone], item.x, item.y));
                oval(-1.6 * s, -3 * s, 2.4 * s, 1.4 * s, rgba(d.pebbleLight, 0.6));
            }
        });
    }
    for (const prop of [
        ...look.props,
        ...look.bases.flatMap((base) => base.flags.map((flag) => ({ kind: 'flag', ...flag }))),
    ]) {
        const shadow = PROP_SHADOWS[prop.kind];
        if (!shadow) continue;
        const k = prop.scale,
            w = shadow.width * k;
        mesh.upright(prop.x, prop.y, () =>
            mesh.softEllipse(
                shadow.dx * k + w * 0.22,
                shadow.dy * GS + w * 0.06,
                w * 0.68,
                w * 0.27,
                rgba(pal.prop.shadow, shadow.alpha * 1.25),
                0.45,
            ),
        );
    }
    return new Float32Array(mesh.data);
}
