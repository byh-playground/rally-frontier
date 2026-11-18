// The standing props of a themed map (map-look-layout.js): stone piles, trees, flags, fences, farm things, landmarks.
// Each prop is built once as flat-coloured triangle fans in its own upright frame (x right, y down, world units, the
// foot at the origin), so drawing one is a projection of its foot and a copy of its vertices. Every part is opaque:
// props write depth and are hidden by, or hide, the units around them. Their soft shadows are painted on the ground.
import { clamp, lerp, randomSource } from './map-look-layout.js';

const TAU = Math.PI * 2;
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255);

// Where each kind's shadow falls on the ground, relative to its foot (map-look-ground.js paints it).
export const PROP_SHADOWS = Object.freeze({
    tree: { dx: 40, dy: 10, width: 120, alpha: 0.2 },
    stack: { dx: 12, dy: 4, width: 70, alpha: 0.22 },
    reeds: { dx: 8, dy: 2, width: 50, alpha: 0.15 },
    cart: { dx: 14, dy: 4, width: 90, alpha: 0.22 },
    scarecrow: { dx: 16, dy: 4, width: 50, alpha: 0.18 },
    windmill: { dx: 66, dy: 10, width: 187, alpha: 0.18 },
    barn: { dx: 55, dy: 10, width: 242, alpha: 0.2 },
    flag: { dx: 10, dy: 2, width: 26, alpha: 0.2 },
});

// Collects one prop's parts. A fan is star-shaped about its first vertex.
class PropShape {
    constructor(scale = 1) {
        this.scale = scale;
        this.parts = [];
        this.left = this.top = Infinity;
        this.right = this.bottom = -Infinity;
    }
    fan(color, flat) {
        const points = new Float32Array(flat.length);
        for (let i = 0; i < flat.length; i += 2) {
            const x = (points[i] = flat[i] * this.scale),
                y = (points[i + 1] = flat[i + 1] * this.scale);
            this.left = Math.min(this.left, x);
            this.right = Math.max(this.right, x);
            this.top = Math.min(this.top, y);
            this.bottom = Math.max(this.bottom, y);
        }
        this.parts.push({ color, points });
        return this;
    }
    polygon(color, points) {
        return this.fan(color, points.flat());
    }
    // A closed outline filled from a centre it is star-shaped about.
    blob(color, cx, cy, ring) {
        return this.fan(color, [cx, cy, ...ring.flat(), ...ring[0]]);
    }
    rect(color, x, y, w, h) {
        return this.fan(color, [x, y, x + w, y, x + w, y + h, x, y + h]);
    }
    line(color, x1, y1, x2, y2, width) {
        const dx = x2 - x1,
            dy = y2 - y1,
            length = Math.hypot(dx, dy) || 1,
            nx = ((-dy / length) * width) / 2,
            ny = ((dx / length) * width) / 2;
        return this.fan(color, [
            x1 + nx,
            y1 + ny,
            x2 + nx,
            y2 + ny,
            x2 - nx,
            y2 - ny,
            x1 - nx,
            y1 - ny,
        ]);
    }
    path(color, points, width, closed = false) {
        for (let i = 0; i < points.length - (closed ? 0 : 1); i++) {
            const a = points[i],
                b = points[(i + 1) % points.length];
            this.line(color, a[0], a[1], b[0], b[1], width);
        }
        return this;
    }
    disc(color, cx, cy, rx, ry = rx, count = 16, rotation = 0) {
        const cos = Math.cos(rotation),
            sin = Math.sin(rotation),
            flat = [];
        for (let i = 0; i < count; i++) {
            const a = (i / count) * TAU,
                x = Math.cos(a) * rx,
                y = Math.sin(a) * ry;
            flat.push(cx + x * cos - y * sin, cy + x * sin + y * cos);
        }
        return this.fan(color, flat);
    }
}

// Points along a quadratic curve from a to b (a excluded).
function quadratic(a, control, b, steps = 6) {
    const out = [];
    for (let i = 1; i <= steps; i++) {
        const t = i / steps,
            u = 1 - t;
        out.push([
            u * u * a[0] + 2 * u * t * control[0] + t * t * b[0],
            u * u * a[1] + 2 * u * t * control[1] + t * t * b[1],
        ]);
    }
    return out;
}

export function buildMapProps(look, theme, projection, seedText) {
    const GS = projection.groundScale,
        HS = projection.heightScale,
        pal = theme.palette,
        p = pal.prop,
        haze = channels(pal.haze),
        { width: W, height: H } = look,
        random = randomSource(seedText),
        props = [];
    // Colours at a place: beyond the boundary they drift towards the haze, like the ground under them.
    const tint = (x, y) => {
        const amount = clamp(
            Math.hypot(Math.max(0, -x, x - W), Math.max(0, -y, y - H)) / 3000,
            0,
            0.72,
        );
        const at = (hex, extra = 0) => {
            const c = channels(hex),
                t = clamp(amount + extra, 0, 0.8);
            return [lerp(c[0], haze[0], t), lerp(c[1], haze[1], t), lerp(c[2], haze[2], t), 1];
        };
        // A quieter outline than the units': the line colour pulled halfway to the fill.
        at.line = (lineHex, fillHex) => {
            const a = at(lineHex, 0.12),
                b = at(fillHex);
            return [lerp(a[0], b[0], 0.45), lerp(a[1], b[1], 0.45), lerp(a[2], b[2], 0.45), 1];
        };
        return at;
    };
    // `front` is how far towards the viewer the prop's draw-order line lies from its foot: one distance, or
    // [seen by the host, seen by the guest] when the two differ.
    const add = (x, y, front, shape) =>
        props.push({
            x,
            y,
            front: Array.isArray(front) ? front : [front, front],
            parts: shape.parts,
            left: shape.left,
            right: shape.right,
            top: shape.top,
            bottom: shape.bottom,
        });

    const builders = {
        tree(prop, c) {
            const s = new PropShape(prop.scale),
                canopy = [
                    [-26, -78, 34],
                    [24, -82, 32],
                    [0, -104, 38],
                    [-4, -72, 30],
                ];
            s.polygon(c(p.trunk), [
                [-7, 0],
                [-5, -58],
                [5, -58],
                [7, 0],
            ]);
            for (const [dx, dy, r] of canopy) s.disc(c.line(p.leafLine, p.leaf), dx, dy, r + 1.4);
            for (const [dx, dy, r] of canopy) s.disc(c(p.leaf), dx, dy, r);
            for (const [dx, dy, r] of canopy)
                s.disc(c(p.leafLight), dx - r * 0.22, dy - r * 0.24, r * 0.7, r * 0.7, 14);
            s.disc(c(p.leafTop, 0.1), -12, -118, 14, 14, 12);
            return s;
        },
        stack(prop, c) {
            const s = new PropShape(prop.scale),
                outline = [
                    [-34, 0],
                    ...quadratic([-34, 0], [-38, -40], [-8, -66]),
                    [4, -76],
                    [10, -64],
                    ...quadratic([10, -64], [38, -40], [34, 0]),
                ];
            s.blob(c(p.straw), 0, -28, outline);
            s.path(c.line(p.strawLine, p.straw), outline, 1.4, true);
            s.blob(c(p.strawLight, 0.06), -15, -32, [
                [-26, -6],
                ...quadratic([-26, -6], [-30, -40], [-4, -64]),
                ...quadratic([-4, -64], [-12, -36], [-8, -6]),
            ]);
            for (const tie of [-22, -44])
                s.path(
                    c(p.strawTie, 0.08),
                    [[-32, tie], ...quadratic([-32, tie], [0, tie + 6], [32, tie])],
                    1.8,
                );
            return s;
        },
        reeds(prop, c, R) {
            const s = new PropShape(prop.scale);
            for (let i = 0; i < 9; i++) {
                const dx = (R() - 0.5) * 40,
                    h = 50 + R() * 35,
                    lean = (R() - 0.3) * 16;
                s.path(
                    c(p.reed[i % 2]),
                    [
                        [dx, 0],
                        ...quadratic([dx, 0], [dx + lean * 0.3, -h * 0.6], [dx + lean, -h], 4),
                    ],
                    2.4,
                );
                if (i % 3 === 0) s.disc(c(p.reedHead), dx + lean, -(h - 4), 3, 8, 8, lean / 60);
            }
            return s;
        },
        cart(prop, c) {
            const s = new PropShape(prop.scale),
                load = [];
            for (let i = 0; i <= 8; i++) {
                const a = Math.PI + (i / 8) * Math.PI;
                load.push([-3 + Math.cos(a) * 34, -38 + Math.sin(a) * 12]);
            }
            s.blob(c(p.straw), -3, -38, load);
            s.polygon(c(p.wood), [
                [-40, -34],
                [34, -34],
                [30, -16],
                [-36, -16],
            ]);
            s.line(c(p.woodDark), 34, -24, 70, -6, 3);
            s.disc(c.line(p.woodLine, p.woodDark), -8, -13, 15.4);
            s.disc(c(p.woodDark), -8, -13, 14);
            s.disc(c(p.woodLine, 0.1), -8, -13, 3.5, 3.5, 8);
            return s;
        },
        scarecrow(prop, c) {
            const s = new PropShape(prop.scale);
            s.line(c(p.trunk), 0, 0, 0, -74, 3.4);
            s.line(c(p.trunk), -26, -54, 26, -54, 3.4);
            s.rect(c(p.cloth), -14, -58, 28, 26);
            s.disc(c(p.face), 0, -70, 9, 9, 12);
            s.polygon(c(p.hat), [
                [-18, -72],
                [0, -90],
                [18, -72],
            ]);
            return s;
        },
        // Leaning on the stones, its head resting a little above the ground.
        hoe(prop, c) {
            const s = new PropShape(1),
                up = -HS * 30;
            s.line(c(p.woodDark), -30, 8 + up, 28, -12 + up, 3);
            s.polygon(c(p.metal), [
                [26, -12 + up],
                [36, -2 + up],
                [30, 4 + up],
            ]);
            return s;
        },
        windmill(prop, c) {
            const s = new PropShape(1.1 * prop.scale),
                tower = [
                    [-44, 0],
                    [-28, -150],
                    [28, -150],
                    [44, 0],
                ],
                roof = [
                    [-36, -146],
                    [0, -188],
                    [36, -146],
                ];
            s.polygon(c(p.wall), tower);
            s.polygon(c(p.wallShade), [
                [10, 0],
                [12, -150],
                [28, -150],
                [44, 0],
            ]);
            s.path(c.line(p.wallLine, p.wall), tower, 1.4, true);
            s.polygon(c(p.roof), roof);
            s.path(c.line(p.wallLine, p.roof), roof, 1.4, true);
            s.rect(c(p.door), -9, -34, 18, 34);
            for (let k = 0; k < 4; k++) {
                const a = (k * Math.PI) / 2 + 0.5,
                    cos = Math.cos(a),
                    sin = Math.sin(a),
                    at = (x, y) => [x * cos - y * sin, -150 + x * sin + y * cos],
                    sail = [at(8, -9), at(100, -9), at(100, 9), at(8, 9)];
                s.polygon(c(p.sail), sail);
                s.path(c.line(p.sailLine, p.sail), sail, 1.2, true);
                for (let u = 26; u < 100; u += 18)
                    s.line(c.line(p.sailLine, p.sail), ...at(u, -9), ...at(u, 9), 1.1);
            }
            s.disc(c(p.hub), 0, -150, 7, 7, 10);
            return s;
        },
        barn(prop, c) {
            const s = new PropShape(1.1 * prop.scale),
                roof = [
                    [-112, -54],
                    ...quadratic([-112, -54], [-60, -128], [-4, -132]),
                    ...quadratic([-4, -132], [60, -128], [112, -54]),
                    ...quadratic([112, -54], [0, -44], [-112, -54]).slice(0, -1),
                ];
            s.rect(c(p.barnWall), -92, -62, 184, 62);
            s.rect(c(p.barnShade), 20, -62, 72, 62);
            for (let u = -80; u < 92; u += 16)
                s.line(c.line(p.barnLine, p.barnWall), u, -60, u, 0, 1.1);
            s.rect(c(p.barnLine, 0.1), -22, -40, 36, 40);
            s.path(
                c.line(p.barnLine, p.barnWall),
                [
                    [-92, -50],
                    [-92, 0],
                    [92, 0],
                    [92, -50],
                ],
                1.4,
            );
            s.blob(c(p.thatch), 0, -84, roof);
            s.blob(c(p.thatchLight, 0.05), -56, -92, [
                [-100, -58],
                ...quadratic([-100, -58], [-60, -118], [-6, -126]),
                ...quadratic([-6, -126], [-50, -100], [-70, -54]),
            ]);
            s.path(c.line(p.thatchLine, p.thatch), roof, 1.4, true);
            for (const t of [0.35, 0.65]) {
                const half = 108 * (1 - t * 0.2),
                    y = -(54 + 74 * t) + 6;
                s.path(
                    c(p.thatchLine, 0.1),
                    [[-half, y], ...quadratic([-half, y], [0, -(48 + 84 * t)], [half, y])],
                    1.5,
                );
            }
            s.path(
                c(p.strawTie),
                [[-40, -128], ...quadratic([-40, -128], [0, -136], [40, -128])],
                4,
            );
            return s;
        },
    };

    for (const prop of look.props) {
        const shape = builders[prop.kind](
            prop,
            tint(prop.x, prop.y),
            random('prop:' + props.length),
        );
        add(prop.x, prop.y, 0, shape);
    }

    // Fences: posts, and between two posts a pair of rails. A rail is built about the middle of its span, so it is
    // the same shape whichever way up the map is seen.
    for (const fence of look.fences)
        fence.forEach(([x, y], i) => {
            const next = fence[i + 1];
            if (next) {
                const mx = (x + next[0]) / 2,
                    my = (y + next[1]) / 2,
                    hx = (next[0] - x) / 2,
                    hy = ((next[1] - y) / 2) * GS,
                    rails = new PropShape(1),
                    c = tint(mx, my);
                for (const h of [12, 26]) rails.line(c(p.rail), -hx, -hy - h, hx, hy - h, 3.4);
                add(mx, my, -1, rails);
            }
            add(x, y, 0, new PropShape(1).rect(tint(x, y)(p.post), -3.5, -34, 7, 34));
        });

    // Stone piles: each stone a chipped block (a footprint, side faces lit from the upper left, a bright top).
    for (const rock of look.rocks) {
        for (const stone of rock.stones) {
            const R = random('stone:' + stone.seed),
                s = new PropShape(1),
                count = 7,
                rotation = R() * TAU,
                base = [],
                top = [],
                lift = -HS * stone.lift,
                rise = -HS * stone.height,
                [low, high] = (R() < 0.5 ? pal.rock.warm : pal.rock.cool).map(channels),
                shade = (l) => [
                    lerp(low[0], high[0], l),
                    lerp(low[1], high[1], l),
                    lerp(low[2], high[2], l),
                    1,
                ];
            for (let i = 0; i < count; i++) {
                const a = rotation + (i / count) * TAU + (R() - 0.5) * 0.4,
                    k = 0.85 + R() * 0.17,
                    kt = 0.62 + R() * 0.16,
                    bx = Math.cos(a) * stone.r * k,
                    by = Math.sin(a) * stone.r * k;
                base.push([bx, by * GS + lift, bx, by]);
                top.push([
                    Math.cos(a + 0.12) * stone.r * k * kt + (R() - 0.5) * 2,
                    (Math.sin(a + 0.12) * stone.r * k * kt + stone.r * 0.05) * GS +
                        lift +
                        rise * (0.9 + R() * 0.2),
                ]);
            }
            s.polygon(
                shade(0.25),
                base.map(([x, y]) => [x, y]),
            );
            // The footprint's outline goes under the faces: only the silhouette's foot shows.
            const line = channels(pal.rock.line),
                edge = shade(0.3).map((v, i) => (i < 3 ? lerp(v, line[i], 0.5) : 1));
            s.path(
                edge,
                base.map(([x, y]) => [x, y]),
                1.2,
                true,
            );
            // Side faces from the back to the front; the light comes from the upper left.
            const faces = base.map((b, i) => {
                const j = (i + 1) % count,
                    mx = (b[2] + base[j][2]) / 2,
                    my = (b[3] + base[j][3]) / 2,
                    length = Math.hypot(mx, my) || 1,
                    light = clamp(
                        0.55 + ((-mx / length) * 0.6 - (my / length) * 0.75) * 0.45,
                        0.2,
                        1,
                    );
                return { i, j, light, y: (b[1] + base[j][1]) / 2 };
            });
            faces.sort((a, b) => a.y - b.y);
            for (const { i, j, light } of faces)
                s.polygon(shade(light * 0.78), [
                    [base[i][0], base[i][1]],
                    [base[j][0], base[j][1]],
                    top[j],
                    top[i],
                ]);
            s.polygon(shade(0.86), top);
            let corner = 0;
            for (let i = 1; i < count; i++)
                if (top[i][0] + top[i][1] < top[corner][0] + top[corner][1]) corner = i;
            s.polygon(shade(1), [
                [
                    top.reduce((sum, t) => sum + t[0], 0) / count,
                    top.reduce((sum, t) => sum + t[1], 0) / count,
                ],
                top[(corner + count - 1) % count],
                top[corner],
                top[(corner + 1) % count],
            ]);
            add(stone.x, stone.y, stone.front, s);
        }
        if (rock.tool) {
            const { kind, x, y, front } = rock.tool;
            add(x, y, front, builders[kind]({ scale: 1 }, tint(x, y)));
        }
    }

    // Base flags: the cloth takes the viewer's colour for that side when it is drawn.
    for (const base of look.bases)
        for (const flag of base.flags) {
            const s = new PropShape(flag.scale),
                c = tint(flag.x, flag.y);
            s.line(c(p.pole), 0, 0, 0, -70, 3);
            s.blob(null, 12, -57, [
                [1, -68],
                ...quadratic([1, -68], [22, -66], [40, -58]),
                ...quadratic([40, -58], [22, -52], [1, -46]),
            ]);
            s.parts[s.parts.length - 1].team = base.side;
            s.disc(c(p.finial), 0, -71, 2.6, 2.6, 8);
            add(flag.x, flag.y, 0, s);
        }

    // Far to near as the host sees them (the guest walks the list backwards), so equal depths still paint in order.
    return props.sort((a, b) => a.y + a.front[0] - (b.y + b.front[0]));
}
