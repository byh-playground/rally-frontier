import { UnitLobAttack } from './unit-lob-attack.js';
// The deterministic lockstep strategy simulation.
import { GameRuleDefinition, RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { HeroDeployment } from './hero-deployment.js';
import { HeroRollAttack } from './hero-roll-attack.js';
import { FruitHeroAttack } from './fruit-hero-attack.js';
import { UnitSpinAttack } from './unit-spin-attack.js';
import { UnitSelfDestructAttack } from './unit-self-destruct-attack.js';
import { UnitLeapAttack } from './unit-leap-attack.js';
import { Building, Projectile, TerrainQuery, Unit, VisibilityPolicy } from './entities.js';
import { StateContract, StateValue } from './components.js';
import { CampaignMission } from './campaign-mission.js';
import { UnitResultStats } from './unit-result-stats.js';
import { RallyStateCodec } from '../core/rally-state-codec.js';
import { LaunchRules } from './launch-rules.js';
import { ConstructionRules } from './construction-rules.js';
import { LaunchImpact } from './launch-impact.js';
import { LaunchInterception } from './launch-interception.js';
import { UnitThornAttack } from './unit-thorn-attack.js';
import { UnitBurstAttack } from './unit-burst-attack.js';
import { LaunchImpactRules } from '../definitions/launch-impact-rules.js';
import { ConnectionSideUtil, StableSerializationUtil } from '../net/lobby-codec.js';
import { CloneUtil, HashUtil, MapGeneration } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UNIT_RUNTIME_GEOMETRY, UnitDefinition } from '../definitions/units.js';
import {
    DAMAGE_CLASS_MATRIX,
    CAPTURE_RADIUS,
    COMBAT_TARGET_REFRESH_MS,
    COMBAT_TARGET_STICKINESS_PCT,
    DEAD_ENTITY_CLEANUP_MS,
    DEFAULT_ATTACK_WINDUP_MS,
    DEFAULT_MELEE_MOVE_RECOVERY_MS,
    DEFAULT_RANGED_MOVE_RECOVERY_MS,
    NAV_BUILDING_MARGIN,
    SPAWN_UNIT_GAP,
} from '../definitions/combat-rules.js';
import { createLocalPerfStats, createLocalBalanceStats } from '../diagnostics/simulation-stats.js';
import {
    ALLY_SOFT_CORRECTION_FRACTION,
    ALLY_SOFT_IDLE_RADIUS_FRACTION,
    ALLY_SOFT_MAX_RADIUS_FRACTION,
    ALLY_SOFT_ITERATIONS,
    ALLY_SOFT_SPEED_FRACTION,
    BALANCE_HISTORY_EVERY_MS,
    BALANCE_HISTORY_MAX,
    BALANCE_SAMPLE_EVERY_MS,
    COLLISION_NORMAL,
    COLLISION_RADIUS_SCALE,
    COLLISION_SPATIAL_CELL,
    PERF_SAMPLE_EVERY_MS,
    SIM_SPATIAL_CELL,
    TERRAIN_ATTACK_REVEAL_MS,
} from '../definitions/world-rules.js';
import { WorldContext } from './world-context.js';
import {
    InteractionGeometry,
    NavigationGoal,
    TerrainNavigation,
    UnitMotion,
} from './navigation.js';
import { FP } from '../core/config.js';
import { RallyGamekit, RallyNetcode } from '../core/gamekit.js';
const { BoundsGrid, SurfaceContactGeometry, SweptCircleContact, UniformGrid } = RallyGamekit;
import { SimulationTiming } from '../core/simulation-timing.js';

class SimulationRuntimeState {
    static collision(sim) {
        // Fixed-point coordinates: one cell is COLLISION_SPATIAL_CELL world units, positions are the units' fx/fy.
        sim.collisionGrid = new UniformGrid({
            cellSize: COLLISION_SPATIAL_CELL * FP,
            width: sim.world.width * FP,
            height: sim.world.height * FP,
            outside: 'clamp',
        });
        sim.collisionGridMaxRadius = 0;
        sim.collisionCandidateBuffer = [];
        sim.collisionSweepGrid = new BoundsGrid({
            cellSize: COLLISION_SPATIAL_CELL * FP,
            width: sim.world.width * FP,
            height: sim.world.height * FP,
            maxCells: 16,
            views: 2,
        });
        sim.collisionSweepEndCell = new Int32Array(0);
        sim.collisionMotion = null;
        for (const key of [
            'collisionRadii',
            'collisionMasses',
            'collisionDx',
            'collisionDy',
            'collisionStartFx',
            'collisionStartFy',
            'collisionSegmentFx',
            'collisionSegmentFy',
            'collisionNextFx',
            'collisionNextFy',
            'collisionBestOther',
        ])
            sim[key] = new Int32Array(0);
        sim.collisionCnt = new Uint16Array(0);
        for (const key of ['collisionBestT', 'collisionBestNx', 'collisionBestNy'])
            sim[key] = new Float64Array(0);
        sim.collisionStartCount = 0;
        sim.collisionMaxStepMovementFP = 0;
        sim.hardFixSapAxis = 'x';
        for (const key of [
            'hardFixSapOrder',
            'hardFixSapEligible',
            'hardFixSapWorkOrder',
            'hardFixSapSweepActive',
            'hardFixSapPairs',
        ])
            sim[key] = [];
        sim.hardFixSapSideHeads = new Int32Array([-1, -1, -1]);
        sim.hardFixSapSideNext = new Int32Array(0);
        sim.hardFixSapSidePrev = new Int32Array(0);
        sim.hardFixSapSideHeaps = [[], [], []];
        sim.hardFixSapMarks = new Uint32Array(0);
        sim.hardFixSapEpoch = 1;
    }
    static spatial(sim) {
        // Units are tracked by array index with one group per side (0, 1, other), so enemy and ally queries skip each other.
        sim.unitSpatial = new UniformGrid({
            cellSize: SIM_SPATIAL_CELL,
            width: sim.world.width,
            height: sim.world.height,
            outside: 'clamp',
            groups: 3,
            track: 'index',
        });
        sim.buildingSpatial = new UniformGrid({
            cellSize: SIM_SPATIAL_CELL,
            width: sim.world.width,
            height: sim.world.height,
            outside: 'clamp',
        });
        sim.buildingSpatialDirty = true;
        sim.buildingSpatialQueryBuffers = Array.from({ length: 16 }, () => []);
        sim.buildingSpatialQueryCursor = 0;
        sim.maxBuildingRadius =
            Math.max(...Object.values(BuildingDefinition.all).map((d) => Number(d?.size) || 35)) +
            NAV_BUILDING_MARGIN;
        sim.unitById = new Map();
        sim.buildingById = new Map();
        sim.unitIndexById = new Map();
        sim.runtimeIndexTick = -1;
        sim.spatialQueryBuffers = Array.from({ length: 64 }, () => []);
        sim.spatialQueryCursor = 0;
        // Scoped results are owned by the active query caller. Nested traversals
        // use a separate stack so they never alias a live rotating-ring result.
        sim.spatialQueryScopeBuffers = [];
        sim.spatialQueryScopeDepth = 0;
        sim.maxUnitRadius = Math.max(
            ...Object.values(UnitDefinition.all).map(
                (d) => (d?.size || 10) * COLLISION_RADIUS_SCALE,
            ),
        );
        sim.targetLevelMemo = new WeakMap();
    }
    static visibility(sim) {
        sim.visionFields = [null, null];
    }
    static initialize(sim, { newMatch = false } = {}) {
        sim.runtimeEpoch = (sim.runtimeEpoch || 0) + 1;
        this.collision(sim);
        this.spatial(sim);
        this.visibility(sim);
        sim.navigation = new TerrainNavigation(sim);
        sim.perfStats = createLocalPerfStats();
        sim._perfCollect = null;
        if (newMatch || !sim.balanceStats) sim.balanceStats = createLocalBalanceStats();
        sim.commandReceipts = [];
    }
    static invalidate(sim) {
        sim.runtimeEpoch = (sim.runtimeEpoch || 0) + 1;
        this.visibility(sim);
        sim.runtimeIndexTick = -1;
        sim.spatialQueryCursor = 0;
        sim.spatialQueryScopeDepth = 0;
        sim.buildingSpatialQueryCursor = 0;
        sim.buildingSpatialDirty = true;
        sim.collisionStartCount = 0;
        sim.hardFixSapOrder.length = 0;
        sim.hardFixSapEligible.length = 0;
        sim.hardFixSapEpoch = 1;
        sim.hardFixSapMarks.fill(0);
        sim.hardFixSapSideHeads.fill(-1);
        for (const heap of sim.hardFixSapSideHeaps) heap.length = 0;
        sim.navigation.motion = new UnitMotion(sim.navigation);
        sim.rebuildRuntimeIndexes();
    }
}

class StrategySim {
    // Root extensions authored by trusted missions are authoritative by default.
    // Runtime owners declare only the local/derived exclusions; entity owners keep
    // their existing StateContracts and serialization.
    static stateContract = new StateContract(
        {},
        {
            presentation: ['events', 'perfStats', 'balanceStats', '_perfCollect'],
            derived: [
                'chargedHeldIds',
                'world',
                'tps',
                'disposed',
                'runtimeEpoch',
                'commandReceipts',
                'collisionGrid',
                'collisionGridMaxRadius',
                'collisionSweepGrid',
                'collisionSweepEndCell',
                'collisionSweepOut',
                'collisionMotion',
                'collisionRadii',
                'collisionMasses',
                'collisionDx',
                'collisionDy',
                'collisionStartFx',
                'collisionStartFy',
                'collisionSegmentFx',
                'collisionSegmentFy',
                'collisionNextFx',
                'collisionNextFy',
                'collisionBestOther',
                'collisionCandidateBuffer',
                'collisionCnt',
                'collisionBestT',
                'collisionBestNx',
                'collisionBestNy',
                'collisionStartCount',
                'collisionMaxStepMovementFP',
                'hardFixSapAxis',
                'hardFixSapOrder',
                'hardFixSapEligible',
                'hardFixSapWorkOrder',
                'hardFixSapSweepActive',
                'hardFixSapPairs',
                'hardFixSapSideHeads',
                'hardFixSapSideNext',
                'hardFixSapSidePrev',
                'hardFixSapSideHeaps',
                'hardFixSapMarks',
                'hardFixSapEpoch',
                'unitSpatial',
                'buildingSpatial',
                'buildingSpatialDirty',
                'buildingSpatialQueryBuffers',
                'buildingSpatialQueryCursor',
                'maxBuildingRadius',
                'unitById',
                'buildingById',
                'unitIndexById',
                'runtimeIndexTick',
                'spatialQueryBuffers',
                'spatialQueryCursor',
                'spatialQueryScopeBuffers',
                'spatialQueryScopeDepth',
                'maxUnitRadius',
                'targetLevelMemo',
                'visionFields',
                'navigation',
                '_selfDestructQueue',
                '_drainingSelfDestruct',
            ],
        },
    );
    static createForMatch({ seed, rules = GameRuleDefinition.current, decks } = {}) {
        return new StrategySim(seed, rules, decks);
    }
    constructor(
        seed,
        rules = GameRuleDefinition.current,
        decks = [LaunchRules.starterDeck, LaunchRules.starterDeck],
    ) {
        this.seed = seed >>> 0;
        this.decks = StateValue.freeze(LaunchRules.normalizeDeckPair(decks));
        this.rules = rules || GameRuleDefinition.current;
        this.tps = RangeUtil.clamp(
            Math.round(Number(this.rules?.simulation?.tps) || SIM_TPS),
            10,
            30,
        );
        this.mapDescriptor = MapGeneration.generateMapDescriptor({
            rules: this.rules,
            seed: this.seed,
            roundNumber: this.rules?.roundNumber || 1,
        });
        StateValue.freeze(this.mapDescriptor);
        this.world = WorldContext.fromMap(this.mapDescriptor);
        this.tick = 0;
        this.seq = 0;
        this.units = [];
        this.buildings = [];
        this.constructionOrders = [];
        this.navigationAdmissions = [];
        this.projectiles = [];
        this.unitLobProjectiles = [];
        this.unitThornProjectiles = [];
        this.events = [];
        this.scheduled = new Map();
        this.wallet = [0, 1].map(() => LaunchRules.startingWallet);
        this.premiumWallet = [0, 0];
        this.baseProducers = [0, 1].map((side) => ({
            owner: side,
            extractedResources: 0,
            production: LaunchRules.productionChannels(
                LaunchRules.baseIncomePerSecond *
                    (side === 0 ? (this.rules.campaign?.baseIncomeRatio ?? 1) : 1),
            ),
        }));
        const campaign = this.rules.campaign;
        this.launchRangeLevel = [campaign?.startingLaunchRangeLevel ?? 0, 0];
        this.launchDeployments = [];
        this.campaignVolleyPractice = campaign?.volleyGoals
            ? {
                  goals: campaign.volleyGoals.map(() => ({
                      projectileIds: [],
                      garrisonIds: [],
                      landed: false,
                  })),
                  complete: false,
              }
            : null;
        this.heroes = this.decks.map((deck) => HeroDeployment.emptySlots(deck));
        this.heroRecovery = this.decks.map((deck) => HeroDeployment.emptySlots(deck));
        // Per-side match totals for the result screen: shots fired, grains sent, enemy units killed.
        this.launchStats = { launches: [0, 0], sent: [0, 0], kills: [0, 0] };
        this.unitResultStats = UnitResultStats.create();
        this.capturePoints = this.mapDescriptor.capturePoints.map(({ miningPerSecond, ...p }) => ({
            ...p,
            owner: p.owner === 0 || p.owner === 1 ? p.owner : null,
            enabled: p.enabled !== false,
            outpostId: null,
            resourceType: p.resourceType ?? 'basic',
            extractedResources: 0,
            production: LaunchRules.productionChannels(
                miningPerSecond ?? LaunchRules.outpostIncomePerSecond,
                p.resourceType === 'premium',
            ),
        }));

        SimulationRuntimeState.initialize(this, { newMatch: true });

        this.flags = CloneUtil.clone(this.mapDescriptor.flags);
        this.createBase(0);
        this.createBase(1);
        // Campaign positions use ordinary outpost ownership and construction completion.
        if (campaign) {
            const enemyPoints = [];
            for (const [side, ids] of [
                campaign.friendlyOutposts ?? [],
                campaign.enemyOutposts,
            ].entries()) {
                for (const id of ids) {
                    const point = this.capturePoints.find((p) => p.id === id);
                    if (!point) throw new Error(`캠페인 거점이 없습니다: ${id}`);
                    const outpost = this.spawnOutpost(point, side);
                    outpost.hp = outpost.maxHp;
                    this.completeConstruction(outpost);
                    if (side === 1) enemyPoints.push(point);
                }
            }
            if (campaign.introducedEnemy && !campaign.mission?.formations) {
                const [front] = enemyPoints;
                for (let i = 0; i < 3; i++)
                    this.spawnUnit(
                        1,
                        campaign.introducedEnemy,
                        front.x + (i - 1) * 50,
                        front.y + 100,
                    );
            }
        }
        // Landed units march straight to the enemy main base.
        for (const side of [0, 1]) {
            const enemy = this.buildings.find((b) => b.id === 'base' + (1 - side));
            this.flags[side] = { x: enemy.x, y: enemy.y, forced: false };
        }
        for (const [index, { x, y, garrison }] of (campaign?.volleyGoals ?? []).entries()) {
            const rows = Math.ceil(garrison.count / garrison.columns);
            for (let i = 0; i < garrison.count; i++) {
                const dx = ((i % garrison.columns) - (garrison.columns - 1) / 2) * garrison.spacing,
                    dy = (Math.floor(i / garrison.columns) - (rows - 1) / 2) * garrison.spacing;
                const defender = this.spawnUnit(1, garrison.type, x + dx, y + dy);
                defender.status.terrainRevealUntil0 = Number.MAX_SAFE_INTEGER;
                this.campaignVolleyPractice.goals[index].garrisonIds.push(defender.id);
            }
        }
        const missionState = CampaignMission.initialize(this);
        if (missionState) this.campaignMission = missionState;
    }
    dispose(reason = 'disposed') {
        if (this.disposed) return false;
        this.disposed = true;
        return true;
    }
    msTicks(ms, options) {
        return SimulationTiming.msToTicks(ms, this.tps, options);
    }
    ticksMs(ticks) {
        return SimulationTiming.ticksToMs(ticks, this.tps);
    }
    terrainAt(x, y) {
        return TerrainQuery.at(this.mapDescriptor, x, y, this.world.terrain.surfaces);
    }
    terrainMovementMultiplier(x, y, nextX = x, nextY = y) {
        const current = this.terrainAt(x, y),
            next = this.terrainAt(nextX, nextY);
        // 다리 footprint는 평지이며 강 패널티를 완전히 제거한다.
        if (!current.bridge && !next.bridge && (current.river || next.river)) return 0.5;
        const fromH = Number(current.surfaceElevation) || 0,
            toH = Number(next.surfaceElevation) || 0;
        if (toH <= fromH + 0.002) return 1;
        // Every authored ramp is a transition between two integer levels. Slowdown is
        // based on progress across that transition, so 1→2 behaves exactly like 0→1.
        const progress =
            next.ramp != null ? Number(next.rampProgress) || 0 : current.ramp != null ? 1 : 0;
        if (progress < 0.25) return 1;
        if (progress < 0.5) return 0.85;
        if (progress < 0.75) return 0.7;
        return 0.5;
    }

    rebuildRuntimeIndexes() {
        for (let i = 0; i < (this.units || []).length; i++)
            if (!(this.units[i] instanceof Unit)) this.units[i] = Unit.fromState(this.units[i]);
        this.unitById.clear();
        this.buildingById.clear();
        this.unitIndexById.clear();
        for (let i = 0; i < this.units.length; i++) {
            const u = this.units[i];
            this.unitById.set(u.id, u);
            this.unitIndexById.set(u.id, i);
        }
        for (const b of this.buildings) this.buildingById.set(b.id, b);
        this.unitSpatial.clear();
        for (let i = 0; i < this.units.length; i++) {
            const u = this.units[i];
            if (u.alive) this.unitSpatial.insert(i, u.x, u.y, StrategySim.spatialGroup(u.side));
        }
        this.runtimeIndexTick = this.tick;
        this.ensureBuildingSpatial();
    }
    entityRefById(id, kind = null) {
        if (id == null) return null;
        if (kind !== 'building') {
            const unit = this.unitById.get(id) || this.units.find((u) => u.id === id);
            if (unit) return { entity: unit, isBuilding: false };
        }
        if (kind !== 'unit') {
            const building = this.buildingById.get(id) || this.buildings.find((b) => b.id === id);
            if (building) return { entity: building, isBuilding: true };
        }
        return null;
    }
    liveEntityRefById(id, kind = null) {
        const ref = this.entityRefById(id, kind);
        if (!ref) return null;
        const alive = ref.isBuilding ? ref.entity.alive !== false : !!ref.entity.alive;
        return alive ? ref : null;
    }
    markBuildingSpatialDirty() {
        this.buildingSpatialDirty = true;
        if (this.navigation) this.navigation.sceneTick = -1;
    }
    ensureBuildingSpatial() {
        if (this.buildingSpatialDirty) {
            this.buildingSpatial.clear();
            for (let i = 0; i < this.buildings.length; i++) {
                const b = this.buildings[i];
                if (b && b.alive !== false) this.buildingSpatial.insert(i, b.x, b.y);
            }
            this.buildingSpatialDirty = false;
        }
    }
    nearbyBuildingIndices(x, y, r) {
        this.ensureBuildingSpatial();
        const out = this.buildingSpatialQueryBuffers[this.buildingSpatialQueryCursor++ & 15];
        return this.buildingSpatial.queryCircle(x, y, r, out);
    }
    static spatialGroup(side) {
        return side === 0 ? 0 : side === 1 ? 1 : 2;
    }
    // A moved unit changes cell (and so bucket order) only when its cell changes; a dead one leaves the grid.
    syncUnitSpatial(u) {
        if (this.runtimeIndexTick !== this.tick || !u) return;
        const index = this.unitIndexById.get(u.id);
        if (index == null) return;
        if (index < this.collisionStartCount)
            this.collisionMaxStepMovementFP = Math.max(
                this.collisionMaxStepMovementFP,
                Math.hypot(
                    u.fx - this.collisionStartFx[index],
                    u.fy - this.collisionStartFy[index],
                ),
            );
        if (u.alive) this.unitSpatial.move(index, u.x, u.y, StrategySim.spatialGroup(u.side));
        else if (this.unitSpatial.keyOf(index) !== this.unitSpatial.keyAt(u.x, u.y))
            this.unitSpatial.remove(index);
    }
    addRuntimeUnit(u) {
        if (!u.behaviorState) u.behaviorState = {};
        if (this.runtimeIndexTick !== this.tick || !u) return;
        const index = this.units.length - 1;
        this.unitById.set(u.id, u);
        this.unitIndexById.set(u.id, index);
        if (u.alive) this.unitSpatial.insert(index, u.x, u.y, StrategySim.spatialGroup(u.side));
    }
    nearbyUnits(x, y, r, side = null, out = null) {
        if (this.runtimeIndexTick !== this.tick) this.rebuildRuntimeIndexes();
        if (out !== null && !Array.isArray(out))
            throw new TypeError('nearbyUnits result buffer must be an array');
        const result = this.unitSpatial.queryCircle(
            x,
            y,
            r,
            out || this.spatialQueryBuffers[this.spatialQueryCursor++ & 63],
            side == null ? -1 : StrategySim.spatialGroup(side),
        );
        if (this._perfCollect) {
            this._perfCollect.spatialQueries++;
            this._perfCollect.spatialCandidates += result.length;
            if (side != null) this._perfCollect.sideSpatialQueries++;
        }
        return result;
    }
    withNearbyUnits(x, y, r, side, visit) {
        if (typeof side === 'function') {
            visit = side;
            side = null;
        }
        if (typeof visit !== 'function')
            throw new TypeError('nearbyUnits visitor must be a function');
        if (this.runtimeIndexTick !== this.tick) this.rebuildRuntimeIndexes();
        const depth = this.spatialQueryScopeDepth || 0;
        const out =
            this.spatialQueryScopeBuffers[depth] || (this.spatialQueryScopeBuffers[depth] = []);
        this.spatialQueryScopeDepth = depth + 1;
        try {
            const result = this.unitSpatial.queryCircle(
                x,
                y,
                r,
                out,
                side == null ? -1 : StrategySim.spatialGroup(side),
            );
            if (this._perfCollect) {
                this._perfCollect.spatialQueries++;
                this._perfCollect.spatialCandidates += result.length;
                if (side != null) this._perfCollect.sideSpatialQueries++;
            }
            return visit(result);
        } finally {
            this.spatialQueryScopeDepth = depth;
        }
    }
    ensureCollisionBuffers(n) {
        if (this.collisionRadii.length >= n) return;
        const oldStartX = this.collisionStartFx,
            oldStartY = this.collisionStartFy;
        let cap = Math.max(64, this.collisionRadii.length || 0);
        while (cap < n) cap *= 2;
        this.collisionRadii = new Int32Array(cap);
        this.collisionMasses = new Int32Array(cap);
        this.collisionDx = new Int32Array(cap);
        this.collisionDy = new Int32Array(cap);
        this.collisionCnt = new Uint16Array(cap);
        this.collisionStartFx = new Int32Array(cap);
        this.collisionStartFy = new Int32Array(cap);
        this.collisionStartFx.set(oldStartX);
        this.collisionStartFy.set(oldStartY);
        this.collisionSegmentFx = new Int32Array(cap);
        this.collisionSegmentFy = new Int32Array(cap);
        this.collisionNextFx = new Int32Array(cap);
        this.collisionNextFy = new Int32Array(cap);
        this.collisionBestT = new Float64Array(cap);
        this.collisionBestNx = new Float64Array(cap);
        this.collisionBestNy = new Float64Array(cap);
        this.collisionBestOther = new Int32Array(cap);
        this.collisionMotion = {
            sx: new Float64Array(cap),
            sy: new Float64Array(cap),
            ex: new Float64Array(cap),
            ey: new Float64Array(cap),
            vx: new Float64Array(cap),
            vy: new Float64Array(cap),
        };
    }
    captureCollisionStepStarts() {
        const n = this.units.length;
        this.ensureCollisionBuffers(n);
        for (let i = 0; i < n; i++) {
            const u = this.units[i];
            this.collisionStartFx[i] = u?.fx ?? Math.round((u?.x || 0) * FP);
            this.collisionStartFy[i] = u?.fy ?? Math.round((u?.y || 0) * FP);
        }
        this.collisionStartCount = n;
        this.collisionMaxStepMovementFP = 0;
        this.navigation.motion.beginStep();
    }

    // Launch shots arrive with their damage already resolved; armor and terrain apply on impact.
    spawnProjectile(params) {
        this.projectiles.push(
            new Projectile({
                alive: true,
                launchX: params.x,
                launchY: params.y,
                ...params,
                trajectoryPolicy: params.trajectoryPolicy || 'lockedPoint',
                lockedAimX: Number(params.lockedAimX) || 0,
                lockedAimY: Number(params.lockedAimY) || 0,
                targetLost: false,
                terrainMiss: false,
                damage: Math.max(1, Math.round(Number(params.damage) || 0)),
                sourceFriendlySide: null,
                impactAbility: false,
                sourceDamageResolved: true,
            }),
        );
    }
    canAttackEntity(sourceType, target, isBuilding = false) {
        const d = UnitDefinition.get(sourceType) || BuildingDefinition.get(sourceType);
        return isBuilding
            ? (d?.canAttackBuildings ?? !!d?.canAttackGround)
            : !d || !!d.canAttackGround;
    }
    terrainLevelAt(x, y) {
        return this.world.terrain.surfaces.levelAt(x, y);
    }
    terrainRangedSource(sourceType) {
        const d = UnitDefinition.get(sourceType) || BuildingDefinition.get(sourceType) || null;
        if (!d) return false;
        return (
            !!d.projectile ||
            !!d.continuous ||
            !!d.lobAttack ||
            !!d.thornAttack ||
            Number(d.range) > 100
        );
    }
    terrainAttackContext(sourceType, sourceEntityId, target, isBuilding = false) {
        const source = sourceEntityId
            ? this.unitById.get(sourceEntityId) ||
              this.buildingById.get(sourceEntityId) ||
              this.units.find((u) => u.id === sourceEntityId && u.alive) ||
              this.buildings.find((b) => b.id === sourceEntityId && b.alive !== false)
            : null;
        if (!source || !target) return null;
        const sourceDef =
            UnitDefinition.get(source.type) ||
            BuildingDefinition.get(source.type) ||
            UnitDefinition.get(sourceType) ||
            BuildingDefinition.get(sourceType) ||
            {};
        return {
            source,
            sourceLevel: this.terrainLevelAt(source.x, source.y),
            targetLevel: this.terrainLevelAt(target.x, target.y),
        };
    }
    markTerrainAttackReveal(sourceType, sourceEntityId, target, isBuilding = false) {
        const ctx = this.terrainAttackContext(sourceType, sourceEntityId, target, isBuilding);
        if (!ctx || ctx.sourceLevel <= ctx.targetLevel) return false;
        const side = target.side;
        if (side !== 0 && side !== 1) return false;
        const until = this.tick + this.msTicks(TERRAIN_ATTACK_REVEAL_MS);
        if (ctx.source instanceof Unit)
            ctx.source.status[side === 0 ? 'terrainRevealUntil0' : 'terrainRevealUntil1'] =
                Math.max(
                    Number(
                        ctx.source.status[
                            side === 0 ? 'terrainRevealUntil0' : 'terrainRevealUntil1'
                        ],
                    ) || 0,
                    until,
                );
        else
            ctx.source[side === 0 ? 'terrainRevealUntil0' : 'terrainRevealUntil1'] = Math.max(
                Number(ctx.source[side === 0 ? 'terrainRevealUntil0' : 'terrainRevealUntil1']) || 0,
                until,
            );
        this.events.push({
            type: 'terrainAttackReveal',
            side,
            x: ctx.source.x,
            y: ctx.source.y,
            sourceId: ctx.source.id,
            sourceType: ctx.source.type,
            untilTick: until,
        });
        return true;
    }
    terrainUphillMiss(sourceType, sourceEntityId, target, isBuilding = false, key = '') {
        if (!this.terrainRangedSource(sourceType)) return false;
        const ctx = this.terrainAttackContext(sourceType, sourceEntityId, target, isBuilding);
        if (!ctx || ctx.sourceLevel >= ctx.targetLevel) return false;
        const v = HashUtil.hash(
            `${key || this.tick}|${ctx.source.id}|${target.id}|${ctx.sourceLevel}>${ctx.targetLevel}|uphill`,
        );
        return (v & 1) === 0;
    }

    releaseCaptureForOutpost(outpostId) {
        const cp = this.capturePoints.find((p) => p.outpostId === outpostId);
        if (!cp) return;
        cp.owner = null;
        cp.outpostId = null;
        cp.enabled = true;
        this.events.push({ type: 'captureLost', captureId: cp.id, x: cp.x, y: cp.y });
    }

    spawnOutpost(cp, side) {
        const d = BuildingDefinition.get(BuildingDefinition.forRole('outpost'));
        const id = 'outpost-' + cp.id + '-' + ++this.seq;
        const construction = ConstructionRules.create(d.construction, this.tick);
        const outpost = new Building({
            id,
            type: BuildingDefinition.forRole('outpost'),
            side,
            x: cp.x,
            y: cp.y,
            hp: ConstructionRules.healthAt(construction, d.hp),
            maxHp: d.hp,
            captureId: cp.id,
            construction,
        });
        this.buildings.push(outpost);
        this.buildingById.set(id, outpost);
        this.markBuildingSpatialDirty();
        cp.owner = null;
        cp.outpostId = id;
        cp.enabled = false;
        this.events.push({
            type: 'captureStarted',
            side,
            captureId: cp.id,
            x: cp.x,
            y: cp.y,
            outpostId: id,
        });
        return outpost;
    }

    completeConstruction(building) {
        building.construction = null;
        const cp = this.capturePoints.find((p) => p.outpostId === building.id);
        if (!cp) return;
        cp.owner = building.side;
        this.events.push({
            type: 'captureComplete',
            side: building.side,
            captureId: cp.id,
            lane: cp.lane,
            label: cp.label,
            x: cp.x,
            y: cp.y,
            outpostId: building.id,
        });
    }

    assignConstructionWorkers() {
        // Query the existing index around each unfinished structure, rather than
        // searching every capture point from every unit. Keep valid assignments.
        for (const b of this.buildings) {
            if (b.alive === false || !b.construction) continue;
            for (const idx of this.nearbyUnits(b.x, b.y, CAPTURE_RADIUS, b.side)) {
                const u = this.units[idx];
                if (
                    !u?.alive ||
                    !UnitDefinition.get(u.type)?.construction ||
                    Math.hypot(u.x - b.x, u.y - b.y) > CAPTURE_RADIUS
                )
                    continue;
                const current =
                    u.constructionWork && this.buildingById.get(u.constructionWork.targetId);
                if (current?.alive !== false && current?.construction && current.side === u.side)
                    continue;
                u.constructionWork = {
                    targetId: b.id,
                    phase: 'approach',
                    phaseStartedAtTick: this.tick,
                    phaseEndsAtTick: null,
                    cycleStartedAtTick: null,
                    nextHitTick: this.tick + this.msTicks(ConstructionRules.cooldownMs),
                    lastHitTick: null,
                };
            }
        }
    }
    constructionSite(u) {
        const work = u.constructionWork;
        if (!work) return null;
        const site = this.buildingById.get(work.targetId);
        if (
            !site ||
            site.alive === false ||
            (!site.construction && work.phase !== 'recover') ||
            site.side !== u.side ||
            Math.hypot(u.x - site.x, u.y - site.y) > CAPTURE_RADIUS
        )
            return null;
        return site;
    }
    constructionWorkerAvailable(u) {
        const m = u.impactMotion;
        return (
            !!u.alive &&
            (!m || (m.heightFP === 0 && m.vzFP <= 0 && this.tick >= m.recoverUntilTick))
        );
    }
    constructionContact(u, b, range) {
        return (
            this.constructionWorkerAvailable(u) &&
            this.terrainLevelAt(u.x, u.y) === this.terrainLevelAt(b.x, b.y) &&
            Math.hypot(u.x - b.x, u.y - b.y) <=
                this.interactionDistance(u, b, 'construction', range)
        );
    }
    setConstructionPhase(work, phase, start = this.tick, end = null) {
        work.phase = phase;
        work.phaseStartedAtTick = start;
        work.phaseEndsAtTick = end;
    }
    resetConstructionCycle(work, phase, nextHitTick = null) {
        work.cycleStartedAtTick = null;
        work.nextHitTick = nextHitTick;
        this.setConstructionPhase(work, phase);
    }
    beginConstructionRecovery(u, b, work) {
        const dx = u.x - b.x,
            dy = u.y - b.y,
            length = Math.hypot(dx, dy) || 1;
        work.retreatX = u.x + (dx / length) * ConstructionRules.retreatDistance;
        work.retreatY = u.y + (dy / length) * ConstructionRules.retreatDistance;
        this.setConstructionPhase(
            work,
            'recover',
            this.tick,
            this.tick +
                Math.max(
                    1,
                    Math.round(
                        this.msTicks(ConstructionRules.cooldownMs) *
                            ConstructionRules.phaseRatios.recoverEnd,
                    ),
                ),
        );
    }
    updateConstructionWork(u, d, speed) {
        const work = u.constructionWork,
            b = this.constructionSite(u),
            ability = d.construction;
        if (!work) return false;
        if (!ability || !b) {
            u.constructionWork = null;
            return false;
        }
        if (!this.constructionWorkerAvailable(u)) {
            if (work.phase !== 'defend')
                this.resetConstructionCycle(work, 'approach', work.nextHitTick);
            return true;
        }
        const cycle = this.msTicks(ConstructionRules.cooldownMs),
            recoverTicks = Math.max(
                1,
                Math.round(cycle * ConstructionRules.phaseRatios.recoverEnd),
            );
        const prepareTicks = Math.max(
            1,
            Math.round(
                cycle *
                    (ConstructionRules.phaseRatios.strikeStart -
                        ConstructionRules.phaseRatios.recoverEnd),
            ),
        );
        const clearance = this.buildingClearanceDistance(u, b),
            dx = u.x - b.x,
            dy = u.y - b.y,
            distance = Math.hypot(dx, dy),
            nx = distance > 0 ? dx / distance : 1,
            ny = distance > 0 ? dy / distance : 0;
        if (work.phase === 'recover') {
            if (this.tick < work.phaseEndsAtTick) {
                this.moveToward(u, work.retreatX, work.retreatY, speed);
                return true;
            }
            this.setConstructionPhase(work, 'approach');
        }
        if (!b.construction) {
            u.constructionWork = null;
            return false;
        }
        if (
            ConstructionRules.project(b.construction, ability.workPerHit, this.wallet[u.side])
                .workAdded === 0
        ) {
            this.resetConstructionCycle(work, 'waiting');
            return true;
        }
        if (work.phase === 'waiting') {
            work.nextHitTick = this.tick + cycle;
            this.setConstructionPhase(work, 'approach');
        }
        if (work.phase === 'defend') this.setConstructionPhase(work, 'approach');
        if (work.phase === 'approach') {
            const readyDistance = clearance + ConstructionRules.retreatDistance;
            if (distance < readyDistance - 1) {
                this.moveToward(u, b.x + nx * readyDistance, b.y + ny * readyDistance, speed);
                return true;
            }
            if (
                distance > readyDistance + 1 ||
                this.terrainLevelAt(u.x, u.y) !== this.terrainLevelAt(b.x, b.y)
            ) {
                this.moveToGoal(u, NavigationGoal.range(b.x, b.y, readyDistance, 0, true), speed);
                return true;
            }
            work.cycleStartedAtTick = this.tick;
            const chargeTicks = Math.max(
                1,
                Math.ceil(
                    (Math.max(0, distance - clearance - ConstructionRules.contactTolerance) *
                        this.tps) /
                        Math.max(0.01, speed * ConstructionRules.chargeSpeedMultiplier),
                ),
            );
            this.setConstructionPhase(
                work,
                'prepare',
                this.tick,
                Math.max(this.tick + prepareTicks, (work.nextHitTick ?? 0) - chargeTicks + 1),
            );
        }
        if (work.phase === 'prepare' && this.tick >= work.phaseEndsAtTick) {
            this.setConstructionPhase(
                work,
                'strike',
                this.tick,
                this.tick + this.msTicks(ConstructionRules.chargeTimeoutMs),
            );
        }
        if (work.phase === 'strike') {
            if (this.tick >= work.phaseEndsAtTick) {
                this.resetConstructionCycle(work, 'approach');
                return true;
            }
            // Retain the pre-movement position; the resolver compares it with the
            // collision-corrected position, not merely the intended target or timer.
            work.strikeFromFx = u.fx;
            work.strikeFromFy = u.fy;
            work.strikeAttemptTick = this.tick;
            this.moveToGoal(
                u,
                InteractionGeometry.goal(u, b, 'construction', 0),
                speed * ConstructionRules.chargeSpeedMultiplier,
            );
        }
        return true;
    }
    resolveConstructionHits() {
        // Insertion order preserves first-started/map order. Within a structure,
        // unit ID breaks simultaneous-hit ties; a completed project cannot overpay.
        for (const b of this.buildings) {
            if (b.alive === false || !b.construction) continue;
            const candidates = this.nearbyUnits(b.x, b.y, CAPTURE_RADIUS, b.side).slice();
            candidates.sort((a, c) =>
                String(this.units[a].id) < String(this.units[c].id)
                    ? -1
                    : String(this.units[a].id) > String(this.units[c].id)
                      ? 1
                      : 0,
            );
            for (const idx of candidates) {
                if (!b.construction) break;
                const u = this.units[idx],
                    work = u.constructionWork,
                    ability = UnitDefinition.get(u.type)?.construction;
                if (
                    !work ||
                    work.targetId !== b.id ||
                    work.phase !== 'strike' ||
                    work.strikeAttemptTick !== this.tick
                )
                    continue;
                if (!ability || !this.constructionContact(u, b, ability.range)) continue;
                const beforeDistance = Math.hypot(
                        work.strikeFromFx / FP - b.x,
                        work.strikeFromFy / FP - b.y,
                    ),
                    afterDistance = Math.hypot(u.x - b.x, u.y - b.y);
                if (
                    afterDistance >
                        this.buildingClearanceDistance(u, b) + ConstructionRules.contactTolerance ||
                    beforeDistance - afterDistance < 1 / FP
                )
                    continue;
                // Crowding or a speed change may bring the worker to contact
                // before its cooldown. Recoil without credit and retry later;
                // remaining pressed against the boundary cannot become a hit.
                if (work.nextHitTick !== null && this.tick < work.nextHitTick) {
                    this.beginConstructionRecovery(u, b, work);
                    continue;
                }
                const progress = b.construction,
                    applied = ConstructionRules.project(
                        progress,
                        ability.workPerHit,
                        this.wallet[u.side],
                    );
                if (applied.workAdded === 0) {
                    this.resetConstructionCycle(work, 'waiting');
                    continue;
                }
                const beforeHp = ConstructionRules.healthAt(progress, b.maxHp);
                progress.workDone = applied.workDone;
                progress.invested = applied.invested;
                this.wallet[u.side] -= applied.spend;
                b.hp += ConstructionRules.healthAt(progress, b.maxHp) - beforeHp;
                work.lastHitTick = this.tick;
                work.cycleStartedAtTick = this.tick;
                work.nextHitTick = this.tick + this.msTicks(ConstructionRules.cooldownMs);
                this.beginConstructionRecovery(u, b, work);
                const dx = u.x - b.x,
                    dy = u.y - b.y,
                    distance = Math.hypot(dx, dy) || 1,
                    radius = BuildingDefinition.get(b.type).size;
                this.events.push({
                    type: 'constructionHit',
                    side: u.side,
                    sourceId: u.id,
                    sourceType: u.type,
                    targetId: b.id,
                    x: b.x,
                    y: b.y,
                    contactX: b.x + (dx / distance) * radius,
                    contactY: b.y + (dy / distance) * radius,
                    workAdded: applied.workAdded,
                    spend: applied.spend,
                    workDone: progress.workDone,
                    invested: progress.invested,
                });
                if (applied.complete) this.completeConstruction(b);
            }
        }
    }

    updateCapturePoints() {
        for (const cp of this.capturePoints) {
            if (cp.owner != null || !cp.enabled) continue;
            let hostPresence = 0,
                guestPresence = 0;
            for (const idx of this.nearbyUnits(cp.x, cp.y, CAPTURE_RADIUS)) {
                const u = this.units[idx];
                if (
                    !u?.alive ||
                    (u.side !== 0 && u.side !== 1) ||
                    !!UnitDefinition.get(u.type)?.captureExcluded
                )
                    continue;
                if (Math.hypot(u.x - cp.x, u.y - cp.y) > CAPTURE_RADIUS) continue;
                if (!this.world.terrain.field.polygonSegmentClear(u.x, u.y, cp.x, cp.y, 0))
                    continue;
                if (u.side === 0) hostPresence++;
                else guestPresence++;
            }
            if (hostPresence > 0 && guestPresence === 0) this.spawnOutpost(cp, 0);
            else if (guestPresence > 0 && hostPresence === 0) this.spawnOutpost(cp, 1);
        }
        this.assignConstructionWorkers();
    }

    createBase(side) {
        const bp =
            side === 0
                ? this.mapDescriptor?.spawns?.host || this.world.bases[0]
                : this.mapDescriptor?.spawns?.guest || this.world.bases[1];
        const type = BuildingDefinition.forRole('mainBase'),
            hp = BuildingDefinition.get(type).hp;
        this.buildings.push(
            new Building({ id: 'base' + side, type, side, x: bp.x, y: bp.y, hp, maxHp: hp }),
        );
        this.markBuildingSpatialDirty();
    }

    spawnUnit(side, type, x, y) {
        const d = UnitDefinition.get(type);
        if (this.world.terrain.active) {
            const q = this.world.terrain.field.nearestOpen(x, y, this.unitRadius(type) + 1, 256);
            if (!q) throw new Error(`생성 위치에 지상 공간이 없습니다: ${type} (${x},${y})`);
            x = q.x;
            y = q.y;
        }
        const u = new Unit({
            id: 'u' + ++this.seq,
            type,
            side,
            fx: Math.round(x * FP),
            fy: Math.round(y * FP),
            x,
            y,
            hp: d.hp,
            maxHp: d.hp,
            alive: true,
        });
        this.units.push(u);
        this.ensureCollisionBuffers(this.units.length);
        const birth = this.units.length - 1;
        this.collisionStartFx[birth] = u.fx;
        this.collisionStartFy[birth] = u.fy;
        this.collisionStartCount = this.units.length;
        this.addRuntimeUnit(u);
        this.navigation.motion.remember(u, false);
        return u;
    }
    unitRadius(type) {
        return InteractionGeometry.unitRadius(type);
    }

    // Common geometry/interaction contract.
    // buildingClearanceDistance is the closest center distance allowed by
    // movement + static-building PBD. interactionDistance is gameplay reach.
    // Building interactions must stay reachable outside that physical envelope.
    buildingClearanceDistance(unitOrType, buildingOrType) {
        return InteractionGeometry.buildingClearance(unitOrType, buildingOrType);
    }

    isAlliedCollisionUnit(a, b) {
        return !!a && !!b && (a.side === 0 || a.side === 1) && a.side === b.side;
    }

    interactionDistance(source, target, kind, extra = 0) {
        if (
            source &&
            target &&
            Number.isFinite(source.x) &&
            Number.isFinite(target.x) &&
            InteractionGeometry.requiresTerrainLine(source, kind, extra) &&
            !this.world.terrain.field.polygonSegmentClear(source.x, source.y, target.x, target.y, 0)
        )
            return -1;
        return InteractionGeometry.reach(source, target, kind, extra);
    }

    attackWindupTicksFor(d) {
        const ms = Number.isFinite(Number(d?.attackWindupMs))
            ? Math.max(0, Math.round(Number(d.attackWindupMs)))
            : DEFAULT_ATTACK_WINDUP_MS;
        return SimulationTiming.msToTicks(ms, this.tps);
    }
    attackMoveRecoveryDurationTicks(u, d) {
        const ms = Number.isFinite(Number(d?.attackMoveRecoveryMs))
            ? Math.max(0, Math.round(Number(d.attackMoveRecoveryMs)))
            : d?.projectile
              ? DEFAULT_RANGED_MOVE_RECOVERY_MS
              : DEFAULT_MELEE_MOVE_RECOVERY_MS;
        return SimulationTiming.msToTicks(ms, this.tps, { min: 0 });
    }

    tickAttackTimers(u) {
        u.combat.lastTimerTick = this.tick;
        if (u.hitFlash > 0) u.hitFlash--;
        if (u.attackFlash > 0) u.attackFlash--;
    }
    startAttackWindup(u, target, targetKind, d) {
        if (!u || !target) return false;
        u.combat.attackWindupStartedAt = this.tick;
        u.combat.attackWindupUntil = this.tick + this.attackWindupTicksFor(d);
        u.combat.attackWindupTargetId = target.id;
        u.combat.attackWindupTargetKind = targetKind;
        u.target = target.id;
        return true;
    }
    attackWindupTarget(u) {
        if (!u?.combat.attackWindupTargetId) return null;
        const ref = this.liveEntityRefById(
            u.combat.attackWindupTargetId,
            u.combat.attackWindupTargetKind,
        );
        return ref?.entity || null;
    }

    tickAttackWindup(u) {
        if (!u || !u.combat.attackWindupUntil) return false;
        return this.tick >= u.combat.attackWindupUntil;
    }
    attackReadyAfterWindup(u, target, targetKind, d) {
        if ((u.combat.attackWindupUntil || 0) > 0) {
            if (!this.tickAttackWindup(u)) return false;
            u.combat.cancelWindup();
            u.target = target.id;
            return true;
        }
        if (u.combat.cooldownActive(this)) return false;
        this.startAttackWindup(u, target, targetKind, d);
        return false;
    }
    attackCooldownJitterMs(entity) {
        // Preserve the former 20TPS ±1-tick flavor as deterministic ±50ms,
        // independent of the selected simulation TPS.
        const id = String(entity?.id || entity?.type || 'attack');
        const slot = HashUtil.hash(`${id}|attack-cooldown|${this.tick}`) & 3;
        return slot === 0 ? -50 : slot === 1 ? 0 : 50;
    }

    attackCooldown(u, d) {
        const cooldown = d.cooldown ?? d.attackIntervalMs / 1000;
        const attackSpeedPct = this.timedModifierPct(u, 'attackSpeedPct');
        return attackSpeedPct > 100 ? (cooldown * 100) / attackSpeedPct : cooldown;
    }

    commitAttackTiming(u, d, cooldown = d.cooldown) {
        const cooldownMs = Number.isFinite(Number(d?.cooldownMs))
            ? Math.max(1, Math.round(Number(d.cooldownMs)))
            : Math.max(1, Math.round(Number(cooldown || 0) * 1000));
        const effectiveMs =
            d.attackIntervalMs ?? Math.max(1, cooldownMs + this.attackCooldownJitterMs(u));
        const scheduled = SimulationTiming.timerTicksWithPhase(
            effectiveMs,
            this.tps,
            u.combat.attackCooldownPhase || 0,
            { min: 1 },
        );
        u.combat.attackCooldownPhase = scheduled.phase;
        const windupTicks = d.attackIntervalMs == null ? 0 : this.attackWindupTicksFor(d);
        u.combat.cooldownUntil = this.tick + Math.max(1, scheduled.ticks - windupTicks);
        u.combat.moveRecoveryUntil = this.tick + this.attackMoveRecoveryDurationTicks(u, d);
        if (d.heroActive || d.fruitAttack) u.combat.basicAttackTick = this.tick;
        u.attackFlash = 1;
    }

    pointClearForUnit(type, x, y, ignoreBuildingId = null, reserved = []) {
        const ur = this.unitRadius(type);

        if (
            x < ur + 8 ||
            x > this.world.width - ur - 8 ||
            y < ur + 8 ||
            y > this.world.height - ur - 8
        )
            return false;

        if (!this.world.terrain.field.polygonCircleClear(x, y, ur + 1)) return false;
        for (const b of this.buildings) {
            if (b.alive === false || b.id === ignoreBuildingId) continue;
            const br = BuildingDefinition.get(b.type)?.size || 35;
            const clearance = Math.max(
                this.buildingClearanceDistance(type, b),
                ur + br + SPAWN_UNIT_GAP,
            );
            if (Math.hypot(x - b.x, y - b.y) < clearance) return false;
        }

        const nearby =
            this.runtimeIndexTick === this.tick
                ? this.nearbyUnits(x, y, ur + this.maxUnitRadius + SPAWN_UNIT_GAP)
                : null;
        if (nearby) {
            for (const idx of nearby) {
                const u = this.units[idx];
                if (!u?.alive) continue;
                const other = this.unitRadius(u.type);
                if (Math.hypot(x - u.x, y - u.y) < ur + other + SPAWN_UNIT_GAP) return false;
            }
        } else {
            for (const u of this.units) {
                if (!u.alive) continue;
                const other = this.unitRadius(u.type);
                if (Math.hypot(x - u.x, y - u.y) < ur + other + SPAWN_UNIT_GAP) return false;
            }
        }

        for (const p of reserved || []) {
            const other = this.unitRadius(p.type || type);
            if (Math.hypot(x - p.x, y - p.y) < ur + other + SPAWN_UNIT_GAP) return false;
        }

        return true;
    }

    findOpenSpawnAround(
        anchor,
        type,
        {
            baseRadius = null,
            maxRadius = null,
            angleSlots = 12,
            radialStep = 8,
            seedKey = 'spawn',
            reserved = [],
            maxElevation = Infinity,
            canReach = null,
        } = {},
    ) {
        if (!anchor) return null;
        const ur = this.unitRadius(type),
            ar = anchor.type ? this.unitRadius(anchor.type) : 0;
        const start = Math.max(ur + ar + SPAWN_UNIT_GAP, Number(baseRadius) || 0);
        const limit = Math.max(start, Number(maxRadius) || start + 48),
            slots = Math.max(8, Math.round(Number(angleSlots) || 12)),
            step = Math.max(4, Number(radialStep) || 8);
        const phase = (HashUtil.hash(String(seedKey)) % 6283) / 1000;
        for (let rr = start; rr <= limit + 0.001; rr += step) {
            for (let k = 0; k < slots; k++) {
                const a = phase + (k * Math.PI * 2) / slots,
                    x = RangeUtil.clamp(
                        anchor.x + Math.cos(a) * rr,
                        ur + 8,
                        this.world.width - ur - 8,
                    ),
                    y = RangeUtil.clamp(
                        anchor.y + Math.sin(a) * rr,
                        ur + 8,
                        this.world.height - ur - 8,
                    );
                if (
                    (maxElevation === Infinity ||
                        this.world.terrain.surfaces.heightAt(x, y) <= maxElevation) &&
                    this.pointClearForUnit(type, x, y, null, reserved) &&
                    (!canReach || canReach(x, y))
                )
                    return { x, y };
            }
        }
        return null;
    }

    queueCommand(cmd) {
        let arr = this.scheduled.get(cmd.tick);
        if (!arr) {
            arr = [];
            this.scheduled.set(cmd.tick, arr);
        }
        arr.push(cmd);
        arr.sort((a, b) => a.seq - b.seq);
    }
    launchCannons(side) {
        return LaunchRules.launchCannons(this, side);
    }
    applyLaunchCommand(side, action) {
        const cannons = this.launchCannons(side),
            cannon = cannons.find((b) => b.id === action.cannonId);
        const reject = (reason) => {
            this.events.push({ type: 'launchRejected', side, reason });
            return false;
        };
        if (!cannon) return reject('cannon-unavailable');
        if (this.tick < (Number(cannon.launchReadyTick) || 0)) return reject('reloading');
        const grain = LaunchRules.grain(action.unitType);
        if (!grain) return reject('invalid-unit');
        if (!this.decks[side]?.includes(action.unitType)) return reject('unit-not-in-deck');
        const heroRejection = HeroDeployment.launchRejection(this.heroes[side][action.unitType]);
        if (heroRejection) return reject(heroRejection);
        if (LaunchRules.population(this, side).total >= LaunchRules.populationLimit)
            return reject('population-limit');
        if (this.wallet[side] < grain.cost) return reject('insufficient-basic-resources');
        if (this.premiumWallet[side] < (grain.premiumCost || 0))
            return reject('insufficient-premium-resources');
        const holdMs = Math.max(0, Math.round(action.holdMs));
        if (LaunchRules.overheated(holdMs)) {
            cannon.launchReadyTick = this.tick + this.msTicks(LaunchRules.overheatMs);
            this.events.push({
                type: 'launchOverheat',
                side,
                cannonId: cannon.id,
                x: cannon.x,
                y: cannon.y,
            });
            return true;
        }
        const level = this.launchRangeLevel[side];
        const aim = LaunchRules.target(
            cannon,
            action.x,
            action.y,
            holdMs,
            this.world,
            this.flags[side],
            action.unitType,
            level,
        );
        const volley = LaunchRules.sharedVolley(
            action.unitType,
            aim,
            cannon,
            this.world,
            cannons,
            this.tick,
            level,
        );
        this.wallet[side] -= grain.cost;
        this.premiumWallet[side] -= grain.premiumCost || 0;
        // The cannon is busy until the last shell of the volley has left, plus the reload.
        const readyTick =
            this.tick + this.msTicks(LaunchRules.volleyMs(action.unitType) + LaunchRules.reloadMs);
        const power = LaunchRules.power(holdMs),
            mode = grain.fire.mode,
            eventsBeforeVolley = this.events.length;
        for (const { cannon: launcher, shots } of volley) {
            launcher.launchReadyTick = readyTick;
            const arcDistance =
                mode === 'split'
                    ? Math.max(
                          1,
                          Math.hypot(aim.x - launcher.x, aim.y - launcher.y) -
                              LaunchImpactRules.muzzleReach,
                      )
                    : null;
            shots.forEach((shot, i) => {
                const fire = {
                    side,
                    cannonId: launcher.id,
                    type: action.unitType,
                    mode,
                    shot: i,
                    shots: shots.length,
                    power,
                    holdMs,
                    arcDistance,
                    ...shot,
                };
                if (shot.delayMs > 0)
                    launcher.salvo.push({ tick: this.tick + this.msTicks(shot.delayMs), ...fire });
                else this.fireLaunchShell(fire);
            });
        }
        if (this.campaignVolleyPractice && side === 0 && action.unitType === 'rice') {
            const index = this.rules.campaign.volleyGoals.findIndex(
                (goal) =>
                    volley.length === goal.cannons && CampaignMission.volleyGoalContains(goal, aim),
            );
            const progress = this.campaignVolleyPractice.goals[index];
            if (progress && !progress.landed) {
                for (let i = eventsBeforeVolley; i < this.events.length; i++) {
                    const event = this.events[i];
                    if (event.type === 'launchFire')
                        progress.projectileIds.push(event.projectileId);
                }
            }
        }
        this.launchStats.launches[side]++;
        this.launchStats.sent[side] += LaunchRules.volleyPassengerCount(volley);
        return true;
    }
    updateVolleyPractice() {
        const practice = this.campaignVolleyPractice;
        if (!practice || practice.complete) return;
        for (const [index, progress] of practice.goals.entries()) {
            if (!progress.projectileIds.length) continue;
            const goal = this.rules.campaign.volleyGoals[index];
            progress.landed ||= this.events.some(
                (event) =>
                    event.type === 'launchImpact' &&
                    progress.projectileIds.includes(event.projectileId) &&
                    CampaignMission.volleyGoalContains(goal, event),
            );
            const pending = new Set(this.projectiles.map((shell) => shell.id));
            for (const group of this.launchDeployments) pending.add(group.projectileId);
            progress.projectileIds = progress.projectileIds.filter((id) => pending.has(id));
        }
        practice.complete = practice.goals.every(
            (progress) =>
                progress.landed &&
                !progress.projectileIds.length &&
                progress.garrisonIds.every((id) => !this.unitById.get(id)?.alive),
        );
    }
    fireLaunchShell({
        side,
        cannonId,
        type,
        mode,
        shot,
        shots,
        power,
        holdMs,
        arcDistance,
        x,
        y,
        count,
        impact,
        splash,
    }) {
        const cannon =
                this.buildingById.get(cannonId) || this.buildings.find((b) => b.id === cannonId),
            speed = LaunchRules.shellSpeed(type),
            id = 'p' + ++this.seq;
        const dx = x - cannon.x,
            dy = y - cannon.y,
            length = Math.hypot(dx, dy) || 1;
        this.spawnProjectile({
            id,
            owner: cannonId,
            side,
            type,
            x: cannon.x + (dx / length) * LaunchImpactRules.muzzleReach,
            y: cannon.y + (dy / length) * LaunchImpactRules.muzzleReach,
            target: null,
            isBuilding: false,
            trajectoryPolicy: 'lockedPoint',
            lockedAimX: x,
            lockedAimY: y,
            // Split shells cover unequal distances in the same time on clear ground.
            speed:
                arcDistance != null
                    ? (speed * Math.max(1, length - LaunchImpactRules.muzzleReach)) / arcDistance
                    : speed,
            arcDistance,
            damage: impact,
            splash,
            splashUnitDamage: impact * LaunchRules.unitImpactScale,
            splashBuildingDamage: impact,
            damageClass: 'normal',
            sourceDamageResolved: true,
            payload: { type, count },
        });
        if (LaunchRules.isHeroType(type)) HeroDeployment.begin(this, side, type, id);
        this.events.push({
            type: 'launchFire',
            side,
            cannonId,
            projectileId: id,
            x: cannon.x,
            y: cannon.y,
            aimX: x,
            aimY: y,
            holdMs,
            power,
            mode,
            shot,
            shots,
        });
    }
    // Delayed shells of a burst leave on their scheduled tick, in order.
    updateLaunchSalvos() {
        for (const cannon of this.buildings) {
            if (!cannon.salvo.length) continue;
            if (cannon.alive === false) {
                cannon.salvo.length = 0;
                continue;
            }
            while (cannon.salvo.length && cannon.salvo[0].tick <= this.tick)
                this.fireLaunchShell(cannon.salvo.shift());
        }
    }
    creditResources(side, amount, resourceType = 'basic') {
        if ((side !== 0 && side !== 1) || !Number.isSafeInteger(amount) || amount < 0)
            throw new RangeError('유효한 진영과 정수 자원이 필요합니다.');
        const wallet = resourceType === 'premium' ? this.premiumWallet : this.wallet;
        const cap =
            resourceType === 'premium' ? LaunchRules.premiumWalletCap : LaunchRules.walletCap;
        wallet[side] = Math.min(cap, wallet[side] + amount);
    }
    updateLaunchEconomy() {
        for (const point of [...this.baseProducers, ...this.capturePoints]) {
            if (point.owner !== 0 && point.owner !== 1) continue;
            if (
                this.baseProducers.includes(point) &&
                !this.buildings.some((b) => b.id === `base${point.owner}` && b.alive !== false)
            )
                continue;
            const efficiency = LaunchRules.productionEfficiency(point);
            for (const resource in point.production) {
                const channel = point.production[resource];
                const wallet = resource === 'premium' ? this.premiumWallet : this.wallet;
                const cap =
                    resource === 'premium' ? LaunchRules.premiumWalletCap : LaunchRules.walletCap;
                if (wallet[point.owner] >= cap) continue;
                // Carry fractional production in hundredths so wallet credits stay whole.
                const wholeUnit = this.tps * 100;
                channel.miningCarry += LaunchRules.productionRateHundredths(channel, efficiency);
                const gained = Math.min(
                    Math.floor(channel.miningCarry / wholeUnit),
                    cap - wallet[point.owner],
                );
                channel.miningCarry %= wholeUnit;
                wallet[point.owner] += gained;
                point.extractedResources += gained;
            }
        }
    }
    upgradeLaunchRange(side) {
        if (side === 0 && this.campaignVolleyPractice) return false;
        const level = this.launchRangeLevel[side],
            cost = LaunchRules.upgradeCost(level),
            premiumCost = LaunchRules.upgradePremiumCost(level);
        if (cost === null || this.wallet[side] < cost || this.premiumWallet[side] < premiumCost)
            return false;
        this.wallet[side] -= cost;
        this.premiumWallet[side] -= premiumCost;
        this.launchRangeLevel[side]++;
        this.events.push({ type: 'launchRangeUpgraded', side, level: this.launchRangeLevel[side] });
        return true;
    }
    applyCommand(actor, action) {
        if (!['host', 'guest'].includes(actor)) return false;
        if (action?.type === 'MATCH_SURRENDER') {
            if (this.netcodeMatchResult) return false;
            this.netcodeMatchResult = {
                winner: actor === 'host' ? 'guest' : 'host',
                reason: 'surrender',
                tick: this.tick,
            };
            return true;
        }
        const side = ConnectionSideUtil.roleSide(actor);
        if (action.type === 'TOGGLE_HERO')
            return HeroDeployment.toggle(this, side, action.sortieId);
        if (action.type === 'ACTIVATE_HERO_SKILL') {
            const hero = HeroDeployment.findSortie(this, side, action.sortieId);
            const unit = hero?.unitId && this.liveEntityRefById(hero.unitId, 'unit')?.entity;
            if (!unit)
                return HeroRollAttack.reject(this, side, action.sortieId, 'hero-not-deployed');
            return unit.fruitAttack
                ? FruitHeroAttack.activate(this, unit, action.sortieId)
                : HeroRollAttack.activate(this, unit, action.sortieId);
        }
        if (action.type === 'LAUNCH') return this.applyLaunchCommand(side, action);
        if (action.type === 'UPGRADE_LAUNCH_RANGE') return this.upgradeLaunchRange(side);
        return false;
    }
    moveToward(u, tx, ty, speed, options = undefined) {
        return this.moveToGoal(u, NavigationGoal.point(tx, ty), speed, options);
    }
    moveToGoal(u, goal, speed, options = null) {
        let tx = goal.x,
            ty = goal.y;
        // Post-attack recovery is movement-only: attacks/cooldowns/wind-ups continue
        // normally while voluntary locomotion is temporarily locked.
        if (
            (u.impactMotion && this.tick < u.impactMotion.recoverUntilTick) ||
            (!options?.allowContactRecovery && u.combat.moveRecoveryActive(this))
        )
            return false;

        const waypoint = this.navigation.nextPoint(u, goal, options?.fixedGoal);
        if (!waypoint || Math.hypot(waypoint.x - u.x, waypoint.y - u.y) < 0.001) return false;
        tx = waypoint.x;
        ty = waypoint.y;
        const dx = tx - u.x,
            dy = ty - u.y;
        const dist = Math.hypot(dx, dy) || 1;
        const rawStep = Math.min(speed / this.tps, dist);
        speed *= this.terrainMovementMultiplier(
            u.x,
            u.y,
            u.x + (dx / dist) * rawStep,
            u.y + (dy / dist) * rawStep,
        );
        const step = Math.min(speed / this.tps, dist);
        const vx = (dx / dist) * step,
            vy = (dy / dist) * step;

        u.collisionIntentTick = this.tick;
        u.collisionIntentTx = tx;
        u.collisionIntentTy = ty;

        if (Math.abs(vx) + Math.abs(vy) > 0.0001 && u.collisionMoveTick !== this.tick) {
            u.collisionMoveTick = this.tick;
            u.collisionMoveStartFx = u.fx;
            u.collisionMoveStartFy = u.fy;
        }
        const oldX = u.fx,
            oldY = u.fy;
        this.navigation.motion.move(u, u.x + vx, u.y + vy, 'steer');
        const moved = u.fx !== oldX || u.fy !== oldY;
        if (moved) {
            u.movement.lastMoveTick = this.tick;
            if (u.status.timedModifiers)
                for (const [key, mod] of Object.entries(u.status.timedModifiers))
                    if (mod?.resetOnMove) delete u.status.timedModifiers[key];
        }
        return moved;
    }
    visionSources(side) {
        return VisibilityPolicy.field(this, side, this);
    }
    isVisible(side, x, y, field) {
        if (this._perfCollect) this._perfCollect.visibilityChecks++;
        return field.visibleAt(x, y, this.terrainLevelAt(x, y));
    }
    canTargetUnit(attackerSide, target) {
        return !!target && target.alive !== false && target.side !== attackerSide;
    }
    targetLevel(target) {
        const memo = this.targetLevelMemo.get(target);
        if (memo && memo.tick === this.tick && memo.x === target.x && memo.y === target.y)
            return memo.level;
        const level = this.world.terrain.surfaces.levelAt(target.x, target.y);
        this.targetLevelMemo.set(target, { tick: this.tick, x: target.x, y: target.y, level });
        return level;
    }
    canSeeCombatTarget(attackerSide, target, sources) {
        if (!target || target.alive === false || target.side === attackerSide) return false;
        if (this._perfCollect) this._perfCollect.visibilityChecks++;
        return sources.visibleAt(target.x, target.y, this.targetLevel(target));
    }
    targetPriorityFactor(attacker, targetDef) {
        const p = UnitDefinition.get(attacker.type)?.priority || {};
        return Math.max(
            100,
            Number(p[targetDef.role]) || 100,
            Number(p[targetDef.sizeClass]) || 100,
        );
    }
    targetChoiceBetter(score, id, bestScore, best) {
        if (score < bestScore) return true;
        if (score > bestScore) return false;
        return !best || String(id) < String(best.entity?.id ?? best.id ?? '');
    }
    basicAttackRange(u) {
        return UnitDefinition.get(u.type).range;
    }
    isHostileCombatBuilding(side, b) {
        return !!b && b.alive !== false && b.hp > 0 && b.side === 1 - side;
    }
    combatTargetAggroRange(u) {
        const d = UnitDefinition.get(u.type);
        return Number(d.aggroRange) || 390;
    }
    combatTargetRefreshDue(u) {
        const interval = this.msTicks(COMBAT_TARGET_REFRESH_MS);
        return this.tick % interval === (HashUtil.hash(String(u.id)) >>> 0) % interval;
    }
    retainedCombatTarget(u, visibleSources) {
        if (u.target == null) return null;
        // Runtime indexes include this tick's spawns; do not linearly scan dead IDs.
        const unit = this.unitById.get(u.target),
            entity = unit || this.buildingById.get(u.target);
        if (!entity) return null;
        const isBuilding = !unit;
        if (isBuilding) {
            if (
                !this.isHostileCombatBuilding(u.side, entity) ||
                !this.canAttackEntity(u.type, entity, true) ||
                !this.isVisible(u.side, entity.x, entity.y, visibleSources)
            )
                return null;
        } else if (
            !this.isHostileCombatUnit(u.side, entity) ||
            !this.canAttackEntity(u.type, entity, false) ||
            !this.canTargetUnit(u.side, entity, visibleSources) ||
            !this.canSeeCombatTarget(u.side, entity, visibleSources)
        )
            return null;
        const dist = Math.hypot(entity.x - u.x, entity.y - u.y);
        if (
            dist > this.combatTargetAggroRange(u) &&
            dist > this.interactionDistance(u, entity, 'attack', this.basicAttackRange(u))
        )
            return null;
        return {
            entity,
            isBuilding,
            def: isBuilding ? BuildingDefinition.get(entity.type) : UnitDefinition.get(entity.type),
        };
    }
    constructionDefenseContactAllowed(d, site, target) {
        return (
            !d.contactMelee || Math.hypot(site.x - target.x, site.y - target.y) <= CAPTURE_RADIUS
        );
    }
    constructionDefenseInReach(u, site, target) {
        const d = UnitDefinition.get(u.type);
        if (!this.constructionDefenseContactAllowed(d, site, target)) return false;
        const distance = Math.hypot(u.x - target.x, u.y - target.y);
        const min = d.minRange
            ? this.interactionDistance(u, target, 'combat-contact') + d.minRange
            : 0;
        return (
            distance >= min &&
            distance <= this.interactionDistance(u, target, 'attack', this.basicAttackRange(u))
        );
    }
    constructionDefenseTarget(u, site, visibleSources) {
        if (u.constructionWork.phase !== 'defend' || !this.constructionWorkerAvailable(u))
            return null;
        const retained = this.retainedCombatTarget(u, visibleSources);
        if (retained && this.constructionDefenseInReach(u, site, retained.entity)) return retained;
        return this.pickCombatTarget(u, visibleSources, site);
    }
    pickCombatTarget(u, visibleSources, defensiveSite = null) {
        // Fireable hostile threats share one pool, regardless of player/neutral storage.
        // Keep a valid target within its priority tier; an idle structure cannot mask
        // a fireable combatant. Only acquire a chase target when nothing can be hit.
        if (this._perfCollect) this._perfCollect.targetQueries++;
        const d = UnitDefinition.get(u.type),
            attackRange = this.basicAttackRange(u);
        const attackNeedsTerrainLine = InteractionGeometry.requiresTerrainLine(
            u,
            'attack',
            attackRange,
        );
        const aggro = defensiveSite ? 0 : this.combatTargetAggroRange(u);
        const queryRange = Math.max(
            aggro,
            attackRange +
                this.unitRadius(u.type) +
                Math.max(this.maxUnitRadius, this.maxBuildingRadius),
        );
        let currentInRange = null;
        let inRangeBest = null,
            inRangeScore = Infinity,
            inRangeRank = Infinity;
        let acquireBest = null,
            acquireD2 = Infinity,
            currentAcquire = null,
            currentAcquireD2 = Infinity;
        let closeFallback = null,
            closeFallbackD2 = Infinity;
        const consider = (entity, isBuilding, def, d2) => {
            if (defensiveSite && !this.constructionDefenseContactAllowed(d, defensiveSite, entity))
                return;
            const dist = Math.sqrt(d2);
            // Preserve visibility memo seeding above. The source's terrain policy is
            // constant for this selection; ranged reach needs no per-target ray gate.
            const rawReach =
                !attackNeedsTerrainLine || dist > aggro
                    ? InteractionGeometry.reach(u, entity, 'attack', attackRange)
                    : null;
            if (dist > aggro && dist > rawReach) return;
            const max = attackNeedsTerrainLine
                ? this.interactionDistance(u, entity, 'attack', attackRange)
                : rawReach;
            if (dist > aggro && dist > max) return;
            const min = d.minRange
                ? (defensiveSite
                      ? this.interactionDistance(u, entity, 'combat-contact')
                      : InteractionGeometry.contact(u, entity)) + d.minRange
                : 0;
            const candidate = { entity, isBuilding, def };
            if (min && dist < min) {
                if (
                    !defensiveSite &&
                    this.targetChoiceBetter(d2, entity.id, closeFallbackD2, closeFallback)
                ) {
                    closeFallback = candidate;
                    closeFallbackD2 = d2;
                }
                return;
            }
            if (dist <= max) {
                const rank = isBuilding ? 2 : 0;
                const score = (d2 * 100) / this.targetPriorityFactor(u, def);
                if (entity.id === u.target) currentInRange = { candidate, rank };
                if (
                    rank < inRangeRank ||
                    (rank === inRangeRank &&
                        this.targetChoiceBetter(score, entity.id, inRangeScore, inRangeBest))
                ) {
                    inRangeBest = candidate;
                    inRangeScore = score;
                    inRangeRank = rank;
                }
            } else if (!defensiveSite) {
                if (this.targetChoiceBetter(d2, entity.id, acquireD2, acquireBest)) {
                    acquireBest = candidate;
                    acquireD2 = d2;
                }
                if (entity.id === u.target) {
                    currentAcquire = candidate;
                    currentAcquireD2 = d2;
                }
            }
        };
        // The grid returns whole cells. queryRange covers aggro and every attack reach,
        // so a farther candidate is rejected by consider(); skip its visibility rays.
        // Units are scanned in two bands. The near band holds every unit that can be in
        // attack reach of this attacker; only those decide the result when one is
        // found, so the aggro band is scanned only when the attacker must chase.
        const queryRange2 = queryRange * queryRange;
        const nearRange = Math.min(
                queryRange,
                attackRange + this.unitRadius(u.type) + this.maxUnitRadius,
            ),
            nearRange2 = nearRange * nearRange;
        const scan = (range, minD2, maxD2) =>
            this.forEachNearbyHostileUnit(u.side, u.x, u.y, range, (e) => {
                const d2 = (e.x - u.x) ** 2 + (e.y - u.y) ** 2;
                if (d2 <= minD2 || d2 > maxD2) return;
                if (
                    !this.canAttackEntity(u.type, e, false) ||
                    !this.canTargetUnit(u.side, e, visibleSources)
                )
                    return;
                if (!this.canSeeCombatTarget(u.side, e, visibleSources)) {
                    if (this._perfCollect) this._perfCollect.targetVisibilityRejects++;
                    return;
                }
                consider(e, false, UnitDefinition.get(e.type), d2);
            });
        if (d.canAttackGround) scan(nearRange, -1, nearRange2);
        for (const i of this.nearbyBuildingIndices(u.x, u.y, queryRange)) {
            const b = this.buildings[i];
            if (
                !this.isHostileCombatBuilding(u.side, b) ||
                !this.canAttackEntity(u.type, b, true) ||
                !this.isVisible(u.side, b.x, b.y, visibleSources)
            )
                continue;
            const bd = BuildingDefinition.get(b.type);
            consider(
                b,
                true,
                { role: bd.isMainBase ? 'base' : 'building', sizeClass: 'heavy', size: bd.size },
                (b.x - u.x) ** 2 + (b.y - u.y) ** 2,
            );
        }
        if (d.canAttackGround && !defensiveSite && !inRangeBest && nearRange < queryRange)
            scan(queryRange, nearRange2, queryRange2);
        if (currentInRange && currentInRange.rank <= inRangeRank) return currentInRange.candidate;
        if (inRangeBest) return inRangeBest;
        if (currentAcquire && currentAcquireD2 * 100 <= acquireD2 * COMBAT_TARGET_STICKINESS_PCT)
            return currentAcquire;
        return acquireBest || closeFallback;
    }
    damageAmount(sourceType, targetDef, base, damageClassOverride = null) {
        const a = UnitDefinition.get(sourceType) || BuildingDefinition.get(sourceType) || null;
        const sizeClass = targetDef.sizeClass || 'heavy';
        const damageClass =
            damageClassOverride || a?.damageClass || UnitDefinition.damageClass(sourceType);
        let mul =
            (DAMAGE_CLASS_MATRIX[damageClass] && DAMAGE_CLASS_MATRIX[damageClass][sizeClass]) ||
            100;
        if (targetDef.rangedReduction && a?.projectile)
            mul = Math.floor((mul * targetDef.rangedReduction) / 100);
        return Math.max(1, Math.floor((base * mul) / 100));
    }
    emitUnitDeath(target, sourceSide, sourceType) {
        if (!target || target.alive === false) return null;

        if (target.spinAttack) UnitSpinAttack.cancel(this, target);
        target.hp = 0;
        target.alive = false;
        target.constructionWork = null;
        HeroDeployment.unitDied(this, target);
        if ((sourceSide === 0 || sourceSide === 1) && target.side === 1 - sourceSide)
            this.launchStats.kills[sourceSide]++;
        if ((sourceSide === 0 || sourceSide === 1) && target.side === 1 - sourceSide)
            UnitResultStats.add(this.unitResultStats, sourceSide, sourceType, 'kills');
        this.events.push({
            type: 'death',
            side: target.side,
            x: target.x,
            y: target.y,
            entity: target.type,
            killerSide: sourceSide,
            sourceType,
        });
        UnitSelfDestructAttack.onDeath(this, target);
        return null;
    }
    flatArmorValue(target) {
        const d = BuildingDefinition.get(target?.type) || UnitDefinition.get(target?.type) || {};
        return Math.max(0, Number(d.flatArmor) || 0);
    }
    applyDamage(
        sourceSide,
        sourceType,
        target,
        isBuilding,
        amount,
        sourceEntityId = null,
        options = null,
    ) {
        const capture = options?.capture || null;
        const setCapture = (dealt = 0, blocked = false, damageClass = null) => {
            if (capture) {
                capture.dealt = dealt;
                capture.blocked = blocked;
                capture.damageClass = damageClass;
            }
        };
        if (
            !isBuilding &&
            options?.damageDelivery !== 'launch-shell' &&
            (UnitDefinition.get(sourceType) || BuildingDefinition.get(sourceType)) &&
            !this.canAttackEntity(sourceType, target, false)
        ) {
            setCapture(0, true, options?.damageClass || UnitDefinition.damageClass(sourceType));
            return null;
        }
        if (!target || target.alive === false || target.hp <= 0) return null;
        const damageClass = options?.damageClass || UnitDefinition.damageClass(sourceType);
        const sourceDamageResolved = !!options?.sourceDamageResolved;
        if (!sourceDamageResolved && sourceEntityId) {
            this.markTerrainAttackReveal(sourceType, sourceEntityId, target, isBuilding);
            if (
                this.terrainUphillMiss(
                    sourceType,
                    sourceEntityId,
                    target,
                    isBuilding,
                    `${this.tick}|${sourceEntityId}|${target.id}|direct`,
                )
            ) {
                this.events.push({
                    type: 'dodge',
                    reason: 'uphill',
                    side: target.side,
                    x: target.x,
                    y: target.y,
                    sourceSide,
                    sourceType,
                    sourceId: sourceEntityId,
                    targetId: target.id,
                });
                setCapture(0, true, damageClass);
                return null;
            }
        }
        if (target.side === sourceSide) {
            setCapture(0, true);
            return null;
        }
        const td = isBuilding
            ? { sizeClass: 'heavy', role: 'building' }
            : UnitDefinition.get(target.type);
        const rawAmount = Math.max(0, Number(amount) || 0);

        let dmg = this.damageAmount(sourceType, td, rawAmount, damageClass);
        if (!isBuilding && sourceSide !== target.side) {
            const terrain = this.terrainAt(target.x, target.y);
            if (terrain.river) dmg = Math.max(1, Math.floor(dmg * 1.5));
        }

        const flatArmor = this.flatArmorValue(target);
        if (flatArmor > 0) {
            const delivery = options?.damageDelivery || 'hit';
            if (delivery === 'continuous') {
                const seconds = Math.max(0, Number(options?.deliverySeconds) || 0);
                // flatArmor is interpreted as damage prevented per second for continuous delivery.
                // Quantize only at the final hit boundary; attack cadence itself no longer multiplies armor.
                const armorForPulse = flatArmor * seconds;
                dmg = Math.max(1, Math.round(dmg - armorForPulse));
            } else {
                dmg = Math.max(1, dmg - flatArmor);
            }
        }

        const hpBefore = Math.max(0, target.hp || 0);
        target.hp -= dmg;
        const dealt = Math.min(hpBefore, dmg);
        if ((sourceSide === 0 || sourceSide === 1) && target.side === 1 - sourceSide)
            UnitResultStats.add(
                this.unitResultStats,
                sourceSide,
                sourceType,
                isBuilding ? 'buildingDamage' : 'unitDamage',
                dealt,
            );
        setCapture(dealt, false, damageClass);
        if (!isBuilding) {
            target.hitFlash = 4;
            target.combat.recordImpact(this, 4);
            const work = target.constructionWork;
            if (
                dealt > 0 &&
                work &&
                work.phase !== 'defend' &&
                this.constructionSite(target)?.construction
            )
                this.resetConstructionCycle(work, 'defend', work.nextHitTick);
        }

        this.events.push({
            type: 'hit',
            side: target.side,
            x: target.x,
            y: target.y,
            amount: dmg,
            sourceSide,
            sourceType,
            sourceId: sourceEntityId || null,
            targetId: target.id || null,
            targetType: isBuilding ? 'building' : target.type,
            isBuilding: !!isBuilding,
            damageClass,
            suppressImpactFx: !!options?.suppressImpactFx,
        });

        if (target.hp <= 0) {
            if (isBuilding) {
                target.hp = 0;
                target.alive = false;
                this.markBuildingSpatialDirty();
                this.events.push({
                    type: 'buildingDeath',
                    side: target.side,
                    x: target.x,
                    y: target.y,
                    entity: target.type,
                    isOutpost: !!BuildingDefinition.get(target.type)?.isOutpost,
                    killerSide: sourceSide,
                    sourceType,
                });
                if (BuildingDefinition.get(target.type)?.isOutpost)
                    this.releaseCaptureForOutpost(target.id);
                if (BuildingDefinition.get(target.type)?.isMainBase)
                    return target.side === 0 ? 'guest' : 'host';
            } else {
                this.emitUnitDeath(target, sourceSide, sourceType);
            }
        }
        return null;
    }
    // strikePeak > 1 makes the blast hit harder toward its centre (1 at the edge, strikePeak at the middle).
    // Returns how many enemies were hit and the strongest multiplier any of them took.
    applyAreaDamage({
        sourceSide,
        sourceType,
        sourceEntityId = null,
        x,
        y,
        radius,
        damage,
        damageClass = 'area',
        damageDelivery,
        suppressImpactFx = false,
        strikePeak = 1,
        impactHeightFP = undefined,
    } = {}) {
        const result = { hits: 0, peak: 1 };
        this.withNearbyUnits(x, y, radius + this.maxUnitRadius, (indices) => {
            for (const idx of indices) {
                const e = this.units[idx];
                if (!e?.alive || e.side === sourceSide) continue;
                const body =
                    impactHeightFP === undefined
                        ? null
                        : LaunchImpact.distanceToBody(this, e, x, y, impactHeightFP);
                const d = body ? body.falloffDistance : Math.hypot(e.x - x, e.y - y);
                if (body ? body.surfaceDistance > radius : d > radius + this.unitRadius(e.type))
                    continue;
                const mult = strikePeak > 1 ? LaunchRules.strike(d, radius, strikePeak) : 1;
                result.hits++;
                result.peak = Math.max(result.peak, mult);
                this.applyDamage(
                    sourceSide,
                    sourceType,
                    e,
                    false,
                    Math.max(1, Math.floor(damage * mult)),
                    sourceEntityId,
                    { damageClass, damageDelivery, suppressImpactFx, sourceDamageResolved: true },
                );
            }
        });
        return result;
    }
    setTimedModifier(
        u,
        key,
        {
            until = null,
            durationTicks = 0,
            movePct = 100,
            attackSpeedPct = 100,
            maxStacks = 1,
            refresh = true,
            persistent = false,
            resetOnMove = false,
        } = {},
    ) {
        if (!u) return;
        if (!u.status.timedModifiers) u.status.timedModifiers = {};
        const prev = u.status.timedModifiers[key];
        const expire = persistent
            ? 0
            : (until ?? this.tick + Math.max(1, Math.round(durationTicks || 1)));
        if (prev && (prev.persistent || prev.until > this.tick)) {
            if (!prev.persistent) prev.until = refresh ? Math.max(prev.until, expire) : prev.until;
            prev.persistent = !!(prev.persistent || persistent);
            prev.resetOnMove = !!(prev.resetOnMove || resetOnMove);
            prev.stacks = Math.min(maxStacks, Math.max(1, (prev.stacks || 1) + 1));
            prev.movePct = Math.max(prev.movePct || 100, movePct);
            prev.attackSpeedPct = Math.max(prev.attackSpeedPct || 100, attackSpeedPct);
        } else {
            u.status.timedModifiers[key] = {
                until: expire,
                stacks: 1,
                movePct,
                attackSpeedPct,
                persistent: !!persistent,
                resetOnMove: !!resetOnMove,
            };
        }
    }
    timedModifierPct(u, field) {
        let pct = 100;
        if (!u?.status.timedModifiers) return pct;
        for (const [key, m] of Object.entries(u.status.timedModifiers)) {
            if (!m || (!m.persistent && m.until <= this.tick)) {
                delete u.status.timedModifiers[key];
                continue;
            }
            const stacks = Math.max(1, m.stacks || 1);
            const one = Math.max(100, Number(m[field]) || 100);
            pct = Math.max(pct, 100 + (one - 100) * stacks);
        }
        return pct;
    }
    engagementGoal(u, target, attackRange) {
        return InteractionGeometry.goal(u, target, 'attack', attackRange);
    }
    isHostileCombatUnit(attackerSide, e) {
        return (
            !!e?.alive && (attackerSide === 0 || attackerSide === 1) && e.side === 1 - attackerSide
        );
    }
    forEachNearbyHostileUnit(attackerSide, x, y, radius, visit) {
        if (attackerSide !== 0 && attackerSide !== 1) return;
        this.withNearbyUnits(x, y, radius, 1 - attackerSide, (indices) => {
            for (const idx of indices) {
                const e = this.units[idx];
                if (this.isHostileCombatUnit(attackerSide, e)) visit(e);
            }
        });
    }
    combatTargetInAttackRange(u, found, attackRange = null) {
        if (!u || !found?.entity) return false;
        const d = UnitDefinition.get(u.type),
            t = found.entity;
        const range = attackRange ?? d.range,
            dist = Math.hypot(t.x - u.x, t.y - u.y);
        const max = this.interactionDistance(u, t, 'attack', range),
            min = this.interactionDistance(u, t, 'combat-contact') + (d.minRange || 0);
        return dist <= max && (!d.minRange || dist >= min);
    }
    unitRallyPoint(u) {
        if (u.launchHoldPointId) {
            const cp = this.capturePoints.find((p) => p.id === u.launchHoldPointId);
            if (cp && cp.owner == null && cp.enabled) return { x: cp.x, y: cp.y, forced: false };
            u.launchHoldPointId = null;
        }
        if (u.side === 1 && this.campaignVolleyPractice) {
            const index = this.campaignVolleyPractice.goals.findIndex((goal) =>
                goal.garrisonIds.includes(u.id),
            );
            if (index >= 0) return this.rules.campaign.volleyGoals[index];
        }
        return this.flags[u.side];
    }
    updateBuildingCombat(vision) {
        for (const b of this.buildings) {
            const d = BuildingDefinition.get(b.type);
            if (
                b.alive === false ||
                b.construction ||
                !(d?.atk > 0) ||
                !(d.range > 0) ||
                b.cooldownActive(this)
            )
                continue;
            const shell =
                d.canAttackAir && LaunchInterception.target(this, b, d.range, vision[b.side]);
            let target = shell,
                isBuilding = false;
            if (!target) {
                let bestDistance = Infinity;
                const consider = (entity, building) => {
                    if (
                        !this.canAttackEntity(b.type, entity, building) ||
                        !this.canSeeCombatTarget(b.side, entity, vision[b.side])
                    )
                        return;
                    const distance = (entity.x - b.x) ** 2 + (entity.y - b.y) ** 2;
                    if (distance > d.range * d.range) return;
                    if (this.targetChoiceBetter(distance, entity.id, bestDistance, target)) {
                        target = entity;
                        isBuilding = building;
                        bestDistance = distance;
                    }
                };
                // On the ground, a defensive tower prefers troops over structures.
                this.forEachNearbyHostileUnit(b.side, b.x, b.y, d.range, (e) => {
                    if (this.canTargetUnit(b.side, e, vision[b.side])) consider(e, false);
                });
                if (!target)
                    for (const idx of this.nearbyBuildingIndices(b.x, b.y, d.range)) {
                        const e = this.buildings[idx];
                        if (this.isHostileCombatBuilding(b.side, e)) consider(e, true);
                    }
            }
            b.targetId = target?.id ?? null;
            if (!target) continue;
            b.startCooldownUntil(this.tick + this.msTicks(d.cooldownMs));
            if (shell) {
                LaunchInterception.hit(this, b, shell, d.atk);
                continue;
            }
            if (d.mortar && ++b.attacksSinceMortar === d.mortar.attackInterval) {
                b.attacksSinceMortar = 0;
                this.fireMortar(b, target, d.mortar);
                continue;
            }
            this.applyDamage(b.side, b.type, target, isBuilding, d.atk, b.id, {
                damageClass: d.damageClass,
            });
        }
    }
    fireMortar(cannon, target, spec) {
        const dx = target.x - cannon.x,
            dy = target.y - cannon.y,
            distance = Math.hypot(dx, dy),
            muzzleReach = Math.min(LaunchImpactRules.muzzleReach, distance / 2),
            muzzleFraction = distance ? muzzleReach / distance : 0,
            arcDistance = Math.max(1, distance - muzzleReach),
            id = 'p' + ++this.seq;
        this.spawnProjectile({
            id,
            owner: cannon.id,
            side: cannon.side,
            type: cannon.type,
            x: cannon.x + dx * muzzleFraction,
            y: cannon.y + dy * muzzleFraction,
            lockedAimX: target.x,
            lockedAimY: target.y,
            speed: (arcDistance * 1000) / spec.flightMs,
            arcDistance,
            damage: spec.damage,
            damageClass: spec.damageClass,
            splash: spec.radius,
            mortar: true,
        });
        this.events.push({
            type: 'mortarFire',
            side: cannon.side,
            cannonId: cannon.id,
            projectileId: id,
            x: cannon.x,
            y: cannon.y,
            aimX: target.x,
            aimY: target.y,
        });
    }
    // Grains are melee bruisers: march to the rally point, chase the chosen target, wind up, hit.
    updateCombat(u, vision, pendingContactAttacks = null) {
        const d = UnitDefinition.get(u.type);
        if (d.selfDestruct && UnitSelfDestructAttack.update(this, u, d.selfDestruct)) return null;
        this.tickAttackTimers(u);
        if (u.heroRoll || u.fruitAttack?.active) return null;
        // A pending skill only takes the combat action slot when it can actually start.
        if (u.heroRollQueued || u.fruitAttack?.queued) {
            const hero = this.heroes[u.side][u.type];
            const skill = u.fruitAttack ? FruitHeroAttack : HeroRollAttack;
            if (hero?.unitId === u.id && skill.tryQueued(this, u, hero.sortieId, vision[u.side]))
                return null;
        }
        if (HeroDeployment.moveReturningUnit(this, u, d)) {
            UnitSpinAttack.cancel(this, u);
            return null;
        }
        if (d.leapAttack && UnitLeapAttack.update(this, u)) {
            u.constructionWork = null;
            return null;
        }
        if (d.contactMelee && u.contactAttack?.phase === 'recover') {
            if (this.tick < u.contactAttack.untilTick) {
                const speed = (d.speed * this.timedModifierPct(u, 'movePct')) / 100;
                this.moveToward(u, u.contactAttack.retreatX, u.contactAttack.retreatY, speed, {
                    allowContactRecovery: true,
                });
                return null;
            }
            u.contactAttack = null;
        }
        const site = d.construction ? this.constructionSite(u) : null;
        const activeSite = site?.construction ? site : null;
        if (d.spinAttack && u.spinAttack) {
            const spin = UnitSpinAttack.update(this, u, d.spinAttack, d.atk);
            if (spin.active) {
                if (!activeSite) u.constructionWork = null;
                return spin.winner;
            }
        }
        if (!UnitMotion.isGrounded(u)) {
            if (d.burstAttack) UnitBurstAttack.cancel(this, u, d);
            if (!activeSite) u.constructionWork = null;
            else if (u.constructionWork.cycleStartedAtTick !== null) {
                const work = u.constructionWork;
                this.resetConstructionCycle(work, 'approach', work.nextHitTick);
            }
            return null;
        }
        if (d.burstAttack && u.combat.burstAttack) {
            const burst = UnitBurstAttack.update(this, u, d, vision[u.side]);
            if (burst.active) return burst.winner;
        }

        const attackRange = this.basicAttackRange(u);
        let found = activeSite
            ? this.constructionDefenseTarget(u, activeSite, vision[u.side])
            : null;
        const targetKind = u.combat.attackWindupTargetKind;
        // A burst unit prefers air until its first shot commits the target.
        // Other units finish their ground windup before acquiring an air target.
        const shell =
            d.canAttackAir &&
            (!activeSite || found) &&
            (d.burstAttack || targetKind === 'projectile' || !u.combat.windupPending()) &&
            !u.combat.cooldownActive(this) &&
            FruitHeroAttack.canBasic(u) &&
            LaunchInterception.target(
                this,
                u,
                d.burstAttack?.airRange ?? attackRange,
                vision[u.side],
                targetKind === 'projectile' ? u.combat.attackWindupTargetId : null,
            );
        if (shell) {
            if (!activeSite) u.constructionWork = null;
            if (targetKind !== 'projectile' || u.combat.attackWindupTargetId !== shell.id)
                u.combat.cancelWindup();
            if (this.attackReadyAfterWindup(u, shell, 'projectile', d)) {
                if (d.burstAttack) UnitBurstAttack.start(this, u, shell, 'projectile', d);
                else {
                    this.commitAttackTiming(u, d, this.attackCooldown(u, d));
                    LaunchInterception.hit(this, u, shell, d.atk);
                }
            }
            return null;
        }
        if (targetKind === 'projectile') {
            u.combat.cancelWindup();
            u.target = null;
        }

        if (activeSite) {
            if (
                found &&
                u.combat.windupPending() &&
                u.combat.attackWindupTargetId !== found.entity.id
            )
                u.combat.cancelWindup();
        } else if ((u.combat.attackWindupUntil || 0) > 0) {
            const locked = this.attackWindupTarget(u);
            if (locked) {
                const isBuilding = !!BuildingDefinition.get(locked.type);
                found = {
                    entity: locked,
                    isBuilding,
                    def: isBuilding
                        ? BuildingDefinition.get(locked.type)
                        : UnitDefinition.get(locked.type),
                };
            } else {
                u.combat.cancelWindup();
            }
        }
        if (!activeSite && !found) {
            if (this.combatTargetRefreshDue(u)) {
                const pickStarted = this._perfCollect ? performance.now() : 0;
                found = this.pickCombatTarget(u, vision[u.side]);
                if (this._perfCollect) {
                    this._perfCollect.combatTargetPickMs += performance.now() - pickStarted;
                    this._perfCollect.combatTargetPickCalls++;
                }
            } else found = this.retainedCombatTarget(u, vision[u.side]);
        }

        let moveSpeed = d.speed;
        const cooldown = this.attackCooldown(u, d);
        // 공통 전투 이동/공속 보정.
        moveSpeed *= this.timedModifierPct(u, 'movePct') / 100;
        const nonCombatMoveSpeed = moveSpeed * (d.outOfCombatMoveMultiplier ?? 1);

        if (!found) {
            u.combat.cancelWindup();
            if (d.contactMelee && u.contactAttack?.phase === 'charge') u.contactAttack = null;
            u.target = null;
            if (this.updateConstructionWork(u, d, nonCombatMoveSpeed)) return null;
            const f = this.unitRallyPoint(u);
            this.moveToward(u, f.x, f.y, nonCombatMoveSpeed);
            return null;
        }

        if (!activeSite) u.constructionWork = null;
        const t = found.entity;
        u.target = t.id;
        // Authoritative second gate: a target picked earlier this tick must still be attackable and visible.
        if (
            !found.isBuilding &&
            (!this.canAttackEntity(u.type, t, false) ||
                !this.canTargetUnit(u.side, t) ||
                !this.canSeeCombatTarget(u.side, t, vision[u.side]))
        ) {
            u.combat.cancelWindup();
            if (d.contactMelee && u.contactAttack?.phase === 'charge') u.contactAttack = null;
            u.target = null;
            const f = this.unitRallyPoint(u);
            this.moveToward(u, f.x, f.y, nonCombatMoveSpeed);
            return null;
        }

        if (
            d.spinAttack &&
            (!d.spinAttack.rhythm || !found.isBuilding) &&
            UnitSpinAttack.start(this, u, d.spinAttack, vision[u.side])
        ) {
            u.combat.cancelWindup();
            if (!d.spinAttack.rhythm)
                u.combat.cooldownUntil = u.spinAttack.endTick + this.msTicks(d.cooldownMs);
            return UnitSpinAttack.update(this, u, d.spinAttack, d.atk).winner;
        }
        const dist = Math.hypot(t.x - u.x, t.y - u.y) || 1;
        const max = this.interactionDistance(u, t, 'attack', attackRange);
        const min = d.minRange ? this.interactionDistance(u, t, 'combat-contact') + d.minRange : 0;
        if (dist > max || dist < min) {
            // Wind-up is valid only while the target remains in legal attack range.
            if (u.combat.windupPending()) u.combat.cancelWindup();
            if (d.contactMelee && u.contactAttack?.phase === 'charge') u.contactAttack = null;
            if (
                !found.isBuilding &&
                d.leapAttack &&
                UnitLeapAttack.start(this, u, t, d.leapAttack, max)
            )
                return null;
            this.moveToGoal(u, this.engagementGoal(u, t, attackRange), moveSpeed);
            return null;
        }

        if (d.selfDestruct) {
            UnitSelfDestructAttack.start(this, u, d.selfDestruct);
            return null;
        }

        if (d.contactMelee) {
            if (!u.combat.windupPending() && !u.combat.cooldownActive(this))
                this.startAttackWindup(u, t, found.isBuilding ? 'building' : 'unit', d);
            const contact = found.isBuilding
                ? this.buildingClearanceDistance(u, t)
                : InteractionGeometry.contact(u, t);
            const readyToCharge = this.tickAttackWindup(u);
            if (readyToCharge) {
                if (u.contactAttack?.phase !== 'charge' || u.contactAttack.targetId !== t.id)
                    u.contactAttack = {
                        phase: 'charge',
                        targetId: t.id,
                        untilTick: this.tick + this.msTicks(ConstructionRules.chargeTimeoutMs),
                    };
                if (this.tick >= u.contactAttack.untilTick) {
                    u.combat.cancelWindup();
                    u.contactAttack = null;
                    u.target = null;
                    return null;
                }
            }
            const fromX = u.x,
                fromY = u.y;
            if (readyToCharge && dist > contact)
                this.moveToGoal(
                    u,
                    NavigationGoal.range(t.x, t.y, contact + NavigationGoal.ARRIVAL_INSET),
                    moveSpeed * ConstructionRules.chargeSpeedMultiplier,
                );
            if (readyToCharge)
                pendingContactAttacks?.push({
                    unit: u,
                    targetId: t.id,
                    isBuilding: found.isBuilding,
                    cooldown,
                    beforeDistance: dist,
                    fromX,
                    fromY,
                });
            return null;
        }

        if (d.spinAttack && !d.spinAttack.arcSweep) return null;
        if (d.lobAttack && d.minRange && dist < InteractionGeometry.contact(u, t) + d.minRange) {
            u.combat.cancelWindup();
            this.moveToward(
                u,
                u.x + ((u.x - t.x) / dist) * d.minRange,
                u.y + ((u.y - t.y) / dist) * d.minRange,
                moveSpeed,
            );
            return null;
        }
        if (u.fruitAttack && !FruitHeroAttack.canBasic(u)) return null;
        if (!this.attackReadyAfterWindup(u, t, found.isBuilding ? 'building' : 'unit', d))
            return null;
        if (d.burstAttack)
            return UnitBurstAttack.start(this, u, t, found.isBuilding ? 'building' : 'unit', d);
        this.commitAttackTiming(u, d, cooldown);
        if (u.fruitAttack) {
            FruitHeroAttack.basic(this, u, t, found.isBuilding);
            return null;
        }
        if (d.lobAttack) {
            UnitLobAttack.launch(this, u, t, d.lobAttack, d.atk);
            return null;
        }
        if (d.thornAttack) {
            UnitThornAttack.launch(this, u, t, found.isBuilding, {
                ...d.thornAttack,
                damage: Math.floor(d.atk),
            });
            return null;
        }
        if (d.spinAttack?.rhythm && !found.isBuilding) {
            UnitSpinAttack.hitBasic(this, u, t, d.spinAttack.rhythm, Math.floor(d.atk));
            return null;
        }
        return this.applyDamage(u.side, u.type, t, found.isBuilding, Math.floor(d.atk), u.id, {
            damageClass: UnitDefinition.damageClass(u.type),
        });
    }
    // Contact attacks commit after the shared motion solver, in the same stable
    // unit order as target selection. Pending entries never cross a tick boundary.
    beginContactAttackRecovery(u, target, cooldownMs) {
        const dx = u.x - target.x,
            dy = u.y - target.y,
            length = Math.hypot(dx, dy) || 1;
        u.contactAttack = {
            phase: 'recover',
            retreatX: u.x + (dx / length) * ConstructionRules.retreatDistance,
            retreatY: u.y + (dy / length) * ConstructionRules.retreatDistance,
            untilTick:
                this.tick +
                Math.max(
                    1,
                    Math.round(this.msTicks(cooldownMs) * ConstructionRules.phaseRatios.recoverEnd),
                ),
        };
    }
    resolveContactAttacks(pending, vision) {
        let winner = null;
        for (const attack of pending) {
            const u = attack.unit;
            if (
                !u.alive ||
                u.combat.attackWindupTargetId !== attack.targetId ||
                !this.tickAttackWindup(u)
            )
                continue;
            const target = this.liveEntityRefById(
                attack.targetId,
                attack.isBuilding ? 'building' : 'unit',
            )?.entity;
            if (!target) {
                u.combat.cancelWindup();
                continue;
            }
            if (
                !this.canAttackEntity(u.type, target, attack.isBuilding) ||
                (!attack.isBuilding &&
                    (!this.canTargetUnit(u.side, target) ||
                        !this.canSeeCombatTarget(u.side, target, vision[u.side])))
            ) {
                u.combat.cancelWindup();
                continue;
            }
            const contact = attack.isBuilding
                ? this.buildingClearanceDistance(u, target)
                : InteractionGeometry.contact(u, target);
            const afterDistance = Math.hypot(target.x - u.x, target.y - u.y);
            if (
                this.interactionDistance(u, target, 'attack', 0) < 0 ||
                afterDistance > contact + ConstructionRules.contactTolerance
            )
                continue;
            u.combat.cancelWindup();
            const definition = UnitDefinition.get(u.type);
            const dx = target.x - attack.fromX,
                dy = target.y - attack.fromY,
                length = Math.hypot(dx, dy) || 1,
                sourceApproach = ((u.x - attack.fromX) * dx + (u.y - attack.fromY) * dy) / length;
            if (attack.beforeDistance - afterDistance < 1 / FP || sourceApproach < 1 / FP) {
                this.beginContactAttackRecovery(
                    u,
                    target,
                    definition.attackIntervalMs ?? definition.cooldownMs,
                );
                continue;
            }
            this.commitAttackTiming(u, definition, attack.cooldown);
            u.combat.contactHitTick = this.tick;
            this.beginContactAttackRecovery(
                u,
                target,
                definition.attackIntervalMs ?? definition.cooldownMs,
            );
            winner =
                this.applyDamage(
                    u.side,
                    u.type,
                    target,
                    attack.isBuilding,
                    Math.floor(definition.atk),
                    u.id,
                    { damageClass: UnitDefinition.damageClass(u.type) },
                ) || winner;
        }
        return winner;
    }
    // The shared height curve clears high obstacles; low swept contacts retire a shot early.
    // Impact damage and queued deployment use that actual contact point.
    retireProjectile(projectile, x, y) {
        projectile.alive = false;
        this.events.push({
            type: 'projectileRetire',
            projectileId: projectile.id,
            x,
            y,
            side: projectile.side,
            sourceType: projectile.type,
        });
    }

    updateProjectiles() {
        for (const p of this.projectiles) {
            if (!p.alive) continue;
            let aimX = Number(p.lockedAimX) || p.x,
                aimY = Number(p.lockedAimY) || p.y;
            const dx = aimX - p.x,
                dy = aimY - p.y,
                dist = Math.hypot(dx, dy),
                step = p.speed / this.tps;
            const travel = Math.min(step, dist),
                toX = p.x + (dx / (dist || 1)) * travel,
                toY = p.y + (dy / (dist || 1)) * travel;
            const contact = LaunchImpact.firstContact(this, p, toX, toY);
            if (contact) {
                aimX = contact.x;
                aimY = contact.y;
            }
            const arrivalStep = p.arcDistance != null ? step : Math.max(20, step);
            if (dist <= arrivalStep || contact) {
                this.retireProjectile(p, aimX, aimY);
                const impactHeightFP =
                    contact?.impactHeightFP ??
                    Math.round(this.world.terrain.surfaces.heightAt(aimX, aimY) * FP);
                const radius = Math.max(1, p.splash || 1);
                if (!p.mortar) LaunchImpact.blast(this, p, aimX, aimY, radius, impactHeightFP);
                if (p.payload) LaunchImpact.enqueue(this, p, aimX, aimY, impactHeightFP);
                const blast = this.applyAreaDamage({
                    sourceSide: p.side,
                    sourceType: p.type,
                    sourceEntityId: p.owner || null,
                    x: aimX,
                    y: aimY,
                    radius,
                    damage: p.splashUnitDamage ?? p.damage,
                    damageClass: p.damageClass || 'normal',
                    damageDelivery: p.payload ? 'launch-shell' : undefined,
                    suppressImpactFx: true,
                    strikePeak: p.mortar ? 1 : LaunchRules.unitImpactPeak,
                    impactHeightFP,
                });
                for (const b of this.buildings) {
                    if (!b || b.alive === false || b.side === p.side) continue;
                    const body = LaunchImpact.distanceToBody(
                        this,
                        b,
                        aimX,
                        aimY,
                        impactHeightFP,
                        true,
                    );
                    if (body.surfaceDistance > radius) continue;
                    const mult = p.mortar
                        ? 1
                        : LaunchRules.strike(
                              body.falloffDistance,
                              radius,
                              LaunchRules.buildingImpactPeak,
                          );
                    blast.hits++;
                    blast.peak = Math.max(blast.peak, mult);
                    this.applyDamage(
                        p.side,
                        p.type,
                        b,
                        true,
                        Math.max(1, Math.floor((p.splashBuildingDamage ?? p.damage) * mult)),
                        p.owner || null,
                        {
                            damageClass: p.damageClass || 'normal',
                            sourceDamageResolved: true,
                            suppressImpactFx: true,
                        },
                    );
                }
                this.events.push({
                    type: p.mortar ? 'mortarImpact' : 'launchImpact',
                    side: p.side,
                    unit: p.type,
                    x: aimX,
                    y: aimY,
                    radius,
                    hits: blast.hits,
                    peak: Math.round(blast.peak * 100) / 100,
                    projectileId: p.id,
                    directHitId: contact?.id || null,
                    impactHeightFP,
                    dirX:
                        (p.lockedAimX - p.launchX) /
                        (Math.hypot(p.lockedAimX - p.launchX, p.lockedAimY - p.launchY) || 1),
                    dirY:
                        (p.lockedAimY - p.launchY) /
                        (Math.hypot(p.lockedAimX - p.launchX, p.lockedAimY - p.launchY) || 1),
                });
                continue;
            }
            p.x = toX;
            p.y = toY;
        }
        this.projectiles = this.projectiles.filter((p) => p.alive);
        return null;
    }
    radiusFP(u) {
        return UNIT_RUNTIME_GEOMETRY[u.type]?.radiusFP || FP;
    }
    mass(u) {
        return UNIT_RUNTIME_GEOMETRY[u.type]?.mass || 100;
    }
    fallbackNormal(a, b) {
        const ds = [
            [COLLISION_NORMAL, 0],
            [2896, 2896],
            [0, COLLISION_NORMAL],
            [-2896, 2896],
            [-COLLISION_NORMAL, 0],
            [-2896, -2896],
            [0, -COLLISION_NORMAL],
            [2896, -2896],
        ];
        const ai = String(a?.id || ''),
            bi = String(b?.id || ''),
            lo = ai < bi ? ai : bi,
            hi = ai < bi ? bi : ai,
            v = ds[HashUtil.hash(lo + '|' + hi) & 7];
        return ai === lo ? v : [-v[0], -v[1]];
    }
    resolveNonAlliedSurfaceMotion(startFx, startFy, radii, maxRadius, maxPasses = 4) {
        const units = this.units,
            n = units.length;
        if (!n) return 0;
        const perf = this._perfCollect;
        if (perf) perf.collisionSweptCalls++;
        this.ensureCollisionBuffers(n);
        const segX = this.collisionSegmentFx,
            segY = this.collisionSegmentFy;
        const nextX = this.collisionNextFx,
            nextY = this.collisionNextFy;
        const bestT = this.collisionBestT,
            bestNx = this.collisionBestNx,
            bestNy = this.collisionBestNy,
            bestOther = this.collisionBestOther;
        const grid = this.collisionGrid;
        const motion = this.collisionMotion;
        let unitRadiusMax = 0;

        for (let i = 0; i < n; i++) {
            const u = units[i];
            segX[i] = i < startFx.length ? startFx[i] : (u?.fx ?? 0);
            segY[i] = i < startFy.length ? startFy[i] : (u?.fy ?? 0);
            if (u?.alive && radii[i] > 0) unitRadiusMax = Math.max(unitRadiusMax, radii[i]);
        }

        let totalCorrections = 0;
        for (let pass = 0; pass < maxPasses; pass++) {
            bestT.fill(Infinity, 0, n);
            bestOther.fill(-1, 0, n);
            let travelMax = 0;
            for (let i = 0; i < n; i++) {
                const u = units[i];
                if (!u?.alive) continue;
                motion.sx[i] = segX[i] / FP;
                motion.sy[i] = segY[i] / FP;
                motion.ex[i] = u.fx / FP;
                motion.ey[i] = u.fy / FP;
                motion.vx[i] = motion.ex[i] - motion.sx[i];
                motion.vy[i] = motion.ey[i] - motion.sy[i];
                if (radii[i] > 0) {
                    const travel = Math.ceil(Math.hypot(u.fx - segX[i], u.fy - segY[i]));
                    travelMax = Math.max(travelMax, travel);
                }
            }
            if (!travelMax) {
                if (perf) perf.collisionSweptZeroMotionCalls++;
                break;
            } // Every relative cast would reject zero motion.
            if (perf) perf.collisionSweptActivePasses++;
            this.rebuildCollisionGrid(units, 0);
            this.rebuildSweepGrid(units, radii, segX, segY, grid);
            let pairContacts = 0;
            for (let i = 0; i < n; i++) {
                const a = units[i];
                if (!a?.alive || radii[i] <= 0) continue;
                const sx = segX[i],
                    sy = segY[i],
                    ex = a.fx,
                    ey = a.fy;
                const reach = radii[i] + unitRadiusMax + travelMax;
                const minCx = grid.cellX(Math.min(sx, ex) - reach),
                    maxCx = grid.cellX(Math.max(sx, ex) + reach);
                const minCy = grid.cellY(Math.min(sy, ey) - reach),
                    maxCy = grid.cellY(Math.max(sy, ey) + reach);
                const candidates = this.sweepCandidates(
                    i,
                    grid,
                    minCx,
                    maxCx,
                    minCy,
                    maxCy,
                    a.side,
                );
                if (perf) perf.collisionSweptPairTests += candidates.length;
                for (const j of candidates) {
                    const b = units[j];
                    if (
                        !b?.alive ||
                        radii[j] <= 0 ||
                        this.isAlliedCollisionUnit(a, b) ||
                        UnitLeapAttack.separated(this, a, b)
                    )
                        continue;
                    if (
                        this.navigation.motion.solvedImpulseTick === this.tick &&
                        (a.impactMotion || b.impactMotion)
                    )
                        continue;
                    // Keep the original floating-point subtraction order. Equal relative
                    // motion has no inward contact, including a stationary overlap.
                    const vx = motion.vx[i] - motion.vx[j],
                        vy = motion.vy[i] - motion.vy[j];
                    if (vx === 0 && vy === 0) continue;
                    const hit = SweptCircleContact.cast(
                        motion.sx[i] - motion.sx[j],
                        motion.sy[i] - motion.sy[j],
                        vx,
                        vy,
                        (radii[i] + radii[j]) / FP,
                        SweptCircleContact.policies.relative,
                        () => {
                            const v = this.fallbackNormal(a, b);
                            return { x: v[0] / COLLISION_NORMAL, y: v[1] / COLLISION_NORMAL };
                        },
                    );
                    if (!hit) continue;
                    if (perf) perf.collisionSweptHits++;
                    pairContacts++;

                    if (
                        hit.t < bestT[i] - 1e-9 ||
                        (Math.abs(hit.t - bestT[i]) <= 1e-9 &&
                            (bestOther[i] < 0 || j < bestOther[i]))
                    ) {
                        bestT[i] = hit.t;
                        bestNx[i] = hit.nx;
                        bestNy[i] = hit.ny;
                        bestOther[i] = j;
                    }
                    if (
                        hit.t < bestT[j] - 1e-9 ||
                        (Math.abs(hit.t - bestT[j]) <= 1e-9 &&
                            (bestOther[j] < 0 || i < bestOther[j]))
                    ) {
                        bestT[j] = hit.t;
                        bestNx[j] = -hit.nx;
                        bestNy[j] = -hit.ny;
                        bestOther[j] = i;
                    }
                }
            }
            if (!pairContacts) {
                if (perf) perf.collisionSweptEmptyPasses++;
                break;
            }

            let corrected = 0;
            for (let i = 0; i < n; i++) {
                const u = units[i];
                nextX[i] = u?.fx ?? 0;
                nextY[i] = u?.fy ?? 0;
                const other = bestOther[i];
                if (!u?.alive || other < 0) continue;
                const sx = segX[i] / FP,
                    sy = segY[i] / FP,
                    ex = u.fx / FP,
                    ey = u.fy / FP;
                const dx = ex - sx,
                    dy = ey - sy,
                    len = Math.hypot(dx, dy);
                if (len < 0.000001) {
                    segX[i] = u.fx;
                    segY[i] = u.fy;
                    continue;
                }

                const q = RangeUtil.clamp(bestT[i], 0, 1),
                    cx = sx + dx * q,
                    cy = sy + dy * q,
                    leftLen = len * (1 - q);
                let goalX = dx,
                    goalY = dy;
                if (u.collisionIntentTick === this.tick) {
                    goalX = (Number(u.collisionIntentTx) || 0) - cx;
                    goalY = (Number(u.collisionIntentTy) || 0) - cy;
                }
                const slide = SurfaceContactGeometry.slide(
                    dx * (1 - q),
                    dy * (1 - q),
                    [{ nx: bestNx[i], ny: bestNy[i], key: 'solid:' + other }],
                    leftLen,
                    {
                        steer: true,
                        goalX,
                        goalY,
                        tieKey: `solid|${u.id}|${units[other]?.id || other}`,
                    },
                );
                const ur = radii[i] || this.radiusFP(u);
                nextX[i] = RangeUtil.clamp(
                    Math.round((cx + slide.x) * FP),
                    ur,
                    this.world.width * FP - ur,
                );
                nextY[i] = RangeUtil.clamp(
                    Math.round((cy + slide.y) * FP),
                    ur,
                    this.world.height * FP - ur,
                );

                // Next pass starts at this contact point, not at tick start. This preserves
                // the actual piecewise path and catches second/third obstacles on the tangent.
                segX[i] = Math.round(cx * FP);
                segY[i] = Math.round(cy * FP);
                if (nextX[i] !== u.fx || nextY[i] !== u.fy) corrected++;
            }

            // Units without a contact have consumed their entire segment and are stationary
            // for later sub-passes; units with a contact continue from their contact point.
            for (let i = 0; i < n; i++) {
                const u = units[i];
                if (!u?.alive) continue;
                if (bestOther[i] < 0) {
                    segX[i] = u.fx;
                    segY[i] = u.fy;
                    continue;
                }
                u.fx = nextX[i];
                u.fy = nextY[i];
                u.x = u.fx / FP;
                u.y = u.fy / FP;
                this.navigation.motion.constrain(u);
            }
            totalCorrections += corrected;
            if (perf) {
                perf.collisionSweptCorrectionUnits += corrected;
                if (!corrected) perf.collisionSweptNoCorrectionPasses++;
            }
            if (!corrected) break;
        }
        return totalCorrections;
    }

    resolveSolidEmergence(source) {
        if (!source?.alive) return 0;
        const sourceRadius = this.radiusFP(source),
            reach = (sourceRadius + this.maxUnitRadius + 2 * FP) / FP;
        const candidates = [];
        for (const idx of this.nearbyUnits(source.x, source.y, reach)) {
            const other = this.units[idx];
            if (
                !other?.alive ||
                other.id === source.id ||
                this.isAlliedCollisionUnit(source, other)
            )
                continue;
            candidates.push(idx);
        }
        candidates.sort(
            (ia, ib) =>
                String(this.units[ia]?.id || '').localeCompare(String(this.units[ib]?.id || '')) ||
                ia - ib,
        );
        let moved = 0;
        for (const idx of candidates) {
            const other = this.units[idx],
                otherRadius = this.radiusFP(other),
                min = sourceRadius + otherRadius + 1;
            let dx = other.fx - source.fx,
                dy = other.fy - source.fy,
                d2 = dx * dx + dy * dy;
            if (d2 >= min * min) continue;
            let nx, ny, dist;
            if (d2 === 0) {
                const f = this.fallbackNormal(source, other);
                nx = f[0];
                ny = f[1];
                dist = 0;
            } else {
                dist = Math.max(1, Math.floor(Math.sqrt(d2)));
                nx = Math.trunc((dx * COLLISION_NORMAL) / dist);
                ny = Math.trunc((dy * COLLISION_NORMAL) / dist);
            }
            const penetration = min - dist;
            other.fx = RangeUtil.clamp(
                other.fx + Math.trunc((nx * penetration) / COLLISION_NORMAL),
                otherRadius,
                this.world.width * FP - otherRadius,
            );
            other.fy = RangeUtil.clamp(
                other.fy + Math.trunc((ny * penetration) / COLLISION_NORMAL),
                otherRadius,
                this.world.height * FP - otherRadius,
            );
            other.x = other.fx / FP;
            other.y = other.fy / FP;
            this.syncUnitSpatial(other);
            moved++;
        }
        return moved;
    }

    nonAlliedPenetrationOwner(ai, bi) {
        const units = this.units,
            a = units[ai],
            b = units[bi];

        // Cross-team crowd pressure never transfers through the contact.
        // Recovery moves the unit whose own motion entered the opposing solid.
        const asx = this.collisionStartFx[ai],
            asy = this.collisionStartFy[ai];
        const bsx = this.collisionStartFx[bi],
            bsy = this.collisionStartFy[bi];
        let dx = bsx - asx,
            dy = bsy - asy;
        if (dx === 0 && dy === 0) {
            const f = this.fallbackNormal(a, b);
            dx = f[0];
            dy = f[1];
        }
        const avx = a.fx - asx,
            avy = a.fy - asy,
            bvx = b.fx - bsx,
            bvy = b.fy - bsy;
        const approachA = avx * dx + avy * dy;
        const approachB = -(bvx * dx + bvy * dy);
        if (approachA > approachB) return ai;
        if (approachB > approachA) return bi;

        const moveA = avx * avx + avy * avy,
            moveB = bvx * bvx + bvy * bvy;
        if (moveA > moveB) return ai;
        if (moveB > moveA) return bi;

        // Exact ties are deterministic only; they do not transmit displacement to the other unit.
        return String(a.id || '') <= String(b.id || '') ? ai : bi;
    }

    enforceNonAlliedNoOverlap(radii, maxRadius, maxPasses = 4) {
        const units = this.units,
            n = units.length;
        let total = 0;
        const perf = this._perfCollect;
        if (perf) perf.collisionHardFixCalls++;
        for (let pass = 0; pass < maxPasses; pass++) {
            if (perf) perf.collisionHardFixPasses++;
            for (let i = 0; i < n; i++) {
                const u = units[i];
                this.collisionSegmentFx[i] = u?.fx ?? 0;
                this.collisionSegmentFy[i] = u?.fy ?? 0;
            }
            const eligible = this.hardFixSapEligible;
            eligible.length = 0;
            let sx = 0,
                sy = 0,
                sxx = 0,
                syy = 0;
            for (let i = 0; i < n; i++) {
                const u = units[i];
                if (!u?.alive || radii[i] <= 0) continue;
                eligible.push(i);
                sx += u.fx;
                sy += u.fy;
                sxx += u.fx * u.fx;
                syy += u.fy * u.fy;
            }
            const count = eligible.length || 1,
                vx = Math.max(0, sxx / count - (sx / count) * (sx / count)),
                vy = Math.max(0, syy / count - (sy / count) * (sy / count));
            let axis = this.hardFixSapAxis || 'x';
            const current = axis === 'x' ? vx : vy,
                other = axis === 'x' ? vy : vx;
            // 25% hysteresis prevents near-equal diagonal distributions from throwing away
            // the temporally coherent ordering for a marginal variance difference.
            if (other > current * 1.25) axis = axis === 'x' ? 'y' : 'x';
            const axisChanged = axis !== this.hardFixSapAxis;
            this.hardFixSapAxis = axis;
            const coord = (i) => (axis === 'x' ? units[i].fx : units[i].fy);
            const otherCoord = (i) => (axis === 'x' ? units[i].fy : units[i].fx);
            if (this.hardFixSapMarks.length < n)
                this.hardFixSapMarks = new Uint32Array(
                    Math.max(n, this.collisionRadii.length || n),
                );
            let epoch = (this.hardFixSapEpoch + 2) >>> 0;
            if (epoch < 2) {
                this.hardFixSapMarks.fill(0);
                epoch = 2;
            }
            this.hardFixSapEpoch = epoch;
            const marks = this.hardFixSapMarks;
            for (const i of eligible) marks[i] = epoch;
            let order = this.hardFixSapWorkOrder;
            order.length = 0;
            if (!axisChanged && this.hardFixSapOrder.length) {
                for (const i of this.hardFixSapOrder)
                    if (marks[i] === epoch) {
                        order.push(i);
                        marks[i] = epoch + 1;
                    }
                for (const i of eligible) if (marks[i] === epoch) order.push(i);
                for (let i = 1; i < order.length; i++) {
                    const cur = order[i],
                        key = coord(cur) - radii[cur];
                    let j = i - 1;
                    while (j >= 0) {
                        const prev = order[j],
                            pk = coord(prev) - radii[prev];
                        if (pk < key || (pk === key && prev < cur)) break;
                        order[j + 1] = prev;
                        j--;
                    }
                    order[j + 1] = cur;
                }
            } else {
                for (const i of eligible) order.push(i);
                order.sort((ia, ib) => coord(ia) - radii[ia] - (coord(ib) - radii[ib]) || ia - ib);
            }
            const saved = this.hardFixSapOrder;
            saved.length = order.length;
            for (let q = 0; q < order.length; q++) saved[q] = order[q];
            const pairs = this.hardFixSapPairs;
            pairs.length = 0;
            if (this.hardFixSapSideNext.length < n) {
                this.hardFixSapSideNext = new Int32Array(n);
                this.hardFixSapSidePrev = new Int32Array(n);
            }
            const heads = this.hardFixSapSideHeads,
                next = this.hardFixSapSideNext,
                prev = this.hardFixSapSidePrev,
                heaps = this.hardFixSapSideHeaps;
            heads.fill(-1);
            for (const heap of heaps) heap.length = 0;
            const heapLess = (ia, ib) => {
                const ea = coord(ia) + radii[ia],
                    eb = coord(ib) + radii[ib];
                return ea < eb || (ea === eb && ia < ib);
            };
            const heapPush = (heap, value) => {
                let i = heap.length;
                heap.push(value);
                while (i > 0) {
                    const p = (i - 1) >> 1;
                    if (!heapLess(value, heap[p])) break;
                    heap[i] = heap[p];
                    i = p;
                }
                heap[i] = value;
            };
            const heapPop = (heap) => {
                const root = heap[0],
                    last = heap.pop();
                if (heap.length) {
                    let i = 0;
                    while (true) {
                        const left = i * 2 + 1;
                        if (left >= heap.length) break;
                        const right = left + 1,
                            child =
                                right < heap.length && heapLess(heap[right], heap[left])
                                    ? right
                                    : left;
                        if (!heapLess(heap[child], last)) break;
                        heap[i] = heap[child];
                        i = child;
                    }
                    heap[i] = last;
                }
                return root;
            };
            const sideIndex = (side) => (side === 0 ? 0 : side === 1 ? 1 : 2);
            const unlink = (group, index) => {
                const p = prev[index],
                    q = next[index];
                if (p >= 0) next[p] = q;
                else heads[group] = q;
                if (q >= 0) prev[q] = p;
                prev[index] = next[index] = -1;
            };
            for (const bi of order) {
                const minB = coord(bi) - radii[bi],
                    biGroup = sideIndex(units[bi].side);
                for (let group = 0; group < 3; group++) {
                    // Player units on the same side are always allied; neutral/other-side
                    // units retain the existing isAlliedCollisionUnit semantics.
                    if (group === biGroup && biGroup !== 2) continue;
                    const heap = heaps[group];
                    while (heap.length && coord(heap[0]) + radii[heap[0]] < minB)
                        unlink(group, heapPop(heap));
                    for (let ai = heads[group]; ai >= 0; ai = next[ai]) {
                        if (perf) perf.collisionHardFixActivePairTests++;
                        const a = units[ai],
                            bb = units[bi];
                        if (this.isAlliedCollisionUnit(a, bb)) continue;
                        const min = radii[ai] + radii[bi];
                        if (Math.abs(otherCoord(ai) - otherCoord(bi)) >= min) continue;
                        if (UnitLeapAttack.separated(this, a, bb)) continue;
                        if (perf) perf.collisionHardFixCandidates++;
                        const owner = this.nonAlliedPenetrationOwner(ai, bi);
                        pairs.push(owner * (n + 1) + (owner === ai ? bi : ai));
                    }
                }
                const groupHeap = heaps[biGroup],
                    head = heads[biGroup];
                prev[bi] = -1;
                next[bi] = head;
                if (head >= 0) prev[head] = bi;
                heads[biGroup] = bi;
                heapPush(groupHeap, bi);
            }
            pairs.sort((a, b) => a - b);
            let changed = 0;
            const pairBase = n + 1;
            for (let q = 0; q < pairs.length; q++) {
                const packed = pairs[q],
                    i = Math.floor(packed / pairBase),
                    j = packed - i * pairBase;
                const u = units[i],
                    o = units[j],
                    ox = this.collisionSegmentFx[j],
                    oy = this.collisionSegmentFy[j];
                const min = radii[i] + radii[j],
                    dx = u.fx - ox,
                    dy = u.fy - oy,
                    d2 = dx * dx + dy * dy;
                if (d2 >= min * min) continue;
                let nx, ny, dist;
                if (d2 === 0) {
                    const f = this.fallbackNormal(u, o);
                    nx = f[0];
                    ny = f[1];
                    dist = 0;
                } else {
                    dist = Math.max(1, Math.floor(Math.sqrt(d2)));
                    nx = Math.trunc((dx * COLLISION_NORMAL) / dist);
                    ny = Math.trunc((dy * COLLISION_NORMAL) / dist);
                }
                const pen = min - dist + 1,
                    ur = radii[i];
                u.fx = RangeUtil.clamp(
                    u.fx + Math.trunc((nx * pen) / COLLISION_NORMAL),
                    ur,
                    this.world.width * FP - ur,
                );
                u.fy = RangeUtil.clamp(
                    u.fy + Math.trunc((ny * pen) / COLLISION_NORMAL),
                    ur,
                    this.world.height * FP - ur,
                );
                u.x = u.fx / FP;
                u.y = u.fy / FP;
                changed++;
                total++;
            }
            if (!changed) break;
        }
        return total;
    }

    resetTerrainMotionOrigin(u) {
        this.navigation.motion.remember(u, false);
        const i = this.unitIndexById.get(u.id);
        if (i != null && i < this.collisionStartCount) {
            this.collisionStartFx[i] = u.fx;
            this.collisionStartFy[i] = u.fy;
        }
    }
    constrainSurfaceContacts() {
        let changed = 0;
        for (const u of this.units) if (u?.alive && this.navigation.motion.constrain(u)) changed++;
        return changed;
    }
    // segmentStart: record where this pass starts as the segment the hostile/terrain sweep checks afterwards.
    // Units live in the collision grid by fixed-point centre; `maxRadius` widens soft-separation queries so a
    // small circle still finds a large possible partner.
    rebuildCollisionGrid(units, maxRadius) {
        const grid = this.collisionGrid;
        grid.clear();
        this.collisionGridMaxRadius = Math.max(0, Math.trunc(Number(maxRadius) || 0));
        for (let i = 0; i < units.length; i++) {
            const u = units[i];
            if (u.alive) grid.insert(i, u.fx, u.fy);
        }
    }
    // Each swept circle is inserted with its own bounds, in the coarse grid's cell order, so a query returns
    // candidates in the same order the coarse traversal would. Views hold only non-allies of side 0 / side 1.
    rebuildSweepGrid(units, radii, segX, segY, coarse) {
        const swept = this.collisionSweepGrid;
        swept.clear();
        if (this.collisionSweepEndCell.length < units.length)
            this.collisionSweepEndCell = new Int32Array(
                Math.max(units.length, this.collisionSweepEndCell.length * 2, 64),
            );
        const endCell = this.collisionSweepEndCell;
        for (let key = 0; key < coarse.cellTotal; key++)
            for (const i of coarse.cellItems(key)) {
                const u = units[i];
                if (!u?.alive || radii[i] <= 0) continue;
                endCell[i] = key;
                swept.insert(
                    i,
                    Math.min(segX[i], u.fx) - radii[i] - 1,
                    Math.min(segY[i], u.fy) - radii[i] - 1,
                    Math.max(segX[i], u.fx) + radii[i] + 1,
                    Math.max(segY[i], u.fy) + radii[i] + 1,
                    (u.side !== 0 ? 1 : 0) | (u.side !== 1 ? 2 : 0),
                );
            }
    }
    sweepCandidates(i, coarse, minCx, maxCx, minCy, maxCy, attackerSide) {
        const out = this.collisionSweepOut || (this.collisionSweepOut = []),
            endCell = this.collisionSweepEndCell;
        this.collisionSweepGrid.queryOverlaps(
            i,
            out,
            attackerSide === 0 || attackerSide === 1 ? attackerSide : -1,
            i,
        );
        let write = 0;
        for (let k = 0; k < out.length; k++) {
            const j = out[k],
                key = endCell[j],
                x = key % coarse.cols,
                y = Math.floor(key / coarse.cols);
            if (x < minCx || x > maxCx || y < minCy || y > maxCy) continue;
            out[write++] = j;
        }
        out.length = write;
        return out;
    }
    resolveAlliedSoftSeparation(radii, maxRadius, segmentStart = true) {
        const units = this.units,
            n = units.length;
        if (!n) return 0;
        const perf = this._perfCollect,
            now = perf ? () => performance.now() : null;
        const grid = this.collisionGrid,
            candidates = this.collisionCandidateBuffer;
        const masses = this.collisionMasses;
        const dxA = this.collisionDx,
            dyA = this.collisionDy,
            cnt = this.collisionCnt;
        let mark = perf ? now() : 0;
        this.rebuildCollisionGrid(units, maxRadius);
        dxA.fill(0, 0, n);
        dyA.fill(0, 0, n);
        cnt.fill(0, 0, n);
        if (segmentStart)
            for (let i = 0; i < n; i++) {
                const u = units[i];
                this.collisionSegmentFx[i] = u?.fx ?? 0;
                this.collisionSegmentFy[i] = u?.fy ?? 0;
            }
        if (perf) {
            perf.collisionGridBuildMs += now() - mark;
            perf.collisionSoftPasses++;
        }

        mark = perf ? now() : 0;
        for (let i = 0; i < n; i++) {
            const a = units[i];
            if (!a?.alive || radii[i] <= 0) continue;
            grid.queryCircle(a.fx, a.fy, radii[i] + this.collisionGridMaxRadius, candidates);
            for (let k = 0; k < candidates.length; k++) {
                const j = candidates[k];
                if (j <= i) continue;
                const b = units[j];
                if (radii[j] <= 0) continue;
                if (!b?.alive) continue;
                if (perf) perf.collisionPairs++;
                if (!this.isAlliedCollisionUnit(a, b)) continue;
                const min = radii[i] + radii[j];
                let dx = b.fx - a.fx,
                    dy = b.fy - a.fy;
                const d2 = dx * dx + dy * dy;
                if (d2 >= min * min) continue;
                let nx, ny, dist;
                if (d2 === 0) {
                    [nx, ny] = this.fallbackNormal(a, b);
                    dist = 0;
                } else {
                    dist = Math.max(1, Math.floor(Math.sqrt(d2)));
                    nx = Math.trunc((dx * COLLISION_NORMAL) / dist);
                    ny = Math.trunc((dy * COLLISION_NORMAL) / dist);
                }
                const pen = min - dist;
                if (pen <= 0) continue;
                const softPen = Math.max(1, Math.trunc(pen * ALLY_SOFT_CORRECTION_FRACTION));
                const ma = masses[i],
                    mb = masses[j],
                    total = Math.max(1, ma + mb);
                const pa = Math.trunc((softPen * mb) / total),
                    pb = softPen - pa;
                dxA[i] -= Math.trunc((nx * pa) / COLLISION_NORMAL);
                dyA[i] -= Math.trunc((ny * pa) / COLLISION_NORMAL);
                dxA[j] += Math.trunc((nx * pb) / COLLISION_NORMAL);
                dyA[j] += Math.trunc((ny * pb) / COLLISION_NORMAL);
                cnt[i]++;
                cnt[j]++;
                if (perf) {
                    perf.collisionSoftContacts++;
                    perf.collisionOverlaps++;
                }
            }
        }
        if (perf) perf.collisionPairScanMs += now() - mark;

        mark = perf ? now() : 0;
        let moved = 0,
            capped = 0;
        for (let i = 0; i < n; i++) {
            const u = units[i];
            if (!u?.alive || !cnt[i]) continue;
            let cx = Math.trunc(dxA[i] / cnt[i]),
                cy = Math.trunc(dyA[i] / cnt[i]);
            const radius = radii[i],
                speed = Math.max(0, Number(UnitDefinition.get(u.type)?.speed) || 0);
            const idleAllowance = Math.round(radius * ALLY_SOFT_IDLE_RADIUS_FRACTION);
            const speedAllowance = Math.round((speed / this.tps) * FP * ALLY_SOFT_SPEED_FRACTION);
            const maxCorrection = Math.max(
                1,
                Math.min(
                    Math.round(radius * ALLY_SOFT_MAX_RADIUS_FRACTION),
                    Math.max(idleAllowance, speedAllowance),
                ),
            );
            const len2 = cx * cx + cy * cy;
            if (len2 > maxCorrection * maxCorrection) {
                const len = Math.max(1, Math.sqrt(len2)),
                    scale = maxCorrection / len;
                cx = Math.trunc(cx * scale);
                cy = Math.trunc(cy * scale);
                capped++;
            }
            if (cx === 0 && cy === 0) continue;
            const oldFx = u.fx,
                oldFy = u.fy;
            u.fx = RangeUtil.clamp(u.fx + cx, radius, this.world.width * FP - radius);
            u.fy = RangeUtil.clamp(u.fy + cy, radius, this.world.height * FP - radius);
            u.x = u.fx / FP;
            u.y = u.fy / FP;
            if (u.fx !== oldFx || u.fy !== oldFy) moved++;
        }
        if (perf) {
            perf.collisionSoftApplyMs += now() - mark;
            perf.collisionSoftMovedUnits = moved;
            perf.collisionSoftCappedUnits = capped;
        }
        return moved;
    }
    solveContacts() {
        const units = this.units,
            n = units.length;
        if (!n) {
            this.navigation.motion.solveImpulseStep(this.collisionStartFx, this.collisionStartFy);
            return;
        }
        const perf = this._perfCollect,
            now = perf ? () => performance.now() : null;
        let mark = perf ? now() : 0;
        this.constrainSurfaceContacts();

        this.ensureCollisionBuffers(n);
        const radii = this.collisionRadii,
            masses = this.collisionMasses;
        let maxRadius = FP;
        for (let i = 0; i < n; i++) {
            const u = units[i],
                ud = UnitDefinition.get(u.type);
            if (
                !u.alive ||
                u.heroRoll ||
                FruitHeroAttack.blocksMovement(u) ||
                ud?.crowdCollision === false
            ) {
                radii[i] = 0;
                masses[i] = 0;
                continue;
            }
            radii[i] = this.radiusFP(u);
            masses[i] = this.mass(u);
            if (radii[i] > maxRadius) maxRadius = radii[i];
        }
        if (perf) perf.collisionPrepMs += now() - mark;

        this.navigation.motion.solveImpulseStep(this.collisionStartFx, this.collisionStartFy);

        // Pure steering keeps its existing nonpenetration policy; dynamic pairs have already consumed one common clock.
        mark = perf ? now() : 0;
        this.resolveNonAlliedSurfaceMotion(
            this.collisionStartFx,
            this.collisionStartFy,
            radii,
            maxRadius,
            4,
        );
        if (perf) perf.collisionSweptMotionMs += now() - mark;

        // Jacobi ally passes (A011·A012, budmori separationIterations): one pass, bounded by radius and tick
        // speed, loses to a crowd that all walks toward the same front, so repeat until nothing moves.
        let softMoved = 0;
        for (let pass = 0; pass < ALLY_SOFT_ITERATIONS; pass++) {
            const moved = this.resolveAlliedSoftSeparation(radii, maxRadius, pass === 0);
            softMoved += moved;
            if (!moved) break;
        }
        if (softMoved) {
            // One sweep from the first pass's start keeps the combined nudge from crossing a hostile solid or terrain.
            mark = perf ? now() : 0;
            this.resolveNonAlliedSurfaceMotion(
                this.collisionSegmentFx,
                this.collisionSegmentFy,
                radii,
                maxRadius,
                3,
            );
            if (perf) perf.collisionSweptMotionMs += now() - mark;
            mark = perf ? now() : 0;
            const surfaceCorrections = this.constrainSurfaceContacts();
            if (perf) {
                perf.collisionTerrainMs += now() - mark;
                perf.collisionOverlaps += surfaceCorrections;
            }
        }

        // This single final SAP call retains zero-motion hostile overlap recovery. It is
        // no longer repeated once per allied convergence iteration.
        mark = perf ? now() : 0;
        const hardFixes = this.enforceNonAlliedNoOverlap(radii, maxRadius, 4);
        if (perf) {
            perf.collisionHardFixMs += now() - mark;
            perf.collisionHardFixCorrections += hardFixes;
            if (!hardFixes) perf.collisionHardFixNoOpCalls++;
        }
        if (hardFixes) {
            if (perf) perf.collisionOverlaps += hardFixes;
            for (let i = 0; i < n; i++) if (units[i]?.alive) this.syncUnitSpatial(units[i]);
            mark = perf ? now() : 0;
            this.constrainSurfaceContacts();
            if (perf) perf.collisionTerrainMs += now() - mark;
        }
    }

    updateBalanceTelemetry(winner = null) {
        const b = this.balanceStats || (this.balanceStats = createLocalBalanceStats());

        // Events are presentation/runtime data, not exported authoritative state. Consume them
        // once here to build local match diagnostics without influencing any gameplay decision.
        for (const e of this.events) {
            const side = Number(e?.side);
            if (e?.type === 'captureComplete' && (side === 0 || side === 1)) {
                b.captures[side]++;
                if (b.firstCaptureTick[side] == null) b.firstCaptureTick[side] = this.tick;
            } else if (e?.type === 'buildingDeath' && (side === 0 || side === 1)) {
                b.buildingLosses[side]++;
                if (e.isOutpost) b.outpostLosses[side]++;
            } else if (
                e?.type === 'hit' &&
                (e.sourceSide === 0 || e.sourceSide === 1) &&
                (side === 0 || side === 1) &&
                e.sourceSide !== side &&
                b.firstCombatTick == null
            ) {
                b.firstCombatTick = this.tick;
            }
        }

        if (winner && b.gameEndTick == null) {
            b.gameEndTick = this.tick;
            b.winner = winner;
        }

        if (this.tick % this.msTicks(BALANCE_SAMPLE_EVERY_MS) !== 0) return;

        const army = [0, 0];
        for (const u of this.units) if (u?.alive && (u.side === 0 || u.side === 1)) army[u.side]++;
        for (const side of [0, 1]) {
            b.currentArmy[side] = army[side];
            b.armyTotal[side] += army[side];
            b.armyPeak[side] = Math.max(b.armyPeak[side], army[side]);
        }
        b.samples++;
        b.lastSampleTick = this.tick;

        if (this.tick % SimulationTiming.msToTicks(BALANCE_HISTORY_EVERY_MS, this.tps) === 0) {
            b.history.push({
                tick: this.tick,
                tps: this.tps,
                wallet: this.wallet.slice(),
                army: army.slice(),
                captures: b.captures.slice(),
            });
            if (b.history.length > BALANCE_HISTORY_MAX)
                b.history.splice(0, b.history.length - BALANCE_HISTORY_MAX);
        }
    }
    cleanupDeadEntities() {
        // Death information is already emitted as an event in the death tick.
        // Keeping every corpse forever makes target scans, snapshots and checksums grow without bound.
        if (this.tick % this.msTicks(DEAD_ENTITY_CLEANUP_MS) !== 0) return;

        this.units = this.units.filter((u) => u.alive || u.impactMotion);

        // Destroyed ordinary buildings no longer participate in any simulation.
        // Base death ends the match before this matters; outpost capture state is released on death.
        const beforeBuildings = this.buildings.length;
        this.buildings = this.buildings.filter((b) => b.alive !== false);
        if (this.buildings.length !== beforeBuildings) this.markBuildingSpatialDirty();
    }

    step() {
        if (this.disposed) throw new Error('종료된 StrategySim은 다시 진행할 수 없습니다.');
        const started = typeof performance !== 'undefined' ? performance.now() : null;
        try {
            return this.stepSimulation();
        } finally {
            // Coarse timing covers every tick, including one-off commands and cold paths.
            // The detailed stage/candidate counters below remain sampled once per second.
            if (started !== null) {
                const ms = performance.now() - started,
                    p = this.perfStats;
                p.lastStepMs = ms;
                p.stepSamples = (p.stepSamples || 0) + 1;
                p.stepCumulativeMs = (p.stepCumulativeMs || 0) + ms;
                p.maxStepMs = Math.max(p.maxStepMs || 0, ms);
                p.ewmaStepMs = p.stepSamples > 1 ? p.ewmaStepMs * 0.8 + ms * 0.2 : ms;
            }
        }
    }
    stepSimulation() {
        const profile =
            (this.tick + 1) % this.msTicks(PERF_SAMPLE_EVERY_MS) === 0 &&
            typeof performance !== 'undefined';
        const now = profile ? () => performance.now() : null;
        const stepStart = profile ? now() : 0;
        this._perfCollect = profile
            ? {
                  spatialQueries: 0,
                  spatialCandidates: 0,
                  targetQueries: 0,
                  targetVisibilityRejects: 0,
                  sideSpatialQueries: 0,
                  visibilityChecks: 0,
                  collisionPairs: 0,
                  collisionOverlaps: 0,
                  collisionSoftPasses: 0,
                  collisionSoftContacts: 0,
                  collisionSoftMovedUnits: 0,
                  collisionSoftCappedUnits: 0,
                  buildingCollisionCandidates: 0,
                  collisionPrepMs: 0,
                  collisionGridBuildMs: 0,
                  collisionPairScanMs: 0,
                  collisionSoftApplyMs: 0,
                  collisionSweptMotionMs: 0,
                  collisionTerrainMs: 0,
                  collisionHardFixMs: 0,
                  collisionSweptCalls: 0,
                  collisionSweptActivePasses: 0,
                  collisionSweptZeroMotionCalls: 0,
                  collisionSweptEmptyPasses: 0,
                  collisionSweptPairTests: 0,
                  collisionSweptHits: 0,
                  collisionSweptCorrectionUnits: 0,
                  collisionSweptNoCorrectionPasses: 0,
                  collisionHardFixCalls: 0,
                  collisionHardFixPasses: 0,
                  collisionHardFixActivePairTests: 0,
                  collisionHardFixCandidates: 0,
                  collisionHardFixCorrections: 0,
                  collisionHardFixNoOpCalls: 0,
                  combatTargetPickMs: 0,
                  combatTargetPickCalls: 0,
              }
            : null;

        this.tick++;
        this.events = [];

        CampaignMission.beforeCommands(this);
        const cmds = this.scheduled.get(this.tick) || [];
        for (const c of cmds) {
            const applied = this.applyCommand(c.actor, c.action) === true;
            this.commandReceipts.push({
                seq: c.seq,
                netcodeSequence: c.netcodeSequence,
                actor: c.actor,
                tick: this.tick,
                type: c.action.type,
                key: StableSerializationUtil.stableStringify(c.action),
                applied,
            });
            if (this.commandReceipts.length > 512) this.commandReceipts.shift();
        }
        this.scheduled.delete(this.tick);

        let mark = profile ? now() : 0;
        // One O(N) rebuild per tick replaces many O(N) target/id scans below.
        this.rebuildRuntimeIndexes();
        const indexMs = profile ? now() - mark : 0;

        mark = profile ? now() : 0;
        this.updateLaunchEconomy();
        this.updateCapturePoints();
        this.updateLaunchSalvos();
        let winner = null;
        const worldMs = profile ? now() - mark : 0;

        // Collision motion origin: world-state changes above are already authoritative
        // placement. Combat/impulse movement below is the motion that solid contacts clip.
        this.captureCollisionStepStarts();
        UnitLobAttack.beginStep(this);

        mark = profile ? now() : 0;
        LaunchImpact.update(this);
        const vision = [this.visionSources(0), this.visionSources(1)];
        const visionMs = profile ? now() - mark : 0;

        mark = profile ? now() : 0;
        this.updateBuildingCombat(vision);
        const pendingContactAttacks = [];
        for (const u of this.units) {
            if (!u.alive) continue;
            winner = this.updateCombat(u, vision, pendingContactAttacks) || winner;
        }
        const combatMs = profile ? now() - mark : 0;

        mark = profile ? now() : 0;
        this.solveContacts();
        winner = this.resolveContactAttacks(pendingContactAttacks, vision) || winner;
        for (const u of this.units) {
            this.navigation.motion.finishImpulseStep(u);
            const definition = UnitDefinition.get(u.type);
            if (
                definition?.leapAttack &&
                UnitLeapAttack.flush(this, u, definition.leapAttack, definition.atk) &&
                definition.selfDestruct?.onLeapLanding
            )
                UnitSelfDestructAttack.detonate(this, u, definition.selfDestruct);
        }
        const collisionMs = profile ? now() - mark : 0;

        // Projectile hits inject velocity at this boundary. Both horizontal and vertical integration start next tick.
        mark = profile ? now() : 0;
        for (const heroes of this.heroes)
            for (const type of LaunchRules.heroTypes) {
                const hero = heroes[type];
                if (hero?.unitId == null) continue;
                const unit = this.liveEntityRefById(hero.unitId, 'unit')?.entity;
                if (unit?.heroRoll) HeroRollAttack.advance(this, unit);
                if (unit?.fruitAttack) FruitHeroAttack.update(this, unit);
            }
        winner = this.updateProjectiles() || winner;
        UnitLobAttack.step(this);
        UnitThornAttack.update(this);
        LaunchImpact.deploy(this);
        this.resolveConstructionHits();
        HeroDeployment.settle(this);
        const projectileMs = profile ? now() - mark : 0;

        mark = profile ? now() : 0;
        // Combat damage reports are not victory authority. Resolve once from the final world state.
        winner = this.netcodeMatchResult?.winner || this.baseOutcome();
        const campaign = this.rules.campaign;
        if (
            this.campaignVolleyPractice &&
            !this.netcodeMatchResult &&
            (!winner || winner === 'host')
        ) {
            this.updateVolleyPractice();
            winner = this.campaignVolleyPractice.complete ? 'host' : null;
        }
        if (
            campaign?.defenseSeconds &&
            !campaign.mission?.waves?.length &&
            !this.netcodeMatchResult
        ) {
            const timeUp = this.tick >= campaign.defenseSeconds * this.tps;
            if (!timeUp && winner === 'host') winner = null;
            if (timeUp && campaign.mode === 'defend' && !winner) winner = 'host';
        }
        if (!this.netcodeMatchResult) winner = CampaignMission.resolve(this, winner);
        this.updateBalanceTelemetry(winner);
        this.cleanupDeadEntities();
        const postMs = profile ? now() - mark : 0;

        if (profile) {
            const total = now() - stepStart,
                p = this.perfStats,
                c = this._perfCollect;
            let aliveUnits = 0;
            for (const u of this.units) if (u.alive) aliveUnits++;
            p.sampleTick = this.tick;
            p.totalMs = total;
            p.indexMs = indexMs;
            p.worldMs = worldMs;
            p.visionMs = visionMs;
            p.combatMs = combatMs;
            p.projectileMs = projectileMs;
            p.collisionMs = collisionMs;
            p.postMs = postMs;
            p.collisionPrepMs = c.collisionPrepMs;
            p.collisionGridBuildMs = c.collisionGridBuildMs;
            p.collisionPairScanMs = c.collisionPairScanMs;
            p.collisionSoftApplyMs = c.collisionSoftApplyMs;
            p.collisionSweptMotionMs = c.collisionSweptMotionMs;
            p.collisionTerrainMs = c.collisionTerrainMs;
            p.collisionHardFixMs = c.collisionHardFixMs;
            p.collisionOtherMs = Math.max(
                0,
                collisionMs -
                    (c.collisionPrepMs +
                        c.collisionGridBuildMs +
                        c.collisionPairScanMs +
                        c.collisionSoftApplyMs +
                        c.collisionSweptMotionMs +
                        c.collisionTerrainMs +
                        c.collisionHardFixMs),
            );
            p.collisionSoftPasses = c.collisionSoftPasses;
            p.collisionSoftContacts = c.collisionSoftContacts;
            p.collisionSoftMovedUnits = c.collisionSoftMovedUnits;
            p.collisionSoftCappedUnits = c.collisionSoftCappedUnits;
            p.collisionSoftDetailedSamples = (p.collisionSoftDetailedSamples || 0) + 1;
            for (const key of [
                'collisionSweptCalls',
                'collisionSweptActivePasses',
                'collisionSweptZeroMotionCalls',
                'collisionSweptEmptyPasses',
                'collisionSweptPairTests',
                'collisionSweptHits',
                'collisionSweptCorrectionUnits',
                'collisionSweptNoCorrectionPasses',
                'collisionHardFixCalls',
                'collisionHardFixPasses',
                'collisionHardFixActivePairTests',
                'collisionHardFixCandidates',
                'collisionHardFixCorrections',
                'collisionHardFixNoOpCalls',
                'combatTargetPickMs',
                'combatTargetPickCalls',
            ])
                p[key] = c[key];
            p.combatOtherMs = Math.max(0, combatMs - c.combatTargetPickMs);
            p.aliveUnits = aliveUnits;
            p.projectiles = this.projectiles.length;
            p.peakAliveUnits = Math.max(p.peakAliveUnits || 0, aliveUnits);
            p.peakBuildings = Math.max(p.peakBuildings || 0, this.buildings.length);
            p.peakProjectiles = Math.max(p.peakProjectiles || 0, this.projectiles.length);
            p.spatialQueries = c.spatialQueries;
            p.spatialCandidates = c.spatialCandidates;
            p.targetQueries = c.targetQueries;
            p.targetVisibilityRejects = c.targetVisibilityRejects;
            p.sideSpatialQueries = c.sideSpatialQueries;
            p.visibilityChecks = c.visibilityChecks;
            p.collisionPairs = c.collisionPairs;
            p.collisionOverlaps = c.collisionOverlaps;
            p.buildingCollisionCandidates = c.buildingCollisionCandidates || 0;
        }
        this._perfCollect = null;
        return winner;
    }
    baseOutcome() {
        const alive = (side) =>
            this.buildings.some(
                (b) =>
                    b.alive !== false &&
                    b.hp > 0 &&
                    b.side === side &&
                    BuildingDefinition.isMainBase(b.type),
            );
        const host = alive(0),
            guest = alive(1);
        return host && guest ? null : host ? 'host' : guest ? 'guest' : 'draw';
    }
    mapFingerprint() {
        return HashUtil.hash(StableSerializationUtil.stableStringify(this.mapDescriptor));
    }
    checksum() {
        return RallyNetcode.hashBytes(RallyStateCodec.encode(this.exportState()))
            .toString(16)
            .padStart(8, '0');
    }
    exportState({ includeIdentity = true } = {}) {
        this.navigation?.sync();
        const source = { ...this, scheduled: [...this.scheduled.entries()] };
        delete source.units;
        delete source.buildings;
        delete source.projectiles;
        // SDK mementos reference these immutable definitions by match identity. Omit
        // them before capture/clone, rather than copying then discarding a large map.
        if (!includeIdentity) {
            delete source.rules;
            delete source.mapDescriptor;
        }
        const state = StrategySim.stateContract.capture(source, 'save');
        state.units = this.units.map((u) => u.toState('save'));
        state.buildings = this.buildings.map((b) => b.toState('save'));
        state.projectiles = this.projectiles.map((p) => p.toState('save'));
        return state;
    }
    importState(s, { rollback = false } = {}) {
        UnitResultStats.validate(s.unitResultStats);
        CampaignMission.validate(s, s.rules?.campaign?.mission);
        const retained = {
            mapDescriptor: this.mapDescriptor,
            rules: this.rules,
            decks: this.decks,
        };
        const retainedNavigation =
            rollback && this.navigation instanceof TerrainNavigation ? this.navigation : null;
        if (rollback) {
            for (const key of Object.keys(retained))
                if (
                    s[key] !== retained[key] &&
                    StableSerializationUtil.stableStringify(s[key] ?? null) !==
                        StableSerializationUtil.stableStringify(retained[key])
                )
                    throw new Error(`롤백의 ${key} 정의가 현재 경기와 다릅니다.`);
        }
        this.disposed = false;
        const source = { ...s };
        if (rollback) for (const key of Object.keys(retained)) delete source[key];
        else source.decks = LaunchRules.normalizeDeckPair(s.decks);
        const copy = StateValue.copy(source),
            scheduled = copy.scheduled || [];
        delete copy.scheduled;
        if (rollback) {
            Object.assign(copy, retained);
            for (const key of StrategySim.stateContract.keys(this, 'save'))
                if (!Object.prototype.hasOwnProperty.call(copy, key) && key !== 'scheduled')
                    delete this[key];
        }
        Object.assign(this, copy);
        if (!copy.campaignMission) delete this.campaignMission;
        StateValue.freeze(this.decks);
        StateValue.freeze(this.mapDescriptor);
        this.world = WorldContext.fromMap(this.mapDescriptor);
        this.tps = RangeUtil.clamp(
            Math.round(Number(this.rules?.simulation?.tps) || SIM_TPS),
            10,
            30,
        );
        this.units = (copy.units || []).map(Unit.fromState);
        this.buildings = (copy.buildings || []).map(Building.fromState);
        this.projectiles = (copy.projectiles || []).map(Projectile.fromState);
        this.scheduled = new Map(scheduled);
        this.events = [];
        SimulationRuntimeState.initialize(this);
        if (retainedNavigation && retainedNavigation.geometry === this.world.terrain) {
            this.navigation = retainedNavigation;
            this.navigation.motion = new UnitMotion(this.navigation);
        }
        this.navigation.sceneTick = -1;
        this.navigation.sync();
        this.rebuildRuntimeIndexes();
    }
    snapshot() {
        const started = performance.now();
        try {
            this.navigation?.sync();
            return {
                tick: this.tick,
                tps: this.tps,
                decks: StateValue.copy(this.decks),
                mapDescriptor: this.mapDescriptor,
                launchDeployments: StateValue.copy(this.launchDeployments),
                campaignMission: CampaignMission.snapshot(this.campaignMission),
                heroes: StateValue.copy(this.heroes),
                heroRecovery: StateValue.copy(this.heroRecovery),
                heroReserveHp: this.heroes.map((heroes, side) =>
                    Object.fromEntries(
                        Object.keys(heroes).map((type) => [
                            type,
                            HeroDeployment.reserveHp(this, side, type),
                        ]),
                    ),
                ),
                unitThornProjectiles: StateValue.copy(
                    this.unitThornProjectiles.filter((p) => p.startTick <= this.tick),
                ),
                wallet: this.wallet.slice(),
                premiumWallet: this.premiumWallet.slice(),
                baseProducers: StateValue.copy(this.baseProducers),
                launchRangeLevel: this.launchRangeLevel.slice(),
                launchStats: StateValue.copy(this.launchStats),
                unitResultStats: StateValue.copy(this.unitResultStats),
                flags: CloneUtil.clone(this.flags),
                capturePoints: CloneUtil.clone(this.capturePoints),
                units: this.units.map((u) => u.toState('view')),
                buildings: this.buildings.map((b) => b.toState()),
                projectiles: this.projectiles.map((p) => p.toState()),
                unitLobProjectiles: this.unitLobProjectiles
                    .filter((p) => p.startTick <= this.tick)
                    .map((p) => ({
                        id: p.id,
                        side: p.side,
                        sourceId: p.sourceId,
                        sourceType: p.sourceType,
                        startTick: p.startTick,
                        x: p.x,
                        y: p.y,
                        zFP: p.zFP,
                        heightFP: Math.max(
                            0,
                            p.zFP - Math.round(this.world.terrain.surfaces.heightAt(p.x, p.y) * FP),
                        ),
                        vxFP: p.vxFP,
                        vyFP: p.vyFP,
                        vzFP: p.vzFP,
                        landedAtTick: p.landedAtTick,
                        explodeTick: p.explodeTick,
                        grounded: p.grounded,
                    })),
                events: StateValue.copy(this.events),
            };
        } finally {
            const perf = this.perfStats;
            perf.snapshotMs = performance.now() - started;
            perf.snapshotCumulativeMs = (perf.snapshotCumulativeMs || 0) + perf.snapshotMs;
            perf.maxSnapshotMs = Math.max(perf.maxSnapshotMs, perf.snapshotMs);
            perf.snapshotSamples++;
        }
    }
}

export { StrategySim };
