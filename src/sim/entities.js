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
import { FruitHeroAttack } from './capabilities/fruit-hero-attack.js';
import { StickyCling } from './capabilities/sticky-cling.js';
import { CannonRider } from './capabilities/cannon-rider.js';
import { RollingBody } from './capabilities/rolling-body.js';
import { UnitFlight } from './capabilities/unit-flight.js';
import { UnitBreathAttack } from './capabilities/unit-breath-attack.js';
import { SustainedAttack } from './capabilities/sustained-attack.js';
import { UnitChainAttack } from './capabilities/unit-chain-attack.js';
import { MapGeneration } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { MapGeometry } from './map-geometry.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { TERRAIN_ATTACK_REVEAL_RADIUS } from '../definitions/world-rules.js';
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
        // An arc sweep keeps its own spin state; a pulsing spin is timed by its sustain (below).
        const spinAttack = UnitDefinition.get(data.type)?.spinAttack;
        if (spinAttack?.arcSweep && !Object.hasOwn(data, 'spinAttack')) data.spinAttack = null;
        if (spinAttack?.rhythm && !Object.hasOwn(data, 'spinAttackBasicHits'))
            data.spinAttackBasicHits = 0;
        if (UnitDefinition.get(data.type)?.contactMelee && !Object.hasOwn(data, 'contactAttack'))
            data.contactAttack = null;
        if (UnitDefinition.get(data.type)?.stickyCling && !Object.hasOwn(data, 'stickyCling'))
            data.stickyCling = StickyCling.initialState();
        if (UnitDefinition.get(data.type)?.cannonRider && !Object.hasOwn(data, 'cannonRide'))
            data.cannonRide = CannonRider.initialState();
        if (UnitDefinition.get(data.type)?.rolling && !Object.hasOwn(data, 'rolling'))
            data.rolling = RollingBody.initialState();
        if (UnitDefinition.get(data.type)?.selfDestruct && !Object.hasOwn(data, 'selfDestruct'))
            data.selfDestruct = null;
        if (UnitDefinition.get(data.type)?.leapAttack && !Object.hasOwn(data, 'leapAttack'))
            data.leapAttack = { phase: 'ready', cooldownUntil: 0 };
        if (UnitDefinition.get(data.type)?.flight && !Object.hasOwn(data, 'flight'))
            data.flight = UnitFlight.initialState();
        if (UnitDefinition.get(data.type)?.breathAttack && !Object.hasOwn(data, 'breath'))
            data.breath = UnitBreathAttack.initialState();
        const chainAttack = UnitDefinition.get(data.type)?.chainAttack;
        if (chainAttack && !Object.hasOwn(data, 'chain'))
            data.chain = UnitChainAttack.initialState(chainAttack);
        // A sustained attack's timing (duration, damage ticks, cooldown) is its own state, shared by every such attack.
        if (UnitDefinition.get(data.type)?.sustain && !Object.hasOwn(data, 'sustain'))
            data.sustain = SustainedAttack.initialState();
        // A returning hero keeps its own A* route (navigation-paths.js RoutePath).
        if (LaunchRules.isHeroType(data.type) && !Object.hasOwn(data, 'route')) data.route = null;
        // A hero's growth record (HeroGrowth), handed over when it lands from its shell.
        if (LaunchRules.isHeroType(data.type) && !Object.hasOwn(data, 'heroGrowth'))
            data.heroGrowth = null;
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
    // Observer kinds (VisibilityPolicy.observe).
    static UNIT = 0;
    static BUILDING = 1;
    static SHELL = 2;
    static UNIT_REVEAL = 3;
    static BUILDING_REVEAL = 4;
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
        this.observe(field.begin(), state, side);
        return field.end();
    }
    // Observer id = number · 8 + kind. A unit's or shell's number is its id's sequence, a building's its place in
    // state.buildings, so ids stay unique within one update and steady across updates while the entity lives.
    static observe(field, state, side) {
        const world = WorldContext.forState(state),
            surfaces = world.terrain.surfaces,
            tick = Number(state.tick || 0),
            units = state.units || [],
            buildings = state.buildings || [];
        for (const u of units)
            if (u.alive && u.side === side)
                field.observe(
                    EntityKey.number(u.id) * 8 + VisibilityPolicy.UNIT,
                    u.x,
                    u.y,
                    Number(UnitDefinition.get(u.type)?.sight) || 0,
                    surfaces.levelAt(u.x, u.y),
                );
        for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i];
            if (b.alive !== false && b.side === side)
                field.observe(
                    i * 8 + VisibilityPolicy.BUILDING,
                    b.x,
                    b.y,
                    Number(BuildingDefinition.get(b.type)?.sight) || 0,
                    surfaces.levelAt(b.x, b.y),
                );
        }
        for (const p of state.projectiles || []) {
            if (!p.alive || !p.payload || p.side !== side) continue;
            const elevation = LaunchImpact.projectileHeight(state, p, p.x, p.y);
            field.observe(
                EntityKey.number(p.id) * 8 + VisibilityPolicy.SHELL,
                p.x,
                p.y,
                LaunchRules.shellFlight.sightRadius,
                Math.min(
                    surfaces.maxLevel,
                    Math.floor(TerrainSurfaceAtlas.levelForElevation(elevation)),
                ),
            );
        }
        // High-ground attackers briefly reveal their own tile to the side they attacked.
        for (const u of units)
            if (u?.alive && u.side !== side && this.revealUntil(u, side) > tick)
                field.observe(
                    EntityKey.number(u.id) * 8 + VisibilityPolicy.UNIT_REVEAL,
                    u.x,
                    u.y,
                    TERRAIN_ATTACK_REVEAL_RADIUS,
                    surfaces.levelAt(u.x, u.y),
                    true,
                );
        for (let i = 0; i < buildings.length; i++) {
            const b = buildings[i];
            if (
                b?.alive !== false &&
                b.side !== side &&
                Number(side === 0 ? b.terrainRevealUntil0 : b.terrainRevealUntil1) > tick
            )
                field.observe(
                    i * 8 + VisibilityPolicy.BUILDING_REVEAL,
                    b.x,
                    b.y,
                    TERRAIN_ATTACK_REVEAL_RADIUS,
                    surfaces.levelAt(b.x, b.y),
                    true,
                );
        }
    }
}
// Numeric keys for tick-path ties and caches instead of strings built from ids.
class EntityKey {
    // The decimal digits that end an id ('u' + seq, 'p' + seq): the entity's sequence number, unique per kind.
    // A match counts far fewer than 2^50 entities, so the number and number · 8 + kind stay below 2^53.
    static number(id) {
        let n = 0,
            scale = 1;
        for (let i = id.length - 1; i >= 0; i--) {
            const digit = id.charCodeAt(i) - 48;
            if (digit < 0 || digit > 9) break;
            n += digit * scale;
            scale *= 10;
        }
        return n;
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
            const id = b.buildingId;
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
                        buildingId: b.id,
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
            a.buildingId < b.buildingId ? -1 : a.buildingId > b.buildingId ? 1 : 0,
        );
        // A circle obstacle's id is its place in this sorted list: an integer, as contact keys need.
        for (let i = 0; i < this.records.length; i++) this.records[i].id = i;
        this.byId = new Map(this.records.map((b) => [b.buildingId, b]));
        this.signature = NavigationTopology.signatureOf(this.records);
        this.version++;
        return true;
    }
}

export {
    Building,
    EntityKey,
    NavigationTopology,
    Projectile,
    TerrainQuery,
    Unit,
    VisibilityPolicy,
};
