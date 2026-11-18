// Paints a themed map's ground (map-look-layout.js) into canvases, once when the map loads: grass, dirt, roads, yards,
// the boundary bank, the paddies outside, low decoration and the shadows of standing props. The renderer uploads the
// canvases as textures and draws nothing else for the ground during a match.
// Everything is painted in view coordinates on the projected ground plane (x right, y down the screen × groundScale).
import { PROP_SHADOWS } from './map-look-props.js';
import { clamp, lerp } from './map-look-layout.js';

const TAU = Math.PI * 2;
const channels = (hex) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const rgba = (hex, alpha = 1) => `rgba(${channels(hex).join(',')},${alpha})`;
function mix(from, to, t, alpha = 1) {
    const a = channels(from),
        b = channels(to);
    return `rgba(${a.map((v, i) => Math.round(lerp(v, b[i], t))).join(',')},${alpha})`;
}

// One ground canvas: the view-space rectangle [x0, x1] × [y0, y1] at `density` texels per world unit, with a
// `gutter` texel border so linear filtering never samples past the painted edge.
export function paintGroundCanvas(
    look,
    theme,
    projection,
    { x0, y0, x1, y1, density, gutter, field },
) {
    const GS = projection.groundScale,
        HS = projection.heightScale,
        canvas = document.createElement('canvas');
    canvas.width = Math.ceil((x1 - x0) * density) + gutter * 2;
    canvas.height = Math.ceil((y1 - y0) * GS * density) + gutter * 2;
    const ctx = canvas.getContext('2d'),
        pal = theme.palette,
        { width: W, height: H } = look,
        ox = gutter - x0 * density,
        oy = gutter - y0 * GS * density;
    // Ground coordinates: a circle drawn here lies flat on the ground.
    const ground = () => ctx.setTransform(density, 0, 0, density * GS, ox, oy);
    // Upright coordinates: the point (x, y·GS), with shapes drawn unsquashed above it.
    const upright = () => ctx.setTransform(density, 0, 0, density, ox, oy);
    const blur = (world) => `blur(${Math.max(0.5, world * density).toFixed(2)}px)`;
    // Aerial perspective beyond the boundary: the further out, the closer to the haze colour.
    const hazeAt = (x, y) =>
        clamp(Math.hypot(Math.max(0, -x, x - W), Math.max(0, -y, y - H)) / 3000, 0, 0.72);
    const hazed = (hex, x, y, alpha = 1) => mix(hex, pal.haze, hazeAt(x, y), alpha);
    const path = (points) => {
        ctx.beginPath();
        points.forEach((p, i) => (i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1])));
        ctx.closePath();
    };
    // A closed curve through the midpoints of `points`; `fresh` false adds it to the current path.
    const smooth = (points, fresh = true) => {
        const n = points.length,
            mid = (a, b) => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
        if (fresh) ctx.beginPath();
        const start = mid(points[n - 1], points[0]);
        ctx.moveTo(start[0], start[1]);
        for (let i = 0; i < n; i++) {
            const p = points[i],
                end = mid(p, points[(i + 1) % n]);
            ctx.quadraticCurveTo(p[0], p[1], end[0], end[1]);
        }
        ctx.closePath();
    };
    const clipToMap = () => {
        ctx.beginPath();
        ctx.rect(0, 0, W, H);
        ctx.clip();
    };

    // ---- beyond the boundary: grass, then flooded, green and fallow paddies ----
    ground();
    ctx.fillStyle = pal.outside.grass;
    ctx.fillRect(x0 - 8, y0 - 8, x1 - x0 + 16, y1 - y0 + 16);
    ctx.save();
    ctx.filter = blur(60);
    ctx.lineWidth = 420;
    for (let ring = 0; ring < 6; ring++) {
        const m = 200 + ring * 380;
        ctx.strokeStyle = mix(pal.outside.ring, pal.haze, clamp(m / 2200, 0, 0.6));
        ctx.strokeRect(-m, -m, W + 2 * m, H + 2 * m);
    }
    ctx.restore();
    for (const paddy of look.paddies) {
        const { x0: px0, x1: px1, y0: py0, y1: py1, kind, inner } = paddy;
        if (px1 < x0 - 60 || px0 > x1 + 60 || py1 < y0 - 60 || py0 > y1 + 60) continue;
        const mx = (px0 + px1) / 2,
            my = (py0 + py1) / 2,
            o = pal.outside;
        path(paddy.quad);
        ctx.fillStyle = hazed(o.bund, mx, my);
        ctx.fill();
        path(inner);
        ctx.fillStyle = hazed(
            kind === 'water' ? o.water : kind === 'fallow' ? o.fallow : o.green,
            mx,
            my,
        );
        ctx.fill();
        ctx.save();
        ctx.clip();
        if (kind === 'water') {
            // The sky on the water, brighter towards the upper left.
            const glint = ctx.createLinearGradient(px0, py0, px1, py1);
            glint.addColorStop(0, hazed(o.waterGlint, mx, my, 0.55));
            glint.addColorStop(0.6, hazed(o.water, mx, my, 0));
            ctx.fillStyle = glint;
            ctx.fillRect(px0 - 60, py0 - 60, px1 - px0 + 120, py1 - py0 + 120);
        }
        // Rows: unbroken stripes, so they never read as dots.
        ctx.beginPath();
        if (kind === 'fallow') {
            ctx.strokeStyle = hazed(o.fallowRow, mx, my, 0.45);
            ctx.lineWidth = 7;
            for (let y = py0 + 34; y < py1; y += 52) {
                ctx.moveTo(px0, y);
                ctx.lineTo(px1, y);
            }
        } else {
            ctx.strokeStyle =
                kind === 'water' ? hazed(o.waterRow, mx, my, 0.42) : hazed(o.greenRow, mx, my, 0.5);
            ctx.lineWidth = kind === 'water' ? 8 : 12;
            if (paddy.rowsAcross)
                for (let y = py0 + 40; y < py1 - 24; y += 40) {
                    ctx.moveTo(px0, y);
                    ctx.lineTo(px1, y);
                }
            else
                for (let x = px0 + 40; x < px1 - 24; x += 40) {
                    ctx.moveTo(x, py0);
                    ctx.lineTo(x, py1);
                }
        }
        ctx.stroke();
        ctx.restore();
        // A shaded strip under the bund's far edge gives it a little height.
        ctx.strokeStyle = hazed(o.bundShade, mx, my, 0.35);
        ctx.lineWidth = 6;
        ctx.beginPath();
        ctx.moveTo(inner[0][0], inner[0][1] + 4);
        ctx.lineTo(inner[1][0], inner[1][1] + 4);
        ctx.stroke();
    }

    if (field) {
        // ---- the field: grass, slow colour drift, a few brushed blades ----
        ground();
        ctx.fillStyle = pal.grass.base;
        ctx.fillRect(0, 0, W, H);
        ctx.save();
        clipToMap();
        ctx.filter = blur(70);
        for (const blotch of look.blotches) {
            smooth(blotch.points);
            ctx.fillStyle = blotch.light ? rgba(pal.grass.light, 0.38) : rgba(pal.grass.dark, 0.32);
            ctx.fill();
        }
        ctx.restore();
        ctx.save();
        clipToMap();
        ctx.lineCap = 'round';
        for (const { x, y, light, size: k } of look.blades) {
            ctx.strokeStyle = light
                ? rgba(pal.grass.bladeLight, 0.22)
                : rgba(pal.grass.bladeDark, 0.18);
            ctx.lineWidth = 3.6 * k;
            ctx.beginPath();
            ctx.moveTo(x - 10 * k, y);
            ctx.quadraticCurveTo(x - 8 * k, y - 20 * k, x - 16 * k, y - 34 * k);
            ctx.moveTo(x + 2 * k, y);
            ctx.quadraticCurveTo(x + 4 * k, y - 22 * k, x + 12 * k, y - 38 * k);
            ctx.stroke();
        }
        ctx.restore();

        // ---- dry dirt patches: crisp edges, each patch's overlapping lobes filled as one shape ----
        ctx.save();
        clipToMap();
        for (const parts of look.dirt) {
            const lobes = (key) => {
                ctx.beginPath();
                for (const part of parts) if (part[key]) smooth(part[key], false);
            };
            lobes('rim');
            ctx.fillStyle = rgba(pal.dirt.rim, 0.5);
            ctx.fill('nonzero');
            lobes('fill');
            ctx.fillStyle = rgba(pal.dirt.fill, 0.92);
            ctx.fill('nonzero');
            lobes('light');
            ctx.fillStyle = rgba(pal.dirt.light, 0.6);
            ctx.fill('nonzero');
        }
        ctx.restore();

        // ---- roads: soft shoulder, edge, dirt, a lighter crown, two wheel ruts ----
        const strokeLanes = (width, style, blurWorld = 0, offset = 0) => {
            ctx.save();
            if (blurWorld) ctx.filter = blur(blurWorld);
            ctx.strokeStyle = style;
            ctx.lineJoin = ctx.lineCap = 'round';
            for (const lane of look.lanes) {
                const points = lane.points;
                ctx.lineWidth = width(lane);
                ctx.beginPath();
                points.forEach((p, i) => {
                    let [x, y] = p;
                    if (offset) {
                        const a = points[Math.max(0, i - 1)],
                            b = points[Math.min(points.length - 1, i + 1)],
                            tx = b[0] - a[0],
                            ty = b[1] - a[1],
                            length = Math.hypot(tx, ty) || 1;
                        x -= (ty / length) * offset * lane.width;
                        y += (tx / length) * offset * lane.width;
                    }
                    if (i) ctx.lineTo(x, y);
                    else ctx.moveTo(x, y);
                });
                ctx.stroke();
            }
            ctx.restore();
        };
        const road = pal.road;
        strokeLanes((lane) => lane.width + theme.lanes.shoulder, rgba(road.shoulder, 0.5), 5);
        strokeLanes((lane) => lane.width + 14, road.edge, 1);
        strokeLanes((lane) => lane.width, road.fill, 0.8);
        strokeLanes((lane) => lane.width * 0.46, rgba(road.crown, 0.6), 6);
        for (const rutSide of [-0.2, 0.2]) strokeLanes(() => 5, rgba(road.rut, 0.28), 2, rutSide);
    }

    // ---- the boundary: a low earth bank ----
    {
        const { offset: o, width, height } = theme.boundary.bank,
            lift = (-HS * height) / GS,
            bank = pal.bank;
        const rounded = (inset, radius) => {
            const x = -inset,
                y = -inset,
                w = W + 2 * inset,
                h = H + 2 * inset;
            ctx.beginPath();
            ctx.moveTo(x + radius, y);
            ctx.arcTo(x + w, y, x + w, y + h, radius);
            ctx.arcTo(x + w, y + h, x, y + h, radius);
            ctx.arcTo(x, y + h, x, y, radius);
            ctx.arcTo(x, y, x + w, y, radius);
            ctx.closePath();
        };
        ground();
        ctx.save();
        ctx.filter = blur(10);
        ctx.translate(0, 30);
        rounded(o + 40, 120);
        ctx.lineWidth = 60;
        ctx.strokeStyle = rgba(bank.shadow, 0.22);
        ctx.stroke();
        ctx.restore();
        rounded(o, 90);
        ctx.lineWidth = width + 8;
        ctx.strokeStyle = bank.side;
        ctx.stroke();
        ctx.save();
        ctx.translate(0, lift);
        rounded(o, 90);
        ctx.lineWidth = width;
        ctx.strokeStyle = bank.top;
        ctx.stroke();
        rounded(o + 12, 100);
        ctx.lineWidth = 22;
        ctx.strokeStyle = rgba(bank.lip, 0.85);
        ctx.stroke();
        rounded(o - 14, 80);
        ctx.lineWidth = 12;
        ctx.strokeStyle = rgba(bank.light, 0.55);
        ctx.stroke();
        ctx.restore();
        // The bank's faint shadow on the field at its foot.
        ctx.save();
        clipToMap();
        ctx.filter = blur(18);
        ctx.strokeStyle = rgba(bank.foot, 0.25);
        ctx.lineWidth = 40;
        ctx.strokeRect(0, 0, W, H);
        ctx.restore();
    }

    if (field) {
        // ---- base yards: packed earth with the cannon's wheel ruts ----
        ground();
        for (const base of look.bases) {
            const c = pal.base;
            ctx.save();
            ctx.filter = blur(4);
            smooth(base.rim);
            ctx.fillStyle = rgba(c.rim, 0.5);
            ctx.fill();
            ctx.restore();
            smooth(base.fill);
            ctx.fillStyle = c.fill;
            ctx.fill();
            const light = ctx.createRadialGradient(
                base.x - 80,
                base.y - 90,
                20,
                base.x,
                base.y,
                base.radius,
            );
            light.addColorStop(0, rgba(c.light, 0.55));
            light.addColorStop(1, rgba(c.light, 0));
            ctx.fillStyle = light;
            ctx.fill();
            ctx.lineCap = 'round';
            ctx.lineWidth = 6;
            for (const rut of base.ruts) {
                ctx.strokeStyle = rgba(c.rut, rut.ring === 2 ? 0.18 : 0.3);
                ctx.beginPath();
                ctx.ellipse(
                    base.x + rut.ring * 4,
                    base.y - rut.ring * 3,
                    rut.radius,
                    rut.radius * 0.97,
                    0.2 * rut.ring,
                    rut.start,
                    rut.end,
                );
                ctx.stroke();
            }
        }

        // ---- capture point yards ----
        for (const yard of look.yards) {
            ground();
            if (yard.kind === 'straw') paintStrawYard(yard);
            else paintPavingYard(yard);
        }

        // ---- blockers: a bed of bare earth, and the stone pile's shadow towards the lower right ----
        ground();
        for (const rock of look.rocks) {
            ctx.save();
            ctx.filter = blur(8);
            smooth(rock.bed);
            ctx.fillStyle = rgba(pal.rock.bed, 0.55);
            ctx.fill();
            ctx.restore();
            ctx.save();
            ctx.filter = blur(6);
            ctx.translate(30, 26);
            ctx.beginPath();
            for (const stone of rock.stones)
                if (!stone.lift) {
                    ctx.moveTo(stone.x + stone.r * 1.05, stone.y);
                    ctx.ellipse(stone.x, stone.y, stone.r * 1.05, stone.r * 0.95, 0, 0, TAU);
                }
            ctx.fillStyle = rgba(pal.rock.shadow, 0.3);
            ctx.fill('nonzero');
            ctx.restore();
        }
    }

    function paintStrawYard(yard) {
        const c = pal.straw,
            { x, y, radius } = yard,
            reach = radius + 60;
        ctx.save();
        ctx.filter = blur(4);
        smooth(yard.rim);
        ctx.fillStyle = rgba(c.rim, 0.5);
        ctx.fill();
        ctx.restore();
        smooth(yard.fill);
        ctx.fillStyle = c.fill;
        ctx.fill();
        ctx.save();
        smooth(yard.fill);
        ctx.clip();
        ctx.lineCap = 'round';
        ctx.lineWidth = 4;
        ctx.strokeStyle = rgba(c.weave, 0.32);
        if (yard.variant === 1) {
            // Coiled mat: rings of straw rope, the stitches leaning the other way on every other ring.
            for (let ring = 0, inner = 36; inner < reach; ring++, inner += 44) {
                ctx.beginPath();
                ctx.arc(x, y, inner + 44, 0, TAU);
                ctx.arc(x, y, inner, 0, TAU, true);
                ctx.fillStyle = ring % 2 ? rgba(c.bandLight, 0.35) : rgba(c.bandDark, 0.18);
                ctx.fill();
                const count = Math.round((TAU * (inner + 22)) / 30),
                    lean = ((ring % 2 ? 1 : -1) * 16) / (inner + 22);
                ctx.beginPath();
                for (let k = 0; k < count; k++) {
                    const a = (k / count) * TAU;
                    ctx.moveTo(x + Math.cos(a) * (inner + 7), y + Math.sin(a) * (inner + 7));
                    ctx.lineTo(
                        x + Math.cos(a + lean) * (inner + 37),
                        y + Math.sin(a + lean) * (inner + 37),
                    );
                }
                ctx.stroke();
            }
        } else if (yard.variant === 2) {
            // Plaited mat: diagonal strips one way, thin seams the other.
            ctx.save();
            ctx.translate(x, y);
            ctx.rotate(-0.62);
            for (let strip = -7; strip <= 7; strip++) {
                ctx.fillStyle = strip % 2 ? rgba(c.bandLight, 0.35) : rgba(c.bandDark, 0.18);
                ctx.fillRect(-reach, strip * 44 - 22, reach * 2, 44);
            }
            ctx.rotate(1.24);
            ctx.beginPath();
            for (let seam = -7; seam <= 7; seam++) {
                ctx.moveTo(-reach, seam * 44);
                ctx.lineTo(reach, seam * 44);
            }
            ctx.stroke();
            ctx.restore();
        } else {
            // Laid straw: wide bands, the stalks slanting the other way on every other band.
            for (let band = -6; band <= 6; band++) {
                const by = y + band * 44,
                    lean = band % 2 ? 1 : -1;
                ctx.fillStyle = band % 2 ? rgba(c.bandLight, 0.35) : rgba(c.bandDark, 0.18);
                ctx.fillRect(x - reach, by - 22, reach * 2, 44);
                ctx.beginPath();
                for (let dx = -reach; dx < reach; dx += 26) {
                    ctx.moveTo(x + dx, by - 16);
                    ctx.lineTo(x + dx + lean * 18, by + 16);
                }
                ctx.stroke();
            }
        }
        const light = ctx.createRadialGradient(x - 70, y - 80, 10, x, y, radius + 20);
        light.addColorStop(0, rgba(c.light, 0.45));
        light.addColorStop(1, rgba(c.light, 0));
        ctx.fillStyle = light;
        ctx.fillRect(x - reach, y - reach, reach * 2, reach * 2);
        ctx.restore();
        // The border: one plaited straw rope.
        smooth(yard.fill);
        ctx.strokeStyle = rgba(c.rope, 0.6);
        ctx.lineWidth = 9;
        ctx.stroke();
        ctx.setLineDash([16, 12]);
        ctx.strokeStyle = rgba(c.ropeLight, 0.6);
        ctx.lineWidth = 4;
        ctx.stroke();
        ctx.setLineDash([]);
        // A grain mark in the middle, under the building.
        upright();
        ctx.fillStyle = rgba(c.mark, 0.45);
        for (let k = 0; k < 5; k++) {
            const a = (k / 5) * TAU - Math.PI / 2;
            ctx.beginPath();
            ctx.ellipse(
                x + Math.cos(a) * 30 * GS,
                y * GS + Math.sin(a) * 30 * GS,
                22 * GS,
                10 * GS,
                a,
                0,
                TAU,
            );
            ctx.fill();
        }
    }

    function paintPavingYard(yard) {
        const c = pal.paving,
            { x, y, radius, sides } = yard;
        const outline = (r) => {
            ctx.beginPath();
            if (!sides) return ctx.arc(x, y, r, 0, TAU);
            for (let k = 0; k < sides; k++) {
                const a = (k / sides) * TAU + Math.PI / sides;
                ctx.lineTo(x + Math.cos(a) * r, y + Math.sin(a) * r);
            }
            ctx.closePath();
        };
        // A low paved step: its shadow, its rim, then the stones.
        ctx.save();
        ctx.filter = blur(4);
        ctx.translate(12, 12);
        outline(radius + 9);
        ctx.fillStyle = rgba(c.shadow, 0.24);
        ctx.fill();
        ctx.restore();
        outline(radius + 9);
        ctx.fillStyle = c.rim;
        ctx.fill();
        outline(radius);
        ctx.fillStyle = c.fill;
        ctx.fill();
        for (const ring of yard.rings) {
            const count = ring.stones.length,
                gap = 5 / ring.outer,
                phase = ring.inner / 40;
            ring.stones.forEach((tone, k) => {
                const start = (k / count) * TAU + phase,
                    end = ((k + 1) / count) * TAU + phase;
                ctx.beginPath();
                ctx.arc(x, y, ring.outer - 3, start + gap, end - gap);
                ctx.arc(x, y, ring.inner + 3, end - gap, start + gap, true);
                ctx.closePath();
                ctx.fillStyle = c.stones[tone];
                ctx.fill();
                ctx.strokeStyle = rgba(c.stoneLight, 0.4);
                ctx.lineWidth = 3;
                ctx.beginPath();
                ctx.arc(x, y, ring.outer - 6, start + gap * 2, end - gap * 2);
                ctx.stroke();
            });
        }
        ctx.save();
        outline(radius);
        ctx.clip();
        const light = ctx.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
        light.addColorStop(0, rgba(c.light, 0.2));
        light.addColorStop(1, rgba(c.shade, 0.08));
        ctx.fillStyle = light;
        ctx.fillRect(x - radius, y - radius, radius * 2, radius * 2);
        ctx.restore();
        ctx.lineWidth = 5;
        ctx.strokeStyle = rgba(c.light, 0.45);
        outline(radius - 4);
        ctx.stroke();
        // An oil-drop mark in the middle, under the building.
        const drop = (cx, cy, s) => {
            ctx.beginPath();
            ctx.moveTo(cx, cy - s * 1.25);
            ctx.bezierCurveTo(
                cx + s * 0.35,
                cy - s * 0.6,
                cx + s * 0.85,
                cy - s * 0.1,
                cx + s * 0.85,
                cy + s * 0.3,
            );
            ctx.arc(cx, cy + s * 0.3, s * 0.85, 0, Math.PI, false);
            ctx.bezierCurveTo(
                cx - s * 0.85,
                cy - s * 0.1,
                cx - s * 0.35,
                cy - s * 0.6,
                cx,
                cy - s * 1.25,
            );
            ctx.closePath();
        };
        ctx.beginPath();
        ctx.arc(x, y, radius * 0.3, 0, TAU);
        ctx.fillStyle = rgba(c.markBed, 0.22);
        ctx.fill();
        upright();
        drop(x, y * GS + 4, radius * 0.125);
        ctx.fillStyle = rgba(c.mark, 0.5);
        ctx.fill();
        drop(x - 5, y * GS - 2, radius * 0.042);
        ctx.fillStyle = rgba(c.markLight, 0.45);
        ctx.fill();
    }

    // ---- low decoration lying on the ground, and the shadows of the standing props ----
    upright();
    ctx.lineCap = 'round';
    for (const item of [...look.small].sort((a, b) => a.y - b.y)) {
        const sx = item.x,
            sy = item.y * GS,
            s = item.size * 0.75,
            tone = item.tone < 0.5 ? 0 : 1,
            d = pal.decor;
        if (!field && item.x > 0 && item.y > 0 && item.x < W && item.y < H) continue;
        if (item.kind === 'tuft') {
            ctx.strokeStyle = hazed(d.tuft[tone], item.x, item.y);
            ctx.lineWidth = 2.4 * s;
            ctx.beginPath();
            for (const [dx, h] of [
                [-6, 14],
                [0, 20],
                [6, 15],
                [-2, 11],
            ]) {
                ctx.moveTo(sx + dx * 0.4 * s, sy);
                ctx.quadraticCurveTo(
                    sx + dx * 0.6 * s,
                    sy - h * 0.6 * s,
                    sx + dx * 1.3 * s,
                    sy - h * s,
                );
            }
            ctx.stroke();
        } else if (item.kind === 'straw') {
            ctx.strokeStyle = hazed(d.straw[tone], item.x, item.y);
            ctx.lineWidth = 2.2 * s;
            ctx.beginPath();
            for (let k = 0; k < 3; k++) {
                const a = item.tone * 6 + k * 0.7;
                ctx.moveTo(sx - Math.cos(a) * 10 * s, sy - Math.sin(a) * 4 * s);
                ctx.lineTo(sx + Math.cos(a) * 10 * s, sy + Math.sin(a) * 4 * s);
            }
            ctx.stroke();
        } else {
            ctx.fillStyle = rgba(pal.rock.shadow, 0.25);
            ctx.beginPath();
            ctx.ellipse(sx + 2 * s, sy + 1.2 * s, 6 * s, 3 * s, 0, 0, TAU);
            ctx.fill();
            ctx.fillStyle = hazed(d.pebble[tone], item.x, item.y);
            ctx.beginPath();
            ctx.ellipse(sx, sy - 1.5 * s, 6 * s, 4 * s, 0, 0, TAU);
            ctx.fill();
            ctx.fillStyle = rgba(d.pebbleLight, 0.6);
            ctx.beginPath();
            ctx.ellipse(sx - 1.6 * s, sy - 3 * s, 2.4 * s, 1.4 * s, 0, 0, TAU);
            ctx.fill();
        }
    }
    ctx.save();
    ctx.filter = blur(3);
    const shadows = [
        ...look.props,
        ...look.bases.flatMap((base) => base.flags.map((flag) => ({ kind: 'flag', ...flag }))),
    ];
    for (const prop of shadows) {
        const shadow = PROP_SHADOWS[prop.kind];
        if (!shadow) continue;
        const k = prop.scale,
            w = shadow.width * k,
            sx = prop.x + shadow.dx * k,
            sy = (prop.y + shadow.dy) * GS;
        ctx.fillStyle = rgba(pal.prop.shadow, shadow.alpha);
        ctx.beginPath();
        ctx.ellipse(sx + w * 0.22, sy + w * 0.06, w * 0.62, w * 0.24, 0, 0, TAU);
        ctx.fill();
    }
    ctx.restore();

    // ---- the far distance dissolves into the haze colour the renderer clears the screen with ----
    ground();
    const { side, far } = look.margin;
    const fade = (fx0, fy0, fx1, fy1, rx, ry, rw, rh) => {
        const gradient = ctx.createLinearGradient(fx0, fy0, fx1, fy1);
        gradient.addColorStop(0, rgba(pal.haze, 0));
        gradient.addColorStop(1, pal.haze);
        ctx.fillStyle = gradient;
        ctx.fillRect(rx, ry, rw, rh);
    };
    const wide = W + side * 2 + 40,
        tall = H + side + far + 40;
    fade(0, H + far * 0.3, 0, H + far, -side - 20, H + far * 0.3, wide, far);
    fade(0, -side * 0.45, 0, -side, -side - 20, -side - 20, wide, side * 0.55 + 20);
    fade(-side * 0.45, 0, -side, 0, -side - 20, -side - 20, side * 0.55 + 20, tall);
    fade(W + side * 0.45, 0, W + side, 0, W + side * 0.45, -side - 20, side * 0.55 + 20, tall);
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    return canvas;
}
