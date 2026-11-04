// Units, buildings, projectiles, supply/vision policies and terrain queries.
import { RangeUtil } from '../core/game-rules.js';
import { UNIT_CAPABILITY_MIXINS, UnitLogicControllerFactory, UnitStateContracts } from './unit-behaviors.js';
import { CapabilityHost, CombatComponent, MovementComponent, ResourceComponent, SimTimerComponent, StateContract, StateValue, StatusComponent } from './components.js';
import { LaunchRules } from './launch-rules.js';
import { MapGeneration } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { DefenseCardDefinition } from '../definitions/decks.js';
import { ECONOMY_WORKER_TYPE, UnitDefinition } from '../definitions/units.js';
import { NEUTRAL_SIDE, PassiveCardDefinition, SpellDefinition } from '../definitions/cards.js';
import { MapGeometry } from './map-geometry.js';
import { NAV_BUILDING_MARGIN } from '../definitions/combat-rules.js';
import { TERRAIN_ATTACK_REVEAL_RADIUS, VISION_SPATIAL_CELL } from '../definitions/world-rules.js';
import { WorldContext } from './world-context.js';
import { TerrainSurfaceAtlas } from './terrain.js';

class Unit extends CapabilityHost{
  constructor(spec={}){
    super();const contracts=UnitStateContracts.forType(spec.type),data=contracts.root.create(spec),logic=data.logic||null;delete data.logic;
    this.behaviorState=contracts.behavior.create(data.behaviorState||{});delete data.behaviorState;
    this.timers=new SimTimerComponent(data.timers||{});delete data.timers;
    this.status=new StatusComponent(data.status||{});delete data.status;
    this.resources=new ResourceComponent(data.resources||{});delete data.resources;
    this.movement=new MovementComponent(data.movement||{});delete data.movement;
    this.combat=new CombatComponent(data.combat||{});delete data.combat;
    Object.assign(this,data);this.attachCapabilities();
    const profile=logic?.type||null,state=logic?.state||{};
    this.logicController=UnitLogicControllerFactory.create(this,profile,state);
  }
  get logicProfile(){return this.logicController?.kind||UnitLogicControllerFactory.normalizeProfile(null,this.side)}
  static neutralStateOf(entity){
    const logic=entity?.logicController||entity?.logic;
    return (logic?.kind||logic?.type)==="neutral-object"?logic.state:null;
  }
  neutralObjectState(){return Unit.neutralStateOf(this)}
  get campId(){return this.neutralObjectState()?.campId??null}
  set campId(v){const st=this.neutralObjectState();if(st)st.campId=v??null}
  get aggroed(){return !!this.neutralObjectState()?.aggroed}
  set aggroed(v){const st=this.neutralObjectState();if(st)st.aggroed=!!v}
  get returningHome(){return !!this.neutralObjectState()?.returningHome}
  set returningHome(v){const st=this.neutralObjectState();if(st)st.returningHome=!!v}
  setLogicProfile(profile,state={}){
    this.logicController=UnitLogicControllerFactory.create(this,profile,state);
    return this.logicController;
  }
  attachCapabilities(){const d=UnitDefinition.get(this.type)||{};for(const Mixin of UNIT_CAPABILITY_MIXINS)if(Mixin.supports(this,d))new Mixin(this)}
  toState(mode="snapshot"){
    const out=UnitStateContracts.forType(this.type).root.capture(this,mode);
    out.logic={type:this.logicController?.kind||"default",state:StateValue.copy(this.logicController?.toState?.()||{})};
    return out;
  }
  writeChecksum(h){UnitStateContracts.forType(this.type).root.hash(h,this);StateValue.hash(h,{type:this.logicProfile,state:this.logicController.toState()})}
  toJSON(){return this.toState("save")}
  static fromState(state){return new Unit(state||{})}
}

class Building{
  static stateContract=new StateContract({cooldownUntil:0,attackCooldownPhase:0,queue:[],terrainRevealUntil0:0,terrainRevealUntil1:0},{presentation:["hitFlash","attackFlash"]});
  constructor(state={}){Object.assign(this,Building.stateContract.create(state));if(!Array.isArray(this.queue))this.queue=[]}
  cooldownActive(sim){return sim.tick<(Number(this.cooldownUntil)||0)}
  clearCooldown(){this.cooldownUntil=0}
  startCooldownUntil(tick){this.cooldownUntil=Math.max(0,Math.round(Number(tick)||0));return this.cooldownUntil}
  toState(mode="snapshot"){return Building.stateContract.capture(this,mode)}
  writeChecksum(h){Building.stateContract.hash(h,this)}toJSON(){return this.toState("save")}static fromState(state){return new Building(state||{})}
}
class DelayedEffectState{
  static contract=new StateContract({}, {presentation:["arcHeight","drawRadius","visualTag"]});
  static capture(value,mode="snapshot"){return (value||[]).map(effect=>this.contract.capture(effect,mode))}
  static hash(h,value){StateValue.hash(h,this.capture(value,"save"))}
}
class Projectile{
  static stateContract=new StateContract({}, {presentation:["arcHeight","drawRadius","visualTag"]});
  constructor(state={}){
    Object.assign(this,Projectile.stateContract.create(state));
    // Impact events are game outputs. Their identity survives recovery independently
    // of the renderer's preset, radius and arc, which come from definitions.
    this.impactEventKind=state.impactEventKind||null;
    const def=BuildingDefinition.get(this.type)||UnitDefinition.get(this.type)||{};
    const eventVisual={rocketBurst:"balsamRocket",shockwave:"medicShock",retaliation:"guardRetaliation"}[this.impactEventKind];
    this.visualTag=state.visualTag??eventVisual??def.projectileVisualTag??({bear:"bearRock",dragon:"dragonFireball"}[this.type])??(this.type==="deathworm"?(this.splash?"rupture":"needle"):null);
    const pattern=def.projectilePattern;
    const patternArc=pattern?(Array.isArray(pattern.arcHeights)?pattern.arcHeights[(Math.max(1,this.burstIndex||1)-1)%pattern.arcHeights.length]:pattern.arcHeight):null;
    const specialArc=this.impactEventKind==="shockwave"?def.basicAttack?.variants?.find(v=>v.attack?.vfxPreset==="medicShock")?.attack?.arcHeight:this.impactEventKind==="retaliation"?(def.guardRetaliationArcHeight||35):null;
    this.arcHeight=state.arcHeight??(state.chargedCastId?def.chargedSkill?.arcHeight:null)??patternArc??specialArc??def.projectileArc??0;
    this.drawRadius=state.drawRadius??def.projectileRadius??0;
    if(this.payload){
      this.visualTag="launchAmmo";
      this.arcHeight=LaunchRules.arcHeight(Math.hypot((Number(this.lockedAimX)||0)-(Number(this.launchX)||0),(Number(this.lockedAimY)||0)-(Number(this.launchY)||0)));
      this.drawRadius=8+Math.min(10,this.payload.count/3);
    }
  }toState(mode="snapshot"){return Projectile.stateContract.capture(this,mode)}
  writeChecksum(h){Projectile.stateContract.hash(h,this)}toJSON(){return this.toState("save")}static fromState(state){return new Projectile(state||{})}
}

/* Combat targeting contract:
   Basic attacks never abandon an attackable in-range enemy to walk toward a preferred role.
   Role priority may only choose among already-fireable basic-attack targets.
   Out-of-range acquisition is nearest-target based.
   Leap / hook / burrow / other explicit abilities own independent targeting policies. */
// Shared, read-only legality over either a simulation or its published snapshot.
// Costs/placement are separate checks; this policy never mutates gameplay state.
class BuildPrerequisitePolicy{
  static completed(state,side,type){
    return (state.buildings||[]).some(b=>b.alive!==false&&b.hp>0&&b.complete&&b.side===side&&b.type===type);
  }
  static infrastructureForTier(tier){
    return tier===2?BuildingDefinition.forRole("academy"):tier===3?BuildingDefinition.forRole("lab"):null;
  }
  static unitReason(state,side,type){
    const d=UnitDefinition.get(type);
    if(!d)return "알 수 없는 병종입니다.";
    if(!(state.decks?.[side]||[]).includes(type))return "선택하지 않은 병종입니다.";
    const cap=state.campaignTechCap?.[side];
    if(Number.isFinite(cap)&&d.tier>cap)return "이 미션에서 해금되지 않은 테크입니다.";
    if(d.tier>(state.tech?.[side]||1))return `T${d.tier} 테크가 필요합니다.`;
    const infra=this.infrastructureForTier(d.tier);
    if(infra&&!this.completed(state,side,infra))return `${BuildingDefinition.get(infra).name} 완공/재건이 필요합니다.`;
    if(d.layer==="AIR"&&!this.completed(state,side,BuildingDefinition.forRole("airTech")))return "공중 배양소 완공/재건이 필요합니다.";
    return null;
  }
  static buildingReason(state,side,type,produceType=null){
    if(BuildingDefinition.get(type)?.scenarioOnly)return "시나리오 전용 지형 오브젝트입니다.";
    const d=BuildingDefinition.get(type);
    if(!d)return "알 수 없는 건물입니다.";
    const cap=state.campaignTechCap?.[side];
    if(Number.isFinite(cap)&&Number(d.tech||0)>cap)return "이 미션에서 해금되지 않은 테크입니다.";
    if(d.singleton&&((state.buildings||[]).some(b=>b.alive!==false&&b.hp>0&&b.side===side&&b.type===type)||(state.constructionOrders||[]).some(b=>b.side===side&&b.type===type)))return `${d.name}은(는) 하나만 건설할 수 있습니다.`;
    if(Number(d.requiresTech)>0&&(state.tech?.[side]||1)<d.requiresTech)return `T${d.requiresTech} 테크가 필요합니다.`;
    for(const dependency of d.requiresBuildings||[]){
      if(!this.completed(state,side,dependency))return `${BuildingDefinition.get(dependency)?.name||dependency} 완공/재건이 필요합니다.`;
    }
    if(d.isDefenseTower&&!DefenseCardDefinition.list(state.defenseCards?.[side]).some(id=>DefenseCardDefinition.get(id)?.building===type))return "선택하지 않은 방어 건물 카드입니다.";
    if(d.productionFacility){
      if(!produceType)return "먼저 생산할 병종을 선택하세요.";
      const reason=this.unitReason(state,side,produceType);if(reason)return reason;
      const tier=UnitDefinition.get(produceType).tier;
      if((Number(d.requiresTech)>0&&tier!==d.requiresTech)||(Number(d.requiresTech||0)<3&&tier>=3))return "이 생산시설에 맞는 병종을 선택하세요.";
    }
    return null;
  }
}

class SupplyPolicy{
  static cap(state,side){
    let total=0;
    for(const b of state.buildings||[])if(b.alive!==false&&b.side===side&&b.complete)total+=BuildingDefinition.get(b.type)?.supplyPlus||0;
    return total;
  }
  static used(state,side){
    let total=0;
    for(const u of state.units||[])if(u.alive&&u.side===side)total+=UnitDefinition.get(u.type)?.supply||0;
    for(const b of state.buildings||[]){
      if(b.alive===false||b.side!==side)continue;
      for(const q of b.queue||[]){
        const type=q.kind==="workerProduction"?ECONOMY_WORKER_TYPE:q.type;
        if(type)total+=(UnitDefinition.get(type)?.supply||0)*Math.max(1,q.count||1);
      }
    }
    return total;
  }
}

class VisibilityPolicy{
  static snapshotQueries=new WeakMap();
  static unitQuery(state){
    if(typeof state.nearbyUnits==="function")return(x,y,r,visit)=>{for(const i of state.nearbyUnits(x,y,r))visit(state.units[i])};
    let cached=this.snapshotQueries.get(state);
    if(cached&&cached.tick===state.tick&&cached.units===state.units)return cached.query;
    const cell=VISION_SPATIAL_CELL,bins=new Map();
    for(const u of state.units||[])if(u?.alive){const key=Math.floor(u.x/cell)+","+Math.floor(u.y/cell);let bin=bins.get(key);if(!bin)bins.set(key,bin=[]);bin.push(u)}
    const query=(x,y,r,visit)=>{for(let cy=Math.floor((y-r)/cell);cy<=Math.floor((y+r)/cell);cy++)for(let cx=Math.floor((x-r)/cell);cx<=Math.floor((x+r)/cell);cx++){const bin=bins.get(cx+","+cy);if(bin)for(const u of bin)visit(u)}};
    this.snapshotQueries.set(state,{tick:state.tick,units:state.units,query});return query;
  }
  static passivePct(state,side){
    const level=Math.max(0,Number(state.passiveCards?.[side]?.vision)||0),def=PassiveCardDefinition.get("vision");
    return level>0&&def?Number(def.values[Math.min(def.values.length,level)-1])||0:0;
  }
  // Aura providers are rare and ability-gated: collect them once per side
  // instead of a neighbour query for every vision source.
  static auraSources(state,side){
    const out=[];
    for(const u of state.units||[]){
      if(!u?.alive||u.side!==side||!state.abilities?.[side]?.[u.type])continue;
      const d=UnitDefinition.get(u.type),r=Number(d?.sightAuraRadius)||0;
      if(r>0)out.push({x:u.x,y:u.y,r,pct:d.sightAuraPct||125});
    }
    return out;
  }
  static auraPct(u,auras){
    let pct=100;
    for(const a of auras)if(Math.hypot(a.x-u.x,a.y-u.y)<=a.r)pct=Math.max(pct,a.pct);
    return pct;
  }
  static revealUntil(unit,side){return Number(side===0?unit?.status?.terrainRevealUntil0:unit?.status?.terrainRevealUntil1)||0}
  static sources(state,side){
    const out=[],auras=this.auraSources(state,side),passive=this.passivePct(state,side),world=WorldContext.forState(state);
    for(const u of state.units||[])if(u.alive&&u.side===side){const d=UnitDefinition.get(u.type)||{},air=d.layer==="AIR";
      out.push({x:u.x,y:u.y,r:Math.round((Number(d.sight)||0)*(100+passive)/100*(auras.length?this.auraPct(u,auras):100)/100),detect:Number(d.detectRadius)||0,level:world.terrain.surfaces.levelAt(u.x,u.y),air,ignoresTerrainVision:false,sourceId:u.id});
    }
    for(const b of state.buildings||[])if(b.alive!==false&&b.side===side&&b.complete){const d=BuildingDefinition.get(b.type)||{};out.push({x:b.x,y:b.y,r:Number(d.sight)||0,detect:Number(d.detectRadius)||0,level:world.terrain.surfaces.levelAt(b.x,b.y),air:false,ignoresTerrainVision:false,sourceId:b.id})}
    for(const sp of state.activeSpells||[])if(sp.type==="flare"&&sp.side===side&&state.tick<sp.expireTick){const r=sp.vision||SpellDefinition.statsAt("flare",0).vision;out.push({x:sp.x,y:sp.y,r,detect:r,level:world.terrain.surfaces.levelAt(sp.x,sp.y),air:true,ignoresTerrainVision:true,sourceId:sp.id||"flare"})}
    // High-ground attackers briefly reveal their own tile to the side they attacked.
    for(const u of state.units||[])if(u?.alive&&u.side!==side&&u.side!==NEUTRAL_SIDE&&this.revealUntil(u,side)>Number(state.tick||0))out.push({x:u.x,y:u.y,r:TERRAIN_ATTACK_REVEAL_RADIUS,detect:0,level:world.terrain.surfaces.levelAt(u.x,u.y),air:true,ignoresTerrainVision:true,reveal:true,sourceId:`reveal:${u.id}`});
    for(const b of state.buildings||[])if(b?.alive!==false&&b.side!==side&&b.side!==NEUTRAL_SIDE&&Number(side===0?b.terrainRevealUntil0:b.terrainRevealUntil1)>Number(state.tick||0))out.push({x:b.x,y:b.y,r:TERRAIN_ATTACK_REVEAL_RADIUS,detect:0,level:world.terrain.surfaces.levelAt(b.x,b.y),air:true,ignoresTerrainVision:true,reveal:true,sourceId:`reveal:${b.id}`});
    return out;
  }
}
// Per-side visibility on a fixed cell grid: the one answer for combat targeting,
// AI, entity rendering and fog. A source lights the cells it can see by walking
// outward from its own cell; each cell inherits sight from the neighbour one step
// closer (0 A.D./OpenRA-style cells instead of a ray per target). Cells count the
// sources per sight ceiling, so "visible to a target on level L" is a lookup, and
// only sources whose cell, radius, level or mode changed are repainted.
class VisionField{
  static CELL=32;
  static AIR_CEILING=127; // air sources and terrain-ignoring reveals see every level
  static MODE_GROUND=0;static MODE_AIR=1;static MODE_IGNORE=2;
  static rasters=new WeakMap();
  static offsetTable=null;
  static of(owner,side,state){
    const terrain=WorldContext.forState(state).terrain,fields=owner.visionFields||=[null,null];
    let field=fields[side];if(field?.terrain!==terrain)field=fields[side]=new VisionField(terrain);
    return field.update(VisibilityPolicy.sources(state,side),state);
  }
  // Static terrain at cell centres: surface level and vision obstacle membership.
  static raster(terrain){
    let raster=this.rasters.get(terrain);if(raster)return raster;
    const cell=this.CELL,cols=Math.ceil(terrain.width/cell),rows=Math.ceil(terrain.height/cell),n=cols*rows;
    const level=new Int8Array(n),ground=new Uint8Array(n),air=new Uint8Array(n);
    const inside=(index,x,y)=>{for(const b of index.query(x,y,x,y,0))if(MapGeometry.pointInSimplePolygon(x,y,b.points))return true;return false};
    for(let cy=0;cy<rows;cy++)for(let cx=0;cx<cols;cx++){
      const x=Math.min(terrain.width,(cx+.5)*cell),y=Math.min(terrain.height,(cy+.5)*cell),c=cy*cols+cx;
      level[c]=terrain.surfaces.levelAt(x,y);ground[c]=inside(terrain.visionIndex,x,y)?1:0;air[c]=inside(terrain.airVisionIndex,x,y)?1:0;
    }
    raster={cols,rows,level,ground,air};this.rasters.set(terrain,raster);return raster;
  }
  // Cell offsets sorted by distance; parent is the neighbour one step toward the origin.
  static offsets(radius){
    if(this.offsetTable?.radius>=radius)return this.offsetTable;
    const R=Math.max(radius,2*(this.offsetTable?.radius||8)),span=2*R+1,list=[];
    for(let dy=-R;dy<=R;dy++)for(let dx=-R;dx<=R;dx++)if(dx*dx+dy*dy<=R*R)list.push([dx,dy,dx*dx+dy*dy]);
    list.sort((a,b)=>a[2]-b[2]||a[1]-b[1]||a[0]-b[0]);
    const n=list.length,dx=new Int16Array(n),dy=new Int16Array(n),d2=new Int32Array(n),parent=new Int32Array(n),at=new Int32Array(span*span);
    list.forEach(([x,y,d],i)=>{dx[i]=x;dy[i]=y;d2[i]=d;at[(y+R)*span+x+R]=i});
    for(let i=0;i<n;i++){
      const x=dx[i],y=dy[i],ax=Math.abs(x),ay=Math.abs(y);let px,py;
      if(!ax&&!ay){parent[i]=-1;continue}
      if(ax>=ay){px=x-Math.sign(x);py=Math.sign(y)*Math.round(ay*(ax-1)/ax)}
      else{py=y-Math.sign(y);px=Math.sign(x)*Math.round(ax*(ay-1)/ay)}
      parent[i]=at[(py+R)*span+px+R];
    }
    return this.offsetTable={radius:R,dx,dy,d2,parent};
  }
  constructor(terrain){
    this.terrain=terrain;this.raster=VisionField.raster(terrain);this.size=this.raster.cols*this.raster.rows;
    this.visionAny=new Uint16Array(this.size);this.detectAny=new Uint16Array(this.size);
    this.vision=new Map();this.detection=new Map();this.records=new Map();this.duplicates=new Map();
    this.buildingGround=new Int32Array(this.size);this.buildingAir=new Int32Array(this.size);this.blockers=[];this.blockerKey="";
    this.pass=new Uint8Array(0);this.scratch=new Int32Array(0);this.epoch=0;this.revision=0;this.sources=[];
  }
  cellAt(x,y){
    const {cols,rows}=this.raster,cell=VisionField.CELL;
    return RangeUtil.clamp(Math.floor(y/cell),0,rows-1)*cols+RangeUtil.clamp(Math.floor(x/cell),0,cols-1);
  }
  update(sources,state){
    this.sources=sources;this.syncBlockers(state);
    const epoch=++this.epoch;let changed=false;this.duplicates.clear();
    for(const s of sources){
      let id=String(s.sourceId);const seen=this.duplicates.get(id)||0;this.duplicates.set(id,seen+1);if(seen)id+="#"+seen;
      const mode=s.ignoresTerrainVision?VisionField.MODE_IGNORE:s.air?VisionField.MODE_AIR:VisionField.MODE_GROUND,cell=this.cellAt(s.x,s.y);
      const key=`${cell}|${Number(s.r)||0}|${Number(s.detect)||0}|${mode}|${Number(s.level)||0}`,record=this.records.get(id);
      if(record?.key===key){record.epoch=epoch;continue}
      if(record)this.apply(record,-1);
      const next=this.paint(s,key,mode,cell);next.epoch=epoch;this.records.set(id,next);this.apply(next,1);changed=true;
    }
    for(const [id,record] of this.records)if(record.epoch!==epoch){this.apply(record,-1);this.records.delete(id);changed=true}
    if(changed)this.revision++;
    return this;
  }
  // Vision-blocking buildings occlude cells behind them, never themselves or
  // the source inside them. A change repaints every source.
  syncBlockers(state){
    const blockers=[];
    for(const b of state.buildings||[]){
      if(b.alive===false||!(b.hp>0))continue;
      const d=BuildingDefinition.get(b.type);if(!d?.blocksVision&&!d?.blocksAirVision)continue;
      blockers.push({x:b.x,y:b.y,r:(d.size||35)+NAV_BUILDING_MARGIN,ground:!!d.blocksVision,air:!!d.blocksAirVision});
    }
    const key=blockers.map(b=>`${b.x},${b.y},${b.r},${b.ground?1:0}${b.air?1:0}`).join(";");
    if(key===this.blockerKey)return;
    this.blockerKey=key;this.blockers=blockers;this.buildingGround.fill(0);this.buildingAir.fill(0);
    const {cols,rows}=this.raster,cell=VisionField.CELL;
    blockers.forEach((b,i)=>{
      for(let cy=Math.max(0,Math.floor((b.y-b.r)/cell));cy<=Math.min(rows-1,Math.floor((b.y+b.r)/cell));cy++)
        for(let cx=Math.max(0,Math.floor((b.x-b.r)/cell));cx<=Math.min(cols-1,Math.floor((b.x+b.r)/cell));cx++){
          if(Math.hypot((cx+.5)*cell-b.x,(cy+.5)*cell-b.y)>=b.r)continue;
          const c=cy*cols+cx;if(b.ground)this.buildingGround[c]=i+1;if(b.air)this.buildingAir[c]=i+1;
        }
    });
    for(const record of this.records.values())this.apply(record,-1);
    this.records.clear();this.revision++;
  }
  paint(s,key,mode,origin){
    const cell=VisionField.CELL,{cols,rows,level,ground,air}=this.raster,sight=Math.max(0,Number(s.r)||0),detect=Math.max(0,Number(s.detect)||0);
    const reach=Math.max(sight,detect)/cell,sight2=(sight/cell)**2,detect2=(detect/cell)**2,reach2=reach*reach,table=VisionField.offsets(Math.ceil(reach));
    if(this.pass.length<table.d2.length)this.pass=new Uint8Array(table.d2.length);
    if(this.scratch.length<table.d2.length)this.scratch=new Int32Array(table.d2.length);
    const pass=this.pass,cells=this.scratch,ox=origin%cols,oy=(origin-ox)/cols,sourceLevel=Number(s.level)||0;
    const own=this.blockers.findIndex(b=>Math.hypot(s.x-b.x,s.y-b.y)<b.r)+1,occluder=mode===VisionField.MODE_AIR?this.buildingAir:this.buildingGround;
    // A zero radius sees nothing, not its own cell.
    let count=0,visionCount=0,detectCount=0;
    for(let i=0;i<table.d2.length;i++){
      const d2=table.d2[i];if(d2>reach2)break;
      const x=ox+table.dx[i],y=oy+table.dy[i],parent=table.parent[i];
      if(x<0||y<0||x>=cols||y>=rows||(parent>=0&&!pass[parent])){pass[i]=0;continue}
      const c=y*cols+x;let seen=true;
      if(mode===VisionField.MODE_AIR)seen=!air[c];
      else if(mode===VisionField.MODE_GROUND)seen=!ground[c]&&(parent<0||level[c]<=sourceLevel);
      pass[i]=seen&&(mode===VisionField.MODE_IGNORE||!occluder[c]||occluder[c]===own)?1:0;
      if(!seen)continue;
      cells[count++]=c;if(sight>0&&d2<=sight2)visionCount=count;if(detect>0&&d2<=detect2)detectCount=count;
    }
    const ceiling=mode===VisionField.MODE_GROUND?sourceLevel:VisionField.AIR_CEILING;
    return{key,ceiling,cells:cells.slice(0,Math.max(visionCount,detectCount)),visionCount,detectCount,epoch:0};
  }
  counts(map,ceiling){let counts=map.get(ceiling);if(!counts)map.set(ceiling,counts=new Uint16Array(this.size));return counts}
  apply(record,delta){
    const {cells,visionCount,detectCount,ceiling}=record;
    if(visionCount){const counts=this.counts(this.vision,ceiling);for(let i=0;i<visionCount;i++){counts[cells[i]]+=delta;this.visionAny[cells[i]]+=delta}}
    if(detectCount){const counts=this.counts(this.detection,ceiling);for(let i=0;i<detectCount;i++){counts[cells[i]]+=delta;this.detectAny[cells[i]]+=delta}}
  }
  lit(map,any,x,y,targetAir,targetLevel){
    const c=this.cellAt(x,y);if(!any[c])return false;if(targetAir)return true;
    for(const [ceiling,counts] of map)if(ceiling>=targetLevel&&counts[c])return true;
    return false;
  }
  visibleAt(x,y,targetAir=false,targetLevel=targetAir?null:this.terrain.surfaces.levelAt(x,y)){return this.lit(this.vision,this.visionAny,x,y,targetAir,targetLevel)}
  detectedAt(x,y,targetAir=false,targetLevel=targetAir?null:this.terrain.surfaces.levelAt(x,y)){return this.lit(this.detection,this.detectAny,x,y,targetAir,targetLevel)}
  // Highest ground level seen at a point: Infinity for air sight, -Infinity for none.
  ceilingAt(x,y){
    const c=this.cellAt(x,y);if(!this.visionAny[c])return -Infinity;
    let best=-Infinity;for(const [ceiling,counts] of this.vision)if(counts[c]&&ceiling>best)best=ceiling;
    return best>=VisionField.AIR_CEILING?Infinity:best;
  }
}
class TerrainQuery{
  static at(map,x,y,atlas=null){
    const terrain=MapGeneration.mapTerrainDescriptor(map);
    const bridge=(terrain.bridges||[]).find(b=>MapGeometry.pointInBridgeZone(x,y,b,0))||null;
    let river=false;
    if(!bridge){
      river=MapGeometry.pointInSimplePolygon(x,y,terrain.riverPolygon||[]);
      if(!river)for(const poly of terrain.riverBranchPolygons||[])if(MapGeometry.pointInSimplePolygon(x,y,poly)){river=true;break}
      if(!river&&(!terrain.riverPolygon||terrain.riverPolygon.length<3)){
        river=(terrain.riverPath||[]).length>1&&MapGeometry.pointPolylineDist(x,y,terrain.riverPath)<=terrain.riverHalfWidth;
        if(!river)for(const branch of terrain.riverBranches||[])if(branch.length>1&&MapGeometry.pointPolylineDist(x,y,branch)<=terrain.riverHalfWidth*.72){river=true;break}
      }
    }
    const surface=(atlas||(map?TerrainSurfaceAtlas.fromMap(map):null))?.sample(x,y)||{elevation:0,level:0,ramp:null};
    const raised=surface.layer&&surface.level>(surface.layer.parent?.level??0);
    return{river:surface.elevation>0||raised||surface.ramp?false:river,bridge,level:surface.level,height:TerrainSurfaceAtlas.levelForElevation(surface.elevation),surfaceElevation:surface.elevation,terrainLayer:surface.level,ramp:surface.ramp?.id||null,rampProgress:surface.ramp?RangeUtil.clamp(Number(surface.progress)||0,0,1):null};
  }
}
// Tracks authoritative obstacle values without per-tick filter/map/string allocation.
// Direct writes by trusted campaign scripts are still noticed on the next sync.
class NavigationTopology{
  constructor(){this.records=[];this.byId=new Map();this.changes=[];this.version=0;this.scans=0}
  refresh(buildings){
    this.scans++;let count=0,changed=this.version===0;
    for(const b of buildings)if(b.alive!==false&&b.hp>0){count++;const old=this.byId.get(b.id),d=BuildingDefinition.get(b.type),r=(d?.size||35)+NAV_BUILDING_MARGIN;
      if(!old||old.type!==b.type||old.x!==b.x||old.y!==b.y||old.r!==r||old.terrainBarrier!==!!d?.isTerrainBarrier||old.blocksVision!==!!d?.blocksVision||old.blocksProjectile!==!!d?.blocksProjectile||old.blocksAirVision!==!!d?.blocksAirVision)changed=true;
    }
    if(!changed&&count===this.records.length)return false;
    const old=new Map(this.byId),records=[],changes=[];
    for(const b of buildings)if(b.alive!==false&&b.hp>0){const d=BuildingDefinition.get(b.type),r=(d?.size||35)+NAV_BUILDING_MARGIN;
      const next={id:b.id,type:b.type,x:b.x,y:b.y,r,terrainBarrier:!!d?.isTerrainBarrier,blocksVision:!!d?.blocksVision,blocksProjectile:!!d?.blocksProjectile,blocksAirVision:!!d?.blocksAirVision,minX:b.x-r,maxX:b.x+r,minY:b.y-r,maxY:b.y+r},previous=old.get(b.id);
      if(!previous||Object.keys(next).some(key=>next[key]!==previous[key])){if(previous)changes.push(previous);changes.push(next)}
      records.push(next);old.delete(b.id);
    }
    changes.push(...old.values());this.changes=changes;
    if(!changes.length&&this.version>0)return false;
    this.records=records.sort((a,b)=>String(a.id)<String(b.id)?-1:String(a.id)>String(b.id)?1:0);this.byId=new Map(this.records.map(b=>[b.id,b]));
    this.version++;return true;
  }
}

export { BuildPrerequisitePolicy, Building, DelayedEffectState, NavigationTopology, Projectile, SupplyPolicy, TerrainQuery, Unit, VisibilityPolicy, VisionField };
