// How the battlefield renderer shows a map's ground and scenery. A map that names a theme (definitions/map-themes.js)
// gets a ThemedMapLook: its ground is one static mesh and its standing props are triangle fans, both built once in
// world coordinates when the map loads. A frame draws the mesh with the camera as uniforms and copies the visible
// props' vertices; turning the view for the guest or a replay rebuilds nothing. A map without a theme keeps the
// renderer's own drawGround. mapLookFor is the one place that tells the two apart.
import { MAP_THEMES } from '../definitions/map-themes.js';
import { BattlefieldProjection } from '../sim/terrain.js';
import { buildMapLook, mapGeometry } from './map-look-layout.js';
import { GROUND_VERTEX_FLOATS, buildGroundMesh } from './map-look-ground.js';
import { buildMapProps } from './map-look-props.js';

const BAND_STEP = 0.09;

const LEGACY_MAP_LOOK = Object.freeze({
    // The camera stops at the map's edges.
    cameraMargin: 0,
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
        const seed = `${descriptor.topology}:${descriptor.theme}`,
            look = buildMapLook(mapGeometry(descriptor), theme, seed);
        this.bases = look.bases;
        this.cameraMargin = theme.camera.margin;
        this.props = buildMapProps(look, theme, BattlefieldProjection, seed);
        // Raised ground keeps its mesh (depth, cliffs, ramps) and takes the theme's colours.
        this.terrainColors = Object.fromEntries(
            Object.entries(theme.palette.terrain).map(([name, hex]) => [
                name,
                [...[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255), 1],
            ]),
        );
        // The ground mesh stays in memory: the GPU copy is lost with the context and uploaded again from here.
        this.ground = buildGroundMesh(look, theme, BattlefieldProjection);
        this.uploaded = false;
        this.onContextRestored = () => (this.uploaded = false);
        r.canvas.addEventListener('webglcontextrestored', this.onContextRestored);
        this.upload(r);
        this.world = { x: 0, y: 0, z: 0, groundY: 0 };
        this.point = {};
        this.color = [0, 0, 0, 1];
        this.stats = {
            theme: descriptor.theme,
            groundVertices: this.ground.length / GROUND_VERTEX_FLOATS,
            groundBytes: this.ground.byteLength,
            props: this.props.length,
            layout: look.counts,
        };
    }
    upload(r) {
        r.device.uploadVertices(r.groundMeshBuffer, this.ground);
        this.uploaded = true;
    }
    // A world ground point on the screen.
    project(r, x, y) {
        const world = this.world;
        world.x = x;
        world.z = y;
        return r.projectRenderWorldPosition(world, this.point);
    }
    // The whole ground is one draw: the mesh is already on the GPU, and the camera (and which way up the viewer
    // sees the map) arrives as the screen positions of the world origin and of one unit along each axis.
    drawGround(r) {
        if (!this.uploaded) this.upload(r);
        let p = this.project(r, 0, 0);
        const ox = p.x,
            oy = p.y;
        p = this.project(r, 1, 0);
        const ex = [p.x - ox, p.y - oy];
        p = this.project(r, 0, 1);
        r.drawBatch(
            r.groundMeshPipeline,
            r.groundMeshBuffer,
            0,
            this.ground.length / GROUND_VERTEX_FLOATS,
            {
                r: [r.canvas.width, r.canvas.height],
                o: [ox, oy],
                ex,
                ey: [p.x - ox, p.y - oy],
                sc: r.sc(),
                depth: r._renderDepth,
            },
        );
        r.perfStats.drawCalls++;
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
        const guest = r.orientationRole() === 'guest',
            props = this.props;
        // The fog's masks for this frame, before any prop reads them.
        r.prepareFogAmount();
        for (let index = 0; index < props.length; index++) {
            // Far to near: the list is in the host's order.
            const prop = props[guest ? props.length - 1 - index : index],
                p = this.project(r, prop.x, prop.y),
                x = p.x,
                y = p.y;
            if (
                x + prop.right * sc < 0 ||
                x + prop.left * sc > width ||
                y + prop.bottom * sc < 0 ||
                y + prop.top * sc > height
            )
                continue;
            // Depth at the prop's draw-order line: its foot moved towards the viewer.
            r.setRenderDepth(
                r.renderDepthForWorld({
                    z: guest ? prop.y - prop.front[1] : prop.y + prop.front[0],
                }) - 0.0005,
            );
            const shade = prop.fogged ? r.fogAmountAt(prop.x, prop.y) : 0;
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
        r.canvas.removeEventListener('webglcontextrestored', this.onContextRestored);
    }
}
