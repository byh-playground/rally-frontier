// The deterministic lockstep strategy simulation.
import { GameRuleDefinition, RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { BuildPrerequisitePolicy, Building, DelayedEffectState, Projectile, SupplyPolicy, TerrainQuery, Unit, VisionField } from './entities.js';
import { NEUTRAL_BEHAVIORS, OBJECTIVE_BEHAVIORS, UNIT_COMBAT_BEHAVIORS } from './unit-behaviors.js';
import { ChargedSkillMixin, CloakAuraMixin, DeployableCombatMixin, ObjectiveMixin, PullerMixin, ShieldProviderMixin, StealthMixin } from './unit-mixins.js';
import { BurrowableMixin, ChargedSkillGeometry, ChargerMixin, HealerMixin, InterceptorMixin, LeapableMixin, MovementComponent, StateContract, StateValue, SummonerMixin } from './components.js';
import { RallyStateCodec } from '../session/game-session.js';
import { LaunchRules } from './launch-rules.js';
import { DeterministicBuildingSpatialGrid, DeterministicCollisionGrid, DeterministicSweptCollisionGrid, DeterministicUnitSpatialGrid } from './spatial-grids.js';
import { ConnectionSideUtil, StableSerializationUtil } from '../net/lobby-codec.js';
import { CloneUtil, HashUtil, MapGeneration } from './map-generation.js';
import { BalanceValidation } from '../definitions/balance.js';
import { ARMOR_REDUCTION_PCT_PER_LEVEL, ATTACK_UPGRADE_PCT_PER_LEVEL, MAX_ARMOR_UPGRADE, MAX_ATTACK_UPGRADE, ResearchDefinition, UnitSpecialResearchDefinition } from '../definitions/research.js';
import { BuildingDefinition, buildingHasBuilderApproach, buildingHasReachableBuilder, buildingPlacementInsideWorld, buildingPlacementSeparation } from '../definitions/buildings.js';
import { DAMAGE_CLASS_MATRIX, DefenseCardDefinition, VALID_DAMAGE_CLASSES } from '../definitions/decks.js';
import { ECONOMY_WORKER_DEF, ECONOMY_WORKER_TYPE, UNIT_RUNTIME_GEOMETRY, UnitDefinition } from '../definitions/units.js';
import { CAPTURED_OBJECTIVE_SCALE, CampDefinition, MAIN_OBJECTIVE_RESPAWN_MS, NEUTRAL_SIDE, NeutralCampPolicy, OBJECTIVE_DRAGON_BREATH_PHASE, OBJECTIVE_DRAGON_BREATH_PHASES, PassiveCardDefinition, SpellDefinition, TACTICAL_ECON_REWARDS, UnitCompositionDefinition } from '../definitions/cards.js';
import { MapGeometry } from './map-geometry.js';
import { BUILD_START_HP_PCT, CAPTURE_DECAY_PER_TICK, CAPTURE_DURATION_MS, CAPTURE_RADIUS, COMBAT_IDEAL_RANGE_REPOSITION_MARGIN, COMBAT_TARGET_REFRESH_MS, COMBAT_TARGET_STICKINESS_PCT, DEAD_ENTITY_CLEANUP_MS, DEFAULT_ARTILLERY_MOVE_RECOVERY_MS, DEFAULT_ATTACK_WINDUP_MS, DEFAULT_MELEE_MOVE_RECOVERY_MS, DEFAULT_RANGED_MOVE_RECOVERY_MS, DEFENSE_CLUSTER_RADIUS, MINERAL_BUILD_MARGIN, NAV_BUILDING_MARGIN, PRODUCTION_CLUSTER_RADIUS, PRODUCTION_CLUSTER_SPEED_PCT, SPAWN_CLEARANCE, SPAWN_UNIT_GAP, SPELL_CAST_MARGIN, SPELL_MASTERY_MAX, SPELL_SLOT_MAX, TACTICAL_CHEST_OPTION_COUNT } from '../definitions/combat-rules.js';
import { PerformanceTelemetry } from '../diagnostics/performance-telemetry.js';
import { FormationDefinition } from '../definitions/formations.js';
import { ALLY_SOFT_CORRECTION_FRACTION, ALLY_SOFT_IDLE_RADIUS_FRACTION, ALLY_SOFT_MAX_RADIUS_FRACTION, ALLY_SOFT_SPEED_FRACTION, BALANCE_HISTORY_EVERY_MS, BALANCE_HISTORY_MAX, BALANCE_SAMPLE_EVERY_MS, COLLISION_NORMAL, COLLISION_RADIUS_SCALE, COLLISION_SPATIAL_CELL, DIVE_BACKLINE_ROLES, GAS_ASSIGNMENT_MAX, GAS_BUILD_SNAP_RADIUS, GAS_DEPLETED_MINE_AMOUNT, GAS_MINE_AMOUNT, PERF_SAMPLE_EVERY_MS, SIM_SPATIAL_CELL, STARTING_WORKER_COUNT, TERRAIN_ATTACK_REVEAL_MS, WORKER_CARRY_CAP, WORKER_COST, WORKER_QUEUE_LIMIT } from '../definitions/world-rules.js';
import { WorldContext } from './world-context.js';
import { AdaptiveNavigationDemand, InteractionGeometry, NavigationGoal, SurfaceContactGeometry, SurfaceMotion, SweptCircleContact, TerrainNavigation } from './navigation.js';
import { FP } from '../core/config.js';
import { RallyNetcode } from '../core/gamekit.js';
import { CampaignMapDefinition, CampaignMissionDefinition, CampaignOutcomeRules, CampaignScriptRuntime, DebugScenarioHarness, SimulationTiming } from '../main.js';

class SimulationRuntimeState{
  static collision(sim){
    sim.collisionGrid=new DeterministicCollisionGrid(COLLISION_SPATIAL_CELL,sim.world);
    sim.collisionCandidateBuffer=[];
    sim.collisionSweepGrid=new DeterministicSweptCollisionGrid(sim.world);
    sim.collisionMotion=null;
    for(const key of ["collisionRadii","collisionMasses","collisionDx","collisionDy","collisionStartFx","collisionStartFy","collisionSegmentFx","collisionSegmentFy","collisionNextFx","collisionNextFy","collisionBestOther"])sim[key]=new Int32Array(0);
    sim.collisionCnt=new Uint16Array(0);
    for(const key of ["collisionBestT","collisionBestNx","collisionBestNy"])sim[key]=new Float64Array(0);
    sim.collisionStartCount=0;
    sim.hardFixSapAxis="x";
    for(const key of ["hardFixSapOrder","hardFixSapEligible","hardFixSapWorkOrder","hardFixSapSweepActive","hardFixSapPairs"])sim[key]=[];
    sim.hardFixSapSideHeads=new Int32Array([-1,-1,-1]);sim.hardFixSapSideNext=new Int32Array(0);sim.hardFixSapSidePrev=new Int32Array(0);sim.hardFixSapSideHeaps=[[],[],[]];
    sim.hardFixSapMarks=new Uint32Array(0);sim.hardFixSapEpoch=1;
  }
  static spatial(sim){
    sim.unitSpatial=new DeterministicUnitSpatialGrid(SIM_SPATIAL_CELL,sim.world);
    sim.buildingSpatial=new DeterministicBuildingSpatialGrid(SIM_SPATIAL_CELL,sim.world);
    sim.buildingSpatialDirty=true;sim.buildingSpatialQueryBuffers=Array.from({length:16},()=>[]);sim.buildingSpatialQueryCursor=0;
    sim.maxBuildingRadius=Math.max(...Object.values(BuildingDefinition.all).map(d=>Number(d?.size)||35))+NAV_BUILDING_MARGIN;
    sim.unitById=new Map();sim.buildingById=new Map();sim.unitIndexById=new Map();sim.runtimeIndexTick=-1;
    sim.spatialQueryBuffers=Array.from({length:64},()=>[]);sim.spatialQueryCursor=0;
    // Scoped results are owned by the active query caller. Nested traversals
    // use a separate stack so they never alias a live rotating-ring result.
    sim.spatialQueryScopeBuffers=[];sim.spatialQueryScopeDepth=0;
    sim.aoeCandidateSpatialScratch=[];sim.aoeCandidateSpatialDepth=0;
    sim.maxUnitRadius=Math.max(...Object.values(UnitDefinition.all).map(d=>(d?.size||10)*COLLISION_RADIUS_SCALE));
    sim.targetLevelMemo=new WeakMap();
    sim.maxTauntRadius=Math.max(0,...Object.values(UnitDefinition.all).map(d=>d?.taunt?Number(d.tauntRadius)||0:0));
  }
  static visibility(sim){
    sim.cloakCacheTick=-1;sim.auraCloakedIds=new Set();
    sim.visionFields=[null,null];
  }
  static economy(sim){sim.economyCacheTick=-1;sim.workerGasAssignments=new Set();sim.validGasExtractorsBySide=[[],[]]}
  static initialize(sim,{newMatch=false}={}){
    sim.runtimeEpoch=(sim.runtimeEpoch||0)+1;
    this.collision(sim);this.spatial(sim);this.visibility(sim);this.economy(sim);
    sim.navigationDemandScope=null;sim.navigationRevision=newMatch?0:(Number.isSafeInteger(sim.navigationRevision)&&sim.navigationRevision>=0?sim.navigationRevision:0);sim.navigation=new TerrainNavigation(sim);
    sim.perfStats=PerformanceTelemetry.createLocalPerfStats();sim._perfCollect=null;
    if(newMatch||!sim.balanceStats)sim.balanceStats=PerformanceTelemetry.createLocalBalanceStats();
    sim.commandReceipts=[];
  }
  static invalidate(sim){
    sim.runtimeEpoch=(sim.runtimeEpoch||0)+1;
    this.visibility(sim);this.economy(sim);
    sim.runtimeIndexTick=-1;sim.spatialQueryCursor=0;sim.spatialQueryScopeDepth=0;sim.aoeCandidateSpatialDepth=0;sim.buildingSpatialQueryCursor=0;sim.buildingSpatialDirty=true;
    sim.collisionStartCount=0;sim.hardFixSapOrder.length=0;sim.hardFixSapEligible.length=0;sim.hardFixSapEpoch=1;sim.hardFixSapMarks.fill(0);
    sim.hardFixSapSideHeads.fill(-1);for(const heap of sim.hardFixSapSideHeaps)heap.length=0;
    sim.navigation.motion=new SurfaceMotion(sim.navigation);
    sim.rebuildRuntimeIndexes();
  }
}

class StrategySim{
  // Root extensions authored by trusted missions are authoritative by default.
  // Runtime owners declare only the local/derived exclusions; entity owners keep
  // their existing StateContracts and serialization.
  static stateContract=new StateContract({}, {presentation:["events","perfStats","balanceStats","_perfCollect"],derived:[
    "chargedHeldIds","navigationDemandScope","world","tps","campaignScriptRuntime","campaignTechCap","disposed","runtimeEpoch","commandReceipts",
    "collisionGrid","collisionSweepGrid","collisionMotion","collisionRadii","collisionMasses","collisionDx","collisionDy","collisionStartFx","collisionStartFy","collisionSegmentFx","collisionSegmentFy","collisionNextFx","collisionNextFy","collisionBestOther","collisionCandidateBuffer","collisionCnt","collisionBestT","collisionBestNx","collisionBestNy","collisionStartCount",
    "hardFixSapAxis","hardFixSapOrder","hardFixSapEligible","hardFixSapWorkOrder","hardFixSapSweepActive","hardFixSapPairs","hardFixSapSideHeads","hardFixSapSideNext","hardFixSapSidePrev","hardFixSapSideHeaps","hardFixSapMarks","hardFixSapEpoch",
    "unitSpatial","buildingSpatial","buildingSpatialDirty","buildingSpatialQueryBuffers","buildingSpatialQueryCursor","maxBuildingRadius","unitById","buildingById","unitIndexById","runtimeIndexTick","spatialQueryBuffers","spatialQueryCursor","spatialQueryScopeBuffers","spatialQueryScopeDepth","aoeCandidateSpatialScratch","aoeCandidateSpatialDepth","maxUnitRadius","maxTauntRadius","targetLevelMemo",
    "cloakCacheTick","auraCloakedIds","visionFields","economyCacheTick","workerGasAssignments","validGasExtractorsBySide","navigation","nextRoutePathId","routePathStore","routePathIndex"
  ],children:{delayedEffects:DelayedEffectState}});
  static createForMatch({draft,seed,rules=GameRuleDefinition.current,campaignScenario=null,debugScenario=null}={}){
    const sim=new StrategySim(draft,seed,rules,campaignScenario,{launchMode:!campaignScenario&&!debugScenario});
    try{if(debugScenario)sim.applyDebugScenario(debugScenario);if(campaignScenario)sim.applyCampaignScenario(campaignScenario);return sim}
    catch(error){sim.dispose("initialization-failed");throw error}
  }
  constructor(draftState,seed,rules=GameRuleDefinition.current,campaignScenario=null,{launchMode=!campaignScenario}={}){
    this.launchMode=!!launchMode;
    this.seed=seed>>>0;this.rules=rules||GameRuleDefinition.current;this.tps=RangeUtil.clamp(Math.round(Number(this.rules?.simulation?.tps)||SIM_TPS),10,30);const campaignHumanRole=campaignScenario?.playerRole||"host",campaignHumanSide=campaignHumanRole==="host"?0:1;this.mapDescriptor=campaignScenario?.map?CampaignMapDefinition.build(campaignScenario.map,this.rules,this.seed,campaignHumanSide):MapGeneration.generateMapDescriptor({rules:this.rules,seed:this.seed,roundNumber:this.rules?.roundNumber||1});StateValue.freeze(this.mapDescriptor);this.world=WorldContext.fromMap(this.mapDescriptor);this.tick=0;this.seq=0;this.units=[];this.buildings=[];this.constructionOrders=[];this.navigationAdmissions=[];this.projectiles=[];this.events=[];this.scheduled=new Map();
    this.nextRoutePathId=1;this.routePathStore=new Map();this.routePathIndex=new Map();
    this.wallet=[0,1].map(()=>this.launchMode?LaunchRules.startingWallet:Math.max(0,Number(this.rules?.economy?.startingResources?.minerals)||0));
    this.launchIncomeCarry=[0,0];
    // Per-side match totals for the result screen: shots fired, grains sent, enemy units killed.
    this.launchStats={launches:[0,0],sent:[0,0],kills:[0,0]};
    this.gasWallet=[0,1].map(()=>Math.max(0,Number(this.rules?.economy?.startingResources?.gas)||0));
    this.tech=[1,1];this.productionPaused=[false,false];this.chargedCasts=[null,null];this.chargedCastSerial=[0,0];
    this.attackUpgrade=[0,0];
    this.armorUpgrade=[0,0];
    this.abilities=[{},{}];
    this.specialResearch=[{},{}];
    // UI-direct research uses three independent research channels.
    this.researchQueues=[
      {attack:null,armor:null,ability:null},
      {attack:null,armor:null,ability:null}
    ];

    // 전술 맵 / 스펠 상태도 lockstep 상태에 포함한다.
    this.capturePoints=this.mapDescriptor.capturePoints.map(p=>({
      ...p,owner:p.owner===0||p.owner===1?p.owner:null,progress:0,progressSide:null,enabled:p.enabled!==false,outpostId:null
    }));
    this.spellBooks=[{},{}];
    this.equippedSpells=[[],[]];
    // 전술상자 패시브: 슬롯 없이 상시 적용, 카드별 현재 레벨 저장.
    this.passiveCards=[{},{}];
    this.spellChests=[0,0];
    this.pendingChestOffers=[null,null];
    this.pendingSpellReplacement=[null,null];
    this.spellRewardSeq=0;
    this.activeSpells=[];
    this.delayedEffects=[];

    SimulationRuntimeState.initialize(this,{newMatch:true});

    this.flags=CloneUtil.clone(this.mapDescriptor.flags);this.decks=[draftState.decks.host.slice(),draftState.decks.guest.slice()];
    this.defenseCards=[DefenseCardDefinition.list(draftState.defenseCards?.host),DefenseCardDefinition.list(draftState.defenseCards?.guest)];
    this.resources=this.launchMode?[]:this.makeMinerals();
    this.gasNodes=this.launchMode?[]:this.makeGasNodes();
    this.camps=this.launchMode?[]:this.makeNeutralCamps();
    this.createBaseAndWorkers(0);this.createBaseAndWorkers(1);
    // Landed units march straight to the enemy main base.
    if(this.launchMode)for(const side of [0,1]){const enemy=this.buildings.find(b=>b.id==="base"+(1-side));this.flags[side]={x:enemy.x,y:enemy.y,forced:false}}
    this.spawnAuthoredMapStructures();
    this.applyStartingSetupPreset();
    for(const camp of this.camps)if(camp.spawnOnStart!==false)this.spawnCamp(camp);
  }
  spawnAuthoredMapStructures(){
    for(const spec of this.mapDescriptor?.authoredStructures||[]){
      const d=BuildingDefinition.get(spec.type);if(!d)continue;
      const b=new Building({id:spec.id,type:spec.type,side:spec.side,x:spec.x,y:spec.y,hp:d.hp,maxHp:d.hp,alive:true,complete:true,progress:d.buildTimeMs!=null?this.msTicks(d.buildTimeMs):this.buildingBuildTicks(d),constructionState:"complete",builderUnitId:null,constructionHpGranted:d.hp,produceType:null,productionTotal:0,productionRemaining:0,productionBatchSize:0,productionTicks:0,productionBatchesCompleted:0,constructionMineralCost:0,constructionGasCost:0,gasNodeId:null,gasWorkerTarget:0,cooldownUntil:0,attackCooldownPhase:0,attackFlash:0,beamTargetId:null,beamStartedAt:-1,beamStage:0,queue:[]});
      b.campaignStructureId=spec.id;b.capturePointId=spec.capturePoint||null;b.campaignObjectiveGroup=spec.objectiveGroup||null;this.buildings.push(b);this.markBuildingSpatialDirty();this.onBuildingComplete(b);
    }
  }
  dispose(reason="disposed"){
    if(this.disposed)return false;
    this.disposed=true;
    this.campaignScriptRuntime?.dispose(reason);
    return true;
  }
  msTicks(ms,options){return SimulationTiming.msToTicks(ms,this.tps,options)}
  ticksMs(ticks){return SimulationTiming.ticksToMs(ticks,this.tps)}
  buildingBuildTicks(def){return def?.buildTimeMs!=null?this.msTicks(def.buildTimeMs):Math.max(1,Number(def?.buildTime)||1)}
  scaledProductionTicks(baseTicks){
    const mult=Math.max(.001,Number(this.rules?.production?.trainTimeMultiplier)||1);
    return Math.max(1,Math.round(Math.max(1,Number(baseTicks)||1)*mult));
  }
  scaledResearchTicks(baseTicks){
    const mult=Math.max(.001,Number(this.rules?.production?.researchTimeMultiplier)||1);
    return Math.max(1,Math.round(Math.max(1,Number(baseTicks)||1)*mult));
  }
  applyStartingSetupPreset(){
    const setup=this.rules?.setup||{};
    if(setup.preset!=="unit-test")return;
    const tech=RangeUtil.clamp(Math.round(Number(setup.startingTech)||1),1,3);
    const resources=this.rules?.economy?.startingResources||{};
    for(const side of [0,1]){
      this.tech[side]=tech;
      this.wallet[side]=Math.max(this.wallet[side],Number(resources.minerals)||0);
      this.gasWallet[side]=Math.max(this.gasWallet[side],Number(resources.gas)||0);
      this.spawnConfiguredStartingBuildings(side,setup);
    }
  }
  spawnConfiguredStartingBuildings(side,setup){
    const bp=this.world.bases[side];
    const specs=[];
    const supplyCount=Math.max(0,Math.round(Number(setup.startingSupplyBuildings)||0));
    for(let i=0;i<supplyCount;i++)specs.push({type:"supply",slot:i});
    for(const type of setup.startingBuildings||[])if(BuildingDefinition.get(type))specs.push({type,slot:specs.length});
    // Production buildings are generated from the current deck, so future units automatically
    // appear in this preset without maintaining a second debug roster.
    for(const unit of this.decks[side]||[]){
      const ud=UnitDefinition.get(unit);if(!ud||ud.carrierSummon)continue;
      specs.push({type:ud.tier===3?"factory":"barracks",produceType:unit,slot:specs.length});
    }
    const baseAngle=side===0?-Math.PI*.15:Math.PI*.85;
    for(let i=0;i<specs.length;i++){
      const spec=specs[i],bd=BuildingDefinition.get(spec.type);if(!bd)continue;
      let placed=null;
      for(let attempt=0;attempt<48&&!placed;attempt++){
        const ring=190+Math.floor(attempt/12)*95+(i%3)*24;
        const angle=baseAngle+(attempt%12)*Math.PI*2/12+(i*.47);
        const x=RangeUtil.clamp(bp.x+Math.cos(angle)*ring,bd.size+20,this.world.width-bd.size-20);
        const y=RangeUtil.clamp(bp.y+Math.sin(angle)*ring,bd.size+20,this.world.height-bd.size-20);
        if(this.pointClearForBuildingSetup(spec.type,x,y)){placed={x,y}}
      }
      if(!placed)continue;
      const profile=spec.produceType?UnitDefinition.productionProfile(spec.produceType):null;
      this.buildings.push(new Building({
        id:`debug-${side}-${spec.type}-${i}`,type:spec.type,side,x:placed.x,y:placed.y,
        hp:bd.hp,maxHp:bd.hp,alive:true,complete:true,progress:bd.buildTimeMs!=null?this.msTicks(bd.buildTimeMs):(this.buildingBuildTicks(bd)),
        constructionState:"complete",builderUnitId:null,constructionHpGranted:bd.hp,
        produceType:spec.produceType||null,
        productionTotal:profile?.totalUnits||0,productionRemaining:profile?.totalUnits||0,
        productionBatchSize:profile?.batchSize||0,productionTicks:profile?.productionMs?this.msTicks(profile.productionMs):(profile?.productionTicks||0),
        productionBatchesCompleted:0,constructionMineralCost:0,constructionGasCost:0,
        gasNodeId:null,gasWorkerTarget:0,cooldownUntil:0,attackFlash:0,beamTargetId:null,beamStartedAt:-1,beamStage:0,queue:[]
      }));
      this.markBuildingSpatialDirty();
      this.onBuildingComplete(this.buildings[this.buildings.length-1]);
    }
  }
  pointClearForBuildingSetup(type,x,y){
    const bd=BuildingDefinition.get(type);if(!bd)return false;
    if(!buildingPlacementInsideWorld(type,x,y,this.world))return false;
    for(const b of this.buildings){
      if(b.alive===false)continue;
      if(Math.hypot(x-b.x,y-b.y)<buildingPlacementSeparation(type,b.type))return false;
    }
    for(const m of this.resources||[])if(Math.hypot(x-m.x,y-m.y)<bd.size+(m.r||28)+MINERAL_BUILD_MARGIN)return false;
    for(const g of this.gasNodes||[])if(Math.hypot(x-g.x,y-g.y)<bd.size+(g.r||32)+18)return false;
    return true;
  }

  terrainAt(x,y){return TerrainQuery.at(this.mapDescriptor,x,y,this.world.terrain.surfaces)}
  terrainMovementMultiplier(x,y,nextX=x,nextY=y){
    const current=this.terrainAt(x,y),next=this.terrainAt(nextX,nextY);
    // 다리 footprint는 평지이며 강 패널티를 완전히 제거한다.
    if(!current.bridge&&!next.bridge&&(current.river||next.river))return .5;
    const fromH=Number(current.surfaceElevation)||0,toH=Number(next.surfaceElevation)||0;
    if(toH<=fromH+.002)return 1;
    // Every authored ramp is a transition between two integer levels. Slowdown is
    // based on progress across that transition, so 1→2 behaves exactly like 0→1.
    const progress=next.ramp!=null?Number(next.rampProgress)||0:current.ramp!=null?1:0;
    if(progress<.25)return 1;
    if(progress<.50)return .85;
    if(progress<.75)return .70;
    return .50;
  }

  rebuildRuntimeIndexes(){
    for(let i=0;i<(this.units||[]).length;i++)if(!(this.units[i] instanceof Unit))this.units[i]=Unit.fromState(this.units[i]);
    this.unitById.clear();this.buildingById.clear();this.unitIndexById.clear();
    for(let i=0;i<this.units.length;i++){
      const u=this.units[i];this.unitById.set(u.id,u);this.unitIndexById.set(u.id,i);
    }
    for(const b of this.buildings)this.buildingById.set(b.id,b);
    this.unitSpatial.reset(this.units,this.unitIndexById);this.runtimeIndexTick=this.tick;
    this.ensureBuildingSpatial();
  }
  entityRefById(id,kind=null){
    if(id==null)return null;
    if(kind!=="building"){
      const unit=this.unitById.get(id)||this.units.find(u=>u.id===id);
      if(unit)return{entity:unit,isBuilding:false};
    }
    if(kind!=="unit"){
      const building=this.buildingById.get(id)||this.buildings.find(b=>b.id===id);
      if(building)return{entity:building,isBuilding:true};
    }
    return null;
  }
  liveEntityRefById(id,kind=null){
    const ref=this.entityRefById(id,kind);
    if(!ref)return null;
    const alive=ref.isBuilding?ref.entity.alive!==false:!!ref.entity.alive;
    return alive?ref:null;
  }
  markBuildingSpatialDirty(){this.buildingSpatialDirty=true;if(this.navigation){this.navigation.sceneTick=-1;this.navigation.sceneRevision=undefined}AdaptiveNavigationDemand.invalidate(this)}
  ensureBuildingSpatial(){
    if(!this.buildingSpatial)this.buildingSpatial=new DeterministicBuildingSpatialGrid(SIM_SPATIAL_CELL,this.world);
    if(this.buildingSpatialDirty){this.buildingSpatial.reset(this.buildings);this.buildingSpatialDirty=false}
  }
  nearbyBuildingIndices(x,y,r){
    this.ensureBuildingSpatial();
    const out=this.buildingSpatialQueryBuffers[this.buildingSpatialQueryCursor++&15];
    return this.buildingSpatial.query(x,y,r,out);
  }
  syncUnitSpatial(u){if(this.runtimeIndexTick===this.tick)this.unitSpatial.sync(u)}
  addRuntimeUnit(u){
    if(!u.behaviorState)u.behaviorState={};
    if(this.runtimeIndexTick!==this.tick||!u)return;
    const index=this.units.length-1;this.unitById.set(u.id,u);this.unitIndexById.set(u.id,index);this.unitSpatial.add(u,index);
  }
  nearbyUnits(x,y,r,side=null,out=null){
    if(this.runtimeIndexTick!==this.tick)this.rebuildRuntimeIndexes();
    if(out!==null&&!Array.isArray(out))throw new TypeError("nearbyUnits result buffer must be an array");
    const result=this.unitSpatial.query(x,y,r,out||this.spatialQueryBuffers[this.spatialQueryCursor++&63],side);
    if(this._perfCollect){this._perfCollect.spatialQueries++;this._perfCollect.spatialCandidates+=result.length;if(side!=null)this._perfCollect.sideSpatialQueries++}
    return result;
  }
  withNearbyUnits(x,y,r,side,visit){
    if(typeof side==="function"){visit=side;side=null}
    if(typeof visit!=="function")throw new TypeError("nearbyUnits visitor must be a function");
    if(this.runtimeIndexTick!==this.tick)this.rebuildRuntimeIndexes();
    const depth=this.spatialQueryScopeDepth||0;
    const out=this.spatialQueryScopeBuffers[depth]||(this.spatialQueryScopeBuffers[depth]=[]);
    this.spatialQueryScopeDepth=depth+1;
    try{
      const result=this.unitSpatial.query(x,y,r,out,side);
      if(this._perfCollect){this._perfCollect.spatialQueries++;this._perfCollect.spatialCandidates+=result.length;if(side!=null)this._perfCollect.sideSpatialQueries++}
      return visit(result);
    }finally{this.spatialQueryScopeDepth=depth}
  }
  ensureCollisionBuffers(n){
    if(this.collisionRadii.length>=n)return;
    const oldStartX=this.collisionStartFx,oldStartY=this.collisionStartFy;
    let cap=Math.max(64,this.collisionRadii.length||0);while(cap<n)cap*=2;
    this.collisionRadii=new Int32Array(cap);this.collisionMasses=new Int32Array(cap);
    this.collisionDx=new Int32Array(cap);this.collisionDy=new Int32Array(cap);this.collisionCnt=new Uint16Array(cap);
    this.collisionStartFx=new Int32Array(cap);this.collisionStartFy=new Int32Array(cap);
    this.collisionStartFx.set(oldStartX);this.collisionStartFy.set(oldStartY);
    this.collisionSegmentFx=new Int32Array(cap);this.collisionSegmentFy=new Int32Array(cap);
    this.collisionNextFx=new Int32Array(cap);this.collisionNextFy=new Int32Array(cap);
    this.collisionBestT=new Float64Array(cap);this.collisionBestNx=new Float64Array(cap);this.collisionBestNy=new Float64Array(cap);
    this.collisionBestOther=new Int32Array(cap);
    this.collisionMotion={flags:new Uint8Array(cap),layers:[],sx:new Float64Array(cap),sy:new Float64Array(cap),ex:new Float64Array(cap),ey:new Float64Array(cap),vx:new Float64Array(cap),vy:new Float64Array(cap)};
  }
  captureCollisionStepStarts(){
    const n=this.units.length;this.ensureCollisionBuffers(n);
    for(let i=0;i<n;i++){
      const u=this.units[i];
      this.collisionStartFx[i]=u?.fx??Math.round((u?.x||0)*FP);
      this.collisionStartFy[i]=u?.fy??Math.round((u?.y||0)*FP);
    }
    this.collisionStartCount=n;this.navigation.motion.beginStep();
  }

  resolveProjectileLaunchDamage({source=null,sourceSide=null,sourceType=null,target=null,isBuilding=false,baseDamage=0,damageClass=null}={}){
    const type=sourceType||source?.type||"";
    const side=sourceSide==null?(source?.side??NEUTRAL_SIDE):sourceSide;
    let damage=Math.max(0,Number(baseDamage)||0);
    // Projectile contract: every source-side attack modifier is frozen at launch.
    // Target armor/terrain/hit-guard and other explicitly defensive rules remain impact-time.
    if(source?.objectiveCaptured&&source.objectiveCapturedScale)damage=Math.max(1,Math.round(damage*source.objectiveCapturedScale));
    if((side===0||side===1)&&!UnitDefinition.get(type)?.economyWorker&&(UnitDefinition.get(type)||BuildingDefinition.get(type))&&!source?.objectiveCaptured){
      const atkLv=this.attackUpgrade[side]||0;
      const passiveAtk=UnitDefinition.get(type)?this.passiveAttackPct(side,type):0;
      damage=Math.max(1,Math.floor(damage*(100+atkLv*ATTACK_UPGRADE_PCT_PER_LEVEL+passiveAtk)/100));
    }
    return Math.max(1,Math.round(damage));
  }

  spawnProjectile(params){
    const source=params.owner?(this.unitById.get(params.owner)||this.buildingById.get(params.owner)||this.units.find(u=>u.id===params.owner&&u.alive)||this.buildings.find(b=>b.id===params.owner&&b.alive!==false)):null;
    const targetRef=params.target?this.liveEntityRefById(params.target,params.isBuilding?"building":"unit"):null;
    const targetAtLaunch=targetRef?.entity||null;
    const terrainMiss=targetAtLaunch?this.terrainUphillMiss(params.type,params.owner,targetAtLaunch,!!params.isBuilding,params.id||`${this.tick}|${this.seq}`):false;
    if(targetAtLaunch)this.markTerrainAttackReveal(params.type,params.owner,targetAtLaunch,!!params.isBuilding);
    const trajectoryPolicy=params.trajectoryPolicy||(params.impactAtAimPoint?"lockedPoint":"trackingTarget");
    const launchAimX=Number.isFinite(Number(params.lockedAimX))?Number(params.lockedAimX):(targetAtLaunch?targetAtLaunch.x+(Number(params.aimOffsetX)||0):Number(params.x)||0);
    const launchAimY=Number.isFinite(Number(params.lockedAimY))?Number(params.lockedAimY):(targetAtLaunch?targetAtLaunch.y+(Number(params.aimOffsetY)||0):Number(params.y)||0);
    const alreadyResolved=!!params.sourceDamageResolved;
    const unitPayload=alreadyResolved
      ?Math.max(1,Math.round(Number(params.splashUnitDamage??params.damage)||0))
      :this.resolveProjectileLaunchDamage({source,sourceSide:params.side,sourceType:params.type,target:params.target,isBuilding:false,baseDamage:params.damage,damageClass:params.damageClass});
    const buildingPayload=alreadyResolved
      ?Math.max(1,Math.round(Number(params.splashBuildingDamage??params.damage)||0))
      :this.resolveProjectileLaunchDamage({source,sourceSide:params.side,sourceType:params.type,target:params.target,isBuilding:true,baseDamage:params.damage,damageClass:params.damageClass});
    const resolvedDamage=alreadyResolved
      ?Math.max(1,Math.round(Number(params.damage)||0))
      :(params.isBuilding?buildingPayload:unitPayload);
    const projectile=new Projectile({
      alive:true,
      launchX:params.x,
      launchY:params.y,
      ...params,
      trajectoryPolicy,
      lockedAimX:launchAimX,
      lockedAimY:launchAimY,
      targetLost:false,
      terrainMiss,
      damage:resolvedDamage,
      sourceFriendlySide:params.sourceFriendlySide??(source?.campId?this.campFriendlySide(this.camps.find(c=>c.id===source.campId)):null),
      impactAbility:params.impactAbility??this.hasAbility(params.side,params.type),
      sourceDamageResolved:true
    });
    // Mixed splash can hit a different target class than the primary target. Store actual
    // launch-resolved payloads (not duplicate scale fields) only when splash needs them.
    if(params.splash){
      projectile.splashUnitDamage=unitPayload;
      projectile.splashBuildingDamage=buildingPayload;
      projectile.splashIgnoreNeutral=!!source?.objectiveCaptured;
    }
    this.projectiles.push(projectile);
  }
  unitLayer(type){return UNIT_RUNTIME_GEOMETRY[type]?.layer||"GROUND"}
  isAirborneStatus(u){return !!u&&u.alive&&this.tick<(u.status?.airborneUntil||0)}
  applyAirborne(target,{durationTicks=null,durationSeconds=null,height=42,sourceSide=null,sourceType=null,allowAir=false}={}){
    if(this.neutralObjectFriendlyToSide(target,sourceSide))return false;
    if(!target||!target.alive||!UnitDefinition.get(target.type))return false;
    // Runtime invariant: crowd-control operates on Unit components, never serialized/plain state.
    if(!(target instanceof Unit)){
      const hydrated=Unit.fromState(target),idx=this.units.indexOf(target);
      if(idx>=0){this.units[idx]=hydrated;target=hydrated;this.runtimeIndexTick=-1}else return false;
    }
    if(!allowAir&&this.unitLayer(target.type)==="AIR")return false;
    const rawTicks=durationTicks!=null?Number(durationTicks):Number(durationSeconds||0)*this.tps;
    const ticks=Math.max(1,Math.min(this.msTicks(10000),Math.round(rawTicks||1)));
    const lift=Math.max(8,Math.min(180,Number(height)||42));
    const until=this.tick+ticks;
    // Crowd-control contract: becoming airborne interrupts an attack wind-up NOW,
    // not on the target's next simulation update.
    if(target.combat?.windupPending())this.clearAttackWindup(target);
    const wasActive=this.isAirborneStatus(target);
    if(!wasActive||until>(target.status.airborneUntil||0)||lift>(target.status.airborneHeight||0)){
      target.status.airborneStartTick=this.tick;
      target.status.airborneUntil=Math.max(until,target.status.airborneUntil||0);
      target.status.airborneDurationTicks=Math.max(1,target.status.airborneUntil-this.tick);
      target.status.airborneHeight=Math.max(lift,wasActive?(target.status.airborneHeight||0):0);
      target.status.airborneSourceType=sourceType||null;
      this.events.push({type:"airborne",side:target.side,x:target.x,y:target.y,targetId:target.id,targetType:target.type,durationTicks:target.status.airborneDurationTicks,height:target.status.airborneHeight,sourceSide,sourceType});
    }
    return true;
  }
  canAttackLayer(sourceType,layer){
    const d=UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType);
    if(!d)return true;
    return layer==="AIR"?!!d.canAttackAir:!!d.canAttackGround;
  }
  canAttackEntity(sourceType,target,isBuilding=false){
    if(isBuilding)return !!((UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType))?.canAttackGround||(UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType))?.canAttackAir);
    if(!!target?.capability(BurrowableMixin.KEY)?.isUntargetable())return false;
    return this.canAttackLayer(sourceType,this.unitLayer(target?.type));
  }
  prepareCloakCache(){
    if(this.cloakCacheTick===this.tick)return;
    this.cloakCacheTick=this.tick;
    this.auraCloakedIds.clear();
    for(const ray of this.units){
      const aura=ray?.capability(CloakAuraMixin.KEY);if(!ray?.alive||!aura)continue;
      const rr=aura.radius();
      for(const idx of this.nearbyUnits(ray.x,ray.y,rr,ray.side)){
        const u=this.units[idx];
        if(!CloakAuraMixin.canAffect(ray,u))continue;
        if(Math.hypot(u.x-ray.x,u.y-ray.y)<=rr)this.auraCloakedIds.add(u.id);
      }
    }
  }
  terrainLevelAt(x,y){return this.world.terrain.surfaces.levelAt(x,y)}
  terrainRangedSource(sourceType){
    const d=UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType)||null;if(!d)return false;
    return !!d.projectile||!!d.continuous||Number(d.range)>100||d.attackVisual?.travel&&d.attackVisual.travel!=="none";
  }
  terrainAttackContext(sourceType,sourceEntityId,target,isBuilding=false){
    const source=sourceEntityId?(this.unitById.get(sourceEntityId)||this.buildingById.get(sourceEntityId)||this.units.find(u=>u.id===sourceEntityId&&u.alive)||this.buildings.find(b=>b.id===sourceEntityId&&b.alive!==false)):null;
    if(!source||!target)return null;
    const sourceDef=UnitDefinition.get(source.type)||BuildingDefinition.get(source.type)||UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType)||{};
    if(sourceDef.layer==="AIR")return null;
    const targetDef=isBuilding?BuildingDefinition.get(target.type):UnitDefinition.get(target.type);
    if(!isBuilding&&targetDef?.layer==="AIR")return null;
    return{source,sourceLevel:this.terrainLevelAt(source.x,source.y),targetLevel:this.terrainLevelAt(target.x,target.y)};
  }
  markTerrainAttackReveal(sourceType,sourceEntityId,target,isBuilding=false){
    const ctx=this.terrainAttackContext(sourceType,sourceEntityId,target,isBuilding);if(!ctx||ctx.sourceLevel<=ctx.targetLevel)return false;
    const side=target.side;if(side!==0&&side!==1)return false;
    const until=this.tick+this.msTicks(TERRAIN_ATTACK_REVEAL_MS);
    if(ctx.source instanceof Unit)ctx.source.status[side===0?"terrainRevealUntil0":"terrainRevealUntil1"]=Math.max(Number(ctx.source.status[side===0?"terrainRevealUntil0":"terrainRevealUntil1"])||0,until);
    else ctx.source[side===0?"terrainRevealUntil0":"terrainRevealUntil1"]=Math.max(Number(ctx.source[side===0?"terrainRevealUntil0":"terrainRevealUntil1"])||0,until);
    this.events.push({type:"terrainAttackReveal",side,x:ctx.source.x,y:ctx.source.y,sourceId:ctx.source.id,sourceType:ctx.source.type,untilTick:until});return true;
  }
  terrainUphillMiss(sourceType,sourceEntityId,target,isBuilding=false,key=""){
    if(!this.terrainRangedSource(sourceType))return false;
    const ctx=this.terrainAttackContext(sourceType,sourceEntityId,target,isBuilding);if(!ctx||ctx.sourceLevel>=ctx.targetLevel)return false;
    const v=HashUtil.hash(`${key||this.tick}|${ctx.source.id}|${target.id}|${ctx.sourceLevel}>${ctx.targetLevel}|uphill`);
    return (v&1)===0;
  }

  makeMinerals(){return CloneUtil.clone(this.mapDescriptor.resources||[])}

  makeGasNodes(){return CloneUtil.clone(this.mapDescriptor.gasNodes||[])}

  makeNeutralCamps(){return CloneUtil.clone(this.mapDescriptor.camps||[])}
  spawnCamp(camp){
    const cd=CampDefinition.get(camp.kind);
    camp.spawnNo++;
    camp.state="alive";
    camp.lastHitSide=null;
    camp.aggroTargetId=null;
    camp.aggroGauge=0;
    camp.insideAggroStartedAt=-1;
    camp.resetting=false;
    camp.engaged=false;
    camp.lastAggroGaugeTick=-1;
    camp.memberHomes={};
    if(cd.mainObjective){
      camp.capturedUnitId=null;camp.capturedOwner=null;camp.lastDeathX=null;camp.lastDeathY=null;
    }

    // Corpses remain until the common end-of-step cleanup; spawning must not renumber live collision slots.

    const composition=UnitCompositionDefinition.normalize(Array.isArray(camp.composition)&&camp.composition.length?camp.composition:cd.composition);
    const members=UnitCompositionDefinition.expand(composition),count=members.length;
    const formation=String(camp.formation||"cluster"),radius=Number.isFinite(camp.homeSpread)?camp.homeSpread:cd.homeSpread;
    for(let i=0;i<count;i++){
      let x=camp.x,y=camp.y;
      if(formation==="line"){const gap=Math.max(18,Math.min(42,radius*.42));x+=((i-(count-1)/2)*gap);}
      else if(formation==="spread"){const cols=Math.max(1,Math.ceil(Math.sqrt(count))),gap=Math.max(22,Math.min(48,radius*.55));x+=(i%cols-(cols-1)/2)*gap;y+=(Math.floor(i/cols)-(Math.ceil(count/cols)-1)/2)*gap;}
      else{const ring=Math.floor(Math.sqrt(i)),a=count===1?0:(i*2.399963229728653),rr=count===1?0:Math.min(radius,(ring+1)*Math.max(14,radius/Math.max(2,Math.sqrt(count))));x+=Math.cos(a)*rr;y+=Math.sin(a)*rr;}
      const spawnSide=cd.scenarioObject&&(camp.side===0||camp.side===1)?camp.side:NEUTRAL_SIDE;
      const logicProfile=cd.unitBasedNeutralObject?"neutral-object":null;
      const u=this.spawnUnit(spawnSide,members[i],x,y,{logicProfile});
      if(u.logicController?.kind==="neutral-object"){
        const st=u.logicController.state;st.campId=camp.id;st.aggroed=false;st.returningHome=false;
        camp.memberHomes[u.id]={x:u.x,y:u.y};
      }else u.scenarioGroupId=camp.id;
      u.forcedTargetId=null;
    }
  }
  isMainObjectiveCamp(camp){return !!camp&&!!CampDefinition.get(camp.kind)?.mainObjective}
  spawnCapturedObjective(camp,side){
    if(!this.isMainObjectiveCamp(camp)||(side!==0&&side!==1))return null;
    const type=UnitCompositionDefinition.first(camp.composition?.length?camp.composition:CampDefinition.get(camp.kind)?.composition),d=UnitDefinition.get(type);
    if(!d)return null;
    const x=Number.isFinite(camp.lastDeathX)?camp.lastDeathX:camp.x;
    const y=Number.isFinite(camp.lastDeathY)?camp.lastDeathY:camp.y;
    const u=this.spawnUnit(side,type,x,y);
    const hp=Math.max(1,Math.round(d.hp*CAPTURED_OBJECTIVE_SCALE));
    u.maxHp=hp;u.hp=hp;u.objectiveCaptured=true;u.objectiveCapturedScale=CAPTURED_OBJECTIVE_SCALE;
    u.behaviorState.objectiveCampId=camp.id;u.objectiveLane=camp.laneKey||CampDefinition.get(camp.kind)?.laneKey||"mid";
    u.objectiveLaneT=MapGeometry.closestPolylineProgress(this.mapDescriptor.laneControlPoints?.[u.objectiveLane]||[],u.x,u.y);
    u.objectiveAttackCount=0;u.behaviorState.objectiveAirCooldownUntil=0;u.objectiveChargePending=false;u.objectiveChargeActive=false;u.objectiveChargeHitIds=[];this.resetObjectiveDragonBreath(u);
    camp.state="captured";camp.capturedUnitId=u.id;camp.capturedOwner=side;camp.respawnAt=0;
    const lanePts=this.mapDescriptor.laneControlPoints?.[u.objectiveLane]||[],laneTan=MapGeometry.laneTangentAt(lanePts,u.objectiveLaneT||0);
    const laneSign=side===0?1:-1;
    this.events.push({type:"objectiveCaptured",side,x:u.x,y:u.y,camp:camp.kind,unit:type,sourceType:type,unitId:u.id,lane:u.objectiveLane,scale:CAPTURED_OBJECTIVE_SCALE,dirX:laneTan.x*laneSign,dirY:laneTan.y*laneSign});
    return u;
  }
  capturedObjectiveForCamp(camp){
    if(!camp?.capturedUnitId)return null;
    return this.unitById.get(camp.capturedUnitId)||this.units.find(u=>u.id===camp.capturedUnitId&&u.alive)||null;
  }
  beginObjectiveRespawn(camp,x=camp?.x,y=camp?.y){
    if(!this.isMainObjectiveCamp(camp))return;
    camp.state="cooldown";camp.respawnAt=this.tick+this.msTicks(MAIN_OBJECTIVE_RESPAWN_MS);camp.capturedUnitId=null;camp.capturedOwner=null;
    camp.lastHitSide=null;camp.aggroTargetId=null;camp.engaged=false;camp.resetting=false;camp.aggroGauge=0;
    this.events.push({type:"objectiveRespawnStarted",side:NEUTRAL_SIDE,x,y,camp:camp.kind,respawnAt:camp.respawnAt,lane:camp.laneKey});
  }
  objectiveLaneAdvanceTarget(u){
    const lane=u?.objectiveLane||"mid",pts=this.mapDescriptor.laneControlPoints?.[lane]||[];
    if(pts.length<2)return this.world.bases[u.side===0?1:0];
    const nearest=MapGeometry.closestPolylineProgress(pts,u.x,u.y);
    u.objectiveLaneT=nearest;
    const dir=u.side===0?1:-1,nextT=RangeUtil.clamp(nearest+dir*.045,0,1);
    if((dir>0&&nextT>=.995)||(dir<0&&nextT<=.005))return this.world.bases[1-u.side];
    return MapGeometry.pointOnPolyline(pts,nextT);
  }

  capturePoint(id){return this.capturePoints.find(p=>p.id===id)||null}

  spellEntry(side,id){
    if(!this.spellBooks[side][id]){
      this.spellBooks[side][id]={unlocked:false,cooldownUntil:0,mastery:0};
    }
    return this.spellBooks[side][id];
  }
  spellEquipped(side,id){return (this.equippedSpells?.[side]||[]).includes(id)}
  spellStats(side,id){return SpellDefinition.spellLevelRuntime(SpellDefinition.statsAt(id,this.spellEntry(side,id).mastery||0),this.tps)}
  spellCooldownTicks(side,id){return Math.max(this.msTicks(1000),this.spellStats(side,id)?.cooldown||this.msTicks(1000))}

  passiveLevel(side,id){
    return Math.max(0,Number(this.passiveCards?.[side]?.[id])||0);
  }
  passiveValue(side,id,level=null){
    const d=PassiveCardDefinition.get(id);if(!d)return 0;
    const lv=level==null?this.passiveLevel(side,id):Math.max(0,Number(level)||0);
    if(lv<=0)return 0;
    return Number(d.values[Math.min(d.values.length,lv)-1])||0;
  }
  isPlayerCombatUnit(side,type){
    return (side===0||side===1)&&!UnitDefinition.get(type)?.economyWorker&&!!UnitDefinition.get(type);
  }
  passiveEffectValue(side,effect,{tier=null,resource=null}={}){
    let total=0;
    for(const id of PassiveCardDefinition.ids){
      const d=PassiveCardDefinition.get(id);if(d.effect!==effect)continue;
      if(d.tier!=null&&d.tier!==tier)continue;
      if(d.resource!=null&&d.resource!==resource)continue;
      total+=this.passiveValue(side,id);
    }
    return total;
  }
  passiveMovePct(side,type){
    if(!this.isPlayerCombatUnit(side,type))return 100;
    const tier=UnitDefinition.get(type)?.tier||0;
    return 100+this.passiveEffectValue(side,"movePct",{tier});
  }
  passiveUnitMaxHp(side,type){
    const d=UnitDefinition.get(type);if(!d)return 1;
    if(!this.isPlayerCombatUnit(side,type))return d.hp;
    const pct=this.passiveEffectValue(side,"hpPct",{tier:d.tier||0})+this.passiveEffectValue(side,"hpPct");
    let baseHp=d.hp;
    for(const r of UnitSpecialResearchDefinition.forUnit(type))if(this.hasSpecialResearch(side,r.id)&&Number(r.effects?.maxHpBonus))baseHp+=Number(r.effects.maxHpBonus);
    return Math.max(1,Math.round(baseHp*(100+pct)/100));
  }
  passiveAttackPct(side,type){
    return this.isPlayerCombatUnit(side,type)?this.passiveEffectValue(side,"attackPct"):0;
  }
  passiveTowerRangePct(side){
    return (side===0||side===1)?this.passiveEffectValue(side,"towerRangePct"):0;
  }
  initialHitGuard(side,type){
    return this.isPlayerCombatUnit(side,type)&&this.passiveEffectValue(side,"hitGuard")>0?1:0;
  }
  applyPassiveOnApply(side,def,fromLevel,toLevel){
    if(def?.onApplyKind==="refreshCombatHp"){
      for(const u of this.units){
        if(!u.alive||u.side!==side||!this.isPlayerCombatUnit(side,u.type))continue;
        const oldMax=Math.max(1,Number(u.maxHp)||UnitDefinition.get(u.type).hp);
        const newMax=this.passiveUnitMaxHp(side,u.type);
        const delta=newMax-oldMax;
        u.maxHp=newMax;
        if(delta>0)u.hp=Math.min(newMax,(u.hp||0)+delta);
        else u.hp=Math.min(u.hp||0,newMax);
      }
      return;
    }
    if(def?.onApplyKind==="grantHitGuardOnFirstUnlock"&&fromLevel===0&&toLevel===1){
      for(const u of this.units){
        if(!u.alive||u.side!==side||!this.isPlayerCombatUnit(side,u.type))continue;
        u.hitGuard=Math.max(0,Number(u.hitGuard)||0)+1;
      }
    }
  }
  applyPassiveUpgrade(side,id,fromLevel,toLevel){
    if(!this.passiveCards?.[side])this.passiveCards[side]={};
    this.passiveCards[side][id]=toLevel;
    this.applyPassiveOnApply(side,PassiveCardDefinition.get(id),fromLevel,toLevel);
  }

  validTacticalRewards(side){
    const rewards=TACTICAL_ECON_REWARDS.map(r=>({...r,type:"economy"}));
    for(const id of PassiveCardDefinition.ids){
      const d=PassiveCardDefinition.get(id),level=this.passiveLevel(side,id);
      if(level>=d.maxLevel)continue;
      rewards.push({
        id:`passive:${id}`,type:"passive",passiveId:id,
        name:d.name,icon:d.icon,fromLevel:level,toLevel:level+1,maxLevel:d.maxLevel,desc:d.desc
      });
    }
    const equipped=this.equippedSpells?.[side]||[];
    for(const id of SpellDefinition.ids){
      const e=this.spellEntry(side,id),d=SpellDefinition.get(id);
      if(!e.unlocked){
        rewards.push({id:`spell-new:${id}`,type:"spell-new",spellId:id,name:d.name,icon:d.icon});
      }else if(!equipped.includes(id)){
        rewards.push({id:`spell-equip:${id}`,type:"spell-equip",spellId:id,name:d.name,icon:d.icon});
      }else if((e.mastery||0)<SPELL_MASTERY_MAX){
        rewards.push({id:`spell-upgrade:${id}`,type:"spell-upgrade",spellId:id,name:d.name,icon:d.icon});
      }
    }
    return rewards;
  }

  openTacticalChest(side){
    if((this.spellChests?.[side]||0)<=0)return false;
    if(this.pendingSpellReplacement?.[side]||this.pendingChestOffers?.[side])return true;
    const seq=++this.spellRewardSeq;
    const pool=this.validTacticalRewards(side);
    const salt=`${this.seed}|chest|${side}|${seq}`;
    pool.sort((a,b)=>{
      const ha=HashUtil.hash(`${salt}|${a.id}`),hb=HashUtil.hash(`${salt}|${b.id}`);
      return ha===hb?(a.id<b.id?-1:1):ha-hb;
    });
    const options=pool.slice(0,TACTICAL_CHEST_OPTION_COUNT).map(r=>CloneUtil.clone(r));
    this.pendingChestOffers[side]={id:`chest-${side}-${seq}`,seq,createdTick:this.tick,options};
    this.events.push({type:"tacticalChestOpened",side,offerId:this.pendingChestOffers[side].id});
    return true;
  }

  consumeChestOffer(side,offer){
    if((this.spellChests?.[side]||0)<=0)return false;
    this.spellChests[side]=Math.max(0,this.spellChests[side]-1);
    this.pendingChestOffers[side]=null;
    this.pendingSpellReplacement[side]=null;
    return true;
  }

  equipRewardSpell(side,reward,replacedSpellId=null){
    const id=reward.spellId,e=this.spellEntry(side,id),equipped=this.equippedSpells[side];
    if(replacedSpellId){
      const idx=equipped.indexOf(replacedSpellId);
      if(idx<0)return false;
      equipped.splice(idx,1);
    }
    e.unlocked=true;
    if(!equipped.includes(id))equipped.push(id);
    e.cooldownUntil=Math.min(e.cooldownUntil||this.tick,this.tick);
    return equipped.length<=SPELL_SLOT_MAX;
  }

  chooseTacticalReward(side,offerId,rewardId){
    const offer=this.pendingChestOffers?.[side];
    if(!offer||offer.id!==offerId||this.pendingSpellReplacement?.[side])return false;
    const reward=offer.options.find(r=>r.id===rewardId);
    if(!reward)return false;

    if(reward.type==="economy"){
      this.wallet[side]+=Number(reward.mineral)||0;
      this.gasWallet[side]+=Number(reward.gas)||0;
      this.consumeChestOffer(side,offer);
      this.events.push({type:"tacticalRewardChosen",side,reward:reward.id,mineral:reward.mineral||0,gas:reward.gas||0});
      return true;
    }

    if(reward.type==="passive"){
      const id=reward.passiveId,d=PassiveCardDefinition.get(id);
      if(!d)return false;
      const from=this.passiveLevel(side,id);
      if(from>=d.maxLevel)return false;
      const to=from+1;
      this.applyPassiveUpgrade(side,id,from,to);
      this.consumeChestOffer(side,offer);
      this.events.push({type:"passiveCardUp",side,passive:id,fromLevel:from,toLevel:to});
      return true;
    }

    if(reward.type==="spell-upgrade"){
      const e=this.spellEntry(side,reward.spellId);
      if(!this.spellEquipped(side,reward.spellId)||(e.mastery||0)>=SPELL_MASTERY_MAX)return false;
      const from=e.mastery||0;
      e.mastery=Math.min(SPELL_MASTERY_MAX,from+1);
      e.cooldownUntil=Math.max(this.tick,(e.cooldownUntil||this.tick)-this.msTicks(30000));
      this.consumeChestOffer(side,offer);
      this.events.push({type:"spellMasteryUp",side,spell:reward.spellId,fromLevel:from+1,toLevel:e.mastery+1});
      return true;
    }

    if(reward.type==="spell-new"||reward.type==="spell-equip"){
      const equipped=this.equippedSpells[side]||[];
      if(equipped.length<SPELL_SLOT_MAX){
        if(!this.equipRewardSpell(side,reward))return false;
        this.consumeChestOffer(side,offer);
        this.events.push({type:"spellEquipped",side,spell:reward.spellId,replaced:null,newUnlock:reward.type==="spell-new"});
        return true;
      }
      this.pendingSpellReplacement[side]={offerId:offer.id,reward:CloneUtil.clone(reward),createdTick:this.tick};
      this.events.push({type:"spellReplacementNeeded",side,spell:reward.spellId});
      return true;
    }
    return false;
  }

  replaceEquippedSpell(side,offerId,oldSpellId){
    const pending=this.pendingSpellReplacement?.[side],offer=this.pendingChestOffers?.[side];
    if(!pending||!offer||pending.offerId!==offerId||offer.id!==offerId)return false;
    if(!(this.equippedSpells?.[side]||[]).includes(oldSpellId))return false;
    if(!this.equipRewardSpell(side,pending.reward,oldSpellId))return false;
    const newId=pending.reward.spellId;
    this.consumeChestOffer(side,offer);
    this.events.push({type:"spellEquipped",side,spell:newId,replaced:oldSpellId,newUnlock:pending.reward.type==="spell-new"});
    return true;
  }

  cancelSpellReplacement(side,offerId){
    const pending=this.pendingSpellReplacement?.[side];
    if(!pending||pending.offerId!==offerId)return false;
    this.pendingSpellReplacement[side]=null;
    return true;
  }

  spellTargetAllowed(side,x,y,margin=SPELL_CAST_MARGIN){
    x=RangeUtil.clamp(x,0,this.world.width);y=RangeUtil.clamp(y,0,this.world.height);
    for(const src of this.visionSources(side).sources){
      const r=src.r+margin,dx=src.x-x,dy=src.y-y;
      if(dx*dx+dy*dy<=r*r)return true;
    }
    return false;
  }

  spellReady(side,id){
    const e=this.spellEntry(side,id);
    return !!e.unlocked&&this.spellEquipped(side,id)&&this.tick>=e.cooldownUntil;
  }

  nearestDropoff(side,x,y){
    let best=null,dist=Infinity;
    for(const b of this.buildings){
      if(b.alive===false||!b.complete||b.side!==side||!BuildingDefinition.get(b.type)?.isDropoff)continue;
      const d=(b.x-x)*(b.x-x)+(b.y-y)*(b.y-y);
      if(d<dist||(d===dist&&best&&b.id<best.id)){best=b;dist=d}
    }
    return best;
  }

  nearestGasNodeAt(x,y,maxDist=GAS_BUILD_SNAP_RADIUS){
    let best=null,dist=maxDist*maxDist;
    for(const g of this.gasNodes||[]){
      const d=(g.x-x)*(g.x-x)+(g.y-y)*(g.y-y);
      if(d<=dist&&(!best||d<dist||(d===dist&&g.id<best.id))){
        best=g;dist=d;
      }
    }
    return best;
  }

  gasNodeOccupied(gasNodeId,excludeBuildingId=null){
    return [...this.buildings,...this.constructionOrders].some(b=>
      b.alive!==false&&
      b.id!==excludeBuildingId&&
      BuildingDefinition.get(b.type)?.isGasExtractor&&
      b.gasNodeId===gasNodeId
    );
  }

  gasNodeForExtractor(b){
    if(!b||!BuildingDefinition.get(b.type)?.isGasExtractor)return null;
    return (this.gasNodes||[]).find(g=>g.id===b.gasNodeId)||null;
  }

  validGasExtractors(side){
    return this.buildings.filter(b=>{
      if(b.alive===false||!b.complete||b.side!==side||!BuildingDefinition.get(b.type)?.isGasExtractor)return false;
      const g=this.gasNodeForExtractor(b);
      // Depleted geysers stay valid at 25% yield.
      return !!g;
    });
  }

  prepareEconomyCaches(){
    this.workerGasAssignments.clear();
    this.validGasExtractorsBySide[0].length=0;
    this.validGasExtractorsBySide[1].length=0;
    const dropoffs=[[],[]];
    for(const b of this.buildings){
      if(b.alive===false||!b.complete||(b.side!==0&&b.side!==1))continue;
      if(BuildingDefinition.get(b.type)?.isDropoff)dropoffs[b.side].push(b);
      if(BuildingDefinition.get(b.type)?.isGasExtractor&&this.gasNodeForExtractor(b))this.validGasExtractorsBySide[b.side].push(b);
    }

    const groups=new Map();
    for(const u of this.units){
      if(!u.alive||!UnitDefinition.get(u.type)?.economyWorker||(u.side!==0&&u.side!==1))continue;
      let base=null,dist=Infinity;
      for(const b of dropoffs[u.side]){
        const d=(b.x-u.x)*(b.x-u.x)+(b.y-u.y)*(b.y-u.y);
        if(d<dist||(d===dist&&base&&b.id<base.id)){base=b;dist=d}
      }
      if(!base)continue;
      let arr=groups.get(base.id);if(!arr){arr=[];groups.set(base.id,arr)}
      arr.push(u);
    }
    for(const [baseId,workers] of groups){
      workers.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
      const base=this.buildingById.get(baseId)||this.buildings.find(b=>b.id===baseId);
      const target=RangeUtil.clamp(Number(base?.gasWorkerTarget)||0,0,GAS_ASSIGNMENT_MAX);
      for(let i=0;i<Math.min(target,workers.length);i++)this.workerGasAssignments.add(workers[i].id);
    }
    this.economyCacheTick=this.tick;
  }

  workerBase(u){
    return this.nearestDropoff(u.side,u.x,u.y);
  }

  workersAssignedToBase(base){
    if(!base)return[];
    return this.units
      .filter(u=>u.alive&&u.side===base.side&&!!UnitDefinition.get(u.type)?.economyWorker)
      .filter(u=>this.nearestDropoff(u.side,u.x,u.y)?.id===base.id)
      .sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);
  }

  workerShouldMineGas(u){
    if(this.economyCacheTick===this.tick)return this.workerGasAssignments.has(u.id);
    const base=this.workerBase(u);
    if(!base)return false;
    const target=RangeUtil.clamp(Number(base.gasWorkerTarget)||0,0,GAS_ASSIGNMENT_MAX);
    if(target<=0)return false;
    const workers=this.workersAssignedToBase(base);
    const index=workers.findIndex(w=>w.id===u.id);
    return index>=0&&index<target;
  }

  releaseCaptureForOutpost(outpostId){
    const cp=this.capturePoints.find(p=>p.outpostId===outpostId);
    if(!cp)return;
    cp.owner=null;cp.outpostId=null;cp.progress=0;cp.progressSide=null;cp.enabled=true;
    this.events.push({type:"captureLost",captureId:cp.id,x:cp.x,y:cp.y});
  }

  spawnOutpost(cp,side){
    const d=BuildingDefinition.get(BuildingDefinition.forRole("outpost"));
    const id="outpost-"+cp.id+"-"+(++this.seq);
    this.buildings.push(new Building({
      id,type:BuildingDefinition.forRole("outpost"),side,x:cp.x,y:cp.y,
      hp:d.hp,maxHp:d.hp,complete:true,progress:0,queue:[],captureId:cp.id,
      gasWorkerTarget:0
    }));
    this.markBuildingSpatialDirty();
    cp.owner=side;cp.outpostId=id;cp.enabled=false;cp.progress=0;cp.progressSide=null;
    this.events.push({type:"captureComplete",side,captureId:cp.id,lane:cp.lane,label:cp.label,x:cp.x,y:cp.y,outpostId:id});
  }

  updateCapturePoints(){
    for(const cp of this.capturePoints){
      if(cp.owner!=null||!cp.enabled)continue;

      let hostGround=0,guestGround=0,hostPresence=0,guestPresence=0;
      for(const idx of this.nearbyUnits(cp.x,cp.y,CAPTURE_RADIUS)){
        const u=this.units[idx];
        if(!u?.alive||(u.side!==0&&u.side!==1)||!!UnitDefinition.get(u.type)?.captureExcluded)continue;
        if(Math.hypot(u.x-cp.x,u.y-cp.y)>CAPTURE_RADIUS)continue;
        if(this.unitLayer(u.type)==="GROUND"&&!this.world.terrain.segmentClear(u.x,u.y,cp.x,cp.y,0))continue;
        if(u.side===0){hostPresence++;if(this.unitLayer(u.type)==="GROUND")hostGround++}
        else{guestPresence++;if(this.unitLayer(u.type)==="GROUND")guestGround++}
      }

      let side=null;
      if(hostGround>0&&guestPresence===0)side=0;
      else if(guestGround>0&&hostPresence===0)side=1;

      if(side==null){
        cp.progress=Math.max(0,cp.progress-CAPTURE_DECAY_PER_TICK);
        if(cp.progress===0)cp.progressSide=null;
        continue;
      }

      if(cp.progressSide!==side){
        cp.progress=Math.max(0,cp.progress-CAPTURE_DECAY_PER_TICK*2);
        if(cp.progress===0)cp.progressSide=side;
        continue;
      }

      cp.progress++;
      if(cp.progress>=this.msTicks(CAPTURE_DURATION_MS))this.spawnOutpost(cp,side);
    }
  }

  applyMeteorDamage(spell){
    let winner=null;
    const radius=spell.radius||SpellDefinition.statsAt("meteor",0).radius;

    this.withNearbyUnits(spell.x,spell.y,radius,indices=>{
      for(const idx of indices){
        const u=this.units[idx];
        if(!u?.alive||u.side===spell.side||u.side===NEUTRAL_SIDE)continue;
        const dist=Math.hypot(u.x-spell.x,u.y-spell.y);
        if(dist>radius)continue;

        const falloff=.45+.55*(1-dist/radius);
        const raw=Math.max(1,Math.floor((spell.unitDamage||165)*falloff));
        const r=this.applyDamage(spell.side,"meteor",u,false,raw,null,{damageClass:"area"});
        if(r)winner=r;
      }
    });

    for(const b of this.buildings){
      if(!b.complete||b.alive===false||b.side===spell.side)continue;
      if(Math.hypot(b.x-spell.x,b.y-spell.y)>radius+(BuildingDefinition.get(b.type)?.size||30))continue;

      let raw=Number(BuildingDefinition.get(b.type)?.meteorBaseDamage)||220;
      raw=Math.max(1,Math.floor(raw*(spell.buildingPct||100)/100));

      const r=this.applyDamage(spell.side,"meteor",b,true,raw,null,{damageClass:"area"});
      if(r)winner=r;
    }

    this.events.push({type:"meteorImpact",side:spell.side,x:spell.x,y:spell.y,radius});
    return winner;
  }

  applyRecallSpell(side,x,y,stats){
    const flag=this.flags[side]||this.world.bases[side];
    const candidates=[];
    for(const idx of this.nearbyUnits(x,y,stats.radius)){
      const u=this.units[idx];
      if(!u?.alive||u.side!==side||UnitDefinition.get(u.type)?.recallExcluded)continue;
      if(Math.hypot(u.x-x,u.y-y)>stats.radius)continue;
      candidates.push(u);
    }
    candidates.sort((a,b)=>String(a.id).localeCompare(String(b.id)));
    let used=0,moved=0;
    for(const u of candidates){
      const supply=Math.max(1,UnitDefinition.get(u.type)?.supply||1);
      if(used+supply>stats.supplyCap)continue;
      const seed=HashUtil.hash(`recall|${this.tick}|${side}|${u.id}`);
      const a=(seed%6283)/1000,ring=42+(moved%4)*22+Math.floor(moved/4)*7;
      const ur=this.unitRadius(u.type);
      let nx=RangeUtil.clamp(flag.x+Math.cos(a)*ring,ur+8,this.world.width-ur-8);
      let ny=RangeUtil.clamp(flag.y+Math.sin(a)*ring,ur+8,this.world.height-ur-8);
      if(!this.pointClearForUnit(u.type,nx,ny)){
        let found=null;
        for(let rr=55;rr<=190&&!found;rr+=28){
          for(let k=0;k<12;k++){
            const aa=a+k/12*Math.PI*2;
            const tx=RangeUtil.clamp(flag.x+Math.cos(aa)*rr,ur+8,this.world.width-ur-8);
            const ty=RangeUtil.clamp(flag.y+Math.sin(aa)*rr,ur+8,this.world.height-ur-8);
            if(this.pointClearForUnit(u.type,tx,ty)){found={x:tx,y:ty};break}
          }
        }
        if(found){nx=found.x;ny=found.y}
      }
      if(this.world.terrain.active&&!this.pointClearForUnit(u.type,nx,ny))continue;
      this.clearAttackWindup(u);
      u.x=nx;u.y=ny;u.fx=Math.round(nx*FP);u.fy=Math.round(ny*FP);
      this.syncUnitSpatial(u);
      used+=supply;moved++;
    }
    this.events.push({type:"recall",side,x,y,x2:flag.x,y2:flag.y,moved,supply:used,forced:!!flag.forced});
  }

  updateActiveSpells(){
    let winner=null;
    const keep=[];

    for(const sp of this.activeSpells){
      if(sp.type==="meteor"){
        if(!sp.resolved&&this.tick>=sp.executeTick){
          sp.resolved=true;
          winner=this.applyMeteorDamage(sp)||winner;
        }
        if(this.tick<sp.expireTick)keep.push(sp);
        continue;
      }

      if(sp.type==="tunnel"){
        if(this.tick>=sp.activateTick&&this.tick<sp.expireTick){
          if(this.tick>=sp.nextTransitTick){
            const candidates=this.units
              .filter(u=>u.alive&&u.side===sp.side&&this.unitLayer(u.type)==="GROUND"&&Math.hypot(u.x-sp.entryX,u.y-sp.entryY)<=(sp.entryRadius||SpellDefinition.statsAt("tunnel",0).entryRadius))
              .sort((a,b)=>a.id<b.id?-1:1);
            const u=candidates.find(x=>(x.tunnelLockUntil||0)<=this.tick);
            if(u){
              const supply=Math.max(1,UnitDefinition.get(u.type)?.supply||1);
              const interval=Math.max(1,Math.ceil((supply/(sp.throughputSupplyPerSec||SpellDefinition.statsAt("tunnel",0).throughputSupplyPerSec))*this.tps));
              const angle=(HashUtil.hash(sp.id+"|"+u.id+"|"+this.tick)%6283)/1000;
              const ur=this.unitRadius(u.type);
              let nx=RangeUtil.clamp(sp.exitX+Math.cos(angle)*36,ur+8,this.world.width-ur-8);
              let ny=RangeUtil.clamp(sp.exitY+Math.sin(angle)*36,ur+8,this.world.height-ur-8);

              // 출구가 건물/유닛과 겹치면 deterministic radial search로 안전점 탐색.
              if(!this.pointClearForUnit(u.type,nx,ny)){
                let found=null;
                for(let ring=1;ring<=5&&!found;ring++){
                  const rr=36+ring*(ur*2+10);
                  for(let k=0;k<12;k++){
                    const a=angle+k/12*Math.PI*2;
                    const tx=RangeUtil.clamp(sp.exitX+Math.cos(a)*rr,ur+8,this.world.width-ur-8);
                    const ty=RangeUtil.clamp(sp.exitY+Math.sin(a)*rr,ur+8,this.world.height-ur-8);
                    if(this.pointClearForUnit(u.type,tx,ty)){found={x:tx,y:ty};break}
                  }
                }
                if(found){nx=found.x;ny=found.y}
              }

              if(this.world.terrain.active&&!this.pointClearForUnit(u.type,nx,ny)){keep.push(sp);continue}
              this.clearAttackWindup(u);
              u.x=nx;u.y=ny;
              u.fx=Math.round(u.x*FP);u.fy=Math.round(u.y*FP);
              this.syncUnitSpatial(u);
              u.tunnelLockUntil=u.timers.start(this,"tunnelLock",1000);
              sp.nextTransitTick=this.tick+interval;
              this.events.push({type:"tunnelTransit",side:sp.side,x:u.x,y:u.y,unit:u.type});
            }
          }
          keep.push(sp);
        }else if(this.tick<sp.expireTick)keep.push(sp);
        continue;
      }

      if((sp.type==="flare"||sp.type==="march")&&this.tick<sp.expireTick){
        keep.push(sp);continue;
      }

      if((sp.type==="healspore"||sp.type==="sporestorm"||sp.type==="thornwall")&&this.tick<sp.expireTick){
        if(sp.type==="healspore"){
          if(this.tick>=(sp.nextPulseTick||0)){
            sp.nextPulseTick=this.tick+this.msTicks(500);
            const healPulse=Math.max(1,Math.round((sp.healPerSecond||1)/2));
            for(const idx of this.nearbyUnits(sp.x,sp.y,sp.radius||0)){
              const u=this.units[idx];
              if(!u?.alive||u.side!==sp.side||UnitDefinition.get(u.type)?.spellHealExcluded||u.hp>=u.maxHp)continue;
              if(Math.hypot(u.x-sp.x,u.y-sp.y)>(sp.radius||0))continue;
              const before=u.hp;u.hp=Math.min(u.maxHp,u.hp+healPulse);
              if(u.hp>before)this.events.push({type:"heal",side:sp.side,x:u.x,y:u.y,amount:u.hp-before,sourceType:"healspore"});
            }
          }
        }else{
          if(sp.type==="thornwall"){
            for(const idx of this.nearbyUnits(sp.x,sp.y,sp.radius||0)){
              const u=this.units[idx];
              if(!u?.alive||u.side===sp.side||u.side===NEUTRAL_SIDE||this.unitLayer(u.type)!=="GROUND")continue;
              if(Math.hypot(u.x-sp.x,u.y-sp.y)>(sp.radius||0))continue;
              u.status.applySlowUntil(this.tick+this.msTicks(100));
            }
          }
          if(this.tick>=(sp.nextPulseTick||0)){
            const continuous=this.continuousDamageProfile(sp.continuous);if(!continuous){keep.push(sp);continue}
            sp.nextPulseTick=this.tick+Math.max(1,this.msTicks(continuous.damageIntervalMs));
            const pulseDamage=continuous.damagePerTick;
            this.withNearbyUnits(sp.x,sp.y,sp.radius||0,indices=>{
              for(const idx of indices){
                const u=this.units[idx];
                if(!u?.alive||u.side===sp.side||u.side===NEUTRAL_SIDE)continue;
                if(sp.type==="thornwall"&&this.unitLayer(u.type)!=="GROUND")continue;
                if(Math.hypot(u.x-sp.x,u.y-sp.y)>(sp.radius||0))continue;
                this.applyDamage(sp.side,sp.type,u,false,pulseDamage,null,{damageClass:"area",damageDelivery:"continuous",deliverySeconds:continuous.deliverySeconds});
              }
            });
          }
        }
        keep.push(sp);continue;
      }
    }

    this.activeSpells=keep;
    return winner;
  }

  updateCamps(){
    for(const camp of this.camps){
      const cd=CampDefinition.get(camp.kind);
      if(!cd)continue;

      if(camp.state==="alive"){
        if(!cd.scenarioObject)this.updateCampAggroGauge(camp,cd);

        const campSide=cd.scenarioObject&&(camp.side===0||camp.side===1)?camp.side:NEUTRAL_SIDE;
        const alive=this.units.some(u=>u.alive&&u.side===campSide&&(u.campId||u.scenarioGroupId)===camp.id);
        if(!alive){
          if(cd.scenarioObject||cd.unitBasedNeutralObject){camp.state="cleared";this.events.push({type:"scenarioObjectCleared",side:cd.unitBasedNeutralObject?camp.friendlySide:camp.side,x:camp.x,y:camp.y,campId:camp.id,label:camp.label||camp.id});continue}
          if(cd.mainObjective){
            if(camp.lastHitSide===0||camp.lastHitSide===1)this.spawnCapturedObjective(camp,camp.lastHitSide);
            else this.beginObjectiveRespawn(camp,camp.lastDeathX??camp.x,camp.lastDeathY??camp.y);
            continue;
          }
          if(camp.lastHitSide===0||camp.lastHitSide===1){
            const side=camp.lastHitSide;
            this.wallet[side]+=cd.clearBonus;
            this.events.push({type:"campClear",side,x:camp.x,y:camp.y,camp:camp.kind,bonus:cd.clearBonus});
            if(camp.spellReward){
              this.spellChests[side]=(this.spellChests[side]||0)+1;
              this.events.push({type:"tacticalChestEarned",side,source:camp.id,count:this.spellChests[side]});
              const cp=this.capturePoint(camp.captureId);
              if(cp&&cp.owner==null){cp.enabled=true;cp.progress=0;cp.progressSide=null;this.events.push({type:"captureEnabled",side,captureId:cp.id,lane:cp.lane,x:cp.x,y:cp.y})}
            }
          }
          camp.state="cooldown";camp.respawnAt=this.tick+this.msTicks(cd.respawnMs);
        }
      }else if(camp.state==="captured"){
        const captured=this.capturedObjectiveForCamp(camp);
        if(!captured?.alive)this.beginObjectiveRespawn(camp,camp.lastDeathX??camp.x,camp.lastDeathY??camp.y);
      }else if(camp.state==="cooldown"&&this.tick>=camp.respawnAt){
        this.spawnCamp(camp);
        if(cd.mainObjective){
          const unit=UnitCompositionDefinition.first(camp.composition?.length?camp.composition:cd.composition);
          this.events.push({type:"objectiveRespawned",side:NEUTRAL_SIDE,x:camp.x,y:camp.y,camp:camp.kind,unit,sourceType:unit,lane:camp.laneKey});
        }else this.events.push({type:"campRespawn",side:NEUTRAL_SIDE,x:camp.x,y:camp.y,camp:camp.kind});
      }
    }
  }

  createBaseAndWorkers(side){
    const bp=side===0?(this.mapDescriptor?.spawns?.host||this.world.bases[0]):(this.mapDescriptor?.spawns?.guest||this.world.bases[1]);
    const base=new Building({
      id:"base"+side,type:BuildingDefinition.forRole("mainBase"),side,x:bp.x,y:bp.y,
      hp:BuildingDefinition.get(BuildingDefinition.forRole("mainBase")).hp,maxHp:BuildingDefinition.get(BuildingDefinition.forRole("mainBase")).hp,
      complete:true,progress:0,queue:[],gasWorkerTarget:0
    });
    this.buildings.push(base);
    this.markBuildingSpatialDirty();

    if(this.launchMode)return;
    // 시작 일꾼도 건물 collider 밖의 안전한 SpawnPort를 사용한다.
    for(let i=0;i<STARTING_WORKER_COUNT;i++){
      const u=this.spawnFromBuilding(base,ECONOMY_WORKER_TYPE);
      if(!u){
        // 맵 시작 직후라 사실상 발생하지 않지만, 결정론적 최후 fallback.
        const angle=(side===0?-Math.PI/4:Math.PI*3/4)+(i-2)*.28;
        const rr=BuildingDefinition.get(BuildingDefinition.forRole("mainBase")).size+ECONOMY_WORKER_DEF.size*COLLISION_RADIUS_SCALE+SPAWN_CLEARANCE+i*3;
        this.spawnUnit(
          side,ECONOMY_WORKER_TYPE,
          RangeUtil.clamp(base.x+Math.cos(angle)*rr,20,this.world.width-20),
          RangeUtil.clamp(base.y+Math.sin(angle)*rr,20,this.world.height-20)
        );
      }
    }
  }

  applyDebugScenario(raw){
    const cfg=DebugScenarioHarness.normalize(raw);
    // Debug Scenario replaces only player rosters. Generated neutral camps/main objectives
    // are part of the real map state and must remain intact unless a scenario explicitly owns them.
    this.units=this.units.filter(u=>u.side===NEUTRAL_SIDE);
    this.unitById.clear();this.unitIndexById.clear();this.runtimeIndexTick=-1;
    this.rebuildRuntimeIndexes();
    this.abilities=[{},{}];this.specialResearch=[{},{}];this.tech=[3,3];
    const humanSide=cfg.humanRole==="host"?0:1,enemySide=1-humanSide;
    // The scenario is the roster SSOT for this debug match too. This prevents normal
    // generated deck consumers (production UI / bot strategy) from reintroducing unrelated units.
    const humanRoster=DebugScenarioHarness.unitRoster(cfg,humanSide),enemyRoster=DebugScenarioHarness.unitRoster(cfg,enemySide);
    this.decks=[[],[]];this.decks[humanSide]=humanRoster.slice();this.decks[enemySide]=enemyRoster.slice();
    if(cfg.research){for(const type of humanRoster)this.abilities[humanSide][type]=true;for(const type of enemyRoster)this.abilities[enemySide][type]=true}
    const formation=(roster,count)=>{
      const cols=Math.max(1,Math.ceil(Math.sqrt(count))),rows=Math.ceil(count/cols),spacing=Math.max(24,...roster.map(type=>(this.unitRadius(type)*2)+8));
      return{cols,rows,spacing,halfHeight:Math.ceil(rows/2)*spacing};
    };
    const placeGroup=(side,roster,count,centerX,centerY)=>{
      const layout=formation(roster,count),out=[];
      for(let i=0;i<count;i++){
        const row=Math.floor(i/layout.cols),col=i%layout.cols,type=roster[i%roster.length];
        out.push({side,type,x:centerX+(col-(layout.cols-1)/2)*layout.spacing,y:centerY+(row-(layout.rows-1)/2)*layout.spacing});
      }
      return out;
    };
    const humanFormation=formation(humanRoster,cfg.allyCount),enemyFormation=formation(enemyRoster,cfg.enemyCount),gap=cfg.testMode==="mobile-battle"?humanFormation.halfHeight+enemyFormation.halfHeight+80:190;
    // Keep opposing rows separated by a small central lane at every supported roster size.
    const placeBattle=(cx,cy)=>[
      ...placeGroup(humanSide,humanRoster,cfg.allyCount,cx,humanSide===0?cy+gap/2:cy-gap/2),
      ...placeGroup(enemySide,enemyRoster,cfg.enemyCount,cx,enemySide===0?cy+gap/2:cy-gap/2)
    ];
    // The mobile battle test is a performance benchmark: it keeps the map-center start so
    // measurements stay comparable, and its largest rosters do not fit between camps anyway.
    const {x:cx,y:cy,placements}=cfg.testMode==="mobile-battle"
      ?{x:this.world.width*.5,y:this.world.height*.5,placements:placeBattle(this.world.width*.5,this.world.height*.5).map(p=>({...p,x:RangeUtil.clamp(p.x,30,this.world.width-30),y:RangeUtil.clamp(p.y,30,this.world.height-30)}))}
      :this.debugBattleSite(placeBattle);
    for(const p of placements)this.spawnUnit(p.side,p.type,p.x,p.y);
    this.flags[humanSide]={...this.flags[humanSide],x:cx,y:humanSide===0?cy-gap:cy+gap,forced:false};
    this.flags[enemySide]={...this.flags[enemySide],x:cx,y:enemySide===0?cy-gap:cy+gap,forced:false};
    this.rebuildRuntimeIndexes();
    return cfg;
  }

  // The debug battle opens on the open ground nearest the map center. Camps stay on the map,
  // so the battle must start outside every camp's aggro area on open, flat ground.
  debugBattleSite(placeBattle){
    const step=50,maxRing=Math.ceil(Math.max(this.world.width,this.world.height)/step);
    const midX=this.world.width*.5,midY=this.world.height*.5;
    const clear=p=>{
      const r=this.unitRadius(p.type);
      if(!this.world.terrain.circleClear(p.x,p.y,r)||!this.world.terrain.surfaces.buildable(p.x,p.y,r))return false;
      for(const c of this.camps){const d=CampDefinition.get(c.kind);if(Math.hypot(p.x-c.x,p.y-c.y)<(d?.aggroRadius||0)+(d?.homeSpread||0)+r)return false}
      for(const b of this.buildings)if(b.alive!==false&&Math.hypot(p.x-b.x,p.y-b.y)<(BuildingDefinition.get(b.type)?.size||0)+r+SPAWN_CLEARANCE)return false;
      return true;
    };
    for(let ring=0;ring<=maxRing;ring++)for(let i=-ring;i<=ring;i++)for(const [dx,dy] of ring?[[i,-ring],[i,ring],[-ring,i],[ring,i]]:[[0,0]]){
      const x=midX+dx*step,y=midY+dy*step,placements=placeBattle(x,y);
      if(placements.every(clear))return{x,y,placements};
    }
    throw new Error("debug battle has no open ground outside neutral camps");
  }
  setUnitControlMode(u,{side=u?.side,logicProfile=null,logicState={}}={}){
    if(!u)return null;
    const nextSide=side===0||side===1||side===NEUTRAL_SIDE?side:u.side;
    u.side=nextSide;
    u.setLogicProfile(logicProfile|| (nextSide===NEUTRAL_SIDE?"neutral-object":"default"),logicState);
    this.syncUnitSpatial(u);
    return u;
  }
  enlistNeutralObjectUnit(u,side){
    if(!u||(side!==0&&side!==1))return null;
    return this.setUnitControlMode(u,{side,logicProfile:"default"});
  }
  makeUnitNeutralObject(u,campId=null,logicState={}){
    if(!u)return null;
    const next=this.setUnitControlMode(u,{side:NEUTRAL_SIDE,logicProfile:"neutral-object",logicState:{campId,...logicState}});
    const camp=campId?this.camps.find(c=>c.id===campId):null;
    if(camp&&!camp.memberHomes?.[u.id])this.registerCampMemberHome(camp,u,u.x,u.y);
    return next;
  }

  applyCampaignScenario(raw){
    this.campaignScriptRuntime?.dispose("scenario-replace");
    const cfg=CampaignMissionDefinition.normalize(raw),humanRole=cfg.playerRole,humanSide=humanRole==="host"?0:1,enemySide=1-humanSide;
    this.campaignScenario=cfg;this.campaignTechCap=[3,3];this.campaignTechCap[humanSide]=cfg.player.techCap;this.campaignTechCap[enemySide]=cfg.enemy.techCap;
    this.applyCampaignSideSetup(humanSide,cfg.player);this.applyCampaignSideSetup(enemySide,cfg.enemy);
    this.campaignScriptRuntime=new CampaignScriptRuntime(this,cfg);this.campaignScriptRuntime.start();this.events.push({type:"campaignStart",missionId:cfg.missionId,title:cfg.title});return cfg
  }
  applyCampaignSideSetup(side,cfg){
    this.decks[side]=cfg.availableUnits.slice();this.defenseCards[side]=cfg.defenseCards.slice();this.tech[side]=cfg.startingTech;this.wallet[side]=cfg.startingResources.minerals;this.gasWallet[side]=cfg.startingResources.gas;
    const base=this.base(side),workers=this.units.filter(u=>u.alive&&u.side===side&&UnitDefinition.get(u.type)?.economyWorker),wanted=cfg.startingWorkers;
    if(workers.length>wanted){const remove=new Set(workers.slice(wanted).map(u=>u.id));this.units=this.units.filter(u=>!remove.has(u.id));this.rebuildRuntimeIndexes()}
    else for(let i=workers.length;i<wanted;i++){const u=base?this.spawnFromBuilding(base,ECONOMY_WORKER_TYPE):null;if(!u&&base)this.spawnUnit(side,ECONOMY_WORKER_TYPE,base.x+(i+1)*18,base.y+(side===0?-1:1)*90)}
    this.spawnCampaignStartingUnits(side,cfg.startingUnits);this.spawnCampaignStartingBuildings(side,cfg.startingBuildings);this.rebuildRuntimeIndexes();
  }
  spawnCampaignStartingUnits(side,composition){
    const base=this.base(side);if(!base)return;const members=UnitCompositionDefinition.expand(composition||[]),count=members.length;
    for(let i=0;i<count;i++){const a=(side===0?-Math.PI/2:Math.PI/2)+(i-(count-1)/2)*.16,rr=135+Math.floor(i/8)*38;this.spawnUnit(side,members[i],RangeUtil.clamp(base.x+Math.cos(a)*rr,30,this.world.width-30),RangeUtil.clamp(base.y+Math.sin(a)*rr,30,this.world.height-30))}
  }
  spawnCampaignStartingBuildings(side,specs){
    const base=this.base(side);if(!base)return;
    for(let i=0;i<(specs||[]).length;i++){
      const spec=specs[i],type=spec.building,bd=BuildingDefinition.get(type);if(!bd)continue;let placed=null;
      for(let attempt=0;attempt<48&&!placed;attempt++){const ring=210+Math.floor(attempt/12)*95+(i%3)*28,a=(side===0?-Math.PI*.18:Math.PI*.82)+(attempt%12)*Math.PI*2/12+i*.41,x=RangeUtil.clamp(base.x+Math.cos(a)*ring,bd.size+20,this.world.width-bd.size-20),y=RangeUtil.clamp(base.y+Math.sin(a)*ring,bd.size+20,this.world.height-bd.size-20);if(this.pointClearForBuildingSetup(type,x,y))placed={x,y}}
      if(!placed)throw new Error(`캠페인 시작 건물 배치 실패: ${type}`);
      const profile=spec.produceType?UnitDefinition.productionProfile(spec.produceType):null,b=new Building({id:`campaign-${side}-${spec.id}-${i}`,type,side,x:placed.x,y:placed.y,hp:bd.hp,maxHp:bd.hp,alive:true,complete:true,progress:bd.buildTimeMs!=null?this.msTicks(bd.buildTimeMs):this.buildingBuildTicks(bd),constructionState:"complete",builderUnitId:null,constructionHpGranted:bd.hp,produceType:spec.produceType||null,productionTotal:profile?.totalUnits||0,productionRemaining:profile?.totalUnits||0,productionBatchSize:profile?.batchSize||0,productionTicks:profile?.productionMs?this.msTicks(profile.productionMs):(profile?.productionTicks||0),productionBatchesCompleted:0,constructionMineralCost:0,constructionGasCost:0,gasNodeId:null,gasWorkerTarget:0,cooldownUntil:0,attackCooldownPhase:0,attackFlash:0,beamTargetId:null,beamStartedAt:-1,beamStage:0,queue:[]});
      this.buildings.push(b);this.markBuildingSpatialDirty();this.onBuildingComplete(b);
    }
  }
  spawnUnit(side,type,x,y,options=null){
    const d=UnitDefinition.get(type);
    if(this.unitLayer(type)!=="AIR"&&this.world.terrain.active){
      const q=this.world.terrain.nearestOpen(x,y,this.unitRadius(type)+1,256);
      if(!q)throw new Error(`생성 위치에 지상 공간이 없습니다: ${type} (${x},${y})`);
      x=q.x;y=q.y;
    }
    const passiveMaxHp=this.passiveUnitMaxHp(side,type);
    const manaMax=UnitDefinition.manaMax(type),manaSchedule=UnitDefinition.manaRegenSchedule(type,this.tps),initialMana=UnitDefinition.initialMana(type);
    const u=new Unit({
      id:"u"+(++this.seq),type,side,logic:{type:options?.logicProfile||(side===NEUTRAL_SIDE?"neutral-object":"default"),state:options?.logicState||{}},fx:Math.round(x*FP),fy:Math.round(y*FP),x,y,
      hp:passiveMaxHp,maxHp:passiveMaxHp,alive:true,hitGuard:this.initialHitGuard(side,type),
      resources:{manaMax,mana:initialMana,nextManaRegenTick:manaSchedule&&initialMana<manaMax?this.tick+manaSchedule.intervalTicks:0}
    });
    UNIT_COMBAT_BEHAVIORS[type]?.init?.(this,u);
    this.units.push(u);
    this.ensureCollisionBuffers(this.units.length);
    const birth=this.units.length-1;
    this.collisionStartFx[birth]=u.fx;this.collisionStartFy[birth]=u.fy;
    this.collisionStartCount=this.units.length;
    this.addRuntimeUnit(u);this.navigation.motion.remember(u,false);
    if((side===0||side===1)&&this.balanceStats){
      if(d.tier===2&&this.balanceStats.firstTier2UnitTick[side]==null)this.balanceStats.firstTier2UnitTick[side]=this.tick;
      if(d.tier===3&&this.balanceStats.firstTier3UnitTick[side]==null)this.balanceStats.firstTier3UnitTick[side]=this.tick;
    }
    return u;
  }

  unitRadius(type){return InteractionGeometry.unitRadius(type)}

  // Common geometry/interaction contract.
  // buildingClearanceDistance is the closest center distance allowed by
  // movement + static-building PBD. interactionDistance is gameplay reach.
  // Building interactions must stay reachable outside that physical envelope.
  buildingClearanceDistance(unitOrType,buildingOrType){return InteractionGeometry.buildingClearance(unitOrType,buildingOrType)}

  
  isAlliedCollisionUnit(a,b){
    return !!a&&!!b&&(a.side===0||a.side===1)&&a.side===b.side;
  }
  

  interactionDistance(source,target,kind,extra=0){
    if(source&&target&&Number.isFinite(source.x)&&Number.isFinite(target.x)&&InteractionGeometry.requiresTerrainLine(source,kind,extra)&&!this.world.terrain.segmentClear(source.x,source.y,target.x,target.y,0))return -1;
    return InteractionGeometry.reach(source,target,kind,extra);
  }

  attackWindupTicksFor(u,d,ability=false){
    const ms=Number.isFinite(Number(d?.attackWindupMs))
      ?Math.max(0,Math.round(Number(d.attackWindupMs)))
      :DEFAULT_ATTACK_WINDUP_MS;
    return SimulationTiming.msToTicks(ms,this.tps);
  }

  attackMoveRecoveryDurationTicks(u,d){
    const ms=Number.isFinite(Number(d?.attackMoveRecoveryMs))
      ?Math.max(0,Math.round(Number(d.attackMoveRecoveryMs)))
      :d?.role==="artillery"?DEFAULT_ARTILLERY_MOVE_RECOVERY_MS
      :d?.projectile?DEFAULT_RANGED_MOVE_RECOVERY_MS
      :DEFAULT_MELEE_MOVE_RECOVERY_MS;
    return SimulationTiming.msToTicks(ms,this.tps,{min:0});
  }

  updateUnitMana(u){
    if(!u||!u.alive)return;
    const max=UnitDefinition.manaMax(u.type),schedule=UnitDefinition.manaRegenSchedule(u.type,this.tps);
    if(max<=0){u.resources.manaMax=0;u.resources.mana=0;u.resources.nextManaRegenTick=0;return}
    u.resources.manaMax=max;
    if(!Number.isFinite(Number(u.resources.mana)))u.resources.mana=max;
    u.resources.mana=Math.max(0,Math.min(max,Math.round(Number(u.resources.mana)||0)));
    if(!schedule){u.resources.nextManaRegenTick=0;return}
    if(!Number.isFinite(Number(u.resources.nextManaRegenTick))||u.resources.nextManaRegenTick<=0)u.resources.nextManaRegenTick=this.tick+schedule.intervalTicks;
    if(u.resources.mana>=max){u.resources.nextManaRegenTick=this.tick+schedule.intervalTicks;return}
    if(this.tick<(u.resources.nextManaRegenTick||0))return;
    const steps=1+Math.floor((this.tick-u.resources.nextManaRegenTick)/schedule.intervalTicks);
    u.resources.mana=Math.min(max,u.resources.mana+steps*schedule.amount);
    u.resources.nextManaRegenTick+=steps*schedule.intervalTicks;
    if(u.resources.mana>=max)u.resources.nextManaRegenTick=this.tick+schedule.intervalTicks;
  }
  consumeUnitMana(u,amount){
    const cost=Math.max(0,Math.round(Number(amount)||0));
    if(cost<=0)return true;
    if(!u||Math.round(Number(u.resources.mana)||0)<cost)return false;
    u.resources.mana=Math.max(0,Math.round(Number(u.resources.mana)||0)-cost);
    return true;
  }
  tickAttackTimers(u,includeSlow=false){
    u.combat.lastTimerTick=this.tick;
    if(u.hitFlash>0)u.hitFlash--;
    if(u.attackFlash>0)u.attackFlash--;

  }

  clearAttackWindup(u){
    if(!u)return;
    u.combat.attackWindupUntil=0;
    u.combat.attackWindupStartedAt=0;
    u.combat.attackWindupTargetId=null;
    u.combat.attackWindupIsBuilding=false;
    UNIT_COMBAT_BEHAVIORS[u.type]?.onWindupClear?.(this,u)
  }

  startAttackWindup(u,target,isBuilding,d,attackRange,ability=false){
    if(!u||!target)return false;
    const total=this.attackWindupTicksFor(u,d,ability);
    u.combat.attackWindupStartedAt=this.tick;
    u.combat.attackWindupUntil=this.tick+total;
    u.combat.attackWindupTargetId=target.id;
    u.combat.attackWindupIsBuilding=!!isBuilding;
    u.target=target.id;
    UNIT_COMBAT_BEHAVIORS[u.type]?.onWindupStart?.(this,u,target)
    return true;
  }

  attackWindupTarget(u){
    if(!u?.combat.attackWindupTargetId)return null;
    const ref=this.liveEntityRefById(
      u.combat.attackWindupTargetId,
      u.combat.attackWindupIsBuilding?"building":"unit"
    );
    return ref?.entity||null;
  }

  tickAttackWindup(u){
    if(!u||!u.combat.attackWindupUntil)return false;
    const ready=this.tick>=u.combat.attackWindupUntil;
    UNIT_COMBAT_BEHAVIORS[u.type]?.onWindupTick?.(this,u)
    return ready;
  }

  attackReadyAfterWindup(u,target,isBuilding,d,attackRange,ability=false){
    if((u.combat.attackWindupUntil||0)>0){
      if(!this.tickAttackWindup(u))return false;
      this.clearAttackWindup(u);
      u.target=target.id;
      return true;
    }
    if(u.combat.cooldownActive(this))return false;
    this.startAttackWindup(u,target,isBuilding,d,attackRange,ability);
    return false;
  }

  basicAttackVariantsFor(u){
    const variants=UnitDefinition.get(u?.type)?.basicAttack?.variants;
    return Array.isArray(variants)?variants:[];
  }
  attackVariantAvailable(u,variant){
    const req=variant?.requires||{};
    if(req.research&&!this.hasSpecialResearch(u.side,req.research))return false;
    if(req.ability&&!this.hasAbility(u.side,req.ability))return false;
    return true;
  }
  attackVariantTriggered(u,variant,attackOrdinal){
    const tr=variant?.trigger||{};
    if(tr.type==="everyN"){
      const n=Math.max(1,Number(tr.n)||1);
      return attackOrdinal%n===0;
    }
    if(tr.type==="chance"){
      const chance=RangeUtil.clamp(Number(tr.chance)||0,0,1);
      // Stateless deterministic roll: stable across peers/recovery and consumes no RNG stream.
      // Hash avalanche prevents sequential attack ordinals from inheriting
      // correlation from the lightweight string hash.
      let bits=HashUtil.hash(`${this.seed}|${u.id}|attack-variant|${variant.id||variant.attack?.type||"variant"}|${attackOrdinal}`)>>>0;
      bits^=bits>>>16;bits=Math.imul(bits,0x7feb352d)>>>0;
      bits^=bits>>>15;bits=Math.imul(bits,0x846ca68b)>>>0;bits^=bits>>>16;
      const roll=(bits>>>0)/4294967296;
      return roll<chance;
    }
    if(tr.type==="always")return true;
    return false;
  }
  selectBasicAttackVariant(u){
    const ordinal=(u.behaviorState.basicAttackCount||0)+1;
    u.behaviorState.basicAttackCount=ordinal;
    const variants=this.basicAttackVariantsFor(u)
      .filter(v=>this.attackVariantAvailable(u,v))
      .slice().sort((a,b)=>(Number(b.priority)||0)-(Number(a.priority)||0)||String(a.id||"").localeCompare(String(b.id||"")));
    for(const variant of variants)if(this.attackVariantTriggered(u,variant,ordinal))return variant;
    return null;
  }
  continuousDamageProfile(profile){
    if(!profile)return null;
    const dps=Math.max(0,Number(profile.dps)||0);
    const damageIntervalMs=Math.max(1,Math.round(Number(profile.damageIntervalMs)||1));
    const durationMs=profile.durationMs==null?null:Math.max(1,Math.round(Number(profile.durationMs)||1));
    return {dps,damageIntervalMs,durationMs,deliverySeconds:damageIntervalMs/1000,damagePerTick:dps*(damageIntervalMs/1000)};
  }
  breathVariantPulse({side,sourceType,sourceId,x,y,dirX,dirY,range,angleDeg,damage,damageClass,damageDelivery="hit",deliverySeconds=0}){
    let winner=null;
    this.withNearbyUnits(x,y,range+this.maxUnitRadius,indices=>{
      for(const idx of indices){
        const e=this.units[idx];
        if(!e?.alive||e.side===side||this.unitLayer(e.type)!=="GROUND")continue;
        const ex=e.x-x,ey=e.y-y,dist=Math.hypot(ex,ey)||1,radius=this.unitRadius(e.type);
        const angularPad=Math.asin(Math.min(1,radius/dist));
        if(dist>range||(ex*dirX+ey*dirY)/dist<Math.cos(angleDeg*Math.PI/360+angularPad))continue;
        const w=this.applyDamage(side,sourceType,e,false,damage,sourceId,{damageClass,damageDelivery,deliverySeconds});if(w)winner=w;
      }
    });
    for(const b of this.buildings){
      if(!b||b.alive===false||b.side===side)continue;
      const ex=b.x-x,ey=b.y-y,dist=Math.hypot(ex,ey)||1,radius=BuildingDefinition.get(b.type)?.size||0;
      const angularPad=Math.asin(Math.min(1,radius/dist));
      if(dist>range||(ex*dirX+ey*dirY)/dist<Math.cos(angleDeg*Math.PI/360+angularPad))continue;
      const w=this.applyDamage(side,sourceType,b,true,damage,sourceId,{damageClass,damageDelivery,deliverySeconds});if(w)winner=w;
    }
    return winner;
  }
  executeBreathAttackVariant(u,target,isBuilding,attack){
    if(!u||!target||!attack)return null;
    const range=Math.max(1,Number(attack.range)||UnitDefinition.get(u.type)?.range||100);
    const angleDeg=RangeUtil.clamp(Number(attack.angleDeg)||30,1,180);
    const continuous=this.continuousDamageProfile(attack.continuous);
    if(!continuous||continuous.durationMs==null)return null;
    const pulseOffsets=SimulationTiming.periodicTickOffsets(continuous.durationMs,continuous.damageIntervalMs,this.tps,{fireImmediately:true});
    const pulseDamage=Math.max(0,continuous.damagePerTick);
    const damageClass=VALID_DAMAGE_CLASSES.has(attack.damageClass)?attack.damageClass:UnitDefinition.damageClass(u.type);
    const dx0=target.x-u.x,dy0=target.y-u.y,len=Math.hypot(dx0,dy0)||1,dx=dx0/len,dy=dy0/len;
    for(const offsetTicks of pulseOffsets){
      this.queueDelayedEffect({
        kind:"breathVariantPulse",executeTick:this.tick+offsetTicks,
        side:u.side,sourceType:u.type,sourceId:u.id,x:u.x,y:u.y,
        dirX:dx,dirY:dy,range,angleDeg,damage:pulseDamage,damageClass,
        damageDelivery:"continuous",deliverySeconds:continuous.deliverySeconds
      });
    }
    this.events.push({
      type:"attackVariantBreath",side:u.side,x:u.x,y:u.y,dirX:dx,dirY:dy,
      range,angleDeg,durationMs:continuous.durationMs,damageIntervalMs:continuous.damageIntervalMs,
      durationTicks:SimulationTiming.msToTicks(continuous.durationMs,this.tps),
      sourceId:u.id,sourceType:u.type,targetId:target.id,vfxPreset:attack.vfxPreset||"fireBreath"
    });
    return null;
  }
  executeBasicAttackVariant(u,target,isBuilding,variant){
    const attack=variant?.attack||{};
    if(attack.type==="breath")return {handled:true,winner:this.executeBreathAttackVariant(u,target,isBuilding,attack)};
    if(attack.type==="projectile"){
      const d=UnitDefinition.get(u.type),damage=d.atk*this.specialResearchNumericMultiplier(u.side,u.type,"attackMultiplier");
      this.spawnProjectile({id:"p"+(++this.seq),owner:u.id,side:u.side,type:u.type,x:u.x,y:u.y,target:target.id,isBuilding,speed:d.projectile,damage,damageClass:UnitDefinition.damageClass(u.type),impactEventKind:attack.vfxPreset==="medicShock"?"shockwave":null,visualTag:attack.vfxPreset||null,arcHeight:Math.max(0,Number(attack.arcHeight)||0),impactKnockbackDistance:Math.max(0,Number(attack.knockbackDistance)||0)});
      this.events.push({type:"shoot",side:u.side,x:u.x,y:u.y,unit:u.type,sourceId:u.id,targetId:target.id,targetType:target.type,visualTag:attack.vfxPreset||null});
      return {handled:true,winner:null};
    }
    return {handled:false,winner:null};
  }

  attackCooldownJitterMs(entity){
    // Preserve the former 20TPS ±1-tick flavor as deterministic ±50ms,
    // independent of the selected simulation TPS.
    const id=String(entity?.id||entity?.type||"attack");
    const slot=HashUtil.hash(`${id}|attack-cooldown|${this.tick}`)&3;
    return slot===0?-50:slot===1?0:50;
  }

  commitAttackTiming(u,d,cooldown=d.cooldown){
    const cooldownMs=Number.isFinite(Number(d?.cooldownMs))
      ?Math.max(1,Math.round(Number(d.cooldownMs)))
      :Math.max(1,Math.round(Number(cooldown||0)*1000));
    const effectiveMs=Math.max(1,cooldownMs+this.attackCooldownJitterMs(u));
    const scheduled=SimulationTiming.timerTicksWithPhase(effectiveMs,this.tps,u.combat.attackCooldownPhase||0,{min:1});
    u.combat.attackCooldownPhase=scheduled.phase;
    u.combat.cooldownUntil=this.tick+scheduled.ticks;
    u.combat.moveRecoveryUntil=this.tick+this.attackMoveRecoveryDurationTicks(u,d);
    u.attackFlash=1;
  }

  tryResetBasicAttackCooldown(u,d,ability=false){
    if(!ability||!u?.alive)return false;
    const chance=RangeUtil.clamp(Number(d?.abilityAttackCooldownResetChance)||0,0,1);
    if(chance<=0)return false;
    const ordinal=(u.behaviorState.attackCooldownResetRollCount||0)+1;
    u.behaviorState.attackCooldownResetRollCount=ordinal;
    // Stateless deterministic roll: each committed normal attack owns one roll.
    // A successful reset only clears the cooldown; the following hit is a fully normal
    // basic attack and therefore receives its own independent roll.
    let bits=HashUtil.hash(`${this.seed}|${u.id}|attack-cooldown-reset|${ordinal}`)>>>0;
    bits^=bits>>>16;bits=Math.imul(bits,0x7feb352d)>>>0;
    bits^=bits>>>15;bits=Math.imul(bits,0x846ca68b)>>>0;bits^=bits>>>16;
    if((bits>>>0)/4294967296>=chance)return false;
    u.combat.cooldownUntil=this.tick;
    this.events.push({type:"attackCooldownReset",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type});
    return true;
  }

  pointClearForUnit(type,x,y,ignoreBuildingId=null,reserved=[]){
    const ur=this.unitRadius(type);

    if(x<ur+8||x>this.world.width-ur-8||y<ur+8||y>this.world.height-ur-8)return false;

    const layer=this.unitLayer(type);
    if(layer!=="AIR"&&!this.world.terrain.circleClear(x,y,ur+1))return false;
    if(layer!=="AIR")for(const b of this.buildings){
      if(b.alive===false||b.id===ignoreBuildingId)continue;
      const br=BuildingDefinition.get(b.type)?.size||35;
      const clearance=Math.max(this.buildingClearanceDistance(type,b),ur+br+SPAWN_UNIT_GAP);
      if(Math.hypot(x-b.x,y-b.y)<clearance)return false;
    }

    const nearby=this.runtimeIndexTick===this.tick
      ?this.nearbyUnits(x,y,ur+this.maxUnitRadius+SPAWN_UNIT_GAP)
      :null;
    if(nearby){
      for(const idx of nearby){
        const u=this.units[idx];
        if(!u?.alive||this.unitLayer(u.type)!==layer)continue;
        const other=this.unitRadius(u.type);
        if(Math.hypot(x-u.x,y-u.y)<ur+other+SPAWN_UNIT_GAP)return false;
      }
    }else{
      for(const u of this.units){
        if(!u.alive||this.unitLayer(u.type)!==layer)continue;
        const other=this.unitRadius(u.type);
        if(Math.hypot(x-u.x,y-u.y)<ur+other+SPAWN_UNIT_GAP)return false;
      }
    }

    for(const p of reserved||[]){
      if(this.unitLayer(p.type||type)!==layer)continue;
      const other=this.unitRadius(p.type||type);
      if(Math.hypot(x-p.x,y-p.y)<ur+other+SPAWN_UNIT_GAP)return false;
    }

    return true;
  }

  findOpenSpawnAround(anchor,type,{baseRadius=null,maxRadius=null,angleSlots=12,radialStep=8,seedKey="spawn",reserved=[]}={}){
    if(!anchor)return null;
    const ur=this.unitRadius(type),ar=anchor.type?this.unitRadius(anchor.type):0;
    const start=Math.max(ur+ar+SPAWN_UNIT_GAP,Number(baseRadius)||0);
    const limit=Math.max(start,Number(maxRadius)||start+48),slots=Math.max(8,Math.round(Number(angleSlots)||12)),step=Math.max(4,Number(radialStep)||8);
    const phase=(HashUtil.hash(String(seedKey))%6283)/1000;
    for(let rr=start;rr<=limit+0.001;rr+=step){
      for(let k=0;k<slots;k++){
        const a=phase+k*Math.PI*2/slots,x=RangeUtil.clamp(anchor.x+Math.cos(a)*rr,ur+8,this.world.width-ur-8),y=RangeUtil.clamp(anchor.y+Math.sin(a)*rr,ur+8,this.world.height-ur-8);
        if(this.pointClearForUnit(type,x,y,null,reserved))return{x,y};
      }
    }
    return null;
  }

  preferredSpawnAngle(b,type){
    let tx=null,ty=null;

    // 일꾼은 가장 가까운 광물 방향으로 출구를 우선한다.
    if(UnitDefinition.get(type)?.economyWorker){
      let best=null,bestD=Infinity;
      for(const r of this.resources){
        if(r.amount<=0)continue;
        const d=(r.x-b.x)*(r.x-b.x)+(r.y-b.y)*(r.y-b.y);
        if(d<bestD||(d===bestD&&best&&r.id<best.id)){best=r;bestD=d}
      }
      if(best){tx=best.x;ty=best.y}
    }

    // 전투 유닛은 현재 랠리 플래그 방향.
    if(tx==null||ty==null){
      const f=this.flags[b.side];
      if(f){tx=f.x;ty=f.y}
    }

    // 플래그가 건물과 거의 같은 지점이면 적 메인 방향.
    if(tx==null||Math.hypot(tx-b.x,ty-b.y)<40){
      const enemy=this.world.bases[1-b.side];
      tx=enemy.x;ty=enemy.y;
    }

    return Math.atan2(ty-b.y,tx-b.x);
  }

  findSpawnPoint(b,type,reserved=[]){
    const ur=this.unitRadius(type);
    const br=BuildingDefinition.get(b.type)?.size||35;
    const radius=br+ur+SPAWN_CLEARANCE;
    const baseAngle=this.preferredSpawnAngle(b,type);

    // 한 개의 명시적 출구를 우선하되 막혀 있으면 좌/우 보조 출구를 순서대로 검사.
    const offsets=[
      0,
      Math.PI/6,-Math.PI/6,
      Math.PI/3,-Math.PI/3,
      Math.PI/2,-Math.PI/2,
      Math.PI*5/6,-Math.PI*5/6,
      Math.PI
    ];

    for(const off of offsets){
      const a=baseAngle+off;
      const x=Math.round(b.x+Math.cos(a)*radius);
      const y=Math.round(b.y+Math.sin(a)*radius);

      if(this.pointClearForUnit(type,x,y,b.id,reserved))return{x,y};
    }

    return null;
  }

  spawnFromBuilding(b,type){
    if(!b||b.alive===false||!b.complete)return null;
    const p=this.findSpawnPoint(b,type);
    if(!p)return null;
    return this.spawnUnit(b.side,type,p.x,p.y);
  }

  findSpawnPointsForBatch(b,type,count){
    const points=[];
    for(let i=0;i<count;i++){
      const p=this.findSpawnPoint(b,type,points.map(x=>({...x,type})));
      if(!p)return null;
      points.push(p);
    }
    return points;
  }

  spawnBatchFromBuilding(b,type,count){
    if(!b||b.alive===false||!b.complete||count<=0)return null;
    const points=this.findSpawnPointsForBatch(b,type,count);
    if(!points)return null;
    return points.map(p=>this.spawnUnit(b.side,type,p.x,p.y));
  }

  queueCommand(cmd){let arr=this.scheduled.get(cmd.tick);if(!arr){arr=[];this.scheduled.set(cmd.tick,arr)}arr.push(cmd);arr.sort((a,b)=>a.seq-b.seq)}
  base(side){return this.buildings.find(b=>b.alive!==false&&b.side===side&&BuildingDefinition.get(b.type)?.isMainBase)}
  completed(side,type){return this.buildings.some(b=>b.alive!==false&&b.side===side&&b.type===type&&b.complete)}
  supplyCap(side){return SupplyPolicy.cap(this,side)}
  supplyUsed(side){return SupplyPolicy.used(this,side)}
  canReserveSupply(side,type){
    return this.canReserveBatchSupply(side,type,1);
  }
  canReserveBatchSupply(side,type,count){
    const need=(UnitDefinition.get(type)?.supply||0)*Math.max(1,count||1);
    return this.supplyUsed(side)+need<=this.supplyCap(side);
  }
  nextProductionBatchSize(b){
    if(!b||!b.produceType)return 0;
    const remain=Math.max(0,b.productionRemaining||0);
    return Math.min(Math.max(1,b.productionBatchSize||1),remain);
  }
  reservableProductionBatchSize(side,b){
    const desired=this.nextProductionBatchSize(b);
    if(desired<=0||!b?.produceType)return 0;
    const perUnit=Math.max(0,Number(UnitDefinition.get(b.produceType)?.supply)||0);
    if(perUnit<=0)return desired;
    const free=Math.max(0,this.supplyCap(side)-this.supplyUsed(side));
    return Math.min(desired,Math.floor(free/perUnit));
  }
  productionSupplyBlocked(side){
    for(const b of this.buildings){
      if(b.alive===false||b.side!==side||!b.complete)continue;
      if(!BuildingDefinition.get(b.type)?.isProductionBuilding)continue;
      if(this.productionPaused[side]||!b.produceType||!this.unitUnlocked(side,b.produceType))continue;
      if((b.queue||[]).length)continue;
      const desired=this.nextProductionBatchSize(b);
      if(desired>0&&this.reservableProductionBatchSize(side,b)<=0)return true;
    }
    return false;
  }
  unitUnlocked(side,type){return !BuildPrerequisitePolicy.unitReason(this,side,type)}
  hasAbility(side,type){return !!this.abilities[side]?.[type]}
  hasSpecialResearch(side,id){return !!this.specialResearch?.[side]?.[id]}
  specialResearchMoveSpeed(side,type,baseSpeed){
    let pct=100;
    for(const d of UnitSpecialResearchDefinition.forUnit(type))if(this.hasSpecialResearch(side,d.id)&&d.effects?.moveSpeedPct)pct+=Math.max(0,Number(d.effects.moveSpeedPct)||100)-100;
    return pct===100?baseSpeed:BalanceValidation.normalizedMoveSpeedTier(baseSpeed*pct/100);
  }
  stationaryAttackRampResearch(side,type){
    return UnitSpecialResearchDefinition.forUnit(type).find(d=>this.hasSpecialResearch(side,d.id)&&Number(d.effects?.stationaryAttackSpeedPerStack)>0)||null;
  }
  specialResearchNumericMultiplier(side,type,key){
    let mult=1;for(const r of UnitSpecialResearchDefinition.forUnit(type))if(this.hasSpecialResearch(side,r.id)&&Number(r.effects?.[key])>0)mult*=Number(r.effects[key]);return mult;
  }
  nearbyDefenseTowerCount(side,x,y,excludeId=null){
    let count=0;
    for(const b of this.buildings){
      if(b.alive===false||!b.complete||b.side!==side||b.id===excludeId)continue;
      if(!BuildingDefinition.isDefenseTower(b.type))continue;
      if(Math.hypot(b.x-x,b.y-y)<=DEFENSE_CLUSTER_RADIUS)count++;
    }
    return count;
  }
  defenseFireSpeedPct(b){
    if(!b||!BuildingDefinition.isDefenseTower(b.type))return 100;
    const near=this.nearbyDefenseTowerCount(b.side,b.x,b.y,b.id);
    return PRODUCTION_CLUSTER_SPEED_PCT[Math.min(near,PRODUCTION_CLUSTER_SPEED_PCT.length-1)];
  }
  defenseAttackRange(b,d=BuildingDefinition.get(b?.type)){
    if(!b||!d)return 0;
    return Math.round((d.range||0)*(100+this.passiveTowerRangePct(b.side))/100);
  }
  buildingAllowed(side,type,produceType){return !BuildPrerequisitePolicy.buildingReason(this,side,type,produceType)}
  buildPointVisible(side,x,y){
    return this.isVisible(side,x,y,this.visionSources(side));
  }
  buildingOverlapsMineral(type,x,y){
    const bd=BuildingDefinition.get(type);
    if(!bd)return true;

    // 일반 건물은 미네랄과 가스 지점을 모두 피한다.
    for(const m of this.resources){
      const min=bd.size+(m.r||28)+MINERAL_BUILD_MARGIN;
      if(Math.hypot(m.x-x,m.y-y)<min)return true;
    }

    if(!bd.isGasExtractor){
      for(const g of this.gasNodes||[]){
        const min=bd.size+(g.r||32)+14;
        if(Math.hypot(g.x-x,g.y-y)<min)return true;
      }
    }

    return false;
  }
  nearbyProductionCount(side,x,y,excludeId=null){
    let count=0;
    for(const b of this.buildings){
      if(b.alive===false||!b.complete||b.side!==side||b.id===excludeId)continue;
      if(!BuildingDefinition.isProduction(b.type))continue;
      if(Math.hypot(b.x-x,b.y-y)<=PRODUCTION_CLUSTER_RADIUS)count++;
    }
    return count;
  }
  productionSpeedPct(b){
    if(!b||!BuildingDefinition.isProduction(b.type))return 100;
    const near=this.nearbyProductionCount(b.side,b.x,b.y,b.id);
    return PRODUCTION_CLUSTER_SPEED_PCT[Math.min(near,PRODUCTION_CLUSTER_SPEED_PCT.length-1)];
  }
  resolveConstructionTarget(id){return this.constructionOrders.find(order=>order.id===id)||this.buildingById.get(id)||this.buildings.find(b=>b.id===id)||null}
  cancelConstructionOrder(order,reason="cancelled"){
    const index=this.constructionOrders.indexOf(order);if(index<0)return false;
    this.releaseBuilderForBuilding(order);this.constructionOrders.splice(index,1);
    this.wallet[order.side]+=order.paidMineral;this.gasWallet[order.side]+=order.paidGas;
    this.events.push({type:"buildCancelled",side:order.side,x:order.x,y:order.y,building:order.type,refund:order.paidMineral,gasRefund:order.paidGas,wasComplete:false,reason});
    return true;
  }
  startConstructionOrder(order){
    if(!this.constructionOrders.includes(order))return null;
    const {side,x,y}=order,bd=BuildingDefinition.get(order.type),mineralCost=order.paidMineral,gasCost=order.paidGas;
    if(!buildingPlacementInsideWorld(order.type,x,y,this.world)||!buildingHasBuilderApproach(this,order.type,x,y)||this.buildingOverlapsMineral(order.type,x,y)||this.buildings.some(b=>b.alive!==false&&Math.hypot(b.x-x,b.y-y)<buildingPlacementSeparation(order.type,b.type))||bd.isGasExtractor&&this.gasNodeOccupied(order.gasNodeId,order.id)){
      this.cancelConstructionOrder(order,"placement-blocked");return null;
    }
    this.constructionOrders.splice(this.constructionOrders.indexOf(order),1);
    const profile=BuildingDefinition.isProduction(order.type)
      ?UnitDefinition.productionProfile(order.produceType)
      :null;

    const buildingId=order.id;
    const startHp=Math.max(1,Math.floor(bd.hp*BUILD_START_HP_PCT/100));
    const created=new Building({
      id:buildingId,type:order.type,side,x,y,
      hp:startHp,maxHp:bd.hp,complete:false,progress:0,
      constructionState:"waitingWorker",builderUnitId:order.builderUnitId,constructionHpGranted:startHp,
      produceType:BuildingDefinition.isProduction(order.type)?(order.produceType||null):null,
      productionTotal:profile?.totalUnits||0,
      productionRemaining:profile?.totalUnits||0,
      productionBatchSize:profile?.batchSize||0,
      productionTicks:profile?.productionMs?this.msTicks(profile.productionMs):(profile?.productionTicks||0),
      productionBatchesCompleted:0,
      constructionMineralCost:mineralCost,
      constructionGasCost:gasCost,
      gasNodeId:order.gasNodeId,
      gasWorkerTarget:0,
      cooldownUntil:0,attackCooldownPhase:0,attackFlash:0,
      beamTargetId:null,beamStartedAt:-1,beamStage:0,
      queue:[]
    });
    this.buildings.push(created);
    this.markBuildingSpatialDirty();
    this.events.push({type:"build",side,x,y,building:order.type,mineralCost,gasCost,gasNodeId:order.gasNodeId});
    return created;
  }
  updateConstructionOrders(){
    for(const order of this.constructionOrders.slice()){
      const builder=this.ensureBuilderForBuilding(order);
      if(this.builderCanConstruct(builder,order))this.startConstructionOrder(order);
    }
  }
  releaseBuilderForBuilding(b){
    if(!b)return;
    const id=b.builderUnitId||null;
    if(id){
      const u=this.unitById.get(id)||this.units.find(x=>x.id===id);
      if(u&&!!UnitDefinition.get(u.type)?.economyWorker&&u.buildTargetId===b.id){
        u.buildTargetId=null;
        u.workState="seek";
        u.mineId=null;
        u.worker?.resetMine();
        u.workResourceType="mineral";
      }
    }
    b.builderUnitId=null;
    if(!b.complete&&b.alive!==false)b.constructionState="waitingWorker";
  }
  assignBuilderToBuilding(b){
    if(!b||b.alive===false||b.complete)return null;
    let best=null,bestD2=Infinity;
    for(const u of this.units){
      if(!u.alive||u.side!==b.side||!UnitDefinition.get(u.type)?.economyWorker||u.buildTargetId)continue;
      const d2=this.navigation.distance(u.x,u.y,InteractionGeometry.goal(u,b,"worker-build"),u.type)**2;
      if(d2<bestD2||(d2===bestD2&&best&&String(u.id)<String(best.id))){best=u;bestD2=d2}
    }
    if(!best)return null;
    // Builder assignment interrupts economy immediately. Carried resources are discarded by design.
    best.carry=0;best.carryType=null;best.mineId=null;best.worker?.resetMine();best.workResourceType="mineral";
    best.buildTargetId=b.id;best.workState="buildTravel";
    b.builderUnitId=best.id;b.constructionState="waitingWorker";
    this.events.push({type:"builderAssigned",side:b.side,buildingId:b.id,workerId:best.id,x:b.x,y:b.y});
    return best;
  }
  ensureBuilderForBuilding(b){
    if(!b||b.alive===false||b.complete)return null;
    let u=b.builderUnitId?(this.unitById.get(b.builderUnitId)||this.units.find(x=>x.id===b.builderUnitId)):null;
    if(!u||!u.alive||!UnitDefinition.get(u.type)?.economyWorker||u.side!==b.side||u.buildTargetId!==b.id){
      this.releaseBuilderForBuilding(b);
      u=this.assignBuilderToBuilding(b);
    }
    return u||null;
  }
  builderCanConstruct(u,b){
    if(!u||!u.alive||!b||b.alive===false||b.complete||u.buildTargetId!==b.id)return false;
    if(this.isAirborneStatus(u))return false;
    return this.navigation.acceptsGoalPoint(InteractionGeometry.region(u,b,"worker-build"),u.x,u.y);
  }
  applyChargedCommand(side,action){
    const id=action.castId;if(!Number.isSafeInteger(id)||id<=0)return false;
    if(action.type==="CHARGE_BEGIN"){
      if(id<=this.chargedCastSerial[side])return false;
      const current=this.chargedCasts[side];if(current&&current.phase!=="released")return false;
      const x=RangeUtil.clamp(action.x,20,this.world.width-20),y=RangeUtil.clamp(action.y,20,this.world.height-20),memberIds=[],unavailableIds=[];
      for(const i of this.nearbyUnits(x,y,ChargedSkillGeometry.gatheringR)){
        const u=this.units[i],cap=u?.capability(ChargedSkillMixin.KEY);if(!u?.alive||u.side!==side||!cap||Math.hypot(u.x-x,u.y-y)>ChargedSkillGeometry.gatheringR)continue;
        (cap.ready(this)?memberIds:unavailableIds).push(u.id);
      }
      this.chargedCastSerial[side]=id;this.chargedCasts[side]={id,side,phase:"gathering",originX:x,originY:y,aimX:x,aimY:y,startTick:this.tick,gatherUntil:this.tick+this.msTicks(ChargedSkillGeometry.gatherMs),releaseTick:0,memberIds:memberIds.sort(),unavailableIds:unavailableIds.sort()};
      return true;
    }
    const cast=this.chargedCasts[side];if(!cast||cast.id!==id||cast.phase==="released")return false;
    if(action.type==="CHARGE_CANCEL"){this.chargedCasts[side]=null;return true}
    cast.aimX=RangeUtil.clamp(action.x,20,this.world.width-20);cast.aimY=RangeUtil.clamp(action.y,20,this.world.height-20);
    if(action.type==="CHARGE_AIM")return true;
    if(action.type!=="CHARGE_RELEASE")return false;
    if(this.tick<cast.gatherUntil){this.chargedCasts[side]=null;return true}
    cast.phase="released";cast.releaseTick=this.tick;
    for(const id of cast.memberIds)this.unitById.get(id)?.capability(ChargedSkillMixin.KEY)?.release(this,cast);
    return true;
  }
  updateChargedCasts(){
    this.chargedHeldIds=new Set();
    for(const side of [0,1]){
      const cast=this.chargedCasts[side];if(!cast)continue;
      if(cast.phase==="released"){
        if(!cast.memberIds.some(id=>{const u=this.unitById.get(id);return u?.alive&&(u.behaviorState.chargedExecution||this.tick<u.behaviorState.chargedRecoveryUntil)}))this.chargedCasts[side]=null;
      }else if(this.tick>=cast.startTick+this.msTicks(ChargedSkillGeometry.maxHoldMs))this.chargedCasts[side]=null;
      else if(this.tick>=cast.gatherUntil)cast.phase="charging";
      if(this.chargedCasts[side]&&cast.phase!=="released")for(const id of cast.memberIds)this.chargedHeldIds.add(id);
    }
  }
  chargedUnitHeld(u){
    const cast=this.chargedCasts[u.side];if(!cast||cast.phase==="released"||!this.chargedHeldIds?.has(u.id))return false;
    if(!UnitDefinition.get(u.type)?.chargedSkill||this.isAirborneStatus(u)||u.movement.impulseActive(this))return false;
    this.clearAttackWindup(u);u.target=null;
    if(cast.phase==="gathering"&&Math.hypot(u.x-cast.originX,u.y-cast.originY)>45)this.moveToward(u,cast.originX,cast.originY,UnitDefinition.get(u.type).speed);
    return true;
  }
  launchCannons(side){
    const main=BuildingDefinition.forRole("mainBase"),outpost=BuildingDefinition.forRole("outpost");
    return this.buildings.filter(b=>b.side===side&&b.alive!==false&&b.complete!==false&&(b.type===main||b.type===outpost));
  }
  applyLaunchCommand(side,action){
    if(!this.launchMode)return false;
    const cannon=this.launchCannons(side).find(b=>b.id===action.cannonId);
    if(!cannon||this.tick<(Number(cannon.launchReadyTick)||0))return false;
    const grain=LaunchRules.grain(action.unitType);if(!grain||this.wallet[side]<grain.cost)return false;
    const holdMs=Math.max(0,Math.round(action.holdMs));
    if(LaunchRules.overheated(holdMs)){
      cannon.launchReadyTick=this.tick+this.msTicks(LaunchRules.overheatMs);
      this.events.push({type:"launchOverheat",side,cannonId:cannon.id,x:cannon.x,y:cannon.y});
      return true;
    }
    const aim=LaunchRules.target(cannon,action.x,action.y,holdMs,this.world,this.flags[side],action.unitType);
    this.wallet[side]-=grain.cost;
    cannon.launchReadyTick=this.tick+this.msTicks(LaunchRules.reloadMs);
    const id="p"+(++this.seq);
    this.spawnProjectile({
      id,owner:cannon.id,side,type:action.unitType,x:cannon.x,y:cannon.y,target:null,isBuilding:false,
      trajectoryPolicy:"lockedPoint",lockedAimX:aim.x,lockedAimY:aim.y,speed:grain.speed,
      damage:grain.impact,splash:grain.splash,splashUnitDamage:grain.impact,splashBuildingDamage:grain.impact,
      damageClass:"area",sourceDamageResolved:true,payload:{type:action.unitType,count:grain.count}
    });
    this.launchStats.launches[side]++;this.launchStats.sent[side]+=grain.count;
    this.events.push({type:"launchFire",side,cannonId:cannon.id,projectileId:id,x:cannon.x,y:cannon.y,holdMs,power:LaunchRules.power(holdMs)});
    return true;
  }
  landLaunchPayload(p,x,y){
    const {type,count}=p.payload,reserved=[];
    let hold=null,best=LaunchRules.captureHoldRadius,landed=0;
    for(const cp of this.capturePoints){if(cp.owner!=null||!cp.enabled)continue;const d=Math.hypot(cp.x-x,cp.y-y);if(d<best){best=d;hold=cp}}
    const grain=LaunchRules.grain(type),anchor={x,y};
    // The line opens toward the enemy base, centred on the landing point.
    const enemy=this.buildings.find(b=>b.side===1-p.side&&b.alive!==false&&BuildingDefinition.get(b.type)?.isMainBase)||{x,y:y-1};
    const ex=enemy.x-x,ey=enemy.y-y,el=Math.hypot(ex,ey)||1,dirX=ex/el,dirY=ey/el;
    for(let i=0;i<count;i++){
      let seed=anchor,opts={baseRadius:0,maxRadius:grain.splash+60,angleSlots:12,radialStep:10};
      if(grain.land==="scatter"){
        const a=HashUtil.hash(`${p.id}|a|${i}`)%3600/3600*Math.PI*2,rr=grain.spread*Math.sqrt((HashUtil.hash(`${p.id}|r|${i}`)%1000)/1000);
        seed={x:Math.round(x+Math.cos(a)*rr),y:Math.round(y+Math.sin(a)*rr)};opts={baseRadius:0,maxRadius:60,angleSlots:8,radialStep:10};
      }else if(grain.land==="line"){
        const k=(i-(count-1)/2)*grain.spacing;
        seed={x:Math.round(x+dirX*k),y:Math.round(y+dirY*k)};opts={baseRadius:0,maxRadius:50,angleSlots:8,radialStep:10};
      }
      const spot=this.findOpenSpawnAround(seed,type,{...opts,seedKey:`${p.id}|${i}`,reserved})||seed;
      let u=null;try{u=this.spawnUnit(p.side,type,spot.x,spot.y)}catch{continue}
      reserved.push({x:u.x,y:u.y,type});
      if(hold)u.launchHoldPointId=hold.id;
      if(grain.land==="rush")this.setTimedModifier(u,"launchRush",{durationTicks:this.msTicks(grain.rushMs),movePct:grain.rushPct,attackSpeedPct:grain.rushPct});
      landed++;
    }
    this.events.push({type:"launchLand",side:p.side,unit:type,count:landed,x,y,holdPointId:hold?.id||null});
  }
  updateLaunchEconomy(){
    if(!this.launchMode)return;
    // Integer carry keeps income per second independent of tps.
    for(const side of [0,1]){
      this.launchIncomeCarry[side]+=LaunchRules.incomePerSecond;
      const gained=Math.floor(this.launchIncomeCarry[side]/this.tps);
      this.launchIncomeCarry[side]-=gained*this.tps;
      this.wallet[side]=Math.min(LaunchRules.walletCap,this.wallet[side]+gained);
    }
  }
  applyCommand(actor,action){
    if(!["host","guest"].includes(actor))return false;
    if(action?.type==="MATCH_SURRENDER"){
      if(this.netcodeMatchResult)return false;
      this.netcodeMatchResult={winner:actor==="host"?"guest":"host",reason:"surrender",tick:this.tick};return true;
    }
    const side=ConnectionSideUtil.roleSide(actor);
    if(action.type.startsWith("CHARGE_"))return this.applyChargedCommand(side,action);
    if(action.type==="LAUNCH")return this.applyLaunchCommand(side,action);
    if(action.type==="SET_FLAG"){
      this.flags[side]={x:RangeUtil.clamp(action.x,40,this.world.width-40),y:RangeUtil.clamp(action.y,40,this.world.height-40),forced:!!action.forced};
      for(const u of this.units)if(u.side===side&&!UnitDefinition.get(u.type)?.economyWorker)u.movement.routeIndex=-1;
      this.events.push({type:"flag",side,x:this.flags[side].x,y:this.flags[side].y,forced:!!action.forced});return true;
    }
    if(action.type==="TOGGLE_PRODUCTION"){this.productionPaused[side]=!this.productionPaused[side];return true;}
    if(action.type==="TRAIN_WORKER"){
      const base=this.buildings.find(b=>
        b.id===action.buildingId&&b.alive!==false&&b.complete&&b.side===side&&BuildingDefinition.get(b.type)?.isDropoff
      );
      if(!base||base.queue.length>=WORKER_QUEUE_LIMIT||!this.canReserveSupply(side,ECONOMY_WORKER_TYPE)||this.wallet[side]<WORKER_COST)return false;
      this.wallet[side]-=WORKER_COST;
      base.queue.push({kind:"workerProduction",readyTick:this.tick+this.msTicks(ECONOMY_WORKER_DEF.buildTimeMs)});
      return true;
    }

    if(action.type==="SET_GAS_WORKERS"){
      const base=this.buildings.find(b=>
        b.id===action.buildingId&&
        b.alive!==false&&
        b.complete&&
        b.side===side&&
        BuildingDefinition.get(b.type)?.isDropoff
      );
      if(!base)return false;
      base.gasWorkerTarget=RangeUtil.clamp(Math.round(Number(action.target)||0),0,GAS_ASSIGNMENT_MAX);
      this.events.push({
        type:"gasWorkerTarget",
        side,
        buildingId:base.id,
        target:base.gasWorkerTarget,
        x:base.x,y:base.y
      });
      return true;
    }

    if(action.type==="OPEN_TACTICAL_CHEST"){return this.openTacticalChest(side);}
    if(action.type==="CHOOSE_TACTICAL_REWARD"){return this.chooseTacticalReward(side,action.offerId,action.rewardId);}
    if(action.type==="REPLACE_SPELL"){return this.replaceEquippedSpell(side,action.offerId,action.oldSpellId);}
    if(action.type==="CANCEL_SPELL_REPLACEMENT"){return this.cancelSpellReplacement(side,action.offerId);}

    if(action.type==="CAST_SPELL"){
      const id=action.spellId,d=SpellDefinition.get(id),entry=this.spellEntry(side,id),sd=this.spellStats(side,id);
      if(!d||!sd||!entry.unlocked||!this.spellEquipped(side,id)||this.tick<entry.cooldownUntil)return false;

      if(id==="tunnel"){
        const ex=action.entryX,ey=action.entryY,xx=action.exitX,xy=action.exitY;
        // 입구는 현재 실제 시야, 출구는 시야 + 추가 투사 범위.
        if(!this.spellTargetAllowed(side,ex,ey,0)||!this.spellTargetAllowed(side,xx,xy,d.castMargin))return false;
        if(Math.hypot(xx-ex,xy-ey)<220)return false;
        const sp={
          id:"spell-"+(++this.seq),type:id,side,
          entryX:RangeUtil.clamp(ex,20,this.world.width-20),entryY:RangeUtil.clamp(ey,20,this.world.height-20),
          exitX:RangeUtil.clamp(xx,20,this.world.width-20),exitY:RangeUtil.clamp(xy,20,this.world.height-20),
          startTick:this.tick,activateTick:this.tick+sd.buildTime,
          expireTick:this.tick+sd.buildTime+sd.duration,nextTransitTick:this.tick+sd.buildTime,
          entryRadius:sd.entryRadius,throughputSupplyPerSec:sd.throughputSupplyPerSec,level:SpellDefinition.masteryLevel(entry.mastery)
        };
        this.activeSpells.push(sp);
        entry.cooldownUntil=this.tick+this.spellCooldownTicks(side,id);
        this.events.push({type:"spellCast",side,spell:id,x:sp.entryX,y:sp.entryY,x2:sp.exitX,y2:sp.exitY});
        return true;
      }

      const x=RangeUtil.clamp(action.x,20,this.world.width-20),y=RangeUtil.clamp(action.y,20,this.world.height-20);
      if(!this.spellTargetAllowed(side,x,y,d.castMargin))return false;
      entry.cooldownUntil=this.tick+this.spellCooldownTicks(side,id);

      if(id==="meteor"){
        this.activeSpells.push({
          id:"spell-"+(++this.seq),type:id,side,x,y,startTick:this.tick,level:SpellDefinition.masteryLevel(entry.mastery),
          executeTick:this.tick+sd.delay,expireTick:this.tick+sd.delay+12,resolved:false,radius:sd.radius,unitDamage:sd.unitDamage,buildingPct:sd.buildingPct
        });
      }else if(id==="flare"){
        this.activeSpells.push({
          id:"spell-"+(++this.seq),type:id,side,x,y,startTick:this.tick,level:SpellDefinition.masteryLevel(entry.mastery),expireTick:this.tick+sd.duration,vision:sd.vision
        });
      }else if(id==="march"){
        this.activeSpells.push({
          id:"spell-"+(++this.seq),type:id,side,x,y,startTick:this.tick,level:SpellDefinition.masteryLevel(entry.mastery),radius:sd.radius,speedPct:sd.speedPct,expireTick:this.tick+sd.duration
        });
      }else if(id==="healspore"||id==="sporestorm"||id==="thornwall"){
        this.activeSpells.push({
          id:"spell-"+(++this.seq),type:id,side,x,y,startTick:this.tick,level:SpellDefinition.masteryLevel(entry.mastery),radius:sd.radius,expireTick:this.tick+sd.duration,
          healPerSecond:sd.healPerSecond||0,continuous:sd.continuous?{...sd.continuous}:null,slowPct:sd.slowPct||0,nextPulseTick:this.tick
        });
      }else if(id==="rootbind"){
        for(const idx of this.nearbyUnits(x,y,sd.radius)){
          const u=this.units[idx];
          if(!u?.alive||u.side===side||u.side===NEUTRAL_SIDE||this.unitLayer(u.type)!=="GROUND")continue;
          if(Math.hypot(u.x-x,u.y-y)>sd.radius)continue;
          u.status.applySlowUntil(this.tick+sd.slowDuration);
        }
        this.events.push({type:"rootBind",side,x,y,radius:sd.radius,duration:sd.slowDuration});
      }else if(id==="recall"){
        this.applyRecallSpell(side,x,y,sd);
      }
      this.events.push({type:"spellCast",side,spell:id,x,y});
      return true;
    }
    if(action.type==="START_RESEARCH"){
      if(this.tech[side]<2)return false;
      const channel=action.research;
      if(!["attack","armor","ability"].includes(channel))return false;
      const queues=this.researchQueues[side]||(this.researchQueues[side]={attack:null,armor:null,ability:null});

      // 공격/방어 업그레이드는 하나의 전투 연구 슬롯을 공유한다.
      if(channel==="attack"||channel==="armor"){
        if(queues.attack||queues.armor)return false;
      }else if(queues[channel])return false;

      const {def,level,unit,researchId}=ResearchDefinition.resolveAction(this,side,action);

      const gasCost=Math.max(0,Number(def?.gasCost)||0);
      if(!def||this.wallet[side]<def.cost||this.gasWallet[side]<gasCost)return false;
      this.wallet[side]-=def.cost;
      this.gasWallet[side]-=gasCost;
      const researchTicks=this.scaledResearchTicks(def.timeMs!=null?this.msTicks(def.timeMs):def.time);
      queues[channel]={
        kind:"research",research:channel,unit,level,researchId,
        readyTick:this.tick+researchTicks,total:researchTicks,cost:def.cost,gasCost
      };
      this.events.push({type:"researchStart",side,research:channel,unit,level,researchId,cost:def.cost,gasCost});
      return true;
    }
    if(action.type==="CANCEL_BUILDING"){
      const order=this.constructionOrders.find(o=>o.id===action.buildingId&&o.side===side);
      if(order)return this.cancelConstructionOrder(order);
      const b=this.buildings.find(x=>x.id===action.buildingId&&x.alive!==false&&x.side===side);
      if(!b||BuildingDefinition.get(b.type)?.isDropoff)return false;

      const wasComplete=!!b.complete;
      const paidMineral=Number.isFinite(Number(b.constructionMineralCost))
        ?Number(b.constructionMineralCost)
        :BuildingDefinition.mineralCost(b.type,b.produceType||null);
      const refund=paidMineral*.5;
      const gasRefund=(Number(b.constructionGasCost)||0)*.5;

      // 완공 후 철거도 건설비 50%를 환불한다.
      this.wallet[side]+=refund;
      this.gasWallet[side]+=gasRefund;
      this.releaseBuilderForBuilding(b);
      b.alive=false;
      b.queue=[];this.markBuildingSpatialDirty();

      this.events.push({
        type:"buildCancelled",side,x:b.x,y:b.y,building:b.type,
        refund,gasRefund,wasComplete
      });
      return true;
    }
    if(action.type==="BUILD"){
      const bd=BuildingDefinition.get(action.building);
      if(!bd)return false;

      let x=action.x,y=action.y,gasNode=null;
      if(bd.isGasExtractor){
        gasNode=this.nearestGasNodeAt(action.x,action.y);
        if(!gasNode||this.gasNodeOccupied(gasNode.id))return false;
        x=gasNode.x;y=gasNode.y;
      }

      const buildCost=BuildingDefinition.resourceCost(action.building,action.produceType);
      const mineralCost=buildCost.mineral,gasCost=buildCost.gas;

      // 실제 커밋 시점에 다시 시야/자원/배치를 검사한다.
      // Perimeter construction is legal when at least one real builder interaction
      // face remains inside the world and clear of existing static buildings.
      if(
        !buildingPlacementInsideWorld(action.building,x,y,this.world)||
        !buildingHasBuilderApproach(this,action.building,x,y)||
        !buildingHasReachableBuilder(this,side,action.building,x,y)||
        !this.buildPointVisible(side,x,y)||
        this.buildingOverlapsMineral(action.building,x,y)||
        this.wallet[side]<mineralCost||
        this.gasWallet[side]<gasCost||
        !this.buildingAllowed(side,action.building,action.produceType)
      )return false;

      for(const b of [...this.buildings,...this.constructionOrders]){
        if(b.alive!==false&&Math.hypot(b.x-x,b.y-y)<buildingPlacementSeparation(action.building,b.type))return false;
      }

      this.wallet[side]-=mineralCost;
      this.gasWallet[side]-=gasCost;

      const order={id:"b"+(++this.seq),type:action.building,side,x,y,produceType:BuildingDefinition.isProduction(action.building)?(action.produceType||null):null,gasNodeId:gasNode?.id||null,createdTick:this.tick,builderUnitId:null,paidMineral:mineralCost,paidGas:gasCost,constructionState:"waitingWorker"};
      this.constructionOrders.push(order);this.assignBuilderToBuilding(order);
      this.events.push({type:"buildOrdered",side,x,y,building:action.building,buildingId:order.id,mineralCost,gasCost,gasNodeId:order.gasNodeId});
      return true;
    }
    return false;
  }
  onBuildingComplete(b){
    const bd=BuildingDefinition.get(b.type);
    if(bd?.tech){
      this.tech[b.side]=Math.max(this.tech[b.side],bd.tech);
      if(this.balanceStats&&(b.side===0||b.side===1)){
        if(bd.tech===2&&this.balanceStats.firstTech2Tick[b.side]==null)this.balanceStats.firstTech2Tick[b.side]=this.tick;
        if(bd.tech===3&&this.balanceStats.firstTech3Tick[b.side]==null)this.balanceStats.firstTech3Tick[b.side]=this.tick;
      }
    }

    // 편의성: 가스 추출장이 완공되는 순간에만 가장 가까운 메인/전진 거점의
    // 가스 일꾼 목표 수를 +1 한다. 이후에는 자동 유지/추적하지 않으며,
    // 사용자가 거점 UI에서 조절한 값이 그대로 authoritative 값이 된다.
    if(BuildingDefinition.get(b.type)?.isGasExtractor){
      const base=this.nearestDropoff(b.side,b.x,b.y);
      if(base){
        const before=RangeUtil.clamp(Number(base.gasWorkerTarget)||0,0,GAS_ASSIGNMENT_MAX);
        const after=RangeUtil.clamp(before+1,0,GAS_ASSIGNMENT_MAX);
        if(after!==before){
          base.gasWorkerTarget=after;
          this.events.push({
            type:"gasWorkerAutoAssigned",
            side:b.side,
            buildingId:base.id,
            extractorId:b.id,
            target:after,
            x:b.x,y:b.y
          });
        }
      }
    }
  }
  exhaustProductionBuilding(b){
    if(!b||b.alive===false||!BuildingDefinition.isProduction(b.type))return;
    const paidMineral=Number.isFinite(Number(b.constructionMineralCost))
      ?Number(b.constructionMineralCost)
      :BuildingDefinition.mineralCost(b.type,b.produceType||null);
    const refund=paidMineral*.5;
    const gasRefund=(Number(b.constructionGasCost)||0)*.5;

    this.wallet[b.side]+=refund;
    this.gasWallet[b.side]+=gasRefund;
    b.alive=false;
    this.markBuildingSpatialDirty();
    b.queue=[];

    this.events.push({
      type:"productionExhausted",side:b.side,x:b.x,y:b.y,
      building:b.type,produceType:b.produceType,refund,gasRefund,
      totalUnits:b.productionTotal||0
    });
    this.events.push({
      type:"buildingDeath",side:b.side,x:b.x,y:b.y,entity:b.type,
      killerSide:b.side,sourceType:"production-exhausted",cause:"production-exhausted"
    });
  }
  neutralThreatForTower(e,side){
    if(!e||!e.alive||e.side!==NEUTRAL_SIDE)return false;
    if(e.returningHome)return false;
    if(e.aggroed||e.forcedTargetId)return true;
    for(const idx of this.nearbyUnits(e.x,e.y,230)){
      const u=this.units[idx];
      if(!u?.alive||u.side!==side||!UnitDefinition.get(u.type)?.economyWorker)continue;
      if(Math.hypot(u.x-e.x,u.y-e.y)<=230)return true;
    }
    for(const b of this.buildings){
      if(b.alive===false||b.side!==side||!BuildingDefinition.get(b.type)?.isDropoff)continue;
      if(Math.hypot(b.x-e.x,b.y-e.y)<=250)return true;
    }
    return false;
  }
  towerTargetValid(b,e,range,sources){
    if(!e?.alive||!this.isHostileCombatUnit(b.side,e)||!this.canAttackEntity(b.type,e,false)||!this.canSeeCombatTarget(b.side,e,sources))return false;
    const d=BuildingDefinition.get(b.type),dist=Math.hypot(e.x-b.x,e.y-b.y);
    if(dist>range||(d.minRange&&dist<d.minRange))return false;
    if(e.side===NEUTRAL_SIDE)return this.neutralThreatForTower(e,b.side);
    return this.isVisible(b.side,e.x,e.y,sources,this.unitLayer(e.type)==="AIR")&&this.canTargetUnit(b.side,e,sources);
  }
  pickTowerTarget(b,range,sources){
    const d=BuildingDefinition.get(b.type);
    let best=null,bestScore=null;
    this.withNearbyUnits(b.x,b.y,range,indices=>{
      for(const idx of indices){
        const e=this.units[idx];
        if(!this.towerTargetValid(b,e,range,sources))continue;
        const dist=Math.hypot(e.x-b.x,e.y-b.y);
        const distScore=d.targetMode==="farthest"?-dist:dist;
        const score=distScore;
        if(bestScore===null||score<bestScore||(score===bestScore&&best&&String(e.id)<String(best.id))){
          best=e;bestScore=score;
        }
      }
    });
    return best;
  }
  updateSunvineTower(b){
    const d=BuildingDefinition.get(b.type),range=this.defenseAttackRange(b,d),sources=this.visionSources(b.side);
    let target=b.beamTargetId?(this.unitById.get(b.beamTargetId)||this.units.find(u=>u.id===b.beamTargetId)):null;
    if(!this.towerTargetValid(b,target,range,sources)){
      const next=this.pickTowerTarget(b,range,sources);
      if(!next){
        b.beamTargetId=null;b.beamStartedAt=-1;b.beamStage=0;b.clearCooldown();
        return;
      }
      target=next;b.beamTargetId=target.id;b.beamStartedAt=this.tick;b.beamStage=1;b.clearCooldown();
      this.events.push({type:"sunBeamLock",side:b.side,x:b.x,y:b.y,targetId:target.id,targetType:target.type});
    }

    if((b.beamStartedAt??-1)<0)b.beamStartedAt=this.tick;
    const beamTicks=this.tick-b.beamStartedAt+1;
    const stage=beamTicks>=this.msTicks(3000)?3:beamTicks>=this.msTicks(1500)?2:1;
    b.beamStage=stage;
    if(b.attackFlash>0)b.attackFlash--;
    if(b.cooldownActive(this))return

    const firePct=Math.max(1,this.defenseFireSpeedPct(b)),continuous=this.continuousDamageProfile(d.continuous);
    if(!continuous)return null;
    const intervalMs=Math.max(1,Math.round(continuous.damageIntervalMs*100/firePct));
    const pulseTicks=Math.max(1,this.msTicks(intervalMs));
    b.startCooldownUntil(this.tick+pulseTicks);
    b.attackFlash=1;

    const mult=stage===3?2.25:stage===2?1.5:1;
    const deliverySeconds=intervalMs/1000,damage=continuous.dps*mult*deliverySeconds;
    const win=this.applyDamage(b.side,b.type,target,false,damage,b.id,{damageDelivery:"continuous",deliverySeconds});
    this.events.push({
      type:"sunBeamPulse",side:b.side,x:b.x,y:b.y,x2:target.x,y2:target.y,
      sourceId:b.id,targetId:target.id,targetType:target.type,stage,damage,beamTicks
    });
    return win;
  }
  updateDefenseTower(b){
    if(!b.complete||!BuildingDefinition.isDefenseTower(b.type))return;
    const d=BuildingDefinition.get(b.type);
    if(d.beamTower)return this.updateSunvineTower(b);

    if(b.attackFlash>0)b.attackFlash--;
    if(b.cooldownActive(this))return;
    const range=this.defenseAttackRange(b,d),sources=this.visionSources(b.side);
    const best=this.pickTowerTarget(b,range,sources);
    if(!best)return;
    const firePct=Math.max(1,this.defenseFireSpeedPct(b));
    const cooldownMs=Math.max(1,Math.round((d.cooldownMs||d.cooldown*1000)*100/firePct));
    const effectiveMs=Math.max(1,cooldownMs+this.attackCooldownJitterMs(b));
    const scheduled=SimulationTiming.timerTicksWithPhase(effectiveMs,this.tps,b.attackCooldownPhase||0,{min:1});
    b.attackCooldownPhase=scheduled.phase;
    b.startCooldownUntil(this.tick+scheduled.ticks);
    b.attackFlash=1;
    this.spawnProjectile({
      id:"p"+(++this.seq),owner:b.id,side:b.side,type:b.type,
      x:b.x,y:b.y,target:best.id,isBuilding:false,
      speed:d.projectile,damage:d.atk,splash:d.splash||0,
      damageClass:UnitDefinition.damageClass(b.type)
    });
    this.events.push({type:"towerShot",side:b.side,x:b.x,y:b.y,unit:b.type,sourceId:b.id,targetId:best.id,targetType:best.type});
  }
  updateResearchQueues(){
    for(const side of [0,1]){
      const queues=this.researchQueues[side]||(this.researchQueues[side]={attack:null,armor:null,ability:null});
      for(const channel of ["attack","armor","ability"]){
        const q=queues[channel];if(!q)continue;
        if(this.tick<q.readyTick)continue;
        queues[channel]=null;
        if(channel==="attack"){
          this.attackUpgrade[side]=Math.min(MAX_ATTACK_UPGRADE,this.attackUpgrade[side]+1);
          this.events.push({type:"researchComplete",side,research:"attack",level:this.attackUpgrade[side]});
        }else if(channel==="armor"){
          this.armorUpgrade[side]=Math.min(MAX_ARMOR_UPGRADE,this.armorUpgrade[side]+1);
          this.events.push({type:"researchComplete",side,research:"armor",level:this.armorUpgrade[side]});
        }else if(q.researchId&&UnitSpecialResearchDefinition.get(q.researchId)){
          const researchDef=UnitSpecialResearchDefinition.get(q.researchId);
          this.specialResearch[side][q.researchId]=true;
          if(Number(researchDef.effects?.maxHpBonus)){
            for(const u of this.units){if(!u.alive||u.side!==side||u.type!==researchDef.unit)continue;const oldMax=u.maxHp,newMax=this.passiveUnitMaxHp(side,u.type);u.maxHp=newMax;u.hp=Math.min(newMax,u.hp+Math.max(0,newMax-oldMax));}
          }
          this.events.push({type:"specialResearchComplete",side,unit:q.unit,researchId:q.researchId});
        }else if(q.unit){
          this.abilities[side][q.unit]=true;
          this.events.push({type:"abilityComplete",side,unit:q.unit});
        }
      }
    }
  }
  updateBuildings(){
    this.updateConstructionOrders();
    for(const b of this.buildings){if(b.alive===false)continue;const bd=BuildingDefinition.get(b.type);
      if(!b.complete){
        const builder=this.ensureBuilderForBuilding(b);
        if(!this.builderCanConstruct(builder,b)){
          b.constructionState="waitingWorker";
          continue;
        }
        b.constructionState="building";
        b.progress++;
        const startHp=Math.max(1,Math.floor(b.maxHp*BUILD_START_HP_PCT/100));
        const granted=Math.min(b.maxHp,startHp+Math.floor((b.maxHp-startHp)*b.progress/Math.max(1,this.buildingBuildTicks(bd))));
        const prev=Math.max(startHp,Number(b.constructionHpGranted)||startHp);
        const gain=Math.max(0,granted-prev);
        if(gain>0)b.hp=Math.min(b.maxHp,b.hp+gain);
        b.constructionHpGranted=granted;
        if(b.progress>=this.buildingBuildTicks(bd)){
          b.complete=true;
          b.constructionState="complete";
          this.releaseBuilderForBuilding(b);
          b.constructionState="complete";
          this.onBuildingComplete(b);
          this.events.push({type:"complete",side:b.side,x:b.x,y:b.y,building:b.type,produceType:b.produceType||null});
        }
        continue
      }
      if(BuildingDefinition.isDefenseTower(b.type))this.updateDefenseTower(b);
      if(BuildingDefinition.get(b.type)?.isDropoff&&b.queue.length){
        const q=b.queue[0];
        if(this.tick>=q.readyTick){
          // 출구가 유닛/건물로 막혀 있으면 완료 상태(0 tick)로 유지하고
          // 공간이 열릴 때까지 다음 tick에 다시 시도한다.
          const spawned=this.spawnFromBuilding(b,ECONOMY_WORKER_TYPE);
          if(spawned)b.queue.shift();
          
        }
      }
      if(BuildingDefinition.get(b.type)?.isProductionBuilding&&!this.productionPaused[b.side]&&b.produceType&&this.unitUnlocked(b.side,b.produceType)){
        // 유한 생산 계약. batch 전체 Supply를 생산 시작 순간 예약한다.
        if(!b.queue.length&&(b.productionRemaining||0)>0){
          // Preferred batches may shrink under supply pressure. This keeps a
          // production contract live whenever at least one unit can fit, while
          // preserving the contract total and normal interval semantics.
          const count=this.reservableProductionBatchSize(b.side,b);
          if(count>0){
            const total=this.scaledProductionTicks(b.productionTicks||this.tps*10)*100;
            b.queue.push({
              type:b.produceType,count,remaining:total,total,
              densityQueue:true,productionBatch:true
            });
            this.events.push({
              type:"productionBatchStart",side:b.side,x:b.x,y:b.y,
              building:b.type,unit:b.produceType,count
            });
}
        }

        if(b.queue.length){
          const q=b.queue[0];
          if(q.productionBatch){
            // 100%일 때 tick당 100 진행. 완료 후에도 batch 전체가 나갈
            // SpawnPort 공간이 생길 때까지 예약 Supply를 유지한다.
            if(q.remaining>0)q.remaining-=this.productionSpeedPct(b);

            if(q.remaining<=0){
              const spawned=this.spawnBatchFromBuilding(b,q.type,q.count||1);
              if(spawned){
                b.queue.shift();
                b.productionRemaining=Math.max(0,(b.productionRemaining||0)-(q.count||1));
                b.productionBatchesCompleted=(b.productionBatchesCompleted||0)+1;

                this.events.push({
                  type:"productionBatchComplete",side:b.side,x:b.x,y:b.y,
                  building:b.type,unit:q.type,count:q.count||1,
                  remaining:b.productionRemaining
                });

                if(b.productionRemaining<=0)this.exhaustProductionBuilding(b);
              }else{
                q.remaining=0;
              }
            }
          }
        }
      }
    }
  }
  nearestInteractionTarget(u,targets,kind,extra=0){
    let best=null,bestDistance=Infinity;const ignore=TerrainNavigation.ignoresBuildings(u);
    const candidates=targets.map(target=>{const goal=InteractionGeometry.goal(u,target,kind,extra),nearest=goal.closest(u.x,u.y);
      return {target,goal,lowerBound:nearest?Math.hypot(nearest.x-u.x,nearest.y-u.y):0};
    }).sort((a,b)=>a.lowerBound-b.lowerBound||(String(a.target.id)<String(b.target.id)?-1:String(a.target.id)>String(b.target.id)?1:0));
    for(const {target,goal,lowerBound} of candidates){
      // Evaluate promising candidates first; a far first entry must not force a
      // map-wide query before the existing exact-distance bound can prune it.
      // Ties still use the original exact distance and target ID rule.
      if(lowerBound>bestDistance+1e-8){this.navigation.metrics.targetCandidatesPruned=(this.navigation.metrics.targetCandidatesPruned||0)+1;continue}
      this.navigation.metrics.targetDistanceQueries=(this.navigation.metrics.targetDistanceQueries||0)+1;
      const distance=this.navigation.distance(u.x,u.y,goal,u.type,ignore);
      if(distance<bestDistance||distance===bestDistance&&best&&String(target.id)<String(best.id)){best=target;bestDistance=distance}
    }
    return best;
  }
  nearestMineral(u){return this.nearestInteractionTarget(u,this.resources.filter(m=>m.amount>0),"worker-mineral")}

  depleteMineralNode(m){
    if(!m||m.amount>0)return;
    const id=m.id;
    this.resources=this.resources.filter(r=>r.id!==id);
    this.events.push({type:"mineralDepleted",resourceId:id,x:m.x,y:m.y});
  }

  

  

  

  

  

  

  

  

  moveToward(u,tx,ty,speed){return this.moveToGoal(u,NavigationGoal.point(tx,ty),speed)}
  moveToInteraction(u,target,kind,speed,extra=0,minRange=null){return this.moveToGoal(u,InteractionGeometry.goal(u,target,kind,extra,minRange),speed)}
  moveToGoal(u,goal,speed){
    let tx=goal.x,ty=goal.y;
    const deployable=u.capability(DeployableCombatMixin.KEY);
    if(deployable&&!deployable.requestMovement(this))return false;
    // 이동을 시도하는 순간 웅크리기/준비를 해제한다.
    if(u.movement.crouched||(u.movement.crouchStartedAt??-1)>=0){u.movement.crouched=false;u.movement.crouchStartedAt=-1}
    // Post-attack recovery is movement-only: attacks/cooldowns/wind-ups continue
    // normally while voluntary locomotion is temporarily locked.
    if(u.combat.moveRecoveryActive(this))return false;
    speed*=this.passiveMovePct(u.side,u.type)/100;
    speed*=this.formationJoinMovePct(u,tx,ty)/100;
    if(u.side===0||u.side===1){
      let mobilityPct=100;
      for(const idx of this.nearbyUnits(u.x,u.y,160,u.side)){
        const ally=this.units[idx],ad=UnitDefinition.get(ally?.type);
        if(!ally?.alive||ally.side!==u.side||!Number(ad?.mobilityAuraRadius))continue;
        const up=this.hasAbility(ally.side,ally.type);
        const radius=up?(ad.abilityMobilityAuraRadius||280):(ad.mobilityAuraRadius||140),pct=up?(ad.abilityMobilityAuraPct||125):(ad.mobilityAuraPct||115);
        if(Math.hypot(ally.x-u.x,ally.y-u.y)<=radius)mobilityPct=Math.max(mobilityPct,pct);
      }
      if(mobilityPct>100)speed=speed*mobilityPct/100;
      let marchPct=100;
      for(const sp of this.activeSpells){
        if(sp.type!=="march"||sp.side!==u.side||this.tick>=sp.expireTick)continue;
        if(Math.hypot(u.x-sp.x,u.y-sp.y)<=(sp.radius||0))marchPct=Math.max(marchPct,sp.speedPct||100);
      }
      if(marchPct>100)speed=speed*marchPct/100;
    }

    if(u.status.isSlowed(this))speed*=.55;

    const waypoint=this.navigation.nextPoint(u,goal);
    if(!waypoint||Math.hypot(waypoint.x-u.x,waypoint.y-u.y)<.001)return false;
    tx=waypoint.x;ty=waypoint.y;
    const dx=tx-u.x,dy=ty-u.y;
    const dist=Math.hypot(dx,dy)||1;
    if(this.unitLayer(u.type)!=="AIR"){
      const rawStep=Math.min(speed/this.tps,dist);
      const nx=u.x+dx/dist*rawStep,ny=u.y+dy/dist*rawStep;
      speed*=this.terrainMovementMultiplier(u.x,u.y,nx,ny);
    }
    const step=Math.min(speed/this.tps,dist);
    let vx=dx/dist*step,vy=dy/dist*step;

    u.collisionIntentTick=this.tick;u.collisionIntentTx=tx;u.collisionIntentTy=ty;

    if(Math.abs(vx)+Math.abs(vy)>.0001&&u.collisionMoveTick!==this.tick){
      u.collisionMoveTick=this.tick;u.collisionMoveStartFx=u.fx;u.collisionMoveStartFy=u.fy;
    }
    const oldX=u.fx,oldY=u.fy;
    this.navigation.motion.move(u,u.x+vx,u.y+vy,'steer');
    const moved=u.fx!==oldX||u.fy!==oldY;
    if(moved){
      u.movement.lastMoveTick=this.tick;
      if(u.status.timedModifiers)for(const [key,m] of Object.entries(u.status.timedModifiers))if(m?.resetOnMove)delete u.status.timedModifiers[key];
      if(UnitDefinition.get(u.type)?.burrowWhileMoving)u.capability(BurrowableMixin.KEY)?.setMovementActive(this,true);
    }
    return moved;
  }

  updateWorker(u){
    const d=UnitDefinition.get(u.type);
    const carryCap=WORKER_CARRY_CAP;
    if(this.isAirborneStatus(u))return;

    if(u.buildTargetId){
      const b=this.resolveConstructionTarget(u.buildTargetId);
      if(!b||b.alive===false||b.complete||b.side!==u.side||b.builderUnitId!==u.id){
        u.buildTargetId=null;u.workState="seek";u.mineId=null;u.worker?.resetMine();u.workResourceType="mineral";
      }else{
        u.carry=0;u.carryType=null;u.mineId=null;u.worker?.resetMine();u.workResourceType="mineral";
        if(this.builderCanConstruct(u,b)){
          u.workState="building";
          b.constructionState="building";
        }else{
          u.workState="buildTravel";
          b.constructionState="waitingWorker";
          this.moveToInteraction(u,b,"worker-build",d.speed);
        }
        return;
      }
    }

    // Return cargo first. Mineral and gas use the exact same dropoff routing.
    if(u.carry>=carryCap||u.workState==="return"){
      const base=u.worker.dropoff(this);
      if(!base)return;

      u.workState="return";

      if(Math.hypot(base.x-u.x,base.y-u.y)<=this.interactionDistance(u,base,"worker-dropoff")){
        const earned=u.carry;
        const kind=u.carryType||"mineral";

        if(kind==="gas")this.gasWallet[u.side]+=earned;
        else this.wallet[u.side]+=earned;

        if(earned>0)this.events.push({
          type:"income",side:u.side,x:base.x,y:base.y,
          amount:earned,reason:kind==="gas"?"gas":"worker",
          resourceType:kind
        });

        u.carry=0;
        u.carryType=null;
        u.workState="seek";
        u.workResourceType=kind;
      }else{
        this.moveToInteraction(u,base,"worker-dropoff",d.speed);
      }
      return;
    }

    const gasAssigned=this.workerShouldMineGas(u);
    const gasExtractor=gasAssigned
      ?this.validGasExtractors(u.side).find(b=>b.id===u.mineId&&u.workResourceType==='gas')||this.nearestInteractionTarget(u,this.economyCacheTick===this.tick?this.validGasExtractorsBySide[u.side]:this.validGasExtractors(u.side),"worker-gas")
      :null;

    // If assigned gas workers have no valid extractor, they automatically
    // fall back to minerals rather than idling.
    const desiredType=gasExtractor?"gas":"mineral";

    if(u.workResourceType!==desiredType){
      u.workResourceType=desiredType;
      u.mineId=null;
      u.worker?.resetMine();
      u.workState="seek";
    }

    if(desiredType==="gas"){
      const extractor=(u.mineId
        ?this.buildings.find(b=>b.id===u.mineId&&b.alive!==false&&b.complete&&BuildingDefinition.get(b.type)?.isGasExtractor&&b.side===u.side)
        :null)||gasExtractor;

      const gasNode=this.gasNodeForExtractor(extractor);
      if(!extractor||!gasNode){
        u.workResourceType="mineral";
        u.mineId=null;
        u.worker?.resetMine();
        u.workState="seek";
        return;
      }

      u.mineId=extractor.id;
      const range=this.interactionDistance(u,extractor,"worker-gas");

      if(Math.hypot(extractor.x-u.x,extractor.y-u.y)>range){
        this.moveToInteraction(u,extractor,"worker-gas",d.speed);
        u.workState="seek";
        return;
      }

      u.workState="mine";
      const mineElapsed=u.worker.mineElapsedTicks(this);
      const gasMinePct=this.passiveEffectValue(u.side,"miningPct",{resource:"gas"});
      const gasMineTicks=Math.max(1,Math.round(this.msTicks(800)*100/(100+gasMinePct)));

      if(mineElapsed>=gasMineTicks){
        u.worker?.resetMine();

        const wasDepleted=gasNode.amount<=0;
        const amt=wasDepleted
          ?GAS_DEPLETED_MINE_AMOUNT
          :Math.min(GAS_MINE_AMOUNT,gasNode.amount);

        u.carry=amt;
        u.carryType="gas";

        if(!wasDepleted){
          gasNode.amount=Math.max(0,gasNode.amount-amt);
        }

        if(amt>0)this.events.push({
          type:"mineHit",
          side:u.side,
          workerId:u.id,
          gasNodeId:gasNode.id,
          extractorId:extractor.id,
          x:extractor.x,y:extractor.y,
          workerX:u.x,workerY:u.y,
          amount:amt,
          resourceType:"gas",
          depleted:wasDepleted
        });

        // One extraction = one trip: 8 normally, 2 after depletion.
        u.workState="return";

        if(!wasDepleted&&gasNode.amount<=0){
          this.events.push({
            type:"gasDepleted",
            side:u.side,
            gasNodeId:gasNode.id,
            extractorId:extractor.id,
            x:extractor.x,y:extractor.y,
            depletedYield:GAS_DEPLETED_MINE_AMOUNT
          });
        }
      }
      return;
    }

    let m=this.resources.find(x=>x.id===u.mineId&&x.amount>0);
    if(!m){
      m=this.nearestMineral(u);
      u.mineId=m?m.id:null;
      u.workResourceType="mineral";
      u.workState="seek";
    }
    if(!m)return;

    if(Math.hypot(m.x-u.x,m.y-u.y)>this.interactionDistance(u,m,"worker-mineral")){
      this.moveToInteraction(u,m,"worker-mineral",d.speed);
      u.workState="seek";
      return;
    }

    u.workState="mine";
    const mineElapsed=u.worker.mineElapsedTicks(this);
    const mineralMinePct=this.passiveEffectValue(u.side,"miningPct",{resource:"mineral"});
    const mineralMineTicks=Math.max(1,Math.round(this.msTicks(800)*100/(100+mineralMinePct)));

    if(mineElapsed>=mineralMineTicks){
      u.worker?.resetMine();
      const amt=Math.min(carryCap-u.carry,m.amount,4);
      u.carry+=amt;
      u.carryType="mineral";
      m.amount-=amt;

      if(amt>0)this.events.push({
        type:"mineHit",
        side:u.side,
        workerId:u.id,
        mineralId:m.id,
        x:m.x,y:m.y,
        workerX:u.x,workerY:u.y,
        amount:amt,
        resourceType:"mineral"
      });

      if(m.amount<=0)this.depleteMineralNode(m);
      if(u.carry>=carryCap||m.amount<=0)u.workState="return";
    }
  }
  // The side's VisionField, current for this state; pass it to the checks below.
  visionSources(side){return VisionField.of(this,side,this)}
  isVisible(side,x,y,field,targetAir=false){
    if(this._perfCollect)this._perfCollect.visibilityChecks++;
    return field.visibleAt(x,y,targetAir);
  }
  isStealthed(u){
    if(!u?.alive)return false;
    // Burrow uses the exact same Star-style cloak contract as permanent/aura cloak:
    // movement/being hit never reveals it; only enemy Detection makes it targetable.
    if(!!u?.capability(BurrowableMixin.KEY)?.isActive())return true;
    if(u.capability(StealthMixin.KEY)?.isActive())return true;
    this.prepareCloakCache();
    return this.auraCloakedIds.has(u.id);
  }
  isDetected(side,u,field){
    if(!this.isStealthed(u))return true;
    if(this._perfCollect)this._perfCollect.visibilityChecks++;
    return field.detectedAt(u.x,u.y,this.unitLayer(u.type)==="AIR");
  }

  canTargetUnit(attackerSide,target,sources=null){
    if(!target||target.alive===false)return false;
    if(target.side===attackerSide||this.neutralObjectFriendlyToSide(target,attackerSide))return false;
    if(!!target?.capability(BurrowableMixin.KEY)?.isUntargetable())return false;

    // Neutral units do not use player Detection rules.
    if(target.side===NEUTRAL_SIDE)return true;

    // Revealed/non-stealth targets are always normally targetable.
    if(!this.isStealthed(target))return true;

    const src=sources||this.visionSources(attackerSide);
    return this.isDetected(attackerSide,target,src);
  }

  // Many attackers test the same target in one tick; reuse its ground level until it moves.
  targetLevel(target){
    const memo=this.targetLevelMemo.get(target);
    if(memo&&memo.tick===this.tick&&memo.x===target.x&&memo.y===target.y)return memo.level;
    const level=this.world.terrain.surfaces.levelAt(target.x,target.y);
    this.targetLevelMemo.set(target,{tick:this.tick,x:target.x,y:target.y,level});
    return level;
  }
  canSeeCombatTarget(attackerSide,target,sources){
    if(!target||target.alive===false||target.side===attackerSide||this.neutralObjectFriendlyToSide(target,attackerSide))return false;
    const targetAir=this.unitLayer(target.type)==="AIR",targetLevel=targetAir?null:this.targetLevel(target);
    if(this._perfCollect)this._perfCollect.visibilityChecks++;
    return sources.visibleAt(target.x,target.y,targetAir,targetLevel)&&(!this.isStealthed(target)||sources.detectedAt(target.x,target.y,targetAir,targetLevel));
  }

  targetPriorityFactor(attacker,targetDef){
    const p=UnitDefinition.get(attacker.type)?.priority||{};
    return Math.max(100,Number(p[targetDef.role])||100,Number(p[targetDef.sizeClass])||100);
  }
  targetChoiceBetter(score,id,bestScore,best){
    if(score<bestScore)return true;
    if(score>bestScore)return false;
    return !best||String(id)<String(best.entity?.id??best.id??"");
  }
  basicAttackRange(u){
    const d=UnitDefinition.get(u.type);
    let range=d.range*this.specialResearchNumericMultiplier(u.side,u.type,"attackRangeMultiplier");
    if(this.hasAbility(u.side,u.type)){
      if(Number(d.abilityRangeMultiplier)>0)range*=Number(d.abilityRangeMultiplier);
      else if(Number(d.abilityRangeBonus)>0)range+=Number(d.abilityRangeBonus);
    }
    return range;
  }
  isHostileCombatBuilding(side,b){
    if(!b||b.alive===false||b.hp<=0||b.side===side)return false;
    return b.side===1-side||((side===0||side===1)&&b.side===NEUTRAL_SIDE&&!!BuildingDefinition.get(b.type)?.isTerrainBarrier);
  }
  combatTargetAggroRange(u){
    const d=UnitDefinition.get(u.type);
    return Number(d.aggroRange)||(d.role==="artillery"?560:d.role==="assassin"?430:390);
  }
  combatTargetRefreshDue(u){
    const interval=this.msTicks(COMBAT_TARGET_REFRESH_MS);
    return this.tick%interval===(HashUtil.hash(String(u.id))>>>0)%interval;
  }
  retainedCombatTarget(u,visibleSources){
    if(u.target==null)return null;
    // Runtime indexes include this tick's spawns; do not linearly scan dead IDs.
    const unit=this.unitById.get(u.target),entity=unit||this.buildingById.get(u.target);
    if(!entity)return null;
    const isBuilding=!unit;
    if(isBuilding){
      if(!this.isHostileCombatBuilding(u.side,entity)||!this.canAttackEntity(u.type,entity,true)||!this.isVisible(u.side,entity.x,entity.y,visibleSources))return null;
    }else if(!this.isHostileCombatUnit(u.side,entity)||!this.canAttackEntity(u.type,entity,false)||!this.canTargetUnit(u.side,entity,visibleSources)||!this.canSeeCombatTarget(u.side,entity,visibleSources))return null;
    const dist=Math.hypot(entity.x-u.x,entity.y-u.y);
    if(dist>this.combatTargetAggroRange(u)&&dist>this.interactionDistance(u,entity,"attack",this.basicAttackRange(u)))return null;
    return {entity,isBuilding,def:isBuilding?BuildingDefinition.get(entity.type):UnitDefinition.get(entity.type)};
  }
  pickCombatTarget(u,visibleSources){
    // Fireable hostile threats share one pool, regardless of player/neutral storage.
    // Keep a valid target within its priority tier; an idle structure cannot mask
    // a fireable combatant. Only acquire a chase target when nothing can be hit.
    if(this._perfCollect)this._perfCollect.targetQueries++;
    const d=UnitDefinition.get(u.type),attackRange=this.basicAttackRange(u);
    const attackNeedsTerrainLine=InteractionGeometry.requiresTerrainLine(u,'attack',attackRange);
    const aggro=this.combatTargetAggroRange(u);
    const queryRange=Math.max(aggro,attackRange+this.unitRadius(u.type)+Math.max(this.maxUnitRadius,this.maxBuildingRadius));
    let taunt=null,tauntD2=Infinity,currentInRange=null;
    let inRangeBest=null,inRangeScore=Infinity,inRangeRank=Infinity;
    let acquireBest=null,acquireD2=Infinity,currentAcquire=null,currentAcquireD2=Infinity;
    let closeFallback=null,closeFallbackD2=Infinity;
    const consider=(entity,isBuilding,def,d2)=>{
      const dist=Math.sqrt(d2);
      // Preserve visibility memo seeding above. The source's terrain policy is
      // constant for this selection; AIR/ranged reach needs no per-target ray gate.
      const rawReach=!attackNeedsTerrainLine||dist>aggro?InteractionGeometry.reach(u,entity,'attack',attackRange):null;
      if(dist>aggro&&dist>rawReach)return;
      const max=attackNeedsTerrainLine?this.interactionDistance(u,entity,"attack",attackRange):rawReach;
      if(dist>aggro&&dist>max)return;
      const min=d.minRange?InteractionGeometry.contact(u,entity)+d.minRange:0;
      const candidate={entity,isBuilding,def};
      if(min&&dist<min){
        if(this.targetChoiceBetter(d2,entity.id,closeFallbackD2,closeFallback)){closeFallback=candidate;closeFallbackD2=d2}
        return;
      }
      if(!isBuilding&&d.role!=="assassin"&&d.role!=="artillery"&&def.taunt&&d2<=(def.tauntRadius||0)**2){
        if(this.targetChoiceBetter(d2,entity.id,tauntD2,taunt)){taunt=candidate;tauntD2=d2}
      }
      if(dist<=max){
        const rank=isBuilding?(BuildingDefinition.isDefenseTower(entity.type)?0:2):(def.economyWorker?1:0);
        const score=d2*100/this.targetPriorityFactor(u,def);
        if(entity.id===u.target)currentInRange={candidate,rank};
        if(rank<inRangeRank||(rank===inRangeRank&&this.targetChoiceBetter(score,entity.id,inRangeScore,inRangeBest))){inRangeBest=candidate;inRangeScore=score;inRangeRank=rank}
      }else{
        if(this.targetChoiceBetter(d2,entity.id,acquireD2,acquireBest)){acquireBest=candidate;acquireD2=d2}
        if(entity.id===u.target){currentAcquire=candidate;currentAcquireD2=d2}
      }
    };
    // The grid returns whole cells. queryRange covers aggro and every attack reach,
    // so a farther candidate is rejected by consider(); skip its visibility rays.
    // Units are scanned in two bands. The near band holds every unit that can be in
    // attack reach or taunt this attacker; only those decide the result when one is
    // found, so the aggro band is scanned only when the attacker must chase.
    const queryRange2=queryRange*queryRange;
    const tauntReach=d.role!=="assassin"&&d.role!=="artillery"?this.maxTauntRadius:0;
    const nearRange=Math.min(queryRange,Math.max(attackRange+this.unitRadius(u.type)+this.maxUnitRadius,tauntReach)),nearRange2=nearRange*nearRange;
    const scan=(range,minD2,maxD2)=>this.forEachNearbyHostileUnit(u.side,u.x,u.y,range,e=>{
      const d2=(e.x-u.x)**2+(e.y-u.y)**2;
      if(d2<=minD2||d2>maxD2)return;
      if(!this.canAttackEntity(u.type,e,false)||!this.canTargetUnit(u.side,e,visibleSources))return;
      if(!this.canSeeCombatTarget(u.side,e,visibleSources)){if(this._perfCollect)this._perfCollect.targetVisibilityRejects++;return}
      consider(e,false,UnitDefinition.get(e.type),d2);
    });
    scan(nearRange,-1,nearRange2);
    for(const i of this.nearbyBuildingIndices(u.x,u.y,queryRange)){
      const b=this.buildings[i];
      if(!this.isHostileCombatBuilding(u.side,b)||!this.canAttackEntity(u.type,b,true)||!this.isVisible(u.side,b.x,b.y,visibleSources))continue;
      const bd=BuildingDefinition.get(b.type);
      consider(b,true,{role:bd.isMainBase?"base":"building",sizeClass:"heavy",size:bd.size},(b.x-u.x)**2+(b.y-u.y)**2);
    }
    if(!taunt&&!inRangeBest&&nearRange<queryRange)scan(queryRange,nearRange2,queryRange2);
    if(taunt)return taunt;
    if(currentInRange&&currentInRange.rank<=inRangeRank)return currentInRange.candidate;
    if(inRangeBest)return inRangeBest;
    if(currentAcquire&&currentAcquireD2*100<=acquireD2*COMBAT_TARGET_STICKINESS_PCT)return currentAcquire;
    return acquireBest||closeFallback;
  }
  damageAmount(sourceType,targetDef,base,damageClassOverride=null){
    const a=UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType)||null;
    const sizeClass=targetDef.sizeClass||"heavy";
    const damageClass=damageClassOverride||a?.damageClass||UnitDefinition.damageClass(sourceType);
    let mul=(DAMAGE_CLASS_MATRIX[damageClass]&&DAMAGE_CLASS_MATRIX[damageClass][sizeClass])||100;
    if(targetDef.rangedReduction&&a?.projectile)mul=Math.floor(mul*targetDef.rangedReduction/100);
    return Math.max(1,Math.floor(base*mul/100));
  }
  beginCampReset(camp){
    if(!camp||camp.state!=="alive"||camp.resetting)return;
    const cd=CampDefinition.get(camp.kind);
    camp.resetting=true;
    camp.engaged=false;
    camp.aggroGauge=cd.aggroGaugeMax;
    camp.insideAggroStartedAt=-1;
    camp.aggroTargetId=null;

    for(const member of this.campMembers(camp)){
      member.forcedTargetId=null;
      member.aggroed=false;
      member.returningHome=true;
    }

    this.events.push({
      type:"neutralReset",side:NEUTRAL_SIDE,
      x:camp.x,y:camp.y,camp:camp.kind
    });
  }

  campMembers(camp){
    return this.units.filter(
      u=>u.alive&&u.side===NEUTRAL_SIDE&&u.campId===camp.id
    );
  }
  campCoreMembers(camp){
    return this.campMembers(camp).filter(u=>UnitDefinition.get(u.type)?.role!=="neutralSummon");
  }
  campMemberHome(camp,u){
    const h=camp?.memberHomes?.[u?.id];
    return h&&Number.isFinite(h.x)&&Number.isFinite(h.y)?h:{x:camp?.x??u?.x??0,y:camp?.y??u?.y??0};
  }
  registerCampMemberHome(camp,u,x=u?.x,y=u?.y){
    if(!camp||!u)return null;
    if(!camp.memberHomes||typeof camp.memberHomes!=="object")camp.memberHomes={};
    return camp.memberHomes[u.id]={x:Number(x)||0,y:Number(y)||0};
  }

  insideCampAggroRadius(unit,camp,cd=CampDefinition.get(camp.kind)){
    const dx=unit.x-camp.x,dy=unit.y-camp.y;
    const radius=NeutralCampPolicy.aggroRadius(camp);return dx*dx+dy*dy<=radius*radius;
  }

  campAllHome(camp,cd){
    const members=this.campCoreMembers(camp);
    return !!members.length&&members.every(u=>{
      const home=this.campMemberHome(camp,u),dx=u.x-home.x,dy=u.y-home.y;
      return dx*dx+dy*dy<=cd.homeRadius*cd.homeRadius;
    });
  }

  finishCampReturn(camp){
    const wasReset=camp.resetting;
    camp.resetting=false;
    camp.engaged=false;
    camp.aggroGauge=0;
    camp.insideAggroStartedAt=-1;
    camp.aggroTargetId=null;
    camp.lastAggroGaugeTick=this.tick;

    for(const u of this.campMembers(camp)){
      const home=this.campMemberHome(camp,u);u.x=home.x;u.y=home.y;
      u.fx=Math.round(u.x*FP);u.fy=Math.round(u.y*FP);
      this.syncUnitSpatial(u);
      u.returningHome=false;
      u.aggroed=false;
      u.forcedTargetId=null;
      NEUTRAL_BEHAVIORS[u.type]?.onCampReturn?.(this,u)
      // Arrival changes state/position only: never force hp to maxHp.
    }

    if(wasReset)this.events.push({
      type:"neutralResetComplete",side:NEUTRAL_SIDE,
      x:camp.x,y:camp.y,camp:camp.kind
    });
  }

  campEnemyById(id){
    if(!id)return null;
    const valid=e=>e.id===id&&(e.side===0||e.side===1)&&
      e.alive!==false&&e.hp>0;
    // Buildings commonly have alive===undefined until destroyed, unlike units.
    const u=this.unitById.get(id),b=this.buildingById.get(id);
    if(u&&valid(u))return u;
    if(b&&valid(b))return b;
    return this.units.find(valid)||this.buildings.find(valid)||null;
  }

  campFriendlySide(camp){return NeutralCampPolicy.friendlySide(camp)}
  neutralObjectFriendlyToSide(entity,side){
    const campId=Unit.neutralStateOf(entity)?.campId;
    if(!campId||(side!==0&&side!==1))return false;
    const camp=this.camps.find(c=>c.id===campId);
    return this.campFriendlySide(camp)===side;
  }

  updateCampAggroGauge(camp,cd){
    if(!camp||camp.state!=="alive")return;
    const members=this.campCoreMembers(camp);
    if(!members.length)return;

    // Arrival is checked before and after movement/contact resolution. Healing
    // belongs to the return state, not to which side of the habitat edge it is on.
    if(camp.resetting){
      if(this.campAllHome(camp,cd))this.finishCampReturn(camp);
      return;
    }

    // updateCamps runs twice per step. The shared timer advances at most once.
    if(camp.lastAggroGaugeTick===this.tick)return;
    camp.lastAggroGaugeTick=this.tick;
    if(!camp.engaged)return; // IDLE never acquires aggro just by leaving its circle.

    const target=this.findCampTarget(camp);
    if(!target&&this.campAllHome(camp,cd)){
      this.finishCampReturn(camp);
      return;
    }

    const outside=members.some(u=>!this.insideCampAggroRadius(u,camp,cd));
    if(outside){
      camp.insideAggroStartedAt=-1;
      // No live/replacement target means no fight: walking home without a target
      // must not consume an outside-combat allowance or trigger a forced reset.
      if(target){
        camp.aggroGauge=Math.min(cd.aggroGaugeMax,(camp.aggroGauge||0)+cd.gaugeGain);
        if(camp.aggroGauge>=cd.aggroGaugeMax)this.beginCampReset(camp);
      }
      return;
    }

    // Even an imported/full gauge cannot interrupt a fight inside the habitat.
    if((camp.insideAggroStartedAt??-1)<0)camp.insideAggroStartedAt=this.tick;
    if(this.tick-camp.insideAggroStartedAt+1>=this.msTicks(2000)&&camp.aggroGauge>0){
      camp.aggroGauge=Math.max(0,camp.aggroGauge-cd.gaugeDecay);
    }
  }

  scanCampTarget(camp,referenceUnit=null,aggroOnly=false){
    if(!camp||camp.resetting)return null;
    const members=this.campCoreMembers(camp);
    if(!members.length)return null;
    let best=null,bestScore=Infinity;
    // Shared neutral target scan controls CAMP engagement/chase state only.
    // Individual neutral combat targeting is selected separately per member.
    // Fixed collection order + ID tie-break keeps it deterministic.
    // aggroOnly is used only for proactive IDLE acquisition; engaged camps retain the
    // existing chase allowance outside the habitat.
    for(const collection of [this.units,this.buildings]){
      for(const e of collection){
        if(e.alive===false||e.hp<=0||(e.side!==0&&e.side!==1)||e.side===this.campFriendlySide(camp))continue;
        if(!BuildingDefinition.get(e.type)&&!members.some(m=>this.canAttackEntity(m.type,e,false)))continue;
        const radius=BuildingDefinition.get(e.type)?.size||0;
        const campDist=Math.max(0,Math.hypot(e.x-camp.x,e.y-camp.y)-radius);
        if(aggroOnly&&campDist>NeutralCampPolicy.aggroRadius(camp))continue;
        let memberDist=Infinity;
        for(const m of members){
          memberDist=Math.min(memberDist,Math.max(0,Math.hypot(e.x-m.x,e.y-m.y)-radius));
        }
        if(!aggroOnly&&campDist>NeutralCampPolicy.aggroRadius(camp)&&memberDist>360)continue;

        const refDist=referenceUnit
          ?Math.max(0,Math.hypot(e.x-referenceUnit.x,e.y-referenceUnit.y)-radius)
          :campDist;
        const score=refDist*(UnitDefinition.get(e.type)?.economyWorker ? .94 : 1);
        if(score<bestScore||(score===bestScore&&best&&String(e.id)<String(best.id))){
          best=e;bestScore=score;
        }
      }
    }
    return best;
  }

  engageCamp(camp,target,sourceUnit=null){
    if(!camp||camp.state!=="alive"||camp.resetting||!target)return null;
    const wasEngaged=camp.engaged;
    camp.engaged=true;
    camp.aggroTargetId=target.id;
    camp.insideAggroStartedAt=-1;
    for(const member of this.campMembers(camp)){
      member.returningHome=false;
      member.aggroed=true;
      member.forcedTargetId=target.id;
    }
    if(!wasEngaged){
      const anchor=sourceUnit||this.campMembers(camp)[0]||camp;
      this.events.push({type:"neutralAggro",side:NEUTRAL_SIDE,x:anchor.x,y:anchor.y,camp:camp.kind,targetId:target.id});
    }
    return target;
  }

  findCampTarget(camp,referenceUnit=null){
    if(!camp||camp.resetting)return null;
    const cd=CampDefinition.get(camp.kind);
    const current=this.campEnemyById(camp.aggroTargetId);
    if(camp.engaged&&current)return current;
    if(camp.engaged)camp.aggroTargetId=null;

    if(!camp.engaged){
      if(!cd.proactiveAggro)return null;
      const proactive=this.scanCampTarget(camp,referenceUnit,true);
      return proactive?this.engageCamp(camp,proactive,referenceUnit):null;
    }

    const replacement=this.scanCampTarget(camp,referenceUnit,false);
    if(replacement)camp.aggroTargetId=replacement.id;
    return replacement;
  }

  findNeutralCombatTarget(camp,u){
    if(!camp||!u?.alive||camp.resetting)return null;
    const d=UnitDefinition.get(u.type)||{},shared=this.findCampTarget(camp,u);
    if(!camp.engaged)return shared;
    const attackRange=Math.max(0,Number(d.range)||0);
    const localRadius=Math.max(
      this.interactionDistance(u,{type:u.type},"combat-contact")+attackRange+16,
      attackRange+96,
      140
    );
    let best=null,bestScore=Infinity;
    const consider=(e,isBuilding=false)=>{
      if(!e||e.alive===false||e.hp<=0||(e.side!==0&&e.side!==1)||e.side===this.campFriendlySide(camp))return;
      if(!isBuilding&&!this.canAttackEntity(u.type,e,false))return;
      const dist=Math.hypot(e.x-u.x,e.y-u.y);
      const attackDist=this.interactionDistance(u,e,"attack",attackRange);
      if(dist>localRadius&&dist>attackDist+24)return;
      // Anything this monster can hit now always beats the camp's shared chase target.
      // Otherwise choose the nearest local enemy; ID is the deterministic tie-break.
      const inRange=dist<=attackDist+1;
      const score=(inRange?0:100000)+Math.max(0,dist-attackDist)+(isBuilding?20:0);
      if(score<bestScore||(score===bestScore&&best&&String(e.id)<String(best.id))){
        best=e;bestScore=score;
      }
    };
    for(const idx of this.nearbyUnits(u.x,u.y,localRadius)){
      const e=this.units[idx];consider(e,false);
    }
    for(const b of this.buildings){
      if(b.alive===false)continue;
      const br=BuildingDefinition.get(b.type)?.size||0;
      if(Math.hypot(b.x-u.x,b.y-u.y)<=localRadius+br)consider(b,true);
    }
    return best||shared;
  }

  triggerNeutralRetaliation(target,sourceSide,sourceEntityId){
    if(!target||target.side!==NEUTRAL_SIDE||!target.campId)return;
    if((sourceSide!==0&&sourceSide!==1)||!sourceEntityId)return;
    const camp=this.camps.find(c=>c.id===target.campId);
    if(!camp||camp.state!=="alive"||sourceSide===this.campFriendlySide(camp))return;

    // The struck MONSTER's position decides re-engagement, not the attacker's.
    // Outside hits still deal damage, but cannot stop a forced return/healing.
    if(camp.resetting&&!this.insideCampAggroRadius(target,camp))return;
    const attacker=this.campEnemyById(sourceEntityId);
    if(!attacker||attacker.side!==sourceSide)return;
    const attackerIsBuilding=!!BuildingDefinition.get(attacker.type);
    if(!attackerIsBuilding&&!this.campMembers(camp).some(m=>this.canAttackEntity(m.type,attacker,false)))return;

    const wasReset=camp.resetting;
    if(wasReset){
      camp.resetting=false;
      // Re-entry starts a new outside-combat allowance. A leftover 100% gauge
      // must not immediately cancel this explicitly requested re-engagement.
      camp.aggroGauge=0;
      camp.insideAggroStartedAt=-1;
      camp.lastAggroGaugeTick=this.tick;
    }
    const existing=!wasReset&&this.campEnemyById(camp.aggroTargetId);
    this.engageCamp(camp,existing||attacker,target);
  }
  emitUnitDeath(target,sourceSide,sourceType){
    if(!target||target.alive===false)return null;

    UNIT_COMBAT_BEHAVIORS[target.type]?.onDeath?.(this,target,sourceSide,sourceType);

    target.hp=0;
    target.alive=false;

    if(UnitDefinition.get(target.type)?.economyWorker&&target.buildTargetId){
      const b=this.resolveConstructionTarget(target.buildTargetId);
      if(b&&b.builderUnitId===target.id){b.builderUnitId=null;if(!b.complete&&b.alive!==false)b.constructionState="waitingWorker"}
    }
    if(UnitDefinition.get(target.type)?.ownsSummonedUnits){
      for(const u of this.units)if(u.alive&&UnitDefinition.get(u.type)?.targetLeashToSummoner&&u.summonerId===target.id){u.hp=0;u.alive=false}
    }
    if(target.side===NEUTRAL_SIDE&&target.campId){
      const camp=this.camps.find(c=>c.id===target.campId);
      if(camp){
        if(sourceSide===0||sourceSide===1)camp.lastHitSide=sourceSide;
        if(this.isMainObjectiveCamp(camp)){camp.lastDeathX=target.x;camp.lastDeathY=target.y}
      }
    }
    if(target.objectiveCaptured&&target.behaviorState.objectiveCampId){
      const camp=this.camps.find(c=>c.id===target.behaviorState.objectiveCampId);
      if(camp){camp.lastDeathX=target.x;camp.lastDeathY=target.y;this.beginObjectiveRespawn(camp,target.x,target.y)}
    }
    if((sourceSide===0||sourceSide===1)&&target.side===1-sourceSide)this.launchStats.kills[sourceSide]++;
    this.events.push({type:"death",side:target.side,x:target.x,y:target.y,entity:target.type,killerSide:sourceSide,sourceType,objectiveCaptured:!!target.objectiveCaptured});
    return null;
  }
  triggerPillbugBlast(unit,scale=1,radiusOverride=null){
    if(!unit||unit.pillbugBlastDone)return null;
    unit.pillbugBlastDone=true;
    const def=UnitDefinition.get(unit.type)||{};
    const radius=Math.floor(radiusOverride||def.attackSplash||def.deathSplash||80);
    const base=Math.floor((def.atk||0)*scale);
    this.events.push({
      type:"pillbugBurst",side:unit.side,x:unit.x,y:unit.y,
      radius,damage:base,sourceType:"pillbug"
    });
    let win=null;
    this.withNearbyUnits(unit.x,unit.y,radius,indices=>{
      for(const idx of indices){
        const e=this.units[idx];
        if(!e?.alive||e.id===unit.id||e.side===unit.side)continue;
        if(Math.hypot(e.x-unit.x,e.y-unit.y)<=radius){
          const r=this.applyDamage(unit.side,unit.type,e,false,base,unit.id,{damageClass:"area"});
          if(r)win=r;
        }
      }
    });
    for(const b of this.buildings){
      if(!b.alive||b.side===unit.side)continue;
      if(Math.hypot(b.x-unit.x,b.y-unit.y)<=Math.max(30,radius*.7)){
        const r=this.applyDamage(unit.side,unit.type,b,true,Math.floor(base*.6),unit.id,{damageClass:"area"});
        if(r)win=r;
      }
    }
    return win;
  }
  flatArmorValue(target){
    if(!target||BuildingDefinition.get(target.type))return Math.max(0,Number(BuildingDefinition.get(target.type)?.flatArmor)||0);
    const d=UnitDefinition.get(target.type)||{};
let value=Math.max(0,Number(d.flatArmor)||0);
    if(target.objectiveCaptured&&target.objectiveCapturedScale)value=Math.max(0,Math.round(value*target.objectiveCapturedScale));
    if(d.abilityFlatArmor&&this.hasAbility(target.side,target.type)){
      const condition=d.abilityFlatArmorCondition||null;
      const active=!condition||(condition==="crouched"&&!!target.movement.crouched);
      if(active)value+=Number(d.abilityFlatArmor)||0;
    }
    return value;
  }
  thornReflectDamage(target,sourceType,sourceEntityId,options=null){
    if(!target||!Number(UnitDefinition.get(target.type)?.meleeReflectFlatArmorPct)||target.alive===false||options?.reflected)return 0;
    if(!sourceEntityId||sourceType===target.type)return 0;
    const sourceRef=this.liveEntityRefById(sourceEntityId);
    if(!sourceRef||sourceRef.isBuilding)return 0;
    const source=sourceRef.entity;
    if(source.side===target.side||source.side===NEUTRAL_SIDE&&target.side===NEUTRAL_SIDE)return 0;
    const sourceDef=UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType)||{};
    const projectile=!!sourceDef.projectile;
    if(projectile&&!this.hasSpecialResearch(target.side,"thornfruitSpines"))return 0;
    const reflect=Math.max(0,Math.round(this.flatArmorValue(target)*(Number(UnitDefinition.get(target.type)?.meleeReflectFlatArmorPct)||100)/100));
    if(reflect<=0)return 0;
    const hpBefore=Math.max(0,source.hp||0);
    source.hp=Math.max(0,hpBefore-reflect);
    const dealt=Math.min(hpBefore,reflect);
    if(dealt>0){
      source.hitFlash=4;source.combat.recordImpact(this,4);
      this.events.push({type:"thornReflect",side:target.side,x:target.x,y:target.y,x2:source.x,y2:source.y,amount:dealt,sourceId:target.id,targetId:source.id,targetType:source.type});
      if(source.hp<=0){
        source.alive=false;
        this.events.push({type:"death",side:source.side,x:source.x,y:source.y,entity:source.type,killerSide:target.side,sourceType:"thornfruit"});
      }
    }
    return dealt;
  }
  tryGuardshroomRetaliation(target,attackerId){
    const providerId=target?.hitGuardSourceId||null;if(!providerId||!attackerId)return false;
    const provider=this.unitById.get(providerId)||this.units.find(x=>x?.alive&&x.id===providerId);
    if(!provider?.alive||provider.type!=="guardshroom"||!this.hasSpecialResearch(provider.side,"guardshroomRetaliation"))return false;
    const attackerRef=this.liveEntityRefById(attackerId);const attacker=attackerRef?.entity;if(!attacker||attacker.alive===false||attacker.side===provider.side)return false;
    const d=UnitDefinition.get(provider.type)||{},range=Math.max(0,Number(d.guardRetaliationRange)||250);
    if(Math.hypot(attacker.x-provider.x,attacker.y-provider.y)>range)return false;
    const manaCost=Math.max(0,Number(d.guardRetaliationManaCost)||10);if(!this.consumeUnitMana(provider,manaCost))return false;
    this.spawnProjectile({id:"p"+(++this.seq),owner:provider.id,side:provider.side,type:provider.type,x:provider.x,y:provider.y,target:attacker.id,isBuilding:!!attackerRef.isBuilding,speed:d.projectile||175,damage:Math.max(1,Number(d.guardRetaliationDamage)||25),splash:Math.max(0,Number(d.guardRetaliationSplash)||50),splashScale:1,splashBuildings:true,damageClass:"area",impactEventKind:"retaliation",visualTag:"guardRetaliation",arcHeight:Math.max(0,Number(d.guardRetaliationArcHeight)||35)});
    this.events.push({type:"guardRetaliation",side:provider.side,x:provider.x,y:provider.y,x2:attacker.x,y2:attacker.y,sourceId:provider.id,targetId:attacker.id,targetType:attacker.type,manaCost});return true;
  }
  applyDamage(sourceSide,sourceType,target,isBuilding,amount,sourceEntityId=null,options=null){
    const capture=options?.capture||null;
    const setCapture=(dealt=0,blocked=false,damageClass=null)=>{if(capture){capture.dealt=dealt;capture.blocked=blocked;capture.damageClass=damageClass}};
    if(!isBuilding&&(UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType))&&!this.canAttackEntity(sourceType,target,false)){setCapture(0,true,options?.damageClass||UnitDefinition.damageClass(sourceType));return null}
    if(!target||target.alive===false||target.hp<=0)return null;
    const damageClass=options?.damageClass||UnitDefinition.damageClass(sourceType);
    const sourceDamageResolved=!!options?.sourceDamageResolved;
    if(!sourceDamageResolved&&sourceEntityId){
      this.markTerrainAttackReveal(sourceType,sourceEntityId,target,isBuilding);
      if(this.terrainUphillMiss(sourceType,sourceEntityId,target,isBuilding,`${this.tick}|${sourceEntityId}|${target.id}|direct`)){
        this.events.push({type:"dodge",reason:"uphill",side:target.side,x:target.x,y:target.y,sourceSide,sourceType,sourceId:sourceEntityId,targetId:target.id});
        setCapture(0,true,damageClass);return null;
      }
    }
    const sourceUnit=!sourceDamageResolved&&sourceEntityId?(this.unitById.get(sourceEntityId)||this.units.find(u=>u.id===sourceEntityId&&u.alive)):null;
    const friendlySide=sourceDamageResolved?options?.sourceFriendlySide:(sourceUnit?.campId?this.campFriendlySide(this.camps.find(c=>c.id===sourceUnit.campId)):null);
    if(target.side===sourceSide||this.neutralObjectFriendlyToSide(target,sourceSide)||
       (sourceSide===NEUTRAL_SIDE&&friendlySide!=null&&target.side===friendlySide)){setCapture(0,true);return null}
    const td=isBuilding?{sizeClass:"heavy",role:"building"}:UnitDefinition.get(target.type);
    let rawAmount=Math.max(0,Number(amount)||0);
    if(!sourceDamageResolved&&sourceUnit?.objectiveCaptured&&sourceUnit.objectiveCapturedScale)rawAmount=Math.max(1,Math.round(rawAmount*sourceUnit.objectiveCapturedScale));
    if(!isBuilding)this.triggerNeutralRetaliation(target,sourceSide,sourceEntityId);

    let dmg=this.damageAmount(sourceType,td,rawAmount,damageClass);
    if(!sourceDamageResolved&&(sourceSide===0||sourceSide===1)&&!UnitDefinition.get(sourceType)?.economyWorker&&(UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType))&&!sourceUnit?.objectiveCaptured){
      const atkLv=this.attackUpgrade[sourceSide]||0;
      const passiveAtk=UnitDefinition.get(sourceType)?this.passiveAttackPct(sourceSide,sourceType):0;
      dmg=Math.max(1,Math.floor(dmg*(100+atkLv*ATTACK_UPGRADE_PCT_PER_LEVEL+passiveAtk)/100));
    }

    if(!isBuilding&&(target.side===0||target.side===1)&&!target.objectiveCaptured){
      const armorLv=this.armorUpgrade[target.side]||0;
      dmg=Math.max(1,Math.floor(dmg*(100-armorLv*ARMOR_REDUCTION_PCT_PER_LEVEL)/100));

      const sourceDef=UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType)||{};
      const defenseBehavior=UNIT_COMBAT_BEHAVIORS[target.type];
      if(defenseBehavior?.modifyIncomingDamage)dmg=defenseBehavior.modifyIncomingDamage(this,target,dmg,sourceDef,{sourceSide,sourceType,sourceEntityId,options});

    }

    if(!isBuilding&&sourceSide!==target.side&&this.unitLayer(target.type)==="GROUND"){
      const terrain=this.terrainAt(target.x,target.y);
      if(terrain.river)dmg=Math.max(1,Math.floor(dmg*1.5));
    }

    const flatArmor=this.flatArmorValue(target);
    if(flatArmor>0){
      const delivery=options?.damageDelivery||"hit";
      if(delivery==="continuous"){
        const seconds=Math.max(0,Number(options?.deliverySeconds)||0);
        // flatArmor is interpreted as damage prevented per second for continuous delivery.
        // Quantize only at the final hit boundary; attack cadence itself no longer multiplies armor.
        const armorForPulse=flatArmor*seconds;
        dmg=Math.max(1,Math.round(dmg-armorForPulse));
      }else{
        dmg=Math.max(1,dmg-flatArmor);
      }
    }

    if(!isBuilding&&(Number(target.hitGuard)||0)>0){
      const guardProviderId=target.hitGuardSourceId||null;
      target.hitGuard=Math.max(0,(Number(target.hitGuard)||0)-1);
      if(target.hitGuard<=0)target.hitGuardSourceId=null;
      target.hitFlash=3;target.combat.recordImpact(this,3);
      this.events.push({
        type:"hitGuardBreak",side:target.side,x:target.x,y:target.y,
        remaining:target.hitGuard,sourceSide,sourceType,sourceId:sourceEntityId||null,targetType:target.type,guardProviderId
      });
      if(guardProviderId){const prev=target.hitGuardSourceId;target.hitGuardSourceId=guardProviderId;this.tryGuardshroomRetaliation(target,sourceEntityId);target.hitGuardSourceId=prev;}
      setCapture(0,true,damageClass);
      return null;
    }

    const hpBefore=Math.max(0,target.hp||0);
    target.hp-=dmg;
    const dealt=Math.min(hpBefore,dmg);
    setCapture(dealt,false,damageClass);
    if(!isBuilding){target.hitFlash=4;target.combat.recordImpact(this,4)}

    this.events.push({
      type:"hit",side:target.side,x:target.x,y:target.y,amount:dmg,sourceSide,
      sourceType,sourceId:sourceEntityId||null,targetId:target.id||null,targetType:isBuilding?"building":target.type,isBuilding:!!isBuilding,damageClass,
      suppressImpactFx:!!options?.suppressImpactFx
    });

    let reactiveWinner=null;
    if(!isBuilding)reactiveWinner=UNIT_COMBAT_BEHAVIORS[target.type]?.afterDamaged?.(this,target,{sourceSide,sourceType,sourceEntityId,options,damage:dmg})||null;
    if(reactiveWinner)return reactiveWinner;

    if(target.hp<=0){
      if(isBuilding){
        target.hp=0;
        this.releaseBuilderForBuilding(target);
        target.alive=false;
        this.markBuildingSpatialDirty();
        this.events.push({type:"buildingDeath",side:target.side,x:target.x,y:target.y,entity:target.type,isOutpost:!!BuildingDefinition.get(target.type)?.isOutpost,killerSide:sourceSide,sourceType});
        if(BuildingDefinition.get(target.type)?.isOutpost)this.releaseCaptureForOutpost(target.id);
        if(BuildingDefinition.get(target.type)?.isMainBase&&this.campaignScenario?.victory?.type!=="structure-group-destroyed")return target.side===0?"guest":"host";
      }else{
        this.emitUnitDeath(target,sourceSide,sourceType);
        const deathWinner=UNIT_COMBAT_BEHAVIORS[target.type]?.onDeath?.(this,target,sourceSide,sourceType);
        if(deathWinner)return deathWinner;
      }
    }
    return null;
  }
  radialFalloffMultiplier(distance,radius,profile="100-75-50"){
    const q=RangeUtil.clamp(distance/Math.max(1,radius),0,1);
    if(profile==="100-75-50")return q<=1/3?1:q<=2/3?.75:.50;
    return 1;
  }
  applyAreaDamage({sourceSide,sourceType,sourceEntityId=null,x,y,radius,damage,damageClass="area",radialFalloff=null,excludeIds=null,onHit=null,suppressImpactFx=false,sourceDamageResolved=false,sourceFriendlySide=null}={}){
    let winner=null;
    const excluded=excludeIds instanceof Set?excludeIds:new Set(excludeIds||[]);
    this.withNearbyUnits(x,y,radius+this.maxUnitRadius,indices=>{
      for(const idx of indices){
        const e=this.units[idx];
        if(!e?.alive||e.side===sourceSide||excluded.has(e.id))continue;
        const dist=Math.hypot(e.x-x,e.y-y);
        if(dist>radius+this.unitRadius(e.type))continue;
        const scale=radialFalloff?this.radialFalloffMultiplier(Math.max(0,dist-this.unitRadius(e.type)),radius,radialFalloff):1;
        const capture={dealt:0,blocked:false,damageClass};
        const result=this.applyDamage(sourceSide,sourceType,e,false,Math.max(1,Math.floor(damage*scale)),sourceEntityId,{damageClass,capture,suppressImpactFx,sourceDamageResolved,sourceFriendlySide});
        if(typeof result==="string")winner=result;
        if(onHit)onHit(e,capture);
      }
    });
    return winner;
  }
  setTimedModifier(u,key,{until=null,durationTicks=0,movePct=100,attackSpeedPct=100,maxStacks=1,refresh=true,persistent=false,resetOnMove=false}={}){
    if(!u)return;
    if(!u.status.timedModifiers)u.status.timedModifiers={};
    const prev=u.status.timedModifiers[key];
    const expire=persistent?0:(until??(this.tick+Math.max(1,Math.round(durationTicks||1))));
    if(prev&&(prev.persistent||prev.until>this.tick)){
      if(!prev.persistent)prev.until=refresh?Math.max(prev.until,expire):prev.until;
      prev.persistent=!!(prev.persistent||persistent);
      prev.resetOnMove=!!(prev.resetOnMove||resetOnMove);
      prev.stacks=Math.min(maxStacks,Math.max(1,(prev.stacks||1)+1));
      prev.movePct=Math.max(prev.movePct||100,movePct);
      prev.attackSpeedPct=Math.max(prev.attackSpeedPct||100,attackSpeedPct);
    }else{
      u.status.timedModifiers[key]={until:expire,stacks:1,movePct,attackSpeedPct,persistent:!!persistent,resetOnMove:!!resetOnMove};
    }
  }
  timedModifierPct(u,field){
    let pct=100;
    if(!u?.status.timedModifiers)return pct;
    for(const [key,m] of Object.entries(u.status.timedModifiers)){
      if(!m||(!m.persistent&&m.until<=this.tick)){delete u.status.timedModifiers[key];continue}
      const stacks=Math.max(1,m.stacks||1);
      const one=Math.max(100,Number(m[field])||100);
      pct=Math.max(pct,100+(one-100)*stacks);
    }
    return pct;
  }
  nearbyUnitScaling(u,profile){
    if(!u||!profile)return{count:0,movePct:100,attackSpeedPct:100};
    let count=0;
    for(const idx of this.nearbyUnits(u.x,u.y,profile.radius||150,u.side)){
      const a=this.units[idx];
      if(!a?.alive||a.id===u.id||a.side!==u.side)continue;
      if(profile.sameType&&a.type!==u.type)continue;
      if(profile.sameRole&&UnitDefinition.get(a.type)?.role!==UnitDefinition.get(u.type)?.role)continue;
      if(Math.hypot(a.x-u.x,a.y-u.y)>(profile.radius||150))continue;
      count++;
    }
    const steps=Math.min(profile.maxSteps||3,Math.floor(count/Math.max(1,profile.countPerStep||2)));
    return{
      count,
      movePct:100+steps*(profile.movePctPerStep||0),
      attackSpeedPct:100+steps*(profile.attackSpeedPctPerStep||0)
    };
  }
  combatRampSpeedPct(u,found){
    if(!u||!UnitDefinition.get(u.type))return 100;
    const d=UnitDefinition.get(u.type);
    if(!Number(d.outOfCombatRampMs)||!Number(d.outOfCombatMaxSpeedPct))return 100;
    const profile={
      rampTicks:this.msTicks(d.outOfCombatRampMs),
      maxSpeedPct:d.outOfCombatMaxSpeedPct,
      requiresAbility:!!d.outOfCombatRampRequiresAbility,
      resetOnCombat:!!d.outOfCombatResetOnCombat,
      writeMomentum:!!d.outOfCombatWriteMomentum,
      holdOnCombat:!!d.outOfCombatHoldOnCombat
    };
    if(profile.requiresAbility&&!this.hasAbility(u.side,u.type))return 100;

    if(found||u.combat.recentlyImpacted(this)){
      if(profile.resetOnCombat){
        u.movement.outOfCombatStartedAt=-1;
        if(profile.writeMomentum)u.movement.chargeMomentum=1000;
        return 100;
      }
      if(profile.holdOnCombat&&profile.writeMomentum){
        return Math.max(100,Math.round((u.movement.chargeMomentum||1000)/10));
      }
      return 100;
    }

    if((u.movement.outOfCombatStartedAt??-1)<0)u.movement.outOfCombatStartedAt=this.tick;
    const outOfCombatElapsed=Math.min(this.msTicks(20000),this.tick-u.movement.outOfCombatStartedAt+1);
    const q=RangeUtil.clamp(outOfCombatElapsed/Math.max(1,profile.rampTicks||1),0,1);
    const pct=Math.round(100+(profile.maxSpeedPct-100)*q);
    if(profile.writeMomentum)u.movement.chargeMomentum=Math.round(1000+(pct-100)*10);
    return pct;
  }
  formationCohortReady(u,target,profile){
    const cfg=profile?.cohort||{};
    const min=Math.max(0,Math.round(Number(cfg.min)||0));
    if(min<=0)return true;
    let cohort=0;
    for(const idx of this.nearbyUnits(u.x,u.y,Math.max(1,Number(cfg.selfRadius)||180),u.side)){
      const a=this.units[idx];
      if(!a?.alive||a.id===u.id||a.side!==u.side)continue;
      if(String(a.target||"")===String(target.id||"")){
        cohort++;
        if(cohort>=min)return true;
      }
    }
    for(const idx of this.nearbyUnits(target.x,target.y,Math.max(1,Number(cfg.targetRadius)||150),u.side)){
      const a=this.units[idx];
      if(!a?.alive||a.id===u.id||a.side!==u.side)continue;
      cohort++;
      if(cohort>=min)return true;
    }
    return false;
  }
  formationPointPassable(u,x,y){
    if(this.unitLayer(u.type)==='AIR')return true;
    this.navigation.sync();
    return this.navigation.segmentClear(u.x,u.y,x,y,this.unitRadius(u.type),TerrainNavigation.ignoresBuildings(u)?'*':null,true,0);
  }
  formationBandCounts(bands){
    const keys=["left","right","center"];
    const slotCount=Math.max(1,Math.round(Number(bands?.slotCount)||8));
    const src=bands?.ratios||{};
    const values=keys.map(k=>Math.max(0,Number(src[k])||0));
    const sum=values.reduce((a,b)=>a+b,0)||1;
    const raw=values.map(v=>v/sum*slotCount);
    const counts=raw.map(Math.floor);
    let remain=slotCount-counts.reduce((a,b)=>a+b,0);
    const order=raw.map((v,i)=>({i,frac:v-counts[i]})).sort((a,b)=>b.frac-a.frac||a.i-b.i);
    for(let i=0;i<remain;i++)counts[order[i%order.length].i]++;
    return{left:counts[0],right:counts[1],center:counts[2],total:slotCount};
  }
  formationFallback(u,target,moveSpeed,profileId,depth){
    if(!profileId||profileId==="direct")return{x:target.x,y:target.y,mode:"direct"};
    return this.formationMoveTarget(u,target,moveSpeed,profileId,(depth||0)+1);
  }
  formationMoveTarget(u,target,moveSpeed,profileId="direct",depth=0){
    const direct={x:target?.x??u?.x??0,y:target?.y??u?.y??0,mode:"direct"};
    if(!u||!target||profileId==="direct"||BuildingDefinition.get(target.type)||depth>4)return direct;
    const profile=FormationDefinition.profiles[profileId];
    if(!profile)return direct;

    if(profile.kiteFallbackProfile&&UnitDefinition.get(target.type)?.maintainIdealRange){
      return this.formationFallback(u,target,moveSpeed,profile.kiteFallbackProfile,depth);
    }

    const dist=Math.hypot(target.x-u.x,target.y-u.y);
    const contact=this.interactionDistance(u,target,"combat-contact")+(UnitDefinition.get(u.type)?.range||0);
    if(dist<=contact+Math.max(0,Number(profile.contactPadding)||0))return direct;

    const activation=profile.activation||null;
    if(activation&&(Number(activation.enemyClusterMin)||0)>0){
      const excluded=new Set(activation.excludeTypes||[]);
      let enemyCluster=0;
      for(const idx of this.nearbyUnits(target.x,target.y,Math.max(1,Number(activation.enemyClusterRadius)||260),target.side)){
        const e=this.units[idx];
        if(!e?.alive||e.side!==target.side||excluded.has(e.type))continue;
        enemyCluster++;
      }
      if(enemyCluster<(Number(activation.enemyClusterMin)||0)){
        return this.formationFallback(u,target,moveSpeed,profile.fallbackProfile,depth);
      }
    }

    if(!this.formationCohortReady(u,target,profile))return direct;

    const dx=target.x-u.x,dy=target.y-u.y,len=Math.hypot(dx,dy)||1;
    const dirX=dx/len,dirY=dy/len,nx=-dirY,ny=dirX;
    const directCost=dist;

    if(profile.strategy==="pairedFlank"){
      const f=profile.flank||{};
      const sideBias=(HashUtil.hash(`${u.id}|${target.id}|${f.hashSalt||profileId}`)&1)?1:-1;
      const minOffset=Math.max(0,Number(f.minOffset)||0),maxOffset=Math.max(minOffset,Number(f.maxOffset)||minOffset);
      const offset=Math.min(maxOffset,Math.max(minOffset,this.unitRadius(target.type)*(Number(f.targetRadiusScale)||0)));
      for(const side of [sideBias,-sideBias]){
        const x=RangeUtil.clamp(target.x+nx*offset*side,20,this.world.width-20);
        const y=RangeUtil.clamp(target.y+ny*offset*side,20,this.world.height-20);
        if(!this.formationPointPassable(u,x,y))continue;
        const cost=Math.hypot(x-u.x,y-u.y)+Math.hypot(target.x-x,target.y-y);
        if(cost>directCost*Math.max(1,Number(f.maxCostMultiplier)||1))continue;
        return{x,y,mode:"surround"};
      }
      return direct;
    }

    if(profile.strategy==="bands"){
      const b=profile.bands||{};
      const counts=this.formationBandCounts(b);
      const slot=HashUtil.hash(`${u.id}|enemy-side-${target.side}|${b.hashSalt||profileId}`)%counts.total;
      let band="center",bandIndex=0,bandCount=counts.center;
      if(slot<counts.left){band="left";bandIndex=slot;bandCount=counts.left}
      else if(slot<counts.left+counts.right){band="right";bandIndex=slot-counts.left;bandCount=counts.right}
      else{bandIndex=slot-counts.left-counts.right}

      let lateral=0,back=0,maxCostMultiplier=1;
      if(band==="left"||band==="right"){
        const sign=band==="left"?1:-1;
        const spread=Math.max(0,Number(b.sideSpread)||0);
        const spreadOffset=bandCount>1?((bandIndex+.5)/bandCount-.5)*spread:0;
        lateral=sign*(Math.max(0,Number(b.sideOffset)||0)+spreadOffset);
        back=Math.max(0,Number(b.sideBackOffset)||0);
        maxCostMultiplier=Math.max(1,Number(b.sideMaxCostMultiplier)||1);
      }else{
        if(bandCount<=0)return direct;
        lateral=(2*bandIndex+1-bandCount)*Math.max(0,Number(b.centerSpread)||0)/(2*bandCount);
        back=Math.max(0,Number(b.centerBackOffset)||0);
        maxCostMultiplier=Math.max(1,Number(b.centerMaxCostMultiplier)||1);
      }

      const x=RangeUtil.clamp(target.x+nx*lateral-dirX*back,20,this.world.width-20);
      const y=RangeUtil.clamp(target.y+ny*lateral-dirY*back,20,this.world.height-20);
      if(!this.formationPointPassable(u,x,y))return direct;
      const cost=Math.hypot(x-u.x,y-u.y)+Math.hypot(target.x-x,target.y-y);
      if(cost>directCost*maxCostMultiplier)return direct;
      return{x,y,mode:"surround"};
    }

    return direct;
  }
  engagementGoal(u,target,moveSpeed,profile,attackRange){
    const point=this.formationMoveTarget(u,target,moveSpeed,profile);
    return point.mode==="direct"?InteractionGeometry.goal(u,target,"attack",attackRange):NavigationGoal.point(point.x,point.y);
  }
  controlDurationTicks(target,ticks){
    const sizeClass=UnitDefinition.get(target?.type)?.sizeClass||"medium";
    const mul=sizeClass==="heavy"?.65:sizeClass==="medium"?.82:1;
    return Math.max(1,Math.round(Math.max(1,ticks)*mul));
  }
  applyAreaAirborne({sourceSide,sourceType,x,y,radius,durationTicks,height=22,excludeIds=null}={}){
    const excluded=excludeIds instanceof Set?excludeIds:new Set(excludeIds||[]);
    let count=0;
    for(const idx of this.nearbyUnits(x,y,radius+this.maxUnitRadius)){
      const e=this.units[idx];
      if(!e?.alive||e.side===sourceSide||excluded.has(e.id)||this.unitLayer(e.type)!=="GROUND")continue;
      if(Math.hypot(e.x-x,e.y-y)>radius+this.unitRadius(e.type))continue;
      const ticks=this.controlDurationTicks(e,durationTicks);
      if(this.applyAirborne(e,{durationTicks:ticks,height,sourceSide,sourceType}))count++;
    }
    return count;
  }
  applyKnockbackFromPoint(source,target,x,y,effect={}){
    if(this.neutralObjectFriendlyToSide(target,source?.side))return false;
    if(!target||target.alive===false||this.unitLayer(target.type)==="AIR")return false;
    if(this.tick<(target.status.knockbackImmuneUntil||0))return false;
    const td=UnitDefinition.get(target.type)||{};
    const base=Math.max(0,Number(effect.distance)||0);
    const sizeMul=effect.sizeMultiplier?.[td.sizeClass]??(td.sizeClass==="heavy"?.62:td.sizeClass==="medium"?.82:1);
    const roleMul=effect.roleMultiplier?.[td.role]??1;
    const resistance=RangeUtil.clamp(Number(td.knockbackResistancePct)||0,0,90);
    const distance=base*sizeMul*roleMul*(100-resistance)/100;
    if(distance<=.01)return false;
    let dx=target.x-x,dy=target.y-y,len=Math.hypot(dx,dy);
    if(len<.001){const h=HashUtil.hash(`${source?.id||source?.type||"effect"}|${target.id}|${this.tick}`),a=(h%6283)/1000;dx=Math.cos(a);dy=Math.sin(a);len=1}
    const ur=this.unitRadius(target.type);
    let nx=RangeUtil.clamp(target.x+dx/len*distance,ur+8,this.world.width-ur-8);
    let ny=RangeUtil.clamp(target.y+dy/len*distance,ur+8,this.world.height-ur-8);
    this.navigation.motion.move(target,nx,ny,'project');
    target.status.knockbackImmuneUntil=this.tick+Math.max(1,Math.round(effect.lockTicks||this.msTicks(300)));
    this.events.push({type:"knockback",side:target.side,x:target.x,y:target.y,sourceType:source?.type||"effect",targetType:target.type,distance});
    return true;
  }
  applyAreaKnockback({sourceSide,sourceType,sourceEntityId=null,x,y,radius,distance,roleMultiplier=null,sizeMultiplier=null,lockTicks=null}={}){
    lockTicks=lockTicks==null?this.msTicks(300):lockTicks;
    const source={id:sourceEntityId||sourceType||"area",type:sourceType||"effect",x,y};let count=0;
    for(const idx of this.nearbyUnits(x,y,radius+this.maxUnitRadius)){
      const e=this.units[idx];
      if(!e?.alive||e.side===sourceSide||this.unitLayer(e.type)!=="GROUND")continue;
      if(Math.hypot(e.x-x,e.y-y)>radius+this.unitRadius(e.type))continue;
      if(this.applyKnockbackFromPoint(source,e,x,y,{distance,roleMultiplier,sizeMultiplier,lockTicks}))count++;
    }
    return count;
  }
  isHostileCombatUnit(attackerSide,e){
    if(!e?.alive||e.side===attackerSide)return false;
    if(attackerSide!==0&&attackerSide!==1)return false;
    return e.side===1-attackerSide||(e.side===NEUTRAL_SIDE&&!this.neutralObjectFriendlyToSide(e,attackerSide));
  }
  specialRoleEligible(target,roles){
    if(!target?.alive)return false;
    if(target.side===NEUTRAL_SIDE)return true;
    return !!roles?.has(UnitDefinition.get(target.type)?.role);
  }
  forEachNearbyHostileUnit(attackerSide,x,y,radius,visit){
    if(attackerSide!==0&&attackerSide!==1)return;
    for(const side of [1-attackerSide,NEUTRAL_SIDE]){
      this.withNearbyUnits(x,y,radius,side,indices=>{
        for(const idx of indices){
          const e=this.units[idx];
          if(this.isHostileCombatUnit(attackerSide,e))visit(e);
        }
      });
    }
  }
  combatTargetInAttackRange(u,found,attackRange=null){
    if(!u||!found?.entity)return false;
    const d=UnitDefinition.get(u.type),t=found.entity;
    const range=attackRange??d.range,dist=Math.hypot(t.x-u.x,t.y-u.y);
    const max=this.interactionDistance(u,t,"attack",range),min=this.interactionDistance(u,t,"combat-contact")+(d.minRange||0);
    return dist<=max&&(!(d.minRange)||dist>=min);
  }
  pickAoeTargetInRange(u,visibleSources,attackRange,splashRadius){
    const d=UnitDefinition.get(u.type);let best=null,bestHits=-1,bestD2=Infinity;
    const candidateQuery=attackRange+this.maxUnitRadius+40;
    // One broad query covers legal attack candidates and their possible splash
    // neighbors. Bin its hostile candidates once, then inspect only nearby bins
    // for each legal target. Keep the original candidate cell rectangle/geometry.
    const query=candidateQuery+splashRadius+this.unitSpatial.cellSize;
    const minCellX=this.unitSpatial.cellX(u.x-candidateQuery),maxCellX=this.unitSpatial.cellX(u.x+candidateQuery);
    const minCellY=this.unitSpatial.cellY(u.y-candidateQuery),maxCellY=this.unitSpatial.cellY(u.y+candidateQuery);
    const depth=this.aoeCandidateSpatialDepth||0,scratch=this.aoeCandidateSpatialScratch[depth]||(this.aoeCandidateSpatialScratch[depth]={bins:new Map(),touched:[]});
    this.aoeCandidateSpatialDepth=depth+1;scratch.touched.length=0;
    try{this.withNearbyUnits(u.x,u.y,query,null,candidates=>{
      for(const idx of candidates){
        const e=this.units[idx];if(!this.isHostileCombatUnit(u.side,e))continue;
        const key=this.unitSpatial.keyFor(e.x,e.y);let bucket=scratch.bins.get(key);
        if(!bucket){bucket=[];scratch.bins.set(key,bucket)}
        if(!bucket.length)scratch.touched.push(bucket);
        bucket.push(idx);
      }
      for(const idx of candidates){
        const e=this.units[idx];if(!this.isHostileCombatUnit(u.side,e))continue;
        const cellX=this.unitSpatial.cellX(e.x),cellY=this.unitSpatial.cellY(e.y);
        if(cellX<minCellX||cellX>maxCellX||cellY<minCellY||cellY>maxCellY)continue;
        if(!this.canAttackEntity(u.type,e,false))continue;
        if(e.side===NEUTRAL_SIDE){if(!this.isVisible(u.side,e.x,e.y,visibleSources,this.unitLayer(e.type)==="AIR"))continue}
        else if(!this.canSeeCombatTarget(u.side,e,visibleSources))continue;
        const dx=e.x-u.x,dy=e.y-u.y,d2=dx*dx+dy*dy,dist=Math.sqrt(d2);
        const max=this.interactionDistance(u,e,"attack",attackRange),min=this.interactionDistance(u,e,"combat-contact")+(d.minRange||0);
        if(dist>max||(d.minRange&&dist<min))continue;
        let hits=0;
        const minX=this.unitSpatial.cellX(e.x-splashRadius),maxX=this.unitSpatial.cellX(e.x+splashRadius);
        const minY=this.unitSpatial.cellY(e.y-splashRadius),maxY=this.unitSpatial.cellY(e.y+splashRadius);
        for(let cy=minY;cy<=maxY;cy++)for(let cx=minX;cx<=maxX;cx++){
          const bucket=scratch.bins.get(this.unitSpatial.keyXY(cx,cy));if(!bucket)continue;
          for(const neighborIdx of bucket){const v=this.units[neighborIdx];if(Math.hypot(v.x-e.x,v.y-e.y)<=splashRadius)hits++}
        }
        if(hits>bestHits||(hits===bestHits&&d2<bestD2)||(hits===bestHits&&d2===bestD2&&best&&String(e.id)<String(best.id))){best=e;bestHits=hits;bestD2=d2}
      }
    })}finally{for(const bucket of scratch.touched)bucket.length=0;scratch.touched.length=0;this.aoeCandidateSpatialDepth=depth}
    return best?{entity:best,isBuilding:false,def:UnitDefinition.get(best.type),aoeHits:bestHits}:null;
  }
  formationJoinMovePct(u,tx,ty){
    const d=UnitDefinition.get(u?.type);
    if(!d||!Number(d.formationJoinRadius)||!Number(d.formationJoinPct)||d.formationJoinRequiresAbility&&!this.hasAbility(u.side,u.type)||this.unitLayer(u.type)!=="AIR")return 100;
    const profile={radius:d.formationJoinRadius,pct:d.formationJoinPct,minCluster:d.formationJoinMinCluster||2};
    const dx=tx-u.x,dy=ty-u.y,len=Math.hypot(dx,dy)||1,dirX=dx/len,dirY=dy/len;let count=0;
    for(const idx of this.nearbyUnits(u.x,u.y,profile.radius,u.side)){
      const a=this.units[idx];if(!a?.alive||a.id===u.id||a.side!==u.side||this.unitLayer(a.type)!=="AIR")continue;
      const rx=a.x-u.x,ry=a.y-u.y;if(rx*dirX+ry*dirY<=0)continue;
      if(Math.hypot(rx,ry)<=profile.radius)count++;
    }
    return count>=profile.minCluster?profile.pct:100;
  }
  adaptiveFormationProfile(u){
    const d=UnitDefinition.get(u.type),baseRange=d.range||0,baseSpeed=d.speed||0;
    if(!Number(d.adaptiveFormationCacheMs)||!this.hasAbility(u.side,u.type))return{preferredRange:baseRange,moveSpeed:baseSpeed};
    const every=this.msTicks(d.adaptiveFormationCacheMs||500),state=u.behaviorState;
    if(this.tick-(state.adaptiveRangeCacheTick||-999999)<every&&state.adaptiveRangeCache>0&&state.adaptiveMoveSpeedCache>0){
      return{preferredRange:state.adaptiveRangeCache,moveSpeed:state.adaptiveMoveSpeedCache};
    }
    let rangeWeighted=0,speedWeighted=0,totalSupply=0;
    const radius=d.sight||450;
    for(const idx of this.nearbyUnits(u.x,u.y,radius,u.side)){
      const a=this.units[idx];if(!a?.alive||a.id===u.id||a.side!==u.side)continue;
      const ad=UnitDefinition.get(a.type);if(!ad||(ad.atk||0)<=0||(ad.range||0)<=0)continue;
      if(Math.hypot(a.x-u.x,a.y-u.y)>radius)continue;
      const weight=Math.max(0,Number(ad.supply)||0);if(weight<=0)continue;
      rangeWeighted+=(Number(ad.range)||0)*weight;
      speedWeighted+=(Number(ad.speed)||0)*weight;
      totalSupply+=weight;
    }
    const weightedRange=totalSupply?rangeWeighted/totalSupply:0;
    const weightedSpeed=totalSupply?speedWeighted/totalSupply:baseSpeed;
    state.adaptiveRangeCache=(d.cloakAuraRadius||baseRange)+weightedRange;
    state.adaptiveMoveSpeedCache=Math.max(baseSpeed,weightedSpeed);
    state.adaptiveRangeCacheTick=this.tick;
    return{preferredRange:state.adaptiveRangeCache,moveSpeed:state.adaptiveMoveSpeedCache};
  }
  adaptivePreferredRange(u){return this.adaptiveFormationProfile(u).preferredRange}
  adaptiveFormationMoveSpeed(u){return this.adaptiveFormationProfile(u).moveSpeed}
  projectilePatternOffset(u,pattern,index){
    const count=Math.max(1,Math.round(Number(pattern?.count)||1)),radius=Math.max(0,Number(pattern?.spreadRadius)||0);
    if(radius<=0)return{x:0,y:0};
    const base=(HashUtil.hash(`${this.seed}|${u.id}|projectile-pattern|${u.behaviorState.basicAttackCount||0}`)%6283)/1000;
    const q=count<=1?0:index/(count-1),r=radius*(.35+.65*q),a=base+index*2.399963229728653;
    return{x:Math.cos(a)*r,y:Math.sin(a)*r};
  }
  scheduleProjectilePattern(u,target,isBuilding,attackValue,pattern){
    const count=Math.max(1,Math.round(Number(pattern?.count)||1)),intervalMs=Math.max(0,Number(pattern?.intervalMs)||0),perShot=Math.max(1,Math.round(Number(pattern?.damagePerShot)||attackValue/count));
    const unitPayload=this.resolveProjectileLaunchDamage({source:u,sourceSide:u.side,sourceType:u.type,target:target.id,isBuilding:false,baseDamage:perShot,damageClass:"area"});
    const buildingPayload=this.resolveProjectileLaunchDamage({source:u,sourceSide:u.side,sourceType:u.type,target:target.id,isBuilding:true,baseDamage:perShot,damageClass:"area"});
    const baseAimX=Number(target.x)||0,baseAimY=Number(target.y)||0;
    for(let i=0;i<count;i++){const off=this.projectilePatternOffset(u,pattern,i);
      const fx={kind:"patternProjectile",executeTick:this.tick+this.msTicks(intervalMs*i,{min:0}),sourceId:u.id,sourceType:u.type,side:u.side,targetId:target.id,isBuilding,speed:UnitDefinition.get(u.type)?.projectile||180,damage:isBuilding?buildingPayload:unitPayload,splashUnitDamage:unitPayload,splashBuildingDamage:buildingPayload,splash:Number(pattern.impactRadius)||0,splashScale:Number.isFinite(Number(pattern.splashScale))?Number(pattern.splashScale):1,damageClass:"area",aimOffsetX:off.x,aimOffsetY:off.y,lockedAimX:baseAimX+off.x,lockedAimY:baseAimY+off.y,impactAtAimPoint:!!pattern.impactAtAimPoint,trajectoryPolicy:pattern.impactAtAimPoint?"lockedPoint":"trackingTarget",burstIndex:i+1,burstCount:count};
      if(i===0)this.spawnPatternProjectile(fx);else this.queueDelayedEffect(fx)}
  }
  spawnPatternProjectile(fx){
    const sourceRef=this.liveEntityRefById(fx.sourceId,"unit");if(!sourceRef)return false;
    const source=sourceRef.entity,targetRef=this.liveEntityRefById(fx.targetId),target=targetRef?.entity||null;
    this.spawnProjectile({id:"p"+(++this.seq),owner:source.id,side:source.side,type:source.type,x:source.x,y:source.y,target:fx.targetId,isBuilding:fx.isBuilding,speed:fx.speed,damage:fx.damage,splash:fx.splash||0,splashScale:fx.splashScale,splashBuildings:true,damageClass:fx.damageClass||"area",sourceDamageResolved:true,splashUnitDamage:fx.splashUnitDamage,splashBuildingDamage:fx.splashBuildingDamage,aimOffsetX:fx.aimOffsetX||0,aimOffsetY:fx.aimOffsetY||0,lockedAimX:fx.lockedAimX,lockedAimY:fx.lockedAimY,trajectoryPolicy:fx.trajectoryPolicy,impactEventKind:source.type==="rocket"?"rocketBurst":null,impactAtAimPoint:!!fx.impactAtAimPoint,burstIndex:fx.burstIndex||1,burstCount:fx.burstCount||1});
    this.events.push({type:"shoot",side:source.side,x:source.x,y:source.y,unit:source.type,sourceId:source.id,targetId:fx.targetId,targetType:target?.type||null,burstShot:fx.burstIndex||1,burstCount:fx.burstCount||1});return true;
  }
  queueDelayedEffect(effect){
    if(!effect||typeof effect!=="object"||!effect.kind)return null;
    const queued={...effect,id:effect.id||`fx-${++this.seq}`};
    this.delayedEffects.push(queued);
    return queued.id;
  }
  updateDelayedEffects(){
    if(!this.delayedEffects?.length)return null;
    let winner=null;const keep=[];
    for(const fx of this.delayedEffects){
      // Delayed records may outlive their source/target through death cleanup,
      // replay/import or recovery. Entity IDs are weak references.
      if(!fx||typeof fx!=="object"||!fx.kind)continue;
      if(this.tick<(Number(fx.executeTick)||0)){keep.push(fx);continue}
      if(fx.kind==="breathVariantPulse"){
        const w=this.breathVariantPulse(fx);if(w)winner=w;
        this.events.push({type:"attackVariantBreathPulse",side:fx.side,x:fx.x,y:fx.y,dirX:fx.dirX,dirY:fx.dirY,range:fx.range,angleDeg:fx.angleDeg,sourceId:fx.sourceId,sourceType:fx.sourceType});
      }else if(fx.kind==="areaDamage"){
        const w=this.applyAreaDamage({sourceSide:fx.side,sourceType:fx.sourceType,sourceEntityId:fx.sourceId,x:fx.x,y:fx.y,radius:fx.radius,damage:fx.damage,damageClass:fx.damageClass||"area"});if(w)winner=w;
        if(fx.airborneTicks)this.applyAreaAirborne({sourceSide:fx.side,sourceType:fx.sourceType,x:fx.x,y:fx.y,radius:fx.radius,durationTicks:fx.airborneTicks,height:fx.airborneHeight||16});
        this.events.push({type:fx.eventType||"delayedArea",side:fx.side,x:fx.x,y:fx.y,radius:fx.radius,sourceId:fx.sourceId,sourceType:fx.sourceType});
      }else if(fx.kind==="patternProjectile"){this.spawnPatternProjectile(fx);
      }else if(fx.kind==="clawHookImpact"){
        const sourceRef=this.liveEntityRefById(fx.sourceId,"unit"),targetRef=this.liveEntityRefById(fx.targetId,"unit");
        if(!sourceRef||!targetRef)continue;
        const source=sourceRef.entity,target=targetRef.entity;
        if(!this.isHostileCombatUnit(source.side,target))continue;
        if(fx.ability)this.applyAirborne(target,{durationTicks:fx.airborneTicks,height:fx.airborneHeight||28,sourceSide:source.side,sourceType:source.type});
        if(!this.addUnitImpulse(target,source.x,source.y,fx.impulseDistance||96,fx.impulseTicks||this.msTicks(400),fx.impulseDecay||780))continue;
        this.events.push({type:"clawPull",side:source.side,x:source.x,y:source.y,fromX:target.x,fromY:target.y,sourceId:source.id,sourceType:source.type,targetId:target.id,targetType:target.type,impulseDistance:fx.impulseDistance,impulseTicks:fx.impulseTicks});
      }else if(fx.kind==="burstProjectile"){
        const sourceRef=this.liveEntityRefById(fx.sourceId,"unit");
        const targetRef=this.liveEntityRefById(fx.targetId);
        if(!sourceRef||!targetRef)continue;
        const source=sourceRef.entity,target=targetRef.entity;
        this.spawnProjectile({
          id:"p"+(++this.seq),owner:source.id,side:source.side,type:source.type,
          x:source.x,y:source.y,target:target.id,isBuilding:targetRef.isBuilding,
          speed:fx.speed,damage:fx.damage,splash:fx.splash||0,
          damageClass:fx.damageClass||"area"
        });
        this.events.push({
          type:"shoot",side:source.side,x:source.x,y:source.y,unit:source.type,
          sourceId:source.id,targetId:target.id,targetType:target.type,burstShot:2
        });
      }
    }
    this.delayedEffects=keep;return winner;
  }
  rootLineAttack(u,target,damage,range,width){
    const dx=target.x-u.x,dy=target.y-u.y,len=Math.hypot(dx,dy)||1;
    const nx=dx/len,ny=dy/len,hits=[];

    // 타깃 탐색/발사 가능 사거리(range)는 기존 값을 그대로 사용한다.
    // 관통 뿌리 가시 자체만 그보다 80 더 뻗어, 최대 사거리에서 공격해도
    // 가시가 타깃 몸체를 지나가고 뒤쪽 적까지 자연스럽게 관통한다.
    const thornReach=range+80;
    const cx=u.x+nx*thornReach*.5,cy=u.y+ny*thornReach*.5;
    const queryRadius=thornReach*.5+width+this.maxUnitRadius;

    for(const idx of this.nearbyUnits(cx,cy,queryRadius)){
      const e=this.units[idx];
      if(!e?.alive||e.side===u.side||e.id===u.id||!this.canAttackEntity(u.type,e,false))continue;
      const rx=e.x-u.x,ry=e.y-u.y;
      const proj=rx*nx+ry*ny;
      if(proj<0||proj>thornReach)continue;
      const perp=Math.abs(rx*ny-ry*nx);
      if(perp>width+UnitDefinition.get(e.type).size)continue;
      hits.push({e,proj});
    }

    hits.sort((a,b)=>a.proj-b.proj||String(a.e.id).localeCompare(String(b.e.id)));
    let win=null;
    for(const h of hits){
      const r=this.applyDamage(u.side,u.type,h.e,false,damage,u.id,{damageClass:"area"});
      if(r)win=r;
      if(this.hasAbility(u.side,"rootstalker"))this.applyAirborne(h.e,{durationTicks:this.controlDurationTicks(h.e,this.msTicks(250)),height:18,sourceSide:u.side,sourceType:u.type});
    }

    this.events.push({
      type:"rootSpike",side:u.side,x:u.x,y:u.y,
      x2:u.x+nx*thornReach,y2:u.y+ny*thornReach,
      width,spikeCount:Math.max(6,Math.round(thornReach/28)),travelMs:Math.max(420,Math.min(900,Math.round(thornReach*2.4)))
    });
    return win;
  }

  deepThornAttack(u,target,isBuilding,damage,radius,airborneTicks,airborneHeight){
    const x=target.x,y=target.y;
    // Render-only attack cause/effect contract. Authoritative damage and airborne still happen
    // on this tick, while clients visualize the caster driving roots underground and the
    // target-area spike erupting from the same deterministic coordinates.
    this.events.push({
      type:"deepThornCast",side:u.side,
      x:u.x,y:u.y,x2:x,y2:y,
      sourceId:u.id,sourceType:u.type,
      radius,airborneTicks,airborneHeight
    });
    let win=this.applyDamage(u.side,u.type,target,isBuilding,damage,u.id,{damageClass:"area"});
    const hitIds=new Set(isBuilding?[]:[target.id]);
    if(!isBuilding)this.applyAirborne(target,{durationTicks:airborneTicks,height:airborneHeight,sourceSide:u.side,sourceType:u.type});
    this.withNearbyUnits(x,y,radius+this.maxUnitRadius,indices=>{
      for(const idx of indices){
        const e=this.units[idx];
        if(!e?.alive||e.side===u.side||hitIds.has(e.id)||this.unitLayer(e.type)!=="GROUND")continue;
        if(Math.hypot(e.x-x,e.y-y)>radius+UnitDefinition.get(e.type).size)continue;
        const r=this.applyDamage(u.side,u.type,e,false,Math.max(1,Math.floor(damage*(UnitDefinition.get(u.type)?.spikeSplashScale||.58))),u.id,{damageClass:"area"});
        if(r)win=r;
        this.applyAirborne(e,{durationTicks:airborneTicks,height:airborneHeight,sourceSide:u.side,sourceType:u.type});
      }
    });
    this.events.push({
      type:"deepThornSpike",side:u.side,x,y,
      x2:u.x,y2:u.y,
      radius,airborneTicks,airborneHeight,
      sourceId:u.id,sourceType:u.type,
      targetId:isBuilding?null:target.id
    });
    return win;
  }

  chainFlowerAttack(u,target,damage,bounces,chainRange){
    const hit=[],sources=this.visionSources(u.side);let current=target,scale=1,win=null;
    for(let i=0;i<=bounces&&current;i++){
      hit.push(current);
      const r=this.applyDamage(u.side,u.type,current,false,Math.max(1,Math.floor(damage*scale)),u.id,{damageClass:"area"});if(r)win=r;
      if(i>=bounces)break;
      let next=null,best=Infinity;
      this.withNearbyUnits(current.x,current.y,chainRange,indices=>{
        for(const idx of indices){
          const e=this.units[idx];if(!this.isHostileCombatUnit(u.side,e)||hit.includes(e)||!this.canAttackEntity(u.type,e,false))continue;
          if(e.side!==NEUTRAL_SIDE&&!this.canTargetUnit(u.side,e,sources))continue;
          const dist=Math.hypot(e.x-current.x,e.y-current.y);if(dist>chainRange)continue;
          if(dist<best||(dist===best&&next&&String(e.id)<String(next.id))){next=e;best=dist}
        }
      });
      current=next;scale*=.65;
    }
    if(this.hasAbility(u.side,"chainflower")&&hit.length===bounces+1){
      const last=hit[hit.length-1];
      const w=this.applyAreaDamage({sourceSide:u.side,sourceType:u.type,sourceEntityId:u.id,x:last.x,y:last.y,radius:58,damage:Math.max(1,Math.round(damage*.38)),damageClass:"area"});if(w)win=w;
      this.events.push({type:"chainOverload",side:u.side,x:last.x,y:last.y,radius:58,sourceId:u.id});
    }
    this.events.push({type:"chainArc",side:u.side,points:hit.map(e=>({x:e.x,y:e.y,type:e.type}))});
    return win;
  }

  findOffensiveMobilityTarget(u,range,roles,visibleSources,options={}){
    const unit=this.findBacklineAbilityTarget(u,range,roles,visibleSources,options);
    if(unit)return {entity:unit,isBuilding:false};
    if(!u||u.alive===false)return null;
    const enemy=u.side===0?1:u.side===1?0:null;if(enemy==null)return null;
    const r2=range*range;let best=null,bestD2=Infinity;
    for(const index of this.nearbyBuildingIndices(u.x,u.y,range)){
      const b=this.buildings[index];
      if(!b||b.alive===false||b.side!==enemy||!this.canAttackEntity(u.type,b,true))continue;
      const dx=b.x-u.x,dy=b.y-u.y,d2=dx*dx+dy*dy;
      if(d2>r2||!this.isVisible(u.side,b.x,b.y,visibleSources))continue;
      if(d2<bestD2||(d2===bestD2&&best&&String(b.id)<String(best.id))){best=b;bestD2=d2}
    }
    return best?{entity:best,isBuilding:true}:null;
  }

  findBacklineAbilityTarget(u,range,roles,visibleSources,{preferFar=false,targetFilter=null,fallbackAny=false}={}){
    if(!u||u.alive===false)return null;
    const d=UnitDefinition.get(u.type),r2=range*range;
    let best=null,bestPriority=-Infinity,bestD2=preferFar?-Infinity:Infinity;
    let fallback=null,fallbackD2=Infinity;
    this.forEachNearbyHostileUnit(u.side,u.x,u.y,range,e=>{
      if(targetFilter&&!targetFilter(e))return;
      if(!this.canAttackEntity(u.type,e,false))return;
      const dx=e.x-u.x,dy=e.y-u.y,d2=dx*dx+dy*dy;
      if(d2>r2)return;
      if(e.side===NEUTRAL_SIDE){if(!this.isVisible(u.side,e.x,e.y,visibleSources,this.unitLayer(e.type)==="AIR"))return}
      else if(!this.canSeeCombatTarget(u.side,e,visibleSources))return;
      if(!this.specialRoleEligible(e,roles)){
        if(fallbackAny&&(d2<fallbackD2||(d2===fallbackD2&&fallback&&String(e.id)<String(fallback.id)))){fallback=e;fallbackD2=d2}
        return;
      }
      const role=UnitDefinition.get(e.type)?.role;
      const priority=e.side===NEUTRAL_SIDE?100:(d.priority?.[role]||100);
      const distBetter=preferFar?d2>bestD2:d2<bestD2;
      if(priority>bestPriority||(priority===bestPriority&&distBetter)||(priority===bestPriority&&d2===bestD2&&best&&String(e.id)<String(best.id))){
        best=e;bestPriority=priority;bestD2=d2;
      }
    });
    return best||fallback;
  }
  clawRetargetBlocked(target,side){
    if(!target)return false;
    const until=side===0?(target.behaviorState.clawRetargetBlockedUntil0||0):(target.behaviorState.clawRetargetBlockedUntil1||0);
    return this.tick<until;
  }

  addUnitImpulse(target,sourceX,sourceY,totalDistance,ticks,decayPermille=780){
    if(!target||target.alive===false||ticks<=0||totalDistance<=0)return false;
    const dx=sourceX-target.x,dy=sourceY-target.y,len=Math.hypot(dx,dy)||1;
    let weight=1000,sum=0;
    for(let i=0;i<ticks;i++){
      sum+=weight;
      weight=Math.max(1,Math.floor(weight*decayPermille/1000));
    }
    const initialFp=Math.max(1,Math.round(totalDistance*FP*1000/Math.max(1,sum)));
    target.movement.impulseFx=(target.movement.impulseFx||0)+Math.round(dx/len*initialFp);
    target.movement.impulseFy=(target.movement.impulseFy||0)+Math.round(dy/len*initialFp);
    target.movement.impulseUntil=Math.max(target.movement.impulseUntil||0,this.tick+ticks);
    target.movement.impulseDecay=decayPermille;
    return true;
  }

  

  updateUnitImpulses(){
    for(const u of this.units){
      if(!u.alive||!u.movement.impulseActive(this))continue;
      const ur=this.unitRadius(u.type);
      const dx=(u.movement.impulseFx||0)/FP,dy=(u.movement.impulseFy||0)/FP;
      let nx=RangeUtil.clamp(u.x+dx,ur+8,this.world.width-ur-8);
      let ny=RangeUtil.clamp(u.y+dy,ur+8,this.world.height-ur-8);

      this.navigation.motion.move(u,nx,ny,'project');

      const decay=u.movement.impulseDecay||780;
      u.movement.impulseFx=Math.trunc((u.movement.impulseFx||0)*decay/1000);
      u.movement.impulseFy=Math.trunc((u.movement.impulseFy||0)*decay/1000);
      const impulseCompletes=u.movement.impulseCompletesAfterCurrentTick(this);
      if(impulseCompletes){
        u.movement.clearImpulse();
        const effect=u.status.impulseCompleteEffect;u.status.impulseCompleteEffect=null;
        if(effect?.type==="areaAirborne"){
          this.applyAreaAirborne({sourceSide:effect.side,sourceType:effect.sourceType,x:u.x,y:u.y,radius:effect.radius,durationTicks:effect.durationTicks,height:effect.height||20});
          this.events.push({type:"pullImpact",side:effect.side,x:u.x,y:u.y,radius:effect.radius,sourceId:effect.sourceId,targetId:u.id});
        }
      }
    }
  }

  applyKnockback(attacker,target,effect={}){
    if(!attacker)return false;
    return this.applyKnockbackFromPoint(attacker,target,attacker.x,attacker.y,effect);
  }

  abilityRangeModifier(side,type,kind,base){
    const d=UnitDefinition.get(type)||{};
    if(!this.hasAbility(side,type))return base;
    const key=kind==="heal"?"abilityHealRange":null;
    const value=key?Number(d[key]):NaN;
    return Number.isFinite(value)&&value>0?value:base;
  }
  objectiveIsEnemy(u,e){
    if(!u||!e||e.alive===false||e.hp<=0)return false;
    if(u.side===NEUTRAL_SIDE)return e.side===0||e.side===1;
    return (u.side===0||u.side===1)&&e.side===1-u.side;
  }
  objectiveTargetRecord(u,visionSources=null){
    if(!u?.alive)return null;
    if(u.side===NEUTRAL_SIDE){
      const camp=this.camps.find(c=>c.id===u.campId);
      const e=camp?this.findCampTarget(camp,u):null;
      return e?{entity:e,isBuilding:!!BuildingDefinition.get(e.type)}:null;
    }
    const d=UnitDefinition.get(u.type)||{},enemy=1-u.side,sources=visionSources||this.visionSources(u.side);
    const search=Math.max(Number(d.sight)||0,(Number(d.range)||0)+160,520);
    let best=null,bestScore=Infinity;
    const consider=(e,isBuilding=false)=>{
      if(!e||!this.objectiveIsEnemy(u,e))return;
      if(!isBuilding&&!this.canAttackEntity(u.type,e,false))return;
      if(!isBuilding&&!this.canSeeCombatTarget(u.side,e,sources))return;
      const edge=isBuilding?(BuildingDefinition.get(e.type)?.size||0):this.unitRadius(e.type);
      const dist=Math.max(0,Math.hypot(e.x-u.x,e.y-u.y)-edge);
      if(dist>search)return;
      const score=dist+(isBuilding?28:0);
      if(score<bestScore||(score===bestScore&&best&&String(e.id)<String(best.entity.id))){best={entity:e,isBuilding};bestScore=score}
    };
    const current=this.unitById.get(u.target)||this.buildingById.get(u.target);
    if(current&&this.objectiveIsEnemy(u,current))consider(current,!!BuildingDefinition.get(current.type));
    this.withNearbyUnits(u.x,u.y,search,enemy,indices=>{for(const idx of indices)consider(this.units[idx],false)});
    for(const b of this.buildings)if(b.side===enemy&&b.alive!==false)consider(b,true);
    return best;
  }
  resetObjectiveDragonBreath(u){
    if(!u)return;
    u.objectiveBreathPhase=OBJECTIVE_DRAGON_BREATH_PHASE.IDLE;
    u.objectiveBreathTellUntil=0;u.objectiveBreathUntil=0;u.objectiveBreathNextTick=0;u.objectiveBreathTargetId=null;
    u.objectiveBreathDirX=1;u.objectiveBreathDirY=0;
  }
  objectiveDragonBreathIsActive(u){
    if(!u)return false;
    const phase=this.normalizeObjectiveDragonBreath(u);
    return phase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL||phase===OBJECTIVE_DRAGON_BREATH_PHASE.ACTIVE;
  }
  normalizeObjectiveDragonBreath(u){
    if(!u)return OBJECTIVE_DRAGON_BREATH_PHASE.IDLE;
    if(!OBJECTIVE_DRAGON_BREATH_PHASES.has(u.objectiveBreathPhase))this.resetObjectiveDragonBreath(u);
    return u.objectiveBreathPhase;
  }
  cancelObjectiveActions(u){
    if(!u)return;
    u.capability(ObjectiveMixin.KEY)?.cancelCharge();
    this.resetObjectiveDragonBreath(u);
    if(u.capability(ObjectiveMixin.KEY)&&u.capability(BurrowableMixin.KEY)?.isActive())u.capability(BurrowableMixin.KEY).setPhase("none");
  }
  objectiveBearShockwave(u,x,y,primaryId=null,damage=null){
    const d=UnitDefinition.get(u.type),radius=d.shockRadius||90,amount=Math.max(1,Number(damage??d.shockDamage)||50);
    let winner=null;
    this.withNearbyUnits(x,y,radius+this.maxUnitRadius,indices=>{
      for(const idx of indices){
        const e=this.units[idx];
        if(!this.objectiveIsEnemy(u,e)||e.id===primaryId||this.unitLayer(e.type)!=="GROUND")continue;
        if(Math.hypot(e.x-x,e.y-y)>radius+this.unitRadius(e.type))continue;
        const r=this.applyDamage(u.side,u.type,e,false,amount,u.id,{damageClass:"area"});if(r)winner=r;
        this.applyKnockbackFromPoint(u,e,x,y,{distance:38,lockTicks:this.msTicks(250),sizeMultiplier:{light:1,medium:.82,heavy:.62}});
        this.applyAirborne(e,{durationTicks:this.msTicks(d.shockAirborneMs||3000),height:d.shockAirborneHeight||72,sourceSide:u.side,sourceType:u.type});
      }
    });
    for(const b of this.buildings){
      if(!this.objectiveIsEnemy(u,b)||b.id===primaryId)continue;
      if(Math.hypot(b.x-x,b.y-y)>radius+(BuildingDefinition.get(b.type)?.size||30))continue;
      const r=this.applyDamage(u.side,u.type,b,true,amount,u.id,{damageClass:"area"});if(r)winner=r;
    }
    this.events.push({type:"objectiveBearShockwave",side:u.side,x,y,radius,sourceId:u.id,sourceType:u.type});
    return winner;
  }
  objectiveDragonConeHit(u,e,range,cosHalf,dirX,dirY,isBuilding=false){
    if(!this.objectiveIsEnemy(u,e))return false;
    const radius=isBuilding?(BuildingDefinition.get(e.type)?.size||0):this.unitRadius(e.type);
    const dx=e.x-u.x,dy=e.y-u.y,dist=Math.hypot(dx,dy)||1;
    if(dist-radius>range)return false;
    return (dx/dist*dirX+dy/dist*dirY)>=cosHalf;
  }
  objectiveDragonBreathTarget(u,visionSources=null){
    const target=this.unitById.get(u.objectiveBreathTargetId)||this.buildingById.get(u.objectiveBreathTargetId);
    if(target&&this.objectiveIsEnemy(u,target))return target;
    const rec=this.objectiveTargetRecord(u,visionSources);return rec?.entity||null;
  }
  startObjectiveDragonBreath(u,target){
    this.resetObjectiveDragonBreath(u);
    u.objectiveBreathPhase=OBJECTIVE_DRAGON_BREATH_PHASE.TELL;
    u.objectiveBreathTellUntil=this.tick+Math.max(6,this.msTicks(300));u.objectiveBreathTargetId=target?.id||null;
    if(target){const dx=target.x-u.x,dy=target.y-u.y,len=Math.hypot(dx,dy)||1;u.objectiveBreathDirX=dx/len;u.objectiveBreathDirY=dy/len}
    this.events.push({type:"objectiveDragonBreathTell",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type,targetId:u.objectiveBreathTargetId});
  }
  updateObjectiveDragonBreath(u,visionSources=null){
    const d=UnitDefinition.get(u.type),phase=this.normalizeObjectiveDragonBreath(u);
    if(phase===OBJECTIVE_DRAGON_BREATH_PHASE.IDLE)return {active:false,winner:null};
    if(phase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL){
      const target=this.objectiveDragonBreathTarget(u,visionSources);
      if(target){const dx=target.x-u.x,dy=target.y-u.y,len=Math.hypot(dx,dy)||1;u.objectiveBreathDirX=dx/len;u.objectiveBreathDirY=dy/len;u.objectiveBreathTargetId=target.id}
      if(this.tick<u.objectiveBreathTellUntil)return {active:true,winner:null};
      const continuous=this.continuousDamageProfile(d.breathContinuous);if(!continuous||continuous.durationMs==null){this.resetObjectiveDragonBreath(u);return {active:false,winner:null}}
      u.objectiveBreathPhase=OBJECTIVE_DRAGON_BREATH_PHASE.ACTIVE;u.objectiveBreathUntil=this.tick+this.msTicks(continuous.durationMs);u.objectiveBreathNextTick=this.tick;
      this.events.push({type:"objectiveDragonBreathStart",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type,durationTicks:this.msTicks(continuous.durationMs)});
    }
    if(this.tick>=u.objectiveBreathUntil){
      this.events.push({type:"objectiveDragonBreathEnd",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type});
      this.resetObjectiveDragonBreath(u);
      return {active:false,winner:null};
    }
    const target=this.objectiveDragonBreathTarget(u,visionSources);
    if(target){const dx=target.x-u.x,dy=target.y-u.y,len=Math.hypot(dx,dy)||1;u.objectiveBreathDirX=dx/len;u.objectiveBreathDirY=dy/len;u.objectiveBreathTargetId=target.id}
    let winner=null;
    if(this.tick>=u.objectiveBreathNextTick){
      const continuous=this.continuousDamageProfile(d.breathContinuous);if(!continuous)return {active:false,winner:null};
      u.objectiveBreathNextTick+=Math.max(1,this.msTicks(continuous.damageIntervalMs));
      const pulseDamage=continuous.damagePerTick,range=d.breathRange||300,cosHalf=Math.cos((d.breathAngleDeg||70)*Math.PI/360),dx=u.objectiveBreathDirX||1,dy=u.objectiveBreathDirY||0;
      this.withNearbyUnits(u.x,u.y,range+this.maxUnitRadius,indices=>{
        for(const idx of indices){
          const e=this.units[idx];if(!this.objectiveDragonConeHit(u,e,range,cosHalf,dx,dy,false))continue;
          const r=this.applyDamage(u.side,u.type,e,false,pulseDamage,u.id,{damageClass:"area",damageDelivery:"continuous",deliverySeconds:continuous.deliverySeconds});if(r)winner=r;
        }
      });
      for(const b of this.buildings){
        if(!this.objectiveDragonConeHit(u,b,range,cosHalf,dx,dy,true))continue;
        const r=this.applyDamage(u.side,u.type,b,true,pulseDamage,u.id,{damageClass:"area",damageDelivery:"continuous",deliverySeconds:continuous.deliverySeconds});if(r)winner=r;
      }
      this.events.push({type:"objectiveDragonBreathPulse",side:u.side,x:u.x,y:u.y,dirX:dx,dirY:dy,range,angleDeg:d.breathAngleDeg||70,sourceId:u.id,sourceType:u.type});
    }
    return {active:true,winner};
  }
  updateObjectiveActiveState(u,visionSources=null){
    return OBJECTIVE_BEHAVIORS[u?.type]?.updateActive?.(this,u,visionSources)||{active:false,winner:null};
  }
  objectiveAttackTarget(u,target,isBuilding,visionSources=null){
    if(!u||!target)return null;
    const active=this.updateObjectiveActiveState(u,visionSources);if(active.active||active.winner)return active.winner;
    return OBJECTIVE_BEHAVIORS[u.type]?.attack?.(this,u,target,isBuilding,visionSources)??null;
  }
  updateCapturedObjective(u,visionSources){
    const d=UnitDefinition.get(u.type);this.tickAttackTimers(u,true);
    if(this.isAirborneStatus(u)){this.clearAttackWindup(u);return null}
    const active=this.updateObjectiveActiveState(u,visionSources);if(active.active||active.winner)return active.winner;
    const found=this.objectiveTargetRecord(u,visionSources);
    if(found){u.target=found.entity.id;return this.objectiveAttackTarget(u,found.entity,found.isBuilding,visionSources)}
    this.clearAttackWindup(u);u.target=null;
    const p=this.objectiveLaneAdvanceTarget(u);this.moveToward(u,p.x,p.y,d.speed);return null;
  }
  neutralAreaHit(u,x,y,radius,damage){
    let winner=null;
    this.withNearbyUnits(x,y,radius+this.maxUnitRadius,indices=>{
      for(const idx of indices){
        const e=this.units[idx];if(!e?.alive||(e.side!==0&&e.side!==1))continue;
        if(Math.hypot(e.x-x,e.y-y)>radius+this.unitRadius(e.type))continue;
        const w=this.applyDamage(NEUTRAL_SIDE,u.type,e,false,damage,u.id,{damageClass:"area"});if(w)winner=w;
      }
    });
    return winner;
  }
  updateNeutralQueen(u){
    const d=UnitDefinition.get(u.type),camp=this.camps.find(c=>c.id===u.campId);
    const interval=this.msTicks(d.summonIntervalMs||5000);
    if(!camp||camp.resetting||!camp.engaged||!this.campEnemyById(camp.aggroTargetId)){
      u.nextNeutralSummonTick=0;
      return;
    }
    const summonType=d.summonType||"seedwasp",living=this.units.filter(x=>x.alive&&x.type===summonType&&x.summonerId===u.id);
    if(!u.nextNeutralSummonTick)u.nextNeutralSummonTick=this.tick+interval;
    if(this.tick<u.nextNeutralSummonTick||living.length>=(d.summonMax||4))return;
    const count=Math.min(d.summonBatch||2,(d.summonMax||4)-living.length);
    for(let i=0;i<count;i++){
      const a=(HashUtil.hash(`${u.id}|seedwasp|${this.tick}|${i}`)%6283)/1000,rr=45;
      const c=this.spawnUnit(NEUTRAL_SIDE,summonType,RangeUtil.clamp(u.x+Math.cos(a)*rr,20,this.world.width-20),RangeUtil.clamp(u.y+Math.sin(a)*rr,20,this.world.height-20));
      c.summonerId=u.id;c.campId=u.campId;this.registerCampMemberHome(camp,c,c.x,c.y);
      c.neutralSummonExpireTick=this.tick+(this.msTicks(d.summonLifetimeMs||10000));
    }
    u.nextNeutralSummonTick=this.tick+interval;
  }
  startNeutralBreath(u,target){
    this.resetObjectiveDragonBreath(u);
    u.objectiveBreathPhase=OBJECTIVE_DRAGON_BREATH_PHASE.TELL;u.objectiveBreathTellUntil=u.timers.start(this,"objectiveBreathTell",400);u.objectiveBreathTargetId=target.id;
    const dx=target.x-u.x,dy=target.y-u.y,len=Math.hypot(dx,dy)||1;u.objectiveBreathDirX=dx/len;u.objectiveBreathDirY=dy/len;
    this.events.push({type:"objectiveDragonBreathTell",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type,targetId:target.id,poison:true});
  }
  updateNeutralBreath(u){
    const d=UnitDefinition.get(u.type),phase=this.normalizeObjectiveDragonBreath(u);
    if(phase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL){
      if(this.tick<u.objectiveBreathTellUntil)return {active:true,winner:null};
      const continuous=this.continuousDamageProfile(d.breathContinuous);if(!continuous||continuous.durationMs==null){this.resetObjectiveDragonBreath(u);return {active:false,winner:null}}
      u.objectiveBreathPhase=OBJECTIVE_DRAGON_BREATH_PHASE.ACTIVE;u.objectiveBreathUntil=this.tick+this.msTicks(continuous.durationMs);u.objectiveBreathNextTick=this.tick;
      this.events.push({type:"objectiveDragonBreathStart",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type,durationTicks:this.msTicks(continuous.durationMs),poison:true});
    }
    if(this.tick>=u.objectiveBreathUntil){this.events.push({type:"objectiveDragonBreathEnd",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type,poison:true});this.resetObjectiveDragonBreath(u);return {active:false,winner:null}}
    let winner=null;
    if(this.tick>=u.objectiveBreathNextTick){
      const continuous=this.continuousDamageProfile(d.breathContinuous);if(!continuous)return {active:false,winner:null};u.objectiveBreathNextTick+=this.msTicks(continuous.damageIntervalMs);const pulseDamage=continuous.damagePerTick,range=d.breathRange||150,cos=Math.cos((d.breathAngleDeg||30)*Math.PI/360),dx=u.objectiveBreathDirX,dy=u.objectiveBreathDirY;
      this.withNearbyUnits(u.x,u.y,range+this.maxUnitRadius,indices=>{for(const idx of indices){const e=this.units[idx];if(!e?.alive||(e.side!==0&&e.side!==1))continue;const ex=e.x-u.x,ey=e.y-u.y,dist=Math.hypot(ex,ey)||1;if(dist>range+this.unitRadius(e.type)||(ex*dx+ey*dy)/dist<cos)continue;const w=this.applyDamage(NEUTRAL_SIDE,u.type,e,false,pulseDamage,u.id,{damageClass:"area",damageDelivery:"continuous",deliverySeconds:continuous.deliverySeconds});if(w)winner=w}});
      this.events.push({type:"objectiveDragonBreathPulse",side:u.side,x:u.x,y:u.y,dirX:dx,dirY:dy,range,angleDeg:d.breathAngleDeg||30,sourceId:u.id,sourceType:u.type,poison:true});
    }
    return {active:true,winner};
  }
  updateNeutral(u){
    const d=UnitDefinition.get(u.type),neutralBehavior=NEUTRAL_BEHAVIORS[u.type]||null;
    const camp=this.camps.find(c=>c.id===u.campId);
    if(!camp)return null;
    const cd=CampDefinition.get(camp.kind);

    this.tickAttackTimers(u);
    const pre=neutralBehavior?.preUpdate?.(this,u);
    if(pre?.handled)return pre.winner;

    if(camp.resetting){
      this.clearAttackWindup(u);
      if(!!UnitDefinition.get(u.type)?.objectiveKind)this.cancelObjectiveActions(u);
      u.returningHome=true;
      u.aggroed=false;
      u.forcedTargetId=null;
      // FORCED_RETURN heals on every simulation tick, both outside and inside.
      // Hit-driven re-engagement clears resetting for every member immediately.
      const maxHp=u.maxHp||d.hp||1;
      const healPerTick=Math.max(1,Math.ceil(maxHp*(cd.resetHealPerSecond||.12)/this.tps));
      const before=u.hp;
      u.hp=Math.min(maxHp,u.hp+healPerTick);
      if(u.hp>before&&u.timers.periodic(this,"neutralRecoverFx",1000)){
        this.events.push({
          type:"neutralRecover",side:NEUTRAL_SIDE,
          x:u.x,y:u.y,amount:u.hp-before,camp:camp.kind
        });
      }
      const home=this.campMemberHome(camp,u);
      if(Math.hypot(home.x-u.x,home.y-u.y)>cd.homeRadius*.45){
        this.moveToward(u,home.x,home.y,d.speed);
      }
      return null;
    }

    u.returningHome=false;
    if(!!UnitDefinition.get(u.type)?.objectiveKind){
      const active=this.updateObjectiveActiveState(u,null);
      if(active.active||active.winner)return active.winner;
    }
    let target=this.attackWindupTarget(u);
    if(!target&&u.combat.windupPending())this.clearAttackWindup(u);
    if(!target)target=this.findNeutralCombatTarget(camp,u);
    if(!target){
      this.clearAttackWindup(u);
      u.aggroed=false;
      u.forcedTargetId=null;
      const home=this.campMemberHome(camp,u);
      if(Math.hypot(home.x-u.x,home.y-u.y)>cd.homeRadius*.45){
        this.moveToward(u,home.x,home.y,d.speed);
      }
      return null;
    }

    u.aggroed=true;
    u.forcedTargetId=target.id;
    u.target=target.id;
    const buildingDef=BuildingDefinition.get(target.type);
    const isBuilding=!!buildingDef;
    if(!!UnitDefinition.get(u.type)?.objectiveKind)return this.objectiveAttackTarget(u,target,isBuilding,null);
    const dist=Math.hypot(target.x-u.x,target.y-u.y)||1;
    const max=this.interactionDistance(u,target,"attack",d.range);
    const winding=u.combat.windupPending();

    if(neutralBehavior?.beforeAttack?.(this,u,target,dist))return null;
    if(dist>max){
      if(winding)this.clearAttackWindup(u);
      this.moveToInteraction(u,target,"attack",d.speed,d.range);
      return null;
    }
    if(!this.attackReadyAfterWindup(u,target,isBuilding,d,d.range,false))return null;

    this.commitAttackTiming(u,d);
    u.neutralAttackCount=(u.neutralAttackCount||0)+1;
    neutralBehavior?.afterAttackCommitted?.(this,u,target);
    if(d.projectile){
      this.spawnProjectile({
        id:"p"+(++this.seq),owner:u.id,side:NEUTRAL_SIDE,type:u.type,x:u.x,y:u.y,target:target.id,isBuilding,
        speed:d.projectile,damage:d.atk,splash:d.splash||0,splashScale:d.splashScale??.55,splashBuildings:!!d.splash,damageClass:d.splash?"area":UnitDefinition.damageClass(u.type)
      });
      this.events.push({type:"shoot",side:NEUTRAL_SIDE,x:u.x,y:u.y,unit:u.type,sourceId:u.id,targetId:target.id,targetType:target.type});
      return null;
    }
    return this.applyDamage(NEUTRAL_SIDE,u.type,target,isBuilding,d.atk,u.id);
  }
  unitRallyPoint(u){
    const group=u.scenarioGroupId?this.camps.find(c=>c.id===u.scenarioGroupId):null;
    if(group){
      const order=group.order;
      if(order){
        const target=order.targetId?this.liveEntityRefById(order.targetId):null;
        return {x:target?.x??order.x,y:target?.y??order.y,forced:order.type==="move"};
      }
      if(group.control==="guard")return {x:group.x,y:group.y,forced:false};
    }
    if(u.launchHoldPointId){
      const cp=this.capturePoints.find(p=>p.id===u.launchHoldPointId);
      if(cp&&cp.owner==null&&cp.enabled)return {x:cp.x,y:cp.y,forced:false};
      u.launchHoldPointId=null;
    }
    return this.flags[u.side];
  }
  updateCombat(u,vision){
    const d=UnitDefinition.get(u.type),ability=this.hasAbility(u.side,u.type),combatBehavior=UNIT_COMBAT_BEHAVIORS[u.type]||null;
    if(u.objectiveCaptured&&!!UnitDefinition.get(u.type)?.objectiveKind)return this.updateCapturedObjective(u,vision?.[u.side]||[]);
    this.tickAttackTimers(u,true);
    if(this.isAirborneStatus(u)){
      this.clearAttackWindup(u);
      return null;
    }
    if(d.burrowCapable&&u.capability(BurrowableMixin.KEY)?.isActive()&&!u.capability(ObjectiveMixin.KEY)){
      const state=u.capability(BurrowableMixin.KEY)?.update(this);
      if(state.active)return state.winner;
      if(state.winner)return state.winner;
    }
    if(u.leapActive&&u.capability(LeapableMixin.KEY)){
      const state=u.capability(LeapableMixin.KEY).update(this);
      if(state.active)return state.winner;
      if(state.winner)return state.winner;
    }

    // Forced rally belongs to DefaultUnitLogicController units only. Neutral-object
    // garrisons never enter updateCombat, so no campaign/garrison exception is needed here.
    const rallyFlag=this.unitRallyPoint(u);
    if(rallyFlag?.forced){
      this.clearAttackWindup(u);
      u.target=null;
      if(combatBehavior?.forcedMove?.(this,u,d.speed))return null;
      let forcedMoveSpeed=d.speed;
      // 이동 속도 보정은 공통 계약만 사용한다. 폭낭 콩벌레 연구는 별도 도약 진입으로 처리한다.
      forcedMoveSpeed*=this.combatRampSpeedPct(u,null)/100;
      forcedMoveSpeed*=this.timedModifierPct(u,"movePct")/100;
      this.moveToward(u,rallyFlag.x,rallyFlag.y,forcedMoveSpeed);
      return null;
    }

    u.capability(ShieldProviderMixin.KEY)?.update(this);
    if(u.capability(SummonerMixin.KEY)&&!u.capability(SummonerMixin.KEY).isCarrierController())u.capability(SummonerMixin.KEY).update(this);
    if(u.capability(SummonerMixin.KEY)?.isCarrierController()){
      this.clearAttackWindup(u);u.target=null;u.capability(SummonerMixin.KEY).update(this);
      const f=this.unitRallyPoint(u);this.moveToward(u,f.x,f.y,d.speed);return null;
    }
    if(combatBehavior?.preCombat?.(this,u,d.speed))return null;
    if(u.capability(HealerMixin.KEY)&&!(u.combat.windupPending())&&u.capability(HealerMixin.KEY).update(this)){u.target=null;return null}

    let found=null;
    if((u.combat.attackWindupUntil||0)>0){
      const locked=this.attackWindupTarget(u);
      if(locked){
        const isBuilding=!!BuildingDefinition.get(locked.type);
        found={entity:locked,isBuilding,def:isBuilding?BuildingDefinition.get(locked.type):UnitDefinition.get(locked.type)};
      }else{
        this.clearAttackWindup(u);
      }
    }
    if(!found){
      if(this.combatTargetRefreshDue(u)){
        const pickStarted=this._perfCollect?performance.now():0;
        found=this.pickCombatTarget(u,vision[u.side]);
        if(this._perfCollect){this._perfCollect.combatTargetPickMs+=performance.now()-pickStarted;this._perfCollect.combatTargetPickCalls++}
      }else found=this.retainedCombatTarget(u,vision[u.side]);
    }

    combatBehavior?.updatePosture?.(this,u,found,ability);

    const normalInRange=this.combatTargetInAttackRange(u,found,this.basicAttackRange(u));
    if(!normalInRange&&!(u.combat.windupPending())&&u.capability(PullerMixin.KEY)&&this.tick>=(u.behaviorState.hookCooldownUntil||0)){
      const hookTarget=this.findBacklineAbilityTarget(u,d.hookRange,DIVE_BACKLINE_ROLES,vision[u.side],{preferFar:true,targetFilter:e=>!this.clawRetargetBlocked(e,u.side)});
      if(hookTarget)u.capability(PullerMixin.KEY)?.tryPull(this,hookTarget,vision[u.side]);
    }
    if(!normalInRange&&!(u.combat.windupPending())&&d.burrowCapable&&u.capability(BurrowableMixin.KEY)&&!u.capability(ObjectiveMixin.KEY)){
      const burrowRange=d.burrowRange||480;
      if(this.tick>=(u.behaviorState.burrowCooldownUntil||0)){
        const diveTarget=this.findOffensiveMobilityTarget(u,burrowRange,DIVE_BACKLINE_ROLES,vision[u.side],{fallbackAny:true});
        if(diveTarget)found={entity:diveTarget.entity,isBuilding:diveTarget.isBuilding,def:diveTarget.isBuilding?BuildingDefinition.get(diveTarget.entity.type):UnitDefinition.get(diveTarget.entity.type)};
      }
    }else if(u.capability(LeapableMixin.KEY)?.tryAuto(this,vision[u.side],ability)){
      return null;
    }
    let moveSpeed=this.specialResearchMoveSpeed(u.side,u.type,d.speed);
    let attackRange=this.basicAttackRange(u);
    let minRange=d.minRange||0;
    let cooldown=d.cooldown;
    let projectileSplash=d.splash||0;
    let attackValue=d.atk*this.specialResearchNumericMultiplier(u.side,u.type,"attackMultiplier");
    let selfDestructRadius=d.attackSplash||0;

    // 공통 전투 이동/공속 보정.
    const rampPct=this.combatRampSpeedPct(u,found);
    moveSpeed*=rampPct/100;
    moveSpeed*=this.timedModifierPct(u,"movePct")/100;
    const timedAttackPct=this.timedModifierPct(u,"attackSpeedPct");
    if(timedAttackPct>100)cooldown*=100/timedAttackPct;

    if(ability&&Number(d.aoeScoreRadius)>0){
      const aoe=this.pickAoeTargetInRange(u,vision[u.side],attackRange,d.aoeScoreRadius||projectileSplash||205);
      if(aoe)found=aoe;
    }

    if(combatBehavior?.modifyCombatStats){
      const stats=combatBehavior.modifyCombatStats(this,u,{moveSpeed,cooldown},ability);
      moveSpeed=stats.moveSpeed;cooldown=stats.cooldown;
    }

    if(!found){
      this.clearAttackWindup(u);
      u.target=null;
      combatBehavior?.onNoTarget?.(this,u);
      if(combatBehavior?.noTarget?.(this,u,moveSpeed))return null;
      const f=this.unitRallyPoint(u);
      this.moveToward(u,f.x,f.y,moveSpeed);
      return null;
    }

    const t=found.entity;
    u.target=t.id;
    if(combatBehavior?.validateTarget&&!combatBehavior.validateTarget(this,u,t,moveSpeed))return null;

    // Authoritative second gate: even if a target was selected earlier in this
    // tick/path, a cloaked undetected unit can never be chased/attacked.
    if(!found.isBuilding&&(!this.canAttackEntity(u.type,t,false)||!this.canTargetUnit(u.side,t,vision[u.side])||!this.canSeeCombatTarget(u.side,t,vision[u.side]))){
      this.clearAttackWindup(u);
      u.target=null;
      const f=this.unitRallyPoint(u);
      this.moveToward(u,f.x,f.y,moveSpeed);
      return null;
    }

    let dx=t.x-u.x,dy=t.y-u.y,dist=Math.hypot(dx,dy)||1;
    if(combatBehavior?.maneuverBeforeAttack?.(this,u,t,found.isBuilding,moveSpeed,attackRange,dist))return null;
    if(combatBehavior?.holdAdaptiveRange?.(this,u,t,found.isBuilding,ability,dist))return null;

    if(!(u.combat.windupPending())&&d.burrowCapable&&u.capability(BurrowableMixin.KEY)&&!u.capability(ObjectiveMixin.KEY)&&!found.isBuilding){
      const range=d.burrowRange||480;
      if(this.tick>=(u.behaviorState.burrowCooldownUntil||0)&&dist<=range&&this.specialRoleEligible(t,DIVE_BACKLINE_ROLES)){
        if(u.capability(BurrowableMixin.KEY)?.startDive(this,t))return null;
      }
    }

    const body=this.interactionDistance(u,t,"combat-contact");
    const max=this.interactionDistance(u,t,"attack",attackRange),min=body+minRange;
    const winding=u.combat.windupPending();

    // Minimum range is a legal-fire constraint, so entering it cancels any
    // non-melee wind-up. Close committed melee attacks never have minRange.
    if(minRange&&dist<min){
      if(winding)this.clearAttackWindup(u);
      this.moveToInteraction(u,t,"attack",moveSpeed,attackRange,minRange);
      return null;
    }

    // Only explicit ideal-range units perform autonomous spacing.
    // Every unit plants its feet during wind-up; post-shot mobility is controlled
    // solely by moveRecoveryUntil through moveToward().
    if(d.maintainIdealRange&&!winding){
      if(d.retreatRange&&dist<body+d.retreatRange){
        // Movement recovery locks locomotion only. If spacing movement is blocked,
        // remain planted and continue the normal attack path when legal.
        if(this.moveToInteraction(u,t,"attack",moveSpeed,d.idealRange||attackRange,d.retreatRange))return null;
      }
      if(d.idealRange&&u.combat.cooldownActive(this)&&dist>body+d.idealRange+COMBAT_IDEAL_RANGE_REPOSITION_MARGIN){
        if(this.moveToInteraction(u,t,"attack",moveSpeed,d.idealRange,minRange))return null;
      }
    }

    if(dist>max){
      // Wind-up is valid only while the target remains in legal attack range.
      // Re-entering range starts a brand-new full wind-up for melee and ranged alike.
      if(winding)this.clearAttackWindup(u);
      const engagementProfile=FormationDefinition.forUnit(u.type,ability);
      this.moveToGoal(u,this.engagementGoal(u,t,moveSpeed,engagementProfile,attackRange),moveSpeed);
      return null;
    }

    if(UnitDefinition.get(u.type)?.burrowWhileMoving)u.capability(BurrowableMixin.KEY)?.setMovementActive(this,false);
    const deployable=u.capability(DeployableCombatMixin.KEY);
    if(deployable&&!deployable.ensureAttackReady(this)){this.clearAttackWindup(u);return null}
    if(!this.attackReadyAfterWindup(u,t,found.isBuilding,d,attackRange,ability))return null;

    this.commitAttackTiming(u,d,cooldown);
    this.tryResetBasicAttackCooldown(u,d,ability);
    const stationaryRamp=this.stationaryAttackRampResearch(u.side,u.type);
    if(stationaryRamp&&this.ticksMs(this.tick-(u.movement.lastMoveTick??-999999))>=100){
      const fx=stationaryRamp.effects||{};
      this.setTimedModifier(u,`special:${stationaryRamp.id}`,{
        persistent:true,resetOnMove:fx.resetOnMove!==false,
        attackSpeedPct:100+Math.max(0,Number(fx.stationaryAttackSpeedPerStack)||0),
        maxStacks:Math.max(1,Number(fx.stationaryAttackSpeedMaxStacks)||1),refresh:true
      });
    }

    // A committed basic attack resolves to exactly one attack variant.
    // If no variant triggers, execution falls through to the unit's normal attack.
    const attackVariant=this.selectBasicAttackVariant(u);
    if(attackVariant){
      const result=this.executeBasicAttackVariant(u,t,found.isBuilding,attackVariant);
      if(result.handled)return result.winner;
    }

    const speciesAttack=combatBehavior?.resolveAttack?.(this,u,t,found.isBuilding,attackValue,attackRange,ability);
    if(speciesAttack?.handled)return speciesAttack.winner;

    if(d.selfDestruct){
      u.pillbugBlastDone=true;
      const blastUnit={...u,pillbugBlastDone:false,x:t.x,y:t.y};
      const win=this.triggerPillbugBlast(blastUnit,1,selfDestructRadius||d.attackSplash||92);
      this.events.push({type:"chargeImpact",side:u.side,x:t.x,y:t.y,multiplier:1.25});
      this.emitUnitDeath(u,u.side,u.type);
      return win;
    }

    if(d.projectile){
      if(d.projectilePattern){this.scheduleProjectilePattern(u,t,found.isBuilding,attackValue,d.projectilePattern);return null}
      this.spawnProjectile({
        id:"p"+(++this.seq),owner:u.id,side:u.side,type:u.type,
        x:u.x,y:u.y,target:t.id,isBuilding:found.isBuilding,
        speed:d.projectile,damage:attackValue,splash:projectileSplash,
        damageClass:UnitDefinition.damageClass(u.type),
        visualTag:UnitDefinition.get(u.type)?.projectileVisualTag||null
      });
      this.events.push({type:"shoot",side:u.side,x:u.x,y:u.y,unit:u.type,sourceId:u.id,targetId:t.id,targetType:t.type});
      if(ability&&Number(d.burstSecondScale)>0){
        this.queueDelayedEffect({kind:"burstProjectile",executeTick:this.tick+(this.msTicks(d.burstIntervalMs||350)),sourceId:u.id,targetId:t.id,speed:d.projectile,damage:Math.max(1,Math.round(attackValue*(d.burstSecondScale||.62))),splash:projectileSplash,damageClass:"area"});
      }
      return null;
    }

    let mult=1;
    const charger=u.capability(ChargerMixin.KEY);
    if(charger)mult=charger.consumeImpact(this,t,found.isBuilding);

    if(combatBehavior?.modifyMelee)mult=combatBehavior.modifyMelee(this,u,mult,t);

    const damageCapture={dealt:0,blocked:false};
    const win=this.applyDamage(
      u.side,u.type,t,found.isBuilding,
      Math.floor(attackValue*mult),u.id,
      {damageClass:UnitDefinition.damageClass(u.type),capture:damageCapture}
    );
    if(!found.isBuilding)charger?.applyImpactControl(this,t,mult,ability);

    if(!found.isBuilding){
      combatBehavior?.afterMeleeHit?.(this,u,t,attackValue,mult,ability,damageCapture);

    }

    return win;
  }
  interceptorForProjectile(p){
    let best=null,bestD=Infinity;
    // Interception is faction-relative, not a two-player-side lookup:
    // any interceptor that is not on the projectile's faction may defend against it.
    // This intentionally includes neutral/objective projectiles.
    for(const idx of this.nearbyUnits(p.x,p.y,260)){
      const u=this.units[idx];
      if(!u?.alive||u.side===p.side)continue;
      const cap=u.capability(InterceptorMixin.KEY);
      if(!cap?.canIntercept(this,p))continue;
      const dist=Math.hypot(u.x-p.x,u.y-p.y);
      if(dist<bestD||(dist===bestD&&best&&String(u.id)<String(best.id))){best=u;bestD=dist}
    }
    return best;
  }
  updateProjectiles(){
    const visionCache=[this.visionSources(0),this.visionSources(1)];
    for(const p of this.projectiles){
      if(!p.alive)continue;

      if((p.side===0||p.side===1)&&!p.payload){
        if(p.interceptById){
          const interceptor=this.unitById.get(p.interceptById),d=UnitDefinition.get(interceptor?.type)||{},up=interceptor?.alive&&this.hasAbility(interceptor.side,interceptor.type),radius=up?(d.abilityInterceptRadius||225):(d.interceptRadius||175);
          if(!interceptor?.alive||Math.hypot(interceptor.x-p.x,p.y-interceptor.y)>radius){
            p.interceptById=null;p.interceptDestroyTick=0;
          }else if(this.tick>=(p.interceptDestroyTick||0)){
            p.alive=false;
            this.events.push({type:"projectileRetire",projectileId:p.id,x:p.x,y:p.y,side:p.side,sourceType:p.type});
            this.events.push({type:"projectileIntercept",side:interceptor.side,x:p.x,y:p.y,sourceId:interceptor.id,targetId:p.id});continue;
          }
        }
        if(!p.interceptById){
          const interceptor=this.interceptorForProjectile(p);
          if(interceptor){
            const d=UnitDefinition.get(interceptor.type),cost=interceptor.capability(InterceptorMixin.KEY).manaCost(this);
            if(this.consumeUnitMana(interceptor,cost)){
              p.interceptById=interceptor.id;p.interceptDestroyTick=this.tick+(this.msTicks(d.interceptDelayMs||300));
              this.events.push({type:"interceptLock",side:interceptor.side,x:interceptor.x,y:interceptor.y,x2:p.x,y2:p.y,sourceId:interceptor.id,targetId:p.id,durationTicks:this.msTicks(d.interceptDelayMs||300),manaCost:cost});
            }
          }
        }
      }

      const trajectoryPolicy=p.trajectoryPolicy||(p.impactAtAimPoint?"lockedPoint":"trackingTarget");
      const targetRef=this.liveEntityRefById(p.target,p.isBuilding?"building":"unit");
      let t=targetRef?.entity||null,targetUsable=!!t;
      // Tracking projectiles update their last-known point only while the target is
      // still legally targetable. Death/removal/stealth loss freezes that point.
      if(trajectoryPolicy==="trackingTarget"&&t&&!p.isBuilding&&(p.side===0||p.side===1)&&(!this.canTargetUnit(p.side,t,visionCache[p.side])||!this.canSeeCombatTarget(p.side,t,visionCache[p.side]))){
        targetUsable=false;
        if(!p.targetLost)this.events.push({type:"projectileLostLock",side:p.side,x:p.x,y:p.y,targetType:t.type});
      }
      if(trajectoryPolicy==="trackingTarget"&&targetUsable){
        p.lockedAimX=t.x+(Number(p.aimOffsetX)||0);p.lockedAimY=t.y+(Number(p.aimOffsetY)||0);p.targetLost=false;
      }else if(trajectoryPolicy==="trackingTarget"&&!targetUsable){
        p.targetLost=true;t=null;
      }
      const aimX=trajectoryPolicy==="lockedPoint"?(Number(p.lockedAimX)||p.x):(Number(p.lockedAimX)||p.x);
      const aimY=trajectoryPolicy==="lockedPoint"?(Number(p.lockedAimY)||p.y):(Number(p.lockedAimY)||p.y);
      const dx=aimX-p.x,dy=aimY-p.y,dist=Math.hypot(dx,dy)||1,step=p.speed/this.tps;
      if(dist<20){
        p.alive=false;
        const impactX=aimX,impactY=aimY;
        this.events.push({type:"projectileRetire",projectileId:p.id,x:impactX,y:impactY,side:p.side,sourceType:p.type});
        if(p.impactEventKind==="rocketBurst")this.events.push({type:"balsamRocketImpact",x:impactX,y:impactY,side:p.side,sourceType:p.type,sourceId:p.owner,burstShot:p.burstIndex||1,burstCount:p.burstCount||4});
        if(p.terrainMiss){this.events.push({type:"dodge",reason:"uphill",side:t?.side??null,x:impactX,y:impactY,sourceSide:p.side,sourceType:p.type,sourceId:p.owner,targetId:p.target});continue}
        const capture={dealt:0,blocked:false};
        if(p.payload)this.landLaunchPayload(p,impactX,impactY);
        if(trajectoryPolicy==="lockedPoint"){
          this.applyAreaDamage({sourceSide:p.side,sourceType:p.type,sourceEntityId:p.owner||null,x:impactX,y:impactY,radius:p.splash||1,damage:p.splashUnitDamage??p.damage,damageClass:p.damageClass||"area",suppressImpactFx:true,sourceDamageResolved:true,sourceFriendlySide:p.sourceFriendlySide});
          for(const b of this.buildings){if(!b||b.alive===false||b.side===p.side)continue;const br=BuildingDefinition.get(b.type)?.size||30;if(Math.hypot(b.x-impactX,b.y-impactY)<=Math.max(1,p.splash||1)+br){this.applyDamage(p.side,p.type,b,true,p.splashBuildingDamage??p.damage,p.owner||null,{damageClass:p.damageClass||"area",sourceDamageResolved:true,sourceFriendlySide:p.sourceFriendlySide,suppressImpactFx:true})}}
        }else if(t&&!p.targetLost)this.applyDamage(p.side,p.type,t,p.isBuilding,p.damage,p.owner||null,{damageClass:p.damageClass||UnitDefinition.damageClass(p.type),capture,sourceDamageResolved:true,sourceFriendlySide:p.sourceFriendlySide});
        if(trajectoryPolicy==="trackingTarget"&&t&&!p.targetLost&&!p.isBuilding){
          if(Number(p.impactKnockbackDistance)>0){
            const attacker={id:p.owner,type:p.type,side:p.side,x:p.launchX,y:p.launchY};
            if(attacker)this.applyKnockback(attacker,t,{distance:Number(p.impactKnockbackDistance),sizeMultiplier:{light:1,medium:.85,heavy:.65},lockTicks:this.msTicks(250)});
            if(p.impactEventKind==="shockwave")this.events.push({type:"impactShockwave",side:p.side,x:t.x,y:t.y,radius:50,sourceType:p.type,sourceId:p.owner});
            if(p.impactEventKind==="retaliation")this.events.push({type:"guardRetaliationImpact",side:p.side,x:t.x,y:t.y,radius:p.splash||50,sourceType:p.type,sourceId:p.owner,targetId:t.id,targetType:t.type});
          }
          if(UnitDefinition.get(p.type)?.abilityImpactKnockback&&p.impactAbility){
            const attacker={id:p.owner,type:p.type,side:p.side,x:p.launchX,y:p.launchY};
            if(attacker)this.applyKnockback(attacker,t,{
              distance:6,roleMultiplier:{charger:1.15},sizeMultiplier:{light:1,medium:.85,heavy:.65},lockTicks:this.msTicks(200)
            });
          }
        }
        // Finish every same-tick impact; step() resolves the final match outcome.
        if(t&&!p.targetLost&&UnitDefinition.get(p.type)?.abilityImpactAreaKnockback&&p.impactAbility){
          const sd=UnitDefinition.get(p.type);
          this.applyAreaKnockback({sourceSide:p.side,sourceType:p.type,sourceEntityId:p.owner,x:t.x,y:t.y,radius:sd.impactKnockbackRadius||82,distance:sd.impactKnockbackDistance||24,lockTicks:this.msTicks(250)});
          this.events.push({type:"impactShockwave",side:p.side,x:t.x,y:t.y,radius:sd.impactKnockbackRadius||82,sourceType:p.type,sourceId:p.owner});
        }
        if(t&&!p.targetLost&&p.splash&&trajectoryPolicy==="trackingTarget"){
          // Splash/폭발은 실제 다중 타격이므로 반드시 범위형 상성을 사용한다.
          // 폭발꽃 특수 연구는 중심부 100 / 중간 75 / 외곽 50%의 계단형 falloff.
          const radial=p.impactAbility?(UnitDefinition.get(p.type)?.abilitySplashFalloff||null):null;
          const ignoreNeutralSplash=!!p.splashIgnoreNeutral;
          const splashScale=Number.isFinite(Number(p.splashScale))?Number(p.splashScale):.55;
          const unitSplashPayload=Math.max(1,Number(p.splashUnitDamage??p.damage)||1);
          const buildingSplashPayload=Math.max(1,Number(p.splashBuildingDamage??p.damage)||1);
          this.withNearbyUnits(t.x,t.y,p.splash+this.maxUnitRadius,indices=>{
            for(const idx of indices){
              const e=this.units[idx];
              if(!e?.alive||e.side===p.side||e.id===t.id)continue;
              if(ignoreNeutralSplash&&e.side===NEUTRAL_SIDE)continue;
              const dd=Math.hypot(e.x-t.x,e.y-t.y);
              if(dd<=p.splash+this.unitRadius(e.type)){
                const scale=radial?this.radialFalloffMultiplier(Math.max(0,dd-this.unitRadius(e.type)),p.splash,radial):splashScale;
                this.applyDamage(p.side,p.type,e,false,Math.max(1,Math.floor(unitSplashPayload*scale)),p.owner||null,{damageClass:"area",sourceDamageResolved:true,sourceFriendlySide:p.sourceFriendlySide});
              }
            }
          });
          if(p.splashBuildings){
            for(const b of this.buildings){
              if(!b||b.alive===false||b.side===p.side||b.id===t.id)continue;
              if(ignoreNeutralSplash&&b.side===NEUTRAL_SIDE)continue;
              const dd=Math.hypot(b.x-t.x,b.y-t.y),br=BuildingDefinition.get(b.type)?.size||30;
              if(dd<=p.splash+br)this.applyDamage(p.side,p.type,b,true,Math.max(1,Math.floor(buildingSplashPayload*splashScale)),p.owner||null,{damageClass:"area",sourceDamageResolved:true,sourceFriendlySide:p.sourceFriendlySide});
            }
          }
        }
        continue
      }
      const travel=Math.min(step,dist),nextX=p.x+dx/dist*travel,nextY=p.y+dy/dist*travel;
      // Launched payloads fly over walls; only the landing point meets terrain.
      if(!p.payload&&!this.navigation.projectileSegmentClear(p.x,p.y,nextX,nextY)){
        p.alive=false;this.events.push({type:"projectileBlocked",projectileId:p.id,x:p.x,y:p.y,side:p.side,sourceType:p.type,sourceId:p.owner});
        this.events.push({type:"projectileRetire",projectileId:p.id,x:p.x,y:p.y,side:p.side,sourceType:p.type});continue;
      }
      p.x=nextX;p.y=nextY;
    }
    this.projectiles=this.projectiles.filter(p=>p.alive);
    return null;
  }
  radiusFP(u){return UNIT_RUNTIME_GEOMETRY[u.type]?.radiusFP||FP}
  mass(u){return UNIT_RUNTIME_GEOMETRY[u.type]?.mass||100}
  fallbackNormal(a,b){
    const ds=[[COLLISION_NORMAL,0],[2896,2896],[0,COLLISION_NORMAL],[-2896,2896],[-COLLISION_NORMAL,0],[-2896,-2896],[0,-COLLISION_NORMAL],[2896,-2896]];
    const ai=String(a?.id||""),bi=String(b?.id||""),lo=ai<bi?ai:bi,hi=ai<bi?bi:ai,v=ds[HashUtil.hash(lo+"|"+hi)&7];
    return ai===lo?v:[-v[0],-v[1]];
  }
  resolveNonAlliedSurfaceMotion(startFx,startFy,radii,maxRadius,maxPasses=4){
    const units=this.units,n=units.length;
    if(!n)return 0;
    const perf=this._perfCollect;if(perf)perf.collisionSweptCalls++;
    this.ensureCollisionBuffers(n);
    const segX=this.collisionSegmentFx,segY=this.collisionSegmentFy;
    const nextX=this.collisionNextFx,nextY=this.collisionNextFy;
    const bestT=this.collisionBestT,bestNx=this.collisionBestNx,bestNy=this.collisionBestNy,bestOther=this.collisionBestOther;
    const grid=this.collisionGrid,buckets=grid.buckets,cols=grid.cols;
    const motion=this.collisionMotion,{flags,layers}=motion;
    const layerRadii=new Map();

    for(let i=0;i<n;i++){
      const u=units[i];
      segX[i]=i<startFx.length?startFx[i]:(u?.fx??0);
      segY[i]=i<startFy.length?startFy[i]:(u?.fy??0);
      // Capabilities/layers do not change during a contact sweep. Positions do.
      flags[i]=(!!u?.capability(BurrowableMixin.KEY)?.isActive()?1:0)|(!!u?.capability(LeapableMixin.KEY)?.isActive(this)?2:0)|(u?.objectiveChargeActive?4:0);
      layers[i]=this.unitLayer(u?.type);
      if(u?.alive&&radii[i]>0&&!flags[i])layerRadii.set(layers[i],Math.max(layerRadii.get(layers[i])||0,radii[i]));
    }

    let totalCorrections=0;
    for(let pass=0;pass<maxPasses;pass++){
      bestT.fill(Infinity,0,n);bestOther.fill(-1,0,n);
      const layerTravel=new Map();let anyMotion=false;
      for(let i=0;i<n;i++){
        const u=units[i];if(!u?.alive)continue;
        motion.sx[i]=segX[i]/FP;motion.sy[i]=segY[i]/FP;motion.ex[i]=u.fx/FP;motion.ey[i]=u.fy/FP;
        motion.vx[i]=motion.ex[i]-motion.sx[i];motion.vy[i]=motion.ey[i]-motion.sy[i];
        if(radii[i]>0&&!flags[i]){
          const travel=Math.ceil(Math.hypot(u.fx-segX[i],u.fy-segY[i]));
          if(travel)anyMotion=true;layerTravel.set(layers[i],Math.max(layerTravel.get(layers[i])||0,travel));
        }
      }
      if(!anyMotion){if(perf)perf.collisionSweptZeroMotionCalls++;break} // Every relative cast would reject zero motion.
      if(perf)perf.collisionSweptActivePasses++;
      grid.reset(units);
      this.collisionSweepGrid.reset(units,motion,radii,segX,segY,grid);
      let pairContacts=0;
      for(let i=0;i<n;i++){
        const a=units[i];
        if(!a?.alive||radii[i]<=0||flags[i]||!layerTravel.get(layers[i]))continue;
        const sx=segX[i],sy=segY[i],ex=a.fx,ey=a.fy;
        const reach=radii[i]+layerRadii.get(layers[i])+layerTravel.get(layers[i]);
        const minCx=grid.cellXFP(Math.min(sx,ex)-reach),maxCx=grid.cellXFP(Math.max(sx,ex)+reach);
        const minCy=grid.cellYFP(Math.min(sy,ey)-reach),maxCy=grid.cellYFP(Math.max(sy,ey)+reach);
        const candidates=this.collisionSweepGrid.query(i,grid,minCx,maxCx,minCy,maxCy,a.side);
        if(perf)perf.collisionSweptPairTests+=candidates.length;
        for(const j of candidates){
            const b=units[j];
            if(!b?.alive||radii[j]<=0||flags[j]||layers[i]!==layers[j]||this.isAlliedCollisionUnit(a,b))continue;
            // Keep the original floating-point subtraction order. Equal relative
            // motion has no inward contact, including a stationary overlap.
            const vx=motion.vx[i]-motion.vx[j],vy=motion.vy[i]-motion.vy[j];
            if(vx===0&&vy===0)continue;
            const hit=SweptCircleContact.cast(motion.sx[i]-motion.sx[j],motion.sy[i]-motion.sy[j],vx,vy,(radii[i]+radii[j])/FP,SweptCircleContact.policies.relative,()=>{const v=this.fallbackNormal(a,b);return{x:v[0]/COLLISION_NORMAL,y:v[1]/COLLISION_NORMAL}});
            if(!hit)continue;
            if(perf)perf.collisionSweptHits++;
            pairContacts++;

            if(hit.t<bestT[i]-1e-9||(Math.abs(hit.t-bestT[i])<=1e-9&&(bestOther[i]<0||j<bestOther[i]))){
              bestT[i]=hit.t;bestNx[i]=hit.nx;bestNy[i]=hit.ny;bestOther[i]=j;
            }
            if(hit.t<bestT[j]-1e-9||(Math.abs(hit.t-bestT[j])<=1e-9&&(bestOther[j]<0||i<bestOther[j]))){
              bestT[j]=hit.t;bestNx[j]=-hit.nx;bestNy[j]=-hit.ny;bestOther[j]=i;
            }
        }
      }
      if(!pairContacts){if(perf)perf.collisionSweptEmptyPasses++;break}

      let corrected=0;
      for(let i=0;i<n;i++){
        const u=units[i];nextX[i]=u?.fx??0;nextY[i]=u?.fy??0;
        const other=bestOther[i];if(!u?.alive||other<0)continue;
        const sx=segX[i]/FP,sy=segY[i]/FP,ex=u.fx/FP,ey=u.fy/FP;
        const dx=ex-sx,dy=ey-sy,len=Math.hypot(dx,dy);
        if(len<.000001){segX[i]=u.fx;segY[i]=u.fy;continue}

        const q=RangeUtil.clamp(bestT[i],0,1),cx=sx+dx*q,cy=sy+dy*q,leftLen=len*(1-q);
        let goalX=dx,goalY=dy;
        if(u.collisionIntentTick===this.tick){
          goalX=(Number(u.collisionIntentTx)||0)-cx;goalY=(Number(u.collisionIntentTy)||0)-cy;
        }
        const slide=SurfaceContactGeometry.slide(dx*(1-q),dy*(1-q),[{nx:bestNx[i],ny:bestNy[i],key:'solid:'+other}],leftLen,{steer:true,
          goalX,goalY,tieKey:`solid|${u.id}|${units[other]?.id||other}`
        });
        const ur=radii[i]||this.radiusFP(u);
        nextX[i]=RangeUtil.clamp(Math.round((cx+slide.x)*FP),ur,this.world.width*FP-ur);
        nextY[i]=RangeUtil.clamp(Math.round((cy+slide.y)*FP),ur,this.world.height*FP-ur);

        // Next pass starts at this contact point, not at tick start. This preserves
        // the actual piecewise path and catches second/third obstacles on the tangent.
        segX[i]=Math.round(cx*FP);segY[i]=Math.round(cy*FP);
        if(nextX[i]!==u.fx||nextY[i]!==u.fy)corrected++;
      }

      // Units without a contact have consumed their entire segment and are stationary
      // for later sub-passes; units with a contact continue from their contact point.
      for(let i=0;i<n;i++){
        const u=units[i];if(!u?.alive)continue;
        if(bestOther[i]<0){segX[i]=u.fx;segY[i]=u.fy;continue}
        u.fx=nextX[i];u.fy=nextY[i];u.x=u.fx/FP;u.y=u.fy/FP;
        this.navigation.motion.constrain(u);
      }
      totalCorrections+=corrected;
      if(perf){perf.collisionSweptCorrectionUnits+=corrected;if(!corrected)perf.collisionSweptNoCorrectionPasses++}
      if(!corrected)break;
    }
    return totalCorrections;
  }

  resolveSolidEmergence(source){
    if(!source?.alive||this.unitLayer(source.type)!=="GROUND")return 0;
    const sourceRadius=this.radiusFP(source),reach=(sourceRadius+this.maxUnitRadius+2*FP)/FP;
    const candidates=[];
    for(const idx of this.nearbyUnits(source.x,source.y,reach)){
      const other=this.units[idx];
      if(!other?.alive||other.id===source.id||this.isAlliedCollisionUnit(source,other)||this.unitLayer(other.type)!=="GROUND")continue;
      if(!!other?.capability(BurrowableMixin.KEY)?.isActive()||!!other?.capability(LeapableMixin.KEY)?.isActive(this)||other.objectiveChargeActive)continue;
      candidates.push(idx);
    }
    candidates.sort((ia,ib)=>String(this.units[ia]?.id||"").localeCompare(String(this.units[ib]?.id||""))||ia-ib);
    let moved=0;
    for(const idx of candidates){
      const other=this.units[idx],otherRadius=this.radiusFP(other),min=sourceRadius+otherRadius+1;
      let dx=other.fx-source.fx,dy=other.fy-source.fy,d2=dx*dx+dy*dy;
      if(d2>=min*min)continue;
      let nx,ny,dist;
      if(d2===0){const f=this.fallbackNormal(source,other);nx=f[0];ny=f[1];dist=0}
      else{dist=Math.max(1,Math.floor(Math.sqrt(d2)));nx=Math.trunc(dx*COLLISION_NORMAL/dist);ny=Math.trunc(dy*COLLISION_NORMAL/dist)}
      const penetration=min-dist;
      other.fx=RangeUtil.clamp(other.fx+Math.trunc(nx*penetration/COLLISION_NORMAL),otherRadius,this.world.width*FP-otherRadius);
      other.fy=RangeUtil.clamp(other.fy+Math.trunc(ny*penetration/COLLISION_NORMAL),otherRadius,this.world.height*FP-otherRadius);
      other.x=other.fx/FP;other.y=other.fy/FP;this.syncUnitSpatial(other);moved++;
    }
    return moved;
  }

  nonAlliedPenetrationOwner(ai,bi){
    const units=this.units,a=units[ai],b=units[bi];
    if(a.side===NEUTRAL_SIDE&&b.side!==NEUTRAL_SIDE)return bi;
    if(b.side===NEUTRAL_SIDE&&a.side!==NEUTRAL_SIDE)return ai;

    // Cross-team crowd pressure never transfers through the contact.
    // Recovery moves the unit whose own motion entered the opposing solid.
    const asx=this.collisionStartFx[ai],asy=this.collisionStartFy[ai];
    const bsx=this.collisionStartFx[bi],bsy=this.collisionStartFy[bi];
    let dx=bsx-asx,dy=bsy-asy;
    if(dx===0&&dy===0){const f=this.fallbackNormal(a,b);dx=f[0];dy=f[1]}
    const avx=a.fx-asx,avy=a.fy-asy,bvx=b.fx-bsx,bvy=b.fy-bsy;
    const approachA=avx*dx+avy*dy;
    const approachB=-(bvx*dx+bvy*dy);
    if(approachA>approachB)return ai;
    if(approachB>approachA)return bi;

    const moveA=avx*avx+avy*avy,moveB=bvx*bvx+bvy*bvy;
    if(moveA>moveB)return ai;
    if(moveB>moveA)return bi;

    // Exact ties are deterministic only; they do not transmit displacement to the other unit.
    return String(a.id||"")<=String(b.id||"")?ai:bi;
  }

  enforceNonAlliedNoOverlap(radii,maxRadius,maxPasses=4){
    const units=this.units,n=units.length;
    let total=0;
    const perf=this._perfCollect;if(perf)perf.collisionHardFixCalls++;
    for(let pass=0;pass<maxPasses;pass++){
      if(perf)perf.collisionHardFixPasses++;
      for(let i=0;i<n;i++){const u=units[i];this.collisionSegmentFx[i]=u?.fx??0;this.collisionSegmentFy[i]=u?.fy??0}
      const eligible=this.hardFixSapEligible;eligible.length=0;
      let sx=0,sy=0,sxx=0,syy=0;
      for(let i=0;i<n;i++){
        const u=units[i];
        if(!u?.alive||radii[i]<=0||!!u?.capability(BurrowableMixin.KEY)?.isActive()||!!u?.capability(LeapableMixin.KEY)?.isActive(this)||u.objectiveChargeActive||this.unitLayer(u.type)==="AIR")continue;
        eligible.push(i);sx+=u.fx;sy+=u.fy;sxx+=u.fx*u.fx;syy+=u.fy*u.fy;
      }
      const count=eligible.length||1,vx=Math.max(0,sxx/count-(sx/count)*(sx/count)),vy=Math.max(0,syy/count-(sy/count)*(sy/count));
      let axis=this.hardFixSapAxis||"x";
      const current=axis==="x"?vx:vy,other=axis==="x"?vy:vx;
      // 25% hysteresis prevents near-equal diagonal distributions from throwing away
      // the temporally coherent ordering for a marginal variance difference.
      if(other>current*1.25)axis=axis==="x"?"y":"x";
      const axisChanged=axis!==this.hardFixSapAxis;
      this.hardFixSapAxis=axis;
      const coord=i=>axis==="x"?units[i].fx:units[i].fy;
      const otherCoord=i=>axis==="x"?units[i].fy:units[i].fx;
      if(this.hardFixSapMarks.length<n)this.hardFixSapMarks=new Uint32Array(Math.max(n,this.collisionRadii.length||n));
      let epoch=(this.hardFixSapEpoch+2)>>>0;if(epoch<2){this.hardFixSapMarks.fill(0);epoch=2}this.hardFixSapEpoch=epoch;
      const marks=this.hardFixSapMarks;
      for(const i of eligible)marks[i]=epoch;
      let order=this.hardFixSapWorkOrder;order.length=0;
      if(!axisChanged&&this.hardFixSapOrder.length){
        for(const i of this.hardFixSapOrder)if(marks[i]===epoch){order.push(i);marks[i]=epoch+1}
        for(const i of eligible)if(marks[i]===epoch)order.push(i);
        for(let i=1;i<order.length;i++){
          const cur=order[i],key=coord(cur)-radii[cur];let j=i-1;
          while(j>=0){
            const prev=order[j],pk=coord(prev)-radii[prev];
            if(pk<key||(pk===key&&prev<cur))break;
            order[j+1]=prev;j--;
          }
          order[j+1]=cur;
        }
      }else{
        for(const i of eligible)order.push(i);
        order.sort((ia,ib)=>(coord(ia)-radii[ia])-(coord(ib)-radii[ib])||ia-ib);
      }
      const saved=this.hardFixSapOrder;saved.length=order.length;for(let q=0;q<order.length;q++)saved[q]=order[q];
      const pairs=this.hardFixSapPairs;pairs.length=0;
      if(this.hardFixSapSideNext.length<n){this.hardFixSapSideNext=new Int32Array(n);this.hardFixSapSidePrev=new Int32Array(n)}
      const heads=this.hardFixSapSideHeads,next=this.hardFixSapSideNext,prev=this.hardFixSapSidePrev,heaps=this.hardFixSapSideHeaps;
      heads.fill(-1);for(const heap of heaps)heap.length=0;
      const heapLess=(ia,ib)=>{const ea=coord(ia)+radii[ia],eb=coord(ib)+radii[ib];return ea<eb||(ea===eb&&ia<ib)};
      const heapPush=(heap,value)=>{
        let i=heap.length;heap.push(value);
        while(i>0){const p=(i-1)>>1;if(!heapLess(value,heap[p]))break;heap[i]=heap[p];i=p}
        heap[i]=value;
      };
      const heapPop=heap=>{
        const root=heap[0],last=heap.pop();
        if(heap.length){let i=0;while(true){const left=i*2+1;if(left>=heap.length)break;const right=left+1,child=right<heap.length&&heapLess(heap[right],heap[left])?right:left;if(!heapLess(heap[child],last))break;heap[i]=heap[child];i=child}heap[i]=last}
        return root;
      };
      const sideIndex=side=>side===0?0:side===1?1:2;
      const unlink=(group,index)=>{
        const p=prev[index],q=next[index];
        if(p>=0)next[p]=q;else heads[group]=q;
        if(q>=0)prev[q]=p;
        prev[index]=next[index]=-1;
      };
      for(const bi of order){
        const minB=coord(bi)-radii[bi],biGroup=sideIndex(units[bi].side);
        for(let group=0;group<3;group++){
          // Player units on the same side are always allied; neutral/other-side
          // units retain the existing isAlliedCollisionUnit semantics.
          if(group===biGroup&&biGroup!==2)continue;
          const heap=heaps[group];
          while(heap.length&&coord(heap[0])+radii[heap[0]]<minB)unlink(group,heapPop(heap));
          for(let ai=heads[group];ai>=0;ai=next[ai]){
            if(perf)perf.collisionHardFixActivePairTests++;
            const a=units[ai],bb=units[bi];
            if(this.isAlliedCollisionUnit(a,bb)||this.unitLayer(a.type)!==this.unitLayer(bb.type))continue;
            const min=radii[ai]+radii[bi];
            if(Math.abs(otherCoord(ai)-otherCoord(bi))>=min)continue;
            if(perf)perf.collisionHardFixCandidates++;
            const owner=this.nonAlliedPenetrationOwner(ai,bi);
            pairs.push(owner*(n+1)+(owner===ai?bi:ai));
          }
        }
        const groupHeap=heaps[biGroup],head=heads[biGroup];
        prev[bi]=-1;next[bi]=head;if(head>=0)prev[head]=bi;heads[biGroup]=bi;
        heapPush(groupHeap,bi);
      }
      pairs.sort((a,b)=>a-b);
      let changed=0;
      const pairBase=n+1;
      for(let q=0;q<pairs.length;q++){const packed=pairs[q],i=Math.floor(packed/pairBase),j=packed-i*pairBase;
        const u=units[i],o=units[j],ox=this.collisionSegmentFx[j],oy=this.collisionSegmentFy[j];
        const min=radii[i]+radii[j],dx=u.fx-ox,dy=u.fy-oy,d2=dx*dx+dy*dy;
        if(d2>=min*min)continue;
        let nx,ny,dist;
        if(d2===0){const f=this.fallbackNormal(u,o);nx=f[0];ny=f[1];dist=0}
        else{dist=Math.max(1,Math.floor(Math.sqrt(d2)));nx=Math.trunc(dx*COLLISION_NORMAL/dist);ny=Math.trunc(dy*COLLISION_NORMAL/dist)}
        const pen=min-dist+1,ur=radii[i];
        u.fx=RangeUtil.clamp(u.fx+Math.trunc(nx*pen/COLLISION_NORMAL),ur,this.world.width*FP-ur);
        u.fy=RangeUtil.clamp(u.fy+Math.trunc(ny*pen/COLLISION_NORMAL),ur,this.world.height*FP-ur);
        u.x=u.fx/FP;u.y=u.fy/FP;changed++;total++;
      }
      if(!changed)break;
    }
    return total;
  }

  resetTerrainMotionOrigin(u){
    this.navigation.motion.remember(u,false);
    const i=this.unitIndexById.get(u.id);
    if(i!=null&&i<this.collisionStartCount){this.collisionStartFx[i]=u.fx;this.collisionStartFy[i]=u.fy}
  }
  constrainSurfaceContacts(){
    let changed=0;
    for(const u of this.units)if(u?.alive&&this.navigation.motion.constrain(u))changed++;
    return changed;
  }
  resolveAlliedSoftSeparation(radii,maxRadius){
    const units=this.units,n=units.length;
    if(!n)return 0;
    const perf=this._perfCollect,now=perf?()=>performance.now():null;
    const grid=this.collisionGrid,candidates=this.collisionCandidateBuffer;
    const masses=this.collisionMasses;
    const dxA=this.collisionDx,dyA=this.collisionDy,cnt=this.collisionCnt;
    const motionFlags=this.collisionMotion.flags,motionLayers=this.collisionMotion.layers;
    let mark=perf?now():0;
    grid.reset(units,maxRadius);
    dxA.fill(0,0,n);dyA.fill(0,0,n);cnt.fill(0,0,n);
    for(let i=0;i<n;i++){
      const u=units[i];this.collisionSegmentFx[i]=u?.fx??0;this.collisionSegmentFy[i]=u?.fy??0;
    }
    if(perf){perf.collisionGridBuildMs+=now()-mark;perf.collisionSoftPasses++}

    mark=perf?now():0;
    for(let i=0;i<n;i++){
      const a=units[i];if(!a?.alive||radii[i]<=0)continue;
      const aFlags=motionFlags[i],aLayer=motionLayers[i];
      grid.queryCandidatesFP(a.fx,a.fy,radii[i],candidates);
      for(let k=0;k<candidates.length;k++){
        const j=candidates[k];if(j<=i)continue;
        const b=units[j];if(radii[j]<=0)continue;
        const bFlags=motionFlags[j];
        if(!b?.alive||(aFlags&1)!==(bFlags&1)||(aFlags&6)||(bFlags&6)||aLayer!==motionLayers[j])continue;
        if(perf)perf.collisionPairs++;
        if(!this.isAlliedCollisionUnit(a,b))continue;
        const min=radii[i]+radii[j];
        let dx=b.fx-a.fx,dy=b.fy-a.fy;const d2=dx*dx+dy*dy;
        if(d2>=min*min)continue;
        let nx,ny,dist;
        if(d2===0){[nx,ny]=this.fallbackNormal(a,b);dist=0}
        else{dist=Math.max(1,Math.floor(Math.sqrt(d2)));nx=Math.trunc(dx*COLLISION_NORMAL/dist);ny=Math.trunc(dy*COLLISION_NORMAL/dist)}
        const pen=min-dist;if(pen<=0)continue;
        const softPen=Math.max(1,Math.trunc(pen*ALLY_SOFT_CORRECTION_FRACTION));
        const ma=masses[i],mb=masses[j],total=Math.max(1,ma+mb);
        const pa=Math.trunc(softPen*mb/total),pb=softPen-pa;
        dxA[i]-=Math.trunc(nx*pa/COLLISION_NORMAL);dyA[i]-=Math.trunc(ny*pa/COLLISION_NORMAL);
        dxA[j]+=Math.trunc(nx*pb/COLLISION_NORMAL);dyA[j]+=Math.trunc(ny*pb/COLLISION_NORMAL);
        cnt[i]++;cnt[j]++;
        if(perf){perf.collisionSoftContacts++;perf.collisionOverlaps++}
      }
    }
    if(perf)perf.collisionPairScanMs+=now()-mark;

    mark=perf?now():0;
    let moved=0,capped=0;
    for(let i=0;i<n;i++){
      const u=units[i];if(!u?.alive||!cnt[i])continue;
      let cx=Math.trunc(dxA[i]/cnt[i]),cy=Math.trunc(dyA[i]/cnt[i]);
      const radius=radii[i],speed=Math.max(0,Number(UnitDefinition.get(u.type)?.speed)||0);
      const idleAllowance=Math.round(radius*ALLY_SOFT_IDLE_RADIUS_FRACTION);
      const speedAllowance=Math.round(speed/this.tps*FP*ALLY_SOFT_SPEED_FRACTION);
      const maxCorrection=Math.max(1,Math.min(Math.round(radius*ALLY_SOFT_MAX_RADIUS_FRACTION),Math.max(idleAllowance,speedAllowance)));
      const len2=cx*cx+cy*cy;
      if(len2>maxCorrection*maxCorrection){
        const len=Math.max(1,Math.sqrt(len2)),scale=maxCorrection/len;
        cx=Math.trunc(cx*scale);cy=Math.trunc(cy*scale);capped++;
      }
      if(cx===0&&cy===0)continue;
      const oldFx=u.fx,oldFy=u.fy;
      u.fx=RangeUtil.clamp(u.fx+cx,radius,this.world.width*FP-radius);
      u.fy=RangeUtil.clamp(u.fy+cy,radius,this.world.height*FP-radius);
      u.x=u.fx/FP;u.y=u.fy/FP;
      if(u.fx!==oldFx||u.fy!==oldFy)moved++;
    }
    if(perf){perf.collisionSoftApplyMs+=now()-mark;perf.collisionSoftMovedUnits=moved;perf.collisionSoftCappedUnits=capped}
    return moved;
  }
  solveContacts(){
    const units=this.units,n=units.length;
    if(!n)return;
    const perf=this._perfCollect,now=perf?()=>performance.now():null;
    let mark=perf?now():0;
    this.constrainSurfaceContacts();

    this.ensureCollisionBuffers(n);
    const radii=this.collisionRadii,masses=this.collisionMasses;
    let maxRadius=FP;
    for(let i=0;i<n;i++){
      const u=units[i],ud=UnitDefinition.get(u.type);
      if(!u.alive||ud?.crowdCollision===false||!!u?.capability(LeapableMixin.KEY)?.isActive(this)||u.objectiveChargeActive){radii[i]=0;masses[i]=0;continue}
      radii[i]=this.radiusFP(u);masses[i]=this.mass(u);
      if(radii[i]>maxRadius)maxRadius=radii[i];
    }
    if(perf)perf.collisionPrepMs+=now()-mark;

    // Keep the full movement/impulse sweep for hostile nonpenetration and tangent sliding.
    mark=perf?now():0;
    this.resolveNonAlliedSurfaceMotion(this.collisionStartFx,this.collisionStartFy,radii,maxRadius,4);
    if(perf)perf.collisionSweptMotionMs+=now()-mark;

    // One Jacobi-style ally pass per tick. It also nudges idle and in-range attackers,
    // but correction is deliberately softer and bounded by radius and normal tick speed.
    const softMoved=this.resolveAlliedSoftSeparation(radii,maxRadius);
    if(softMoved){
      // Keep the one-pass nudge from crossing a hostile solid or a terrain boundary.
      mark=perf?now():0;
      this.resolveNonAlliedSurfaceMotion(this.collisionSegmentFx,this.collisionSegmentFy,radii,maxRadius,3);
      if(perf)perf.collisionSweptMotionMs+=now()-mark;
      mark=perf?now():0;
      const surfaceCorrections=this.constrainSurfaceContacts();
      if(perf){perf.collisionTerrainMs+=now()-mark;perf.collisionOverlaps+=surfaceCorrections}
    }

    // This single final SAP call retains zero-motion hostile overlap recovery. It is
    // no longer repeated once per allied convergence iteration.
    mark=perf?now():0;
    const hardFixes=this.enforceNonAlliedNoOverlap(radii,maxRadius,4);
    if(perf){perf.collisionHardFixMs+=now()-mark;perf.collisionHardFixCorrections+=hardFixes;if(!hardFixes)perf.collisionHardFixNoOpCalls++}
    if(hardFixes){
      if(perf)perf.collisionOverlaps+=hardFixes;
      for(let i=0;i<n;i++)if(units[i]?.alive)this.syncUnitSpatial(units[i]);
      mark=perf?now():0;
      this.constrainSurfaceContacts();
      if(perf)perf.collisionTerrainMs+=now()-mark;
    }
  }

  updateBalanceTelemetry(winner=null){
    const b=this.balanceStats||(this.balanceStats=PerformanceTelemetry.createLocalBalanceStats());

    // Events are presentation/runtime data, not exported authoritative state. Consume them
    // once here to build local match diagnostics without influencing any gameplay decision.
    for(const e of this.events){
      const side=Number(e?.side);
      if(e?.type==="income"&&(side===0||side===1)){
        const amount=Math.max(0,Number(e.amount)||0);
        if(e.resourceType==="gas"||e.reason==="gas")b.gasIncome[side]+=amount;
        else b.mineralIncome[side]+=amount;
      }else if(e?.type==="productionExhausted"&&(side===0||side===1)){
        b.productionExhausted[side]++;
      }else if(e?.type==="captureComplete"&&(side===0||side===1)){
        b.captures[side]++;
        if(b.firstCaptureTick[side]==null)b.firstCaptureTick[side]=this.tick;
      }else if(e?.type==="buildingDeath"&&(side===0||side===1)&&e.cause!=="production-exhausted"){
        b.buildingLosses[side]++;
        if(e.isOutpost)b.outpostLosses[side]++;
      }else if(
        e?.type==="hit"&&
        (e.sourceSide===0||e.sourceSide===1)&&
        (side===0||side===1)&&
        e.sourceSide!==side&&
        b.firstCombatTick==null
      ){
        b.firstCombatTick=this.tick;
      }
    }

    if(winner&&b.gameEndTick==null){
      b.gameEndTick=this.tick;
      b.winner=winner;
    }

    if(this.tick%this.msTicks(BALANCE_SAMPLE_EVERY_MS)!==0)return;

    const army=[0,0],air=[0,0],antiAir=[0,0];
    for(const u of this.units){
      if(!u?.alive||(u.side!==0&&u.side!==1)||UnitDefinition.get(u.type)?.economyWorker)continue;
      const d=UnitDefinition.get(u.type);
      // Temporary summons and carrier mites still count as real battlefield bodies; this
      // makes the metric describe actual screen pressure rather than only paid supply.
      army[u.side]++;
      if(this.unitLayer(u.type)==="AIR")air[u.side]++;
      if(d?.canAttackAir)antiAir[u.side]++;
      if(d?.tier===2&&b.firstTier2UnitTick[u.side]==null)b.firstTier2UnitTick[u.side]=this.tick;
      if(d?.tier===3&&b.firstTier3UnitTick[u.side]==null)b.firstTier3UnitTick[u.side]=this.tick;
    }

    for(const side of [0,1]){
      if(this.tech[side]>=2&&b.firstTech2Tick[side]==null)b.firstTech2Tick[side]=this.tick;
      if(this.tech[side]>=3&&b.firstTech3Tick[side]==null)b.firstTech3Tick[side]=this.tick;
      b.currentArmy[side]=army[side];
      b.currentAir[side]=air[side];
      b.currentAntiAir[side]=antiAir[side];
      b.armyTotal[side]+=army[side];
      b.armyPeak[side]=Math.max(b.armyPeak[side],army[side]);
    }
    b.samples++;
    b.lastSampleTick=this.tick;

    if(this.tick%SimulationTiming.msToTicks(BALANCE_HISTORY_EVERY_MS,this.tps)===0){
      b.history.push({
        tick:this.tick,tps:this.tps,
        wallet:this.wallet.slice(),gasWallet:this.gasWallet.slice(),
        mineralIncome:b.mineralIncome.slice(),gasIncome:b.gasIncome.slice(),
        army:army.slice(),air:air.slice(),antiAir:antiAir.slice(),
        productionExhausted:b.productionExhausted.slice(),captures:b.captures.slice()
      });
      if(b.history.length>BALANCE_HISTORY_MAX)b.history.splice(0,b.history.length-BALANCE_HISTORY_MAX);
    }
  }

  cleanupDeadEntities(){
    // Death information is already emitted as an event in the death tick.
    // Keeping every corpse forever makes target scans, snapshots and checksums grow without bound.
    if(this.tick%this.msTicks(DEAD_ENTITY_CLEANUP_MS)!==0)return;

    // Target-bound delayed effects are weak references. Positional delayed effects remain
    // valid after their source dies; a delayed second projectile requires both endpoints.
    if(this.delayedEffects?.length){
      this.delayedEffects=this.delayedEffects.filter(fx=>{
        if(!fx||typeof fx!=="object"||!fx.kind)return false;
        if(fx.kind!=="burstProjectile"&&fx.kind!=="patternProjectile")return true;
        return !!this.liveEntityRefById(fx.sourceId,"unit")&&!!this.liveEntityRefById(fx.targetId);
      });
    }

    this.units=this.units.filter(u=>u.alive);

    // Destroyed ordinary buildings no longer participate in any simulation.
    // Base death ends the match before this matters; outpost capture state is released on death.
    const beforeBuildings=this.buildings.length;
    this.buildings=this.buildings.filter(b=>b.alive!==false);
    if(this.buildings.length!==beforeBuildings)this.markBuildingSpatialDirty();
  }

  step(){
    if(this.disposed)throw new Error("종료된 StrategySim은 다시 진행할 수 없습니다.");
    const started=typeof performance!=="undefined"?performance.now():null;
    AdaptiveNavigationDemand.begin(this);
    try{return this.stepSimulation()}finally{
      AdaptiveNavigationDemand.end(this);
      // Coarse timing covers every tick, including one-off commands and cold paths.
      // The detailed stage/candidate counters below remain sampled once per second.
      if(started!==null){
        const ms=performance.now()-started,p=this.perfStats;
        p.lastStepMs=ms;p.stepSamples=(p.stepSamples||0)+1;p.stepCumulativeMs=(p.stepCumulativeMs||0)+ms;p.maxStepMs=Math.max(p.maxStepMs||0,ms);
        p.ewmaStepMs=p.stepSamples>1?p.ewmaStepMs*.8+ms*.2:ms;
      }
    }
  }
  stepSimulation(){
    const profile=((this.tick+1)%this.msTicks(PERF_SAMPLE_EVERY_MS)===0)&&typeof performance!=="undefined";
    const now=profile?()=>performance.now():null;
    const stepStart=profile?now():0;
    this._perfCollect=profile?{spatialQueries:0,spatialCandidates:0,targetQueries:0,targetVisibilityRejects:0,sideSpatialQueries:0,visibilityChecks:0,
      collisionPairs:0,collisionOverlaps:0,collisionSoftPasses:0,collisionSoftContacts:0,collisionSoftMovedUnits:0,collisionSoftCappedUnits:0,buildingCollisionCandidates:0,collisionPrepMs:0,collisionGridBuildMs:0,collisionPairScanMs:0,collisionSoftApplyMs:0,collisionSweptMotionMs:0,collisionTerrainMs:0,collisionHardFixMs:0,
      collisionSweptCalls:0,collisionSweptActivePasses:0,collisionSweptZeroMotionCalls:0,collisionSweptEmptyPasses:0,collisionSweptPairTests:0,collisionSweptHits:0,collisionSweptCorrectionUnits:0,collisionSweptNoCorrectionPasses:0,
      collisionHardFixCalls:0,collisionHardFixPasses:0,collisionHardFixActivePairTests:0,collisionHardFixCandidates:0,collisionHardFixCorrections:0,collisionHardFixNoOpCalls:0,combatTargetPickMs:0,combatTargetPickCalls:0}:null;

    this.tick++;
    this.events=[];
    this.campaignScriptRuntime?.tick();

    const cmds=this.scheduled.get(this.tick)||[];
    for(const c of cmds){
      const applied=this.applyCommand(c.actor,c.action)===true;
      this.commandReceipts.push({seq:c.seq,netcodeSequence:c.netcodeSequence,actor:c.actor,tick:this.tick,type:c.action.type,key:StableSerializationUtil.stableStringify(c.action),applied});
      if(this.commandReceipts.length>512)this.commandReceipts.shift();
    }
    this.scheduled.delete(this.tick);

    let mark=profile?now():0;
    // One O(N) rebuild per tick replaces many O(N) target/id scans below.
    this.rebuildRuntimeIndexes();
    const indexMs=profile?now()-mark:0;

    mark=profile?now():0;
    this.updateBuildings();
    this.updateResearchQueues();
    this.updateCamps();
    this.updateCapturePoints();
    this.updateLaunchEconomy();
    let winner=this.updateActiveSpells();
    winner=this.updateDelayedEffects()||winner;
    const worldMs=profile?now()-mark:0;

    mark=profile?now():0;
    // One worker grouping/rank pass per tick replaces O(W² log W) gas assignment.
    this.prepareEconomyCaches();
    const economyMs=profile?now()-mark:0;

    // Collision motion origin: spells/world-state changes above are already authoritative
    // placement. Worker/combat/impulse movement below is the motion that solid contacts clip.
    this.captureCollisionStepStarts();

    mark=profile?now():0;
    for(const u of this.units){
      if(u.alive&&u.expireTick&&this.tick>=u.expireTick){
        u.alive=false;
        this.events.push({type:"sporeFade",side:u.side,x:u.x,y:u.y,entity:u.type});
      }
      if(u.alive)this.updateUnitMana(u);
      if(u.alive&&!!UnitDefinition.get(u.type)?.economyWorker)this.updateWorker(u);
    }
    const workerMs=profile?now()-mark:0;

    mark=profile?now():0;
    this.updateChargedCasts();
    const vision=[this.visionSources(0),this.visionSources(1)];
    const visionMs=profile?now()-mark:0;

    mark=profile?now():0;
    for(const u of this.units){
      if(!u.alive||!!UnitDefinition.get(u.type)?.economyWorker)continue;
      if(this.chargedUnitHeld(u)||u.capability(ChargedSkillMixin.KEY)?.update(this))continue;
      winner=u.logicController.update(this,vision)||winner;
    }
    const combatMs=profile?now()-mark:0;

    // Hook/knock-style external forces are resolved as deterministic velocity impulses
    // after normal unit intent, then one bounded ally pass and hostile safety solve run.
    this.updateUnitImpulses();

    mark=profile?now():0;
    winner=this.updateProjectiles()||winner;
    const projectileMs=profile?now()-mark:0;

    mark=profile?now():0;
    this.solveContacts();

    const collisionMs=profile?now()-mark:0;

    mark=profile?now():0;
    this.updateCamps();
    this.campaignScriptRuntime?.postStep();
    // Combat damage reports are not mission victory authority. Resolve once from the
    // final world state, using mission policy or the unchanged ordinary base rule.
    winner=this.netcodeMatchResult?.winner||CampaignOutcomeRules.resolve(this)?.winner||null;
    this.updateBalanceTelemetry(winner);
    this.cleanupDeadEntities();
    this.collectUnusedRoutePaths();
    const postMs=profile?now()-mark:0;

    if(profile){
      const total=now()-stepStart,p=this.perfStats,c=this._perfCollect;
      let aliveUnits=0,workers=0,combatUnits=0;
      for(const u of this.units)if(u.alive){aliveUnits++;if(!!UnitDefinition.get(u.type)?.economyWorker)workers++;else combatUnits++}
      p.sampleTick=this.tick;p.totalMs=total;p.indexMs=indexMs;p.worldMs=worldMs;p.economyMs=economyMs;p.workerMs=workerMs;p.visionMs=visionMs;
      p.combatMs=combatMs;p.projectileMs=projectileMs;p.collisionMs=collisionMs;p.postMs=postMs;
      p.collisionPrepMs=c.collisionPrepMs;p.collisionGridBuildMs=c.collisionGridBuildMs;p.collisionPairScanMs=c.collisionPairScanMs;p.collisionSoftApplyMs=c.collisionSoftApplyMs;
      p.collisionSweptMotionMs=c.collisionSweptMotionMs;p.collisionTerrainMs=c.collisionTerrainMs;p.collisionHardFixMs=c.collisionHardFixMs;
      p.collisionOtherMs=Math.max(0,collisionMs-(c.collisionPrepMs+c.collisionGridBuildMs+c.collisionPairScanMs+c.collisionSoftApplyMs+c.collisionSweptMotionMs+c.collisionTerrainMs+c.collisionHardFixMs));
      p.collisionSoftPasses=c.collisionSoftPasses;p.collisionSoftContacts=c.collisionSoftContacts;p.collisionSoftMovedUnits=c.collisionSoftMovedUnits;p.collisionSoftCappedUnits=c.collisionSoftCappedUnits;
      p.collisionSoftDetailedSamples=(p.collisionSoftDetailedSamples||0)+1;
      for(const key of ["collisionSweptCalls","collisionSweptActivePasses","collisionSweptZeroMotionCalls","collisionSweptEmptyPasses","collisionSweptPairTests","collisionSweptHits","collisionSweptCorrectionUnits","collisionSweptNoCorrectionPasses",
        "collisionHardFixCalls","collisionHardFixPasses","collisionHardFixActivePairTests","collisionHardFixCandidates","collisionHardFixCorrections","collisionHardFixNoOpCalls","combatTargetPickMs","combatTargetPickCalls"])p[key]=c[key];
      p.combatOtherMs=Math.max(0,combatMs-c.combatTargetPickMs);
      p.aliveUnits=aliveUnits;p.workers=workers;p.combatUnits=combatUnits;p.projectiles=this.projectiles.length;
      p.peakAliveUnits=Math.max(p.peakAliveUnits||0,aliveUnits);
      p.peakBuildings=Math.max(p.peakBuildings||0,this.buildings.length);
      p.peakProjectiles=Math.max(p.peakProjectiles||0,this.projectiles.length);
      p.spatialQueries=c.spatialQueries;p.spatialCandidates=c.spatialCandidates;p.targetQueries=c.targetQueries;p.targetVisibilityRejects=c.targetVisibilityRejects;p.sideSpatialQueries=c.sideSpatialQueries;p.visibilityChecks=c.visibilityChecks;
      p.collisionPairs=c.collisionPairs;p.collisionOverlaps=c.collisionOverlaps;p.buildingCollisionCandidates=c.buildingCollisionCandidates||0;
    }
    this._perfCollect=null;
    return winner;
  }
  routePathSignature(recipe){return StableSerializationUtil.stableStringify(recipe)}
  routePathBody(data,id){
    const root=data.tailId===null?null:this.routePathStore.get(data.tailId);if(data.tailId!==null&&!root)throw new Error('Missing shared route root');
    const recipe=StateValue.freeze(StateValue.copy(data.recipe)),points=StateValue.freeze(data.points.slice());
    const body={id,key:data.key,radius:data.radius,ignore:data.ignore,topology:data.topology,points,tailId:data.tailId,tailStart:data.tailStart,recipe};
    Object.defineProperties(body,{length:{value:points.length/2+(root?root.length-data.tailStart:0)},rootPathId:{value:root?.rootPathId??root?.id??data.rootPathId??id}});
    return StateValue.freeze(body);
  }
  internRoutePath(data){
    if(!data||!Array.isArray(data.points)||data.points.length>RallyStateCodec.MAX_ARRAY||!data.recipe||typeof data.key!=='string'||!Number.isFinite(data.radius)||typeof data.ignore!=='boolean'||typeof data.topology!=='string'||data.tailId!==null&&!this.routePathStore.has(data.tailId))throw new Error('Invalid runtime route path');
    const points=[];for(const point of data.points){if(!point||!Number.isFinite(point.x)||!Number.isFinite(point.y))throw new Error('Invalid runtime route waypoint');points.push(point.x,point.y)}
    const root=data.tailId===null?null:this.routePathStore.get(data.tailId);
    if(data.tailId===null?data.tailStart!==0:!root||root.tailId!==null||!Number.isSafeInteger(data.tailStart)||data.tailStart<0||data.tailStart>=root.length||root.key!==data.key||root.radius!==data.radius||root.ignore!==data.ignore)throw new Error('Invalid runtime shared route root');
    if(points.length/2+(root?root.length-data.tailStart:0)>RallyStateCodec.MAX_ARRAY)throw new Error('Runtime route path exceeds array budget');
    const signature=this.routePathSignature(data.recipe),existing=this.routePathIndex.get(signature);if(existing!==undefined)return existing;
    const id=this.nextRoutePathId;if(!Number.isSafeInteger(id)||id<1||id>=Number.MAX_SAFE_INTEGER)throw new Error('Runtime route ID space exhausted');this.nextRoutePathId=id+1;
    const path=this.routePathBody({...data,points},id);this.routePathStore.set(id,path);this.routePathIndex.set(signature,id);return id;
  }
  collectUnusedRoutePaths(){
    const used=new Set();
    for(const unit of this.units)for(const route of unit.movement?.routes||[]){const path=this.routePathStore.get(route.pathId);if(path){used.add(path.id);used.add(path.rootPathId??path.id)}}
    let changed=false;
    for(const id of this.routePathStore.keys())if(!used.has(id)){this.routePathStore.delete(id);changed=true}
    if(changed){this.routePathIndex.clear();for(const path of this.routePathStore.values())this.routePathIndex.set(this.routePathSignature(path.recipe),path.id);if(this.navigation)this.navigation.routeTemplates=null}
  }
  clearRuntimeRouteCache({resetIds=false,clearHandles=true}={}){
    this.routePathStore?.clear();this.routePathIndex?.clear();if(resetIds)this.nextRoutePathId=1;
    if(clearHandles)for(const unit of this.units||[])if(unit.movement){unit.movement.routes=[];unit.movement.routeIndex=-1}
    if(this.navigation){this.navigation.routeTemplates=null;this.navigation.routeChecks=new WeakMap()}
  }
  static routeObstacleSignature(buildings=[]){
    const records=[];for(const b of buildings||[])if(b&&b.alive!==false&&b.hp>0){const d=BuildingDefinition.get(b.type),r=(d?.size||35)+NAV_BUILDING_MARGIN;records.push([String(b.id),b.type,b.x,b.y,r,!!d?.isTerrainBarrier])}
    records.sort((a,b)=>a[0]<b[0]?-1:a[0]>b[0]?1:0);return JSON.stringify(records);
  }
  runtimeRouteCacheForState(state,mapDescriptor){
    this.navigation?.sync();
    const handles=[];for(const unit of state.units||[])for(const route of unit?.movement?.routes||[])handles.push(route);
    const targetRevision=state.navigationRevision,signature=StrategySim.routeObstacleSignature(state.buildings);
    const currentRevision=this.navigationRevision;
    const currentSignature=this.navigation?.topology?.records?JSON.stringify(this.navigation.topology.records.map(c=>[String(c.id),c.type,c.x,c.y,c.r,c.terrainBarrier])):StrategySim.routeObstacleSignature(this.buildings);
    const sameMap=mapDescriptor===this.mapDescriptor||StableSerializationUtil.stableStringify(mapDescriptor)===StableSerializationUtil.stableStringify(this.mapDescriptor);
    const reusable=this.routePathStore instanceof Map&&this.routePathIndex instanceof Map&&sameMap&&currentRevision===targetRevision&&this.navigationRevision===targetRevision&&currentSignature===signature&&handles.every(route=>{
      const recipe=MovementComponent.decodeRouteRecipe(route?.recipe);
      const pathId=this.routePathIndex.get(this.routePathSignature(recipe)),path=this.routePathStore.get(pathId);
      if(!path||route.cursor>=Math.max(1,path.length))return false;
      if(recipe.kind!=='join')return true;
      const root={kind:recipe.root.kind,key:recipe.key,radius:recipe.radius,ignore:recipe.ignore,fromX:recipe.root.fromX,fromY:recipe.root.fromY,planner:recipe.root.planner};
      return this.routePathIndex.has(this.routePathSignature(root));
    });
    if(reusable)return{routePathStore:this.routePathStore,routePathIndex:this.routePathIndex,nextRoutePathId:this.nextRoutePathId};
    const staged=Object.create(StrategySim.prototype);
    Object.assign(staged,{mapDescriptor,world:WorldContext.fromMap(mapDescriptor),buildings:(state.buildings||[]).map(Building.fromState),units:(state.units||[]).map(Unit.fromState),tick:state.tick||0,navigationRevision:targetRevision,nextRoutePathId:1,routePathStore:new Map(),routePathIndex:new Map(),runtimeEpoch:0});
    staged.navigation=new TerrainNavigation(staged);staged.navigation.sync();staged.rebuildRuntimeRouteCache();
    return{routePathStore:staged.routePathStore,routePathIndex:staged.routePathIndex,nextRoutePathId:staged.nextRoutePathId};
  }
  rebuildRuntimeRouteCache(){
    for(const unit of this.units||[])for(const route of unit.movement?.routes||[]){
      const recipe=MovementComponent.decodeRouteRecipe(route.recipe),pathId=this.navigation.materializeRouteRecipe(recipe);if(pathId===null)continue;
      const path=this.routePathStore.get(pathId);if(!path||route.cursor>=Math.max(1,path.length))throw new Error('Runtime route recipe cursor is invalid');
      Object.defineProperty(route,'pathId',{value:pathId,writable:true,enumerable:false,configurable:true});
      Object.defineProperty(route,'routeRecipe',{value:recipe,writable:true,enumerable:false,configurable:true});
    }
  }
  bindRuntimeRouteHandles(){
    for(const unit of this.units||[])for(const route of unit.movement?.routes||[]){
      const recipe=MovementComponent.decodeRouteRecipe(route.recipe),pathId=this.routePathIndex.get(this.routePathSignature(recipe)),path=this.routePathStore.get(pathId);
      if(pathId===undefined||!path||route.cursor>=Math.max(1,path.length))throw new Error('Runtime route cache is incomplete');
      Object.defineProperty(route,'pathId',{value:pathId,writable:true,enumerable:false,configurable:true});
      Object.defineProperty(route,'routeRecipe',{value:recipe,writable:true,enumerable:false,configurable:true});
      this.navigation.routeChecks.set(path,{records:this.navigation.circles,key:path.topology});
    }
  }
  mapFingerprint(){return HashUtil.hash(StableSerializationUtil.stableStringify(this.mapDescriptor))}
  checksum(){return RallyNetcode.hashBytes(RallyStateCodec.encode(this.exportState())).toString(16).padStart(8,"0")}
  exportState({includeIdentity=true}={}){
    this.navigation?.sync();
    const source={...this,campaignScenario:this.campaignScenario||null,campaignScriptState:this.campaignScriptRuntime?.state||null,scheduled:[...this.scheduled.entries()]};
    // Runtime path bodies stay in the local route cache. Unit handles capture
    // only the goal, movement profile, route origin, and deterministic recipe.
    delete source.units;delete source.buildings;delete source.projectiles;
    // SDK mementos reference these immutable definitions by match identity. Omit
    // them before capture/clone, rather than copying then discarding a large map.
    if(!includeIdentity){delete source.rules;delete source.mapDescriptor;delete source.campaignScenario}
    const state=StrategySim.stateContract.capture(source,"save");
    state.units=this.units.map(u=>u.toState("save"));state.buildings=this.buildings.map(b=>b.toState("save"));state.projectiles=this.projectiles.map(p=>p.toState("save"));
    return state;
  }
  restoreCampaignState(mission,state,{rollback=false}={}){
    const runtime=this.campaignScriptRuntime;
    if(rollback&&runtime&&!runtime.disposed&&mission&&
      (runtime.mission===mission||StableSerializationUtil.stableStringify(runtime.mission)===StableSerializationUtil.stableStringify(mission))){
      // Rollback restores data in the same validated module. Lifecycle hooks and
      // module-local teardown belong to match/replay transitions, never rewinds.
      this.campaignScenario=runtime.mission;runtime.state=StateValue.copy(state||{});return;
    }
    if(rollback&&(runtime||mission))throw new Error("롤백의 캠페인 정의가 현재 경기와 다릅니다.");
    this.campaignScriptRuntime?.dispose("state-restore");
    this.campaignScriptRuntime=null;
    if(mission){
      this.campaignScenario=CampaignMissionDefinition.normalize(mission);
      this.campaignScriptRuntime=new CampaignScriptRuntime(this,this.campaignScenario);
      this.campaignScriptRuntime.started=true;
      this.campaignScriptRuntime.state=CloneUtil.clone(state||{});
      const h=this.campaignScenario.playerRole==="guest"?1:0;
      this.campaignTechCap=[3,3];this.campaignTechCap[h]=this.campaignScenario.player.techCap;this.campaignTechCap[1-h]=this.campaignScenario.enemy.techCap;
    }else{this.campaignScenario=null;this.campaignScriptRuntime=null;delete this.campaignTechCap}
  }
  importState(s,{rollback=false}={}){
    const retained={mapDescriptor:this.mapDescriptor,rules:this.rules,campaignScenario:this.campaignScenario||null};
    const retainedNavigation=rollback&&this.navigation instanceof TerrainNavigation?this.navigation:null;
    if(rollback){
      for(const key of Object.keys(retained))if(s[key]!==retained[key]&&StableSerializationUtil.stableStringify(s[key]??null)!==StableSerializationUtil.stableStringify(retained[key]))throw new Error(`롤백의 ${key} 정의가 현재 경기와 다릅니다.`);
      if(this.campaignScriptRuntime?.disposed||!!this.campaignScriptRuntime!==!!retained.campaignScenario)throw new Error("롤백할 캠페인 runtime이 없습니다.");
    }
    const routeMapDescriptor=s.mapDescriptor??retained.mapDescriptor,routeCache=this.runtimeRouteCacheForState(s,routeMapDescriptor);
    if(!rollback){this.campaignScriptRuntime?.dispose("state-import");this.campaignScriptRuntime=null}
    this.disposed=false;
    const source={...s};
    if(rollback)for(const key of Object.keys(retained))delete source[key];
    const copy=StateValue.copy(source),scheduled=copy.scheduled||[];delete copy.scheduled;
    if(rollback){
      Object.assign(copy,retained);
      for(const key of StrategySim.stateContract.keys(this,"save"))if(!Object.prototype.hasOwnProperty.call(copy,key)&&key!=="scheduled")delete this[key];
    }
    Object.assign(this,copy);
    StateValue.freeze(this.mapDescriptor);this.world=WorldContext.fromMap(this.mapDescriptor);
    this.restoreCampaignState(copy.campaignScenario,copy.campaignScriptState,{rollback});
    delete this.campaignScriptState;
    this.tps=RangeUtil.clamp(Math.round(Number(this.rules?.simulation?.tps)||SIM_TPS),10,30);
    this.units=(copy.units||[]).map(Unit.fromState);this.buildings=(copy.buildings||[]).map(Building.fromState);this.projectiles=(copy.projectiles||[]).map(Projectile.fromState);
    this.scheduled=new Map(scheduled);
    this.events=[];
    SimulationRuntimeState.initialize(this);
    this.navigation.sceneTick=-1;this.navigation.sceneRevision=undefined;
    if(retainedNavigation&&retainedNavigation.geometry===this.world.terrain){
      this.navigation=retainedNavigation;
      this.navigation.sceneTick=-1;this.navigation.sceneRevision=undefined;
      this.navigation.motion=new SurfaceMotion(this.navigation);
      this.navigation.sync({preserveRevision:true});
    }else this.navigation.sync({preserveRevision:true});
    this.routePathStore=routeCache.routePathStore;this.routePathIndex=routeCache.routePathIndex;this.nextRoutePathId=routeCache.nextRoutePathId;
    this.navigation.routeChecks=new WeakMap();this.navigation.routeTemplates=null;this.bindRuntimeRouteHandles();
    this.rebuildRuntimeIndexes();
  }
  snapshot(){
    const started=performance.now();
    try{this.navigation?.sync();return TerrainNavigation.bindSnapshot({tick:this.tick,tps:this.tps,launchMode:this.launchMode,navigationRevision:this.navigationRevision,decks:this.decks.map(d=>d.slice()),campaignTechCap:this.campaignTechCap?.slice()||null,mapDescriptor:this.mapDescriptor,wallet:this.wallet.slice(),launchStats:StateValue.copy(this.launchStats),gasWallet:this.gasWallet.slice(),gasNodes:StateValue.copy(this.gasNodes),tech:this.tech.slice(),attackUpgrade:this.attackUpgrade.slice(),armorUpgrade:this.armorUpgrade.slice(),abilities:CloneUtil.clone(this.abilities),specialResearch:CloneUtil.clone(this.specialResearch),researchQueues:CloneUtil.clone(this.researchQueues),productionPaused:this.productionPaused.slice(),flags:CloneUtil.clone(this.flags),chargedCasts:StateValue.copy(this.chargedCasts),chargedCastSerial:this.chargedCastSerial.slice(),defenseCards:StateValue.copy(this.defenseCards),resources:StateValue.copy(this.resources),camps:StateValue.copy(this.camps),capturePoints:CloneUtil.clone(this.capturePoints),spellBooks:CloneUtil.clone(this.spellBooks),equippedSpells:CloneUtil.clone(this.equippedSpells),passiveCards:CloneUtil.clone(this.passiveCards),spellChests:this.spellChests.slice(),pendingChestOffers:CloneUtil.clone(this.pendingChestOffers),pendingSpellReplacement:CloneUtil.clone(this.pendingSpellReplacement),activeSpells:CloneUtil.clone(this.activeSpells),delayedEffects:CloneUtil.clone(this.delayedEffects),units:this.units.map(u=>u.toState("view")),buildings:this.buildings.map(b=>b.toState()),constructionOrders:StateValue.copy(this.constructionOrders),projectiles:this.projectiles.map(p=>p.toState()),events:StateValue.copy(this.events)},this)}
    finally{const perf=this.perfStats;perf.snapshotMs=performance.now()-started;perf.snapshotCumulativeMs=(perf.snapshotCumulativeMs||0)+perf.snapshotMs;perf.maxSnapshotMs=Math.max(perf.maxSnapshotMs,perf.snapshotMs);perf.snapshotSamples++}
  }
}

export { StrategySim };
