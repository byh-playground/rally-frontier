// The standing props of a map (map-look-layout.js): stone piles, trees, flags, fences, bridge railings, farm things,
// landmarks.
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
    pine: { dx: 34, dy: 8, width: 104, alpha: 0.2 },
    log: { dx: 10, dy: 4, width: 104, alpha: 0.2 },
    stump: { dx: 10, dy: 3, width: 54, alpha: 0.2 },
    hollowTree: { dx: 62, dy: 10, width: 210, alpha: 0.2 },
    cabin: { dx: 50, dy: 10, width: 200, alpha: 0.2 },
    cottage: { dx: 52, dy: 10, width: 210, alpha: 0.2 },
    silo: { dx: 40, dy: 10, width: 130, alpha: 0.2 },
    beacon: { dx: 44, dy: 10, width: 120, alpha: 0.2 },
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
    // A prop stands at the height of the ground under its foot; one on a bridge deck belongs to that deck's layer
    // (`bridgeId`), as the units crossing the bridge do.
    const add = (x, y, front, shape) =>
        props.push({
            x,
            y,
            height: look.terrain.heightAt(x, y),
            bridgeId: look.terrain.bridgeAt(x, y),
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
        // A conifer: three tiers of boughs, each lit on its left.
        pine(prop, c) {
            const s = new PropShape(prop.scale);
            s.polygon(c(p.trunk), [
                [-6, 0],
                [-4, -40],
                [4, -40],
                [6, 0],
            ]);
            for (const [w, foot, tip] of [
                [48, -28, -84],
                [39, -62, -118],
                [29, -96, -152],
            ]) {
                const boughs = [
                    [0, tip],
                    [w, foot],
                    [w * 0.5, foot + 7],
                    [0, foot + 2],
                    [-w * 0.5, foot + 7],
                    [-w, foot],
                ];
                s.blob(c(p.pine), 0, (foot + tip) / 2, boughs);
                s.polygon(c(p.pineLight), [
                    [0, tip],
                    [-w * 0.12, foot + 1],
                    [-w * 0.5, foot + 5],
                    [-w * 0.86, foot - 1],
                ]);
                s.path(c.line(p.pineLine, p.pine), boughs, 1.4, true);
            }
            return s;
        },
        // A fallen log lying across the view: bark, a lit strip along its top, moss, its cut end with rings.
        log(prop, c) {
            const s = new PropShape(prop.scale),
                side = [
                    [-46, -4],
                    [-50, -15],
                    [-46, -26],
                    [38, -26],
                    [38, -4],
                ];
            s.polygon(c(p.wood), side);
            s.rect(c(p.woodDark), -46, -11, 84, 7);
            s.rect(c(p.rail, -0.05), -46, -26, 84, 4);
            s.polygon(c(p.moss), [
                [-30, -25],
                [-22, -31],
                [-6, -32],
                [6, -27],
                [0, -22],
                [-20, -21],
            ]);
            s.path(c.line(p.woodLine, p.wood), side, 1.3, true);
            s.disc(c.line(p.woodLine, p.woodEnd), 38, -15, 9.2, 12.2, 14);
            s.disc(c(p.woodEnd), 38, -15, 8, 11, 14);
            s.disc(c(p.woodRing), 38, -15, 4.6, 6.4, 12);
            s.disc(c(p.woodEnd), 38, -15, 2.2, 3.2, 10);
            return s;
        },
        // A stump: flared bark and the pale cut top with a ring.
        stump(prop, c) {
            const s = new PropShape(prop.scale),
                bark = [
                    [-26, 2],
                    [-17, -8],
                    [-15, -26],
                    [15, -26],
                    [17, -8],
                    [26, 2],
                    [0, 4],
                ];
            s.blob(c(p.trunk), 0, -12, bark);
            s.polygon(c(p.woodDark), [
                [4, -26],
                [15, -26],
                [17, -8],
                [26, 2],
                [6, 4],
            ]);
            s.path(c.line(p.trunkLine, p.trunk), bark, 1.3, true);
            s.disc(c(p.woodEnd), 0, -26, 15.6, 6.6, 14);
            s.disc(c(p.woodRing), 0, -26, 9, 3.8, 12);
            s.disc(c(p.woodEnd), 0, -26, 4.6, 2, 10);
            return s;
        },
        // The great hollow tree: a thick trunk on spreading roots with a dark hollow, under a broad crown.
        hollowTree(prop, c) {
            const s = new PropShape(prop.scale),
                trunk = [
                    [-66, 0],
                    [-42, -10],
                    [-35, -58],
                    [-40, -128],
                    [40, -128],
                    [35, -58],
                    [44, -10],
                    [70, 0],
                    [34, 5],
                    [0, 2],
                    [-32, 5],
                ],
                crown = [
                    [-88, -122, 32],
                    [86, -126, 32],
                    [-52, -146, 44],
                    [50, -150, 42],
                    [0, -164, 46],
                    [-4, -132, 40],
                ];
            s.blob(c(p.trunk), 0, -60, trunk);
            s.polygon(c(p.woodDark), [
                [14, -128],
                [40, -128],
                [35, -58],
                [44, -10],
                [34, 5],
                [18, -40],
            ]);
            s.polygon(c(p.woodDark), [
                [44, -10],
                [70, 0],
                [34, 5],
            ]);
            s.path(c.line(p.trunkLine, p.trunk), trunk, 1.4, true);
            s.disc(c(p.hollow), -6, -34, 18, 27, 16);
            s.rect(c(p.hollow), -24, -34, 36, 28);
            s.disc(c(p.moss), -40, -4, 12, 5, 10);
            s.disc(c(p.moss), 46, -3, 14, 5, 10);
            for (const [dx, dy, r] of crown) s.disc(c.line(p.leafLine, p.leaf), dx, dy, r + 1.4);
            for (const [dx, dy, r] of crown) s.disc(c(p.leaf), dx, dy, r);
            for (const [dx, dy, r] of crown)
                s.disc(c(p.leafLight), dx - r * 0.22, dy - r * 0.24, r * 0.7, r * 0.7, 14);
            s.disc(c(p.leafTop, 0.1), -14, -184, 16, 16, 12);
            return s;
        },
        // A log cabin: walls of stacked logs with their cut ends at the corners, a mossy roof, a lit window.
        cabin(prop, c) {
            const s = new PropShape(1.1 * prop.scale),
                roof = [
                    [-88, -54],
                    [0, -114],
                    [88, -54],
                ];
            s.rect(c(p.chimney), 34, -108, 16, 40);
            s.rect(c(p.wood), -70, -58, 140, 58);
            s.rect(c(p.woodDark), 22, -58, 48, 58);
            for (let y = -50; y < 0; y += 10)
                s.line(c.line(p.woodLine, p.wood), -70, y, 70, y, 1.1);
            for (let y = -54; y < 0; y += 10)
                for (const x of [-70, 70]) s.disc(c(p.woodEnd), x, y + 4, 4.4, 4.4, 8);
            s.rect(c(p.door), -16, -38, 24, 38);
            s.rect(c(p.window), 32, -42, 20, 16);
            s.line(c.line(p.woodLine, p.wood), 42, -42, 42, -26, 1.2);
            s.polygon(c(p.cabinRoof), roof);
            s.polygon(c(p.cabinRoofLight), [
                [0, -114],
                [-88, -54],
                [-26, -54],
            ]);
            s.path(c.line(p.cabinRoofLine, p.cabinRoof), roof, 1.4, true);
            return s;
        },
        // A village cottage: plastered walls, a tiled roof with a chimney, a door and a lit window.
        cottage(prop, c) {
            const s = new PropShape(1.15 * prop.scale),
                roof = [
                    [-96, -58],
                    [-52, -112],
                    [52, -112],
                    [96, -58],
                ];
            s.rect(c(p.chimneyBrick), 38, -128, 18, 46);
            s.rect(c(p.chimneyCap), 35, -132, 24, 7);
            s.rect(c(p.wall), -78, -62, 156, 62);
            s.rect(c(p.wallShade), 30, -62, 48, 62);
            s.rect(c(p.wallLine), -78, -2, 156, 3);
            s.rect(c(p.door), -50, -42, 26, 42);
            s.rect(c(p.window), 2, -44, 22, 20);
            s.line(c.line(p.wallLine, p.wall), 13, -44, 13, -24, 1.2);
            s.line(c.line(p.wallLine, p.wall), 2, -34, 24, -34, 1.2);
            s.rect(c(p.window), 44, -44, 22, 20);
            s.polygon(c(p.tile), roof);
            for (const y of [-72, -84, -98]) {
                const inset = (y + 58) * -0.82;
                s.line(c.line(p.tileLine, p.tile), -96 + inset * 0.5, y, 96 - inset * 0.5, y, 1.4);
            }
            s.polygon(c(p.tileLight), [
                [-52, -112],
                [-96, -58],
                [-60, -58],
                [-30, -112],
            ]);
            s.path(c.line(p.tileLine, p.tile), roof, 1.5, true);
            return s;
        },
        // A hilltop beacon: a tapering tower of pale stone with a brazier and its flame on top.
        beacon(prop, c) {
            const s = new PropShape(1.15 * prop.scale),
                tower = [
                    [-34, 0],
                    [-24, -150],
                    [24, -150],
                    [34, 0],
                ];
            s.polygon(c(p.beaconWall), tower);
            s.polygon(c(p.beaconShade), [
                [12, 0],
                [10, -150],
                [24, -150],
                [34, 0],
            ]);
            for (let y = -126; y < 0; y += 26) {
                const half = 34 - (-y / 150) * 10;
                s.line(c.line(p.beaconLine, p.beaconWall), -half, y, half, y, 1.3);
            }
            s.rect(c(p.door), -9, -28, 18, 28);
            s.polygon(c(p.beaconRim), [
                [-34, -150],
                [34, -150],
                [40, -168],
                [-40, -168],
            ]);
            s.polygon(c(p.beaconFire), [
                [-18, -168],
                [18, -168],
                [8, -198],
                [0, -224],
                [-10, -196],
            ]);
            s.polygon(c(p.beaconFireLight), [
                [-8, -168],
                [8, -168],
                [3, -190],
                [0, -204],
                [-4, -188],
            ]);
            return s;
        },
        // A grain silo: banded metal cylinder with a domed cap and a ladder.
        silo(prop, c) {
            const s = new PropShape(1.1 * prop.scale);
            s.rect(c(p.siloWall), -34, -150, 68, 150);
            s.rect(c(p.siloShade), 12, -150, 22, 150);
            for (let y = -130; y < 0; y += 24)
                s.line(c.line(p.siloLine, p.siloWall), -34, y, 34, y, 1.3);
            s.disc(c(p.siloShade), 0, -150, 36, 14, 18);
            s.disc(c(p.siloCap), 0, -158, 34, 24, 18);
            s.disc(c(p.siloCapLight), -8, -164, 16, 10, 14);
            s.rect(c(p.door), -9, -26, 18, 26);
            s.line(c.line(p.siloLine, p.siloWall), -26, -140, -26, -6, 1.6);
            for (let y = -128; y < -8; y += 16)
                s.line(c.line(p.siloLine, p.siloWall), -30, y, -22, y, 1.2);
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
                mossShare = theme.blockers.moss,
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
            // A theme with mossy blockers: moss on the top of that share of the stones, in place of bare stone.
            const moss =
                mossShare && R() < mossShare
                    ? pal.rock.moss.map((hex) => [...channels(hex), 1])
                    : [shade(0.86), shade(1)];
            s.polygon(moss[0], top);
            let corner = 0;
            for (let i = 1; i < count; i++)
                if (top[i][0] + top[i][1] < top[corner][0] + top[corner][1]) corner = i;
            s.polygon(moss[1], [
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
