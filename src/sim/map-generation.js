// Seeded frontier map generation.
import { GameRuleDefinition, GameRuleRuntime, RangeUtil } from '../core/game-rules.js';
import { TerrainQuery } from './entities.js';
import {
    CapturePointDefinition,
    LANE_NORMALS,
    MapGeometry,
    RIVER_HALF_WIDTH,
    RIVER_PATH,
} from './map-geometry.js';
import { LANE_CONTROL_POINTS } from '../definitions/combat-rules.js';
import { UNIT_RUNTIME_GEOMETRY } from '../definitions/units.js';
import { WorldContext } from './world-context.js';
import { TerrainNavigation } from './navigation.js';
import { TerrainGeometry, TerrainSurfaceAtlas } from './terrain.js';
import { RallyGamekit } from '../core/gamekit.js';
const {
    minPairDistance,
    nearestPointDistance,
    pointDistance,
    pointInSimplePolygon,
    pointPolylineDistance,
    pointSegmentDistance,
    polygonsOverlap,
    polylineTangentAt,
    polylineToRibbonPolygon,
    roundedPointOnPolyline,
    segmentDistance,
    smoothPolylineCatmull,
} = RallyGamekit;

class CloneUtil {
    static clone(v) {
        return JSON.parse(JSON.stringify(v));
    }
}
class HashUtil {
    static hash(s) {
        let h = 2166136261 >>> 0;
        for (let i = 0; i < s.length; i++) {
            h ^= s.charCodeAt(i);
            h = Math.imul(h, 16777619);
        }
        return h >>> 0;
    }
}

const MAP_DESCRIPTOR_SCHEMA_VERSION = 1;
// Terrain gates belong to neither player (factionRelation treats any other side as neutral).
const NEUTRAL_SIDE = 2;
// Candidate maps must connect every strategic point for the widest grain.
const MAP_VALIDATION_UNIT_RADIUS = Math.max(
    ...Object.values(UNIT_RUNTIME_GEOMETRY).map((g) => g.radius),
);

// Rooms and terrain boundaries are laid out together. Variation changes the same
// structural template; no post-hoc random walls are placed across a valid route.
class FrontierTerrainLayout {
    static create(ctx) {
        const { width: w, height: h, seed } = ctx;
        const point = ([x, y]) => ({ x: Math.round(x * w), y: Math.round(y * h) }),
            mirror = (p) => ({ x: w - p.x, y: h - p.y });
        const density = RangeUtil.clamp(Number(ctx.m.obstacleDensity ?? 0.5), 0, 1),
            openness = RangeUtil.clamp(Number(ctx.m.openness ?? 0.5), 0, 1),
            choke = RangeUtil.clamp(Number(ctx.m.chokeDensity ?? 0.5), 0, 1);
        const variation =
                (((HashUtil.hash(seed + '|plateau-shape') % 21) - 10) / 2000) * (0.5 + density),
            widthScale = 1 + (openness - 0.5) * 0.3;
        const layers = [],
            ramps = [],
            blockers = [],
            structures = [];
        const pairLayer = (id, coords, entries) => {
            const points = coords.map(point);
            for (let side = 0; side < 2; side++) {
                const layerId = id + '-' + side;
                layers.push({
                    id: layerId,
                    level: 1,
                    points: side ? points.map(mirror) : points.map((p) => ({ ...p })),
                });
                for (const e of entries) {
                    const half = ((e.t1 - e.t0) / 2) * (e.destructible ? 1 : widthScale),
                        center = (e.t0 + e.t1) / 2;
                    ramps.push({
                        ...e,
                        t0: center - half,
                        t1: center + half,
                        run: e.run * (0.85 + choke * 0.3),
                        id: layerId + '-' + e.name,
                        layerId,
                    });
                }
            }
        };
        pairLayer(
            'base-high',
            [
                [0, 0.735],
                [0.205, 0.735],
                [0.275, 0.805],
                [0.275, 1],
                [0, 1],
            ],
            [
                { name: 'main-ramp', edge: 0, t0: 0.38, t1: 0.88, run: 240 },
                { name: 'flank-ramp', edge: 2, t0: 0.22, t1: 0.64, run: 220 },
            ],
        );
        pairLayer(
            'flank-high',
            [
                [0.22, 0.32],
                [0.28, 0.285],
                [0.355 + variation, 0.3],
                [0.405 + variation, 0.37],
                [0.4, 0.45],
                [0.34, 0.5],
                [0.265, 0.465],
                [0.235, 0.4],
            ],
            [
                { name: 'outer-ramp', edge: 6, t0: 0.15, t1: 0.85, run: 155 },
                { name: 'centre-ramp', edge: 3, t0: 0.08, t1: 0.92, run: 160 },
                { name: 'shortcut', edge: 0, t0: 0.135, t1: 0.865, run: 150, destructible: true },
            ],
        );
        const border = [
            [0, 0],
            [0.35, 0],
            [0.33, 0.065],
            [0.255, 0.09],
            [0.195, 0.16],
            [0.115, 0.2],
            [0.075, 0.285],
            [0, 0.32],
        ].map(point);
        blockers.push(
            { id: 'outer-ridge-nw', kind: 'cliff', points: border },
            { id: 'outer-ridge-se', kind: 'cliff', points: border.map(mirror) },
        );
        const atlas = new TerrainSurfaceAtlas({ width: w, height: h, terrain: { layers, ramps } });
        for (const r of atlas.ramps)
            if (r.destructible) {
                const p = TerrainSurfaceAtlas.lerp(r.lowA, r.lowB, 0.5);
                structures.push({
                    id: 'gate-' + r.id,
                    type: 'rootBarrier',
                    side: NEUTRAL_SIDE,
                    x: Math.round(p.x),
                    y: Math.round(p.y),
                    terrainGate: r.id,
                });
            }
        return { layers, ramps, blockers, structures };
    }
    static lanes(ctx) {
        const w = ctx.width,
            h = ctx.height,
            p = (x, y) => ({ x: Math.round(x * w), y: Math.round(y * h) }),
            mirror = (q) => ({ x: w - q.x, y: h - q.y });
        // Corner rooms are connected by two outer routes and the central battlefield.
        const top = [
            ctx.host,
            p(0.135, 0.76),
            p(0.135, 0.69),
            p(0.13, 0.57),
            p(0.12, 0.42),
            p(0.17, 0.275),
            p(0.27, 0.16),
            p(0.43, 0.13),
            p(0.61, 0.135),
            p(0.735, 0.14),
            ctx.guest,
        ];
        const bot = top.slice().reverse().map(mirror),
            mid = [
                ctx.host,
                p(0.2, 0.8),
                p(0.3, 0.72),
                p(0.35, 0.65),
                p(0.5, 0.5),
                p(0.65, 0.35),
                p(0.72, 0.3),
                p(0.8, 0.2),
                ctx.guest,
            ];
        const capturePoints = [
            ['top', 1, 0.13, 0.75],
            ['top', 2, 0.43, 0.13],
            ['mid', 1, 0.4, 0.88],
            ['mid', 2, 0.6, 0.12],
            ['bot', 1, 0.57, 0.87],
            ['bot', 2, 0.87, 0.25],
        ].map(([id, stage, x, y]) => ({
            id: id + '-' + stage,
            lane: id.toUpperCase(),
            laneKey: id,
            label: id.toUpperCase() + ' ' + stage,
            stage,
            resourceType: id === 'mid' ? 'premium' : 'basic',
            ...p(x, y),
        }));
        return {
            laneControlPoints: { top, mid, bot },
            laneNormals: {
                top: { x: ctx.nx, y: ctx.ny },
                mid: { x: ctx.nx, y: ctx.ny },
                bot: { x: ctx.nx, y: ctx.ny },
            },
            capturePoints,
        };
    }
    static safety(map) {
        const geometry = TerrainGeometry.fromMap(map),
            atlas = geometry.surfaces,
            terrain = map.terrain;
        const dryGeometry = TerrainGeometry.fromMap({
            ...map,
            terrain: {
                ...terrain,
                layers: (terrain.layers || []).filter((l) => !l.innerPoints?.length),
                bridges: [],
            },
        });
        const waterPaths = [terrain.riverPath, ...(terrain.riverBranches || [])],
            banks = atlas.layers.filter((l) => l.innerPoints?.length),
            elevated = atlas.layers.filter((l) => l.level > 0);
        const clearance = (terrain.riverHalfWidth || 0) + (terrain.riverBankWidth || 0) + 20;
        const waterClear =
            waterPaths.every((path) =>
                path.every(
                    (p, i) =>
                        dryGeometry.field.polygonCircleClear(p.x, p.y, clearance) &&
                        (!i ||
                            dryGeometry.field.polygonSegmentClear(
                                path[i - 1].x,
                                path[i - 1].y,
                                p.x,
                                p.y,
                                clearance,
                            )),
                ),
            ) &&
            banks.every(
                (b, i) =>
                    b.points.every(
                        (p) => p.x >= 0 && p.x <= map.width && p.y >= 0 && p.y <= map.height,
                    ) &&
                    !elevated.some((l) => polygonsOverlap(b.points, l.points)) &&
                    !banks.slice(i + 1).some((l) => polygonsOverlap(b.points, l.points)),
            );
        const bridgeClear = (terrain.bridges || []).every((b) => {
            const ca = Math.cos(b.angle),
                sa = Math.sin(b.angle),
                p = [
                    [-1, -1],
                    [1, -1],
                    [1, 1],
                    [-1, 1],
                ].map(([x, y]) => ({
                    x: b.x + x * b.halfLength * ca - y * b.halfWidth * sa,
                    y: b.y + x * b.halfLength * sa + y * b.halfWidth * ca,
                }));
            const groundedEndcaps = [1, 3].every((i) =>
                banks.every((bank) =>
                    bank.points.every((a, j) => {
                        const z = bank.points[(j + 1) % bank.points.length],
                            v = p[i],
                            q = p[(i + 1) % 4];
                        return segmentDistance(v.x, v.y, q.x, q.y, a.x, a.y, z.x, z.y) >= 2;
                    }),
                ),
            );
            return (
                groundedEndcaps &&
                p.every(
                    (v, i) =>
                        atlas.heightAt(v.x, v.y) === 0 &&
                        dryGeometry.field.polygonSegmentClear(
                            v.x,
                            v.y,
                            p[(i + 1) % 4].x,
                            p[(i + 1) % 4].y,
                            2,
                        ),
                ) &&
                !elevated.some((l) => polygonsOverlap(p, l.points))
            );
        });
        const pads = [map.spawns.host, map.spawns.guest, ...map.capturePoints];
        const buildablePads = pads.every(
            (p) =>
                geometry.field.polygonCircleClear(p.x, p.y, 42) &&
                atlas.buildable(p.x, p.y, 42) &&
                !banks.some((b) => pointInSimplePolygon(p.x, p.y, b.points)),
        );
        return {
            waterLayerSeparation: waterClear,
            bridgeRampSeparation: bridgeClear,
            buildablePads,
        };
    }
    static connectedLayout(map) {
        // Every strategic point must be reachable by the widest grain on the
        // radius-inflated distance grid. Generation-time caches are discarded.
        const world = WorldContext.fromMap(map),
            nav = new TerrainNavigation({ world, tick: 0, buildings: [] });
        const strategic = [
            map.spawns.guest,
            ...map.capturePoints,
            ...world.terrain.surfaces.layers.map((l) =>
                l.points.reduce(
                    (p, q) => ({ x: p.x + q.x / l.points.length, y: p.y + q.y / l.points.length }),
                    { x: 0, y: 0 },
                ),
            ),
        ];
        return nav.connected(map.spawns.host, strategic, MAP_VALIDATION_UNIT_RADIUS);
    }
    static water(ctx) {
        const { width: w, height: h, seed } = ctx;
        const shift = ((HashUtil.hash(seed + '|lowland-stream') % 21) - 10) / 2000;
        const riverHalfWidth = 65 + 5 * (HashUtil.hash(seed + '|stream-width') % 4);
        const riverBankWidth = 96,
            outerWidth = riverHalfWidth + riverBankWidth;
        // Caps extend along the tangent as well as across it. Reserve the maximum
        // possible cap extent before smoothing; paired contours are never clamped.
        const startX = Math.max(0.075, (outerWidth * Math.hypot(1, 0.72) + 20) / w);
        const templates = [
            [
                [startX, 0.66],
                [0.13, 0.645],
                [0.215, 0.615],
                [0.29, 0.57 + shift],
                [0.36, 0.555 + shift],
                [0.445, 0.56 + shift],
            ],
        ];
        // Short maps cannot fit the full stream between the fixed physical ramps.
        // Search a shorter lowland ribbon while keeping the same gentle bank width.
        const offsets = [0, 0.015, -0.015, 0.03, -0.03],
            reverse = HashUtil.hash(seed + '|compact-stream') & 1 ? 1 : -1;
        for (const dy of offsets)
            for (const dx of offsets)
                templates.push(
                    [
                        [0.34, 0.76],
                        [0.38, 0.75],
                        [0.425, 0.72],
                        [0.47, 0.675],
                    ].map(([x, y]) => [x + dx * reverse, y + dy]),
                );
        const layout = ctx.terrainLayout || FrontierTerrainLayout.create(ctx),
            geometry = new TerrainGeometry({ width: w, height: h, terrain: layout }),
            atlas = geometry.surfaces;
        const pads = [ctx.host, ctx.guest, ...FrontierTerrainLayout.lanes(ctx).capturePoints],
            clearance = outerWidth + 20;
        for (const coords of templates) {
            const controls = coords.map(([x, y]) => ({ x: x * w, y: y * h }));
            const riverPath = smoothPolylineCatmull(controls, 5).map((p) => ({
                x: Math.round(p.x),
                y: Math.round(p.y),
            }));
            const riverBranches = [riverPath.map((p) => ({ x: w - p.x, y: h - p.y }))],
                paths = [riverPath, ...riverBranches];
            const riverBankLayers = paths.map((path, i) => ({
                id: 'river-bank-' + i,
                level: -1,
                points: polylineToRibbonPolygon(path, outerWidth),
                innerPoints: polylineToRibbonPolygon(path, riverHalfWidth),
            }));
            const clear = riverBankLayers.every(
                (b, i) =>
                    b.points.every((p) => p.x >= 0 && p.x <= w && p.y >= 0 && p.y <= h) &&
                    ![...atlas.layers, ...atlas.ramps].some((l) =>
                        polygonsOverlap(b.points, l.points),
                    ) &&
                    !riverBankLayers
                        .slice(i + 1)
                        .some((l) => polygonsOverlap(b.points, l.points)) &&
                    pads.every(
                        (p) =>
                            !pointInSimplePolygon(p.x, p.y, b.points) &&
                            b.points.every((a, j) => {
                                const z = b.points[(j + 1) % b.points.length];
                                return pointSegmentDistance(p.x, p.y, a.x, a.y, z.x, z.y) >= 42;
                            }),
                    ),
            );
            if (
                !clear ||
                !paths.every((path) =>
                    path.every(
                        (p, i) =>
                            geometry.field.polygonCircleClear(p.x, p.y, clearance) &&
                            (!i ||
                                geometry.field.polygonSegmentClear(
                                    path[i - 1].x,
                                    path[i - 1].y,
                                    p.x,
                                    p.y,
                                    clearance,
                                )),
                    ),
                )
            )
                continue;
            return {
                riverPath,
                riverHalfWidth,
                riverBranches,
                riverBankWidth,
                riverBankLayers,
                riverPolygon: polylineToRibbonPolygon(riverPath, riverHalfWidth),
                riverBranchPolygons: riverBranches.map((p) =>
                    polylineToRibbonPolygon(p, riverHalfWidth),
                ),
            };
        }
        throw new Error('No lowland corridor can fit the physical river banks');
    }
}

class MapGeneration {
    static descriptorCache = null;
    static mapRuleSeed(baseSeed, rules = GameRuleDefinition.current, roundNumber = 1) {
        const m = rules?.map || {};
        const salt = m.generation?.seedSalt || 'map';
        return (
            HashUtil.hash(
                `${baseSeed >>> 0}|${rules?.modeId || 'standard'}|${roundNumber || 1}|${m.generator || 'fixed-standard'}|${m.generatorVersion || 1}|${salt}`,
            ) >>> 0
        );
    }
    static fixedStandardMapDescriptor(
        rules = GameRuleDefinition.current,
        baseSeed = 0,
        roundNumber = 1,
    ) {
        const m = rules?.map || GameRuleDefinition.defaults.map;
        const width = Number(m.width) || 3600,
            height = Number(m.height) || 4200;
        const sx = width / 3600,
            sy = height / 4200;
        const scalePoint = (p) => ({ x: Math.round(p.x * sx), y: Math.round(p.y * sy) });
        const cps = CapturePointDefinition.all.map((cp) => ({ ...cp, ...scalePoint(cp) }));
        const laneNormals = CloneUtil.clone(LANE_NORMALS);
        return {
            schemaVersion: MAP_DESCRIPTOR_SCHEMA_VERSION,
            generator: m.generator || 'fixed-standard',
            generatorVersion: m.generatorVersion || 1,
            seed: MapGeneration.mapRuleSeed(baseSeed, rules, roundNumber),
            width,
            height,
            biome: m.biome || 'frontier',
            topology: m.topology || 'standard',
            symmetry: m.symmetry || 'diagonal',
            spawns: {
                host: { x: Number(m.spawns?.host?.x) || 450, y: Number(m.spawns?.host?.y) || 3750 },
                guest: {
                    x: Number(m.spawns?.guest?.x) || 3150,
                    y: Number(m.spawns?.guest?.y) || 450,
                },
            },
            flags: [
                { x: 1050 * sx, y: 3150 * sy, forced: false },
                { x: width - 1050 * sx, y: height - 3150 * sy, forced: false },
            ],
            laneControlPoints: Object.fromEntries(
                Object.entries(LANE_CONTROL_POINTS).map(([k, pts]) => [k, pts.map(scalePoint)]),
            ),
            laneNormals,
            capturePoints: cps,
            terrain: {
                layers: [],
                ramps: [],
                blockers: [],
                riverPath: RIVER_PATH.map(scalePoint),
                riverHalfWidth: Math.round(RIVER_HALF_WIDTH * ((sx + sy) / 2)),
                riverBranches: [],
                riverPolygon: [],
                riverBranchPolygons: [],
                bridges: [],
            },
        };
    }
    static seededMapRandom(seed) {
        let x = seed >>> 0 || 0x9e3779b9;
        return () => {
            x ^= x << 13;
            x ^= x >>> 17;
            x ^= x << 5;
            x >>>= 0;
            return x / 4294967296;
        };
    }
    static createProceduralMapContext(
        rules = GameRuleDefinition.current,
        baseSeed = 0,
        roundNumber = 1,
        candidateSeed = null,
    ) {
        const m = rules?.map || GameRuleDefinition.defaults.map,
            width = Number(m.width) || 3600,
            height = Number(m.height) || 4200;
        const seed =
                (candidateSeed == null
                    ? MapGeneration.mapRuleSeed(baseSeed, rules, roundNumber)
                    : candidateSeed) >>> 0,
            rnd = MapGeneration.seededMapRandom(seed);
        const host = {
            x: Number(m.spawns?.host?.x) || Math.round(width * 0.125),
            y: Number(m.spawns?.host?.y) || Math.round(height * 0.893),
        };
        const guest = {
            x: Number(m.spawns?.guest?.x) || width - host.x,
            y: Number(m.spawns?.guest?.y) || height - host.y,
        };
        const axisX = guest.x - host.x,
            axisY = guest.y - host.y,
            axisLen = Math.hypot(axisX, axisY) || 1;
        const ux = axisX / axisLen,
            uy = axisY / axisLen,
            nx = -uy,
            ny = ux;
        const margin = 150,
            mirror = (p) => ({ x: width - p.x, y: height - p.y });
        const clampPt = (p) => ({
            x: Math.round(RangeUtil.clamp(p.x, margin, width - margin)),
            y: Math.round(RangeUtil.clamp(p.y, margin, height - margin)),
        });
        const requestedTopology = String(m.topology || 'mixed');
        const topologyPool = ['open', 'braided', 'hourglass', 'split', 'wild'];
        const topology =
            requestedTopology === 'mixed'
                ? topologyPool[Math.floor(rnd() * topologyPool.length)]
                : requestedTopology;
        const terrainArchetypes = ['plains', 'ridge', 'riverland', 'basin', 'highlands', 'broken'];
        const terrainArchetype = terrainArchetypes[Math.floor(rnd() * terrainArchetypes.length)];
        const scale = Math.min(width / 3600, height / 4200);
        return {
            rules,
            m,
            width,
            height,
            seed,
            rnd,
            host,
            guest,
            axisX,
            axisY,
            ux,
            uy,
            nx,
            ny,
            mirror,
            clampPt,
            topology,
            terrainArchetype,
            scale,
        };
    }
    static generateProceduralLanes(ctx) {
        return FrontierTerrainLayout.lanes(ctx);
    }
    static proceduralFrontierMapCandidate(
        rules = GameRuleDefinition.current,
        baseSeed = 0,
        roundNumber = 1,
        candidateSeed = null,
    ) {
        const ctx = MapGeneration.createProceduralMapContext(
            rules,
            baseSeed,
            roundNumber,
            candidateSeed,
        );
        const layout = FrontierTerrainLayout.create(ctx),
            { layers, ramps, blockers, structures } = layout;
        ctx.terrainLayout = layout;
        const { laneControlPoints, laneNormals, capturePoints } =
            MapGeneration.generateProceduralLanes(ctx);
        const terrain = {
            layers,
            ramps,
            blockers,
            riverPath: [],
            riverBranches: [],
            riverPolygon: [],
            riverBranchPolygons: [],
            riverHalfWidth: 80,
            bridges: [],
        };
        // Add the full walkable bank before placing strategic objects, so placement
        // sees the same signed heights and slopes as movement and visibility.
        Object.assign(terrain, FrontierTerrainLayout.water(ctx));
        terrain.bridges = MapGeneration.generateProceduralBridges(ctx, laneControlPoints, terrain);
        terrain.layers.push(...terrain.riverBankLayers);
        delete terrain.riverBankLayers;
        const { m, width, height, seed, host, guest, topology, terrainArchetype } = ctx;
        return {
            schemaVersion: MAP_DESCRIPTOR_SCHEMA_VERSION,
            generator: 'procedural-frontier',
            generatorVersion: 11,
            seed,
            width,
            height,
            biome: m.biome || 'frontier',
            topology,
            terrainArchetype,
            symmetry: 'rotational-terrain',
            spawns: { host, guest },
            flags: [
                roundedPointOnPolyline(laneControlPoints.mid, 0.18),
                roundedPointOnPolyline(laneControlPoints.mid, 0.82),
            ].map((p) => ({ ...p, forced: false })),
            laneControlPoints,
            laneNormals,
            capturePoints,
            terrain,
            authoredStructures: structures,
        };
    }
    static mapTerrainDescriptor(mapDescriptor) {
        return (
            mapDescriptor?.terrain || {
                layers: [],
                ramps: [],
                blockers: [],
                riverPath: RIVER_PATH,
                riverHalfWidth: RIVER_HALF_WIDTH,
                riverBranches: [],
                bridges: [],
            }
        );
    }
    static mapTerrainFlagsAt(desc, x, y) {
        return TerrainQuery.at(desc, x, y);
    }
    static terrainMapDiagnostics(desc) {
        const terrain = MapGeneration.mapTerrainDescriptor(desc),
            atlas = TerrainSurfaceAtlas.fromMap(desc);
        const elevatedCoverageByLane = { top: 0, mid: 0, bot: 0 };
        // Sample the playable corridor against the same level atlas used by combat/vision.
        for (const laneKey of ['top', 'mid', 'bot']) {
            const pts = desc.laneControlPoints?.[laneKey] || [];
            let hit = 0,
                total = 0;
            for (let i = 0; i <= 48; i++) {
                const t = i / 48,
                    q = roundedPointOnPolyline(pts, t),
                    tan = polylineTangentAt(pts, t),
                    nx = -tan.y,
                    ny = tan.x;
                for (const offset of [-180, -90, 0, 90, 180]) {
                    total++;
                    if (atlas.levelAt(q.x + nx * offset, q.y + ny * offset) > 0) hit++;
                }
            }
            elevatedCoverageByLane[laneKey] = total ? Math.round((hit / total) * 1000) / 1000 : 0;
        }
        const crossings = MapGeometry.laneRiverCrossings(desc.laneControlPoints, terrain);
        let bridgeLevelOverlap = false;
        for (const b of terrain.bridges || []) {
            const ca = Math.cos(b.angle || 0),
                sa = Math.sin(b.angle || 0),
                probes = [
                    [0, 0],
                    [b.halfLength, 0],
                    [-b.halfLength, 0],
                    [0, b.halfWidth],
                    [0, -b.halfWidth],
                ];
            for (const [lx, ly] of probes) {
                if (atlas.levelAt(b.x + lx * ca - ly * sa, b.y + lx * sa + ly * ca) > 0) {
                    bridgeLevelOverlap = true;
                    break;
                }
            }
            if (bridgeLevelOverlap) break;
        }
        return {
            elevatedLayerCount: atlas.layers.filter((l) => l.level > 0).length,
            elevatedCoverageByLane,
            riverCrossingCount: crossings.length,
            bridgeCount: (terrain.bridges || []).length,
            bridgeLevelOverlap,
        };
    }
    static evaluateProceduralMapCandidate(desc, rules = GameRuleDefinition.current) {
        const g = rules?.map?.generation || GameRuleDefinition.defaults.map.generation;
        const host = desc.spawns.host,
            guest = desc.spawns.guest;
        // A base's own plateau is its buildable starting room, not a spawn hazard.
        const elevatedCenters = TerrainSurfaceAtlas.fromMap(desc)
            .layers.filter(
                (l) =>
                    l.level > 0 &&
                    !pointInSimplePolygon(host.x, host.y, l.points) &&
                    !pointInSimplePolygon(guest.x, guest.y, l.points),
            )
            .map((l) => ({
                x: l.points.reduce((n, p) => n + p.x, 0) / l.points.length,
                y: l.points.reduce((n, p) => n + p.y, 0) / l.points.length,
            }));
        const spawnHazardDistance = Math.min(
            nearestPointDistance(host, elevatedCenters),
            nearestPointDistance(guest, elevatedCenters),
        );
        const objectives = desc.capturePoints || [];
        const objectiveClearance = minPairDistance(objectives, 99999);
        const laneCenters = Object.values(desc.laneControlPoints || {}).map((pts) =>
            roundedPointOnPolyline(pts, 0.5),
        );
        const laneSeparation = minPairDistance(laneCenters, 99999);
        let maxObjectiveLaneOffset = 0,
            maxLaneEndpointError = 0;
        for (const cp of objectives) {
            const pts = desc.laneControlPoints?.[cp.laneKey] || [];
            if (pts.length > 1)
                maxObjectiveLaneOffset = Math.max(
                    maxObjectiveLaneOffset,
                    pointPolylineDistance(cp.x, cp.y, pts),
                );
        }
        for (const pts of Object.values(desc.laneControlPoints || {})) {
            if (!pts.length) continue;
            maxLaneEndpointError = Math.max(
                maxLaneEndpointError,
                pointDistance(pts[0], host),
                pointDistance(pts[pts.length - 1], guest),
            );
        }
        const hostObjectives = objectives.filter((o) => o.stage === 1),
            guestObjectives = objectives.filter((o) => o.stage === 2);
        const hostObjCost =
            hostObjectives.reduce((s, o) => s + pointDistance(host, o), 0) /
            Math.max(1, hostObjectives.length);
        const guestObjCost =
            guestObjectives.reduce((s, o) => s + pointDistance(guest, o), 0) /
            Math.max(1, guestObjectives.length);
        const fairnessError =
            Math.abs(hostObjCost - guestObjCost) / Math.max(1, (hostObjCost + guestObjCost) / 2);
        const spawnClearanceTarget = Math.max(220, Number(g.minSpawnClearance) || 560) * 0.7;
        const topology = String(desc.topology || 'mixed');
        const objectiveFactor = topology === 'braided' ? 0.78 : topology === 'wild' ? 0.86 : 1;
        const laneFactor =
            topology === 'hourglass'
                ? 0.42
                : topology === 'braided'
                  ? 0.72
                  : topology === 'wild'
                    ? 0.78
                    : 1;
        const objectiveTarget =
            Math.max(120, Number(g.minObjectiveClearance) || 260) * objectiveFactor;
        const laneTarget =
            Math.min(desc.width, desc.height) *
            Math.max(0.04, Math.min(0.14, Number(g.minLaneSeparationRatio) || 0.07)) *
            laneFactor;
        const terrainVariety = (desc.terrain?.layers || []).length >= 2;
        const objectiveTerrain = MapGeneration.terrainMapDiagnostics(desc);
        const blockerGeometry = TerrainGeometry.fromMap(desc),
            blockerCount = (desc.terrain?.blockers || []).length;
        const blockerSubjects = [...objectives, desc.spawns.host, desc.spawns.guest];
        const blockerPlacement =
            blockerCount >= 2 &&
            blockerSubjects.every((p) =>
                blockerGeometry.field.polygonCircleClear(p.x, p.y, Math.max(42, Number(p.r) || 0)),
            );
        const checks = {
            ...FrontierTerrainLayout.safety(desc),
            spawnClearance: spawnHazardDistance >= spawnClearanceTarget,
            terrainVariety,
            blockerPlacement,
            objectiveClearance: objectiveClearance >= objectiveTarget,
            laneDiversity: laneSeparation >= laneTarget,
            objectiveOnLane: maxObjectiveLaneOffset <= 36,
            laneConnectsBases: maxLaneEndpointError <= 36,
            bridgeLevelSeparation: !objectiveTerrain.bridgeLevelOverlap,
            fairness: fairnessError <= Math.max(0.1, Number(g.fairnessTolerance) || 0.12),
        };
        checks.groundConnectivity = Object.values(checks).every(Boolean)
            ? FrontierTerrainLayout.connectedLayout(desc)
            : false;
        const ratios = [
            spawnHazardDistance / spawnClearanceTarget,
            objectiveClearance / objectiveTarget,
            laneSeparation / laneTarget,
        ];
        const midCoverage = Number(objectiveTerrain.elevatedCoverageByLane?.mid) || 0,
            sideCoverage =
                ((Number(objectiveTerrain.elevatedCoverageByLane?.top) || 0) +
                    (Number(objectiveTerrain.elevatedCoverageByLane?.bot) || 0)) /
                2;
        let terrainSoftBonus = 0;
        if (midCoverage > sideCoverage)
            terrainSoftBonus += Math.min(4, (midCoverage - sideCoverage) * 10);
        if (objectiveTerrain.elevatedLayerCount >= 2 && objectiveTerrain.elevatedLayerCount <= 8)
            terrainSoftBonus += 2.5;
        if (objectiveTerrain.bridgeCount >= 1 && objectiveTerrain.bridgeCount <= 2)
            terrainSoftBonus += 2;
        const score =
            Math.round(
                (ratios.reduce((sum, v) => sum + Math.min(1.5, v), 0) * 16 +
                    (checks.fairness ? 20 : 0) +
                    terrainSoftBonus) *
                    1000,
            ) / 1000;
        return {
            accepted: Object.values(checks).every(Boolean),
            score,
            checks,
            metrics: {
                spawnHazardDistance: Math.round(spawnHazardDistance),
                objectiveClearance: Math.round(objectiveClearance),
                laneSeparation: Math.round(laneSeparation),
                maxObjectiveLaneOffset: Math.round(maxObjectiveLaneOffset),
                maxLaneEndpointError: Math.round(maxLaneEndpointError),
                fairnessError: Math.round(fairnessError * 1000) / 1000,
                terrainSoftBonus: Math.round(terrainSoftBonus * 1000) / 1000,
                ...objectiveTerrain,
            },
        };
    }
    static proceduralFrontierMapDescriptor(
        rules = GameRuleDefinition.current,
        baseSeed = 0,
        roundNumber = 1,
    ) {
        const rootSeed = MapGeneration.mapRuleSeed(baseSeed, rules, roundNumber);
        const requestedTopology = String(rules?.map?.topology || 'mixed');
        const topologyPool = ['open', 'braided', 'hourglass', 'split', 'wild'];
        const topology =
            requestedTopology === 'mixed'
                ? topologyPool[HashUtil.hash(`${rootSeed}|topology`) % topologyPool.length]
                : requestedTopology;
        const candidateRules =
            requestedTopology === 'mixed'
                ? GameRuleRuntime.mergeGameRules(rules, { map: { topology } })
                : rules;
        const attempts = Math.max(
            1,
            Math.min(64, Math.floor(Number(rules?.map?.generation?.attempts) || 24)),
        );
        let best = null,
            bestEval = null,
            bestAttempt = 0;
        for (let attempt = 0; attempt < attempts; attempt++) {
            const candidateSeed =
                HashUtil.hash(`${rootSeed}|${topology}|candidate|${attempt}`) >>> 0;
            const candidate = MapGeneration.proceduralFrontierMapCandidate(
                candidateRules,
                baseSeed,
                roundNumber,
                candidateSeed,
            );
            const quality = MapGeneration.evaluateProceduralMapCandidate(candidate, candidateRules);
            if (!best || quality.score > bestEval.score) {
                best = candidate;
                bestEval = quality;
                bestAttempt = attempt;
            }
            if (quality.accepted) {
                best = candidate;
                bestEval = quality;
                bestAttempt = attempt;
                break;
            }
        }
        best.seed = rootSeed;
        best.topology = topology;
        best.generation = {
            attempt: bestAttempt,
            attemptsTried: bestAttempt + 1,
            accepted: bestEval.accepted,
            score: bestEval.score,
            checks: bestEval.checks,
            metrics: bestEval.metrics,
        };
        return best;
    }
    static generateMapDescriptor({
        rules = GameRuleDefinition.current,
        seed = 0,
        roundNumber = 1,
    } = {}) {
        const id = rules?.map?.generator || 'fixed-standard';
        const key = JSON.stringify([id, seed >>> 0, roundNumber || 1, rules]);
        if (this.descriptorCache?.key === key) return this.descriptorCache.descriptor;
        const generator = MAP_GENERATORS[id] || MAP_GENERATORS['fixed-standard'];
        const out = generator(rules, seed, roundNumber);
        out.generator = id in MAP_GENERATORS ? id : 'fixed-standard';
        this.descriptorCache = { key, descriptor: out };
        return out;
    }
    static generateProceduralBridges(ctx, laneControlPoints, terrain) {
        // Span the depressed floor and both banks; bridge endpoints return to level 0.
        const crossings = MapGeometry.laneRiverCrossings(laneControlPoints, {
                ...terrain,
                riverHalfWidth: (terrain.riverHalfWidth || 80) + (terrain.riverBankWidth || 0),
            }),
            eligible = [];
        for (const c of crossings) {
            const chance = c.laneKey === 'mid' ? 0.55 : 0.32;
            const roll =
                (HashUtil.hash(`${ctx.seed}|bridge|${c.laneKey}|${Math.round(c.t * 1000)}`) %
                    10000) /
                10000;
            if (roll >= chance) continue;
            const tangent = polylineTangentAt(laneControlPoints[c.laneKey], c.t);
            eligible.push({ ...c, priority: c.laneKey === 'mid' ? 0 : 1, roll, tangent });
        }
        eligible.sort(
            (a, b) =>
                a.priority - b.priority ||
                a.roll - b.roll ||
                a.laneKey.localeCompare(b.laneKey) ||
                a.t - b.t,
        );
        return eligible
            .slice(0, 2)
            .map((c, i) => {
                const angle = Math.atan2(c.tangent.y, c.tangent.x),
                    ca = Math.cos(-angle),
                    sa = Math.sin(-angle);
                const project = (p) => {
                    const ox = p.x - c.x,
                        oy = p.y - c.y;
                    return ox * ca - oy * sa;
                };
                const bankSpan = Math.max(Math.abs(project(c.start)), Math.abs(project(c.end)));
                const bankOverhang = Math.max(
                    28 * ctx.scale,
                    (terrain.riverHalfWidth || 80) * 0.18,
                );
                const x = Math.round(c.x),
                    y = Math.round(c.y),
                    halfWidth = Math.round(46 * ctx.scale),
                    banks =
                        terrain.riverBankLayers ||
                        (terrain.layers || []).filter((l) => l.innerPoints?.length);
                // The lane crossing is curved but the deck is straight. Projected lane
                // endpoints can miss a thin bank sliver between sampled endcap points.
                // Require both complete endcap segments, plus their land margin, to clear
                // every bank polygon before fixing the actual level-0 bridge footprint.
                const endcapsClear = (halfLength) =>
                    [-1, 1].every((sign) => {
                        const ex = x + sign * halfLength * Math.cos(angle),
                            ey = y + sign * halfLength * Math.sin(angle);
                        const a = {
                                x: ex - halfWidth * Math.sin(angle),
                                y: ey + halfWidth * Math.cos(angle),
                            },
                            b = {
                                x: ex + halfWidth * Math.sin(angle),
                                y: ey - halfWidth * Math.cos(angle),
                            };
                        return banks.every(
                            (bank) =>
                                !pointInSimplePolygon(a.x, a.y, bank.points) &&
                                !pointInSimplePolygon(b.x, b.y, bank.points) &&
                                bank.points.every((p, j) => {
                                    const q = bank.points[(j + 1) % bank.points.length];
                                    return (
                                        segmentDistance(a.x, a.y, b.x, b.y, p.x, p.y, q.x, q.y) >=
                                        bankOverhang
                                    );
                                }),
                        );
                    });
                let halfLength = Math.max(120, Math.ceil(bankSpan + bankOverhang));
                const extent = Math.ceil(Math.hypot(ctx.width, ctx.height));
                while (halfLength < extent && !endcapsClear(halfLength)) halfLength++;
                return {
                    id: `bridge-${c.laneKey}-${i}`,
                    laneKey: c.laneKey,
                    level: 0,
                    x,
                    y,
                    angle,
                    halfLength,
                    halfWidth,
                    crossingT: Math.round(c.t * 10000) / 10000,
                    crossingStartT: Math.round(c.startT * 10000) / 10000,
                    crossingEndT: Math.round(c.endT * 10000) / 10000,
                };
            })
            .filter((b) => {
                const ca = Math.cos(b.angle),
                    sa = Math.sin(b.angle),
                    points = [
                        [-1, -1],
                        [1, -1],
                        [1, 1],
                        [-1, 1],
                    ].map(([x, y]) => ({
                        x: b.x + x * b.halfLength * ca - y * b.halfWidth * sa,
                        y: b.y + x * b.halfLength * sa + y * b.halfWidth * ca,
                    }));
                const atlas = TerrainSurfaceAtlas.fromMap({
                    width: ctx.width,
                    height: ctx.height,
                    terrain: ctx.terrainLayout || FrontierTerrainLayout.create(ctx),
                });
                return (
                    points.every(
                        (p) => p.x >= 0 && p.x <= ctx.width && p.y >= 0 && p.y <= ctx.height,
                    ) &&
                    ![...atlas.layers, ...atlas.ramps].some((l) =>
                        polygonsOverlap(points, l.points),
                    )
                );
            });
    }
}

const MAP_GENERATORS = {
    'fixed-standard': MapGeneration.fixedStandardMapDescriptor,
    'procedural-frontier': MapGeneration.proceduralFrontierMapDescriptor,
};

export { CloneUtil, HashUtil, MapGeneration };
