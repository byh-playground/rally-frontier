// How the battlefield renderer shows a map's ground and scenery. A map that names a theme (definitions/map-themes.js)
// gets a ThemedMapLook: its ground is painted into textures once when the map loads and its standing props are built
// once, so a frame only draws those textures and copies prop vertices. A map without a theme keeps the renderer's own
// drawGround. mapLookFor is the one place that tells the two apart.
import { MAP_THEMES } from '../definitions/map-themes.js';
import { BattlefieldProjection } from '../sim/terrain.js';
import { buildMapLook, mapViewGeometry } from './map-look-layout.js';
import { paintGroundCanvas } from './map-look-ground.js';
import { buildMapProps } from './map-look-props.js';

// The field is baked at about one texel per screen pixel at the default zoom; the distance beyond the boundary, seen
// only when zoomed far out, at a fraction of that. Each layer is cut into chunks of at most CHUNK_TEXELS a side.
const FIELD_TEXELS_PER_UNIT = 1,
    FAR_TEXELS_PER_UNIT = 0.4,
    FIELD_SKIRT = 128,
    CHUNK_TEXELS = 4096,
    GUTTER = 1,
    FLOATS_PER_CHUNK = 30,
    BAND_STEP = 0.09;

const LEGACY_MAP_LOOK = Object.freeze({
    drawGround: (r) => r.drawGround(),
    drawGroundMarks: (r) => r.drawStrategicMap(),
    drawProps() {},
    dispose() {},
});

export function mapLookFor(r, descriptor) {
    return descriptor?.theme ? new ThemedMapLook(r, descriptor) : LEGACY_MAP_LOOK;
}

class ThemedMapLook {
    constructor(r, descriptor) {
        const theme = MAP_THEMES[descriptor.theme];
        if (!theme) throw new Error(`Unknown map theme: ${descriptor.theme}`);
        // Decoration follows the map and the theme only, never the match seed.
        const seed = `${descriptor.generator}:${descriptor.theme}`,
            look = buildMapLook(
                mapViewGeometry(descriptor, r.orientationRole() === 'guest'),
                theme,
                seed,
            ),
            { width, height, margin } = look,
            [red, green, blue] = [1, 3, 5].map(
                (i) => parseInt(theme.palette.haze.slice(i, i + 2), 16) / 255,
            );
        this.haze = [red, green, blue, 1];
        // Raised ground keeps its mesh (depth, cliffs, ramps) and takes the theme's colours.
        this.terrainColors = Object.fromEntries(
            Object.entries(theme.palette.terrain).map(([name, hex]) => [
                name,
                [...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), 1],
            ]),
        );
        this.props = buildMapProps(look, theme, BattlefieldProjection, seed);
        this.bases = look.bases;
        this.field = {
            x0: -FIELD_SKIRT,
            y0: -FIELD_SKIRT,
            x1: width + FIELD_SKIRT,
            y1: height + FIELD_SKIRT,
        };
        this.chunks = [];
        const limit = Math.min(CHUNK_TEXELS, r.device.maxTextureSize) - GUTTER * 2;
        const bake = (area, density, field) => {
            const columns = Math.ceil(((area.x1 - area.x0) * density) / limit),
                rows = Math.ceil(
                    ((area.y1 - area.y0) * BattlefieldProjection.groundScale * density) / limit,
                );
            for (let row = 0; row < rows; row++)
                for (let column = 0; column < columns; column++) {
                    const x0 = area.x0 + ((area.x1 - area.x0) * column) / columns,
                        x1 = area.x0 + ((area.x1 - area.x0) * (column + 1)) / columns,
                        y0 = area.y0 + ((area.y1 - area.y0) * row) / rows,
                        y1 = area.y0 + ((area.y1 - area.y0) * (row + 1)) / rows,
                        canvas = paintGroundCanvas(look, theme, BattlefieldProjection, {
                            x0,
                            y0,
                            x1,
                            y1,
                            density,
                            gutter: GUTTER,
                            field,
                        });
                    this.chunks.push({
                        texture: r.device.createTexture(canvas),
                        field,
                        x0,
                        y0,
                        x1,
                        y1,
                        u0: GUTTER / canvas.width,
                        v0: GUTTER / canvas.height,
                        u1: (GUTTER + (x1 - x0) * density) / canvas.width,
                        v1:
                            (GUTTER + (y1 - y0) * BattlefieldProjection.groundScale * density) /
                            canvas.height,
                        texels: canvas.width * canvas.height,
                    });
                }
        };
        // Far scenery first, the field over it.
        bake(
            {
                x0: -margin.side,
                y0: -margin.side,
                x1: width + margin.side,
                y1: height + margin.far,
            },
            FAR_TEXELS_PER_UNIT,
            false,
        );
        bake(this.field, FIELD_TEXELS_PER_UNIT, true);
        this.vertices = new Float32Array(this.chunks.length * FLOATS_PER_CHUNK);
        this.world = { x: 0, y: 0, z: 0, groundY: 0 };
        this.point = {};
        this.color = [0, 0, 0, 1];
        this.stats = {
            theme: descriptor.theme,
            textures: this.chunks.length,
            texels: this.chunks.reduce((sum, chunk) => sum + chunk.texels, 0),
            props: this.props.length,
            layout: look.counts,
        };
    }
    // A view-space ground point on the screen.
    project(r, x, y) {
        const world = this.world;
        world.x = r.viewX(x);
        world.z = r.viewY(y);
        return r.projectRenderWorldPosition(world, this.point);
    }
    drawGround(r) {
        const width = r.canvas.width,
            height = r.canvas.height,
            a = r.projectedCoordinatesAtScreen(0, 0),
            b = r.projectedCoordinatesAtScreen(width, height),
            top = BattlefieldProjection.viewYFromPlane(a.y),
            bottom = BattlefieldProjection.viewYFromPlane(b.y),
            f = this.field,
            // In a match the camera stays over the field: its texture alone covers the screen.
            fieldOnly = a.x >= f.x0 && b.x <= f.x1 && top >= f.y0 && bottom <= f.y1,
            data = this.vertices,
            depth = r._renderDepth;
        if (!fieldOnly) {
            r.rect(0, 0, width, height, this.haze);
            r.flush();
            r.begin();
        }
        let count = 0;
        for (const chunk of this.chunks) {
            if (fieldOnly && !chunk.field) continue;
            if (chunk.x1 < a.x || chunk.x0 > b.x || chunk.y1 < top || chunk.y0 > bottom) continue;
            chunk.first = count * 6;
            let i = count++ * FLOATS_PER_CHUNK;
            for (const [x, y, u, v] of [
                [chunk.x0, chunk.y0, chunk.u0, chunk.v0],
                [chunk.x1, chunk.y0, chunk.u1, chunk.v0],
                [chunk.x1, chunk.y1, chunk.u1, chunk.v1],
                [chunk.x0, chunk.y0, chunk.u0, chunk.v0],
                [chunk.x1, chunk.y1, chunk.u1, chunk.v1],
                [chunk.x0, chunk.y1, chunk.u0, chunk.v1],
            ]) {
                const p = this.project(r, x, y);
                data[i++] = p.x;
                data[i++] = p.y;
                data[i++] = depth;
                data[i++] = u;
                data[i++] = v;
            }
            chunk.shown = true;
        }
        if (count) {
            const used = data.subarray(0, count * FLOATS_PER_CHUNK);
            r.device.uploadVertices(r.groundTextureBuffer, used);
            for (const chunk of this.chunks) {
                if (!chunk.shown) continue;
                chunk.shown = false;
                r.drawBatch(
                    r.groundTexturePipeline,
                    r.groundTextureBuffer,
                    chunk.first,
                    6,
                    { r: [width, height], tex: 0 },
                    [chunk.texture],
                );
            }
            r.perfStats.drawCalls += count;
            r.perfStats.bufferUploadBytes += used.byteLength;
        }
        r.drawTerrainSurfaces(this.terrainColors);
    }
    // Ground marks that change during a match: each base's band in the viewer's colour for that side, and the
    // capture points' ownership.
    drawGroundMarks(r) {
        for (const base of this.bases) {
            const color = r.factionColor(base.side, { alpha: 0.55 });
            for (const band of base.band) {
                const steps = Math.max(2, Math.ceil((band.end - band.start) / BAND_STEP));
                let innerX = 0,
                    innerY = 0,
                    outerX = 0,
                    outerY = 0;
                for (let i = 0; i <= steps; i++) {
                    const angle = band.start + ((band.end - band.start) * i) / steps,
                        cos = Math.cos(angle),
                        sin = Math.sin(angle),
                        inner = band.radius - band.width / 2,
                        outer = band.radius + band.width / 2;
                    let p = this.project(r, base.x + cos * inner, base.y + sin * inner);
                    const ix = p.x,
                        iy = p.y;
                    p = this.project(r, base.x + cos * outer, base.y + sin * outer);
                    if (i) r.quad(innerX, innerY, outerX, outerY, p.x, p.y, ix, iy, color);
                    innerX = ix;
                    innerY = iy;
                    outerX = p.x;
                    outerY = p.y;
                }
            }
        }
        r.drawCapturePointMarks();
    }
    // Standing props, far to near, each at the depth of its foot: units behind one are hidden, units in front
    // of it cover it. A prop on fogged ground is darkened like the ground under it.
    drawProps(r) {
        const sc = r.sc(),
            width = r.canvas.width,
            height = r.canvas.height,
            previous = r._renderDepth,
            fog = r.fogColor(),
            mixed = this.color;
        for (const prop of this.props) {
            const p = this.project(r, prop.x, prop.y),
                x = p.x,
                y = p.y;
            if (
                x + prop.right * sc < 0 ||
                x + prop.left * sc > width ||
                y + prop.bottom * sc < 0 ||
                y + prop.top * sc > height
            )
                continue;
            r.setRenderDepth(r.renderDepthForWorld({ z: r.viewY(prop.front) }) - 0.0005);
            const shade = prop.fogged ? r.fogAmountAt(r.viewX(prop.x), r.viewY(prop.y)) : 0;
            for (const part of prop.parts) {
                let color = part.team == null ? part.color : r.factionColor(part.team);
                if (shade > 0) {
                    mixed[0] = color[0] + (fog[0] - color[0]) * shade;
                    mixed[1] = color[1] + (fog[1] - color[1]) * shade;
                    mixed[2] = color[2] + (fog[2] - color[2]) * shade;
                    color = mixed;
                }
                const points = part.points,
                    ax = x + points[0] * sc,
                    ay = y + points[1] * sc;
                for (let i = 2; i < points.length - 2; i += 2) {
                    r.v(ax, ay, color);
                    r.v(x + points[i] * sc, y + points[i + 1] * sc, color);
                    r.v(x + points[i + 2] * sc, y + points[i + 3] * sc, color);
                }
            }
        }
        r._renderDepth = previous;
    }
    dispose(r) {
        for (const chunk of this.chunks) r.device.deleteTexture(chunk.texture);
        this.chunks.length = 0;
    }
}
