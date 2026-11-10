// Units, buildings, projectiles, the vision policy and terrain queries.
import { RangeUtil } from '../core/game-rules.js';
import {
    CombatComponent,
    MovementComponent,
    StateContract,
    StatusComponent,
} from './components.js';
import { LaunchRules } from './launch-rules.js';
import { LaunchImpact } from './launch-impact.js';
import { FruitHeroAttack } from './fruit-hero-attack.js';
import { StickyCling } from './sticky-cling.js';
import { MapGeneration } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { MapGeometry } from './map-geometry.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { TERRAIN_ATTACK_REVEAL_RADIUS, VISION_SPATIAL_CELL } from '../definitions/world-rules.js';
import { WorldContext } from './world-context.js';
import { TerrainSurfaceAtlas } from './terrain.js';
import { RallyGamekit } from '../core/gamekit.js';
import { FP } from '../core/config.js';
const { VisionField, pointInSimplePolygon, pointPolylineDistance } = RallyGamekit;

class Unit {
    static stateContract = new StateContract(
        { hitFlash: 0, attackFlash: 0, target: null, impactMotion: null, constructionWork: null },
        {
            presentation: ['hitFlash', 'attackFlash'],
            derived: [
                'collisionIntentTick',
                'collisionIntentTx',
                'collisionIntentTy',
                'collisionMoveTick',
                'collisionMoveStartFx',
                'collisionMoveStartFy',
            ],
            children: {
                status: StatusComponent.stateContract,
                movement: MovementComponent.stateContract,
                combat: CombatComponent.stateContract,
            },
        },
    );
    constructor(spec = {}) {
        const data = Unit.stateContract.create(spec);
        if (UnitDefinition.get(data.type)?.heroActive) {
            if (!Object.hasOwn(data, 'heroRoll')) data.heroRoll = null;
            if (!Object.hasOwn(data, 'heroRollQueued')) data.heroRollQueued = false;
        }
        if (UnitDefinition.get(data.type)?.fruitAttack && !Object.hasOwn(data, 'fruitAttack'))
            data.fruitAttack = FruitHeroAttack.initialState();
        const spinAttack = UnitDefinition.get(data.type)?.spinAttack;
        if (spinAttack && !Object.hasOwn(data, 'spinAttack')) data.spinAttack = null;
        if (spinAttack?.rhythm && !Object.hasOwn(data, 'spinAttackBasicHits'))
            data.spinAttackBasicHits = 0;
        if (UnitDefinition.get(data.type)?.contactMelee && !Object.hasOwn(data, 'contactAttack'))
            data.contactAttack = null;
        if (UnitDefinition.get(data.type)?.stickyCling && !Object.hasOwn(data, 'stickyCling'))
            data.stickyCling = StickyCling.initialState();
        if (UnitDefinition.get(data.type)?.selfDestruct && !Object.hasOwn(data, 'selfDestruct'))
            data.selfDestruct = null;
        if (UnitDefinition.get(data.type)?.leapAttack && !Object.hasOwn(data, 'leapAttack'))
            data.leapAttack = { phase: 'ready', cooldownUntil: 0 };
        // A returning hero keeps its own A* route (navigation-paths.js RoutePath).
        if (LaunchRules.isHeroType(data.type) && !Object.hasOwn(data, 'route')) data.route = null;
        this.status = new StatusComponent(data.status || {});
        delete data.status;
        this.movement = new MovementComponent(data.movement || {});
        delete data.movement;
        this.combat = new CombatComponent(data.combat || {});
        delete data.combat;
        Object.assign(this, data);
    }
    toState(mode = 'snapshot') {
        return Unit.stateContract.capture(this, mode);
    }
    writeChecksum(h) {
        Unit.stateContract.hash(h, this);
    }
    toJSON() {
        return this.toState('save');
    }
    static fromState(state) {
        return new Unit(state || {});
    }
}

class Building {
    static stateContract = new StateContract(
        {
            cooldownUntil: 0,
            attackCooldownPhase: 0,
            attacksSinceMortar: 0,
            targetId: null,
            construction: null,
            salvo: [],
            terrainRevealUntil0: 0,
            terrainRevealUntil1: 0,
        },
        { presentation: ['hitFlash', 'attackFlash'] },
    );
    constructor(state = {}) {
        Object.assign(this, Building.stateContract.create(state));
        if (!Array.isArray(this.salvo)) this.salvo = [];
    }
    cooldownActive(sim) {
        return sim.tick < (Number(this.cooldownUntil) || 0);
    }
    clearCooldown() {
        this.cooldownUntil = 0;
    }
    startCooldownUntil(tick) {
        this.cooldownUntil = Math.max(0, Math.round(Number(tick) || 0));
        return this.cooldownUntil;
    }
    toState(mode = 'snapshot') {
        return Building.stateContract.capture(this, mode);
    }
    writeChecksum(h) {
        Building.stateContract.hash(h, this);
    }
    toJSON() {
        return this.toState('save');
    }
    static fromState(state) {
        return new Building(state || {});
    }
}
class Projectile {
    static stateContract = new StateContract(
        {},
        { presentation: ['arcHeight', 'drawRadius', 'visualTag'] },
    );
    constructor(state = {}) {
        Object.assign(this, Projectile.stateContract.create(state));
        if (this.payload && this.hp == null) this.hp = LaunchRules.grain(this.payload.type).shellHp;
        this.visualTag = 'launchAmmo';
        this.arcHeight = this.mortar
            ? BuildingDefinition.get(this.type).mortar.arcHeight
            : LaunchRules.arcHeight(
                  this.arcDistance ??
                      Math.hypot(
                          (Number(this.lockedAimX) || 0) - (Number(this.launchX) || 0),
                          (Number(this.lockedAimY) || 0) - (Number(this.launchY) || 0),
                      ),
                  this.type,
              );
        this.drawRadius = 8 + Math.min(10, (this.payload?.count || 0) / 3);
    }
    toState(mode = 'snapshot') {
        return Projectile.stateContract.capture(this, mode);
    }
    writeChecksum(h) {
        Projectile.stateContract.hash(h, this);
    }
    toJSON() {
        return this.toState('save');
    }
    static fromState(state) {
        return new Projectile(state || {});
    }
}

class VisibilityPolicy {
    static snapshotQueries = new WeakMap();
    static unitQuery(state) {
        if (typeof state.nearbyUnits === 'function')
            return (x, y, r, visit) => {
                for (const i of state.nearbyUnits(x, y, r)) visit(state.units[i]);
            };
        let cached = this.snapshotQueries.get(state);
        if (cached && cached.tick === state.tick && cached.units === state.units)
            return cached.query;
        const cell = VISION_SPATIAL_CELL,
            bins = new Map();
        for (const u of state.units || [])
            if (u?.alive) {
                const key = Math.floor(u.x / cell) + ',' + Math.floor(u.y / cell);
                let bin = bins.get(key);
                if (!bin) bins.set(key, (bin = []));
                bin.push(u);
            }
        const query = (x, y, r, visit) => {
            for (let cy = Math.floor((y - r) / cell); cy <= Math.floor((y + r) / cell); cy++)
                for (let cx = Math.floor((x - r) / cell); cx <= Math.floor((x + r) / cell); cx++) {
                    const bin = bins.get(cx + ',' + cy);
                    if (bin) for (const u of bin) visit(u);
                }
        };
        this.snapshotQueries.set(state, { tick: state.tick, units: state.units, query });
        return query;
    }
    static revealUntil(unit, side) {
        return (
            Number(
                side === 0 ? unit?.status?.terrainRevealUntil0 : unit?.status?.terrainRevealUntil1,
            ) || 0
        );
    }
    // The side's vision field, current for this state: one per side on `owner`, rebuilt when the terrain changes. Combat
    // targeting, AI, entity drawing and fog all read it; only observers whose cell, radius or level changed are repainted.
    static field(owner, side, state) {
        const map = WorldContext.forState(state).terrain.ensureVisionMap(),
            fields = (owner.visionFields ||= [null, null]);
        let field = fields[side];
        if (field?.map !== map) field = fields[side] = new VisionField(map);
        return field.update(this.observers(state, side));
    }
    static observers(state, side) {
        const out = [],
            world = WorldContext.forState(state);
        for (const u of state.units || [])
            if (u.alive && u.side === side) {
                const d = UnitDefinition.get(u.type) || {};
                out.push({
                    id: u.id,
                    x: u.x,
                    y: u.y,
                    radius: Number(d.sight) || 0,
                    level: world.terrain.surfaces.levelAt(u.x, u.y),
                });
            }
        for (const b of state.buildings || [])
            if (b.alive !== false && b.side === side) {
                const d = BuildingDefinition.get(b.type) || {};
                out.push({
                    id: b.id,
                    x: b.x,
                    y: b.y,
                    radius: Number(d.sight) || 0,
                    level: world.terrain.surfaces.levelAt(b.x, b.y),
                });
            }
        const surfaces = world.terrain.surfaces;
        for (const p of state.projectiles || []) {
            if (!p.alive || !p.payload || p.side !== side) continue;
            const elevation = LaunchImpact.projectileHeight(state, p, p.x, p.y);
            out.push({
                id: p.id,
                x: p.x,
                y: p.y,
                radius: LaunchRules.shellFlight.sightRadius,
                level: Math.min(
                    surfaces.maxLevel,
                    Math.floor(TerrainSurfaceAtlas.levelForElevation(elevation)),
                ),
            });
        }
        // High-ground attackers briefly reveal their own tile to the side they attacked.
        for (const u of state.units || [])
            if (u?.alive && u.side !== side && this.revealUntil(u, side) > Number(state.tick || 0))
                out.push({
                    id: `reveal:${u.id}`,
                    x: u.x,
                    y: u.y,
                    radius: TERRAIN_ATTACK_REVEAL_RADIUS,
                    level: world.terrain.surfaces.levelAt(u.x, u.y),
                    xray: true,
                });
        for (const b of state.buildings || [])
            if (
                b?.alive !== false &&
                b.side !== side &&
                Number(side === 0 ? b.terrainRevealUntil0 : b.terrainRevealUntil1) >
                    Number(state.tick || 0)
            )
                out.push({
                    id: `reveal:${b.id}`,
                    x: b.x,
                    y: b.y,
                    radius: TERRAIN_ATTACK_REVEAL_RADIUS,
                    level: world.terrain.surfaces.levelAt(b.x, b.y),
                    xray: true,
                });
        return out;
    }
}
class TerrainQuery {
    static boxes = new WeakMap();
    // Bounding boxes reject most river polygon tests without changing any answer.
    static inPolygon(x, y, points) {
        let box = this.boxes.get(points);
        if (!box) {
            box = { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity };
            for (const p of points) {
                box.minX = Math.min(box.minX, p.x);
                box.maxX = Math.max(box.maxX, p.x);
                box.minY = Math.min(box.minY, p.y);
                box.maxY = Math.max(box.maxY, p.y);
            }
            this.boxes.set(points, box);
        }
        return (
            x >= box.minX &&
            x <= box.maxX &&
            y >= box.minY &&
            y <= box.maxY &&
            pointInSimplePolygon(x, y, points)
        );
    }
    static at(map, x, y, atlas = null) {
        const terrain = MapGeneration.mapTerrainDescriptor(map);
        const bridge =
            (terrain.bridges || []).find((b) => MapGeometry.pointInBridgeZone(x, y, b, 0)) || null;
        let river = false;
        if (!bridge) {
            river = !!terrain.riverPolygon && this.inPolygon(x, y, terrain.riverPolygon);
            if (!river)
                for (const poly of terrain.riverBranchPolygons || [])
                    if (this.inPolygon(x, y, poly)) {
                        river = true;
                        break;
                    }
            if (!river && (!terrain.riverPolygon || terrain.riverPolygon.length < 3)) {
                river =
                    (terrain.riverPath || []).length > 1 &&
                    pointPolylineDistance(x, y, terrain.riverPath) <= terrain.riverHalfWidth;
                if (!river)
                    for (const branch of terrain.riverBranches || [])
                        if (
                            branch.length > 1 &&
                            pointPolylineDistance(x, y, branch) <= terrain.riverHalfWidth * 0.72
                        ) {
                            river = true;
                            break;
                        }
            }
        }
        const surface = (atlas || (map ? TerrainSurfaceAtlas.fromMap(map) : null))?.sample(
            x,
            y,
        ) || { elevation: 0, level: 0, ramp: null };
        const raised = surface.layer && surface.level > (surface.layer.parent?.level ?? 0);
        return {
            river: surface.elevation > 0 || raised || surface.ramp ? false : river,
            bridge,
            level: surface.level,
            height: TerrainSurfaceAtlas.levelForElevation(surface.elevation),
            surfaceElevation: surface.elevation,
            terrainLayer: surface.level,
            ramp: surface.ramp?.id || null,
            rampProgress: surface.ramp
                ? RangeUtil.clamp(Number(surface.progress) || 0, 0, 1)
                : null,
        };
    }
}
// Tracks authoritative obstacle values without per-tick filter/map/string allocation.
// Direct writes by trusted scenario scripts are still noticed on the next sync.
class NavigationTopology {
    constructor() {
        this.records = [];
        this.byId = new Map();
        this.changes = [];
        this.version = 0;
        // FNV-1a of the obstacle records: equal for equal layouts in every peer, replay and restored save,
        // unlike `version`, which only counts this instance's refreshes. Stored routes compare against it.
        this.signature = NavigationTopology.signatureOf([]);
        this.scans = 0;
    }
    static signatureOf(records) {
        let h = 0x811c9dc5;
        const mix = (n) => {
            h = Math.imul(h ^ (n >>> 0), 0x01000193) >>> 0;
        };
        for (const b of records) {
            const id = String(b.id);
            mix(id.length);
            for (let i = 0; i < id.length; i++) mix(id.charCodeAt(i));
            mix(Math.round(b.x * FP));
            mix(Math.round(b.y * FP));
            mix(Math.round(b.r * FP));
            mix(b.terrainBarrier ? 1 : 0);
        }
        return h;
    }
    refresh(buildings) {
        this.scans++;
        let count = 0,
            changed = this.version === 0;
        for (const b of buildings)
            if (b.alive !== false && b.hp > 0) {
                count++;
                const old = this.byId.get(b.id),
                    d = BuildingDefinition.get(b.type),
                    r = (d?.size || 35) + NAV_BUILDING_MARGIN;
                if (
                    !old ||
                    old.type !== b.type ||
                    old.x !== b.x ||
                    old.y !== b.y ||
                    old.r !== r ||
                    old.terrainBarrier !== !!d?.isTerrainBarrier ||
                    old.blocksVision !== !!d?.blocksVision
                )
                    changed = true;
            }
        if (!changed && count === this.records.length) return false;
        const old = new Map(this.byId),
            records = [],
            changes = [];
        for (const b of buildings)
            if (b.alive !== false && b.hp > 0) {
                const d = BuildingDefinition.get(b.type),
                    r = (d?.size || 35) + NAV_BUILDING_MARGIN;
                const next = {
                        id: b.id,
                        type: b.type,
                        x: b.x,
                        y: b.y,
                        r,
                        terrainBarrier: !!d?.isTerrainBarrier,
                        blocksVision: !!d?.blocksVision,
                        minX: b.x - r,
                        maxX: b.x + r,
                        minY: b.y - r,
                        maxY: b.y + r,
                    },
                    previous = old.get(b.id);
                if (!previous || Object.keys(next).some((key) => next[key] !== previous[key])) {
                    if (previous) changes.push(previous);
                    changes.push(next);
                }
                records.push(next);
                old.delete(b.id);
            }
        changes.push(...old.values());
        this.changes = changes;
        if (!changes.length && this.version > 0) return false;
        this.records = records.sort((a, b) =>
            String(a.id) < String(b.id) ? -1 : String(a.id) > String(b.id) ? 1 : 0,
        );
        this.byId = new Map(this.records.map((b) => [b.id, b]));
        this.signature = NavigationTopology.signatureOf(this.records);
        this.version++;
        return true;
    }
}

export { Building, NavigationTopology, Projectile, TerrainQuery, Unit, VisibilityPolicy };
