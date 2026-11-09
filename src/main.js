import { RESOURCES, ResourceDisplay } from './ui/resource-display.js';
import { CAMPAIGN_STAGES, campaignStage } from './definitions/campaign.js';
import { RangeUtil, SIM_TPS } from './core/game-rules.js';
import { SimulationTiming } from './core/simulation-timing.js';
import {
    createLocalPerfStats,
    createLocalBalanceStats,
    measureSessionPulse,
} from './diagnostics/simulation-stats.js';
import './sim/strategy-sim.js';
import { TerrainQuery, VisibilityPolicy } from './sim/entities.js';
import { BotController } from './ai/bot-controller.js';
import { GameSession, RallySynctestDiagnostics } from './session/game-session.js';
import { WorkerSessionProxy } from './session/worker-session-proxy.js';
import { ReplayPlayer } from './session/replay.js';
import { ReplayPolicy } from './session/replay-recording.js';
import {
    ActiveViewState,
    BACKGROUND_TICK_SESSIONS,
    NetworkModuleLoader,
} from './session/runtime-state.js';
import { LaunchRules } from './sim/launch-rules.js';
import { ConstructionRules } from './sim/construction-rules.js';
import { LaunchImpactRules } from './definitions/launch-impact-rules.js';
import { fruitProjectilePosition } from './definitions/fruit-hero-trajectory.js';
import { RoomTransport } from './net/rtc-transport.js';
import { RecoveryTelemetry } from './diagnostics/recovery-telemetry.js';
import { recordRecovery } from './diagnostics/recovery-flight-recorder.js';
import { ConnectionSideUtil } from './net/lobby-codec.js';
import { CloneUtil, HashUtil, MapGeneration } from './sim/map-generation.js';
import { AttackPresentationDefinition } from './definitions/attack-presentation.js';
import { BuildingDefinition } from './definitions/buildings.js';
import {
    GRAIN_FACE_IDS,
    GRAIN_SPRITE_BASE_SCALE,
    UNIT_RENDER_RADIUS_SCALE,
    UnitDefinition,
    UnitFactionPalette,
    UnitVisualDefinition,
} from './definitions/units.js';
import { MapGeometry } from './sim/map-geometry.js';
import { CAPTURE_RADIUS, LANE_CONTROL_POINTS } from './definitions/combat-rules.js';
import { PerformanceTelemetry } from './diagnostics/performance-telemetry.js';
import { VIEW_H, VIEW_W } from './definitions/world-rules.js';
import { WorldContext } from './sim/world-context.js';
import {
    InteractionGeometry,
    NavigationGoal,
    TerrainNavigation,
    UnitMotion,
} from './sim/navigation.js';
import {
    BattlefieldProjection,
    TerrainSurfaceAtlas,
    TerrainSurfaceProjection,
} from './sim/terrain.js';
import { BACKGROUND_TICK_PULSE_MS } from './core/session-timing.js';
import { RenderStateStore } from './render/render-state-store.js';
import { BuildingArt } from './render/building-art.js';
import {
    createPresentationView,
    EffectObjectFactory,
    FloatingTextPresentationDefinition,
} from './render/presentation-effects.js';
import { GRAIN_SPRITES } from './render/grain-sprite-registry.js';
import { heroBasicAttackElapsedMs, HERO_BASIC_STRIKE_MS } from './render/hero-basic-motion.js';
import {
    setWatermelonRollMatrix,
    watermelonRollProgress,
    watermelonRollTuck,
} from './render/watermelon-sprite.js';
import { LaunchImpactArt } from './render/launch-impact-art.js';
import {
    CONFIG,
    FP,
    LAUNCH_HOLD_ARM_MS,
    LAUNCH_HOLD_DRAG_PX,
    STATE_PUBLISH_HZ,
    STATE_PUBLISH_INTERVAL_MS,
    setNetcodeMode,
} from './core/config.js';
import { BUILD_META } from './core/build-info.js';
import { PRODUCT_VERSION } from './core/product-version.js';
import { RallyGamekit } from './core/gamekit.js';
import { LaunchScreens } from './ui/launch-screens.js';
import { createShowcaseHost } from './ui/showcase-host.js';
import { DeckEditor } from './ui/deck-editor.js';
import { CampaignProgress } from './ui/campaign-progress.js';
import { CampaignPresentation } from './ui/campaign-presentation.js';
import { grainPortrait } from './ui/grain-portrait.js';
import { readDevQuery } from './ui/dev-query.js';
import { AudioSystem } from './audio/audio-system.js';
const {
    insetPolygonTowardCenter,
    pointInSimplePolygon,
    polylineToRibbonPolygon,
    triangulatePolygon,
} = RallyGamekit;

/* =========================
   5. WebGL renderer + fog
   ========================= */

// Renderer-only reuse helpers. They never enter StrategySim/checksum/export/recovery.
// The goal is to remove short-lived allocations from 60 fps geometry/VFX, 20 Hz render targets, and 10 Hz full snapshots.
class ReusableFloat32Buffer {
    constructor(initialCapacity = 65536) {
        let cap = 1;
        while (cap < initialCapacity) cap <<= 1;
        this.data = new Float32Array(cap);
        this.length = 0;
        this.grows = 0;
    }
    reset() {
        this.length = 0;
    }
    ensure(extra) {
        const need = this.length + extra;
        if (need <= this.data.length) return;
        let cap = this.data.length || 1;
        while (cap < need) cap <<= 1;
        const next = new Float32Array(cap);
        next.set(this.data.subarray(0, this.length));
        this.data = next;
        this.grows++;
    }
    push5(a, b, c, d, e) {
        this.ensure(5);
        const i = this.length,
            v = this.data;
        v[i] = a;
        v[i + 1] = b;
        v[i + 2] = c;
        v[i + 3] = d;
        v[i + 4] = e;
        this.length = i + 5;
    }
    push7(a, b, c, d, e, f, g) {
        this.ensure(7);
        const i = this.length,
            v = this.data;
        v[i] = a;
        v[i + 1] = b;
        v[i + 2] = c;
        v[i + 3] = d;
        v[i + 4] = e;
        v[i + 5] = f;
        v[i + 6] = g;
        this.length = i + 7;
    }
    view() {
        return this.data.subarray(0, this.length);
    }
}

/* Developer architecture contract:
   Perspective ownership: domain policy/query/presentation helpers belong to cohesive
   owner classes and consumers call Owner.method() directly. Definition data and its
   interpretation stay with the Definition owner. Do not expose this developer-only
   architecture contract in player-facing help UI. */
/* Error ownership invariant:
   window.__RALLY_GLOBAL_ERROR_HANDLER__ / __RALLY_PRESENT_FATAL__ is the single global
   error presentation sink. window error, unhandled rejection, simulation, renderer,
   presentation-contract and watchdog diagnostics all converge there. Domain owners may
   enrich context but must not install competing global error handlers or fatal overlays. */
/* Global diagnostic contract:
   Only concrete failures reach the fatal UI:
   - window error
   - unhandled promise rejection
   - simulation fatal catch
   - renderer fatal catch
   Heuristic "nothing happened for N seconds" presentation errors are forbidden. */
class DiagnosticPresentation {
    static journal = new RallyGamekit.DiagnosticRing({ capacity: 20, release: BUILD_META.id });
    static presentFatalDiagnostic(diag) {
        this.journal.report(new Error(diag.message || diag.kind), {
            kind: diag.kind || 'fatal',
            fatal: true,
            origin: diag.stage || 'game',
        });
        diag = {
            ...diag,
            build: BUILD_META.id,
            buildMetadata: BUILD_META.snapshot(),
            gamekitDiagnostic: this.journal.snapshot(),
        };
        const sink = window.__RALLY_PRESENT_FATAL__;
        if (typeof sink === 'function') {
            sink(diag);
            return;
        }
        window.__RALLY_FATAL_DIAGNOSTIC__ = diag;
        console.error('[쌀콩팡!] diagnostic bootstrap unavailable', diag);
    }
}

// ============================================================
// Unit Visual Registry — species-specific composition boundary.
// IS-A UnitVisual. Shared pipeline is HAS-A. Runtime state remains CAN-BE.
// ============================================================
class GeometryTemplateCache {
    constructor() {
        this.regular = new Map();
        this.outline = new Map();
        this.petals = new Map();
    }
    regularPolygon(n = 10, rot = 0) {
        n = Math.max(3, n | 0);
        const key = n + '|' + Number(rot).toFixed(6);
        let pts = this.regular.get(key);
        if (pts) return pts;
        pts = new Float32Array(n * 2);
        for (let i = 0; i < n; i++) {
            const a = rot + (i / n) * Math.PI * 2;
            pts[i * 2] = Math.cos(a);
            pts[i * 2 + 1] = Math.sin(a);
        }
        this.regular.set(key, pts);
        return pts;
    }
    outlineCircle(segments = 56) {
        segments = Math.max(3, segments | 0);
        let pts = this.outline.get(segments);
        if (pts) return pts;
        pts = new Float32Array(segments * 2);
        for (let i = 0; i < segments; i++) {
            const a = (i / segments) * Math.PI * 2;
            pts[i * 2] = Math.cos(a);
            pts[i * 2 + 1] = Math.sin(a);
        }
        this.outline.set(segments, pts);
        return pts;
    }
    petalRing(count = 6, rot = 0) {
        count = Math.max(1, count | 0);
        const key = count + '|' + Number(rot).toFixed(6);
        let pts = this.petals.get(key);
        if (pts) return pts;
        pts = new Float32Array(count * 2);
        for (let i = 0; i < count; i++) {
            const a = rot + (i / count) * Math.PI * 2;
            pts[i * 2] = Math.cos(a);
            pts[i * 2 + 1] = Math.sin(a);
        }
        this.petals.set(key, pts);
        return pts;
    }
}
const SHARED_GEOMETRY_TEMPLATES = new GeometryTemplateCache();
// GameKit's retained stroke offsets are in CSS pixels after the ellipse is projected.
function buildGrainTeamRing() {
    const segments = 14,
        halfStrokePx = 1,
        vertices = [],
        indices = [];
    for (let i = 0; i < segments; i++) {
        const angle = (i / segments) * Math.PI * 2,
            x = Math.cos(angle),
            y = Math.sin(angle);
        // Position, RGBA, unit tangent, tangent/normal pixel offsets, part index.
        for (const offset of [halfStrokePx, -halfStrokePx])
            vertices.push(x, y, 1, 1, 1, 1, -y, x, 0, offset, 0);
        const a = i * 2,
            b = ((i + 1) % segments) * 2;
        indices.push(a, b, b + 1, a, b + 1, a + 1);
    }
    return {
        vertices: new Float32Array(vertices),
        indices: new Uint16Array(indices),
        strideFloats: 11,
        partCount: 1,
        morphCount: 0,
        nonScalingStroke: true,
    };
}
// Depth gap between consecutive grains in painter order: a few 24-bit depth steps, so 500 grains shift terrain occlusion by ~2e-4.
const GRAIN_DEPTH_RANK_STEP = 4e-7;
// Bound presentation-only retention while avoiding churn when the camera crosses a unit.
const GRAIN_ACTOR_RETENTION_MS = 2000;
const GRAIN_ACTOR_HIDDEN_LIMIT = 512;

class RenderPassProfiler {
    constructor() {
        this.names = [
            'prepare',
            'device-begin',
            'ground',
            'shadow',
            'world',
            'overlay',
            'ui-fx',
            'camera-compose',
            'minimap',
        ];
        this.current = Object.create(null);
        this.ewma = Object.create(null);
        this.max = Object.create(null);
    }
    beginFrame() {
        for (const n of this.names) this.current[n] = 0;
    }
    measure(name, fn) {
        const t = performance.now();
        try {
            return fn();
        } finally {
            const ms = performance.now() - t;
            this.current[name] = (this.current[name] || 0) + ms;
            this.ewma[name] = this.ewma[name] ? this.ewma[name] * 0.85 + ms * 0.15 : ms;
            this.max[name] = Math.max(this.max[name] || 0, ms);
        }
    }
    snapshot() {
        const out = {};
        for (const n of this.names)
            out[n] = {
                ms: this.current[n] || 0,
                ewmaMs: this.ewma[n] || 0,
                maxMs: this.max[n] || 0,
            };
        return out;
    }
}
const PROJECTILE_VISUAL_RENDER_FNS = Object.freeze({
    launchAmmo: (rdr, c) => {
        const { p, sc, screenMotion, x, y } = c;
        // Each grain flies as its own bundle SVG, nose along the screen-space flight direction.
        const record = rdr.launchAmmoRecord(p.payload?.type);
        if (!record) return;
        let dx = screenMotion?.valid ? screenMotion.dx : 1,
            dy = screenMotion?.valid ? screenMotion.dy : 0;
        if (
            record.cornCone &&
            !screenMotion?.valid &&
            Number.isFinite(p.lockedAimX) &&
            Number.isFinite(p.lockedAimY)
        ) {
            const target = rdr.worldToPx(rdr.viewX(p.lockedAimX), rdr.viewY(p.lockedAimY));
            dx = target[0] - x;
            dy = target[1] - y;
        }
        const length = Math.max(30, 58 * sc);
        rdr.drawVectorBillboard(record, x, y, Math.atan2(dy, dx), length / 200, {
            depthTest: !!(record.cornCone || record.heroAmmo),
        });
        rdr.circle(
            x,
            y,
            Math.max(2, 3 * sc),
            rdr.factionRelation(p.side) === 'friendly' ? [0.3, 0.55, 1, 1] : [1, 0.36, 0.32, 1],
            8,
        );
    },
});
function fruitShotsAt(attack, tick) {
    if (!attack) return [];
    const active = attack.active?.shot;
    const shots = active ? [...attack.projectiles, active] : attack.projectiles;
    return shots.filter((shot) => tick >= shot.startTick && tick < shot.endTick);
}
const THORN_TRAIL_COLOR = Object.freeze([151 / 255, 93 / 255, 43 / 255, 1]);
const THORN_IMPACT_COLOR = Object.freeze([225 / 255, 157 / 255, 65 / 255, 1]);
const BUILDING_VISUAL_RENDER_FNS = Object.freeze({
    base: (renderer, { b }) => renderer.buildingArt.draw(b, renderer.cannonArtOptions(b)),
    outpost: (renderer, { b }) => renderer.buildingArt.draw(b, renderer.cannonArtOptions(b)),
});
class TerrainPresentation {
    static colors = Object.freeze({
        lowGround: Object.freeze([0.69, 0.81, 0.63, 1]),
        highGround: Object.freeze([0.64, 0.72, 0.47, 1]),
        rampLow: Object.freeze([0.66, 0.62, 0.42, 1]),
        rampHigh: Object.freeze([0.69, 0.69, 0.44, 1]),
    });
    static css(color) {
        return `rgba(${Math.round(color[0] * 255)},${Math.round(color[1] * 255)},${Math.round(color[2] * 255)},${color[3] ?? 1})`;
    }
    static fillPlanarGround(c, w, h) {
        c.fillStyle = this.css(this.colors.lowGround);
        c.fillRect(0, 0, w, h);
    }
    static riverSurfaceCache = new WeakMap();
    static riverSurfaceMesh(map, atlas) {
        let mesh = this.riverSurfaceCache.get(atlas);
        if (mesh) return mesh;
        mesh = [];
        {
            const terrain = MapGeneration.mapTerrainDescriptor(map),
                sources = [];
            const add = (poly) => {
                if (poly?.length >= 3) sources.push(poly);
            };
            if (terrain.riverPolygon?.length >= 3) add(terrain.riverPolygon);
            else if (terrain.riverPath?.length > 1)
                add(polylineToRibbonPolygon(terrain.riverPath, terrain.riverHalfWidth));
            for (const poly of terrain.riverBranchPolygons || []) add(poly);
            if (!terrain.riverBranchPolygons?.length)
                for (const path of terrain.riverBranches || [])
                    if (path.length > 1)
                        add(polylineToRibbonPolygon(path, terrain.riverHalfWidth * 0.72));
            const floors = (atlas.renderSurfaceMesh || atlas.surfaceMesh).filter((p) => {
                if (p.kind !== 'plateau' || p.level > 0) return false;
                const layer = atlas.layers.find((l) => l.id === p.id);
                return !layer || p.level <= (layer.parent?.level ?? 0);
            });
            for (const source of sources)
                for (const [poly, color] of [
                    [source, [0.1, 0.31, 0.39, 0.6]],
                    [insetPolygonTowardCenter(source, 0.12), [0.2, 0.52, 0.64, 0.44]],
                ]) {
                    const triangles = triangulatePolygon(poly).triangles;
                    for (const floor of floors)
                        for (const indices of floor.triangles) {
                            const clip = indices.map((i) => ({
                                x: floor.vertices[i].x,
                                y: floor.vertices[i].z,
                            }));
                            if (NavigationGoal.cross(clip[0], clip[1], clip[2]) < 0) clip.reverse();
                            for (const tri of triangles) {
                                const points = NavigationGoal.clipPolygon(
                                    tri.map((i) => poly[i]),
                                    clip,
                                );
                                for (let i = 1; i < points.length - 1; i++) {
                                    const tri = [points[0], points[i], points[i + 1]],
                                        x = tri.reduce((s, p) => s + p.x, 0) / 3,
                                        y = tri.reduce((s, p) => s + p.y, 0) / 3;
                                    if (
                                        atlas.levelAt(x, y) !== floor.level ||
                                        !TerrainQuery.at(map, x, y, atlas).river
                                    )
                                        continue;
                                    mesh.push({
                                        color,
                                        vertices: tri.map((p) => ({
                                            x: p.x,
                                            y: TerrainSurfaceAtlas.elevationForLevel(floor.level),
                                            z: p.y,
                                            groundY: 0,
                                        })),
                                    });
                                }
                            }
                        }
                }
        }
        this.riverSurfaceCache.set(atlas, mesh);
        return mesh;
    }
    static drawRiverSurfaces(r, map, restoreDepthWrite = null) {
        const mesh = this.riverSurfaceMesh(map, r.world.terrain.surfaces);
        if (!mesh.length) return;
        const projection = TerrainSurfaceProjection.forAtlas(
            r.world.terrain.surfaces,
        ).projectedTriangleMesh(mesh, r.orientationRole() === 'guest');
        const a = r.projectedCoordinatesAtScreen(0, 0),
            b = r.projectedCoordinatesAtScreen(r.canvas.width, r.canvas.height);
        const visible = projection.index
            .query(a.x, a.y, b.x, b.y, 1 / r.sc())
            .sort((a, b) => a.order - b.order);
        r.perfStats.riverVisibleTriangles = visible.length;
        r.perfStats.riverTotalTriangles = mesh.length;
        const previous = r._renderDepth,
            depthWrite = restoreDepthWrite ?? r.passState.depthWrite;
        r.passState.depthWrite = false;
        r.begin();
        try {
            for (const { tri } of visible)
                for (const v of tri.vertices) {
                    const p = r.projectRenderWorldPosition(v);
                    r.setRenderDepth(p.depth - 0.0001);
                    r.v(p.x, p.y, tri.color);
                }
            r.flush();
        } finally {
            r.passState.depthWrite = depthWrite;
            r.setRenderDepth(previous);
            r.begin();
        }
    }
    static drawBridges(r, restoreDepthWrite = null) {
        const sc = r.sc(),
            previous = r._renderDepth,
            depthWrite = restoreDepthWrite ?? r.passState.depthWrite;
        r.passState.depthWrite = false;
        r.begin();
        try {
            // 다리: 실제 lane×river crossing descriptor를 그대로 사용. 다리 footprint는 평지 판정이다.
            for (const br of r.world.terrain.surfaces.bridges) {
                const deck = { x: br.x, y: br.elevation, z: br.y, groundY: 0, bridgeId: br.id };
                r.withWorldSpriteDepth(deck, () => {
                    const corners = br.points.map(({ x, y }) => {
                        const point = r.projectRenderWorldPosition({ ...deck, x, z: y });
                        return [point.x, point.y];
                    });
                    r.poly(corners, [0.58, 0.45, 0.28, 1]);
                    // Interpolation of projected deck edges preserves the affine ground projection.
                    const [a, b, c, d] = corners;
                    for (let i = -2; i <= 2; i++) {
                        const t = 0.5 + i / 5;
                        const x0 = a[0] + (b[0] - a[0]) * t;
                        const y0 = a[1] + (b[1] - a[1]) * t;
                        const x1 = d[0] + (c[0] - d[0]) * t;
                        const y1 = d[1] + (c[1] - d[1]) * t;
                        const dx = (x1 - x0) * 0.04;
                        const dy = (y1 - y0) * 0.04;
                        r.line(
                            x0 + dx,
                            y0 + dy,
                            x1 - dx,
                            y1 - dy,
                            Math.max(1, 1.4 * sc),
                            [0.76, 0.64, 0.42, 0.5],
                        );
                    }
                    r.line(...a, ...b, Math.max(1.2, 1.8 * sc), [0.34, 0.27, 0.18, 0.75]);
                    r.line(...d, ...c, Math.max(1.2, 1.8 * sc), [0.34, 0.27, 0.18, 0.75]);
                });
            }
            r.flush();
        } finally {
            r.passState.depthWrite = depthWrite;
            r.setRenderDepth(previous);
            r.begin();
        }
    }
    static drawSurfaces(r) {
        const atlas = r.world.terrain.surfaces;
        if (!atlas.layers.length && !atlas.bridges.length) return;
        const previous = r._renderDepth,
            mesh = TerrainSurfaceProjection.forAtlas(atlas).renderProjectedSurfaceMesh(
                r.orientationRole() === 'guest',
            );
        const a = r.projectedCoordinatesAtScreen(0, 0),
            b = r.projectedCoordinatesAtScreen(r.canvas.width, r.canvas.height);
        const visible = mesh.index
            .query(a.x, a.y, b.x, b.y, 1 / r.sc())
            .sort((a, b) => a.order - b.order);
        r.perfStats.terrainVisibleTriangles = visible.length;
        r.perfStats.terrainTotalTriangles = mesh.triangles.length;
        const colorCache = mesh.colors || (mesh.colors = new Map());
        for (const tri of visible) {
            const patch = tri.patch;
            let colors = colorCache.get(patch);
            if (!colors) {
                if (patch.kind === 'cliff') {
                    const f = patch.face,
                        dx = f.b.x - f.a.x,
                        dy = f.b.y - f.a.y,
                        light = (dx - dy) / (Math.hypot(dx, dy) || 1);
                    colors = patch.vertices.map(() => [
                        0.31 + light * 0.035,
                        0.37 + light * 0.035,
                        0.25 + light * 0.025,
                        1,
                    ]);
                } else if (patch.kind === 'ramp')
                    colors = patch.vertices.map((v) => {
                        const t = RangeUtil.clamp(
                            (v.y - TerrainSurfaceAtlas.elevationForLevel(patch.lowLevel)) /
                                (TerrainSurfaceAtlas.elevationForLevel(patch.highLevel) -
                                    TerrainSurfaceAtlas.elevationForLevel(patch.lowLevel)),
                            0,
                            1,
                        );
                        return this.colors.rampLow.map(
                            (c, i) => c + (this.colors.rampHigh[i] - c) * t,
                        );
                    });
                // The level-0 underlay already owns its grass/water markings. Write the
                // exact floor depth without repainting those colors; authored depressions remain opaque.
                else
                    colors = patch.vertices.map(() =>
                        patch.id === 'low-ground'
                            ? [...this.colors.lowGround.slice(0, 3), 0]
                            : patch.level === 0
                              ? this.colors.lowGround
                              : this.colors.highGround,
                    );
                colorCache.set(patch, colors);
            }
            const bridge = patch.bridge ? atlas.bridges.find((b) => b.id === patch.id) : null,
                deckDepth = bridge ? r.bridgeDepth(bridge) : null;
            for (let i = 0; i < 3; i++) {
                const p = r.projectRenderWorldPosition(tri.vertices[i]);
                r.setRenderDepth(deckDepth ?? p.depth);
                r.v(p.x, p.y, colors[tri.indices[i]]);
            }
        }
        r.setRenderDepth(previous);
    }
    static surfaceLine(r, a, b, ha, hb, width, color) {
        const previous = r._renderDepth;
        const p = r.projectRenderWorldPosition({ x: a.x, y: ha, z: a.y, groundY: 0 }),
            q = r.projectRenderWorldPosition({ x: b.x, y: hb, z: b.y, groundY: 0 });
        const dx = q.x - p.x,
            dy = q.y - p.y,
            len = Math.hypot(dx, dy) || 1,
            nx = ((-dy / len) * width) / 2,
            ny = ((dx / len) * width) / 2;
        const v = [
            { x: p.x + nx, y: p.y + ny, d: p.depth },
            { x: q.x + nx, y: q.y + ny, d: q.depth },
            { x: q.x - nx, y: q.y - ny, d: q.depth },
            { x: p.x - nx, y: p.y - ny, d: p.depth },
        ];
        for (const i of [0, 1, 2, 0, 2, 3]) {
            const p = v[i];
            r.setRenderDepth(p.d - 0.0008);
            r.v(p.x, p.y, color);
        }
        r.setRenderDepth(previous);
    }
    static drawSurfaceEdges(r) {
        const atlas = r.world.terrain.surfaces;
        if (!atlas.layers.length && !atlas.bridges.length) return;
        const sc = r.sc(),
            previous = r._renderDepth;
        // Endpoint depths preserve picking/render alignment on every ramp orientation.
        const edge = (...args) => this.surfaceLine(r, ...args);
        for (const f of atlas.renderFaces || atlas.faces)
            edge(
                f.a,
                f.b,
                f.highA ?? f.high,
                f.highB ?? f.high,
                Math.max(1, 3 * sc),
                [0.8, 0.83, 0.6, 1],
            );
        for (const ramp of atlas.ramps) {
            edge(
                ramp.lowA,
                ramp.lowB,
                ramp.lowElevation,
                ramp.lowElevation,
                Math.max(0.8, 1.5 * sc),
                [0.78, 0.73, 0.53, 1],
            );
            edge(
                ramp.highA,
                ramp.highB,
                ramp.highElevation,
                ramp.highElevation,
                Math.max(0.8, 1.5 * sc),
                [0.86, 0.81, 0.6, 1],
            );
            for (const t of [0.25, 0.5, 0.75]) {
                const a = TerrainSurfaceAtlas.lerp(ramp.lowA, ramp.highA, t),
                    b = TerrainSurfaceAtlas.lerp(ramp.lowB, ramp.highB, t),
                    h = ramp.lowElevation + (ramp.highElevation - ramp.lowElevation) * t;
                edge(a, b, h, h, Math.max(0.6, 1.1 * sc), [0.84, 0.79, 0.57, 0.28]);
            }
        }
        r.setRenderDepth(previous);
    }
    static drawSurfaceMini(c, map, pt, scale) {
        const atlas = TerrainSurfaceAtlas.fromMap(map);
        if (!atlas.layers.length) return;
        const fill = (points, color) => {
            c.fillStyle = color;
            c.beginPath();
            for (let i = 0; i < points.length; i++) {
                const p = pt(points[i]);
                if (i) c.lineTo(...p);
                else c.moveTo(...p);
            }
            c.closePath();
            c.fill();
        };
        for (const layer of atlas.layers
            .slice()
            .sort((a, b) => Math.abs(b.area) - Math.abs(a.area)))
            fill(
                layer.renderTopPoints || layer.topPoints,
                this.css(layer.level === 0 ? this.colors.lowGround : this.colors.highGround),
            );
        for (const ramp of atlas.ramps) {
            const a = pt(TerrainSurfaceAtlas.lerp(ramp.lowA, ramp.lowB, 0.5)),
                b = pt(TerrainSurfaceAtlas.lerp(ramp.highA, ramp.highB, 0.5));
            const gradient = c.createLinearGradient(...a, ...b);
            gradient.addColorStop(0, this.css(this.colors.rampLow));
            gradient.addColorStop(1, this.css(this.colors.rampHigh));
            fill(ramp.points, gradient);
        }
        c.strokeStyle = '#47573b';
        c.lineWidth = Math.max(0.75, 5 * scale);
        for (const f of atlas.renderFaces || atlas.faces) {
            const a = pt(f.a),
                b = pt(f.b);
            c.beginPath();
            c.moveTo(...a);
            c.lineTo(...b);
            c.stroke();
        }
    }

    static polygonMesh(points) {
        return triangulatePolygon(points);
    }
    static fillMesh(r, points, triangles, color) {
        for (const [a, b, c] of triangles) r.tri(...points[a], ...points[b], ...points[c], color);
    }

    static drawWorld(r, terrain, restoreDepthWrite = null) {
        const depthWrite = restoreDepthWrite ?? r.passState.depthWrite;
        this.drawSurfaces(r);
        // Only solid terrain owns occlusion. Ground decoration must not hide Fog.
        r.flush();
        r.begin();
        r.passState.depthWrite = false;
        const sc = r.sc(),
            pt = (p) => r.worldToPx(r.viewX(p.x), r.viewY(p.y));
        for (const road of terrain.roads || []) {
            const width = road.width * sc,
                atlas = r.world.terrain.surfaces;
            for (let i = 0; i < road.points.length - 1; i++) {
                const a = road.points[i],
                    b = road.points[i + 1],
                    ha = atlas.heightAt(a.x, a.y),
                    hb = atlas.heightAt(b.x, b.y);
                this.surfaceLine(r, a, b, ha, hb, width, [0.73, 0.68, 0.5, 0.42]);
                this.surfaceLine(r, a, b, ha, hb, width * 0.74, [0.84, 0.79, 0.62, 0.42]);
            }
            for (const p of road.points) {
                const q = pt(p);
                r.withWorldSpriteDepth(
                    { x: p.x, y: atlas.heightAt(p.x, p.y), z: p.y, groundY: 0 },
                    () => r.circle(q[0], q[1], width * 0.37, [0.84, 0.79, 0.62, 0.25], 16),
                );
            }
        }
        for (const block of terrain.blockers || []) {
            const points = block.points.map(pt),
                roots = block.kind === 'roots';
            const center = points.reduce(
                (p, q) => [p[0] + q[0] / points.length, p[1] + q[1] / points.length],
                [0, 0],
            );
            const minX = Math.min(...points.map((p) => p[0])),
                maxX = Math.max(...points.map((p) => p[0])),
                minY = Math.min(...points.map((p) => p[1])),
                maxY = Math.max(...points.map((p) => p[1]));
            if (
                maxX < -40 ||
                minX > r.canvas.width + 40 ||
                maxY < -40 ||
                minY > r.canvas.height + 40
            )
                continue;
            const anchor = block.points.reduce(
                (p, q) => ({
                    x: p.x + q.x / block.points.length,
                    y: p.y + q.y / block.points.length,
                }),
                { x: 0, y: 0 },
            );
            r.withWorldSpriteDepth(
                {
                    x: anchor.x,
                    y: r.world.terrain.surfaces.heightAt(anchor.x, anchor.y),
                    z: anchor.y,
                    groundY: 0,
                },
                () => {
                    const mesh = TerrainPresentation.polygonMesh(block.points);
                    if (!mesh.convex) {
                        TerrainPresentation.fillMesh(
                            r,
                            points.map((p) => [p[0] + 7 * sc, p[1] + 12 * sc]),
                            mesh.triangles,
                            [0.12, 0.17, 0.12, 0.24],
                        );
                        TerrainPresentation.fillMesh(
                            r,
                            points,
                            mesh.triangles,
                            roots ? [0.47, 0.43, 0.28, 1] : [0.49, 0.55, 0.44, 1],
                        );
                        for (let i = 0; i < points.length; i++) {
                            const a = points[i],
                                b = points[(i + 1) % points.length];
                            r.line(
                                a[0],
                                a[1],
                                b[0],
                                b[1],
                                Math.max(1, 3 * sc),
                                [0.7, 0.73, 0.59, 0.8],
                            );
                        }
                        return;
                    }
                    r.poly(
                        points.map((p) => [p[0] + 7 * sc, p[1] + 12 * sc]),
                        [0.12, 0.17, 0.12, 0.24],
                    );
                    r.poly(points, roots ? [0.27, 0.26, 0.17, 1] : [0.24, 0.31, 0.26, 1]);
                    const inner = points.map((p) => [
                        center[0] + (p[0] - center[0]) * 0.93,
                        center[1] + (p[1] - center[1]) * 0.9 - 3 * sc,
                    ]);
                    r.poly(inner, roots ? [0.47, 0.43, 0.28, 1] : [0.49, 0.55, 0.44, 1]);
                    const top = inner.map((p) => [
                        center[0] + (p[0] - center[0]) * 0.85,
                        center[1] + (p[1] - center[1]) * 0.78,
                    ]);
                    r.poly(top, roots ? [0.55, 0.51, 0.32, 1] : [0.58, 0.62, 0.49, 1]);
                    for (let i = 0; i < inner.length; i++) {
                        const a = inner[i],
                            b = inner[(i + 1) % inner.length];
                        r.line(
                            a[0],
                            a[1],
                            b[0],
                            b[1],
                            Math.max(1, 3 * sc),
                            roots ? [0.66, 0.61, 0.37, 0.8] : [0.7, 0.73, 0.59, 0.8],
                        );
                        if (i % 2 === 0) {
                            const c = points[i];
                            r.line(
                                a[0],
                                a[1],
                                c[0],
                                c[1],
                                Math.max(1, 3 * sc),
                                [0.17, 0.22, 0.16, 0.6],
                            );
                        }
                    }
                    if (roots) {
                        for (let i = 0; i < top.length; i += 2) {
                            const a = top[i],
                                b = top[(i + 3) % top.length];
                            r.line(
                                a[0],
                                a[1],
                                center[0],
                                center[1],
                                Math.max(2, 14 * sc),
                                [0.37, 0.34, 0.2, 0.6],
                            );
                            r.line(
                                center[0],
                                center[1],
                                b[0],
                                b[1],
                                Math.max(2, 9 * sc),
                                [0.67, 0.61, 0.36, 0.6],
                            );
                        }
                    } else {
                        for (let i = 0; i < top.length; i += 3) {
                            const a = top[i],
                                b = top[(i + 1) % top.length];
                            r.poly([a, b, center], [0.68, 0.71, 0.57, 0.23]);
                        }
                    }
                },
            );
        }
        r.flush();
        r.begin();
        r.passState.depthWrite = depthWrite;
    }
    static miniRiverCache = new WeakMap();
    static drawMiniBridges(c, terrain, pt, style) {
        const origin = pt({ x: 0, y: 0 }),
            xAxis = pt({ x: 1, y: 0 }),
            yAxis = pt({ x: 0, y: 1 });
        const sx = Math.hypot(xAxis[0] - origin[0], xAxis[1] - origin[1]),
            sy = Math.hypot(yAxis[0] - origin[0], yAxis[1] - origin[1]);
        const orientation = Math.atan2(xAxis[1] - origin[1], xAxis[0] - origin[0]);
        for (const br of terrain.bridges || []) {
            const q = pt(br),
                hl = (br.halfLength || 80) * sx,
                hw = (br.halfWidth || 30) * sy;
            c.save();
            c.translate(...q);
            c.rotate((Number(br.angle) || 0) + orientation);
            c.fillStyle = style.fill;
            c.strokeStyle = style.stroke;
            c.lineWidth = style.lineWidth;
            c.fillRect(-hl, -hw, hl * 2, hw * 2);
            c.strokeRect(-hl, -hw, hl * 2, hw * 2);
            c.restore();
        }
    }
    static drawMini(
        c,
        map,
        pt,
        scale,
        bridgeStyle = {
            fill: '#9a7a47',
            stroke: '#d2b477',
            lineWidth: Math.max(0.8, c.canvas.width * 0.0022),
        },
    ) {
        this.drawSurfaceMini(c, map, pt, scale);
        const atlas = TerrainSurfaceAtlas.fromMap(map),
            mesh = this.riverSurfaceMesh(map, atlas);
        if (mesh.length) {
            let cache = this.miniRiverCache.get(atlas);
            if (!cache) this.miniRiverCache.set(atlas, (cache = new Map()));
            const origin = pt({ x: 0, y: 0 }),
                extent = pt({ x: atlas.width, y: atlas.height }),
                key = [c.canvas.width, c.canvas.height, ...origin, ...extent, scale].join(':');
            let image = cache.get(key);
            if (!image) {
                image = document.createElement('canvas');
                image.width = c.canvas.width;
                image.height = c.canvas.height;
                const water = image.getContext('2d');
                for (const tri of mesh) {
                    water.fillStyle = this.css(tri.color);
                    water.beginPath();
                    for (let i = 0; i < tri.vertices.length; i++) {
                        const v = tri.vertices[i],
                            p = pt({ x: v.x, y: v.z });
                        if (i) water.lineTo(...p);
                        else water.moveTo(...p);
                    }
                    water.closePath();
                    water.fill();
                }
                if (cache.size >= 4) cache.delete(cache.keys().next().value);
                cache.set(key, image);
            }
            c.drawImage(image, 0, 0);
        }
        const terrain = map?.terrain || {};
        for (const road of terrain.roads || []) {
            const p = road.points.map(pt);
            if (!p.length) continue;
            c.lineCap = 'round';
            c.lineJoin = 'round';
            c.lineWidth = Math.max(1, road.width * scale);
            c.strokeStyle = '#94896988';
            c.beginPath();
            c.moveTo(...p[0]);
            for (let i = 1; i < p.length; i++) c.lineTo(...p[i]);
            c.stroke();
        }
        for (const b of terrain.blockers || []) {
            const p = b.points.map(pt);
            if (p.length < 3) continue;
            c.fillStyle = b.kind === 'roots' ? '#615b38' : '#4e5c4b';
            c.strokeStyle = '#9aa884';
            c.lineWidth = Math.max(0.7, scale * 10);
            c.beginPath();
            c.moveTo(...p[0]);
            for (let i = 1; i < p.length; i++) c.lineTo(...p[i]);
            c.closePath();
            c.fill();
            c.stroke();
        }
        this.drawMiniBridges(c, terrain, pt, bridgeStyle);
    }
    static drawBarrier(r, b) {
        if (!r.isFriendlySide(b.side) && !r.visibleRaw(b.x, b.y)) return;
        const [x, y] = r.worldToPx(r.viewX(b.x), r.viewY(b.y)),
            rad = BuildingDefinition.get(b.type).size * r.sc();
        r.circle(x, y + rad * 0.18, rad, [0.15, 0.18, 0.12, 0.27], 12);
        r.circle(x, y, rad * 0.95, [0.29, 0.25, 0.16, 1], 10);
        for (let i = -1; i <= 1; i++) {
            const yy = y + i * rad * 0.4;
            r.line(
                x - rad * 0.77,
                yy + rad * 0.24,
                x + rad * 0.77,
                yy - rad * 0.24,
                rad * 0.31,
                [0.6, 0.48, 0.27, 1],
            );
            r.line(
                x - rad * 0.73,
                yy + rad * 0.18,
                x + rad * 0.73,
                yy - rad * 0.3,
                rad * 0.075,
                [0.8, 0.68, 0.42, 1],
            );
        }
        r.line(
            x - rad * 0.25,
            y - rad * 0.78,
            x + rad * 0.32,
            y + rad * 0.78,
            rad * 0.16,
            [0.36, 0.43, 0.23, 1],
        );
        r.circle(x - rad * 0.56, y - rad * 0.37, rad * 0.19, [0.53, 0.6, 0.32, 1], 5);
        if (b.hitFlash > 0) r.circle(x, y, rad * 0.86, [1, 0.8, 0.4, 0.18], 10);
    }
}

class FogVisibilityGrid {
    constructor(renderer, step) {
        this.atlas = renderer.world.terrain.surfaces;
        this.width = renderer.world.width;
        this.height = renderer.world.height;
        this.step = step;
        this.w = Math.max(2, Math.ceil(this.width / step) + 1);
        this.h = Math.max(2, Math.ceil(this.height / step) + 1);
        this.x = Float64Array.from({ length: this.w }, (_, i) => (i / (this.w - 1)) * this.width);
        this.y = Float64Array.from({ length: this.h }, (_, j) => (j / (this.h - 1)) * this.height);
        this.ceilings = new Float64Array(this.w * this.h);
        this.groundLevels = null;
        this.guestGroundLevels = null;
        this.masks = new Map();
        this.groundMasks = new Map();
        this.generation = 0;
    }
    sameGeometry(renderer, step) {
        return (
            this.atlas === renderer.world.terrain.surfaces &&
            this.width === renderer.world.width &&
            this.height === renderer.world.height &&
            this.step === step
        );
    }
    update(renderer) {
        const sides = renderer.replayVisionSides(),
            sideKey = sides.join(',');
        const revisionKey = sides
            .map((side) => renderer.visionFields[side]?.revision ?? -1)
            .join(',');
        if (
            this.snapshot === renderer.snapshot &&
            this.tick === renderer.snapshot.tick &&
            this.revisionKey === revisionKey &&
            this.sideKey === sideKey &&
            this.observer === renderer.replayObserverAll
        )
            return this;
        this.snapshot = renderer.snapshot;
        this.tick = renderer.snapshot.tick;
        this.revisionKey = revisionKey;
        this.fields = renderer.visionFields;
        this.sideKey = sideKey;
        this.sides = sides;
        this.observer = renderer.replayObserverAll;
        // Published mask arrays remain immutable while the GPU transition retains them.
        this.masks.clear();
        this.groundMasks.clear();
        this.generation++;
        for (let j = 0; j < this.h; j++)
            for (let i = 0; i < this.w; i++)
                this.ceilings[j * this.w + i] = this.ceilingAt(this.x[i], this.y[j]);
        return this;
    }
    ceilingAt(x, y) {
        if (this.observer) return Infinity;
        let best = -Infinity;
        for (const side of this.sides)
            best = Math.max(best, this.fields[side]?.ceilingAt(x, y) ?? -Infinity);
        return best;
    }
    atLevel(level) {
        let mask = this.masks.get(level);
        if (mask) return mask;
        mask = Uint8Array.from(this.ceilings, (ceiling) => (ceiling >= level ? 255 : 0));
        this.masks.set(level, mask);
        return mask;
    }
    atGround(renderer) {
        const role = renderer.orientationRole();
        let mask = this.groundMasks.get(role);
        if (mask) return mask;
        if (!this.groundLevels)
            this.groundLevels = Float64Array.from(this.ceilings, (_, k) =>
                this.atlas.levelAt(this.x[k % this.w], this.y[Math.floor(k / this.w)]),
            );
        mask = new Uint8Array(this.w * this.h);
        if (role !== 'guest')
            for (let k = 0; k < mask.length; k++)
                mask[k] = this.ceilings[k] >= this.groundLevels[k] ? 255 : 0;
        else {
            if (!this.guestGroundLevels) this.guestGroundLevels = new Float64Array(mask.length);
            const buildLevels = !this.guestLevelsReady;
            for (let j = 0; j < this.h; j++)
                for (let i = 0; i < this.w; i++) {
                    const k = j * this.w + i,
                        ri = this.w - 1 - i,
                        rj = this.h - 1 - j,
                        rk = rj * this.w + ri,
                        x = renderer.viewX(this.x[i]),
                        y = renderer.viewY(this.y[j]);
                    // Keep the old reflected-coordinate arithmetic at exact geometry boundaries.
                    const canonical = x === this.x[ri] && y === this.y[rj];
                    if (buildLevels)
                        this.guestGroundLevels[k] = canonical
                            ? this.groundLevels[rk]
                            : this.atlas.levelAt(x, y);
                    const ceiling = canonical ? this.ceilings[rk] : this.ceilingAt(x, y);
                    mask[k] = ceiling >= this.guestGroundLevels[k] ? 255 : 0;
                }
            this.guestLevelsReady = true;
        }
        this.groundMasks.set(role, mask);
        return mask;
    }
}

const DEFAULT_LIVE_ZOOM = 1.5;
const MAX_LIVE_ZOOM = 2;

class GLRenderer {
    static DEPTH_PROJECTION = Object.freeze({
        offset: 0.88,
        viewSpan: 1.72,
        min: -0.94,
        max: 0.94,
    });
    constructor(
        canvas,
        {
            deferLoop = false,
            showcase = false,
            fxCanvas = document.getElementById('fxCanvas'),
        } = {},
    ) {
        this.canvas = canvas;
        this.showcase = showcase;
        // HAS-A immutable topology cache. Unit positions/state stay dynamic; only reusable
        // polygon/circle/petal topology is shared across every instance and frame.
        this.geometryTemplates = SHARED_GEOMETRY_TEMPLATES;
        this.geometryTemplateHits = 0;
        this.passProfiler = new RenderPassProfiler();
        // Cached local-space body meshes for species whose body/equipment is immutable for
        // a visual state key. Movement/facing/depth remain per-entity and are applied on replay.
        this.unitBodyMeshCache = new Map();
        this.unitBodyMeshCacheHits = 0;
        this.unitBodyMeshCacheMisses = 0;

        // 전장 본 렌더는 WebGL 단일 백엔드다.
        // Canvas2D는 미니맵/텍스트/숫자/UI 전용이며 전장 fallback을 구현하지 않는다.
        this.webglAttrs = {
            alpha: false,
            antialias: true,
            stencil: true,
            depth: true,
            preserveDrawingBuffer: false,
            powerPreference: 'high-performance',
            failIfMajorPerformanceCaveat: false,
            // Allow one additional layer for face art, vector gradients, and dynamic atlas regions.
            // Unique canvases match the actual shared sprite uploads and allocation order.
            textureAtlas: {
                width: 2048,
                height: 1024,
                gutter: 1,
                layers:
                    RallyGamekit.estimateTextureAtlasLayers(
                        [
                            ...RallyGamekit.VECTOR_RENDERER_ATLAS_REGIONS,
                            ...new Set(Object.values(globalThis.RallySpriteCanvases)),
                        ],
                        { width: 2048, height: 1024, gutter: 1 },
                    ) + 1,
            },
        };
        this.device = new RallyGamekit.WebGLDevice(canvas, this.webglAttrs);
        if (this.webglAttrs.textureAtlas.layers > this.device.maxArrayTextureLayers) {
            const limit = this.device.maxArrayTextureLayers;
            this.device.dispose();
            throw new Error(
                `게임 그래픽을 준비하려면 텍스처 레이어 ${this.webglAttrs.textureAtlas.layers}장이 필요하지만 이 기기는 ${limit}장까지 지원합니다.`,
            );
        }
        this.vectorContext = new RallyGamekit.VectorContext(this.device, {
            safeAlphaRunBatching: true,
        });
        this.vectorContext.acquireMeshRenderer();
        this.grainTeamRing = this.vectorContext.createMesh(buildGrainTeamRing());
        this.grainTeamRingMatrix = new Float32Array(6);
        this.grainFaces = new RallyGamekit.FaceOverlay(this.vectorContext, {
            faces: GRAIN_FACE_IDS,
        }); // 메시 통계가 첫 유닛 그리기 전에도 null이 아니도록 미리 만든다.
        this.vectorUnitAssetCache = new Map();
        this.buildingArt = new BuildingArt(this);
        this.spriteRenderers = {};
        this.riceBodyGroup = [];
        // One actor per grain: a shared actor re-seeked per grain rewrites its pose row and splits the instanced batch.
        this.grainActors = new Map();
        this.grainActorFrame = 0;
        this.grainBodyGroups = new Map();
        this.grainOpaqueCoverage = new Map();
        this._vectorUnitMatrix = new Float32Array(6);
        this._vectorOcclusionCoords = new Float32Array(0);
        this.gl = this.device.gl;
        this.passState = {
            depthEnabled: true,
            depthWrite: true,
            depthFunc: 'lequal',
            stencil: false,
            colorMask: [true, true, true, true],
        };
        if (!this.gl) throw new Error('쌀콩팡! requires WebGL for battlefield rendering.');
        this.backend = 'WebGL';
        this.canvas.dataset.rendererBackend = this.backend;

        // Render-only visibility spatial cache.
        this.visionFields = [null, null];
        this.fogVisibilityGrids = new Map();
        this.visibleUnitFrame = [];

        // High-frequency renderer pools. They are presentation-only and deliberately
        // excluded from deterministic state. Sizes are bounded to prevent hidden growth.
        this.renderState = new RenderStateStore(() => {
            const replay = ReplayPresentation.replayPlayer;
            return replay ? (replay.playing ? replay.speed : 0) : 1;
        });
        this.liveRenderTargets = false;
        this.combatFxPool = new RallyGamekit.ObjectPool(
            EffectObjectFactory.makeCombatFx,
            EffectObjectFactory.resetCombatFx,
            256,
        );
        this.floatFxPool = new RallyGamekit.ObjectPool(
            EffectObjectFactory.makeFloatFx,
            EffectObjectFactory.resetFloatFx,
            96,
        );
        this.shakeFxPool = new RallyGamekit.ObjectPool(
            EffectObjectFactory.makeShakeFx,
            EffectObjectFactory.resetShakeFx,
            16,
        );
        // Presentation-only shared hitGuard shield state. All shield sources use the same visual language.

        // Presentation timing is render-only. Full UI snapshots remain 10 Hz, while
        // registered Render State targets can be refreshed every authoritative simulation tick.
        this.perfStats = {
            frameWorkMs: 0,
            ewmaFrameWorkMs: 0,
            maxFrameWorkMs: 0,
            fps: 0,
            frames: 0,
            fpsWindowAt: performance.now(),
            lastFrameAt: performance.now(),
            frameIntervalMs: 0,
            ewmaFrameIntervalMs: 0,
            maxFrameIntervalMs: 0,
            frameIntervalWindowAt: performance.now(),
            cpuDepthSortMs: 0,
            drawCalls: 0,
            bufferUploadBytes: 0,
        };
        this.renderStage = 'init';
        this.renderEntity = null;
        this.renderFatalReported = false;

        // Game shaders express Rally's terrain/depth/fog policy. Gamekit owns GPU resources and submission.
        const vs = `attribute vec3 a;attribute vec4 ac;uniform vec2 r;varying lowp vec4 vc;void main(){vec2 p=a.xy/r*2.0-1.0;gl_Position=vec4(p.x,-p.y,a.z,1.0);vc=ac;}`,
            fs = `precision lowp float;varying lowp vec4 vc;void main(){gl_FragColor=vc;}`,
            spriteFs = `precision lowp float;varying lowp vec4 vc;uniform lowp float alphaCutoff;void main(){if(vc.a<alphaCutoff)discard;gl_FragColor=vc;}`,
            attributes = [
                { name: 'a', size: 3, offset: 0 },
                { name: 'ac', size: 4, offset: 12 },
            ];
        this.p = this.device.createPipeline({
            vertex: vs,
            fragment: fs,
            stride: 28,
            attributes,
            uniforms: { r: '2f' },
        });
        this.spriteProgram = this.device.createPipeline({
            vertex: vs,
            fragment: spriteFs,
            stride: 28,
            attributes,
            uniforms: { r: '2f', alphaCutoff: '1f' },
        });
        this.buf = this.device.createVertexBuffer({ capacityBytes: 7 * 16384 * 4 });
        const fogVs = `attribute vec3 a;attribute vec2 uv;uniform vec2 r;uniform vec2 maskSize;varying mediump vec2 vuv;void main(){vec2 p=a.xy/r*2.0-1.0;gl_Position=vec4(p.x,-p.y,a.z,1.0);vuv=(uv*(maskSize-1.0)+0.5)/maskSize;}`,
            fogFs = `precision mediump float;varying mediump vec2 vuv;uniform sampler2D tex;uniform sampler2D previousTex;uniform float transition;uniform vec4 fog;void main(){float vis=mix(texture2D(previousTex,vuv).r,texture2D(tex,vuv).r,transition);float edge=smoothstep(.12,.88,vis);gl_FragColor=vec4(fog.rgb,fog.a*(1.0-edge));}`;
        this.fogProgram = this.device.createPipeline({
            vertex: fogVs,
            fragment: fogFs,
            stride: 20,
            attributes: [
                { name: 'a', size: 3, offset: 0 },
                { name: 'uv', size: 2, offset: 12 },
            ],
            uniforms: {
                r: '2f',
                maskSize: '2f',
                tex: '1i',
                previousTex: '1i',
                transition: '1f',
                fog: '4f',
            },
        });
        this.fogBuf = this.device.createVertexBuffer({ capacityBytes: 5 * 8192 * 4 });
        this.fogFrame = new ReusableFloat32Buffer(5 * 8192);
        this.fogTextures = new Map();
        this._fogTextureKey = null;
        this.fogMaskStep = 64;
        this.fogPreviousTextures = new Map();
        this.fogMaskRecords = new Map();
        this.fogTransitionDurationMs = STATE_PUBLISH_INTERVAL_MS;
        this._fogTransitionStartedAt = null;
        this._fogMaskContext = null;

        // Reusable CPU staging buffer + persistent GPU allocation. This removes per-flush
        // frame copies and repeated GPU buffer orphaning.
        this.frame = new ReusableFloat32Buffer(7 * 16384);
        this.reducedMotion = matchMedia('(prefers-reduced-motion: reduce)');
        this.worldSpriteFrame = [];
        this.worldSpritePool = [];
        this.terrainOccludedBodyFrame = new ReusableFloat32Buffer(7 * 4096);
        this.world = WorldContext.standard;
        this.snapshot = null;
        this.role = 'host';
        this.replayObserverAll = false;
        this.replayPerspectiveSide = null;
        this.replayVisionMode = null;
        this.replayOrientationRole = null;
        this.replayZoom = 1;
        this.cameraLeft = 0;
        this.cameraTop = this.clampCameraTop(Infinity);
        this.attackVariantBreathFx = [];
        // Presentation-only facing: never enters StrategySim/checksum/export/recovery.
        this.unitFacingStates = new Map();
        this.launchRecoil = new Map();
        this.projectileTrails = new Map();
        // Presentation-only particles are independent of the projectile image and sim state.
        this.cornTrails = new Map();
        this.cornTrailAnchors = new Map();
        this.cornBursts = [];
        this.milletBursts = [];
        this.cornQuadMatrix = new Float32Array(6);
        this.projectileScreenMotionStates = new Map();
        this.last = performance.now();
        this.particles = [];

        // 전투/경제 숫자는 WebGL과 별개의 투명 Canvas2D에 그린다.
        // 이미지/폰트 리소스를 추가하지 않고 브라우저 기본 폰트만 사용한다.
        this.fxCanvas = fxCanvas;
        this.fxCtx = this.fxCanvas?.getContext('2d') || null;
        this.floatFx = [];

        // florr.io-inspired client-only combat feedback.
        // These arrays are renderer-only and never enter StrategySim/checksum/export/recovery.
        this.combatFx = [];
        this.bundleBreakIds = new Set();
        this.shakeFx = [];
        // HAS-A common source-body pulse presentation. Presets own timing/scale; consumers only trigger them.
        this.frameShakeX = 0;
        this.frameShakeY = 0;
        this.cameraShakePresentationMoved = false;
        this.loop = this.loop.bind(this);
        this.loopStarted = false;
        if (!deferLoop) this.startLoop();
    }
    startLoop() {
        if (!this.loopStarted) {
            this.loopStarted = true;
            this.loopFrame = requestAnimationFrame(this.loop);
        }
    }
    stopLoop() {
        this.loopStarted = false;
        cancelAnimationFrame(this.loopFrame);
    }
    playShowcase(onError, onFirstFrame) {
        this.onShowcaseError = onError;
        this.onShowcaseFirstFrame = onFirstFrame;
        this.setSnapshot({ ...this.snapshot, events: [] }, { snapTargets: true });
        this.startLoop();
    }
    disposeShowcase() {
        this.releaseShowcaseScene();
        this.grainFaces.dispose();
        for (const sprites of Object.values(this.spriteRenderers)) sprites.dispose();
        for (const hold of this.gameResourceHolds || []) hold.release();
        this.spriteRenderers = {};
        this.gameResourceHolds = null;
        this.vectorContext.dispose();
        this.device.dispose();
    }
    releaseShowcaseScene() {
        this.stopLoop();
        if (this.vectorContext.active) this.vectorContext.endFrame();
        this.onPresentationFrame = null;
        this.onShowcaseError = null;
        this.onShowcaseFirstFrame = null;
        this.snapshot = null;
        this.world = WorldContext.standard;
        this.renderState.reset();
        this.renderEntity = null;

        this.clearGrainActors();
        this.buildingArt.dispose();
        this.unitFacingStates.clear();
        this.launchRecoil.clear();
        this.visibleUnitFrame.length = 0;
        this.riceBodyGroup.length = 0;
        this.grainBodyGroups.clear();
        this.worldSpriteFrame.length = 0;
        this.worldSpritePool.length = 0;
        this.visionFields.fill(null);
        this.fogVisibilityGrids.clear();
        this.fogSurfaces = null;
        this._fogSurfaceAtlas = null;
        this.resetFogTransition();
        for (const textures of [this.fogTextures, this.fogPreviousTextures]) {
            for (const texture of textures.values()) this.device.deleteTexture(texture);
            textures.clear();
        }

        this.projectileTrails.clear();
        this.projectileScreenMotionStates.clear();
        this.cornTrails.clear();
        this.cornTrailAnchors.clear();
        this.cornBursts.length = 0;
        this.milletBursts.length = 0;
        this.particles.length = 0;
        this.bundleBreakIds.clear();
        this.attackVariantBreathFx.length = 0;
        for (const fx of this.combatFx) this.combatFxPool.release(fx);
        for (const fx of this.floatFx) this.floatFxPool.release(fx);
        for (const fx of this.shakeFx) this.shakeFxPool.release(fx);
        this.combatFx.length = 0;
        this.floatFx.length = 0;
        this.shakeFx.length = 0;
        this.frameShakeX = this.frameShakeY = 0;
        this.cameraShakePresentationMoved = false;
        if (this.frameComposition?.texture) {
            this.device.deleteTexture(this.frameComposition.texture);
            this.frameComposition.texture = null;
            this.frameComposition.width = this.frameComposition.height = 0;
        }
        this.fxCanvas.style.transform = '';
        this.canvas.width = this.canvas.height = 1;
        this.fxCanvas.width = this.fxCanvas.height = 1;
    }
    resize() {
        const dpr = Math.min(1.6, devicePixelRatio || 1);
        const cssW = Math.max(
            1,
            this.canvas.clientWidth || this.canvas.parentElement?.clientWidth || 360,
        );
        const cssH = Math.max(
            1,
            this.canvas.clientHeight ||
                this.canvas.parentElement?.clientHeight ||
                Math.round((cssW * 5) / 3),
        );
        const w = Math.max(1, Math.floor(cssW * dpr));
        const h = Math.max(1, Math.floor(cssH * dpr));

        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
            this.cameraTop = this.clampCameraTop(this.cameraTop);
        }
        if (this.fxCanvas && (this.fxCanvas.width !== w || this.fxCanvas.height !== h)) {
            this.fxCanvas.width = w;
            this.fxCanvas.height = h;
        }
    }

    prepareGameResources() {
        if (this.gameResourceHolds) return;
        const holds = [],
            actors = [],
            C = this.vectorContext,
            matrix = [1, 0, 0, 1, 0, 0];
        try {
            this.resize();
            for (const [type, definition] of Object.entries(GRAIN_SPRITES)) {
                if (!this.spriteRenderers[type])
                    this.spriteRenderers[type] = new definition.renderer(
                        C,
                        globalThis.RallySpriteCanvases[type],
                        RallyGamekit,
                        type,
                    );
            }
            this.grainFaces.prepare();
            if (!C.beginFrame()) throw new Error('그래픽 장치를 준비할 수 없습니다.');
            // A hidden boot canvas has no CSS viewport for the non-scaling stroke.
            if (this.canvas.clientWidth > 0 && this.canvas.clientHeight > 0) {
                C.drawMesh(this.grainTeamRing);
                C.flush('grain-team-ring-preparation');
            }
            for (const [id, source] of Object.entries(globalThis.RallyVectorAssets)) {
                holds.push(RallyGamekit.holdVectorAsset(C, source));
                const actor = RallyGamekit.createVectorActor(C, source, {
                    clip: 'idle',
                    startedAtMs: 0,
                });
                actors.push(actor);
                actor.seek(0);
                actor.preparePose();
                C.preparePoses();
                for (const depthWrite of [false, true]) {
                    C.drawVectorActor(actor, { matrix, depthTest: true, depthWrite });
                    C.flush('resource-preparation');
                }
                if (LaunchRules.grain(id)) {
                    this.grainFaces.draw(source, actor, 'neutral', matrix);
                    C.flush('resource-face-preparation');
                }
            }
            for (const own of [true, false])
                for (const dy of [-1, 1])
                    for (const fireAgeMs of [Infinity, 0]) {
                        this.buildingArt.draw(
                            { id: 'resource-preparation' },
                            { x: 0, y: 0, sc: 1, aim: { dx: 1, dy }, own, fireAgeMs },
                        );
                    }
            for (const sprites of Object.values(this.spriteRenderers)) {
                const actor = sprites.createActor();
                actors.push(actor);
                actor.seek(0);
                actor.preparePose();
                C.preparePoses();
                C.depthTest = true;
                C.depthWrite = true;
                sprites.drawBody(actor, matrix, 0);
                C.depthWrite = false;
                sprites.drawFace(actor, matrix, 0, 'neutral');
                if (sprites === this.spriteRenderers.corn)
                    this.spriteRenderers.corn.drawHeldKernel(actor, matrix, 0);
                C.flush('grain-resource-preparation');
                if (
                    sprites === this.spriteRenderers.acorn ||
                    sprites === this.spriteRenderers.watermelon
                ) {
                    actor.play('spin');
                    for (const elapsed of [1250, 1500]) {
                        actor.seekElapsed(elapsed);
                        actor.preparePose();
                        C.preparePoses();
                        C.depthWrite = true;
                        sprites.drawBody(actor, matrix, 0);
                        C.depthWrite = false;
                        sprites.drawFace(actor, matrix, 0, 'attack');
                        C.flush('spin-resource-preparation');
                    }
                }
                C.depthTest = false;
            }
            C.depthTest = true;
            this.spriteRenderers.acorn.drawAmmo(matrix, 0);
            this.spriteRenderers.acorn.drawTeamMarker(matrix, 0, true);
            this.spriteRenderers.acorn.drawTeamMarker(matrix, 0, false);
            C.flush('acorn-ammo-resource-preparation');
            for (const [type, spec] of Object.entries(GRAIN_SPRITES)) {
                if (!spec.cannonAmmo) continue;
                const renderer = this.spriteRenderers[type];
                renderer.drawAmmo([32, 0, 0, 32, 0, 0], 0);
                renderer.drawCombatAmmo?.([24, 0, 0, 24, 0, 0], 0);
                C.flush('fruit-ammo-resource-preparation');
            }
            C.depthTest = false;
            this.spriteRenderers.millet.drawEar(matrix, 0);
            this.spriteRenderers.corn.drawKernel(matrix, 0);
            this.spriteRenderers.corn.drawCone(matrix, 0);
            this.spriteRenderers.popcorn.drawAmmo(matrix, 0);
            this.spriteRenderers.popcorn.drawBurst(matrix, 0);
            this.spriteRenderers.corn.drawTeamMarker(matrix, 0, true);
            for (let i = 0; i < 3; i++) this.spriteRenderers.corn.drawPopcorn(i, matrix, 0);
            C.flush('corn-particle-resource-preparation');
            C.depthTest = false;
            this.spriteRenderers.chestnut.drawBurr([32, 0, 0, 32, 0, 0], 0);
            this.spriteRenderers.chestnut.drawThorn([32, 0, 0, 32, 0, 0], 0);
            this.spriteRenderers.chestnut.drawParticle([8, 0, 0, 8, 0, 0], 0, THORN_IMPACT_COLOR);
            C.flush('chestnut-projectile-resource-preparation');
            this.buildingArt.prune([]);
            C.endFrame();
            // Warm-up draws raw art in canvas coordinates. Leave a clean backbuffer.
            this.device.clear({ color: [0, 0, 0, 0] });
            this.gl.finish();
            if (this.device.state !== 'ready' || this.gl.isContextLost())
                throw new Error('그래픽 장치 연결이 끊겼습니다.');
            this.gameResourceHolds = holds;
        } catch (error) {
            if (C.active) C.endFrame();
            this.buildingArt.prune([]);
            for (const hold of holds) hold.release();
            for (const sprites of Object.values(this.spriteRenderers)) sprites.dispose();
            this.spriteRenderers = {};
            throw error;
        } finally {
            for (const actor of actors) actor.dispose();
        }
    }
    baseSc() {
        return Math.min(this.canvas.width / VIEW_W, this.canvas.height / VIEW_H);
    }
    sc() {
        return this.baseSc() * (this.replayZoom || 1);
    }
    viewWorldW() {
        return VIEW_W / (this.replayZoom || 1);
    }
    viewWorldH() {
        return this.canvas.height / this.sc();
    }
    clampCameraTop(top) {
        const atlas = this.world.terrain.surfaces,
            min = BattlefieldProjection.planarY(0, atlas.maxHeight);
        const max = Math.max(
            min,
            BattlefieldProjection.planarY(this.world.height, atlas.minHeight) - this.viewWorldH(),
        );
        return RangeUtil.clamp(top, min, max);
    }
    orientationRole() {
        return this.replayOrientationRole || this.role;
    }
    viewX(x) {
        return this.orientationRole() === 'guest' ? this.world.width - x : x;
    }
    viewY(y) {
        return this.orientationRole() === 'guest' ? this.world.height - y : y;
    }
    // Faction ownership, camera orientation and replay perspective are separate contracts.
    // Replay perspective is allowed to override ownership ONLY while actually in replay mode.
    mySide() {
        const replayActive =
            typeof UiRuntimeState.value !== 'undefined' && UiRuntimeState.value.screen === 'replay';
        return replayActive && this.replayPerspectiveSide != null
            ? this.replayPerspectiveSide
            : ConnectionSideUtil.roleSide(this.role);
    }
    isFriendlySide(side) {
        return side === this.mySide();
    }
    factionRelation(side) {
        if (side !== 0 && side !== 1) return 'neutral';
        return this.isFriendlySide(side) ? 'friendly' : 'enemy';
    }
    factionColor(side, { alpha = 1, neutral = [0.95, 0.73, 0.25] } = {}) {
        const relation = this.factionRelation(side);
        const rgb =
            relation === 'friendly'
                ? [0.22, 0.5, 1]
                : relation === 'enemy'
                  ? [1, 0.3, 0.3]
                  : neutral;
        return [rgb[0], rgb[1], rgb[2], alpha];
    }
    worldToPx(x, y, elevation = null) {
        const ax = this.viewX(x),
            az = this.viewY(y),
            height = elevation ?? this.world.terrain.surfaces.heightAt(ax, az);
        const p = this.projectRenderWorldPosition({ x: ax, y: height, z: az, groundY: 0 });
        return [p.x, p.y];
    }
    stableCamera() {
        if (this._frameCamera) return this._frameCamera;
        // Rally owns terrain projection/axis meaning. The shared camera owns viewport transforms.
        if (!this.cameraViewport)
            this.cameraViewport = new RallyGamekit.CameraViewport({
                projection: {
                    projectInto: (x, z, height, out) => {
                        out.x = x;
                        out.y = BattlefieldProjection.planarY(z, height);
                        return out;
                    },
                    groundInto: (x, y, out, height = 0) => {
                        out.x = x;
                        out.y = BattlefieldProjection.viewYFromPlane(y, height);
                        out.z = height;
                        return out;
                    },
                },
            });
        const camera = this.cameraViewport,
            sc = this.sc();
        if (camera.width !== this.canvas.width || camera.height !== this.canvas.height)
            camera.setViewport({ width: this.canvas.width, height: this.canvas.height });
        const x = this.cameraLeft + this.viewWorldW() / 2,
            y = this.cameraTop + this.viewWorldH() / 2;
        if (camera.camera.x !== x || camera.camera.y !== y || camera.camera.zoom !== sc)
            camera.setCamera({ x, y, zoom: sc });
        return camera;
    }
    projectedCoordinatesAtScreen(px, py) {
        return (this._frameCamera || this.stableCamera()).screenToPlaneInto(px, py, {});
    }
    surfaceAtScreen(px, py) {
        const p = this.projectedCoordinatesAtScreen(px, py);
        return TerrainSurfaceProjection.forAtlas(this.world.terrain.surfaces).pickSurface(
            p.x,
            p.y,
            this.orientationRole() === 'guest',
        );
    }
    // A hidden battlefield (result screen, closed tab) has no layout box, so its screen points map nowhere.
    hasDisplayArea() {
        const rect = this.canvas.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
    }
    pxToWorld(cx, cy) {
        const rect = this.canvas.getBoundingClientRect();
        const stable = this.sceneCoordinatesAtDisplay(
            ((cx - rect.left) / rect.width) * this.canvas.width,
            ((cy - rect.top) / rect.height) * this.canvas.height,
            { sampled: true },
        );
        const p = this.surfaceAtScreen(stable.x, stable.y);
        return [this.viewX(p.x), this.viewY(p.z)];
    }
    begin() {
        this.frame.reset();
    }
    setRenderDepth(depth) {
        this._renderDepth = RangeUtil.clamp(Number(depth) || 0, -0.98, 0.98);
    }
    withRenderDepth(depth, fn) {
        const prev = this._renderDepth;
        this.setRenderDepth(depth);
        try {
            return fn();
        } finally {
            this._renderDepth = prev;
        }
    }
    withWorldSpriteDepth(world, fn, bias = 0.0005) {
        return this.withRenderDepth(this.spriteDepthForWorld(world, bias), fn);
    }
    spriteDepthForWorld(world, bias = 0.0005) {
        const bridge = this.renderBridgeAt(world.x, world.z);
        const height = bridge
            ? world.y +
              (world.groundY == null ? this.world.terrain.surfaces.heightAt(world.x, world.z) : 0)
            : 0;
        return (
            (bridge && height >= bridge.elevation - 0.01
                ? this.bridgeDepth(bridge)
                : this.renderDepthForWorld(world)) - bias
        );
    }
    v(x, y, c) {
        this.frame.push7(
            x,
            y,
            this._renderDepth ?? 0,
            c[0],
            c[1],
            c[2],
            RangeUtil.clamp(c[3] ?? 1, 0, 1),
        );
    }
    regularPolygon(x, y, r, c, n = 10, rot = 0) {
        if (n < 3 || r <= 0) return;
        const pts = this.geometryTemplates.regularPolygon(n, rot);
        this.geometryTemplateHits++;
        const ax = x + pts[0] * r,
            ay = y + pts[1] * r;
        for (let i = 1; i < n - 1; i++) {
            const i1 = i * 2,
                i2 = (i + 1) * 2;
            this.v(ax, ay, c);
            this.v(x + pts[i1] * r, y + pts[i1 + 1] * r, c);
            this.v(x + pts[i2] * r, y + pts[i2 + 1] * r, c);
        }
    }
    tri(x1, y1, x2, y2, x3, y3, c) {
        this.v(x1, y1, c);
        this.v(x2, y2, c);
        this.v(x3, y3, c);
    }
    quad(x1, y1, x2, y2, x3, y3, x4, y4, c) {
        this.v(x1, y1, c);
        this.v(x2, y2, c);
        this.v(x3, y3, c);
        this.v(x1, y1, c);
        this.v(x3, y3, c);
        this.v(x4, y4, c);
    }
    petalRing(x, y, r, count, c, rot = 0, stretch = 0.62) {
        const dirs = this.geometryTemplates.petalRing(count, rot);
        this.geometryTemplateHits++;
        const ca = Math.cos(Math.PI * 0.48),
            sa = Math.sin(Math.PI * 0.48),
            rr = r * 0.42;
        for (let i = 0; i < count; i++) {
            const dx = dirs[i * 2],
                dy = dirs[i * 2 + 1],
                cx = x + dx * r,
                cy = y + dy * r;
            const ppx = dx * ca - dy * sa,
                ppy = dx * sa + dy * ca;
            const pmx = dx * ca + dy * sa,
                pmy = -dx * sa + dy * ca;
            this.quad(
                cx + dx * rr,
                cy + dy * rr * stretch,
                cx + ppx * rr * 0.62,
                cy + ppy * rr * 0.62,
                cx - dx * rr * 0.72,
                cy - dy * rr * 0.72 * stretch,
                cx + pmx * rr * 0.62,
                cy + pmy * rr * 0.62,
                c,
            );
        }
    }
    poly(p, c) {
        for (let i = 1; i < p.length - 1; i++) {
            this.v(p[0][0], p[0][1], c);
            this.v(p[i][0], p[i][1], c);
            this.v(p[i + 1][0], p[i + 1][1], c);
        }
    }
    rect(x, y, w, h, c) {
        this.quad(x, y, x + w, y, x + w, y + h, x, y + h, c);
    }
    circle(x, y, r, c, n = 10) {
        this.regularPolygon(x, y, r, c, n, 0);
    }
    line(x1, y1, x2, y2, w, c) {
        const dx = x2 - x1,
            dy = y2 - y1,
            l = Math.hypot(dx, dy) || 1,
            nx = ((-dy / l) * w) / 2,
            ny = ((dx / l) * w) / 2;
        this.quad(x1 + nx, y1 + ny, x2 + nx, y2 + ny, x2 - nx, y2 - ny, x1 - nx, y1 - ny, c);
    }
    drawGroundCircle(x, z, radius, { stroke, fill, width = 1, segments = 32, elevation = null }) {
        const directions = this.geometryTemplates.outlineCircle(segments),
            atlas = this.world.terrain.surfaces,
            // Filled circles stay on a local plane so triangles never connect two floor heights.
            plane = elevation ?? (fill ? atlas.heightAt(x, z) : null),
            project = (wx, wz, height) => this.worldToPx(this.viewX(wx), this.viewY(wz), height),
            center = fill ? project(x, z, plane) : null;
        this.geometryTemplateHits++;
        const sample = (i) => {
            const wx = x + directions[i * 2] * radius,
                wz = z + directions[i * 2 + 1] * radius;
            if (plane !== null) return { x: wx, z: wz, height: plane, ramp: false };
            if (wx < 0 || wz < 0 || wx > this.world.width || wz > this.world.height) return null;
            const surface = atlas.sample(wx, wz);
            return { x: wx, z: wz, height: surface.elevation, ramp: !!surface.ramp };
        };
        let previous = sample(0),
            previousProjected = plane === null ? null : project(previous.x, previous.z, plane);
        for (let i = 1; i <= segments; i++) {
            const next = sample(i % segments);
            // An outline can follow a ramp, but must not draw a diagonal through a cliff face.
            if (
                previous &&
                next &&
                (previous.height === next.height || previous.ramp || next.ramp)
            ) {
                const a = previousProjected ?? project(previous.x, previous.z, previous.height),
                    b = project(next.x, next.z, next.height);
                if (fill) this.tri(center[0], center[1], a[0], a[1], b[0], b[1], fill);
                if (stroke) this.line(a[0], a[1], b[0], b[1], width, stroke);
                if (plane !== null) previousProjected = b;
            }
            previous = next;
        }
    }
    drawBatch(pipeline, buffer, first, count, uniforms, textures = []) {
        // Direct regression renders can submit a pass without starting the animation loop.
        if (!this.vectorContext.active && !this.vectorContext.beginFrame()) return;
        const state = this.passState;
        this.device.draw({
            pipeline,
            buffer,
            first,
            count,
            uniforms,
            textures,
            blend: 'straight-alpha',
            depth: state.depthEnabled ? { func: state.depthFunc, write: state.depthWrite } : false,
            stencil: state.stencil,
            colorMask: state.colorMask,
        });
    }
    flush(frame = this.frame, worldDepth = false) {
        if (!frame.length) return;
        const d = frame.view();
        this.device.uploadVertices(this.buf, d);
        let draws = 0;
        const uniforms = { r: [this.canvas.width, this.canvas.height] };
        if (worldDepth) {
            let start = 0,
                solid = null;
            const draw = (end) => {
                if (end <= start) return;
                this.passState.depthWrite = solid;
                this.drawBatch(this.spriteProgram, this.buf, start / 7, (end - start) / 7, {
                    ...uniforms,
                    alphaCutoff: solid ? 0.5 : 0,
                });
                draws++;
                start = end;
            };
            for (let i = 0; i < frame.length; i += 21) {
                const next =
                    Math.min(d[i + 6], d[i + 13], d[i + 20]) >= 0.999 ||
                    Math.max(d[i + 6], d[i + 13], d[i + 20]) <= 0;
                if (solid !== null && next !== solid) draw(i);
                solid = next;
            }
            draw(frame.length);
            this.passState.depthWrite = false;
        } else {
            this.drawBatch(this.p, this.buf, 0, frame.length / 7, uniforms);
            draws = 1;
        }
        this.perfStats.drawCalls = (this.perfStats.drawCalls || 0) + draws;
        this.perfStats.bufferUploadBytes = (this.perfStats.bufferUploadBytes || 0) + d.byteLength;
        this.perfStats.vertexBufferGrows = frame.grows;
    }
    onScreenAuth(x, y, pad = 120) {
        // 최적화 판정은 고정 월드 뷰포트가 아니라
        // 실제 현재 게임 화면(캔버스) 기준으로 계산한다.
        // PC처럼 화면비가 넓거나 DPR/리사이즈가 자주 바뀌는 환경에서도
        // "화면 안인데 컬링되는" 현상을 줄이기 위한 보수적 판정이다.
        const sc = this.sc();
        const padPx = Math.max(12, pad * sc);
        const [sx, sy] = this.worldToPx(this.viewX(x), this.viewY(y));
        return (
            sx >= -padPx &&
            sx <= this.canvas.width + padPx &&
            sy >= -padPx &&
            sy <= this.canvas.height + padPx
        );
    }

    presentationTargetIntervalMs(source = this.snapshot) {
        const tps = Math.max(1, Number(source?.tps || this.snapshot?.tps || SIM_TPS) || SIM_TPS);
        return 1000 / tps;
    }

    updatePresentationTargets(source, snap = false) {
        if (!source) return;
        const now = performance.now();
        const units = source.units || [],
            projectiles = source.projectiles || [];
        const targetIntervalMs = this.presentationTargetIntervalMs(source);
        if (this.renderState.stepMs != null && this.renderState.stepMs !== targetIntervalMs) {
            this.cornTrails.clear();
            this.cornTrailAnchors.clear();
        }

        this.renderState.capture(source, now, snap, targetIntervalMs);
        const liveFacingIds = new Set(units.filter((u) => u?.alive !== false).map((u) => u.id));
        for (const id of this.unitFacingStates.keys())
            if (!liveFacingIds.has(id)) this.unitFacingStates.delete(id);
        const liveProjectileIds = new Set(
            projectiles.filter((p) => p?.alive !== false).map((p) => p.id),
        );
        for (const id of this.projectileScreenMotionStates.keys())
            if (!liveProjectileIds.has(id)) this.projectileScreenMotionStates.delete(id);
        for (const id of this.projectileTrails.keys())
            if (!liveProjectileIds.has(id)) this.projectileTrails.delete(id);
    }

    presentationNow(now = performance.now()) {
        return this._framePresentationAt ?? now;
    }
    presentationEventTick(event, snapshot) {
        return Number.isFinite(Number(event.presentationTick))
            ? Number(event.presentationTick)
            : snapshot.tick;
    }
    cornPresentationTime() {
        return this.renderState.frame(this.presentationNow())?.timeMs;
    }
    renderTrackedPosition(entity, kind = 'unit') {
        return this.renderState.position(kind, entity.id, entity, this.presentationNow());
    }
    renderTrackedScreenPosition(entity, kind = 'unit') {
        const p = this.renderTrackedPosition(entity, kind);
        const q = this.worldToPx(this.viewX(p.x), this.viewY(p.y));
        return { x: q[0], y: q[1], world: p };
    }
    renderTrackedDelta(entity, kind = 'unit') {
        return this.renderState.delta(kind, entity.id);
    }

    presentationEntityActive(kind, id) {
        return this.renderState.has(kind, id, this.presentationNow());
    }

    resolveArcTravelPresentation({ fromX, fromY, toX, toY, planarX, planarY, arcHeight = 0 } = {}) {
        const sx = Number(fromX),
            sy = Number(fromY),
            tx = Number(toX),
            ty = Number(toY),
            px = Number(planarX),
            py = Number(planarY);
        if (![sx, sy, tx, ty, px, py].every(Number.isFinite))
            return { height: 0, groundHeight: 0, progress: 0, motion: 'ground' };
        const totalDistance = Math.hypot(tx - sx, ty - sy);
        const travelledDistance = Math.hypot(px - sx, py - sy);
        const progress = RangeUtil.clamp(travelledDistance / Math.max(1, totalDistance), 0, 1);
        const atlas = this.world.terrain.surfaces,
            from = atlas.heightAt(sx, sy),
            to = atlas.heightAt(tx, ty);
        const groundHeight = from * (1 - progress) + to * progress;
        return {
            height: Math.sin(progress * Math.PI) * Math.max(0, Number(arcHeight) || 0),
            groundHeight,
            progress,
            motion: 'arc',
        };
    }

    resolveRenderWorldPosition(entity, kind = 'unit', options = null) {
        const useEntityPlanar = !!options?.useEntityPlanar;
        const planar = useEntityPlanar
            ? { x: Number(entity.x) || 0, y: Number(entity.y) || 0 }
            : this.renderTrackedPosition(entity, kind);
        const atlas = this.world.terrain.surfaces;
        let groundY = atlas.heightAt(planar.x, planar.y),
            height = 0,
            motion = 'ground',
            progress = 0;
        const model = useEntityPlanar
            ? null
            : this.renderState.model(kind, entity.id, this.presentationNow());
        const motionState = model?.entity || entity;
        if (kind === 'unit') {
            const heightFP = motionState.impactMotion?.heightFP;
            if (Number.isFinite(heightFP)) height = Math.max(0, heightFP) / FP;
            if (motionState.heroRoll?.phase === 'hop') {
                const hop = watermelonRollProgress(
                    motionState.heroRoll,
                    model?.tick ?? this.snapshot.tick,
                );
                const apex = UnitDefinition.get(entity.type).heroActive.hopHeight;
                height += 4 * apex * hop * (1 - hop);
            }
        }
        if (kind === 'unitLob') {
            // zFP is authoritative absolute world altitude, not a visual-only arc.
            height = (Number(motionState.zFP) || 0) / FP - groundY;
            motion = 'ballistic';
        }
        if (kind === 'projectile') {
            if (motionState.launchX != null && motionState.launchY != null) {
                // Arc presentation must use the same trajectory destination as simulation.
                // In particular lockedPoint artillery must never recompute its arc from a
                // living target that can move/separate after launch.
                const policy =
                    motionState.trajectoryPolicy ||
                    (motionState.impactAtAimPoint ? 'lockedPoint' : 'trackingTarget');
                let aimX = Number(motionState.lockedAimX),
                    aimY = Number(motionState.lockedAimY);
                if (policy === 'trackingTarget' && !motionState.targetLost) {
                    const target =
                        (this.renderState.model(
                            'unit',
                            motionState.target,
                            this.presentationNow(),
                        ) &&
                            this.renderState.entity('unit', motionState.target)) ||
                        (this.snapshot?.buildings || []).find(
                            (b) => b.id === motionState.target && b.alive !== false,
                        );
                    if (target) {
                        const targetPose =
                            this.renderState.model('unit', target.id, this.presentationNow())
                                ?.entity || target;
                        aimX = targetPose.x + (Number(motionState.aimOffsetX) || 0);
                        aimY = targetPose.y + (Number(motionState.aimOffsetY) || 0);
                    }
                }
                if (Number.isFinite(aimX) && Number.isFinite(aimY)) {
                    // All consumers use the shared arc-travel primitive; projectile code owns
                    // endpoint policy only, never the trajectory formula.
                    const arc = this.resolveArcTravelPresentation({
                        fromX: motionState.launchX,
                        fromY: motionState.launchY,
                        toX: aimX,
                        toY: aimY,
                        planarX: planar.x,
                        planarY: planar.y,
                        arcHeight: motionState.arcHeight,
                    });
                    groundY = arc.groundHeight;
                    height =
                        entity.payload || entity.mortar
                            ? LaunchImpactRules.flightHeight(arc.progress, motionState.arcHeight)
                            : arc.height;
                    progress = arc.progress;
                    motion = arc.motion;
                }
            }
        }
        const position = {
            x: planar.x,
            y: groundY + height,
            z: planar.y,
            groundY,
            motion,
            progress,
        };
        return position;
    }
    resolveGroundShadowPosition(entity, kind = 'unit') {
        const p = this.renderTrackedPosition(entity, kind);
        const groundY = this.world.terrain.surfaces.heightAt(p.x, p.y);
        return { x: p.x, y: groundY + 0.001, z: p.y, groundY, motion: 'ground' };
    }
    renderDepthForWorld(p) {
        // Height belongs to screen projection only. Ground progression owns depth,
        // normalized to this map's extent in either camera orientation.
        const vz = this.viewY(p.z);
        const d = GLRenderer.DEPTH_PROJECTION;
        if (p.bridgeId) {
            const bridge = this.world.terrain.surfaces.bridges.find((b) => b.id === p.bridgeId);
            if (bridge) return this.bridgeDepth(bridge);
        }
        return RangeUtil.clamp(d.offset - (vz / this.world.height) * d.viewSpan, d.min, d.max);
    }
    bridgeDepth(bridge) {
        // A deck is a separate occluding layer over the same ground footprint.
        const vz = Math.max(this.viewY(bridge.minY), this.viewY(bridge.maxY)),
            d = GLRenderer.DEPTH_PROJECTION;
        return RangeUtil.clamp(d.offset - (vz / this.world.height) * d.viewSpan, d.min, d.max);
    }
    renderBridgeAt(x, z) {
        const atlas = this.world.terrain.surfaces;
        if (!atlas.bridges.length) return null;
        return (
            atlas.bridgeIndex
                .query(x, z)
                .find(
                    (b) => pointInSimplePolygon(x, z, b.points) || atlas.onBoundary(b.points, x, z),
                ) || null
        );
    }
    projectRenderWorldPositionStable(p) {
        // Same projection as projectRenderWorldPosition, but intentionally before
        // final screen composition. All world consumers use this stable projection.
        const vx = this.viewX(p.x),
            vz = this.viewY(p.z);
        const groundY =
            p.groundY == null ? this.world.terrain.surfaces.heightAt(p.x, p.z) : p.groundY;
        const resolved = p.groundY == null ? { ...p, y: p.y + groundY, groundY } : p;
        const projected = { depth: this.renderDepthForWorld(resolved), world: resolved };
        return (this._frameCamera || this.stableCamera()).worldToScreenInto(
            vx,
            vz,
            resolved.y,
            projected,
        );
    }
    projectRenderWorldPosition(p) {
        return this.projectRenderWorldPositionStable(p);
    }
    projectEntityScreen(entity, kind = 'unit') {
        return this.projectRenderWorldPosition(this.resolveRenderWorldPosition(entity, kind));
    }
    unitVisibleForRender(u) {
        if ((!u?.alive && !u?.impactMotion) || !this.presentationEntityActive('unit', u.id))
            return false;
        const p = this.projectEntityScreen(u, 'unit'),
            pad = ((UnitDefinition.get(u.type)?.size || 15) + 80) * this.sc();
        if (
            p.x < -pad ||
            p.y < -pad ||
            p.x > this.canvas.width + pad ||
            p.y > this.canvas.height + pad
        )
            return false;
        return u.side === this.mySide() || this.visibleRaw(u.x, u.y);
    }
    prepareVisibleUnitFrame() {
        const out = this.visibleUnitFrame;
        out.length = 0;
        for (const u of this.renderState.displayed('unit', this.presentationNow()))
            if (this.unitVisibleForRender(u)) out.push(u);
        return out;
    }

    drawUnitShadow(u, visibilityChecked = false) {
        const own = u.side === this.mySide();
        if (!visibilityChecked && !own && !this.visibleRaw(u.x, u.y)) return;
        const body = this.resolveRenderWorldPosition(u, 'unit');
        const groundWorld = this.resolveGroundShadowPosition(u, 'unit'),
            ground = this.projectRenderWorldPosition(groundWorld);
        const sc = this.sc(),
            r = this.unitRenderRadius(u);
        const height = Math.max(0, body.y - body.groundY),
            shrink = 1 / (1 + height / 220),
            alpha = RangeUtil.clamp(0.17 - height / 850, 0.06, 0.17);
        if (UnitVisualDefinition.get(u.type)?.billboard) {
            const team = UnitFactionPalette.get(this.factionRelation(u.side)).body,
                rx = r * 1.05 * shrink,
                ry = rx * BattlefieldProjection.groundScale,
                C = this.vectorContext,
                m = this.grainTeamRingMatrix,
                previousColor = C.forceColor,
                previousAlpha = C.globalAlpha,
                previousDepth = C.depth,
                previousTest = C.depthTest,
                previousWrite = C.depthWrite,
                previousFunc = C.depthFunc;
            if (this.frame.length) {
                this.flush();
                this.begin();
            }
            m[0] = rx;
            m[1] = 0;
            m[2] = 0;
            m[3] = ry;
            m[4] = ground.x;
            m[5] = ground.y + r * 0.55;
            C.depth = this.spriteDepthForWorld(groundWorld, 0.0003);
            C.depthTest = !!this.passState.depthEnabled;
            C.depthWrite = false;
            C.depthFunc = this.passState.depthFunc || 'lequal';
            C.forceColor = team;
            C.globalAlpha = 0.85;
            try {
                C.drawMesh(this.grainTeamRing, { transform: m });
            } finally {
                C.forceColor = previousColor;
                C.globalAlpha = previousAlpha;
                C.depth = previousDepth;
                C.depthTest = previousTest;
                C.depthWrite = previousWrite;
                C.depthFunc = previousFunc;
            }
            return;
        }
        this.flushVectorMesh('grain-ring-to-shadow');
        this.withWorldSpriteDepth(
            groundWorld,
            () => {
                this.circle(
                    ground.x + 2 * sc,
                    ground.y + Math.max(1, 2 * sc),
                    r * 0.96 * shrink,
                    [0.04, 0.06, 0.08, alpha],
                    12,
                );
                this.circle(
                    ground.x,
                    ground.y,
                    r * 0.52 * shrink,
                    [0.04, 0.06, 0.08, alpha * 0.5],
                    10,
                );
            },
            0.0003,
        );
    }

    rebuildVisibilityCache() {
        if (!this.snapshot) return;
        for (const side of [0, 1]) VisibilityPolicy.field(this, side, this.snapshot);
    }
    setSnapshot(s, { liveTargets = false, snapTargets = false } = {}) {
        const old = this.snapshot;
        if (
            !old ||
            old.mapDescriptor?.seed !== s.mapDescriptor?.seed ||
            s.tick < old.tick ||
            (snapTargets && s.tick !== old.tick)
        ) {
            this.clearGrainActors();
            this.cornTrails.clear();
            this.cornTrailAnchors.clear();
            this.cornBursts.length = 0;
            this.milletBursts.length = 0;
        }
        if (snapTargets || !old) this.resetFogTransition();
        this.world = WorldContext.forState(s);
        if (!old || old.mapDescriptor?.seed !== s.mapDescriptor?.seed)
            this.cameraTop = this.clampCameraTop(Infinity);
        this.snapshot = s;
        this.buildingArt.prune(s.buildings);
        // Aim/recoil is presentation-only. Never carry it across a map or backwards replay seek.
        if (!old || old.mapDescriptor?.seed !== s.mapDescriptor?.seed || s.tick < old.tick)
            this.launchRecoil.clear();
        for (const id of this.launchRecoil.keys())
            if (!s.buildings.some((b) => b.id === id && b.alive !== false))
                this.launchRecoil.delete(id);

        if (liveTargets) {
            // The sim bridge owns motion and lifetime. UI snapshots only refresh ordinary
            // visual metadata; they cannot introduce an identity ahead of its display time.
            if (!this.liveRenderTargets || !old || snapTargets)
                this.updatePresentationTargets(s, true);
            else this.renderState.updateMetadata(s);
            this.liveRenderTargets = true;
        } else {
            // Replay/snapshot-only consumers do not have the simulation bridge, so each
            // received snapshot becomes a presentation target through the same store.
            this.liveRenderTargets = false;
            this.updatePresentationTargets(s, !!snapTargets || !old);
        }

        this.rebuildVisibilityCache();
    }

    presentEvent(record, ageMs, { hud = false } = {}) {
        if (!this.snapshot) return null;
        const clock = { ageMs, lifeMs: 0, expired: false };
        const event = {
            ...record.payload,
            presentationTick: record.tick,
            presentationSequence: record.sequence,
        };
        const snapshot = { ...this.snapshot, events: [event], presentationClock: clock };
        this.processFloatingEvents(snapshot);
        this.processClientCombatEffects(snapshot);
        this.processCornEvents(snapshot);
        this.processMilletEvents(snapshot);
        if (hud) LaunchPresentation.presentEvents(snapshot, this.mySide());
        return clock;
    }

    triggerClientShake(
        intensity = 2,
        duration = 140,
        seed = 1,
        event = null,
        snapshot = this.snapshot,
    ) {
        const dpr = Math.min(1.6, devicePixelRatio || 1),
            sh = this.shakeFxPool.acquire();
        const clock = snapshot.presentationClock;
        if (clock.ageMs >= duration) {
            this.shakeFxPool.release(sh);
            return;
        }
        EffectObjectFactory.attachClock(sh, clock, duration);
        sh.duration = Math.max(40, duration);
        sh.intensity = Math.max(0.5, intensity * dpr);
        sh.seed = Number(seed) || 1;
        this.shakeFx.push(sh);
        while (this.shakeFx.length > 8) this.shakeFxPool.release(this.shakeFx.shift());
    }

    updateClientShake() {
        let sx = 0,
            sy = 0,
            write = 0;

        for (let i = 0; i < this.shakeFx.length; i++) {
            const sh = this.shakeFx[i],
                age = sh.clock.ageMs;
            if (sh.clock.expired) {
                this.shakeFxPool.release(sh);
                continue;
            }
            if (age >= sh.duration) {
                this.shakeFxPool.release(sh);
                continue;
            }

            const t = age / sh.duration;
            const amp = sh.intensity * Math.pow(1 - t, 2);
            const phase = age * 0.095 + (sh.seed % 997) * 0.013;
            sx += Math.sin(phase * 1.71) * amp;
            sy += Math.sin(phase * 2.33 + 1.7) * amp * 0.72;
            this.shakeFx[write++] = sh;
        }

        this.shakeFx.length = write;
        this.frameShakeX = sx;
        this.frameShakeY = sy;
    }

    processCornEvents(snapshot) {
        if (!snapshot) return;
        for (const event of snapshot.events || []) {
            if (event.type !== 'unitLobExplosion' && event.type !== 'unitSelfDestruct') continue;
            if (!this.eventVisible(event)) continue;
            const tick = Number.isFinite(Number(event.presentationTick))
                ? Number(event.presentationTick)
                : snapshot.tick;
            const clock = snapshot.presentationClock;
            if (clock.ageMs >= EffectObjectFactory.cornBurstLifeMs) continue;
            const burst = {
                x: event.x,
                y: event.y,
                zFP: event.zFP,
                radius: event.radius,
                side: event.side,
                selfDestruct: event.type === 'unitSelfDestruct',
                seed: HashUtil.hash(
                    String(event.projectileId || event.sourceId || '') + '|' + tick,
                ),
            };
            EffectObjectFactory.attachClock(burst, clock, EffectObjectFactory.cornBurstLifeMs);
            this.cornBursts.push(burst);
        }
        if (this.cornBursts.length > 220) this.cornBursts.splice(0, this.cornBursts.length - 220);
    }
    processMilletEvents(snapshot) {
        if (!snapshot) return;
        for (const event of snapshot.events || []) {
            if (event.type !== 'launchLand' || event.unit !== 'millet' || event.index !== 0)
                continue;
            if (!this.eventVisible(event)) continue;
            const clock = snapshot.presentationClock;
            if (clock.ageMs >= EffectObjectFactory.milletBurstLifeMs) continue;
            const burst = {
                x: event.x,
                y: event.y,
                zFP: event.impactHeightFP,
                side: event.side,
            };
            EffectObjectFactory.attachClock(burst, clock, EffectObjectFactory.milletBurstLifeMs);
            this.milletBursts.push(burst);
        }
        if (this.milletBursts.length > 220)
            this.milletBursts.splice(0, this.milletBursts.length - 220);
    }
    addClientFx(kind, e, snapshot, index, extra = {}) {
        const eventTick = Number.isFinite(Number(e.presentationTick))
            ? Number(e.presentationTick)
            : snapshot.tick;
        const seed = HashUtil.hash(
            `${eventTick}|${index}|${kind}|${e.sourceType || e.unit || e.spell || ''}|` +
                `${Math.round(e.x || 0)}|${Math.round(e.y || 0)}`,
        );

        const fx = this.combatFxPool.acquire();
        fx.kind = kind;
        fx.x = Number(e.x) || 0;
        fx.y = Number(e.y) || 0;
        fx.x2 = Number(e.x2) || 0;
        fx.y2 = Number(e.y2) || 0;
        fx.sourceType = e.sourceType || e.unit || '';
        fx.targetType = e.targetType || e.entity || '';
        fx.entity = e.entity || '';
        fx.amount = Number(e.amount) || 0;
        fx.radius = Number(e.radius) || 0;
        fx.width = Number(e.width) || 0;
        fx.remaining = Math.max(0, Number(e.remaining) || 0);
        fx.spikeCount = Math.max(0, Math.round(Number(e.spikeCount) || 0));
        fx.durationTicks = Number(e.durationTicks) || 0;
        fx.sourceId = e.sourceId || null;
        fx.targetId = e.targetId || null;
        fx.travelMs = Number(e.travelMs) || 0;
        fx.arcHeight = Number(e.arcHeight) || 0;
        fx.retractMs = Number(e.retractMs) || 0;
        fx.pullTicks = Number(e.pullTicks) || 0;
        fx.fromX = Number(e.fromX) || 0;
        fx.fromY = Number(e.fromY) || 0;
        fx.fromX = Number.isFinite(Number(e.fromX)) ? Number(e.fromX) : null;
        fx.fromY = Number.isFinite(Number(e.fromY)) ? Number(e.fromY) : null;
        fx.isBuilding = !!e.isBuilding;
        fx.points = Array.isArray(e.points) ? e.points.map((p) => ({ ...p })) : null;
        fx.side = e.side;
        fx.seed = seed;
        const extraKeys = extra && Object.keys(extra);
        if (extraKeys?.length) {
            fx._extraKeys = extraKeys;
            for (const k of extraKeys) fx[k] = extra[k];
        }
        const lifeMs = EffectObjectFactory.combatLife(fx);
        const clock = snapshot.presentationClock;
        if (clock.ageMs >= lifeMs) {
            this.combatFxPool.release(fx);
            return;
        }
        EffectObjectFactory.attachClock(fx, clock, lifeMs);
        this.combatFx.push(fx);

        while (this.combatFx.length > 220) this.combatFxPool.release(this.combatFx.shift());
    }

    processClientCombatEffects(snapshot) {
        if (!snapshot || !this.fxCtx) return;

        const mySide = this.mySide();
        let index = snapshot.events?.[0]?.presentationSequence ?? 0;

        for (const e of snapshot.events || []) {
            const x = Number(e.x),
                y = Number(e.y);
            const visible =
                e.side === mySide ||
                (Number.isFinite(x) && Number.isFinite(y) && this.eventVisible(e));
            if (!visible) {
                index++;
                continue;
            }

            if (e.type === 'hit') {
                const sourceType = e.sourceType || '';
                const attackVisual = AttackPresentationDefinition.forSource(sourceType),
                    impactPreset = AttackPresentationDefinition.impactPreset(sourceType);
                if (attackVisual.travel === 'none' && attackVisual.sourceMotion && e.sourceId) {
                    const source = e.presentationSource;
                    if (source?.alive)
                        this.addClientFx(
                            'meleeSourceMotion',
                            { ...e, x: source.x, y: source.y, x2: e.x, y2: e.y },
                            snapshot,
                            index,
                            { motion: attackVisual.sourceMotion },
                        );
                }
                if (attackVisual.travel === 'hitscan' && !e.suppressImpactFx) {
                    const source = e.presentationSource;
                    if (source?.alive) {
                        const dx = e.x - source.x,
                            dy = e.y - source.y,
                            length = Math.hypot(dx, dy) || 1;
                        const recoil = {
                            presentationTick: this.presentationEventTick(e, snapshot),
                            dx: dx / length,
                            dy: dy / length,
                            power: 0,
                        };
                        if (snapshot.presentationClock.ageMs < 260) {
                            EffectObjectFactory.attachClock(
                                recoil,
                                snapshot.presentationClock,
                                260,
                            );
                            this.launchRecoil.set(source.id, recoil);
                        }
                        this.addClientFx(
                            'hitscanTravel',
                            { ...e, x: source.x, y: source.y, x2: e.x, y2: e.y, side: source.side },
                            snapshot,
                            index,
                            { aimDx: dx / length, aimDy: dy / length },
                        );
                    }
                }
                if (!e.suppressImpactFx)
                    this.addClientFx('meleeImpact', e, snapshot, index, {
                        impactScale: impactPreset.scale,
                    });
                if (e.side === mySide)
                    this.triggerClientShake(
                        1.5,
                        90,
                        HashUtil.hash(`${snapshot.tick}|hurt|${index}`),
                        e,
                        snapshot,
                    );
            } else if (e.type === 'spinBasicImpact') {
                this.addClientFx('spinBasicImpact', e, snapshot, index);
            } else if (e.type === 'heroRollHit') {
                this.addClientFx('meleeImpact', e, snapshot, index, { impactScale: 1.5 });
            } else if (e.type === 'fruitBerryLand') {
                this.addClientFx('fruitBerryImpact', e, snapshot, index);
            } else if (e.type === 'unitThornHit') {
                this.addClientFx('thornImpact', e, snapshot, index, {
                    id: 'thorn-impact:' + e.projectileId,
                    impactHeightFP: e.zFP,
                    eventTick: Number.isFinite(Number(e.presentationTick))
                        ? Number(e.presentationTick)
                        : snapshot.tick,
                    thornReplayClock: null,
                });
            } else if (e.type === 'death') {
                this.addClientFx('deathBurst', e, snapshot, index);
            } else if (e.type === 'buildingDeath') {
                this.addClientFx('buildingBurst', e, snapshot, index);
                this.triggerClientShake(
                    3.5,
                    180,
                    HashUtil.hash(`${snapshot.tick}|building|${index}`),
                    e,
                    snapshot,
                );
            } else if (e.type === 'constructionHit') {
                this.addClientFx(
                    'constructionHit',
                    { ...e, x: e.contactX ?? e.x, y: e.contactY ?? e.y },
                    snapshot,
                    index,
                    {
                        spend: e.spend,
                        workAdded: e.workAdded,
                        eventTick: e.presentationTick ?? snapshot.tick,
                    },
                );
            } else if (e.type === 'launchFire' || e.type === 'mortarFire') {
                this.launchFireFx(e, snapshot, index);
            } else if (e.type === 'launchImpact') {
                this.launchImpactFx(e, snapshot, index);
            } else if (
                e.type === 'leapLand' ||
                e.type === 'heroRollLand' ||
                e.type === 'mortarImpact'
            ) {
                this.addClientFx('launchBlast', e, snapshot, index, {
                    peak: 1,
                    hits: e.hits ?? 1,
                    groundRing: e.type !== 'leapLand',
                    impactHeightFP: e.impactHeightFP,
                });
            } else if (e.type === 'launchOverheat') {
                const b = e.presentationSource,
                    aim = b ? this.cannonAim(b) : { dx: 0, dy: -1 };
                this.addClientFx('launchMuzzle', e, snapshot, index, {
                    power: 0,
                    mode: 'overheat',
                    shot: 0,
                    cannonId: e.cannonId,
                    aimDx: aim.dx,
                    aimDy: aim.dy,
                });
            }
            index++;
        }
    }
    // The firing moment: muzzle flash and smoke at the cannon, a kick on the cannon itself, and a
    // camera shake that grows with the charge. Later shells of a burst are lighter; a shotgun flashes once.
    launchFireFx(e, snapshot, index) {
        const power = RangeUtil.clamp(Number(e.power) || 0, 0, 1),
            mode = e.mode || 'single',
            first = !(e.shot > 0);
        const dx = Number(e.aimX) - e.x,
            dy = Number(e.aimY) - e.y,
            len = Math.hypot(dx, dy) || 1;
        const eventTick = this.presentationEventTick(e, snapshot);
        const recoil = {
            presentationTick: eventTick,
            dx: dx / len,
            dy: dy / len,
            power,
        };
        if (snapshot.presentationClock.ageMs < 260) {
            EffectObjectFactory.attachClock(recoil, snapshot.presentationClock, 260);
            this.launchRecoil.set(e.cannonId, recoil);
        }
        if (mode !== 'shotgun' || first)
            this.addClientFx('launchMuzzle', { ...e, x2: e.aimX, y2: e.aimY }, snapshot, index, {
                power,
                mode,
                shot: e.shot || 0,
                cannonId: e.cannonId,
                aimDx: dx / len,
                aimDy: dy / len,
            });
        if (mode === 'shotgun' && !first) return;
        const weight = (first ? 1 : 0.55) * (mode === 'shotgun' ? 1.25 : 1);
        this.triggerClientShake(
            (1.2 + 3.8 * power) * weight,
            EffectObjectFactory.fireShakeDuration(power),
            HashUtil.hash(`${snapshot.tick}|fire|${index}`),
            e,
            snapshot,
        );
    }
    // The landing: a shock ring the size of the blast, dust, and a flash that grows when the strike was near the middle.
    launchImpactFx(e, snapshot, index) {
        const peak = Number(e.peak) || 1,
            hits = Number(e.hits) || 0;
        const dx = Number(e.dirX),
            dy = Number(e.dirY),
            angle = Number.isFinite(dx) && Number.isFinite(dy) ? Math.atan2(dy, dx) : 0;
        if (e.unit !== 'millet') {
            this.addClientFx('launchBlast', e, snapshot, index, {
                peak,
                hits,
                impactHeightFP: e.impactHeightFP,
            });
        }
        this.addClientFx('launchBundleBreak', e, snapshot, index, {
            id: 'bundle:' + e.projectileId,
            grainType: e.unit,
            angle,
            impactHeightFP: e.impactHeightFP,
        });
        const shake = hits > 0 ? 0.7 + 0.9 * peak : 0.5;
        this.triggerClientShake(
            shake,
            EffectObjectFactory.impactShakeDuration(peak, hits),
            HashUtil.hash(`${snapshot.tick}|blast|${index}`),
            e,
            snapshot,
        );
    }
    // World-space aim remains outside the deterministic simulation and survives the short recoil clip.
    cannonAim(b) {
        const hold = LaunchPresentation.hold;
        if (
            !ReplayPresentation.replayPlayer &&
            hold?.cannonId === b.id &&
            this.isFriendlySide(b.side)
        ) {
            const dx = hold.aimX - b.x,
                dy = hold.aimY - b.y,
                length = Math.hypot(dx, dy);
            if (length > 0.001) return { dx: dx / length, dy: dy / length };
        }
        const shot = this.launchRecoil.get(b.id);
        if (shot && !shot.clock.expired && shot.clock.ageMs < 260)
            return { dx: shot.dx, dy: shot.dy };
        // In-flight aim is recoverable from a snapshot, including a replay seek. Idle cannons face the enemy base.
        const pods = this.snapshot.projectiles;
        for (let i = pods.length - 1; i >= 0; i--) {
            const p = pods[i];
            if (p.owner !== b.id || !p.payload) continue;
            const dx = p.lockedAimX - p.launchX,
                dy = p.lockedAimY - p.launchY,
                length = Math.hypot(dx, dy);
            if (length > 0.001) return { dx: dx / length, dy: dy / length };
        }
        const target = Object.hasOwn(b, 'presentationTarget')
            ? b.presentationTarget
            : b.targetId &&
              ((this.snapshot.units || []).find((u) => u.id === b.targetId && u.alive !== false) ||
                  (this.snapshot.buildings || []).find(
                      (v) => v.id === b.targetId && v.alive !== false,
                  ));
        if (target) {
            const dx = target.x - b.x,
                dy = target.y - b.y,
                length = Math.hypot(dx, dy) || 1;
            return { dx: dx / length, dy: dy / length };
        }
        const enemy = this.snapshot.buildings.find(
            (v) =>
                v.side === 1 - b.side && v.alive !== false && BuildingDefinition.isMainBase(v.type),
        );
        const dx = enemy ? enemy.x - b.x : 0,
            dy = enemy ? enemy.y - b.y : b.side === 0 ? -1 : 1,
            length = Math.hypot(dx, dy) || 1;
        return { dx: dx / length, dy: dy / length };
    }
    cannonArtOptions(b, { aim = this.cannonAim(b), fireAgeMs, power } = {}) {
        const [x, y] = this.worldToPx(this.viewX(b.x), this.viewY(b.y)),
            shot = this.launchRecoil.get(b.id),
            flip = this.orientationRole() === 'guest' ? -1 : 1;
        const impact = this.constructionImpact(b),
            compression = impact ? impact.pulse * (impact.fx.spend > 0 ? 0.06 : 0.025) : 0;
        return {
            x: x + this.constructionWobble(impact),
            y: y + compression * 10 * this.sc(),
            sc: this.sc() * (1 - compression),
            own: this.isFriendlySide(b.side),
            aim: { dx: aim.dx * flip, dy: aim.dy * flip },
            fireAgeMs: fireAgeMs ?? (shot && !shot.clock.expired ? shot.clock.ageMs : Infinity),
            power: power ?? shot?.power ?? 0,
        };
    }
    processFloatingEvents(snapshot) {
        if (!snapshot || !this.fxCtx) return;

        const side = this.mySide();
        let index = snapshot.events?.[0]?.presentationSequence ?? 0;

        for (const e of snapshot.events || []) {
            let kind = null,
                text = '',
                amount = 0;

            if (e.type === 'hit' && e.amount > 0) {
                // 적/중립 피해 숫자는 실제 시야가 있을 때만 보여 Fog 정보를 새지 않게 한다.
                if (!this.eventVisible(e)) {
                    index++;
                    continue;
                }
                kind = e.side === side ? 'damageTaken' : 'damageDealt';
                amount = e.amount;
                text = `-${e.amount}`;
            } else if (e.type === 'dodge' || e.type === 'graze') {
                if (!this.eventVisible(e)) {
                    index++;
                    continue;
                }
                kind = 'dodge';
                text = 'MISS';
            }

            if (!kind) {
                index++;
                continue;
            }

            const eventTick = Number.isFinite(Number(e.presentationTick))
                ? Number(e.presentationTick)
                : snapshot.tick;
            const seed = HashUtil.hash(
                `${eventTick}|${index}|${kind}|${Math.round(e.x)}|${Math.round(e.y)}|${amount}`,
            );
            const f = this.floatFxPool.acquire();
            f.x = e.x;
            f.y = e.y;
            f.kind = kind;
            f.text = text;
            f.amount = amount;
            f.jitter = ((seed % 1000) / 1000 - 0.5) * 34;
            f.lane = (seed >>> 10) % 4;
            const lifeMs = FloatingTextPresentationDefinition.get(kind).lifeMs;
            if (snapshot.presentationClock.ageMs >= lifeMs) {
                this.floatFxPool.release(f);
                index++;
                continue;
            }
            EffectObjectFactory.attachClock(f, snapshot.presentationClock, lifeMs);
            this.floatFx.push(f);
            index++;
        }

        // 화면을 숫자로 도배하지 않되, 최근 실제 타격 수치는 충분히 남긴다.
        while (this.floatFx.length > 72) this.floatFxPool.release(this.floatFx.shift());
    }

    constructionImpact(building) {
        const active = (f) =>
            f.kind === 'constructionHit' &&
            f.targetId === building.id &&
            !f.clock.expired &&
            f.clock.ageMs < 220;
        const paid = this.combatFx.findLast((f) => active(f) && f.spend > 0),
            latest = paid || this.combatFx.findLast(active);
        if (!latest) return null;
        let spend = 0;
        if (paid)
            for (const f of this.combatFx)
                if (
                    f.kind === 'constructionHit' &&
                    f.targetId === building.id &&
                    f.eventTick === paid.eventTick
                )
                    spend += Math.max(0, Number(f.spend) || 0);
        return {
            fx: paid ? { ...paid, spend } : latest,
            progress: latest.clock.ageMs / 220,
            pulse: Math.sin((latest.clock.ageMs / 220) * Math.PI),
        };
    }
    constructionWobble(impact) {
        return impact
            ? Math.sin(impact.progress * Math.PI * 2) * (1 - impact.progress) * 5 * this.sc()
            : 0;
    }
    // Five cells normalize the rule's next expense interval. They do not prescribe five hits.
    drawConstructionPaymentMeter(ctx, work, x, y, width, height, impact = null) {
        const next = ConstructionRules.nextPayment(work);
        if (!next) return null;
        const gap = 3,
            cellWidth = (width - gap * 4) / 5,
            spending = impact?.fx.spend > 0;
        for (let i = 0; i < 5; i++) {
            const left = x - width / 2 + i * (cellWidth + gap),
                fill = RangeUtil.clamp(next.progress * 5 - i, 0, 1);
            ctx.fillStyle = 'rgba(0,0,0,.65)';
            ctx.fillRect(left, y, cellWidth, height);
            ctx.fillStyle = spending ? '#ffe7a1' : '#a6d9ff';
            ctx.fillRect(left, y, cellWidth * (spending ? 1 : fill), height);
            if (impact) {
                ctx.strokeStyle = spending
                    ? `rgba(255,224,126,${impact.pulse})`
                    : `rgba(190,232,255,${impact.pulse})`;
                ctx.lineWidth = 1;
                ctx.strokeRect(left - 1, y - 1, cellWidth + 2, height + 2);
            }
        }
        return next;
    }
    drawStrategicLabels() {
        const ctx = this.fxCtx;
        if (!ctx || !this.snapshot) return;
        const sc = this.sc(),
            side = this.mySide();
        ctx.save();
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        const ratio = this.fxCanvas.width / Math.max(1, this.canvas.clientWidth),
            pad = 6 * ratio,
            textTop = 8 * ratio,
            top = (MatchLifecycle.selectedCampaign ? 126 : 96) * ratio,
            feedback = DomUtil.byId('launchFeedback'),
            bottom = feedback && !feedback.classList.contains('hidden') ? 50 * ratio : pad,
            placed = [];
        const labelPosition = (x, y, wantedY, lines, height) => {
            if (x < 0 || x > this.fxCanvas.width || y < 0 || y > this.fxCanvas.height) return null;
            const lastY = this.fxCanvas.height - height - bottom;
            if (lastY < top) return null;
            const wanted = RangeUtil.clamp(wantedY, top, lastY);
            const textWidth = Math.max(...lines.map((line) => ctx.measureText(line).width)) + pad;
            const rows = [wanted];
            for (const bounds of placed) {
                rows.push(bounds.bottom + textTop + pad, bounds.top - height - pad);
            }
            rows.sort((a, b) => Math.abs(a - wanted) - Math.abs(b - wanted));
            for (const labelY of rows) {
                if (labelY < top || labelY > lastY) continue;
                const right = this.fxCanvas.width - pad - (labelY < 154 * ratio ? 98 * ratio : 0);
                const width = Math.min(right - pad, textWidth);
                if (width <= 0) continue;
                const labelX = RangeUtil.clamp(x, pad + width / 2, right - width / 2);
                const bounds = {
                    left: labelX - width / 2,
                    right: labelX + width / 2,
                    top: labelY - textTop,
                    bottom: labelY + height,
                };
                if (
                    placed.some(
                        (other) =>
                            bounds.left < other.right &&
                            bounds.right > other.left &&
                            bounds.top < other.bottom &&
                            bounds.bottom > other.top,
                    )
                )
                    continue;
                placed.push(bounds);
                return { x: labelX, y: labelY, width };
            }
            return null;
        };
        for (const cp of this.snapshot.capturePoints || []) {
            const [px, py] = this.worldToPx(this.viewX(cp.x), this.viewY(cp.y));
            if (px < 0 || px > this.fxCanvas.width || py < 0 || py > this.fxCanvas.height) continue;
            const outpost = (this.snapshot.buildings || []).find(
                (b) => b.id === cp.outpostId && b.alive !== false,
            );
            const construction = outpost?.construction;
            const visibleConstruction =
                construction &&
                (this.isFriendlySide(outpost.side) || this.visibleRaw(outpost.x, outpost.y));
            const locked = !cp.enabled && !outpost;
            const relation = this.factionRelation(visibleConstruction ? outpost.side : cp.owner);
            const ownerColor =
                relation === 'friendly' ? '#4d93ff' : relation === 'enemy' ? '#ef5757' : '#c0cbb2';
            ResourceDisplay.drawDepositMarker(
                ctx,
                px,
                py,
                Math.max(5.2, 6 * sc),
                cp.resourceType,
                ownerColor,
                locked,
            );
            const owner = visibleConstruction
                ? outpost.side === side
                    ? '아군 건설 중'
                    : '적 건설 중'
                : cp.owner === side
                  ? '아군 거점'
                  : cp.owner == null
                    ? locked
                        ? '오브젝트 잠금'
                        : '점령 가능'
                    : '적 거점';
            ctx.font = `900 ${Math.max(9, 11 * sc)}px system-ui,sans-serif`;
            ctx.lineWidth = Math.max(2, 3 * sc);
            ctx.strokeStyle = 'rgba(0,0,0,.60)';
            const kind = cp.resourceType === 'premium' ? RESOURCES[1] : RESOURCES[0];
            const siteName = ResourceDisplay.depositName(cp, kind);
            const efficiency = LaunchRules.productionEfficiency(cp);
            const previousUse =
                cp.owner == null && efficiency < 100 ? ` · 효율 ${efficiency}%` : '';
            const text = `${kind.symbol} ${siteName} · ${owner}${previousUse}`,
                lineGap = Math.max(14, 15 * sc);
            const workers = visibleConstruction
                ? (this.snapshot.units || []).filter(
                      (u) =>
                          u.alive !== false &&
                          u.constructionWork?.targetId === outpost.id &&
                          (this.isFriendlySide(u.side) || this.visibleRaw(u.x, u.y)),
                  )
                : [];
            const workState = !visibleConstruction
                ? ''
                : !workers.length
                  ? outpost.side === side
                      ? '작업자 필요'
                      : '작업자 미확인'
                  : workers.every((u) => u.constructionWork.phase === 'waiting')
                    ? '자원 대기'
                    : workers.every((u) => u.constructionWork.phase === 'approach')
                      ? `${workers.length}명 접근 중`
                      : `${workers.length}명 작업 중`;
            const cost = BuildingDefinition.get(BuildingDefinition.forRole('outpost')).construction
                .cost;
            const production = RESOURCES.flatMap(({ key, symbol }) => {
                const rate = LaunchRules.productionRate(cp, key);
                return rate > 0 ? [`${symbol} +${ResourceDisplay.rateText(rate)}/초`] : [];
            });
            const guide = visibleConstruction
                ? `건설 ${Math.round(ConstructionRules.progress(construction) * 1000) / 10}% · ◆ ${construction.invested}/${construction.cost}`
                : cp.owner != null
                  ? [`효율 ${efficiency}%`, ...production].join(' · ')
                  : locked
                    ? '연결 전술 오브젝트 처치 필요'
                    : `병력으로 건설 · ◆ ${cost}`;
            const label = labelPosition(
                px,
                py,
                py -
                    Math.max(visibleConstruction ? 110 : 50, (visibleConstruction ? 180 : 64) * sc),
                [text, guide],
                lineGap + (visibleConstruction ? 45 : 8),
            );
            if (!label) continue;
            const { x, y: labelY, width } = label;
            ctx.strokeText(text, x, labelY, width);
            ctx.fillStyle = '#fff';
            ctx.fillText(text, x, labelY, width);
            ctx.font = `800 ${Math.max(10, 9 * sc)}px system-ui,sans-serif`;
            ctx.strokeText(guide, x, labelY + lineGap, width);
            ctx.fillStyle =
                cp.owner === side || (visibleConstruction && outpost.side === side)
                    ? '#cfe6ff'
                    : '#fff3b0';
            ctx.fillText(guide, x, labelY + lineGap, width);
            if (visibleConstruction) {
                const ratio = ConstructionRules.progress(construction),
                    w = Math.min(width, Math.max(80, 96 * sc)),
                    h = Math.max(4, 5 * sc),
                    barY = labelY + lineGap + 10,
                    impact = this.constructionImpact(outpost);
                ctx.fillStyle = 'rgba(0,0,0,.65)';
                ctx.fillRect(x - w / 2, barY, w, h);
                ctx.fillStyle = '#ffd36b';
                ctx.fillRect(x - w / 2, barY, w * ratio, h);
                const next = this.drawConstructionPaymentMeter(
                    ctx,
                    construction,
                    x,
                    barY + 11,
                    w,
                    Math.max(5, 6 * sc),
                    impact,
                );
                const payment =
                    impact?.fx.spend > 0
                        ? `◆ −${impact.fx.spend}`
                        : next
                          ? `다음 ◆ ${next.amount}`
                          : '추가 지출 없음';
                ctx.font = `800 ${Math.max(9, 9 * sc)}px system-ui,sans-serif`;
                ctx.strokeText(`${payment} · ${workState}`, x, barY + 28, width);
                ctx.fillStyle = impact?.fx.spend > 0 ? '#ffe1a1' : '#d8ebff';
                ctx.fillText(`${payment} · ${workState}`, x, barY + 28, width);
            }
        }
        ctx.restore();
    }

    drawClientCombatFx() {
        const ctx = this.fxCtx;
        if (!ctx || !this.fxCanvas) return;
        let write = 0;
        const sc = this.sc();

        const dot = (x, y, r, fill, alpha = 1) => {
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            ctx.arc(x, y, Math.max(0.8, r), 0, Math.PI * 2);
            ctx.fillStyle = fill;
            ctx.fill();
        };

        const ring = (x, y, r, width, stroke, alpha = 1, yScale = 1) => {
            ctx.globalAlpha = alpha;
            ctx.beginPath();
            const radius = Math.max(1, r);
            ctx.ellipse(x, y, radius, radius * yScale, 0, 0, Math.PI * 2);
            ctx.lineWidth = Math.max(1, width);
            ctx.strokeStyle = stroke;
            ctx.stroke();
        };

        const resolveFxEntityScreen = (id) => {
            if (!id || !this.snapshot) return null;
            const u = (this.snapshot.units || []).find((v) => v.id === id && v.alive !== false);
            if (u) {
                const p = this.projectEntityScreen(u, 'unit');
                return [p.x, p.y];
            }
            const b = (this.snapshot.buildings || []).find((v) => v.id === id && v.alive !== false);
            if (b) return this.worldToPx(this.viewX(b.x), this.viewY(b.y));
            return null;
        };

        const fxDirection = (fx, x, y, mode = 'target') => {
            let p = null;
            if (mode === 'target') p = resolveFxEntityScreen(fx.targetId);
            else p = resolveFxEntityScreen(fx.sourceId);
            if (
                !p &&
                mode === 'target' &&
                Number.isFinite(fx.x2) &&
                Number.isFinite(fx.y2) &&
                (fx.x2 || fx.y2)
            ) {
                p = this.worldToPx(this.viewX(fx.x2), this.viewY(fx.y2));
            }
            if (!p && mode === 'source' && fx.fromX != null && fx.fromY != null) {
                p = this.worldToPx(this.viewX(fx.fromX), this.viewY(fx.fromY));
            }
            if (!p) return null;
            let dx = mode === 'source' ? x - p[0] : p[0] - x;
            let dy = mode === 'source' ? y - p[1] : p[1] - y;
            const len = Math.hypot(dx, dy);
            if (len < 0.001) return null;
            return { x: dx / len, y: dy / len };
        };

        const burst = (
            fx,
            x,
            y,
            t,
            count,
            color,
            speed = 52,
            size = 3,
            flatten = 0.72,
            seedOverride = null,
        ) => {
            const seed = seedOverride == null ? fx.seed : seedOverride;
            for (let i = 0; i < count; i++) {
                const h = HashUtil.hash(`${seed}|p|${i}`);
                const a = ((h % 4096) / 4096) * Math.PI * 2;
                const k = 0.62 + ((h >>> 12) % 1000) / 1500;
                const d = (8 + speed * t * k) * sc;
                const rr = (size + ((h >>> 22) % 3)) * (1 - t * 0.55) * Math.max(0.55, sc);
                dot(
                    x + Math.cos(a) * d,
                    y + Math.sin(a) * d * flatten,
                    rr,
                    color,
                    Math.max(0, 1 - t),
                );
            }
        };

        for (let read = 0; read < this.combatFx.length; read++) {
            const fx = this.combatFx[read];
            const age = fx.clock.ageMs;
            const life = EffectObjectFactory.combatLife(fx);
            if (fx.clock.expired || age >= life) {
                this.combatFxPool.release(fx);
                continue;
            }
            if (fx.kind === 'thornImpact') {
                this.combatFx[write++] = fx;
                continue;
            }
            const t = age / life;
            const ease = 1 - Math.pow(1 - t, 3);
            let [x, y] = this.worldToPx(
                this.viewX(fx.x),
                this.viewY(fx.y),
                Number.isFinite(fx.impactHeightFP) ? fx.impactHeightFP / 100 : null,
            );

            if (
                x < -160 ||
                x > this.fxCanvas.width + 160 ||
                y < -160 ||
                y > this.fxCanvas.height + 160
            ) {
                this.combatFx[write++] = fx;
                continue;
            }

            ctx.save();
            ctx.lineCap = 'round';
            ctx.lineJoin = 'round';

            if (fx.kind === 'meleeSourceMotion') {
                const motion = fx.motion || 'smash';
                const src = resolveFxEntityScreen(fx.sourceId);
                const sx0 = src?.[0] ?? x,
                    sy0 = src?.[1] ?? y;
                let tx = sx0 + 1,
                    ty = sy0;
                if (Number.isFinite(fx.x2) && Number.isFinite(fx.y2)) {
                    const tp = this.worldToPx(this.viewX(fx.x2), this.viewY(fx.y2));
                    tx = tp[0];
                    ty = tp[1];
                }
                let dx = tx - sx0,
                    dy = ty - sy0,
                    dl = Math.hypot(dx, dy) || 1;
                dx /= dl;
                dy /= dl;
                // Source Motion belongs to the attacker, not the contact point. Keep the
                // entire gesture inside a small radius around the attacker's silhouette;
                // target-side readability is owned exclusively by Impact FX.
                const sourceEntity = (this.snapshot?.units || []).find(
                    (u) => u.id === fx.sourceId && u.alive,
                );
                const sourceRadius = sourceEntity ? this.unitRenderRadius(sourceEntity) : 12;
                const preset =
                    AttackPresentationDefinition.sourceMotions[motion] ||
                    AttackPresentationDefinition.sourceMotions.smash;
                // unitRenderRadius is already in screen pixels, so this stays stable across target sizes.
                const effectSize = RangeUtil.clamp(
                    sourceRadius * preset.sourceRadiusScale,
                    preset.baseSize * sc,
                    preset.maxSize * sc,
                );
                const reach = effectSize,
                    px = -dy,
                    py = dx,
                    fade = 1 - t;
                if (motion === 'slash') {
                    const cx = sx0 + dx * reach * 0.28,
                        cy = sy0 + dy * reach * 0.28,
                        a = Math.atan2(dy, dx),
                        rad = reach * 0.72;
                    ctx.globalAlpha = 0.88 * fade;
                    ctx.strokeStyle = '#fff0a8';
                    ctx.lineWidth = Math.max(1.6, 3 * sc);
                    ctx.beginPath();
                    ctx.arc(cx, cy, rad, a - 1.12, a + 0.72);
                    ctx.stroke();
                    ctx.globalAlpha = 0.42 * fade;
                    ctx.strokeStyle = '#9fe66f';
                    ctx.lineWidth = Math.max(1, 1.7 * sc);
                    ctx.beginPath();
                    ctx.arc(cx, cy, rad * 0.78, a - 0.96, a + 0.6);
                    ctx.stroke();
                } else if (motion === 'thrust') {
                    const ext = reach * (0.55 + 0.45 * ease),
                        ex = sx0 + dx * ext,
                        ey = sy0 + dy * ext;
                    ctx.globalAlpha = 0.92 * fade;
                    ctx.strokeStyle = '#fff1a3';
                    ctx.lineWidth = Math.max(1.5, 2.8 * sc);
                    ctx.beginPath();
                    ctx.moveTo(sx0 + dx * 4 * sc, sy0 + dy * 4 * sc);
                    ctx.lineTo(ex, ey);
                    ctx.stroke();
                    ctx.globalAlpha = 0.48 * fade;
                    ctx.strokeStyle = '#c9ef83';
                    ctx.lineWidth = Math.max(1, 1.5 * sc);
                    ctx.beginPath();
                    ctx.moveTo(ex - px * 5 * sc, ey - py * 5 * sc);
                    ctx.lineTo(ex + px * 5 * sc, ey + py * 5 * sc);
                    ctx.stroke();
                } else if (motion === 'claw') {
                    for (const side of [-1, 1]) {
                        const spread = (1 - ease) * 7 * sc * side,
                            cx = sx0 + dx * reach * 0.72 + px * spread,
                            cy = sy0 + dy * reach * 0.72 + py * spread;
                        ctx.globalAlpha = 0.84 * fade;
                        ctx.strokeStyle = '#ffd57c';
                        ctx.lineWidth = Math.max(1.4, 2.5 * sc);
                        ctx.beginPath();
                        ctx.moveTo(sx0 + px * side * 8 * sc, sy0 + py * side * 8 * sc);
                        ctx.quadraticCurveTo(
                            cx + px * side * 6 * sc,
                            cy + py * side * 6 * sc,
                            cx,
                            cy,
                        );
                        ctx.stroke();
                    }
                } else if (motion === 'bite') {
                    // Readable even on tiny summons: two jaws visibly start open and snap shut
                    // immediately in front of the attacker. Impact remains target-side only.
                    const biteReach = reach,
                        cx = sx0 + dx * biteReach * 0.72,
                        cy = sy0 + dy * biteReach * 0.72;
                    const jawOpen = (1 - ease) * 12 * sc + 2 * sc;
                    for (const side of [-1, 1]) {
                        const bx = cx + px * side * jawOpen,
                            by = cy + py * side * jawOpen;
                        ctx.globalAlpha = 0.94 * fade;
                        ctx.strokeStyle = '#e8f69a';
                        ctx.lineWidth = Math.max(1.8, 3.2 * sc);
                        ctx.beginPath();
                        ctx.moveTo(
                            sx0 + dx * 3 * sc + px * side * 8 * sc,
                            sy0 + dy * 3 * sc + py * side * 8 * sc,
                        );
                        ctx.quadraticCurveTo(
                            bx - dx * 5 * sc,
                            by - dy * 5 * sc,
                            cx + dx * 7 * sc,
                            cy + dy * 7 * sc,
                        );
                        ctx.stroke();
                        // Short fang marks make "bite" readable rather than another slash.
                        ctx.globalAlpha = 0.76 * fade;
                        ctx.lineWidth = Math.max(1.2, 2 * sc);
                        ctx.beginPath();
                        ctx.moveTo(cx + px * side * 5 * sc, cy + py * side * 5 * sc);
                        ctx.lineTo(cx + dx * 7 * sc, cy + dy * 7 * sc);
                        ctx.stroke();
                    }
                } else {
                    // Smash is deliberately bold and local: wind-up streak -> heavy forward stroke
                    // -> attacker-side semicircular shock. This is not the target impact effect.
                    const smashReach = reach,
                        ex = sx0 + dx * smashReach * (0.5 + 0.5 * ease),
                        ey = sy0 + dy * smashReach * (0.5 + 0.5 * ease);
                    const backX = sx0 - dx * (7 + 5 * (1 - ease)) * sc,
                        backY = sy0 - dy * (7 + 5 * (1 - ease)) * sc;
                    ctx.globalAlpha = 0.94 * fade;
                    ctx.strokeStyle = '#f4dd83';
                    ctx.lineWidth = Math.max(3, 7 * sc);
                    ctx.beginPath();
                    ctx.moveTo(backX, backY);
                    ctx.lineTo(ex, ey);
                    ctx.stroke();
                    const a = Math.atan2(dy, dx),
                        rr = (8 + 11 * ease) * sc;
                    ctx.globalAlpha = 0.7 * fade;
                    ctx.strokeStyle = '#ffeaa0';
                    ctx.lineWidth = Math.max(2, 3.4 * sc);
                    ctx.beginPath();
                    ctx.arc(ex, ey, rr, a - Math.PI * 0.58, a + Math.PI * 0.58);
                    ctx.stroke();
                    ctx.globalAlpha = 0.34 * fade;
                    ctx.strokeStyle = '#9b7b38';
                    ctx.lineWidth = Math.max(1.4, 2.2 * sc);
                    ctx.beginPath();
                    ctx.arc(ex, ey, rr * 0.72, a - Math.PI * 0.5, a + Math.PI * 0.5);
                    ctx.stroke();
                }
            } else if (fx.kind === 'meleeImpact') {
                const isc = Number(fx.impactScale) || 1,
                    incoming = fxDirection(fx, x, y, 'source');
                dot(x, y, (7 + 8 * (1 - t)) * sc * isc, '#fff7c8', Math.max(0, 1 - t * 1.2));
                ring(x, y, (7 + 24 * ease) * sc * isc, 2.4 * sc * isc, '#ffb93e', 0.72 * (1 - t));
                const baseA = incoming
                    ? Math.atan2(incoming.y, incoming.x) + Math.PI * 0.5
                    : ((fx.seed % 360) / 180) * Math.PI;
                for (let i = 0; i < 3; i++) {
                    const spread =
                        (i - 1) * 0.3 +
                        ((HashUtil.hash(`${fx.seed}|slash|${i}`) % 1000) / 1000 - 0.5) * 0.18;
                    const a = baseA + spread;
                    const len = (15 + 22 * ease) * sc * isc;
                    ctx.globalAlpha = 0.9 * (1 - t);
                    ctx.strokeStyle = i === 0 ? '#fff7d6' : '#ff9e35';
                    ctx.lineWidth = Math.max(1.5, (3.2 - i * 0.5) * sc * isc);
                    ctx.beginPath();
                    ctx.moveTo(x - Math.cos(a) * len * 0.34, y - Math.sin(a) * len * 0.34);
                    ctx.lineTo(x + Math.cos(a) * len, y + Math.sin(a) * len);
                    ctx.stroke();
                }
                burst(fx, x, y, t, 5, '#ffd26a', 34, 2.2);
            } else if (fx.kind === 'deathBurst') {
                const vd =
                    UnitVisualDefinition.get(fx.entity) ||
                    UnitVisualDefinition.get(fx.targetType) ||
                    null;
                const ac = vd?.accent || [0.9, 0.82, 0.66, 1];
                const accent = `rgb(${Math.round(ac[0] * 255)},${Math.round(ac[1] * 255)},${Math.round(ac[2] * 255)})`;
                burst(fx, x, y, t, 6, accent, 54, 3.5, 0.62);
                burst(fx, x, y, t, 5, '#e7d7b7', 64, 2.5, 0.58, fx.seed ^ 0x2a51);
                ring(x, y, (6 + 26 * ease) * sc, 2 * sc, accent, 0.34 * (1 - t));
            } else if (fx.kind === 'buildingBurst') {
                burst(fx, x, y, t, 13, '#6a6259', 72, 4.8, 0.48);
                burst(fx, x, y, t, 7, '#d2aa63', 58, 3.3, 0.52);
                ring(x, y, (15 + 72 * ease) * sc, 3 * sc, '#b98c54', 0.35 * (1 - t));
            } else if (fx.kind === 'constructionHit') {
                const paid = fx.spend > 0;
                burst(fx, x, y, t, paid ? 6 : 3, '#e7bd75', paid ? 28 : 16, paid ? 2 : 1.5, 0.5);
                ring(
                    x,
                    y,
                    (4 + (paid ? 12 : 6) * ease) * sc,
                    Math.max(1, 1.5 * sc),
                    paid ? '#ffe1a1' : '#f2d39a',
                    0.5 * (1 - t),
                );
            } else if (fx.kind === 'hitscanTravel') {
                const source = { id: fx.sourceId, x: fx.x, y: fx.y, side: fx.side };
                const pose = BuildingArt.pose(
                    this.cannonArtOptions(source, {
                        aim: { dx: fx.aimDx, dy: fx.aimDy },
                        fireAgeMs: age,
                        power: 0,
                    }),
                );
                const [tx, ty] = this.worldToPx(this.viewX(fx.x2), this.viewY(fx.y2));
                ctx.globalAlpha = (1 - t) * 0.85;
                ctx.strokeStyle = '#fff2b0';
                ctx.lineWidth = Math.max(1, 2 * sc);
                ctx.lineCap = 'round';
                ctx.beginPath();
                ctx.moveTo(pose.muzzle.x, pose.muzzle.y);
                ctx.lineTo(tx, ty);
                ctx.stroke();
                dot(pose.muzzle.x, pose.muzzle.y, (5 + 3 * (1 - t)) * sc, '#fff3bf', 1 - t);
            } else if (fx.kind === 'launchMuzzle') {
                // Muzzle flash on the barrel's end, then smoke that drifts up and spreads.
                const power = Number(fx.power) || 0,
                    overheat = fx.mode === 'overheat';
                const cannon = { id: fx.cannonId, x: fx.x, y: fx.y, side: fx.side };
                const pose = BuildingArt.pose(
                    this.cannonArtOptions(cannon, {
                        aim: { dx: fx.aimDx, dy: fx.aimDy },
                        fireAgeMs: 0,
                        power,
                    }),
                );
                const { x: smokeX, y: smokeY } = pose.muzzle,
                    { x: dx, y: dy } = pose.muzzleDir;
                const flash = BuildingArt.pose(
                    this.cannonArtOptions(cannon, {
                        aim: { dx: fx.aimDx, dy: fx.aimDy },
                        fireAgeMs: age,
                        power,
                    }),
                );
                const { x: mx, y: my } = flash.muzzle;
                if (!overheat && t < 0.2) {
                    const k = 1 - t / 0.2,
                        len = (46 + 62 * power) * sc * (fx.shot > 0 ? 0.75 : 1),
                        wide =
                            fx.mode === 'shotgun' ? [-0.5, -0.25, 0, 0.25, 0.5] : [-0.22, 0, 0.22];
                    ctx.globalAlpha = k;
                    ctx.lineCap = 'round';
                    for (const [i, spread] of wide.entries()) {
                        const a = Math.atan2(dy, dx) + spread,
                            l = len * (i % 2 ? 0.75 : 1);
                        ctx.strokeStyle = spread === 0 ? '#fff6c8' : '#ffb347';
                        ctx.lineWidth = Math.max(3, (spread === 0 ? 13 : 8) * sc * k);
                        ctx.beginPath();
                        ctx.moveTo(mx, my);
                        ctx.lineTo(mx + Math.cos(a) * l, my + Math.sin(a) * l);
                        ctx.stroke();
                    }
                    dot(mx, my, (26 + 20 * power) * sc * k, '#ffe9a0', 0.55 * k);
                    dot(mx, my, (20 + 14 * power) * sc * k, '#fff3b0', k);
                    dot(mx, my, (11 + 9 * power) * sc * k, '#ff8a2a', 0.9 * k);
                    ring(mx, my, (16 + 60 * (1 - k)) * sc, 3.4 * sc, '#ffd37a', 0.75 * k);
                }
                const smoke = overheat ? '#7a4a44' : '#cfc7b8';
                for (let i = 0; i < (overheat ? 9 : 8); i++) {
                    const h = HashUtil.hash(`${fx.seed}|smoke|${i}`),
                        a = ((h % 4096) / 4096) * Math.PI * 2,
                        spread = 0.35 + ((h >>> 12) % 1000) / 1600;
                    const rise = (26 + 52 * t) * sc * spread,
                        out = (16 + 40 * ease) * sc * spread;
                    dot(
                        smokeX + dx * out * 0.8 + Math.cos(a) * out * 0.6,
                        smokeY + dy * out * 0.8 - rise * 0.5 + Math.sin(a) * out * 0.3,
                        (9 + 15 * ease) * sc * (0.6 + spread * 0.5),
                        smoke,
                        Math.max(0, 0.6 * (1 - t)),
                    );
                }
            } else if (fx.kind === 'launchBundleBreak' && fx.grainType !== 'millet') {
                LaunchImpactArt.drawBurst(ctx, {
                    x,
                    y,
                    ageMs: age,
                    scale: sc,
                    seed: fx.seed,
                    grainType: fx.grainType,
                });
            } else if (fx.kind === 'launchBlast') {
                // Landing: shock ring the size of the blast, dust thrown outward and, near the middle, a hard white flash.
                const radius = Math.max(30, Number(fx.radius) || 100) * sc,
                    peak = Number(fx.peak) || 1,
                    hits = Number(fx.hits) || 0,
                    strong = peak >= 2,
                    yScale = fx.groundRing ? BattlefieldProjection.groundScale : 1;
                if (t < 0.35) {
                    const k = 1 - t / 0.35;
                    dot(
                        x,
                        y,
                        radius * (strong ? 0.24 : 0.18) * (1 - (0.4 * t) / 0.35),
                        strong ? '#ffffff' : '#fff0b8',
                        (strong ? 0.38 : 0.28) * k,
                    );
                }
                ring(
                    x,
                    y,
                    radius * (0.18 + 0.82 * ease),
                    (8 - 5 * t) * sc * (strong ? 1.6 : 1),
                    strong ? '#fff3c8' : '#ffcf6a',
                    0.9 * (1 - t),
                    yScale,
                );
                ring(
                    x,
                    y,
                    radius * (0.1 + 0.55 * ease),
                    2.4 * sc,
                    '#ff9a3a',
                    0.6 * (1 - t),
                    yScale,
                );
                if (strong && t < 0.55)
                    ring(
                        x,
                        y,
                        radius * (0.5 + 1.1 * ease),
                        3 * sc,
                        '#ffffff',
                        0.5 * (1 - t / 0.55),
                    );
                burst(fx, x, y, t, hits > 0 ? 22 : 12, '#a9895c', (radius / sc) * 1.05, 8, 0.62);
                burst(fx, x, y, t, 10, '#e9dcc0', (radius / sc) * 0.8, 5, 0.58, fx.seed ^ 0x51f1);
                if (strong && hits > 0) {
                    if (t < 0.12) {
                        ctx.globalAlpha = 0.05 * (1 - t / 0.12);
                        ctx.fillStyle = '#ffffff';
                        ctx.fillRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);
                    }
                    // The return on a good throw, in numbers: the strongest multiplier any enemy took.
                    ctx.globalAlpha = Math.min(1, (1 - t) * 2);
                    ctx.textAlign = 'center';
                    ctx.textBaseline = 'middle';
                    ctx.font = `900 ${Math.round(Math.max(18, 30 * sc * (1 + 0.25 * Math.min(2, peak - 2))))}px system-ui,sans-serif`;
                    ctx.lineWidth = Math.max(3, 5 * sc);
                    ctx.strokeStyle = 'rgba(60,20,0,.9)';
                    ctx.fillStyle = '#ffe27a';
                    const text = `강타 ×${peak.toFixed(1)}`,
                        ty = y - radius * 0.55 - 26 * sc * ease;
                    ctx.strokeText(text, x, ty);
                    ctx.fillText(text, x, ty);
                }
            }

            ctx.restore();
            this.combatFx[write++] = fx;
        }

        this.combatFx.length = write;
    }

    drawWorldHudOverlay() {
        const ctx = this.fxCtx,
            snap = this.snapshot;
        if (!ctx || !this.fxCanvas || !snap) return;
        const side = this.mySide(),
            sc = this.sc();

        ctx.save();
        ctx.lineCap = 'round';
        ctx.lineJoin = 'round';

        // Single-owner invariant for status bars: building and unit HP are drawn ONLY here,
        // never inside drawBuilding()/drawUnit(). This pass stays above combat VFX so
        // explosions/debris can never cover persistent information.
        for (const b of snap.buildings || []) {
            if (b.alive === false || b.hp >= b.maxHp) continue;
            if (b.side !== side && !this.visibleRaw(b.x, b.y)) continue;
            if (!this.onScreenAuth(b.x, b.y, (BuildingDefinition.get(b.type)?.size || 40) + 100))
                continue;
            const d = BuildingDefinition.get(b.type) || { size: 35 };
            const anchor = RallyGamekit.resolveAnchorInto(
                this.stableCamera(),
                {
                    space: 'world',
                    x: this.viewX(b.x),
                    y: this.viewY(b.y),
                    z: this.world.terrain.surfaces.heightAt(b.x, b.y),
                },
                {},
            );
            const { x, y } = anchor,
                r = d.size * sc;
            const ratio = RangeUtil.clamp((b.hp || 0) / Math.max(1, b.maxHp || 1), 0, 1);
            const bw = r * 2,
                bh = Math.max(2.4, 3.2 * sc),
                by = y + r + 3 * sc;
            ctx.fillStyle = 'rgba(18,24,28,.72)';
            ctx.fillRect(x - r - 1 * sc, by - 1 * sc, bw + 2 * sc, bh + 2 * sc);
            ctx.fillStyle = ratio > 0.48 ? '#62c775' : '#f04d49';
            ctx.fillRect(x - r, by, bw * ratio, bh);
        }

        for (const u of snap.units || []) {
            const maxHp = Math.max(1, Number(u.maxHp) || 1);
            if (!u.alive || (Number(u.hp) || 0) >= maxHp) continue;
            if (u.side !== side && !this.visibleRaw(u.x, u.y)) continue;
            if (!this.onScreenAuth(u.x, u.y, (UnitDefinition.get(u.type)?.size || 15) + 100))
                continue;
            const projected = this.projectRenderWorldPosition(
                this.resolveRenderWorldPosition(u, 'unit'),
            );
            const r = this.unitRenderRadius(u),
                bw = r * 2.2,
                bh = Math.max(2.2, 3.2 * sc),
                x = projected.x,
                y = projected.y - r * 1.58;
            const ratio = RangeUtil.clamp((Number(u.hp) || 0) / maxHp, 0, 1);
            ctx.fillStyle = 'rgba(7,10,12,.72)';
            ctx.fillRect(x - bw / 2 - 1 * sc, y - 1 * sc, bw + 2 * sc, bh + 2 * sc);
            ctx.fillStyle = ratio > 0.48 ? '#6fdf63' : '#f34d47';
            ctx.fillRect(x - bw / 2, y, bw * ratio, bh);
        }

        ctx.restore();
    }
    drawSelectedBuildingOverlay() {
        const ctx = this.fxCtx,
            snap = this.snapshot,
            id = this.selectedBuildingId;
        if (!ctx || !snap || !id) return;
        const side = this.mySide(),
            b = (snap.buildings || []).find(
                (x) => x.id === id && x.alive !== false && x.side === side,
            );
        if (!b || !this.onScreenAuth(b.x, b.y, (BuildingDefinition.get(b.type)?.size || 40) + 100))
            return;
        const sc = this.sc(),
            [x, y] = this.worldToPx(this.viewX(b.x), this.viewY(b.y));
        const r = (BuildingDefinition.get(b.type)?.size || 35) * sc * 1.06,
            m = Math.max(4, 8 * sc),
            lw = Math.max(1.8, 2.8 * sc);
        ctx.save();
        ctx.globalAlpha = 0.98;
        ctx.strokeStyle = '#ffd75f';
        ctx.lineWidth = lw;
        ctx.lineCap = 'round';
        ctx.beginPath();
        ctx.moveTo(x - r, y - r + m);
        ctx.lineTo(x - r, y - r);
        ctx.lineTo(x - r + m, y - r);
        ctx.moveTo(x + r - m, y - r);
        ctx.lineTo(x + r, y - r);
        ctx.lineTo(x + r, y - r + m);
        ctx.moveTo(x - r, y + r - m);
        ctx.lineTo(x - r, y + r);
        ctx.lineTo(x - r + m, y + r);
        ctx.moveTo(x + r - m, y + r);
        ctx.lineTo(x + r, y + r);
        ctx.lineTo(x + r, y + r - m);
        ctx.stroke();
        ctx.restore();
    }

    drawFloatingFx() {
        const ctx = this.fxCtx;
        if (!ctx || !this.fxCanvas) return;

        ctx.clearRect(0, 0, this.fxCanvas.width, this.fxCanvas.height);

        // Stable presentation order. It never changes with unit count:
        // world annotations -> decorative combat VFX -> persistent world HUD -> numbers -> status/selection.
        if (!this.showcase) this.drawStrategicLabels();

        // Decorative presentation is always below information overlays.
        this.drawClientCombatFx();

        // Persistent information is never hidden by combat density.
        this.drawWorldHudOverlay();

        let write = 0;

        for (let read = 0; read < this.floatFx.length; read++) {
            const f = this.floatFx[read],
                age = f.clock.ageMs,
                preset = FloatingTextPresentationDefinition.get(f.kind);
            const life = preset.lifeMs;
            if (f.clock.expired || age >= life) {
                this.floatFxPool.release(f);
                continue;
            }

            const t = age / life;
            const viewX = this.viewX(f.x),
                viewY = this.viewY(f.y);
            let [x, y] = this.worldToPx(viewX, viewY);

            // Combat numbers are a subordinate information layer. Low alpha means dense
            // overlaps naturally become more legible/darker without explicit aggregation.
            x += f.jitter * this.sc();
            y -= (14 + (f.lane || 0) * 7 + preset.rise * t) * this.sc();

            if (
                x < -100 ||
                x > this.fxCanvas.width + 100 ||
                y < -100 ||
                y > this.fxCanvas.height + 100
            ) {
                this.floatFx[write++] = f;
                continue;
            }

            const fade = (t < 0.62 ? 1 : Math.max(0, 1 - (t - 0.62) / 0.38)) * preset.alpha;
            const pop =
                t < 0.12 ? 0.9 + (t / 0.12) * (preset.pop - 0.9) : preset.pop - (t - 0.12) * 0.04;
            const fontSize = Math.max(preset.minSize, preset.baseSize * this.sc() * pop);

            let fill = '#d7e9ff',
                stroke = '#1a3d64';
            if (f.kind === 'damageTaken') {
                fill = '#ff6b6b';
                stroke = '#4b0909';
            } else if (f.kind === 'damageDealt') {
                fill = '#fff0c2';
                stroke = '#6d2c12';
            }

            ctx.save();
            ctx.font = `800 ${fontSize}px system-ui,-apple-system,"Segoe UI",sans-serif`;
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.lineJoin = 'round';
            ctx.lineWidth = Math.max(1, 2 * this.sc());
            ctx.globalAlpha = fade * preset.strokeAlpha;
            ctx.strokeStyle = stroke;
            ctx.strokeText(f.text, x, y);
            ctx.globalAlpha = fade;
            ctx.fillStyle = fill;
            ctx.fillText(f.text, x, y);
            ctx.restore();

            this.floatFx[write++] = f;
        }

        this.floatFx.length = write;

        // Keep selection and the current firing order readable over explosions.
        if (!this.showcase) {
            this.drawSelectedBuildingOverlay();
            this.drawLaunchAimOrder();
        }
    }

    drawLaunchAimOrder() {
        if (!this.launchAimOrder?.length) return;
        const ctx = this.fxCtx,
            ratio = this.fxCanvas.width / Math.max(1, this.canvas.clientWidth);
        ctx.save();
        ctx.font = `800 ${12 * ratio}px system-ui,sans-serif`;
        ctx.textAlign = 'center';
        ctx.textBaseline = 'middle';
        ctx.lineJoin = 'round';
        for (const { label, x, y, dx, dy } of this.launchAimOrder) {
            const pad = ctx.measureText(label).width / 2 + 4 * ratio,
                labelX = RangeUtil.clamp(x + dx * 13 * ratio, pad, this.fxCanvas.width - pad),
                labelY = RangeUtil.clamp(
                    y + dy * 13 * ratio,
                    10 * ratio,
                    this.fxCanvas.height - 10 * ratio,
                );
            ctx.strokeStyle = '#332216';
            ctx.lineWidth = 4 * ratio;
            ctx.beginPath();
            ctx.moveTo(x, y);
            ctx.lineTo(x + dx * 5 * ratio, y + dy * 5 * ratio);
            ctx.stroke();
            ctx.strokeText(label, labelX, labelY);
            ctx.fillStyle = '#fff5d5';
            ctx.fillText(label, labelX, labelY);
        }
        ctx.restore();
    }

    replayVisionSides() {
        if (this.replayVisionMode === 'union') return [0, 1];
        if (this.replayVisionMode === 'guest') return [1];
        if (this.replayVisionMode === 'host') return [0];
        return [this.mySide()];
    }
    visibleRaw(x, y) {
        if (this.replayObserverAll) return true;
        if (!this.snapshot) return false;
        const targetLevel = this.world.terrain.surfaces.levelAt(x, y);
        for (const side of this.replayVisionSides())
            if (this.visionFields[side]?.visibleAt(x, y, targetLevel)) return true;
        return false;
    }
    eventVisible(event) {
        if (event.side === this.mySide() || this.replayObserverAll) return true;
        if (!this.visibleRaw(event.x, event.y)) return false;
        return (
            !event.presentationVisible ||
            this.replayVisionSides().some((side) => event.presentationVisible[side])
        );
    }

    drawStrategicMap() {
        if (!this.snapshot) return;
        const sc = this.sc();
        const laneDefs = [
            { id: 'top', col: [0.35, 0.62, 0.9, 0.13] },
            { id: 'mid', col: [0.94, 0.76, 0.28, 0.15] },
            { id: 'bot', col: [0.48, 0.78, 0.42, 0.13] },
        ];

        const mapDesc = this.snapshot.mapDescriptor || null;
        const lanePoints = mapDesc?.laneControlPoints || LANE_CONTROL_POINTS;
        for (const lane of laneDefs) {
            const pts = lanePoints[lane.id].map((p) =>
                this.worldToPx(this.viewX(p.x), this.viewY(p.y)),
            );
            for (let i = 0; i < pts.length - 1; i++) {
                this.line(
                    pts[i][0],
                    pts[i][1],
                    pts[i + 1][0],
                    pts[i + 1][1],
                    Math.max(26, 58 * sc),
                    lane.col,
                );
            }
        }

        for (const cp of this.snapshot.capturePoints || []) {
            const base =
                cp.owner != null
                    ? this.factionColor(cp.owner, { alpha: 0.18 })
                    : cp.enabled
                      ? [0.95, 0.73, 0.25, 0.16]
                      : [0.42, 0.47, 0.5, 0.1];

            this.drawGroundCircle(cp.x, cp.y, CAPTURE_RADIUS, { fill: base });
            this.drawGroundCircle(cp.x, cp.y, 38, {
                fill:
                    cp.owner != null
                        ? this.factionColor(cp.owner, { alpha: 0.55 })
                        : cp.enabled
                          ? [1, 0.78, 0.25, 0.48]
                          : [0.55, 0.58, 0.6, 0.32],
                segments: 16,
            });

            const outpost = (this.snapshot.buildings || []).find(
                (b) => b.id === cp.outpostId && b.alive !== false,
            );
            if (
                outpost?.construction &&
                (this.isFriendlySide(outpost.side) || this.visibleRaw(outpost.x, outpost.y))
            ) {
                const ratio = ConstructionRules.progress(outpost.construction);
                this.drawGroundCircle(cp.x, cp.y, 30, {
                    fill: this.factionColor(outpost.side, { alpha: 0.18 + ratio * 0.35 }),
                    segments: 16,
                });
            }
        }
    }
    drawGroundGrid() {
        // The underlay grid belongs to the level-zero world plane. Its height and
        // phase must never come from terrain sampled at a moving viewport edge.
        const step = 220,
            topLeft = this.projectedCoordinatesAtScreen(0, 0),
            bottomRight = this.projectedCoordinatesAtScreen(this.canvas.width, this.canvas.height),
            topY = BattlefieldProjection.viewYFromPlane(topLeft.y),
            bottomY = BattlefieldProjection.viewYFromPlane(bottomRight.y),
            guest = this.orientationRole() === 'guest',
            phaseX = guest ? this.world.width % step : 0,
            phaseY = guest ? this.world.height % step : 0,
            point = (x, z) =>
                this.projectRenderWorldPosition({
                    x: this.viewX(x),
                    y: 0,
                    z: this.viewY(z),
                    groundY: 0,
                });
        for (
            let y = Math.floor((topY - phaseY) / step) * step + phaseY;
            y <= bottomY + step;
            y += step
        ) {
            const a = point(topLeft.x, y),
                b = point(bottomRight.x, y);
            this.line(a.x, a.y, b.x, b.y, 1, [1, 1, 1, 0.035]);
        }
        for (
            let x = Math.floor((topLeft.x - phaseX) / step) * step + phaseX;
            x <= bottomRight.x + step;
            x += step
        ) {
            const a = point(x, topY),
                b = point(x, bottomY);
            this.line(a.x, a.y, b.x, b.y, 1, [1, 1, 1, 0.03]);
        }
    }
    drawGround() {
        const sc = this.sc(),
            vw = this.viewWorldW(),
            vh = this.viewWorldH(),
            ox = (this.canvas.width - vw * sc) / 2;

        // Brighter low-detail grass base: clean enough for tiny units to read.
        this.rect(
            0,
            0,
            this.canvas.width,
            this.canvas.height,
            TerrainPresentation.colors.lowGround,
        );

        // 자연스러운 큰 지면 색 덩어리
        for (const b of [
            { x: 520, y: 3520, r: 500, c: [0.55, 0.67, 0.53, 0.52] },
            { x: 970, y: 1350, r: 470, c: [0.61, 0.72, 0.57, 0.48] },
            { x: 1810, y: 2070, r: 560, c: [0.69, 0.75, 0.6, 0.4] },
            { x: 2710, y: 3100, r: 520, c: [0.58, 0.69, 0.54, 0.48] },
            { x: 3020, y: 820, r: 450, c: [0.65, 0.72, 0.58, 0.4] },
        ]) {
            this.drawGroundCircle(b.x, b.y, b.r, { fill: b.c, elevation: 0, segments: 28 });
        }

        this.drawGroundGrid();

        // TOP / MID / BOT 길은 밝은 흙길 느낌. 절차맵 descriptor를 그대로 사용한다.
        const mapDesc = this.snapshot?.mapDescriptor || null;
        const groundLanePoints = mapDesc?.laneControlPoints || LANE_CONTROL_POINTS;
        for (const lane of mapDesc?.terrain?.roads?.length
            ? []
            : [
                  { id: 'top', col: [0.88, 0.84, 0.67, 0.24] },
                  { id: 'mid', col: [0.91, 0.86, 0.69, 0.23] },
                  { id: 'bot', col: [0.87, 0.83, 0.66, 0.24] },
              ]) {
            const pts = groundLanePoints[lane.id].map((p) =>
                this.worldToPx(this.viewX(p.x), this.viewY(p.y)),
            );
            for (let i = 0; i < pts.length - 1; i++) {
                this.line(
                    pts[i][0],
                    pts[i][1],
                    pts[i + 1][0],
                    pts[i + 1][1],
                    Math.max(38, 96 * sc),
                    lane.col,
                );
            }
        }

        const terrain = MapGeneration.mapTerrainDescriptor(mapDesc);
        // renderGroundPass owns depth writes here; avoid GPU state readbacks between batches.
        TerrainPresentation.drawWorld(this, terrain, true);
        TerrainPresentation.drawRiverSurfaces(this, mapDesc, true);
        TerrainPresentation.drawBridges(this, true);
    }
    drawConstructionScaffold(building) {
        const radius = BuildingDefinition.get(building.type).size,
            dirs = this.geometryTemplates.outlineCircle(6),
            points = [];
        const sc = this.sc(),
            wobble = this.constructionWobble(this.constructionImpact(building));
        for (let i = 0; i < 6; i++) {
            const point = this.worldToPx(
                this.viewX(building.x + dirs[i * 2] * radius),
                this.viewY(building.y + dirs[i * 2 + 1] * radius),
            );
            point[0] += wobble;
            points.push(point);
        }
        this.poly(points, [0.51, 0.36, 0.18, 0.18]);
        for (let i = 0; i < 6; i++) {
            const a = points[i],
                b = points[(i + 1) % 6];
            this.line(a[0], a[1], b[0], b[1], Math.max(1.5, 5 * sc), [0.57, 0.39, 0.19, 1]);
            this.line(
                a[0],
                a[1] - Math.max(2, 7 * sc),
                a[0],
                a[1] + 2 * sc,
                Math.max(1.5, 3 * sc),
                [0.81, 0.64, 0.35, 1],
            );
        }
    }
    drawBuilding(b) {
        if (BuildingDefinition.get(b.type)?.isTerrainBarrier)
            return TerrainPresentation.drawBarrier(this, b);
        const own = this.isFriendlySide(b.side);
        if (!own && !this.visibleRaw(b.x, b.y)) return;
        const [x, groundY] = this.worldToPx(this.viewX(b.x), this.viewY(b.y)),
            sc = this.sc(),
            d = BuildingDefinition.get(b.type),
            y = groundY - 10 * sc;
        const buildingVisual = BUILDING_VISUAL_RENDER_FNS[d.visualCategory];
        if (!buildingVisual) throw new Error(`Missing building visual renderer for ${b.type}`);
        if (b.construction) this.drawConstructionScaffold(b);
        buildingVisual(this, { b });
        // The art owns its base and flag. Selection follows the visual footprint, never the collision radius.
        const r = 40 * sc;
        if (own && this.selectedBuildingId === b.id) {
            this.drawGroundCircle(b.x, b.y, 40 * 1.28, {
                fill: [0.25, 0.88, 0.57, 0.18],
                segments: 24,
            });
            // 네 귀퉁이 선택 마커
            const m = Math.max(3, 7 * sc),
                lw = Math.max(1.5, 2.5 * sc),
                ec = [0.34, 1, 0.68, 0.95];
            this.line(x - r, y - r, x - r + m, y - r, lw, ec);
            this.line(x - r, y - r, x - r, y - r + m, lw, ec);
            this.line(x + r, y - r, x + r - m, y - r, lw, ec);
            this.line(x + r, y - r, x + r, y - r + m, lw, ec);
            this.line(x - r, y + r, x - r + m, y + r, lw, ec);
            this.line(x - r, y + r, x - r, y + r - m, lw, ec);
            this.line(x + r, y + r, x + r - m, y + r, lw, ec);
            this.line(x + r, y + r, x + r, y + r - m, lw, ec);
        }
    }
    // Identity comes from species silhouette, appendages, equipment and VFX.

    unitRenderVisualScale(u) {
        return UnitVisualDefinition.get(u?.type)?.visualScale ?? 1.08;
    }
    unitRenderRadius(u) {
        const size = UnitDefinition.get(u?.type)?.size || UnitDefinition.get('rice').size;
        return size * UNIT_RENDER_RADIUS_SCALE * this.unitRenderVisualScale(u) * this.sc();
    }

    hasGrainArt(u) {
        return !!this.spriteRenderers[u?.type] || !!window.RallyVectorAssets?.[u?.type];
    }
    launchAmmoRecord(type) {
        if (!LaunchRules.grain(type)) return null;
        const key = 'ammo|' + type;
        let record = this.vectorUnitAssetCache.get(key);
        if (record) return record;
        if (GRAIN_SPRITES[type]?.cannonAmmo) {
            record = { heroAmmo: this.spriteRenderers[type] };
            this.vectorUnitAssetCache.set(key, record);
            return record;
        }
        if (type === 'acorn') {
            record = { acornAmmo: true };
            this.vectorUnitAssetCache.set(key, record);
            return record;
        }
        if (type === 'corn') {
            record = { cornCone: true };
            this.vectorUnitAssetCache.set(key, record);
            return record;
        }
        if (type === 'popcorn') {
            record = { popcornAmmo: true };
            this.vectorUnitAssetCache.set(key, record);
            return record;
        }
        if (type === 'millet') {
            record = { milletEar: true };
            this.vectorUnitAssetCache.set(key, record);
            return record;
        }
        if (type === 'chestnut') {
            record = { sprite: this.spriteRenderers.chestnut };
            this.vectorUnitAssetCache.set(key, record);
            return record;
        }
        const source = window.RallyVectorAssets?.['ammo-' + type];
        if (!source) return null;
        const actor = RallyGamekit.createVectorActor(this.vectorContext, source, {
            clip: 'idle',
            startedAtMs: 0,
        });
        actor.setExpression('default').seek(0);
        record = { actor, compiled: source };
        this.vectorUnitAssetCache.set(key, record);
        return record;
    }
    // Draws a 256-canvas asset centred at (x,y), rotated and scaled, between frame batches.
    drawVectorBillboard(
        record,
        x,
        y,
        angle,
        scale,
        { scaleX = 1, scaleY = 1, depthTest = false } = {},
    ) {
        if (this.frame.length) {
            this.flushVectorMesh('frame-to-vector-switch');
            this.flush(this.frame, true);
            this.begin();
        }
        const actualAngle = record.milletEar
                ? angle + 0.6
                : record.acornAmmo || record.cornCone
                  ? angle + Math.PI / 4
                  : angle,
            centered =
                record.acornAmmo ||
                record.cornCone ||
                record.milletEar ||
                record.popcornAmmo ||
                record.heroAmmo,
            actualScale = centered ? scale * 200 : scale,
            cos = Math.cos(actualAngle) * actualScale,
            sin = Math.sin(actualAngle) * actualScale,
            m = this._vectorUnitMatrix;
        if (record.sprite) {
            m[0] = cos * scaleX * 256;
            m[1] = sin * scaleX * 256;
            m[2] = -sin * scaleY * 256;
            m[3] = cos * scaleY * 256;
            m[4] = x;
            m[5] = y;
            this.vectorContext.depthTest = depthTest;
            this.vectorContext.depthWrite = false;
            record.sprite.drawBurr(m, this._renderDepth ?? 0);
            this.flushVectorMesh('burr-billboard');
            return;
        }
        m[0] = cos * scaleX;
        m[1] = sin * scaleX;
        m[2] = -sin * scaleY;
        m[3] = cos * scaleY;
        m[4] = centered ? x : x - m[0] * 128 - m[2] * 128;
        m[5] = centered ? y : y - m[1] * 128 - m[3] * 128;
        if (centered) {
            this.vectorContext.depthTest = depthTest;
            this.vectorContext.depthWrite = false;
            if (record.acornAmmo) this.spriteRenderers.acorn.drawAmmo(m, this._renderDepth ?? 0);
            else if (record.cornCone) this.spriteRenderers.corn.drawCone(m, this._renderDepth ?? 0);
            else if (record.popcornAmmo)
                this.spriteRenderers.popcorn.drawAmmo(m, this._renderDepth ?? 0);
            else if (record.heroAmmo) record.heroAmmo.drawAmmo(m, this._renderDepth ?? 0);
            else this.spriteRenderers.millet.drawEar(m, this._renderDepth ?? 0);
            return;
        }
        this.vectorContext.drawVectorActor(record.actor, {
            matrix: m,
            alpha: 1,
            depth: this._renderDepth ?? 0,
            depthTest,
            depthWrite: false,
        });
        this.flushVectorMesh('vector-billboard');
    }
    landingBundlePose(fx) {
        const age = fx.clock.ageMs;
        if (age < 0) return { visible: false };
        const pending = this.renderState.model(
            'bundle',
            fx.id.slice(7),
            this.presentationNow(),
        )?.entity;
        const pose = LaunchImpactArt.bundlePose(pending ? Math.min(age, 150) : age);
        if (pending) {
            const remaining = (pending.count - pending.index) / pending.count;
            pose.scaleX *= 0.5 + 0.5 * remaining;
            pose.scaleY *= 0.5 + 0.5 * remaining;
        }
        return pose;
    }
    drawLandingBundle(fx) {
        const pose = this.landingBundlePose(fx);
        if (!pose.visible) return;
        const record = this.launchAmmoRecord(fx.grainType);
        if (!record) return;
        const pending = this.renderState.model(
            'bundle',
            fx.id.slice(7),
            this.presentationNow(),
        )?.entity;
        const ground = this.world.terrain.surfaces.heightAt(fx.x, fx.y),
            height = pending
                ? ground + (Number(pending.heightFP) || 0) / 100
                : Number.isFinite(fx.impactHeightFP)
                  ? fx.impactHeightFP / 100
                  : ground;
        const [x, y] = this.worldToPx(this.viewX(fx.x), this.viewY(fx.y), height),
            flip = this.orientationRole() === 'guest' ? Math.PI : 0;
        this.drawVectorBillboard(
            record,
            x,
            y,
            (fx.angle || 0) + flip + pose.rotation,
            (58 * this.sc()) / 200,
            { scaleX: pose.scaleX, scaleY: pose.scaleY, depthTest: true },
        );
    }
    grainUnitRecord(type) {
        const key = 'grain|' + type;
        let record = this.vectorUnitAssetCache.get(key);
        if (record) return record;
        const sprites = this.spriteRenderers[type];
        if (sprites) {
            record = { compiled: sprites, ground: [0, GRAIN_SPRITES[type].groundY], sprite: true };
            this.vectorUnitAssetCache.set(key, record);
            return record;
        }
        const source = window.RallyVectorAssets?.[type];
        if (!source) return null;
        const sockets = source.metadata.sockets,
            point = (id) => {
                const s = sockets[id];
                if (!s) throw new Error(`Grain body is missing socket ${id}`);
                return s.point;
            };
        record = { compiled: source, ground: point('ground') };
        this.vectorUnitAssetCache.set(key, record);
        return record;
    }
    // Poses every visible grain before any is drawn, so the context evaluates them in one pass
    // (budmori farm-renderer does the same). Entries arrive far to near; each grain's depth is its
    // world depth pulled nearer by its rank, so equal world depths still keep painter order.
    constructionWorkPose(unit, renderTick) {
        const work = unit?.constructionWork,
            target =
                work &&
                (this.snapshot.buildings || []).find(
                    (b) => b.id === work.targetId && b.alive !== false,
                );
        if (!target) return null;
        const phase = work.phase,
            progress = RangeUtil.clamp(
                (renderTick - work.phaseStartedAtTick) /
                    Math.max(
                        1,
                        (work.phaseEndsAtTick ?? work.phaseStartedAtTick) - work.phaseStartedAtTick,
                    ),
                0,
                1,
            );
        const to = this.worldToPx(this.viewX(target.x), this.viewY(target.y)),
            at = this.projectEntityScreen(unit, 'unit');
        const dx = to[0] - at.x,
            dy = to[1] - at.y,
            distance = Math.hypot(dx, dy) || 1,
            facing = dx < 0 ? -1 : 1;
        const active = phase === 'prepare' || phase === 'strike' || phase === 'recover';
        const lean =
            phase === 'prepare'
                ? -0.16 * progress
                : phase === 'strike'
                  ? -0.16 + 0.42 * progress
                  : phase === 'recover'
                    ? 0.26 * (1 - progress)
                    : 0;
        const squash =
            phase === 'prepare'
                ? 0.08 * progress
                : phase === 'strike'
                  ? 0.08 + 0.04 * progress
                  : phase === 'recover'
                    ? 0.12 * (1 - progress)
                    : 0;
        // Align the artwork with the collision silhouette only at confirmed contact.
        const contactInset =
            phase === 'recover' && work.lastHitTick != null
                ? this.unitRenderRadius(unit) * 0.2 * (1 - progress)
                : 0;
        return {
            phase,
            progress,
            active,
            facing,
            rotation: lean * facing,
            scaleX: 1 + squash,
            scaleY: 1 - squash,
            offsetX: (dx / distance) * contactInset,
            offsetY: (dy / distance) * contactInset,
            clip: active ? (phase === 'strike' || phase === 'recover' ? 'walk' : 'idle') : null,
        };
    }
    prepareGrainPoses(entries) {
        this.grainActorFrame++;
        const wallNow = performance.now();
        this.grainActorNow = wallNow;
        const now = this.presentationNow(wallNow);
        let rank = 0;
        for (const { kind, entity: u, world, depth } of entries) {
            if (kind !== 'unit' || !this.hasGrainArt(u)) continue;
            const record = this.grainUnitRecord(u.type);
            if (!record) continue;
            const grain = this.grainActor(u, record),
                actor = grain.actor,
                delta = this.renderTrackedDelta(u, 'unit'),
                moving = Math.hypot(delta.x, delta.y) > 0.01;
            const model = this.renderState.model('unit', u.id, now),
                entity = model?.entity || u,
                renderTick = model?.tick ?? this.snapshot.tick,
                grounded = UnitMotion.isGrounded(entity),
                impact = LaunchImpactArt.unitPose(entity, renderTick, this.snapshot.tps || SIM_TPS);
            const work = impact.active ? null : this.constructionWorkPose(entity, renderTick);
            let clip = !grounded
                    ? 'idle'
                    : work?.clip ||
                      (u.attackFlash > 0
                          ? 'fire'
                          : impact.active
                            ? 'idle'
                            : u.hitFlash > 0
                              ? 'hit'
                              : moving
                                ? 'walk'
                                : 'idle'),
                restart = false;
            if (record.sprite) {
                const chestnut = record.compiled === this.spriteRenderers.chestnut,
                    attack = !!(chestnut ? entity.attackFlash : u.attackFlash),
                    hit = !!(chestnut ? entity.hitFlash : u.hitFlash),
                    attackStarted = attack && !grain.attackLatch,
                    hitStarted = hit && !grain.hitLatch;
                if (attackStarted) grain.attackUntil = now + 425;
                if (hitStarted) grain.hitUntil = now + 295;
                grain.attackLatch = attack;
                grain.hitLatch = hit;
                clip = !grounded
                    ? 'idle'
                    : work?.active
                      ? work.clip
                      : grain.attackUntil > now
                        ? 'fire'
                        : impact.active
                          ? 'idle'
                          : grain.hitUntil > now
                            ? 'hit'
                            : moving
                              ? 'walk'
                              : 'idle';
                restart = clip === 'fire' ? attackStarted : clip === 'hit' && hitStarted;
            }
            let cornElapsed = null;
            grain.holdsKernel = false;
            if (record.compiled === this.spriteRenderers.corn && !impact.active && !work?.active) {
                const combat = entity.combat || u.combat || {},
                    start = Number(combat.attackWindupStartedAt),
                    end = Number(combat.attackWindupUntil),
                    launch = combat.lobLaunchTick == null ? null : Number(combat.lobLaunchTick),
                    tps = this.snapshot.tps || SIM_TPS;
                if (end > 0 && end > start && renderTick < end) {
                    cornElapsed = 620 * RangeUtil.clamp((renderTick - start) / (end - start), 0, 1);
                    grain.holdsKernel = true;
                } else if (Number.isFinite(launch)) {
                    // The projectile's first physical step runs during
                    // (lobLaunchTick - 1, lobLaunchTick], so release is at its start.
                    const ageMs = ((renderTick - (launch - 1)) * 1000) / tps;
                    if (ageMs >= -1000 / tps && ageMs < 330) {
                        cornElapsed = 620 + Math.max(0, ageMs);
                        grain.holdsKernel = ageMs < 0;
                    }
                }
                // Corn's throw is anchored to authority windup/release, not the
                // generic melee attackFlash latch (which would restart it later).
                clip =
                    cornElapsed != null
                        ? 'fire'
                        : grain.hitUntil > now
                          ? 'hit'
                          : moving
                            ? 'walk'
                            : 'idle';
                if (cornElapsed != null && entity.target) {
                    const target =
                        this.renderState.model('unit', entity.target, now)?.entity ||
                        (this.snapshot.buildings || []).find((b) => b.id === entity.target);
                    if (target && Number.isFinite(Number(target.x))) {
                        const worldDirection = Number(target.x) < Number(entity.x) ? -1 : 1;
                        grain.cornFacing =
                            this.orientationRole() === 'guest' ? -worldDirection : worldDirection;
                    }
                }
            }
            let chestnutFireMs = null,
                chestnutFacing = 1;
            if (
                record.compiled === this.spriteRenderers.chestnut &&
                !impact.active &&
                !work?.active &&
                !entity.hitFlash
            ) {
                const combat = entity.combat || {},
                    start = Number(combat.attackWindupStartedAt) || 0,
                    end = Number(combat.attackWindupUntil) || 0,
                    launch = Number(combat.thornLaunchTick) || 0,
                    sinceLaunch = ((renderTick - launch) * 1000) / (this.snapshot.tps || SIM_TPS);
                if (end > start && renderTick >= start && renderTick <= end) {
                    chestnutFireMs =
                        Math.max(0, Math.min(1, (renderTick - start) / (end - start))) * 550;
                } else if (
                    launch &&
                    sinceLaunch >= -1000 / (this.snapshot.tps || SIM_TPS) &&
                    sinceLaunch < 850
                ) {
                    chestnutFireMs = 550 + Math.max(0, sinceLaunch);
                }
                if (chestnutFireMs !== null) {
                    clip = 'fire';
                    const target =
                        this.renderState.entity('unit', entity.target) ||
                        (this.snapshot.buildings || []).find((b) => b.id === entity.target);
                    const aimX = end > start && target ? target.x : combat.thornAimX;
                    if (Number.isFinite(aimX))
                        chestnutFacing = this.viewX(aimX) < this.viewX(entity.x) ? -1 : 1;
                }
            }
            let milletFireMs = null,
                milletFacing = 1;
            if (
                record.compiled === this.spriteRenderers.millet &&
                !impact.active &&
                !work?.active &&
                !entity.hitFlash
            ) {
                const combat = entity.combat || {},
                    start = Number(combat.attackWindupStartedAt) || 0,
                    end = Number(combat.attackWindupUntil) || 0,
                    hitTick = Number(combat.contactHitTick) || 0,
                    ageMs = ((renderTick - hitTick) * 1000) / (this.snapshot.tps || SIM_TPS);
                if (entity.contactAttack?.phase === 'charge') milletFireMs = 750;
                else if (end > start && renderTick >= start && renderTick <= end)
                    milletFireMs =
                        300 * RangeUtil.clamp((renderTick - start) / (end - start), 0, 1);
                else if (hitTick && ageMs >= 0 && ageMs < 600) milletFireMs = 900 + ageMs;
                if (milletFireMs !== null) {
                    clip = 'fire';
                    const target =
                        this.renderState.entity('unit', entity.target) ||
                        (this.snapshot.buildings || []).find((b) => b.id === entity.target);
                    const aimX =
                        target?.x ??
                        (Number.isFinite(entity.contactAttack?.retreatX)
                            ? 2 * entity.x - entity.contactAttack.retreatX
                            : entity.x + 1);
                    const worldDirection = aimX < entity.x ? -1 : 1;
                    milletFacing =
                        this.orientationRole() === 'guest' ? -worldDirection : worldDirection;
                }
            }
            const spin = entity.spinAttack,
                roll =
                    record.compiled === this.spriteRenderers.watermelon && grounded
                        ? entity.heroRoll
                        : null;
            const rollProgress = roll?.phase ? watermelonRollProgress(roll, renderTick) : 0;
            const selfDestruct =
                entity.selfDestruct?.phase === 'windup' ? entity.selfDestruct : null;
            const sprite = GRAIN_SPRITES[u.type];
            const heroBasic =
                sprite?.heroBasic && grounded && !impact.active && !work?.active
                    ? heroBasicAttackElapsedMs(
                          entity.combat,
                          renderTick,
                          this.snapshot.tps || SIM_TPS,
                      )
                    : null;
            const fruit = sprite?.fruitAttack ? entity.fruitAttack : null;
            const active = fruit?.active;
            const tps = this.snapshot.tps || SIM_TPS;
            const barrageShot = fruit?.projectiles.findLast(
                (shot) =>
                    shot.kind === 'berry' && shot.mode === 'active' && shot.startTick <= renderTick,
            );
            let fruitSkillElapsed = barrageShot
                ? heroBasicAttackElapsedMs(
                      { basicAttackTick: barrageShot.startTick },
                      renderTick,
                      tps,
                  )
                : null;
            if (heroBasic != null || active || fruitSkillElapsed != null) {
                const targetId = entity.combat?.attackWindupTargetId ?? entity.target;
                const target =
                    targetId &&
                    (this.renderState.model('unit', targetId, now)?.entity ||
                        this.snapshot.buildings.find((entry) => entry.id === targetId));
                const aimX =
                    active?.shot?.to.x ?? active?.impacts?.[0]?.x ?? barrageShot?.to.x ?? target?.x;
                if (Number.isFinite(aimX))
                    grain.heroFacing = this.viewX(aimX) < this.viewX(entity.x) ? -1 : 1;
            }
            if (sprite?.heroBasic && clip === 'fire' && heroBasic == null)
                clip = moving ? 'walk' : 'idle';
            if (heroBasic != null || active || fruitSkillElapsed != null) clip = 'fire';
            if (sprite?.fruitAttack) {
                actor.weaponAway = fruitShotsAt(fruit, renderTick).some(
                    (shot) => shot.kind === 'boomerang',
                );
                const activeSpec = UnitDefinition.get(u.type).fruitAttack.active;
                if (active?.shot || (active && active.strike === 0)) {
                    const releaseTick = active.shot?.startTick ?? active.nextTick;
                    const windupStart = active.shot
                        ? releaseTick - SimulationTiming.msToTicks(activeSpec.windupMs, tps)
                        : active.startTick;
                    fruitSkillElapsed =
                        renderTick < releaseTick
                            ? HERO_BASIC_STRIKE_MS *
                              RangeUtil.clamp(
                                  (renderTick - windupStart) /
                                      Math.max(1, releaseTick - windupStart),
                                  0,
                                  1,
                              )
                            : HERO_BASIC_STRIKE_MS + ((renderTick - releaseTick) * 1000) / tps;
                }
            }
            if (selfDestruct) clip = 'windup';
            if (spin) clip = 'spin';
            if (roll?.phase) clip = 'roll';
            if (
                actor.currentClip !== clip ||
                (restart && record.sprite && (clip === 'fire' || clip === 'hit'))
            )
                actor.play(clip, 0);
            if (roll?.phase) {
                actor.rollTuck = watermelonRollTuck(roll.phase, rollProgress);
                actor.seekElapsed(0);
            } else if (spin) {
                const windupTicks = Math.max(1, spin.activeStartTick - spin.startTick);
                const activeTicks = Math.max(1, spin.activeEndTick - spin.activeStartTick);
                const recoveryTicks = Math.max(1, spin.endTick - spin.activeEndTick);
                const elapsed = Math.max(0, renderTick - spin.startTick);
                // Align all authored clip phases to their simulation intervals.
                actor.seekElapsed(
                    elapsed < windupTicks
                        ? (elapsed / windupTicks) * 1000
                        : elapsed < windupTicks + activeTicks
                          ? 1000 + ((elapsed - windupTicks) / activeTicks) * 2000
                          : 3000 + ((elapsed - windupTicks - activeTicks) / recoveryTicks) * 1000,
                );
            } else if (selfDestruct) {
                const duration = Math.max(1, selfDestruct.endTick - selfDestruct.startTick);
                actor.seekElapsed(
                    1000 * RangeUtil.clamp((renderTick - selfDestruct.startTick) / duration, 0, 1),
                );
            } else if (fruitSkillElapsed != null) actor.seekElapsed(fruitSkillElapsed);
            else if (heroBasic != null) actor.seekElapsed(heroBasic);
            else if (cornElapsed != null) actor.seekElapsed(cornElapsed);
            else if (chestnutFireMs !== null && clip === 'fire') actor.seekElapsed(chestnutFireMs);
            else if (milletFireMs !== null && clip === 'fire') actor.seekElapsed(milletFireMs);
            else
                actor.seek(
                    work?.active && work.clip === 'idle'
                        ? 0
                        : now + (HashUtil.hash(u.id) % 997) * 7,
                );
            actor.preparePose();
            // Budmori bodies are front-facing: no rotation, ground socket on the unit's ground point.
            const p = this.projectRenderWorldPosition(world),
                r = this.unitRenderRadius(u),
                scale =
                    r *
                    GRAIN_SPRITE_BASE_SCALE *
                    (UnitVisualDefinition.get(u.type)?.visualScale || 1) *
                    (GRAIN_SPRITES[u.type]?.artScale || 1),
                m = grain.matrix;
            const angle =
                    work?.rotation ??
                    impact.rotation * (this.orientationRole() === 'guest' ? -1 : 1),
                cos = Math.cos(angle),
                sin = Math.sin(angle),
                sx =
                    scale *
                    impact.scaleX *
                    (work?.facing ??
                        (sprite?.fruitAttack ||
                        (sprite?.heroBasic && heroBasic != null && !spin && !roll)
                            ? grain.heroFacing || 1
                            : cornElapsed != null
                              ? grain.cornFacing || 1
                              : milletFireMs != null
                                ? milletFacing
                                : chestnutFacing)) *
                    (work?.scaleX ?? 1),
                sy = scale * impact.scaleY * (work?.scaleY ?? 1);
            m[0] = cos * sx;
            m[1] = sin * sx;
            m[2] = -sin * sy;
            m[3] = cos * sy;
            const cx = record.ground[0],
                cy = record.ground[1] - 120;
            m[4] = p.x + (work?.offsetX ?? 0) - m[0] * cx - m[2] * cy;
            m[5] = p.y + (work?.offsetY ?? 0) + r * 0.55 - 120 * scale - m[1] * cx - m[3] * cy;
            if (roll?.phase) {
                const heading =
                    (this.orientationRole() === 'guest' ? -1 : 1) *
                    Math.sign(Math.abs(roll.dx) > 0.001 ? roll.dx : roll.dy);
                setWatermelonRollMatrix(
                    m,
                    p.x,
                    p.y + r * 0.55,
                    scale,
                    heading,
                    roll.distance / UnitDefinition.get(u.type).heroActive.rollDistance,
                    actor.rollTuck,
                    roll.phase === 'unfold' ? rollProgress : 0,
                );
            }
            grain.depth = RangeUtil.clamp(depth, -0.98, 0.98) - ++rank * GRAIN_DEPTH_RANK_STEP;
            grain.face =
                grounded && (clip === 'fire' || spin || roll?.phase)
                    ? 'attack'
                    : impact.expression ||
                      ((record.sprite ? clip === 'hit' : u.hitFlash > 0)
                          ? 'hurt'
                          : work?.clip ||
                              spin ||
                              selfDestruct ||
                              (record.sprite ? clip === 'fire' : u.attackFlash > 0)
                            ? 'attack'
                            : 'neutral');
            grain.bodyDrawn = false;
        }
        this.vectorContext.preparePoses();
    }
    // Opaque bodies go first, grouped by species, writing depth: the native path draws each species in one
    // instanced call and the depth buffer, not submission order, settles overlaps. Faces follow in painter order.
    drawGrainBodies(entries) {
        if (!this.passState.depthEnabled) return;
        const C = this.vectorContext,
            groups = this.grainBodyGroups;
        for (const g of groups.values()) g.length = 0;
        this.riceBodyGroup.length = 0;
        for (const { kind, entity: u } of entries) {
            if (kind !== 'unit') continue;
            const grain = this.grainActors.get(u.id);
            if (!grain || grain.frame !== this.grainActorFrame) continue;
            if (grain.sprite) {
                this.riceBodyGroup.push(grain);
                continue;
            }
            if (!this.grainBodyOpaque(grain)) continue;
            let g = groups.get(grain.compiled);
            if (!g) groups.set(grain.compiled, (g = []));
            g.push(grain);
        }
        C.depthTest = true;
        C.depthWrite = true;
        C.depthFunc = this.passState.depthFunc || 'lequal';
        for (const g of groups.values())
            for (const grain of g) {
                C.depth = grain.depth;
                C.drawVectorActor(grain.actor, { matrix: grain.matrix });
                grain.bodyDrawn = true;
            }
        for (const grain of this.riceBodyGroup) {
            grain.compiled.drawBody(grain.actor, grain.matrix, grain.depth);
            grain.bodyDrawn = true;
        }
        C.depth = 0;
        C.depthTest = false;
        C.depthWrite = false;
        C.depthFunc = 'lequal';
    }
    grainBodyOpaque(grain) {
        const expression = grain.actor.currentExpression,
            cache = this.grainOpaqueCoverage;
        let byExpression = cache.get(grain.compiled);
        if (!byExpression) cache.set(grain.compiled, (byExpression = new Map()));
        if (!byExpression.has(expression)) {
            const geometry = grain.compiled.geometry;
            byExpression.set(
                expression,
                RallyGamekit.hasOpaqueCoverage(geometry, {
                    indexVariant: geometry.expressionIndices?.[expression] ? expression : null,
                }),
            );
        }
        return byExpression.get(expression);
    }
    // The painter-order part of a grain: its face, and its body too when that was not depth-batched.
    // The face sits just in front of its own body and behind every nearer grain. The depth policy stays set
    // until the world pass ends, since changing it closes the vector stream that batches every face.
    drawGrainUnit(u) {
        const grain = this.grainActors.get(u.id);
        if (!grain || grain.frame !== this.grainActorFrame)
            throw new Error(`Grain ${u.id} was drawn without a prepared pose`);
        if (this.frame.length) {
            this.flushVectorMesh('frame-to-vector-switch');
            this.flush(this.frame, true);
            this.begin();
        }
        const C = this.vectorContext;
        C.depthTest = !!this.passState.depthEnabled;
        C.depthWrite = false;
        C.depthFunc = this.passState.depthFunc || 'lequal';
        if (grain.sprite) {
            if (!grain.bodyDrawn) grain.compiled.drawBody(grain.actor, grain.matrix, grain.depth);
            grain.compiled.drawFace(
                grain.actor,
                grain.matrix,
                grain.depth - GRAIN_DEPTH_RANK_STEP / 2,
                grain.face,
            );
            if (grain.compiled === this.spriteRenderers.corn && grain.holdsKernel)
                this.spriteRenderers.corn.drawHeldKernel(
                    grain.actor,
                    grain.matrix,
                    grain.depth - GRAIN_DEPTH_RANK_STEP / 2,
                );
            this.vectorAssetDrawnInstances = (this.vectorAssetDrawnInstances || 0) + 1;
            return;
        }
        C.depth = grain.depth;
        if (!grain.bodyDrawn) C.drawVectorActor(grain.actor, { matrix: grain.matrix });
        C.depth = grain.depth - GRAIN_DEPTH_RANK_STEP / 2;
        // Budmori faces: shared eye/mouth/cheek atlas parts placed on this body's posed face sockets.
        this.grainFaces.draw(grain.compiled, grain.actor, grain.face, grain.matrix, 1);
        this.vectorAssetDrawnInstances = (this.vectorAssetDrawnInstances || 0) + 1;
    }
    grainActor(u, record) {
        let grain = this.grainActors.get(u.id);
        if (grain?.compiled !== record.compiled) {
            grain?.actor.dispose();
            // Give the pose atlas room on smaller GPUs before allocating a new row.
            // An actor not yet used this frame can be recreated if it becomes visible.
            if (!grain && this.grainActors.size >= Math.max(1, this.device.maxTextureSize - 64)) {
                for (const [id, cached] of this.grainActors) {
                    if (cached.frame === this.grainActorFrame) continue;
                    cached.actor.dispose();
                    this.grainActors.delete(id);
                    break;
                }
            }
            grain = {
                actor: record.sprite
                    ? record.compiled.createActor()
                    : RallyGamekit.createVectorActor(this.vectorContext, record.compiled, {
                          clip: 'idle',
                          startedAtMs: 0,
                      }),
                compiled: record.compiled,
                sprite: !!record.sprite,
                ground: record.ground,
                matrix: new Float64Array(6),
                depth: 0,
                face: 'neutral',
                bodyDrawn: false,
                frame: 0,
            };
            this.grainActors.set(u.id, grain);
        }
        if (grain.hidden) {
            // A newly allocated actor starts idle and has no one-frame latches.
            // Reusing the pose resource must preserve that same re-entry behavior.
            grain.actor.play('idle', 0);
            grain.attackLatch = false;
            grain.hitLatch = false;
            grain.attackUntil = 0;
            grain.hitUntil = 0;
            grain.cornFacing = undefined;
            grain.hidden = false;
        }
        grain.frame = this.grainActorFrame;
        grain.lastVisibleMs = this.grainActorNow;
        return grain;
    }
    clearGrainActors() {
        for (const grain of this.grainActors.values()) grain.actor.dispose();
        this.grainActors.clear();
    }
    // Keep recently hidden pose resources briefly; never draw them outside visibility.
    pruneGrainActors() {
        let hidden = 0;
        for (const [id, grain] of this.grainActors)
            if (grain.frame !== this.grainActorFrame) {
                if (
                    !this.renderState.entity('unit', id) ||
                    this.grainActorNow - grain.lastVisibleMs >= GRAIN_ACTOR_RETENTION_MS
                ) {
                    grain.actor.dispose();
                    this.grainActors.delete(id);
                } else {
                    grain.hidden = true;
                    hidden++;
                }
            }
        if (hidden > GRAIN_ACTOR_HIDDEN_LIMIT)
            for (const [id, grain] of this.grainActors) {
                if (hidden <= GRAIN_ACTOR_HIDDEN_LIMIT) break;
                if (grain.frame === this.grainActorFrame) continue;
                grain.actor.dispose();
                this.grainActors.delete(id);
                hidden--;
            }
    }
    flushVectorMesh(reason) {
        return this.vectorContext.active ? this.vectorContext.flush(reason) : undefined;
    }
    drawUnitSafely(u, renderOptions = null) {
        try {
            return this.drawUnit(u, renderOptions);
        } catch (err) {
            this.reportEntityRenderError('unit', u, err);
            try {
                const q = this.projectEntityScreen(u, 'unit');
                this.circle(
                    q.x,
                    q.y,
                    Math.max(4 * (this.replayZoom || 1), this.unitRenderRadius(u)),
                    u.side === this.mySide() ? [0.18, 0.43, 0.93, 1] : [0.72, 0.25, 0.22, 1],
                    10,
                );
            } catch (fallbackErr) {
                this.reportEntityRenderError('unit-fallback', u, fallbackErr);
            }
        }
    }
    reportEntityRenderError(kind, entity, err) {
        this.entityRenderErrors ??= new Set();
        const key = `${kind}:${entity?.type || 'unknown'}:${String(err?.message || err)}`;
        if (this.entityRenderErrors.has(key)) return;
        this.entityRenderErrors.add(key);
        console.error('[쌀콩팡!] entity render fallback', kind, entity?.type, err);
    }
    reportRenderFatal(err) {
        if (this.renderFatalReported) return;
        this.renderFatalReported = true;
        const s = this.snapshot || {},
            entity = this.renderEntity || null;
        const diag = {
            kind: 'SSALKONGPANG_RENDER_FATAL',
            build: BUILD_META.id,
            buildMetadata: BUILD_META.snapshot(),
            at: new Date().toISOString(),
            renderer: this.backend || null,
            tick: Number(s.tick) || 0,
            tps: Number(s.tps) || 0,
            stage: this.renderStage || 'unknown',
            entity: entity
                ? {
                      id: entity.id || null,
                      type: entity.type || null,
                      side: entity.side ?? null,
                      x: entity.x ?? null,
                      y: entity.y ?? null,
                  }
                : null,
            projectiles: s.projectiles?.length || 0,
            units: s.units?.length || 0,
            message: String(err?.message || err),
            stack: String(err?.stack || ''),
        };
        DiagnosticPresentation.presentFatalDiagnostic(diag);
    }
    drawBuildingSafely(b) {
        try {
            return this.drawBuilding(b);
        } catch (err) {
            this.reportEntityRenderError('building', b, err);
            try {
                const q = this.worldToPx(this.viewX(b.x), this.viewY(b.y)),
                    r = Math.max(
                        12,
                        (BuildingDefinition.get(b.type)?.size || 40) * this.sc() * 0.55,
                    );
                this.rect(
                    q[0] - r,
                    q[1] - r,
                    r * 2,
                    r * 2,
                    b.side === this.mySide() ? [0.18, 0.43, 0.93, 1] : [0.72, 0.25, 0.22, 1],
                );
            } catch (fallbackErr) {
                this.reportEntityRenderError('building-fallback', b, fallbackErr);
            }
        }
    }
    drawProjectileSafely(p) {
        try {
            return this.drawProjectile(p);
        } catch (err) {
            this.reportEntityRenderError('projectile', p, err);
            try {
                const q = this.projectEntityScreen(p, 'projectile');
                this.circle(
                    q.x,
                    q.y,
                    Math.max(2, (p.drawRadius || 4) * this.sc()),
                    [1, 0.75, 0.25, 1],
                    8,
                );
            } catch (fallbackErr) {
                this.reportEntityRenderError('projectile-fallback', p, fallbackErr);
            }
        }
    }

    drawAcornAmmoProjectile(p, world) {
        if (p.side !== this.mySide() && !this.visibleRaw(p.x, p.y)) return;
        const point = this.projectRenderWorldPosition(world);
        const stable = this.projectRenderWorldPositionStable(world);
        const motion = this.projectileScreenMotion(p, stable.x, stable.y);
        let dx = motion.valid ? motion.dx : 1,
            dy = motion.valid ? motion.dy : 0;
        if (!motion.valid && Number.isFinite(p.lockedAimX) && Number.isFinite(p.lockedAimY)) {
            const target = this.worldToPx(this.viewX(p.lockedAimX), this.viewY(p.lockedAimY));
            dx = target[0] - point.x;
            dy = target[1] - point.y;
        }
        const angle = Math.atan2(dy, dx) + Math.PI / 4,
            size = Math.max(30, 58 * this.sc());
        const m = this._vectorUnitMatrix,
            c = this.vectorContext;
        m[0] = Math.cos(angle) * size;
        m[1] = Math.sin(angle) * size;
        m[2] = -m[1];
        m[3] = m[0];
        m[4] = point.x;
        m[5] = point.y;
        c.depthTest = !!this.passState.depthEnabled;
        c.depthWrite = false;
        c.depthFunc = this.passState.depthFunc || 'lequal';
        this.spriteRenderers.acorn.drawAmmo(m, this._renderDepth ?? 0);
        const marker = Math.max(4, 6 * this.sc());
        m[0] = marker;
        m[1] = 0;
        m[2] = 0;
        m[3] = marker;
        this.spriteRenderers.acorn.drawTeamMarker(
            m,
            this._renderDepth ?? 0,
            this.factionRelation(p.side) === 'friendly',
        );
    }

    drawUnit(u, renderOptions = null) {
        const own = u.side === this.mySide();
        if (!renderOptions?.visibilityChecked && !own && !this.visibleRaw(u.x, u.y)) return;
        // Health/status bars are drawn by drawWorldHudOverlay(), never in the unit pass.
        this.drawGrainUnit(u);
    }
    // A fading smoke ribbon behind a launched pod, following its real arc (kept in world space so camera moves don't smear it).
    drawLaunchTrail(p, wp, sc) {
        const now = this.renderState.frame(this.presentationNow())?.timeMs;
        if (!Number.isFinite(now)) return;
        let trail = this.projectileTrails.get(p.id);
        if (!trail) this.projectileTrails.set(p.id, (trail = []));
        const last = trail[trail.length - 1];
        if (last && now < last.t) trail.length = 0;
        if (!trail.length || now - trail[trail.length - 1].t >= 24)
            trail.push({ x: wp.x, y: wp.y, z: wp.z, groundY: wp.groundY, t: now });
        while (trail.length && now - trail[0].t > 520) trail.shift();
        const friendly = this.factionRelation(p.side) === 'friendly';
        let prev = null;
        for (const point of trail) {
            const q = this.projectRenderWorldPosition(point),
                age = (now - point.t) / 520,
                fade = 1 - age;
            if (prev) {
                this.line(
                    prev.x,
                    prev.y,
                    q.x,
                    q.y,
                    Math.max(2, (13 - 9 * age) * sc),
                    friendly ? [0.86, 0.92, 1, 0.55 * fade] : [1, 0.88, 0.84, 0.55 * fade],
                );
                this.line(prev.x, prev.y, q.x, q.y, Math.max(1.5, (5 - 3 * age) * sc), [
                    1,
                    0.96,
                    0.78,
                    0.9 * fade,
                ]);
            }
            prev = q;
        }
    }
    projectileScreenMotion(p, screenX, screenY) {
        let st = this.projectileScreenMotionStates.get(p.id),
            dx = 0,
            dy = 0,
            valid = false;
        if (st) {
            dx = screenX - st.x;
            dy = screenY - st.y;
            const len = Math.hypot(dx, dy);
            if (len > 0.01) {
                dx /= len;
                dy /= len;
                valid = true;
            } else if (st.valid) {
                dx = st.dx;
                dy = st.dy;
                valid = true;
            }
            st.x = screenX;
            st.y = screenY;
            if (valid) {
                st.dx = dx;
                st.dy = dy;
                st.valid = true;
            }
        } else {
            st = { x: screenX, y: screenY, dx: 0, dy: 0, valid: false };
            this.projectileScreenMotionStates.set(p.id, st);
        }
        return { dx, dy, valid };
    }
    drawThorn(shot, world) {
        if (!this.spriteRenderers.chestnut) return;
        if (this.frame.length) {
            this.flushVectorMesh('frame-to-thorn');
            this.flush(this.frame, true);
            this.begin();
        }
        const from = this.projectRenderWorldPosition({
                x: shot.fromFx / FP,
                y: shot.fromZFP / FP,
                z: shot.fromFy / FP,
                groundY: 0,
            }),
            to = this.projectRenderWorldPosition({
                x: shot.toFx / FP,
                y: shot.toZFP / FP,
                z: shot.toFy / FP,
                groundY: 0,
            }),
            point = this.projectRenderWorldPosition(world),
            angle = Math.atan2(to.y - from.y, to.x - from.x),
            length = 32 * this.sc(),
            directionX = Math.cos(angle),
            directionY = Math.sin(angle),
            cosine = directionX * length,
            sine = directionY * length,
            context = this.vectorContext;
        context.depthTest = !!this.passState.depthEnabled;
        context.depthWrite = false;
        context.depthFunc = this.passState.depthFunc || 'lequal';
        // The tail is a separate set of atlas particles, never part of the thorn image.
        const traveled = Math.hypot(point.x - from.x, point.y - from.y),
            count = Math.max(
                0,
                Math.min(4, Math.floor((traveled - length * 0.5) / (4 * this.sc()))),
            ),
            matrix = this._vectorUnitMatrix;
        matrix[0] = cosine;
        matrix[1] = sine;
        matrix[2] = -sine;
        matrix[3] = cosine;
        matrix[4] = point.x;
        matrix[5] = point.y;
        this.spriteRenderers.chestnut.drawTrail(
            matrix,
            this._renderDepth ?? 0,
            count,
            THORN_TRAIL_COLOR,
            0.25,
        );
        this.spriteRenderers.chestnut.drawThorn(matrix, this._renderDepth ?? 0);
    }
    drawThornImpact(fx, world) {
        if (!this.spriteRenderers.chestnut) return;
        if (this.frame.length) {
            this.flushVectorMesh('frame-to-thorn-impact');
            this.flush(this.frame, true);
            this.begin();
        }
        const age = fx.clock.ageMs,
            t = RangeUtil.clamp(age / 250, 0, 1),
            p = this.projectRenderWorldPosition(world),
            m = this._vectorUnitMatrix,
            context = this.vectorContext,
            distance = (5 + 20 * t) * this.sc(),
            width = 10 * this.sc(),
            height = Math.max(1, 2.5 * this.sc());
        context.depthTest = !!this.passState.depthEnabled;
        context.depthWrite = false;
        context.depthFunc = this.passState.depthFunc || 'lequal';
        for (let i = 0; i < 6; i++) {
            const angle = (i * Math.PI) / 3,
                cosine = Math.cos(angle),
                sine = Math.sin(angle);
            m[0] = cosine * width;
            m[1] = sine * width;
            m[2] = -sine * height;
            m[3] = cosine * height;
            m[4] = p.x + cosine * distance;
            m[5] = p.y + sine * distance;
            this.spriteRenderers.chestnut.drawParticle(
                m,
                this._renderDepth ?? 0,
                THORN_IMPACT_COLOR,
                1 - t,
            );
        }
    }
    drawProjectile(p) {
        const targetVisible = this.visibleRaw(p.x, p.y) || p.side === this.mySide();
        if (!targetVisible) return;
        const sc = this.sc();
        const wp = this.resolveRenderWorldPosition(p, 'projectile');
        const stablePp = this.projectRenderWorldPositionStable(wp);
        const pp = this.projectRenderWorldPosition(wp);
        const gp = this.projectRenderWorldPosition(
            this.resolveGroundShadowPosition(p, 'projectile'),
        );
        const gx = gp.x,
            gy = gp.y;
        let x = pp.x,
            y = pp.y;
        this.setRenderDepth(this.spriteDepthForWorld(wp));
        const target =
            (this.snapshot?.units || []).find((u) => u.id === p.target && u.alive) ||
            (this.snapshot?.buildings || []).find((b) => b.id === p.target && b.alive !== false);
        if (wp.y > 0.01) {
            const sr = Math.max(2, ((p.drawRadius || 5) - 1) * sc);
            this.withWorldSpriteDepth(this.resolveGroundShadowPosition(p, 'projectile'), () => {
                this.circle(gx, gy, sr, [0.06, 0.08, 0.1, 0.22], 8);
                this.circle(gx, gy, sr * 1.55, [0.06, 0.08, 0.1, 0.08], 10);
            });
            if (gy - y > 2.5)
                this.line(
                    gx,
                    gy - sr * 0.25,
                    gx,
                    y + sr * 0.3,
                    Math.max(1, 1.25 * sc),
                    [0.95, 0.92, 0.8, 0.16],
                );
        }
        if (p.payload) this.drawLaunchTrail(p, wp, sc);
        if (p.mortar) {
            const radius = Math.max(3, 10 * sc);
            this.circle(x, y, radius, [0.19, 0.15, 0.13, 1], 12);
            this.circle(x, y, radius * 0.6, [0.98, 0.65, 0.26, 1], 12);
            return;
        }
        const projectileCtx = { p, sc, target, gx, gy, wp, pp, gp, x, y };
        // Direction is sampled after interpolation/camera projection/z-height, but before
        // transient hit/camera shake.
        projectileCtx.screenMotion = this.projectileScreenMotion(p, stablePp.x, stablePp.y);
        PROJECTILE_VISUAL_RENDER_FNS.launchAmmo(this, projectileCtx);
    }
    sampleCornTrail(id, side, world) {
        const displayMs = this.cornPresentationTime();
        if (!Number.isFinite(displayMs)) return;
        const anchor = this.cornTrailAnchors.get(id);
        if (!anchor) {
            if (this.cornTrailAnchors.size >= 512)
                this.cornTrailAnchors.delete(this.cornTrailAnchors.keys().next().value);
            this.cornTrailAnchors.set(id, {
                x: world.x,
                y: world.y,
                z: world.z,
                groundY: world.groundY,
                at: displayMs,
            });
            return;
        }
        const elapsed = displayMs - anchor.at;
        if (elapsed < 0 || elapsed > 300) {
            anchor.x = world.x;
            anchor.y = world.y;
            anchor.z = world.z;
            anchor.groundY = world.groundY;
            anchor.at = displayMs;
            return;
        }
        if (elapsed < 50) return;
        if (Math.hypot(world.x - anchor.x, world.y - anchor.y, world.z - anchor.z) < 0.5) return;
        let trail = this.cornTrails.get(id);
        if (!trail) {
            if (this.cornTrails.size >= 512)
                this.cornTrails.delete(this.cornTrails.keys().next().value);
            this.cornTrails.set(id, (trail = []));
        }
        trail.push({ ...anchor, at: displayMs, side });
        if (trail.length > 6) trail.shift();
        anchor.x = world.x;
        anchor.y = world.y;
        anchor.z = world.z;
        anchor.groundY = world.groundY;
        anchor.at = displayMs;
    }
    drawMilletEarProjectile(projectile, world) {
        if (projectile.side !== this.mySide() && !this.visibleRaw(projectile.x, projectile.y))
            return;
        const point = this.projectRenderWorldPosition(world),
            stable = this.projectRenderWorldPositionStable(world),
            motion = this.projectileScreenMotion(projectile, stable.x, stable.y);
        let dx = motion.valid ? motion.dx : 1,
            dy = motion.valid ? motion.dy : 0;
        if (
            !motion.valid &&
            Number.isFinite(projectile.lockedAimX) &&
            Number.isFinite(projectile.lockedAimY)
        ) {
            const target = this.worldToPx(
                this.viewX(projectile.lockedAimX),
                this.viewY(projectile.lockedAimY),
            );
            dx = target[0] - point.x;
            dy = target[1] - point.y;
        }
        // The approved ear asset points about -0.6 radians from its local x axis.
        const angle = Math.atan2(dy, dx) + 0.6,
            size = Math.max(30, 58 * this.sc()),
            a = Math.cos(angle) * size,
            b = Math.sin(angle) * size,
            matrix = this.cornQuadMatrix,
            context = this.vectorContext;
        matrix[0] = a;
        matrix[1] = b;
        matrix[2] = -b;
        matrix[3] = a;
        matrix[4] = point.x;
        matrix[5] = point.y;
        context.depthTest = !!this.passState.depthEnabled;
        context.depthWrite = false;
        context.depthFunc = this.passState.depthFunc || 'lequal';
        this.spriteRenderers.millet.drawEar(matrix, this._renderDepth ?? 0);
        const markerSize = Math.max(4, 6 * this.sc());
        matrix[0] = markerSize;
        matrix[1] = 0;
        matrix[2] = 0;
        matrix[3] = markerSize;
        this.spriteRenderers.corn.drawTeamMarker(
            matrix,
            this._renderDepth ?? 0,
            this.factionRelation(projectile.side) === 'friendly',
        );
        this.sampleCornTrail('millet-ear:' + projectile.id, projectile.side, world);
    }
    drawCornConeProjectile(projectile, world, popcorn = false) {
        if (projectile.side !== this.mySide() && !this.visibleRaw(projectile.x, projectile.y))
            return;
        const point = this.projectRenderWorldPosition(world),
            stable = this.projectRenderWorldPositionStable(world),
            motion = this.projectileScreenMotion(projectile, stable.x, stable.y);
        let dx = motion.valid ? motion.dx : 1,
            dy = motion.valid ? motion.dy : 0;
        if (
            !motion.valid &&
            Number.isFinite(projectile.lockedAimX) &&
            Number.isFinite(projectile.lockedAimY)
        ) {
            const target = this.worldToPx(
                this.viewX(projectile.lockedAimX),
                this.viewY(projectile.lockedAimY),
            );
            dx = target[0] - point.x;
            dy = target[1] - point.y;
        }
        this.sampleCornTrail('cone:' + projectile.id, projectile.side, world);
        const angle = Math.atan2(dy, dx) + Math.PI / 4,
            size = Math.max(30, 58 * this.sc()),
            a = Math.cos(angle) * size,
            b = Math.sin(angle) * size,
            matrix = this.cornQuadMatrix,
            C = this.vectorContext;
        matrix[0] = a;
        matrix[1] = b;
        matrix[2] = -b;
        matrix[3] = a;
        matrix[4] = point.x;
        matrix[5] = point.y;
        C.depthTest = !!this.passState.depthEnabled;
        C.depthWrite = false;
        C.depthFunc = this.passState.depthFunc || 'lequal';
        if (popcorn) this.spriteRenderers.popcorn.drawAmmo(matrix, this._renderDepth ?? 0);
        else this.spriteRenderers.corn.drawCone(matrix, this._renderDepth ?? 0);
        const markerSize = Math.max(4, 6 * this.sc());
        matrix[0] = markerSize;
        matrix[1] = 0;
        matrix[2] = 0;
        matrix[3] = markerSize;
        this.spriteRenderers.corn.drawTeamMarker(
            matrix,
            this._renderDepth ?? 0,
            this.factionRelation(projectile.side) === 'friendly',
        );
    }
    drawCornKernel(projectile, world) {
        if (!this.spriteRenderers.corn)
            throw new Error('옥수수 투사체 자원이 준비되지 않았습니다.');
        const now = this.presentationNow(),
            model = this.renderState.model('unitLob', projectile.id, now),
            sampled = model?.entity || projectile;
        if (!sampled.grounded && world.y > world.groundY + 1)
            this.sampleCornTrail('lob:' + projectile.id, projectile.side, world);
        const point = this.projectRenderWorldPosition(world),
            radius = Number(UnitDefinition.get(projectile.sourceType)?.lobAttack?.radius) || 5,
            size = Math.max(3, radius * 2 * this.sc()),
            matrix = this.cornQuadMatrix,
            C = this.vectorContext;
        matrix[0] = size;
        matrix[1] = 0;
        matrix[2] = 0;
        matrix[3] = size;
        matrix[4] = point.x;
        matrix[5] = point.y;
        C.depthTest = !!this.passState.depthEnabled;
        C.depthWrite = false;
        C.depthFunc = this.passState.depthFunc || 'lequal';
        this.spriteRenderers.corn.drawKernel(matrix, this._renderDepth ?? 0);
    }
    renderMilletParticles() {
        if (!this.milletBursts.length) return;
        const life = EffectObjectFactory.milletBurstLifeMs,
            scale = this.sc();
        let write = 0;
        this.begin();
        this.passState.depthWrite = false;
        for (const burst of this.milletBursts) {
            const age = burst.clock.ageMs;
            if (burst.clock.expired || age >= life) continue;
            this.milletBursts[write++] = burst;
            if (age < 0 || (burst.side !== this.mySide() && !this.visibleRaw(burst.x, burst.y)))
                continue;
            const t = age / life,
                distance = 10 + 75 * t;
            for (let i = 0; i < 12; i++) {
                const angle = (i * Math.PI * 2) / 12,
                    world = {
                        x: burst.x + Math.cos(angle) * distance,
                        z: burst.y + Math.sin(angle) * distance * 0.4,
                        y: (Number(burst.zFP) || 0) / FP,
                        groundY: 0,
                    },
                    point = this.projectRenderWorldPosition(world);
                this.withWorldSpriteDepth(world, () =>
                    this.circle(
                        point.x,
                        point.y,
                        Math.max(2, (3 + 3 * (1 - t)) * scale),
                        [220 / 255, 165 / 255, 68 / 255, 1 - t],
                        8,
                    ),
                );
            }
        }
        this.milletBursts.length = write;
        if (this.frame.length) this.flush(this.frame, true);
        this.begin();
    }
    renderCornParticles() {
        if ((!this.cornTrails.size && !this.cornBursts.length) || !this.spriteRenderers.corn)
            return;
        const time = this.cornPresentationTime();
        if (!Number.isFinite(time)) return;
        const sc = this.sc(),
            trailLife = 300,
            burstLife = EffectObjectFactory.cornBurstLifeMs;
        this.begin();
        this.passState.depthWrite = false;
        for (const [id, trail] of this.cornTrails) {
            let write = 0;
            for (const p of trail) {
                const age = time - p.at;
                if (age >= trailLife) continue;
                trail[write++] = p;
                if (age < 0 || (p.side !== this.mySide() && !this.visibleRaw(p.x, p.z))) continue;
                const point = this.projectRenderWorldPosition(p),
                    fade = 1 - age / trailLife;
                this.withWorldSpriteDepth(p, () =>
                    this.circle(
                        point.x,
                        point.y,
                        Math.max(1, (2 + 2 * fade) * sc),
                        [1, 0.73, 0.16, 0.55 * fade],
                        8,
                    ),
                );
            }
            trail.length = write;
            if (!write) this.cornTrails.delete(id);
        }
        let write = 0;
        for (const burst of this.cornBursts) {
            const age = burst.clock.ageMs;
            if (burst.clock.expired || age >= burstLife) continue;
            this.cornBursts[write++] = burst;
            if (age < 0 || (burst.side !== this.mySide() && !this.visibleRaw(burst.x, burst.y)))
                continue;
            const t = age / burstLife;
            for (let i = 0; i < 3; i++) {
                const angle = (i * Math.PI * 2) / 3 + ((burst.seed % 360) * Math.PI) / 180;
                const world = {
                    x: burst.x + Math.cos(angle) * 15 * t,
                    z: burst.y + Math.sin(angle) * 10 * t,
                    y: (Number(burst.zFP) || 0) / FP + 5 + 15 * t,
                    groundY: 0,
                };
                const point = this.projectRenderWorldPosition(world);
                this.withWorldSpriteDepth(world, () =>
                    this.circle(
                        point.x,
                        point.y,
                        Math.max(2, (5 + 8 * t) * sc),
                        [1, 0.92, 0.72, 0.28 * (1 - t)],
                        8,
                    ),
                );
            }
        }
        this.cornBursts.length = write;
        if (this.frame.length) this.flush(this.frame, true);
        this.begin();
        if (!this.cornBursts.length) return;
        const C = this.vectorContext,
            matrix = this.cornQuadMatrix;
        C.depthTest = !!this.passState.depthEnabled;
        C.depthWrite = false;
        C.depthFunc = this.passState.depthFunc || 'lequal';
        for (const burst of this.cornBursts) {
            const age = burst.clock.ageMs;
            if (age < 0 || (burst.side !== this.mySide() && !this.visibleRaw(burst.x, burst.y)))
                continue;
            const t = Math.min(1, age / burstLife);
            if (burst.selfDestruct) {
                const world = {
                    x: burst.x,
                    z: burst.y,
                    y: (Number(burst.zFP) || 0) / FP + 10,
                    groundY: 0,
                };
                const point = this.projectRenderWorldPosition(world),
                    size = Math.max(4, (30 + 65 * Math.min(1, t * 3)) * sc);
                matrix[0] = size;
                matrix[1] = 0;
                matrix[2] = 0;
                matrix[3] = size;
                matrix[4] = point.x;
                matrix[5] = point.y;
                this.spriteRenderers.popcorn.drawBurst(
                    matrix,
                    this.spriteDepthForWorld(world),
                    1 - t,
                );
                continue;
            }
            const distance = Math.min(45, Number(burst.radius) || 45) * t;
            for (let i = 0; i < 6; i++) {
                const angle = (i * Math.PI * 2) / 6 + ((burst.seed % 360) * Math.PI) / 180;
                const world = {
                    x: burst.x + Math.cos(angle) * distance,
                    z: burst.y + Math.sin(angle) * distance * 0.6,
                    y: (Number(burst.zFP) || 0) / FP + Math.sin(Math.PI * t) * (10 + 4 * (i % 3)),
                    groundY: 0,
                };
                const point = this.projectRenderWorldPosition(world),
                    size = Math.max(3, 13 * sc * (1 - t * 0.35)),
                    rotation = angle * 0.35 + t * (i % 2 ? -1 : 1);
                const a = Math.cos(rotation) * size,
                    b = Math.sin(rotation) * size;
                matrix[0] = a;
                matrix[1] = b;
                matrix[2] = -b;
                matrix[3] = a;
                matrix[4] = point.x;
                matrix[5] = point.y;
                this.spriteRenderers.corn.drawPopcorn(
                    i % 3,
                    matrix,
                    this.spriteDepthForWorld(world),
                    1 - t,
                );
            }
        }
        C.flush('corn-particles');
        C.depthTest = false;
        C.depthWrite = false;
        C.depthFunc = 'lequal';
    }
    prepareFogSurfaces(atlas) {
        if (this._fogSurfaceAtlas === atlas) return;
        const surfaces = new Map([[0, []]]),
            add = (level, patch) => {
                if (!surfaces.has(level)) surfaces.set(level, []);
                surfaces.get(level).push(patch);
            };
        for (const patch of atlas.presentationSurfaceMesh()) add(patch.fogLevel, patch);
        for (const [id, texture] of this.fogTextures)
            if (!surfaces.has(Number(id.slice(6)))) {
                this.device.deleteTexture(texture);
                this.fogTextures.delete(id);
            }
        for (const [id, texture] of this.fogPreviousTextures)
            if (!surfaces.has(Number(id.slice(6)))) {
                this.device.deleteTexture(texture);
                this.fogPreviousTextures.delete(id);
            }
        this.resetFogTransition();
        this.fogSurfaces = surfaces;
        this._fogSurfaceAtlas = atlas;
        this._fogTextureKey = null;
    }
    resetFogTransition() {
        this._fogTransitionStartedAt = null;
        this._fogMaskContext = null;
        this._fogTextureKey = null;
        this.fogMaskRecords.clear();
    }
    fogTransitionAmount(now = performance.now()) {
        return this._fogTransitionStartedAt == null
            ? 1
            : RangeUtil.clamp(
                  (now - this._fogTransitionStartedAt) / this.fogTransitionDurationMs,
                  0,
                  1,
              );
    }
    fogVisibilityGrid(step = this.fogMaskStep || 64) {
        const activeStep = this.fogMaskStep || 64;
        for (const key of this.fogVisibilityGrids.keys())
            if (key !== 64 && key !== activeStep) this.fogVisibilityGrids.delete(key);
        let field = this.fogVisibilityGrids.get(step);
        if (!field || !field.sameGeometry(this, step)) {
            field = new FogVisibilityGrid(this, step);
            this.fogVisibilityGrids.set(step, field);
        }
        return field.update(this);
    }
    fogVisionRevision() {
        return this.visionFields.map((field) => field?.revision ?? -1).join(',');
    }
    ensureFogTextures() {
        if (!this.snapshot) return null;
        const gl = this.gl,
            atlas = this.world.terrain.surfaces,
            step = this.fogMaskStep || 64,
            w = Math.max(2, Math.ceil(this.world.width / step) + 1),
            h = Math.max(2, Math.ceil(this.world.height / step) + 1),
            key = `${this.snapshot.tick}|${this.replayVisionMode || this.mySide()}|${this.replayObserverAll ? 1 : 0}|${this.world.width}x${this.world.height}|${atlas.maxLevel}|${w}x${h}`;
        this.prepareFogSurfaces(atlas);
        if (this._fogTextureKey === key && this._fogVisionRevision === this.fogVisionRevision())
            return this.fogMaskSize;
        const now = performance.now(),
            perspective = `${this.orientationRole()}|${this.replayVisionMode || this.mySide()}|${this.replayObserverAll ? 1 : 0}`,
            previous = this._fogMaskContext,
            delta = Number(this.snapshot.tick) - Number(previous?.tick),
            continuous =
                previous?.atlas === atlas &&
                previous.perspective === perspective &&
                previous.w === w &&
                previous.h === h &&
                delta > 0 &&
                delta <=
                    Math.ceil((Number(this.snapshot.rules?.simulation?.tps) || SIM_TPS) * 0.25),
            amount = this.fogTransitionAmount(now);
        const upload = (textures, id, data) => {
            let tex = textures.get(id);
            if (tex && (this.fogMaskSize?.w !== w || this.fogMaskSize?.h !== h)) {
                this.device.deleteTexture(tex);
                textures.delete(id);
                tex = null;
            }
            if (!tex) {
                tex = this.device.createTexture(
                    { width: w, height: h, data },
                    { format: 'luminance', filter: 'linear' },
                );
                textures.set(id, tex);
            } else this.device.updateTexture(tex, { width: w, height: h, data });
            return tex;
        };
        const visibility = this.fogVisibilityGrid(step);
        // Levels need not be contiguous: only surfaces that exist need a texture.
        for (const level of this.fogSurfaces.keys()) {
            const id = `level:${level}`,
                target = visibility.atLevel(level),
                record = this.fogMaskRecords.get(id);
            // Blend only the presentation mask. Exact entity visibility continues to use
            // VisibilityPolicy against the current snapshot, never these texture values.
            let from = target;
            if (continuous && record) {
                from = new Uint8Array(target.length);
                for (let i = 0; i < from.length; i++)
                    from[i] = Math.round(
                        record.from[i] + (record.target[i] - record.from[i]) * amount,
                    );
                upload(this.fogPreviousTextures, id, from);
            }
            upload(this.fogTextures, id, target);
            this.fogMaskRecords.set(id, { from, target });
        }
        this._fogTransitionStartedAt = continuous ? now : null;
        this._fogMaskContext = { atlas, perspective, tick: this.snapshot.tick, w, h };
        this.fogMaskSize = { w, h };
        this._fogTextureKey = key;
        this._fogVisionRevision = this.fogVisionRevision();
        return this.fogMaskSize;
    }
    fogVertex(world, bridgeId = null) {
        const q = this.projectRenderWorldPosition(world),
            u = RangeUtil.clamp(world.x / this.world.width, 0, 1),
            v = RangeUtil.clamp(world.z / this.world.height, 0, 1);
        // Slight camera-facing bias keeps the transparent fog coplanar with terrain without z-fighting.
        this.fogFrame.push5(
            q.x,
            q.y,
            (bridgeId ? this.renderDepthForWorld({ ...world, bridgeId }) : q.depth) - 0.00035,
            u,
            v,
        );
    }
    flushFog(texture, color, previousTexture = texture) {
        if (!this.fogFrame.length || !texture) return;
        const d = this.fogFrame.view();
        this.device.uploadVertices(this.fogBuf, d);
        this.drawBatch(
            this.fogProgram,
            this.fogBuf,
            0,
            this.fogFrame.length / 5,
            {
                r: [this.canvas.width, this.canvas.height],
                fog: color,
                tex: 0,
                previousTex: 1,
                transition: this.fogTransitionAmount(),
                maskSize: [this.fogMaskSize.w, this.fogMaskSize.h],
            },
            [texture, this._fogTransitionStartedAt == null ? texture : previousTexture],
        );
        this.perfStats.drawCalls = (this.perfStats.drawCalls || 0) + 1;
        this.perfStats.bufferUploadBytes = (this.perfStats.bufferUploadBytes || 0) + d.byteLength;
        this.fogFrame.reset();
    }
    drawFog() {
        if (this.replayObserverAll || !this.snapshot) {
            this.resetFogTransition();
            return;
        }
        this.ensureFogTextures();
        const gl = this.gl,
            color = this.replayVisionMode
                ? [0.008, 0.012, 0.018, 0.96]
                : [0.025, 0.045, 0.048, 0.88];
        // Reuse terrain's projected spatial index and orientation filter. Tessellation
        // is built once; offscreen triangles never enter the per-frame Fog upload.
        const mesh = TerrainSurfaceProjection.forAtlas(
                this.world.terrain.surfaces,
            ).renderProjectedSurfaceMesh(this.orientationRole() === 'guest'),
            a = this.projectedCoordinatesAtScreen(0, 0),
            b = this.projectedCoordinatesAtScreen(this.canvas.width, this.canvas.height),
            visible = new Map();
        for (const tri of mesh.index.query(a.x, a.y, b.x, b.y, 1 / this.sc())) {
            const level = tri.patch.fogLevel;
            if (!visible.has(level)) visible.set(level, []);
            visible.get(level).push(tri);
        }
        this.passState.depthEnabled = true;
        this.passState.depthFunc = 'lequal';
        this.passState.depthWrite = false;
        // The atlas clips the base floor around authored surfaces, including depressions.
        // Fog uses those same patches so an implicit level-0 plane cannot cover a lower floor.
        for (const level of this.fogSurfaces.keys()) {
            this.fogFrame.reset();
            for (const tri of visible.get(level) || [])
                for (const v of tri.vertices)
                    this.fogVertex(v, tri.patch.bridge ? tri.patch.id : null);
            this.flushFog(
                this.fogTextures.get(`level:${level}`),
                color,
                this.fogPreviousTextures.get(`level:${level}`),
            );
        }
        this.passState.depthEnabled = false;
        this.passState.depthWrite = false;
    }
    drawFogLandmarks() {
        if (this.replayObserverAll) return;
        if (!this.snapshot) return;
        const side = this.mySide(),
            sc = this.sc();

        // 상대 메인 베이스: 위치/존재는 항상 알지만, 시야 밖에서는
        //    HP, 건설 상태, 주변 상황 등의 실시간 정보는 보여주지 않는다.
        const enemyBase = this.snapshot.buildings.find(
            (b) =>
                b.alive !== false && b.side !== side && BuildingDefinition.get(b.type)?.isMainBase,
        );
        if (enemyBase && !this.visibleRaw(enemyBase.x, enemyBase.y)) {
            const [x, y] = this.worldToPx(this.viewX(enemyBase.x), this.viewY(enemyBase.y));
            const d = BuildingDefinition.get(enemyBase.type),
                r = d.size * sc;
            this.rect(x - r, y - r, r * 2, r * 2, [0.28, 0.08, 0.1, 0.72]);
            this.rect(x - r * 0.55, y - r * 0.55, r * 1.1, r * 1.1, [0.42, 0.15, 0.17, 0.76]);
            // 실루엣 외곽선
            const edge = [0.62, 0.24, 0.26, 0.72],
                w = Math.max(1.5, 2.5 * sc);
            this.line(x - r, y - r, x + r, y - r, w, edge);
            this.line(x + r, y - r, x + r, y + r, w, edge);
            this.line(x + r, y + r, x - r, y + r, w, edge);
            this.line(x - r, y + r, x - r, y - r, w, edge);
            // 위치만 알려주는 중앙 표식. HP bar는 의도적으로 없음.
            this.circle(x, y, r * 0.2, [0.78, 0.32, 0.34, 0.78], 8);
        }
    }
    renderGroundPass() {
        this.renderStage = 'ground';
        this.renderEntity = null;
        const gl = this.gl;
        this.passState.depthWrite = true;
        this.setRenderDepth(0.97);
        this.begin();
        this.drawGround();
        this.flush();
        this.passState.depthWrite = false;
        this.begin();
        TerrainPresentation.drawSurfaceEdges(this);
        this.setRenderDepth(0.969);
        this.drawStrategicMap();
        this.flush();
        this.passState.depthWrite = true;
    }
    renderShadowPass(visibleUnits) {
        if (!this.snapshot) return;
        this.passState.depthWrite = false;
        this.begin();
        this.renderStage = 'unit-shadow';
        for (const u of visibleUnits) {
            this.renderEntity = u;
            try {
                this.drawUnitShadow(u, true);
            } catch (err) {
                this.reportEntityRenderError('unit-shadow', u, err);
            }
        }
        this.flushVectorMesh('grain-ring-end');
        for (const p of this.renderState.displayed('projectile', this.presentationNow())) {
            if (p.payload?.type !== 'acorn' || !this.presentationEntityActive('projectile', p.id))
                continue;
            if (p.side !== this.mySide() && !this.visibleRaw(p.x, p.y)) continue;
            if (
                p.retiredTick != null &&
                this.renderState.frame(this.presentationNow()).timeMs >=
                    p.retiredTick * this.presentationTargetIntervalMs()
            )
                continue;
            const world = this.resolveRenderWorldPosition(p, 'projectile');
            const ground = this.resolveGroundShadowPosition(p, 'projectile');
            const pt = this.projectRenderWorldPosition(ground),
                radius = Math.max(2, ((p.drawRadius || 5) - 1) * this.sc());
            this.withWorldSpriteDepth(ground, () => {
                this.circle(pt.x, pt.y, radius, [0.06, 0.08, 0.1, 0.22], 8);
                this.circle(pt.x, pt.y, radius * 1.55, [0.06, 0.08, 0.1, 0.08], 10);
            });
            this.withWorldSpriteDepth(world, () => this.drawLaunchTrail(p, world, this.sc()));
        }
        for (const projectile of this.renderState.displayed('unitLob', this.presentationNow())) {
            if (
                projectile.retiredAtTick != null &&
                this.renderState.frame(this.presentationNow()).timeMs >=
                    projectile.retiredAtTick * this.presentationTargetIntervalMs()
            )
                continue;
            if (projectile.side !== this.mySide() && !this.visibleRaw(projectile.x, projectile.y))
                continue;
            const world = this.resolveRenderWorldPosition(projectile, 'unitLob');
            if (world.y <= world.groundY + 0.01) continue;
            const ground = this.resolveGroundShadowPosition(projectile, 'unitLob');
            const point = this.projectRenderWorldPosition(ground);
            this.withWorldSpriteDepth(ground, () =>
                this.circle(
                    point.x,
                    point.y,
                    Math.max(2, 5 * this.sc()),
                    [0.05, 0.06, 0.03, 0.24],
                    8,
                ),
            );
        }
        for (const projectile of this.renderState.displayed('projectile', this.presentationNow())) {
            if (projectile.payload?.type !== 'corn' && projectile.payload?.type !== 'millet')
                continue;
            if (projectile.side !== this.mySide() && !this.visibleRaw(projectile.x, projectile.y))
                continue;
            if (
                projectile.retiredTick != null &&
                this.renderState.frame(this.presentationNow()).timeMs >=
                    projectile.retiredTick * this.presentationTargetIntervalMs()
            )
                continue;
            const world = this.resolveRenderWorldPosition(projectile, 'projectile');
            if (world.y <= world.groundY + 0.01) continue;
            const ground = this.resolveGroundShadowPosition(projectile, 'projectile');
            const point = this.projectRenderWorldPosition(ground),
                radius = Math.max(2, ((projectile.drawRadius || 5) - 1) * this.sc());
            this.withWorldSpriteDepth(ground, () => {
                this.circle(point.x, point.y, radius, [0.06, 0.08, 0.1, 0.22], 8);
                this.circle(point.x, point.y, radius * 1.55, [0.06, 0.08, 0.1, 0.08], 10);
            });
        }
        this.flush();
        this.passState.depthWrite = true;
    }
    prepareWorldSpriteFrame(visibleUnits) {
        const out = this.worldSpriteFrame;
        out.length = 0;
        let used = 0;
        const add = (kind, entity, world) => {
            const entry = this.worldSpritePool[used] || (this.worldSpritePool[used] = {});
            used++;
            entry.kind = kind;
            entry.entity = entity;
            entry.world = world;
            entry.depth = this.spriteDepthForWorld(world);
            entry.key = kind + ':' + entity.id;
            out.push(entry);
        };
        for (const b of this.snapshot.buildings || [])
            if (
                b.alive !== false &&
                b.hp > 0 &&
                this.onScreenAuth(b.x, b.y, (BuildingDefinition.get(b.type)?.size || 40) + 100)
            )
                add('building', b, { x: b.x, y: 0, z: b.y });
        for (const u of visibleUnits) add('unit', u, this.resolveRenderWorldPosition(u, 'unit'));
        const fruitNow = this.presentationNow();
        for (const unit of this.renderState.displayed('unit', fruitNow)) {
            if (!GRAIN_SPRITES[unit.type]?.fruitAttack) continue;
            const model = this.renderState.model('unit', unit.id, fruitNow);
            const renderTick = model?.tick ?? this.snapshot.tick;
            for (const shot of fruitShotsAt(model?.entity.fruitAttack, renderTick)) {
                const { x, y, z } = fruitProjectilePosition(shot, renderTick);
                if (unit.side !== this.mySide() && !this.visibleRaw(x, y)) continue;
                const groundY = this.world.terrain.surfaces.heightAt(x, y);
                add(
                    'fruitProjectile',
                    {
                        ...shot,
                        sourceType: unit.type,
                        sourceId: unit.id,
                        side: unit.side,
                        renderTick,
                    },
                    {
                        x,
                        y: z,
                        z: y,
                        groundY,
                    },
                );
            }
        }
        for (const p of this.renderState.displayed('projectile', this.presentationNow())) {
            if (!this.presentationEntityActive('projectile', p.id)) continue;
            if (
                p.retiredTick != null &&
                this.renderState.frame(this.presentationNow()).timeMs >=
                    p.retiredTick * this.presentationTargetIntervalMs()
            )
                continue;
            const world = this.resolveRenderWorldPosition(p, 'projectile');
            const screen = this.projectRenderWorldPosition(world),
                pad = 90 * this.sc();
            if (
                screen.x >= -pad &&
                screen.y >= -pad &&
                screen.x <= this.canvas.width + pad &&
                screen.y <= this.canvas.height + pad
            )
                add('projectile', p, world);
        }
        for (const p of this.renderState.displayed('unitLob', this.presentationNow())) {
            if (
                p.retiredAtTick != null &&
                this.renderState.frame(this.presentationNow()).timeMs >=
                    p.retiredAtTick * this.presentationTargetIntervalMs()
            )
                continue;
            if (p.side !== this.mySide() && !this.visibleRaw(p.x, p.y)) continue;
            const world = this.resolveRenderWorldPosition(p, 'unitLob');
            const screen = this.projectRenderWorldPosition(world),
                pad = 90 * this.sc();
            if (
                screen.x >= -pad &&
                screen.y >= -pad &&
                screen.x <= this.canvas.width + pad &&
                screen.y <= this.canvas.height + pad
            )
                add('unitLob', p, world);
        }
        for (const thorn of this.renderState.displayed('thorn', this.presentationNow())) {
            if (
                thorn.retiredTick != null &&
                this.renderState.frame(this.presentationNow()).timeMs >=
                    (thorn.retiredTick * 1000) / (this.snapshot.tps || SIM_TPS)
            )
                continue;
            if (thorn.side !== this.mySide() && !this.visibleRaw(thorn.x, thorn.y)) continue;
            const model = this.renderState.model('thorn', thorn.id, this.presentationNow()),
                entity = model?.entity || thorn,
                ground = this.world.terrain.surfaces.heightAt(entity.x, entity.y),
                world = { x: entity.x, y: entity.zFP / FP, z: entity.y, groundY: ground },
                screen = this.projectRenderWorldPosition(world),
                pad = 90 * this.sc();
            if (
                screen.x >= -pad &&
                screen.y >= -pad &&
                screen.x <= this.canvas.width + pad &&
                screen.y <= this.canvas.height + pad
            )
                add('thorn', thorn, world);
        }
        const now = this.presentationNow();
        for (const fx of this.combatFx) {
            if (
                fx.kind !== 'thornImpact' ||
                fx.clock.expired ||
                fx.clock.ageMs >= EffectObjectFactory.combatLife(fx)
            )
                continue;
            const ground = this.world.terrain.surfaces.heightAt(fx.x, fx.y);
            add('thornImpact', fx, {
                x: fx.x,
                y: Number.isFinite(fx.impactHeightFP) ? fx.impactHeightFP / FP : ground,
                z: fx.y,
                groundY: ground,
            });
        }
        const bundleBreakIds = this.bundleBreakIds;
        bundleBreakIds.clear();
        for (const fx of this.combatFx) {
            if (fx.kind === 'launchBundleBreak' && !fx.clock.expired) {
                bundleBreakIds.add(fx.id);
                if (this.landingBundlePose(fx).visible)
                    add('landingBundle', fx, {
                        x: fx.x,
                        y: this.world.terrain.surfaces.heightAt(fx.x, fx.y),
                        z: fx.y,
                        groundY: 0,
                    });
            }
        }
        for (const group of this.renderState.displayed('bundle', now)) {
            if (group.side !== this.mySide() && !this.visibleRaw(group.x, group.y)) continue;
            if (group.index >= group.count || bundleBreakIds.has('bundle:' + group.projectileId))
                continue;
            const fx = {
                id: 'bundle:' + group.projectileId,
                x: group.x,
                y: group.y,
                clock: { ageMs: 150, expired: false },
                grainType: group.type,
                angle: 0,
            };
            add('landingBundle', fx, {
                x: fx.x,
                y: this.world.terrain.surfaces.heightAt(fx.x, fx.y),
                z: fx.y,
                groundY: 0,
            });
        }
        const started = performance.now();
        out.sort((a, b) => b.depth - a.depth || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
        this.perfStats.cpuDepthSortMs = performance.now() - started;
        this.perfStats.visibleSprites = out.length;
        return out;
    }
    renderTerrainOccludedBodies() {
        const frame = this.terrainOccludedBodyFrame;
        if (!frame.length) return;
        const gl = this.gl;
        this.device.clear({ stencil: 0 });
        this.passState.stencil = {
            func: 'equal',
            ref: 0,
            mask: 255,
            writeMask: 255,
            fail: 'keep',
            zfail: 'keep',
            pass: 'increment',
        };
        this.passState.depthFunc = 'greater';
        this.flush(frame);
        this.passState.stencil = false;
        this.passState.depthFunc = 'lequal';
    }
    renderTerrainOcclusionDepth() {
        const atlas = this.world.terrain.surfaces,
            gl = this.gl;
        if (!atlas._occlusionMesh) {
            atlas._occlusionMesh = [];
            for (const patch of atlas.renderSurfaceMesh)
                if (patch.kind === 'cliff' || patch.bridge)
                    for (const indices of patch.triangles)
                        atlas._occlusionMesh.push({
                            vertices: indices.map((i) =>
                                patch.bridge
                                    ? { ...patch.vertices[i], bridgeId: patch.id }
                                    : patch.vertices[i],
                            ),
                        });
        }
        const projection = TerrainSurfaceProjection.forAtlas(atlas).projectedTriangleMesh(
                atlas._occlusionMesh,
                this.orientationRole() === 'guest',
            ),
            a = this.projectedCoordinatesAtScreen(0, 0),
            b = this.projectedCoordinatesAtScreen(this.canvas.width, this.canvas.height);
        this.passState.depthWrite = true;
        this.device.clear({ depth: 1 });
        this.passState.colorMask = [false, false, false, false];
        this.begin();
        try {
            for (const item of projection.index.query(a.x, a.y, b.x, b.y))
                for (const v of item.tri.vertices) {
                    const p = this.projectRenderWorldPosition(v);
                    this.setRenderDepth(p.depth);
                    this.v(p.x, p.y, [1, 1, 1, 1]);
                }
            this.flush();
        } finally {
            this.passState.colorMask = [true, true, true, true];
            this.passState.depthWrite = false;
            this.begin();
        }
    }
    renderWorldPass(visibleUnits) {
        if (!this.snapshot) return;
        const gl = this.gl;
        this.renderTerrainOcclusionDepth();
        this.terrainOccludedBodyFrame.reset();
        this.begin();
        // Terrain alone owns the depth buffer. Each billboard's authored painter
        // order must never compete with its own coplanar component triangles.
        let lastPainter = null;
        const entries = this.prepareWorldSpriteFrame(visibleUnits);
        this.prepareGrainPoses(entries);
        this.drawUnitAttackEffects(entries);
        if (this.frame.length) {
            this.flush(this.frame, true);
            this.begin();
        }
        this.drawGrainBodies(entries);
        for (const entry of entries) {
            const { kind, entity, world } = entry;
            this.renderEntity = entity;
            this.renderStage = kind;
            const nextPainter =
                kind === 'landingBundle' ||
                (kind === 'projectile' && entity.payload?.type === 'acorn') ||
                (kind === 'projectile' && entity.payload?.type === 'corn') ||
                (kind === 'projectile' && entity.payload?.type === 'millet') ||
                (kind === 'projectile' && GRAIN_SPRITES[entity.payload?.type]?.cannonAmmo) ||
                kind === 'fruitProjectile' ||
                kind === 'unitLob' ||
                kind === 'thorn' ||
                kind === 'thornImpact' ||
                (kind === 'unit' && this.hasGrainArt(entity))
                    ? 'vector'
                    : 'frame';
            if (lastPainter && nextPainter !== lastPainter) {
                if (lastPainter === 'vector')
                    this.flushVectorMesh('vector-to-frame-painter-switch');
                else if (this.frame.length) {
                    this.flush(this.frame, true);
                    this.begin();
                }
            }
            lastPainter = nextPainter;
            this.withWorldSpriteDepth(world, () => {
                if (kind === 'unit')
                    this.drawUnitSafely(entity, {
                        skipShadow: true,
                        visibilityChecked: true,
                        worldPosition: world,
                    });
                else if (kind === 'building') this.drawBuildingSafely(entity);
                else if (kind === 'landingBundle') this.drawLandingBundle(entity);
                else if (entity.payload?.type === 'acorn')
                    this.drawAcornAmmoProjectile(entity, world);
                else if (kind === 'unitLob') this.drawCornKernel(entity, world);
                else if (kind === 'projectile' && entity.payload?.type === 'corn')
                    this.drawCornConeProjectile(entity, world);
                else if (kind === 'projectile' && entity.payload?.type === 'popcorn')
                    this.drawCornConeProjectile(entity, world, true);
                else if (kind === 'projectile' && entity.payload?.type === 'millet')
                    this.drawMilletEarProjectile(entity, world);
                else if (kind === 'fruitProjectile') this.drawFruitProjectile(entity, world);
                else if (kind === 'thorn') this.drawThorn(entity, world);
                else if (kind === 'thornImpact') this.drawThornImpact(entity, world);
                else this.drawProjectileSafely(entity);
            });
        }
        this.flushVectorMesh('world-pass-end');
        this.pruneGrainActors();
        const C = this.vectorContext;
        C.depth = 0;
        C.depthTest = false;
        C.depthWrite = false;
        C.depthFunc = 'lequal';
        if (this.frame.length) {
            this.flush(this.frame, true);
            this.begin();
        }
        this.passState.depthWrite = false;
        try {
            // Behind-terrain friendly bodies are faint, and foreground sprites paint
            // over them. Fog/detection filtering has already selected visibleUnits.
            this.renderTerrainOccludedBodies();
            this.flush(this.frame, true);
        } finally {
            this.passState.stencil = false;
            this.passState.depthFunc = 'lequal';
            this.passState.depthWrite = true;
        }
    }
    // Visual arcs and dust share the world's primitive batch; the authoritative
    // spin interval and contact pulses remain owned by the simulation.
    drawUnitAttackEffects(entries) {
        for (const fx of this.combatFx) {
            if (
                (fx.kind !== 'spinBasicImpact' && fx.kind !== 'fruitBerryImpact') ||
                fx.clock.expired
            )
                continue;
            const fade = 1 - fx.clock.ageMs / EffectObjectFactory.combatLife(fx);
            if (fade <= 0) continue;
            const elevation = this.world.terrain.surfaces.heightAt(fx.x, fx.y);
            const stroke =
                fx.kind === 'fruitBerryImpact' ? [0.75, 0.45, 1, fade] : [1, 0.77, 0.44, fade];
            this.withWorldSpriteDepth({ x: fx.x, y: elevation, z: fx.y, groundY: 0 }, () =>
                this.drawGroundCircle(fx.x, fx.y, fx.radius, {
                    elevation,
                    stroke,
                    width: Math.max(1, 2 * this.sc()),
                    segments: 20,
                }),
            );
        }
        const now = this.presentationNow();
        for (const entry of entries) {
            if (entry.kind !== 'unit') continue;
            const definition = UnitDefinition.get(entry.entity.type);
            const spec = definition?.spinAttack;
            if (!spec && !definition?.heroActive && !definition?.fruitAttack) continue;
            const model = this.renderState.model('unit', entry.entity.id, now);
            if (definition.heroActive && entry.entity.alive)
                this.drawHeroRollTelegraph(entry, model, definition.heroActive);
            if (definition.fruitAttack && entry.entity.alive)
                this.drawFruitAttackEffect(model, definition.fruitAttack);
            const spin = model?.entity?.spinAttack,
                tick = model?.tick,
                radius = spec?.radius;
            if (
                !spin ||
                !Number.isFinite(tick) ||
                !Number.isFinite(radius) ||
                tick < spin.startTick ||
                tick >= spin.endTick
            )
                continue;
            const active = tick >= spin.activeStartTick && tick < spin.activeEndTick,
                recovery = tick >= spin.activeEndTick,
                fadeTicks = Math.max(1, (this.snapshot.tps || ActiveSimulationTiming.tps()) * 0.14),
                fade = recovery ? Math.max(0, 1 - (tick - spin.activeEndTick) / fadeTicks) : 1;
            if (!fade) continue;
            const windupProgress = Math.max(
                0,
                Math.min(1, (tick - spin.startTick) / (spin.activeStartTick - spin.startTick)),
            );
            const ground = this.resolveGroundShadowPosition(entry.entity, 'unit'),
                project = (angle) =>
                    this.projectRenderWorldPosition({
                        x: ground.x + Math.cos(angle) * radius,
                        y: ground.y,
                        z: ground.z + Math.sin(angle) * radius,
                        groundY: 0,
                    }),
                fill = spec.arcSweep
                    ? [0.95, 0.48, 0.29, (0.07 + 0.12 * windupProgress ** 2) * fade]
                    : [
                          0.9,
                          0.21,
                          0.27,
                          (recovery ? 0.38 : active ? 0.25 : 0.08 + 0.18 * windupProgress ** 2) *
                              fade,
                      ],
                edge = spec.arcSweep
                    ? [1, 0.64, 0.37, 0.85 * fade]
                    : recovery
                      ? [1, 0.45, 0.47, fade]
                      : [0.89, 0.24, 0.29, 0.9];
            const turns =
                ((tick - spin.activeStartTick) / (spin.activeEndTick - spin.activeStartTick)) *
                Math.PI *
                (spec.arcSweep ? 1 : 6);
            this.withWorldSpriteDepth(ground, () => {
                this.drawGroundCircle(ground.x, ground.z, radius, {
                    fill,
                    stroke: edge,
                    width: Math.max(1, 1.6 * this.sc()),
                    elevation: ground.y,
                });
                if (!active) return;
                for (let arc = 0; arc < 2; arc++) {
                    const length = spec.arcSweep ? Math.min(turns, Math.PI / 3) : Math.PI / 2;
                    const start = turns + arc * Math.PI - (spec.arcSweep ? length : 0);
                    for (let j = 0; j < 7; j++) {
                        const a = start + (j / 7) * length,
                            b = start + ((j + 1) / 7) * length,
                            from = project(a),
                            to = project(b);
                        this.line(
                            from.x,
                            from.y,
                            to.x,
                            to.y,
                            Math.max(1, (spec.arcSweep ? 5 : 2.5) * this.sc()),
                            spec.arcSweep ? [1, 0.9, 0.61, 0.35 + j * 0.09] : [1, 0.78, 0.36, 0.72],
                        );
                    }
                }
                if (spec.arcSweep) return;
                for (let i = 0; i < 3; i++) {
                    const a = turns * 0.7 + (i * Math.PI * 2) / 3;
                    const dust = project(a);
                    this.circle(
                        dust.x,
                        dust.y,
                        Math.max(1, 2.5 * this.sc()),
                        [0.88, 0.75, 0.5, 0.4],
                        6,
                    );
                }
            });
        }
    }
    drawFruitProjectile(shot, world) {
        const p = this.projectRenderWorldPosition(world),
            span =
                (shot.kind === 'berry'
                    ? shot.mode === 'basic'
                        ? 14
                        : 20
                    : shot.mode === 'active'
                      ? shot.radius * 2
                      : 22) * this.sc(),
            age = (shot.renderTick - shot.startTick) / (this.snapshot.tps || SIM_TPS),
            angle = shot.kind === 'boomerang' ? age * Math.PI * 7 : 0,
            cos = Math.cos(angle) * span,
            sin = Math.sin(angle) * span;
        if (shot.kind === 'boomerang') {
            const departure = shot.renderTick - shot.startTick;
            const arrival = shot.endTick - shot.renderTick;
            const source = this.grainActors.get(shot.sourceId);
            // Only bridge the one-tick boundary from the visible grip to the
            // authoritative trajectory and back. The flight itself uses its world track.
            if ((departure < 1 || arrival < 1) && source?.frame === this.grainActorFrame) {
                const [x, y] = source.compiled.weaponSocket(source.matrix, departure < 1);
                const weight = 1 - Math.min(departure, arrival);
                p.x += (x - p.x) * weight;
                p.y += (y - p.y) * weight;
            }
            if (shot.mode === 'passive') this.drawBananaPassiveCue(shot, p, span);
        }
        if (this.frame.length) {
            this.flushVectorMesh('frame-to-fruit-projectile-switch');
            this.flush(this.frame, true);
            this.begin();
        }
        this.vectorContext.depthTest = true;
        this.vectorContext.depthWrite = false;
        this.spriteRenderers[shot.sourceType].drawCombatAmmo(
            [cos, sin, -sin, cos, p.x, p.y],
            this._renderDepth ?? 0,
        );
    }
    drawBananaPassiveCue(shot, point, span) {
        const returning = shot.renderTick >= shot.turnTick;
        const ink = [0.22, 0.13, 0.29, 0.9],
            gold = [1, 0.85, 0.33, 1];
        const radius = Math.max(5, span * 0.58);
        const corners = [
            [point.x, point.y - radius],
            [point.x + radius, point.y],
            [point.x, point.y + radius],
            [point.x - radius, point.y],
        ];
        for (let i = 0; i < corners.length; i++) {
            const from = corners[i],
                to = corners[(i + 1) % corners.length];
            this.line(...from, ...to, returning ? 3.5 : 2.5, ink);
            this.line(...from, ...to, returning ? 1.8 : 1.2, gold);
        }
        if (this.reducedMotion.matches) return;

        // Rebuild from the displayed tick so a seek or a lost sightline leaves no trail state.
        const tps = this.snapshot.tps || SIM_TPS,
            oldest = Math.max(
                returning ? shot.turnTick : shot.startTick,
                shot.renderTick - tps * (returning ? 0.22 : 0.12),
            );
        if (oldest >= shot.renderTick) return;
        let previous = point;
        const segments = 4;
        for (let i = 1; i <= segments; i++) {
            const fraction = i / segments;
            const { x, y, z } = fruitProjectilePosition(
                shot,
                shot.renderTick + (oldest - shot.renderTick) * fraction,
            );
            if (shot.side !== this.mySide() && !this.visibleRaw(x, y)) break;
            const current = this.projectRenderWorldPosition({
                x,
                y: z,
                z: y,
                groundY: this.world.terrain.surfaces.heightAt(x, y),
            });
            const fade = 1 - (i - 1) / segments;
            this.line(previous.x, previous.y, current.x, current.y, (returning ? 5 : 3) * fade, [
                0.22,
                0.13,
                0.29,
                0.8 * fade,
            ]);
            this.line(
                previous.x,
                previous.y,
                current.x,
                current.y,
                (returning ? 2.8 : 1.4) * fade,
                [1, 0.85, 0.33, fade],
            );
            previous = current;
        }
    }
    drawFruitAttackEffect(model, spec) {
        const fruit = model?.entity.fruitAttack;
        if (!fruit) return;
        const { active } = fruit;
        const shot = active?.shot;
        if (shot) {
            if (model.tick >= shot.startTick) return;
            this.drawFruitThrowPreview(shot);
            return;
        }
        const impacts = active?.impacts?.slice(active.strike) ?? [];
        for (const projectile of fruit.projectiles)
            if (
                projectile.kind === 'berry' &&
                projectile.mode !== 'basic' &&
                model.tick < projectile.endTick
            )
                impacts.push(projectile.to);
        for (const { x, y, z } of impacts)
            this.withWorldSpriteDepth({ x, y: z, z: y, groundY: z }, () => {
                this.drawGroundCircle(x, y, spec.lob.radius, {
                    elevation: z,
                    stroke: [0.81, 0.58, 1, 0.9],
                    fill: [0.55, 0.3, 0.82, 0.08],
                    width: Math.max(1, 2 * this.sc()),
                    segments: 20,
                });
            });
    }
    drawFruitThrowPreview(shot) {
        const groundPoint = (x, z) => {
            const y = this.world.terrain.surfaces.heightAt(x, z);
            return this.projectRenderWorldPosition({ x, y, z, groundY: y });
        };
        const drawLeg = (start, end, edge, band) => {
            const segments = 16;
            let a = fruitProjectilePosition(shot, start);
            for (let i = 1; i <= segments; i++) {
                const b = fruitProjectilePosition(shot, start + ((end - start) * i) / segments),
                    dx = b.x - a.x,
                    dy = b.y - a.y,
                    length = Math.hypot(dx, dy);
                if (!length) continue;
                const nx = (-dy * shot.radius) / length,
                    ny = (dx * shot.radius) / length,
                    leftA = groundPoint(a.x + nx, a.y + ny),
                    leftB = groundPoint(b.x + nx, b.y + ny),
                    rightB = groundPoint(b.x - nx, b.y - ny),
                    rightA = groundPoint(a.x - nx, a.y - ny);
                this.withRenderDepth((leftA.depth + leftB.depth) / 2 - 0.001, () => {
                    this.quad(
                        leftA.x,
                        leftA.y,
                        leftB.x,
                        leftB.y,
                        rightB.x,
                        rightB.y,
                        rightA.x,
                        rightA.y,
                        band,
                    );
                    const from = groundPoint(a.x, a.y),
                        to = groundPoint(b.x, b.y);
                    this.line(from.x, from.y, to.x, to.y, Math.max(1.5, 2 * this.sc()), edge);
                });
                a = b;
            }
        };
        drawLeg(shot.startTick, shot.turnTick, [0.35, 0.95, 0.53, 0.9], [0.25, 0.82, 0.45, 0.24]);
        drawLeg(shot.turnTick, shot.endTick, [1, 0.82, 0.27, 0.9], [1, 0.74, 0.24, 0.24]);
    }
    drawHeroRollTelegraph({ entity, world }, model, spec) {
        const roll = model?.entity?.heroRoll;
        if (
            roll?.phase !== 'hop' ||
            model.tick < roll.phaseStartTick ||
            model.tick >= roll.phaseEndTick
        )
            return;

        const ground = { ...world, y: world.groundY };
        const { x, z } = ground;
        const radius = InteractionGeometry.unitRadius(entity.type);
        if (this.rollPreviewNavigation?.geometry !== this.world.terrain)
            this.rollPreviewNavigation = new TerrainNavigation({ world: this.world });
        const { distance } = this.rollPreviewNavigation.traceStraightTravel(
            x,
            z,
            roll.dx,
            roll.dy,
            spec.rollDistance,
            radius,
            this.snapshot,
        );
        const progress = watermelonRollProgress(roll, model.tick);
        this.withWorldSpriteDepth(ground, () => {
            this.drawGroundCircle(x, z, spec.landing.radius, {
                elevation: ground.y,
                fill: [0.9, 0.19, 0.25, 0.1 + 0.14 * progress ** 2],
                stroke: [1, 0.42, 0.4, 0.9],
                width: Math.max(1.5, 2 * this.sc()),
            });
            this.drawHeroRollPath(ground, roll, distance, spec.rollHitRadius);
        });
    }
    drawHeroRollPath(ground, { dx, dy }, distance, radius) {
        const project = (along, across) =>
            this.worldToPx(
                this.viewX(ground.x + dx * along - dy * across),
                this.viewY(ground.z + dy * along + dx * across),
                ground.y,
            );
        const points = [];
        const segments = 8;
        for (let i = 0; i <= segments; i++) {
            const angle = (Math.PI * i) / segments;
            points.push(project(distance + radius * Math.sin(angle), radius * Math.cos(angle)));
        }
        for (let i = 0; i <= segments; i++) {
            const angle = (Math.PI * i) / segments;
            points.push(project(-radius * Math.sin(angle), -radius * Math.cos(angle)));
        }
        const edge = [1, 0.79, 0.34, 0.95];
        this.poly(points, [0.92, 0.52, 0.12, 0.22]);
        for (let i = 0; i < points.length; i++)
            this.line(...points[i], ...points[(i + 1) % points.length], 1.5, edge);
        if (!distance) return;
        const tip = project(distance, 0),
            wing = Math.min(radius * 0.5, distance * 0.4);
        const arrow = [
            project(0, 0),
            project(distance - wing, -wing),
            project(distance - wing, wing),
        ];
        for (const point of arrow) this.line(...point, ...tip, 4, [0.28, 0.13, 0.04, 0.86]);
        for (const point of arrow) this.line(...point, ...tip, 2, edge);
    }
    renderOverlayPass() {
        this.passState.depthEnabled = false;
        this.passState.depthWrite = false;
        this.drawFog();
        this.begin();
        this.setRenderDepth(0);
        this.drawFogLandmarks();
        this.flush();
        this.begin();
        this.drawLaunchOverlay();
        this.flush();
    }
    // Range is measured in simulation XY. Every contour point is projected from its own terrain height.
    drawLaunchRange(cannon, type, level, active = false) {
        const reach = LaunchRules.maxReachOf(type, level);
        this.drawGroundCircle(cannon.x, cannon.y, reach, {
            stroke: active ? [1, 0.86, 0.36, 0.8] : [0.63, 0.84, 1, 0.24],
            width: Math.max(1, (active ? 2 : 1.2) * this.sc()),
            segments: Math.max(64, Math.ceil((Math.PI * 2 * reach) / 48)),
        });
    }
    drawLaunchOverlay() {
        const s = this.snapshot,
            side = this.mySide(),
            sc = this.sc(),
            now = performance.now();
        const main = BuildingDefinition.forRole('mainBase'),
            outpost = BuildingDefinition.forRole('outpost'),
            reloadTicks = SimulationTiming.msToTicks(
                LaunchRules.reloadMs,
                s.tps || ActiveSimulationTiming.tps(),
            );
        const hold = LaunchPresentation.hold,
            card = hold?.card || LaunchPresentation.card || LaunchRules.deck[0],
            level = s.launchRangeLevel?.[side] ?? 0;
        // Friendly completed cannons show the selected payload's maximum launch reach.
        for (const b of s.buildings || []) {
            if (
                b.side !== side ||
                b.alive === false ||
                b.construction ||
                (b.type !== main && b.type !== outpost)
            )
                continue;
            this.drawLaunchRange(b, card, level, hold?.cannonId === b.id);
        }
        // Overheated cannons glow red; reloading ones show a thin ring.
        for (const b of s.buildings || []) {
            if (
                b.side !== side ||
                b.alive === false ||
                b.construction ||
                (b.type !== main && b.type !== outpost)
            )
                continue;
            const wait = (Number(b.launchReadyTick) || 0) - s.tick;
            if (wait <= 0) continue;
            const radius = (BuildingDefinition.get(b.type)?.size || 40) + 10,
                hot = wait > reloadTicks;
            this.drawGroundCircle(b.x, b.y, radius, {
                width: Math.max(2, 3 * sc),
                stroke: hot
                    ? [1, 0.3, 0.2, 0.5 + 0.4 * (Math.floor(now / 160) % 2)]
                    : [0.92, 0.92, 0.92, 0.45],
            });
        }
        this.launchAimOrder = [];
        if (hold) {
            const project = (x, y) =>
                this.worldToPx(
                    this.viewX(x),
                    this.viewY(y),
                    this.world.terrain.surfaces.heightAt(x, y),
                );
            const [cx, cy] = project(hold.cannonX, hold.cannonY);
            const held = now - hold.armedAt,
                power = LaunchRules.power(held),
                burnt = LaunchRules.overheated(held),
                full = power >= 1;
            const color = burnt
                    ? [1, 0.22, 0.16, 1]
                    : full
                      ? [1, 0.78, 0.2, Math.floor(now / 90) % 2 ? 1 : 0.55]
                      : [1, 0.95, 0.75, 0.9],
                w = Math.max(2, 3 * sc);
            const { aim, shots, formation } = LaunchPresentation.aimPreview(hold, held, this.world);
            const [lx, ly] = project(aim.x, aim.y);
            this.line(cx, cy, lx, ly, Math.max(1.5, 2 * sc), [color[0], color[1], color[2], 0.45]);
            const rings = new Map();
            // Split shells may launch at different times to land together. Only bursts show an order.
            const ordered = LaunchRules.grain(hold.card).fire.mode === 'burst';
            for (const [index, shot] of shots.entries()) {
                // Equal-radius shells on the same point share a ring and show all their turns.
                const key = `${shot.x},${shot.y},${shot.splash}`;
                if (!rings.has(key)) rings.set(key, { shot, order: [] });
                if (ordered) rings.get(key).order.push(index + 1);
            }
            let ringIndex = 0;
            for (const { shot, order } of rings.values()) {
                this.drawGroundCircle(shot.x, shot.y, shot.splash, {
                    stroke: color,
                    width: w,
                    segments: 40,
                });
                if (rings.size === 1 || !ordered) {
                    this.drawGroundCircle(shot.x, shot.y, shot.splash * (1 - Math.SQRT1_2), {
                        stroke: [color[0], color[1], color[2], 0.6],
                        width: Math.max(1.5, 2 * sc),
                        segments: 24,
                    });
                }
                if (order.length) {
                    // Stagger the labels so concentric rings stay legible when zoomed out.
                    const angle = (ringIndex * 2 * Math.PI) / 3;
                    const ox = Math.cos(angle) * shot.splash,
                        oy = Math.sin(angle) * shot.splash;
                    const wx = shot.x + ox,
                        wy = shot.y + oy;
                    const [x, y] = project(
                        wx >= 0 && wx <= this.world.width ? wx : shot.x - ox,
                        wy >= 0 && wy <= this.world.height ? wy : shot.y - oy,
                    );
                    const [sx, sy] = project(shot.x, shot.y),
                        length = Math.hypot(x - sx, y - sy) || 1;
                    this.launchAimOrder.push({
                        label: order.join('·'),
                        x,
                        y,
                        dx: (x - sx) / length,
                        dy: (y - sy) / length,
                    });
                }
                ringIndex++;
            }
            for (const spot of formation) {
                this.drawGroundCircle(spot.x, spot.y, spot.radius, {
                    stroke: [0.57, 0.94, 1, 0.9],
                    width: Math.max(1.5, 2 * sc),
                    segments: 16,
                });
            }
            this.line(lx - 8, ly, lx + 8, ly, 2, color);
            this.line(lx, ly - 8, lx, ly + 8, 2, color);
            // The previous shot's landing distance, as a faint ring at that reach.
            if (hold.lastPower != null && !full) {
                const last = LaunchPresentation.landing(
                    hold,
                    hold.lastPower * LaunchRules.chargeMs,
                    this.world,
                );
                this.drawGroundCircle(last.x, last.y, 10, {
                    stroke: [1, 1, 1, 0.55],
                    width: Math.max(1.5, 2 * sc),
                    segments: 20,
                });
            }
        }
        const W = this.canvas.width,
            H = this.canvas.height,
            pad = Math.max(18, 26 * sc);
        for (const m of LaunchPresentation.marks) {
            if (m.clock.expired) continue;
            const age = RangeUtil.clamp(m.clock.ageMs / LaunchRules.landingMarkMs, 0, 1),
                alpha = 1 - age,
                col = [1, 0.9, 0.5, alpha];
            const [x, y] = this.worldToPx(this.viewX(m.x), this.viewY(m.y));
            if (x >= 0 && x <= W && y >= 0 && y <= H) {
                this.drawGroundCircle(m.x, m.y, 30 + 40 * age, {
                    stroke: col,
                    width: Math.max(2, 3 * sc),
                });
                this.line(x - 8, y, x + 8, y, 2, [1, 1, 1, alpha]);
                this.line(x, y - 8, x, y + 8, 2, [1, 1, 1, alpha]);
                continue;
            }
            // Off-screen landing: an arrow on the screen edge points at it.
            let dx = x - W / 2,
                dy = y - H / 2;
            const k = Math.min(
                (W / 2 - pad) / Math.max(1e-6, Math.abs(dx)),
                (H / 2 - pad) / Math.max(1e-6, Math.abs(dy)),
            );
            const ex = W / 2 + dx * k,
                ey = H / 2 + dy * k,
                len = Math.hypot(dx, dy) || 1,
                a = Math.max(16, 26 * sc);
            dx /= len;
            dy /= len;
            this.line(ex, ey, ex - dx * a + dy * a * 0.65, ey - dy * a - dx * a * 0.65, 4, col);
            this.line(ex, ey, ex - dx * a - dy * a * 0.65, ey - dy * a + dx * a * 0.65, 4, col);
            this.circle(ex - dx * a * 0.45, ey - dy * a * 0.45, 4, col, 10);
        }
    }
    renderUiFxPass() {
        this.drawFloatingFx();
        this.passState.depthWrite = true;
        this.passState.depthEnabled = true;
    }
    displayCoordinatesAtScene(x, y) {
        return { x: x + (this.frameShakeX || 0), y: y + (this.frameShakeY || 0) };
    }
    sceneCoordinatesAtDisplay(x, y, { sampled = false } = {}) {
        const sx = this.frameShakeX || 0,
            sy = this.frameShakeY || 0,
            point = { x: x - sx, y: y - sy };
        // The final texture repeats its border texel where the translated scene ends.
        // Picking follows that displayed sample; internal scene queries stay unclamped.
        return sampled && (sx || sy)
            ? {
                  x: RangeUtil.clamp(point.x, 0.5, this.canvas.width - 0.5),
                  y: RangeUtil.clamp(point.y, 0.5, this.canvas.height - 0.5),
              }
            : point;
    }
    renderCameraShakePass() {
        // Translate the resolved, antialiased scene once; geometry, visibility and Fog
        // have already rendered with the same stable projection as spatial inference.
        const gl = this.gl,
            w = this.canvas.width,
            h = this.canvas.height,
            { x: sx, y: sy } = this.displayCoordinatesAtScene(0, 0);
        // Prime the program and sized texture with an identity copy on first use or
        // resize, so the first impact never pays the cold composition setup cost.
        const needsWarmup =
            !this.frameComposition ||
            this.frameComposition.width !== w ||
            this.frameComposition.height !== h;
        if (!sx && !sy && !needsWarmup) {
            if (this.cameraShakePresentationMoved) {
                if (this.fxCanvas) this.fxCanvas.style.transform = 'translate(0px,0px)';
                this.cameraShakePresentationMoved = false;
            }
            return;
        }
        const rect = this.canvas.getBoundingClientRect(),
            cssX = (sx * rect.width) / w,
            cssY = (sy * rect.height) / h;
        if (this.fxCanvas) this.fxCanvas.style.transform = `translate(${cssX}px,${cssY}px)`;
        this.cameraShakePresentationMoved = !!sx || !!sy;
        if (!this.frameComposition) {
            const precision = gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER, gl.HIGH_FLOAT)
                ?.precision
                ? 'highp'
                : 'mediump';
            const program = this.device.createPipeline({
                vertex: 'attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}',
                fragment: `precision ${precision} float;uniform sampler2D scene;uniform vec2 size;uniform vec2 offset;void main(){gl_FragColor=texture2D(scene,(gl_FragCoord.xy-offset)/size);}`,
                stride: 8,
                attributes: [{ name: 'position', size: 2, offset: 0 }],
                uniforms: { scene: '1i', size: '2f', offset: '2f' },
            });
            const buffer = this.device.createVertexBuffer({ capacityBytes: 48 });
            this.frameComposition = { program, buffer, texture: null, width: 0, height: 0 };
        }
        const c = this.frameComposition;
        if (c.width !== w || c.height !== h) {
            if (c.texture) this.device.deleteTexture(c.texture);
            c.texture = this.device.createTexture({ width: w, height: h, data: null });
            c.width = w;
            c.height = h;
        }
        this.device.uploadVertices(
            c.buffer,
            new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
        );
        this.device.copyFrameToTexture(c.texture);
        this.device.draw({
            pipeline: c.program,
            buffer: c.buffer,
            count: 6,
            uniforms: { scene: 0, size: [w, h], offset: [sx, -sy] },
            textures: [c.texture],
            blend: false,
            depth: false,
        });
    }

    renderMinimapPass() {
        const now = performance.now();
        if (ActiveViewState.minimap && now - ActiveViewState.minimap.lastDrawAt >= 100)
            ActiveViewState.minimap.draw();
    }

    loop() {
        try {
            // A showcase can lose its display area before visibility is synchronized.
            if (this.showcase && !this.hasDisplayArea()) {
                this.loopFrame = requestAnimationFrame(this.loop);
                return;
            }
            const frameStarted = performance.now();
            this._framePresentationAt = frameStarted;
            this.resize();
            // DOM viewport synchronization is once per frame, not once per terrain/Fog vertex.
            // All math still uses the shared camera; input and standalone passes refresh on demand.
            if (!this.showcase) LaunchPresentation.followAim(this);
            this._frameCamera = this.stableCamera();

            // Result/lobby UI owns the screen after a match ends. Do not continue sampling
            // presentation state from an ended match (especially the delayed sample buffer).
            if (
                !this.showcase &&
                UiRuntimeState.value.screen !== 'game' &&
                UiRuntimeState.value.screen !== 'replay'
            ) {
                if (this.vectorContext.active) this.vectorContext.endFrame();
                if (this.vectorContext.beginFrame()) this.vectorContext.endFrame();
                this.loopFrame = requestAnimationFrame(this.loop);
                return;
            }

            this.onPresentationFrame?.(this.renderState.frame(frameStarted));
            this.updateClientShake();

            const rp = this.perfStats;
            rp.drawCalls = 0;
            rp.bufferUploadBytes = 0;
            rp.cpuDepthSortMs = 0;
            this.geometryTemplateHits = 0;
            this.unitBodyMeshCacheHits = 0;
            this.unitBodyMeshCacheMisses = 0;

            this.passProfiler.beginFrame();
            const visibleUnits = this.passProfiler.measure('prepare', () =>
                this.snapshot ? this.prepareVisibleUnitFrame() : this.visibleUnitFrame,
            );
            if (this.vectorContext.active) this.vectorContext.endFrame();
            this.grainFaces.prepare();
            if (!this.passProfiler.measure('device-begin', () => this.vectorContext.beginFrame())) {
                this.loopFrame = requestAnimationFrame(this.loop);
                return;
            }
            Object.assign(this.passState, {
                depthEnabled: true,
                depthWrite: true,
                depthFunc: 'lequal',
                stencil: false,
                colorMask: [true, true, true, true],
            });

            this.passProfiler.measure('ground', () => this.renderGroundPass());
            this.vectorAssetDrawnInstances = 0;
            this.vectorTerrainOcclusionTests = 0;
            this.vectorTerrainOcclusionRegions = 0;
            this.vectorTerrainOcclusionTriangles = 0;
            this.passProfiler.measure('world', () => {
                this.renderWorldPass(visibleUnits);
                this.renderCornParticles();
                this.renderMilletParticles();
            });
            this.passProfiler.measure('shadow', () => this.renderShadowPass(visibleUnits));
            if (!this.showcase)
                this.passProfiler.measure('overlay', () => this.renderOverlayPass());
            this.passProfiler.measure('ui-fx', () => this.renderUiFxPass());
            this.passProfiler.measure('camera-compose', () => this.renderCameraShakePass());
            if (!this.showcase)
                this.passProfiler.measure('minimap', () => this.renderMinimapPass());

            const vectorStats = this.vectorContext.stats().mesh;
            rp.vectorAssetDraws = this.vectorAssetDrawnInstances;
            rp.vectorAssetInstances = vectorStats.instances;
            rp.vectorAssetDrawCalls = vectorStats.draws;
            rp.vectorTerrainOcclusionTests = this.vectorTerrainOcclusionTests;
            rp.vectorTerrainOcclusionRegions = this.vectorTerrainOcclusionRegions;
            rp.vectorTerrainOcclusionTriangles = this.vectorTerrainOcclusionTriangles;
            rp.vectorAssetGeometryBytes = vectorStats.geometryBytesUploaded;
            rp.vectorAssetInstanceBytes = vectorStats.instanceBytesUploaded;
            rp.vectorAssetRetainedBytes = vectorStats.retainedBytes;
            rp.vectorAssetMeshes = vectorStats.meshCount;
            rp.drawCalls += vectorStats.draws;
            rp.bufferUploadBytes +=
                vectorStats.geometryBytesUploaded + vectorStats.instanceBytesUploaded;
            rp.geometryTemplateHits = this.geometryTemplateHits;
            rp.unitBodyMeshCacheHits = this.unitBodyMeshCacheHits;
            rp.unitBodyMeshCacheMisses = this.unitBodyMeshCacheMisses;
            rp.unitBodyMeshCacheSize = this.unitBodyMeshCache.size;
            rp.passes = this.passProfiler.snapshot();
            const frameEnded = performance.now(),
                work = frameEnded - frameStarted;
            rp.frameWorkMs = work;
            rp.maxFrameWorkMs = Math.max(rp.maxFrameWorkMs || 0, work);
            rp.ewmaFrameWorkMs = rp.ewmaFrameWorkMs
                ? rp.ewmaFrameWorkMs * 0.85 + work * 0.15
                : work;
            const frameInterval = Math.max(0, frameEnded - (rp.lastFrameAt || frameEnded));
            rp.lastFrameAt = frameEnded;
            if (frameInterval > 0) {
                rp.frameIntervalMs = frameInterval;
                rp.ewmaFrameIntervalMs = rp.ewmaFrameIntervalMs
                    ? rp.ewmaFrameIntervalMs * 0.85 + frameInterval * 0.15
                    : frameInterval;
                rp.maxFrameIntervalMs = Math.max(rp.maxFrameIntervalMs || 0, frameInterval);
            }
            rp.frames++;
            const fpsSpan = frameEnded - rp.fpsWindowAt;
            if (fpsSpan >= 1000) {
                rp.fps = (rp.frames * 1000) / fpsSpan;
                rp.frames = 0;
                rp.fpsWindowAt = frameEnded;
                // Recent max, not lifetime max, so a mobile spike remains visible for about a second.
                rp.maxFrameIntervalMs = rp.frameIntervalMs || 0;
                rp.maxFrameWorkMs = rp.frameWorkMs || 0;
            }
            if (this.onShowcaseFirstFrame) {
                this.vectorContext.endFrame();
                const onFirstFrame = this.onShowcaseFirstFrame;
                this.onShowcaseFirstFrame = null;
                onFirstFrame();
            }
            if (this.loopStarted) this.loopFrame = requestAnimationFrame(this.loop);
        } catch (err) {
            if (this.showcase) {
                this.stopLoop();
                this.onShowcaseError?.(err);
                return;
            }
            this.reportRenderFatal(err);
            // Do not permanently kill requestAnimationFrame. Entity-level failures are isolated
            // above; a remaining frame-level failure keeps the diagnostic visible and retries so
            // recovery/correction or a later valid snapshot can restore presentation.
            this.loopFrame = requestAnimationFrame(this.loop);
        } finally {
            if (this.vectorContext.active) this.vectorContext.endFrame();
            this._framePresentationAt = null;
            this._frameCamera = null;
        }
    }
}
class MiniMap {
    constructor(canvas) {
        this.canvas = canvas;
        this.ctx = canvas.getContext('2d');
        this.renderer = null;
        this.snapshot = null;
        this.lastDrawAt = 0;
        this.fogMaskTarget = null;
        this.fogMaskDarkKey = '';
        this.dragging = false;
        this.pointerId = null;
        this.bind();
    }
    bind() {
        const jump = (e) => {
            if (!this.renderer) return;
            e.preventDefault();
            e.stopPropagation();

            const rect = this.contentRect();
            const px = RangeUtil.clamp(e.clientX - rect.left, 0, rect.width);
            const py = RangeUtil.clamp(e.clientY - rect.top, 0, rect.height);

            // 미니맵 좌표는 항상 "내 본진 좌하단 → 적 본진 우상단" 사용자 시점.
            const viewWorldX = (px / rect.width) * this.renderer.world.width;
            const viewWorldY = (py / rect.height) * this.renderer.world.height;

            // 탭한 지점이 화면 중앙에 오도록 즉시 점프.
            const vw = this.renderer.viewWorldW(),
                vh = this.renderer.viewWorldH();
            this.renderer.cameraLeft = RangeUtil.clamp(
                viewWorldX - vw / 2,
                0,
                Math.max(0, this.renderer.world.width - vw),
            );
            const elevation = this.renderer.world.terrain.surfaces.heightAt(
                this.renderer.viewX(viewWorldX),
                this.renderer.viewY(viewWorldY),
            );
            this.renderer.cameraTop = this.renderer.clampCameraTop(
                BattlefieldProjection.planarY(viewWorldY, elevation) - vh / 2,
            );

            this.draw();
        };

        this.input = RallyGamekit.createDOMInput({
            target: this.canvas,
            pointerButtons: { 0: 'minimap', 1: 'minimap', 2: 'minimap' },
            touchAction: 'none',
            onPointer: (point) => {
                const e = point.originalEvent;
                if (point.type === 'down') {
                    if (this.dragging && this.pointerId !== point.pointerId) return;
                    this.dragging = true;
                    this.pointerId = point.pointerId;
                    jump(e);
                } else if (point.type === 'move') {
                    if (this.dragging && this.pointerId === point.pointerId) jump(e);
                } else if (this.pointerId === point.pointerId) {
                    this.dragging = false;
                    this.pointerId = null;
                    e?.preventDefault();
                    e?.stopPropagation();
                }
            },
            onRelease: () => {
                this.dragging = false;
                this.pointerId = null;
            },
        });
    }
    set(renderer, snapshot) {
        this.renderer = renderer;
        this.snapshot = snapshot;
        this.canvas.style.objectFit = 'contain';
    }
    contentRect() {
        const rect = this.canvas.getBoundingClientRect(),
            scale = Math.min(rect.width / this.canvas.width, rect.height / this.canvas.height);
        const width = this.canvas.width * scale,
            height = this.canvas.height * scale;
        return {
            left: rect.left + (rect.width - width) / 2,
            top: rect.top + (rect.height - height) / 2,
            width,
            height,
        };
    }
    resize() {
        const dpr = Math.min(1.6, devicePixelRatio || 1),
            world = this.renderer?.world || WorldContext.standard;
        const scale =
            Math.min(
                this.canvas.clientWidth / world.width,
                this.canvas.clientHeight / world.height,
            ) * dpr;
        const w = Math.max(1, Math.round(world.width * scale));
        const h = Math.max(1, Math.round(world.height * scale));
        if (this.canvas.width !== w || this.canvas.height !== h) {
            this.canvas.width = w;
            this.canvas.height = h;
        }
    }
    point(authX, authY) {
        const vx = this.renderer.viewX(authX);
        const vy = this.renderer.viewY(authY);
        return [
            (vx / this.renderer.world.width) * this.canvas.width,
            (vy / this.renderer.world.height) * this.canvas.height,
        ];
    }
    dot(x, y, r, color) {
        const c = this.ctx;
        c.beginPath();
        c.arc(x, y, r, 0, Math.PI * 2);
        c.fillStyle = color;
        c.fill();
    }
    drawFog() {
        const r = this.renderer;
        if (!r || r.replayObserverAll) return;
        const w = this.canvas.width,
            h = this.canvas.height,
            field = r.fogVisibilityGrid(64),
            mw = field.w,
            mh = field.h,
            mask = this.fogMask || (this.fogMask = document.createElement('canvas'));
        if (mask.width !== mw || mask.height !== mh) {
            mask.width = mw;
            mask.height = mh;
        }
        const target = field.atGround(r),
            dark = r.replayVisionMode ? [2, 4, 6, 245] : [7, 12, 13, 224],
            darkKey = dark.join(',');
        if (this.fogMaskTarget !== target || this.fogMaskDarkKey !== darkKey) {
            const c = mask.getContext('2d'),
                img = c.createImageData(mw, mh);
            for (let k = 0; k < target.length; k++) {
                const p = k * 4;
                img.data[p] = dark[0];
                img.data[p + 1] = dark[1];
                img.data[p + 2] = dark[2];
                img.data[p + 3] = target[k] ? 0 : dark[3];
            }
            c.putImageData(img, 0, 0);
            this.fogMaskTarget = target;
            this.fogMaskDarkKey = darkKey;
        }
        const out = this.ctx;
        out.save();
        out.imageSmoothingEnabled = true;
        out.imageSmoothingQuality = 'high';
        out.drawImage(mask, 0, 0, mw, mh, 0, 0, w, h);
        out.restore();
    }
    draw() {
        if (!this.renderer || !this.snapshot) return;
        this.lastDrawAt = performance.now();
        this.resize();

        const c = this.ctx,
            w = this.canvas.width,
            h = this.canvas.height,
            s = this.snapshot,
            r = this.renderer;
        c.clearRect(0, 0, w, h);
        TerrainPresentation.fillPlanarGround(c, w, h);

        // 현재 맵 descriptor의 실제 지형을 먼저 표시한다.
        // 미니맵은 전략 지도를 축약한 것이므로 강/고지/등고선을 생략하지 않는다.
        const miniTerrain = MapGeneration.mapTerrainDescriptor(s.mapDescriptor);
        const drawMiniRiverPolygon = (poly, fill) => {
            if (!Array.isArray(poly) || poly.length < 3) return;
            const pts = poly.map((p) => this.point(p.x, p.y));
            c.fillStyle = fill;
            c.beginPath();
            c.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
            c.closePath();
            c.fill();
        };
        drawMiniRiverPolygon(miniTerrain.riverPolygon || [], '#326d84cc');
        for (const poly of miniTerrain.riverBranchPolygons || [])
            drawMiniRiverPolygon(poly, '#39778ccc');
        if (
            (!miniTerrain.riverPolygon || miniTerrain.riverPolygon.length < 3) &&
            (miniTerrain.riverPath || []).length > 1
        ) {
            const pts = miniTerrain.riverPath.map((p) => this.point(p.x, p.y));
            c.lineCap = 'round';
            c.strokeStyle = '#326d84';
            c.lineWidth = Math.max(
                2,
                ((miniTerrain.riverHalfWidth || 80) / this.renderer.world.width) * w * 2,
            );
            c.beginPath();
            c.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
            c.stroke();
        }
        TerrainPresentation.drawMini(
            c,
            s.mapDescriptor,
            (p) => this.point(p.x, p.y),
            w / this.renderer.world.width,
        );
        // 현재 맵 descriptor의 실제 lane을 표시한다.
        const miniLanePoints = s.mapDescriptor?.laneControlPoints || LANE_CONTROL_POINTS;
        for (const lane of s.mapDescriptor?.terrain?.roads?.length
            ? []
            : [
                  { id: 'top', color: '#72b8f477' },
                  { id: 'mid', color: '#ead36e77' },
                  { id: 'bot', color: '#8bd57b77' },
              ]) {
            const pts = miniLanePoints[lane.id].map((p) => this.point(p.x, p.y));
            if (pts.length < 2) continue;
            c.strokeStyle = lane.color;
            c.lineWidth = Math.max(1, w * 0.014);
            c.beginPath();
            c.moveTo(pts[0][0], pts[0][1]);
            for (let i = 1; i < pts.length; i++) c.lineTo(pts[i][0], pts[i][1]);
            c.stroke();
        }

        // 스타크래프트식 미니맵 가시성:
        // 먼저 지형 바탕에 현재 전장 시야 Fog를 적용해 "지금 확보한 시야"를 밝게 구분한다.
        // 알려진 전략 지점은 그 위에 다시 그려 Fog 밖에서도 위치 자체는 계속 읽을 수 있게 한다.
        this.drawFog();

        // TOP / MID / BOT 점령지는 항상 전략 정보로 표시.
        for (const cp of s.capturePoints || []) {
            const p = this.point(cp.x, cp.y);
            const relation = r.factionRelation(cp.owner);
            const col =
                relation === 'friendly' ? '#4d93ff' : relation === 'enemy' ? '#ef5757' : '#c0cbb2';
            ResourceDisplay.drawDepositMarker(
                c,
                p[0],
                p[1],
                4.3,
                cp.resourceType,
                col,
                cp.owner == null && cp.enabled === false,
            );
        }

        for (const m of LaunchPresentation.marks) {
            if (m.clock.expired) continue;
            const p = this.point(m.x, m.y),
                age = RangeUtil.clamp(m.clock.ageMs / LaunchRules.landingMarkMs, 0, 1);
            c.strokeStyle = `rgba(255,228,128,${1 - age})`;
            c.lineWidth = 2;
            c.beginPath();
            c.arc(p[0], p[1], 4 + 8 * age, 0, Math.PI * 2);
            c.stroke();
        }

        // 건물: 양쪽 메인 Base는 고정 전략 정보라 항상 표시.
        // 그 외 적 건물만 실제 현재 시야가 있을 때 표시한다.
        for (const b of s.buildings) {
            if (b.alive === false) continue;
            const own = r.isFriendlySide(b.side);
            const mainBase = BuildingDefinition.get(b.type)?.isMainBase;
            if (!own && !mainBase && !r.visibleRaw(b.x, b.y)) continue;
            const p = this.point(b.x, b.y);
            if (own) {
                c.fillStyle = '#4c8fff';
            } else if (mainBase) {
                c.fillStyle = '#ef5757';
            } else {
                c.fillStyle = '#ef5757';
            }
            const size = mainBase ? 5 : BuildingDefinition.get(b.type)?.isOutpost ? 4 : 3;
            c.fillRect(p[0] - size / 2, p[1] - size / 2, size, size);
        }

        // 유닛: 아군은 항상, 적은 실제 시야 안에서만.
        for (const u of s.units) {
            if (!u.alive) continue;
            const own = r.isFriendlySide(u.side);
            if (!own && !r.visibleRaw(u.x, u.y)) continue;
            const p = this.point(u.x, u.y);
            this.dot(p[0], p[1], 1.55, own ? '#64a1ff' : '#ff6666');
        }

        // 깃발
        const f = s.flags?.[r.mySide()];
        if (f) {
            const p = this.point(f.x, f.y);
            c.strokeStyle = f.forced ? '#ff9f2f' : '#ffe36d';
            c.lineWidth = 1.4;
            c.beginPath();
            c.moveTo(p[0] - 3, p[1]);
            c.lineTo(p[0] + 3, p[1]);
            c.moveTo(p[0], p[1] - 3);
            c.lineTo(p[0], p[1] + 3);
            c.stroke();
        }

        // 현재 카메라 뷰포트. cameraLeft/Top 자체가 이미 사용자 시점 좌표다.
        c.strokeStyle = '#ffffff';
        c.lineWidth = Math.max(1, window.devicePixelRatio || 1);
        c.beginPath();
        const corners = [
            [0, 0],
            [r.canvas.width, 0],
            [r.canvas.width, r.canvas.height],
            [0, r.canvas.height],
        ];
        for (let i = 0; i < corners.length; i++) {
            const a = corners[i],
                b = corners[(i + 1) % corners.length];
            for (let j = 0; j < 4; j++) {
                const t = j / 4,
                    p = r.surfaceAtScreen(a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t);
                const q = this.point(
                    RangeUtil.clamp(p.x, 0, r.world.width),
                    RangeUtil.clamp(p.z, 0, r.world.height),
                );
                if (!i && !j) c.moveTo(...q);
                else c.lineTo(...q);
            }
        }
        c.closePath();
        c.stroke();
    }
}

const audioSystem = new AudioSystem();

/* =========================
   7. UI wiring
   ========================= */
class DomUtil {
    static byId(id) {
        return document.getElementById(id);
    }
}
class UiRegistry {
    static refs = {
        p2pHealth: DomUtil.byId('p2pHealth'),
        p2pHealthText: DomUtil.byId('p2pHealthText'),
        lobby: DomUtil.byId('lobby'),
        game: DomUtil.byId('gameScreen'),
        createDialog: DomUtil.byId('createDialog'),
        joinDialog: DomUtil.byId('joinDialog'),
        createClose: DomUtil.byId('createCloseBtn'),
        joinClose: DomUtil.byId('joinCloseBtn'),
        createStatus: DomUtil.byId('createStatus'),
        createRetry: DomUtil.byId('createRetryBtn'),
        joinConfirm: DomUtil.byId('joinConfirmBtn'),
        room: DomUtil.byId('roomInput'),
        codeArea: DomUtil.byId('hostCodeArea'),
        code: DomUtil.byId('hostCode'),
        joinError: DomUtil.byId('joinError'),
        canvas: DomUtil.byId('glCanvas'),
        minimapCanvas: DomUtil.byId('minimapCanvas'),
        result: DomUtil.byId('result'),
        resultTitle: DomUtil.byId('resultTitle'),
        resultText: DomUtil.byId('resultText'),
        rematch: DomUtil.byId('rematchBtn'),
    };
}

UiRegistry.refs.lockstepDebugPanel = DomUtil.byId('lockstepDebugPanel');
UiRegistry.refs.lockstepDebugCloseBtn = DomUtil.byId('lockstepDebugCloseBtn');
UiRegistry.refs.manualRecoveryBtn = DomUtil.byId('manualRecoveryBtn');
UiRegistry.refs.fullConnectionResetBtn = DomUtil.byId('fullConnectionResetBtn');
UiRegistry.refs.lockstepDebugResetBtn = DomUtil.byId('lockstepDebugResetBtn');
UiRegistry.refs.recoveryLogExportBtn = DomUtil.byId('recoveryLogExportBtn');
UiRegistry.refs.balanceTelemetryExportBtn = DomUtil.byId('balanceTelemetryExportBtn');
UiRegistry.refs.lockstepDebugSummary = DomUtil.byId('lockstepDebugSummary');
UiRegistry.refs.lockstepDebugVerdict = DomUtil.byId('lockstepDebugVerdict');
UiRegistry.refs.synctestRunBtn = DomUtil.byId('synctestRunBtn');
UiRegistry.refs.dbgSyncStatus = DomUtil.byId('dbgSyncStatus');
UiRegistry.refs.dbgSyncChecked = DomUtil.byId('dbgSyncChecked');
UiRegistry.refs.dbgSyncResimulated = DomUtil.byId('dbgSyncResimulated');
UiRegistry.refs.dbgSyncDistance = DomUtil.byId('dbgSyncDistance');
UiRegistry.refs.dbgSyncHash = DomUtil.byId('dbgSyncHash');
UiRegistry.refs.dbgSyncBytes = DomUtil.byId('dbgSyncBytes');
UiRegistry.refs.dbgSyncCost = DomUtil.byId('dbgSyncCost');
UiRegistry.refs.dbgSyncFailure = DomUtil.byId('dbgSyncFailure');
UiRegistry.refs.dbgCoreLatency = DomUtil.byId('dbgCoreLatency');
for (const id of [
    'dbgPerfInputDelay',
    'dbgPerfCommandConfirm',
    'dbgPerfCommandPending',
    'dbgPerfIceRtt',
    'dbgPerfEventLoop',
    'dbgPerfLongTask',
    'dbgPerfPulseGap',
    'dbgPerfPulse',
    'dbgPerfStateSave',
    'dbgPerfResimulation',
    'dbgPerfPresentation',
    'dbgPerfFrameInterval',
    'dbgPerfDeviceBegin',
    'dbgPerfRenderPasses',
    'dbgPerfRenderEffects',
    'dbgPerfRenderTail',
    'dbgPerfNavigation',
    'dbgPerfProjection',
    'dbgPerfDrawCalls',
    'performanceTimingExportBtn',
])
    UiRegistry.refs[id] = DomUtil.byId(id);
UiRegistry.refs.dbgCorePacing = DomUtil.byId('dbgCorePacing');
UiRegistry.refs.dbgCorePrediction = DomUtil.byId('dbgCorePrediction');
UiRegistry.refs.dbgCoreHistory = DomUtil.byId('dbgCoreHistory');
UiRegistry.refs.dbgCoreStatus = DomUtil.byId('dbgCoreStatus');
UiRegistry.refs.dbgCoreRollback = DomUtil.byId('dbgCoreRollback');
UiRegistry.refs.dbgCoreRecovery = DomUtil.byId('dbgCoreRecovery');
UiRegistry.refs.dbgCoreBytes = DomUtil.byId('dbgCoreBytes');
UiRegistry.refs.dbgPerfStep = DomUtil.byId('dbgPerfStep');
UiRegistry.refs.dbgPerfPeerStep = DomUtil.byId('dbgPerfPeerStep');
UiRegistry.refs.dbgPerfCore = DomUtil.byId('dbgPerfCore');
UiRegistry.refs.dbgPerfCombat = DomUtil.byId('dbgPerfCombat');
UiRegistry.refs.dbgPerfTail = DomUtil.byId('dbgPerfTail');
UiRegistry.refs.dbgPerfSnapshot = DomUtil.byId('dbgPerfSnapshot');
UiRegistry.refs.dbgPerfEntities = DomUtil.byId('dbgPerfEntities');
UiRegistry.refs.dbgPerfSpatial = DomUtil.byId('dbgPerfSpatial');
UiRegistry.refs.dbgPerfTarget = DomUtil.byId('dbgPerfTarget');
UiRegistry.refs.dbgPerfCollision = DomUtil.byId('dbgPerfCollision');
UiRegistry.refs.dbgPerfRender = DomUtil.byId('dbgPerfRender');
UiRegistry.refs.dbgPerfAllowanceLabel = DomUtil.byId('dbgPerfAllowanceLabel');
UiRegistry.refs.dbgPerfAllowance = DomUtil.byId('dbgPerfAllowance');
UiRegistry.refs.dbgPerfUsedLabel = DomUtil.byId('dbgPerfUsedLabel');
UiRegistry.refs.dbgPerfUsed = DomUtil.byId('dbgPerfUsed');
UiRegistry.refs.dbgPerfBudgetLabel = DomUtil.byId('dbgPerfBudgetLabel');
UiRegistry.refs.dbgPerfBudget = DomUtil.byId('dbgPerfBudget');
UiRegistry.refs.dbgPerfCollisionCore = DomUtil.byId('dbgPerfCollisionCore');
UiRegistry.refs.dbgPerfCollisionTail = DomUtil.byId('dbgPerfCollisionTail');
UiRegistry.refs.dbgPerfCombatSplit = DomUtil.byId('dbgPerfCombatSplit');
UiRegistry.refs.dbgPerfCollisionSweepFlow = DomUtil.byId('dbgPerfCollisionSweepFlow');
UiRegistry.refs.dbgPerfCollisionHardFixFlow = DomUtil.byId('dbgPerfCollisionHardFixFlow');
UiRegistry.refs.dbgEndurancePeaks = DomUtil.byId('dbgEndurancePeaks');
UiRegistry.refs.dbgBalanceTime = DomUtil.byId('dbgBalanceTime');
UiRegistry.refs.dbgBalanceCombat = DomUtil.byId('dbgBalanceCombat');
UiRegistry.refs.dbgBalanceCapture = DomUtil.byId('dbgBalanceCapture');
UiRegistry.refs.dbgBalanceArmy = DomUtil.byId('dbgBalanceArmy');
UiRegistry.refs.dbgBalanceLosses = DomUtil.byId('dbgBalanceLosses');

UiRegistry.refs.gameStartBtn = DomUtil.byId('gameStartBtn');
UiRegistry.refs.singleStatus = DomUtil.byId('singleStatus');

UiRegistry.refs.installPwaBtn = DomUtil.byId('installPwaBtn');
UiRegistry.refs.installPwaMeta = DomUtil.byId('installPwaMeta');
UiRegistry.refs.installGuideBtn = DomUtil.byId('installGuideBtn');
UiRegistry.refs.installGuideModal = DomUtil.byId('installGuideModal');
UiRegistry.refs.installGuideBackdrop = DomUtil.byId('installGuideBackdrop');
UiRegistry.refs.installGuideCloseBtn = DomUtil.byId('installGuideCloseBtn');
UiRegistry.refs.installGuideDoneBtn = DomUtil.byId('installGuideDoneBtn');
UiRegistry.refs.bootGate = DomUtil.byId('bootGate');
UiRegistry.refs.bootTitle = DomUtil.byId('bootTitle');
UiRegistry.refs.bootStatus = DomUtil.byId('bootStatus');
UiRegistry.refs.bootProgressBar = DomUtil.byId('bootProgressBar');
UiRegistry.refs.bootBuild = DomUtil.byId('bootBuild');
UiRegistry.refs.bootRetryBtn = DomUtil.byId('bootRetryBtn');

UiRegistry.refs.replayOpenBtn = DomUtil.byId('replayOpenBtn');
UiRegistry.refs.replayFileInput = DomUtil.byId('replayFileInput');
UiRegistry.refs.replayWatchBtn = DomUtil.byId('replayWatchBtn');
UiRegistry.refs.replaySaveBtn = DomUtil.byId('replaySaveBtn');
UiRegistry.refs.replayDock = DomUtil.byId('replayDock');
UiRegistry.refs.replayPlayPauseBtn = DomUtil.byId('replayPlayPauseBtn');
UiRegistry.refs.replayStepBackBtn = DomUtil.byId('replayStepBackBtn');
UiRegistry.refs.replayStepForwardBtn = DomUtil.byId('replayStepForwardBtn');
UiRegistry.refs.replayStepBack30Btn = DomUtil.byId('replayStepBack30Btn');
UiRegistry.refs.replayStepForward30Btn = DomUtil.byId('replayStepForward30Btn');
UiRegistry.refs.replayTimeline = DomUtil.byId('replayTimeline');
UiRegistry.refs.replayTime = DomUtil.byId('replayTime');
UiRegistry.refs.replayTimeInput = DomUtil.byId('replayTimeInput');
UiRegistry.refs.replayTimeGoBtn = DomUtil.byId('replayTimeGoBtn');
UiRegistry.refs.replaySpeed = DomUtil.byId('replaySpeed');
UiRegistry.refs.replayExitBtn = DomUtil.byId('replayExitBtn');
UiRegistry.refs.replayHostViewBtn = DomUtil.byId('replayHostViewBtn');
UiRegistry.refs.replayGuestViewBtn = DomUtil.byId('replayGuestViewBtn');
UiRegistry.refs.replayAllViewBtn = DomUtil.byId('replayAllViewBtn');
UiRegistry.refs.replayHostOrientationBtn = DomUtil.byId('replayHostOrientationBtn');
UiRegistry.refs.replayGuestOrientationBtn = DomUtil.byId('replayGuestOrientationBtn');
UiRegistry.refs.replayZoomOutBtn = DomUtil.byId('replayZoomOutBtn');
UiRegistry.refs.replayZoomInBtn = DomUtil.byId('replayZoomInBtn');
UiRegistry.refs.replayZoomValue = DomUtil.byId('replayZoomValue');
UiRegistry.refs.replayStats = DomUtil.byId('replayStats');
UiRegistry.refs.matchMenuBtnGame = DomUtil.byId('matchMenuBtnGame');
UiRegistry.refs.matchMenuModal = DomUtil.byId('matchMenuModal');
UiRegistry.refs.matchMenuBackdrop = DomUtil.byId('matchMenuBackdrop');
UiRegistry.refs.matchMenuCloseBtn = DomUtil.byId('matchMenuCloseBtn');
UiRegistry.refs.matchMenuContinueBtn = DomUtil.byId('matchMenuContinueBtn');
UiRegistry.refs.matchMenuReplaySaveBtn = DomUtil.byId('matchMenuReplaySaveBtn');
UiRegistry.refs.matchMenuHelpBtn = DomUtil.byId('matchMenuHelpBtn');
UiRegistry.refs.matchMenuSurrenderBtn = DomUtil.byId('matchMenuSurrenderBtn');
UiRegistry.refs.matchMenuLeaveBtn = DomUtil.byId('matchMenuLeaveBtn');
UiRegistry.refs.matchMenuWarning = DomUtil.byId('matchMenuWarning');
UiRegistry.refs.disconnectGate = DomUtil.byId('disconnectGate');
UiRegistry.refs.disconnectGateTitle = DomUtil.byId('disconnectGateTitle');
UiRegistry.refs.disconnectGateCount = DomUtil.byId('disconnectGateCount');
UiRegistry.refs.disconnectGateCopy = DomUtil.byId('disconnectGateCopy');
UiRegistry.refs.disconnectGateActions = DomUtil.byId('disconnectGateActions');
UiRegistry.refs.disconnectReconnectBtn = DomUtil.byId('disconnectReconnectBtn');
UiRegistry.refs.disconnectSurrenderBtn = DomUtil.byId('disconnectSurrenderBtn');

UiRegistry.refs.launchHand = DomUtil.byId('launchHand');
UiRegistry.refs.launchCards = DomUtil.byId('launchCards');
UiRegistry.refs.launchResources = DomUtil.byId('launchResources');
UiRegistry.refs.launchPopulationText = DomUtil.byId('launchPopulationText');
UiRegistry.refs.launchReachText = DomUtil.byId('launchReachText');
UiRegistry.refs.launchRangeBtn = DomUtil.byId('launchRangeBtn');
UiRegistry.refs.launchRangeText = DomUtil.byId('launchRangeText');
UiRegistry.refs.launchRangeCost = DomUtil.byId('launchRangeCost');
UiRegistry.refs.launchRangeStatus = DomUtil.byId('launchRangeStatus');
UiRegistry.refs.launchRangeBtn?.addEventListener('click', () => LaunchPresentation.upgradeRange());
UiRegistry.refs.launchCards?.addEventListener('pointerdown', (e) =>
    LaunchPresentation.pressHeroCard(e),
);
UiRegistry.refs.launchCards?.addEventListener('pointermove', (e) =>
    LaunchPresentation.moveHeroPress(e),
);
UiRegistry.refs.launchCards?.addEventListener('pointerout', (e) => {
    const press = LaunchPresentation.heroPress;
    if (press?.pointerId === e.pointerId && !press.button.contains(e.relatedTarget))
        LaunchPresentation.endHeroPress(true);
});
for (const type of ['pointerup', 'pointercancel', 'lostpointercapture']) {
    UiRegistry.refs.launchCards?.addEventListener(type, (e) => {
        if (LaunchPresentation.heroPress?.pointerId === e.pointerId)
            LaunchPresentation.endHeroPress(type !== 'pointerup');
    });
}
UiRegistry.refs.launchCards?.addEventListener('contextmenu', (e) => {
    if (e.pointerType !== 'touch' && e.button !== 0) return;
    const press = LaunchPresentation.heroPress || LaunchPresentation.heroPressClick;
    if (press?.button.contains(e.target) && !e.target.closest('[data-card-info]'))
        e.preventDefault();
});
UiRegistry.refs.launchCards?.addEventListener('keydown', (e) => LaunchPresentation.heroSkillKey(e));
window.addEventListener('blur', () => LaunchPresentation.endHeroPress(true));
UiRegistry.refs.launchCards?.addEventListener('click', (e) => {
    const button = e.target.closest('[data-launch-card]');
    if (button && !LaunchPresentation.consumeHeroClick(e, button))
        LaunchPresentation.selectCard(button.dataset.launchCard);
});

const UI_RADIO = Object.freeze({
    screen: new Set(['lobby', 'game', 'replay', 'result']),
    modal: new Set(['none', 'create', 'join', 'match-menu', 'disconnect']),
    command: new Set(['closed', 'tree', 'building']),
});
// UI STATE CONTRACT:
// Radio: screen/modal/command.branch; Tree: command category/page + modalState phases;
// Checkbox: only independent options. DOM classes are derived output, never app-state input.
// Async/transient gesture/network booleans may remain local when simultaneous truth is valid.
class UiRuntimeState {
    static value = {
        screen: 'lobby',
        modal: 'none',
        modalState: { disconnect: 'hidden' },
        options: { minimapExpanded: false, lockstepDebugOpen: false },
        settings: { presetId: 'standard', simulationTps: 10 },
    };
}

/* DOM write ownership contract:
   UiController is the sole generic visibility/screen/modal writer.
   Domain Presentation owners write their own content and domain-local visual state only.
   CSS owns layout/appearance, never application visibility; component display rules must
   not override the shared hidden state. */
class UiController {
    static setElementVisible(ref, visible) {
        if (!ref) return false;
        ref.classList.toggle('hidden', !visible);
        return !!visible;
    }
    static setUiRadio(group, value) {
        const allowed = UI_RADIO[group];
        if (!allowed?.has(value)) throw new Error(`Invalid UI ${group}: ${value}`);
        UiRuntimeState.value[group] = value;
        return value;
    }
    static setUiScreen(value) {
        UiController.setUiRadio('screen', value);
        if (value !== 'game') CampaignPresentation.clearBattle();
        UiController.renderUiState();
        LaunchScreens.syncScreen(value);
        return value;
    }
    static setUiModal(value) {
        const prev = UiRuntimeState.value.modal;
        UiController.setUiRadio('modal', value);
        if (prev === 'disconnect' && value !== 'disconnect')
            UiRuntimeState.value.modalState.disconnect = 'hidden';
        return value;
    }
    static openDialog(d) {
        if (typeof d.showModal === 'function') {
            if (!d.open) d.showModal();
        } else {
            d.setAttribute('open', '');
        }
    }
    static closeDialog(d) {
        if (typeof d.close === 'function' && d.open) d.close();
        else d.removeAttribute('open');
    }
    static syncModalState() {
        for (const [kind, key] of Object.entries(UI_MODAL_DIALOG_KEYS)) {
            const el = UiRegistry.refs[key],
                should = UiRuntimeState.value.modal === kind;
            if (!el) continue;
            if (should) {
                if (!el.open) UiController.openDialog(el);
            } else if (el.open) UiController.closeDialog(el);
        }
        UiRegistry.refs.matchMenuModal?.classList.toggle(
            'hidden',
            UiRuntimeState.value.modal !== 'match-menu',
        );
        UiRegistry.refs.disconnectGate?.classList.toggle(
            'hidden',
            UiRuntimeState.value.modal !== 'disconnect',
        );
    }
    static openUiModal(kind) {
        UiController.setUiModal(kind);
        UiController.syncModalState();
        return kind;
    }
    static closeUiModal(kind = UiRuntimeState.value.modal) {
        if (UiRuntimeState.value.modal !== kind) return false;
        UiController.setUiModal('none');
        UiController.syncModalState();
        return true;
    }
    static setStartSimulationTps(value) {
        UiRuntimeState.value.settings.simulationTps = RangeUtil.clamp(
            Math.round(Number(value) || 10),
            10,
            30,
        );
    }
    static openJoinDialog() {
        if (MatchLifecycle.singleMatch || ActiveViewState.session?.sim) return false;
        MatchLifecycle.cancelOnlinePreparation();
        UiRegistry.refs.joinError.textContent = '';
        UiRegistry.refs.room.value = '';
        UiRegistry.refs.joinConfirm.disabled = false;
        UiRegistry.refs.joinConfirm.textContent = '참가하기';

        UiController.openUiModal('join');

        // 모바일에서는 다이얼로그를 연 직후 입력칸을 강제 focus하지 않는다.
        // 사용자가 입력칸을 탭했을 때 키보드가 열리는 일반적인 동작을 따른다.
    }
    static renderUiState() {
        const screen = UiRuntimeState.value.screen;
        UiRegistry.refs.lobby?.classList.toggle('hidden', screen !== 'lobby');
        // screen state maps 1:1 to sibling DOM screens.
        const gameShellVisible = screen === 'game' || screen === 'replay';
        UiRegistry.refs.game?.classList.toggle('hidden', !gameShellVisible);
        document.body.classList.toggle('playing', gameShellVisible);
        document.body.classList.toggle('replay-mode', screen === 'replay');
        document.body.classList.toggle('result-mode', screen === 'result');
        UiRegistry.refs.result?.classList.toggle('hidden', screen !== 'result');
        if (typeof UiController.syncModalState === 'function') UiController.syncModalState();
        UiRegistry.refs.lockstepDebugPanel?.classList.toggle(
            'hidden',
            !UiRuntimeState.value.options.lockstepDebugOpen,
        );
        UiRegistry.refs.p2pHealth?.setAttribute(
            'aria-expanded',
            UiRuntimeState.value.options.lockstepDebugOpen ? 'true' : 'false',
        );
    }
    static viewToAuth(x, y) {
        return ActiveViewState.role === 'guest'
            ? {
                  x: (ActiveViewState.renderer?.world || WorldContext.standard).width - x,
                  y: (ActiveViewState.renderer?.world || WorldContext.standard).height - y,
              }
            : { x, y };
    }
    static bindImmediateButton(btn, handler) {
        if (!btn) return;
        btn.addEventListener('click', (e) => {
            if (btn.disabled) return;
            e.preventDefault();
            handler(e);
        });
    }
}

window.addEventListener('resize', () =>
    requestAnimationFrame(() => ConnectionPresentation.positionP2PHealthNextToMenu()),
);
window.addEventListener('orientationchange', () =>
    setTimeout(() => ConnectionPresentation.positionP2PHealthNextToMenu(), 80),
);

class DebugFormatUtil {
    static formatDebugBytes(bytes) {
        const n = Number(bytes) || 0;
        if (n < 1024) return n + ' B';
        if (n < 1024 * 1024) return (n / 1024).toFixed(1) + ' KB';
        return (n / (1024 * 1024)).toFixed(2) + ' MB';
    }
}

class ConnectionPresentation {
    static showVersionMismatch(info, role) {
        const message = String(
            info.message || '게임 버전이 다릅니다. 양쪽 모두 같은 최신 HTML을 사용하세요.',
        );
        LogUtil.status(message);
        if (SinglePlayerModeUtil.isSinglePlayer()) {
            UiRegistry.refs.singleStatus.textContent = message;
            UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
            MatchLifecycle.stopSinglePlayer();
        } else if (role === 'host') {
            UiRegistry.refs.createStatus.textContent =
                message + ' · 현재 방은 참가 대기를 유지합니다.';
        } else {
            UiRegistry.refs.joinError.textContent = message;
            MatchLifecycle.setJoinBusy(false);
        }
        LogUtil.log(message);
    }

    static lastP2PHealthInfo = null;
    static lastP2PHealthLocal = false;

    static openLockstepDebugPanel() {
        UiRuntimeState.value.options.lockstepDebugOpen = true;
        UiController.renderUiState();
        ConnectionPresentation.renderLockstepDebugPanel();
    }
    static closeLockstepDebugPanel() {
        UiRuntimeState.value.options.lockstepDebugOpen = false;
        UiController.renderUiState();
    }
    static renderP2PHealth(info, isLocal = false) {
        if (!info) return;
        const netcode = MatchLifecycle.activeSession?.()?.netcodeSession;
        if (netcode) {
            const state = {
                running: 'connected',
                resimulating: 'connected',
                synchronizing: 'unstable',
                recovering: 'unstable',
                interrupted: 'unstable',
                disconnected: 'disconnected',
                failed: 'fatal',
                closed: 'disconnected',
            }[netcode.status];
            info = {
                ...info,
                rtt: netcode.metrics.smoothedRTT,
                state: info.state === 'fatal' ? 'fatal' : state || info.state,
            };
        }
        ConnectionPresentation.lastP2PHealthInfo = info;
        ConnectionPresentation.lastP2PHealthLocal = !!isLocal;
        UiRegistry.refs.p2pHealth.classList.remove(
            'hidden',
            'connected',
            'unstable',
            'disconnected',
            'fatal',
        );
        const state = info.state || 'connected';
        UiRegistry.refs.p2pHealth.classList.add(state === 'fatal' ? 'disconnected' : state);
        if (state === 'fatal') UiRegistry.refs.p2pHealthText.textContent = '오류';
        else if (state === 'disconnected') UiRegistry.refs.p2pHealthText.textContent = '끊김';
        else if (state === 'unstable')
            UiRegistry.refs.p2pHealthText.textContent =
                info.rtt == null ? '불안정' : `⚠ ${Math.round(info.rtt)}ms`;
        else
            UiRegistry.refs.p2pHealthText.textContent =
                info.rtt == null ? (isLocal ? '● LOCAL' : '● P2P') : `● ${Math.round(info.rtt)}ms`;
        const active = MatchLifecycle.activeSession?.(),
            rp = ActiveViewState.renderer?.perfStats,
            detail = [];
        if (info.rtt != null) detail.push(`RTT ${Math.round(info.rtt)}ms`);
        if (active?.sim)
            detail.push(
                active.netcodeMode,
                `tick ${active.sim.tick}`,
                `${ActiveSimulationTiming.tps()} TPS`,
            );
        if (rp?.fps > 0) detail.push(`${Math.round(rp.fps)} FPS`);
        UiRegistry.refs.p2pHealth.title = detail.join(' · ') || '동기화 진단 열기';
        ConnectionPresentation.positionP2PHealthNextToMenu();
    }
    static renderLockstepDebugPanel() {
        if (!UiRuntimeState.value.options.lockstepDebugOpen) return;
        const active = MatchLifecycle.activeSession?.();

        if (!active?.netcodeSession) {
            for (const el of UiRegistry.refs.lockstepDebugPanel.querySelectorAll(
                '#performanceTimingPanel b',
            ))
                el.textContent = '-';
            UiRegistry.refs.lockstepDebugSummary.textContent =
                '활성 경기에서 확정 입력을 검사할 수 있습니다.';
            UiRegistry.refs.synctestRunBtn.disabled = true;
            return;
        }
        const core = active.netcodeSession,
            metrics = core.metrics,
            report = RallySynctestDiagnostics.report(active),
            sync = report?.metrics;
        const text = (id, value) => {
            UiRegistry.refs[id].textContent = value;
        };
        text('dbgSyncStatus', report?.status || '미실행');
        text('dbgSyncChecked', sync ? String(sync.checkedTicks) : '-');
        text('dbgSyncResimulated', sync ? String(sync.resimulatedTicks) : '-');
        text('dbgSyncDistance', sync ? String(sync.checkDistance) : '-');
        text(
            'dbgSyncHash',
            sync?.stateHash != null ? sync.stateHash.toString(16).padStart(8, '0') : '-',
        );
        text('dbgSyncBytes', sync ? DebugFormatUtil.formatDebugBytes(sync.historyBytes) : '-');
        text('dbgSyncCost', sync ? Number(sync.totalCostMs).toFixed(2) + 'ms' : '-');
        const failure = sync?.failure;
        text(
            'dbgSyncFailure',
            failure?.code === 'determinism-mismatch'
                ? 'S[' +
                      failure.tick +
                      '] · byte ' +
                      failure.firstDifference +
                      ' · ' +
                      failure.expectedHash.toString(16).padStart(8, '0') +
                      ' / ' +
                      failure.actualHash.toString(16).padStart(8, '0')
                : failure?.message || report?.error || '없음',
        );
        text(
            'dbgCoreLatency',
            metrics.smoothedRTT.toFixed(2) + 'ms / ' + metrics.jitter.toFixed(2) + 'ms',
        );
        text('dbgCorePacing', metrics.holds + ' / ' + metrics.stalls + ' / ' + metrics.pace);
        text(
            'dbgCorePrediction',
            metrics.predictedTicks + ' / ' + metrics.lateInputRate.toFixed(4),
        );
        text(
            'dbgCoreHistory',
            DebugFormatUtil.formatDebugBytes(metrics.retainedSnapshotBytes) +
                ' / ' +
                metrics.stateHashComputations,
        );
        text('dbgCoreStatus', core.profile.mode + ' / ' + core.status + ' / ' + core.confirmedTick);
        text(
            'dbgCoreRollback',
            metrics.inputDelay + 't / ' + metrics.rollbacks + ' / ' + metrics.resimulatedTicks,
        );
        text(
            'dbgCoreRecovery',
            metrics.hashMismatches + ' / ' + metrics.recoveries + ' / ' + metrics.rejectedSnapshots,
        );
        text(
            'dbgCoreBytes',
            DebugFormatUtil.formatDebugBytes(metrics.sentBytes) +
                ' / ' +
                DebugFormatUtil.formatDebugBytes(metrics.receivedBytes),
        );
        UiRegistry.refs.synctestRunBtn.disabled =
            report?.status === 'running' || core.resimulating || active.disposed;
        const perf = active.sim?.perfStats || createLocalPerfStats();
        const fmtMs = (v) => `${(Number(v) || 0).toFixed(2)}ms`;
        const peerRole = active.role === 'host' ? 'guest' : 'host';
        const peerPerf = SinglePlayerModeUtil.isSinglePlayer()
            ? MatchLifecycle.singleMatch?.sessions?.[peerRole]?.sim?.perfStats
            : null;
        const avgCandidates = perf.spatialQueries
            ? perf.spatialCandidates / perf.spatialQueries
            : 0;
        UiRegistry.refs.dbgPerfStep.textContent = `${fmtMs(perf.lastStepMs)} / ${fmtMs(perf.ewmaStepMs)} / ${fmtMs(perf.maxStepMs)}`;
        UiRegistry.refs.dbgPerfPeerStep.textContent = peerPerf
            ? `${peerRole} ${fmtMs(peerPerf.lastStepMs)} / EWMA ${fmtMs(peerPerf.ewmaStepMs)}`
            : '-';
        UiRegistry.refs.dbgPerfCore.textContent = `${fmtMs(perf.indexMs)} / ${fmtMs(perf.worldMs)}`;
        UiRegistry.refs.dbgPerfCombat.textContent = `${fmtMs(perf.visionMs)} / ${fmtMs(perf.combatMs)}`;
        UiRegistry.refs.dbgPerfTail.textContent = `${fmtMs(perf.projectileMs)} / ${fmtMs(perf.collisionMs)} / ${fmtMs(perf.postMs)}`;
        UiRegistry.refs.dbgPerfSnapshot.textContent = perf.snapshotSamples
            ? `${fmtMs(perf.snapshotMs)} / ${fmtMs(perf.maxSnapshotMs)}`
            : '표본 수집 중';
        UiRegistry.refs.dbgPerfEntities.textContent = `${perf.aliveUnits || 0} / ${perf.combatUnits || 0} / ${perf.projectiles || 0}`;
        UiRegistry.refs.dbgPerfSpatial.textContent = `${perf.spatialQueries || 0} / ${perf.spatialCandidates || 0} (${avgCandidates.toFixed(1)})`;
        UiRegistry.refs.dbgPerfTarget.textContent = `target ${perf.targetQueries || 0} · reject ${perf.targetVisibilityRejects || 0} / vis ${perf.visibilityChecks || 0} · sideQ ${perf.sideSpatialQueries || 0}`;
        UiRegistry.refs.dbgPerfCombatSplit.textContent = `${fmtMs(perf.combatTargetPickMs)} / ${fmtMs(perf.combatOtherMs)} · ${perf.combatTargetPickCalls || 0} target calls`;
        UiRegistry.refs.dbgPerfCollision.textContent = `${perf.collisionPairs || 0} / ${perf.collisionSoftContacts || 0} / ${perf.collisionSoftMovedUnits || 0} / ${perf.collisionSoftCappedUnits || 0} / ${perf.collisionSoftPasses || 0}`;
        UiRegistry.refs.dbgPerfCollisionCore.textContent = `${fmtMs(perf.collisionPrepMs)} / ${fmtMs(perf.collisionGridBuildMs)} / ${fmtMs(perf.collisionPairScanMs)} / ${fmtMs(perf.collisionSoftApplyMs)}`;
        UiRegistry.refs.dbgPerfCollisionTail.textContent = `${fmtMs(perf.collisionSweptMotionMs)} / ${fmtMs(perf.collisionTerrainMs)} / ${fmtMs(perf.collisionHardFixMs)} / ${fmtMs(perf.collisionOtherMs)}`;
        UiRegistry.refs.dbgPerfCollisionSweepFlow.textContent = `${perf.collisionSweptCalls || 0} / ${perf.collisionSweptActivePasses || 0} / ${perf.collisionSweptPairTests || 0} / ${perf.collisionSweptHits || 0} / ${perf.collisionSweptCorrectionUnits || 0} / ${perf.collisionSweptNoCorrectionPasses || 0}`;
        UiRegistry.refs.dbgPerfCollisionHardFixFlow.textContent = `${perf.collisionHardFixCalls || 0} / ${perf.collisionHardFixPasses || 0} / ${perf.collisionHardFixActivePairTests || 0} / ${perf.collisionHardFixCandidates || 0} / ${perf.collisionHardFixCorrections || 0} / ${perf.collisionHardFixNoOpCalls || 0}`;
        const rp = ActiveViewState.renderer?.perfStats;
        UiRegistry.refs.dbgPerfRender.textContent = rp
            ? `${(rp.fps || 0).toFixed(1)} FPS / ${fmtMs(rp.ewmaFrameWorkMs)} (max ${fmtMs(rp.maxFrameWorkMs)})`
            : '-';
        const stats = active.performanceStats,
            t = stats.timings,
            m = PerformanceTelemetry.runtimeMonitor;
        const timing = (row) =>
            row?.samples
                ? `${fmtMs(row.currentMs)} / ${fmtMs(row.ewmaMs)} / ${fmtMs(row.maxMs)}`
                : '표본 수집 중';
        PerformanceTelemetry.sampleConnection(active);
        text(
            'dbgPerfInputDelay',
            `${metrics.inputDelay}t · ${fmtMs((metrics.inputDelay * 1000) / active.sim.tps)}`,
        );
        text(
            'dbgPerfCommandConfirm',
            t.commandConfirm?.samples ? timing(t.commandConfirm) : '입력 없음',
        );
        const commandNow = performance.now();
        let pendingCommandMs = 0;
        for (const ticket of active.pendingNetcodeCommands.values())
            if (Number.isFinite(ticket.submittedAt))
                pendingCommandMs = Math.max(pendingCommandMs, commandNow - ticket.submittedAt);
        text(
            'dbgPerfCommandPending',
            `${active.pendingNetcodeCommands.size}개 · ${fmtMs(pendingCommandMs)}`,
        );
        const iceAge = stats.iceFetchedAt === null ? null : performance.now() - stats.iceFetchedAt;
        text(
            'dbgPerfIceRtt',
            !active.transport?.room?.peerConnection?.getStats
                ? '지원 안 됨'
                : stats.iceError
                  ? '조회 실패'
                  : stats.iceRttMs === null
                    ? 'ICE RTT 표본 없음'
                    : `${fmtMs(stats.iceRttMs)} · ${fmtMs(iceAge)} 전 조회`,
        );
        text(
            'dbgPerfEventLoop',
            timing(m?.timings.eventLoop) + (document.hidden ? ' · 백그라운드' : ''),
        );
        text(
            'dbgPerfLongTask',
            !m?.observer
                ? '지원 안 됨'
                : `${m.longTasks}회 · 최근 ${fmtMs(m.longTaskMs)} / 최대 ${fmtMs(m.maxLongTaskMs)}`,
        );
        text('dbgPerfPulseGap', timing(t.pulseGap));
        text('dbgPerfPulse', timing(t.pulse));
        text('dbgPerfStateSave', timing(t.save));
        text(
            'dbgPerfResimulation',
            metrics.resimulatedTicks
                ? `${fmtMs(metrics.latestResimulationMs)} / ${fmtMs(metrics.resimulationCostMs)}`
                : '미실행',
        );
        text(
            'dbgPerfPresentation',
            `Targets ${timing(t.renderTargets)} · UI ${timing(t.snapshotUi)}`,
        );
        text(
            'dbgPerfFrameInterval',
            rp
                ? `${fmtMs(rp.frameIntervalMs)} / ${fmtMs(rp.ewmaFrameIntervalMs)} / ${fmtMs(rp.maxFrameIntervalMs)}`
                : '표본 수집 중',
        );
        const pass = (name) => rp?.passes?.[name],
            passMs = (name) => (pass(name) ? fmtMs(pass(name).ms) : '-'),
            begin = pass('device-begin');
        text(
            'dbgPerfDeviceBegin',
            begin
                ? `${fmtMs(begin.ms)} / ${fmtMs(begin.ewmaMs)} / ${fmtMs(begin.maxMs)}`
                : '표본 수집 중',
        );
        text(
            'dbgPerfRenderPasses',
            `${passMs('prepare')} / ${passMs('ground')} / ${passMs('world')}`,
        );
        text(
            'dbgPerfRenderEffects',
            `${passMs('shadow')} / ${passMs('overlay')} / ${passMs('ui-fx')}`,
        );
        text(
            'dbgPerfRenderTail',
            `${passMs('camera-compose')} / ${passMs('minimap')} / ${rp ? fmtMs(rp.cpuDepthSortMs) : '-'}`,
        );
        const nav = active.sim.navigation?.metrics;
        text(
            'dbgPerfNavigation',
            nav ? `${nav.fieldsBuilt} / ${nav.localFields} / ${fmtMs(nav.fieldBuildMs)}` : '-',
        );
        text('dbgPerfProjection', nav ? `${nav.rayHits} / ${nav.nextCalls}` : '-');
        text(
            'dbgPerfDrawCalls',
            `${rp?.drawCalls || 0} / ${DebugFormatUtil.formatDebugBytes(rp?.bufferUploadBytes || 0)} · 전송 대기 ${DebugFormatUtil.formatDebugBytes(active.transport?.netcodeBufferedAmount || 0)}`,
        );
        const activeTps = ActiveSimulationTiming.tps(),
            allowanceMs = 1000 / activeTps,
            isSingle = SinglePlayerModeUtil.isSinglePlayer();
        UiRegistry.refs.dbgPerfAllowanceLabel.textContent = activeTps + ' TPS 틱 허용시간';
        UiRegistry.refs.dbgPerfAllowance.textContent = fmtMs(allowanceMs);
        UiRegistry.refs.dbgPerfUsedLabel.textContent = isSingle
            ? '사용시간 · 싱글 두 세션 step EWMA'
            : '사용시간 · 현재 세션 step EWMA';
        const sampled = perf.stepSamples > 0 && (!isSingle || peerPerf?.stepSamples > 0);
        if (!sampled) {
            UiRegistry.refs.dbgPerfUsed.textContent = UiRegistry.refs.dbgPerfBudget.textContent =
                '표본 수집 중';
        } else {
            const usedMs = perf.ewmaStepMs + (isSingle ? peerPerf.ewmaStepMs : 0),
                remainingMs = Math.max(0, allowanceMs - usedMs),
                overrunMs = Math.max(0, usedMs - allowanceMs);
            UiRegistry.refs.dbgPerfUsed.textContent =
                fmtMs(usedMs) + ' · ' + ((usedMs / allowanceMs) * 100).toFixed(1) + '% 사용';
            UiRegistry.refs.dbgPerfBudget.textContent =
                fmtMs(remainingMs) +
                ' · ' +
                ((remainingMs / allowanceMs) * 100).toFixed(1) +
                '% 남음' +
                (overrunMs > 0 ? ' · ' + fmtMs(overrunMs) + ' 초과' : '');
        }
        UiRegistry.refs.dbgEndurancePeaks.textContent = `${perf.peakAliveUnits || 0} / ${perf.peakBuildings || 0} / ${perf.peakProjectiles || 0}`;

        const bs = active.sim?.balanceStats || createLocalBalanceStats();
        const formatTickTime = (t) =>
            t == null ? '-' : `${ActiveSimulationTiming.ticksToSeconds(t).toFixed(1)}s`;
        const pairTicks = (a) => `${formatTickTime(a?.[0])} / ${formatTickTime(a?.[1])}`;
        const avgArmy = [0, 1].map((side) => (bs.samples ? bs.armyTotal[side] / bs.samples : 0));
        UiRegistry.refs.dbgBalanceTime.textContent = `${formatTickTime(active.sim?.tick)} / ${bs.gameEndTick == null ? '진행 중' : `${formatTickTime(bs.gameEndTick)} · ${bs.winner || '-'}`}`;
        UiRegistry.refs.dbgBalanceCombat.textContent = formatTickTime(bs.firstCombatTick);
        UiRegistry.refs.dbgBalanceCapture.textContent = pairTicks(bs.firstCaptureTick);
        UiRegistry.refs.dbgBalanceArmy.textContent = `${bs.currentArmy[0]}/${avgArmy[0].toFixed(1)}/${bs.armyPeak[0]} · ${bs.currentArmy[1]}/${avgArmy[1].toFixed(1)}/${bs.armyPeak[1]}`;
        UiRegistry.refs.dbgBalanceLosses.textContent = `${bs.buildingLosses[0]}/${bs.outpostLosses[0]} · ${bs.buildingLosses[1]}/${bs.outpostLosses[1]}`;

        if (UiRegistry.refs.manualRecoveryBtn) {
            const recovering = !!(
                active.syncHold &&
                active.recoveryPhase &&
                active.recoveryPhase !== 'idle' &&
                active.recoveryPhase !== 'needs-manual'
            );

            // Recovery itself is restartable from zero with the same button.
            UiRegistry.refs.manualRecoveryBtn.disabled = !active.sim || active.simEnded;
            UiRegistry.refs.manualRecoveryBtn.textContent = recovering
                ? '복구 처음부터 다시 시작'
                : active.simpleRecoveryNeedsManual || active.recoveryPhase === 'needs-manual'
                  ? '복구 필요 · 입력 이력으로 재접속'
                  : '입력 이력으로 연결 복구';
        }

        if (UiRegistry.refs.fullConnectionResetBtn) {
            UiRegistry.refs.fullConnectionResetBtn.disabled = true;
            UiRegistry.refs.fullConnectionResetBtn.classList.add('hidden');
        }

        UiRegistry.refs.lockstepDebugSummary.textContent =
            '확정 입력 Synctest · ' +
            (sync ? 'S[0]~S[' + sync.tick + ']' : '미실행') +
            ' · ' +
            core.profile.mode +
            ' · Core ' +
            core.status;
        UiRegistry.refs.lockstepDebugVerdict.className =
            'lockstep-debug-verdict ' +
            (report?.status === 'failed' ? 'bad' : report?.status === 'passed' ? 'ok' : 'warn');
        UiRegistry.refs.lockstepDebugVerdict.textContent =
            report?.status === 'passed'
                ? '검사한 입력 구간의 저장·복원·재실행 결과가 일치했습니다.'
                : report?.status === 'failed'
                  ? 'Synctest가 실패했습니다. 위 라이브러리 실패 정보를 확인하세요.'
                  : report?.status === 'running'
                    ? '공통 Synctest 검사 중…'
                    : 'Synctest를 실행하면 라이브러리가 측정한 결과를 표시합니다.';
    }
    static renderConnectionGate() {
        if (!UiRegistry.refs.disconnectGate || ReplayPresentation.replayPlayer) {
            ConnectionPresentation.setDisconnectPhase('hidden');
            if (UiRuntimeState.value.modal === 'disconnect')
                UiController.closeUiModal('disconnect');
            return;
        }
        const active = RecoveryTelemetry.localRecoverySession?.();
        if (!active || active.simEnded) {
            ConnectionPresentation.setDisconnectPhase('hidden');
            if (UiRuntimeState.value.modal === 'disconnect')
                UiController.closeUiModal('disconnect');
            return;
        }
        const now = Date.now();
        if (active.postRecoveryResumeAt > now) {
            UiController.openUiModal('disconnect');
            ConnectionPresentation.setDisconnectPhase('resuming');
            const n = Math.max(1, Math.ceil((active.postRecoveryResumeAt - now) / 1000));
            UiRegistry.refs.disconnectGateTitle.textContent = '연결 복구 완료';
            UiRegistry.refs.disconnectGateCount.textContent = String(n);
            UiRegistry.refs.disconnectGateCount.classList.add('resume');
            UiRegistry.refs.disconnectGateCopy.textContent =
                '권위 상태 검증 완료 · 게임을 곧 재개합니다.';
            UiRegistry.refs.disconnectGateActions.classList.add('hidden');
            return;
        }
        if (active.disconnectGraceDeadlineAt > now) {
            UiController.openUiModal('disconnect');
            UiRegistry.refs.disconnectGateTitle.textContent = '상대와 연결이 끊겼습니다';
            UiRegistry.refs.disconnectGateCount.textContent = GraceTimeFormatUtil.formatGraceTime(
                active.disconnectGraceDeadlineAt - now,
            );
            UiRegistry.refs.disconnectGateCount.classList.remove('resume');
            const recovering =
                active.recoveryPhase &&
                active.recoveryPhase !== 'idle' &&
                active.recoveryPhase !== 'needs-manual';
            ConnectionPresentation.setDisconnectPhase(recovering ? 'recovering' : 'grace');
            UiRegistry.refs.disconnectGateCopy.textContent = recovering
                ? '재접속 및 Host 권위 상태 복구 중입니다.'
                : '게임은 현재 정지되어 있습니다. 제한시간 안에 재접속할 수 있습니다.';
            UiRegistry.refs.disconnectGateActions.classList.remove('hidden');
            UiRegistry.refs.disconnectReconnectBtn.disabled = !!recovering;
            UiRegistry.refs.disconnectReconnectBtn.textContent = recovering
                ? '재접속 중…'
                : '재접속 시도';
            return;
        }
        ConnectionPresentation.setDisconnectPhase('hidden');
        if (UiRuntimeState.value.modal === 'disconnect') UiController.closeUiModal('disconnect');
    }
    static positionP2PHealthNextToMenu() {
        if (!UiRegistry.refs.p2pHealth) return;
        const inGame = UiRuntimeState.value.screen === 'game';
        const menu = UiRegistry.refs.matchMenuBtnGame;
        if (inGame && menu) {
            const r = menu.getBoundingClientRect();
            const badgeH = UiRegistry.refs.p2pHealth.offsetHeight || 34;
            UiRegistry.refs.p2pHealth.style.left = `${Math.round(r.right + 6)}px`;
            UiRegistry.refs.p2pHealth.style.top = `${Math.round(r.top + (r.height - badgeH) / 2)}px`;
            UiRegistry.refs.p2pHealth.classList.add('in-game-positioned');
        } else {
            UiRegistry.refs.p2pHealth.style.left = '';
            UiRegistry.refs.p2pHealth.style.top = '';
            UiRegistry.refs.p2pHealth.classList.remove('in-game-positioned');
        }
    }
    static hideP2PHealth() {
        UiRegistry.refs.p2pHealth.classList.add('hidden');
        UiRegistry.refs.p2pHealth.classList.remove(
            'connected',
            'unstable',
            'disconnected',
            'in-game-positioned',
        );
        UiRegistry.refs.p2pHealth.style.left = '';
        UiRegistry.refs.p2pHealth.style.top = '';
    }
    static requestFullConnectionResetFromUi() {
        return RecoveryTelemetry.requestManualRecovery();
    }
    static requestConnectionReconnect() {
        const active = RecoveryTelemetry.localRecoverySession?.();
        if (!active || active.simEnded) return false;
        if (active.sim) return RecoveryTelemetry.requestManualRecovery();
        const trans = active.transport;
        if (active.role === 'guest')
            return !!trans?.rebuildRecoveryGuest?.('pre-start-disconnect-reconnect');
        return !!trans?.prepareRecoveryHost?.('pre-start-disconnect-reconnect');
    }
    static setDisconnectPhase(phase) {
        if (!['hidden', 'grace', 'recovering', 'resuming'].includes(phase))
            throw new Error(`Invalid disconnect phase: ${phase}`);
        UiRuntimeState.value.modalState.disconnect = phase;
        return phase;
    }
    static runWhenNetworkReady(action, onWaiting) {
        if (typeof window.RallyNetcode?.createNostrSignaler === 'function') {
            NetworkModuleLoader.networkLoadState = 'ready';
            action();
            return;
        }
        NetworkModuleLoader.pendingPeerAction = action;
        if (NetworkModuleLoader.networkLoadState === 'error') {
            if (onWaiting)
                onWaiting(
                    NetworkModuleLoader.networkLoadError ||
                        'URL 네트워크 모듈이 준비되지 않았습니다.',
                    true,
                );
            return;
        }
        if (onWaiting) onWaiting('네트워크 모듈을 준비하고 있습니다…', false);
    }
}

UiRegistry.refs.p2pHealth?.addEventListener('click', (e) => {
    e.preventDefault();
    e.stopPropagation();
    if (!UiRuntimeState.value.options.lockstepDebugOpen)
        ConnectionPresentation.openLockstepDebugPanel();
    else ConnectionPresentation.closeLockstepDebugPanel();
});
UiRegistry.refs.p2pHealth?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        if (!UiRuntimeState.value.options.lockstepDebugOpen)
            ConnectionPresentation.openLockstepDebugPanel();
        else ConnectionPresentation.closeLockstepDebugPanel();
    }
});
UiRegistry.refs.lockstepDebugCloseBtn?.addEventListener(
    'click',
    ConnectionPresentation.closeLockstepDebugPanel,
);
UiRegistry.refs.manualRecoveryBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    RecoveryTelemetry.requestManualRecovery();
});
UiRegistry.refs.fullConnectionResetBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    ConnectionPresentation.requestFullConnectionResetFromUi();
});

UiRegistry.refs.recoveryLogExportBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    RecoveryTelemetry.exportCorrectionFlightLog();
});
UiRegistry.refs.balanceTelemetryExportBtn?.addEventListener('click', (e) => {
    e.preventDefault();
    PerformanceTelemetry.exportBalanceTelemetry();
});
UiRegistry.refs.synctestRunBtn?.addEventListener('click', () =>
    RallySynctestDiagnostics.request(MatchLifecycle.activeSession(), () =>
        ConnectionPresentation.renderLockstepDebugPanel(),
    ),
);
UiRegistry.refs.lockstepDebugResetBtn?.addEventListener('click', () => {
    RallySynctestDiagnostics.clear(MatchLifecycle.activeSession?.());
    ConnectionPresentation.renderLockstepDebugPanel();
});
UiRegistry.refs.performanceTimingExportBtn?.addEventListener('click', () =>
    PerformanceTelemetry.exportTimingTelemetry(),
);
setInterval(() => {
    if (UiRuntimeState.value.options.lockstepDebugOpen)
        ConnectionPresentation.renderLockstepDebugPanel();
}, 500);

class GraceTimeFormatUtil {
    static formatGraceTime(ms) {
        const sec = Math.max(0, Math.ceil(ms / 1000));
        return `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
    }
}

class ReplayPresentation {
    static replayPlayer = null;
    static replayLoadedData = null;
    static replayTimelineDragging = false;
    static replayTimelineResumePlaying = null;
    static timeline = new RallyGamekit.ReplayTimeline({
        read: () => ({
            tick: ReplayPresentation.replayPlayer?.sim?.tick || 0,
            firstTick: 0,
            lastTick: ReplayPresentation.replayPlayer?.endTick || 0,
            playing: !!ReplayPresentation.replayPlayer?.playing,
        }),
        seek: (tick) => ReplayPresentation.replayPlayer?.seek(tick),
        setPlaying: (value) => ReplayPresentation.replayPlayer?.setPlaying(value),
    });

    static formatReplayTime(tick) {
        const sec = Math.max(0, Math.floor((Number(tick) || 0) / ActiveSimulationTiming.tps()));
        const m = Math.floor(sec / 60),
            s = sec % 60;
        return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    static replaySourceSession() {
        if (ReplayPresentation.replayPlayer) return null;
        const active = ActiveViewState.session;
        if (active?.replayRecorder?.result) return active;
        if (SinglePlayerModeUtil.isSinglePlayer()) {
            if (MatchLifecycle.singleMatch?.sessions?.host?.replayRecorder?.result)
                return MatchLifecycle.singleMatch.sessions.host;
            if (MatchLifecycle.singleMatch?.sessions?.guest?.replayRecorder?.result)
                return MatchLifecycle.singleMatch.sessions.guest;
        }
        return active?.replayRecorder ? active : null;
    }
    static currentReplayPayload() {
        const sess = ReplayPresentation.replaySourceSession();
        if (!sess?.replayRecorder) return null;
        if (!sess.replayRecorder.result && sess.simEnded)
            sess.replayRecorder.finalize(
                sess.matchResult?.winner || null,
                sess.sim,
                sess.matchResult?.reason || 'base-destroyed',
            );
        if (!sess.replayRecorder.result && sess.sim)
            sess.replayRecorder.captureCheckpoint(sess.sim, true);
        const payload = sess.replayRecorder.payload(sess.simEnded ? null : sess.sim);
        const saverRole = SinglePlayerModeUtil.isSinglePlayer()
            ? MatchLifecycle.singleMatch?.humanRole || ActiveViewState.role || 'host'
            : ActiveViewState.role || sess.role || 'host';
        payload.savedByRole = saverRole === 'guest' ? 'guest' : 'host';
        payload.defaultOrientationRole = payload.savedByRole;
        return payload;
    }
    static downloadReplay(payload) {
        if (!payload) return false;
        const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' });
        const url = URL.createObjectURL(blob),
            a = document.createElement('a');
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        a.href = url;
        a.download = `ssalkongpang-replay-${stamp}.json`;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
        const state = payload.result?.reason === 'in-progress' ? ' · 진행 중 저장본' : '';
        LogUtil.log(
            `리플레이 저장 · ${payload.commands?.length || 0}개 명령 · ${payload.checkpoints?.length || 0}개 체크포인트${state}`,
        );
        return true;
    }
    static replayStatsHtml(snapshot, sim) {
        if (!snapshot || !sim) return '';
        const card = (side) => {
            const army = (snapshot.units || []).filter((u) => u.alive && u.side === side).length;
            const buildings = (snapshot.buildings || []).filter(
                (b) => b.alive !== false && b.side === side,
            ).length;
            const captures = (snapshot.capturePoints || []).filter(
                (cp) => cp.owner === side,
            ).length;
            return `<div class="replay-side-card ${side === 0 ? 'host' : 'guest'}"><div class="replay-side-name">${side === 0 ? 'HOST' : 'GUEST'}</div><div class="replay-side-line"><span>◆ 자원</span><b>${Math.floor(snapshot.wallet?.[side] || 0)}</b></div><div class="replay-side-line"><span>⚔ 병력</span><b>${army}</b></div><div class="replay-side-line"><span>⌂ 건물 · 거점</span><b>${buildings} · ${captures}</b></div></div>`;
        };
        return `<div class="replay-stats-title">REPLAY · 양측 현황</div><div class="replay-stats-grid">${card(0)}${card(1)}</div>`;
    }
    static applyReplayPerspective({ preserveCenter = false } = {}) {
        if (!ReplayPresentation.replayPlayer || !ActiveViewState.renderer) return;
        const viewMode = ReplayPresentation.replayPlayer.viewMode,
            orientation =
                ReplayPresentation.replayPlayer.orientationRole === 'guest' ? 'guest' : 'host';
        const oldOrientation = ActiveViewState.renderer.orientationRole();
        const oldW = ActiveViewState.renderer.viewWorldW(),
            oldH = ActiveViewState.renderer.viewWorldH();
        let oldCenterX = ActiveViewState.renderer.cameraLeft + oldW / 2,
            oldCenterY = ActiveViewState.renderer.cameraTop + oldH / 2;
        if (preserveCenter && oldOrientation !== orientation) {
            const renderer = ActiveViewState.renderer;
            const point = renderer.surfaceAtScreen(
                renderer.canvas.width / 2,
                renderer.canvas.height / 2,
            );
            oldCenterX = orientation === 'guest' ? renderer.world.width - point.x : point.x;
            const viewY = orientation === 'guest' ? renderer.world.height - point.z : point.z;
            oldCenterY = BattlefieldProjection.planarY(viewY, point.y);
        }
        ActiveViewState.role = orientation;
        ActiveViewState.renderer.role = orientation;
        ActiveViewState.renderer.replayOrientationRole = orientation;
        ActiveViewState.renderer.replayPerspectiveSide = ConnectionSideUtil.roleSide(orientation);
        ActiveViewState.renderer.replayVisionMode = viewMode === 'all' ? 'union' : viewMode;
        ActiveViewState.renderer.replayObserverAll = false;
        ActiveViewState.renderer.replayZoom = ReplayPresentation.replayPlayer.zoom || 1;
        if (preserveCenter) {
            const vw = ActiveViewState.renderer.viewWorldW(),
                vh = ActiveViewState.renderer.viewWorldH();
            ActiveViewState.renderer.cameraLeft = RangeUtil.clamp(
                oldCenterX - vw / 2,
                0,
                Math.max(0, (ActiveViewState.renderer?.world || WorldContext.standard).width - vw),
            );
            ActiveViewState.renderer.cameraTop = ActiveViewState.renderer.clampCameraTop(
                oldCenterY - vh / 2,
            );
        }
        if (ActiveViewState.minimap) ActiveViewState.minimap.renderer = ActiveViewState.renderer;
        UiRegistry.refs.replayHostViewBtn?.classList.toggle('active', viewMode === 'host');
        UiRegistry.refs.replayGuestViewBtn?.classList.toggle('active', viewMode === 'guest');
        UiRegistry.refs.replayAllViewBtn?.classList.toggle('active', viewMode === 'all');
        UiRegistry.refs.replayHostOrientationBtn?.classList.toggle(
            'active',
            orientation === 'host',
        );
        UiRegistry.refs.replayGuestOrientationBtn?.classList.toggle(
            'active',
            orientation === 'guest',
        );
    }
    static applyReplayZoom(value) {
        if (!ReplayPresentation.replayPlayer || !ActiveViewState.renderer) return;

        // Replay zoom is camera presentation only. Transient gameplay/prediction
        // visuals must never be scaled or carried across replay zoom changes.
        ActiveViewState.renderer.selectedBuildingId = null;

        const oldW = ActiveViewState.renderer.viewWorldW(),
            oldH = ActiveViewState.renderer.viewWorldH();
        const centerX = ActiveViewState.renderer.cameraLeft + oldW / 2,
            centerY = ActiveViewState.renderer.cameraTop + oldH / 2;
        ActiveViewState.renderer.replayZoom = RangeUtil.clamp(Number(value) || 1, 0.6, 1.8);
        ReplayPresentation.centerReplayCamera(centerX, centerY);
    }
    static centerReplayCamera(x, y) {
        const renderer = ActiveViewState.renderer,
            vw = renderer.viewWorldW(),
            vh = renderer.viewWorldH();
        renderer.cameraLeft = RangeUtil.clamp(
            x - vw / 2,
            0,
            Math.max(0, (renderer.world || WorldContext.standard).width - vw),
        );
        renderer.cameraTop = renderer.clampCameraTop(y - vh / 2);
        ActiveViewState.minimap?.draw();
    }
    static refreshReplayView() {
        const player = ReplayPresentation.replayPlayer,
            renderer = ActiveViewState.renderer,
            snapshot = renderer?.snapshot;
        if (!player || !renderer || !snapshot) return;
        ReplayPresentation.applyReplayPerspective();
        ActiveViewState.minimap?.set(renderer, snapshot);
        ActiveViewState.minimap?.draw();
        LaunchPresentation.render(
            { ...snapshot, events: [] },
            ConnectionSideUtil.roleSide(player.orientationRole),
        );
        if (UiRegistry.refs.replayStats)
            UiRegistry.refs.replayStats.innerHTML = ReplayPresentation.replayStatsHtml(
                snapshot,
                player.sim,
            );
        ReplayPresentation.syncReplayControls();
    }
    static renderReplaySnapshot(s, { snapTargets = false } = {}) {
        if (!ReplayPresentation.replayPlayer) return;
        UiController.setUiScreen('replay');
        ActiveViewState.snap = s;
        if (!ActiveViewState.renderer) {
            ActiveViewState.renderer = new GLRenderer(UiRegistry.refs.canvas);
        }
        if (!ActiveViewState.minimap)
            ActiveViewState.minimap = new MiniMap(UiRegistry.refs.minimapCanvas);
        ActiveViewState.renderer.onPresentationFrame = (frame) =>
            ReplayPresentation.replayPlayer?.presentFrame(frame);
        ActiveViewState.renderer.startLoop();
        ReplayPresentation.applyReplayPerspective();
        ActiveViewState.renderer.selectedBuildingId = null;
        ActiveViewState.renderer.setSnapshot(s, {
            liveTargets: false,
            snapTargets:
                snapTargets ||
                ActiveViewState.renderer.liveRenderTargets ||
                s.tick < (ActiveViewState.renderer.snapshot?.tick ?? 0),
        });
        ReplayPresentation.replayPlayer.flushPresentationEvents(s);
        ActiveViewState.minimap?.set(ActiveViewState.renderer, s);
        LaunchPresentation.render(
            s,
            ConnectionSideUtil.roleSide(ReplayPresentation.replayPlayer.orientationRole),
        );
        audioSystem.processSnapshot(s, ActiveViewState.renderer);
        UiRegistry.refs.replayDock?.classList.remove('hidden');
        UiRegistry.refs.replayStats?.classList.remove('hidden');
        if (UiRegistry.refs.replayStats)
            UiRegistry.refs.replayStats.innerHTML = ReplayPresentation.replayStatsHtml(
                s,
                ReplayPresentation.replayPlayer.sim,
            );
        LogUtil.status('리플레이 · 네트워크 시뮬레이션 없음');
        UiRegistry.refs.p2pHealth?.classList.add('hidden');
    }
    static syncReplayControls() {
        if (!ReplayPresentation.replayPlayer) return;
        const tick = ReplayPresentation.replayPlayer.sim?.tick || 0,
            end = ReplayPresentation.replayPlayer.endTick || 0;
        if (UiRegistry.refs.replayTimeline) {
            UiRegistry.refs.replayTimeline.max = String(
                Math.max(0.1, end / ActiveSimulationTiming.tps()),
            );
            if (!ReplayPresentation.replayTimelineDragging)
                UiRegistry.refs.replayTimeline.value = String(
                    RangeUtil.clamp(
                        tick / ActiveSimulationTiming.tps(),
                        0,
                        end / ActiveSimulationTiming.tps() || 0.1,
                    ),
                );
        }
        if (UiRegistry.refs.replayTime)
            UiRegistry.refs.replayTime.textContent = `${ReplayPresentation.formatReplayTime(tick)} / ${ReplayPresentation.formatReplayTime(end)}`;
        if (UiRegistry.refs.replayPlayPauseBtn)
            UiRegistry.refs.replayPlayPauseBtn.textContent = ReplayPresentation.replayPlayer.playing
                ? '⏸ 일시정지'
                : '▶ 재생';
        if (UiRegistry.refs.replaySpeed)
            UiRegistry.refs.replaySpeed.value = String(ReplayPresentation.replayPlayer.speed);
        if (UiRegistry.refs.replayZoomValue)
            UiRegistry.refs.replayZoomValue.textContent = `${Math.round((ReplayPresentation.replayPlayer.zoom || 1) * 100)}%`;
    }
    static replayImportFailureMessage(error) {
        const detail = String(error?.message || error || '');
        let reason =
            '파일을 읽거나 검증하지 못했습니다. JSON 형식과 필수 데이터가 올바른지 확인하세요.';
        if (error instanceof SyntaxError || /json|unexpected token|unexpected end/i.test(detail))
            reason = 'JSON으로 읽을 수 없습니다. 파일이 잘렸거나 JSON 형식이 아닙니다.';
        else if (/version|sim_version|버전/i.test(detail))
            reason =
                '다른 게임 버전에서 저장한 리플레이입니다. 현재 게임 버전과 맞는 파일을 선택하세요.';
        else if (/checksum|check.?point|체크포인트|체크섬/i.test(detail))
            reason = '시작 상태 체크포인트 검증에 실패했습니다. 파일이 손상되었을 수 있습니다.';
        else if (/protocol|쌀콩팡|형식/i.test(detail))
            reason = '지원하지 않는 형식입니다. 쌀콩팡!에서 저장한 리플레이 JSON을 선택하세요.';
        else if (/command|payload|초기 상태|리플레이 데이터|손상/i.test(detail))
            reason = '리플레이의 명령 기록이나 초기 상태가 없거나 손상되었습니다.';
        return `리플레이를 열지 못했습니다. ${reason} 현재 화면은 유지했습니다. 정상 파일을 선택해 다시 시도하세요.`;
    }
    static showReplayImportError(error) {
        const status = UiRegistry.refs.singleStatus;
        if (!status) return;
        status.textContent = '';
        status.dataset.tone = 'error';
        status.setAttribute('role', 'alert');
        status.setAttribute('aria-live', 'assertive');
        UiController.setElementVisible(status, true);
        status.textContent = this.replayImportFailureMessage(error);
    }
    static clearReplayImportError() {
        const status = UiRegistry.refs.singleStatus;
        if (!status) return;
        status.textContent = '';
        delete status.dataset.tone;
        status.removeAttribute('role');
        status.setAttribute('aria-live', 'polite');
        UiController.setElementVisible(status, false);
    }
    static startReplay(data, { onError = null } = {}) {
        let loadedData, player, snapshot;
        try {
            ReplayPolicy.validateReplayPayload(data);
            loadedData = CloneUtil.clone(data);
            player = new ReplayPlayer(loadedData);
            snapshot = player.sim.snapshot();
        } catch (e) {
            player?.stop();
            LogUtil.log(`⚠ 리플레이 열기 실패 · ${e.message || e}`);
            onError?.(e);
            return false;
        }
        MatchLifecycle.disposeMatches('replay-start');
        ReplayPresentation.replayPlayer?.stop();
        ReplayPresentation.replayLoadedData = loadedData;
        ReplayPresentation.replayPlayer = player;
        if (ActiveViewState.renderer) {
        }
        UiController.closeUiModal('create');
        UiController.closeUiModal('join');

        ReplayPresentation.renderReplaySnapshot(snapshot);
        ReplayPresentation.applyReplayPerspective();
        ReplayPresentation.syncReplayControls();
        ReplayPresentation.replayPlayer.start();
        LogUtil.log(
            `▶ 리플레이 시작 · ${ReplayPresentation.formatReplayTime(ReplayPresentation.replayPlayer.endTick)} · 명령 ${data.commands.length}개`,
        );
        return true;
    }
    static stopReplay() {
        ReplayPresentation.replayPlayer?.stop();
        ReplayPresentation.replayPlayer = null;
        ReplayPresentation.replayLoadedData = null;
        UiController.setUiScreen('lobby');
        location.reload();
    }
}

// The game screen has no log or status line; the last messages stay readable from the console for diagnostics.
class LogUtil {
    static last = '';
    static lastStatus = '';
    static log(t) {
        LogUtil.last = String(t);
    }
    static status(t) {
        LogUtil.lastStatus = String(t);
    }
}
class RoomCodeUtil {
    static randomCode() {
        return String(Math.floor(Math.random() * 10000)).padStart(4, '0');
    }
}
class SinglePlayerModeUtil {
    static isSinglePlayer() {
        return !!MatchLifecycle.singleMatch;
    }
}

class MatchLifecycle {
    static singleMatch = null;
    static selectedCampaign = null;

    static activeSession() {
        return ReplayPresentation.replayPlayer || ActiveViewState.session;
    }
    static currentMatchConfig() {
        return {
            presetId: UiRuntimeState.value.settings.presetId,
            simulationTps: UiRuntimeState.value.settings.simulationTps,
        };
    }
    static createSession(role, transport, roomCode, config, deck) {
        const session = new GameSession(role, transport, roomCode, config, deck);
        session.onSimulationStarted = AppLifecycle.registerBackgroundSession;
        session.onSimulationStopped = AppLifecycle.unregisterBackgroundSession;
        session.onSimulationFatal = (info) => {
            const sim = session.sim;
            DiagnosticPresentation.presentFatalDiagnostic({
                kind: 'SSALKONGPANG_SIMULATION_FATAL',
                build: BUILD_META.id,
                buildMetadata: BUILD_META.snapshot(),
                at: info.at,
                source: info.source,
                role: info.role,
                remote: info.remote,
                tick: info.tick,
                localTick: info.localTick,
                runtimeSeq: info.runtimeSeq,
                checksum: info.checksum,
                localChecksum: info.localChecksum,
                tps: Number(sim?.tps) || ActiveSimulationTiming.tps(),
                units: sim?.units?.filter?.((u) => u?.alive !== false)?.length || 0,
                projectiles: sim?.projectiles?.filter?.((p) => p?.alive !== false)?.length || 0,
                message: info.message,
                stack: info.stack,
            });
        };
        return session;
    }
    static wireSessionForView(r, sess, trans) {
        const isCurrent = () =>
            !sess.disposed &&
            ActiveViewState.session === sess &&
            ActiveViewState.transport === trans;
        sess.presentationView = createPresentationView(
            sess,
            () => isCurrent() && ActiveViewState.renderer,
        );
        sess.onSnapshot = (state) => {
            if (!isCurrent()) return;
            if (ActiveViewState.renderer)
                ActiveViewState.renderer.onPresentationFrame = (frame) => sess.presentFrame(frame);
            if (ActiveViewState.role === r) BattlePresentation.renderGame(state);
        };
        sess.onRenderTargets = (sim, snapNow = false) => {
            if (!isCurrent()) return;
            if (ActiveViewState.role === r && ActiveViewState.renderer)
                ActiveViewState.renderer.updatePresentationTargets(sim, !!snapNow);
        };
        sess.onLog = (text) => {
            if (isCurrent() && ActiveViewState.role === r) LogUtil.log(text);
        };
        sess.onNetworkHealth = (info) => {
            if (!isCurrent()) return;
            if (ActiveViewState.role !== r) return;
            ConnectionPresentation.renderP2PHealth(info, false);

            if (info?.state === 'fatal') {
                const fatal = info.simulationFatalInfo || {};
                LogUtil.status('시뮬레이션 오류로 일시 중단됨');
                if (SinglePlayerModeUtil.isSinglePlayer()) {
                    UiRegistry.refs.singleStatus.textContent =
                        '시뮬레이션 오류 · 안전을 위해 경기를 중단했습니다.';
                    UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
                }
                LogUtil.log(
                    `⚠ 시뮬레이션 오류 · ${(fatal.role || r).toUpperCase()} tick ${fatal.localTick ?? fatal.tick ?? '-'} · ${fatal.message || 'unknown'}`,
                );
                return;
            }

            if (
                info?.state === 'connected' &&
                sess.sim &&
                !sess.syncHold &&
                sess.recoveryPhase === 'idle'
            ) {
                LogUtil.status(
                    SinglePlayerModeUtil.isSinglePlayer()
                        ? '싱글 · 공통 코어 재연결 완료 · 게임 재개'
                        : '공통 코어 재연결 완료 · 연결됨',
                );

                if (SinglePlayerModeUtil.isSinglePlayer()) {
                    UiRegistry.refs.singleStatus.textContent = `복구 완료 · ${r === 'host' ? '내' : 'AI'} Host 권위 상태와 일치 · 게임 재개`;
                    UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
                }
            }
        };
        sess.onResult = (w, reason = 'base-destroyed') => {
            // Authoritative result must not depend on which role is currently displayed.
            if (isCurrent()) MatchLifecycle.presentMatchResult(w, reason, r);
            if (sess.leaveAfterResult) setTimeout(() => location.reload(), 0);
        };

        trans.onPeerReady = () => {
            if (!isCurrent()) return;
            if (ActiveViewState.role !== r) return;
            if (SinglePlayerModeUtil.isSinglePlayer()) {
                LogUtil.status('싱글 · AI WebRTC 연결 준비');
                UiRegistry.refs.singleStatus.textContent = 'AI용 WebRTC 피어를 연결하고 있습니다…';
                UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
            } else {
                LogUtil.status('방 ' + ActiveViewState.roomCode + ' · 상대 대기');
                if (r === 'host') {
                    UiRegistry.refs.codeArea.classList.remove('hidden');
                    UiRegistry.refs.createStatus.textContent =
                        '방이 열렸습니다. 상대 참가를 기다립니다.';
                }
            }
        };
        trans.onOpen = () => {
            if (!isCurrent()) return;
            // DataChannel open is only transport readiness. During recovery the match
            // is NOT "connected" until Host snapshot READY/RUN finishes.
            sess.localVisible = document.visibilityState === 'visible';
            sess.onTransportOpen();

            if (ActiveViewState.role === r) {
                const recovering = !!(sess.sim && (sess.syncHold || sess.recoveryPhase !== 'idle'));

                LogUtil.status(
                    SinglePlayerModeUtil.isSinglePlayer()
                        ? recovering
                            ? '싱글 · 새 DataChannel 연결됨 · 공통 코어 입력 동기화 중'
                            : `싱글 · ${r.toUpperCase()} 테스트 · AI ${(MatchLifecycle.singleMatch?.botRole || 'guest').toUpperCase()} 연결됨`
                        : recovering
                          ? '새 DataChannel 연결됨 · 공통 코어 입력 동기화 중'
                          : '연결됨 · ' + ActiveViewState.roomCode,
                );

                MatchLifecycle.setJoinBusy(false);
                UiController.closeUiModal('create');
                UiController.closeUiModal('join');

                if (SinglePlayerModeUtil.isSinglePlayer()) {
                    UiRegistry.refs.singleStatus.textContent = recovering
                        ? '새 WebRTC 채널 연결 완료 · Host 게임 상태 복원 중'
                        : `내 역할 ${r.toUpperCase()} · AI ${(MatchLifecycle.singleMatch?.botRole || 'guest').toUpperCase()}와 실제 WebRTC 연결 완료`;
                    UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
                }
            }

            AppLifecycle.requestScreenWakeLock();
        };
        trans.onError = (e) => {
            if (!isCurrent()) return;
            if (e?.error) console.error('연결 오류 원인:', e.error);
            if (e?.type === 'version-mismatch') {
                ConnectionPresentation.showVersionMismatch(e, r);
                return;
            }
            if (ActiveViewState.role === r) {
                const message = e.message || e.type || '연결 오류';
                LogUtil.status('연결 오류');
                if (SinglePlayerModeUtil.isSinglePlayer()) {
                    if (trans.everOpened) {
                        UiRegistry.refs.singleStatus.textContent = 'WebRTC 복구 중 · ' + message;
                        UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
                    } else {
                        MatchLifecycle.failSinglePlayer(
                            '싱글 WebRTC 연결 실패 · 다시 시도해 주세요: ' + message,
                        );
                    }
                } else if (r === 'host') {
                    UiRegistry.refs.createStatus.textContent = '방 연결에 실패했습니다: ' + message;
                    UiController.setElementVisible(UiRegistry.refs.createRetry, true);
                } else {
                    const friendly =
                        message === 'signal-timeout' || message === 'nostr-module-unavailable'
                            ? '해당 방을 찾을 수 없습니다. 방 코드와 방장이 아직 접속 중인지 확인해 주세요.'
                            : '연결에 실패했습니다: ' + message;
                    UiRegistry.refs.joinError.textContent = friendly;
                    MatchLifecycle.setJoinBusy(false);
                }
            }
        };
        trans.onClose = () => {
            if (!isCurrent()) return;
            sess.onTransportClosed();
            if (ActiveViewState.role === r) {
                LogUtil.status(
                    SinglePlayerModeUtil.isSinglePlayer()
                        ? '싱글 · 연결 끊김 · 게임 정지 · 복구 버튼 필요'
                        : 'P2P 연결 끊김 · 게임 정지 · 복구 버튼 필요',
                );

                if (SinglePlayerModeUtil.isSinglePlayer()) {
                    UiRegistry.refs.singleStatus.textContent =
                        '연결이 끊겼습니다 · 복구 버튼으로 Host 권위 스냅샷을 기준으로 새 연결을 만드세요.';
                    UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
                }
            }
        };
    }
    static disposeMatches(reason = 'mode-change') {
        const sessions = new Set(
            [ActiveViewState.session, ...Object.values(this.singleMatch?.sessions || {})].filter(
                Boolean,
            ),
        );
        this.singleMatch?.bot?.stop();
        const errors = [];
        for (const session of sessions) {
            try {
                session.dispose(reason);
            } catch (error) {
                errors.push(error);
            }
        }
        this.singleMatch = null;
        ActiveViewState.session = null;
        ActiveViewState.transport = null;
        ActiveViewState.snap = null;
        if (errors.length)
            throw new AggregateError(errors, '세션 종료 처리 중 오류가 발생했습니다.');
    }
    static setJoinBusy(busy) {
        this.joinBusy = !!busy;
        UiRegistry.refs.joinConfirm.disabled = this.joinBusy;
        UiRegistry.refs.joinConfirm.textContent = this.joinBusy ? '연결 중…' : '참가하기';
    }
    static cancelOnlinePreparation() {
        NetworkModuleLoader.pendingPeerAction = null;
        if (!this.singleMatch && !ActiveViewState.session?.sim) {
            this.disposeMatches('online-cancel');
            ActiveViewState.roomCode = '';
        }
        this.setJoinBusy(false);
        UiRegistry.refs.codeArea.classList.add('hidden');
        UiController.closeUiModal('create');
        UiController.closeUiModal('join');
    }
    static connect(r, c) {
        MatchLifecycle.disposeMatches('online-start');
        MatchLifecycle.singleMatch = null;
        ConnectionPresentation.hideP2PHealth();
        ActiveViewState.role = r;
        ActiveViewState.roomCode = c;
        LogUtil.status('연결 중…');
        ActiveViewState.transport = new RoomTransport(r, c);
        ActiveViewState.session = MatchLifecycle.createSession(
            r,
            ActiveViewState.transport,
            c,
            r === 'host' ? MatchLifecycle.currentMatchConfig() : null,
            DeckEditor.getDeck(),
        );
        MatchLifecycle.wireSessionForView(r, ActiveViewState.session, ActiveViewState.transport);
        ActiveViewState.transport.open();
    }
    static singleRoomToken() {
        return 'AI' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    }
    static stopSinglePlayer() {
        if (!this.singleMatch) return;
        MatchLifecycle.disposeMatches('single-stop');
    }
    static startSinglePlayerWebRTC(humanRole = 'guest') {
        if (MatchLifecycle.singleMatch) return;
        const stage = campaignStage(this.selectedCampaign);
        if (this.selectedCampaign && (!stage || !campaignProgress.canStart(stage))) return;
        MatchLifecycle.disposeMatches('single-start');

        humanRole = humanRole === 'host' ? 'host' : 'guest';
        const botRole = humanRole === 'host' ? 'guest' : 'host';

        ConnectionPresentation.hideP2PHealth();
        NetworkModuleLoader.pendingPeerAction = null;
        UiController.closeUiModal('create');
        UiController.closeUiModal('join');

        const token = MatchLifecycle.singleRoomToken();
        ActiveViewState.roomCode = token;
        ActiveViewState.role = humanRole;

        ActiveViewState.snap = null;

        UiController.setUiScreen('lobby');
        UiRegistry.refs.singleStatus.textContent = `${humanRole.toUpperCase()} 테스트용 실제 WebRTC 양쪽 피어를 준비하고 있습니다…`;
        UiController.setElementVisible(UiRegistry.refs.singleStatus, true);

        const hostTransport = new RoomTransport('host', token, { signalMode: 'local' });
        const guestTransport = new RoomTransport('guest', token, { signalMode: 'local' });
        const transports = { host: hostTransport, guest: guestTransport };
        const humanTransport = transports[humanRole];
        const botTransport = transports[botRole];
        const config = { ...MatchLifecycle.currentMatchConfig(), campaignStage: stage?.id || null },
            configFor = (role) => (role === 'host' ? config : undefined);
        const humanSession = MatchLifecycle.createSession(
            humanRole,
            humanTransport,
            token,
            configFor(humanRole),
            stage?.deck ?? DeckEditor.getDeck(),
        );
        // CONFIG.single.botWorker runs the AI session in src/sim-worker.js; its WebRTC transport stays here.
        const botDeck = stage?.enemyDeck;
        const botSession = CONFIG.single.botWorker
            ? new WorkerSessionProxy(botRole, botTransport, token, configFor(botRole), botDeck)
            : MatchLifecycle.createSession(
                  botRole,
                  botTransport,
                  token,
                  configFor(botRole),
                  botDeck,
              );
        const sessions = { [humanRole]: humanSession, [botRole]: botSession };
        const bot = CONFIG.single.botWorker ? null : BotController.attach(botSession, botRole);
        if (CONFIG.single.botWorker)
            botSession.onFatal = (e) => {
                if (e?.error) console.error('AI Worker 오류 원인:', e.error);
                MatchLifecycle.failSinglePlayer(
                    `AI ${botRole.toUpperCase()} Worker 오류 · ${e.message}`,
                );
            };

        MatchLifecycle.singleMatch = {
            roomCode: token,
            humanRole,
            botRole,
            recoveryInitiatorRole: humanRole,
            transports,
            sessions,
            bot,
        };

        ActiveViewState.session = humanSession;
        ActiveViewState.transport = humanTransport;
        MatchLifecycle.wireSessionForView(humanRole, humanSession, humanTransport);

        botTransport.onOpen = () => {
            botSession.localVisible = document.visibilityState === 'visible';
            botSession.onTransportOpen();
            AppLifecycle.requestScreenWakeLock();
        };

        botTransport.onError = (e) => {
            if (e?.error) console.error('AI 연결 오류 원인:', e.error);
            if (e?.type === 'version-mismatch') {
                ConnectionPresentation.showVersionMismatch(e, botRole);
                return;
            }
            const message = e?.type || e?.message || `AI ${botRole.toUpperCase()} 연결 오류`;
            if (botTransport.everOpened) {
                UiRegistry.refs.singleStatus.textContent = `AI ${botRole.toUpperCase()} WebRTC 복구 필요 · ${message}`;
                UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
            } else {
                MatchLifecycle.failSinglePlayer(
                    `AI ${botRole.toUpperCase()} WebRTC 연결 실패 · 다시 시도해 주세요: ${message}`,
                );
            }
        };
        botTransport.onClose = () => botSession.onTransportClosed();

        // 싱글은 Host RTCPeerConnection signaling endpoint를 먼저 연 뒤 Guest가 참가한다.
        hostTransport.onPeerReady = () => {
            if (humanRole === 'host') {
                UiRegistry.refs.singleStatus.textContent =
                    '내 Host 방 준비 완료 · AI Guest가 실제 WebRTC로 참가 중…';
            } else {
                UiRegistry.refs.singleStatus.textContent =
                    'AI Host 준비 완료 · 내 Guest가 실제 WebRTC로 참가 중…';
            }
            guestTransport.open();
        };

        // Open the link once the AI worker is ready to answer its first peer message.
        if (CONFIG.single.botWorker)
            void botSession.ready.then(() => {
                if (!botSession.disposed) hostTransport.open();
            });
        else hostTransport.open();
    }
    static beginCreateRoom() {
        if (this.singleMatch || ActiveViewState.session?.sim) return false;
        this.cancelOnlinePreparation();
        UiController.openUiModal('create');
        const c = RoomCodeUtil.randomCode();
        UiRegistry.refs.code.textContent = c;
        UiRegistry.refs.codeArea.classList.add('hidden');
        UiController.setElementVisible(UiRegistry.refs.createRetry, false);
        UiRegistry.refs.createStatus.textContent = '방을 준비하고 있습니다…';

        ConnectionPresentation.runWhenNetworkReady(
            () => {
                NetworkModuleLoader.pendingPeerAction = null;
                UiRegistry.refs.createStatus.textContent = '방 코드를 확보하고 있습니다…';
                MatchLifecycle.connect('host', c);
            },
            (msg, failed) => {
                UiRegistry.refs.createStatus.textContent = msg;
                UiController.setElementVisible(UiRegistry.refs.createRetry, !!failed);
            },
        );
    }
    static submitJoinRoom() {
        if (this.joinBusy || this.singleMatch || ActiveViewState.session?.sim) return false;
        const c = UiRegistry.refs.room.value.replace(/\D/g, '').slice(0, 4);
        UiRegistry.refs.room.value = c;

        if (c.length !== 4) {
            UiRegistry.refs.joinError.textContent = '4자리 숫자 코드를 입력해 주세요.';
            return;
        }

        audioSystem.unlock();
        UiRegistry.refs.joinError.textContent = '';
        MatchLifecycle.setJoinBusy(true);

        ConnectionPresentation.runWhenNetworkReady(
            () => {
                NetworkModuleLoader.pendingPeerAction = null;
                MatchLifecycle.connect('guest', c);
            },
            (msg, failed) => {
                if (failed) MatchLifecycle.setJoinBusy(false);
                UiRegistry.refs.joinError.textContent = msg;
                if (failed) NetworkModuleLoader.networkLoadError = msg;
            },
        );
    }
    static requestMatchSurrender({ leave = false } = {}) {
        const active =
            RecoveryTelemetry.localRecoverySession?.() || MatchLifecycle.activeSession?.();
        if (!active || active.simEnded) return false;
        const ok = window.confirm(
            leave
                ? '진행 중인 게임에서 나가면 패배 처리됩니다. 나갈까요?'
                : '항복하면 패배 처리됩니다. 항복할까요?',
        );
        if (!ok) return false;
        if (!active.surrender()) return false;
        active.leaveAfterResult = !!leave;
        MatchLifecycle.closeMatchMenu();
        return true;
    }
    static startCampaignStage(stage) {
        if (!stage || !campaignProgress.canStart(stage)) return;
        this.disposeMatches('campaign-stage-change');
        this.selectedCampaign = stage.id;
        this.startSinglePlayerWebRTC('host');
    }
    static presentMatchResult(winner, reason = 'base-destroyed', sourceRole = null) {
        const humanRole = SinglePlayerModeUtil.isSinglePlayer()
            ? MatchLifecycle.singleMatch?.humanRole || ActiveViewState.role
            : ActiveViewState.role;
        const viewRole = humanRole === 'host' ? 'host' : 'guest';
        MatchLifecycle.closeMatchMenu();
        if (UiRuntimeState.value.modal === 'disconnect') UiController.closeUiModal('disconnect');
        ConnectionPresentation.setDisconnectPhase('hidden');
        const draw = reason === 'draw' || !winner,
            mine = !draw && winner === viewRole;
        const stage = campaignStage(MatchLifecycle.selectedCampaign);
        const cleared = stage && mine && reason === 'base-destroyed';
        const reward = cleared ? campaignProgress.complete(stage) : null;
        const next = cleared ? CAMPAIGN_STAGES[CAMPAIGN_STAGES.indexOf(stage) + 1] : null;
        LaunchScreens.renderCampaignResult(reward, next);
        UiRegistry.refs.resultTitle.textContent = draw ? '무승부' : mine ? '승리' : '패배';
        if (reason === 'surrender')
            UiRegistry.refs.resultText.textContent = mine
                ? '상대가 항복했습니다.'
                : '항복했습니다.';
        else if (reason === 'disconnect-timeout')
            UiRegistry.refs.resultText.textContent =
                '연결을 60초 안에 복구하지 못해 경기가 중단되었습니다.';
        else if (reason === 'draw')
            UiRegistry.refs.resultText.textContent = '양쪽 메인 거점이 같은 tick에 파괴되었습니다.';
        else
            UiRegistry.refs.resultText.textContent = mine
                ? '적 메인 거점을 파괴했습니다.'
                : '내 메인 거점이 파괴되었습니다.';
        if (stage && mine && stage.mode === 'defend')
            UiRegistry.refs.resultText.textContent = '제한 시간 동안 본진을 지켰습니다.';
        if (cleared && !next)
            UiRegistry.refs.resultText.textContent = '캠페인을 모두 완료했습니다.';
        const end = ActiveViewState.snap,
            stats = end?.launchStats,
            mySide = ConnectionSideUtil.roleSide(viewRole);
        if (stats)
            LaunchScreens.renderResult({
                durationMs: (1000 * end.tick) / (end.tps || ActiveSimulationTiming.tps()),
                launches: stats.launches[mySide],
                sent: stats.sent[mySide],
                kills: stats.kills[mySide],
                unitStats: end.unitResultStats?.[mySide],
                deck: end.decks?.[mySide] || [],
                partial: reason === 'disconnect-timeout',
            });
        else {
            DomUtil.byId('resultStats').replaceChildren();
            DomUtil.byId('resultByUnit').hidden = true;
        }
        const replayReady = !!ReplayPresentation.replaySourceSession()?.replayRecorder?.result;
        if (UiRegistry.refs.replaySaveBtn) UiRegistry.refs.replaySaveBtn.disabled = !replayReady;
        if (UiRegistry.refs.replayWatchBtn) UiRegistry.refs.replayWatchBtn.disabled = !replayReady;
        UiController.setUiScreen('result');
        requestAnimationFrame(() => UiRegistry.refs.result?.focus?.({ preventScroll: true }));
    }
    static failSinglePlayer(message) {
        MatchLifecycle.disposeMatches('single-start-failed');
        UiRuntimeState.value.settings.presetId = 'standard';
        UiRegistry.refs.singleStatus.textContent = message;
        UiController.setElementVisible(UiRegistry.refs.singleStatus, true);
    }
    static openMatchMenu() {
        if (ReplayPresentation.replayPlayer) {
            if (UiRegistry.refs.matchMenuReplaySaveBtn)
                UiRegistry.refs.matchMenuReplaySaveBtn.disabled = true;
            if (UiRegistry.refs.matchMenuSurrenderBtn)
                UiRegistry.refs.matchMenuSurrenderBtn.classList.add('hidden');
            if (UiRegistry.refs.matchMenuLeaveBtn) {
                UiRegistry.refs.matchMenuLeaveBtn.classList.remove('hidden');
                UiRegistry.refs.matchMenuLeaveBtn.textContent = '리플레이 종료';
            }
            if (UiRegistry.refs.matchMenuWarning)
                UiRegistry.refs.matchMenuWarning.textContent =
                    '리플레이 재생은 경기 결과에 영향을 주지 않습니다.';
            UiController.openUiModal('match-menu');
            return;
        }
        UiRegistry.refs.matchMenuSurrenderBtn?.classList.remove('hidden');
        // A live launch match leaves only by surrender; the leave button is for ending a replay.
        UiRegistry.refs.matchMenuLeaveBtn?.classList.add('hidden');
        const active =
            RecoveryTelemetry.localRecoverySession?.() || MatchLifecycle.activeSession?.();
        if (!active || active.simEnded) return;
        const replayReady = !!active.replayRecorder;
        if (UiRegistry.refs.matchMenuReplaySaveBtn)
            UiRegistry.refs.matchMenuReplaySaveBtn.disabled = !replayReady;
        if (UiRegistry.refs.matchMenuWarning)
            UiRegistry.refs.matchMenuWarning.textContent = active.sim
                ? '진행 중인 경기에서 항복하거나 나가면 패배 처리됩니다.'
                : '드래프트 중 항복하거나 나가도 패배 처리됩니다.';
        UiController.openUiModal('match-menu');
    }
    static closeMatchMenu() {
        UiController.closeUiModal('match-menu');
    }
}

class AppLifecycle {
    static async requestScreenWakeLock() {
        if (document.visibilityState !== 'visible') return;
        if (!('wakeLock' in navigator)) return;

        try {
            if (AppLifecycle.screenWakeLock && !AppLifecycle.screenWakeLock.released) return;

            AppLifecycle.screenWakeLock = await navigator.wakeLock.request('screen');
            AppLifecycle.screenWakeLock.addEventListener('release', () => {
                AppLifecycle.screenWakeLock = null;
            });
        } catch {
            // 미지원/권한 거절 환경에서도 visibility freeze 프로토콜은 정상 동작한다.
            AppLifecycle.screenWakeLock = null;
        }
    }

    static bootGateFinished = false;

    static pageHiddenAtWall = 0;

    static screenWakeLock = null;

    static backgroundTickWorker = null;
    static backgroundTickFallback = 0;

    static sessionsForVisibility() {
        if (SinglePlayerModeUtil.isSinglePlayer()) {
            return Object.values(MatchLifecycle.singleMatch.sessions || {});
        }
        return ActiveViewState.session ? [ActiveViewState.session] : [];
    }

    static pulseBackgroundSessions(now = performance.now()) {
        for (const sess of [...BACKGROUND_TICK_SESSIONS]) {
            try {
                measureSessionPulse(sess, now);
            } catch (err) {
                try {
                    if (typeof sess?.enterSimulationFatal === 'function') {
                        sess.enterSimulationFatal(err, { source: 'background-pulse' });
                    } else {
                        BACKGROUND_TICK_SESSIONS.delete(sess);
                        console.error('simulation pulse fatal', err);
                    }
                } catch (fatalErr) {
                    BACKGROUND_TICK_SESSIONS.delete(sess);
                    console.error('simulation fatal handler', fatalErr, err);
                }
            }
        }
        if (BACKGROUND_TICK_SESSIONS.size === 0) {
            AppLifecycle.stopBackgroundTicker();
            PerformanceTelemetry.stopRuntimeMonitor();
        }
    }
    static registerBackgroundSession(sess) {
        if (!sess) return;
        if (BACKGROUND_TICK_SESSIONS.size === 0) PerformanceTelemetry.startRuntimeMonitor();
        BACKGROUND_TICK_SESSIONS.add(sess);
        AppLifecycle.ensureBackgroundTicker();
    }
    static unregisterBackgroundSession(sess) {
        BACKGROUND_TICK_SESSIONS.delete(sess);
        if (BACKGROUND_TICK_SESSIONS.size === 0) {
            AppLifecycle.stopBackgroundTicker();
            PerformanceTelemetry.stopRuntimeMonitor();
        }
    }
    static applyPageVisibility() {
        const visible = document.visibilityState === 'visible';
        const allSessions = AppLifecycle.sessionsForVisibility();

        for (const sess of allSessions) {
            sess?.setLocalVisibility(visible);
        }

        if (!visible) {
            AppLifecycle.pageHiddenAtWall = Date.now();
            if (ActiveViewState.session?.sim) {
                LogUtil.status('백그라운드 전환 · 연결 이상 시 복구 버튼 사용');
            }
            return;
        }

        AppLifecycle.requestScreenWakeLock();
        AppLifecycle.pageHiddenAtWall = 0;
        AppLifecycle.pulseBackgroundSessions(performance.now());

        const active = RecoveryTelemetry.localRecoverySession();
        if (active?.simpleRecoveryNeedsManual || active?.recoveryPhase === 'needs-manual') {
            LogUtil.status(
                SinglePlayerModeUtil.isSinglePlayer()
                    ? '싱글 연결 복구 필요 · 복구 버튼을 눌러주세요'
                    : 'P2P 연결 복구 필요 · 복구 버튼을 눌러주세요',
            );
        } else if (ActiveViewState.session?.sim) {
            LogUtil.status(
                SinglePlayerModeUtil.isSinglePlayer() ? '싱글 · 게임 계속' : '연결됨 · 게임 계속',
            );
        }
    }
    static invalidateLiveConnectionForLifecycle(reason) {
        // Memory-only live match: if the page lifecycle freezes the RTC path,
        // discard that DataConnection and require the same manual Host-snapshot flow.
        const sessions = AppLifecycle.sessionsForVisibility();
        const seenTrans = new Set();
        for (const sess of sessions) {
            if (!sess?.sim || sess.simEnded) continue;
            recordRecovery('page.lifecycle-invalidates-connection', sess, sess.transport, {
                reason,
            });
            sess.markManualRecoveryNeeded(reason);
            sess.startDisconnectGrace?.(reason);
            const trans = sess.transport;
            if (trans && !seenTrans.has(trans)) {
                seenTrans.add(trans);
                trans.discardCurrentConnection?.(reason);
            }
        }
    }
    static setBootState(title, status, progress, retry = false) {
        if (UiRegistry.refs.bootTitle) UiRegistry.refs.bootTitle.textContent = title;
        if (UiRegistry.refs.bootStatus) UiRegistry.refs.bootStatus.textContent = status;
        if (UiRegistry.refs.bootProgressBar)
            UiRegistry.refs.bootProgressBar.style.width =
                Math.max(4, Math.min(100, progress)) + '%';
        if (UiRegistry.refs.bootBuild)
            UiRegistry.refs.bootBuild.textContent = BUILD_META.commit
                ? `v${PRODUCT_VERSION} · BUILD ${BUILD_META.commit.slice(0, 12)}`
                : `v${PRODUCT_VERSION} · BUILD · 배포 정보 ${BUILD_META.status === 'pending' ? '확인 중' : '확인 불가'}`;
        if (UiRegistry.refs.bootRetryBtn)
            UiRegistry.refs.bootRetryBtn.classList.toggle('hidden', !retry);
    }
    static finishBootGate() {
        if (AppLifecycle.bootGateFinished) return;
        AppLifecycle.bootGateFinished = true;
        AppLifecycle.setBootState(
            '게임 준비 완료',
            '브라우저 게임 · 별도 설치 파일 없음',
            100,
            false,
        );
        requestAnimationFrame(() => {
            UiRegistry.refs.bootGate?.classList.add('ready');
            setTimeout(() => {
                document.body.classList.remove('boot-loading');
                if (UiRegistry.refs.bootGate) UiRegistry.refs.bootGate.style.display = 'none';
            }, 180);
        });
    }
    static async runBootAndStartApp() {
        if (AppLifecycle.bootGateFinished || AppLifecycle.bootPreparing) return;
        AppLifecycle.bootPreparing = true;
        AppLifecycle.setBootState('게임 준비 중', '그래픽 리소스를 준비하고 있습니다.', 80, false);
        try {
            await new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
            if (!ActiveViewState.renderer)
                ActiveViewState.renderer = new GLRenderer(UiRegistry.refs.canvas, {
                    deferLoop: true,
                });
            ActiveViewState.renderer.prepareGameResources();
            await LaunchScreens.prepareTitleBattle();
            AppLifecycle.finishBootGate();
            NetworkModuleLoader.ensureReady();
        } catch (error) {
            AppLifecycle.setBootState(
                '그래픽 준비 실패',
                String(error?.message || error),
                80,
                true,
            );
            console.error(error);
        } finally {
            AppLifecycle.bootPreparing = false;
        }
    }
    static stopBackgroundTicker() {
        const worker = AppLifecycle.backgroundTickWorker;
        AppLifecycle.backgroundTickWorker = null;
        if (worker) {
            try {
                worker.onmessage = null;
                worker.onerror = null;
                worker.onmessageerror = null;
                worker.postMessage('stop');
            } catch {}
            try {
                worker.terminate();
            } catch {}
        }
        if (AppLifecycle.backgroundTickFallback) {
            clearTimeout(AppLifecycle.backgroundTickFallback);
            AppLifecycle.backgroundTickFallback = 0;
        }
    }
    static backgroundWorkerSource() {
        return `
    let timer=0,running=false,pending=0,sequence=0,postedAt=0;
    function arm(){
      if(!running||timer||pending)return;
      timer=setTimeout(()=>{
        timer=0;if(!running||pending)return;
        postedAt=performance.now();pending=++sequence;postMessage({type:"tick",sequence:pending});
      },Math.max(1,${BACKGROUND_TICK_PULSE_MS}-(performance.now()-postedAt)));
    }
    onmessage=e=>{
      if(e.data==="stop"){
        running=false;pending=0;if(timer)clearTimeout(timer);timer=0;return;
      }
      if(e.data==="start"){if(!running)postedAt=performance.now();running=true;arm();return;}
      if(e.data?.type==="ack"&&e.data.sequence===pending&&pending){pending=0;arm();}
    };
  `;
    }
    static startBackgroundTickFallback(delayMs = BACKGROUND_TICK_PULSE_MS) {
        if (
            !BACKGROUND_TICK_SESSIONS.size ||
            AppLifecycle.backgroundTickWorker ||
            AppLifecycle.backgroundTickFallback
        )
            return;
        // A single timeout is armed only after the previous main-thread pulse returns.
        // CPU work therefore never leaves a queue of overdue timer callbacks.
        AppLifecycle.backgroundTickFallback = setTimeout(() => {
            AppLifecycle.backgroundTickFallback = 0;
            const started = performance.now();
            try {
                AppLifecycle.pulseBackgroundSessions(performance.now());
            } finally {
                AppLifecycle.startBackgroundTickFallback(
                    Math.max(1, BACKGROUND_TICK_PULSE_MS - (performance.now() - started)),
                );
            }
        }, delayMs);
    }
    static ensureBackgroundTicker() {
        if (
            !BACKGROUND_TICK_SESSIONS.size ||
            AppLifecycle.backgroundTickWorker ||
            AppLifecycle.backgroundTickFallback
        )
            return;

        // Dedicated Worker timers are generally much less coupled to tab rendering
        // than requestAnimationFrame. Some browsers/OSes may still suspend the whole
        // page process; elapsed-time catch-up below handles that on wake.
        if (
            typeof Worker === 'function' &&
            typeof Blob === 'function' &&
            typeof URL !== 'undefined'
        ) {
            try {
                const source = AppLifecycle.backgroundWorkerSource();
                const blob = new Blob([source], { type: 'text/javascript' });
                const url = URL.createObjectURL(blob);
                let worker;
                try {
                    worker = new Worker(url);
                } finally {
                    URL.revokeObjectURL(url);
                }
                AppLifecycle.backgroundTickWorker = worker;
                worker.onmessage = (e) => {
                    if (
                        AppLifecycle.backgroundTickWorker !== worker ||
                        e.data?.type !== 'tick' ||
                        !Number.isSafeInteger(e.data.sequence)
                    )
                        return;
                    try {
                        AppLifecycle.pulseBackgroundSessions(performance.now());
                    } finally {
                        if (AppLifecycle.backgroundTickWorker === worker)
                            try {
                                worker.postMessage({ type: 'ack', sequence: e.data.sequence });
                            } catch {
                                fallback();
                            }
                    }
                };
                const fallback = () => {
                    if (AppLifecycle.backgroundTickWorker !== worker) return;
                    try {
                        worker.onmessage = null;
                        worker.onerror = null;
                        worker.onmessageerror = null;
                        worker.terminate();
                    } catch {}
                    AppLifecycle.backgroundTickWorker = null;
                    AppLifecycle.startBackgroundTickFallback();
                };
                worker.onerror = fallback;
                worker.onmessageerror = fallback;
                worker.postMessage('start');
                return;
            } catch {
                AppLifecycle.stopBackgroundTicker();
            }
        }

        AppLifecycle.startBackgroundTickFallback();
    }
}

// Shows the executed source product version and separately served deployment metadata.
class BuildMetadataPresentation {
    static renderBuildMetadata() {
        document.documentElement.dataset.productVersion = PRODUCT_VERSION;
        document.documentElement.dataset.build = BUILD_META.id;
        document.documentElement.dataset.buildStatus = BUILD_META.status;
        document.documentElement.dataset.buildCommit = BUILD_META.commit || '';
        const versionTag = document.querySelector('meta[name="ssalkongpang-version"]');
        if (versionTag) versionTag.setAttribute('content', PRODUCT_VERSION);
        const buildTag = document.querySelector('meta[name="ssalkongpang-build"]');
        const updatedTag = document.querySelector('meta[name="ssalkongpang-updated-at"]');
        if (buildTag) buildTag.setAttribute('content', BUILD_META.id);
        if (updatedTag) updatedTag.setAttribute('content', BUILD_META.updatedAt || '');

        const el = document.getElementById('titleUpdateStamp');
        if (el) {
            const updated = new Date(BUILD_META.updatedAt);
            const now = new Date();
            const validUpdated =
                BUILD_META.updatedAt !== null && Number.isFinite(updated.getTime());
            const kstDayKey = (d) =>
                new Intl.DateTimeFormat('en-CA', {
                    timeZone: 'Asia/Seoul',
                    year: 'numeric',
                    month: '2-digit',
                    day: '2-digit',
                }).format(d);
            const daySerial = (key) => Math.floor(Date.parse(key + 'T00:00:00Z') / 86400000);
            const dayDiff = validUpdated
                ? daySerial(kstDayKey(now)) - daySerial(kstDayKey(updated))
                : null;
            const buildTimeZone = 'Asia/Seoul';
            const hm = validUpdated
                ? new Intl.DateTimeFormat('ko-KR', {
                      timeZone: buildTimeZone,
                      hour: '2-digit',
                      minute: '2-digit',
                      hour12: false,
                  }).format(updated)
                : '시간 미상';
            let label;
            if (BUILD_META.status === 'pending') label = '배포 정보 확인 중';
            else if (BUILD_META.status !== 'available') label = '배포 정보 확인 불가';
            else if (!validUpdated) label = '업데이트 시간 미상';
            else if (dayDiff === 0) label = `오늘 ${hm}`;
            else if (dayDiff === 1) label = `어제 ${hm}`;
            else
                label = new Intl.DateTimeFormat('ko-KR', {
                    timeZone: 'Asia/Seoul',
                    year: 'numeric',
                    month: 'numeric',
                    day: 'numeric',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                }).format(updated);
            el.textContent = `v${PRODUCT_VERSION} · 최근 업데이트 · ${label}${BUILD_META.commit ? ` · ${BUILD_META.commit.slice(0, 12)}` : ''}`;
            el.title = BUILD_META.updatedAt
                ? `제품 v${PRODUCT_VERSION} · 배포 기록 ${BUILD_META.commit} · 복사 시각 ${BUILD_META.updatedAt} · build.json`
                : `제품 v${PRODUCT_VERSION} · 배포 정보 ${BUILD_META.status === 'pending' ? '확인 중' : '확인 불가'}`;
        }
        if (UiRegistry.refs.bootBuild)
            UiRegistry.refs.bootBuild.textContent = BUILD_META.commit
                ? `v${PRODUCT_VERSION} · BUILD ${BUILD_META.commit.slice(0, 12)}`
                : `v${PRODUCT_VERSION} · BUILD · 배포 정보 ${BUILD_META.status === 'pending' ? '확인 중' : '확인 불가'}`;
    }
}

// 조준 중 예상 착지와 최대 사거리를 표시하고, 실제 착탄 흔적은 권위 사건을 따른다.
class LaunchPresentation {
    static premiumResourceHint = '미니맵의 ✦ 기름 거점을 확보하세요.';
    static HERO_SKILL_HOLD_MS = 500;
    static card = null;
    static deckKey = '';
    static lastPower = null;
    static marks = [];
    static hold = null;
    static heroPress = null;
    static heroPressClick = null;
    static feedbackTimer = 0;
    static feedback(message) {
        const el = DomUtil.byId('launchFeedback');
        if (!el) return;
        clearTimeout(this.feedbackTimer);
        el.textContent = message;
        el.classList.remove('hidden');
        this.feedbackTimer = setTimeout(() => {
            el.classList.add('hidden');
            this.feedbackTimer = 0;
        }, 2500);
    }
    static active(s = ActiveViewState.snap) {
        return !!s && !ReplayPresentation.replayPlayer;
    }
    static reset() {
        this.card = null;
        this.deckKey = '';
        this.lastPower = null;
        this.marks = [];
        this.hold = null;
        this.endHeroPress();
        this.heroPressClick = null;
        clearTimeout(this.feedbackTimer);
        this.feedbackTimer = 0;
        DomUtil.byId('launchFeedback')?.classList.add('hidden');
    }
    static resourceBalance(s, side) {
        return {
            basic: Math.floor(s.wallet?.[side] || 0),
            premium: Math.floor(s.premiumWallet?.[side] || 0),
        };
    }

    static resourceWarning(s, side, price) {
        const balance = this.resourceBalance(s, side);
        const shortage = ResourceDisplay.shortageText(price, balance);
        if (!shortage) return '';
        return price.premiumCost > balance.premium &&
            LaunchRules.incomePerSecondFor(s.capturePoints, side, 'premium') === 0
            ? `${shortage} · ${this.premiumResourceHint}`
            : shortage;
    }

    static render(s, side) {
        const on = !!s;
        document.body.classList.toggle('launch-mode', on);
        UiRegistry.refs.launchHand?.classList.toggle('hidden', !on);
        if (this.heroPress && !this.currentHeroPress(this.heroPress, s, side))
            this.endHeroPress(true);
        if (!on) return;
        const deck = s.decks?.[side] ?? LaunchRules.starterDeck,
            heroes = s.heroes?.[side],
            balance = this.resourceBalance(s, side),
            population = LaunchRules.population(s, side);
        if (!deck.includes(this.card) || heroes?.[this.card])
            this.card =
                deck.find((type) => !LaunchRules.isHeroType(type)) ??
                deck.find((type) => !heroes?.[type]) ??
                null;
        const key = deck.join('|');
        if (key !== this.deckKey) {
            this.deckKey = key;
            UiRegistry.refs.launchCards.innerHTML = deck
                .map((type) => LaunchScreens.cardMarkup(type, LaunchRules.isHeroType(type)))
                .join('');
            LaunchScreens.fillCardPortraits(UiRegistry.refs.launchCards);
        }
        for (const el of UiRegistry.refs.launchCards.querySelectorAll('[data-launch-card]')) {
            const t = el.dataset.launchCard,
                payload = LaunchRules.payload(t);
            el.classList.toggle('selected', t === this.card);
            if (LaunchRules.isHeroType(t)) this.renderHeroCard(el, s, side, t);
            else {
                const warning = this.resourceWarning(s, side, payload);
                el.classList.toggle('unaffordable', !!warning);
                el.disabled = !this.active(s) || !!warning;
                el.setAttribute('aria-pressed', String(t === this.card));
                el.setAttribute(
                    'aria-label',
                    `${UnitDefinition.get(t).name} ${payload.count}명 · ${ResourceDisplay.costText(payload, true)}${warning ? ' · ' + warning : ''}`,
                );
                el.title = warning;
            }
        }
        ResourceDisplay.renderWallet(UiRegistry.refs.launchResources, s, side, balance);
        const limit = LaunchRules.populationLimit,
            atLimit = population.total >= limit,
            populationText = UiRegistry.refs.launchPopulationText,
            breakdown = `전장 ${population.alive}명 · 출격 대기 ${population.reserved}명`;
        populationText.textContent = `인구 ${population.total} / ${limit}${atLimit ? ' · 출격 한도' : ''}`;
        populationText.title = breakdown;
        populationText.setAttribute('aria-label', `${populationText.textContent} · ${breakdown}`);
        populationText.toggleAttribute('data-limit', atLimit);
        const level = s.launchRangeLevel?.[side] ?? 0,
            cost = LaunchRules.upgradeCost(level),
            premiumCost = LaunchRules.upgradePremiumCost(level),
            maxed = cost == null,
            price = { cost, premiumCost },
            warning = maxed ? '' : this.resourceWarning(s, side, price),
            rangeButton = UiRegistry.refs.launchRangeBtn;
        UiRegistry.refs.launchReachText.textContent = this.card
            ? `${UnitDefinition.get(this.card).name} 최대 발사 ${LaunchRules.maxReachOf(this.card, level).toLocaleString('ko-KR')}`
            : '발사할 카드 없음';
        UiRegistry.refs.launchRangeText.textContent = maxed
            ? `사거리 ×${LaunchRules.rangeMultiplier(level)} · 최대`
            : `사거리 ×${LaunchRules.rangeMultiplier(level)} → ×${LaunchRules.rangeMultiplier(level + 1)}`;
        UiRegistry.refs.launchRangeCost.textContent = maxed
            ? '강화 완료'
            : ResourceDisplay.costText(price);
        UiRegistry.refs.launchRangeStatus.hidden = !warning;
        UiRegistry.refs.launchRangeStatus.textContent = maxed
            ? ''
            : ResourceDisplay.shortageText(price, balance);
        rangeButton.disabled = maxed || !!ReplayPresentation.replayPlayer;
        rangeButton.setAttribute('aria-disabled', String(rangeButton.disabled || !!warning));
        rangeButton.title =
            warning ||
            (maxed
                ? '모든 대포의 발사 사거리가 최대로 강화됐습니다.'
                : `모든 대포의 발사 사거리 강화 · ${ResourceDisplay.costText(price, true)}`);
        this.renderHud(s, side);
        for (const event of s.events || [])
            if (event.type === 'launchRejected' && event.side === side)
                this.feedback(
                    {
                        reloading: '대포가 재장전 중입니다.',
                        'insufficient-basic-resources': `${RESOURCES[0].name}이 부족합니다.`,
                        'insufficient-premium-resources': `기름이 부족합니다. ${LaunchPresentation.premiumResourceHint}`,
                        'population-limit': '인구가 가득 찼습니다.',
                        'hero-already-deployed': '영웅이 이미 출격 중입니다.',
                        'hero-unavailable': '전사한 영웅은 이번 경기에 다시 출격할 수 없습니다.',
                        'cannon-unavailable': '사용할 수 있는 대포가 없습니다.',
                        'invalid-unit': '발사할 병종을 확인해 주세요.',
                    }[event.reason] || '발사할 수 없습니다.',
                );
        this.marks = this.marks.filter(
            (m) => !m.clock.expired && m.clock.ageMs < LaunchRules.landingMarkMs,
        );
    }
    static presentEvents(snapshot, side) {
        for (const event of snapshot.events || []) {
            if (event.type === 'heroSkillStarted' && event.side === side && this.active(snapshot)) {
                const type =
                    event.heroType ??
                    Object.entries(snapshot.heroes?.[side] ?? {}).find(
                        ([, hero]) => hero?.sortieId === event.sortieId,
                    )?.[0];
                const button = LaunchRules.isHeroType(type)
                    ? UiRegistry.refs.launchCards.querySelector(`[data-launch-card="${type}"]`)
                    : null;
                if (button) this.presentHeroSpend(button, event.cost);
                continue;
            }
            if (
                event.type === 'heroSkillRejected' &&
                event.side === side &&
                this.active(snapshot)
            ) {
                this.feedback(
                    {
                        'hero-not-deployed': '출격 중인 영웅이 필요합니다.',
                        'insufficient-basic-resources': `${RESOURCES[0].name}이 부족합니다.`,
                    }[event.reason] || '영웅 스킬을 쓸 수 없습니다.',
                );
                continue;
            }
            if (event.type === 'heroRecovered' && event.side === side && this.active(snapshot)) {
                const name = UnitDefinition.get(event.heroType)?.name ?? '영웅';
                this.feedback(`${name} 회수 · 다시 출격할 수 있습니다.`);
                continue;
            }
            if (event.type !== 'launchImpact' || event.side !== side) continue;
            const mark = { projectileId: event.projectileId, x: event.x, y: event.y };
            EffectObjectFactory.attachClock(
                mark,
                snapshot.presentationClock,
                LaunchRules.landingMarkMs,
            );
            this.marks.push(mark);
        }
    }
    static presentHeroSpend(button, cost) {
        button.querySelector('.hero-card-spend')?.remove();
        const spend = document.createElement('span');
        spend.className = 'hero-card-spend';
        spend.setAttribute('aria-hidden', 'true');
        spend.textContent = `◆ −${cost}`;
        spend.addEventListener('animationend', () => spend.remove(), { once: true });
        button.append(spend);
    }
    static renderHeroCard(el, s, side, type) {
        el.classList.add('hero-card');
        const badge = el.querySelector('em'),
            hero = s.heroes?.[side]?.[type],
            mode = hero?.mode;
        el.disabled = mode === 'dead' || !this.active(s);
        const label = {
            advance: ['ON · 진격', '영웅 복귀시키기'],
            return: ['OFF · 복귀', '영웅 진격 재개'],
            dead: ['전사', '전사한 영웅은 이번 경기에 다시 출격할 수 없습니다.'],
        }[mode] ?? ['무료', '영웅 발사'];
        badge.textContent = label[0];
        const definition = UnitDefinition.get(type),
            unit = hero?.unitId ? s.units?.find((entry) => entry.id === hero.unitId) : null,
            maxHp = unit?.maxHp ?? definition.hp,
            hp = mode === 'dead' ? 0 : (unit?.hp ?? s.heroReserveHp?.[side]?.[type] ?? maxHp),
            currentHp = RangeUtil.clamp(Math.floor(hp), 0, maxHp),
            recovering = !hero && currentHp < maxHp;
        let health = el.querySelector('.hero-card-health');
        if (!health) {
            health = document.createElement('span');
            health.className = 'hero-card-health';
            health.setAttribute('aria-hidden', 'true');
            badge.before(health);
        }
        const hpText = `${currentHp}/${maxHp}`;
        health.textContent = `♥ ${hpText}`;
        health.style.setProperty('--hero-hp', `${(100 * currentHp) / maxHp}%`);
        const skillHint = this.renderHeroSkill(
            el,
            s,
            side,
            unit,
            definition.fruitAttack?.active ?? definition.heroActive,
        );
        el.title = `${label[1]}${recovering ? ' · 회복 중' : ''}${skillHint}`;
        const attackCounter = this.renderAttackCounter(
            el,
            unit?.alive ? (unit.fruitAttack?.combo ?? unit.spinAttackBasicHits ?? 0) : null,
            definition.fruitAttack
                ? definition.fruitAttack.every - 1
                : definition.spinAttack?.rhythm?.basicsPerSweep,
        );
        el.setAttribute(
            'aria-label',
            `${definition.name} · ${label[0]} · 체력 ${hpText}${recovering ? ' · 회복 중' : ''}${attackCounter}${skillHint}`,
        );
        el.classList.toggle('hero-dead', mode === 'dead');
        if (mode === 'advance' || mode === 'return')
            el.setAttribute('aria-pressed', String(mode === 'advance'));
        else el.removeAttribute('aria-pressed');
    }
    static renderHeroSkill(el, s, side, unit, skill) {
        let badge = el.querySelector('.hero-card-skill');
        const deployed = !!skill && !!unit?.alive && this.active(s);
        el.toggleAttribute('data-hero-skill', deployed);
        if (!deployed) {
            if (badge) badge.hidden = true;
            el.removeAttribute('aria-keyshortcuts');
            return '';
        }
        const queued = unit.fruitAttack?.queued ?? unit.heroRollQueued;
        if (queued) el.removeAttribute('aria-keyshortcuts');
        else el.setAttribute('aria-keyshortcuts', 'Shift+Enter');
        if (!badge) {
            const name = el.querySelector('b'),
                row = document.createElement('span');
            row.className = 'hero-card-name';
            badge = document.createElement('span');
            badge.className = 'hero-card-skill';
            badge.setAttribute('aria-hidden', 'true');
            name.before(row);
            row.append(name, badge);
        }
        const active = unit.fruitAttack?.active;
        const status = active
            ? active.kind === 'boomerang'
                ? s.tick < active.shot.startTick
                    ? '투척 준비'
                    : '왕복 중'
                : '포도알 연사'
            : { hop: '뛰는 중', roll: '구르는 중', unfold: '자세 펴기' }[unit.heroRoll?.phase];
        badge.hidden = false;
        badge.textContent = queued ? '발동 예약' : (status ?? `길게 ◆ ${skill.cost}`);
        badge.toggleAttribute('data-queued', queued);
        badge.toggleAttribute('data-rolling', !!status);
        badge.toggleAttribute('data-unavailable', s.wallet?.[side] < skill.cost);
        if (queued) return ' · 스킬 발동 예약, 조건이 맞으면 자동 발동';
        if (status) return ` · ${status}`;
        return ` · 길게 누르기 또는 Shift+Enter로 스킬 사용 · ${ResourceDisplay.costText(skill, true)}`;
    }
    static renderAttackCounter(el, current, required) {
        let counter = el.querySelector('.hero-card-counter');
        if (current === null || !required) {
            if (counter) counter.hidden = true;
            return '';
        }
        if (!counter) {
            counter = document.createElement('span');
            counter.className = 'hero-card-counter';
            counter.setAttribute('aria-hidden', 'true');
            el.append(counter);
        }
        const count = RangeUtil.clamp(current, 0, required);
        counter.hidden = false;
        counter.textContent = '●'.repeat(count) + '○'.repeat(required - count);
        counter.toggleAttribute('data-ready', count === required);
        return ` · 공격 연계 ${count}/${required}`;
    }
    // Both main bases' health, elapsed time, and an edge arrow while the enemy base is off screen.
    static renderHud(s, side) {
        const main = BuildingDefinition.forRole('mainBase'),
            hp = (k) => {
                const b = (s.buildings || []).find((b) => b.side === k && b.type === main);
                return b && b.alive !== false
                    ? Math.ceil((100 * Math.max(0, b.hp || 0)) / Math.max(1, b.maxHp || 1))
                    : 0;
            };
        const r = ActiveViewState.renderer,
            enemy = (s.buildings || []).find(
                (b) => b.side === 1 - side && b.type === main && b.alive !== false,
            );
        let enemyDirection = null;
        if (r && enemy) {
            const { width, height } = r.canvas;
            const [x, y] = r.worldToPx(r.viewX(enemy.x), r.viewY(enemy.y));
            if (x < 0 || x > width || y < 0 || y > height) {
                const center = r.surfaceAtScreen(width / 2, height / 2);
                enemyDirection = {
                    angle: Math.atan2(y - height / 2, x - width / 2) + Math.PI / 2,
                    distance: Math.hypot(enemy.x - center.x, enemy.y - center.z),
                };
            }
        }
        const stage =
            UiRuntimeState.value.screen === 'game'
                ? campaignStage(MatchLifecycle.selectedCampaign)
                : null;
        const tps = s.tps || ActiveSimulationTiming.tps();
        CampaignPresentation.renderBattle(stage, s, side, tps);
        LaunchScreens.renderHud({
            myHpPct: hp(side),
            enemyHpPct: hp(1 - side),
            elapsedMs: (1000 * s.tick) / tps,
            enemyDirection,
        });
    }
    static selectCard(type) {
        const s = ActiveViewState.snap;
        if (!this.active(s)) return;
        const side = ConnectionSideUtil.roleSide(ActiveViewState.role),
            hero = s.heroes?.[side]?.[type];
        if (!s.decks?.[side]?.includes(type)) return;
        if (hero) {
            if (hero.mode === 'dead') return;
            if (
                !MatchLifecycle.activeSession()?.command({
                    type: 'TOGGLE_HERO',
                    sortieId: hero.sortieId,
                })
            )
                this.feedback('영웅 명령을 접수할 수 없습니다.');
            return;
        }
        this.card = type;
        this.render(s, side);
        const warning = this.resourceWarning(s, side, LaunchRules.payload(type));
        if (warning) this.feedback(warning);
    }
    static heroSkillInput(s, side, type) {
        if (
            !this.active(s) ||
            UiRuntimeState.value.screen !== 'game' ||
            UiRuntimeState.value.modal !== 'none'
        )
            return null;
        const hero = s.heroes?.[side]?.[type];
        if (!hero?.unitId || hero.mode === 'dead') return null;
        const unit = s.units?.find((entry) => entry.id === hero.unitId);
        if (!unit?.alive || unit.side !== side) return null;
        return { sortieId: hero.sortieId, queued: unit.fruitAttack?.queued ?? unit.heroRollQueued };
    }
    static currentHeroPress(press, s, side) {
        const input = this.heroSkillInput(s, side, press.button.dataset.launchCard);
        return (
            press.button.isConnected &&
            MatchLifecycle.activeSession() === press.session &&
            press.session.inputAvailable() &&
            input?.sortieId === press.sortieId &&
            (press.queued || !input.queued)
        );
    }
    static issueHeroSkill(session, sortieId) {
        if (!session.command({ type: 'ACTIVATE_HERO_SKILL', sortieId }))
            this.feedback('영웅 스킬 명령을 접수할 수 없습니다.');
    }
    static heroSkillKey(e) {
        if (
            e.key !== 'Enter' ||
            !e.shiftKey ||
            e.altKey ||
            e.ctrlKey ||
            e.metaKey ||
            !e.target.matches('[data-hero-skill]')
        )
            return;
        e.preventDefault();
        if (e.repeat || this.heroPress) return;
        const side = ConnectionSideUtil.roleSide(ActiveViewState.role),
            input = this.heroSkillInput(ActiveViewState.snap, side, e.target.dataset.launchCard),
            session = MatchLifecycle.activeSession();
        if (input && !input.queued && session?.inputAvailable())
            this.issueHeroSkill(session, input.sortieId);
    }
    static pressHeroCard(e) {
        if (!e.isPrimary || e.button !== 0) return;
        this.endHeroPress();
        this.heroPressClick = null;
        const button = e.target.closest('[data-launch-card][data-hero-skill]');
        if (!button) return;
        const side = ConnectionSideUtil.roleSide(ActiveViewState.role),
            input = this.heroSkillInput(ActiveViewState.snap, side, button.dataset.launchCard),
            session = MatchLifecycle.activeSession();
        if (!input || !session?.inputAvailable()) return;
        const press = {
            button,
            pointerId: e.pointerId,
            x: e.clientX,
            y: e.clientY,
            session,
            ...input,
        };
        if (!press.queued) {
            button.style.setProperty('--hero-hold-duration', `${this.HERO_SKILL_HOLD_MS}ms`);
            button.setAttribute('data-hero-charging', '');
        }
        press.timer = setTimeout(() => {
            // A held card must never fall through to the short-tap toggle.
            this.endHeroPress(true);
            const currentSide = ConnectionSideUtil.roleSide(ActiveViewState.role);
            if (
                press.queued ||
                document.hidden ||
                !this.currentHeroPress(press, ActiveViewState.snap, currentSide)
            )
                return;
            this.issueHeroSkill(session, press.sortieId);
        }, this.HERO_SKILL_HOLD_MS);
        this.heroPress = press;
    }
    static moveHeroPress(e) {
        const press = this.heroPress;
        if (press?.pointerId !== e.pointerId) return;
        const rect = press.button.getBoundingClientRect();
        if (
            Math.hypot(e.clientX - press.x, e.clientY - press.y) > LAUNCH_HOLD_DRAG_PX ||
            e.clientX < rect.left ||
            e.clientX >= rect.right ||
            e.clientY < rect.top ||
            e.clientY >= rect.bottom
        )
            this.endHeroPress(true);
    }
    static endHeroPress(suppressClick = false) {
        const press = this.heroPress;
        if (!press) return;
        clearTimeout(press.timer);
        press.button.removeAttribute('data-hero-charging');
        this.heroPress = null;
        if (suppressClick)
            this.heroPressClick = { button: press.button, pointerId: press.pointerId };
    }
    static consumeHeroClick(e, button) {
        const press = this.heroPressClick;
        // Keyboard clicks have no pointer and must keep their tap behavior.
        if (
            press?.button !== button ||
            !e.detail ||
            (e.pointerType && e.pointerId !== press.pointerId)
        )
            return false;
        this.heroPressClick = null;
        return true;
    }
    static upgradeRange() {
        if (!this.active()) return;
        const s = ActiveViewState.snap,
            side = ConnectionSideUtil.roleSide(ActiveViewState.role),
            level = s.launchRangeLevel?.[side] ?? 0,
            cost = LaunchRules.upgradeCost(level);
        if (cost == null) return;
        const warning = this.resourceWarning(s, side, {
            cost,
            premiumCost: LaunchRules.upgradePremiumCost(level),
        });
        if (warning) {
            this.feedback(warning);
            return;
        }
        if (!MatchLifecycle.activeSession()?.command({ type: 'UPGRADE_LAUNCH_RANGE' }))
            LogUtil.log('⚠ 사거리 강화 명령을 접수할 수 없습니다.');
    }
    static nearestCannon(s, side, x, y) {
        const main = BuildingDefinition.forRole('mainBase'),
            outpost = BuildingDefinition.forRole('outpost');
        let best = null,
            bestD = Infinity;
        for (const b of s.buildings || []) {
            if (
                b.side !== side ||
                b.alive === false ||
                b.construction ||
                (b.type !== main && b.type !== outpost)
            )
                continue;
            const d = Math.hypot(b.x - x, b.y - y);
            if (d < bestD) {
                bestD = d;
                best = b;
            }
        }
        return best;
    }
    static begin(a, pointerId) {
        const s = ActiveViewState.snap,
            side = ConnectionSideUtil.roleSide(ActiveViewState.role),
            cannon = s && this.nearestCannon(s, side, a.x, a.y);
        if (!cannon || !this.card) return null;
        if (LaunchRules.population(s, side).total >= LaunchRules.populationLimit) {
            this.feedback('인구가 가득 찼습니다.');
            return null;
        }
        const wait = Math.max(0, (Number(cannon.launchReadyTick) || 0) - s.tick);
        if (wait > 0) {
            this.feedback(
                `대포 재장전 중 · ${(wait / (s.tps || ActiveSimulationTiming.tps())).toFixed(1)}초`,
            );
            return null;
        }
        const warning = this.resourceWarning(s, side, LaunchRules.payload(this.card));
        if (warning) {
            this.feedback(warning);
            return null;
        }
        this.hold = {
            pointerId,
            cannonId: cannon.id,
            cannonX: cannon.x,
            cannonY: cannon.y,
            aimX: a.x,
            aimY: a.y,
            armedAt: performance.now(),
            card: this.card,
            lastPower: this.lastPower,
            side,
        };
        if (navigator.vibrate) navigator.vibrate(12);
        return this.hold;
    }
    static aim(a) {
        if (this.hold) {
            this.hold.aimX = a.x;
            this.hold.aimY = a.y;
        }
    }
    // Where the sim will land this hold: same rule and fallback direction as the LAUNCH command.
    static landing(hold, holdMs, world) {
        const s = ActiveViewState.snap,
            side = hold.side ?? ConnectionSideUtil.roleSide(ActiveViewState.role),
            flag = s?.flags?.[side] || { x: hold.cannonX, y: hold.cannonY };
        return LaunchRules.target(
            { x: hold.cannonX, y: hold.cannonY },
            hold.aimX,
            hold.aimY,
            Math.max(0, Math.round(holdMs)),
            world,
            flag,
            hold.card,
            s?.launchRangeLevel?.[side] ?? 0,
        );
    }
    static aimPreview(hold, holdMs, world) {
        const cannon = { x: hold.cannonX, y: hold.cannonY };
        const aim = this.landing(hold, holdMs, world);
        const shots = LaunchRules.volley(hold.card, aim, cannon, world);
        const grain = LaunchRules.grain(hold.card);
        const formation = [];
        if (grain.land === 'transverse') {
            for (const shot of shots) {
                const dx = shot.x - cannon.x,
                    dy = shot.y - cannon.y,
                    distance = Math.hypot(dx, dy) || 1;
                const group = { ...shot, dirX: dx / distance, dirY: dy / distance };
                for (let index = 0; index < shot.count; index++) {
                    const point = LaunchRules.lineDeploymentPosition(group, index, grain.spacing);
                    formation.push({ ...point, radius: 8 });
                }
            }
        } else if (grain.land === 'compact') {
            for (const shot of shots) formation.push({ x: shot.x, y: shot.y, radius: 18 });
        }
        return { aim, shots, formation };
    }
    // While charging, the camera eases just far enough to keep the whole preview on screen.
    static FOLLOW_HALF_LIFE_MS = 52;
    static followAt = null;
    static followAim(r) {
        const hold = this.hold;
        if (!hold || !r.world) {
            this.followAt = null;
            if (this.labelShown) {
                this.labelShown = false;
                LaunchScreens.renderAimLabel(null);
            }
            return;
        }
        const { aim, shots, formation } = this.aimPreview(
            hold,
            performance.now() - hold.armedAt,
            r.world,
        );
        const vw = r.viewWorldW(),
            vh = r.viewWorldH(),
            points = [
                ...shots.map((shot) => ({ x: shot.x, y: shot.y, radius: shot.splash })),
                ...formation,
            ];
        let minX = Infinity,
            minY = Infinity,
            maxX = -Infinity,
            maxY = -Infinity;
        for (const point of points) {
            const x = r.viewX(point.x),
                y = BattlefieldProjection.planarY(
                    r.viewY(point.y),
                    r.world.terrain.surfaces.heightAt(point.x, point.y),
                ),
                radiusY = BattlefieldProjection.planarY(point.radius);
            minX = Math.min(minX, x - point.radius);
            maxX = Math.max(maxX, x + point.radius);
            minY = Math.min(minY, y - radiusY);
            maxY = Math.max(maxY, y + radiusY);
        }
        // Give the label and HUD room above the outline. Center oversized patterns in a narrow view.
        const hud = (120 * vw) / Math.max(1, r.canvas.clientWidth);
        const frame = (current, low, high) =>
            low > high ? (low + high) / 2 : RangeUtil.clamp(current, low, high);
        const left = frame(r.cameraLeft, maxX + 80 - vw, minX - 80),
            top = frame(r.cameraTop, maxY + 80 - vh, minY - 80 - hud);
        // The shared camera eases toward that framing by half-life, so the pace does not depend on the frame rate.
        const camera = r.stableCamera(),
            halfH = vh / 2,
            now = performance.now(),
            elapsed = Math.min(100, now - (this.followAt ?? now));
        this.followAt = now;
        camera.follow(left + vw / 2, top + halfH, elapsed, this.FOLLOW_HALF_LIFE_MS);
        r.cameraLeft = RangeUtil.clamp(
            camera.camera.x - vw / 2,
            0,
            Math.max(0, r.world.width - vw),
        );
        r.cameraTop = r.clampCameraTop(camera.camera.y - halfH);
        // Convert the highest ring edge from projected world coordinates to CSS pixels.
        const [lx] = r.worldToPx(r.viewX(aim.x), r.viewY(aim.y)),
            k = r.canvas.clientWidth / Math.max(1, r.canvas.width);
        this.labelShown = true;
        LaunchScreens.renderAimLabel(
            { x: lx * k, y: (minY - r.cameraTop) * r.sc() * k - 6 },
            hold.card,
            LaunchRules.maxReachOf(
                hold.card,
                ActiveViewState.snap?.launchRangeLevel?.[hold.side] ?? 0,
            ),
        );
    }
    static cancel() {
        this.hold = null;
    }
    static release(a) {
        const hold = this.hold;
        this.hold = null;
        if (!hold) return;
        if (a) {
            hold.aimX = a.x;
            hold.aimY = a.y;
        }
        const holdMs = Math.round(performance.now() - hold.armedAt),
            sess = MatchLifecycle.activeSession();
        if (!sess?.sim || !ActiveViewState.snap) return;
        const warning = this.resourceWarning(
            ActiveViewState.snap,
            hold.side,
            LaunchRules.payload(hold.card),
        );
        if (warning) {
            this.feedback(warning);
            return;
        }
        const accepted = sess.command({
            type: 'LAUNCH',
            cannonId: hold.cannonId,
            x: Math.round(hold.aimX),
            y: Math.round(hold.aimY),
            holdMs,
            unitType: hold.card,
        });
        if (!accepted) {
            this.feedback('연결을 확인한 뒤 다시 발사해 주세요.');
            return;
        }
        if (LaunchRules.overheated(holdMs)) {
            this.feedback(`과열! 대포가 ${LaunchRules.overheatMs / 1000}초 멈춥니다.`);
            if (navigator.vibrate) navigator.vibrate([30, 40, 30]);
            return;
        }
        this.lastPower = LaunchRules.power(holdMs);
        if (navigator.vibrate) navigator.vibrate(20);
    }
}
class BattlePresentation {
    // The battlefield takes one gesture: a still press charges a launch, a drag pans the camera. Replay only pans.
    static setupCanvas() {
        const armLaunchHold = () => {
            const drag = ActiveViewState.drag;
            drag.launchTimer = setTimeout(() => {
                drag.launchTimer = 0;
                if (ActiveViewState.drag !== drag || drag.moved || !ActiveViewState.renderer)
                    return;
                const [vx, vy] = ActiveViewState.renderer.pxToWorld(drag.lastX, drag.lastY);
                drag.launchHold = LaunchPresentation.begin(
                    UiController.viewToAuth(vx, vy),
                    drag.id,
                );
            }, LAUNCH_HOLD_ARM_MS);
        };
        const cancelLaunchHold = () => {
            const drag = ActiveViewState.drag;
            if (drag?.launchTimer) {
                clearTimeout(drag.launchTimer);
                drag.launchTimer = 0;
            }
            if (drag) drag.launchHold = null;
            LaunchPresentation.cancel();
        };

        // A pinch consumes both pointers, so it can never release an armed cannon.
        const touches = new Map();
        let pinch = null;
        let suppressTouch = false;
        const zoomAt = (value, clientX, clientY) => {
            const r = ActiveViewState.renderer;
            if (!r || UiRuntimeState.value.screen !== 'game' || !r.hasDisplayArea()) return;
            const rect = r.canvas.getBoundingClientRect();
            const px = ((clientX - rect.left) / rect.width) * r.canvas.width;
            const py = ((clientY - rect.top) / rect.height) * r.canvas.height;
            const point = r.projectedCoordinatesAtScreen(px, py);
            r.replayZoom = RangeUtil.clamp(value, 0.6, MAX_LIVE_ZOOM);
            const scale = r.sc(),
                vw = r.viewWorldW();
            r.cameraLeft = RangeUtil.clamp(
                point.x - (px - r.canvas.width / 2) / scale - vw / 2,
                0,
                Math.max(0, r.world.width - vw),
            );
            r.cameraTop = r.clampCameraTop(point.y - py / scale);
            ActiveViewState.minimap?.draw();
        };
        UiRegistry.refs.canvas.addEventListener(
            'wheel',
            (e) => {
                if (UiRuntimeState.value.screen !== 'game' || !ActiveViewState.renderer) return;
                e.preventDefault();
                cancelLaunchHold();
                const units = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? 300 : 1;
                zoomAt(
                    ActiveViewState.renderer.replayZoom * Math.exp(-e.deltaY * units * 0.001),
                    e.clientX,
                    e.clientY,
                );
            },
            { passive: false },
        );
        const handleTouch = (point, event) => {
            if (event.pointerType !== 'touch' || UiRuntimeState.value.screen !== 'game')
                return false;
            if (point.type === 'down')
                touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
            else if (point.type === 'move' && touches.has(event.pointerId))
                touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
            if (touches.size >= 2 && !pinch) {
                cancelLaunchHold();
                ActiveViewState.drag = null;
                const [a, b] = [...touches.values()];
                pinch = {
                    distance: Math.max(1, Math.hypot(a.x - b.x, a.y - b.y)),
                    zoom: ActiveViewState.renderer.replayZoom,
                };
                suppressTouch = true;
            }
            if (pinch && point.type === 'move' && touches.size >= 2) {
                const [a, b] = [...touches.values()];
                zoomAt(
                    (pinch.zoom * Math.hypot(a.x - b.x, a.y - b.y)) / pinch.distance,
                    (a.x + b.x) / 2,
                    (a.y + b.y) / 2,
                );
            }
            const consumed = suppressTouch;
            if (point.type === 'up' || point.type === 'cancel') {
                touches.delete(event.pointerId);
                if (touches.size < 2) pinch = null;
                if (!touches.size) suppressTouch = false;
            }
            return consumed;
        };

        const pointerDown = (e) => {
            if (ActiveViewState.drag && ActiveViewState.drag.id !== e.pointerId) return;
            if (ActiveViewState.drag) cancelLaunchHold();
            audioSystem.unlock();
            e.preventDefault();
            if (!ActiveViewState.renderer) return;
            ActiveViewState.drag = {
                id: e.pointerId,
                x: e.clientX,
                y: e.clientY,
                lastX: e.clientX,
                lastY: e.clientY,
                left: ActiveViewState.renderer.cameraLeft,
                top: ActiveViewState.renderer.cameraTop,
                moved: false,
            };
            if (LaunchPresentation.active()) armLaunchHold();
        };

        const pointerMove = (e) => {
            const drag = ActiveViewState.drag,
                r = ActiveViewState.renderer;
            if (!r || !drag || drag.id !== e.pointerId) return;
            e.preventDefault();
            if (drag.launchHold) {
                const [vx, vy] = r.pxToWorld(e.clientX, e.clientY);
                LaunchPresentation.aim(UiController.viewToAuth(vx, vy));
            } else {
                if (
                    !drag.moved &&
                    Math.hypot(e.clientX - drag.x, e.clientY - drag.y) > LAUNCH_HOLD_DRAG_PX
                ) {
                    drag.moved = true;
                    cancelLaunchHold();
                }
                if (drag.moved) {
                    const rect = UiRegistry.refs.canvas.getBoundingClientRect(),
                        dx = ((e.clientX - drag.x) * UiRegistry.refs.canvas.width) / rect.width,
                        dy = ((e.clientY - drag.y) * UiRegistry.refs.canvas.height) / rect.height,
                        scale = r.sc();
                    r.cameraLeft = RangeUtil.clamp(
                        drag.left - dx / scale,
                        0,
                        Math.max(0, (r.world || WorldContext.standard).width - r.viewWorldW()),
                    );
                    r.cameraTop = r.clampCameraTop(drag.top - dy / scale);
                }
            }
            drag.lastX = e.clientX;
            drag.lastY = e.clientY;
        };

        const pointerCancel = (e) => {
            if (ActiveViewState.drag?.id !== e.pointerId) return;
            cancelLaunchHold();
            ActiveViewState.drag = null;
        };

        const pointerUp = (e) => {
            const drag = ActiveViewState.drag;
            if (!drag || drag.id !== e.pointerId) return;
            e.preventDefault();
            ActiveViewState.drag = null;
            if (drag.launchTimer) clearTimeout(drag.launchTimer);
            if (drag.launchHold && ActiveViewState.renderer) {
                const [vx, vy] = ActiveViewState.renderer.pxToWorld(e.clientX, e.clientY);
                LaunchPresentation.release(UiController.viewToAuth(vx, vy));
            }
        };

        RallyGamekit.createDOMInput({
            target: UiRegistry.refs.canvas,
            pointerButtons: { 0: 'battlefield' },
            touchAction: 'none',
            onPointer: (point) => {
                const event = point.originalEvent || point;
                // Points on a hidden battlefield cannot aim: a press there is ignored and a release cancels the hold.
                if (
                    point.type !== 'cancel' &&
                    ActiveViewState.renderer &&
                    !ActiveViewState.renderer.hasDisplayArea()
                ) {
                    if (point.type === 'up') pointerCancel(event);
                    return;
                }
                if (handleTouch(point, event)) return;
                if (point.type === 'down') pointerDown(event);
                else if (point.type === 'move') pointerMove(event);
                else if (point.type === 'up') pointerUp(event);
                else pointerCancel(event);
            },
            onRelease: () => {
                cancelLaunchHold();
                ActiveViewState.drag = null;
                touches.clear();
                pinch = null;
                suppressTouch = false;
            },
        });
    }

    static renderGame(s) {
        // An already queued snapshot must never switch Result back to Game.
        if (UiRuntimeState.value.screen === 'result') return;
        const side = ConnectionSideUtil.roleSide(ActiveViewState.role);
        if (!MatchLifecycle.activeSession()?.sim) {
            DiagnosticPresentation.presentFatalDiagnostic({
                kind: 'SSALKONGPANG_PRESENTATION_CONTRACT_FATAL',
                build: BUILD_META.id,
                buildMetadata: BUILD_META.snapshot(),
                at: new Date().toISOString(),
                source: 'BattlePresentation.renderGame',
                role: ActiveViewState.role,
                tick: Number(s?.tick) || 0,
                message: 'Live snapshot reached game presentation without an active simulation.',
            });
            return;
        }
        const enteringGame = UiRuntimeState.value.screen !== 'game';
        UiController.setUiScreen('game');
        UiController.closeUiModal('create');
        UiController.closeUiModal('join');
        ActiveViewState.snap = s;
        if (enteringGame)
            requestAnimationFrame(() => ConnectionPresentation.positionP2PHealthNextToMenu());

        const rendererRoleChanged =
            !!ActiveViewState.renderer && ActiveViewState.renderer.role !== ActiveViewState.role;
        if (!ActiveViewState.renderer) {
            ActiveViewState.renderer = new GLRenderer(UiRegistry.refs.canvas);
            LogUtil.log(
                `렌더러 ${ActiveViewState.renderer.backend} · 입력/UI ${STATE_PUBLISH_HZ}Hz · Render Target ${ActiveSimulationTiming.tps()}Hz · 시뮬 ${ActiveSimulationTiming.tps()}TPS · 렌더 rAF 60Hz+`,
            );
        }
        ActiveViewState.renderer.role = ActiveViewState.role;
        // Live gameplay owns its faction strictly from role. Replay-only fields must never
        // leak into host/guest colors, FoW ownership or minimap ownership.
        ActiveViewState.renderer.replayPerspectiveSide = null;
        ActiveViewState.renderer.replayOrientationRole = null;
        ActiveViewState.renderer.replayVisionMode = null;
        ActiveViewState.renderer.replayObserverAll = false;
        if (!ActiveViewState.minimap)
            ActiveViewState.minimap = new MiniMap(UiRegistry.refs.minimapCanvas);
        ActiveViewState.renderer.startLoop();
        ActiveViewState.renderer.setSnapshot(s, {
            liveTargets: true,
            snapTargets: rendererRoleChanged,
        });
        MatchLifecycle.activeSession()?.flushPresentationEvents(s);
        LaunchPresentation.render(s, side);
        if (enteringGame) {
            const r = ActiveViewState.renderer;
            r.replayZoom = DEFAULT_LIVE_ZOOM;
            r.resize();
            const base = r.world.bases[side],
                width = r.viewWorldW(),
                height = r.world.terrain.surfaces.heightAt(base.x, base.y);
            r.cameraLeft = RangeUtil.clamp(r.viewX(base.x) - width / 2, 0, r.world.width - width);
            r.cameraTop = r.clampCameraTop(
                BattlefieldProjection.planarY(r.viewY(base.y), height) - r.viewWorldH() / 2,
            );
        }
        ActiveViewState.minimap.set(ActiveViewState.renderer, s);
        ActiveViewState.minimap.draw();
        audioSystem.processSnapshot(s, ActiveViewState.renderer);
    }
}

const UI_MODAL_DIALOG_KEYS = Object.freeze({ create: 'createDialog', join: 'joinDialog' });

class ActiveSimulationTiming {
    static tps() {
        // Query the real active GameSession. `runtime` was a refactor-only phantom owner.
        const active =
            typeof MatchLifecycle !== 'undefined' ? MatchLifecycle.activeSession() : null;
        return RangeUtil.clamp(
            Math.round(
                Number(
                    active?.sim?.tps ||
                        active?.roundRules?.simulation?.tps ||
                        active?.matchConfig?.simulationTps ||
                        UiRuntimeState.value?.settings?.simulationTps ||
                        SIM_TPS,
                ),
            ),
            10,
            30,
        );
    }
    static tickMs() {
        return 1000 / this.tps();
    }
    static ticksToSeconds(ticks) {
        return Number(ticks || 0) / this.tps();
    }
    static elapsedMinutes(ticks) {
        return Math.max(1 / this.tps(), Number(ticks || 0) / this.tps()) / 60;
    }
}

UiRegistry.refs.joinConfirm.addEventListener('click', (e) => {
    e.preventDefault();
    if (!UiRegistry.refs.joinConfirm.disabled) MatchLifecycle.submitJoinRoom();
});

UiRegistry.refs.room.oninput = () => {
    UiRegistry.refs.room.value = UiRegistry.refs.room.value.replace(/\D/g, '').slice(0, 4);
    if (UiRegistry.refs.joinError.textContent) UiRegistry.refs.joinError.textContent = '';
};

UiRegistry.refs.room.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
        e.preventDefault();
        if (!UiRegistry.refs.joinConfirm.disabled) MatchLifecycle.submitJoinRoom();
    }
});

UiRegistry.refs.createRetry.onclick = () => MatchLifecycle.beginCreateRoom();
UiRegistry.refs.createClose.onclick = () => MatchLifecycle.cancelOnlinePreparation();
UiRegistry.refs.joinClose.onclick = () => MatchLifecycle.cancelOnlinePreparation();
for (const dialog of [UiRegistry.refs.createDialog, UiRegistry.refs.joinDialog]) {
    dialog.addEventListener('click', (e) => {
        if (e.target === dialog) MatchLifecycle.cancelOnlinePreparation();
    });
    dialog.addEventListener('cancel', (e) => {
        e.preventDefault();
        MatchLifecycle.cancelOnlinePreparation();
    });
}
/*
 * 게임 입력 계약
 * 1) 일반 UI 선택/버튼은 click 확정 후 처리한다. 스크롤 시작(pointerdown)은 선택이 아니다.
 * 2) 동적 버튼은 안정적인 부모에 click 이벤트를 위임한다.
 * 3) 동적 TPS 시뮬레이션 렌더는 동일한 인터랙티브 DOM을 재생성하지 않는다.
 * 4) Guest 권위 입력은 proposal → Host commit → ACK/수렴 경로만 사용한다.
 */

UiRegistry.refs.matchMenuReplaySaveBtn?.addEventListener('click', () => {
    const data = ReplayPresentation.currentReplayPayload();
    if (data) ReplayPresentation.downloadReplay(data);
    else LogUtil.log('아직 저장할 전투 리플레이가 없습니다.');
});
UiRegistry.refs.matchMenuSurrenderBtn?.addEventListener('click', () =>
    MatchLifecycle.requestMatchSurrender(),
);
UiRegistry.refs.matchMenuLeaveBtn?.addEventListener('click', () => {
    if (ReplayPresentation.replayPlayer) {
        MatchLifecycle.closeMatchMenu();
        ReplayPresentation.stopReplay();
        return;
    }
    MatchLifecycle.requestMatchSurrender({ leave: true });
});
UiRegistry.refs.disconnectReconnectBtn?.addEventListener(
    'click',
    ConnectionPresentation.requestConnectionReconnect,
);
UiRegistry.refs.disconnectSurrenderBtn?.addEventListener('click', () =>
    MatchLifecycle.requestMatchSurrender({ leave: true }),
);
setInterval(ConnectionPresentation.renderConnectionGate, 100);
setInterval(() => {
    if (UiRuntimeState.value.screen === 'game' && ConnectionPresentation.lastP2PHealthInfo)
        ConnectionPresentation.renderP2PHealth(
            ConnectionPresentation.lastP2PHealthInfo,
            ConnectionPresentation.lastP2PHealthLocal,
        );
}, 250);

UiRegistry.refs.replaySaveBtn?.addEventListener('click', () => {
    const data = ReplayPresentation.currentReplayPayload();
    if (!data) {
        LogUtil.log('저장할 리플레이가 없습니다.');
        return;
    }
    ReplayPresentation.downloadReplay(data);
});
UiRegistry.refs.replayWatchBtn?.addEventListener('click', () => {
    const data = ReplayPresentation.currentReplayPayload();
    if (!data) {
        LogUtil.log('재생할 리플레이가 없습니다.');
        return;
    }
    ReplayPresentation.startReplay(data);
});
UiRegistry.refs.replayOpenBtn?.addEventListener('click', () =>
    UiRegistry.refs.replayFileInput?.click(),
);
UiRegistry.refs.replayFileInput?.addEventListener('change', async () => {
    const file = UiRegistry.refs.replayFileInput.files?.[0];
    if (!file) return;
    ReplayPresentation.clearReplayImportError();
    try {
        const data = JSON.parse(await file.text());
        const started = ReplayPresentation.startReplay(data, {
            onError: (error) => ReplayPresentation.showReplayImportError(error),
        });
        if (started) ReplayPresentation.clearReplayImportError();
    } catch (e) {
        LogUtil.log(`⚠ 리플레이 열기 실패 · ${e.message || e}`);
        ReplayPresentation.showReplayImportError(e);
    } finally {
        UiRegistry.refs.replayFileInput.value = '';
    }
});
UiRegistry.refs.replayPlayPauseBtn?.addEventListener('click', () =>
    ReplayPresentation.replayPlayer?.setPlaying(!ReplayPresentation.replayPlayer.playing),
);
UiRegistry.refs.replaySpeed?.addEventListener('change', () =>
    ReplayPresentation.replayPlayer?.setSpeed(UiRegistry.refs.replaySpeed.value),
);
class ReplayInteraction {
    static seekSeconds(seconds, { resumePlaying = null } = {}) {
        if (!ReplayPresentation.replayPlayer) return;
        const targetTick = Math.round(
            RangeUtil.clamp(
                Number(seconds) || 0,
                0,
                ReplayPresentation.replayPlayer.endTick / ActiveSimulationTiming.tps(),
            ) * ActiveSimulationTiming.tps(),
        );
        const shouldResume =
            resumePlaying == null ? !!ReplayPresentation.replayPlayer.playing : !!resumePlaying;
        try {
            if ((ReplayPresentation.replayPlayer.sim?.tick || 0) !== targetTick)
                ReplayPresentation.timeline.seek(targetTick);
        } catch (error) {
            LogUtil.log(`⚠ 리플레이 시간 이동 실패 · ${error.message || error}`);
            if (UiRegistry.refs.replayTimeInput)
                UiRegistry.refs.replayTimeInput.value = ReplayPresentation.formatReplayTime(
                    ReplayPresentation.replayPlayer.sim?.tick || 0,
                );
        }
        ReplayPresentation.replayPlayer.setPlaying(
            shouldResume &&
                (ReplayPresentation.replayPlayer.sim?.tick || 0) <
                    ReplayPresentation.replayPlayer.endTick,
        );
        ReplayPresentation.syncReplayControls();
    }
    static parseTimeInput(value) {
        const raw = String(value || '').trim();
        if (!raw) return null;
        if (/^\d+(?:\.\d+)?$/.test(raw)) return Number(raw);
        const m = raw.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);
        if (!m) return null;
        return Number(m[1]) * 60 + Number(m[2]) + Number('0.' + (m[3] || '0'));
    }
}
UiRegistry.refs.replayTimeline?.addEventListener('pointerdown', () => {
    if (!ReplayPresentation.replayPlayer) return;
    ReplayPresentation.replayTimelineDragging = true;
    if (ReplayPresentation.replayTimelineResumePlaying == null)
        ReplayPresentation.replayTimelineResumePlaying = !!ReplayPresentation.replayPlayer.playing;
    ReplayPresentation.replayPlayer.setPlaying(false);
});
UiRegistry.refs.replayTimeline?.addEventListener('input', () => {
    if (!ReplayPresentation.replayPlayer) return;
    ReplayPresentation.replayTimelineDragging = true;
    if (UiRegistry.refs.replayTime)
        UiRegistry.refs.replayTime.textContent = `${ReplayPresentation.formatReplayTime((Number(UiRegistry.refs.replayTimeline.value) || 0) * ActiveSimulationTiming.tps())} / ${ReplayPresentation.formatReplayTime(ReplayPresentation.replayPlayer.endTick)}`;
});
class ReplayTimelineInteraction {
    static commit() {
        if (!ReplayPresentation.replayPlayer || !UiRegistry.refs.replayTimeline) return;
        const sec = Number(UiRegistry.refs.replayTimeline.value) || 0;
        const resumePlaying =
            ReplayPresentation.replayTimelineResumePlaying == null
                ? !!ReplayPresentation.replayPlayer.playing
                : ReplayPresentation.replayTimelineResumePlaying;
        ReplayPresentation.replayTimelineDragging = false;
        ReplayPresentation.replayTimelineResumePlaying = null;
        ReplayInteraction.seekSeconds(sec, { resumePlaying });
    }
}
// Range controls already emit one `change` at commit time for mouse/touch/keyboard.
// Do not also seek on pointerup: that would replay the same expensive seek twice.
UiRegistry.refs.replayTimeline?.addEventListener('change', ReplayTimelineInteraction.commit);
UiRegistry.refs.replayTimeline?.addEventListener('pointercancel', () => {
    ReplayPresentation.replayTimelineDragging = false;
    if (ReplayPresentation.replayPlayer && ReplayPresentation.replayTimelineResumePlaying != null)
        ReplayPresentation.replayPlayer.setPlaying(ReplayPresentation.replayTimelineResumePlaying);
    ReplayPresentation.replayTimelineResumePlaying = null;
    ReplayPresentation.syncReplayControls();
});
UiRegistry.refs.replayTimeGoBtn?.addEventListener('click', () => {
    const sec = ReplayInteraction.parseTimeInput(UiRegistry.refs.replayTimeInput?.value);
    if (sec == null) {
        LogUtil.log('시간 형식은 MM:SS 또는 초 단위로 입력하세요.');
        return;
    }
    ReplayInteraction.seekSeconds(sec);
});
UiRegistry.refs.replayTimeInput?.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') UiRegistry.refs.replayTimeGoBtn?.click();
});
UiRegistry.refs.replayStepBackBtn?.addEventListener('click', () =>
    ReplayInteraction.seekSeconds(
        (ReplayPresentation.replayPlayer?.sim?.tick || 0) / ActiveSimulationTiming.tps() - 5,
    ),
);
UiRegistry.refs.replayStepForwardBtn?.addEventListener('click', () =>
    ReplayInteraction.seekSeconds(
        (ReplayPresentation.replayPlayer?.sim?.tick || 0) / ActiveSimulationTiming.tps() + 5,
    ),
);
UiRegistry.refs.replayStepBack30Btn?.addEventListener('click', () =>
    ReplayInteraction.seekSeconds(
        (ReplayPresentation.replayPlayer?.sim?.tick || 0) / ActiveSimulationTiming.tps() - 30,
    ),
);
UiRegistry.refs.replayStepForward30Btn?.addEventListener('click', () =>
    ReplayInteraction.seekSeconds(
        (ReplayPresentation.replayPlayer?.sim?.tick || 0) / ActiveSimulationTiming.tps() + 30,
    ),
);
UiRegistry.refs.replayHostViewBtn?.addEventListener('click', () =>
    ReplayPresentation.replayPlayer?.setViewMode('host'),
);
UiRegistry.refs.replayGuestViewBtn?.addEventListener('click', () =>
    ReplayPresentation.replayPlayer?.setViewMode('guest'),
);
UiRegistry.refs.replayAllViewBtn?.addEventListener('click', () =>
    ReplayPresentation.replayPlayer?.setViewMode('all'),
);
UiRegistry.refs.replayHostOrientationBtn?.addEventListener('click', () =>
    ReplayPresentation.replayPlayer?.setOrientation('host'),
);
UiRegistry.refs.replayGuestOrientationBtn?.addEventListener('click', () =>
    ReplayPresentation.replayPlayer?.setOrientation('guest'),
);
UiRegistry.refs.replayZoomOutBtn?.addEventListener('click', () =>
    ReplayPresentation.replayPlayer?.setZoom((ReplayPresentation.replayPlayer.zoom || 1) - 0.2),
);
UiRegistry.refs.replayZoomInBtn?.addEventListener('click', () =>
    ReplayPresentation.replayPlayer?.setZoom((ReplayPresentation.replayPlayer.zoom || 1) + 0.2),
);
UiRegistry.refs.replayExitBtn?.addEventListener('click', ReplayPresentation.stopReplay);

// A rematch reloads into a fresh match: the AI starts again from #/play, a friend match goes back to the friend sheet.
const reloadAt = (hash) => {
    history.replaceState(null, '', location.pathname + location.search + hash);
    location.reload();
};
UiController.bindImmediateButton(UiRegistry.refs.rematch, () => {
    const stage = campaignStage(MatchLifecycle.selectedCampaign);
    if (stage) MatchLifecycle.startCampaignStage(stage);
    else reloadAt(MatchLifecycle.singleMatch ? '#/play' : '#/friend');
});
BattlePresentation.setupCanvas();

// Recovery initiation must mirror a real multiplayer client:
// only the session controlled by this UI/tab initiates recovery.
// In single player this is whichever role the human selected.
// The AI remains the opposite real WebRTC peer.

document.addEventListener('visibilitychange', () => {
    recordRecovery(
        'page.visibility',
        RecoveryTelemetry.localRecoverySession?.(),
        RecoveryTelemetry.localRecoverySession?.()?.transport,
        { visibility: document.visibilityState },
    );
    AppLifecycle.applyPageVisibility();
});

document.addEventListener('freeze', () => {
    recordRecovery(
        'page.freeze',
        RecoveryTelemetry.localRecoverySession?.(),
        RecoveryTelemetry.localRecoverySession?.()?.transport,
    );
    AppLifecycle.invalidateLiveConnectionForLifecycle('page-freeze');
});

document.addEventListener('resume', () => {
    recordRecovery(
        'page.resume',
        RecoveryTelemetry.localRecoverySession?.(),
        RecoveryTelemetry.localRecoverySession?.()?.transport,
    );
});

window.addEventListener('pagehide', (e) => {
    recordRecovery(
        'page.pagehide',
        RecoveryTelemetry.localRecoverySession?.(),
        RecoveryTelemetry.localRecoverySession?.()?.transport,
        { persisted: !!e.persisted },
    );
    if (e.persisted) AppLifecycle.invalidateLiveConnectionForLifecycle('pagehide-bfcache');
});
window.addEventListener('pageshow', (e) => {
    recordRecovery(
        'page.pageshow',
        RecoveryTelemetry.localRecoverySession?.(),
        RecoveryTelemetry.localRecoverySession?.()?.transport,
        { persisted: !!e.persisted },
    );
    if (document.visibilityState === 'visible' && AppLifecycle.pageHiddenAtWall)
        AppLifecycle.applyPageVisibility();
});
window.addEventListener('focus', () => {
    recordRecovery(
        'page.focus',
        RecoveryTelemetry.localRecoverySession?.(),
        RecoveryTelemetry.localRecoverySession?.()?.transport,
    );
    if (document.visibilityState === 'visible' && AppLifecycle.pageHiddenAtWall)
        AppLifecycle.applyPageVisibility();
});
window.addEventListener('blur', () => {
    recordRecovery(
        'page.blur',
        RecoveryTelemetry.localRecoverySession?.(),
        RecoveryTelemetry.localRecoverySession?.()?.transport,
    );
});

// 페이지가 실제로 사용자에게 보여지는 동안 화면 자동 꺼짐을 최대한 방지한다.
AppLifecycle.requestScreenWakeLock();

/* Title-screen procedural scene. Pure presentation: fixed local paths, no StrategySim state. */
(function initTitleScene() {
    const canvas = document.getElementById('titleSceneCanvas');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;
    const agents = [
        { lane: 0.21, p: 0.02, s: 0.02, type: 'seed', team: 0 },
        { lane: 0.21, p: 0.19, s: 0.017, type: 'bug', team: 0 },
        { lane: 0.21, p: 0.39, s: 0.014, type: 'moth', team: 0 },
        { lane: 0.5, p: 0.08, s: 0.018, type: 'bug', team: 0 },
        { lane: 0.5, p: 0.29, s: 0.015, type: 'seed', team: 0 },
        { lane: 0.5, p: 0.67, s: -0.016, type: 'bug', team: 1 },
        { lane: 0.79, p: 0.13, s: 0.016, type: 'moth', team: 0 },
        { lane: 0.79, p: 0.75, s: -0.019, type: 'seed', team: 1 },
        { lane: 0.79, p: 0.92, s: -0.015, type: 'bug', team: 1 },
        { lane: 0.21, p: 0.82, s: -0.017, type: 'moth', team: 1 },
        { lane: 0.5, p: 0.88, s: -0.013, type: 'seed', team: 1 },
    ];
    function resize() {
        const r = canvas.getBoundingClientRect(),
            dpr = Math.min(1.6, window.devicePixelRatio || 1);
        const w = Math.max(1, Math.floor(r.width * dpr)),
            h = Math.max(1, Math.floor(r.height * dpr));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        return { w, h, dpr };
    }
    function pathPoint(t, lane, w, h) {
        const x = w * (0.07 + 0.86 * t),
            baseY = h * (0.88 - 0.76 * t),
            curve = Math.sin(t * Math.PI * 1.35 + lane * 3.2) * h * 0.055;
        return { x, y: baseY + (lane - 0.5) * h * 0.42 + curve };
    }
    function drawLeafUnit(x, y, r, team, phase) {
        const body = team === 0 ? '#4d8d4b' : '#b75749',
            dark = team === 0 ? '#214f34' : '#6e302b';
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.sin(phase) * 0.18);
        ctx.fillStyle = '#173b2230';
        ctx.beginPath();
        ctx.ellipse(2, r * 0.8, r * 1.05, r * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.78, r, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(1, r * 0.13);
        ctx.beginPath();
        ctx.moveTo(-r * 0.15, -r * 0.3);
        ctx.lineTo(r * 0.95, -r * 0.95);
        ctx.stroke();
        ctx.fillStyle = '#9ed86e';
        ctx.beginPath();
        ctx.ellipse(r * 0.72, -r * 0.9, r * 0.62, r * 0.26, -0.65, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    function drawBug(x, y, r, team, phase) {
        const body = team === 0 ? '#6aa94e' : '#c66a52',
            dark = team === 0 ? '#315d31' : '#71382f';
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(Math.sin(phase * 0.7) * 0.12);
        ctx.fillStyle = '#173b2230';
        ctx.beginPath();
        ctx.ellipse(2, r * 0.8, r * 1.1, r * 0.45, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.strokeStyle = dark;
        ctx.lineWidth = Math.max(1, r * 0.12);
        for (const sy of [-0.45, 0, 0.45]) {
            ctx.beginPath();
            ctx.moveTo(-r * 0.55, r * sy);
            ctx.lineTo(-r * 1.05, r * (sy + 0.2));
            ctx.moveTo(r * 0.55, r * sy);
            ctx.lineTo(r * 1.05, r * (sy + 0.2));
            ctx.stroke();
        }
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.72, r, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = '#e9d874';
        ctx.beginPath();
        ctx.arc(0, -r * 0.64, r * 0.19, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    function drawMoth(x, y, r, team, phase) {
        const body = team === 0 ? '#4f9a75' : '#c56d63';
        ctx.save();
        ctx.translate(x, y - Math.sin(phase * 2) * r * 0.28);
        ctx.fillStyle = '#173b2230';
        ctx.beginPath();
        ctx.ellipse(2, r * 1.25, r * 1.15, r * 0.38, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.globalAlpha = 0.78;
        ctx.fillStyle = team === 0 ? '#c7efd0' : '#ffd5c8';
        const flap = 0.62 + 0.22 * Math.sin(phase * 3);
        for (const sx of [-1, 1]) {
            ctx.save();
            ctx.scale(sx, 1);
            ctx.rotate(-0.3 * flap);
            ctx.beginPath();
            ctx.ellipse(r * 0.7, -r * 0.15, r * 0.72, r * 0.38, -0.5, 0, Math.PI * 2);
            ctx.fill();
            ctx.restore();
        }
        ctx.globalAlpha = 1;
        ctx.fillStyle = body;
        ctx.beginPath();
        ctx.ellipse(0, 0, r * 0.28, r * 0.85, 0, 0, Math.PI * 2);
        ctx.fill();
        ctx.restore();
    }
    function frame(ms) {
        const { w, h } = resize();
        if (UiRuntimeState.value.screen === 'lobby') {
            ctx.clearRect(0, 0, w, h);
            const g = ctx.createLinearGradient(0, 0, w, h);
            g.addColorStop(0, '#b9dba6');
            g.addColorStop(0.58, '#8fc48d');
            g.addColorStop(1, '#6eaa83');
            ctx.fillStyle = g;
            ctx.fillRect(0, 0, w, h);
            // terrain patches
            ctx.fillStyle = '#dfe5a7';
            for (let i = 0; i < 7; i++) {
                const x = w * (0.12 + ((i * 0.137) % 0.82)),
                    y = h * (0.12 + (((i * 37) % 73) / 100) * 0.76);
                ctx.beginPath();
                ctx.ellipse(x, y, w * 0.08, h * 0.04, ((i % 3) - 0.8) * 0.4, 0, Math.PI * 2);
                ctx.fill();
            }
            // river
            ctx.strokeStyle = '#7fc4dd';
            ctx.lineWidth = Math.max(10, w * 0.055);
            ctx.lineCap = 'round';
            ctx.globalAlpha = 0.82;
            ctx.beginPath();
            ctx.moveTo(w * 0.02, h * 0.38);
            ctx.bezierCurveTo(w * 0.28, h * 0.25, w * 0.55, h * 0.72, w * 0.98, h * 0.53);
            ctx.stroke();
            ctx.globalAlpha = 1;
            ctx.strokeStyle = '#dff6ff88';
            ctx.lineWidth = Math.max(2, w * 0.008);
            ctx.beginPath();
            ctx.moveTo(w * 0.02, h * 0.36);
            ctx.bezierCurveTo(w * 0.28, h * 0.23, w * 0.55, h * 0.7, w * 0.98, h * 0.51);
            ctx.stroke();
            // three strategic lanes
            ctx.setLineDash([Math.max(4, w * 0.012), Math.max(5, w * 0.016)]);
            ctx.lineWidth = Math.max(1, w * 0.003);
            ctx.strokeStyle = '#f7ffe377';
            for (const lane of [0.21, 0.5, 0.79]) {
                ctx.beginPath();
                for (let i = 0; i <= 28; i++) {
                    const p = pathPoint(i / 28, lane, w, h);
                    i ? ctx.lineTo(p.x, p.y) : ctx.moveTo(p.x, p.y);
                }
                ctx.stroke();
            }
            ctx.setLineDash([]);
            // rally flag at center
            const c = pathPoint(0.5, 0.5, w, h);
            const pulse = 1 + Math.sin(ms * 0.004) * 0.06;
            ctx.strokeStyle = '#fffbd0';
            ctx.lineWidth = Math.max(2, w * 0.005);
            ctx.beginPath();
            ctx.arc(c.x, c.y, w * 0.048 * pulse, 0, Math.PI * 2);
            ctx.stroke();
            ctx.strokeStyle = '#214b32';
            ctx.lineWidth = Math.max(2, w * 0.006);
            ctx.beginPath();
            ctx.moveTo(c.x, c.y + h * 0.055);
            ctx.lineTo(c.x, c.y - h * 0.075);
            ctx.stroke();
            ctx.fillStyle = '#f3b63e';
            ctx.beginPath();
            ctx.moveTo(c.x, c.y - h * 0.075);
            ctx.lineTo(c.x + w * 0.07, c.y - h * 0.055);
            ctx.lineTo(c.x + w * 0.05, c.y - h * 0.018);
            ctx.lineTo(c.x, c.y - h * 0.035);
            ctx.closePath();
            ctx.fill();
            // units
            const t = ms / 1000;
            for (let i = 0; i < agents.length; i++) {
                const a = agents[i];
                let p = (a.p + t * a.s) % 1;
                if (p < 0) p += 1;
                const pt = pathPoint(p, a.lane, w, h);
                const r = Math.max(5, Math.min(w, h) * (0.025 + (i % 3) * 0.002));
                if (a.type === 'bug') drawBug(pt.x, pt.y, r, a.team, t + i);
                else if (a.type === 'moth') drawMoth(pt.x, pt.y, r, a.team, t + i);
                else drawLeafUnit(pt.x, pt.y, r, a.team, t + i);
            }
            // bases
            for (const [x, y, team] of [
                [w * 0.08, h * 0.87, 0],
                [w * 0.91, h * 0.13, 1],
            ]) {
                ctx.fillStyle = team === 0 ? '#e5f1d3' : '#f3d2c9';
                ctx.strokeStyle = team === 0 ? '#356c47' : '#9d4d43';
                ctx.lineWidth = Math.max(2, w * 0.005);
                ctx.beginPath();
                ctx.arc(x, y, w * 0.055, 0, Math.PI * 2);
                ctx.fill();
                ctx.stroke();
                ctx.fillStyle = ctx.strokeStyle;
                ctx.beginPath();
                ctx.arc(x, y, w * 0.019, 0, Math.PI * 2);
                ctx.fill();
            }
        }
        if (UiRuntimeState.value.screen !== 'lobby') {
            setTimeout(() => requestAnimationFrame(frame), 320);
        } else {
            requestAnimationFrame(frame);
        }
    }
    requestAnimationFrame(frame);
})();

// Deployment metadata is optional diagnostics. Its fetch never gates game startup.

BuildMetadataPresentation.renderBuildMetadata();
void BUILD_META.load().then(() => BuildMetadataPresentation.renderBuildMetadata());

if (UiRegistry.refs.bootRetryBtn)
    UiController.bindImmediateButton(UiRegistry.refs.bootRetryBtn, AppLifecycle.runBootAndStartApp);
AppLifecycle.runBootAndStartApp();
const dev = readDevQuery(location.search);
if (dev.tps) UiController.setStartSimulationTps(dev.tps);
if (dev.netcode) setNetcodeMode(dev.netcode);
const leaveSetup = () => {
    audioSystem.unlock();
};
let campaignStorage;
try {
    campaignStorage = window.localStorage;
} catch (error) {
    console.warn('캠페인 진행 저장소를 열 수 없습니다.', error);
}
const campaignProgress = new CampaignProgress(campaignStorage);
addEventListener('storage', () => campaignProgress.sync());
DeckEditor.install({
    types: () => LaunchRules.deck,
    heroes: () => LaunchRules.heroTypes,
    starter: () => LaunchRules.starterDeck,
    limit: LaunchRules.deckLimit,
    heroLimit: LaunchRules.deckHeroLimit,
    nameOf: (type) => UnitDefinition.get(type)?.name || type,
    statsOf: (type) => ({ ...LaunchRules.payload(type), ...UnitDefinition.get(type) }),
    infoOf: (type) => LaunchScreens.grainInfo(type),
    isUnlocked: (type) => campaignProgress.isUnlocked(type),
    unlockHint: (type) => {
        const stage = campaignProgress.unlockStage(type);
        return stage ? `${stage.title} 클리어 시 해금` : '';
    },
    renderDetails: (type, host) => LaunchScreens.renderCardDetail(type, host),
    portraitOf: (type) => grainPortrait(type, window.RallyVectorAssets[type]),
});
const showcaseSurface = createShowcaseHost(
    (canvas, fxCanvas) => new GLRenderer(canvas, { deferLoop: true, showcase: true, fxCanvas }),
);
addEventListener('pagehide', (event) => {
    if (!event.persisted) showcaseSurface.dispose();
});
LaunchScreens.install({
    createNavigation: RallyGamekit.createNavigation,
    showcaseSurface,
    actions: {
        campaignProgress,
        startCampaignStage: (stage) => {
            leaveSetup();
            MatchLifecycle.startCampaignStage(stage);
        },
        openRewardDeck: (type) => DeckEditor.open(type),
        selectCampaign: (id) => {
            MatchLifecycle.selectedCampaign = id;
        },
        inMatch: () => UiRuntimeState.value.screen === 'game',
        hasResult: () => UiRuntimeState.value.screen === 'result',
        startAiMatch: () => {
            leaveSetup();
            MatchLifecycle.startSinglePlayerWebRTC(
                MatchLifecycle.selectedCampaign ? 'host' : dev.role || 'host',
            );
        },
        openMenu: () => {
            if (UiRuntimeState.value.modal !== 'match-menu') MatchLifecycle.openMatchMenu();
        },
        closeMenu: () => {
            if (UiRuntimeState.value.modal === 'match-menu') MatchLifecycle.closeMatchMenu();
        },
        grains: () => [...LaunchRules.heroTypes, ...LaunchRules.deck],
        grainName: (t) => UnitDefinition.get(t)?.name || t,
        grainStats: (t) => ({
            ...LaunchRules.payload(t),
            maxReach: LaunchRules.maxReachOf(
                t,
                ActiveViewState.snap?.launchRangeLevel?.[
                    ConnectionSideUtil.roleSide(ActiveViewState.role)
                ] ?? 0,
            ),
        }),
        portraitSource: (t) => grainPortrait(t, window.RallyVectorAssets[t]),
        toggleSound: () => audioSystem.setEnabled(!audioSystem.enabled),
        soundOn: () => !!audioSystem.enabled,
        createRoom: () => {
            leaveSetup();
            UiController.openUiModal('create');
            MatchLifecycle.beginCreateRoom();
        },
        joinRoom: (code) => {
            leaveSetup();
            UiController.openJoinDialog();
            UiRegistry.refs.room.value = code;
            MatchLifecycle.submitJoinRoom();
        },
        leaveToTitle: () => reloadAt('#/'),
    },
});

export {
    AppLifecycle,
    ConnectionPresentation,
    DiagnosticPresentation,
    LogUtil,
    MatchLifecycle,
    ReplayPresentation,
    ActiveSimulationTiming,
    SinglePlayerModeUtil,
    UiController,
    UiRegistry,
};
