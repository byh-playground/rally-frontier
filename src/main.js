import { GameRuleDefinition, RangeUtil, SIM_TPS } from './core/game-rules.js';
import { GrainFaceOverlay } from './core/grain-face-overlay.js';
import { StrategySim } from './sim/strategy-sim.js';
import { BuildPrerequisitePolicy, TerrainQuery, Unit, VisibilityPolicy, VisionField } from './sim/entities.js';
import './sim/unit-behaviors.js';
import { ChargedSkillMixin, CloakAuraMixin } from './sim/unit-mixins.js';
import { BurrowableMixin, ChargedSkillGeometry } from './sim/components.js';
import { BotController } from './ai/bot-controller.js';
import './ai/ai-policy.js';
import { GameSession, RallySynctestDiagnostics } from './session/game-session.js';
import { ReplayPlayer, ReplayPolicy, ReplayRecorder } from './session/replay.js';
import { ActiveViewState, BACKGROUND_TICK_SESSIONS, BattlePresentationCache, NetworkModuleLoader } from './session/runtime-state.js';
import { LaunchRules } from './sim/launch-rules.js';
import './sim/spatial-grids.js';
import { LoopbackTransport, NostrRtcTransport } from './net/rtc-transport.js';
import { RecoveryTelemetry } from './diagnostics/recovery-telemetry.js';
import { ConnectionRoleUtil, ConnectionSideUtil, StableSerializationUtil } from './net/lobby-codec.js';
import { CloneUtil, HashUtil, MapGeneration } from './sim/map-generation.js';
import { ABILITY_INFO } from './definitions/balance.js';
import { ABILITY_RESEARCH_COSTS, ARMOR_REDUCTION_PCT_PER_LEVEL, ATTACK_UPGRADE_PCT_PER_LEVEL, AttackPresentationDefinition, BodyPulsePresentation, ResearchDefinition, UnitSpecialResearchDefinition } from './definitions/research.js';
import { BuildingDefinition, buildingPlacementInsideWorld, buildingPlacementSeparation } from './definitions/buildings.js';
import { DAMAGE_CLASS_LABEL, DAMAGE_CLASS_MATRIX, DECK_SLOT_COUNT, DECK_TOTAL_CARD_COUNT, DeckCardRuleDefinition, DefenseCardDefinition, SIZE_CLASS_LABEL } from './definitions/decks.js';
import { COMBAT_UNITS, ECONOMY_WORKER_DEF, UnitDefinition, UnitFactionPalette, UnitVisualDefinition } from './definitions/units.js';
import { CampDefinition, MAIN_OBJECTIVE_RESPAWN_MS, NEUTRAL_SIDE, NeutralCampPolicy, OBJECTIVE_DRAGON_BREATH_PHASE, PassiveCardDefinition, SpellDefinition, UnitCompositionDefinition } from './definitions/cards.js';
import { MapGeometry } from './sim/map-geometry.js';
import { CAPTURE_DURATION_MS, CAPTURE_RADIUS, DEFENSE_CLUSTER_RADIUS, LANE_CONTROL_POINTS, MINERAL_BUILD_MARGIN, PRODUCTION_CLUSTER_RADIUS, PRODUCTION_CLUSTER_SPEED_PCT, SPELL_MASTERY_MAX, SPELL_SLOT_MAX, TACTICAL_CHEST_OPTION_COUNT } from './definitions/combat-rules.js';
import { PerformanceTelemetry } from './diagnostics/performance-telemetry.js';
import './definitions/formations.js';
import { BASE_SUPPLY, GAS_ASSIGNMENT_MAX, GAS_DEPLETED_MINE_AMOUNT, GAS_MINE_AMOUNT, ROGUE_LEAP_ARC_HEIGHT, STARTING_WORKER_COUNT, VIEW_H, VIEW_W, WORKER_CARRY_CAP, WORKER_COST, WORKER_QUEUE_LIMIT } from './definitions/world-rules.js';
import { WorldContext } from './sim/world-context.js';
import { NavigationGoal, NavigationMeshBuilder } from './sim/navigation.js';
import { BattlefieldProjection, PolygonTriangulation, TerrainGeometry, TerrainSurfaceAtlas, TerrainSurfaceProjection } from './sim/terrain.js';
import { BACKGROUND_TICK_PULSE_MS, DISCONNECT_GRACE_MS } from './core/session-timing.js';
import { RENDER_TRACKS } from './render/render-tracks.js';
import { CHARGED_SKILL_DRAG_PX, CHARGED_SKILL_HOLD_MS, CONFIG, GAS_WORKER_UI_DEBOUNCE_MS, PREDICTED_BUILD_GHOST_TTL_MS, PREDICTED_COMMAND_FX_TTL_MS, SIM_VERSION, STATE_PUBLISH_HZ, STATE_PUBLISH_INTERVAL_MS, netcodeMode } from './core/config.js';
import { BUILD_META } from './core/build-info.js';
import { RallyGamekit, RallyNetcode, SIM_WORKER } from './core/gamekit.js';
import { LaunchScreens } from './ui/launch-screens.js';
import { grainPortrait } from './ui/grain-portrait.js';
import { readDevQuery } from './ui/dev-query.js';

// The Worker realm has no window; GameKit modules must still see it as non-browser.
const window=globalThis;

/* =========================
   5. WebGL renderer + fog
   ========================= */

// Renderer-only reuse helpers. They never enter StrategySim/checksum/export/recovery.
// The goal is to remove short-lived allocations from 60 fps geometry/VFX, 20 Hz render targets, and 10 Hz full snapshots.
class ArcTetherPresentation{
  static phase({elapsedMs=0,travelMs=0,holdMs=0,retractMs=0,retract=false}={}){
    const travel=Math.max(1,Number(travelMs)||1),hold=Math.max(0,Number(holdMs)||0),back=Math.max(1,Number(retractMs)||travel);
    const elapsed=Math.max(0,Number(elapsedMs)||0);
    if(elapsed<travel)return{kind:"extend",progress:RangeUtil.clamp(elapsed/travel,0,1)};
    if(!retract)return{kind:"hold",progress:1};
    if(elapsed<travel+hold)return{kind:"hold",progress:1};
    return{kind:"retract",progress:1-RangeUtil.clamp((elapsed-travel-hold)/back,0,1)};
  }
  static sample({sourceWorld,targetWorld,baseArcHeight=90,referenceDistance=1,samples=12,extent=1}={}){
    if(!sourceWorld||!targetWorld)return[];
    const sx=Number(sourceWorld.x)||0,sz=Number(sourceWorld.z)||0,sy=Number(sourceWorld.y)||0;
    const tx=Number(targetWorld.x)||0,tz=Number(targetWorld.z)||0,ty=Number(targetWorld.y)||0;
    const distance=Math.hypot(tx-sx,tz-sz),ratio=RangeUtil.clamp(distance/Math.max(1,Number(referenceDistance)||1),0,1);
    const arc=Math.max(0,Number(baseArcHeight)||0)*ratio,visible=RangeUtil.clamp(Number(extent),0,1);
    const n=Math.max(3,Math.round(Number(samples)||12)),points=[];
    for(let i=0;i<n;i++){
      const q=(i/(n-1))*visible;
      const x=sx+(tx-sx)*q,z=sz+(tz-sz)*q;
      const y=sy+(ty-sy)*q+Math.sin(q*Math.PI)*arc;
      points.push({x,y,z,groundY:0,motion:"arcTether",progress:q});
    }
    return points;
  }
  // Reusable lifecycle contract:
  // extend -> optional hold/live tether -> optional retract.
  // Consumers own only endpoints and timing. Curve/height/retraction stay presentation-only.
  static resolve({sourceWorld,targetWorld,referenceDistance,baseArcHeight,samples,elapsedMs,travelMs,holdMs=0,retractMs=0,retract=false}={}){
    const phase=this.phase({elapsedMs,travelMs,holdMs,retractMs,retract});
    return{phase,points:this.sample({sourceWorld,targetWorld,referenceDistance,baseArcHeight,samples,extent:phase.progress})};
  }
}

class ReusableFloat32Buffer{
  constructor(initialCapacity=65536){
    let cap=1;while(cap<initialCapacity)cap<<=1;
    this.data=new Float32Array(cap);this.length=0;this.grows=0;
  }
  reset(){this.length=0}
  ensure(extra){
    const need=this.length+extra;if(need<=this.data.length)return;
    let cap=this.data.length||1;while(cap<need)cap<<=1;
    const next=new Float32Array(cap);next.set(this.data.subarray(0,this.length));
    this.data=next;this.grows++;
  }
  push5(a,b,c,d,e){
    this.ensure(5);const i=this.length,v=this.data;
    v[i]=a;v[i+1]=b;v[i+2]=c;v[i+3]=d;v[i+4]=e;
    this.length=i+5;
  }
  push7(a,b,c,d,e,f,g){
    this.ensure(7);const i=this.length,v=this.data;
    v[i]=a;v[i+1]=b;v[i+2]=c;v[i+3]=d;v[i+4]=e;v[i+5]=f;v[i+6]=g;
    this.length=i+7;
  }
  view(){return this.data.subarray(0,this.length)}
}

/* Render-position contract:
   Every continuous moving visual, including bodies, strategic markers, facing origins,
   construction poses, hidden/burrow ground markers, trails and moving VFX endpoints,
   reads registered x/y through RenderStateStore. Snapshot x/y remains authoritative for gameplay,
   visibility/detection and checksum; presentation must not bypass interpolation merely
   because the unit body itself is hidden. */
// Game-owned identity/discontinuity policy; the gamekit timeline owns interpolation.
class RenderStateStore{
  constructor(definitions){this.definitions=definitions;this.records=new Map();this.generation=0;this.revision=0;this.sequence=0;this.clock=0;this.zeroDelta=Object.freeze({x:0,y:0});this.lists={unit:[],projectile:[],flag:[]}}
  time(now){return this.clock=Math.max(this.clock,Number(now)||0)}
  capture(source,now,snap,stepMs){
    const at=this.time(now),tick=Number(source.tick)||0;
    if(!this.runtime||this.stepMs!==stepMs){
      this.stepMs=stepMs;
      // Keep two fixed samples buffered, matching GameKit's 10 TPS / 200 ms frame example.
      this.runtime=new RallyGamekit.PresentationRuntime({stepMs,delayMs:stepMs*2});
      snap=true;
    }
    // A reset rebases the timeline only. Live identities and their metadata copies
    // stay; re-cloning every entity here made an overloaded frame heavier still.
    if(snap)this.revision++;
    const entities=[],seen=new Set();
    const add=(kind,id,value)=>{
      const key=kind+":"+id,def=this.definitions[kind];let record=this.records.get(key);
      const previous=record?.live?record:null;
      if(!previous){
        // One detached visual identity at birth. Ordinary metadata is refreshed by
        // the existing UI snapshot cadence, never by cloning the sim each frame.
        record={kind,id,generation:++this.generation,entity:value.toState?value.toState("view"):structuredClone(value),delta:{x:0,y:0}};
        this.records.set(key,record);
      }else if(snap&&!value.toState)record.entity=structuredClone(value);
      const teleport=!!previous&&Math.hypot(value.x-record.x,value.y-record.y)>def.snapDistance*Math.max(1,tick-record.tick);
      record.delta.x=snap||teleport||!previous?0:value.x-record.x;record.delta.y=snap||teleport||!previous?0:value.y-record.y;
      record.x=value.x;record.y=value.y;record.tick=tick;record.live=true;seen.add(key);
      const packet={id:key,generation:record.generation,type:def.type,source:{entity:value,tick,delta:record.delta},teleport};
      if(kind==="projectile"&&!previous&&!snap&&Number.isFinite(value.launchX)&&Number.isFinite(value.launchY)){
        packet.initialSource={entity:{...value,x:value.launchX,y:value.launchY},tick:tick-1};packet.initialTimeMs=(tick-1)*stepMs;
      }
      entities.push(packet);
    };
    for(const unit of source.units||[])if(unit.alive!==false)add("unit",unit.id,unit);
    for(const projectile of source.projectiles||[])if(projectile.alive!==false)add("projectile",projectile.id,projectile);
    for(let side=0;side<(source.flags||[]).length;side++)if(source.flags[side])add("flag",side,source.flags[side]);
    for(const [key,record]of this.records)if(!seen.has(key))record.live=false;
    this.runtime.capture({revision:this.revision,sequence:++this.sequence,timeMs:tick*stepMs,mode:snap?"reset":"continuous",entities},at);
    this.frameAt=NaN;
  }
  updateMetadata(snapshot){
    for(const kind of ["unit","projectile"]){
      for(const entity of snapshot[kind==="unit"?"units":"projectiles"]||[]){
        const record=this.records.get(kind+":"+entity.id);if(record&&entity.alive!==false)record.entity=entity;
      }
    }
  }
  frame(now){
    const at=this.time(now);if(this.frameAt===at)return this.currentFrame;
    this.frameAt=at;for(const list of Object.values(this.lists))list.length=0;
    this.currentFrame=this.runtime?.frame(at);const displayed=new Set();
    this.currentFrame?.forEach((model,key)=>{const record=this.records.get(key);if(record){displayed.add(key);record.model=model;this.lists[record.kind].push(record.entity)}});
    for(const [key,record]of this.records){if(!displayed.has(key)){record.model=null;if(!record.live)this.records.delete(key)}}
    return this.currentFrame;
  }
  model(kind,id,now=performance.now()){this.frame(now);return this.records.get(kind+":"+id)?.model||null}
  has(kind,id,now=performance.now()){return !!this.model(kind,id,now)}
  position(kind,id,source,now=performance.now()){
    return this.model(kind,id,now)?.entity||{x:Number(source?.x)||0,y:Number(source?.y)||0};
  }
  displayed(kind,now){this.frame(now);return this.lists[kind]}
  entity(kind,id){return this.records.get(kind+":"+id)?.entity||null}
  delta(kind,id){return this.records.get(kind+":"+id)?.model?.delta||this.zeroDelta}
  clear(){this.records.clear();this.runtime=null;this.frameAt=NaN;for(const list of Object.values(this.lists))list.length=0}
}
class FloatingTextPresentationDefinition{
  static presets=Object.freeze({
    damageTaken:Object.freeze({lifeMs:600,baseSize:15,minSize:10,rise:30,alpha:.8,strokeAlpha:.8,pop:1}),
    damageDealt:Object.freeze({lifeMs:600,baseSize:15,minSize:10,rise:30,alpha:.8,strokeAlpha:.8,pop:1}),
    heal:Object.freeze({lifeMs:600,baseSize:15,minSize:10,rise:30,alpha:.8,strokeAlpha:.8,pop:1}),
    dodge:Object.freeze({lifeMs:750,baseSize:15,minSize:10,rise:30,alpha:.8,strokeAlpha:.8,pop:1}),
    manaSpend:Object.freeze({lifeMs:750,baseSize:20,minSize:10,rise:40,alpha:.8,strokeAlpha:.8,pop:1}),
    income:Object.freeze({lifeMs:1000,baseSize:25,minSize:15,rise:60,alpha:.9,strokeAlpha:.9,pop:1.1}),
    gasIncome:Object.freeze({lifeMs:1000,baseSize:25,minSize:15,rise:60,alpha:.9,strokeAlpha:.9,pop:1.1})
  });
  static get(kind){return this.presets[kind]||this.presets.damageDealt}
}

class EffectObjectFactory{
  static makeFloatFx(){return {x:0,y:0,kind:"",text:"",amount:0,start:0,jitter:0,lane:0}}
  static resetFloatFx(v){v.x=0;v.y=0;v.kind="";v.text="";v.amount=0;v.start=0;v.jitter=0;v.lane=0}
  static makeShakeFx(){return {start:0,duration:0,intensity:0,seed:0}}
  static resetShakeFx(v){v.start=0;v.duration=0;v.intensity=0;v.seed=0}
  static makeFlagFx(){return {x:0,y:0,side:0,forced:false,start:0,seed:0}}
  static resetFlagFx(v){v.x=0;v.y=0;v.side=0;v.forced=false;v.start=0;v.seed=0}
  static makeCombatFx(){return {kind:"",x:0,y:0,x2:0,y2:0,sourceType:"",targetType:"",entity:"",spell:"",amount:0,radius:0,width:0,airborneHeight:0,airborneMs:0,durationTicks:0,remaining:0,sourceId:null,targetId:null,fromX:null,fromY:null,isBuilding:false,points:null,side:null,start:0,seed:0,_extraKeys:null}}
  static resetCombatFx(v){if(v._extraKeys){for(const k of v._extraKeys)delete v[k];v._extraKeys=null}v.kind="";v.x=v.y=v.x2=v.y2=0;v.sourceType=v.targetType=v.entity=v.spell="";v.amount=v.radius=v.width=v.airborneHeight=v.airborneTicks=v.durationTicks=v.remaining=0;v.sourceId=v.targetId=null;v.fromX=v.fromY=null;v.isBuilding=false;v.points=null;v.side=null;v.start=v.seed=0}
}

// Shared renderer-only elemental VFX pool. Fire and electric effects share one manager,
// while typed sub-pools keep the hot paths compact and avoid oversized polymorphic objects.
// Nothing here enters StrategySim/checksum/export/recovery.
class EffectPresetDefinition{
  static presets=Object.freeze({
  fireBreath:Object.freeze({
    spawnRate:420,maxParticles:260,warmupParticles:8,
    lifetimeMin:.50,lifetimeMax:.72,visualRangeMul:1.00,travelRangeMin:.62,travelRangeMax:1.00,edgeShare:.24,
    sizeBase:5.4,sizeWave:8.4,startFade:.08,endFade:.18,
    hotColor:"#ffe07a",midColor:"#ff8a2b",coolColor:"#df4a1d"
  }),
  poisonBreath:Object.freeze({
    spawnRate:420,maxParticles:260,warmupParticles:8,
    lifetimeMin:.50,lifetimeMax:.72,visualRangeMul:1.00,travelRangeMin:.62,travelRangeMax:1.00,edgeShare:.24,
    sizeBase:5.4,sizeWave:8.4,startFade:.08,endFade:.18,
    hotColor:"#e9ff82",midColor:"#78d83e",coolColor:"#2b8b46"
  }),
  // Fire-ant breath: compact, dense orange flame rather than the toad's poison cloud.
  fireAntBreath:Object.freeze({
    spawnRate:520,maxParticles:220,warmupParticles:10,
    lifetimeMin:.30,lifetimeMax:.48,visualRangeMul:1.00,travelRangeMin:.70,travelRangeMax:1.00,edgeShare:.12,
    sizeBase:3.8,sizeWave:5.8,startFade:.05,endFade:.14,
    hotColor:"#fff09a",midColor:"#ff9b32",coolColor:"#d94718"
  }),
  electricArc:Object.freeze({
    segmentLength:28,minSegments:4,maxSegments:14,
    minAmplitude:8,maxAmplitude:26,amplitudeRatio:.085,
    underColor:"#397b94",coreColor:"#b8efff"
  })
});
}

class CommonEffectObjectFactory{
  static makeCommonFireParticle(){return {age:0,lifetime:0,seed:0,angleUnit:0,sizeScale:1,driftPhase:0,lateralBias:0,travelRangeFactor:1}}
  static resetCommonFireParticle(p){p.age=0;p.lifetime=0;p.seed=0;p.angleUnit=0;p.sizeScale=1;p.driftPhase=0;p.lateralBias=0;p.travelRangeFactor=1}
  static makeCommonEmitter(){return {key:"",preset:"",particles:[],spawnCarry:0,nextSeed:1,touched:false,centerX:0,centerY:0,mouthX:0,mouthY:0,dirX:1,dirY:0,range:0,halfAngle:0,scale:1}}
  static resetCommonEmitter(e){e.key="";e.preset="";e.particles.length=0;e.spawnCarry=0;e.nextSeed=1;e.touched=false;e.centerX=e.centerY=e.mouthX=e.mouthY=0;e.dirX=1;e.dirY=0;e.range=e.halfAngle=0;e.scale=1}
  static makeElectricArcScratch(){return {points:new Float32Array(30),count:0}}
  static resetElectricArcScratch(a){a.count=0}
}

class CommonEffectPool{
  constructor(renderer){
    this.renderer=renderer;
    this.fireParticlePool=new RallyGamekit.ObjectPool(CommonEffectObjectFactory.makeCommonFireParticle,CommonEffectObjectFactory.resetCommonFireParticle,640);
    this.emitterPool=new RallyGamekit.ObjectPool(CommonEffectObjectFactory.makeCommonEmitter,CommonEffectObjectFactory.resetCommonEmitter,32);
    this.electricArcScratchPool=new RallyGamekit.ObjectPool(CommonEffectObjectFactory.makeElectricArcScratch,CommonEffectObjectFactory.resetElectricArcScratch,24);
    this.emitters=new Map();
    this.lastFrameAt=performance.now();
    this.now=this.lastFrameAt;
    this.deltaSec=0;
  }
  rand01(n){
    n=(n^61)^(n>>>16);n=Math.imul(n,9);n=n^(n>>>4);n=Math.imul(n,0x27d4eb2d);n=n^(n>>>15);
    return(n>>>0)/4294967295;
  }
  beginFrame(now=performance.now()){
    this.now=now;
    this.deltaSec=Math.min(1/15,Math.max(0,(now-this.lastFrameAt)/1000));
    this.lastFrameAt=now;
    for(const emitter of this.emitters.values()){
      emitter.touched=false;
      let write=0;
      for(let i=0;i<emitter.particles.length;i++){
        const p=emitter.particles[i];p.age+=this.deltaSec;
        if(p.age>=p.lifetime){this.fireParticlePool.release(p);continue}
        emitter.particles[write++]=p;
      }
      emitter.particles.length=write;
    }
  }
  _spawnFireParticle(emitter,preset,ageProgress=0){
    if(emitter.particles.length>=preset.maxParticles)return;
    const p=this.fireParticlePool.acquire(),seed=HashUtil.hash(`${emitter.key}|${emitter.nextSeed++}`);
    const a=this.rand01(seed),b=this.rand01(seed^0x9e3779b9),c=this.rand01(seed^0x85ebca6b),d=this.rand01(seed^0xc2b2ae35);
    const signed=a*2-1;
    p.angleUnit=b<preset.edgeShare?signed:Math.sign(signed||1)*Math.pow(Math.abs(signed),1.48);
    p.lifetime=preset.lifetimeMin+(preset.lifetimeMax-preset.lifetimeMin)*c;
    p.age=Math.min(p.lifetime*.94,Math.max(0,p.lifetime*ageProgress));
    p.seed=seed;p.sizeScale=.84+.34*d;p.driftPhase=b*Math.PI*2;p.lateralBias=this.rand01(seed^0x27d4eb2d)*2-1;
    const travelRnd=this.rand01(seed^0x165667b1),travelMin=RangeUtil.clamp(Number(preset.travelRangeMin??1),0,1),travelMax=RangeUtil.clamp(Number(preset.travelRangeMax??1),travelMin,1);
    p.travelRangeFactor=travelMin+(travelMax-travelMin)*travelRnd;
    emitter.particles.push(p);
  }
  touchFireEmitter(key,{preset="fireBreath",centerX,centerY,mouthX,mouthY,dirX,dirY,range,halfAngle,scale=1}={}){
    const config=EffectPresetDefinition.presets[preset]||EffectPresetDefinition.presets.fireBreath;
    let emitter=this.emitters.get(key);
    if(!emitter){
      emitter=this.emitterPool.acquire();emitter.key=key;emitter.preset=preset;
      emitter.nextSeed=(HashUtil.hash(key)%100000)+1;this.emitters.set(key,emitter);
      for(let i=0;i<config.warmupParticles;i++)this._spawnFireParticle(emitter,config,(i/config.warmupParticles)*.08);
    }
    emitter.touched=true;emitter.preset=preset;emitter.centerX=Number(centerX)||0;emitter.centerY=Number(centerY)||0;
    emitter.mouthX=Number(mouthX)||0;emitter.mouthY=Number(mouthY)||0;
    const len=Math.hypot(Number(dirX)||0,Number(dirY)||0)||1;emitter.dirX=(Number(dirX)||0)/len;emitter.dirY=(Number(dirY)||0)/len;
    emitter.range=Math.max(0,Number(range)||0);emitter.halfAngle=Math.max(0,Number(halfAngle)||0);emitter.scale=Math.max(.1,Number(scale)||1);
    emitter.spawnCarry+=config.spawnRate*this.deltaSec;
    let spawn=Math.min(32,Math.floor(emitter.spawnCarry));emitter.spawnCarry-=spawn;
    while(spawn-->0&&emitter.particles.length<config.maxParticles)this._spawnFireParticle(emitter,config,0);
  }
  _drawFlatFireParticle(ctx,x,y,size,angle,color,alpha){
    ctx.save();ctx.translate(x,y);ctx.rotate(angle);ctx.globalAlpha=alpha;ctx.fillStyle=color;
    // Flat quadrilateral particle, matching the game's existing procedural shape language.
    ctx.beginPath();ctx.moveTo(size*.78,0);ctx.lineTo(-size*.48,-size*.42);ctx.lineTo(-size*.72,0);ctx.lineTo(-size*.48,size*.42);ctx.closePath();ctx.fill();
    ctx.restore();
  }
  drawFire(ctx){
    const renderer=this.renderer;
    for(const emitter of this.emitters.values()){
      if(!emitter.particles.length)continue;
      const preset=EffectPresetDefinition.presets[emitter.preset]||EffectPresetDefinition.presets.fireBreath;
      const maxVisualRange=emitter.range*preset.visualRangeMul;
      for(const p of emitter.particles){
        const q=RangeUtil.clamp(p.age/p.lifetime,0,1);
        const drift=Math.sin(q*Math.PI*2+p.driftPhase+this.now*.006)*emitter.halfAngle*.024*(.2+.8*q);
        const off=RangeUtil.clamp(p.angleUnit*emitter.halfAngle+drift,-emitter.halfAngle*.995,emitter.halfAngle*.995);
        const ca=Math.cos(off),sa=Math.sin(off),rdx=emitter.dirX*ca-emitter.dirY*sa,rdy=emitter.dirX*sa+emitter.dirY*ca;
        // Each flame packet owns a fixed randomized travel distance. The simulation
        // range is only the outer envelope; particles terminate at different depths.
        const particleRange=maxVisualRange*RangeUtil.clamp(p.travelRangeFactor||1,0,1);
        const end=renderer.worldToPx(renderer.viewX(emitter.centerX+rdx*particleRange),renderer.viewY(emitter.centerY+rdy*particleRange));
        const vx=end[0]-emitter.mouthX,vy=end[1]-emitter.mouthY,len=Math.hypot(vx,vy)||1,px=-vy/len,py=vx/len;
        const travel=Math.pow(q,.94);
        const widthEnvelope=Math.sin(Math.PI*travel);
        const jitter=(p.lateralBias*(2+6.5*travel)+Math.sin(p.seed*.013+q*11)*1.6)*emitter.scale*widthEnvelope;
        const x=emitter.mouthX+vx*travel+px*jitter,y=emitter.mouthY+vy*travel+py*jitter;
        const centerBias=1-Math.min(1,Math.abs(off)/(emitter.halfAngle||1));
        const size=(preset.sizeBase+preset.sizeWave*Math.sin(Math.PI*q))*p.sizeScale*(.70+.30*centerBias)*emitter.scale;
        const fadeIn=RangeUtil.clamp(q/preset.startFade,0,1),fadeOut=RangeUtil.clamp((1-q)/preset.endFade,0,1);
        const alpha=(.52+.42*centerBias)*fadeIn*fadeOut;
        const color=q<.24?preset.hotColor:q<.58?preset.midColor:preset.coolColor;
        this._drawFlatFireParticle(ctx,x,y,size,Math.atan2(vy,vx),color,alpha);
      }
    }
  }
  drawElectricArc(ctx,from,to,{seed=1,time=this.now/1000,color=null,alpha=1,scale=1,width=1}={}){
    const preset=EffectPresetDefinition.presets.electricArc,arc=this.electricArcScratchPool.acquire(),points=arc.points;
    const dx=to.x-from.x,dy=to.y-from.y,distance=Math.hypot(dx,dy);
    if(distance<=.001){this.electricArcScratchPool.release(arc);return}
    const segmentCount=RangeUtil.clamp(Math.ceil(distance/Math.max(4,preset.segmentLength*scale)),preset.minSegments,preset.maxSegments);
    const perpX=-dy/distance,perpY=dx/distance;
    const amplitude=RangeUtil.clamp(distance*preset.amplitudeRatio,preset.minAmplitude*scale,preset.maxAmplitude*scale);
    arc.count=segmentCount+1;points[0]=from.x;points[1]=from.y;
    for(let i=1;i<segmentCount;i++){
      const q=i/segmentCount,envelope=Math.sin(q*Math.PI);
      const rapid=Math.sin(time*34+i*2.71+seed*.013),slow=Math.sin(time*15+i*7.93+seed*.031);
      const offset=(rapid*.72+slow*.28)*amplitude*envelope;
      points[i*2]=from.x+dx*q+perpX*offset;points[i*2+1]=from.y+dy*q+perpY*offset;
    }
    points[segmentCount*2]=to.x;points[segmentCount*2+1]=to.y;
    const stroke=(strokeColor,lineWidth,strokeAlpha)=>{
      ctx.globalAlpha=alpha*strokeAlpha;ctx.strokeStyle=strokeColor;ctx.lineWidth=Math.max(1,lineWidth*scale*width);ctx.lineCap="round";ctx.lineJoin="round";
      ctx.beginPath();ctx.moveTo(points[0],points[1]);for(let i=1;i<arc.count;i++)ctx.lineTo(points[i*2],points[i*2+1]);ctx.stroke();
    };
    ctx.save();ctx.globalCompositeOperation="source-over";
    stroke(preset.underColor,4.8,.46);stroke(color||preset.coreColor,2.1,.96);stroke("#f3fcff",.72,.88);
    ctx.restore();this.electricArcScratchPool.release(arc);
  }
  endFrame(){
    for(const[key,emitter]of this.emitters){
      if(emitter.touched)continue;
      if(emitter.particles.length)continue;
      this.emitters.delete(key);this.emitterPool.release(emitter);
    }
  }
}

/* Developer architecture contract:
   Perspective ownership: domain policy/query/presentation helpers belong to cohesive
   owner classes and consumers call Owner.method() directly. Definition data and its
   interpretation stay with the Definition owner. Do not expose this developer-only
   architecture contract in player-facing help/deck-selection UI. */
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
class DiagnosticPresentation{
  static journal=new RallyGamekit.DiagnosticRing({capacity:20,release:BUILD_META.id});
  static presentFatalDiagnostic(diag){
    this.journal.report(new Error(diag.message||diag.kind),{kind:diag.kind||'fatal',fatal:true,origin:diag.stage||'game'});
    diag={...diag,build:BUILD_META.id,buildMetadata:BUILD_META.snapshot(),gamekitDiagnostic:this.journal.snapshot()};
    const sink=window.__RALLY_PRESENT_FATAL__;
    if(typeof sink==="function"){sink(diag);return}
    window.__RALLY_FATAL_DIAGNOSTIC__=diag;
    console.error("[RALLY FRONTIER] diagnostic bootstrap unavailable",diag);
  }
}

// ============================================================
// Unit Visual Registry — species-specific composition boundary.
// IS-A UnitVisual. Shared pipeline is HAS-A. Runtime state remains CAN-BE.
// ============================================================
const UNIT_VISUAL_RENDER_FNS=Object.freeze({
  // Grain soldiers always draw their budmori SVG; this circle only shows if that asset is missing.
  "rice":(rdr,ctx)=>rdr.circle(ctx.x,ctx.y,ctx.r*.8,UnitVisualDefinition.get("rice").accent,12),
  "soybean":(rdr,ctx)=>rdr.circle(ctx.x,ctx.y,ctx.r*.8,UnitVisualDefinition.get("soybean").accent,12),
  "redbean":(rdr,ctx)=>rdr.circle(ctx.x,ctx.y,ctx.r*.8,UnitVisualDefinition.get("redbean").accent,12),
  "fireant":(rdr,ctx)=>{
    const {sc,x,y,r,ownStealthAlpha,teamDark,teamLight,dir}=ctx;
    {
      // Distinct ant silhouette: three body segments, six legs, antennae and a hot abdominal gland.
      // Team identity stays on the thorax rim while the species reads red/orange for both sides.
      const antDark=[.20,.055,.025,ownStealthAlpha],antBody=[.66,.12,.045,ownStealthAlpha],
        antHot=[1,.34,.07,ownStealthAlpha],antGlow=[1,.72,.18,.72*ownStealthAlpha];
      const facing=dir,headY=y+facing*r*.54,thoraxY=y,abdY=y-facing*r*.58;
      rdr.circle(x,abdY,r*.48,antDark,11);
      rdr.circle(x,abdY,r*.39,antBody,11);
      rdr.circle(x,thoraxY,r*.34,teamDark,10);
      rdr.circle(x,thoraxY,r*.27,antBody,10);
      rdr.circle(x,headY,r*.31,antDark,10);
      rdr.circle(x,headY,r*.24,antBody,10);
      // Six legs angle out from thorax/abdomen.
      for(const side of [-1,1]){
        rdr.line(x+side*r*.16,y+facing*r*.18,x+side*r*.72,y+facing*r*.42,Math.max(1,1.45*sc),antDark);
        rdr.line(x+side*r*.18,y,x+side*r*.78,y-facing*r*.02,Math.max(1,1.45*sc),antDark);
        rdr.line(x+side*r*.14,y-facing*r*.22,x+side*r*.68,y-facing*r*.48,Math.max(1,1.45*sc),antDark);
        rdr.line(x+side*r*.12,headY+facing*r*.12,x+side*r*.45,headY+facing*r*.55,Math.max(1,1.15*sc),antDark);
      }
      // Acid/fire gland telegraphs the unit's ranged identity without looking like a generic caster.
      rdr.circle(x,abdY-facing*r*.08,r*.16,antHot,8);
      rdr.circle(x,abdY-facing*r*.08,r*.08,antGlow,7);
      rdr.outlineCircle(x,thoraxY,r*.39,Math.max(1,1.5*sc),teamLight,12,1);
    
    }
  },
  "ancientbear":(rdr,ctx)=>{
    const {u,sc,x,y,r,factionPalette}=ctx;
    {
      // TOP main objective: preserve the established greatbear visual language, scaled up into a boss silhouette.
      const fur=[.53,.39,.22,1],furDark=[.28,.20,.12,1],furHi=[.68,.53,.30,1],pollen=[.78,.68,.34,1];
      rdr.circle(x,y+r*.12,r*1.14,furDark,16);
      rdr.circle(x,y+r*.04,r*1.00,fur,16);
      rdr.petalRing(x,y-r*.16,r*.72,8,pollen,Math.PI/8,.80);
      rdr.circle(x,y-r*.64,r*.70,furHi,14);
      rdr.circle(x-r*.48,y-r*1.05,r*.27,furDark,10);rdr.circle(x+r*.48,y-r*1.05,r*.27,furDark,10);
      rdr.circle(x-r*.21,y-r*.69,Math.max(1.4,r*.068),[.12,.08,.04,1],7);rdr.circle(x+r*.21,y-r*.69,Math.max(1.4,r*.068),[.12,.08,.04,1],7);
      rdr.circle(x,y-r*.46,r*.115,[.10,.06,.03,1],8);
      // Oversized forepaws sell the slam/charge weight without turning the creature into armor.
      rdr.circle(x-r*.82,y+r*.48,r*.46,furDark,11);rdr.circle(x+r*.82,y+r*.48,r*.46,furDark,11);
      rdr.circle(x-r*.82,y+r*.52,r*.34,fur,10);rdr.circle(x+r*.82,y+r*.52,r*.34,fur,10);
      const ownerRing=factionPalette.ring;
      rdr.outlineCircle(x,y,r*1.32,Math.max(1.6,2.4*sc),ownerRing,22,1);
      if(u.objectiveChargeActive)rdr.outlineCircle(x,y,r*1.42,Math.max(2,3.4*sc),[1,.68,.28,.52],24,1);
    
    }
  },
  "deathworm":(rdr,ctx)=>{
    const {u,sc,groundWorld,groundPos,x,y,r,factionPalette}=ctx;
    {
      // MID objective: eyeless flesh worm. The circular maw is the face.
      const flesh=[.73,.49,.39,1],fleshHi=[.86,.62,.51,1],fleshDark=[.48,.28,.24,1];
      const mouth=[.12,.045,.035,1],gum=[.48,.16,.13,1],tooth=[1,.88,.67,1];
      const soil=[.39,.29,.18,1],deep=[.08,.075,.055,1];
      const buried=BurrowableMixin.stateActive(u),hx=groundPos[0],hy=groundPos[1];
      rdr.withWorldSpriteDepth(groundWorld,()=>{
        rdr.circle(hx,hy+r*.46,r*.82,soil,16);
        rdr.circle(hx,hy+r*.46,r*.64,deep,16);
        for(let k=0;k<6;k++){
          const a=(k/6)*Math.PI*2+(HashUtil.hash(u.id)%97)*.013,rr=r*(.72+(k%2)*.18);
          rdr.circle(hx+Math.cos(a)*rr,hy+r*.46+Math.sin(a)*rr*.36,r*(.10+(k%3)*.018),k%2?[.52,.38,.20,1]:[.34,.25,.15,1],7);
        }
      });
      if(!buried){
        const baseY=hy+r*.20,topY=y-r*.88;
        // Segmented soft body: alternating flesh values read as folds, not green armor.
        for(let k=0;k<5;k++){
          const q=(k+.10)/4.25,yy=baseY+(topY-baseY)*q,xx=hx+(x-hx)*q;
          const rad=r*(.64-k*.045);
          rdr.circle(xx,yy,rad,k%2?flesh:fleshDark,14);
          rdr.circle(xx-rad*.10,yy-rad*.16,rad*.72,k%2?fleshHi:flesh,12);
        }
        // Head has NO eyes. Oversized round mouth is the only facial landmark.
        const headY=y-r*1.18,headR=r*.70;
        rdr.circle(x,headY,headR,fleshDark,16);
        rdr.circle(x-r*.07,headY-r*.07,headR*.88,flesh,15);
        const mouthR=r*.47;
        rdr.circle(x,headY-r*.03,mouthR,gum,18);
        rdr.circle(x,headY-r*.03,mouthR*.72,mouth,18);
        // Dense inward-facing teeth around the circular maw.
        const teeth=18;
        for(let k=0;k<teeth;k++){
          const a=(k/teeth)*Math.PI*2;
          const cx=x+Math.cos(a)*mouthR*.77,cy=headY-r*.03+Math.sin(a)*mouthR*.77;
          const tx=x+Math.cos(a)*mouthR*.45,ty=headY-r*.03+Math.sin(a)*mouthR*.45;
          rdr.line(cx,cy,tx,ty,Math.max(1.1,1.65*sc),tooth);
          rdr.circle(cx,cy,Math.max(.9,1.25*sc),tooth,5);
        }
        rdr.circle(x,headY-r*.03,mouthR*.29,[.035,.012,.010,1],12);
        // Subtle wet rim makes the maw readable without adding eyes/horns.
        rdr.outlineCircle(x,headY-r*.03,mouthR*.96,Math.max(1.2,1.8*sc),[.92,.54,.43,.65],20,1);
        if((u.objectiveAttackCount||0)%4===3)rdr.outlineCircle(x,headY-r*.03,mouthR*1.18,Math.max(1.5,2.3*sc),[1,.54,.26,.34],20,1);
      }else{
        rdr.withWorldSpriteDepth(groundWorld,()=>rdr.circle(hx,hy+r*.40,r*.36,[.72,.43,.34,.18],12));
      }
      const ownerRing=factionPalette.ring;
      rdr.withWorldSpriteDepth(groundWorld,()=>rdr.outlineCircle(hx,hy+r*.12,r*1.18,Math.max(1.6,2.4*sc),ownerRing,22,1));
    
    }
  },
  "dragon":(rdr,ctx)=>{
    const {u,sc,x,y,r,attack,factionPalette}=ctx;
    {
      // BOT objective: one local facing coordinate drives body, head, mouth, wings and tail.
      const pose=rdr.resolveDragonRenderPose(u,x,y,r),P=pose.point,fire=[1,.42,.12,1],fireHi=[1,.82,.28,1],wing=[.39,.14,.11,1],wingHi=[.52,.19,.14,1],body=[.58,.24,.15,1],bodyDark=[.42,.16,.11,1],head=[.66,.27,.14,1],ink=[.10,.055,.035,1];
      // Rounded 3-lobe wings: broad silhouette without sharp triangle-only geometry.
      for(const side of [-1,1]){
        let q=P(-.12,side*.72);rdr.circle(q[0],q[1],r*.49,wing,13);
        q=P(-.30,side*1.02);rdr.circle(q[0],q[1],r*.39,wing,12);
        q=P(.16,side*.92);rdr.circle(q[0],q[1],r*.34,wingHi,11);
      }
      const b0=P(-.10,0),neck=P(.36,0),headP=pose.head,muzzle=pose.muzzle,mouth=pose.mouth;
      rdr.circle(b0[0],b0[1],r*.74,bodyDark,15);
      rdr.circle(b0[0]+pose.forwardX*r*.06,b0[1]+pose.forwardY*r*.06,r*.64,body,15);
      rdr.circle(neck[0],neck[1],r*.43,body,12);
      rdr.circle(headP[0],headP[1],r*.51,head,13);
      rdr.circle(muzzle[0],muzzle[1],r*.34,bodyDark,11);
      rdr.circle(muzzle[0]+pose.forwardX*r*.08,muzzle[1]+pose.forwardY*r*.08,r*.25,head,10);
      // Mouth/jaw opens slightly during attacks and breath, aligned to the same facing axis.
      const mouthOpen=(u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL||u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.ACTIVE||attack);
      if(mouthOpen){const jaw=P(1.12,.12);rdr.line(muzzle[0]+pose.forwardX*r*.12,muzzle[1]+pose.forwardY*r*.12,jaw[0],jaw[1],Math.max(1.4,2.4*sc),ink)}
      // Horns stay readable, but the eyes are rounder and softer so the dragon reads as cute instead of eerie.
      for(const side of [-1,1]){
        const hb=P(.69,side*.36);rdr.crestTriangle(hb[0],hb[1],r*.21,fire,pose.angle+side*.44);
        const eye=P(.88,side*.19);
        rdr.circle(eye[0],eye[1],r*.118,[1,.97,.86,1],9);
        rdr.circle(eye[0]-pose.sideX*side*r*.010,eye[1]-pose.sideY*side*r*.010,r*.088,[1,.93,.70,1],8);
        const pupilX=eye[0]+pose.forwardX*r*.010+pose.sideX*side*r*.010;
        const pupilY=eye[1]+pose.forwardY*r*.010+pose.sideY*side*r*.010;
        rdr.circle(pupilX,pupilY,r*.034,[.18,.13,.10,1],7);
        rdr.circle(eye[0]-pose.forwardX*r*.030-pose.sideX*side*r*.020,eye[1]-pose.forwardY*r*.030-pose.sideY*side*r*.020,r*.015,[1,1,1,.96],6);
        const cheek=P(.98,side*.30);rdr.circle(cheek[0],cheek[1],r*.050,[1,.72,.56,.28],7);
      }
      rdr.line(pose.tailA[0],pose.tailA[1],pose.tailB[0],pose.tailB[1],Math.max(3,4.8*sc),bodyDark);
      rdr.line(pose.tailB[0],pose.tailB[1],pose.tailTip[0],pose.tailTip[1],Math.max(2.6,4.0*sc),bodyDark);
      rdr.circle(pose.tailTip[0],pose.tailTip[1],r*.20,fire,9);rdr.circle(pose.tailTip[0]+pose.forwardX*r*.03,pose.tailTip[1]+pose.forwardY*r*.03,r*.10,fireHi,8);
      const ownerRing=factionPalette.ring;
      rdr.outlineCircle(x,y,r*1.48,Math.max(1.6,2.4*sc),ownerRing,24,1);
      if(u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL){rdr.circle(mouth[0],mouth[1],r*.30,[1,.54,.15,.34],12);rdr.circle(mouth[0],mouth[1],r*.14,fireHi,10)}
      else if(u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.ACTIVE){rdr.circle(mouth[0],mouth[1],r*.24,[1,.78,.28,.78],10);rdr.circle(mouth[0],mouth[1],r*.11,[1,.96,.62,1],8)}
      else if(attack){rdr.circle(mouth[0],mouth[1],r*.20,[1,.70,.20,.62],10);rdr.circle(mouth[0],mouth[1],r*.09,[1,.95,.58,.95],8)}
    
    }
  },
  "wildhound":(rdr,ctx)=>{
    const {sc,x,y,r,attack}=ctx;
    {
      const vd=UnitVisualDefinition.get(ctx.u.type);
      const body=ctx.team,dark=vd.dark,accent=vd.accent;
      // Fast runner: low oval body and thorn-leaf mane.
      rdr.poly([
        [x-r*.96,y+r*.18],[x-r*.56,y-r*.30],
        [x+r*.48,y-r*.30],[x+r*.92,y+r*.16],
        [x+r*.50,y+r*.48],[x-r*.62,y+r*.50]
      ],body);
      for(let k=0;k<5;k++){
        const sx=x-r*.48+k*r*.24;
        rdr.crestTriangle(
          sx,y-r*.52-(k%2)*r*.05,
          r*.18,dark,-Math.PI/2
        );
      }
      rdr.circle(x+r*.58,y-r*.28,r*.36,body,10);
      rdr.crestTriangle(x+r*.42,y-r*.58,r*.19,dark,-Math.PI/2);
      rdr.crestTriangle(x+r*.74,y-r*.56,r*.18,dark,-Math.PI/2);
      rdr.circle(x+r*.68,y-r*.32,Math.max(1,r*.065),accent,7);
      rdr.circle(x+r*.80,y-r*.12,r*.075,[.10,.08,.05,1],7);
      rdr.line(x-r*.46,y+r*.34,x-r*.72,y+r*.78,Math.max(1.3,2.2*sc),dark);
      rdr.line(x+r*.18,y+r*.34,x+r*.42,y+r*.78,Math.max(1.3,2.2*sc),dark);
      if(attack){
        rdr.poly([
          [x+r*.78,y-r*.06],[x+r*1.14,y+r*.02],[x+r*.80,y+r*.14]
        ],[.96,.91,.68,1]);
      }
    
    }
  },
  "boar":(rdr,ctx)=>{
    const {x,y,r,attack}=ctx;
    {
      const vd=UnitVisualDefinition.get(ctx.u.type);
      const body=ctx.team,dark=vd.dark,accent=vd.accent;
      // Seed-shell brute: chunky seed armor plates and tusk-like sprouts.
      rdr.poly([
        [x-r*.98,y+r*.50],[x-r*.88,y-r*.36],
        [x+r*.56,y-r*.52],[x+r*.98,y+r*.18],
        [x+r*.58,y+r*.64],[x-r*.70,y+r*.66]
      ],body);
      for(let k=-2;k<=2;k++){
        const sx=x+k*r*.28;
        rdr.poly([
          [sx-r*.16,y-r*.44],[sx,y-r*.70],
          [sx+r*.16,y-r*.44],[sx+r*.10,y-r*.12],
          [sx-r*.10,y-r*.12]
        ],dark);
      }
      rdr.circle(x+r*.66,y-r*.10,r*.46,body,10);
      rdr.circle(x+r*.78,y-r*.20,Math.max(1,r*.055),[.12,.08,.04,1],7);
      rdr.poly([
        [x+r*.94,y-r*.02],[x+r*1.34,y-r*.18],[x+r*1.04,y+r*.14]
      ],[.94,.88,.65,1]);
      rdr.poly([
        [x+r*.90,y+r*.10],[x+r*1.26,y+r*.26],[x+r*.98,y+r*.31]
      ],[.94,.88,.65,1]);
      if(attack){
        rdr.circle(x+r*.90,y,r*.74,[accent[0],accent[1],accent[2],.10],12);
      }
    
    }
  },
  "sporetoad":(rdr,ctx)=>{
    const {sc,x,y,r,attack}=ctx;
    {
      const vd=UnitVisualDefinition.get(ctx.u.type),body=ctx.team,dark=vd.dark,accent=vd.accent;
      // Low, broad toad silhouette. Spore sacs sit on the BACK instead of reading as lateral wings.
      const sacPulse=attack?1.16:1;
      rdr.circle(x-r*.38,y-r*.52,r*.30*sacPulse,accent,11);
      rdr.circle(x+r*.34,y-r*.56,r*.34*sacPulse,[.72,.56,.28,1],11);
      rdr.circle(x+r*.05,y-r*.72,r*.24*sacPulse,[.82,.68,.34,1],10);
      // Massive rear legs and planted front legs make the quadruped/toad read instantly.
      rdr.circle(x-r*.72,y+r*.40,r*.46,dark,12);rdr.circle(x+r*.72,y+r*.40,r*.46,dark,12);
      rdr.circle(x-r*.70,y+r*.40,r*.34,body,11);rdr.circle(x+r*.70,y+r*.40,r*.34,body,11);
      rdr.circle(x,y+r*.18,r*.86,dark,15);
      rdr.circle(x,y+r*.08,r*.76,body,15);
      rdr.circle(x-r*.42,y+r*.44,r*.25,body,10);rdr.circle(x+r*.42,y+r*.44,r*.25,body,10);
      // Raised toad eyes; no bird-like central beak.
      rdr.circle(x-r*.34,y-r*.43,r*.25,dark,10);rdr.circle(x+r*.34,y-r*.43,r*.25,dark,10);
      rdr.circle(x-r*.34,y-r*.47,r*.16,[.92,.71,.20,1],9);rdr.circle(x+r*.34,y-r*.47,r*.16,[.92,.71,.20,1],9);
      rdr.circle(x-r*.34,y-r*.48,r*.065,[.06,.07,.04,1],7);rdr.circle(x+r*.34,y-r*.48,r*.065,[.06,.07,.04,1],7);
      // Wide feeding slit is part of the creature anatomy.
      rdr.line(x-r*.42,y-r*.03,x+r*.42,y-r*.03,Math.max(1.5,2.6*sc),[.13,.15,.08,1]);
      rdr.line(x-r*.30,y+r*.04,x+r*.30,y+r*.04,Math.max(1,1.5*sc),[.30,.34,.16,1]);
      if(attack){
        rdr.circle(x,y-r*.03,r*.26,[.72,.94,.30,.20],10);
        rdr.circle(x+r*.34,y-r*.56,r*.46,[accent[0],accent[1],accent[2],.10],12);
      }
    
    }
  },
  "shellcrab":(rdr,ctx)=>{
    const {sc,x,y,r,attack}=ctx;
    {
      const vd=UnitVisualDefinition.get(ctx.u.type),body=ctx.team,dark=vd.dark,accent=vd.accent;
      // Very wide low silhouette: seed-shell body plus two oversized claws.
      rdr.poly([[x-r*.92,y+r*.34],[x-r*.72,y-r*.38],[x,y-r*.62],[x+r*.72,y-r*.38],[x+r*.92,y+r*.34],[x+r*.52,y+r*.62],[x-r*.52,y+r*.62]],dark);
      rdr.circle(x,y,r*.74,body,14);
      for(const ox of [-.42,0,.42])rdr.poly([[x+ox*r-r*.18,y-r*.45],[x+ox*r,y-r*.70],[x+ox*r+r*.18,y-r*.45],[x+ox*r+r*.10,y-r*.05],[x+ox*r-r*.10,y-r*.05]],accent);
      rdr.line(x-r*.55,y+r*.36,x-r*1.02,y+r*.72,Math.max(2,3.4*sc),dark);
      rdr.line(x+r*.55,y+r*.36,x+r*1.02,y+r*.72,Math.max(2,3.4*sc),dark);
      rdr.circle(x-r*1.07,y+r*.72,r*.28,body,9);rdr.circle(x+r*1.07,y+r*.72,r*.28,body,9);
      rdr.crestTriangle(x-r*1.22,y+r*.67,r*.24,accent,Math.PI);rdr.crestTriangle(x+r*1.22,y+r*.67,r*.24,accent,0);
      rdr.circle(x-r*.20,y-r*.18,r*.065,[.08,.07,.04,1],7);rdr.circle(x+r*.20,y-r*.18,r*.065,[.08,.07,.04,1],7);
      if(attack){rdr.circle(x-r*1.10,y+r*.69,r*.42,[accent[0],accent[1],accent[2],.10],10);rdr.circle(x+r*1.10,y+r*.69,r*.42,[accent[0],accent[1],accent[2],.10],10)}
    
    }
  },
  "seedwasp":(rdr,ctx)=>{
    const {sc,x,y,r,attack}=ctx;
    {
      const vd=UnitVisualDefinition.get(ctx.u.type),body=ctx.team,dark=vd.dark,accent=vd.accent;
      // Seed abdomen + broad leaf wings; common AIR height/shadow handles altitude.
      rdr.poly([[x-r*.18,y],[x-r*1.10,y-r*.62],[x-r*.78,y+r*.18],[x-r*.16,y+r*.30]],[.72,.88,.58,.72]);
      rdr.poly([[x+r*.18,y],[x+r*1.10,y-r*.62],[x+r*.78,y+r*.18],[x+r*.16,y+r*.30]],[.72,.88,.58,.72]);
      rdr.circle(x,y+r*.10,r*.48,body,11);
      rdr.poly([[x-r*.34,y+r*.24],[x,y+r*.92],[x+r*.34,y+r*.24]],dark);
      rdr.circle(x,y-r*.42,r*.34,accent,10);
      rdr.circle(x-r*.12,y-r*.46,r*.055,[.08,.07,.03,1],7);rdr.circle(x+r*.12,y-r*.46,r*.055,[.08,.07,.03,1],7);
      rdr.line(x-r*.12,y-r*.66,x-r*.34,y-r*.95,Math.max(1,1.6*sc),dark);rdr.line(x+r*.12,y-r*.66,x+r*.34,y-r*.95,Math.max(1,1.6*sc),dark);
      if(attack)rdr.crestTriangle(x,y+r*1.02,r*.20,[.98,.90,.56,1],Math.PI/2);
    
    }
  },
  "greatbear":(rdr,ctx)=>{
    const {u,sc,x,y,r,attack}=ctx;
    {
      const vd=UnitVisualDefinition.get(ctx.u.type);
      const body=ctx.team,dark=vd.dark,accent=vd.accent;
      // Ancient flower-back bear: huge round mass with established petals/seed plates.
      rdr.circle(x,y+r*.10,r*1.06,dark,14);
      rdr.circle(x,y+r*.04,r*.92,body,14);
      rdr.petalRing(x,y-r*.20,r*.64,7,[.58,.49,.26,1],Math.PI/7,.78);
      rdr.circle(x,y-r*.60,r*.62,body,12);
      rdr.circle(x-r*.42,y-r*.98,r*.22,dark,9);
      rdr.circle(x+r*.42,y-r*.98,r*.22,dark,9);
      rdr.circle(x-r*.18,y-r*.62,Math.max(1.2,r*.065),[.13,.08,.04,1],7);
      rdr.circle(x+r*.18,y-r*.62,Math.max(1.2,r*.065),[.13,.08,.04,1],7);
      rdr.circle(x,y-r*.42,r*.10,[.10,.06,.03,1],7);
      rdr.line(x-r*.60,y+r*.26,x-r*1.18,y+r*.54,Math.max(2,3.3*sc),dark);
      rdr.line(x+r*.60,y+r*.26,x+r*1.18,y+r*.54,Math.max(2,3.3*sc),dark);
      if(attack){
        for(const ox of [-.30,0,.30]){
          rdr.line(
            x+r*.68+ox*r,y-r*.04,
            x+r*1.24+ox*r,y+r*.26,
            Math.max(1.2,1.8*sc),
            [.95,.89,.67,1]
          );
        }
      }
      // Ancient pollen glow; render-only.
      const pulse=.5+.5*Math.sin(performance.now()*.003+(HashUtil.hash(u.id)%100)*.1);
      rdr.circle(x,y-r*.24,r*(.28+.06*pulse),[accent[0],accent[1],accent[2],.08],12);
    
    }
  },
  "worker":(rdr,ctx)=>{
    const {u,sc,x,y,r,workerBuildAnim,ownStealthAlpha,team,gold}=ctx;
    {
      /*
       * 일꾼은 전투병과 실루엣부터 다르게 보이게 한다.
       * - 넓은 안전모
       * - 작업 조끼/멜빵
       * - 등에 광물 운반 바구니
       * - 총처럼 보일 수 있는 수평 장총 형태 금지
       * - 채광 중에는 양손 곡괭이를 머리 위에서 광물 방향으로 크게 휘두름
       */
      const mining=u.workState==="mine";
      const building=u.workState==="building"&&!!workerBuildAnim;
      const returning=u.workState==="return"&&u.carry>0;

      // 짧고 넓은 작업자 체형.
      rdr.poly([
        [x-r*.72,y+r*.64],
        [x+r*.72,y+r*.64],
        [x+r*.58,y-r*.20],
        [x-r*.58,y-r*.20]
      ],[team[0]*.82,team[1]*.82,team[2]*.82,1]);

      // 밝은 작업 조끼 + 멜빵. 군복/방탄복 실루엣과 구분.
      rdr.rect(x-r*.46,y-r*.12,r*.92,r*.60,[.92,.58,.16,1]);
      rdr.line(x-r*.28,y-r*.10,x-r*.12,y+r*.46,Math.max(1.3,2.2*sc),[.98,.84,.32,1]);
      rdr.line(x+r*.28,y-r*.10,x+r*.12,y+r*.46,Math.max(1.3,2.2*sc),[.98,.84,.32,1]);
      rdr.rect(x-r*.28,y+r*.20,r*.56,r*.13,[.28,.31,.34,1]);

      // 작업화.
      rdr.rect(x-r*.50,y+r*.52,r*.34,r*.20,[.19,.16,.12,1]);
      rdr.rect(x+r*.16,y+r*.52,r*.34,r*.20,[.19,.16,.12,1]);

      // 콩 생명체의 둥근 머리 + 넓고 명확한 안전모.
      rdr.circle(x,y-r*.48,r*.52,[.72,.78,.42,1],10);
      rdr.circle(x-r*.13,y-r*.52,r*.22,[.62,.72,.34,ownStealthAlpha],9);
      // 안전모 위 작은 새싹: 작업자도 같은 생태 군단이라는 시각 표식.
      rdr.line(x,y-r*.94,x-r*.10,y-r*1.13,Math.max(1.2,1.8*sc),[.28,.58,.24,1]);
      rdr.line(x,y-r*.94,x+r*.12,y-r*1.10,Math.max(1.2,1.8*sc),[.28,.58,.24,1]);
      rdr.circle(x-r*.12,y-r*1.14,r*.10,[.46,.76,.35,1],8);
      rdr.circle(x+r*.14,y-r*1.11,r*.10,[.46,.76,.35,1],8);
      rdr.circle(x,y-r*.48,r*.50,[.58,.68,.31,ownStealthAlpha],10);
      rdr.poly([
        [x-r*.62,y-r*.58],
        [x+r*.62,y-r*.58],
        [x+r*.48,y-r*.92],
        [x-r*.48,y-r*.92]
      ],gold);
      rdr.rect(x-r*.72,y-r*.61,r*1.44,r*.12,[1,.80,.18,1]);
      rdr.rect(x-r*.10,y-r*.90,r*.20,r*.33,[1,.88,.32,.72]);

      // 얼굴 대신 씨앗형 작업 헬멧의 전면 보호판만 사용한다.
      rdr.poly([
        [x-r*.42,y-r*.58],[x-r*.28,y-r*.82],[x,y-r*.94],
        [x+r*.28,y-r*.82],[x+r*.42,y-r*.58],[x+r*.24,y-r*.42],[x-r*.24,y-r*.42]
      ],[.34,.25,.12,1]);
      rdr.rect(x-r*.24,y-r*.66,r*.48,r*.10,[1,.80,.18,.88]);

      // 등에 매단 광물 바구니. 빈 상태에도 프레임이 보이고,
      // carry가 있으면 청록 광물이 위로 튀어나온다.
      rdr.poly([
        [x-r*.80,y-r*.04],
        [x-r*.46,y-r*.12],
        [x-r*.38,y+r*.44],
        [x-r*.86,y+r*.42]
      ],[.31,.22,.13,1]);
      rdr.line(x-r*.76,y,x-r*.43,y+r*.04,Math.max(1,1.6*sc),[.67,.46,.22,1]);
      rdr.line(x-r*.78,y+r*.18,x-r*.40,y+r*.20,Math.max(1,1.6*sc),[.67,.46,.22,1]);

      if(u.carry>0){
        const load=Math.min(1,u.carry/8);
        const gasLoad=u.carryType==="gas";
        const ore=gasLoad?[.35,.92,.42,1]:[.20,.78,.96,1];
        const ore2=gasLoad?[.57,1,.58,1]:[.34,.90,1,1];
        rdr.hex(x-r*.70,y-r*.10-r*.16*load,r*.22,ore);
        if(load>.45)rdr.hex(x-r*.50,y-r*.02-r*.12*load,r*.18,ore2);
        if(load>.8)rdr.hex(x-r*.82,y-r*.27,r*.16,ore2);
      }

      // 팔 위치.
      const handCol=[.94,.70,.53,1];

      if(building){
        const {target,aimX,aimY,sideX,sideY,motion}=workerBuildAnim;
        const angleBase=Math.atan2(aimY,aimX);
        const handCol=[.94,.70,.53,1];

        // Fast rhythmic construction cycle (~0.56 s): crouch -> overhead slam -> root pull -> recoil -> reset.
        const slam=RangeUtil.clamp(motion.drive+motion.impact*.55,0,1);
        const pull=motion.pull;
        const toolAngle=angleBase-Math.PI*(.72-.60*slam+.22*pull);
        const hx=Math.cos(toolAngle),hy=Math.sin(toolAngle);

        const shoulderX=x+aimX*r*.10,shoulderY=y+aimY*r*.10-r*.05;
        const grip1X=shoulderX+sideX*r*.18+aimX*r*(.15+.18*slam);
        const grip1Y=shoulderY+sideY*r*.18+aimY*r*(.15+.18*slam);
        const grip2X=shoulderX-sideX*r*.16+aimX*r*(.25+.20*slam);
        const grip2Y=shoulderY-sideY*r*.16+aimY*r*(.25+.20*slam);
        rdr.line(x-sideX*r*.20,y+r*.38,x+sideX*r*.18,y+r*(.56+.10*motion.crouch),Math.max(1.5,2.4*sc),[.19,.16,.12,1]);
        rdr.line(x+sideX*r*.18,y+r*.38,x-sideX*r*.20,y+r*(.56-.08*motion.crouch),Math.max(1.5,2.4*sc),[.19,.16,.12,1]);
        rdr.circle(grip1X,grip1Y,r*.12,handCol,7);rdr.circle(grip2X,grip2Y,r*.12,handCol,7);

        // Oversized pick/root-hook: the downward impact reads clearly at combat zoom,
        // while the backward phase feels like yanking living roots into place.
        const handleStartX=x-hx*r*.18,handleStartY=y-hy*r*.18;
        const toolX=x+hx*r*(1.66+.22*slam-.14*pull),toolY=y+hy*r*(1.66+.22*slam-.14*pull);
        rdr.line(handleStartX,handleStartY,toolX,toolY,Math.max(2.2,3.4*sc),[.45,.27,.11,1]);
        const px=-hy,py=hx;
        rdr.line(toolX-px*r*.48,toolY-py*r*.48,toolX+px*r*.48,toolY+py*r*.48,Math.max(2.2,3.8*sc),[.34,.39,.44,1]);
        rdr.poly([[toolX+px*r*.48,toolY+py*r*.48],[toolX+px*r*.68+hx*r*.08,toolY+py*r*.68+hy*r*.08],[toolX+px*r*.42-hx*r*.05,toolY+py*r*.42-hy*r*.05]],[.52,.58,.62,1]);

        // Root being pulled toward the worker during the yank half of the cycle.
        if(pull>.05){
          const [bx,by]=rdr.worldToPx(rdr.viewX(target.x),rdr.viewY(target.y));
          const rootX=bx-aimX*BuildingDefinition.get(target.type).size*sc*.48;
          const rootY=by-aimY*BuildingDefinition.get(target.type).size*sc*.48;
          const bendX=(rootX+x)*.5+sideX*r*.28*Math.sin(motion.phase*Math.PI*2);
          const bendY=(rootY+y)*.5+sideY*r*.28*Math.sin(motion.phase*Math.PI*2);
          rdr.line(rootX,rootY,bendX,bendY,Math.max(1.4,2.2*sc),[.34,.64,.24,.78]);
          rdr.line(bendX,bendY,x+aimX*r*.34,y+aimY*r*.34,Math.max(1.2,1.9*sc),[.46,.76,.30,.72]);
          rdr.circle(rootX,rootY,r*(.07+.05*pull),[.58,.86,.36,.72],7);
        }

        if(motion.impact>0){
          const [bx,by]=rdr.worldToPx(rdr.viewX(target.x),rdr.viewY(target.y));
          const rr=BuildingDefinition.get(target.type).size*sc;
          const contactX=bx-aimX*rr*.56,contactY=by-aimY*rr*.56;
          const fade=1-motion.impact*.35;
          rdr.circle(contactX,contactY,r*(.16+.26*motion.impact),[.60,.88,.34,.16*fade],9);
          for(let k=0;k<5;k++){
            const h=HashUtil.hash(u.id+"|buildLeaf|"+k);
            const spread=((h%1000)/1000-.5)*1.55;
            const aa=angleBase+Math.PI+spread;
            const dist=r*(.26+.72*motion.impact+((h>>>8)%100)/230);
            const lx=contactX+Math.cos(aa)*dist,ly=contactY+Math.sin(aa)*dist;
            const leafR=Math.max(1.1,r*(.055+.01*(k%3))*(1-motion.impact*.30));
            rdr.poly([[lx,ly-leafR],[lx+leafR*.9,ly],[lx,ly+leafR],[lx-leafR*.55,ly]],[.46,.78,.30,.84*fade]);
          }
          for(let k=0;k<3;k++){
            const h=HashUtil.hash(u.id+"|buildDustWorker|"+k);
            const aa=angleBase+Math.PI+((h%1000)/1000-.5)*1.2;
            const dist=r*(.30+.52*motion.impact);
            rdr.circle(contactX+Math.cos(aa)*dist,contactY+Math.sin(aa)*dist*.55,Math.max(1.2,r*.06*(1-motion.impact*.35)),[.70,.56,.31,.62*fade],7);
          }
        }
      }else if(mining){
        const mineral=u.workResourceType==="gas"
          ?rdr.snapshot?.buildings?.find(b=>b.id===u.mineId&&BuildingDefinition.get(b.type)?.isGasExtractor)
          :rdr.snapshot?.resources?.find(m=>m.id===u.mineId);
        let aimX=0,aimY=-1;

        if(mineral){
          const wx=rdr.viewX(u.x),wy=rdr.viewY(u.y);
          const mx=rdr.viewX(mineral.x),my=rdr.viewY(mineral.y);
          const dx=mx-wx,dy=my-wy;
          const len=Math.hypot(dx,dy)||1;
          aimX=dx/len;
          aimY=dy/len;
        }

        // 렌더 전용 반복 스윙. 상태 publish 10Hz와 무관하게 rAF에서 부드럽게 움직인다.
        const seedPhase=(HashUtil.hash(u.id)%997)/997;
        const cycle=((performance.now()/720)+seedPhase)%1;

        // 0~0.48: 머리 위로 들어올림, 0.48~0.70: 빠르게 타격, 이후 복귀.
        let swing;
        if(cycle<.48){
          swing=cycle/.48;
        }else if(cycle<.70){
          swing=1-(cycle-.48)/.22;
        }else{
          swing=0;
        }

        const sideX=-aimY,sideY=aimX;
        const lift=(.15+.85*swing);

        // 손 두 개가 도구 손잡이를 잡음.
        const grip1X=x+sideX*r*.18-aimX*r*.05;
        const grip1Y=y+sideY*r*.18-aimY*r*.05;
        const grip2X=x-sideX*r*.12+aimX*r*.12;
        const grip2Y=y-sideY*r*.12+aimY*r*.12;
        rdr.circle(grip1X,grip1Y,r*.11,handCol,7);
        rdr.circle(grip2X,grip2Y,r*.11,handCol,7);

        // 곡괭이 손잡이는 갈색 목재. 총신처럼 읽히지 않도록
        // 큰 회전각과 명확한 T자 헤드를 가진다.
        const angleBase=Math.atan2(aimY,aimX);
        const angle=angleBase-Math.PI*.80*lift-Math.PI*.12;
        const hx=Math.cos(angle),hy=Math.sin(angle);

        const handleStartX=x-hx*r*.15;
        const handleStartY=y-hy*r*.15;
        const toolX=x+hx*r*1.62;
        const toolY=y+hy*r*1.62;

        rdr.line(
          handleStartX,handleStartY,
          toolX,toolY,
          Math.max(2,3.1*sc),
          [.45,.27,.11,1]
        );

        // 곡괭이 T자 금속 헤드.
        const px=-hy,py=hx;
        rdr.line(
          toolX-px*r*.48,toolY-py*r*.48,
          toolX+px*r*.48,toolY+py*r*.48,
          Math.max(2,3.5*sc),
          [.34,.39,.44,1]
        );
        rdr.poly([
          [toolX+px*r*.48,toolY+py*r*.48],
          [toolX+px*r*.66+hx*r*.08,toolY+py*r*.66+hy*r*.08],
          [toolX+px*r*.42-hx*r*.05,toolY+py*r*.42-hy*r*.05]
        ],[.52,.58,.62,1]);
        rdr.poly([
          [toolX-px*r*.48,toolY-py*r*.48],
          [toolX-px*r*.66+hx*r*.08,toolY-py*r*.66+hy*r*.08],
          [toolX-px*r*.42-hx*r*.05,toolY-py*r*.42-hy*r*.05]
        ],[.52,.58,.62,1]);

        // 타격 순간 미네랄 표면에 광석 파편/스파크.
        // 판정과 무관한 순수 WebGL VFX.
        if(mineral&&cycle>=.48&&cycle<.68){
          const impactT=(cycle-.48)/.20;
          const [mx,my]=rdr.worldToPx(rdr.viewX(mineral.x),rdr.viewY(mineral.y));
          const contactX=mx-aimX*(mineral.r||28)*sc*.55;
          const contactY=my-aimY*(mineral.r||28)*sc*.55;
          const fade=1-impactT;

          rdr.circle(contactX,contactY,r*(.18+.24*impactT),[.35,.90,1,.18*fade],8);

          for(let k=0;k<5;k++){
            const h=HashUtil.hash(u.id+"|mine|"+k);
            const spread=((h%1000)/1000-.5)*1.45;
            const aa=angleBase+Math.PI+spread;
            const dist=(.25+impactT*(.55+((h>>>9)%100)/120))*r;
            const px2=contactX+Math.cos(aa)*dist;
            const py2=contactY+Math.sin(aa)*dist;
            const rr=Math.max(1.2,r*(.07+((h>>>17)%5)*.008)*(1-impactT*.55));
            rdr.poly([
              [px2-rr,py2],
              [px2,py2-rr],
              [px2+rr,py2],
              [px2,py2+rr]
            ],[.31,.84,1,.92*fade]);
          }

          for(let k=0;k<3;k++){
            const aa=angleBase+Math.PI+(-.45+k*.45);
            rdr.line(
              contactX,contactY,
              contactX+Math.cos(aa)*r*(.45+.25*impactT),
              contactY+Math.sin(aa)*r*(.45+.25*impactT),
              Math.max(1,1.5*sc),
              [1,.88,.42,.72*fade]
            );
          }
        }
      }else{
        // 이동/복귀 중엔 곡괭이를 등에 비스듬히 메고 간다.
        // 수평으로 앞으로 내밀지 않아 총처럼 보이지 않는다.
        const hx=.56,hy=-.83;
        const ax=x+r*.18,ay=y+r*.30;
        const bx=x+hx*r*1.28,by=y+hy*r*1.28;

        rdr.line(ax,ay,bx,by,Math.max(1.8,2.8*sc),[.45,.27,.11,1]);
        const px=-hy,py=hx;
        rdr.line(
          bx-px*r*.36,by-py*r*.36,
          bx+px*r*.36,by+py*r*.36,
          Math.max(1.8,3*sc),
          [.34,.39,.44,1]
        );

        // 운반 중에는 한 손으로 바구니 끈을 잡는 느낌.
        if(returning)rdr.circle(x-r*.46,y+r*.12,r*.11,handCol,7);
      }

      // 작업자 상태를 작은 도형으로만 표현: 채광=곡괭이 표시, 운반=광물 표시.
      if(building){
        rdr.circle(x+r*.70,y+r*.50,r*.11,[.52,.86,.30,.92],7);
        rdr.line(x+r*.62,y+r*.50,x+r*.78,y+r*.50,Math.max(1,1.4*sc),[.96,.82,.34,.92]);
      }else if(mining){
        rdr.circle(x+r*.70,y+r*.50,r*.10,[1,.78,.22,.9],7);
      }else if(returning){
        rdr.hex(x+r*.70,y+r*.50,r*.11,[.28,.86,1,.95]);
      }
    
    }
  },
  "swordsman":(rdr,ctx)=>{
    const {sc,x,y,r,attack,dir}=ctx;
    {
        // 칼잎 전사: 금속검 대신 몸에서 자란 넓은 칼잎 한 장이 정체성.
        const slash=attack?r*.32:0;
        rdr.petalRing(x-r*.48,y+r*.05,r*.26,3,[.38,.68,.28,1],-.3,.58);
        rdr.poly([
          [x+r*.28,y+r*.12],[x+r*.70,y+dir*r*.18],
          [x+r*1.34,y+dir*(r*.82+slash)],[x+r*.92,y+dir*(r*.95+slash)],
          [x+r*.40,y+dir*r*.22]
        ],[.48,.80,.32,1]);
        rdr.line(x+r*.44,y+dir*r*.18,x+r*1.14,y+dir*(r*.72+slash),Math.max(1,1.6*sc),[.24,.52,.20,1]);
      
    }
  },
  "pikeman":(rdr,ctx)=>{
    const {sc,x,y,r,accent,attack,dir}=ctx;
    {
        // 가시창풀: 길고 유연한 줄기 + 끝가시.
        const thrust=attack?r*.38:0;
        rdr.line(x+r*.08,y+r*.12,x+r*.08,y+dir*(r*2.18+thrust),Math.max(2,3.2*sc),[.30,.55,.22,1]);
        rdr.poly([[x-r*.02,y+dir*r*.86],[x-r*.35,y+dir*r*.58],[x-r*.08,y+dir*r*.42]],accent);
        rdr.poly([[x+r*.18,y+dir*r*1.28],[x+r*.48,y+dir*r*1.02],[x+r*.18,y+dir*r*.90]],accent);
        rdr.crestTriangle(x+r*.08,y+dir*(r*2.34+thrust),r*.25,[.78,.88,.55,1],dir<0?-Math.PI/2:Math.PI/2);
      
    }
  },
  "archer":(rdr,ctx)=>{
    const {sc,x,y,r,attack,dir}=ctx;
    {
        // 씨앗궁수: 두 장의 휘어진 잎과 중앙 씨앗이 활 역할을 한다.
        rdr.poly([[x+r*.35,y-r*.68],[x+r*.83,y-r*.36],[x+r*.63,y-r*.06],[x+r*.28,y-r*.28]], [.36,.66,.28,1]);
        rdr.poly([[x+r*.35,y+r*.68],[x+r*.83,y+r*.36],[x+r*.63,y+r*.06],[x+r*.28,y+r*.28]], [.36,.66,.28,1]);
        rdr.line(x+r*.80,y-r*.34,x+r*.80,y+r*.34,Math.max(1,1.4*sc),[.78,.84,.55,1]);
        rdr.circle(x+r*.76,y,r*.10,[.74,.58,.25,1],8);
        if(attack){
          rdr.line(x+r*.78,y,x+r*1.48,y+dir*r*.06,Math.max(1.1,1.6*sc),[.53,.39,.18,1]);
          rdr.circle(x+r*1.52,y+dir*r*.06,r*.09,[.82,.65,.30,1],8);
        }
      
    }
  },
  "skirmisher":(rdr,ctx)=>{
    const {x,y,r,accent,attack,dir}=ctx;
    {
        // 포자사수: 총/탄창 대신 등에 포자낭과 짧은 분사구를 붙인다.
        rdr.circle(x-r*.38,y-r*.08,r*.38,[.30,.64,.48,1],11);
        rdr.circle(x-r*.48,y-r*.20,r*.13,[.68,.92,.60,1],8);
        rdr.circle(x-r*.28,y+r*.12,r*.11,[.68,.92,.60,1],8);
        rdr.poly([[x+r*.25,y-r*.15],[x+r*.92,y-r*.22],[x+r*1.18,y],[x+r*.92,y+r*.22],[x+r*.25,y+r*.15]], [.28,.58,.42,1]);
        rdr.circle(x+r*1.20,y,r*.12,accent,8);
        if(attack){
          rdr.circle(x+r*1.50,y+dir*r*.04,r*.14,[.62,1,.72,.50],8);
          rdr.circle(x+r*1.72,y+dir*r*.06,r*.07,[.82,1,.86,.70],7);
        }
      
    }
  },
  "kickhopper":(rdr,ctx)=>{
    const {sc,x,y,r,teamLight,accent,attack,dir}=ctx;
    {
        // 방아깨비: 작은 몸보다 훨씬 큰 탄성 뒷다리가 먼저 읽히는 T1 실루엣.
        rdr.circle(x,y+r*.02,r*.58,[.46,.62,.20,1],12);
        rdr.circle(x,y-r*.42,r*.32,teamLight,10);
        rdr.line(x-r*.20,y+r*.26,x-r*.72,y+r*.74,Math.max(2.0,3.2*sc),[.38,.50,.16,1]);
        rdr.line(x+r*.20,y+r*.26,x+r*.72,y+r*.74,Math.max(2.0,3.2*sc),[.38,.50,.16,1]);
        const kick=attack?r*.52:0;
        rdr.line(x-r*.72,y+r*.74,x-r*1.10,y+dir*(r*.58+kick),Math.max(2.2,3.8*sc),accent);
        rdr.line(x+r*.72,y+r*.74,x+r*1.10,y+dir*(r*.58+kick),Math.max(2.2,3.8*sc),accent);
        rdr.circle(x-r*1.12,y+dir*(r*.60+kick),r*.11,[.92,.96,.58,1],8);
        rdr.circle(x+r*1.12,y+dir*(r*.60+kick),r*.11,[.92,.96,.58,1],8);
        rdr.line(x-r*.16,y-r*.58,x-r*.42,y-r*.88,Math.max(1,1.5*sc),[.30,.40,.15,1]);
        rdr.line(x+r*.16,y-r*.58,x+r*.42,y-r*.88,Math.max(1,1.5*sc),[.30,.40,.15,1]);
      
    }
  },
  "shellbug":(rdr,ctx)=>{
    const {sc,x,y,r,teamDark,accent}=ctx;
    {
        rdr.circle(x,y+r*.10,r*.82,[.34,.45,.22,1],12);
        rdr.poly([[x-r*.72,y-r*.10],[x-r*.42,y-r*.62],[x,y-r*.78],[x+r*.42,y-r*.62],[x+r*.72,y-r*.10],[x+r*.52,y+r*.40],[x-r*.52,y+r*.40]],teamDark);
        rdr.line(x,y-r*.68,x,y+r*.30,Math.max(1.3,2*sc),accent);
        rdr.circle(x-r*.26,y-r*.18,r*.07,[.95,.92,.68,1],7);rdr.circle(x+r*.26,y-r*.18,r*.07,[.95,.92,.68,1],7);
      
    }
  },
  "stingbug":(rdr,ctx)=>{
    const {sc,x,y,r,team,teamDark,accent,attack,dir}=ctx;
    {
        rdr.circle(x-r*.12,y+r*.10,r*.54,team,11);rdr.circle(x+r*.44,y-r*.04,r*.32,teamDark,9);
        rdr.line(x-r*.18,y+r*.30,x-r*.78,y+r*.62,Math.max(1.2,1.8*sc),teamDark);
        rdr.line(x+r*.14,y+r*.30,x+r*.74,y+r*.62,Math.max(1.2,1.8*sc),teamDark);
        const jab=attack?r*.30:0;
        rdr.line(x+r*.58,y,x+r*1.38+jab,y+dir*r*.06,Math.max(1.5,2.3*sc),accent);
        rdr.crestTriangle(x+r*1.46+jab,y+dir*r*.06,r*.18,accent,0);
      
    }
  },
  "dandelion":(rdr,ctx)=>{
    const {sc,x,y,r,team,accent}=ctx;
    {
        rdr.circle(x,y+r*.16,r*.40,team,10);
        for(let k=0;k<9;k++){const a=k*Math.PI*2/9+performance.now()*.0005;rdr.line(x,y-r*.30,x+Math.cos(a)*r*.72,y-r*.30+Math.sin(a)*r*.72,Math.max(1,1.3*sc),[.94,.95,.82,.9])}
        rdr.circle(x,y-r*.30,r*.13,accent,8);
      
    }
  },
  "thornfruit":(rdr,ctx)=>{
    const {x,y,r,teamDark,accent}=ctx;
    {
        rdr.circle(x,y,r*.62,[.47,.63,.25,1],12);
        for(let k=0;k<10;k++){const a=k*Math.PI*2/10;rdr.crestTriangle(x+Math.cos(a)*r*.58,y+Math.sin(a)*r*.58,r*.20,accent,a)}
        rdr.circle(x,y-r*.08,r*.22,teamDark,9);
      
    }
  },
  "tank":(rdr,ctx)=>{
    const {x,y,r,team,teamDark}=ctx;
    {
        // 껍질수호자: 방패를 든 병사가 아니라 몸 자체가 여러 겹의 씨앗껍질.
        rdr.circle(x,y+r*.06,r*.92,[.24,.34,.18,1],14);
        for(let k=-2;k<=2;k++){
          const ox=k*r*.24;
          rdr.poly([[x+ox-r*.20,y-r*.66],[x+ox+r*.20,y-r*.66],[x+ox+r*.28,y+r*.46],[x+ox-r*.28,y+r*.46]],k%2?teamDark:[.48,.62,.30,1]);
        }
        rdr.circle(x,y-r*.30,r*.28,team,10);
        rdr.circle(x+r*.08,y-r*.35,r*.07,[.90,.94,.66,1],7);
      
    }
  },
  "rogue":(rdr,ctx)=>{
    const {sc,x,y,r,teamDark,accent,attack,dir}=ctx;
    {
        // 그림자벼룩: 큰 뒷다리 + 칼날 같은 앞다리, 망토/단검 없음.
        rdr.circle(x,y+r*.06,r*.50,teamDark,11);
        rdr.circle(x,y-r*.40,r*.30,[.24,.28,.18,1],9);
        rdr.line(x-r*.26,y+r*.22,x-r*.92,y+r*.74,Math.max(2,3.2*sc),teamDark);
        rdr.line(x+r*.26,y+r*.22,x+r*.92,y+r*.74,Math.max(2,3.2*sc),teamDark);
        const stab=attack?r*.30:0;
        rdr.line(x-r*.20,y-r*.20,x-r*.90,y+dir*(r*.70+stab),Math.max(1.5,2.4*sc),accent);
        rdr.line(x+r*.20,y-r*.20,x+r*.90,y+dir*(r*.70+stab),Math.max(1.5,2.4*sc),accent);
        rdr.circle(x-r*.11,y-r*.44,r*.055,[.90,.82,.28,1],6);
        rdr.circle(x+r*.11,y-r*.44,r*.055,[.90,.82,.28,1],6);
      
    }
  },
  "mage":(rdr,ctx)=>{
    const {x,y,r,team,attack}=ctx;
    {
        // 폭발꽃: 지팡이 대신 꽃술 자체가 폭발성 꽃가루를 압축한다.
        rdr.petalRing(x,y-r*.08,r*.72,8,[.68,.35,.78,1],Math.PI/8,.76);
        rdr.circle(x,y-r*.08,r*.36,team,12);
        const orb=r*(attack?.34:.22);
        rdr.circle(x,y-r*.12,orb,[.92,.62,1,1],10);
        rdr.circle(x,y-r*.12,orb*1.9,[.86,.46,1,.14],12);
        for(let k=0;k<4;k++){
          const a=k*Math.PI/2+performance.now()*.0015;
          rdr.circle(x+Math.cos(a)*r*.72,y-r*.08+Math.sin(a)*r*.72,r*.07,[.94,.78,1,.6],7);
        }
      
    }
  },
  "lancer":(rdr,ctx)=>{
    const {sc,x,y,r,team,teamDark,accent,attack,dir}=ctx;
    {
        // 왕사슴 돌격대: 실제 사슴벌레 몸체와 거대한 집게턱이 실루엣의 대부분.
        rdr.circle(x,y+r*.14,r*.80,[.20,.16,.12,1],13);
        rdr.poly([[x-r*.66,y-r*.06],[x,y-r*.58],[x+r*.66,y-r*.06],[x+r*.52,y+r*.48],[x-r*.52,y+r*.48]],teamDark);
        rdr.circle(x,y-r*.50,r*.34,[.31,.22,.12,1],10);
        const charge=attack?r*.34:0;
        rdr.line(x-r*.18,y-r*.66,x-r*.58,y+dir*(r*1.55+charge),Math.max(2,3.4*sc),accent);
        rdr.line(x+r*.18,y-r*.66,x+r*.58,y+dir*(r*1.55+charge),Math.max(2,3.4*sc),accent);
        rdr.crestTriangle(x-r*.60,y+dir*(r*1.62+charge),r*.20,accent,dir<0?-Math.PI/2:Math.PI/2);
        rdr.crestTriangle(x+r*.60,y+dir*(r*1.62+charge),r*.20,accent,dir<0?-Math.PI/2:Math.PI/2);
        // 작은 씨앗 기수.
        rdr.circle(x,y-r*.88,r*.22,team,9);
      
    }
  },
  "medic":(rdr,ctx)=>{
    const {sc,x,y,r,team}=ctx;
    {
        // 이슬치유사: 꽃잎 받침 + 큰 이슬방울. 의료십자/주사기 없음.
        rdr.petalRing(x,y+r*.04,r*.55,6,[.42,.76,.48,1],Math.PI/6,.70);
        rdr.circle(x,y-r*.34,r*.38,team,11);
        rdr.circle(x+r*.56,y-r*.30,r*.25,[.52,.96,.82,.62],10);
        rdr.circle(x+r*.49,y-r*.39,r*.08,[.90,1,.96,.85],8);
        rdr.line(x+r*.28,y-r*.12,x+r*.48,y-r*.26,Math.max(1.4,2.1*sc),[.28,.62,.44,1]);
      
    }
  },
  "mantis":(rdr,ctx)=>{
    const {own,sc,x,y,r,cloaked,accent,attack,dir}=ctx;
    {
        // Veil Mantis: leaf cloak + oversized scythe forelegs.
        rdr.poly([
          [x-r*.88,y+r*.42],[x-r*.42,y-r*.38],
          [x,y-r*.78],[x+r*.42,y-r*.38],[x+r*.88,y+r*.42],
          [x,y+r*.70]
        ],[.26,.58,.28,own&&cloaked?.24:1]);
        const cut=attack?r*.34:0;
        rdr.line(x-r*.30,y-r*.02,x-r*1.14,y+dir*(r*.70+cut),Math.max(1.8,2.8*sc),accent);
        rdr.line(x+r*.30,y-r*.02,x+r*1.14,y+dir*(r*.70+cut),Math.max(1.8,2.8*sc),accent);
        rdr.crestTriangle(x-r*1.20,y+dir*(r*.78+cut),r*.18,accent,dir<0?-Math.PI/2:Math.PI/2);
        rdr.crestTriangle(x+r*1.20,y+dir*(r*.78+cut),r*.18,accent,dir<0?-Math.PI/2:Math.PI/2);

      
    }
  },
  "pillbug":(rdr,ctx)=>{
    const {u,sc,x,y,r,team,teamDark,accent,attack,dir}=ctx;
    {
        // Rolling Pillbug: segmented round shell + volatile front sac.
        const roll=performance.now()*.012+(HashUtil.hash(u.id)%997)*.01;
        rdr.circle(x,y,r*.88,[.13,.16,.18,1],14);
        rdr.circle(x,y,r*.76,team,14);
        for(let k=0;k<6;k++){
          const a=roll+k*Math.PI/3;
          rdr.line(
            x+Math.cos(a)*r*.18,y+Math.sin(a)*r*.18,
            x+Math.cos(a)*r*.72,y+Math.sin(a)*r*.72,
            Math.max(1.3,2.2*sc),teamDark
          );
        }
        const pulse=.82+.18*Math.sin(performance.now()*.012+(HashUtil.hash(u.id)%17));
        rdr.circle(x+r*.62,y+dir*r*.14,r*.26* pulse,accent,10);
        rdr.circle(x+r*.68,y+dir*r*.10,r*.10,[1,.94,.72,1],8);
        if(attack)rdr.circle(x,y,r*1.08,[1,.66,.22,.12],16);
      
    }
  },
  "rootstalker":(rdr,ctx)=>{
    const {sc,x,y,r,ownStealthAlpha,accent}=ctx;
    {
        rdr.circle(x,y+r*.14,r*.72,[.43,.31,.18,1],12);
        for(let k=0;k<5;k++){const a=-Math.PI*.85+k*.42;rdr.line(x,y+r*.15,x+Math.cos(a)*r*.95,y+Math.sin(a)*r*.95,Math.max(1.5,2.2*sc),[.36,.23,.12,1])}
        rdr.circle(x,y-r*.34,r*.32,[.50,.34,.18,ownStealthAlpha],10);rdr.crestTriangle(x,y-r*.82,r*.20,accent,-Math.PI/2);
      
    }
  },
  "chainflower":(rdr,ctx)=>{
    const {x,y,r,team,accent}=ctx;
    {
        rdr.petalRing(x,y,r*.58,7,accent,Math.PI/7,.72);rdr.circle(x,y-r*.12,r*.36,team,12);rdr.circle(x,y-r*.12,r*.16,[.86,.96,1,1],10);
      
    }
  },
  "guardshroom":(rdr,ctx)=>{
    const {x,y,r,accent}=ctx;
    {
        rdr.circle(x,y+r*.28,r*.58,[.72,.67,.54,1],12);rdr.circle(x,y-r*.28,r*.86,accent,14);
        rdr.circle(x-r*.24,y-r*.42,r*.12,[1,.92,.78,.55],8);rdr.circle(x+r*.18,y-r*.18,r*.10,[1,.92,.78,.45],8);
      
    }
  },
  "sporeherd":(rdr,ctx)=>{
    const {x,y,r,team}=ctx;
    {
        rdr.circle(x,y+r*.10,r*.74,team,12);rdr.circle(x,y-r*.46,r*.48,[.72,.78,.30,1],12);
        for(let k=0;k<4;k++){const a=k*Math.PI/2;rdr.circle(x+Math.cos(a)*r*.52,y-r*.44+Math.sin(a)*r*.30,r*.14,[.88,.94,.52,1],9)}
      
    }
  },
  "clawhunter":(rdr,ctx)=>{
    const {sc,x,y,r,ownStealthAlpha,team,accent,attack,dir}=ctx;
    {
        rdr.circle(x,y+r*.08,r*.72,team,12);rdr.circle(x,y-r*.38,r*.36,[.48,.25,.12,ownStealthAlpha],10);
        const reach=attack?r*.32:0;
        rdr.line(x-r*.30,y,x-r*1.15,y+dir*(r*.36+reach),Math.max(2,3.4*sc),accent);
        rdr.line(x+r*.30,y,x+r*1.15,y+dir*(r*.36+reach),Math.max(2,3.4*sc),accent);
        rdr.crestTriangle(x-r*1.20,y+dir*(r*.40+reach),r*.24,accent,dir<0?-Math.PI/2:Math.PI/2);
        rdr.crestTriangle(x+r*1.20,y+dir*(r*.40+reach),r*.24,accent,dir<0?-Math.PI/2:Math.PI/2);
      
    }
  },
  "sporeling":(rdr,ctx)=>{
    const {x,y,r}=ctx;
    {
        rdr.circle(x,y,r*.62,[.76,.85,.38,1],10);rdr.circle(x,y-r*.34,r*.22,[.92,.96,.62,1],8);
      
    }
  },
  "shelltitan":(rdr,ctx)=>{
    const {sc,x,y,r,attack}=ctx;
    {
        // Final direction is intentionally close to the approved A prototype:
        // one massive oval shell + small head + sparse shell studs + antennae.
        // No eyes, arms or legs. Authored head is -Y; common full-facing rotates the whole silhouette.
        const shell=[.47,.38,.23,1],shellDark=[.27,.25,.17,1],ridge=[.67,.55,.31,1],head=[.63,.51,.29,1],antenna=[.76,.63,.35,1];
        rdr.circle(x,y+r*.10,r*1.04,shellDark,18);
        rdr.poly([[x,y-r*.86],[x-r*.48,y-r*.75],[x-r*.82,y-r*.43],[x-r*.96,y+r*.04],[x-r*.78,y+r*.55],[x-r*.36,y+r*.84],[x,y+r*.92],[x+r*.36,y+r*.84],[x+r*.78,y+r*.55],[x+r*.96,y+r*.04],[x+r*.82,y-r*.43],[x+r*.48,y-r*.75]],shell);
        // Single central shell seam: strong at actual game scale without clutter.
        rdr.line(x,y-r*.72,x,y+r*.72,Math.max(1.6,2.6*sc),shellDark);
        // Six raised shell studs give the ancient carapace a recognizable species pattern.
        for(const [ox,oy,sz] of [[-.40,-.34,.085],[.40,-.34,.085],[-.46,.02,.095],[.46,.02,.095],[-.36,.40,.075],[.36,.40,.075]]){
          rdr.circle(x+ox*r,y+oy*r,r*sz,ridge,8);
        }
        // Small separate head, visually subordinate to the giant shell.
        rdr.poly([[x,y-r*.78],[x-r*.20,y-r*.72],[x-r*.25,y-r*.94],[x,y-r*1.16],[x+r*.25,y-r*.94],[x+r*.20,y-r*.72]],head);
        // Minimal antennae are the only fine biological detail.
        rdr.line(x-r*.11,y-r*1.02,x-r*.27,y-r*1.24,Math.max(1.1,1.7*sc),antenna);
        rdr.line(x+r*.11,y-r*1.02,x+r*.27,y-r*1.24,Math.max(1.1,1.7*sc),antenna);
        rdr.circle(x-r*.28,y-r*1.26,r*.05,antenna,7);
        rdr.circle(x+r*.28,y-r*1.26,r*.05,antenna,7);
        if(attack){
          const phase=Math.sin(Math.min(1,Number(attack.progress)||.5)*Math.PI);
          rdr.circle(x,y+r*.08,r*(1.02+.13*phase),[1,.76,.30,.09],20);
        }
    }
  },
  "swarmbug":(rdr,ctx)=>{
    const {sc,x,y,r,team,teamDark,accent}=ctx;
    {
        rdr.circle(x,y,r*.50,team,10);rdr.circle(x+r*.34,y-r*.12,r*.28,teamDark,9);
        for(let k=-1;k<=1;k++){rdr.line(x-r*.12,y+k*r*.22,x-r*.62,y+k*r*.38,Math.max(1,1.5*sc),accent);rdr.line(x+r*.12,y+k*r*.22,x+r*.62,y+k*r*.38,Math.max(1,1.5*sc),accent)}
      
    }
  },
  "aegisbeetle":(rdr,ctx)=>{
    const {u,sc,x,y,r,team,teamDark,accent}=ctx;
    {
        // Broad scutellum silhouette: the shell itself reads as the shield.
        rdr.circle(x,y+r*.16,r*.82,teamDark,16);
        rdr.poly([[x,y-r*.94],[x-r*.72,y-r*.55],[x-r*.88,y+r*.10],[x-r*.55,y+r*.68],[x,y+r*.84],[x+r*.55,y+r*.68],[x+r*.88,y+r*.10],[x+r*.72,y-r*.55]],team);
        rdr.poly([[x,y-r*.78],[x-r*.55,y-r*.43],[x-r*.67,y+r*.08],[x-r*.40,y+r*.50],[x,y+r*.64],[x+r*.40,y+r*.50],[x+r*.67,y+r*.08],[x+r*.55,y-r*.43]],teamDark);
        rdr.line(x,y-r*.70,x,y+r*.58,Math.max(1.2,2.2*sc),accent);
        const manaRatio=RangeUtil.clamp((Number(u.resources.mana)||0)/Math.max(1,Number(u.resources.manaMax)||250),0,1);
        const pulse=.65+.35*Math.sin(performance.now()*.005+(HashUtil.hash(u.id)%100)*.1);
        const nodes=[[-.43,-.30],[.43,-.30],[-.40,.30],[.40,.30]];
        for(const [nx,ny] of nodes){
          rdr.circle(x+nx*r,y+ny*r,r*.095,[.08,.20,.26,1],10);
          rdr.circle(x+nx*r,y+ny*r,r*.055,[.70,.96,1,.42+.50*manaRatio*pulse],8);
        }
        if(manaRatio>0)rdr.circle(x,y+r*.05,r*.91,[.45,.88,1,.025+.055*manaRatio*pulse],24);
    }
  },
  "burrowbeast":(rdr,ctx)=>{
    const {sc,x,y,r,accent,attack}=ctx;
    {
        // Authored forward is screen-up, matching the common full-facing contract.
        // The common facing transform then rotates the whole creature toward movement/target intent.
        const hide=[.38,.25,.15,1],hideDark=[.20,.13,.09,1],plate=[.50,.34,.18,1],horn=[.76,.58,.30,1];
        rdr.circle(x,y+r*.18,r*.82,hideDark,14);
        rdr.circle(x,y+r*.08,r*.72,hide,14);
        rdr.poly([[x-r*.58,y+r*.42],[x-r*.70,y-r*.12],[x-r*.42,y-r*.58],[x,y-r*.82],[x+r*.42,y-r*.58],[x+r*.70,y-r*.12],[x+r*.58,y+r*.42]],plate);
        // Dorsal armor plates stay symmetric around the forward axis.
        for(let k=-1;k<=1;k++){const oy=(.16+k*.25)*r;rdr.line(x-r*.46,y+oy,x+r*.46,y+oy-r*.08,Math.max(1.5,2.5*sc),[.25,.16,.10,1])}
        // Paired inward-curving digging scythes: broad at the shoulders, flare outward,
        // then hook back toward the centerline near the tips.
        const scythe=(side)=>{
          const sx=side;
          rdr.poly([
            [x+sx*r*.28,y-r*.34],
            [x+sx*r*.58,y-r*.58],
            [x+sx*r*.88,y-r*.86],
            [x+sx*r*.96,y-r*1.12],
            [x+sx*r*.72,y-r*1.34],
            [x+sx*r*.42,y-r*1.43],
            [x+sx*r*.52,y-r*1.20],
            [x+sx*r*.68,y-r*.98],
            [x+sx*r*.58,y-r*.76],
            [x+sx*r*.16,y-r*.62]
          ],horn);
          // Bright inner cutting edge reinforces the inward hook.
          rdr.line(x+sx*r*.58,y-r*.76,x+sx*r*.68,y-r*.98,Math.max(1.2,2.0*sc),accent);
          rdr.line(x+sx*r*.68,y-r*.98,x+sx*r*.42,y-r*1.43,Math.max(1.2,1.8*sc),accent);
        };
        scythe(-1);scythe(1);
        // Four planted legs preserve the creature silhouette.
        for(const sx of [-.46,.46])for(const oy of [-.12,.38]){
          rdr.line(x+sx*r,y+oy*r,x+sx*r*1.35,y+(oy+.18)*r,Math.max(1.8,2.8*sc),hideDark);
        }
        if(attack)rdr.circle(x,y-r*.38,r*.30,[1,.68,.28,.12],12);
    }
  },
  "deepthorn":(rdr,ctx)=>{
    const {sc,x,y,r,accent,attack}=ctx;
    {
        const root=[.27,.38,.16,1],rootDark=[.15,.23,.10,1],bark=[.38,.50,.20,1],thorn=[.72,.90,.34,1];
        // Wide rooted base: this creature reads as a living subterranean siege-root, not a generic round monster.
        rdr.circle(x,y+r*.30,r*1.02,rootDark,16);
        for(let k=0;k<8;k++){
          const a=k*Math.PI/4,inner=.42*r,outer=(1.10+(k%2)*.16)*r;
          rdr.line(x+Math.cos(a)*inner,y+r*.30+Math.sin(a)*inner*.55,x+Math.cos(a)*outer,y+r*.30+Math.sin(a)*outer*.55,Math.max(2.4,3.8*sc),root);
          rdr.crestTriangle(x+Math.cos(a)*outer,y+r*.30+Math.sin(a)*outer*.55,r*.16,bark,a);
        }
        // Layered central root-bulb with a huge upward thorn matching the actual ground eruption.
        rdr.poly([[x-r*.62,y+r*.34],[x-r*.50,y-r*.26],[x-r*.28,y-r*.58],[x,y-r*.72],[x+r*.28,y-r*.58],[x+r*.50,y-r*.26],[x+r*.62,y+r*.34]],root);
        rdr.poly([[x-r*.38,y+r*.18],[x-r*.30,y-r*.28],[x,y-r*.56],[x+r*.30,y-r*.28],[x+r*.38,y+r*.18]],bark);
        rdr.poly([[x-r*.18,y-r*.38],[x-r*.10,y-r*.88],[x,y-r*1.48],[x+r*.10,y-r*.88],[x+r*.18,y-r*.38]],thorn);
        rdr.poly([[x-r*.07,y-r*.52],[x,y-r*1.28],[x+r*.07,y-r*.52]],accent);
        // Small lateral buds imply the researched second eruption without adding a hidden effect.
        rdr.crestTriangle(x-r*.46,y-r*.42,r*.20,thorn,-2.18);
        rdr.crestTriangle(x+r*.46,y-r*.42,r*.20,thorn,-.96);
        if(attack){
          rdr.circle(x,y+r*.04,r*1.18,[.64,.88,.30,.10],20);
          rdr.circle(x,y-r*.64,r*.34,[.82,1,.42,.18],12);
        }
    }
  },
  "siege":(rdr,ctx)=>{
    const {u,sc,x,y,r,teamDark,accent,attack}=ctx;
    // Cancel the outer generic facing transform: this species owns two independent pivots.
    const outer=rdr._unitFacingTransform;rdr._unitFacingTransform=null;
    try{
      const facing=rdr.artilleryFacingScreen(u),st=facing.deployState,d0=UnitDefinition.get(u.type)?.deployment||{},until=Number(u.behaviorState?.deploymentUntil)||0,nowTick=Number(rdr.snapshot?.tick)||0;
      let q=st==="deployed"?1:0;
      if(st==="deploying"){const total=Math.max(1,Math.round((Number(d0.deployMs)||900)/(1000/Math.max(1,Number(rdr.snapshot?.tps)||20))));q=RangeUtil.clamp(1-(until-nowTick)/total,0,1)}
      else if(st==="undeploying"){const total=Math.max(1,Math.round((Number(d0.undeployMs)||450)/(1000/Math.max(1,Number(rdr.snapshot?.tps)||20))));q=RangeUtil.clamp((until-nowTick)/total,0,1)}
      const ease=q*q*(3-2*q),drop=r*.30*ease;
      // HULL: tripod/chassis freezes when deployment begins.
      rdr.withFacingAngle(facing.hullAngle,u,x,y,()=>{
        const cannonAngle=-Math.PI/2,anchorBase=cannonAngle+Math.PI/3;
        for(let i=0;i<3;i++){const a=anchorBase+i*Math.PI*2/3,ca=Math.cos(a),sa=Math.sin(a),rootR=r*(.42+.08*ease),footR=r*(.68+.82*ease),sx=x+ca*rootR,sy=y-drop+sa*rootR*.72,ex=x+ca*footR,ey=y-drop+sa*footR*.72;
          rdr.line(sx,sy,ex,ey,Math.max(2.8,4.5*sc),[.25,.31,.15,1]);rdr.circle(ex,ey,r*(.12+.17*ease),[.31,.22,.10,1],10);
          if(ease>.30){const tx=-sa,ty=ca*.72;rdr.line(ex,ey,ex+tx*r*.25,ey+ty*r*.25,Math.max(1.4,2.2*sc),[.38,.25,.11,.88]);rdr.line(ex,ey,ex-tx*r*.25,ey-ty*r*.25,Math.max(1.4,2.2*sc),[.38,.25,.11,.88])}
        }
        rdr.circle(x,y+r*.08-drop,r*(.76+.10*ease),[.32,.36,.20,1],14);rdr.circle(x,y-r*.05-drop,r*.54,teamDark,12);
      });
      // TURRET ASSEMBLY: the whole upper body rotates around its bearing center.
      // Keeping every upper-body vertex centered on this pivot prevents the "head turning"
      // orbit that happened when the barrel and pod used different visual centers.
      const turretPivotX=x,turretPivotY=y-r*.08-drop;
      rdr.withFacingPivot(facing.turretAngle,u,turretPivotX,turretPivotY,turretPivotX,turretPivotY,()=>{
        const cx=turretPivotX,cy=turretPivotY;
        rdr.circle(cx,cy,r*.60,[.46,.48,.22,1],14);
        rdr.circle(cx,cy,r*.34,[.30,.34,.17,1],12);
        rdr.poly([[cx-r*.48,cy+r*.14],[cx-r*.34,cy-r*.40],[cx+r*.34,cy-r*.40],[cx+r*.48,cy+r*.14]],[.39,.43,.20,1]);
        rdr.circle(cx-r*.34,cy-r*.10,r*.15,[.70,.58,.25,1],9);rdr.circle(cx+r*.34,cy-r*.10,r*.15,[.70,.58,.25,1],9);
        rdr.poly([[cx-r*.32,cy+r*.16],[cx-r*.25,cy+r*.54],[cx+r*.25,cy+r*.54],[cx+r*.32,cy+r*.16]],[.29,.34,.17,1]);
        const kick=attack?r*.22:0,barrelLen=r*(1.50+1.05*ease)-kick;
        rdr.line(cx,cy-r*.12,cx,cy-barrelLen,Math.max(3.2,5.6*sc),[.34,.54,.23,1]);
        rdr.circle(cx,cy-r*(1.02+1.02*ease),r*.22,[.70,.58,.25,1],10);
        rdr.circle(cx,cy-barrelLen,r*.20,accent,10);
      });
      if(st==="deploying"&&ease>0)rdr.outlineCircle(x,y+r*.22,r*(.70+.78*ease),Math.max(1.4,2.2*sc),[.48,.32,.14,.48],20,1);
    }finally{rdr._unitFacingTransform=outer}
  },
  "rocket":(rdr,ctx)=>{
    const {sc,x,y,r,teamDark,attack}=ctx;
    // 다연발 봉선화: four swollen balsam seed pods arranged as a compact launcher.
    rdr.petalRing(x,y+r*.16,r*.86,7,[.38,.48,.24,1],Math.PI/7,.72);
    rdr.circle(x,y+r*.12,r*.60,teamDark,12);
    const pods=[[-.48,-.18],[.48,-.18],[-.28,-.72],[.28,-.72]];
    for(let i=0;i<4;i++){
      const [ox,oy]=pods[i],px=x+ox*r,py=y+oy*r;
      const pulse=attack?(.06+((i+1)*.025)):0;
      // Pod shell and four split petals make it read as a seed capsule rather than a gun barrel.
      rdr.circle(px,py,r*(.25+pulse),[.58,.66,.25,1],10);
      rdr.petalRing(px,py-r*.02,r*(.18+pulse),4,[1,.48,.30,1],Math.PI/4,.48);
      rdr.circle(px,py-r*.08,r*.09,[1,.86,.38,1],8);
      // Short launch throat points forward; no long conventional cannon tube.
      rdr.line(px,py-r*.08,px,py-r*(.42+(attack?.08:0)),Math.max(1.8,2.7*sc),[.42,.58,.24,1]);
    }
    if(attack)rdr.circle(x,y-r*.28,r*1.08,[1,.52,.24,.08],16);
  }
});
class UnitVisualLookup{
  static renderer(type){return UNIT_VISUAL_RENDER_FNS[type]||null}
  static cachePolicy(type){return UNIT_VISUAL_RENDER_FNS[type]?.cachePolicy==="STATIC"?"STATIC":"DYNAMIC"}
  static validateCoverage(){
    const missing=[];
    for(const id of Object.keys(UnitDefinition.all)){
      const d=UnitDefinition.get(id);
      if(d?.layer==="AIR"&&(AIR_UNIT_VISUAL_RENDER_FNS[id]||d?.targetLeashToSummoner))continue;
      if(!this.renderer(id))missing.push(id);
    }
    if(missing.length)throw new Error(`Missing unit visual renderer: ${missing.join(", ")}`);
    return true;
  }
}

class GeometryTemplateCache{
  constructor(){this.regular=new Map();this.outline=new Map();this.petals=new Map()}
  regularPolygon(n=10,rot=0){
    n=Math.max(3,n|0);
    const key=n+"|"+Number(rot).toFixed(6);
    let pts=this.regular.get(key);
    if(pts)return pts;
    pts=new Float32Array(n*2);
    for(let i=0;i<n;i++){
      const a=rot+i/n*Math.PI*2;
      pts[i*2]=Math.cos(a);pts[i*2+1]=Math.sin(a);
    }
    this.regular.set(key,pts);return pts;
  }
  outlineCircle(segments=56){
    segments=Math.max(3,segments|0);
    let pts=this.outline.get(segments);
    if(pts)return pts;
    pts=new Float32Array(segments*2);
    for(let i=0;i<segments;i++){
      const a=i/segments*Math.PI*2;
      pts[i*2]=Math.cos(a);pts[i*2+1]=Math.sin(a);
    }
    this.outline.set(segments,pts);return pts;
  }
  petalRing(count=6,rot=0){
    count=Math.max(1,count|0);
    const key=count+"|"+Number(rot).toFixed(6);
    let pts=this.petals.get(key);
    if(pts)return pts;
    pts=new Float32Array(count*2);
    for(let i=0;i<count;i++){
      const a=rot+i/count*Math.PI*2;
      pts[i*2]=Math.cos(a);pts[i*2+1]=Math.sin(a);
    }
    this.petals.set(key,pts);return pts;
  }
}
const SHARED_GEOMETRY_TEMPLATES=new GeometryTemplateCache();

class RenderPassProfiler{
  constructor(){
    this.names=["prepare","device-begin","ground","shadow","world","overlay","ui-fx","camera-compose","minimap"];
    this.current=Object.create(null);this.ewma=Object.create(null);this.max=Object.create(null);
  }
  beginFrame(){for(const n of this.names)this.current[n]=0}
  measure(name,fn){
    const t=performance.now();
    try{return fn()}finally{
      const ms=performance.now()-t;
      this.current[name]=(this.current[name]||0)+ms;
      this.ewma[name]=this.ewma[name]?this.ewma[name]*.85+ms*.15:ms;
      this.max[name]=Math.max(this.max[name]||0,ms);
    }
  }
  snapshot(){
    const out={};
    for(const n of this.names)out[n]={ms:this.current[n]||0,ewmaMs:this.ewma[n]||0,maxMs:this.max[n]||0};
    return out;
  }
}
const AIR_UNIT_VISUAL_RENDER_FNS=Object.freeze({
  "flowerbee":(rdr,c)=>{const {r,accent,attack,sc,pt,linePts,fastFlap,wingBright,wingSoft,body,bodyDark}=c;
      // Compact bee: chunky striped abdomen + petal-like double wings.
      const flap=.78+.28*fastFlap;
      for(const side of [-1,1]){
        const root=pt(.02,side*.20),outer=pt(-.08,side*.92*flap),rear=pt(-.42,side*.70*flap);
        rdr.poly([root,outer,rear,pt(-.28,side*.18)],wingBright);
        rdr.poly([pt(.15,side*.15),pt(.32,side*.74*flap),pt(.02,side*.62*flap),pt(-.04,side*.13)],wingSoft);
      }
      const rear=pt(-.40,0),mid=pt(.02,0),head=pt(.43,0),sting=pt(-.86,0);
      rdr.circle(rear[0],rear[1],r*.48,[.78,.54,.16,1],11);
      rdr.circle(mid[0],mid[1],r*.46,body,11);rdr.circle(head[0],head[1],r*.32,bodyDark,9);
      for(const f of [-.58,-.38,-.18]){const a=pt(f,-.31),b=pt(f,.31);linePts(a,b,Math.max(1.2,1.9*sc),[.22,.16,.08,.92])}
      linePts(pt(-.62,0),sting,Math.max(1.2,1.8*sc),accent);
      if(attack){const a=pt(.50,0),b=pt(1.12,0);linePts(a,b,Math.max(1.6,2.5*sc),[1,.86,.34,.88]);rdr.circle(b[0],b[1],r*.11,[1,.93,.54,.72],7)}
    },
  "sporefly":(rdr,c)=>{const {r,attack,pt,fastFlap,wingSoft,body,bodyDark}=c;
      // Tiny fly: bulbous eyes, short translucent wings, unmistakable spore sacs on the rear.
      const flap=.70+.34*fastFlap;
      for(const side of [-1,1])rdr.poly([pt(.10,side*.12),pt(.20,side*.86*flap),pt(-.30,side*.68*flap),pt(-.24,side*.10)],wingSoft);
      const bodyP=pt(-.05,0),head=pt(.38,0);
      rdr.circle(bodyP[0],bodyP[1],r*.43,body,10);rdr.circle(head[0],head[1],r*.28,bodyDark,9);
      rdr.circle(...pt(-.42,-.26),r*.18,[.74,.92,.38,.92],8);rdr.circle(...pt(-.50,.04),r*.20,[.64,.86,.30,.92],8);rdr.circle(...pt(-.39,.29),r*.16,[.78,.94,.44,.90],8);
      rdr.circle(...pt(.45,-.13),r*.09,[.92,1,.76,.92],7);rdr.circle(...pt(.45,.13),r*.09,[.92,1,.76,.92],7);
      if(attack){for(const side of [-.18,0,.18]){const q=pt(.75,side);rdr.circle(q[0],q[1],r*.075,[.76,1,.50,.58],6)}}
    },
  "gustmayfly":(rdr,c)=>{const {u,r,teamLight,sc,pt,linePts,slowFlap,wingBright,body,bodyDark}=c;
      // Mayfly: long needle body, oversized upright wings and three trailing filaments.
      const flap=.84+.18*slowFlap;
      const nose=pt(.72,0),tail=pt(-.76,0);
      linePts(tail,nose,Math.max(2,3.2*sc),bodyDark);rdr.circle(...pt(.20,0),r*.22,body,9);rdr.circle(nose[0],nose[1],r*.16,teamLight,8);
      for(const side of [-1,1])rdr.poly([pt(.18,side*.10),pt(.10,side*1.08*flap),pt(-.26,side*.90*flap),pt(-.22,side*.08)],wingBright);
      for(const side of [-.16,0,.16])linePts(tail,pt(-1.55,side),Math.max(1,1.25*sc),[.72,.94,1,.72]);
      const ramp=RangeUtil.clamp(Math.max(0,(Number(rdr.snapshot?.tick)||0)-(Number(u.movement.outOfCombatStartedAt)||0)+1)/Math.max(1,SimulationTiming.msToTicks(Number(UnitDefinition.get(u.type)?.outOfCombatRampMs)||3000,rdr.snapshot?.tps||SIM_TPS)),0,1);
      if(ramp>.12){
        for(let k=0;k<3;k++){const side=(k-1)*.20,a=pt(-.85-k*.14,side),b=pt(-1.45-k*.28,side);linePts(a,b,Math.max(1,1.3*sc),[.48,.92,1,.10+.22*ramp])}
      }
    },
  "lanternmoth":(rdr,c)=>{const {r,sc,pt,linePts,now,seed,slowFlap,wingBright,wingSoft,body,bodyDark}=c;
      // Light moth: broad symmetric wings and a central lantern organ.
      const flap=.90+.12*slowFlap;
      for(const side of [-1,1]){
        rdr.poly([pt(.22,side*.10),pt(.18,side*1.18*flap),pt(-.48,side*1.02*flap),pt(-.64,side*.38),pt(-.18,side*.08)],wingBright);
        rdr.poly([pt(-.10,side*.10),pt(-.48,side*.76),pt(-.72,side*.44),pt(-.38,side*.08)],wingSoft);
      }
      rdr.circle(...pt(-.08,0),r*.36,bodyDark,10);rdr.circle(...pt(.34,0),r*.24,body,9);
      const glow=.78+.22*Math.sin(now*.006+seed),lamp=pt(-.12,0);
      rdr.circle(lamp[0],lamp[1],r*.24*glow,[1,.86,.30,.95],10);rdr.circle(lamp[0],lamp[1],r*.48*glow,[1,.88,.34,.10],14);
      for(const side of [-1,1])linePts(pt(.45,side*.08),pt(.78,side*.22),Math.max(1,1.15*sc),[1,.91,.56,.62]);
    },
  "sporemoth":(rdr,c)=>{const {r,attack,pt,now,seed,slowFlap,wingSoft,body,bodyDark}=c;
      // Bomber moth: short thick wings and a conspicuous hanging spore sac.
      const flap=.86+.15*slowFlap;
      for(const side of [-1,1])rdr.poly([pt(.18,side*.12),pt(.02,side*.98*flap),pt(-.54,side*.82*flap),pt(-.68,side*.28),pt(-.20,side*.08)],wingSoft);
      rdr.circle(...pt(-.06,0),r*.48,bodyDark,11);rdr.circle(...pt(.32,0),r*.27,body,9);
      const swell=attack?1.22:(.94+.08*Math.sin(now*.007+seed)),sac=pt(-.48,0);
      rdr.circle(sac[0],sac[1],r*.34*swell,[.67,.40,.82,.98],11);rdr.circle(sac[0],sac[1],r*.17*swell,[.88,.72,1,.86],9);
      if(attack)rdr.circle(sac[0],sac[1],r*.62,[.72,.50,.92,.10],14);
    },
  "hunterwasp":(rdr,c)=>{const {u,r,teamLight,accent,attack,sc,fx,fy,pt,linePts,fastFlap,wingBright,body,bodyDark}=c;
      // Hunter wasp: head is clearly forward; the anatomical stinger belongs to the rear abdomen.
      // Attack readability comes from a brief abdomen-curl strike trail, never a horn on the head.
      const flap=.72+.32*fastFlap,attackKick=attack?.10:0;
      for(const side of [-1,1])rdr.poly([pt(.08,side*.08),pt(.18,side*.84*flap),pt(-.28,side*.69*flap),pt(-.36,side*.08)],wingBright);
      // Tapered striped abdomen -> narrow waist -> thorax -> small head.
      rdr.poly([pt(-.12,-.24),pt(-.34,-.40),pt(-.70,-.27),pt(-.82,0),pt(-.70,.27),pt(-.34,.40),pt(-.12,.24)],[.92,.58,.16,1]);
      for(const f of [-.61,-.45,-.29])linePts(pt(f,-.27),pt(f,.27),Math.max(1.2,1.8*sc),[.18,.12,.08,.90]);
      rdr.circle(...pt(.02,0),r*.31,body,10);
      rdr.circle(...pt(.43+attackKick,0),r*.25,bodyDark,9);
      // Antennae/mandibles establish the front without reading as a weapon spike.
      for(const side of [-1,1]){
        linePts(pt(.54,side*.08),pt(.72,side*.24),Math.max(1,1.15*sc),teamLight);
        linePts(pt(.58,side*.07),pt(.72,side*.10),Math.max(1,1.2*sc),accent);
      }
      // Permanent rear stinger: short, dark-rooted and unmistakably attached to the abdomen.
      linePts(pt(-.76,0),pt(-1.00,0),Math.max(1.3,2.0*sc),[.24,.16,.08,.96]);
      rdr.crestTriangle(...pt(-1.05,0),r*.12,accent,Math.atan2(-fy,-fx));
      if(attack){
        // Fast curled-abdomen sting gesture toward the target side. It is presentation-only.
        const side=((HashUtil.hash(u.id)+(Number(rdr.snapshot?.tick)||0))&1)?1:-1;
        const a=pt(-.66,side*.06),b=pt(-.30,side*.50),d=pt(.36,side*.34),tip=pt(.68,side*.12);
        linePts(a,b,Math.max(1.2,1.8*sc),[1,.70,.22,.36]);
        linePts(b,d,Math.max(1.5,2.3*sc),[1,.78,.28,.62]);
        linePts(d,tip,Math.max(1.2,2.0*sc),[1,.92,.58,.82]);
        rdr.circle(tip[0],tip[1],r*.13,[1,.90,.42,.76],8);
      }
    },
  "sailwing":(rdr,c)=>{const {r,teamLight,sc,delta,pt,linePts,now,seed,bodyDark}=c;
      // Sail-wing: the wings ARE the silhouette; tiny core, huge leaf-sails, mostly gliding.
      const breathe=.96+.06*Math.sin(now*.004+seed);
      for(const side of [-1,1]){
        rdr.poly([pt(.30,side*.10),pt(.10,side*1.48*breathe),pt(-.62,side*1.18*breathe),pt(-.82,side*.36),pt(-.18,side*.08)],side<0?[.38,.82,.66,.78]:[.48,.90,.74,.78]);
        linePts(pt(.18,side*.10),pt(-.56,side*1.06*breathe),Math.max(1,1.25*sc),[.20,.54,.38,.55]);
      }
      rdr.circle(...pt(-.05,0),r*.28,bodyDark,9);rdr.circle(...pt(.22,0),r*.20,teamLight,8);
      const moving=Math.hypot(delta.x,delta.y)>.001;
      if(moving){for(const side of [-.35,.35])linePts(pt(-.72,side),pt(-1.34,side*.72),Math.max(1,1.3*sc),[.42,.92,.78,.20])}
    },
  "ancientmistray":(rdr,c)=>{const {r,teamLight,sc,pt,linePts,now,seed}=c;
      // Ancient mist ray: one continuous manta silhouette, no insect body/paired generic wings.
      const wave=.12*Math.sin(now*.004+seed),front=pt(.72,0),rear=pt(-.70,0),left=pt(-.06,-1.46-wave),right=pt(-.06,1.46+wave);
      rdr.poly([front,left,pt(-.74,-.54),rear,pt(-.74,.54),right],[.42,.68,.82,.82]);
      rdr.poly([pt(.40,0),pt(-.02,-.88-wave*.5),pt(-.40,0),pt(-.02,.88+wave*.5)],[.62,.86,.94,.48]);
      rdr.circle(...pt(.18,0),r*.28,teamLight,10);linePts(rear,pt(-1.48,0),Math.max(1.2,1.8*sc),[.58,.82,.88,.68]);
      for(let k=0;k<3;k++){const q=(now*.00025+k/3+seed)%1,p=pt(-.72-q*.70,(k-1)*.34);rdr.circle(p[0],p[1],r*(.10+.06*(1-q)),[.72,.90,.96,.10*(1-q)],9)}
    },
  "hivecarrier":(rdr,c)=>{const {r,pt,now,seed,body}=c;
      // Carrier: massive seed-hive with four visible launch ports and slow lifting petals.
      const pulse=.5+.5*Math.sin(now*.003+seed),flap=.96+.05*Math.sin(now*.005+seed);
      for(const side of [-1,1])rdr.poly([pt(.12,side*.18),pt(-.02,side*1.10*flap),pt(-.70,side*.82),pt(-.50,side*.18)], [.66,.58,.30,.72]);
      rdr.circle(...pt(-.08,0),r*.74,[.34,.30,.17,1],14);rdr.circle(...pt(.20,0),r*.56,body,13);
      for(const side of [-1,1])for(const f of [-.28,.26]){const port=pt(f,side*.40);rdr.circle(port[0],port[1],r*.13,[.12,.10,.06,1],8);rdr.circle(port[0],port[1],r*(.06+.025*pulse),[.94,.78,.30,.72],7)}
      rdr.circle(...pt(.22,0),r*.18,[1,.86,.42,.72],9);
    },
  "queenwasp":(rdr,c)=>{const {x,y,r,accent,body,bodyDark,pt,linePts,sc,fastFlap}=c;
    const flap=.82+.18*fastFlap;
    for(const side of [-1,1])rdr.poly([pt(-.05,side*.12),pt(-.18,side*.92*flap),pt(.34,side*.62*flap),pt(.28,side*.10)],[.92,.82,.42,.42]);
    rdr.circle(x,y,r*.62,bodyDark,12);rdr.circle(x,y-r*.05,r*.48,body,12);
    rdr.circle(...pt(.48,0),r*.28,accent,9);for(const side of [-1,1])linePts(pt(.56,side*.08),pt(.92,side*.28),Math.max(1,1.5*sc),accent);
  },
  "seedwasp":(rdr,c)=>{const {x,y,r,accent,body,bodyDark,pt,fastFlap}=c;
    const flap=.78+.22*fastFlap;
    for(const side of [-1,1])rdr.poly([pt(-.08,side*.06),pt(-.22,side*.72*flap),pt(.22,side*.48*flap),pt(.22,side*.04)],[.94,.84,.48,.38]);
    rdr.circle(x,y,r*.48,bodyDark,10);rdr.circle(...pt(.30,0),r*.28,body,9);rdr.crestTriangle(...pt(.62,0),r*.18,accent,0);
  },
});
const PROJECTILE_ORIGIN_ADJUSTERS=Object.freeze({
  dragonFireball:(rdr,c)=>{const {p}=c;let {x,y}=c;
      const source=(rdr.snapshot?.units||[]).find(u=>u.id===p.owner&&u.alive&&UnitVisualDefinition.get(u.type)?.specialMouthPose);
      if(source){
        const sp=rdr.projectEntityScreen(source,"unit"),pose=rdr.resolveDragonRenderPose(source,sp.x,sp.y,rdr.unitRenderRadius(source));
        const travel=Math.hypot((p.x??0)-(p.launchX??p.x),(p.y??0)-(p.launchY??p.y)),q=RangeUtil.clamp(travel/78,0,1);
        x=pose.mouth[0]+(x-pose.mouth[0])*q;y=pose.mouth[1]+(y-pose.mouth[1])*q;
      }
    ;return{x,y}}
});
const PROJECTILE_VISUAL_RENDER_FNS=Object.freeze({
  "launchAmmo":(rdr,c)=>{const {p,sc,screenMotion,x,y}=c;
    // Each grain flies as its own bundle SVG, nose along the screen-space flight direction.
    const dx=screenMotion?.valid?screenMotion.dx:1,dy=screenMotion?.valid?screenMotion.dy:0,length=Math.max(30,58*sc);
    const record=rdr.launchAmmoRecord(p.payload?.type);if(!record)return;
    rdr.drawVectorBillboard(record,x,y,Math.atan2(dy,dx),length/200);
    rdr.circle(x,y,Math.max(2,3*sc),rdr.factionRelation(p.side)==="friendly"?[.30,.55,1,1]:[1,.36,.32,1],8);
  },
  "guardRetaliation":(rdr,c)=>{const {p,sc,wp}=c;let {x,y}=c;
    // Guardshroom retaliation: chunky spore pod, visibly distinct from the normal light projectile.
    const rr=Math.max(3.4,(p.drawRadius||5)*sc);
    rdr.circle(x,y,rr*2.15,[.72,.92,.32,.13],12);
    rdr.circle(x,y,rr*1.30,[.62,.82,.24,.42],10);
    rdr.circle(x,y,rr,[.86,.96,.46,1],9);
    for(let k=0;k<3;k++){const a=(k/3)*Math.PI*2+(wp.progress||0)*2.4;rdr.circle(x+Math.cos(a)*rr*1.35,y+Math.sin(a)*rr*1.35,rr*.28,[.94,1,.68,.72],7)}
  },
  "medicShock":(rdr,c)=>{const {p,sc,wp}=c;let {x,y}=c;
    // T3 combat-dew shell: a visibly heavier dew globule travelling on the shared arc path.
    // The ground shadow/height are owned by resolveArcTravelPresentation; this renderer only owns appearance.
    const rr=Math.max(3.2,(p.drawRadius||5)*sc);
    rdr.circle(x,y,rr*2.15,[.38,.92,1,.12],12);
    rdr.circle(x,y,rr*1.35,[.34,.82,1,.34],10);
    rdr.circle(x,y,rr,[.66,.95,1,1],9);
    rdr.circle(x-rr*.22,y-rr*.22,rr*.42,[1,1,1,.92],8);
    if(wp.y>2){
      const q=.55+.45*Math.sin((wp.progress||0)*Math.PI);
      rdr.outlineCircle(x,y,rr*(1.45+.25*q),Math.max(1,1.5*sc),[.72,.96,1,.48],14,1);
    }
  },
  "fireAntEmber":(rdr,c)=>{const {p,sc}=c;let {x,y}=c;
      // Tiny compressed flame seed: bright core + orange body + faint heat halo.
      const rr=Math.max(1.8,(p.drawRadius||3)*sc);
      rdr.circle(x,y,rr*1.9,[1,.28,.04,.10],10);
      rdr.circle(x,y,rr,[1,.38,.08,1],8);
      rdr.circle(x,y,rr*.52,[1,.92,.42,1],7);
      const vx=(p.x??0)-(p.launchX??p.x),vy=(p.y??0)-(p.launchY??p.y),vl=Math.hypot(vx,vy)||1;
      const nx=vx/vl,ny=vy/vl;
      // Flame tongue extends both behind and slightly ahead of the projectile core,
      // so the visible fire reaches the same homing impact point as the simulation projectile.
      rdr.line(x-nx*rr*3.8,y-ny*rr*3.8,x+nx*rr*.85,y+ny*rr*.85,Math.max(1,rr*.9),[1,.30,.05,.42]);
      rdr.circle(x+nx*rr*.55,y+ny*rr*.55,rr*.62,[1,.78,.20,.72],7);
    },
  "armorSeed":(rdr,c)=>{const {p,sc}=c;let {x,y}=c;const rr=Math.max(3.5,(p.drawRadius||6)*sc);rdr.circle(x,y,rr*1.8,[.20,.12,.06,.18],10);rdr.circle(x,y,rr,[.42,.28,.12,1],9);rdr.circle(x-rr*.18,y-rr*.18,rr*.45,[.92,.76,.38,.9],8);},
  "balsamRocket":(rdr,c)=>{const {p,sc,target,screenMotion}=c;let {x,y}=c;const rr=Math.max(2.8,(p.drawRadius||4)*sc);let dx=screenMotion?.valid?screenMotion.dx:0,dy=screenMotion?.valid?screenMotion.dy:0;
    if(!screenMotion?.valid&&target){const tp=rdr.projectRenderWorldPosition({x:target.x+(Number(p.aimOffsetX)||0),y:0,z:target.y+(Number(p.aimOffsetY)||0)});dx=tp.x-x;dy=tp.y-y;const dl=Math.hypot(dx,dy)||1;dx/=dl;dy/=dl}
    if(Math.hypot(dx,dy)<.001){dx=1;dy=0}
    const sx=-dy,sy=dx,nose=[x+dx*rr*2.25,y+dy*rr*2.25],rear=[x-dx*rr*1.55,y-dy*rr*1.55];
    rdr.poly([[nose[0],nose[1]],[x+sx*rr*.72,y+sy*rr*.72],[rear[0]+sx*rr*.52,rear[1]+sy*rr*.52],[rear[0]-sx*rr*.52,rear[1]-sy*rr*.52],[x-sx*rr*.72,y-sy*rr*.72]],[.66,.30,.12,1]);
    rdr.line(x-dx*rr*1.45,y-dy*rr*1.45,x-dx*rr*5.4,y-dy*rr*5.4,Math.max(1.4,rr*.82),[1,.38,.10,.58]);rdr.circle(nose[0],nose[1],rr*.42,[1,.88,.46,1],7);rdr.circle(x-dx*rr*2.0,y-dy*rr*2.0,rr*.58,[1,.22,.06,.42],8);
  },
  "deathworm":(rdr,c)=>{const {p,sc}=c;let {x,y}=c;
      const rupture=p.visualTag==="rupture";
      // High-contrast worm spit: pale hot core + red-orange rim + dark silhouette/trail.
      // It must remain readable over grass, river, dirt and fog.
      const rr=Math.max(3.6,(rupture?8.2:5.6)*sc);
      const vx=(p.x??0)-(p.launchX??p.x),vy=(p.y??0)-(p.launchY??p.y),vl=Math.hypot(vx,vy)||1;
      const nx=vx/vl,ny=vy/vl;
      rdr.line(x-nx*rr*4.6,y-ny*rr*4.6,x-nx*rr*.35,y-ny*rr*.35,Math.max(2.2,rr*.92),[.16,.045,.025,.62]);
      rdr.line(x-nx*rr*3.7,y-ny*rr*3.7,x,y,Math.max(1.4,rr*.48),[1,.42,.18,.72]);
      rdr.circle(x,y,rr*2.15,[.10,.025,.015,.24],12);
      rdr.circle(x,y,rr*1.55,[1,.30,.10,.20],11);
      rdr.circle(x,y,rr,[.94,.48,.24,1],10);
      rdr.circle(x,y,rr*.55,[1,.91,.62,1],9);
      rdr.circle(x-nx*rr*.18,y-ny*rr*.18,rr*.23,[1,1,.86,.98],7);
      if(rupture){
        rdr.outlineCircle(x,y,rr*1.75,Math.max(1.5,2.2*sc),[1,.68,.24,.58],16,1);
        rdr.circle(x,y,rr*2.8,[1,.22,.06,.10],14);
      }
    },
  "dragon":(rdr,c)=>{const {p,sc}=c;let {x,y}=c;
      const rr=Math.max(4,(p.drawRadius||9)*sc);
      rdr.circle(x,y,rr,[1,.35,.08,1],10);rdr.circle(x,y,rr*.58,[1,.86,.28,1],9);rdr.circle(x,y,rr*1.9,[1,.25,.04,.10],12);
    },
  "ancientbear":(rdr,c)=>{const {p,sc}=c;let {x,y}=c;
      const rr=Math.max(3,(p.drawRadius||7)*sc);
      rdr.circle(x,y,rr,[.48,.34,.20,1],8);rdr.circle(x,y,rr*.48,[.78,.64,.38,1],8);
    },
  "thornTower":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      rdr.circle(x,y,Math.max(2,4*sc),[.72,1,.44,1],6);
      rdr.circle(x,y,Math.max(1.2,2.1*sc),[.94,1,.72,.72],6);
    },
  "acornTower":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      rdr.circle(x,y,Math.max(2,5*sc),[1,.72,.28,1],6);
      rdr.circle(x,y,Math.max(1.5,2.4*sc),[1,.88,.58,.78],6);
    },
  "sunvineTower":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      rdr.circle(x,y,Math.max(2.5,5*sc),[1,.82,.22,1],8);
      rdr.circle(x,y,Math.max(1.5,2.6*sc),[1,.96,.64,.90],8);
      rdr.circle(x,y,Math.max(4,8*sc),[1,.82,.22,.12],10);
    },
  "mortarTower":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      const r=Math.max(3,5.5*sc);
      rdr.circle(x,y,r,[.79,.58,.30,1],8);
      rdr.circle(x,y,r*.55,[.56,.34,.19,1],8);
      rdr.circle(x,y,r*1.75,[.95,.76,.32,.08],12);
    },
  "siege":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      const r=Math.max(3,5.4*sc);
      rdr.circle(x,y,r,[.88,.72,.32,1],8);
      rdr.circle(x,y,r*.62,[.62,.42,.16,1],8);
      rdr.circle(x,y,r*1.55,[1,.86,.38,.08],12);
    },
  "rocket":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      const r=Math.max(2.8,5.1*sc);
      rdr.circle(x,y,r,[.99,.42,.24,1],8);
      rdr.circle(x,y,r*.56,[1,.86,.42,.84],8);
      rdr.circle(x,y+r*.95,Math.max(1.6,r*.55),[1,.78,.18,.44],8);
    },
  "lanternmoth":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      const rr=Math.max(2.4,4.3*sc);rdr.circle(x,y,rr,[1,.88,.34,1],9);rdr.circle(x,y,rr*.45,[1,1,.78,.95],8);rdr.circle(x,y,rr*2.0,[1,.88,.32,.10],12);
    },
  "sporemoth":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      const rr=Math.max(3,5.2*sc);rdr.circle(x,y,rr,[.68,.42,.82,1],9);rdr.circle(x,y,rr*.52,[.88,.72,1,.92],8);rdr.circle(x,y,rr*1.8,[.62,.86,.34,.10],12);
    },
  "sailwing":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      const rr=Math.max(2.1,3.8*sc);rdr.circle(x,y,rr,[.48,.92,.76,.90],8);rdr.circle(x,y,rr*1.8,[.48,.92,.76,.08],10);
    },
  "ancientmistray":(rdr,c)=>{const {sc}=c;let {x,y}=c;
      const rr=Math.max(2.5,4.5*sc);rdr.circle(x,y,rr,[.65,.86,.96,.88],9);rdr.circle(x,y,rr*2.1,[.62,.84,.94,.09],12);
    }
});
class ProjectileVisualFallback{
  static render(rdr,c){const {p,sc}=c;let {x,y}=c;
      const impact=AttackPresentationDefinition.forSource(p.type).impact;
      // Projectile visual direction must not depend on the target still existing.
      // Render motion is primary; cache-cold frames fall back only to the
      // simulation-owned locked aim point from the current projectile contract.
      let dx=Number(c.screenMotion?.dx)||0,dy=Number(c.screenMotion?.dy)||0;
      let directionValid=!!c.screenMotion?.valid;
      if(!directionValid&&Number.isFinite(Number(p.lockedAimX))&&Number.isFinite(Number(p.lockedAimY))){
        const ap=rdr.worldToPx(rdr.viewX(Number(p.lockedAimX)),rdr.viewY(Number(p.lockedAimY)));
        dx=ap[0]-x;dy=ap[1]-y;directionValid=Math.hypot(dx,dy)>.01;
      }
      if(!directionValid){dx=1;dy=0}
      const len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;
      if(impact==="arcane"){
        rdr.line(x-dx*12*sc,y-dy*12*sc,x-dx*3*sc,y-dy*3*sc,Math.max(1.2,2.2*sc),[.68,.48,1,.30]);
        rdr.circle(x,y,Math.max(2.4,4.6*sc),[.72,.53,1,1],8);
        rdr.circle(x,y,Math.max(4.5,8*sc),[.72,.53,1,.13],10);
      }else if(impact==="pierce"){
        rdr.line(x-dx*10*sc,y-dy*10*sc,x+dx*6*sc,y+dy*6*sc,Math.max(1,1.8*sc),[1,.91,.56,.95]);
        rdr.circle(x+dx*5*sc,y+dy*5*sc,Math.max(1.4,2.5*sc),[1,.97,.75,1],6);
      }else if(impact==="explosive"){
        rdr.line(x-dx*12*sc,y-dy*12*sc,x-dx*3*sc,y-dy*3*sc,Math.max(1.4,2.5*sc),[1,.46,.18,.35]);
        rdr.circle(x,y,Math.max(2.8,5.1*sc),[1,.48,.22,1],8);
        rdr.circle(x,y,Math.max(5,8.8*sc),[1,.62,.20,.10],10);
      }else{
        rdr.line(x-dx*8*sc,y-dy*8*sc,x-dx*2*sc,y-dy*2*sc,Math.max(1,1.5*sc),[.72,.86,.45,.28]);
        rdr.circle(x,y,Math.max(2.2,4.2*sc),[.78,.88,.48,1],7);
        rdr.circle(x,y,Math.max(1.1,2.0*sc),[.96,.97,.68,.78],7);
      }
    }
}
const UNIT_PRODUCTION_TOPPER_RENDER_FNS=Object.freeze({
  "swordsman":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.poly([[x-r*.18,y-r*.34],[x-r*.06,y-r*.72],[x+r*.32,y-r*.84],[x+r*.16,y-r*.40]],trim);
      },
  "pikeman":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.line(x,y-r*.82,x,y-r*.24,Math.max(2,2.8*sc),[.30,.55,.22,1]);
        renderer.crestTriangle(x,y-r*.86,r*.14,trim,-Math.PI/2);
      },
  "lancer":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.line(x-r*.16,y-r*.38,x-r*.34,y-r*.76,Math.max(1.8,2.5*sc),trim);
        renderer.line(x+r*.16,y-r*.38,x+r*.34,y-r*.76,Math.max(1.8,2.5*sc),trim);
      },
  "archer":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.circle(x,y-r*.50,r*.10,[.72,.58,.26,1],8);
        renderer.poly([[x-r*.28,y-r*.66],[x-r*.06,y-r*.50],[x-r*.28,y-r*.34]],trim);
        renderer.poly([[x+r*.28,y-r*.66],[x+r*.06,y-r*.50],[x+r*.28,y-r*.34]],trim);
      },
  "skirmisher":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.circle(x-r*.15,y-r*.52,r*.13,trim,8);renderer.circle(x+r*.10,y-r*.60,r*.11,trim,8);renderer.circle(x+r*.22,y-r*.42,r*.09,trim,8);
      },
  "shellbug":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.circle(x,y-r*.50,r*.24,trim,10);renderer.line(x,y-r*.70,x,y-r*.30,Math.max(1.2,2*sc),[.15,.20,.12,1]);
      },
  "stingbug":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.line(x-r*.20,y-r*.42,x+r*.22,y-r*.72,Math.max(1.8,2.5*sc),trim);renderer.crestTriangle(x+r*.27,y-r*.76,r*.16,trim,-.6);
      },
  "dandelion":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.circle(x,y-r*.52,r*.08,trim,8);for(let k=0;k<7;k++){const a=k*Math.PI*2/7;renderer.line(x,y-r*.52,x+Math.cos(a)*r*.26,y-r*.52+Math.sin(a)*r*.26,Math.max(1,1.4*sc),[.94,.95,.82,1])}
      },
  "thornfruit":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.circle(x,y-r*.50,r*.17,trim,9);for(let k=0;k<6;k++){const a=k*Math.PI/3;renderer.line(x+Math.cos(a)*r*.16,y-r*.50+Math.sin(a)*r*.16,x+Math.cos(a)*r*.31,y-r*.50+Math.sin(a)*r*.31,Math.max(1,1.5*sc),trim)}
      },
  "tank":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.circle(x,y-r*.50,r*.25,trim,10);renderer.line(x-r*.24,y-r*.50,x+r*.24,y-r*.50,Math.max(1.3,2*sc),[.28,.36,.18,1]);
      },
  "rogue":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.line(x-r*.12,y-r*.44,x-r*.34,y-r*.72,Math.max(1.5,2.1*sc),trim);renderer.line(x+r*.12,y-r*.44,x+r*.34,y-r*.72,Math.max(1.5,2.1*sc),trim);
      },
  "mage":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.petalRing(x,y-r*.50,r*.23,6,trim,Math.PI/6,.68);renderer.circle(x,y-r*.50,r*.08,[.94,.75,1,1],7);
      },
  "medic":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.petalRing(x,y-r*.50,r*.20,5,trim,0,.66);renderer.circle(x+r*.16,y-r*.58,r*.10,[.66,1,.88,.72],8);
      },
  "pillbug":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.circle(x,y-r*.50,r*.18,trim,10);renderer.line(x-r*.14,y-r*.50,x+r*.14,y-r*.50,Math.max(1.2,2*sc),[.16,.18,.20,1]);renderer.line(x,y-r*.65,x,y-r*.35,Math.max(1.2,2*sc),[.16,.18,.20,1]);
      },
  "rootstalker":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.line(x,y-r*.72,x,y-r*.32,Math.max(1.8,2.4*sc),trim);renderer.line(x,y-r*.40,x-r*.22,y-r*.24,Math.max(1.2,1.8*sc),trim);renderer.line(x,y-r*.40,x+r*.22,y-r*.24,Math.max(1.2,1.8*sc),trim);
      },
  "chainflower":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.petalRing(x,y-r*.50,r*.22,5,trim,0,.65);
      },
  "guardshroom":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.circle(x,y-r*.53,r*.24,trim,10);renderer.rect(x-r*.05,y-r*.53,r*.10,r*.28,[.78,.70,.54,1]);
      },
  "sporeherd":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.circle(x-r*.16,y-r*.52,r*.10,trim,8);renderer.circle(x+r*.16,y-r*.52,r*.10,trim,8);renderer.circle(x,y-r*.70,r*.11,trim,8);
      },
  "clawhunter":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.line(x-r*.05,y-r*.42,x-r*.28,y-r*.70,Math.max(1.6,2.2*sc),trim);renderer.line(x+r*.05,y-r*.42,x+r*.28,y-r*.70,Math.max(1.6,2.2*sc),trim);
      },
  "mantis":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.line(x-r*.05,y-r*.42,x-r*.30,y-r*.68,Math.max(1.5,2.1*sc),trim);renderer.line(x+r*.05,y-r*.42,x+r*.30,y-r*.68,Math.max(1.5,2.1*sc),trim);
      },
  "siege":(renderer,c)=>{const {x,y,r,sc}=c;
        renderer.circle(x,y-r*.42,r*.16,[.68,.56,.25,1],9);renderer.line(x,y-r*.34,x,y-r*.92,Math.max(3,5*sc),[.36,.58,.25,1]);
      },
  "rocket":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        for(let k=-1;k<=1;k++){const sx=x+k*r*.22;renderer.line(sx,y-r*.12,sx,y-r*.68,Math.max(2.2,3.4*sc),[.38,.58,.28,1]);renderer.petalRing(sx,y-r*.74,r*.11,5,trim,0,.60)}
      },
  "shelltitan":(renderer,c)=>{const {x,y,r,sc,trim}=c;
        renderer.circle(x,y-r*.48,r*.30,trim,12);renderer.line(x-r*.30,y-r*.48,x+r*.30,y-r*.48,Math.max(2,3*sc),[.24,.20,.12,1]);
      },
  "swarmbug":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.circle(x-r*.22,y-r*.52,r*.10,trim,8);renderer.circle(x+r*.22,y-r*.52,r*.10,trim,8);renderer.circle(x,y-r*.72,r*.10,trim,8);renderer.circle(x,y-r*.34,r*.10,trim,8);
      },
  "aegisbeetle":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.poly([[x,y-r*.78],[x-r*.42,y-r*.50],[x-r*.50,y-r*.08],[x,y+r*.16],[x+r*.50,y-r*.08],[x+r*.42,y-r*.50]],trim);
        for(const sx of [-.25,.25])renderer.circle(x+sx*r,y-r*.30,r*.07,[.72,.96,1,.85],8);
      },
  "burrowbeast":(renderer,c)=>{const {x,y,r,trim}=c;
        renderer.crestTriangle(x-r*.18,y-r*.52,r*.20,trim,-2.15);renderer.crestTriangle(x+r*.18,y-r*.52,r*.20,trim,-.99);
      }
});
class UnitProductionVisualFallback{
  static render(renderer,c){const {x,y,r,trim}=c;
    renderer.circle(x,y-r*.51,r*.14,trim,9);
  }
}
const BUILDING_VISUAL_RENDER_FNS=Object.freeze({
  "base":(renderer,c)=>{const {x,y,r,own,teamCap,sc}=c;
      const dark=own?[.09,.20,.36,1]:[.40,.09,.11,1];
      const light=own?[.60,.82,1,1]:[1,.66,.64,1];

      renderer.petalRing(x,y-r*.04,r*.52,8,teamCap,Math.PI/8,.82);
      renderer.circle(x,y-r*.05,r*.50,dark,12);
      renderer.circle(x,y-r*.10,r*.28,light,12);
      renderer.circle(x,y-r*.10,r*.12,[.94,.98,1,1],10);

      // short production ramp
      renderer.poly([
        [x-r*.34,y+r*.18],[x+r*.34,y+r*.18],
        [x+r*.46,y+r*.62],[x-r*.46,y+r*.62]
      ],[.27,.31,.34,1]);

      for(let k=-2;k<=2;k++){
        const sx=x+k*r*.12;
        renderer.line(sx,y+r*.28,sx,y+r*.56,Math.max(1.2,2*sc),[.70,.76,.80,1]);
      }
    },
  "outpost":(renderer,c)=>{const {x,y,r,teamCap,teamHi,shell}=c;
      renderer.petalRing(x,y-r*.02,r*.46,6,teamCap,Math.PI/6,.78);
      renderer.circle(x,y-r*.04,r*.42,shell,12);
      renderer.circle(x,y-r*.05,r*.22,teamHi,10);
      renderer.rect(x-r*.30,y+r*.18,r*.60,r*.34,[.30,.33,.34,1]);
    },
  "supply":(renderer,c)=>{const {x,y,r,own,teamCap}=c;
      // Storage pods / seed crates.
      for(const ox of [-.38,.38]){
        renderer.circle(x+r*ox,y+r*.12,r*.28,[.88,.90,.82,1],10);
        renderer.rect(x-r*.12+r*ox,y-r*.16,r*.24,r*.48,[.43,.52,.45,1]);
      }
      renderer.circle(x,y-r*.20,r*.24,teamCap,10);
      renderer.drawTeamMark(x,y-r*.20,r*.12,own);
    },
  "gasExtractor":(renderer,c)=>{const {x,y,r,sc}=c;
      const gas=[.39,.90,.46,1];
      renderer.circle(x,y+r*.04,r*.58,[.17,.26,.19,1],12);
      renderer.circle(x,y-r*.05,r*.42,[.22,.44,.27,1],12);
      renderer.circle(x,y-r*.14,r*.25,gas,10);
      renderer.circle(x-r*.09,y-r*.23,r*.10,[.72,1,.65,.70],8);
      for(let k=0;k<4;k++){
        const a=k*Math.PI/2;
        renderer.line(
          x+Math.cos(a)*r*.38,y+Math.sin(a)*r*.38,
          x+Math.cos(a)*r*.72,y+Math.sin(a)*r*.72,
          Math.max(1.6,2.4*sc),
          [.34,.39,.35,1]
        );
      }
    },
  "barracks":(renderer,c)=>{const {b,x,y,r,teamCap,teamHi,shell,sc}=c;
      const vd=UnitVisualDefinition.get(b.produceType)||null;
      const trim=vd?.accent||teamHi;

      renderer.petalRing(x,y-r*.06,r*.42,6,teamCap,Math.PI/6,.72);
      renderer.circle(x,y-r*.08,r*.40,shell,12);
      renderer.circle(x,y-r*.08,r*.20,trim,10);
      renderer.rect(x-r*.38,y+r*.18,r*.76,r*.30,[.30,.32,.33,1]);

      // Topper mirrors the unit's defining weapon.
      {const render=UNIT_PRODUCTION_TOPPER_RENDER_FNS[b.produceType]||UnitProductionVisualFallback.render;render(renderer,{x,y,r,sc,trim});}
    },
  "thornTower":(renderer,c)=>{const {b,x,y,r,teamCap,teamHi,sc}=c;
      // 가시꽃 초소: 낮은 생체 받침 + 길게 뻗은 가시꽃 총열.
      renderer.circle(x,y+r*.10,r*.58,[.32,.46,.22,1],12);
      renderer.petalRing(x,y-r*.18,r*.36,6,teamCap,Math.PI/6,.66);
      const kick=(b.attackFlash||0)>0?r*.12:0;
      renderer.line(x,y-r*.18,x,y-r*(1.15-kick),Math.max(2,3.4*sc),[.28,.50,.20,1]);
      renderer.crestTriangle(x,y-r*(1.26-kick),r*.18,[.88,.94,.50,1],-Math.PI/2);
      renderer.circle(x,y-r*.18,r*.17,teamHi,10);
    },
  "acornTower":(renderer,c)=>{const {b,x,y,r,sc}=c;
      // 도토리 감시포: 두꺼운 껍질 포좌 + 긴 씨앗포신.
      renderer.circle(x,y+r*.05,r*.66,[.37,.27,.15,1],12);
      renderer.circle(x,y-r*.12,r*.44,[.62,.46,.24,1],12);
      const kick=(b.attackFlash||0)>0?r*.10:0;
      renderer.line(x,y-r*.18,x,y-r*(1.35-kick),Math.max(3,4.8*sc),[.44,.31,.17,1]);
      renderer.circle(x,y-r*(1.40-kick),r*.14,[.92,.76,.38,1],9);
      renderer.poly([[x-r*.36,y-r*.18],[x-r*.18,y-r*.62],[x+r*.18,y-r*.62],[x+r*.36,y-r*.18]],[.49,.34,.19,1]);
    },
  "sunvineTower":(renderer,c)=>{const {b,x,y,r,sc}=c;
      // 태양덩굴 포탑: 해바라기처럼 빛을 모아 위로 세운 꽃심에서 고열 탄을 발사.
      const pulse=(b.attackFlash||0)>0?1:0;
      renderer.circle(x,y+r*.10,r*.56,[.29,.45,.18,1],12);
      renderer.line(x-r*.18,y+r*.18,x-r*.38,y+r*.54,Math.max(1.8,2.6*sc),[.24,.48,.18,1]);
      renderer.line(x+r*.18,y+r*.18,x+r*.38,y+r*.54,Math.max(1.8,2.6*sc),[.24,.48,.18,1]);
      renderer.line(x,y+r*.02,x,y-r*.46,Math.max(2.6,4.0*sc),[.30,.58,.20,1]);
      renderer.petalRing(x,y-r*.64,r*.42,12,[.99,.79,.22,1],Math.PI/12,.84);
      renderer.circle(x,y-r*.64,r*.24,[.53,.32,.14,1],12);
      renderer.circle(x,y-r*.64,r*(.18+.05*pulse),[1,.95,.62,.88],10);
      renderer.circle(x,y-r*.64,r*(.34+.08*pulse),[1,.90,.28,.14],16);

      const beamTarget=b.beamTargetId?renderer.snapshot?.units?.find(u=>u.id===b.beamTargetId&&u.alive):null;
      if(beamTarget){
        const rp=renderer.renderTrackedPosition(beamTarget,"unit");
        const tp=renderer.worldToPx(renderer.viewX(rp.x),renderer.viewY(rp.y));
        const stage=Math.max(1,Math.min(3,Number(b.beamStage)||1));
        const beamW=Math.max(1.2,(stage===3?4.8:stage===2?3.5:2.4)*sc);
        const alpha=stage===3?.92:stage===2?.80:.68;
        renderer.line(x,y-r*.64,tp[0],tp[1],beamW*2.2,[1,.46,.08,.16*alpha]);
        renderer.line(x,y-r*.64,tp[0],tp[1],beamW,[1,.82,.24,alpha]);
        renderer.circle(tp[0],tp[1],Math.max(4,(5+stage*2)*sc),[1,.72,.16,.15+.08*stage],12);
      }
    },
  "mortarTower":(renderer,c)=>{const {b,x,y,r,sc}=c;
      // 포자 박격 둥지: 낮은 포대 안에 큰 박격 튜브가 위로 들려 있는 곡사 포격 건물.
      const kick=(b.attackFlash||0)>0?r*.14:0;
      renderer.circle(x,y+r*.06,r*.68,[.31,.24,.18,1],14);
      renderer.circle(x,y-r*.02,r*.46,[.54,.42,.24,1],12);
      renderer.poly([[x-r*.18,y-r*.10],[x-r*.42,y-r*.58],[x-r*.12,y-r*.76],[x+r*.12,y-r*.76],[x+r*.42,y-r*.58],[x+r*.18,y-r*.10]],[.45,.34,.21,1]);
      renderer.line(x,y-r*.12,x,y-r*(1.12-kick),Math.max(4.2,6.0*sc),[.39,.29,.20,1]);
      renderer.circle(x,y-r*(1.14-kick),r*.16,[.88,.76,.42,1],9);
      renderer.circle(x-r*.34,y+r*.18,r*.10,[.66,.58,.34,1],8);
      renderer.circle(x+r*.34,y+r*.18,r*.10,[.66,.58,.34,1],8);
    },
  "academy":(renderer,c)=>{const {x,y,r,sc}=c;
      renderer.circle(x,y,r*.45,[.85,.75,1,1],8);
      renderer.line(x-r*.55,y+r*.35,x+r*.55,y-r*.35,Math.max(1.5,3*sc),[.40,.31,.66,.9]);
    },
  "airIncubator":(renderer,c)=>{const {b,x,y,r}=c;
      // 공중 배양소: 가스가 맴도는 부유 씨앗 고치 + 양쪽 날개막.
      const pulse=.5+.5*Math.sin(performance.now()*.004+(HashUtil.hash(b.id)%997)*.017);
      renderer.circle(x,y+r*.12,r*.66,[.27,.42,.28,1],12);
      renderer.circle(x,y-r*.12,r*.42,[.46,.72,.48,1],12);
      renderer.poly([[x-r*.28,y-r*.10],[x-r*.92,y-r*.50],[x-r*.72,y+r*.20],[x-r*.22,y+r*.12]],[.55,.84,.64,.68]);
      renderer.poly([[x+r*.28,y-r*.10],[x+r*.92,y-r*.50],[x+r*.72,y+r*.20],[x+r*.22,y+r*.12]],[.55,.84,.64,.68]);
      renderer.circle(x,y-r*.18,r*(.18+.05*pulse),[.46,1,.62,.78],10);
      renderer.circle(x,y-r*.18,r*(.40+.07*pulse),[.42,.92,.58,.10],14);
    },
  "lab":(renderer,c)=>{const {x,y,r}=c;
      renderer.circle(x,y,r*.48,[1,.65,.25,1],6);
      renderer.circle(x,y,r*.18,[1,.91,.48,1],8);
    },
  "factory":(renderer,c)=>{const {b,x,y,r,teamCap,teamHi,sc}=c;
      const vd=UnitVisualDefinition.get(b.produceType)||null;
      const trim=vd?.accent||teamHi;

      renderer.circle(x,y+r*.02,r*.58,[.16,.20,.24,1],12);
      renderer.rect(x-r*.66,y-r*.30,r*1.32,r*.62,teamCap);
      renderer.circle(x,y-r*.06,r*.30,[.14,.17,.20,1],12);

      {const render=UNIT_PRODUCTION_TOPPER_RENDER_FNS[b.produceType]||UnitProductionVisualFallback.render;render(renderer,{x,y,r,sc,trim});}
    }
});
class TerrainPresentation{
  static colors=Object.freeze({
    lowGround:Object.freeze([.69,.81,.63,1]),highGround:Object.freeze([.64,.72,.47,1]),
    rampLow:Object.freeze([.66,.62,.42,1]),rampHigh:Object.freeze([.69,.69,.44,1])
  });
  static css(color){return `rgba(${Math.round(color[0]*255)},${Math.round(color[1]*255)},${Math.round(color[2]*255)},${color[3]??1})`}
  static fillPlanarGround(c,w,h){c.fillStyle=this.css(this.colors.lowGround);c.fillRect(0,0,w,h)}
  static riverSurfaceCache=new WeakMap();
  static riverSurfaceMesh(map,atlas){
    let mesh=this.riverSurfaceCache.get(atlas);if(mesh)return mesh;
    mesh=[];
    {
      const terrain=MapGeneration.mapTerrainDescriptor(map),sources=[];
      const add=poly=>{if(poly?.length>=3)sources.push(poly)};
      if(terrain.riverPolygon?.length>=3)add(terrain.riverPolygon);
      else if(terrain.riverPath?.length>1)add(MapGeometry.polylineToRibbonPolygon(terrain.riverPath,terrain.riverHalfWidth));
      for(const poly of terrain.riverBranchPolygons||[])add(poly);
      if(!terrain.riverBranchPolygons?.length)for(const path of terrain.riverBranches||[])if(path.length>1)add(MapGeometry.polylineToRibbonPolygon(path,terrain.riverHalfWidth*.72));
      const floors=(atlas.renderSurfaceMesh||atlas.surfaceMesh).filter(p=>{if(p.kind!=='plateau'||p.level>0)return false;const layer=atlas.layers.find(l=>l.id===p.id);return !layer||p.level<=(layer.parent?.level??0)});
      for(const source of sources)for(const [poly,color] of [[source,[.10,.31,.39,.60]],[MapGeometry.insetPolygonTowardCenter(source,.12),[.20,.52,.64,.44]]]){
        const triangles=PolygonTriangulation.mesh(poly).triangles;
        for(const floor of floors)for(const indices of floor.triangles){
          const clip=indices.map(i=>({x:floor.vertices[i].x,y:floor.vertices[i].z}));
          if(NavigationMeshBuilder.cross(clip[0],clip[1],clip[2])<0)clip.reverse();
          for(const tri of triangles){
            const points=NavigationGoal.clipPolygon(tri.map(i=>poly[i]),clip);
            for(let i=1;i<points.length-1;i++){const tri=[points[0],points[i],points[i+1]],x=tri.reduce((s,p)=>s+p.x,0)/3,y=tri.reduce((s,p)=>s+p.y,0)/3;if(atlas.levelAt(x,y)!==floor.level||!TerrainQuery.at(map,x,y,atlas).river)continue;mesh.push({color,vertices:tri.map(p=>({x:p.x,y:TerrainSurfaceAtlas.elevationForLevel(floor.level),z:p.y,groundY:0}))})}
          }
        }
      }
    }
    this.riverSurfaceCache.set(atlas,mesh);return mesh;
  }
  static drawRiverSurfaces(r,map,restoreDepthWrite=null){
    const mesh=this.riverSurfaceMesh(map,r.world.terrain.surfaces);if(!mesh.length)return;
    const projection=TerrainSurfaceProjection.forAtlas(r.world.terrain.surfaces).projectedTriangleMesh(mesh,r.orientationRole()==='guest');
    const a=r.projectedCoordinatesAtScreen(0,0),b=r.projectedCoordinatesAtScreen(r.canvas.width,r.canvas.height);
    const visible=projection.index.query(a.x,a.y,b.x,b.y,1/r.sc()).sort((a,b)=>a.order-b.order);
    r.perfStats.riverVisibleTriangles=visible.length;r.perfStats.riverTotalTriangles=mesh.length;
    const previous=r._renderDepth,depthWrite=restoreDepthWrite??r.passState.depthWrite;
    r.passState.depthWrite=false;r.begin();
    try{for(const {tri} of visible)for(const v of tri.vertices){const p=r.projectRenderWorldPosition(v);r.setRenderDepth(p.depth-.0001);r.v(p.x,p.y,tri.color)}r.flush()}
    finally{r.passState.depthWrite=depthWrite;r.setRenderDepth(previous);r.begin()}
  }
  static drawBridges(r,terrain,restoreDepthWrite=null){
    const sc=r.sc(),previous=r._renderDepth,depthWrite=restoreDepthWrite??r.passState.depthWrite;r.passState.depthWrite=false;r.begin();
    try{
    // 다리: 실제 lane×river crossing descriptor를 그대로 사용. 다리 footprint는 평지 판정이다.
    for(const br of terrain.bridges||[])r.withWorldSpriteDepth({x:br.x,y:0,z:br.y},()=>{
      const c=r.worldToPx(r.viewX(br.x),r.viewY(br.y));
      const a=(Number(br.angle)||0)+(r.orientationRole()==="guest"?Math.PI:0);
      const ca=Math.cos(a),sa=Math.sin(a),hl=(br.halfLength||80)*sc,hw=(br.halfWidth||30)*sc;
      const corners=[[-hl,-hw],[hl,-hw],[hl,hw],[-hl,hw]].map(([lx,ly])=>[c[0]+lx*ca-ly*sa,c[1]+lx*sa+ly*ca]);
      r.poly(corners,[.58,.45,.28,1]);
      // simple plank/stone bands so the crossing reads at combat zoom.
      for(let i=-2;i<=2;i++){
        const t=i/2.5,px=c[0]+ca*hl*t,py=c[1]+sa*hl*t;
        r.line(px-sa*hw*.92,py+ca*hw*.92,px+sa*hw*.92,py-ca*hw*.92,Math.max(1,1.4*sc),[.76,.64,.42,.50]);
      }
      r.line(corners[0][0],corners[0][1],corners[1][0],corners[1][1],Math.max(1.2,1.8*sc),[.34,.27,.18,.75]);
      r.line(corners[3][0],corners[3][1],corners[2][0],corners[2][1],Math.max(1.2,1.8*sc),[.34,.27,.18,.75]);
    });
      r.flush();
    }finally{r.passState.depthWrite=depthWrite;r.setRenderDepth(previous);r.begin()}
  }
  static drawSurfaces(r){
    const atlas=r.world.terrain.surfaces;if(!atlas.layers.length&&!atlas.bridges.length)return;
    const previous=r._renderDepth,mesh=TerrainSurfaceProjection.forAtlas(atlas).renderProjectedSurfaceMesh(r.orientationRole()==='guest');
    const a=r.projectedCoordinatesAtScreen(0,0),b=r.projectedCoordinatesAtScreen(r.canvas.width,r.canvas.height);
    const visible=mesh.index.query(a.x,a.y,b.x,b.y,1/r.sc()).sort((a,b)=>a.order-b.order);
    r.perfStats.terrainVisibleTriangles=visible.length;r.perfStats.terrainTotalTriangles=mesh.triangles.length;
    const colorCache=mesh.colors||(mesh.colors=new Map());
    for(const tri of visible){
      const patch=tri.patch;
      let colors=colorCache.get(patch);
      if(!colors){
      if(patch.kind==='cliff'){
        const f=patch.face,dx=f.b.x-f.a.x,dy=f.b.y-f.a.y,light=(dx-dy)/(Math.hypot(dx,dy)||1);
        colors=patch.vertices.map(()=>[.31+light*.035,.37+light*.035,.25+light*.025,1]);
      }else if(patch.kind==='ramp')colors=patch.vertices.map(v=>{
        const t=RangeUtil.clamp((v.y-TerrainSurfaceAtlas.elevationForLevel(patch.lowLevel))/(TerrainSurfaceAtlas.elevationForLevel(patch.highLevel)-TerrainSurfaceAtlas.elevationForLevel(patch.lowLevel)),0,1);
        return this.colors.rampLow.map((c,i)=>c+(this.colors.rampHigh[i]-c)*t);
      });
      // The level-0 underlay already owns its grass/water markings. Write the
      // exact floor depth without repainting those colors; authored depressions remain opaque.
      else colors=patch.vertices.map(()=>patch.id==='low-ground'?[...this.colors.lowGround.slice(0,3),0]:patch.level===0?this.colors.lowGround:this.colors.highGround);
      colorCache.set(patch,colors);
      }
      const bridge=patch.bridge?atlas.bridges.find(b=>b.id===patch.id):null,deckDepth=bridge?r.bridgeDepth(bridge):null;
      for(let i=0;i<3;i++){const p=r.projectRenderWorldPosition(tri.vertices[i]);r.setRenderDepth(deckDepth??p.depth);r.v(p.x,p.y,colors[tri.indices[i]])}
    }
    r.setRenderDepth(previous);
  }
  static surfaceLine(r,a,b,ha,hb,width,color){
      const previous=r._renderDepth;
      const p=r.projectRenderWorldPosition({x:a.x,y:ha,z:a.y,groundY:0}),q=r.projectRenderWorldPosition({x:b.x,y:hb,z:b.y,groundY:0});
      const dx=q.x-p.x,dy=q.y-p.y,len=Math.hypot(dx,dy)||1,nx=-dy/len*width/2,ny=dx/len*width/2;
      const v=[{x:p.x+nx,y:p.y+ny,d:p.depth},{x:q.x+nx,y:q.y+ny,d:q.depth},{x:q.x-nx,y:q.y-ny,d:q.depth},{x:p.x-nx,y:p.y-ny,d:p.depth}];
      for(const i of [0,1,2,0,2,3]){const p=v[i];r.setRenderDepth(p.d-.0008);r.v(p.x,p.y,color)}
      r.setRenderDepth(previous);
  }
  static drawSurfaceEdges(r){
    const atlas=r.world.terrain.surfaces;if(!atlas.layers.length&&!atlas.bridges.length)return;
    const sc=r.sc(),previous=r._renderDepth;
    // Endpoint depths preserve picking/render alignment on every ramp orientation.
    const edge=(...args)=>this.surfaceLine(r,...args);
    for(const f of (atlas.renderFaces||atlas.faces))edge(f.a,f.b,f.highA??f.high,f.highB??f.high,Math.max(1,3*sc),[.80,.83,.60,1]);
    for(const ramp of atlas.ramps){
      edge(ramp.lowA,ramp.lowB,ramp.lowElevation,ramp.lowElevation,Math.max(.8,1.5*sc),[.78,.73,.53,1]);
      edge(ramp.highA,ramp.highB,ramp.highElevation,ramp.highElevation,Math.max(.8,1.5*sc),[.86,.81,.60,1]);
      for(const t of [.25,.5,.75]){
        const a=TerrainSurfaceAtlas.lerp(ramp.lowA,ramp.highA,t),b=TerrainSurfaceAtlas.lerp(ramp.lowB,ramp.highB,t),h=ramp.lowElevation+(ramp.highElevation-ramp.lowElevation)*t;
        edge(a,b,h,h,Math.max(.6,1.1*sc),[.84,.79,.57,.28]);
      }
    }
    r.setRenderDepth(previous);
  }
  static drawSurfaceMini(c,map,pt,scale){
    const atlas=TerrainSurfaceAtlas.fromMap(map);if(!atlas.layers.length)return;
    const fill=(points,color)=>{c.fillStyle=color;c.beginPath();for(let i=0;i<points.length;i++){const p=pt(points[i]);if(i)c.lineTo(...p);else c.moveTo(...p)}c.closePath();c.fill()};
    for(const layer of atlas.layers.slice().sort((a,b)=>Math.abs(b.area)-Math.abs(a.area)))fill(layer.renderTopPoints||layer.topPoints,this.css(layer.level===0?this.colors.lowGround:this.colors.highGround));
    for(const ramp of atlas.ramps){
      const a=pt(TerrainSurfaceAtlas.lerp(ramp.lowA,ramp.lowB,.5)),b=pt(TerrainSurfaceAtlas.lerp(ramp.highA,ramp.highB,.5));
      const gradient=c.createLinearGradient(...a,...b);
      gradient.addColorStop(0,this.css(this.colors.rampLow));gradient.addColorStop(1,this.css(this.colors.rampHigh));
      fill(ramp.points,gradient);
    }
    c.strokeStyle='#47573b';c.lineWidth=Math.max(.75,5*scale);
    for(const f of (atlas.renderFaces||atlas.faces)){const a=pt(f.a),b=pt(f.b);c.beginPath();c.moveTo(...a);c.lineTo(...b);c.stroke()}
  }

  static polygonMesh(points){return PolygonTriangulation.mesh(points)}
  static fillMesh(r,points,triangles,color){
    for(const [a,b,c] of triangles)r.tri(...points[a],...points[b],...points[c],color);
  }

  static drawWorld(r,terrain,restoreDepthWrite=null){
    const depthWrite=restoreDepthWrite??r.passState.depthWrite;
    this.drawSurfaces(r);
    // Only solid terrain owns occlusion. Ground decoration must not hide Fog.
    r.flush();r.begin();
    r.passState.depthWrite=false;
    const sc=r.sc(),pt=p=>r.worldToPx(r.viewX(p.x),r.viewY(p.y));
    for(const road of terrain.roads||[]){
      const width=road.width*sc,atlas=r.world.terrain.surfaces;
      for(let i=0;i<road.points.length-1;i++){
        const a=road.points[i],b=road.points[i+1],ha=atlas.heightAt(a.x,a.y),hb=atlas.heightAt(b.x,b.y);
        this.surfaceLine(r,a,b,ha,hb,width,[.73,.68,.50,.42]);
        this.surfaceLine(r,a,b,ha,hb,width*.74,[.84,.79,.62,.42]);
      }
      for(const p of road.points){const q=pt(p);
        r.withWorldSpriteDepth({x:p.x,y:atlas.heightAt(p.x,p.y),z:p.y,groundY:0},()=>r.circle(q[0],q[1],width*.37,[.84,.79,.62,.25],16));
      }
    }
    for(const block of terrain.blockers||[]){
      const points=block.points.map(pt),roots=block.kind==="roots";
      const center=points.reduce((p,q)=>[p[0]+q[0]/points.length,p[1]+q[1]/points.length],[0,0]);
      const minX=Math.min(...points.map(p=>p[0])),maxX=Math.max(...points.map(p=>p[0])),minY=Math.min(...points.map(p=>p[1])),maxY=Math.max(...points.map(p=>p[1]));
      if(maxX<-40||minX>r.canvas.width+40||maxY<-40||minY>r.canvas.height+40)continue;
      const anchor=block.points.reduce((p,q)=>({x:p.x+q.x/block.points.length,y:p.y+q.y/block.points.length}),{x:0,y:0});
      r.withWorldSpriteDepth({x:anchor.x,y:r.world.terrain.surfaces.heightAt(anchor.x,anchor.y),z:anchor.y,groundY:0},()=>{
      const mesh=TerrainPresentation.polygonMesh(block.points);
      if(!mesh.convex){
        TerrainPresentation.fillMesh(r,points.map(p=>[p[0]+7*sc,p[1]+12*sc]),mesh.triangles,[.12,.17,.12,.24]);
        TerrainPresentation.fillMesh(r,points,mesh.triangles,roots?[.47,.43,.28,1]:[.49,.55,.44,1]);
        for(let i=0;i<points.length;i++){const a=points[i],b=points[(i+1)%points.length];r.line(a[0],a[1],b[0],b[1],Math.max(1,3*sc),[.70,.73,.59,.8])}
        return;
      }
      r.poly(points.map(p=>[p[0]+7*sc,p[1]+12*sc]),[.12,.17,.12,.24]);
      r.poly(points,roots?[.27,.26,.17,1]:[.24,.31,.26,1]);
      const inner=points.map(p=>[center[0]+(p[0]-center[0])*.93,center[1]+(p[1]-center[1])*.90-3*sc]);
      r.poly(inner,roots?[.47,.43,.28,1]:[.49,.55,.44,1]);
      const top=inner.map(p=>[center[0]+(p[0]-center[0])*.85,center[1]+(p[1]-center[1])*.78]);
      r.poly(top,roots?[.55,.51,.32,1]:[.58,.62,.49,1]);
      for(let i=0;i<inner.length;i++){
        const a=inner[i],b=inner[(i+1)%inner.length];
        r.line(a[0],a[1],b[0],b[1],Math.max(1,3*sc),roots?[.66,.61,.37,.80]:[.70,.73,.59,.8]);
        if(i%2===0){const c=points[i];r.line(a[0],a[1],c[0],c[1],Math.max(1,3*sc),[.17,.22,.16,.6])}
      }
      if(roots){
        for(let i=0;i<top.length;i+=2){const a=top[i],b=top[(i+3)%top.length];
          r.line(a[0],a[1],center[0],center[1],Math.max(2,14*sc),[.37,.34,.20,.6]);
          r.line(center[0],center[1],b[0],b[1],Math.max(2,9*sc),[.67,.61,.36,.6]);
        }
      }else{
        for(let i=0;i<top.length;i+=3){const a=top[i],b=top[(i+1)%top.length];r.poly([a,b,center],[.68,.71,.57,.23])}
      }
      });
    }
    r.flush();r.begin();
    r.passState.depthWrite=depthWrite;
  }
  static miniRiverCache=new WeakMap();
  static drawMiniBridges(c,terrain,pt,style){
    const origin=pt({x:0,y:0}),xAxis=pt({x:1,y:0}),yAxis=pt({x:0,y:1});
    const sx=Math.hypot(xAxis[0]-origin[0],xAxis[1]-origin[1]),sy=Math.hypot(yAxis[0]-origin[0],yAxis[1]-origin[1]);
    const orientation=Math.atan2(xAxis[1]-origin[1],xAxis[0]-origin[0]);
    for(const br of terrain.bridges||[]){
      const q=pt(br),hl=(br.halfLength||80)*sx,hw=(br.halfWidth||30)*sy;
      c.save();c.translate(...q);c.rotate((Number(br.angle)||0)+orientation);
      c.fillStyle=style.fill;c.strokeStyle=style.stroke;c.lineWidth=style.lineWidth;
      c.fillRect(-hl,-hw,hl*2,hw*2);c.strokeRect(-hl,-hw,hl*2,hw*2);c.restore();
    }
  }
  static drawMini(c,map,pt,scale,bridgeStyle={fill:"#9a7a47",stroke:"#d2b477",lineWidth:Math.max(.8,c.canvas.width*.0022)}){
    this.drawSurfaceMini(c,map,pt,scale);
    const atlas=TerrainSurfaceAtlas.fromMap(map),mesh=this.riverSurfaceMesh(map,atlas);
    if(mesh.length){
      let cache=this.miniRiverCache.get(atlas);if(!cache)this.miniRiverCache.set(atlas,cache=new Map());
      const origin=pt({x:0,y:0}),extent=pt({x:atlas.width,y:atlas.height}),key=[c.canvas.width,c.canvas.height,...origin,...extent,scale].join(':');
      let image=cache.get(key);
      if(!image){
        image=document.createElement('canvas');image.width=c.canvas.width;image.height=c.canvas.height;const water=image.getContext('2d');
        for(const tri of mesh){
          water.fillStyle=this.css(tri.color);water.beginPath();
          for(let i=0;i<tri.vertices.length;i++){const v=tri.vertices[i],p=pt({x:v.x,y:v.z});if(i)water.lineTo(...p);else water.moveTo(...p)}water.closePath();water.fill();
        }
        if(cache.size>=4)cache.delete(cache.keys().next().value);cache.set(key,image);
      }
      c.drawImage(image,0,0);
    }
    const terrain=map?.terrain||{};
    for(const road of terrain.roads||[]){const p=road.points.map(pt);if(!p.length)continue;
      c.lineCap="round";c.lineJoin="round";c.lineWidth=Math.max(1,road.width*scale);c.strokeStyle="#94896988";
      c.beginPath();c.moveTo(...p[0]);for(let i=1;i<p.length;i++)c.lineTo(...p[i]);c.stroke();
    }
    for(const b of terrain.blockers||[]){const p=b.points.map(pt);if(p.length<3)continue;
      c.fillStyle=b.kind==="roots"?"#615b38":"#4e5c4b";c.strokeStyle="#9aa884";c.lineWidth=Math.max(.7,scale*10);
      c.beginPath();c.moveTo(...p[0]);for(let i=1;i<p.length;i++)c.lineTo(...p[i]);c.closePath();c.fill();c.stroke();
    }
    this.drawMiniBridges(c,terrain,pt,bridgeStyle);
  }
  static drawBarrier(r,b){
    if(!r.isFriendlySide(b.side)&&!r.visibleRaw(b.x,b.y))return;
    const [x,y]=r.worldToPx(r.viewX(b.x),r.viewY(b.y)),rad=BuildingDefinition.get(b.type).size*r.sc();
    r.circle(x,y+rad*.18,rad,[.15,.18,.12,.27],12);
    r.circle(x,y,rad*.95,[.29,.25,.16,1],10);
    for(let i=-1;i<=1;i++){
      const yy=y+i*rad*.40;
      r.line(x-rad*.77,yy+rad*.24,x+rad*.77,yy-rad*.24,rad*.31,[.60,.48,.27,1]);
      r.line(x-rad*.73,yy+rad*.18,x+rad*.73,yy-rad*.30,rad*.075,[.80,.68,.42,1]);
    }
    r.line(x-rad*.25,y-rad*.78,x+rad*.32,y+rad*.78,rad*.16,[.36,.43,.23,1]);
    r.circle(x-rad*.56,y-rad*.37,rad*.19,[.53,.60,.32,1],5);
    if(b.hitFlash>0)r.circle(x,y,rad*.86,[1,.8,.4,.18],10);
  }
}

class FogVisibilityGrid{
  constructor(renderer,step){
    this.atlas=renderer.world.terrain.surfaces;this.width=renderer.world.width;this.height=renderer.world.height;
    this.step=step;this.w=Math.max(2,Math.ceil(this.width/step)+1);this.h=Math.max(2,Math.ceil(this.height/step)+1);
    this.x=Float64Array.from({length:this.w},(_,i)=>i/(this.w-1)*this.width);
    this.y=Float64Array.from({length:this.h},(_,j)=>j/(this.h-1)*this.height);
    this.ceilings=new Float64Array(this.w*this.h);this.groundLevels=null;this.guestGroundLevels=null;
    this.masks=new Map();this.groundMasks=new Map();this.generation=0;
  }
  sameGeometry(renderer,step){return this.atlas===renderer.world.terrain.surfaces&&this.width===renderer.world.width&&this.height===renderer.world.height&&this.step===step}
  update(renderer){
    const sides=renderer.replayVisionSides(),sideKey=sides.join(',');
    const revisionKey=sides.map(side=>renderer.visionFields[side]?.revision??-1).join(',');
    if(this.snapshot===renderer.snapshot&&this.tick===renderer.snapshot.tick&&this.revisionKey===revisionKey&&this.sideKey===sideKey&&this.observer===renderer.replayObserverAll)return this;
    this.snapshot=renderer.snapshot;this.tick=renderer.snapshot.tick;this.revisionKey=revisionKey;this.fields=renderer.visionFields;
    this.sideKey=sideKey;this.sides=sides;this.observer=renderer.replayObserverAll;
    // Published mask arrays remain immutable while the GPU transition retains them.
    this.masks.clear();this.groundMasks.clear();this.generation++;
    for(let j=0;j<this.h;j++)for(let i=0;i<this.w;i++)this.ceilings[j*this.w+i]=this.ceilingAt(this.x[i],this.y[j]);
    return this;
  }
  ceilingAt(x,y){
    if(this.observer)return Infinity;
    let best=-Infinity;for(const side of this.sides)best=Math.max(best,this.fields[side]?.ceilingAt(x,y)??-Infinity);
    return best;
  }
  atLevel(level){
    let mask=this.masks.get(level);if(mask)return mask;
    mask=Uint8Array.from(this.ceilings,ceiling=>ceiling>=level?255:0);this.masks.set(level,mask);return mask;
  }
  atGround(renderer){
    const role=renderer.orientationRole();let mask=this.groundMasks.get(role);if(mask)return mask;
    if(!this.groundLevels)this.groundLevels=Float64Array.from(this.ceilings,(_,k)=>this.atlas.levelAt(this.x[k%this.w],this.y[Math.floor(k/this.w)]));
    mask=new Uint8Array(this.w*this.h);
    if(role!=='guest')for(let k=0;k<mask.length;k++)mask[k]=this.ceilings[k]>=this.groundLevels[k]?255:0;
    else{
      if(!this.guestGroundLevels)this.guestGroundLevels=new Float64Array(mask.length);
      const buildLevels=!this.guestLevelsReady;
      for(let j=0;j<this.h;j++)for(let i=0;i<this.w;i++){
        const k=j*this.w+i,ri=this.w-1-i,rj=this.h-1-j,rk=rj*this.w+ri,x=renderer.viewX(this.x[i]),y=renderer.viewY(this.y[j]);
        // Keep the old reflected-coordinate arithmetic at exact geometry boundaries.
        const canonical=x===this.x[ri]&&y===this.y[rj];
        if(buildLevels)this.guestGroundLevels[k]=canonical?this.groundLevels[rk]:this.atlas.levelAt(x,y);
        const ceiling=canonical?this.ceilings[rk]:this.ceilingAt(x,y);
        mask[k]=ceiling>=this.guestGroundLevels[k]?255:0;
      }
      this.guestLevelsReady=true;
    }
    this.groundMasks.set(role,mask);return mask;
  }
}

class GLRenderer{
  static DEPTH_PROJECTION=Object.freeze({offset:.88,viewSpan:1.72,min:-.94,max:.94});
  constructor(canvas){
    this.canvas=canvas;
    // HAS-A immutable topology cache. Unit positions/state stay dynamic; only reusable
    // polygon/circle/petal topology is shared across every instance and frame.
    this.geometryTemplates=SHARED_GEOMETRY_TEMPLATES;
    this.geometryTemplateHits=0;
    this.passProfiler=new RenderPassProfiler();
    // Cached local-space body meshes for species whose body/equipment is immutable for
    // a visual state key. Movement/facing/depth remain per-entity and are applied on replay.
    this.unitBodyMeshCache=new Map();
    this.unitBodyMeshCacheHits=0;this.unitBodyMeshCacheMisses=0;

    // 전장 본 렌더는 WebGL 단일 백엔드다.
    // Canvas2D는 미니맵/텍스트/숫자/UI 전용이며 전장 fallback을 구현하지 않는다.
    this.webglAttrs={
      alpha:false,
      antialias:true,
      stencil:true,
      depth:true,
      preserveDrawingBuffer:false,
      powerPreference:"high-performance",
      failIfMajorPerformanceCaveat:false
    };
    this.device=new RallyGamekit.WebGLDevice(canvas,this.webglAttrs);
    this.vectorContext=new RallyGamekit.VectorContext(this.device,{safeAlphaRunBatching:true});this.vectorContext.acquireMeshRenderer();this.grainFaces=new GrainFaceOverlay(this.vectorContext);// 메시 통계가 첫 유닛 그리기 전에도 null이 아니도록 미리 만든다.
    this.vectorUnitAssetCache=new Map();
    this._vectorUnitMatrix=new Float32Array(6);
    this._vectorOcclusionCoords=new Float32Array(0);
    this.gl=this.device.gl;
    this.passState={depthEnabled:true,depthWrite:true,depthFunc:"lequal",stencil:false,colorMask:[true,true,true,true]};
    if(!this.gl)throw new Error("RALLY FRONTIER requires WebGL for battlefield rendering.");
    this.backend="WebGL";
    this.canvas.dataset.rendererBackend=this.backend;

    // Render-only visibility spatial cache.
    this.visionFields=[null,null];
    this.snapshotCloakedIds=new Set();
    this.fogVisibilityGrids=new Map();
    this.visibleUnitFrame=[];

    // High-frequency renderer pools. They are presentation-only and deliberately
    // excluded from deterministic state. Sizes are bounded to prevent hidden growth.
    this.renderState=new RenderStateStore(RENDER_TRACKS);
    this.liveRenderTargets=false;
    this.combatFxPool=new RallyGamekit.ObjectPool(EffectObjectFactory.makeCombatFx,EffectObjectFactory.resetCombatFx,256);
    this.floatFxPool=new RallyGamekit.ObjectPool(EffectObjectFactory.makeFloatFx,EffectObjectFactory.resetFloatFx,96);
    this.shakeFxPool=new RallyGamekit.ObjectPool(EffectObjectFactory.makeShakeFx,EffectObjectFactory.resetShakeFx,16);
    this.flagFxPool=new RallyGamekit.ObjectPool(EffectObjectFactory.makeFlagFx,EffectObjectFactory.resetFlagFx,8);
    this.commonEffectPool=new CommonEffectPool(this);
    // Presentation-only shared hitGuard shield state. All shield sources use the same visual language.
    this.shieldVisualStates=new Map();

    // Presentation timing is render-only. Full UI snapshots remain 10 Hz, while
    // registered Render State targets can be refreshed every authoritative simulation tick.
    this.perfStats={frameWorkMs:0,ewmaFrameWorkMs:0,maxFrameWorkMs:0,fps:0,frames:0,fpsWindowAt:performance.now(),lastFrameAt:performance.now(),frameIntervalMs:0,ewmaFrameIntervalMs:0,maxFrameIntervalMs:0,frameIntervalWindowAt:performance.now(),cpuDepthSortMs:0,drawCalls:0,bufferUploadBytes:0};
    this.renderStage="init";this.renderEntity=null;this.renderFatalReported=false;

      // Game shaders express Rally's terrain/depth/fog policy. Gamekit owns GPU resources and submission.
      const vs=`attribute vec3 a;attribute vec4 ac;uniform vec2 r;varying lowp vec4 vc;void main(){vec2 p=a.xy/r*2.0-1.0;gl_Position=vec4(p.x,-p.y,a.z,1.0);vc=ac;}`,
        fs=`precision lowp float;varying lowp vec4 vc;void main(){gl_FragColor=vc;}`,
        spriteFs=`precision lowp float;varying lowp vec4 vc;uniform lowp float alphaCutoff;void main(){if(vc.a<alphaCutoff)discard;gl_FragColor=vc;}`,
        attributes=[{name:'a',size:3,offset:0},{name:'ac',size:4,offset:12}];
      this.p=this.device.createPipeline({vertex:vs,fragment:fs,stride:28,attributes,uniforms:{r:'2f'}});
      this.spriteProgram=this.device.createPipeline({vertex:vs,fragment:spriteFs,stride:28,attributes,uniforms:{r:'2f',alphaCutoff:'1f'}});
      this.buf=this.device.createVertexBuffer({capacityBytes:7*16384*4});
      const fogVs=`attribute vec3 a;attribute vec2 uv;uniform vec2 r;uniform vec2 maskSize;varying mediump vec2 vuv;void main(){vec2 p=a.xy/r*2.0-1.0;gl_Position=vec4(p.x,-p.y,a.z,1.0);vuv=(uv*(maskSize-1.0)+0.5)/maskSize;}`,
        fogFs=`precision mediump float;varying mediump vec2 vuv;uniform sampler2D tex;uniform sampler2D previousTex;uniform float transition;uniform vec4 fog;void main(){float vis=mix(texture2D(previousTex,vuv).r,texture2D(tex,vuv).r,transition);float edge=smoothstep(.12,.88,vis);gl_FragColor=vec4(fog.rgb,fog.a*(1.0-edge));}`;
      this.fogProgram=this.device.createPipeline({vertex:fogVs,fragment:fogFs,stride:20,
        attributes:[{name:'a',size:3,offset:0},{name:'uv',size:2,offset:12}],
        uniforms:{r:'2f',maskSize:'2f',tex:'1i',previousTex:'1i',transition:'1f',fog:'4f'}});
      this.fogBuf=this.device.createVertexBuffer({capacityBytes:5*8192*4});this.fogFrame=new ReusableFloat32Buffer(5*8192);
      this.fogTextures=new Map();this._fogTextureKey=null;this.fogMaskStep=64;
      this.fogPreviousTextures=new Map();this.fogMaskRecords=new Map();this.fogTransitionDurationMs=STATE_PUBLISH_INTERVAL_MS;
      this._fogTransitionStartedAt=null;this._fogMaskContext=null;

    // Reusable CPU staging buffer + persistent GPU allocation. This removes per-flush
    // frame copies and repeated GPU buffer orphaning.
    this.frame=new ReusableFloat32Buffer(7*16384);
    this.worldSpriteFrame=[];this.worldSpritePool=[];
    this.terrainOccludedBodyFrame=new ReusableFloat32Buffer(7*4096);
    this.world=WorldContext.standard;
    this.snapshot=null;
    this.role="host";
    this.replayObserverAll=false;
    this.replayPerspectiveSide=null;
    this.replayVisionMode=null;
    this.replayOrientationRole=null;
    this.replayZoom=1;
    this.cameraLeft=0;
    this.cameraTop=this.world.height-VIEW_H;
    this.buildPreview=null;
    this.spellPreview=null;
    // Local latency-hiding presentation. These never enter StrategySim/checksum/export/recovery.
    this.pendingBuildGhosts=[];
    this.predictedFlag=null;
    this.latencySpellFx=[];
    this.attackVariantBreathFx=[];
    // Presentation-only facing: never enters StrategySim/checksum/export/recovery.
    this.unitFacingStates=new Map();
    this.artilleryFacingStates=new Map();
    this.projectileScreenMotionStates=new Map();
    this._unitFacingTransform=null;
    // Client-only long-press feedback. Never enters StrategySim/checksum/export.
    this.chargedSkillGesture=null;
    this.last=performance.now();
    this.particles=[];

    // 전투/경제 숫자는 WebGL과 별개의 투명 Canvas2D에 그린다.
    // 이미지/폰트 리소스를 추가하지 않고 브라우저 기본 폰트만 사용한다.
    this.fxCanvas=document.getElementById("fxCanvas");
    this.fxCtx=this.fxCanvas?.getContext("2d")||null;
    this.floatFx=[];
    this.lastFloatTickByRole={host:-1,guest:-1};

    // florr.io-inspired client-only combat feedback.
    // These arrays are renderer-only and never enter StrategySim/checksum/export/recovery.
    this.combatFx=[];
    this.shakeFx=[];
    this.lastCombatFxTickByRole={host:-1,guest:-1};
    this.attackPresentationUntil=new Map();
    // HAS-A common source-body pulse presentation. Presets own timing/scale; consumers only trigger them.
    this.bodyPulsePresentation=new BodyPulsePresentation();
    this.frameShakeX=0;
    this.frameShakeY=0;
    this.cameraShakePresentationMoved=false;

    // 깃발 명령 VFX는 시뮬레이션 상태와 분리된 로컬 렌더 효과다.
    this.flagFx=[];
    this.lastFlagFxKey="";
    this.loop=this.loop.bind(this);
    requestAnimationFrame(this.loop);
  }
  resize(){
    const dpr=Math.min(1.6,devicePixelRatio||1);
    const cssW=Math.max(1,this.canvas.clientWidth||this.canvas.parentElement?.clientWidth||360);
    const cssH=Math.max(1,this.canvas.clientHeight||this.canvas.parentElement?.clientHeight||Math.round(cssW*5/3));
    const w=Math.max(1,Math.floor(cssW*dpr));
    const h=Math.max(1,Math.floor(cssH*dpr));

    if(this.canvas.width!==w||this.canvas.height!==h){
      this.canvas.width=w;
      this.canvas.height=h;
    }
    if(this.fxCanvas&&(this.fxCanvas.width!==w||this.fxCanvas.height!==h)){
      this.fxCanvas.width=w;
      this.fxCanvas.height=h;
    }

  }
  baseSc(){return Math.min(this.canvas.width/VIEW_W,this.canvas.height/VIEW_H)}
  sc(){return this.baseSc()*(this.replayZoom||1)}
  viewWorldW(){return VIEW_W/(this.replayZoom||1)}
  viewWorldH(){return VIEW_H/(this.replayZoom||1)}
  clampCameraTop(top){
    const atlas=this.world.terrain.surfaces,min=-atlas.maxHeight*BattlefieldProjection.heightScale;
    const max=Math.max(min,this.world.height-atlas.minHeight*BattlefieldProjection.heightScale-this.viewWorldH());
    return RangeUtil.clamp(top,min,max);
  }
  orientationRole(){return this.replayOrientationRole||this.role}
  viewX(x){return this.orientationRole()==="guest"?this.world.width-x:x}
  viewY(y){return this.orientationRole()==="guest"?this.world.height-y:y}
  // Faction ownership, camera orientation and replay perspective are separate contracts.
  // Replay perspective is allowed to override ownership ONLY while actually in replay mode.
  mySide(){
    const replayActive=typeof UiRuntimeState.value!=="undefined"&&UiRuntimeState.value.screen==="replay";
    return replayActive&&this.replayPerspectiveSide!=null?this.replayPerspectiveSide:ConnectionSideUtil.roleSide(this.role);
  }
  isFriendlySide(side){return side===this.mySide()}
  factionRelation(side){
    if(side==null||side===NEUTRAL_SIDE)return "neutral";
    return this.isFriendlySide(side)?"friendly":"enemy";
  }
  factionColor(side,{alpha=1,neutral=[.95,.73,.25]}={}){
    const relation=this.factionRelation(side);
    const rgb=relation==="friendly"?[.22,.50,1]:relation==="enemy"?[1,.30,.30]:neutral;
    return [rgb[0],rgb[1],rgb[2],alpha];
  }
  factionCssColor(side,{alpha=.94,neutral="rgba(214,224,208,.82)"}={}){
    const relation=this.factionRelation(side);
    if(relation==="neutral")return neutral;
    const [r,g,b]=relation==="friendly"?[104,164,255]:[255,104,96];
    return `rgba(${r},${g},${b},${alpha})`;
  }
  worldToPx(x,y,elevation=null){
    const ax=this.viewX(x),az=this.viewY(y),height=elevation??this.world.terrain.surfaces.heightAt(ax,az);
    const p=this.projectRenderWorldPosition({x:ax,y:height,z:az,groundY:0});return[p.x,p.y];
  }
  stableCamera(){
    if(this._frameCamera)return this._frameCamera;
    // Rally owns terrain projection/axis meaning. The shared camera owns viewport transforms.
    if(!this.cameraViewport)this.cameraViewport=new RallyGamekit.CameraViewport({projection:{
      projectInto:(x,z,height,out)=>{out.x=x;out.y=BattlefieldProjection.planarY(z,height);return out},
      groundInto:(x,y,out,height=0)=>{out.x=x;out.y=y+height*BattlefieldProjection.heightScale;out.z=height;return out}
    }});
    const camera=this.cameraViewport,sc=this.sc();
    if(camera.width!==this.canvas.width||camera.height!==this.canvas.height)camera.setViewport({width:this.canvas.width,height:this.canvas.height});
    const x=this.cameraLeft+this.viewWorldW()/2,y=this.cameraTop+this.canvas.height/sc/2;
    if(camera.camera.x!==x||camera.camera.y!==y||camera.camera.zoom!==sc)camera.setCamera({x,y,zoom:sc});
    return camera;
  }
  projectedCoordinatesAtScreen(px,py){return (this._frameCamera||this.stableCamera()).screenToPlaneInto(px,py,{})}
  surfaceAtScreen(px,py){
    const p=this.projectedCoordinatesAtScreen(px,py);
    return TerrainSurfaceProjection.forAtlas(this.world.terrain.surfaces).pickSurface(p.x,p.y,this.orientationRole()==='guest');
  }
  // A hidden battlefield (result screen, closed tab) has no layout box, so its screen points map nowhere.
  hasDisplayArea(){const rect=this.canvas.getBoundingClientRect();return rect.width>0&&rect.height>0}
  pxToWorld(cx,cy){
    const rect=this.canvas.getBoundingClientRect();
    const stable=this.sceneCoordinatesAtDisplay((cx-rect.left)/rect.width*this.canvas.width,(cy-rect.top)/rect.height*this.canvas.height,{sampled:true});
    const p=this.surfaceAtScreen(stable.x,stable.y);
    return[this.viewX(p.x),this.viewY(p.z)];
  }
  begin(){this.frame.reset()}
  setRenderDepth(depth){this._renderDepth=RangeUtil.clamp(Number(depth)||0,-.98,.98)}
  withRenderDepth(depth,fn){
    const prev=this._renderDepth;
    this.setRenderDepth(depth);
    try{return fn()}finally{this._renderDepth=prev}
  }
  withWorldSpriteDepth(world,fn,bias=.0005){
    return this.withRenderDepth(this.spriteDepthForWorld(world,bias),fn);
  }
  spriteDepthForWorld(world,bias=.0005){
    const bridge=this.renderBridgeAt(world.x,world.z);
    const height=bridge?world.y+(world.groundY==null?this.world.terrain.surfaces.heightAt(world.x,world.z):0):0;
    return (bridge&&height>=bridge.elevation-.01?this.bridgeDepth(bridge):this.renderDepthForWorld(world))-bias;
  }
  css(c,alphaMul=1){
    const r=Math.round(RangeUtil.clamp(c[0],0,1)*255),g=Math.round(RangeUtil.clamp(c[1],0,1)*255),b=Math.round(RangeUtil.clamp(c[2],0,1)*255),a=RangeUtil.clamp((c[3]??1)*alphaMul,0,1);
    return `rgba(${r},${g},${b},${a})`;
  }
  v(x,y,c){
    const alphaMul=this._unitRenderAlphaMul==null?1:this._unitRenderAlphaMul;
    if(this._unitFacingTransform)[x,y]=this.unitFacingPoint(x,y);
    this.frame.push7(x,y,this._renderDepth??0,c[0],c[1],c[2],RangeUtil.clamp((c[3]??1)*alphaMul,0,1));
  }
  regularPolygon(x,y,r,c,n=10,rot=0){
    if(n<3||r<=0)return;
    const pts=this.geometryTemplates.regularPolygon(n,rot);this.geometryTemplateHits++;
    const ax=x+pts[0]*r,ay=y+pts[1]*r;
    for(let i=1;i<n-1;i++){
      const i1=i*2,i2=(i+1)*2;
      this.v(ax,ay,c);
      this.v(x+pts[i1]*r,y+pts[i1+1]*r,c);
      this.v(x+pts[i2]*r,y+pts[i2+1]*r,c);
    }
  }
  tri(x1,y1,x2,y2,x3,y3,c){
    this.v(x1,y1,c);this.v(x2,y2,c);this.v(x3,y3,c);
  }
  quad(x1,y1,x2,y2,x3,y3,x4,y4,c){
    this.v(x1,y1,c);this.v(x2,y2,c);this.v(x3,y3,c);this.v(x1,y1,c);this.v(x3,y3,c);this.v(x4,y4,c);
  }
  hex(x,y,r,c){this.regularPolygon(x,y,r,c,6,Math.PI/6)}
  petalRing(x,y,r,count,c,rot=0,stretch=.62){
    const dirs=this.geometryTemplates.petalRing(count,rot);this.geometryTemplateHits++;
    const ca=Math.cos(Math.PI*.48),sa=Math.sin(Math.PI*.48),rr=r*.42;
    for(let i=0;i<count;i++){
      const dx=dirs[i*2],dy=dirs[i*2+1],cx=x+dx*r,cy=y+dy*r;
      const ppx=dx*ca-dy*sa,ppy=dx*sa+dy*ca;
      const pmx=dx*ca+dy*sa,pmy=-dx*sa+dy*ca;
      this.quad(
        cx+dx*rr,cy+dy*rr*stretch,
        cx+ppx*rr*.62,cy+ppy*rr*.62,
        cx-dx*rr*.72,cy-dy*rr*.72*stretch,
        cx+pmx*rr*.62,cy+pmy*rr*.62,
        c
      );
    }
  }
  crestTriangle(x,y,r,c,angle=-Math.PI/2){
    this.tri(
      x+Math.cos(angle)*r,y+Math.sin(angle)*r,
      x+Math.cos(angle+2.35)*r*.72,y+Math.sin(angle+2.35)*r*.72,
      x+Math.cos(angle-2.35)*r*.72,y+Math.sin(angle-2.35)*r*.72,
      c
    );
  }
  drawTeamMark(x,y,r,own){
    const c=own?[.21,.49,.95,1]:[.94,.27,.28,1];
    this.circle(x,y,r,[.08,.10,.12,1],10);
    this.circle(x,y,r*.70,c,10);
  }
  poly(p,c){
    for(let i=1;i<p.length-1;i++){this.v(p[0][0],p[0][1],c);this.v(p[i][0],p[i][1],c);this.v(p[i+1][0],p[i+1][1],c)}
  }
  rect(x,y,w,h,c){this.quad(x,y,x+w,y,x+w,y+h,x,y+h,c)}
  circle(x,y,r,c,n=10){this.regularPolygon(x,y,r,c,n,0)}
  line(x1,y1,x2,y2,w,c){
    const dx=x2-x1,dy=y2-y1,l=Math.hypot(dx,dy)||1,nx=-dy/l*w/2,ny=dx/l*w/2;
    this.quad(x1+nx,y1+ny,x2+nx,y2+ny,x2-nx,y2-ny,x1-nx,y1-ny,c);
  }
  outlineCircle(x,y,r,w,c,segments=56,dashEvery=0){
    const pts=this.geometryTemplates.outlineCircle(segments);this.geometryTemplateHits++;
    for(let i=0;i<segments;i++){
      if(dashEvery>0&&i%dashEvery!==0)continue;
      const j=(i+1)%segments,i0=i*2,i1=j*2;
      this.line(
        x+pts[i0]*r,y+pts[i0+1]*r,
        x+pts[i1]*r,y+pts[i1+1]*r,
        w,c
      );
    }
  }
  drawBatch(pipeline,buffer,first,count,uniforms,textures=[]){
    // Direct regression renders can submit a pass without starting the animation loop.
    if(!this.vectorContext.active&&!this.vectorContext.beginFrame())return;
    const state=this.passState;
    this.device.draw({pipeline,buffer,first,count,uniforms,textures,blend:'straight-alpha',
      depth:state.depthEnabled?{func:state.depthFunc,write:state.depthWrite}:false,
      stencil:state.stencil,colorMask:state.colorMask});
  }
  flush(frame=this.frame,worldDepth=false){
    if(!frame.length)return;
    const d=frame.view();this.device.uploadVertices(this.buf,d);let draws=0;
    const uniforms={r:[this.canvas.width,this.canvas.height]};
    if(worldDepth){
      let start=0,solid=null;
      const draw=end=>{
        if(end<=start)return;
        this.passState.depthWrite=solid;
        this.drawBatch(this.spriteProgram,this.buf,start/7,(end-start)/7,{...uniforms,alphaCutoff:solid?.5:0});draws++;start=end;
      };
      for(let i=0;i<frame.length;i+=21){
        const next=Math.min(d[i+6],d[i+13],d[i+20])>=.999||Math.max(d[i+6],d[i+13],d[i+20])<=0;
        if(solid!==null&&next!==solid)draw(i);solid=next;
      }
      draw(frame.length);this.passState.depthWrite=false;
    }else{this.drawBatch(this.p,this.buf,0,frame.length/7,uniforms);draws=1}
    this.perfStats.drawCalls=(this.perfStats.drawCalls||0)+draws;
    this.perfStats.bufferUploadBytes=(this.perfStats.bufferUploadBytes||0)+d.byteLength;
    this.perfStats.vertexBufferGrows=frame.grows;
  }
  onScreenAuth(x,y,pad=120){
    // 최적화 판정은 고정 월드 뷰포트가 아니라
    // 실제 현재 게임 화면(캔버스) 기준으로 계산한다.
    // PC처럼 화면비가 넓거나 DPR/리사이즈가 자주 바뀌는 환경에서도
    // "화면 안인데 컬링되는" 현상을 줄이기 위한 보수적 판정이다.
    const sc=this.sc();
    const padPx=Math.max(12,pad*sc);
    const [sx,sy]=this.worldToPx(this.viewX(x),this.viewY(y));
    return sx>=-padPx&&
      sx<=this.canvas.width+padPx&&
      sy>=-padPx&&
      sy<=this.canvas.height+padPx;
  }

  presentationTargetIntervalMs(source=this.snapshot){
    const tps=Math.max(1,Number(source?.tps||this.snapshot?.tps||SIM_TPS)||SIM_TPS);
    return 1000/tps;
  }

  updatePresentationTargets(source,snap=false){
    if(!source)return;
    const now=performance.now();
    const units=source.units||[],projectiles=source.projectiles||[],flags=source.flags||[];
    const targetIntervalMs=this.presentationTargetIntervalMs(source);

    this.renderState.capture(source,now,snap,targetIntervalMs);
    const liveFacingIds=new Set(units.filter(u=>u?.alive!==false).map(u=>u.id));
    for(const id of this.unitFacingStates.keys())if(!liveFacingIds.has(id))this.unitFacingStates.delete(id);
    for(const id of this.artilleryFacingStates.keys())if(!liveFacingIds.has(id))this.artilleryFacingStates.delete(id);
    const liveProjectileIds=new Set(projectiles.filter(p=>p?.alive!==false).map(p=>p.id));
    for(const id of this.projectileScreenMotionStates.keys())if(!liveProjectileIds.has(id))this.projectileScreenMotionStates.delete(id);
  }

  presentationNow(now=performance.now()){return this._framePresentationAt??now}
  renderTrackedPosition(entity,kind="unit"){
    return this.renderState.position(kind,entity.id,entity,this.presentationNow());
  }
  renderTrackedScreenPosition(entity,kind="unit"){
    const p=this.renderTrackedPosition(entity,kind);
    const q=this.worldToPx(this.viewX(p.x),this.viewY(p.y));
    return{x:q[0],y:q[1],world:p};
  }
  renderTrackedDirectionScreen(entity,dx,dy,kind="unit"){
    const p=this.renderTrackedPosition(entity,kind);
    const a=this.worldToPx(this.viewX(p.x),this.viewY(p.y));
    const b=this.worldToPx(this.viewX(p.x+(Number(dx)||0)),this.viewY(p.y+(Number(dy)||0)));
    const vx=b[0]-a[0],vy=b[1]-a[1],len=Math.hypot(vx,vy)||1;
    return{x:vx/len,y:vy/len};
  }

  renderTrackedDelta(entity,kind="unit"){
    return this.renderState.delta(kind,entity.id);
  }

  chargedMemberIds(side){
    this.chargedMemberCache??=[null,null];
    const cast=this.snapshot?.chargedCasts?.[side],cached=this.chargedMemberCache[side];
    if(cached?.cast===cast)return cached.ids;
    const ids=new Set(cast?.memberIds||[]);this.chargedMemberCache[side]={cast,ids};return ids;
  }
  unitFacingIntentWorld(u){
    if(!u)return{x:0,y:0,attack:false};
    const execution=u.behaviorState?.chargedExecution;
    if(execution)return{x:execution.dirX,y:execution.dirY,attack:true};
    const cast=this.snapshot?.chargedCasts?.[u.side];
    if(cast&&cast.phase!=='released'&&this.chargedMemberIds(u.side).has(u.id)&&ChargedSkillMixin.stateReady(u,this.snapshot.tick)){
      const aim=ChargedSkillGeometry.aimPoint(u,cast,this.snapshot.tick,this.snapshot.tps,this.world);
      return{x:aim.x-u.x,y:aim.y-u.y,attack:true};
    }
    if(u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL||u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.ACTIVE){
      const x=Number(u.objectiveBreathDirX)||0,y=Number(u.objectiveBreathDirY)||0;
      if(Math.hypot(x,y)>.001)return{x,y,attack:true};
    }
    const model=this.renderState.model("unit",u.id,this.presentationNow()),pose=model?.entity;
    const tick=model?.tick??(this.snapshot?.tick||0);
    const combat=pose?.combat||u.combat,target=pose?pose.target:u.target,attackFlash=pose?pose.attackFlash:u.attackFlash;
    let targetId=null;
    if(combat.attackArcTargetId&&tick<(combat.attackArcUntilTick||0))targetId=combat.attackArcTargetId;
    else if(target&&(((combat.attackWindupUntil||0)>tick)||attackFlash>0||((combat.cooldownUntil||0)>tick)||(this.attackPresentationUntil.get(u.id)||0)>performance.now()))targetId=target;
    if(targetId){
      const target=(this.renderState.model("unit",targetId,this.presentationNow())&&this.renderState.entity("unit",targetId))||
        (this.snapshot?.buildings||[]).find(e=>e.id===targetId&&e.alive!==false);
      if(target){
        const targetPose=this.renderState.model("unit",target.id,this.presentationNow())?.entity||target,pose=this.renderTrackedPosition(u);
        const x=targetPose.x-pose.x,y=targetPose.y-pose.y;
        if(Math.hypot(x,y)>.001)return{x,y,attack:true};
      }
    }
    const delta=this.renderTrackedDelta(u,"unit");
    if(Math.hypot(delta.x,delta.y)>.001)return{x:delta.x,y:delta.y,attack:false};
    return{x:0,y:0,attack:false};
  }

  artilleryFacingScreen(u){
    const now=performance.now(),intent=this.unitFacingIntentWorld(u),delta=this.renderTrackedDelta(u,"unit");
    const movementIntent=Math.hypot(delta.x,delta.y)>.001?delta:null;
    const turretIntent=intent.attack?intent:(movementIntent||intent);
    const angleFor=(v,fallback)=>{
      if(!v||Math.hypot(v.x,v.y)<.001)return fallback;
      const q=this.renderTrackedDirectionScreen(u,v.x,v.y,"unit");return Math.atan2(q.y,q.x);
    };
    const fallback=this.isFriendlySide(u.side)?-Math.PI/2:Math.PI/2;
    let st=this.artilleryFacingStates.get(u.id);
    if(!st){const a=angleFor(movementIntent||turretIntent,fallback);st={hull:a,turret:a,lastAt:now,locked:false};this.artilleryFacingStates.set(u.id,st)}
    const dt=RangeUtil.clamp((now-(st.lastAt||now))/1000,0,.10);st.lastAt=now;
    const deployState=u.behaviorState?.deploymentState||"mobile",anchored=deployState==="deploying"||deployState==="deployed";
    // Hull locks at the instant deployment starts. It remains fixed until fully mobile again.
    if(anchored&&!st.locked)st.locked=true;
    if(deployState==="mobile"){
      st.locked=false;
      if(movementIntent){const desired=angleFor(movementIntent,st.hull),diff=Math.atan2(Math.sin(desired-st.hull),Math.cos(desired-st.hull));st.hull+=RangeUtil.clamp(diff,-7*dt,7*dt)}
    }
    // Turret is independent: target while fighting, otherwise travel direction.
    if(turretIntent){const desired=angleFor(turretIntent,st.turret),diff=Math.atan2(Math.sin(desired-st.turret),Math.cos(desired-st.turret));st.turret+=RangeUtil.clamp(diff,-14*dt,14*dt)}
    return{hullAngle:st.hull,turretAngle:st.turret,attack:intent.attack,deployState};
  }
  withFacingAngle(angle,u,x,y,fn){return this.withFacingPivot(angle,u,x,y,x,y,fn)}
  withFacingPivot(angle,u,pivotX,pivotY,baseX,baseY,fn){
    const authoredForward=-Math.PI/2,a=Math.atan2(Math.sin(angle-authoredForward),Math.cos(angle-authoredForward)),prev=this._unitFacingTransform;
    this._unitFacingTransform={pivotX,pivotY,cos:Math.cos(a),sin:Math.sin(a)};
    try{return fn({baseX,baseY})}finally{this._unitFacingTransform=prev}
  }

  resolveUnitFacingScreen(u){
    const intent=this.unitFacingIntentWorld(u),now=performance.now();
    let desired=null;
    if(Math.hypot(intent.x,intent.y)>.001){
      const dir=this.renderTrackedDirectionScreen(u,intent.x,intent.y,"unit");
      if(Math.hypot(dir.x,dir.y)>.001)desired=Math.atan2(dir.y,dir.x);
    }
    const fallback=this.isFriendlySide(u.side)?-Math.PI/2:Math.PI/2;
    let state=this.unitFacingStates.get(u.id);
    if(!state){state={angle:desired??fallback,lastAt:now};this.unitFacingStates.set(u.id,state)}
    else{
      const dt=RangeUtil.clamp((now-(state.lastAt||now))/1000,0,.10);state.lastAt=now;
      if(desired!=null){
        let diff=Math.atan2(Math.sin(desired-state.angle),Math.cos(desired-state.angle));
        const step=(intent.attack?14:9)*dt;diff=RangeUtil.clamp(diff,-step,step);state.angle+=diff;
      }
    }
    const fx=Math.cos(state.angle),fy=Math.sin(state.angle);
    return{fx,fy,sx:-fy,sy:fx,angle:state.angle,attack:intent.attack};
  }

  unitFacingEnabled(u){return !!u&&UnitVisualDefinition.get(u.type)?.facing==="full"}

  beginUnitFacingTransform(u,x,y){
    const facing=this.resolveUnitFacingScreen(u);
    // Full-facing ground visuals have one authored local forward: screen-up (-Y).
    // Perspective/side inversion is already resolved by renderTrackedDirectionScreen().
    // Using own/enemy to choose another base axis double-inverts Guest/enemy visuals.
    const authoredForward=-Math.PI/2;
    const a=Math.atan2(Math.sin(facing.angle-authoredForward),Math.cos(facing.angle-authoredForward));
    const prev=this._unitFacingTransform;
    this._unitFacingTransform={pivotX:x,pivotY:y,cos:Math.cos(a),sin:Math.sin(a)};
    return prev;
  }
  restoreUnitFacingTransform(prev){this._unitFacingTransform=prev||null}
  unitFacingPoint(x,y){
    const tr=this._unitFacingTransform;if(!tr)return[x,y];
    const dx=x-tr.pivotX,dy=y-tr.pivotY;
    return[tr.pivotX+dx*tr.cos-dy*tr.sin,tr.pivotY+dx*tr.sin+dy*tr.cos];
  }

  presentationEntityActive(kind,id){
    return this.renderState.has(kind,id,this.presentationNow());
  }

  

  resolveArcTravelPresentation({fromX,fromY,toX,toY,planarX,planarY,arcHeight=0,fromElevation=null,toElevation=null}={}){
    const sx=Number(fromX),sy=Number(fromY),tx=Number(toX),ty=Number(toY),px=Number(planarX),py=Number(planarY);
    if(![sx,sy,tx,ty,px,py].every(Number.isFinite))return{height:0,groundHeight:0,progress:0,motion:"ground"};
    const totalDistance=Math.hypot(tx-sx,ty-sy);
    const travelledDistance=Math.hypot(px-sx,py-sy);
    const progress=RangeUtil.clamp(travelledDistance/Math.max(1,totalDistance),0,1);
    const atlas=this.world.terrain.surfaces,from=Number.isFinite(fromElevation)?fromElevation:atlas.heightAt(sx,sy),to=Number.isFinite(toElevation)?toElevation:atlas.heightAt(tx,ty);
    const groundHeight=from*(1-progress)+to*progress;
    return{height:Math.sin(progress*Math.PI)*Math.max(0,Number(arcHeight)||0),groundHeight,progress,motion:"arc"};
  }

  resolveRenderWorldPosition(entity,kind="unit",options=null){
    const useEntityPlanar=!!options?.useEntityPlanar;
    const planar=useEntityPlanar
      ?{x:Number(entity.x)||0,y:Number(entity.y)||0}
      :this.renderTrackedPosition(entity,kind);
    const atlas=this.world.terrain.surfaces;
    let groundY=atlas.heightAt(planar.x,planar.y),height=0,motion="ground",progress=0;
    const model=useEntityPlanar?null:this.renderState.model(kind,entity.id,this.presentationNow());
    const motionState=model?.entity||entity;
    const renderTick=model?.tick??(this.snapshot?.tick||0);

    if(kind==="unit"){
      const d=UnitDefinition.get(entity.type)||{};
      if(d.layer==="AIR"){
        const bob=Math.sin(this.presentationNow()*.004+(HashUtil.hash(entity.id)%997)*.019)*2.4;
        height=atlas.maxHeight-groundY+(d.airHeight||36)+bob;
        motion="air";
      }else if(motionState.leapActive&&renderTick<(motionState.leapEndTick||0)){
        const duration=Math.max(1,(motionState.leapEndTick||0)-(motionState.leapStartTick||0));
        progress=RangeUtil.clamp((renderTick-(motionState.leapStartTick||0))/duration,0,1);
        const startHeight=atlas.heightAt(motionState.leapStartX??entity.x,motionState.leapStartY??entity.y),endHeight=atlas.heightAt(motionState.leapEndX??entity.x,motionState.leapEndY??entity.y);
        groundY=startHeight+(endHeight-startHeight)*progress;
        height=Math.sin(progress*Math.PI)*(ROGUE_LEAP_ARC_HEIGHT+atlas.maxHeight);
        motion="leap";
      }else if(renderTick<(motionState.status.airborneUntil||0)){
        const duration=Math.max(1,motionState.status.airborneDurationTicks||((motionState.status.airborneUntil||0)-(motionState.status.airborneStartTick||0))||1);
        progress=RangeUtil.clamp((renderTick-(motionState.status.airborneStartTick||0))/duration,0,1);
        height=Math.sin(progress*Math.PI)*(motionState.status.airborneHeight||42);
        motion="airborne";
      }
    }else if(kind==="projectile"){
      if(motionState.launchX!=null&&motionState.launchY!=null){
        // Arc presentation must use the same trajectory destination as simulation.
        // In particular lockedPoint artillery must never recompute its arc from a
        // living target that can move/separate after launch.
        const policy=motionState.trajectoryPolicy||(motionState.impactAtAimPoint?"lockedPoint":"trackingTarget");
        let aimX=Number(motionState.lockedAimX),aimY=Number(motionState.lockedAimY),toElevation=null;
        const source=UnitDefinition.get(entity.type),fromElevation=source?.layer==="AIR"?atlas.maxHeight+(source.airHeight||36):null;
        if(policy==="trackingTarget"&&!motionState.targetLost){
          const target=(this.renderState.model("unit",motionState.target,this.presentationNow())&&this.renderState.entity("unit",motionState.target))||
            (this.snapshot?.buildings||[]).find(b=>b.id===motionState.target&&b.alive!==false);
          if(target){const targetPose=this.renderState.model("unit",target.id,this.presentationNow())?.entity||target;aimX=targetPose.x+(Number(motionState.aimOffsetX)||0);aimY=targetPose.y+(Number(motionState.aimOffsetY)||0);const td=UnitDefinition.get(target.type);if(td?.layer==="AIR")toElevation=atlas.maxHeight+(td.airHeight||36)}
        }
        if(Number.isFinite(aimX)&&Number.isFinite(aimY)){
          // All consumers use the shared arc-travel primitive; projectile code owns
          // endpoint policy only, never the trajectory formula.
          const arc=this.resolveArcTravelPresentation({
            fromX:motionState.launchX,fromY:motionState.launchY,toX:aimX,toY:aimY,
            planarX:planar.x,planarY:planar.y,arcHeight:motionState.arcHeight,fromElevation,toElevation
          });
          groundY=arc.groundHeight;height=arc.height;progress=arc.progress;motion=arc.motion;
        }
      }
    }
    return{x:planar.x,y:groundY+height,z:planar.y,groundY,motion,progress};
  }
  resolveGroundShadowPosition(entity,kind="unit"){
    const p=this.renderTrackedPosition(entity,kind);
    const groundY=this.world.terrain.surfaces.heightAt(p.x,p.y);
    return{x:p.x,y:groundY+.001,z:p.y,groundY,motion:"ground"};
  }
  renderDepthForWorld(p){
    // Height belongs to screen projection only. Ground progression owns depth,
    // normalized to this map's extent in either camera orientation.
    const vz=this.viewY(p.z);
    const d=GLRenderer.DEPTH_PROJECTION;
    if(p.bridgeId){const bridge=this.world.terrain.surfaces.bridges.find(b=>b.id===p.bridgeId);if(bridge)return this.bridgeDepth(bridge)}
    return RangeUtil.clamp(d.offset-vz/this.world.height*d.viewSpan,d.min,d.max);
  }
  bridgeDepth(bridge){
    // A deck is a separate occluding layer over the same ground footprint.
    const vz=Math.max(this.viewY(bridge.minY),this.viewY(bridge.maxY)),d=GLRenderer.DEPTH_PROJECTION;
    return RangeUtil.clamp(d.offset-vz/this.world.height*d.viewSpan,d.min,d.max);
  }
  renderBridgeAt(x,z){
    const atlas=this.world.terrain.surfaces;
    if(!atlas.bridges.length)return null;
    return atlas.bridgeIndex.query(x,z).find(b=>MapGeometry.pointInSimplePolygon(x,z,b.points)||atlas.onBoundary(b.points,x,z))||null;
  }
  projectRenderWorldPositionStable(p){
    // Same projection as projectRenderWorldPosition, but intentionally before
    // final screen composition. All world consumers use this stable projection.
    const vx=this.viewX(p.x),vz=this.viewY(p.z);
    const groundY=p.groundY==null?this.world.terrain.surfaces.heightAt(p.x,p.z):p.groundY;
    const resolved=p.groundY==null?{...p,y:p.y+groundY,groundY}:p;
    const projected={depth:this.renderDepthForWorld(resolved),world:resolved};
    return (this._frameCamera||this.stableCamera()).worldToScreenInto(vx,vz,resolved.y,projected);
  }
  projectRenderWorldPosition(p){
    return this.projectRenderWorldPositionStable(p);
  }
  projectEntityScreen(entity,kind="unit"){
    return this.projectRenderWorldPosition(this.resolveRenderWorldPosition(entity,kind));
  }
  resolveLeapTrailWorldPositions(entity,count=3){
    const cur=this.resolveRenderWorldPosition(entity,"unit");
    if(cur.motion!=="leap")return[];
    entity=this.renderState.model("unit",entity.id,this.presentationNow())?.entity||entity;
    const out=[];
    for(let k=1;k<=count;k++){
      const t=RangeUtil.clamp(cur.progress-k*.10,0,1);
      const x=(entity.leapStartX??entity.x)+((entity.leapEndX??entity.x)-(entity.leapStartX??entity.x))*t;
      const z=(entity.leapStartY??entity.y)+((entity.leapEndY??entity.y)-(entity.leapStartY??entity.y))*t;
      const atlas=this.world.terrain.surfaces,groundY=atlas.heightAt(entity.leapStartX??entity.x,entity.leapStartY??entity.y)*(1-t)+atlas.heightAt(entity.leapEndX??entity.x,entity.leapEndY??entity.y)*t;
      out.push({x,y:groundY+Math.sin(t*Math.PI)*(ROGUE_LEAP_ARC_HEIGHT+atlas.maxHeight),z,groundY,motion:"leapTrail",progress:t});
    }
    return out;
  }
  unitVisibleForRender(u){
    if(!u?.alive||BurrowableMixin.stateActive(u)||!this.presentationEntityActive("unit",u.id))return false;
    const p=this.projectEntityScreen(u,"unit"),pad=((UnitDefinition.get(u.type)?.size||15)+80)*this.sc();
    if(p.x<-pad||p.y<-pad||p.x>this.canvas.width+pad||p.y>this.canvas.height+pad)return false;
    const own=u.side===this.mySide(),cloaked=this.snapshotStealthed(u);
    const air=UnitDefinition.get(u.type)?.layer==="AIR",detected=own?true:this.detectedRaw(u.x,u.y,air);
    return own||(this.visibleRaw(u.x,u.y,air)&&(!cloaked||detected));
  }
  prepareVisibleUnitFrame(){
    const out=this.visibleUnitFrame;out.length=0;
    for(const u of this.renderState.displayed("unit",this.presentationNow()))if(this.unitVisibleForRender(u))out.push(u);
    return out;
  }

  drawUnitShadow(u,visibilityChecked=false){
    const own=u.side===this.mySide();
    const air=UnitDefinition.get(u.type)?.layer==="AIR",cloaked=this.snapshotStealthed(u),detected=own?true:this.detectedRaw(u.x,u.y,air);
    if(!visibilityChecked&&!own&&(!this.visibleRaw(u.x,u.y,air)||(cloaked&&!detected)))return;
    const body=this.resolveRenderWorldPosition(u,"unit");
    const groundWorld=this.resolveGroundShadowPosition(u,"unit"),ground=this.projectRenderWorldPosition(groundWorld);
    const sc=this.sc(),r=this.unitRenderRadius(u);
    const height=Math.max(0,body.y-body.groundY),shrink=1/(1+height/220),alpha=RangeUtil.clamp(.17-height/850,.06,.17);
    if(UnitVisualDefinition.get(u.type)?.billboard){
      const team=UnitFactionPalette.get(this.factionRelation(u.side)).body,rx=r*1.05*shrink,ry=r*.42*shrink,pts=[];
      for(let i=0;i<14;i++){const a=i/14*Math.PI*2;pts.push([ground.x+Math.cos(a)*rx,ground.y+r*.55+Math.sin(a)*ry])}
      this.withWorldSpriteDepth(groundWorld,()=>this.poly(pts,[team[0],team[1],team[2],.85]),.0003);
      return;
    }
    this.withWorldSpriteDepth(groundWorld,()=>{
      this.circle(ground.x+2*sc,ground.y+Math.max(1,2*sc),r*.96*shrink,own&&cloaked?[.05,.12,.08,alpha*.42]:[.04,.06,.08,alpha],12);
      this.circle(ground.x,ground.y,r*.52*shrink,[.04,.06,.08,alpha*.50],10);
    },.0003);
  }

  renderTrackedFlag(side){
    const current=this.snapshot?.flags?.[side];
    if(!current)return null;
    const p=this.renderState.position("flag",side,current,this.presentationNow());
    return{x:p.x,y:p.y,forced:!!p.forced};
  }

  rebuildVisibilityCache(){
    this.snapshotCloakedIds.clear();
    if(!this.snapshot)return;
    for(const side of [0,1])VisionField.of(this,side,this.snapshot);
    const query=VisibilityPolicy.unitQuery(this.snapshot);
    for(const source of this.snapshot.units){
      const radius=Number(UnitDefinition.get(source.type)?.cloakAuraRadius)||0;if(!source.alive||radius<=0)continue;
      query(source.x,source.y,radius,u=>{if(CloakAuraMixin.canAffect(source,u)&&(u.x-source.x)**2+(u.y-source.y)**2<=radius*radius)this.snapshotCloakedIds.add(u.id)});
    }
  }

  reconcileShieldVisualStates(snapshot,animateTransitions=true){
    const now=performance.now(),seenTick=Number(snapshot?.tick)||0;
    for(const u of snapshot?.units||[]){
      if(!u?.id||u.alive===false)continue;
      const charges=Math.max(0,Number(u.hitGuard)||0);
      let state=this.shieldVisualStates.get(u.id);
      if(!state){
        state={charges,appliedAt:0,lastSeenTick:seenTick,seed:HashUtil.hash(`shield:${u.id}`)};
        if(animateTransitions&&charges>0)state.appliedAt=now;
        this.shieldVisualStates.set(u.id,state);
      }else{
        if(animateTransitions&&charges>state.charges)state.appliedAt=now;
        state.charges=charges;state.lastSeenTick=seenTick;
      }
    }
    // Keep the map bounded across long matches/replays.
    if(this.shieldVisualStates.size>640){
      for(const[id,state]of this.shieldVisualStates){
        if(state.lastSeenTick!==seenTick)this.shieldVisualStates.delete(id);
      }
    }
  }

  drawSharedShieldVisual(u,x,y,r){
    const charges=Math.max(0,Number(u?.hitGuard)||0);
    if(charges<=0||u.side===NEUTRAL_SIDE)return;
    const now=performance.now(),state=this.shieldVisualStates.get(u.id);
    const applyAge=state?.appliedAt?Math.max(0,now-state.appliedAt):9999;
    const applyT=RangeUtil.clamp(applyAge/240,0,1),ease=1-Math.pow(1-applyT,3);
    const pulse=.5+.5*Math.sin(now*.0048+(state?.seed||HashUtil.hash(u.id))*.013);
    const shellR=r*(1.42+(1-ease)*.20+.040*pulse);
    const innerR=shellR*.74;

    // Protoss-like energy shell: a readable translucent body envelope with broad flat plates.
    // The broad plates keep the status readable even when combat zoom makes units only a few pixels wide.
    this.circle(x,y,shellR,[.14,.69,.95,.135+.045*pulse],26);
    this.circle(x,y,innerR,[.48,.92,1,.035+.018*pulse],22);

    const facetCount=6,span=.39;
    for(let i=0;i<facetCount;i++){
      const a=-Math.PI/2+i*Math.PI*2/facetCount+now*.00014;
      const shimmer=(i===Math.floor((now*.00135+(state?.seed||0)*.01)%facetCount));
      const a0=a-span,a1=a+span,ri=shellR*.68,ro=shellR*1.025;
      const pts=[
        [x+Math.cos(a0)*ri,y+Math.sin(a0)*ri],
        [x+Math.cos(a0)*ro,y+Math.sin(a0)*ro],
        [x+Math.cos(a1)*ro,y+Math.sin(a1)*ro],
        [x+Math.cos(a1)*ri,y+Math.sin(a1)*ri]
      ];
      this.poly(pts,shimmer?[.72,.97,1,.38]:[.25,.80,1,.14+(i%2)*.035]);
    }

    // Two asymmetric surface highlights make it read as a curved bubble rather than a circular status ring.
    const hiA=-2.28+Math.sin(now*.0012+(state?.seed||0))*.08;
    for(let j=0;j<3;j++){
      const a=hiA+j*.25,rr=shellR*(.64+j*.10),len=Math.max(r*.22,2.0*this.sc());
      const tx=-Math.sin(a),ty=Math.cos(a),cx=x+Math.cos(a)*rr,cy=y+Math.sin(a)*rr;
      this.line(cx-tx*len,cy-ty*len,cx+tx*len,cy+ty*len,Math.max(1.2,(2.7-j*.35)*this.sc()),[.88,1,1,.58-j*.09]);
    }
    const lowA=.56,lowCx=x+Math.cos(lowA)*shellR*.80,lowCy=y+Math.sin(lowA)*shellR*.80;
    this.poly([[lowCx-r*.13,lowCy],[lowCx,lowCy-r*.16],[lowCx+r*.13,lowCy],[lowCx,lowCy+r*.16]],[.58,.94,1,.28]);

    // Applying a shield briefly expands the whole shell so newly protected units are immediately readable.
    if(applyT<1){
      const flash=(1-applyT);
      this.circle(x,y,shellR*(.74+.28*ease),[.48,.93,1,.12+.12*flash],22);
      const rr=shellR*(.72+.28*ease);
      for(let k=0;k<6;k++){
        const a=k*Math.PI/3+(state?.seed||0)*.01;
        this.circle(x+Math.cos(a)*rr,y+Math.sin(a)*rr,Math.max(1.8,r*.075),[.82,.98,1,.52*flash],7);
      }
    }

    // Multiple hitGuard charges share the same visual; extra charge only strengthens the shell slightly.
    if(charges>1)this.circle(x,y,shellR*.93,[.42,.90,1,.035*Math.min(3,charges)],22);
  }

  drawSharedShieldsOverlay(){
    if(!this.snapshot)return;
    for(const u of this.snapshot.units||[]){
      if(!u?.alive||(Number(u.hitGuard)||0)<=0||u.side===NEUTRAL_SIDE||!this.presentationEntityActive("unit",u.id))continue;
      const own=u.side===this.mySide(),cloaked=this.snapshotStealthed(u),detected=own?true:this.detectedRaw(u.x,u.y);
      if(!own&&(!this.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR")||(cloaked&&!detected)))continue;
      const rp=this.renderTrackedPosition(u,"unit");
      if(!this.onScreenAuth(rp.x,rp.y,(UnitDefinition.get(u.type)?.size||15)+90))continue;
      const pos=this.projectEntityScreen(u,"unit"),r=this.unitRenderRadius(u);
      this.drawSharedShieldVisual(u,pos.x,pos.y,r);
    }
  }

  reconcileAirPresentationSpawns(previous,snapshot){
    if(!previous||!snapshot)return;
    const tickGap=Math.abs((Number(snapshot.tick)||0)-(Number(previous.tick)||0));
    // Recovery/seek/large correction snapshots must snap, not replay a storm of spawn VFX.
    if(tickGap>4)return;
    const oldIds=new Set((previous.units||[]).filter(u=>u?.alive!==false).map(u=>u.id));
    let seq=0;
    for(const u of snapshot.units||[]){
      if(!u?.alive||!UnitDefinition.get(u.type)?.carrierSummon||oldIds.has(u.id)||!u.summonerId)continue;
      const carrier=(snapshot.units||[]).find(x=>x.id===u.summonerId&&x.alive&&UnitDefinition.get(x.type)?.ownsSummonedUnits);
      if(!carrier)continue;
      this.addClientFx("carrierLaunch",{
        type:"carrierLaunch",side:u.side,sourceType:carrier.type,sourceId:carrier.id,targetId:u.id,
        x:carrier.x,y:carrier.y,x2:u.x,y2:u.y
      },snapshot,9000+(seq++));
    }
  }

  setSnapshot(s,{liveTargets=false,snapTargets=false}={}){
    const old=this.snapshot;
    if(snapTargets||!old)this.resetFogTransition();
    this.world=WorldContext.forState(s);
    this.snapshot=s;

    if(liveTargets){
      // The sim bridge owns motion and lifetime. UI snapshots only refresh ordinary
      // visual metadata; they cannot introduce an identity ahead of its display time.
      if(!this.liveRenderTargets||!old||snapTargets)this.updatePresentationTargets(s,true);
      else this.renderState.updateMetadata(s);
      this.liveRenderTargets=true;
    }else{
      // Replay/snapshot-only consumers do not have the simulation bridge, so each
      // received snapshot becomes a presentation target through the same store.
      this.liveRenderTargets=false;
      this.updatePresentationTargets(s,!!snapTargets||!old);
    }
    this.reconcileShieldVisualStates(s,!!old);
    if(old&&!snapTargets)this.reconcileAirPresentationSpawns(old,s);

    // Reconcile local latency-hiding visuals with authoritative snapshots.
    const mySide=this.mySide();
    const now=performance.now();
    if(this.pendingBuildGhosts?.length){
      this.pendingBuildGhosts=this.pendingBuildGhosts.filter(g=>{
        if(now-g.start>PREDICTED_BUILD_GHOST_TTL_MS)return false;
        return [...(s?.buildings||[]),...(s?.constructionOrders||[])].every(b=>!(
          b.alive!==false&&b.side===mySide&&b.type===g.building&&
          Math.hypot((b.x||0)-g.x,(b.y||0)-g.y)<4
        ));
      });
    }
    if(this.predictedFlag){
      const af=s?.flags?.[mySide];
      if(af&&af.forced===this.predictedFlag.forced&&Math.hypot(af.x-this.predictedFlag.x,af.y-this.predictedFlag.y)<3){
        this.predictedFlag=null;
      }
    }
    this.prunePredictedFlag(now);
    if(this.latencySpellFx?.length)this.latencySpellFx=this.latencySpellFx.filter(f=>now-f.start<PREDICTED_COMMAND_FX_TTL_MS);

    this.rebuildVisibilityCache();

    // SET_FLAG 자체는 lockstep 이벤트로 양쪽이 동일하게 받지만,
    // 먼지/충격파/천 흔들림은 좌표 동기화가 필요 없는 로컬 VFX다.
    const side=this.mySide();
    const ev=[...(s?.events||[])].reverse().find(e=>e.type==="flag"&&e.side===side);
    if(ev){
      const key=`${s.tick}:${side}:${Math.round(ev.x)}:${Math.round(ev.y)}`;
      const locallyPredicted=this.lastPredictedFlagFx&&
        this.lastPredictedFlagFx.forced===!!ev.forced&&
        Math.hypot(this.lastPredictedFlagFx.x-ev.x,this.lastPredictedFlagFx.y-ev.y)<3&&
        performance.now()-this.lastPredictedFlagFx.start<5000;
      if(key!==this.lastFlagFxKey){
        this.lastFlagFxKey=key;
        if(!locallyPredicted){
          const flagFx=this.flagFxPool.acquire();
          flagFx.x=ev.x;flagFx.y=ev.y;flagFx.side=side;flagFx.forced=!!ev.forced;flagFx.start=performance.now();flagFx.seed=HashUtil.hash(key);
          this.flagFx.push(flagFx);
          // 최신 지휘 명령만 강하게 보이도록 오래된 효과는 정리.
          while(this.flagFx.length>3)this.flagFxPool.release(this.flagFx.shift());
        }
      }
    }
    this.processFloatingEvents(s);
    this.processClientCombatEffects(s);
  }

  predictBuild(action){
    if(!action||action.type!=="BUILD")return;
    const key=`${action.building}|${Math.round(action.x)}|${Math.round(action.y)}`;
    this.pendingBuildGhosts=this.pendingBuildGhosts.filter(g=>g.key!==key);
    this.pendingBuildGhosts.push({
      key,building:action.building,produceType:action.produceType||null,
      x:action.x,y:action.y,start:performance.now()
    });
    if(this.pendingBuildGhosts.length>12)this.pendingBuildGhosts.splice(0,this.pendingBuildGhosts.length-12);
  }
  prunePredictedFlag(now=performance.now()){
    if(this.predictedFlag&&now-this.predictedFlag.start>PREDICTED_BUILD_GHOST_TTL_MS)this.predictedFlag=null;
  }
  predictFlag(x,y,forced=false){
    const now=performance.now(),side=this.mySide();
    this.predictedFlag={x,y,forced:!!forced,start:now};
    this.lastPredictedFlagFx={x,y,forced:!!forced,start:now};
    const key=`pred:${side}:${Math.round(x)}:${Math.round(y)}:${forced?1:0}:${Math.round(now)}`;
    const fx=this.flagFxPool.acquire();fx.x=x;fx.y=y;fx.side=side;fx.forced=!!forced;fx.start=now;fx.seed=HashUtil.hash(key);
    this.flagFx.push(fx);
    while(this.flagFx.length>3)this.flagFxPool.release(this.flagFx.shift());
  }
  predictSpellCast(spellId,payload={}){
    const now=performance.now();
    this.latencySpellFx.push({spellId,start:now,...payload});
    if(this.latencySpellFx.length>8)this.latencySpellFx.splice(0,this.latencySpellFx.length-8);
  }
  drawConstructionOrders(){
    const side=this.mySide(),prev=this._unitRenderAlphaMul;
    this._unitRenderAlphaMul=.38;
    try{
      for(const order of this.snapshot?.constructionOrders||[]){
        if(order.side!==side)continue;
        // Presentation DTO only: reservations never enter the entity render/HP pass.
        this.drawBuildingSafely({...order,complete:true,queue:[]});
      }
    }finally{this._unitRenderAlphaMul=prev}
  }
  drawPendingBuildGhosts(){
    if(!this.pendingBuildGhosts?.length)return;
    const now=performance.now(),side=this.mySide(),prev=this._unitRenderAlphaMul;
    this.pendingBuildGhosts=this.pendingBuildGhosts.filter(g=>now-g.start<PREDICTED_BUILD_GHOST_TTL_MS);
    this._unitRenderAlphaMul=.30;
    for(const g of this.pendingBuildGhosts){
      this.drawBuilding({
        id:`pred-${g.key}`,type:g.building,side,x:g.x,y:g.y,
        hp:BuildingDefinition.get(g.building)?.hp||1,maxHp:BuildingDefinition.get(g.building)?.hp||1,
        complete:true,progress:0,queue:[],alive:true,produceType:g.produceType||null
      });
    }
    this._unitRenderAlphaMul=prev;
  }
  drawLatencySpellFx(){
    if(!this.latencySpellFx?.length)return;
    const now=performance.now(),sc=this.sc();
    this.latencySpellFx=this.latencySpellFx.filter(f=>now-f.start<PREDICTED_COMMAND_FX_TTL_MS);
    for(const f of this.latencySpellFx){
      const age=now-f.start,t=RangeUtil.clamp(age/PREDICTED_COMMAND_FX_TTL_MS,0,1),d=SpellDefinition.get(f.spellId);
      if(!d)continue;
      const pulse=.5+.5*Math.sin(age*.018);
      const drawAt=(ax,ay)=>{
        const p=this.worldToPx(this.viewX(ax),this.viewY(ay));
        const stats=this.snapshot?.spellBooks?.[this.mySide()]?.[f.spellId];
        const sd=SpellDefinition.statsAt(f.spellId,stats?.mastery||0);
        const rr=(sd?.radius||42)*sc;
        this.circle(p[0],p[1],Math.max(10,rr*(.94+.06*pulse)),[.35,.82,1,.18*(1-t)],32);
        this.outlineCircle(p[0],p[1],Math.max(12,rr),Math.max(1.5,2.4*sc),[.62,.92,1,.72*(1-t)],32,1);
      };
      if(f.spellId==="tunnel"&&f.entryX!=null&&f.exitX!=null){
        drawAt(f.entryX,f.entryY);drawAt(f.exitX,f.exitY);
      }else if(f.x!=null)drawAt(f.x,f.y);
    }
  }

  triggerClientShake(intensity=2,duration=140,seed=1){
    const dpr=Math.min(1.6,devicePixelRatio||1),sh=this.shakeFxPool.acquire();
    sh.start=performance.now();sh.duration=Math.max(40,duration);sh.intensity=Math.max(.5,intensity*dpr);sh.seed=Number(seed)||1;
    this.shakeFx.push(sh);
    while(this.shakeFx.length>8)this.shakeFxPool.release(this.shakeFx.shift());
  }

  updateClientShake(){
    const now=performance.now();
    let sx=0,sy=0,write=0;

    for(let i=0;i<this.shakeFx.length;i++){
      const sh=this.shakeFx[i],age=now-sh.start;
      if(age>=sh.duration){this.shakeFxPool.release(sh);continue}

      const t=age/sh.duration;
      const amp=sh.intensity*Math.pow(1-t,2);
      const phase=age*.095+(sh.seed%997)*.013;
      sx+=Math.sin(phase*1.71)*amp;
      sy+=Math.sin(phase*2.33+1.7)*amp*.72;
      this.shakeFx[write++]=sh;
    }

    this.shakeFx.length=write;
    this.frameShakeX=sx;
    this.frameShakeY=sy;
  }

  addClientFx(kind,e,snapshot,index,extra={}){
    if(kind==="linkedBeam"&&e.sourceId){
      for(let i=this.combatFx.length-1;i>=0;i--){
        const old=this.combatFx[i];if(old?.kind!=="linkedBeam"||old.sourceId!==e.sourceId)continue;
        if(old.targetId===e.targetId){old.start=performance.now();old.durationTicks=Number(e.durationTicks)||old.durationTicks;old.x=Number(e.x)||old.x;old.y=Number(e.y)||old.y;old.x2=Number(e.x2)||old.x2;old.y2=Number(e.y2)||old.y2;return old}
        this.combatFx.splice(i,1);this.combatFxPool.release(old);
      }
    }
    const eventTick=Number.isFinite(Number(e.presentationTick))?Number(e.presentationTick):snapshot.tick;
    const seed=HashUtil.hash(
      `${eventTick}|${index}|${kind}|${e.sourceType||e.unit||e.spell||""}|`+
      `${Math.round(e.x||0)}|${Math.round(e.y||0)}`
    );
    const eventAgeMs=Math.max(0,Math.min(250,(snapshot.tick-eventTick)*(1000/(snapshot.tps||SIM_TPS))));

    const fx=this.combatFxPool.acquire();
    fx.kind=kind;fx.x=Number(e.x)||0;fx.y=Number(e.y)||0;fx.x2=Number(e.x2)||0;fx.y2=Number(e.y2)||0;
    fx.sourceType=e.sourceType||e.unit||"";fx.targetType=e.targetType||e.entity||"";fx.entity=e.entity||"";fx.spell=e.spell||"";
    fx.amount=Number(e.amount)||0;fx.radius=Number(e.radius)||0;fx.width=Number(e.width)||0;fx.remaining=Math.max(0,Number(e.remaining)||0);fx.spikeCount=Math.max(0,Math.round(Number(e.spikeCount)||0));
    fx.airborneHeight=Number(e.height??e.status?.airborneHeight)||0;fx.airborneTicks=Number(e.airborneTicks)||0;fx.durationTicks=Number(e.durationTicks)||0;
    fx.sourceId=e.sourceId||null;fx.targetId=e.targetId||null;
    fx.travelMs=Number(e.travelMs)||0;fx.arcHeight=Number(e.arcHeight)||0;fx.retractMs=Number(e.retractMs)||0;fx.pullTicks=Number(e.pullTicks)||0;fx.fromX=Number(e.fromX)||0;fx.fromY=Number(e.fromY)||0;
    fx.fromX=Number.isFinite(Number(e.fromX))?Number(e.fromX):null;fx.fromY=Number.isFinite(Number(e.fromY))?Number(e.fromY):null;
    fx.isBuilding=!!e.isBuilding;fx.points=Array.isArray(e.points)?e.points.map(p=>({...p})):null;fx.side=e.side;
    // Preserve the relative timing of events generated on different simulation ticks
    // inside one 10 Hz snapshot instead of making the whole batch pop at once.
    fx.start=performance.now()-eventAgeMs;fx.seed=seed;
    const extraKeys=extra&&Object.keys(extra);
    if(extraKeys?.length){fx._extraKeys=extraKeys;for(const k of extraKeys)fx[k]=extra[k]}
    this.combatFx.push(fx);

    while(this.combatFx.length>220)this.combatFxPool.release(this.combatFx.shift());
  }

  

  combatImpactFxKind(sourceType){
    if(UnitDefinition.get(sourceType)?.airAttackFx)return "airImpact";
    return AttackPresentationDefinition.impactFx(sourceType)||"meleeImpact";
  }

  combatMuzzleFxKind(sourceType){
    if(UnitDefinition.get(sourceType)?.airAttackFx)return "airMuzzle";
    const d=UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType)||{};
    if(d.vfxMuzzle==="gun")return "gunMuzzle";
    const a=AttackPresentationDefinition.forSource(sourceType);
    if(a.impact==="explosive"||d.vfxHeavy)return "heavyMuzzle";
    if(a.impact==="arcane")return "magicMuzzle";
    return "bowMuzzle";
  }

  processClientCombatEffects(snapshot){
    if(!snapshot||!this.fxCtx)return;

    const roleKey=this.role==="guest"?"guest":"host";
    if(this.lastCombatFxTickByRole[roleKey]===snapshot.tick)return;
    this.lastCombatFxTickByRole[roleKey]=snapshot.tick;

    const mySide=this.mySide();
    let index=0;

    for(const e of snapshot.events||[]){
      if(e.type==="projectileRetire"){index++;continue}
      const x=Number(e.x);
      const y=Number(e.y);
      const visible=
        e.side===mySide||
        (Number.isFinite(x)&&Number.isFinite(y)&&this.visibleRaw(x,y));

      if(!visible){index++;continue}

      if(e.type==="hit"){
        const sourceType=e.sourceType||"",kind=this.combatImpactFxKind(sourceType);
        const attackVisual=AttackPresentationDefinition.forSource(sourceType),impactPreset=AttackPresentationDefinition.impactPreset(sourceType);
        if(attackVisual.travel==="none"&&attackVisual.sourceMotion&&e.sourceId){
          const source=(snapshot.units||[]).find(u=>u.id===e.sourceId&&u.alive);
          if(source)this.addClientFx("meleeSourceMotion",{...e,x:source.x,y:source.y,x2:e.x,y2:e.y},snapshot,index,{motion:attackVisual.sourceMotion});
          this.attackPresentationUntil.set(e.sourceId,performance.now()+220);
        }
        if(!e.suppressImpactFx)this.addClientFx(kind,e,snapshot,index,{impactScale:impactPreset.scale});

        // Sunvine is a continuous beam: keep the normal hit VFX/damage-number event,
        // but never stack camera shake from its frequent damage pulses.
        const suppressHitShake=!!BuildingDefinition.get(e.sourceType)?.suppressHitShake;
        if(kind==="heavyImpact"&&!suppressHitShake){
          this.triggerClientShake(5.5,230,HashUtil.hash(`${snapshot.tick}|heavy|${index}`));
        }else if(e.side===mySide&&!suppressHitShake){
          this.triggerClientShake(1.5,90,HashUtil.hash(`${snapshot.tick}|hurt|${index}`));
        }
      }else if(e.type==="shoot"||e.type==="towerShot"){
        const kind=this.combatMuzzleFxKind(e.unit||e.sourceType||"");
        this.addClientFx(kind,e,snapshot,index);
        if(e.sourceId)this.attackPresentationUntil.set(e.sourceId,performance.now()+180);
      }else if(e.type==="balsamRocketImpact"){
        this.addClientFx("balsamImpact",e,snapshot,index,{burstShot:e.burstShot||1,burstCount:e.burstCount||4});
      }else if(e.type==="meteorImpact"){
        this.addClientFx("meteorImpact",e,snapshot,index);
        this.triggerClientShake(9,480,HashUtil.hash(`${snapshot.tick}|meteor|${index}`));
      }else if(e.type==="spellCast"&&e.spell==="tunnel"){
        this.addClientFx("tunnelOpen",e,snapshot,index);
        if(Number.isFinite(e.x2)&&Number.isFinite(e.y2)){
          this.addClientFx("tunnelOpen",{...e,x:e.x2,y:e.y2},snapshot,index+1000);
        }
      }else if(e.type==="tunnelTransit"){
        this.addClientFx("tunnelTransit",e,snapshot,index);
      }else if(e.type==="rogueBlink"){
        this.addClientFx("blinkBurst",e,snapshot,index);
      }else if(e.type==="rogueLeapStart"){
        this.addClientFx("rogueLeapStart",e,snapshot,index);
      }else if(e.type==="rogueLeapLand"){
        this.addClientFx("rogueLeapLand",e,snapshot,index);
        this.triggerClientShake(1.8,110,HashUtil.hash(`${snapshot.tick}|rogue-land|${index}`));
      }else if(e.type==="healLink"){
        this.addClientFx("linkedBeam",e,snapshot,index);
      }else if(e.type==="chargeImpact"){
        this.addClientFx("chargeBurst",e,snapshot,index);
        this.triggerClientShake(2.8,150,HashUtil.hash(`${snapshot.tick}|charge|${index}`));
      }else if(e.type==="chargedSkillRelease"){
        this.addClientFx("chargedSkillLaunch",e,snapshot,index);
      }else if(e.type==="pillbugBurst"){
        this.addClientFx("pillbugBurst",e,snapshot,index);
        this.triggerClientShake(6.5,260,HashUtil.hash(`${snapshot.tick}|pillbug|${index}`));
      }else if(e.type==="rootSpike"){
        this.addClientFx("rootSpike",e,snapshot,index);
      }else if(e.type==="deepThornCast"){
        this.addClientFx("deepThornCast",e,snapshot,index);
      }else if(e.type==="deepThornSpike"){
        this.addClientFx("deepThornSpike",e,snapshot,index);
        this.triggerClientShake(6.2,280,HashUtil.hash(`${snapshot.tick}|deepthorn|${index}`));
      }else if(e.type==="airborne"){
        this.addClientFx("airborneBurst",e,snapshot,index);
      }else if(e.type==="chainArc"){
        this.addClientFx("chainArc",e,snapshot,index,{aegisArc:!!e.aegisArc});
      }else if(e.type==="hitGuardBreak"){
        this.addClientFx("hitGuardBreak",e,snapshot,index);
      }else if(e.type==="guardPulse"||e.type==="guardCharge"){
        this.addClientFx("guardPulse",e,snapshot,index);
      }else if(e.type==="attackCooldownReset"){
        if(e.sourceId){
          const now=performance.now();
          this.attackPresentationUntil.set(e.sourceId,now+220);
          this.bodyPulsePresentation.trigger(e.sourceId,"hunterWaspRapidSting",now);
          this.addClientFx("hunterWaspCooldownReset",e,snapshot,index);
        }
      }else if(e.type==="guardRetaliation"){
        // Retaliation must read from the mushroom itself, not only from the projectile.
        this.addClientFx("guardRetaliationBurst",e,snapshot,index);
        if(e.sourceId){
          const now=performance.now();
          this.attackPresentationUntil.set(e.sourceId,now+320);
          this.bodyPulsePresentation.trigger(e.sourceId,"guardshroomRetaliation",now);
        }
      }else if(e.type==="guardRetaliationImpact"){
        this.addClientFx("guardRetaliationImpact",e,snapshot,index);
      }else if(e.type==="sporeSpawn"){
        this.addClientFx("sporeSpawn",e,snapshot,index);
      }else if(e.type==="clawHookLaunch"){
        this.addClientFx("arcTether",e,snapshot,index);
      }else if(e.type==="clawPull"){
        this.addClientFx("clawPullImpact",e,snapshot,index);
      }else if(e.type==="thornReflect"){
        this.addClientFx("thornReflect",e,snapshot,index);
      }else if(e.type==="thornBurst"){
        this.addClientFx("thornBurst",e,snapshot,index);
        this.triggerClientShake(2.8,150,HashUtil.hash(`${snapshot.tick}|thorn-burst|${index}`));
      }else if(e.type==="kickhopperSplash"){
        this.addClientFx("kickhopperSplash",e,snapshot,index);
        this.triggerClientShake(2.2,120,HashUtil.hash(`${snapshot.tick}|kickhopper|${index}`));
      }else if(e.type==="chainOverload"||e.type==="deepThornSecondary"||e.type==="impactShockwave"||e.type==="pullImpact"||e.type==="allySpeedBurst"){
        this.addClientFx(e.type,e,snapshot,index);
      }else if(e.type==="objectiveBearShockwave"){
        this.addClientFx("titanSlam",e,snapshot,index);
        this.triggerClientShake(4.6,210,HashUtil.hash(`${snapshot.tick}|objective-bear-shock|${index}`));
      }else if(e.type==="objectiveBearChargeStart"){
        this.addClientFx("chargeBurst",e,snapshot,index);
      }else if(e.type==="objectiveBearChargeTrail"){
        this.addClientFx("objectiveBearChargeTrail",e,snapshot,index);
      }else if(e.type==="objectiveBearChargeEnd"){
        this.addClientFx("titanSlam",e,snapshot,index);
        this.triggerClientShake(5.4,240,HashUtil.hash(`${snapshot.tick}|objective-bear-charge|${index}`));
      }else if(e.type==="objectiveDragonBreathTell"){
        this.addClientFx("dragonMuzzle",e,snapshot,index);
      }else if(e.type==="objectiveDragonFireball"){
        this.addClientFx("dragonMuzzle",e,snapshot,index);
      }else if(e.type==="attackVariantBreath"){
        this.attackVariantBreathFx.push({
          id:`${e.sourceId||"unit"}:${e.tick||this.snapshot?.tick||0}:${this.attackVariantBreathFx.length}`,
          sourceId:e.sourceId,sourceType:e.sourceType,x:e.x,y:e.y,
          dirX:e.dirX,dirY:e.dirY,range:e.range,angleDeg:e.angleDeg,
          preset:e.vfxPreset||"fireAntBreath",start:performance.now(),
          duration:Math.max(100,Number(e.durationMs)||SimulationTiming.ticksToMs(e.durationTicks||(this.snapshot?.tps||SIM_TPS),this.snapshot?.tps||SIM_TPS))
        });
      }else if(e.type==="objectiveCaptured"){
        this.addClientFx("objectiveCaptured",e,snapshot,index,{dirX:Number(e.dirX)||0,dirY:Number(e.dirY)||0});
        this.triggerClientShake(3.2,170,HashUtil.hash(`${snapshot.tick}|objective-captured|${index}`));
      }else if(e.type==="objectiveRespawned"){
        this.addClientFx("objectiveRespawned",e,snapshot,index);
        this.triggerClientShake(UnitVisualDefinition.get(e.sourceType)?.objectiveFxStyle==="dragon"?2.4:3.8,190,HashUtil.hash(`${snapshot.tick}|objective-respawn|${index}`));
      }else if(e.type==="titanSlam"){
        this.addClientFx("titanSlam",e,snapshot,index);
        this.triggerClientShake(7.5,300,HashUtil.hash(`${snapshot.tick}|titan|${index}`));
      }else if(e.type==="interceptLock"){
        this.addClientFx("electricLink",e,snapshot,index);
      }else if(e.type==="projectileIntercept"){
        this.addClientFx("projectileIntercept",e,snapshot,index);
      }else if(e.type==="burrowDive"){
        this.addClientFx("burrowDive",e,snapshot,index);
      }else if(e.type==="burrowTravel"||e.type==="burrowTrail"){
        this.addClientFx("burrowTrail",e,snapshot,index);
      }else if(e.type==="burrowEmerge"){
        this.addClientFx("burrowEmerge",e,snapshot,index);
        this.triggerClientShake(6.5,280,HashUtil.hash(`${snapshot.tick}|burrow-emerge|${index}`));
      }else if(e.type==="burrowMelee"){
        this.addClientFx("burrowMelee",e,snapshot,index);
      }else if(e.type==="ambush"){
        this.addClientFx("ambushBurst",e,snapshot,index);
      }else if(e.type==="knockback"){
        this.addClientFx("knockbackBurst",e,snapshot,index);
      }else if(e.type==="death"){
        this.addClientFx("deathBurst",e,snapshot,index);
      }else if(e.type==="buildingDeath"){
        this.addClientFx("buildingBurst",e,snapshot,index);
        this.triggerClientShake(3.5,180,HashUtil.hash(`${snapshot.tick}|building|${index}`));
      }else if(e.type==="swarmCarcassConsume"){
        // Presentation-only reuse of the same arc-travel primitive as artillery.
        // The consumer declares endpoints/height/preset; it never owns trajectory math.
        this.addClientFx("arcTravelFx",e,snapshot,index,{
          fromX:Number(e.x),fromY:Number(e.y),toX:Number(e.targetX),toY:Number(e.targetY),
          arcHeight:50,preset:"swarmCarcassEnergy",durationMs:600
        });
      }else if(e.type==="heal"){
        this.addClientFx("healBurst",e,snapshot,index);
      }else if(e.type==="neutralRecover"){
        this.addClientFx("healBurst",e,snapshot,index);
      }else if(e.type==="rootBind"){
        this.addClientFx("rootBindBurst",e,snapshot,index);
      }else if(e.type==="recall"){
        this.addClientFx("recallBurst",e,snapshot,index);
      }else if(e.type==="sporeFade"){
        this.addClientFx("sporeFadeBurst",e,snapshot,index);
      }else if(e.type==="projectileLostLock"){
        this.addClientFx("lostLockBurst",e,snapshot,index);
      }

      index++;
    }
  }

  processFloatingEvents(snapshot){
    if(!snapshot||!this.fxCtx)return;
    const roleKey=this.role==="guest"?"guest":"host";
    if(this.lastFloatTickByRole[roleKey]===snapshot.tick)return;
    this.lastFloatTickByRole[roleKey]=snapshot.tick;

    const side=this.mySide();
    const now=performance.now();
    let index=0;

    for(const e of snapshot.events||[]){
      let kind=null,text="",amount=0;

      if(e.type==="hit"&&e.amount>0){
        // 적/중립 피해 숫자는 실제 시야가 있을 때만 보여 Fog 정보를 새지 않게 한다.
        if(e.side!==side&&!this.visibleRaw(e.x,e.y)){index++;continue}
        kind=e.side===side?"damageTaken":"damageDealt";
        amount=e.amount;
        text=`-${e.amount}`;
      }else if(e.type==="heal"&&e.amount>0&&e.side===side){
        kind="heal";amount=e.amount;text=`+${e.amount}`;
      }else if(e.type==="swarmCarcassConsume"&&e.amount>0&&e.side===side){
        kind="heal";amount=e.amount;text=`+${e.amount}`;e.x=Number(e.targetX);e.y=Number(e.targetY);
      }else if(e.type==="income"&&e.amount>0&&e.side===side){
        kind=e.resourceType==="gas"?"gasIncome":"income";
        amount=e.amount;
        text=e.resourceType==="gas"?`+${e.amount} ⬡`:`+${e.amount} ◆`;
      }else if(e.type==="campClear"&&e.bonus>0&&e.side===side){
        kind="income";amount=e.bonus;text=`+${e.bonus} ◆`;
      }else if(e.type==="buildCancelled"&&e.refund>0&&e.side===side){
        kind="income";amount=e.refund;text=`+${e.refund} ◆`;
      }else if(e.type==="interceptLock"&&e.side===side&&e.manaCost>0){
        kind="manaSpend";amount=e.manaCost;text=`-${e.manaCost} MP`;
      }else if(e.type==="dodge"||e.type==="graze"){
        if(e.side!==side&&!this.visibleRaw(e.x,e.y)){index++;continue}
        kind="dodge";
        text=e.type==="dodge"?"MISS":"빗맞음";
      }

      if(!kind){index++;continue}

      // 일꾼 반납처럼 같은 지점의 돈 숫자는 짧은 시간 동안 합쳐 가독성을 확보.
      if(kind==="income"||kind==="gasIncome"||kind==="manaSpend"){
        const existing=[...this.floatFx].reverse().find(f=>
          f.kind===kind&&now-f.start<160&&Math.hypot(f.x-e.x,f.y-e.y)<65
        );
        if(existing){
          existing.amount+=amount;
          existing.text=kind==="gasIncome"
            ?`+${existing.amount} ⬡`
            :kind==="manaSpend"
              ?`-${existing.amount} MP`
              :`+${existing.amount} ◆`;
          existing.start=now;
          index++;
          continue;
        }
      }

      const eventTick=Number.isFinite(Number(e.presentationTick))?Number(e.presentationTick):snapshot.tick;
      const seed=HashUtil.hash(`${eventTick}|${index}|${kind}|${Math.round(e.x)}|${Math.round(e.y)}|${amount}`);
      const eventAgeMs=Math.max(0,Math.min(250,(snapshot.tick-eventTick)*(1000/(snapshot.tps||SIM_TPS))));
      const f=this.floatFxPool.acquire();
      f.x=e.x;f.y=e.y;f.kind=kind;f.text=text;f.amount=amount;f.start=now-eventAgeMs;
      f.jitter=((seed%1000)/1000-.5)*34;f.lane=(seed>>>10)%4;
      this.floatFx.push(f);
      index++;
    }

    // 화면을 숫자로 도배하지 않되, 최근 실제 타격 수치는 충분히 남긴다.
    while(this.floatFx.length>72)this.floatFxPool.release(this.floatFx.shift());
  }

  drawStrategicLabels(){
    const ctx=this.fxCtx;
    if(!ctx||!this.snapshot)return;
    const sc=this.sc(),side=this.mySide();
    ctx.save();
    ctx.textAlign="center";ctx.textBaseline="middle";
    for(const cp of this.snapshot.capturePoints||[]){
      const[x,y]=this.worldToPx(this.viewX(cp.x),this.viewY(cp.y));
      if(x<-80||x>this.fxCanvas.width+80||y<-80||y>this.fxCanvas.height+80)continue;
      const owner=cp.owner===side?"아군 거점":cp.owner==null?(cp.enabled?"점령 가능":"오브젝트 잠금"):"적 거점";
      ctx.font=`900 ${Math.max(9,11*sc)}px system-ui,sans-serif`;
      ctx.lineWidth=Math.max(2,3*sc);ctx.strokeStyle="rgba(0,0,0,.60)";
      const text=`${cp.label||cp.lane} · ${owner}`;
      ctx.strokeText(text,x,y-52*sc);ctx.fillStyle="#fff";ctx.fillText(text,x,y-52*sc);
      ctx.font=`800 ${Math.max(7,8*sc)}px system-ui,sans-serif`;
      const guide=cp.owner===side
        ? "시야 · 자원 귀환 · 방어 건설권"
        : cp.owner==null&&cp.enabled
          ? "아군 전투 유닛만 유지하면 점령"
          : cp.owner==null
            ? "연결 전술 오브젝트 처치 필요"
            : "파괴 시 다시 점령 가능";
      ctx.strokeText(guide,x,y-39*sc);ctx.fillStyle=cp.owner===side?"#cfe6ff":"#fff3b0";ctx.fillText(guide,x,y-39*sc);
      if(cp.owner==null&&cp.enabled&&cp.progress>0){
        const pct=Math.floor(cp.progress/SimulationTiming.msToTicks(CAPTURE_DURATION_MS,this.snapshot?.tps||SIM_TPS)*100);
        ctx.font=`800 ${Math.max(8,9*sc)}px system-ui,sans-serif`;
        ctx.strokeText(`${pct}%`,x,y-27*sc);ctx.fillText(`${pct}%`,x,y-27*sc);
      }
    }
    ctx.restore();
  }

  drawProductionBuildingEmblems(){
    const ctx=this.fxCtx;
    if(!ctx||!this.fxCanvas||!this.snapshot)return;

    const side=this.mySide(),sc=this.sc();

    for(const b of this.snapshot.buildings){
      if(b.alive===false||!BuildingDefinition.get(b.type)?.isProductionBuilding||!b.produceType)continue;

      const own=b.side===side;
      if(!own&&!this.visibleRaw(b.x,b.y))continue;

      const info=UnitDefinition.cardInfo[b.produceType]||{icon:"?",desc:""};

      const[x,y]=this.worldToPx(this.viewX(b.x),this.viewY(b.y));
      const d=BuildingDefinition.get(b.type);
      const bodyR=d.size*sc;

      // 건물 지붕 한가운데 붙은 병종 엠블럼.
      // 건설 중에도 보이되 살짝 흐리게 해서 어떤 전용 배럭을 짓는지 알 수 있다.
      const badgeR=Math.max(13,Math.min(24,bodyR*.48));
      const alpha=b.complete?1:.62;

      if(x<-badgeR*2||x>this.fxCanvas.width+badgeR*2||
         y<-badgeR*2||y>this.fxCanvas.height+badgeR*2)continue;

      ctx.save();
      ctx.globalAlpha=alpha;

      // 그림자
      ctx.beginPath();
      ctx.arc(x+1.5*sc,y+1.8*sc,badgeR+2,0,Math.PI*2);
      ctx.fillStyle="rgba(0,0,0,.28)";
      ctx.fill();

      // 팀 컬러 배지
      ctx.beginPath();
      ctx.arc(x,y,badgeR,0,Math.PI*2);
      ctx.fillStyle=own?"rgba(232,241,255,.96)":"rgba(255,232,232,.96)";
      ctx.fill();
      ctx.lineWidth=Math.max(2,2.6*sc);
      ctx.strokeStyle=own?"rgba(52,105,214,.98)":"rgba(205,65,70,.98)";
      ctx.stroke();

      // 내부 얇은 링
      ctx.beginPath();
      ctx.arc(x,y,badgeR*.76,0,Math.PI*2);
      ctx.lineWidth=Math.max(1,1.4*sc);
      ctx.strokeStyle=own?"rgba(105,145,225,.42)":"rgba(220,105,110,.42)";
      ctx.stroke();

      // 드래프트 카드와 완전히 같은 아이콘.
      const fontSize=Math.max(16,Math.min(29,badgeR*1.28));
      ctx.font=`900 ${fontSize}px system-ui,-apple-system,"Segoe UI Symbol","Segoe UI",sans-serif`;
      ctx.textAlign="center";
      ctx.textBaseline="middle";
      ctx.lineJoin="round";
      ctx.lineWidth=Math.max(1.5,2*sc);
      ctx.strokeStyle=own?"rgba(255,255,255,.98)":"rgba(255,255,255,.98)";
      ctx.strokeText(info.icon,x,y+.5*sc);
      ctx.fillStyle=own?"#2450a8":"#a62b31";
      ctx.fillText(info.icon,x,y+.5*sc);

      // 선택된 생산건물은 아이콘 바깥 링도 강하게 표시.
      if(this.selectedBuildingId===b.id){
        ctx.beginPath();
        ctx.arc(x,y,badgeR+5*sc,0,Math.PI*2);
        ctx.lineWidth=Math.max(2,3*sc);
        ctx.strokeStyle="#ffd75f";
        ctx.stroke();
      }

      ctx.restore();
    }
  }

  aegisShellNodeScreen(source,targetX,targetY){
    const sp=this.renderTrackedScreenPosition(source,"unit"),r=this.unitRenderRadius(source);
    const nodes=[[-.43,-.30],[.43,-.30],[-.40,.30],[.40,.30]];
    let best={x:sp.x,y:sp.y},bestDot=-Infinity;
    const dx=targetX-sp.x,dy=targetY-sp.y,len=Math.hypot(dx,dy)||1,nx=dx/len,ny=dy/len;
    for(const [ox,oy] of nodes){const dot=ox*nx+oy*ny;if(dot>bestDot){bestDot=dot;best={x:sp.x+ox*r,y:sp.y+oy*r}}}
    return best;
  }
  drawClientCombatFx(){
    const ctx=this.fxCtx;
    if(!ctx||!this.fxCanvas)return;

    const now=performance.now();
    let write=0;
    const sc=this.sc();

    const dot=(x,y,r,fill,alpha=1)=>{
      ctx.globalAlpha=alpha;
      ctx.beginPath();
      ctx.arc(x,y,Math.max(.8,r),0,Math.PI*2);
      ctx.fillStyle=fill;
      ctx.fill();
    };

    const ring=(x,y,r,width,stroke,alpha=1)=>{
      ctx.globalAlpha=alpha;
      ctx.beginPath();
      ctx.arc(x,y,Math.max(1,r),0,Math.PI*2);
      ctx.lineWidth=Math.max(1,width);
      ctx.strokeStyle=stroke;
      ctx.stroke();
    };

    const resolveFxEntityScreen=(id)=>{
      if(!id||!this.snapshot)return null;
      const u=(this.snapshot.units||[]).find(v=>v.id===id&&v.alive!==false);
      if(u){
        const p=this.projectEntityScreen(u,"unit");
        return[p.x,p.y];
      }
      const b=(this.snapshot.buildings||[]).find(v=>v.id===id&&v.alive!==false);
      if(b)return this.worldToPx(this.viewX(b.x),this.viewY(b.y));
      return null;
    };

    const fxDirection=(fx,x,y,mode="target")=>{
      let p=null;
      if(mode==="target")p=resolveFxEntityScreen(fx.targetId);
      else p=resolveFxEntityScreen(fx.sourceId);
      if(!p&&mode==="target"&&Number.isFinite(fx.x2)&&Number.isFinite(fx.y2)&&(fx.x2||fx.y2)){
        p=this.worldToPx(this.viewX(fx.x2),this.viewY(fx.y2));
      }
      if(!p&&mode==="source"&&fx.fromX!=null&&fx.fromY!=null){
        p=this.worldToPx(this.viewX(fx.fromX),this.viewY(fx.fromY));
      }
      if(!p)return null;
      let dx=mode==="source"?x-p[0]:p[0]-x;
      let dy=mode==="source"?y-p[1]:p[1]-y;
      const len=Math.hypot(dx,dy);
      if(len<.001)return null;
      return {x:dx/len,y:dy/len};
    };

    const burst=(fx,x,y,t,count,color,speed=52,size=3,flatten=.72,seedOverride=null)=>{
      const seed=seedOverride==null?fx.seed:seedOverride;
      for(let i=0;i<count;i++){
        const h=HashUtil.hash(`${seed}|p|${i}`);
        const a=(h%4096)/4096*Math.PI*2;
        const k=.62+((h>>>12)%1000)/1500;
        const d=(8+speed*t*k)*sc;
        const rr=(size+((h>>>22)%3))*(1-t*.55)*Math.max(.55,sc);
        dot(
          x+Math.cos(a)*d,
          y+Math.sin(a)*d*flatten,
          rr,
          color,
          Math.max(0,1-t)
        );
      }
    };

    for(let read=0;read<this.combatFx.length;read++){
      const fx=this.combatFx[read];
      const age=now-fx.start;
      const life=
        fx.kind==="meteorImpact"?820:
        fx.kind==="tunnelOpen"?720:
        fx.kind==="buildingBurst"?620:
        fx.kind==="deathBurst"?480:
        fx.kind==="pillbugBurst"?540:
        fx.kind==="rootSpike"?Math.max(560,Number(fx.travelMs)||0):
        fx.kind==="deepThornCast"?620:
        fx.kind==="deepThornSpike"?760:
        fx.kind==="airborneBurst"?300:
        fx.kind==="chainArc"?(fx.aegisArc?340:300):
        fx.kind==="hitGuardBreak"?360:
        fx.kind==="guardPulse"?280:
        fx.kind==="guardRetaliationBurst"?320:
        fx.kind==="hunterWaspCooldownReset"?260:
        fx.kind==="guardRetaliationImpact"?420:
        fx.kind==="sporeSpawn"?360:
        fx.kind==="arcTether"?Math.max(650,(fx.travelMs||300)+(fx.pullTicks?SimulationTiming.ticksToMs(fx.pullTicks,this.snapshot?.tps||SIM_TPS):250)+(fx.retractMs||220)+80):
        fx.kind==="clawPullImpact"?260:
        fx.kind==="thornReflect"?360:
        fx.kind==="thornBurst"?700:
        fx.kind==="kickhopperSplash"?360:
        fx.kind==="titanSlam"?520:
        fx.kind==="electricLink"?Math.max(220,(fx.durationTicks?SimulationTiming.ticksToMs(fx.durationTicks,this.snapshot?.tps||SIM_TPS):300)):
        fx.kind==="chainOverload"||fx.kind==="deepThornSecondary"||fx.kind==="impactShockwave"||fx.kind==="pullImpact"||fx.kind==="allySpeedBurst"?420:
        fx.kind==="projectileIntercept"?260:
        fx.kind==="burrowDive"?420:
        fx.kind==="burrowTrail"?300:
        fx.kind==="objectiveBearChargeTrail"?260:
        fx.kind==="chargedSkillLaunch"?420:
        fx.kind==="objectiveCaptured"?720:
        fx.kind==="objectiveRespawned"?760:
        fx.kind==="burrowEmerge"?720:
        fx.kind==="burrowMelee"?360:
        fx.kind==="rootBindBurst"?620:
        fx.kind==="recallBurst"?720:
        fx.kind==="sporeFadeBurst"?420:
        fx.kind==="arcTravelFx"?Math.max(120,Number(fx.durationMs)||520):
        fx.kind==="lostLockBurst"?300:
        fx.kind==="airMuzzle"?300:
        fx.kind==="meleeSourceMotion"?(AttackPresentationDefinition.sourceMotions[fx.motion]?.lifeMs||220):
        fx.kind==="airImpact"?420:
        fx.kind==="carrierLaunch"?520:
        fx.kind.endsWith("Muzzle")?260:
        fx.kind==="healBurst"?500:
        fx.kind==="linkedBeam"?Math.max(300,(fx.durationTicks?SimulationTiming.ticksToMs(fx.durationTicks,this.snapshot?.tps||SIM_TPS):900)):
        fx.kind==="rogueLeapStart"?360:
        fx.kind==="rogueLeapLand"?420:
        fx.kind==="blinkBurst"?420:
        fx.kind==="chargeBurst"?460:
        fx.kind==="ambushBurst"?430:
        fx.kind==="knockbackBurst"?300:
        360;

      if(age>=life){this.combatFxPool.release(fx);continue}
      const t=age/life;
      const ease=1-Math.pow(1-t,3);
      let[x,y]=this.worldToPx(this.viewX(fx.x),this.viewY(fx.y));

      if(x<-160||x>this.fxCanvas.width+160||y<-160||y>this.fxCanvas.height+160){
        this.combatFx[write++]=fx;
        continue;
      }

      ctx.save();
      ctx.lineCap="round";
      ctx.lineJoin="round";

      if(fx.kind==="airMuzzle"){
        const src=resolveFxEntityScreen(fx.sourceId),mx=src?.[0]??x,my=src?.[1]??y;
        const dir=fxDirection(fx,mx,my,"target")||{x:1,y:0},nx=dir.x,ny=dir.y,sx=-ny,sy=nx;
        if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="flutter"){
          ctx.globalAlpha=.88*(1-t);ctx.strokeStyle="#ffd55d";ctx.lineWidth=Math.max(1.4,2.3*sc);ctx.beginPath();ctx.moveTo(mx+nx*3*sc,my+ny*3*sc);ctx.lineTo(mx+nx*(18+8*ease)*sc,my+ny*(18+8*ease)*sc);ctx.stroke();
          for(let k=-1;k<=1;k++)dot(mx+nx*(8+6*ease)*sc+sx*k*4*sc,my+ny*(8+6*ease)*sc+sy*k*4*sc,Math.max(1.2,2*sc),"#fff0a0",.62*(1-t));
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="swarm"){
          ring(mx,my,(3+12*ease)*sc,1.5*sc,"#b8e76a",.42*(1-t));burst(fx,mx,my,t,5,"#d6f38b",18,1.5,.72);
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="glide"){
          for(let k=-1;k<=1;k++){const off=k*3.5*sc;ctx.globalAlpha=.62*(1-t);ctx.strokeStyle="#9defff";ctx.lineWidth=Math.max(1,1.5*sc);ctx.beginPath();ctx.moveTo(mx-nx*8*sc+sx*off,my-ny*8*sc+sy*off);ctx.lineTo(mx+nx*(20+14*ease)*sc+sx*off,my+ny*(20+14*ease)*sc+sy*off);ctx.stroke()}
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="moth"){
          dot(mx,my,(5+5*(1-t))*sc,"#fff7ad",.92*(1-t));ring(mx,my,(7+18*ease)*sc,2*sc,"#ffd85a",.44*(1-t));
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="heavy-moth"){
          const dropY=my+(8+16*ease)*sc;ctx.globalAlpha=.55*(1-t);ctx.strokeStyle="#b47ad1";ctx.lineWidth=Math.max(1.2,2*sc);ctx.beginPath();ctx.moveTo(mx,my+2*sc);ctx.lineTo(mx,dropY);ctx.stroke();dot(mx,dropY,(4+3*(1-t))*sc,"#c99be4",.88*(1-t));
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="wasp"){
          ctx.globalAlpha=.92*(1-t);ctx.strokeStyle="#ff9f2e";ctx.lineWidth=Math.max(1.6,2.7*sc);ctx.beginPath();ctx.moveTo(mx,my);ctx.lineTo(mx+nx*(24+12*ease)*sc,my+ny*(24+12*ease)*sc);ctx.stroke();dot(mx+nx*(24+12*ease)*sc,my+ny*(24+12*ease)*sc,2.2*sc,"#fff0ac",.90*(1-t));
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="sail"){
          for(let k=-1;k<=1;k++){ctx.globalAlpha=.34*(1-t);ctx.strokeStyle="#83efd1";ctx.lineWidth=Math.max(1,1.5*sc);ctx.beginPath();ctx.arc(mx-sx*k*5*sc,my-sy*k*5*sc,(10+10*ease+Math.abs(k)*4)*sc,Math.atan2(ny,nx)-.7,Math.atan2(ny,nx)+.7);ctx.stroke()}
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="ray"){
          for(let k=0;k<3;k++){const off=(k-1)*5*sc;ctx.globalAlpha=(.26+.12*k)*(1-t);ctx.strokeStyle="#c2eff7";ctx.lineWidth=Math.max(1.2,2*sc);ctx.beginPath();ctx.moveTo(mx+sx*off,my+sy*off);ctx.quadraticCurveTo(mx+nx*12*sc+sx*(off+5*sc),my+ny*12*sc+sy*(off+5*sc),mx+nx*(30+8*ease)*sc+sx*off,my+ny*(30+8*ease)*sc+sy*off);ctx.stroke()}
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="drone"){
          ctx.globalAlpha=.82*(1-t);ctx.strokeStyle="#f6d36e";ctx.lineWidth=Math.max(1,1.6*sc);ctx.beginPath();ctx.moveTo(mx,my);ctx.lineTo(mx+nx*(14+6*ease)*sc,my+ny*(14+6*ease)*sc);ctx.stroke();
        }
      }else if(fx.kind==="airImpact"){
        if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="flutter"){
          dot(x,y,(4+3*(1-t))*sc,"#fff2a0",.9*(1-t));burst(fx,x,y,t,4,"#e9bd42",22,1.6,.65);
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="swarm"){
          ring(x,y,(3+17*ease)*sc,1.7*sc,"#a9d85c",.42*(1-t));burst(fx,x,y,t,7,"#c9ea75",28,2,.80);
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="glide"){
          for(let k=-1;k<=1;k++){const a=(fx.seed%6283)/1000+k*.72,len=(7+24*ease)*sc;ctx.globalAlpha=.68*(1-t);ctx.strokeStyle="#9befff";ctx.lineWidth=Math.max(1,1.7*sc);ctx.beginPath();ctx.moveTo(x-Math.cos(a)*len*.45,y-Math.sin(a)*len*.45);ctx.lineTo(x+Math.cos(a)*len,y+Math.sin(a)*len);ctx.stroke()}
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="moth"){
          dot(x,y,(6+5*(1-t))*sc,"#fffbd0",.95*(1-t));ring(x,y,(6+28*ease)*sc,2.2*sc,"#ffd95b",.55*(1-t));
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="heavy-moth"){
          const rr=(12+44*ease)*sc;ring(x,y,rr,3*sc,"#a96bc8",.62*(1-t));ring(x,y,rr*.64,1.8*sc,"#a8d85c",.38*(1-t));burst(fx,x,y,t,12,"#c795df",52,3,.78);burst(fx,x,y,t,7,"#b9dc70",38,2.2,.82,fx.seed^0x6611);
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="wasp"){
          const dir=fxDirection(fx,x,y,"source")||{x:-1,y:0};ctx.globalAlpha=.9*(1-t);ctx.strokeStyle="#ff922a";ctx.lineWidth=Math.max(1.3,2.4*sc);ctx.beginPath();ctx.moveTo(x-dir.x*6*sc,y-dir.y*6*sc);ctx.lineTo(x+dir.x*(16+8*ease)*sc,y+dir.y*(16+8*ease)*sc);ctx.stroke();dot(x,y,3.4*sc,"#ffe19b",.84*(1-t));
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="sail"){
          ring(x,y,(5+24*ease)*sc,2*sc,"#78ddc5",.40*(1-t));for(let k=0;k<3;k++){const a=(fx.seed%97)*.07+k*2.1;ctx.globalAlpha=.28*(1-t);ctx.strokeStyle="#a5f1df";ctx.lineWidth=Math.max(1,1.4*sc);ctx.beginPath();ctx.arc(x,y,(9+18*ease+k*5)*sc,a,a+1.1);ctx.stroke()}
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="ray"){
          ring(x,y,(6+30*ease)*sc,2*sc,"#aee3ef",.38*(1-t));burst(fx,x,y,t,7,"#d5f2f7",34,2.2,.88);
        }else if(UnitDefinition.get(fx.sourceType)?.airVisualMotion==="drone"){
          dot(x,y,3*sc,"#ffe17a",.84*(1-t));burst(fx,x,y,t,3,"#e8bd52",18,1.3,.60);
        }else{
          ring(x,y,(5+20*ease)*sc,1.8*sc,"#cdeef5",.35*(1-t));
        }
      }else if(fx.kind==="carrierLaunch"){
        const a=resolveFxEntityScreen(fx.sourceId)||this.worldToPx(this.viewX(fx.x),this.viewY(fx.y));
        const b=resolveFxEntityScreen(fx.targetId)||this.worldToPx(this.viewX(fx.x2),this.viewY(fx.y2));
        const q=RangeUtil.clamp(ease,0,1),px=a[0]+(b[0]-a[0])*q,py=a[1]+(b[1]-a[1])*q;
        ctx.globalAlpha=.36*(1-t);ctx.strokeStyle="#d9bd63";ctx.lineWidth=Math.max(1.1,1.8*sc);ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(px,py);ctx.stroke();dot(px,py,(3.5+2*(1-t))*sc,"#ffe794",.88*(1-t));ring(b[0],b[1],(4+15*ease)*sc,1.8*sc,"#dfc76f",.36*(1-t));
      }else if(fx.kind==="meleeSourceMotion"){
        const motion=fx.motion||"smash";
        const src=resolveFxEntityScreen(fx.sourceId);
        const sx0=src?.[0]??x,sy0=src?.[1]??y;
        let tx=sx0+1,ty=sy0;
        if(Number.isFinite(fx.x2)&&Number.isFinite(fx.y2)){const tp=this.worldToPx(this.viewX(fx.x2),this.viewY(fx.y2));tx=tp[0];ty=tp[1]}
        let dx=tx-sx0,dy=ty-sy0,dl=Math.hypot(dx,dy)||1;dx/=dl;dy/=dl;
        // Source Motion belongs to the attacker, not the contact point. Keep the
        // entire gesture inside a small radius around the attacker's silhouette;
        // target-side readability is owned exclusively by Impact FX.
        const sourceEntity=(this.snapshot?.units||[]).find(u=>u.id===fx.sourceId&&u.alive);
        const sourceRadius=sourceEntity?this.unitRenderRadius(sourceEntity):12;
        const preset=AttackPresentationDefinition.sourceMotions[motion]||AttackPresentationDefinition.sourceMotions.smash;
        // unitRenderRadius is already in screen pixels, so this stays stable across target sizes.
        const effectSize=RangeUtil.clamp(sourceRadius*preset.sourceRadiusScale,preset.baseSize*sc,preset.maxSize*sc);
        const reach=effectSize,px=-dy,py=dx,fade=1-t;
        if(motion==="slash"){
          const cx=sx0+dx*reach*.28,cy=sy0+dy*reach*.28,a=Math.atan2(dy,dx),rad=reach*.72;
          ctx.globalAlpha=.88*fade;ctx.strokeStyle="#fff0a8";ctx.lineWidth=Math.max(1.6,3*sc);ctx.beginPath();ctx.arc(cx,cy,rad,a-1.12,a+.72);ctx.stroke();
          ctx.globalAlpha=.42*fade;ctx.strokeStyle="#9fe66f";ctx.lineWidth=Math.max(1,1.7*sc);ctx.beginPath();ctx.arc(cx,cy,rad*.78,a-.96,a+.60);ctx.stroke();
        }else if(motion==="thrust"){
          const ext=reach*(.55+.45*ease),ex=sx0+dx*ext,ey=sy0+dy*ext;
          ctx.globalAlpha=.92*fade;ctx.strokeStyle="#fff1a3";ctx.lineWidth=Math.max(1.5,2.8*sc);ctx.beginPath();ctx.moveTo(sx0+dx*4*sc,sy0+dy*4*sc);ctx.lineTo(ex,ey);ctx.stroke();
          ctx.globalAlpha=.48*fade;ctx.strokeStyle="#c9ef83";ctx.lineWidth=Math.max(1,1.5*sc);ctx.beginPath();ctx.moveTo(ex-px*5*sc,ey-py*5*sc);ctx.lineTo(ex+px*5*sc,ey+py*5*sc);ctx.stroke();
        }else if(motion==="claw"){
          for(const side of [-1,1]){const spread=(1-ease)*7*sc*side,cx=sx0+dx*reach*.72+px*spread,cy=sy0+dy*reach*.72+py*spread;
            ctx.globalAlpha=.84*fade;ctx.strokeStyle="#ffd57c";ctx.lineWidth=Math.max(1.4,2.5*sc);ctx.beginPath();ctx.moveTo(sx0+px*side*8*sc,sy0+py*side*8*sc);ctx.quadraticCurveTo(cx+px*side*6*sc,cy+py*side*6*sc,cx,cy);ctx.stroke()}
        }else if(motion==="bite"){
          // Readable even on tiny summons: two jaws visibly start open and snap shut
          // immediately in front of the attacker. Impact remains target-side only.
          const biteReach=reach,cx=sx0+dx*biteReach*.72,cy=sy0+dy*biteReach*.72;
          const jawOpen=(1-ease)*12*sc+2*sc;
          for(const side of [-1,1]){
            const bx=cx+px*side*jawOpen,by=cy+py*side*jawOpen;
            ctx.globalAlpha=.94*fade;ctx.strokeStyle="#e8f69a";ctx.lineWidth=Math.max(1.8,3.2*sc);
            ctx.beginPath();ctx.moveTo(sx0+dx*3*sc+px*side*8*sc,sy0+dy*3*sc+py*side*8*sc);
            ctx.quadraticCurveTo(bx-dx*5*sc,by-dy*5*sc,cx+dx*7*sc,cy+dy*7*sc);ctx.stroke();
            // Short fang marks make "bite" readable rather than another slash.
            ctx.globalAlpha=.76*fade;ctx.lineWidth=Math.max(1.2,2*sc);ctx.beginPath();
            ctx.moveTo(cx+px*side*5*sc,cy+py*side*5*sc);ctx.lineTo(cx+dx*7*sc,cy+dy*7*sc);ctx.stroke();
          }
        }else{
          // Smash is deliberately bold and local: wind-up streak -> heavy forward stroke
          // -> attacker-side semicircular shock. This is not the target impact effect.
          const smashReach=reach,ex=sx0+dx*smashReach*(.50+.50*ease),ey=sy0+dy*smashReach*(.50+.50*ease);
          const backX=sx0-dx*(7+5*(1-ease))*sc,backY=sy0-dy*(7+5*(1-ease))*sc;
          ctx.globalAlpha=.94*fade;ctx.strokeStyle="#f4dd83";ctx.lineWidth=Math.max(3,7*sc);
          ctx.beginPath();ctx.moveTo(backX,backY);ctx.lineTo(ex,ey);ctx.stroke();
          const a=Math.atan2(dy,dx),rr=(8+11*ease)*sc;
          ctx.globalAlpha=.70*fade;ctx.strokeStyle="#ffeaa0";ctx.lineWidth=Math.max(2,3.4*sc);
          ctx.beginPath();ctx.arc(ex,ey,rr,a-Math.PI*.58,a+Math.PI*.58);ctx.stroke();
          ctx.globalAlpha=.34*fade;ctx.strokeStyle="#9b7b38";ctx.lineWidth=Math.max(1.4,2.2*sc);
          ctx.beginPath();ctx.arc(ex,ey,rr*.72,a-Math.PI*.50,a+Math.PI*.50);ctx.stroke();
        }
      }else if(fx.kind==="meleeImpact"){
        const isc=Number(fx.impactScale)||1,incoming=fxDirection(fx,x,y,"source");
        dot(x,y,(7+8*(1-t))*sc*isc,"#fff7c8",Math.max(0,1-t*1.2));
        ring(x,y,(7+24*ease)*sc*isc,2.4*sc*isc,"#ffb93e",.72*(1-t));
        const baseA=incoming?Math.atan2(incoming.y,incoming.x)+Math.PI*.5:(fx.seed%360)/180*Math.PI;
        for(let i=0;i<3;i++){
          const spread=(i-1)*.30+(((HashUtil.hash(`${fx.seed}|slash|${i}`)%1000)/1000)-.5)*.18;
          const a=baseA+spread;
          const len=(15+22*ease)*sc*isc;
          ctx.globalAlpha=.9*(1-t);
          ctx.strokeStyle=i===0?"#fff7d6":"#ff9e35";
          ctx.lineWidth=Math.max(1.5,(3.2-i*.5)*sc*isc);
          ctx.beginPath();
          ctx.moveTo(x-Math.cos(a)*len*.34,y-Math.sin(a)*len*.34);
          ctx.lineTo(x+Math.cos(a)*len,y+Math.sin(a)*len);
          ctx.stroke();
        }
        burst(fx,x,y,t,5,"#ffd26a",34,2.2);
      }else if(fx.kind==="pierceImpact"){
        const isc=Number(fx.impactScale)||1,incoming=fxDirection(fx,x,y,"source");
        const a=incoming?Math.atan2(incoming.y,incoming.x):(fx.seed%360)/180*Math.PI;
        dot(x,y,6*sc*isc,"#fff9dd",1-t);
        ctx.globalAlpha=.92*(1-t);ctx.strokeStyle="#ffe78b";ctx.lineWidth=Math.max(1.4,2.5*sc*isc);
        ctx.beginPath();
        ctx.moveTo(x-Math.cos(a)*(13+8*ease)*sc*isc,y-Math.sin(a)*(13+8*ease)*sc*isc);
        ctx.lineTo(x+Math.cos(a)*(10+24*ease)*sc*isc,y+Math.sin(a)*(10+24*ease)*sc*isc);
        ctx.stroke();
        for(let i=-1;i<=1;i+=2){
          const sideA=a+i*.62;
          ctx.globalAlpha=.58*(1-t);ctx.lineWidth=Math.max(1,1.6*sc*isc);
          ctx.beginPath();ctx.moveTo(x,y);
          ctx.lineTo(x+Math.cos(sideA)*(9+14*ease)*sc*isc,y+Math.sin(sideA)*(9+14*ease)*sc*isc);ctx.stroke();
        }
      }else if(fx.kind==="bulletImpact"){
        const isc=Number(fx.impactScale)||1,incoming=fxDirection(fx,x,y,"source");
        dot(x,y,5.5*sc*isc,"#fff7d8",1-t);
        if(incoming){
          ctx.globalAlpha=.7*(1-t);ctx.strokeStyle="#ffe8a3";ctx.lineWidth=Math.max(1,1.8*sc*isc);
          ctx.beginPath();ctx.moveTo(x-incoming.x*12*sc*isc,y-incoming.y*12*sc*isc);ctx.lineTo(x+incoming.x*9*sc*isc,y+incoming.y*9*sc*isc);ctx.stroke();
        }
        burst(fx,x,y,t,7,"#f7bd50",42,1.7,.62);
        ring(x,y,(6+16*ease)*sc*isc,1.5*sc*isc,"#ffffff",.42*(1-t));
      }else if(fx.kind==="magicImpact"){
        const isc=Number(fx.impactScale)||1;
        ring(x,y,(7+34*ease)*sc*isc,3*sc*isc,"#9a72ff",.85*(1-t));
        ring(x,y,(4+20*ease)*sc*isc,2*sc*isc,"#d8c6ff",.65*(1-t));
        burst(fx,x,y,t,8,"#b99aff",48,2.4);
        dot(x,y,(8*(1-t)+2)*sc*isc,"#f4ecff",.9*(1-t));
      }else if(fx.kind==="balsamImpact"){
        // Seed capsule pops open like a balsam pod: flower-like flash, then seeds/petals scatter.
        const shot=Math.max(1,Number(fx.burstShot)||1),rot=(shot-1)*Math.PI*.31;
        ring(x,y,(5+28*ease)*sc,2.4*sc,"#ff8a4a",.70*(1-t));
        for(let k=0;k<6;k++){const a=rot+k*Math.PI/3+(fx.seed%17)*.013,rr=(7+34*ease)*sc,px=x+Math.cos(a)*rr,py=y+Math.sin(a)*rr;dot(px,py,Math.max(1.2,2.8*(1-t))*sc,k%2?"#ffd36a":"#ff7048",.78*(1-t))}
        // Four opening petals reinforce the 봉선화 identity.
        for(let k=0;k<4;k++){const a=rot+Math.PI/4+k*Math.PI/2,len=(8+22*ease)*sc;ctx.globalAlpha=.62*(1-t);ctx.strokeStyle="#ff9b62";ctx.lineWidth=Math.max(1.2,2.3*sc);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(x+Math.cos(a)*len,y+Math.sin(a)*len);ctx.stroke()}
        dot(x,y,(7*(1-t)+2)*sc,"#fff1a8",.86*(1-t));
      }else if(fx.kind==="heavyImpact"){
        const isc=Number(fx.impactScale)||1;
        ring(x,y,(10+64*ease)*sc*isc,4.5*sc*isc,"#ff8a2c",.88*(1-t));
        ring(x,y,(6+34*ease)*sc*isc,2.4*sc*isc,"#ffe3a0",.7*(1-t));
        burst(fx,x,y,t,12,"#ffb14a",78,3.2,.55);
        burst(fx,x,y,t,7,"#695748",52,4,.45);
        dot(x,y,(13*(1-t)+3)*sc*isc,"#fff3c2",Math.max(0,.95-t));
      }else if(fx.kind==="dragonMuzzle"){
        const source=(this.snapshot?.units||[]).find(u=>u.id===fx.sourceId&&u.alive&&UnitVisualDefinition.get(u.type)?.specialMouthPose);
        let mx=x,my=y,aim=null;
        if(source){const sp=this.projectEntityScreen(source,"unit"),pose=this.resolveDragonRenderPose(source,sp.x,sp.y,this.unitRenderRadius(source));mx=pose.mouth[0];my=pose.mouth[1];aim={x:pose.forwardX,y:pose.forwardY}}
        const ox=aim?.x??1,oy=aim?.y??0;dot(mx,my,(11-5*t)*sc,"#fff0a0",.92*(1-t));ring(mx,my,(6+18*ease)*sc,2.6*sc,"#ff7a20",.70*(1-t));
        ctx.globalAlpha=.76*(1-t);ctx.strokeStyle="#ffb53b";ctx.lineWidth=Math.max(2,4.5*sc);ctx.beginPath();ctx.moveTo(mx,my);ctx.lineTo(mx+ox*(18+18*ease)*sc,my+oy*(18+18*ease)*sc);ctx.stroke();burst(fx,mx,my,t,6,"#ff8d25",34,2.4,.62);
      }else if(
        fx.kind==="bowMuzzle"||
        fx.kind==="gunMuzzle"||
        fx.kind==="magicMuzzle"||
        fx.kind==="heavyMuzzle"
      ){
        const col=
          fx.kind==="magicMuzzle"?"#bb9cff":
          fx.kind==="heavyMuzzle"?"#ff8b32":
          fx.kind==="gunMuzzle"?"#ffd56a":
          "#f3e7b0";
        const aim=fxDirection(fx,x,y,"target");
        const ox=aim?aim.x:1,oy=aim?aim.y:0;
        const tipX=x+ox*(fx.kind==="heavyMuzzle"?18:11)*sc,tipY=y+oy*(fx.kind==="heavyMuzzle"?18:11)*sc;
        dot(tipX,tipY,(fx.kind==="heavyMuzzle"?11:7)*(1-t*.65)*sc,col,.9*(1-t));
        ctx.globalAlpha=.78*(1-t);ctx.strokeStyle=col;ctx.lineWidth=Math.max(1.2,(fx.kind==="heavyMuzzle"?4.4:2.4)*sc);
        ctx.beginPath();ctx.moveTo(x+ox*3*sc,y+oy*3*sc);ctx.lineTo(tipX+ox*(8+14*ease)*sc,tipY+oy*(8+14*ease)*sc);ctx.stroke();
        if(fx.kind==="heavyMuzzle"){
          ctx.globalAlpha=.34*(1-t);ctx.strokeStyle="#8d7967";ctx.lineWidth=Math.max(2,5*sc);
          ctx.beginPath();ctx.moveTo(x-ox*2*sc,y-oy*2*sc);ctx.lineTo(x-ox*(16+22*ease)*sc,y-oy*(16+22*ease)*sc);ctx.stroke();
        }
        burst(fx,tipX,tipY,t,fx.kind==="heavyMuzzle"?8:4,col,fx.kind==="heavyMuzzle"?55:28,fx.kind==="heavyMuzzle"?3:1.8,.72,fx.seed^0x7f4a);
      }else if(fx.kind==="meteorImpact"){
        const flash=Math.max(0,1-t*2.2);
        dot(x,y,(28+20*(1-t))*sc,"#fff8df",flash);
        ring(x,y,(18+145*ease)*sc,8*sc,"#ff6b25",.92*(1-t));
        ring(x,y,(10+92*ease)*sc,4*sc,"#ffd064",.72*(1-t));
        burst(fx,x,y,t,18,"#ff9c3b",130,4.5,.52);
        burst(fx,x,y,t,12,"#4e4338",92,5.5,.40);
      }else if(fx.kind==="tunnelOpen"){
        const pulse=.5+.5*Math.sin(age*.035);
dot(x,y,(22+5*pulse)*sc,"#35205a",.72*(1-t*.5));
        ring(x,y,(22+36*ease)*sc,4*sc,"#9a70f4",.85*(1-t));
        for(let i=0;i<7;i++){
          const a=i/7*Math.PI*2+age*.0045;
          const rr=(28+18*ease)*sc;
          dot(x+Math.cos(a)*rr,y+Math.sin(a)*rr*.62,3.2*sc,i%2?"#c6a8ff":"#7750d8",.8*(1-t));
        }
      }else if(fx.kind==="tunnelTransit"){
        ring(x,y,(8+30*ease)*sc,3*sc,"#b493ff",.72*(1-t));
        burst(fx,x,y,t,7,"#a27cf1",44,2.8,.6);
      }else if(fx.kind==="linkedBeam"){
        const source=(this.snapshot?.units||[]).find(u=>u.id===fx.sourceId&&u.alive);
        const target=(this.snapshot?.units||[]).find(u=>u.id===fx.targetId&&u.alive);
        const sd=source?UnitDefinition.get(source.type):null;
        const researched=source?!!this.snapshot?.abilities?.[source.side]?.[source.type]:false;
        const linkRange=sd?(researched?(sd.abilityHealRange||sd.healRange||0):(sd.healRange||0)):0;
        const stillLinked=!!source&&!!target&&Math.hypot(target.x-source.x,target.y-source.y)<=linkRange+6;
        if(stillLinked){
          const sp=this.projectEntityScreen(source,"unit");
          const tp=this.projectEntityScreen(target,"unit");
          const a=[sp.x,sp.y],b=[tp.x,tp.y];
          const pulse=.5+.5*Math.sin(age*.020+(fx.seed%31));
          ctx.globalAlpha=.24*(1-t*.45);ctx.strokeStyle="#67d98d";ctx.lineWidth=Math.max(4,6.5*sc);
          ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();
          ctx.globalAlpha=.88*(1-t*.35);ctx.strokeStyle="#b8ffd0";ctx.lineWidth=Math.max(1.4,(2.0+1.1*pulse)*sc);
          ctx.beginPath();ctx.moveTo(a[0],a[1]);ctx.lineTo(b[0],b[1]);ctx.stroke();
          dot(b[0],b[1],Math.max(3.5,(4.5+2*pulse)*sc),"#d9ffe3",.75*(1-t*.4));
        }
      }else if(fx.kind==="rogueLeapStart"){
        ring(x,y,(5+28*ease)*sc,2.4*sc,"#8a6cff",.55*(1-t));
        burst(fx,x,y,t,7,"#9b8a78",36,2.2,.38);
      }else if(fx.kind==="rogueLeapLand"){
        ring(x,y,(7+36*ease)*sc,3*sc,"#b392ff",.72*(1-t));
        burst(fx,x,y,t,9,"#8e745b",48,2.8,.42);
        if(fx.radius>0)ring(x,y,Math.max(12,fx.radius*sc)*(.28+.72*ease),2*sc,"#c4a6ff",.35*(1-t));
      }else if(fx.kind==="blinkBurst"){
        ring(x,y,(6+42*ease)*sc,3*sc,"#a874ff",.78*(1-t));
        burst(fx,x,y,t,7,"#d8c0ff",44,2.2,.7);
      }else if(fx.kind==="chargeBurst"){
        ring(x,y,(8+48*ease)*sc,4*sc,"#ffc34e",.82*(1-t));
        burst(fx,x,y,t,9,"#ffb638",68,2.8,.52);
      }else if(fx.kind==="chargedSkillLaunch"){
        const end=this.worldToPx(this.viewX(fx.x2),this.viewY(fx.y2));
        const dx=end[0]-x,dy=end[1]-y,len=Math.hypot(dx,dy),nx=len?dx/len:0,ny=len?dy/len:0;
        const tipX=x+nx*Math.min(len,90*sc),tipY=y+ny*Math.min(len,90*sc);
        ctx.globalAlpha=.72*(1-t);ctx.strokeStyle="#b7ddff";ctx.lineWidth=Math.max(1.5,3*sc);
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(tipX,tipY);
        ctx.moveTo(tipX-nx*10*sc-ny*6*sc,tipY-ny*10*sc+nx*6*sc);ctx.lineTo(tipX,tipY);ctx.lineTo(tipX-nx*10*sc+ny*6*sc,tipY-ny*10*sc-nx*6*sc);ctx.stroke();
        ring(x,y,(5+20*ease)*sc,Math.max(1.5,2*sc),"#c9e8ff",.65*(1-t));
      }else if(fx.kind==="objectiveBearChargeTrail"){
        const rr=(8+18*ease)*sc;
        ring(x,y,rr,Math.max(1.6,2.5*sc),"#a47a45",.28*(1-t));
        burst(fx,x,y,t,5,"#8a6840",28,2.3,.30);
        const seedPhase=(fx.seed%17)*.19;
        for(let k=0;k<3;k++){
          const off=(k-1)*7*sc,back=(14+22*t+k*5)*sc;
          ctx.globalAlpha=.28*(1-t);ctx.strokeStyle=k===1?"#b18a54":"#765638";ctx.lineWidth=Math.max(1.2,(2.3-k*.3)*sc);
          ctx.beginPath();ctx.moveTo(x+off,y+4*sc);ctx.lineTo(x+off+Math.cos(seedPhase+k)*4*sc,y+back);ctx.stroke();
        }
      }else if(fx.kind==="ambushBurst"){
        ring(x,y,(5+34*ease)*sc,2.5*sc,"#76e96e",.72*(1-t));
        burst(fx,x,y,t,8,"#a6f58e",50,2.1,.65);
      }else if(fx.kind==="knockbackBurst"){
        ring(x,y,(4+24*ease)*sc,2.2*sc,"#fff0a8",.55*(1-t));
        burst(fx,x,y,t,5,"#f4dc86",28,1.7,.45);
      }else if(fx.kind==="pillbugBurst"){
        const rr=Math.max(34,(fx.radius||92)*sc)*(0.22+.78*ease);
        ring(x,y,rr,4*sc,"#ffb347",.60*(1-t));
        ring(x,y,rr*.62,3*sc,"#fff0a0",.58*(1-t));
        burst(fx,x,y,t,14,"#ffbe4f",84,4.2,.66);
        burst(fx,x,y,t,7,"#fff3b5",54,2.6,.52);
      }else if(fx.kind==="rootSpike"){
        const e2=this.worldToPx(this.viewX(fx.x2),this.viewY(fx.y2));
        const count=Math.max(6,fx.spikeCount||9),dx=e2[0]-x,dy=e2[1]-y;
        // Rootstalker is a ground-travelling attack, not a normal airborne projectile.
        // Keep a clearly visible dirt ridge travelling along the authoritative attack line,
        // then erupt each spike as that ridge reaches it.
        const head=RangeUtil.clamp(t*1.18,0,1),hx=x+dx*head,hy=y+dy*head;
        ctx.globalAlpha=.34*(1-t*.45);ctx.strokeStyle="#5a351b";ctx.lineWidth=Math.max(2.0,3.2*sc);
        ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(hx,hy);ctx.stroke();
        ring(hx,hy,(5+7*Math.sin(Math.min(1,t*1.5)*Math.PI))*sc,Math.max(1.5,2.4*sc),"#9a6330",.62*(1-t*.35));
        dot(hx,hy,Math.max(2.2,3.4*sc),"#6b421f",.78*(1-t*.25));
        for(let i=0;i<count;i++){
          const along=(i+.55)/count;
          // A spike starts only after the underground ridge reaches its position.
          const arrival=along/.92;
          const local=RangeUtil.clamp((t-arrival)/.28,0,1);
          if(local<=0||local>=1)continue;
          const rise=Math.sin(local*Math.PI),px=x+dx*along,py=y+dy*along;
          const h=(14+18*(i/count))*rise*sc,w=(5+3*rise)*sc;
          ctx.globalAlpha=.98-.24*local;ctx.fillStyle=i%2?"#75441f":"#9a6330";
          ctx.beginPath();ctx.moveTo(px-w,py+2*sc);ctx.lineTo(px,py-h);ctx.lineTo(px+w,py+2*sc);ctx.closePath();ctx.fill();
          ctx.globalAlpha=.78*(1-local*.5);ctx.fillStyle="#d2a66a";
          ctx.beginPath();ctx.moveTo(px-w*.25,py-h*.72);ctx.lineTo(px,py-h);ctx.lineTo(px+w*.25,py-h*.72);ctx.closePath();ctx.fill();
          dot(px,py+2*sc,Math.max(1.2,2.2*sc),"#4a2b18",.48*(1-local));
        }
      }else if(fx.kind==="deepThornCast"){
        const to=this.worldToPx(this.viewX(fx.x2),this.viewY(fx.y2));
        const dx=to[0]-x,dy=to[1]-y,len=Math.hypot(dx,dy)||1,nx=dx/len,ny=dy/len;
        // Phase 1: the creature drives its crown/root mass into the ground.
        const plunge=RangeUtil.clamp(t/.34,0,1),impact=Math.sin(plunge*Math.PI);
        const baseR=(12+24*impact)*sc;
        ring(x,y,baseR,Math.max(2,4.4*sc),"#8fb84d",.78*(1-plunge*.55));
        ring(x,y,baseR*.62,Math.max(1.5,2.7*sc),"#d4ed7a",.65*(1-plunge*.65));
        for(let i=0;i<5;i++){
          const a=(i-2)*.42+Math.atan2(ny,nx);
          const d=(10+30*plunge+(i%2)*6)*sc;
          ctx.globalAlpha=.72*(1-t);ctx.strokeStyle=i%2?"#73953a":"#a9c95c";
          ctx.lineWidth=Math.max(2,3.4*sc);ctx.beginPath();ctx.moveTo(x,y);
          ctx.lineTo(x+Math.cos(a)*d,y+Math.sin(a)*d*.55);ctx.stroke();
        }
        // A short subterranean pressure trace points toward the eruption site without
        // pretending that a visible projectile travels above ground.
        const travel=RangeUtil.clamp((t-.12)/.56,0,1);
        if(travel>0&&travel<1){
          const px=x+dx*travel,py=y+dy*travel;
          dot(px,py,Math.max(2.2,4.2*sc),"#7b5d2f",.38*Math.sin(travel*Math.PI));
          ring(px,py,(5+7*Math.sin(travel*Math.PI))*sc,1.5*sc,"#9c7b42",.24*Math.sin(travel*Math.PI));
        }
      }else if(fx.kind==="deepThornSpike"){
        const rr=Math.max(42,(fx.radius||58))*sc;
        // Ground crack/pressure ring first so the eruption reads even under a large airborne body.
        const crack=RangeUtil.clamp(t/.26,0,1);
        ring(x,y,rr*(.45+.62*crack),Math.max(2.2,4.0*sc),"#76562c",.58*(1-t));
        ring(x,y,rr*(.28+.48*crack),Math.max(1.6,2.8*sc),"#b6d862",.52*(1-t));
        for(let i=0;i<8;i++){
          const a=i/8*Math.PI*2+(fx.seed%997)/997*.35;
          const inner=rr*.18,outer=rr*(.65+.18*((i*29)%7)/6);
          ctx.globalAlpha=.36*(1-t);ctx.strokeStyle=i%2?"#604526":"#866333";
          ctx.lineWidth=Math.max(1.3,2.3*sc);ctx.beginPath();
          ctx.moveTo(x+Math.cos(a)*inner,y+Math.sin(a)*inner*.52);
          ctx.lineTo(x+Math.cos(a)*outer,y+Math.sin(a)*outer*.52);ctx.stroke();
        }
        // One unmistakable central spike does the lifting, with smaller roots around it.
        const mainLocal=RangeUtil.clamp(t/.72,0,1);
        if(mainLocal>0&&mainLocal<1){
          const rise=Math.sin(Math.min(1,mainLocal/.62)*Math.PI*.5);
          const fall=mainLocal>.70?RangeUtil.clamp((1-mainLocal)/.30,0,1):1;
          const h=(72+Math.min(24,(fx.airborneHeight||52)*.30))*rise*fall*sc;
          const w=(12+7*rise)*sc;
          ctx.globalAlpha=.98*fall;ctx.fillStyle="#cfe96b";
          ctx.beginPath();ctx.moveTo(x-w,y+7*sc);ctx.lineTo(x-w*.25,y-h*.42);ctx.lineTo(x,y-h);ctx.lineTo(x+w*.25,y-h*.42);ctx.lineTo(x+w,y+7*sc);ctx.closePath();ctx.fill();
          ctx.globalAlpha=.72*fall;ctx.fillStyle="#6e8d36";
          ctx.beginPath();ctx.moveTo(x-w*.52,y+5*sc);ctx.lineTo(x,y-h*.78);ctx.lineTo(x+w*.52,y+5*sc);ctx.closePath();ctx.fill();
        }
        const count=6;
        for(let i=0;i<count;i++){
          const a=i/count*Math.PI*2+(fx.seed%1000)/1000;
          const rad=(.30+.48*((i*37)%100)/100)*rr;
          const px=x+Math.cos(a)*rad,py=y+Math.sin(a)*rad*.58;
          const local=RangeUtil.clamp((t-.035-i*.025)/.62,0,1);
          if(local<=0||local>=1)continue;
          const rise=Math.sin(local*Math.PI),h=(25+(i%3)*9)*rise*sc,w=(6+(i%2)*2)*sc;
          ctx.globalAlpha=.90*(1-local*.45);ctx.fillStyle=i%2?"#95bb4a":"#b9d963";
          ctx.beginPath();ctx.moveTo(px-w,py+3*sc);ctx.lineTo(px,py-h);ctx.lineTo(px+w,py+3*sc);ctx.closePath();ctx.fill();
        }
        burst(fx,x,y,Math.min(1,t*1.15),13,"#80653a",52,3.0,.34);
      }else if(fx.kind==="airborneBurst"){
        ring(x,y,(5+18*ease)*sc,2.0*sc,"#e8f6b1",.30*(1-t));
        burst(fx,x,y,t,5,"#b9d86f",26,1.5,.45);
      }else if(fx.kind==="chainArc"){
        const pts=fx.points?.length>=2?fx.points:[{x:fx.x,y:fx.y},{x:fx.x2,y:fx.y2}],aegis=!!fx.aegisArc;
        for(let i=1;i<pts.length;i++){
          const a=this.worldToPx(this.viewX(pts[i-1].x),this.viewY(pts[i-1].y));
          const b=this.worldToPx(this.viewX(pts[i].x),this.viewY(pts[i].y));
          if(aegis){
            // Aegis attacks are rapid tick damage, so keep a clearly connected luminous cable
            // between attacker and target instead of a barely-visible one-frame spark.
            this.commonEffectPool.drawElectricArc(ctx,{x:a[0],y:a[1]},{x:b[0],y:b[1]},{
              seed:fx.seed+i*131,time:now/1000,color:"#59cfff",alpha:.42*(1-t*.55),scale:sc,width:2.45
            });
            this.commonEffectPool.drawElectricArc(ctx,{x:a[0],y:a[1]},{x:b[0],y:b[1]},{
              seed:fx.seed+i*131,time:now/1000,color:"#e9fcff",alpha:.98*(1-t*.72),scale:sc,width:1.18
            });
            dot(a[0],a[1],Math.max(2.4,3.8*sc),"#bff6ff",.86*(1-t*.55));
            dot(b[0],b[1],Math.max(2.0,3.2*sc),"#ffffff",.88*(1-t*.55));
          }else{
            this.commonEffectPool.drawElectricArc(ctx,{x:a[0],y:a[1]},{x:b[0],y:b[1]},{
              seed:fx.seed+i*131,time:now/1000,color:"#9edfff",alpha:.82*(1-t),scale:sc,width:1.08
            });
          }
        }
      }else if(fx.kind==="hitGuardBreak"){
        const t=RangeUtil.clamp(age/320,0,1),aliveShield=fx.remaining>0;
        const source=(this.snapshot?.units||[]).find(u=>u.id===fx.sourceId&&u.alive)||(this.snapshot?.buildings||[]).find(b=>b.id===fx.sourceId&&b.alive!==false);
        let impactA=(fx.seed%6283)/1000;
        if(source){
          const sp=source.id&&this.renderState.has("unit",source.id,this.presentationNow())
            ?this.renderTrackedScreenPosition(source,"unit")
            :{x:this.worldToPx(this.viewX(source.x),this.viewY(source.y))[0],y:this.worldToPx(this.viewX(source.x),this.viewY(source.y))[1]};
          impactA=Math.atan2(sp.y-y,sp.x-x);
        }
        const targetSize=UnitDefinition.get(fx.targetType)?.size||18,baseR=Math.max(9,targetSize*sc*(1.48+.18*(1-t))),impactX=x+Math.cos(impactA)*baseR*.80,impactY=y+Math.sin(impactA)*baseR*.80;
        // Localized white/cyan flash on the side that was struck: the body itself never flashes.
        ctx.save();ctx.globalCompositeOperation="source-over";
        ctx.globalAlpha=(1-t)*.96;ctx.fillStyle="#e8fbff";ctx.beginPath();ctx.arc(impactX,impactY,Math.max(4.5,(10-3*t)*sc),0,Math.PI*2);ctx.fill();
        ctx.globalAlpha=(1-t)*.48;ctx.strokeStyle="#6fe1ff";ctx.lineWidth=Math.max(1.4,2.8*sc);ctx.beginPath();
        ctx.arc(x,y,baseR,impactA-.72-t*.20,impactA+.72+t*.20);ctx.stroke();
        if(!aliveShield){
          // Full break: flat energy facets fly away from the former shell.
          for(let k=0;k<10;k++){
            const a=impactA+(k-4.5)*.34+((fx.seed>>>(k%16))&7)*.018;
            const dist=(baseR*.72+Math.max(7,(14+42*t+(k%3)*6)*sc));
            const px=x+Math.cos(a)*dist,py=y+Math.sin(a)*dist;
            const sz=Math.max(2.8,(6.5-2.8*t+(k%2))*sc);
            ctx.save();ctx.translate(px,py);ctx.rotate(a+t*(k%2?2.1:-1.8));ctx.globalAlpha=(1-t)*(.58+(k%3)*.09);ctx.fillStyle=k%3===0?"#e8fbff":"#58cfee";
            ctx.beginPath();ctx.moveTo(sz,0);ctx.lineTo(-sz*.45,-sz*.55);ctx.lineTo(-sz*.75,0);ctx.lineTo(-sz*.45,sz*.55);ctx.closePath();ctx.fill();ctx.restore();
          }
        }else{
          // A charge remains: show a quick surface ripple, not a shatter.
          ctx.globalAlpha=(1-t)*.30;ctx.fillStyle="#58cfee";ctx.beginPath();ctx.arc(x,y,baseR*.90,0,Math.PI*2);ctx.fill();
        }
        ctx.restore();
      }else if(fx.kind==="guardPulse"){
        ring(x,y,(8+28*ease)*sc,2.2*sc,"#65d9f6",.28*(1-t));
      }else if(fx.kind==="hunterWaspCooldownReset"){
        ring(x,y,(5+13*ease)*sc,Math.max(1.0,1.5*sc),"#ffd05a",.26*(1-t));
        burst(fx,x,y,t,4,"#fff0a0",18,1.3,.34);
      }else if(fx.kind==="guardRetaliationBurst"){
        // Cap activation: quick compression/expansion is represented by concentric cap-centered pulses
        // plus a short spore burst. Only the retaliation event emits this presentation.
        const pulse=Math.sin(Math.min(1,t)*Math.PI);
        ring(x,y,(10+26*ease)*sc,Math.max(1.8,3.2*sc),"#dff58a",.62*(1-t));
        ring(x,y,(5+14*pulse)*sc,Math.max(1.4,2.4*sc),"#8fca48",.72*(1-t));
        burst(fx,x,y,t,6,"#eef9ad",30,2.2,.70);
      }else if(fx.kind==="guardRetaliationImpact"){
        ring(x,y,(8+Math.max(24,fx.radius||50)*ease)*sc,Math.max(1.5,2.8*sc),"#b8dc62",.48*(1-t));
        burst(fx,x,y,t,8,"#dff28a",34,2.0,.58);
      }else if(fx.kind==="sporeSpawn"){
        ring(x,y,(4+18*ease)*sc,2*sc,"#c8df72",.38*(1-t));
        burst(fx,x,y,t,5,"#e7f4a2",24,1.8,.42);
      }else if(fx.kind==="arcTether"){
        const source=(this.snapshot?.units||[]).find(u=>u.id===fx.sourceId&&u.alive);
        const target=(this.snapshot?.units||[]).find(u=>u.id===fx.targetId&&u.alive);
        if(source&&target){
          const elapsed=Math.max(0,performance.now()-fx.start),travelMs=Math.max(1,fx.travelMs||300);
          const sourceRender=this.resolveRenderWorldPosition(source,"unit");
          const liveTargetRender=this.resolveRenderWorldPosition(target,"unit");
          const initialDistance=Math.max(1,Math.hypot((Number(fx.fromX)||0)-sourceRender.x,(Number(fx.fromY)||0)-sourceRender.z));
          let targetWorld;
          if(elapsed<travelMs){
            // Launch phase: the hook head advances on the shared ArcTravelPresentation path.
            const q=RangeUtil.clamp(elapsed/travelMs,0,1),px=sourceRender.x+((Number(fx.fromX)||0)-sourceRender.x)*q,pz=sourceRender.z+((Number(fx.fromY)||0)-sourceRender.z)*q;
            const arc=this.resolveArcTravelPresentation({fromX:sourceRender.x,fromY:sourceRender.z,toX:Number(fx.fromX)||0,toY:Number(fx.fromY)||0,planarX:px,planarY:pz,arcHeight:fx.arcHeight||90});
            targetWorld={x:px,y:arc.height+arc.groundHeight,z:pz,groundY:0,motion:"arc",progress:q};
          }else{
            // Reel phase: target endpoint is the victim's live render position, including airborne height.
            targetWorld=liveTargetRender;
          }
          const pullMs=fx.pullTicks?SimulationTiming.ticksToMs(fx.pullTicks,this.snapshot?.tps||SIM_TPS):250;
          const retractStart=travelMs+pullMs,retractElapsed=Math.max(0,elapsed-retractStart),retractMs=Math.max(1,fx.retractMs||220);
          const tether=elapsed<retractStart
            ?ArcTetherPresentation.resolve({sourceWorld:sourceRender,targetWorld,baseArcHeight:fx.arcHeight||90,referenceDistance:initialDistance,samples:14,elapsedMs:elapsed,travelMs:travelMs,retract:false})
            :ArcTetherPresentation.resolve({sourceWorld:sourceRender,targetWorld:liveTargetRender,baseArcHeight:fx.arcHeight||90,referenceDistance:initialDistance,samples:14,elapsedMs:travelMs+retractElapsed,travelMs:travelMs,holdMs:0,retractMs:retractMs,retract:true});
          const worldPoints=tether.points;
          const pts=worldPoints.map(p=>this.projectRenderWorldPosition(p));
          ctx.save();ctx.lineJoin="round";ctx.lineCap="round";
          const drawPath=(color,width,alpha)=>{
            if(pts.length<2)return;ctx.globalAlpha=alpha;ctx.strokeStyle=color;ctx.lineWidth=Math.max(1,width*sc);ctx.beginPath();ctx.moveTo(pts[0].x,pts[0].y);
            for(let i=1;i<pts.length;i++)ctx.lineTo(pts[i].x,pts[i].y);ctx.stroke();
          };
          drawPath("#54270d",6.5,.30*(1-t*.55));drawPath("#ffad42",3.0,.92*(1-t*.35));drawPath("#ffe2a5",1.0,.80*(1-t*.25));
          const head=pts[pts.length-1];if(head){ctx.globalAlpha=.95*(1-t*.35);ctx.fillStyle="#ffd27b";ctx.beginPath();ctx.arc(head.x,head.y,Math.max(2.5,4*sc),0,Math.PI*2);ctx.fill()}
          ctx.restore();
        }
      }else if(fx.kind==="clawPullImpact"){
        ring(x,y,(4+12*ease)*sc,Math.max(1.4,2.3*sc),"#ffb24c",.62*(1-t));
        burst(fx,x,y,t,4,"#ffe1a2",20,1.6,.55);
      }else if(fx.kind==="thornReflect"){
        // Reflection is directional: the thornfruit visibly fires the damage back
        // toward the attacker. This intentionally differs from the radial thornBurst.
        const to=this.worldToPx(this.viewX(Number(fx.x2)||fx.x),this.viewY(Number(fx.y2)||fx.y));
        let dx=to[0]-x,dy=to[1]-y,len=Math.hypot(dx,dy)||1;dx/=len;dy/=len;
        const travel=RangeUtil.clamp(t/.72,0,1),te=1-Math.pow(1-travel,3);
        const sx=x+dx*8*sc,sy=y+dy*8*sc;
        const ex=sx+dx*Math.min(len*.88,(22+38*te)*sc),ey=sy+dy*Math.min(len*.88,(22+38*te)*sc);
        ctx.globalAlpha=.92*(1-t);ctx.strokeStyle="#dfff76";ctx.lineWidth=Math.max(2,3.8*sc);
        ctx.beginPath();ctx.moveTo(sx,sy);ctx.lineTo(ex,ey);ctx.stroke();
        // Arrowhead / thorn tip makes the return direction readable in melee.
        const px=-dy,py=dx,tip=7*sc,back=10*sc;
        ctx.fillStyle="#efff9a";ctx.globalAlpha=.92*(1-t);
        ctx.beginPath();ctx.moveTo(ex+dx*tip,ey+dy*tip);ctx.lineTo(ex-dx*back+px*5*sc,ey-dy*back+py*5*sc);ctx.lineTo(ex-dx*back-px*5*sc,ey-dy*back-py*5*sc);ctx.closePath();ctx.fill();
        ring(x,y,(4+13*ease)*sc,Math.max(1.4,2.3*sc),"#8ed84a",.48*(1-t));
        ring(to[0],to[1],(3+8*ease)*sc,Math.max(1.2,2*sc),"#eaff92",.58*(1-t));
      }else if(fx.kind==="thornBurst"){
        // Ability VFX must read as an outward thorn detonation, not as another hit spark.
        // Three staged rings show the authoritative AoE boundary while long radial spikes
        // give it a unique silhouette even in a dense melee.
        const radius=Math.max(50,Number(fx.radius)||50),rr=radius*sc;
        const wave=RangeUtil.clamp(t/.72,0,1),waveEase=1-Math.pow(1-wave,3);
        ring(x,y,rr*(.18+.82*waveEase),Math.max(2.8,5.2*sc),"#d8ff72",.92*(1-wave));
        ring(x,y,rr*(.10+.64*waveEase),Math.max(1.8,3.1*sc),"#79d83f",.66*(1-wave));
        if(t<.32)ring(x,y,rr*(.10+.30*(t/.32)),Math.max(2.2,4*sc),"#fff3a1",.82*(1-t/.32));
        const spikeAlpha=Math.max(0,1-t/.82);
        for(let k=0;k<16;k++){
          const a=(k/16)*Math.PI*2+(fx.seed%31)*.013;
          const stagger=((k*7)%5)*.025;
          const q=RangeUtil.clamp((t-stagger)/.58,0,1),qe=1-Math.pow(1-q,3);
          const inner=rr*(.10+.28*qe),outer=rr*(.24+.76*qe);
          ctx.globalAlpha=.88*spikeAlpha;
          ctx.strokeStyle=k%2?"#b9ed5c":"#efff9a";
          ctx.lineWidth=Math.max(1.6,(k%3?2.8:4.2)*sc);
          ctx.beginPath();
          ctx.moveTo(x+Math.cos(a)*inner,y+Math.sin(a)*inner);
          ctx.lineTo(x+Math.cos(a)*outer,y+Math.sin(a)*outer);
          ctx.stroke();
        }
        burst(fx,x,y,t,18,"#eaff92",Math.max(64,radius*.72),3.4,.72);
      }else if(fx.kind==="kickhopperSplash"){
        const rr=(fx.radius||55)*(0.22+.78*ease)*sc;
        ring(x,y,rr,Math.max(1.6,2.6*sc),"#d9ef72",.44*(1-t));
        ring(x,y,rr*.62,Math.max(1,1.7*sc),"#fff0a6",.30*(1-t));
        burst(fx,x,y,t,7,"#9c7b43",36,2.0,.38);
      }else if(fx.kind==="titanSlam"){
        const rr=(fx.radius||100)*(0.18+.82*ease)*sc,sourceType=fx.sourceType||"",isTitan=sourceType==="shelltitan";
        ring(x,y,rr,(isTitan?5.5:3.5)*sc,"#d9b85b",.52*(1-t));
        ring(x,y,rr*.58,Math.max(1.8,(isTitan?3.4:2.2)*sc),"#f2dc8a",.36*(1-t));
        if(isTitan){
          for(let k=0;k<10;k++){
            const a=k/10*Math.PI*2+(fx.seed%73)*.017,inner=rr*.18,outer=rr*(.68+.22*((k*37)%11)/10);
            ctx.globalAlpha=.52*(1-t);ctx.strokeStyle=k%2?"#72512c":"#9a743c";ctx.lineWidth=Math.max(1.5,2.8*sc);
            ctx.beginPath();ctx.moveTo(x+Math.cos(a)*inner,y+Math.sin(a)*inner*.62);ctx.lineTo(x+Math.cos(a)*outer,y+Math.sin(a)*outer*.62);ctx.stroke();
          }
          burst(fx,x,y,t,22,"#8a673c",92,5.8,.60);
          burst(fx,x,y,t,10,"#ead391",58,3.2,.48);
        }else burst(fx,x,y,t,12,"#d8c089",68,3.5,.50);
      }else if(fx.kind==="objectiveCaptured"){
        const col=fx.side===0?"#66a0ff":fx.side===1?"#ff6868":"#d8bb68",rr=(18+82*ease)*sc;
        ring(x,y,rr,Math.max(2,4.5*sc),col,.76*(1-t));ring(x,y,rr*.58,Math.max(1.4,2.5*sc),"#fff0b0",.42*(1-t));burst(fx,x,y,t,16,col,84,3.4,.55);
        const dx=Number(fx.dirX)||0,dy=Number(fx.dirY)||0,len=Math.hypot(dx,dy)||1;if(len>.01){const a=this.worldToPx(this.viewX(fx.x),this.viewY(fx.y)),b=this.worldToPx(this.viewX(fx.x+dx/len*1),this.viewY(fx.y+dy/len*1));let vx=b[0]-a[0],vy=b[1]-a[1],vl=Math.hypot(vx,vy)||1;vx/=vl;vy/=vl;for(let k=-1;k<=1;k++){const off=k*9*sc;ctx.globalAlpha=.55*(1-t);ctx.strokeStyle=col;ctx.lineWidth=Math.max(1.4,2.6*sc);ctx.beginPath();ctx.moveTo(x-vy*off,y+vx*off);ctx.lineTo(x+vx*(36+58*ease)*sc-vy*off,y+vy*(36+58*ease)*sc+vx*off);ctx.stroke()}}
      }else if(fx.kind==="objectiveRespawned"){
        if(UnitVisualDefinition.get(fx.sourceType)?.objectiveFxStyle==="dragon"){ring(x,y,(16+72*ease)*sc,4*sc,"#ff7c2c",.62*(1-t));ring(x,y,(8+44*ease)*sc,2.2*sc,"#ffd45f",.52*(1-t));for(let k=0;k<7;k++){const a=k/7*Math.PI*2+(fx.seed%31)*.07;ctx.globalAlpha=.48*(1-t);ctx.strokeStyle=k%2?"#ffb538":"#fff0a0";ctx.lineWidth=Math.max(1.3,2.2*sc);ctx.beginPath();ctx.moveTo(x+Math.cos(a)*10*sc,y+Math.sin(a)*6*sc);ctx.lineTo(x+Math.cos(a)*(28+38*ease)*sc,y+Math.sin(a)*(18+24*ease)*sc-22*(1-t)*sc);ctx.stroke()}}
        else if(UnitVisualDefinition.get(fx.sourceType)?.objectiveFxStyle==="worm"){ring(x,y,(10+66*ease)*sc,4*sc,"#a9bd3f",.66*(1-t));burst(fx,x,y,t,18,"#7d6a36",76,4.6,.58);burst(fx,x,y,t,8,"#d4df59",48,2.4,.46)}
        else{ring(x,y,(10+58*ease)*sc,4*sc,"#a77a45",.60*(1-t));burst(fx,x,y,t,16,"#84633c",70,4.8,.56);burst(fx,x,y,t,7,"#d5b477",42,2.8,.42)}
      }else if(fx.kind==="electricLink"){
        const source=(this.snapshot?.units||[]).find(u=>u.id===fx.sourceId&&u.alive),target=(this.snapshot?.projectiles||[]).find(p=>p.id===fx.targetId&&p.alive);
        if(source&&target){
          const sa=this.renderTrackedScreenPosition(source,"unit"),tb=this.renderTrackedScreenPosition(target,"projectile");
          const node=this.aegisShellNodeScreen(source,tb.x,tb.y),a=[node.x,node.y],b=[tb.x,tb.y];
          ring(sa.x,sa.y,Math.max(7,this.unitRenderRadius(source)*(.78+.16*ease)),Math.max(1.3,2.2*sc),"#6fe6ff",.30*(1-t));
          this.commonEffectPool.drawElectricArc(ctx,{x:a[0],y:a[1]},{x:b[0],y:b[1]},{
            seed:fx.seed,time:now/1000,color:"#b8f4ff",alpha:.94*(1-t*.25),scale:sc,width:1
          });
          dot(a[0],a[1],3.5*sc,"#d9fbff",.8);dot(b[0],b[1],3*sc,"#ffffff",.9);
        }
      }else if(fx.kind==="chainOverload"||fx.kind==="deepThornSecondary"||fx.kind==="impactShockwave"||fx.kind==="pullImpact"||fx.kind==="allySpeedBurst"){
        const col=fx.kind==="allySpeedBurst"?"#9be879":fx.kind==="impactShockwave"?"#ffd66a":"#c7a6ff",rr=Math.max(24,(fx.radius||55)*sc)*(.25+.75*ease);ring(x,y,rr,Math.max(1.6,2.8*sc),col,.58*(1-t));burst(fx,x,y,t,7,col,42,2.1,.45);
      }else if(fx.kind==="projectileIntercept"){
        ring(x,y,(5+22*ease)*sc,2.6*sc,"#7fdcff",.55*(1-t));
        burst(fx,x,y,t,6,"#bdeeff",26,1.8,.48);
        const source=(this.snapshot?.units||[]).find(u=>u.id===fx.sourceId&&u.alive);
        if(source){const sp=this.renderTrackedScreenPosition(source,"unit"),rr=this.unitRenderRadius(source);ring(sp.x,sp.y,rr*(.80+.25*ease),Math.max(1.2,2.0*sc),"#78e7ff",.26*(1-t))}
      }else if(fx.kind==="burrowDive"){
        const worm=UnitVisualDefinition.get(fx.sourceType)?.objectiveFxStyle==="worm",beast=fx.sourceType==="burrowbeast",edge=worm?"#9eb32b":"#7b4a24",soil=worm?"#77812b":"#8a5a31",bright=worm?"#d5df58":"#c29a67";
        ring(x,y,(8+(beast?46:34)*ease)*sc,(beast?4.4:3.2)*sc,edge,.55*(1-t));
        burst(fx,x,y,t,12,soil,42,3.2,.58);
        burst(fx,x,y,t,7,bright,28,2.2,.48);
      }else if(fx.kind==="burrowTrail"){
        if(fx.sourceId){
          const source=(this.snapshot?.units||[]).find(u=>u.id===fx.sourceId&&u.alive);
          if(source){
            const rp=this.renderTrackedPosition(source,"unit");
            const sourcePx=this.worldToPx(this.viewX(rp.x),this.viewY(rp.y));
            x=sourcePx[0];y=sourcePx[1];
          }
        }
        const worm=UnitVisualDefinition.get(fx.sourceType)?.objectiveFxStyle==="worm";
        ring(x,y,(5+18*ease)*sc,2.2*sc,worm?"#8b9630":"#6d4527",.32*(1-t));
        burst(fx,x,y,t,6,worm?"#b1bd43":"#9b7148",24,2.0,.35);
      }else if(fx.kind==="burrowEmerge"){
        const beast=fx.sourceType==="burrowbeast",rr=(fx.radius||92)*(0.35+.65*ease)*sc,worm=UnitVisualDefinition.get(fx.sourceType)?.objectiveFxStyle==="worm";
        ring(x,y,rr,(beast?6.0:4.2)*sc,worm?"#b6c83b":"#9a5d2e",.72*(1-t));
        burst(fx,x,y,t,beast?26:18,worm?"#7d8330":"#8d623d",beast?112:88,beast?7.0:5.5,.62);
        burst(fx,x,y,t,beast?16:11,worm?"#d8e35a":"#d1a56d",beast?82:64,beast?4.5:3.5,.52);
        if(beast)ring(x,y,rr*.66,Math.max(2,3.4*sc),"#d6a063",.44*(1-t));
      }else if(fx.kind==="burrowMelee"){
        const rr=(fx.radius||64)*(0.25+.75*ease)*sc;
        ring(x,y,rr,3*sc,"#b77a3d",.48*(1-t));
        burst(fx,x,y,t,7,"#d2a06a",38,2.6,.40);
      }else if(fx.kind==="rootBindBurst"){
        const rr=(fx.radius||190)*sc;
        ring(x,y,rr*(.40+.60*ease),3.2*sc,"#7b4b22",.55*(1-t));
        for(let k=0;k<12;k++){
          const a=(k/12)*Math.PI*2+(fx.seed%23)*.03;
          const inner=rr*(.22+.42*ease),outer=rr*(.48+.36*ease);
          ctx.globalAlpha=.72*(1-t);ctx.strokeStyle=k%2?"#8a5a2b":"#4f6f2b";ctx.lineWidth=Math.max(1.5,2.7*sc);
          ctx.beginPath();ctx.moveTo(x+Math.cos(a)*inner,y+Math.sin(a)*inner*.70);ctx.lineTo(x+Math.cos(a)*outer,y+Math.sin(a)*outer*.70);ctx.stroke();
        }
        burst(fx,x,y,t,9,"#9d7040",46,2.5,.50);
      }else if(fx.kind==="recallBurst"){
        const to=this.worldToPx(this.viewX(fx.x2),this.viewY(fx.y2));
        const rr=(14+34*ease)*sc;
        ring(x,y,rr,2.8*sc,"#9d7cff",.58*(1-t));
        ring(to[0],to[1],rr*1.08,3.2*sc,"#c4a6ff",.72*(1-t));
        burst(fx,x,y,t,8,"#b99aff",42,2.5,.60);
        burst(fx,to[0],to[1],t,10,"#e0d1ff",48,2.6,.60,fx.seed^0x5a17);
        ctx.globalAlpha=.18*(1-t);ctx.strokeStyle="#b89aff";ctx.lineWidth=Math.max(1,1.8*sc);ctx.beginPath();ctx.moveTo(x,y);ctx.lineTo(to[0],to[1]);ctx.stroke();
      }else if(fx.kind==="sporeFadeBurst"){
        ring(x,y,(4+20*ease)*sc,1.8*sc,"#a6ce62",.30*(1-t));
        burst(fx,x,y,t,7,"#b6d86c",30,2.0,.75);
      }else if(fx.kind==="lostLockBurst"){
        ring(x,y,(3+14*ease)*sc,1.6*sc,"#9bc5d8",.30*(1-t));
        burst(fx,x,y,t,4,"#d1e9f2",20,1.5,.80);
      }else if(fx.kind==="arcTravelFx"){
        const q=RangeUtil.clamp(t,0,1);
        const px=fx.fromX+(fx.toX-fx.fromX)*q,py=fx.fromY+(fx.toY-fx.fromY)*q;
        const arc=this.resolveArcTravelPresentation({
          fromX:fx.fromX,fromY:fx.fromY,toX:fx.toX,toY:fx.toY,
          planarX:px,planarY:py,arcHeight:fx.arcHeight
        });
        const wp={x:px,y:arc.height+arc.groundHeight,z:py,groundY:0,motion:arc.motion,progress:arc.progress};
        const pp=this.projectRenderWorldPosition(wp),gp=this.projectRenderWorldPosition({x:px,y:.001+this.world.terrain.surfaces.heightAt(px,py),z:py,groundY:0,motion:"ground"});
        if(fx.preset==="swarmCarcassEnergy"){
          const pulse=.85+.15*Math.sin(q*Math.PI*5+fx.seed*.001),fade=Math.min(1,q/.08,(1-q)/.08);
          const start=this.projectRenderWorldPosition({x:fx.fromX,y:.001+this.world.terrain.surfaces.heightAt(fx.fromX,fx.fromY),z:fx.fromY,groundY:0,motion:"ground"});
          const end=this.projectRenderWorldPosition({x:fx.toX,y:.001+this.world.terrain.surfaces.heightAt(fx.toX,fx.toY),z:fx.toY,groundY:0,motion:"ground"});

          // Phase 1 — unmistakable source release. All five consume events overlap here,
          // intentionally making the corpse origin brighter instead of creating five projectile-like muzzle flashes.
          if(q<.28){
            const bt=q/.28,be=1-Math.pow(1-bt,3),ba=(1-bt);
            this.withRenderDepth(start.depth+.006,()=>{
              ring(start.x,start.y,(5+30*be)*sc,Math.max(2,3*sc),"#d9f06b",.72*ba);
              ring(start.x,start.y,(2+18*be)*sc,Math.max(1.5,2*sc),"#fff0a0",.58*ba);
              burst(fx,start.x,start.y,bt,5,"#c7e95c",36,3.2,.78);
            });
          }

          // Phase 2 — large organic energy core + halo. Motion itself still comes exclusively
          // from resolveArcTravelPresentation().
          this.withRenderDepth(pp.depth,()=>{
            this.circle(pp.x,pp.y,Math.max(5,8*sc)*pulse,[.91,.98,.48,.98*fade],12);
            this.circle(pp.x,pp.y,Math.max(8,14*sc)*pulse,[.55,.82,.24,.30*fade],16);
            this.circle(pp.x,pp.y,Math.max(11,19*sc)*pulse,[.45,.70,.18,.10*fade],18);
          });

          // Very short dotted afterimage: only the last three arc samples, never a continuous projectile trail.
          for(let k=1;k<=3;k++){
            const tq=Math.max(0,q-k*.045),tx=fx.fromX+(fx.toX-fx.fromX)*tq,ty=fx.fromY+(fx.toY-fx.fromY)*tq;
            const ta=this.resolveArcTravelPresentation({fromX:fx.fromX,fromY:fx.fromY,toX:fx.toX,toY:fx.toY,planarX:tx,planarY:ty,arcHeight:fx.arcHeight});
            const tp=this.projectRenderWorldPosition({x:tx,y:ta.height+ta.groundHeight,z:ty,groundY:0,motion:ta.motion,progress:ta.progress});
            this.withRenderDepth(tp.depth,()=>this.circle(tp.x,tp.y,Math.max(2,4.5*sc)*(1-k*.18),[.72,.90,.30,.18*fade*(1-k*.20)],9));
          }
          this.withRenderDepth(gp.depth+.002,()=>this.circle(gp.x,gp.y,Math.max(3,5*sc),[.06,.08,.05,.22*fade],10));

          // Phase 3 — absorption, not impact: a bright ring contracts into the recipient.
          if(q>.70){
            const at=(q-.70)/.30,ar=(22-17*at)*sc,aa=Math.sin(at*Math.PI);
            this.withRenderDepth(end.depth+.008,()=>{
              ring(end.x,end.y,Math.max(4,ar),Math.max(2,3*sc),"#dff56f",.82*aa);
              this.circle(end.x,end.y,Math.max(3,6*sc)*(1-at*.45),[.86,.96,.42,.24*aa],12);
            });
          }
        }
      }else if(fx.kind==="deathBurst"){
        const vd=UnitVisualDefinition.get(fx.entity)||UnitVisualDefinition.get(fx.targetType)||null;
        const ac=vd?.accent||[.90,.82,.66,1];
        const accent=`rgb(${Math.round(ac[0]*255)},${Math.round(ac[1]*255)},${Math.round(ac[2]*255)})`;
        burst(fx,x,y,t,6,accent,54,3.5,.62);
        burst(fx,x,y,t,5,"#e7d7b7",64,2.5,.58,fx.seed^0x2a51);
        ring(x,y,(6+26*ease)*sc,2*sc,accent,.34*(1-t));
      }else if(fx.kind==="buildingBurst"){
        burst(fx,x,y,t,13,"#6a6259",72,4.8,.48);
        burst(fx,x,y,t,7,"#d2aa63",58,3.3,.52);
        ring(x,y,(15+72*ease)*sc,3*sc,"#b98c54",.35*(1-t));
      }else if(fx.kind==="healBurst"){
        ring(x,y,(5+28*ease)*sc,2.5*sc,"#79e89a",.65*(1-t));
        burst(fx,x,y,t,5,"#9af0af",32,2.1,.7);
      }

      ctx.restore();
      this.combatFx[write++]=fx;
    }

    this.combatFx.length=write;
  }

  drawCombatReadabilityOverlay(){
    const ctx=this.fxCtx,snap=this.snapshot;
    if(!ctx||!snap)return;
    const side=this.mySide(),sc=this.sc(),flag=snap.flags?.[side],now=performance.now();
    ctx.save();ctx.lineCap="round";ctx.lineJoin="round";
    for(const u of snap.units||[]){
      if(!u.alive||!!UnitDefinition.get(u.type)?.economyWorker||u.side===NEUTRAL_SIDE)continue;
      const own=u.side===side;
      if(!own&&!this.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR"))continue;
      if(!this.onScreenAuth(u.x,u.y,120))continue;
      const rp=this.renderTrackedScreenPosition(u,"unit"),x=rp.x,y=rp.y;
      const baseR=Math.max(7,(UnitDefinition.get(u.type)?.size||12)*sc*1.8);

      // Forced rally: tiny chevron means this unit is intentionally ignoring combat.
      if(own&&flag?.forced){
        const yy=y-baseR*1.35,pulse=.70+.30*Math.sin(now*.010+(HashUtil.hash(u.id)%31));
        ctx.globalAlpha=.55+.30*pulse;ctx.strokeStyle="#ffad3d";ctx.lineWidth=Math.max(1.4,2.2*sc);
        ctx.beginPath();ctx.moveTo(x-baseR*.28,yy-baseR*.12);ctx.lineTo(x,yy+baseR*.12);ctx.lineTo(x+baseR*.28,yy-baseR*.12);ctx.stroke();
      }

      // Rootstalker setup is strategically important: expose only the active setup progress.
      if(Number(UnitDefinition.get(u.type)?.rootSetupMs)>0&&(u.behaviorState.rootSetupTicks||0)>0){
        const need=SimulationTiming.msToTicks(snap.abilities?.[u.side]?.[u.type]?700:(UnitDefinition.get(u.type).rootSetupMs||1050),this.snapshot?.tps||SIM_TPS);
        const pct=RangeUtil.clamp((u.behaviorState.rootSetupTicks||0)/Math.max(1,need),0,1);
        ctx.globalAlpha=.78;ctx.strokeStyle="#c7ef72";ctx.lineWidth=Math.max(1.5,2.4*sc);
        ctx.beginPath();ctx.arc(x,y,baseR*1.18,-Math.PI/2,-Math.PI/2+Math.PI*2*pct);ctx.stroke();
      }

      // 수호버섯 hitGuard 충전 반경. 실제 보호막은 각 유닛의 공통 에너지 외피로 표시한다.
      if(Number(UnitDefinition.get(u.type)?.guardChargeRadius)>0&&sc>.18){
        const gd=UnitDefinition.get(u.type);
        const radius=(snap.abilities?.[u.side]?.[u.type]?(gd.guardChargeRadius||150):(gd.guardChargeRadius||150))*sc;
        ctx.globalAlpha=.10;ctx.strokeStyle="#88c9d9";ctx.lineWidth=Math.max(1,1.35*sc);
        ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.stroke();
      }

      // AIR support fields are presentation-only. Use material-like cues instead of one generic aura circle.
      if(Number(UnitDefinition.get(u.type)?.sightAuraRadius)>0&&sc>.18){
        const md=UnitDefinition.get(u.type),det=(md.detectRadius||200)*sc,up=!!snap.abilities?.[u.side]?.[u.type],sight=(md.sightAuraRadius||220)*sc;
        const rp=this.renderTrackedPosition(u,"unit"),q=this.worldToPx(this.viewX(rp.x),this.viewY(rp.y)),cx=q[0],cy=q[1],pulse=.5+.5*Math.sin(now*.004+(HashUtil.hash(u.id)%71));
        ctx.globalAlpha=.08+.04*pulse;ctx.fillStyle="#ffe98a";ctx.beginPath();ctx.arc(cx,cy,det,0,Math.PI*2);ctx.fill();
        ctx.globalAlpha=.24;ctx.strokeStyle="#ffe884";ctx.lineWidth=Math.max(1,1.35*sc);ctx.setLineDash([Math.max(3,8*sc),Math.max(3,10*sc)]);ctx.beginPath();ctx.arc(cx,cy,det,0,Math.PI*2);ctx.stroke();ctx.setLineDash([]);
        if(up){ctx.globalAlpha=.20;ctx.strokeStyle="#fff4b6";ctx.lineWidth=Math.max(1,1.2*sc);ctx.beginPath();ctx.arc(cx,cy,sight,0,Math.PI*2);ctx.stroke()}
      }else if(Number(UnitDefinition.get(u.type)?.mobilityAuraRadius)>0&&sc>.18){
        const sd=UnitDefinition.get(u.type),up=!!snap.abilities?.[u.side]?.[u.type],radius=(up?(sd.abilityMobilityAuraRadius||280):(sd.mobilityAuraRadius||140))*sc;
        const rp=this.renderTrackedPosition(u,"unit"),q=this.worldToPx(this.viewX(rp.x),this.viewY(rp.y)),cx=q[0],cy=q[1],phase=now*.0012+(HashUtil.hash(u.id)%53);
        for(let k=0;k<4;k++){const a=phase+k*Math.PI*.5,rr=radius*(.58+.10*(k%2));ctx.globalAlpha=.16+(up?0.05:0);ctx.strokeStyle="#87e6cf";ctx.lineWidth=Math.max(1,1.45*sc);ctx.beginPath();ctx.arc(cx,cy,rr,a,a+1.15);ctx.stroke()}
      }else if(Number(UnitDefinition.get(u.type)?.cloakAuraRadius)>0&&sc>.18){
        const md=UnitDefinition.get(u.type),radius=(md.cloakAuraRadius||210)*sc;
        const rp=this.renderTrackedPosition(u,"unit"),q=this.worldToPx(this.viewX(rp.x),this.viewY(rp.y)),cx=q[0],cy=q[1],phase=now*.0007+(HashUtil.hash(u.id)%79);
        ctx.globalAlpha=.10;ctx.strokeStyle="#a9dce8";ctx.lineWidth=Math.max(1,1.4*sc);ctx.beginPath();ctx.arc(cx,cy,radius,0,Math.PI*2);ctx.stroke();
        for(let k=0;k<5;k++){const a=phase+k*Math.PI*.4,rr=radius*(.48+.09*(k%3));ctx.globalAlpha=.09;ctx.strokeStyle=k%2?"#c4eaf1":"#8fcbd9";ctx.lineWidth=Math.max(2,3.4*sc);ctx.beginPath();ctx.arc(cx,cy,rr,a,a+.9);ctx.stroke()}
      }else if(Number(UnitDefinition.get(u.type)?.interceptRadius)>0&&sc>.18){
        const ad=UnitDefinition.get(u.type),up=!!snap.abilities?.[u.side]?.[u.type];
        const radius=(up?(ad.abilityInterceptRadius||225):(ad.interceptRadius||175))*sc;
        const cost=up?(ad.abilityInterceptManaCost||100):(ad.interceptManaCost||200),charged=(Number(u.resources.mana)||0)>=cost,manaRatio=RangeUtil.clamp((Number(u.resources.mana)||0)/Math.max(1,Number(u.resources.manaMax)||250),0,1);
        ctx.globalAlpha=charged?(.18+.16*manaRatio):.08;ctx.strokeStyle=charged?"#6fdcff":"#5f7486";ctx.lineWidth=Math.max(1,1.5*sc);
        ctx.beginPath();ctx.arc(x,y,radius,0,Math.PI*2);ctx.stroke();
      }
    }
    ctx.restore();
  }

  drawWorldHudOverlay(){
    const ctx=this.fxCtx,snap=this.snapshot;
    if(!ctx||!this.fxCanvas||!snap)return;
    const side=this.mySide(),sc=this.sc(),now=performance.now();

    ctx.save();
    ctx.lineCap="round";
    ctx.lineJoin="round";

    // Single-owner invariant for building status bars:
    // building HP is drawn ONLY here, never inside drawBuilding(). This pass stays
    // above combat VFX so explosions/debris can never cover persistent information.
    for(const b of snap.buildings||[]){
      if(b.alive===false)continue;
      const own=b.side===side;
      if(!own&&!this.visibleRaw(b.x,b.y))continue;
      if(!this.onScreenAuth(b.x,b.y,(BuildingDefinition.get(b.type)?.size||40)+100))continue;
      const d=BuildingDefinition.get(b.type)||{size:35,buildTime:1};
      const anchor=RallyGamekit.resolveAnchorInto(this.stableCamera(),{space:'world',
        x:this.viewX(b.x),y:this.viewY(b.y),z:this.world.terrain.surfaces.heightAt(b.x,b.y)},{});
      const {x,y}=anchor,r=d.size*sc;

      if(!b.complete){
        const q=RangeUtil.clamp((b.progress||0)/Math.max(1,SimulationTiming.msToTicks(d.buildTimeMs,this.snapshot?.tps||SIM_TPS)),0,1);
        const bw=r*2,bh=Math.max(3,4*sc),by=y+r+3*sc;
        ctx.fillStyle="rgba(18,24,28,.72)";ctx.fillRect(x-r-1*sc,by-1*sc,bw+2*sc,bh+2*sc);
        ctx.fillStyle=b.constructionState==="building"?"#f2b53b":"#8b97a3";ctx.fillRect(x-r,by,bw*q,bh);
      }else if(b.hp<b.maxHp){
        const ratio=RangeUtil.clamp((b.hp||0)/Math.max(1,b.maxHp||1),0,1);
        const bw=r*2,bh=Math.max(2.4,3.2*sc),by=y+r+3*sc;
        ctx.fillStyle="rgba(18,24,28,.72)";ctx.fillRect(x-r-1*sc,by-1*sc,bw+2*sc,bh+2*sc);
        ctx.fillStyle=ratio>.48?"#62c775":"#f04d49";ctx.fillRect(x-r,by,bw*ratio,bh);
      }

      // Production progress is gameplay information, not decoration. Keep it on the
      // same stable HUD layer regardless of how many combat effects are active.
      if(own&&b.complete&&BuildingDefinition.get(b.type)?.isProductionBuilding){
        const q=b.queue?.[0]?.productionBatch?b.queue[0]:null;
        if(q){
          const total=Math.max(1,Number(q.total)||1);
          const remaining=SimulationTiming.queueRemainingTicks(q,this.snapshot?.tick||0);
          const prog=RangeUtil.clamp(1-remaining/total,0,1);
          const bw=Math.max(32,52*sc),bh=Math.max(5,7*sc),by=y+r+9*sc;
          ctx.fillStyle="rgba(7,10,13,.90)";ctx.fillRect(x-bw/2,by,bw,bh);
          ctx.fillStyle=remaining<=0?"#ed971e":"#3496ef";ctx.fillRect(x-bw/2+1,by+1,Math.max(0,(bw-2)*prog),Math.max(1,bh-2));
        }
      }
    }

    // Aegis basic attack link: authoritative last-hit target is kept across snapshot boundaries.
    // This avoids missing the cable when transient attackFlash/u.target changes between 10 Hz snapshots.
    for(const u of snap.units||[]){
      const arcTargetId=u?.combat.attackArcTargetId;
      if(!u?.alive||!arcTargetId||(snap.tick||0)>(u.combat.attackArcUntilTick||0))continue;
      const own=u.side===side;
      if(!own&&!this.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR"))continue;
      const targetUnit=(snap.units||[]).find(t=>t.id===arcTargetId&&t.alive);
      const targetBuilding=targetUnit?null:(snap.buildings||[]).find(b=>b.id===arcTargetId&&b.alive!==false);
      const target=targetUnit||targetBuilding;if(!target)continue;
      if(targetUnit){
        const targetOwn=targetUnit.side===side,cloaked=this.snapshotStealthed(targetUnit),detected=targetOwn||this.detectedRaw(targetUnit.x,targetUnit.y);
        if(!targetOwn&&(!this.visibleRaw(targetUnit.x,targetUnit.y)||(cloaked&&!detected)))continue;
      }else if(targetBuilding.side!==side&&!this.visibleRaw(targetBuilding.x,targetBuilding.y))continue;
      const tp=targetUnit
        ?this.projectRenderWorldPosition(this.resolveRenderWorldPosition(targetUnit,"unit"))
        :(()=>{const q=this.worldToPx(this.viewX(targetBuilding.x),this.viewY(targetBuilding.y));return{x:q[0],y:q[1]}})();
      const pulse=.82+.18*Math.sin(now*.038+(HashUtil.hash(u.id)%97)),node=this.aegisShellNodeScreen(u,tp.x,tp.y);
      this.commonEffectPool.drawElectricArc(ctx,{x:node.x,y:node.y},{x:tp.x,y:tp.y},{
        seed:HashUtil.hash(`${u.id}|${arcTargetId}`),time:now/1000,color:"#55d7ff",alpha:.72*pulse,scale:sc,width:2.8
      });
      this.commonEffectPool.drawElectricArc(ctx,{x:node.x,y:node.y},{x:tp.x,y:tp.y},{
        seed:HashUtil.hash(`${u.id}|${arcTargetId}|core`),time:now/1000,color:"#efffff",alpha:.96*pulse,scale:sc,width:1.15
      });
    }

    // Single-owner invariant for unit status bars:
    // HP/Mana are drawn ONLY in this HUD pass, never inside drawUnit().
    // This keeps one stable information layer across AIR height, leap/airborne motion,
    // Render State interpolation and future body-render passes.
    for(const u of snap.units||[]){
      const hasMana=(Number(u.resources.manaMax)||0)>0;
      const maxHp=Math.max(1,Number(u.maxHp)||1);
      const showHp=(Number(u.hp)||0)<maxHp;
      if(!u.alive||(!showHp&&!hasMana))continue;
      const own=u.side===side,d=UnitDefinition.get(u.type)||{};
      const cloaked=this.snapshotStealthed(u);
      const detected=own?true:this.detectedRaw(u.x,u.y);
      if(!own&&(!this.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR")||(cloaked&&!detected)))continue;
      if(!this.onScreenAuth(u.x,u.y,(d.size||15)+100))continue;

      const wp=this.resolveRenderWorldPosition(u,"unit");
      const projected=this.projectRenderWorldPosition(wp);
      const x=projected.x,y=projected.y;
      const r=this.unitRenderRadius(u);
      const bw=r*2.2,bh=Math.max(2.2,3.2*sc);
      const airUnit=d.layer==="AIR";
      const barLift=airUnit?1.90:1.58;
      const baseY=y-r*barLift;

      let nextY=baseY;
      if(showHp){
        const ratio=RangeUtil.clamp((Number(u.hp)||0)/maxHp,0,1);
        ctx.fillStyle="rgba(7,10,12,.72)";
        ctx.fillRect(x-bw/2-1*sc,nextY-1*sc,bw+2*sc,bh+2*sc);
        ctx.fillStyle=ratio>.48?"#6fdf63":"#f34d47";
        ctx.fillRect(x-bw/2,nextY,bw*ratio,bh);
        nextY+=bh+Math.max(2,2.2*sc);
      }

      // Mana is a separate blue resource bar. Full-health mana units show only mana,
      // so a resource bar can never be mistaken for a duplicate green health bar.
      if(hasMana){
        const manaRatio=RangeUtil.clamp((Number(u.resources.mana)||0)/Math.max(1,Number(u.resources.manaMax)||1),0,1);
        const mh=Math.max(1.8,2.5*sc),my=nextY;
        ctx.fillStyle="rgba(7,10,18,.78)";
        ctx.fillRect(x-bw/2-1*sc,my-1*sc,bw+2*sc,mh+2*sc);
        ctx.fillStyle="#3f8cff";
        ctx.fillRect(x-bw/2,my,bw*manaRatio,mh);
        if(own&&sc>.22){
          ctx.font=`800 ${Math.max(7,8.5*sc)}px system-ui,-apple-system,"Segoe UI",sans-serif`;
          ctx.textAlign="left";ctx.textBaseline="middle";ctx.lineWidth=Math.max(1,1.7*sc);
          const label=`${Math.round(Number(u.resources.mana)||0)}/${Math.round(Number(u.resources.manaMax)||0)}`;
          ctx.strokeStyle="rgba(5,18,45,.92)";ctx.strokeText(label,x+bw/2+3*sc,my+mh*.50);
          ctx.fillStyle="#80b8ff";ctx.fillText(label,x+bw/2+3*sc,my+mh*.50);
        }
      }
    }

    ctx.restore();
  }

  drawSelectedBuildingOverlay(){
    const ctx=this.fxCtx,snap=this.snapshot,id=this.selectedBuildingId;
    if(!ctx||!snap||!id)return;
    const side=this.mySide(),b=[...(snap.buildings||[]),...(snap.constructionOrders||[])].find(x=>x.id===id&&x.alive!==false&&x.side===side);
    if(!b||!this.onScreenAuth(b.x,b.y,(BuildingDefinition.get(b.type)?.size||40)+100))return;
    const sc=this.sc(),[x,y]=this.worldToPx(this.viewX(b.x),this.viewY(b.y));
    const r=(BuildingDefinition.get(b.type)?.size||35)*sc*1.06,m=Math.max(4,8*sc),lw=Math.max(1.8,2.8*sc);
    ctx.save();ctx.globalAlpha=.98;ctx.strokeStyle="#ffd75f";ctx.lineWidth=lw;ctx.lineCap="round";
    ctx.beginPath();
    ctx.moveTo(x-r,y-r+m);ctx.lineTo(x-r,y-r);ctx.lineTo(x-r+m,y-r);
    ctx.moveTo(x+r-m,y-r);ctx.lineTo(x+r,y-r);ctx.lineTo(x+r,y-r+m);
    ctx.moveTo(x-r,y+r-m);ctx.lineTo(x-r,y+r);ctx.lineTo(x-r+m,y+r);
    ctx.moveTo(x+r-m,y+r);ctx.lineTo(x+r,y+r);ctx.lineTo(x+r,y+r-m);
    ctx.stroke();ctx.restore();
  }

  drawObjectivePersistentFx(){
    const ctx=this.fxCtx,snap=this.snapshot;if(!ctx||!snap)return;
    const sc=this.sc();
    ctx.save();ctx.lineCap="round";ctx.lineJoin="round";

    // Death Worm normal movement: subtle ground-only dirt pressure, much weaker than burrowTrail.
    for(const u of snap.units||[]){
      if(!u?.alive||!UnitVisualDefinition.get(u.type)?.movingGroundDust||u.burrowPhase==="dive"||u.burrowPhase==="travel")continue;
      if((snap.tick-(Number(u.movement.lastMoveTick)||-999999))>3)continue;
      if(!this.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR")&&u.side!==this.mySide())continue;
      const delta=this.renderTrackedDelta(u,"unit");
      let dx=delta.x,dy=delta.y,len=Math.hypot(dx,dy);if(len<.05)continue;dx/=len;dy/=len;
      const ground=this.projectRenderWorldPosition(this.resolveGroundShadowPosition(u,"unit"));
      const dir=this.renderTrackedDirectionScreen(u,dx,dy,"unit");
      let fx=dir.x,fy=dir.y,fl=Math.hypot(fx,fy)||1;fx/=fl;fy/=fl;const sx=-fy,sy=fx;
      const phase=(performance.now()*.004+(HashUtil.hash(u.id)%101)*.017)%1;
      for(let k=0;k<4;k++){
        const q=(k+phase)/4,back=(10+24*q)*sc,side=((k%2?1:-1)*(5+5*q))*sc;
        const px=ground.x-fx*back+sx*side,py=ground.y-fy*back+sy*side;
        ctx.globalAlpha=(1-q)*.18;ctx.fillStyle=k%2?"#8d6b3e":"#6f542f";ctx.beginPath();ctx.arc(px,py,Math.max(1.8,(3.6-1.2*q)*sc),0,Math.PI*2);ctx.fill();
      }
      ctx.globalAlpha=.12;ctx.strokeStyle="#9a7a48";ctx.lineWidth=Math.max(1.2,2.2*sc);ctx.beginPath();ctx.arc(ground.x+fx*6*sc,ground.y+fy*6*sc,Math.max(5,10*sc),0,Math.PI);ctx.stroke();
    }

    for(const u of snap.units||[]){
      const breathUnit=Number(UnitDefinition.get(u?.type)?.breathRange)>0;
      if(!u?.alive||!breathUnit||(u.objectiveBreathPhase!==OBJECTIVE_DRAGON_BREATH_PHASE.TELL&&u.objectiveBreathPhase!==OBJECTIVE_DRAGON_BREATH_PHASE.ACTIVE))continue;
      if(!this.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR")&&u.side!==this.mySide())continue;

      const d=UnitDefinition.get(u.type)||{},bp=this.projectEntityScreen(u,"unit"),r=this.unitRenderRadius(u);
      const dx=Number(u.objectiveBreathDirX)||0,dy=Number(u.objectiveBreathDirY)||0,len=Math.hypot(dx,dy)||1,nx=dx/len,ny=dy/len;
      let mouth;
      if(UnitVisualDefinition.get(u.type)?.breathMouth==="dragon"){
        mouth=this.resolveDragonRenderPose(u,bp.x,bp.y,r).mouth;
      }else{
        const dir=this.renderTrackedDirectionScreen(u,nx,ny,"unit");
        mouth=[bp.x+dir.x*r*.62,bp.y+dir.y*r*.62];
      }

      const range=d.breathRange||d.range||150,half=(d.breathAngleDeg||30)*Math.PI/360;
      const breathVisual=UnitVisualDefinition.get(u.type)||{},breathPreset=breathVisual.breathVfxPreset||"fireBreath",breathTellColor=breathVisual.breathTellColor||"#ffe075";

      if(u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL){
        // Telegraph only at the mouth. Do not draw a cone/triangle that duplicates
        // the breath footprint; the active particle VFX itself communicates reach.
        const pulse=.5+.5*Math.sin(performance.now()*.025+(HashUtil.hash(u.id)%77));
        ctx.globalAlpha=.85;ctx.fillStyle=breathTellColor;
        ctx.beginPath();ctx.arc(mouth[0],mouth[1],Math.max(3,(6+4*pulse)*sc),0,Math.PI*2);ctx.fill();
        continue;
      }

      this.commonEffectPool.touchFireEmitter(`${breathPreset}-breath:${u.id}`,{
        preset:breathPreset,
        centerX:u.x,centerY:u.y,mouthX:mouth[0],mouthY:mouth[1],
        dirX:nx,dirY:ny,range,halfAngle:half,scale:sc
      });
    }

    // Basic-attack breath variants are instantaneous simulation attacks, but their
    // presentation persists briefly so the shared particle emitter reads as a breath.
    const breathNow=performance.now();
    this.attackVariantBreathFx=this.attackVariantBreathFx.filter(f=>breathNow-f.start<f.duration);
    for(const f of this.attackVariantBreathFx){
      const source=(snap.units||[]).find(u=>u.id===f.sourceId&&u.alive);
      const sx=source?.x??f.x,sy=source?.y??f.y;
      if(!this.visibleRaw(sx,sy)&&source?.side!==this.mySide())continue;
      const bp=source?this.projectEntityScreen(source,"unit"):null;
      const rr=source?this.unitRenderRadius(source):8*sc;
      const dx=Number(f.dirX)||1,dy=Number(f.dirY)||0,len=Math.hypot(dx,dy)||1,nx=dx/len,ny=dy/len;
      let mouth;
      if(source){
        const dir=this.renderTrackedDirectionScreen(source,nx,ny,"unit");
        mouth=[bp.x+dir.x*rr*.62,bp.y+dir.y*rr*.62];
      }else{
        mouth=this.worldToPx(this.viewX(sx),this.viewY(sy));
      }
      this.commonEffectPool.touchFireEmitter(`attack-variant-breath:${f.id}`,{
        preset:f.preset||"fireAntBreath",centerX:sx,centerY:sy,mouthX:mouth[0],mouthY:mouth[1],
        dirX:nx,dirY:ny,range:f.range||150,halfAngle:(f.angleDeg||30)*Math.PI/360,scale:sc
      });
    }
    ctx.restore();
  }

  drawFloatingFx(){
    const ctx=this.fxCtx;
    if(!ctx||!this.fxCanvas)return;

    ctx.clearRect(0,0,this.fxCanvas.width,this.fxCanvas.height);

    // Stable presentation order. It never changes with unit count:
    // world annotations -> decorative combat VFX -> persistent world HUD -> numbers -> status/selection.
    this.drawStrategicLabels();
    this.drawCampRangeLabels();

    // Decorative presentation is always below information overlays.
    this.commonEffectPool.beginFrame(performance.now());
    this.drawClientCombatFx();
    this.drawObjectivePersistentFx();
    this.commonEffectPool.drawFire(ctx);
    this.commonEffectPool.endFrame();

    // Persistent information is never hidden by combat density.
    this.drawProductionBuildingEmblems();
    this.drawWorldHudOverlay();

    const now=performance.now();
    let write=0;

    for(let read=0;read<this.floatFx.length;read++){
      const f=this.floatFx[read],age=now-f.start,preset=FloatingTextPresentationDefinition.get(f.kind);
      const life=preset.lifeMs;
      if(age>=life){this.floatFxPool.release(f);continue}

      const t=age/life;
      const viewX=this.viewX(f.x),viewY=this.viewY(f.y);
      let[x,y]=this.worldToPx(viewX,viewY);

      // Combat numbers are a subordinate information layer. Low alpha means dense
      // overlaps naturally become more legible/darker without explicit aggregation.
      x+=f.jitter*this.sc();
      y-=((14+(f.lane||0)*7)+preset.rise*t)*this.sc();

      if(x<-100||x>this.fxCanvas.width+100||y<-100||y>this.fxCanvas.height+100){
        this.floatFx[write++]=f;
        continue;
      }

      const fade=(t<.62?1:Math.max(0,1-(t-.62)/.38))*preset.alpha;
      const pop=t<.12?(0.90+t/.12*(preset.pop-.90)):preset.pop-(t-.12)*.04;
      const fontSize=Math.max(preset.minSize,preset.baseSize*this.sc()*pop);

      let fill="#ffd36a",stroke="#503400";
      if(f.kind==="damageTaken"){fill="#ff6b6b";stroke="#4b0909"}
      else if(f.kind==="damageDealt"){fill="#fff0c2";stroke="#6d2c12"}
      else if(f.kind==="heal"){fill="#74e69a";stroke="#123b21"}
      else if(f.kind==="manaSpend"){fill="#65a9ff";stroke="#102e63"}
      else if(f.kind==="dodge"){fill="#d7e9ff";stroke="#1a3d64"}

      ctx.save();
      ctx.font=`800 ${fontSize}px system-ui,-apple-system,"Segoe UI",sans-serif`;
      ctx.textAlign="center";
      ctx.textBaseline="middle";
      ctx.lineJoin="round";
      ctx.lineWidth=Math.max(1,2*this.sc());
      ctx.globalAlpha=fade*preset.strokeAlpha;
      ctx.strokeStyle=stroke;
      ctx.strokeText(f.text,x,y);
      ctx.globalAlpha=fade;
      ctx.fillStyle=fill;
      ctx.fillText(f.text,x,y);
      ctx.restore();

      this.floatFx[write++]=f;
    }

    this.floatFx.length=write;

    // Strategic status and selection are the final world-space UI layer.
    // They remain readable even when an explosion happens on the same pixel.
    this.drawCombatReadabilityOverlay();
    this.drawSelectedBuildingOverlay();
  }

  replayVisionSides(){
    if(this.replayVisionMode==="union")return[0,1];
    if(this.replayVisionMode==="guest")return[1];
    if(this.replayVisionMode==="host")return[0];
    return[this.mySide()];
  }
  visibleRaw(x,y,targetAir=false){
    if(this.replayObserverAll)return true;
    if(!this.snapshot)return false;
    const targetLevel=targetAir?null:this.world.terrain.surfaces.levelAt(x,y);
    for(const side of this.replayVisionSides())if(this.visionFields[side]?.visibleAt(x,y,targetAir,targetLevel))return true;
    return false;
  }
  detectedRaw(x,y,targetAir=false){
    if(this.replayObserverAll||this.replayVisionMode==="union")return true;
    if(!this.snapshot)return false;
    const targetLevel=targetAir?null:this.world.terrain.surfaces.levelAt(x,y);
    for(const side of this.replayVisionSides())if(this.visionFields[side]?.detectedAt(x,y,targetAir,targetLevel))return true;
    return false;
  }

  snapshotStealthed(u){
    return !!u&&u.alive!==false&&(
      BurrowableMixin.stateActive(u)||
      !!UnitDefinition.get(u.type)?.stealth||this.snapshotCloakedIds.has(u.id)
    );
  }

  drawStrategicMap(){
    if(!this.snapshot)return;
    const sc=this.sc();
    const laneDefs=[
      {id:"top",col:[.35,.62,.90,.13]},
      {id:"mid",col:[.94,.76,.28,.15]},
      {id:"bot",col:[.48,.78,.42,.13]}
    ];

    const mapDesc=this.snapshot.mapDescriptor||null;
    const lanePoints=mapDesc?.laneControlPoints||LANE_CONTROL_POINTS;
    for(const lane of laneDefs){
      const pts=lanePoints[lane.id].map(p=>this.worldToPx(this.viewX(p.x),this.viewY(p.y)));
      for(let i=0;i<pts.length-1;i++){
        this.line(pts[i][0],pts[i][1],pts[i+1][0],pts[i+1][1],Math.max(26,58*sc),lane.col);
      }
    }

    for(const cp of this.snapshot.capturePoints||[]){
      const[x,y]=this.worldToPx(this.viewX(cp.x),this.viewY(cp.y));
      const rr=Math.max(20,CAPTURE_RADIUS*sc);
      const base=cp.owner!=null
        ?this.factionColor(cp.owner,{alpha:.18})
        :(cp.enabled?[.95,.73,.25,.16]:[.42,.47,.50,.10]);

      this.circle(x,y,rr,base,32);
      this.circle(
        x,y,Math.max(8,38*sc),
        cp.owner!=null
          ?this.factionColor(cp.owner,{alpha:.55})
          :(cp.enabled?[1,.78,.25,.48]:[.55,.58,.60,.32]),
        16
      );

      if(cp.owner==null&&cp.enabled&&cp.progress>0){
        const ratio=Math.min(1,cp.progress/SimulationTiming.msToTicks(CAPTURE_DURATION_MS,this.snapshot?.tps||SIM_TPS));
        this.circle(
          x,y,Math.max(7,30*sc),
          this.factionColor(cp.progressSide,{alpha:.18+ratio*.35}),
          16
        );
      }
    }
  }
  drawNeutralCampMarkers(){
    if(!this.snapshot)return;
    const sc=this.sc();

    for(const camp of this.snapshot.camps||[]){
      const cd=CampDefinition.get(camp.kind);
      if(!cd)continue;
      if(!this.onScreenAuth(camp.x,camp.y,NeutralCampPolicy.aggroRadius(camp)+120))continue;

      const[x,y]=this.worldToPx(this.viewX(camp.x),this.viewY(camp.y));
      const alive=camp.state==="alive";
      const gauge=RangeUtil.clamp((camp.aggroGauge||0)/(cd.aggroGaugeMax||1000),0,1);
      const resetting=!!camp.resetting;

      const objectiveKind=!!CampDefinition.get(camp.kind)?.mainObjective;
      const base=camp.kind==="objectiveBear"?[.55,.36,.16,.18]:
        camp.kind==="objectiveDeathWorm"?[.48,.58,.12,.18]:
        camp.kind==="objectiveDragon"?[.66,.20,.12,.18]:
        camp.kind==="toads"?[.34,.52,.20,.14]:
        camp.kind==="crabs"?[.52,.34,.20,.14]:
        camp.kind==="wasps"?[.58,.48,.18,.14]:
        camp.kind==="relic"?[.46,.31,.68,.13]:
        [.35,.28,.18,.12];
      const edge=camp.kind==="objectiveBear"?[.96,.68,.28,.42]:
        camp.kind==="objectiveDeathWorm"?[.78,.92,.22,.42]:
        camp.kind==="objectiveDragon"?[1,.42,.18,.42]:
        camp.kind==="toads"?[.72,.90,.40,.34]:
        camp.kind==="crabs"?[.92,.62,.30,.34]:
        camp.kind==="wasps"?[.96,.84,.38,.34]:
        camp.kind==="relic"?[.72,.50,.95,.30]:
        [.66,.50,.28,.26];
      const rr=(objectiveKind?112:camp.kind==="relic"?82:70)*sc;

      // 큰 원 하나: 어그로/활동 범위. 게이지가 찰수록 황금 -> 주황 -> 붉은색으로 강해진다.
      const aggroRangeCol=resetting
        ?[.40,.92,.48,.38]
        :[
          1,
          .76-.38*gauge,
          .22-.06*gauge,
          alive?(.25+.22*gauge):.10
        ];
      this.outlineCircle(
        x,y,NeutralCampPolicy.aggroRadius(camp)*sc,Math.max(1.2,1.9*sc),
        aggroRangeCol,72,0
      );

      // 작은 원: 원위치 복귀 완료 영역.
      const homeVisual=(cd.homeRadius+NeutralCampPolicy.homeSpread(camp))*sc;
      this.outlineCircle(
        x,y,homeVisual,Math.max(1,1.45*sc),
        resetting?[.38,.96,.52,.34]:[.82,.86,.72,.18],
        44,2
      );

      this.circle(x,y,rr,base,24);
      if(alive)this.circle(x,y,rr*.78,edge,20);

      if(resetting){
        const pulse=.5+.5*Math.sin(performance.now()*.008+(HashUtil.hash(camp.id)%100)*.1);
        this.circle(
          x,y,rr*(1.05+.14*pulse),
          [.35,.92,.45,.08+.05*pulse],
          22
        );
      }

      // 어그로 게이지를 바닥 레이어에 얇게 표시한다.
      const bw=Math.max(52,92*sc),bh=Math.max(3,6*sc);
      const gy=y-rr-18*sc;
      this.rect(x-bw/2,gy,bw,bh,[.08,.10,.11,.62]);
      const fill=resetting
        ?[.36,.92,.45,.85]
        :[1,.82-.60*gauge,.18-.08*gauge,.86];
      if(gauge>0)this.rect(x-bw/2,gy,bw*gauge,bh,fill);
    }
  }

  drawCampRangeLabels(){
    const ctx=this.fxCtx;
    if(!ctx||!this.snapshot)return;
    const sc=this.sc();

    ctx.save();
    const label=(text,x,y)=>{
      ctx.lineWidth=Math.max(2.5,3*sc);
      ctx.lineJoin="round";
      ctx.strokeStyle="rgba(12,24,18,.88)";
      ctx.strokeText(text,x,y);
      ctx.fillText(text,x,y);
    };
    ctx.textAlign="center";
    ctx.textBaseline="middle";
    ctx.font=`800 ${Math.max(10,11*sc)}px system-ui,-apple-system,"Segoe UI",sans-serif`;

    for(const camp of this.snapshot.camps||[]){
      const cd=CampDefinition.get(camp.kind);
      if(!cd)continue;
      if(!this.onScreenAuth(camp.x,camp.y,NeutralCampPolicy.aggroRadius(camp)+120))continue;

      const c=this.worldToPx(this.viewX(camp.x),this.viewY(camp.y));
      const mainObjective=!!CampDefinition.get(camp.kind)?.mainObjective;
      if(mainObjective&&camp.state==="captured"){
        ctx.fillStyle=this.factionCssColor(camp.capturedOwner,{alpha:.94});
        label(`${camp.laneKey?.toUpperCase()||""} 획득 · 해당 라인 자동 전진`,c[0],c[1]+Math.max(20,26*sc));
        continue;
      }
      if(mainObjective&&camp.state==="cooldown"){
        const sec=Math.max(0,Math.ceil(((camp.respawnAt||0)-(this.snapshot.tick||0))/(this.snapshot?.tps||SIM_TPS)));
        ctx.fillStyle="rgba(214,224,208,.82)";
        label(`${camp.laneKey?.toUpperCase()||""} 재생성 · ${sec}초`,c[0],c[1]+Math.max(20,26*sc));
        continue;
      }
      if(camp.state!=="alive")continue;
      const gauge=RangeUtil.clamp((camp.aggroGauge||0)/(cd.aggroGaugeMax||1000),0,1);
      const pct=Math.round(gauge*100);
      const markerRadius=!!CampDefinition.get(camp.kind)?.mainObjective?112:camp.kind==="relic"?82:70;
      const statusY=c[1]+Math.max(cd.homeRadius+NeutralCampPolicy.homeSpread(camp),markerRadius)*sc+Math.max(14,14*sc);

      ctx.fillStyle="rgba(255,207,84,.70)";
      label(cd.proactiveAggro?"어그로 범위 · 선공":"어그로 범위 · 피격 반응",c[0],c[1]-NeutralCampPolicy.aggroRadius(camp)*sc);

      ctx.fillStyle="rgba(205,224,190,.58)";
      label("원위치 · 복귀 완료",c[0],c[1]-(cd.homeRadius+NeutralCampPolicy.homeSpread(camp))*sc);

      if(camp.resetting){
        ctx.fillStyle="rgba(100,238,122,.90)";
        label("RESET · 귀환 + 회복",c[0],statusY);
      }else{
        ctx.fillStyle=pct>=70
          ?"rgba(255,91,70,.92)"
          :"rgba(255,207,84,.90)";
        label(`${camp.engaged?"교전":"대기"} · 어그로 ${pct}%`,c[0],statusY);
      }
      if(camp.spellReward){
        ctx.fillStyle="rgba(255,238,160,.92)";
        label("처치 → 전술상자 + 연결 거점 해금",c[0],statusY+Math.max(13,13*sc));
      }else if(mainObjective){
        ctx.fillStyle="rgba(255,239,180,.94)";
        label("막타 진영 합류 · 해당 라인 자동 푸시",c[0],statusY+Math.max(13,13*sc));
      }
    }

    ctx.restore();
  }

  drawActiveSpells(){
    if(!this.snapshot)return;
    const sc=this.sc(),nowTick=this.snapshot.tick,side=this.mySide();

    for(const sp of this.snapshot.activeSpells||[]){
      const own=sp.side===side;

      if(sp.type==="meteor"){
        const[x,y]=this.worldToPx(this.viewX(sp.x),this.viewY(sp.y));
        const remain=Math.max(0,(sp.executeTick||0)-nowTick);
        const ratio=1-Math.min(1,remain/((sp.executeTick||0)-(sp.startTick||0)||1));
        const pulse=.72+.28*Math.sin(performance.now()*.018);

        this.circle(x,y,(sp.radius||SpellDefinition.statsAt("meteor",0).radius)*sc,[1,.14,.05,.10+.13*ratio],36);
        this.circle(x,y,Math.max(10,(28+ratio*82)*sc),[1,.34,.08,.16*pulse],28);
        this.circle(x,y,Math.max(7,(14+ratio*22)*sc),[1,.72,.22,.18+.18*ratio],20);

        if(remain>0){
          const fall=ratio;
          const mx=x+(1-fall)*72*sc;
          const my=y-(1-fall)*260*sc;
          this.line(mx-62*sc,my-96*sc,mx,my,Math.max(4,13*sc),[1,.34,.08,.20+.38*fall]);
          this.circle(mx,my,Math.max(7,18*sc),[.95,.23,.06,.96],14);
          this.circle(mx-3*sc,my-3*sc,Math.max(4,9*sc),[1,.88,.48,.96],12);
        }

        this.line(x-22*sc,y,x+22*sc,y,Math.max(1.5,2.8*sc),[1,.72,.26,.88]);
        this.line(x,y-22*sc,x,y+22*sc,Math.max(1.5,2.8*sc),[1,.72,.26,.88]);
      }else if(sp.type==="tunnel"){
        const entryVisible=own||this.visibleRaw(sp.entryX,sp.entryY),exitVisible=own||this.visibleRaw(sp.exitX,sp.exitY);
        if(!entryVisible&&!exitVisible)continue;
        const a=this.worldToPx(this.viewX(sp.entryX),this.viewY(sp.entryY));
        const b=this.worldToPx(this.viewX(sp.exitX),this.viewY(sp.exitY));
        const active=nowTick>=sp.activateTick;
        const col=own?[.52,.32,.92,.82]:[.92,.28,.42,.78];
        const spin=performance.now()*.0038;

        const portal=(p,visible)=>{
          if(!visible)return;
          const rr=Math.max(12,40*sc);
          this.circle(p[0],p[1],rr,[.12,.07,.20,active?.58:.30],24);
          this.circle(p[0],p[1],rr*1.08,[col[0],col[1],col[2],active?.26:.14],24);
          for(let i=0;i<7;i++){
            const ang=spin+i/7*Math.PI*2;
            this.circle(
              p[0]+Math.cos(ang)*rr*.82,
              p[1]+Math.sin(ang)*rr*.55,
              Math.max(2,4*sc),
              [col[0],col[1],col[2],active?.92:.62],
              8
            );
          }
        };

        portal(a,entryVisible);
        portal(b,exitVisible);

        if(own&&entryVisible&&exitVisible){
          this.line(a[0],a[1],b[0],b[1],Math.max(1.2,2.2*sc),[col[0],col[1],col[2],.18]);
        }
      }else if(sp.type==="flare"&&own){
        const[x,y]=this.worldToPx(this.viewX(sp.x),this.viewY(sp.y));
        this.circle(x,y,(sp.vision||SpellDefinition.statsAt("flare",0).vision)*sc,[.35,.82,1,.07],40);
        this.circle(x,y,Math.max(8,30*sc),[.55,.92,1,.32],16);
      }else if(sp.type==="march"&&own){
        const[x,y]=this.worldToPx(this.viewX(sp.x),this.viewY(sp.y));
        this.circle(x,y,(sp.radius||SpellDefinition.statsAt("march",0).radius)*sc,[.35,.85,.45,.08],36);
      }else if(sp.type==="healspore"&&own){
        const[x,y]=this.worldToPx(this.viewX(sp.x),this.viewY(sp.y));const pulse=.5+.5*Math.sin(performance.now()*.008);
        this.circle(x,y,(sp.radius||0)*sc,[.30,.96,.55,.07+.05*pulse],36);this.circle(x,y,Math.max(10,28*sc),[.55,1,.72,.28],18);
      }else if(sp.type==="rootbind"){
        // Instant spell has no persistent active object.
      }else if(sp.type==="sporestorm"){
        const[x,y]=this.worldToPx(this.viewX(sp.x),this.viewY(sp.y));const pulse=.5+.5*Math.sin(performance.now()*.012);
        this.circle(x,y,(sp.radius||0)*sc,[.55,.30,.72,.08+.05*pulse],36);
      }else if(sp.type==="thornwall"){
        const[x,y]=this.worldToPx(this.viewX(sp.x),this.viewY(sp.y));
        this.circle(x,y,(sp.radius||0)*sc,[.35,.62,.20,.08],36);this.outlineCircle(x,y,(sp.radius||0)*sc,Math.max(1.5,2.5*sc),[.42,.75,.25,.65],36,1);
      }
    }
  }

  drawSpellPreview(){
    const p=this.spellPreview;
    if(!p)return;
    const sc=this.sc(),d=SpellDefinition.get(p.spellId);
    if(!d)return;
    const col=p.valid?[.25,.82,.50,.20]:[.92,.24,.24,.20];
    const edge=p.valid?[.25,.92,.58,.75]:[1,.26,.26,.78];

    if(p.spellId==="tunnel"){
      if(p.entry){
        const a=this.worldToPx(p.entry.x,p.entry.y);
        this.circle(a[0],a[1],Math.max(10,42*sc),[.48,.30,.90,.24],20);
        if(p.x!=null){
          const b=this.worldToPx(p.x,p.y);
          this.circle(b[0],b[1],Math.max(10,42*sc),col,20);
          this.line(a[0],a[1],b[0],b[1],Math.max(2,3*sc),edge);
        }
      }else if(p.x!=null){
        const b=this.worldToPx(p.x,p.y);
        this.circle(b[0],b[1],Math.max(10,42*sc),col,20);
      }
      return;
    }

    const[x,y]=this.worldToPx(p.x,p.y);
    const side=this.mySide(),entry=this.snapshot?.spellBooks?.[side]?.[p.spellId]||{mastery:0},sd=SpellDefinition.statsAt(p.spellId,entry.mastery||0);
    const rr=(sd?.radius!=null?sd.radius:70)*sc;
    this.circle(x,y,rr,col,32);
    this.circle(x,y,Math.max(8,28*sc),edge,18);
  }

  drawGroundGrid(){
    // The underlay grid belongs to the level-zero world plane. Its height and
    // phase must never come from terrain sampled at a moving viewport edge.
    const step=220,sc=this.sc(),vw=this.viewWorldW(),vh=this.viewWorldH(),
      guest=this.orientationRole()==='guest',
      phaseX=guest?this.world.width%step:0,phaseY=guest?this.world.height%step:0,
      point=(x,z)=>this.projectRenderWorldPosition({x:this.viewX(x),y:0,z:this.viewY(z),groundY:0});
    for(let y=Math.floor((this.cameraTop-phaseY)/step)*step+phaseY;y<=this.cameraTop+vh+step;y+=step){
      const a=point(this.cameraLeft,y),b=point(this.cameraLeft+vw,y);
      this.line(a.x,a.y,b.x,b.y,1,[1,1,1,.035]);
    }
    for(let x=Math.floor((this.cameraLeft-phaseX)/step)*step+phaseX;x<=this.cameraLeft+vw+step;x+=step){
      const a=point(x,this.cameraTop),b=point(x,this.cameraTop+this.canvas.height/sc);
      this.line(a.x,a.y,b.x,b.y,1,[1,1,1,.03]);
    }
  }
  drawGround(){
    const sc=this.sc(),vw=this.viewWorldW(),vh=this.viewWorldH(),ox=(this.canvas.width-vw*sc)/2;

    // Brighter low-detail grass base: clean enough for tiny units to read.
    this.rect(0,0,this.canvas.width,this.canvas.height,TerrainPresentation.colors.lowGround);

    // 자연스러운 큰 지면 색 덩어리
    for(const b of [
      {x:520,y:3520,r:500,c:[.55,.67,.53,.52]},
      {x:970,y:1350,r:470,c:[.61,.72,.57,.48]},
      {x:1810,y:2070,r:560,c:[.69,.75,.60,.40]},
      {x:2710,y:3100,r:520,c:[.58,.69,.54,.48]},
      {x:3020,y:820,r:450,c:[.65,.72,.58,.40]}
    ]){
      const p=this.worldToPx(this.viewX(b.x),this.viewY(b.y));
      this.circle(p[0],p[1],Math.max(90,b.r*sc),b.c,28);
    }

    this.drawGroundGrid();

    // TOP / MID / BOT 길은 밝은 흙길 느낌. 절차맵 descriptor를 그대로 사용한다.
    const mapDesc=this.snapshot?.mapDescriptor||null;
    const groundLanePoints=mapDesc?.laneControlPoints||LANE_CONTROL_POINTS;
    for(const lane of ((mapDesc?.terrain?.roads?.length)?[]:[
      {id:"top",col:[.88,.84,.67,.24]},
      {id:"mid",col:[.91,.86,.69,.23]},
      {id:"bot",col:[.87,.83,.66,.24]}
    ])){
      const pts=groundLanePoints[lane.id].map(
        p=>this.worldToPx(this.viewX(p.x),this.viewY(p.y))
      );
      for(let i=0;i<pts.length-1;i++){
        this.line(
          pts[i][0],pts[i][1],pts[i+1][0],pts[i+1][1],
          Math.max(38,96*sc),lane.col
        );
      }
    }

    const terrain=MapGeneration.mapTerrainDescriptor(mapDesc);
    // renderGroundPass owns depth writes here; avoid GPU state readbacks between batches.
    TerrainPresentation.drawWorld(this,terrain,true);
    TerrainPresentation.drawRiverSurfaces(this,mapDesc,true);
    TerrainPresentation.drawBridges(this,terrain,true);
  }
  drawMineral(m){
    if(m.amount<=0||!this.visibleRaw(m.x,m.y))return;
    const[x,y]=this.worldToPx(this.viewX(m.x),this.viewY(m.y));
    const sc=this.sc();
    const ratio=m.max?RangeUtil.clamp(m.amount/m.max,.15,1):1;
    const r=15*sc*(.72+.28*ratio);
    const edge=[.10,.25,.34,1];
    const blue=[.20,.69,.94,1];
    const light=[.62,.91,1,1];

    // florr-like readable cluster: dark rocky base + five simple crystals.
    this.circle(x,y+r*.42,r*.92,[.10,.15,.18,.34],10);
    this.poly([
      [x-r*.92,y+r*.44],[x-r*.50,y+r*.14],
      [x-r*.12,y+r*.34],[x+r*.22,y+r*.06],
      [x+r*.88,y+r*.40],[x+r*.56,y+r*.70],
      [x-r*.60,y+r*.70]
    ],edge);

    const shard=(sx,sy,rr,flip=1)=>{
      this.poly([
        [sx,sy-rr],
        [sx+rr*.54,sy-rr*.10],
        [sx+rr*.34,sy+rr*.78],
        [sx-rr*.34,sy+rr*.78],
        [sx-rr*.54,sy-rr*.10]
      ],blue);
      this.poly([
        [sx,sy-rr*.82],
        [sx+rr*.25,sy-rr*.08],
        [sx,sy+rr*.46],
        [sx-rr*.18,sy-rr*.06]
      ],light);
    };

    shard(x-r*.46,y+r*.02,r*.55);
    shard(x,y-r*.18,r*.78);
    shard(x+r*.50,y+r*.06,r*.50);
    shard(x-r*.12,y+r*.27,r*.42);
    shard(x+r*.28,y+r*.30,r*.34);
  }

  drawGasNode(g){
    if(!this.visibleRaw(g.x,g.y))return;
    const[x,y]=this.worldToPx(this.viewX(g.x),this.viewY(g.y));
    const sc=this.sc();
    const ratio=g.max?RangeUtil.clamp(g.amount/g.max,0,1):0;
    const depleted=ratio<=0;
    const r=Math.max(7,17*sc);
    const rock=depleted?[.28,.31,.27,1]:[.24,.28,.25,1];
    const gas=depleted?[.43,.58,.39,.72]:[.35,.88,.42,.92];
    const glow=depleted?[.58,.70,.53,.46]:[.70,1,.62,.72];

    this.circle(x,y+r*.40,r*.96,[.08,.12,.09,.30],10);
    this.poly([
      [x-r*.94,y+r*.42],[x-r*.62,y-r*.12],
      [x-r*.18,y-r*.32],[x+r*.20,y-r*.24],
      [x+r*.78,y-r*.02],[x+r*.96,y+r*.48],
      [x+r*.42,y+r*.72],[x-r*.58,y+r*.70]
    ],rock);

    // Big simple gas bubbles are readable at mobile scale.
    this.circle(x-r*.28,y-r*.22,r*.34,gas,10);
    this.circle(x+r*.16,y-r*.48,r*.42,gas,10);
    this.circle(x+r*.45,y-r*.08,r*.27,gas,10);
    this.circle(x+r*.08,y-r*.52,r*.14,glow,8);
    this.circle(x-r*.37,y-r*.28,r*.10,glow,8);
  }

  constructionMotion(id){
    const seed=(HashUtil.hash(String(id||"construction"))%997)/997;
    const raw=performance.now()/560+seed;
    const phase=raw-Math.floor(raw);
    const cycleIndex=Math.floor(raw);
    let crouch=0,drive=0,pull=0,recoil=0,impact=0;
    if(phase<.18)crouch=phase/.18;
    else if(phase<.34){const t=(phase-.18)/.16;crouch=1-t*.35;drive=t}
    else if(phase<.46){const t=(phase-.34)/.12;drive=1-t;pull=t;impact=1-Math.abs(t-.28)/.28;impact=RangeUtil.clamp(impact,0,1)}
    else if(phase<.68){const t=(phase-.46)/.22;pull=1-t*.25;recoil=t}
    else if(phase<.82){const t=(phase-.68)/.14;recoil=1-t}
    const lateral=((cycleIndex&1)?1:-1)*(0.45+((HashUtil.hash(String(id)+"|foot|"+cycleIndex)>>>3)%100)/180);
    return{phase,crouch,drive,pull,recoil,impact,lateral};
  }
drawConstructionStage(b,x,y,r,own,teamCap,teamHi,shell,stone,sc,q,motion){
    const d=BuildingDefinition.get(b.type);
    const root=[.30,.55,.22,1],rootHi=[.52,.78,.34,1],wood=[.42,.31,.18,1];
    const stage=q<.10?0:q<.30?1:q<.70?2:3;
    const pulse=motion?.impact||0;

    // Every unfinished building starts as a deliberately readable ruin/foundation,
    // then crosses visually distinct 10 / 30 / 70 percent silhouettes.
    this.circle(x+2*sc,y+r*.58,r*.96,[.04,.07,.08,.18],12);
    this.circle(x,y+r*.12,r*.70,[.12,.15,.15,1],12);

    for(let k=0;k<6;k++){
      const a=(k/6)*Math.PI*2+(HashUtil.hash(b.id)%17)*.03;
      const rr=r*(.43+(k%2)*.12);
      const px=x+Math.cos(a)*rr,py=y+r*.18+Math.sin(a)*rr*.50;
      const s=r*(.10+(k%3)*.025);
      this.poly([[px-s,py+s*.5],[px-s*.35,py-s],[px+s,py-s*.25],[px+s*.55,py+s*.75]],k%2?wood:stone);
    }

    if(stage>=1){
      for(let k=0;k<5;k++){
        const a=-Math.PI*.88+k*Math.PI*.44;
        const len=r*(.48+.07*(k%2));
        this.line(x,y+r*.18,x+Math.cos(a)*len,y+r*.18+Math.sin(a)*len*.52,Math.max(1.3,2.2*sc),root);
      }
      this.circle(x,y+r*.03,r*(.24+.03*pulse),[.34,.54,.24,1],10);
      this.petalRing(x,y-r*.04,r*.18,4,rootHi,Math.PI/4,.62);
    }

    if(stage>=2){
      // Mid-build rib/scaffold makes the footprint read as an intentional building,
      // not rubble. The top marker hints at the future building role.
      for(const sx of [-.46,-.18,.18,.46]){
        this.line(x+r*sx,y+r*.36,x+r*sx*.70,y-r*.44,Math.max(1.2,1.9*sc),wood);
      }
      this.line(x-r*.52,y-r*.10,x+r*.52,y-r*.10,Math.max(1.4,2.1*sc),wood);
      this.line(x-r*.40,y-r*.38,x+r*.40,y-r*.38,Math.max(1.4,2.1*sc),wood);

      if(BuildingDefinition.isDefenseTower(b.type)){
        this.line(x,y-r*.36,x,y-r*.92,Math.max(2.0,3.2*sc),root);
        this.crestTriangle(x,y-r*1.02,r*.15,teamHi,-Math.PI/2);
      }else if(BuildingDefinition.get(b.type)?.isGasExtractor){
        this.circle(x,y-r*.34,r*.22,[.39,.90,.46,1],9);
      }else if(d.visualCategory==="supply"){
        this.circle(x-r*.24,y-r*.28,r*.18,teamCap,8);this.circle(x+r*.24,y-r*.28,r*.18,teamCap,8);
      }else if(d.visualCategory==="airIncubator"){
        this.poly([[x-r*.18,y-r*.28],[x-r*.58,y-r*.54],[x-r*.46,y-r*.12]],rootHi);
        this.poly([[x+r*.18,y-r*.28],[x+r*.58,y-r*.54],[x+r*.46,y-r*.12]],rootHi);
        this.circle(x,y-r*.42,r*.18,[.46,1,.62,.76],9);
      }else if(Array.isArray(BuildingDefinition.get(b.type)?.constructionCoreColor)){
        this.circle(x,y-r*.44,r*.20,BuildingDefinition.get(b.type).constructionCoreColor,9);
      }else{
        const vd=UnitVisualDefinition.get(b.produceType)||null;
        this.circle(x,y-r*.44,r*.18,vd?.accent||teamCap,9);
        this.petalRing(x,y-r*.44,r*.28,5,teamCap,0,.48);
      }
    }

    // Worker strike feedback is intentionally presentation-only.
    if(pulse>0){
      this.circle(x,y+r*.12,r*(.50+.24*pulse),[.55,.86,.30,.08*(1-pulse*.35)],16);
      for(let k=0;k<5;k++){
        const a=-Math.PI*.92+k*Math.PI*.46;
        const len=r*(.34+.36*pulse);
        this.line(x,y+r*.22,x+Math.cos(a)*len,y+r*.22+Math.sin(a)*len*.48,Math.max(1,1.6*sc),[.55,.82,.30,.62*(1-pulse*.45)]);
      }
      for(let k=0;k<4;k++){
        const h=HashUtil.hash(b.id+"|buildDust|"+k);
        const a=Math.PI+((h%1000)/1000-.5)*1.5;
        const dist=r*(.24+.42*pulse+((h>>>8)%100)/500);
        const px=x+Math.cos(a)*dist,py=y+r*.30+Math.sin(a)*dist*.44;
        this.circle(px,py,Math.max(1.2,r*(.045+.02*(k%2))*(1-pulse*.35)),[.72,.58,.32,.64*(1-pulse*.55)],7);
      }
    }

    if(own&&this.selectedBuildingId===b.id){
      const rr=r*1.28,m=Math.max(3,7*sc),lw=Math.max(1.5,2.5*sc),ec=[1,.78,.26,.95];
      this.circle(x,y,rr,[1,.72,.20,.20],24);
      this.line(x-r,y-r,x-r+m,y-r,lw,ec);this.line(x-r,y-r,x-r,y-r+m,lw,ec);
      this.line(x+r,y-r,x+r-m,y-r,lw,ec);this.line(x+r,y-r,x+r,y-r+m,lw,ec);
      this.line(x-r,y+r,x-r+m,y+r,lw,ec);this.line(x-r,y+r,x-r,y+r-m,lw,ec);
      this.line(x+r,y+r,x+r-m,y+r,lw,ec);this.line(x+r,y+r,x+r,y+r-m,lw,ec);
    }
    this.rect(x-r,y+r+3*sc,r*2,4*sc,[.12,.16,.18,.3]);
    this.rect(x-r,y+r+3*sc,r*2*q,4*sc,[.95,.70,.23,1]);
    return stage<3;
  }

  drawBuilding(b){
    if(BuildingDefinition.get(b.type)?.isTerrainBarrier)return TerrainPresentation.drawBarrier(this,b);
    const own=this.isFriendlySide(b.side);
    if(!own&&!this.visibleRaw(b.x,b.y))return;
    const[x,y]=this.worldToPx(this.viewX(b.x),this.viewY(b.y)),sc=this.sc(),d=BuildingDefinition.get(b.type);
    const buildQ=b.complete?1:RangeUtil.clamp((b.progress||0)/Math.max(1,SimulationTiming.msToTicks(d.buildTimeMs,this.snapshot?.tps||SIM_TPS)),0,1);
    const builder=b.builderUnitId?this.snapshot?.units?.find(u=>u.id===b.builderUnitId&&u.alive&&u.workState==="building"):null;
    const buildMotion=builder?this.constructionMotion(builder.id):null;
    let r=d.size*sc*(1+(!b.complete?(buildMotion?.impact||0)*.045:0));
    const shell=[.12,.16,.20,1];
    const stone=[.72,.74,.73,1];
    const teamCap=own?[.19,.48,.94,1]:[.94,.27,.27,1];
    const teamHi=own?[.57,.78,1,1]:[1,.62,.60,1];

    if(!b.complete&&this.drawConstructionStage(b,x,y,r,own,teamCap,teamHi,shell,stone,sc,buildQ,buildMotion))return;

    // 70%부터 실제 완성 실루엣이 드러난다. 남은 공정 동안에는
    // 뿌리/비계 흔적과 작업 타격 pulse가 겹쳐져 아직 미완성임을 유지한다.
    // Shared florr-like building foundation: chunky, rounded, readable.
    this.circle(x+2*sc,y+r*.55,r*.94,[.04,.07,.08,.18],12);
    this.poly([
      [x-r*.78,y-r*.40],[x-r*.48,y-r*.70],
      [x+r*.48,y-r*.70],[x+r*.78,y-r*.40],
      [x+r*.82,y+r*.42],[x+r*.50,y+r*.70],
      [x-r*.50,y+r*.70],[x-r*.82,y+r*.42]
    ],shell);
    this.circle(x,y+r*.02,r*.63,stone,12);
    this.circle(x,y-r*.05,r*.48,teamCap,12);
    this.circle(x-r*.14,y-r*.20,r*.16,teamHi,10);
    if(!b.complete&&(b.progress||0)===0){
      // Reserved foundation exists immediately, but does not masquerade as a completed building.
      this.circle(x,y-r*.02,r*.46,[.18,.22,.24,1],12);
      this.line(x-r*.42,y-r*.34,x+r*.42,y+r*.34,Math.max(1.2,2*sc),teamHi);
      this.line(x+r*.42,y-r*.34,x-r*.42,y+r*.34,Math.max(1.2,2*sc),teamHi);
      this.circle(x,y,r*.14,[1,.74,.25,.92],10);
      if(own&&this.selectedBuildingId===b.id){
        const rr=r*1.28,m=Math.max(3,7*sc),lw=Math.max(1.5,2.5*sc),ec=[1,.78,.26,.95];
        this.circle(x,y,rr,[1,.72,.20,.20],24);
        this.line(x-r,y-r,x-r+m,y-r,lw,ec);this.line(x-r,y-r,x-r,y-r+m,lw,ec);
        this.line(x+r,y-r,x+r-m,y-r,lw,ec);this.line(x+r,y-r,x+r,y-r+m,lw,ec);
        this.line(x-r,y+r,x-r+m,y+r,lw,ec);this.line(x-r,y+r,x-r,y+r-m,lw,ec);
        this.line(x+r,y+r,x+r-m,y+r,lw,ec);this.line(x+r,y+r,x+r,y+r-m,lw,ec);
      }
      this.rect(x-r,y+r+3*sc,r*2,4*sc,[.12,.16,.18,.3]);
      return;
    }
    const buildingVisual=BUILDING_VISUAL_RENDER_FNS[d.visualCategory];
    if(!buildingVisual)throw new Error(`Missing building visual renderer for ${b.type}`);
    buildingVisual(this,{b,x,y,r,own,teamCap,teamHi,shell,stone,sc,d});

    if(!b.complete){
      const fade=RangeUtil.clamp((1-buildQ)/.30,0,1);
      for(const sx of [-.48,.48]){
        this.line(x+r*sx,y+r*.46,x+r*sx*.72,y-r*.58,Math.max(1.1,1.8*sc),[.42,.31,.18,.74*fade]);
      }
      this.line(x-r*.48,y-r*.30,x+r*.48,y-r*.30,Math.max(1.1,1.8*sc),[.42,.31,.18,.62*fade]);
      this.petalRing(x,y+r*.38,r*.28,5,[.42,.72,.28,.42*fade],Math.PI/5,.52);
      const pulse=buildMotion?.impact||0;
      if(pulse>0){
        this.circle(x,y+r*.16,r*(.62+.22*pulse),[.55,.86,.30,.07*(1-pulse*.4)],18);
        for(let k=0;k<5;k++){
          const a=-Math.PI*.9+k*Math.PI*.45;
          this.line(x,y+r*.26,x+Math.cos(a)*r*(.42+.35*pulse),y+r*.26+Math.sin(a)*r*(.34+.22*pulse),Math.max(1,1.5*sc),[.55,.82,.30,.52*(1-pulse*.4)]);
        }
      }
    }

    // Shared faction pennant gives every military/economy building the same family language.
    if(d.showsFactionPennant){
      const flagX=x+r*.38;
      const flagTop=y-r*.92;
      this.line(flagX,y-r*.36,flagX,flagTop,Math.max(1.2,2.1*sc),[.16,.20,.23,1]);
      this.poly([
        [flagX,flagTop],
        [flagX+r*.38,flagTop+r*.10],
        [flagX,flagTop+r*.26]
      ],teamCap);
    }

    if(own&&this.selectedBuildingId===b.id){
      const rr=r*1.28;
      const col=b.complete?[.25,.88,.57,.18]:[1,.72,.20,.20];
      this.circle(x,y,rr,col,24);
      // 네 귀퉁이 선택 마커
      const m=Math.max(3,7*sc),lw=Math.max(1.5,2.5*sc),ec=b.complete?[.34,1,.68,.95]:[1,.78,.26,.95];
      this.line(x-r,y-r,x-r+m,y-r,lw,ec);this.line(x-r,y-r,x-r,y-r+m,lw,ec);
      this.line(x+r,y-r,x+r-m,y-r,lw,ec);this.line(x+r,y-r,x+r,y-r+m,lw,ec);
      this.line(x-r,y+r,x-r+m,y+r,lw,ec);this.line(x-r,y+r,x-r,y+r-m,lw,ec);
      this.line(x+r,y+r,x+r-m,y+r,lw,ec);this.line(x+r,y+r,x+r,y+r-m,lw,ec);
    }

    if(!b.complete){
      const q=Math.min(1,b.progress/Math.max(1,SimulationTiming.msToTicks(d.buildTimeMs,this.snapshot?.tps||SIM_TPS)));
      this.rect(x-r,y+r+3*sc,r*2,4*sc,[.12,.16,.18,.3]);
      this.rect(x-r,y+r+3*sc,r*2*q,4*sc,[.95,.70,.23,1]);
    }

    // 내 생산건물은 생산 상태를 전장에서도 바로 읽을 수 있다.
    // Star-like rule: selected panel is detailed, battlefield strip is glanceable.
    if(BuildingDefinition.get(b.type)?.isProductionBuilding&&b.complete&&own){
      const sim=MatchLifecycle.activeSession()?.sim;
      if(sim){
        const pct=sim.productionSpeedPct(b);
        const q=b.queue?.[0]?.productionBatch?b.queue[0]:null;

        // Current production progress strip.
        if(q){
          const total=Math.max(1,Number(q.total)||1);
          const remaining=SimulationTiming.queueRemainingTicks(q,this.snapshot?.tick||0);
          const prog=Math.max(0,Math.min(1,1-remaining/total));
          const bw=Math.max(32,52*sc);
          const bh=Math.max(5,7*sc);
          const by=y+r+9*sc;

          this.rect(x-bw/2,by,bw,bh,[.07,.10,.13,.90]);
          this.rect(
            x-bw/2+1,
            by+1,
            Math.max(0,(bw-2)*prog),
            Math.max(1,bh-2),
            remaining<=0?[.93,.59,.16,.98]:[.20,.59,.94,.98]
          );
        }

        // Density efficiency stays as a smaller warning above the building.
        if(pct<100){
          const bw=Math.max(24,44*sc),bh=Math.max(7,11*sc);
          this.rect(x-bw/2,y-r-19*sc,bw,bh,[.45,.10,.06,.90]);
          this.rect(x-bw/2,y-r-19*sc,bw*(pct/100),bh,[.95,.44,.18,.96]);
          const dots=pct===85?1:pct===70?2:3;
          for(let i=0;i<dots;i++)this.circle(x-bw/2+5*sc+i*7*sc,y-r-13.5*sc,2.2*sc,[1,.92,.72,1],6);
        }else if(!q){
          this.circle(x,y-r-14*sc,Math.max(2.5,4*sc),[.25,.82,.47,.92],8);
        }
      }
    }
  }
  // Identity comes from species silhouette, appendages, equipment and VFX.

  unitRenderVisualScale(u){
    return UnitVisualDefinition.get(u?.type)?.visualScale??1.08;
  }
  unitRenderRadius(u){
    const d=UnitDefinition.get(u?.type)||{};
    return Math.max(6.2,(d.size||10)*this.sc()*1.56*this.unitRenderVisualScale(u));
  }
  
  resolveDragonRenderPose(u,bodyX=null,bodyY=null,radius=null){
    const bp=(bodyX==null||bodyY==null)?this.projectEntityScreen(u,"unit"):null;
    const x=bodyX==null?bp.x:bodyX,y=bodyY==null?bp.y:bodyY,r=radius||this.unitRenderRadius(u);
    const facing=this.resolveUnitFacingScreen(u);
    const fx=facing.fx,fy=facing.fy,sx=facing.sx,sy=facing.sy;
    const tell=u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL;
    const recoil=Math.max(0,Math.min(1,(Number(u.attackFlash)||0)/5));
    const headBack=(tell?.10:0)+recoil*.035;
    const point=(forward,side=0)=>[x+fx*forward*r+sx*side*r,y+fy*forward*r+sy*side*r];
    return{x,y,r,worldX:0,worldY:0,forwardX:fx,forwardY:fy,sideX:sx,sideY:sy,angle:facing.angle,point,
      body:point(-.08,0),neck:point(.38-headBack*.35,0),head:point(.76-headBack,0),muzzle:point(1.08-headBack,0),mouth:point(1.34-headBack,0),
      tailA:point(-.64,0),tailB:point(-1.12,.07),tailTip:point(-1.48,.02)};
  }

  resolveAirFacingScreen(u){
    if(this.unitFacingEnabled(u))return this.resolveUnitFacingScreen(u);
    const fy=this.isFriendlySide(u.side)?-1:1;
    return{fx:0,fy,sx:-fy,sy:0,angle:Math.atan2(fy,0),attack:false};
  }

  drawAirUnitSilhouette(u,x,y,r,team,teamDark,teamLight,accent,attack,sc){
    const delta=this.renderTrackedDelta(u,"unit");
    const pose=this.resolveAirFacingScreen(u),{fx,fy,sx,sy}=pose;
    const pt=(forward=0,side=0)=>[x+fx*forward*r+sx*side*r,y+fy*forward*r+sy*side*r];
    const linePts=(a,b,w,c)=>this.line(a[0],a[1],b[0],b[1],w,c);
    const now=performance.now(),seed=(HashUtil.hash(u.id)%997)*.017;
    const fastFlap=.5+.5*Math.sin(now*.026+seed),slowFlap=.5+.5*Math.sin(now*.010+seed);
    const wingBright=[Math.min(1,accent[0]+.18),Math.min(1,accent[1]+.18),Math.min(1,accent[2]+.18),.72];
    const wingSoft=[Math.min(1,accent[0]+.12),Math.min(1,accent[1]+.12),Math.min(1,accent[2]+.12),.42];
    const body=team,bodyDark=teamDark;

    
    const ctx={u,x,y,r,team,teamDark,teamLight,accent,attack,sc,delta,fx,fy,sx,sy,pt,linePts,now,seed,fastFlap,slowFlap,wingBright,wingSoft,body,bodyDark};
    const render=AIR_UNIT_VISUAL_RENDER_FNS[u.type];
    if(render)return render(this,ctx);
    if(UnitDefinition.get(u.type)?.targetLeashToSummoner){

      const flap=.72+.30*fastFlap;
      for(const side of [-1,1])this.poly([pt(.02,side*.06),pt(.06,side*.64*flap),pt(-.32,side*.48*flap),pt(-.28,side*.05)],wingSoft);
      this.circle(...pt(-.12,0),r*.40,body,9);this.circle(...pt(.30,0),r*.23,bodyDark,8);linePts(pt(.34,0),pt(.82,0),Math.max(1,1.6*sc),accent);
    
      return;
    }
    throw new Error(`Missing AIR visual renderer for ${u.type}`);
  }
  drawAirUnitTransientEffects(ctx){
    const {u,x,y,r,sc}=ctx,pose=this.resolveAirFacingScreen(u),pt=(forward=0,side=0)=>[x+pose.fx*forward*r+pose.sx*side*r,y+pose.fy*forward*r+pose.sy*side*r],linePts=(a,b,w,c)=>this.line(a[0],a[1],b[0],b[1],w,c);
    const delta=this.renderTrackedDelta(u,"unit");let hasEffect=false;
    if(u.type==="sailwing"&&Math.hypot(delta.x,delta.y)>.001){
      hasEffect=true;
    }else if(u.type==="gustmayfly"){
      const ramp=RangeUtil.clamp(Math.max(0,(Number(this.snapshot?.tick)||0)-(Number(u.movement?.outOfCombatStartedAt)||0)+1)/Math.max(1,SimulationTiming.msToTicks(Number(UnitDefinition.get(u.type)?.outOfCombatRampMs)||3000,this.snapshot?.tps||SIM_TPS)),0,1);
      hasEffect=ramp>.12;
    }
    if(!hasEffect)return;
    this.flushVectorMesh("air-transient-effects");
    if(this.frame.length){this.flush(this.frame,true);this.begin()}
    if(u.type==="sailwing"){
      for(const side of [-.35,.35])linePts(pt(-.72,side),pt(-1.34,side*.72),Math.max(1,1.3*sc),[.42,.92,.78,.20]);
    }else if(u.type==="gustmayfly"){
      const ramp=RangeUtil.clamp(Math.max(0,(Number(this.snapshot?.tick)||0)-(Number(u.movement?.outOfCombatStartedAt)||0)+1)/Math.max(1,SimulationTiming.msToTicks(Number(UnitDefinition.get(u.type)?.outOfCombatRampMs)||3000,this.snapshot?.tps||SIM_TPS)),0,1);
      if(ramp>.12)for(let k=0;k<3;k++){const side=(k-1)*.20,a=pt(-.85-k*.14,side),b=pt(-1.45-k*.28,side);linePts(a,b,Math.max(1,1.3*sc),[.48,.92,1,.10+.22*ramp])}
    }
  }
  shouldUseVectorUnitArt(u){
    const definition=UnitDefinition.get(u?.type);
    return !!window.RallyVectorAssets?.[u?.type]&&!(definition?.economyWorker&&u.workState==="building"&&u.buildTargetId);
  }
  unitVectorAssetRecord(type,relation){
    const key=type+"|"+relation;
    let record=this.vectorUnitAssetCache.get(key);if(record)return record;
    const source=window.RallyVectorAssets?.[type];if(!source)return null;
    const palette=UnitFactionPalette.get(relation);if(!palette)throw new Error("Missing vector faction palette: "+relation);
    const vertices=source.geometry.vertices.slice();
    const markers={"254,254,254":palette.body,"85,85,85":palette.dark,"191,191,191":palette.light,"153,153,153":palette.ring};
    for(let i=0;i<vertices.length;i+=11){
      const target=markers[[2,3,4].map(offset=>Math.round(vertices[i+offset]*255)).join(",")];
      if(target){vertices[i+2]=target[0];vertices[i+3]=target[1];vertices[i+4]=target[2]}
    }
    const compiled={...source,geometry:{...source.geometry,vertices}};
    const actor=RallyGamekit.createVectorActor(this.vectorContext,compiled,{clip:"idle",startedAtMs:0});actor.setExpression("default").seek(0);
    record={actor,compiled,relation,isAir:UnitDefinition.get(type)?.layer==="AIR",partIds:new Set(compiled.metadata.parts.map(part=>part.id))};this.vectorUnitAssetCache.set(key,record);return record;
  }
  launchAmmoRecord(type){
    if(!LaunchRules.grain(type))return null;
    const key="ammo|"+type;let record=this.vectorUnitAssetCache.get(key);if(record)return record;
    const source=window.RallyVectorAssets?.["ammo-"+type];if(!source)return null;
    const actor=RallyGamekit.createVectorActor(this.vectorContext,source,{clip:"idle",startedAtMs:0});actor.setExpression("default").seek(0);
    record={actor,compiled:source};this.vectorUnitAssetCache.set(key,record);return record;
  }
  // Draws a 256-canvas asset centred at (x,y), rotated and scaled, between frame batches.
  drawVectorBillboard(record,x,y,angle,scale){
    if(this.frame.length){this.flushVectorMesh("frame-to-vector-switch");this.flush(this.frame,true);this.begin()}
    const cos=Math.cos(angle)*scale,sin=Math.sin(angle)*scale,m=this._vectorUnitMatrix;
    m[0]=cos;m[1]=sin;m[2]=-sin;m[3]=cos;m[4]=x-cos*128+sin*128;m[5]=y-sin*128-cos*128;
    this.vectorContext.drawVectorActor(record.actor,{matrix:m,alpha:1,depth:this._renderDepth??0,depthTest:false,depthWrite:false});
    this.flushVectorMesh("vector-billboard");
  }
  grainUnitRecord(type){
    const key="grain|"+type;let record=this.vectorUnitAssetCache.get(key);if(record)return record;
    const source=window.RallyVectorAssets?.[type];if(!source)return null;
    const sockets=source.metadata.sockets,point=id=>{const s=sockets[id];if(!s)throw new Error(`Grain body is missing socket ${id}`);return s.point};
    const actor=RallyGamekit.createVectorActor(this.vectorContext,source,{clip:"idle",startedAtMs:0});
    record={actor,compiled:source,ground:point("ground")};this.vectorUnitAssetCache.set(key,record);return record;
  }
  // Budmori bodies are front-facing: no rotation, ground socket on the unit's ground point.
  drawGrainUnitBody(ctx){
    const record=this.grainUnitRecord(ctx.u.type);if(!record)return null;
    if(this.frame.length){this.flushVectorMesh("frame-to-vector-switch");this.flush(this.frame,true);this.begin()}
    const u=ctx.u,actor=record.actor,now=this.presentationNow(performance.now()),phase=(HashUtil.hash(u.id)%997)*7;
    const delta=this.renderTrackedDelta(u,"unit"),moving=Math.hypot(delta.x,delta.y)>.01;
    const clip=ctx.attack?"fire":ctx.hit?"hit":moving?"walk":"idle";
    if(actor.currentClip!==clip)actor.play(clip,0);
    actor.seek(now+phase);
    const scale=ctx.r*2.7/260*(UnitVisualDefinition.get(u.type)?.visualScale||1),m=this._vectorUnitMatrix;
    const gx=ctx.x,gy=ctx.y+ctx.r*.55;
    m[0]=scale;m[1]=0;m[2]=0;m[3]=scale;m[4]=gx-scale*record.ground[0];m[5]=gy-scale*record.ground[1];
    this.vectorContext.drawVectorActor(actor,{matrix:m,alpha:ctx.ownStealthAlpha,depth:this._renderDepth??0,
      depthTest:!!this.passState.depthEnabled,depthWrite:true,depthWriteAlphaThreshold:.999,depthFunc:this.passState.depthFunc||"lequal"});
    // Budmori faces: shared eye/mouth/cheek atlas parts placed on this body's posed face sockets.
    this.grainFaces.draw(record.compiled,actor,ctx.hit?"hurt":ctx.attack?"attack":"neutral",m,ctx.ownStealthAlpha);
    this.vectorAssetDrawnInstances=(this.vectorAssetDrawnInstances||0)+1;
    return record;
  }
  vectorUnitMatrix(ctx){
    const scale=ctx.r/40,tr=this._unitFacingTransform,airFacing=ctx.airUnit?this.resolveAirFacingScreen(ctx.u):null,cos=airFacing?.fx??tr?.cos??1,sin=airFacing?.fy??tr?.sin??0;
    const a=scale*cos,b=scale*sin,c=-scale*sin,d=scale*cos;
    const matrix=this._vectorUnitMatrix;
    matrix[0]=a;matrix[1]=b;matrix[2]=c;matrix[3]=d;
    matrix[4]=ctx.x-a*128-c*128;matrix[5]=ctx.y-b*128-d*128;
    return matrix;
  }
  flushVectorMesh(reason){
    return this.vectorContext.active?this.vectorContext.flush(reason):undefined;
  }
  setVectorUnitPartVisible(record,expression,id,visible){
    if(!record.partIds.has(id))return;
    const variant=record.compiled.metadata.expressions[expression];
    // setExpression already restores authored visibility; redundant overrides discard its index variant.
    if((visible?variant.show:variant.hide).includes(id))return;
    record.actor.setPartVisible(id,visible);
  }
  drawVectorUnitBody(ctx){
    const relation=this.factionRelation(ctx.u.side),record=this.unitVectorAssetRecord(ctx.u.type,relation);
    if(!record)return null;
    if(this.frame.length){
      this.flushVectorMesh("frame-to-vector-switch");
      this.flush(this.frame,true);this.begin();
    }
    const expression=ctx.hit?(ctx.attack?"hit-attack":"hit"):(ctx.attack?"attack":"default");
    const actor=record.actor;
    if(record.isAir){
      const hash=HashUtil.hash(ctx.u.id),phase=(hash%997)*17;
      actor.seek(this.presentationNow(performance.now())+phase).setExpression(expression);
      const breathTell=ctx.u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.TELL,breathActive=ctx.u.objectiveBreathPhase===OBJECTIVE_DRAGON_BREATH_PHASE.ACTIVE;
      this.setVectorUnitPartVisible(record,expression,"attackFx",!!ctx.attack);
      this.setVectorUnitPartVisible(record,expression,"breathTell",breathTell);
      this.setVectorUnitPartVisible(record,expression,"breathActive",breathActive);
      if(record.partIds.has("sac"))actor.setBasePose("sac",{scaleX:ctx.attack?1.22:1,scaleY:ctx.attack?1.22:1});
      if(record.partIds.has("jaw"))actor.setBasePose("jaw",{opacity:breathTell||breathActive||ctx.attack?1:.15});
    }else actor.setExpression(expression);
    this.vectorContext.drawVectorActor(actor,{matrix:this.vectorUnitMatrix(ctx),alpha:ctx.ownStealthAlpha,depth:this._renderDepth??0,
      depthTest:!!this.passState.depthEnabled,depthWrite:true,depthWriteAlphaThreshold:.999,depthFunc:this.passState.depthFunc||"lequal"});
    this.vectorAssetDrawnInstances=(this.vectorAssetDrawnInstances||0)+1;
    return record;
  }
  appendVectorTerrainOccludedBody(record,ctx,world){
    this.vectorTerrainOcclusionTests=(this.vectorTerrainOcclusionTests||0)+1;
    if(!record||!world)return;
    const deck=this.renderBridgeAt(world.x,world.z);if(deck&&world.y<deck.elevation-.01)return;
    const geometry=record.compiled.geometry,vertices=geometry.vertices,indices=geometry.indices;
    const vertexCount=vertices.length/11,count=indices?indices.length:vertexCount,matrix=this.vectorUnitMatrix(ctx);
    let coords=this._vectorOcclusionCoords;if(coords.length<vertexCount*2){coords=new Float32Array(Math.max(vertexCount*2,coords.length*2,128));this._vectorOcclusionCoords=coords}
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(let vertex=0;vertex<vertices.length/11;vertex++){
      const offset=vertex*11;if(vertices[offset+10]!==0)continue;
      const lx=vertices[offset],ly=vertices[offset+1],x=matrix[0]*lx+matrix[2]*ly+matrix[4],y=matrix[1]*lx+matrix[3]*ly+matrix[5];
      coords[vertex*2]=x;coords[vertex*2+1]=y;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);
    }
    if(!Number.isFinite(minX))return;
    const a=this.projectedCoordinatesAtScreen(minX,minY),b=this.projectedCoordinatesAtScreen(maxX,maxY);
    const projected=TerrainSurfaceProjection.forAtlas(this.world.terrain.surfaces).projectedSurfaceMesh(this.orientationRole()==="guest");
    const transitions=projected.transitionIndex.query(a.x,a.y,b.x,b.y);if(!transitions.length)return;this.vectorTerrainOcclusionRegions=(this.vectorTerrainOcclusionRegions||0)+1;
    const destination=this.terrainOccludedBodyFrame;destination.ensure(count*7);let writtenTriangles=0;
    for(let at=0;at+2<count;at+=3){
      const a=indices?indices[at]:at,b=indices?indices[at+1]:at+1,c=indices?indices[at+2]:at+2;
      const oa=a*11,ob=b*11,oc=c*11;
      if(vertices[oa+10]!==0||vertices[ob+10]!==0||vertices[oc+10]!==0||vertices[oa+5]<.5||vertices[ob+5]<.5||vertices[oc+5]<.5)continue;
      destination.push7(coords[a*2],coords[a*2+1],this._renderDepth??0,.34,.68,1,.34);
      destination.push7(coords[b*2],coords[b*2+1],this._renderDepth??0,.34,.68,1,.34);
      destination.push7(coords[c*2],coords[c*2+1],this._renderDepth??0,.34,.68,1,.34);
      writtenTriangles++;
    }
    this.vectorTerrainOcclusionTriangles=(this.vectorTerrainOcclusionTriangles||0)+writtenTriangles;
  }
  unitBodyMeshKey(ctx){
    const {u,own,neutral,ownStealthAlpha,attack,sc}=ctx;
    return [
      u.type,own?1:0,neutral?1:0,
      ownStealthAlpha<1?1:0,attack?1:0,
      Number(sc).toFixed(4)
    ].join("|");
  }
  appendCachedUnitBodyMesh(mesh,ctx,facingTransform){
    const frame=this.frame,data=mesh.data,n=data.length;
    frame.ensure(n);
    const out=frame.data,start=frame.length;
    const px=ctx.x,py=ctx.y,baseDepth=this._renderDepth??0;
    const hasFacing=!!facingTransform;
    const cos=hasFacing?facingTransform.cos:1,sin=hasFacing?facingTransform.sin:0;
    for(let i=0;i<n;i+=7){
      let lx=data[i],ly=data[i+1];
      if(hasFacing){
        const rx=lx*cos-ly*sin,ry=lx*sin+ly*cos;lx=rx;ly=ry;
      }
      const o=start+i;
      out[o]=px+lx;out[o+1]=py+ly;out[o+2]=baseDepth+data[i+2];
      out[o+3]=data[i+3];out[o+4]=data[i+4];out[o+5]=data[i+5];out[o+6]=data[i+6];
    }
    frame.length=start+n;
  }
  drawUnitBodyComposed(ctx,unitVisual){
    if(!unitVisual)return;
    const cacheable=unitVisual.cachePolicy==="STATIC";
    if(!cacheable){
      this.drawUnitCommonBody(ctx);unitVisual.render(this,ctx);return;
    }
    const key=this.unitBodyMeshKey(ctx),cached=this.unitBodyMeshCache.get(key);
    const facing=this._unitFacingTransform;
    if(cached){
      this.unitBodyMeshCacheHits++;
      this.appendCachedUnitBodyMesh(cached,ctx,facing);
      return;
    }
    this.unitBodyMeshCacheMisses++;
    // Generate once without entity facing, then store local-space vertices.
    const start=this.frame.length,baseDepth=this._renderDepth??0;
    this._unitFacingTransform=null;
    try{
      this.drawUnitCommonBody(ctx);unitVisual.render(this,ctx);
    }finally{
      this._unitFacingTransform=facing;
    }
    const end=this.frame.length,n=end-start,local=new Float32Array(n);
    const data=this.frame.data;
    for(let i=0;i<n;i+=7){
      local[i]=data[start+i]-ctx.x;
      local[i+1]=data[start+i+1]-ctx.y;
      local[i+2]=data[start+i+2]-baseDepth;
      local[i+3]=data[start+i+3];local[i+4]=data[start+i+4];
      local[i+5]=data[start+i+5];local[i+6]=data[start+i+6];
    }
    if(this.unitBodyMeshCache.size>=384)this.unitBodyMeshCache.clear();
    this.unitBodyMeshCache.set(key,{data:local});
    // The cache stays local and terrain-independent. Apply facing and the current
    // supporting plane to every instance, including the first one.
    for(let i=start;i<end;i+=7){
      if(facing){const lx=data[i]-ctx.x,ly=data[i+1]-ctx.y;data[i]=ctx.x+lx*facing.cos-ly*facing.sin;data[i+1]=ctx.y+lx*facing.sin+ly*facing.cos}
    }
  }

  drawUnitCommonBody(ctx){
    const {u,airUnit,x,y,r,team,teamLight}=ctx;
    if(!UnitDefinition.get(u.type)?.objectiveKind&&!airUnit&&UnitVisualDefinition.get(u.type)?.commonGroundBody!==false){
      this.circle(x,y+r*.12,r*.78,[.07,.10,.13,1],12);
      this.circle(x,y+r*.08,r*.68,team,12);
      this.circle(x-r*.18,y-r*.04,r*.25,teamLight,10);
    }
  }
  drawUnitStateFeedback(ctx){
    const {hit,attack,x,y,r}=ctx;
    if(hit)this.circle(x,y,r*1.42,[1,.94,.75,.18],12);
    if(attack)this.circle(x,y,r*1.22,[1,.73,.22,.07],10);
  }

  reportEntityRenderError(kind,entity,err){
    this.entityRenderErrors??=new Set();
    const key=`${kind}:${entity?.type||"unknown"}:${String(err?.message||err)}`;
    if(this.entityRenderErrors.has(key))return;
    this.entityRenderErrors.add(key);
    console.error("[RALLY FRONTIER] entity render fallback",kind,entity?.type,err);
  }
  drawFallbackUnit(u){
    const p=this.projectEntityScreen(u,"unit"),r=this.unitRenderRadius(u);
    const palette=UnitFactionPalette.get(this.factionRelation(u.side));
    const body=palette.body,edge=palette.dark;
    this.circle(p.x,p.y,r*.78,edge,12);
    this.circle(p.x,p.y-r*.04,r*.58,body,12);
    this.circle(p.x+r*.22,p.y-r*.18,r*.12,[.95,.90,.55,1],8);
  }
  drawUnitSafely(u,renderOptions=null){
    try{return this.drawUnit(u,renderOptions)}
    catch(err){
      this.reportEntityRenderError("unit",u,err);
      try{return this.drawFallbackUnit(u)}catch(fallbackErr){this.reportEntityRenderError("unit-fallback",u,fallbackErr)}
    }
  }
  drawBuildingSafely(b){
    try{return this.drawBuilding(b)}
    catch(err){
      this.reportEntityRenderError("building",b,err);
      try{
        const q=this.worldToPx(this.viewX(b.x),this.viewY(b.y)),r=Math.max(12,(BuildingDefinition.get(b.type)?.size||40)*this.sc()*.55);
        this.rect(q[0]-r,q[1]-r,r*2,r*2,b.side===this.mySide()?[.18,.43,.93,1]:[.72,.25,.22,1]);
      }catch(fallbackErr){this.reportEntityRenderError("building-fallback",b,fallbackErr)}
    }
  }
  drawProjectileSafely(p){
    try{return this.drawProjectile(p)}
    catch(err){
      this.reportEntityRenderError("projectile",p,err);
      try{
        const q=this.projectEntityScreen(p,"projectile");
        this.circle(q.x,q.y,Math.max(2,(p.drawRadius||4)*this.sc()),[1,.75,.25,1],8);
      }catch(fallbackErr){this.reportEntityRenderError("projectile-fallback",p,fallbackErr)}
    }
  }

  drawUnit(u,renderOptions=null){
    const own=u.side===this.mySide();
    const d=UnitDefinition.get(u.type);
    const cloaked=this.snapshotStealthed(u);
    const detected=own?true:this.detectedRaw(u.x,u.y);
    if(!renderOptions?.visibilityChecked&&!own&&(!this.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR")||(cloaked&&!detected)))return;

    const sc=this.sc(),neutral=u.side===NEUTRAL_SIDE;
    const worldPos=renderOptions?.worldPosition||this.resolveRenderWorldPosition(u,"unit");
    const bodyPos=this.projectRenderWorldPosition(worldPos);
    const groundWorld=this.resolveGroundShadowPosition(u,"unit");
    const groundProjection=this.projectRenderWorldPosition(groundWorld);
    const groundPos=[groundProjection.x,groundProjection.y];
    let x=bodyPos.x,y=bodyPos.y;
    const airborne=worldPos.y>worldPos.groundY+.01;
    const airUnit=d?.layer==="AIR";
    const r=this.unitRenderRadius(u);

    // All body geometry shares one GPU depth derived from the render-world coordinate.
    this.setRenderDepth(this.spriteDepthForWorld(worldPos));

    // Only an actual bodily cast draws momentum. Use the common interpolated pose
    // and current movement delta; no predicted bodies or retained per-unit trails.
    if(u.behaviorState?.chargedExecution){
      const delta=this.renderTrackedDelta(u,"unit"),distance=Math.hypot(delta.x,delta.y);
      if(distance>.01){
        for(let k=1;k<=3;k++){
          const back=k*.55,trailWorld={...worldPos,x:worldPos.x-delta.x*back,z:worldPos.z-delta.y*back};
          const tp=this.projectRenderWorldPosition(trailWorld);
          this.withRenderDepth(tp.depth+.001,()=>this.circle(tp.x,tp.y,r*(.65-k*.10),[.35,.64,1,.14*(4-k)/3],10));
        }
      }
    }

    // Leap trail samples the exact same 3D trajectory instead of rebuilding a
    // screen-space lift. r is defined before this branch.
    if(worldPos.motion==="leap"){
      const trails=this.resolveLeapTrailWorldPositions(u,3);
      for(let k=0;k<trails.length;k++){
        const tp=this.projectRenderWorldPosition(trails[k]),fade=(trails.length-k)/(trails.length+1);
        this.withRenderDepth(tp.depth+.001,()=>this.circle(tp.x,tp.y,r*(.38-.05*k),[.55,.42,.92,.10*fade],10));
      }
      const sp=this.projectRenderWorldPosition({x:u.leapStartX||u.x,y:0,z:u.leapStartY||u.y});
      this.withRenderDepth(bodyPos.depth+.001,()=>this.line(sp.x,sp.y,x,y,Math.max(1,1.4*sc),[.62,.48,.96,.12]));
    }
    let workerBuildAnim=null;
    if(!!UnitDefinition.get(u.type)?.economyWorker&&u.workState==="building"&&u.buildTargetId){
      const target=this.snapshot?.buildings?.find(b=>b.id===u.buildTargetId&&b.alive!==false&&!b.complete);
      if(target){
        const rp=this.renderTrackedPosition(u,"unit");
        const wx=this.viewX(rp.x),wy=this.viewY(rp.y),tx=this.viewX(target.x),ty=this.viewY(target.y);
        const dx=tx-wx,dy=ty-wy,len=Math.hypot(dx,dy)||1;
        const aimX=dx/len,aimY=dy/len,sideX=-aimY,sideY=aimX;
        const motion=this.constructionMotion(u.id);
        const forward=(motion.drive*5.5-motion.pull*4.2-motion.recoil*2.4)*sc;
        const crouch=(motion.crouch*2.8-motion.recoil*1.8)*sc;
        const lateral=motion.lateral*1.7*sc;
        x+=aimX*forward+sideX*lateral;
        y+=aimY*forward+sideY*lateral+crouch;
        workerBuildAnim={target,aimX,aimY,sideX,sideY,motion};
      }
    }

    // Own cloaked unit remains visible to its owner, but the entire body/equipment
    // is rendered at 30% opacity. This is applied as a renderer-wide multiplier
    // below so bespoke hard-coded unit colors cannot accidentally bypass stealth alpha.
    const ownStealthAlpha=(own&&cloaked)?0.30:1;
    // 모바일에서도 장비/표정이 보이도록 물리 반경보다 시각 반경을 조금 크게 사용.

    if(UnitDefinition.get(u.type)?.momentumCharge&&(u.movement.chargeMomentum||1000)>1180){
      const q=RangeUtil.clamp(((u.movement.chargeMomentum||1000)-1000)/1000,0,1),dir=own?-1:1;
      for(let k=1;k<=3;k++)this.line(x-r*.35*k,y+dir*r*.16*k,x+r*.25-r*.48*k,y+dir*r*.16*k,Math.max(1,(1.4+q)*sc),[.96,.74,.25,.08+.12*q]);
    }

    if(neutral&&Unit.neutralStateOf(u)?.returningHome){
      const pulse=.5+.5*Math.sin(performance.now()*.010+(HashUtil.hash(u.id)%100)*.12);
      this.circle(
        x,y,r*(1.35+.12*pulse),
        [.32,.95,.44,.07+.06*pulse],
        18
      );
      const cx=x+r*.92,cy=y-r*.72,w=Math.max(1.4,2.2*sc);
      this.line(cx-r*.14,cy,cx+r*.14,cy,w,[.65,1,.68,.62]);
      this.line(cx,cy-r*.14,cx,cy+r*.14,w,[.65,1,.68,.62]);
    }

    const factionPalette=UnitFactionPalette.get(this.factionRelation(u.side));
    const team=ownStealthAlpha<1?[...factionPalette.body.slice(0,3),ownStealthAlpha]:factionPalette.body;
    const teamDark=ownStealthAlpha<1?[...factionPalette.dark.slice(0,3),ownStealthAlpha]:factionPalette.dark;
    const teamLight=ownStealthAlpha<1?[...factionPalette.light.slice(0,3),ownStealthAlpha]:factionPalette.light;
    const ink=[.09,.12,.16,ownStealthAlpha],
      metal=[.23,.28,.34,ownStealthAlpha],
      gold=[.96,.72,.24,ownStealthAlpha];
    const hit=u.hitFlash>0;
    const attack=u.attackFlash>0;
    const accent=UnitVisualDefinition.get(u.type)?.accent||teamLight;
    // Ground silhouettes are authored vertically, then rotated by common presentation facing.
    const dir=-1;
    const previousFacingTransform=this._unitFacingTransform;
    if(!airUnit&&this.unitFacingEnabled(u))this.beginUnitFacingTransform(u,x,y);

    // Shadow placement is centralized in drawUnitShadow(), which always uses
    // the x/z ground projection regardless of AIR/leap/airborne state.

    // Apply cloak opacity to the whole rendered unit body, including bespoke
    // species geometry that uses hard-coded alpha=1 colors. Shadows stay on the
    // ground at their own opacity and HUD bars are restored to full opacity later.
    const prevUnitRenderAlphaMul=this._unitRenderAlphaMul;
    this._unitRenderAlphaMul=ownStealthAlpha;

    // Presentation-only source-body pulses are composed for every unit through one common contract.
    // Simulation size/collision remain authoritative and unchanged.
    const presentationR=r*this.bodyPulsePresentation.scale(u.id,performance.now());
    const unitRenderCtx={
      u,own,d,sc,neutral,worldPos,bodyPos,groundWorld,groundProjection,groundPos,
      x,y,airborne,airUnit,r:presentationR,workerBuildAnim,ownStealthAlpha,cloaked,
      team,teamDark,teamLight,factionPalette,ink,metal,gold,accent,hit,attack,dir
    };
    // HAS-A common body + IS-A species visual. Immutable bodies use a local-space
    // mesh cache; CAN-BE dynamic species keep the procedural path.
    const bodyStart=this.frame.length;
    let vectorBody=null;
    if(airUnit&&this.shouldUseVectorUnitArt(u)){
      vectorBody=this.drawVectorUnitBody(unitRenderCtx);
      this.drawAirUnitTransientEffects(unitRenderCtx);
    }else if(airUnit&&(AIR_UNIT_VISUAL_RENDER_FNS[u.type]||UnitDefinition.get(u.type)?.targetLeashToSummoner)){
      this.drawAirUnitSilhouette(u,x,y,presentationR,team,teamDark,teamLight,accent,attack,sc);
    }else{
      const unitVisual={type:u.type,cachePolicy:UnitVisualLookup.cachePolicy(u.type),render:UnitVisualLookup.renderer(u.type)};
      if(!unitVisual.render)throw new Error(`Missing unit visual renderer for ${u.type}`);
      if(UnitVisualDefinition.get(u.type)?.billboard)vectorBody=this.drawGrainUnitBody(unitRenderCtx);
      else if(!workerBuildAnim&&this.shouldUseVectorUnitArt(u))vectorBody=this.drawVectorUnitBody(unitRenderCtx);
      if(!vectorBody)this.drawUnitBodyComposed(unitRenderCtx,unitVisual);
    }
    if(vectorBody){
      // Upright grain bodies have no top-down silhouette to project under terrain.
      if(own&&!cloaked&&!airUnit&&!UnitVisualDefinition.get(u.type)?.billboard&&this.world.terrain.surfaces.layers.length)this.appendVectorTerrainOccludedBody(vectorBody,unitRenderCtx,worldPos);
    }else{
      if(own&&!cloaked&&!airUnit&&this.world.terrain.surfaces.layers.length)this.appendTerrainOccludedBody(bodyStart,this.frame.length,worldPos);
      // CAN-BE hit/attack presentation layer stays in the existing dynamic path.
      this.drawUnitStateFeedback(unitRenderCtx);
    }

    this.restoreUnitFacingTransform(previousFacingTransform);
    // HUD는 은신 상태에서도 읽혀야 하므로 전역 alpha multiplier를 복구한다.
    this._unitRenderAlphaMul=prevUnitRenderAlphaMul;

    // Health/status bars are intentionally NOT drawn in the opaque unit pass.
    // drawWorldHudOverlay() is the single owner so Render State / AIR height / future
    // presentation passes cannot accidentally render a second health bar.
  }
  projectileScreenMotion(p,screenX,screenY){
    let st=this.projectileScreenMotionStates.get(p.id),dx=0,dy=0,valid=false;
    if(st){dx=screenX-st.x;dy=screenY-st.y;const len=Math.hypot(dx,dy);if(len>.01){dx/=len;dy/=len;valid=true}else if(st.valid){dx=st.dx;dy=st.dy;valid=true}st.x=screenX;st.y=screenY;if(valid){st.dx=dx;st.dy=dy;st.valid=true}}
    else{st={x:screenX,y:screenY,dx:0,dy:0,valid:false};this.projectileScreenMotionStates.set(p.id,st)}
    return{dx,dy,valid};
  }
  drawProjectile(p){
    const targetVisible=this.visibleRaw(p.x,p.y)||p.side===this.mySide();if(!targetVisible)return;
    const sc=this.sc();
    const wp=this.resolveRenderWorldPosition(p,"projectile");
    const stablePp=this.projectRenderWorldPositionStable(wp);
    const pp=this.projectRenderWorldPosition(wp);
    const gp=this.projectRenderWorldPosition(this.resolveGroundShadowPosition(p,"projectile"));
    const gx=gp.x,gy=gp.y;let x=pp.x,y=pp.y;
    this.setRenderDepth(this.spriteDepthForWorld(wp));
    const target=(this.snapshot?.units||[]).find(u=>u.id===p.target&&u.alive)||
      (this.snapshot?.buildings||[]).find(b=>b.id===p.target&&b.alive!==false);
    if(wp.y>0.01){
      const sr=Math.max(2,((p.drawRadius||5)-1)*sc);
      this.withWorldSpriteDepth(this.resolveGroundShadowPosition(p,"projectile"),()=>{
        this.circle(gx,gy,sr,[.06,.08,.10,.22],8);
        this.circle(gx,gy,sr*1.55,[.06,.08,.10,.08],10);
      });
      if((gy-y)>2.5)this.line(gx,gy-sr*.25,gx,y+sr*.3,Math.max(1,1.25*sc),[.95,.92,.80,.16]);
    }
    const projectileCtx={p,sc,target,gx,gy,wp,pp,gp,x,y};
    const adjust=PROJECTILE_ORIGIN_ADJUSTERS[p.visualTag];
    if(adjust){const adjusted=adjust(this,projectileCtx);x=adjusted.x;y=adjusted.y;projectileCtx.x=x;projectileCtx.y=y}
    // Direction is sampled after interpolation/camera projection/z-height, but before
    // transient hit/camera shake. Origin adjusters are converted to the same stable space.
    const adjustDx=x-pp.x,adjustDy=y-pp.y;
    projectileCtx.screenMotion=this.projectileScreenMotion(p,stablePp.x+adjustDx,stablePp.y+adjustDy);
    const visual=PROJECTILE_VISUAL_RENDER_FNS[p.visualTag]||PROJECTILE_VISUAL_RENDER_FNS[p.type];
    if(visual)visual(this,projectileCtx);else ProjectileVisualFallback.render(this,projectileCtx);
  }
  drawRallyGuide(){
    if(!this.snapshot)return;
    const side=this.mySide();
    const flag=this.predictedFlag||this.renderTrackedFlag(side);
    if(!flag)return;

    const sc=this.sc();
    const own=side===0;

    const drawDashed=(from,to,{color,glow,dash=15,gap=11,width=2.2,startPad=8,endPad=8}={})=>{
      if(!from||!to)return;
      const a=this.worldToPx(this.viewX(from.x),this.viewY(from.y));
      const b=this.worldToPx(this.viewX(to.x),this.viewY(to.y));
      const dx=b[0]-a[0],dy=b[1]-a[1],len=Math.hypot(dx,dy);
      if(len<4)return;
      const nx=dx/len,ny=dy/len;
      const dashPx=Math.max(8,dash*sc);
      const gapPx=Math.max(6,gap*sc);
      const step=dashPx+gapPx;
      const lineW=Math.max(1.15,width*sc);
      const sPad=Math.max(4,startPad*sc),ePad=Math.max(4,endPad*sc);

      if(glow)this.line(a[0],a[1],b[0],b[1],Math.max(2.5,6*sc),glow);
      for(let d=sPad;d<len-ePad;d+=step){
        const e=Math.min(len-ePad,d+dashPx);
        if(e<=d)break;
        this.line(a[0]+nx*d,a[1]+ny*d,a[0]+nx*e,a[1]+ny*e,lineW,color);
      }
    };

    // ------------------------------------------------------
    // 1) Combat rally: every production building -> global flag.
    //    Bases no longer pretend to be combat-rally origins.
    // ------------------------------------------------------
    const forced=!!flag.forced;
    const combatColor=forced?[1,.70,.18,.34]:(own?[.30,.62,1,.22]:[1,.38,.38,.22]);
    const combatGlow=forced?[1,.62,.12,.075]:(own?[.34,.66,1,.035]:[1,.40,.40,.035]);
    const producers=(this.snapshot.buildings||[]).filter(b=>
      b.alive!==false&&b.complete&&b.side===side&&
      BuildingDefinition.get(b.type)?.isProductionBuilding
    );
    for(const b of producers){
      drawDashed(b,flag,{color:combatColor,glow:combatGlow,dash:15,gap:11,width:2.1,startPad:18,endPad:14});
    }

    // ------------------------------------------------------
    // 2) Economy rally: base/outpost -> resource target.
    //    Prefer the resource actually targeted by workers assigned to that dropoff.
    //    If no worker has a live target yet, fall back to the nearest valid resource.
    // ------------------------------------------------------
    const dropoffs=(this.snapshot.buildings||[]).filter(b=>
      b.alive!==false&&b.complete&&b.side===side&&
      BuildingDefinition.get(b.type)?.isDropoff
    );
    const minerals=(this.snapshot.resources||[]).filter(m=>m.amount>0);
    const extractors=(this.snapshot.buildings||[]).filter(b=>
      b.alive!==false&&b.complete&&b.side===side&&BuildingDefinition.get(b.type)?.isGasExtractor
    );
    const workers=(this.snapshot.units||[]).filter(u=>u.alive&&u.side===side&&!!UnitDefinition.get(u.type)?.economyWorker);

    const nearestDropoffFor=worker=>{
      let best=null,bd=Infinity;
      for(const b of dropoffs){
        const d=(worker.x-b.x)*(worker.x-b.x)+(worker.y-b.y)*(worker.y-b.y);
        if(d<bd||(d===bd&&best&&String(b.id)<String(best.id))){best=b;bd=d}
      }
      return best;
    };
    const assignedByDropoff=new Map(dropoffs.map(b=>[b.id,[]]));
    for(const w of workers){
      const b=nearestDropoffFor(w);
      if(b)assignedByDropoff.get(b.id)?.push(w);
    }

    const mostCommonTarget=(list,type)=>{
      const counts=new Map();
      for(const w of list||[]){
        if(w.workResourceType!==type||!w.mineId)continue;
        counts.set(w.mineId,(counts.get(w.mineId)||0)+1);
      }
      let best=null,bestCount=0;
      for(const [id,count] of counts){
        if(count>bestCount||(count===bestCount&&best!=null&&String(id)<String(best))){best=id;bestCount=count}
      }
      return best;
    };
    const nearestTo=(origin,list)=>{
      let best=null,bd=Infinity;
      for(const x of list){
        const d=(x.x-origin.x)*(x.x-origin.x)+(x.y-origin.y)*(x.y-origin.y);
        if(d<bd||(d===bd&&best&&String(x.id)<String(best.id))){best=x;bd=d}
      }
      return best;
    };

    const mineralColor=[.27,.73,1,.24],mineralGlow=[.25,.70,1,.035];
    const gasColor=[.37,.90,.42,.25],gasGlow=[.34,.86,.40,.038];

    for(const base of dropoffs){
      const group=assignedByDropoff.get(base.id)||[];

      const mineralId=mostCommonTarget(group,"mineral");
      let mineral=minerals.find(m=>m.id===mineralId)||null;
      if(!mineral)mineral=nearestTo(base,minerals);
      if(mineral){
        drawDashed(base,mineral,{color:mineralColor,glow:mineralGlow,dash:11,gap:9,width:1.9,startPad:20,endPad:10});
      }

      const gasTarget=Math.max(0,Number(base.gasWorkerTarget)||0);
      if(gasTarget>0&&extractors.length){
        const extractorId=mostCommonTarget(group,"gas");
        let extractor=extractors.find(e=>e.id===extractorId)||null;
        if(!extractor)extractor=nearestTo(base,extractors);
        if(extractor){
          drawDashed(base,extractor,{color:gasColor,glow:gasGlow,dash:10,gap:8,width:1.9,startPad:20,endPad:10});
        }
      }
    }

    // Ground target ring below the actual flag and units.
    const b=this.worldToPx(this.viewX(flag.x),this.viewY(flag.y));
    const pulse=.5+.5*Math.sin(performance.now()*.0035);
    this.circle(
      b[0],b[1],
      Math.max(14,(25+3*pulse)*sc),
      forced?[1,.62,.12,.12]:(own?[.24,.55,1,.065]:[1,.32,.34,.065]),
      24
    );
    if(forced){
      this.outlineCircle(b[0],b[1],Math.max(20,(35+4*pulse)*sc),Math.max(1.4,2.2*sc),[1,.72,.20,.50],28,2);
    }
  }

  drawFlag(){
    if(!this.snapshot)return;
    const side=this.mySide(),f=this.predictedFlag||this.renderTrackedFlag(side);
    if(!f)return;

    const now=performance.now(),sc=this.sc();
    const[x,y]=this.worldToPx(this.viewX(f.x),this.viewY(f.y));

    // 해당 위치의 가장 최근 planting FX.
    let fx=null;
    for(let i=this.flagFx.length-1;i>=0;i--){
      const candidate=this.flagFx[i];
      if(candidate.side===side&&Math.hypot(candidate.x-f.x,candidate.y-f.y)<2){
        fx=candidate;
        break;
      }
    }

    const age=fx?now-fx.start:99999;
    const total=1250;
    const active=age<total;

    // ease helpers
    const clamp01=v=>Math.max(0,Math.min(1,v));
    const outBack=t=>{
      t=clamp01(t);
      const c1=1.70158,c3=c1+1;
      return 1+c3*Math.pow(t-1,3)+c1*Math.pow(t-1,2);
    };
    const outCubic=t=>1-Math.pow(1-clamp01(t),3);

    // 0~220ms: 위에서 빠르게 내려꽂힘.
    const dropT=clamp01(age/220);
    // 220~430ms: 충격/반동.
    const impactT=clamp01((age-220)/210);
    // 430~1250ms: 펄럭임 감쇠.
    const settleT=clamp01((age-430)/820);

    let poleBottomY=y;
    let poleTopY=y-46*sc;
    let poleTopX=x;

    if(active&&age<220){
      const e=outBack(dropT);
      // 처음에는 말뚝 전체가 위에 떠 있고 살짝 기울어진 채 내려온다.
      const lift=(1-e)*82*sc;
      poleBottomY=y-lift;
      poleTopY=poleBottomY-46*sc;
      poleTopX=x-(1-e)*20*sc;
    }else if(active&&age<430){
      // 지면을 찍은 직후 짧게 눌렸다가 바로 복원.
      const bounce=Math.sin(impactT*Math.PI)*7*sc*(1-impactT*.45);
      poleBottomY=y+bounce;
      poleTopY=poleBottomY-46*sc;
      poleTopX=x+Math.sin(impactT*Math.PI*2)*2.5*sc*(1-impactT);
    }

    // 그림자: 내려오는 동안 작아졌다가 충격 순간 넓어짐.
    const shadowAlpha=active?(.10+.16*outCubic(dropT)):.15;
    const shadowR=(active&&age<430
      ? (12+18*outCubic(dropT)+7*Math.sin(impactT*Math.PI))*sc
      : 25*sc);
    this.poly([
      [x-shadowR,y+7*sc],
      [x,y+12*sc],
      [x+shadowR,y+7*sc],
      [x,y+2*sc]
    ],[.03,.06,.08,shadowAlpha]);

    // 착지 충격파 / 먼지. 220ms 이후에만 발생.
    if(active&&age>=200&&age<760){
      const t=clamp01((age-200)/560);
      const ringR=(18+78*outCubic(t))*sc;
      const alpha=.32*(1-t);
      // 둥근 링 대신 polygon ring 느낌으로 두 개의 얇은 다각형 테두리.
      const seg=24;
      for(let j=0;j<seg;j++){
        const a0=j/seg*Math.PI*2;
        const a1=(j+1)/seg*Math.PI*2;
        const r0=ringR,r1=ringR+Math.max(1.4,2.5*sc);
        this.poly([
          [x+Math.cos(a0)*r0,y+Math.sin(a0)*r0*.42],
          [x+Math.cos(a1)*r0,y+Math.sin(a1)*r0*.42],
          [x+Math.cos(a1)*r1,y+Math.sin(a1)*r1*.42],
          [x+Math.cos(a0)*r1,y+Math.sin(a0)*r1*.42]
        ],[.72,.57,.34,alpha]);
      }

      // 결정적인 먼지 조각 8개. random을 사용하지 않아 프레임마다 튀지 않는다.
      for(let i=0;i<8;i++){
        const h=HashUtil.hash(String((fx?.seed||1)+i*7919));
        const ang=((h%1000)/1000)*Math.PI*2;
        const speed=.55+((h>>>10)%100)/180;
        const d=(16+62*t*speed)*sc;
        const rise=Math.sin(t*Math.PI)*(10+((h>>>17)%16))*sc;
        const dx=Math.cos(ang)*d;
        const dy=Math.sin(ang)*d*.45-rise;
        const rr=(2.2+((h>>>22)%4))*sc*(1-t*.55);
        this.poly([
          [x+dx-rr,y+dy],
          [x+dx,y+dy-rr*.75],
          [x+dx+rr,y+dy],
          [x+dx,y+dy+rr*.55]
        ],[.56,.43,.28,.42*(1-t)]);
      }
    }

    // 충격 순간 중앙 섬광 / 지면 파편.
    if(active&&age>=205&&age<390){
      const t=clamp01((age-205)/185);
      const a=.28*(1-t);
      for(let i=0;i<6;i++){
        const ang=-Math.PI*.88+i*Math.PI*.352;
        const len=(20+35*outCubic(t))*sc;
        this.line(
          x+Math.cos(ang)*8*sc,y+Math.sin(ang)*5*sc,
          x+Math.cos(ang)*len,y+Math.sin(ang)*len*.42,
          Math.max(1.2,2.1*sc),
          [1,.78,.34,a]
        );
      }
    }

    // 깃대: 검은 외곽 + 금속 하이라이트.
    const poleW=Math.max(2.2,4.0*sc);
    this.line(x,poleBottomY+5*sc,poleTopX,poleTopY,poleW,[.07,.10,.13,1]);
    this.line(x-.8*sc,poleBottomY+3*sc,poleTopX-.8*sc,poleTopY,Math.max(1,1.15*sc),[.55,.63,.68,.7]);

    // 바닥에 꽂힌 금속 스파이크.
    if(!active||age>=205){
      this.poly([
        [x-3.6*sc,y-1*sc],
        [x+3.6*sc,y-1*sc],
        [x,y+13*sc]
      ],[.14,.17,.19,1]);
    }

    // 천 펄럭임:
    // 충격 직후 크게 흔들리고 1초 동안 감쇠. 평상시에도 아주 미세하게 살아있다.
    const impactWave=active&&age>=220
      ? Math.sin((age-220)*.055)*16*sc*(1-settleT)
      : 0;
    const idleWave=Math.sin(now*.0045)*2.2*sc;
    const wave=impactWave+idleWave;
    const topY=poleTopY+4*sc;
    const clothH=19*sc;
    const clothW=34*sc;

    // 3분할 폴리곤 천으로 곡면 느낌.
    const p0=[poleTopX,topY];
    const p1=[poleTopX+clothW*.34,topY+3*sc+wave*.25];
    const p2=[poleTopX+clothW*.70,topY+1*sc-wave*.18];
    const p3=[poleTopX+clothW,topY+7*sc+wave*.38];
    const q0=[poleTopX,topY+clothH];
    const q1=[poleTopX+clothW*.34,topY+clothH-1*sc+wave*.16];
    const q2=[poleTopX+clothW*.70,topY+clothH+2*sc-wave*.12];
    const q3=[poleTopX+clothW*.86,topY+clothH-1*sc+wave*.30];

    const forced=!!f.forced;
    const blue=forced?[.96,.48,.08,1]:[.14,.39,.92,1];
    const blue2=forced?[1,.68,.12,1]:[.20,.50,1,1];
    const blue3=forced?[.72,.26,.03,1]:[.10,.29,.72,1];
    this.poly([p0,p1,q1,q0],blue3);
    this.poly([p1,p2,q2,q1],blue);
    this.poly([p2,p3,q3,q2],blue2);

    // 깃발 중앙의 작은 밝은 문장형 삼각 표식.
    const cx=poleTopX+clothW*.47,cy=topY+clothH*.50+wave*.05;
    if(forced){
      // Two inward chevrons identify the no-retaliation forced-move order.
      this.line(cx-8*sc,cy-3*sc,cx-1*sc,cy,Math.max(1.2,2*sc),[1,.98,.82,.98]);
      this.line(cx-8*sc,cy+3*sc,cx-1*sc,cy,Math.max(1.2,2*sc),[1,.98,.82,.98]);
      this.line(cx+8*sc,cy-3*sc,cx+1*sc,cy,Math.max(1.2,2*sc),[1,.98,.82,.98]);
      this.line(cx+8*sc,cy+3*sc,cx+1*sc,cy,Math.max(1.2,2*sc),[1,.98,.82,.98]);
    }else{
      this.poly([
        [cx-4*sc,cy+3*sc],
        [cx,cy-5*sc],
        [cx+5*sc,cy+3*sc]
      ],[.93,.96,1,.92]);
    }

    // 명령 확정 후 0.9초 정도 지휘 범위를 한 번 강조.
    if(active&&age>=300&&age<1100){
      const t=clamp01((age-300)/800);
      const rr=(28+35*outCubic(t))*sc;
      const aa=.16*(1-t);
      this.circle(x,y,rr,[.18,.43,.93,aa],32);
    }

    // 끝난 VFX 정리.
    if(this.flagFx.length){
      let write=0;
      for(let i=0;i<this.flagFx.length;i++){
        const e=this.flagFx[i];
        if(now-e.start<1600)this.flagFx[write++]=e;else this.flagFxPool.release(e);
      }
      this.flagFx.length=write;
    }
  }
  drawChargedSkillPreview(){
    const side=ConnectionSideUtil.roleSide(this.orientationRole()),cast=this.snapshot?.chargedCasts?.[side],sc=this.sc();
    const pointer=this.chargedSkillGesture;
    // White intent follows input immediately. Gold landing points below always
    // come from confirmed membership, readiness and the authoritative cast aim.
    if(pointer&&Number.isFinite(pointer.aimX)&&Number.isFinite(pointer.aimY)){
      const [px,py]=this.worldToPx(this.viewX(pointer.aimX),this.viewY(pointer.aimY));
      this.outlineCircle(px,py,5,1.3,[.92,.96,1,.8],12,1);
      if(pointer.pointerType==='touch'){
        this.line(px,py,px,py-48,1,[.92,.96,1,.5]);
        this.outlineCircle(px,py-48,8,1.5,[.92,.96,1,.85],12,1);
      }
    }
    if(!cast||!['gathering','charging'].includes(cast.phase)){
      const pending=this.chargedSkillGesture;
      if(pending){const [x,y]=this.worldToPx(pending.x,pending.y);this.outlineCircle(x,y,Math.max(12,20*sc),1.5,[.75,.83,.84,.7],16,1)}
      if(pending&&!ReplayPresentation.replayPlayer&&UiRuntimeState.value.target.type==='flag')UiRegistry.refs.hint.textContent='집결 지시 중 · 흰색: 내 조준 · 확정된 참가 병력을 기다립니다.';
      if(!pending&&!ReplayPresentation.replayPlayer&&UiRuntimeState.value.target.type==='flag'){
        const hint='탭: 자동전투 깃발 · 정지 홀드: 집결·충전 · 홀드 전 드래그: 맵 이동 · 이후 드래그: 조준 · 놓기: 발사';
        if(UiRegistry.refs.hint.textContent!==hint)UiRegistry.refs.hint.textContent=hint;
      }
      return;
    }
    const [x,y]=this.worldToPx(this.viewX(cast.originX),this.viewY(cast.originY));
    this.outlineCircle(x,y,ChargedSkillGeometry.gatheringR*sc,Math.max(1,2*sc),[.40,.87,.73,.55],48,1);
    const members=this.chargedMemberIds(side),unavailable=new Set(cast.unavailableIds);
    let ready=0,progress=0,unavailableCount=unavailable.size,centerX=0,centerY=0,targetX=0,targetY=0;
    for(const id of [...cast.memberIds,...cast.unavailableIds]){
      const unit=this.renderState.entity('unit',id);
      if(!unit?.alive)continue;
      const pose=this.renderTrackedScreenPosition(unit,"unit"),ux=pose.x,uy=pose.y,r=Math.max(5,this.unitRenderRadius(unit));
      if(!members.has(unit.id)||!ChargedSkillMixin.stateReady(unit,this.snapshot.tick)){
        if(members.has(unit.id))unavailableCount++;
        this.outlineCircle(ux,uy,r+4,1,[.60,.62,.64,.65],12,1);continue;
      }
      ready++;
      const target=ChargedSkillGeometry.aimPoint(unit,cast,this.snapshot.tick,this.snapshot.tps||SimulationTiming.tps(),this.world);
      progress=Math.max(progress,target.progress);
      const [tx,ty]=this.worldToPx(this.viewX(target.x),this.viewY(target.y));
      centerX+=pose.x;centerY+=pose.y;targetX+=tx;targetY+=ty;
      this.outlineCircle(ux,uy,r+4,Math.max(1,2*sc),[.72,.93,.57,.9],12,1);
      this.line(ux,uy,tx,ty,Math.max(1,1.5*sc),[.83,.92,.55,.36]);
      this.outlineCircle(tx,ty,Math.max(7,11*sc),Math.max(1.3,2*sc),[1,.85,.38,.9],16,1);
      this.line(tx-5,ty,tx+5,ty,1.5,[1,.95,.73,.95]);this.line(tx,ty-5,tx,ty+5,1.5,[1,.95,.73,.95]);
    }
    if(ready){
      const radius=ChargedSkillGeometry.gatheringR*sc,segments=48,filled=Math.floor(progress*segments);
      for(let i=0;i<filled;i++){
        const a=-Math.PI/2+i/segments*Math.PI*2,b=a+.8/segments*Math.PI*2;
        this.line(x+Math.cos(a)*radius,y+Math.sin(a)*radius,x+Math.cos(b)*radius,y+Math.sin(b)*radius,Math.max(2,3*sc),progress>=1?[.78,.95,1,.95]:[.45,.69,1,.85]);
      }
      if(progress>=1)this.outlineCircle(x,y,radius+4,Math.max(1,2*sc),[.78,.95,1,.5],48,1);
      const cx=centerX/ready,cy=centerY/ready,tx=targetX/ready,ty=targetY/ready,dx=tx-cx,dy=ty-cy,len=Math.hypot(dx,dy);
      if(pointer&&Number.isFinite(pointer.aimX)&&Number.isFinite(pointer.aimY)){
        const [px,py]=this.worldToPx(this.viewX(pointer.aimX),this.viewY(pointer.aimY)),ix=px-cx,iy=py-cy;
        if(Math.hypot(px-tx,py-ty)>4&&Math.hypot(ix,iy)>8){this.line(cx,cy,px,py,1.2,[.92,.96,1,.32]);this.crestTriangle(px,py,6,[.92,.96,1,.65],Math.atan2(iy,ix))}
      }
      if(len>8){
        this.line(cx,cy,tx,ty,Math.max(2,3*sc),[.45,.69,1,.65]);
        this.crestTriangle(tx,ty,Math.max(8,12*sc),[.67,.84,1,.95],Math.atan2(dy,dx));
      }
    }
    const [ax,ay]=this.worldToPx(this.viewX(cast.aimX),this.viewY(cast.aimY));
    // A connected offset indicator keeps the aim readable above a mobile finger.
    if(pointer?.pointerType==='touch'){this.line(ax,ay,ax,ay-32,1,[1,.88,.48,.6]);this.outlineCircle(ax,ay-32,6,2,[1,.88,.48,.9],12,1)}
    if(!ReplayPresentation.replayPlayer&&UiRuntimeState.value.target.type==='flag'){
      const message=`${cast.phase==='gathering'?'집결':'충전 '+Math.round(progress*100)+'%'} · 준비 ${ready} · 사용 불가 ${unavailableCount} · 흰 점: 포인터 · 금색: 확정 착탄 · 드래그 조준, 놓으면 발사`;
      if(UiRegistry.refs.hint.textContent!==message)UiRegistry.refs.hint.textContent=message;
    }
  }
  drawBuildPreview(){
    const p=this.buildPreview;
    if(!p||!p.building)return;
    const d=BuildingDefinition.get(p.building);
    if(!d)return;
    const[x,y]=this.worldToPx(p.x,p.y),sc=this.sc(),r=d.size*sc;

    const fill=p.valid?[.20,.78,.46,.34]:[.91,.24,.24,.34];
    const edge=p.valid?[.12,.62,.34,.95]:[.78,.12,.12,.95];
    this.rect(x-r,y-r,r*2,r*2,fill);
    this.line(x-r,y-r,x+r,y-r,Math.max(2,3*sc),edge);
    this.line(x+r,y-r,x+r,y+r,Math.max(2,3*sc),edge);
    this.line(x+r,y+r,x-r,y+r,Math.max(2,3*sc),edge);
    this.line(x-r,y+r,x-r,y-r,Math.max(2,3*sc),edge);
    this.circle(x,y,r*1.25,[edge[0],edge[1],edge[2],.08],18);

    if(p.density){
      const clusterR=(p.density.kind==="defense"?DEFENSE_CLUSTER_RADIUS:PRODUCTION_CLUSTER_RADIUS)*sc;
      const col=p.density.penalty>0?[.95,.30,.20,.12]:[.20,.75,.43,.08];
      this.circle(x,y,clusterR,col,36);

      // 밀집 패널티가 있으면 건물 바로 위에만 짧은 상태 막대를 표시.
      if(p.density.penalty>0){
        const bw=Math.max(28,64*sc),bh=Math.max(3,6*sc);
        this.rect(x-bw/2,y-r-13*sc,bw,bh,[.15,.08,.07,.75]);
        this.rect(x-bw/2,y-r-13*sc,bw*(p.density.speed/100),bh,[.95,.48,.20,.95]);
      }
    }
  }
  prepareFogSurfaces(atlas){
    if(this._fogSurfaceAtlas===atlas)return;
    const surfaces=new Map([[0,[]]]),add=(level,patch)=>{
      if(!surfaces.has(level))surfaces.set(level,[]);
      surfaces.get(level).push(patch);
    };
    for(const patch of atlas.presentationSurfaceMesh())add(patch.fogLevel,patch);
    for(const [id,texture] of this.fogTextures)if(!surfaces.has(Number(id.slice(6)))){
      this.device.deleteTexture(texture);this.fogTextures.delete(id);
    }
    for(const [id,texture] of this.fogPreviousTextures)if(!surfaces.has(Number(id.slice(6)))){
      this.device.deleteTexture(texture);this.fogPreviousTextures.delete(id);
    }
    this.resetFogTransition();
    this.fogSurfaces=surfaces;this._fogSurfaceAtlas=atlas;this._fogTextureKey=null;
  }
  resetFogTransition(){
    this._fogTransitionStartedAt=null;this._fogMaskContext=null;this._fogTextureKey=null;this.fogMaskRecords.clear();
  }
  fogTransitionAmount(now=performance.now()){
    return this._fogTransitionStartedAt==null?1:RangeUtil.clamp((now-this._fogTransitionStartedAt)/this.fogTransitionDurationMs,0,1);
  }
  fogVisibilityGrid(step=this.fogMaskStep||64){
    const activeStep=this.fogMaskStep||64;
    for(const key of this.fogVisibilityGrids.keys())if(key!==64&&key!==activeStep)this.fogVisibilityGrids.delete(key);
    let field=this.fogVisibilityGrids.get(step);
    if(!field||!field.sameGeometry(this,step)){field=new FogVisibilityGrid(this,step);this.fogVisibilityGrids.set(step,field)}
    return field.update(this);
  }
  fogVisionRevision(){return this.visionFields.map(field=>field?.revision??-1).join(",")}
  ensureFogTextures(){
    if(!this.snapshot)return null;
    const gl=this.gl,atlas=this.world.terrain.surfaces,step=this.fogMaskStep||64,w=Math.max(2,Math.ceil(this.world.width/step)+1),h=Math.max(2,Math.ceil(this.world.height/step)+1),
      key=`${this.snapshot.tick}|${this.replayVisionMode||this.mySide()}|${this.replayObserverAll?1:0}|${this.world.width}x${this.world.height}|${atlas.maxLevel}|${w}x${h}`;
    this.prepareFogSurfaces(atlas);
    if(this._fogTextureKey===key&&this._fogVisionRevision===this.fogVisionRevision())return this.fogMaskSize;
    const now=performance.now(),perspective=`${this.orientationRole()}|${this.replayVisionMode||this.mySide()}|${this.replayObserverAll?1:0}`,
      previous=this._fogMaskContext,delta=Number(this.snapshot.tick)-Number(previous?.tick),
      continuous=previous?.atlas===atlas&&previous.perspective===perspective&&previous.w===w&&previous.h===h&&delta>0&&delta<=Math.ceil((Number(this.snapshot.rules?.simulation?.tps)||SIM_TPS)*.25),
      amount=this.fogTransitionAmount(now);
    const upload=(textures,id,data)=>{
      let tex=textures.get(id);
      if(tex&&(this.fogMaskSize?.w!==w||this.fogMaskSize?.h!==h)){this.device.deleteTexture(tex);textures.delete(id);tex=null}
      if(!tex){tex=this.device.createTexture({width:w,height:h,data},{format:'luminance',filter:'linear'});textures.set(id,tex)}
      else this.device.updateTexture(tex,{width:w,height:h,data});return tex;
    };
    const visibility=this.fogVisibilityGrid(step);
    // Levels need not be contiguous: only surfaces that exist need a texture.
    for(const level of this.fogSurfaces.keys()){
      const id=`level:${level}`,target=visibility.atLevel(level),record=this.fogMaskRecords.get(id);
      // Blend only the presentation mask. Exact entity visibility continues to use
      // VisibilityPolicy against the current snapshot, never these texture values.
      let from=target;
      if(continuous&&record){
        from=new Uint8Array(target.length);
        for(let i=0;i<from.length;i++)from[i]=Math.round(record.from[i]+(record.target[i]-record.from[i])*amount);
        upload(this.fogPreviousTextures,id,from);
      }
      upload(this.fogTextures,id,target);this.fogMaskRecords.set(id,{from,target});
    }
    this._fogTransitionStartedAt=continuous?now:null;
    this._fogMaskContext={atlas,perspective,tick:this.snapshot.tick,w,h};
    this.fogMaskSize={w,h};
    this._fogTextureKey=key;this._fogVisionRevision=this.fogVisionRevision();return this.fogMaskSize;
  }
  fogVertex(world,bridgeId=null){
    const q=this.projectRenderWorldPosition(world),u=RangeUtil.clamp(world.x/this.world.width,0,1),v=RangeUtil.clamp(world.z/this.world.height,0,1);
    // Slight camera-facing bias keeps the transparent fog coplanar with terrain without z-fighting.
    this.fogFrame.push5(q.x,q.y,(bridgeId?this.renderDepthForWorld({...world,bridgeId}):q.depth)-.00035,u,v);
  }
  flushFog(texture,color,previousTexture=texture){
    if(!this.fogFrame.length||!texture)return;const d=this.fogFrame.view();
    this.device.uploadVertices(this.fogBuf,d);
    this.drawBatch(this.fogProgram,this.fogBuf,0,this.fogFrame.length/5,{
      r:[this.canvas.width,this.canvas.height],fog:color,tex:0,previousTex:1,
      transition:this.fogTransitionAmount(),maskSize:[this.fogMaskSize.w,this.fogMaskSize.h]
    },[texture,this._fogTransitionStartedAt==null?texture:previousTexture]);
    this.perfStats.drawCalls=(this.perfStats.drawCalls||0)+1;
    this.perfStats.bufferUploadBytes=(this.perfStats.bufferUploadBytes||0)+d.byteLength;this.fogFrame.reset();
  }
  drawFog(){
    if(this.replayObserverAll||!this.snapshot){this.resetFogTransition();return}this.ensureFogTextures();
    const gl=this.gl,color=this.replayVisionMode?[.008,.012,.018,.96]:[.025,.045,.048,.88];
    // Reuse terrain's projected spatial index and orientation filter. Tessellation
    // is built once; offscreen triangles never enter the per-frame Fog upload.
    const mesh=TerrainSurfaceProjection.forAtlas(this.world.terrain.surfaces).renderProjectedSurfaceMesh(this.orientationRole()==='guest'),
      a=this.projectedCoordinatesAtScreen(0,0),b=this.projectedCoordinatesAtScreen(this.canvas.width,this.canvas.height),visible=new Map();
    for(const tri of mesh.index.query(a.x,a.y,b.x,b.y,1/this.sc())){
      const level=tri.patch.fogLevel;if(!visible.has(level))visible.set(level,[]);visible.get(level).push(tri);
    }
    this.passState.depthEnabled=true;this.passState.depthFunc="lequal";this.passState.depthWrite=false;
    // The atlas clips the base floor around authored surfaces, including depressions.
    // Fog uses those same patches so an implicit level-0 plane cannot cover a lower floor.
    for(const level of this.fogSurfaces.keys()){this.fogFrame.reset();for(const tri of visible.get(level)||[])for(const v of tri.vertices)this.fogVertex(v,tri.patch.bridge?tri.patch.id:null);this.flushFog(this.fogTextures.get(`level:${level}`),color,this.fogPreviousTextures.get(`level:${level}`))}
    this.passState.depthEnabled=false;this.passState.depthWrite=false;
  }
  drawFogLandmarks(){
    if(this.replayObserverAll)return;
    if(!this.snapshot)return;
    const side=this.mySide(),sc=this.sc();

    // 1) 미네랄: 시야 밖에서도 자원 위치는 항상 알 수 있다.
    //    남은 양은 정확한 숫자로 노출하지 않고 크기/밝기만 약하게 표현한다.
    for(const m of this.snapshot.resources){
      if(m.amount<=0||!this.onScreenAuth(m.x,m.y,80)||this.visibleRaw(m.x,m.y))continue;
      const[x,y]=this.worldToPx(this.viewX(m.x),this.viewY(m.y));
      const r=Math.max(5,13*sc);
      this.circle(x,y,r,[.12,.34,.42,.72],7);
      this.circle(x,y-r*.10,r*.46,[.28,.55,.62,.50],6);
      // 암흑 속 고정 랜드마크라는 느낌의 얇은 외곽 링
      this.circle(x,y,r*1.28,[.12,.34,.42,.12],10);
    }

    // 가스 지점도 전략 자원 위치로 항상 표시.
    for(const g of this.snapshot.gasNodes||[]){
      if(!this.onScreenAuth(g.x,g.y,80)||this.visibleRaw(g.x,g.y))continue;
      const[x,y]=this.worldToPx(this.viewX(g.x),this.viewY(g.y));
      const r=Math.max(5,12*sc);
      this.circle(x,y,r,[.17,.42,.21,.65],9);
      this.circle(x,y,r*.45,[.32,.72,.36,.42],8);
    }

    // 2) 중립 캠프 위치: 사냥터 위치는 항상 알려준다.
    //    암흑에서는 현재 생존/리젠 상태는 표시하지 않아 정찰 가치가 남는다.
    for(const camp of this.snapshot.camps||[]){
      if(!this.onScreenAuth(camp.x,camp.y,100)||this.visibleRaw(camp.x,camp.y))continue;
      const[x,y]=this.worldToPx(this.viewX(camp.x),this.viewY(camp.y));
      const base=camp.kind==="relic"?16:camp.kind==="boars"?14:11;
      const r=Math.max(5,base*sc);
      const campCol=camp.spellReward?[.50,.30,.72,.68]:[.49,.35,.16,.56];
      this.circle(x,y,r,campCol,9);
      this.circle(x,y,r*1.45,[.78,.57,.22,.10],12);
      // 발자국을 연상시키는 작은 점 3개
      this.circle(x-r*.40,y-r*.82,r*.22,[.62,.45,.22,.65],7);
      this.circle(x,y-r*.98,r*.22,[.62,.45,.22,.65],7);
      this.circle(x+r*.40,y-r*.82,r*.22,[.62,.45,.22,.65],7);
    }

    // 3) 상대 메인 베이스: 위치/존재는 항상 알지만, 시야 밖에서는
    //    HP, 건설 상태, 주변 상황 등의 실시간 정보는 보여주지 않는다.
    const enemyBase=this.snapshot.buildings.find(
      b=>b.alive!==false&&b.side!==side&&BuildingDefinition.get(b.type)?.isMainBase
    );
    if(enemyBase&&!this.visibleRaw(enemyBase.x,enemyBase.y)){
      const[x,y]=this.worldToPx(this.viewX(enemyBase.x),this.viewY(enemyBase.y));
      const d=BuildingDefinition.get(enemyBase.type),r=d.size*sc;
      this.rect(x-r,y-r,r*2,r*2,[.28,.08,.10,.72]);
      this.rect(x-r*.55,y-r*.55,r*1.1,r*1.1,[.42,.15,.17,.76]);
      // 실루엣 외곽선
      const edge=[.62,.24,.26,.72],w=Math.max(1.5,2.5*sc);
      this.line(x-r,y-r,x+r,y-r,w,edge);
      this.line(x+r,y-r,x+r,y+r,w,edge);
      this.line(x+r,y+r,x-r,y+r,w,edge);
      this.line(x-r,y+r,x-r,y-r,w,edge);
      // 위치만 알려주는 중앙 표식. HP bar는 의도적으로 없음.
      this.circle(x,y,r*.20,[.78,.32,.34,.78],8);
    }
  }
  reportRenderFatal(err){
    if(this.renderFatalReported)return;
    this.renderFatalReported=true;
    const s=this.snapshot||{},entity=this.renderEntity||null;
    const diag={
      kind:"RALLY_FRONTIER_RENDER_FATAL",
      build:BUILD_META.id,buildMetadata:BUILD_META.snapshot(),
      at:new Date().toISOString(),
      renderer:this.backend||null,
      tick:Number(s.tick)||0,tps:Number(s.tps)||0,
      stage:this.renderStage||"unknown",
      entity:entity?{id:entity.id||null,type:entity.type||null,side:entity.side??null,x:entity.x??null,y:entity.y??null,burrowPhase:entity.burrowPhase||null,airborneUntil:entity.status?.airborneUntil||0,airborneHeight:entity.status?.airborneHeight||0}:null,
      projectiles:s.projectiles?.length||0,units:s.units?.length||0,
      message:String(err?.message||err),stack:String(err?.stack||"")
    };
    DiagnosticPresentation.presentFatalDiagnostic(diag);
  }

  renderGroundPass(){
    this.renderStage="ground";this.renderEntity=null;
    const gl=this.gl;this.passState.depthWrite=true;
    this.setRenderDepth(.97);this.begin();this.drawGround();this.flush();
    this.passState.depthWrite=false;
    this.begin();TerrainPresentation.drawSurfaceEdges(this);
    this.setRenderDepth(.969);this.drawStrategicMap();this.drawNeutralCampMarkers();this.drawRallyGuide();
    for(const u of this.snapshot?.units||[]){
      if(!u.alive||!UnitDefinition.get(u.type)?.burrowTrail||!BurrowableMixin.stateActive(u))continue;
      const own=u.side===this.mySide();
      if(!own&&!this.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR"))continue;
      if(UnitDefinition.get(u.type)?.burrowTrailRequiresDetection&&!own&&!this.detectedRaw(u.x,u.y))continue;
      const rp=this.renderTrackedPosition(u,"unit");
      const [bx,by]=this.worldToPx(this.viewX(rp.x),this.viewY(rp.y)),sc=this.sc();
      const pulse=.5+.5*Math.sin(this.presentationNow()*.018+(HashUtil.hash(u.id)%17));
      this.withWorldSpriteDepth({x:rp.x,y:.001,z:rp.y},()=>{
        this.circle(bx,by,Math.max(5,(12+4*pulse)*sc),[.34,.22,.12,.38],12);
        this.circle(bx,by,Math.max(3,(7+2*pulse)*sc),[.58,.39,.22,.34],10);
      });
    }
    this.flush();this.passState.depthWrite=true;
  }
  renderShadowPass(visibleUnits){
    if(!this.snapshot)return;
    this.passState.depthWrite=false;
    this.begin();this.renderStage="unit-shadow";
    for(const u of visibleUnits){this.renderEntity=u;try{this.drawUnitShadow(u,true)}catch(err){this.reportEntityRenderError("unit-shadow",u,err)}}
    this.flush();this.passState.depthWrite=true;
  }
  prepareWorldSpriteFrame(visibleUnits){
    const out=this.worldSpriteFrame;out.length=0;let used=0;
    const add=(kind,entity,world)=>{
      const entry=this.worldSpritePool[used]||(this.worldSpritePool[used]={});used++;
      entry.kind=kind;entry.entity=entity;entry.world=world;
      entry.depth=this.spriteDepthForWorld(world);entry.key=kind+":"+entity.id;out.push(entry);
    };
    for(const m of this.snapshot.resources||[])if(m.amount>0&&this.onScreenAuth(m.x,m.y,90))add("mineral",m,{x:m.x,y:0,z:m.y});
    for(const g of this.snapshot.gasNodes||[])if(this.onScreenAuth(g.x,g.y,90))add("gas",g,{x:g.x,y:0,z:g.y});
    for(const b of this.snapshot.buildings||[])if(b.alive!==false&&b.hp>0&&this.onScreenAuth(b.x,b.y,(BuildingDefinition.get(b.type)?.size||40)+100))add("building",b,{x:b.x,y:0,z:b.y});
    for(const u of visibleUnits)add("unit",u,this.resolveRenderWorldPosition(u,"unit"));
    for(const p of this.renderState.displayed("projectile",this.presentationNow())){
      if(!this.presentationEntityActive("projectile",p.id))continue;
      const world=this.resolveRenderWorldPosition(p,"projectile");
      const screen=this.projectRenderWorldPosition(world),pad=90*this.sc();
      if(screen.x>=-pad&&screen.y>=-pad&&screen.x<=this.canvas.width+pad&&screen.y<=this.canvas.height+pad)add("projectile",p,world);
    }
    const started=performance.now();
    out.sort((a,b)=>b.depth-a.depth||(a.key<b.key?-1:a.key>b.key?1:0));
    this.perfStats.cpuDepthSortMs=performance.now()-started;
    this.perfStats.visibleSprites=out.length;
    return out;
  }
  appendTerrainOccludedBody(start,end,world=null){
    if(end<=start)return;
    const deck=world?this.renderBridgeAt(world.x,world.z):null;
    if(deck&&world.y<deck.elevation-.01)return;
    const src=this.frame.data,dst=this.terrainOccludedBodyFrame;
    let minX=Infinity,minY=Infinity,maxX=-Infinity,maxY=-Infinity;
    for(let i=start;i<end;i+=7){minX=Math.min(minX,src[i]);maxX=Math.max(maxX,src[i]);minY=Math.min(minY,src[i+1]);maxY=Math.max(maxY,src[i+1])}
    const a=this.projectedCoordinatesAtScreen(minX,minY),b=this.projectedCoordinatesAtScreen(maxX,maxY);
    const projected=TerrainSurfaceProjection.forAtlas(this.world.terrain.surfaces).projectedSurfaceMesh(this.orientationRole()==='guest');
    if(!projected.transitionIndex.query(a.x,a.y,b.x,b.y).length)return;
    dst.ensure(end-start);
    // Copy the actual body silhouette. A stencil union prevents darker overlaps
    // where its component triangles meet. No body is generated a second time.
    for(let i=start;i<end;i+=21){
      if(Math.min(src[i+6],src[i+13],src[i+20])<.5)continue;
      for(let j=i;j<i+21;j+=7)dst.push7(src[j],src[j+1],src[j+2],.34,.68,1,.34);
    }
  }
  renderTerrainOccludedBodies(){
    const frame=this.terrainOccludedBodyFrame;if(!frame.length)return;
    const gl=this.gl;
    this.device.clear({stencil:0});
    this.passState.stencil={func:"equal",ref:0,mask:255,writeMask:255,fail:"keep",zfail:"keep",pass:"increment"};
    this.passState.depthFunc="greater";
    this.flush(frame);
    this.passState.stencil=false;this.passState.depthFunc="lequal";
  }
  renderTerrainOcclusionDepth(){
    const atlas=this.world.terrain.surfaces,gl=this.gl;
    if(!atlas._occlusionMesh){
      atlas._occlusionMesh=[];
      for(const patch of atlas.renderSurfaceMesh)if(patch.kind==='cliff'||patch.bridge)
        for(const indices of patch.triangles)atlas._occlusionMesh.push({vertices:indices.map(i=>patch.bridge?{...patch.vertices[i],bridgeId:patch.id}:patch.vertices[i])});
    }
    const projection=TerrainSurfaceProjection.forAtlas(atlas).projectedTriangleMesh(atlas._occlusionMesh,this.orientationRole()==='guest'),a=this.projectedCoordinatesAtScreen(0,0),b=this.projectedCoordinatesAtScreen(this.canvas.width,this.canvas.height);
    this.passState.depthWrite=true;this.device.clear({depth:1});this.passState.colorMask=[false,false,false,false];this.begin();
    try{
      for(const item of projection.index.query(a.x,a.y,b.x,b.y))for(const v of item.tri.vertices){
        const p=this.projectRenderWorldPosition(v);this.setRenderDepth(p.depth);this.v(p.x,p.y,[1,1,1,1]);
      }
      this.flush();
    }finally{this.passState.colorMask=[true,true,true,true];this.passState.depthWrite=false;this.begin()}
  }
  renderWorldPass(visibleUnits){
    if(!this.snapshot)return;
    const gl=this.gl;this.renderTerrainOcclusionDepth();this.terrainOccludedBodyFrame.reset();this.begin();
    // Terrain alone owns the depth buffer. Each billboard's authored painter
    // order must never compete with its own coplanar component triangles.
    let lastPainter=null;
    for(const entry of this.prepareWorldSpriteFrame(visibleUnits)){
      const {kind,entity,world}=entry;this.renderEntity=entity;this.renderStage=kind;
      const nextPainter=kind==="unit"&&this.shouldUseVectorUnitArt(entity)?"vector":"frame";
      if(lastPainter&&nextPainter!==lastPainter){
        if(lastPainter==="vector")this.flushVectorMesh("vector-to-frame-painter-switch");
        else if(this.frame.length){this.flush(this.frame,true);this.begin()}
      }
      lastPainter=nextPainter;
      this.withWorldSpriteDepth(world,()=>{
        if(kind==="unit")this.drawUnitSafely(entity,{skipShadow:true,visibilityChecked:true,worldPosition:world});
        else if(kind==="building")this.drawBuildingSafely(entity);
        else if(kind==="projectile")this.drawProjectileSafely(entity);
        else if(kind==="mineral")this.drawMineral(entity);
        else this.drawGasNode(entity);
      });
    }
    this.flushVectorMesh("world-pass-end");
    if(this.frame.length){this.flush(this.frame,true);this.begin()}
    this.passState.depthWrite=false;
    try{
      // Behind-terrain friendly bodies are faint, and foreground sprites paint
      // over them. Fog/detection filtering has already selected visibleUnits.
      this.renderTerrainOccludedBodies();this.flush(this.frame,true);
    }finally{
      this.passState.stencil=false;this.passState.depthFunc="lequal";this.passState.depthWrite=true;
    }
  }
  renderOverlayPass(){
    this.passState.depthEnabled=false;this.passState.depthWrite=false
    this.drawFog();
    this.begin();this.setRenderDepth(0);
    this.drawSharedShieldsOverlay();this.drawFogLandmarks();this.drawActiveSpells();this.flush();
    this.begin();if(this.snapshot?.launchMode)this.drawLaunchOverlay();else{this.drawFlag();this.drawChargedSkillPreview()}this.flush();
  }
  drawLaunchOverlay(){
    const s=this.snapshot,side=ConnectionSideUtil.roleSide(this.orientationRole()),sc=this.sc(),now=performance.now();
    const main=BuildingDefinition.forRole("mainBase"),outpost=BuildingDefinition.forRole("outpost"),reloadTicks=SimulationTiming.msToTicks(LaunchRules.reloadMs,s.tps||SimulationTiming.tps());
    // Overheated cannons glow red; reloading ones show a thin ring.
    for(const b of s.buildings||[]){
      if(b.side!==side||b.alive===false||(b.type!==main&&b.type!==outpost))continue;
      const wait=(Number(b.launchReadyTick)||0)-s.tick;if(wait<=0)continue;
      const [x,y]=this.worldToPx(this.viewX(b.x),this.viewY(b.y)),r=Math.max(18,((BuildingDefinition.get(b.type)?.size||40)+10)*sc),hot=wait>reloadTicks;
      this.outlineCircle(x,y,r,Math.max(2,3*sc),hot?[1,.3,.2,.5+.4*(Math.floor(now/160)%2)]:[.92,.92,.92,.45],32);
    }
    const hold=LaunchPresentation.hold;
    if(hold){
      const [cx,cy]=this.worldToPx(this.viewX(hold.cannonX),this.viewY(hold.cannonY)),[ax,ay]=this.worldToPx(this.viewX(hold.aimX),this.viewY(hold.aimY));
      const held=now-hold.armedAt,power=LaunchRules.power(held),burnt=LaunchRules.overheated(held),full=power>=1;
      const color=burnt?[1,.22,.16,1]:full?[1,.78,.2,(Math.floor(now/90)%2)?1:.55]:[1,.95,.75,.9],w=Math.max(2,3*sc);
      // Landing ring: the point the sim will pick for this hold time and direction, sized by the grain's splash.
      const at=LaunchPresentation.landing(hold,held,this.world);
      const [lx,ly]=this.worldToPx(this.viewX(at.x),this.viewY(at.y)),splash=Math.max(14,(LaunchRules.grain(hold.card)?.splash||120)*sc);
      this.line(cx,cy,lx,ly,Math.max(1.5,2*sc),[color[0],color[1],color[2],.45]);
      this.outlineCircle(lx,ly,splash,w,color,40);
      this.line(lx-8,ly,lx+8,ly,2,color);this.line(lx,ly-8,lx,ly+8,2,color);
      // The previous shot's landing distance, as a faint ring at that reach.
      if(hold.lastPower!=null&&!full){
        const last=LaunchPresentation.landing(hold,hold.lastPower*LaunchRules.chargeMs,this.world);
        const [px,py]=this.worldToPx(this.viewX(last.x),this.viewY(last.y));
        this.outlineCircle(px,py,Math.max(8,10*sc),Math.max(1.5,2*sc),[1,1,1,.55],20);
      }
    }
    const W=this.canvas.width,H=this.canvas.height,pad=Math.max(18,26*sc);
    for(const m of LaunchPresentation.marks){
      const age=RangeUtil.clamp((now-m.at)/LaunchRules.landingMarkMs,0,1),alpha=1-age,col=[1,.9,.5,alpha];
      const [x,y]=this.worldToPx(this.viewX(m.x),this.viewY(m.y));
      if(x>=0&&x<=W&&y>=0&&y<=H){
        this.outlineCircle(x,y,Math.max(14,(30+40*age)*sc),Math.max(2,3*sc),col,32);
        this.line(x-8,y,x+8,y,2,[1,1,1,alpha]);this.line(x,y-8,x,y+8,2,[1,1,1,alpha]);
        continue;
      }
      // Off-screen landing: an arrow on the screen edge points at it.
      let dx=x-W/2,dy=y-H/2;const k=Math.min((W/2-pad)/Math.max(1e-6,Math.abs(dx)),(H/2-pad)/Math.max(1e-6,Math.abs(dy)));
      const ex=W/2+dx*k,ey=H/2+dy*k,len=Math.hypot(dx,dy)||1,a=Math.max(16,26*sc);dx/=len;dy/=len;
      this.line(ex,ey,ex-dx*a+dy*a*.65,ey-dy*a-dx*a*.65,4,col);
      this.line(ex,ey,ex-dx*a-dy*a*.65,ey-dy*a+dx*a*.65,4,col);
      this.circle(ex-dx*a*.45,ey-dy*a*.45,4,col,10);
    }
  }
  renderUiFxPass(){
    if(this.spellPreview){this.begin();this.drawSpellPreview();this.flush()}
    if(this.buildPreview){this.begin();this.drawBuildPreview();this.flush()}
    if(this.snapshot?.constructionOrders?.length||this.pendingBuildGhosts?.length||this.latencySpellFx?.length){
      this.begin();this.drawConstructionOrders();this.drawPendingBuildGhosts();this.drawLatencySpellFx();this.flush();
    }
    this.drawFloatingFx();
    this.passState.depthWrite=true;this.passState.depthEnabled=true
  }
  displayCoordinatesAtScene(x,y){return{x:x+(this.frameShakeX||0),y:y+(this.frameShakeY||0)}}
  sceneCoordinatesAtDisplay(x,y,{sampled=false}={}){
    const sx=this.frameShakeX||0,sy=this.frameShakeY||0,point={x:x-sx,y:y-sy};
    // The final texture repeats its border texel where the translated scene ends.
    // Picking follows that displayed sample; internal scene queries stay unclamped.
    return sampled&&(sx||sy)?{x:RangeUtil.clamp(point.x,.5,this.canvas.width-.5),y:RangeUtil.clamp(point.y,.5,this.canvas.height-.5)}:point;
  }
  renderCameraShakePass(){
    // Translate the resolved, antialiased scene once; geometry, visibility and Fog
    // have already rendered with the same stable projection as spatial inference.
    const gl=this.gl,w=this.canvas.width,h=this.canvas.height,{x:sx,y:sy}=this.displayCoordinatesAtScene(0,0);
    // Prime the program and sized texture with an identity copy on first use or
    // resize, so the first impact never pays the cold composition setup cost.
    const needsWarmup=!this.frameComposition||this.frameComposition.width!==w||this.frameComposition.height!==h;
    if(!sx&&!sy&&!needsWarmup){
      if(this.cameraShakePresentationMoved){
        if(this.fxCanvas)this.fxCanvas.style.transform='translate(0px,0px)';
        for(const el of document.querySelectorAll('.campaign-world-ping'))el.style.translate='0px 0px';
        this.cameraShakePresentationMoved=false;
      }
      return;
    }
    const rect=this.canvas.getBoundingClientRect(),cssX=sx*rect.width/w,cssY=sy*rect.height/h;
    if(this.fxCanvas)this.fxCanvas.style.transform=`translate(${cssX}px,${cssY}px)`;
    for(const el of document.querySelectorAll('.campaign-world-ping'))el.style.translate=`${cssX}px ${cssY}px`;
    this.cameraShakePresentationMoved=!!sx||!!sy;
    if(!this.frameComposition){
      const precision=gl.getShaderPrecisionFormat(gl.FRAGMENT_SHADER,gl.HIGH_FLOAT)?.precision?'highp':'mediump';
      const program=this.device.createPipeline({vertex:'attribute vec2 position;void main(){gl_Position=vec4(position,0.0,1.0);}',
        fragment:`precision ${precision} float;uniform sampler2D scene;uniform vec2 size;uniform vec2 offset;void main(){gl_FragColor=texture2D(scene,(gl_FragCoord.xy-offset)/size);}`,
        stride:8,attributes:[{name:'position',size:2,offset:0}],uniforms:{scene:'1i',size:'2f',offset:'2f'}});
      const buffer=this.device.createVertexBuffer({capacityBytes:48});
      this.frameComposition={program,buffer,texture:null,width:0,height:0};
    }
    const c=this.frameComposition;
    if(c.width!==w||c.height!==h){if(c.texture)this.device.deleteTexture(c.texture);c.texture=this.device.createTexture({width:w,height:h,data:null});c.width=w;c.height=h}
    this.device.uploadVertices(c.buffer,new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]));
    this.device.copyFrameToTexture(c.texture);
    this.device.draw({pipeline:c.program,buffer:c.buffer,count:6,uniforms:{scene:0,size:[w,h],offset:[sx,-sy]},textures:[c.texture],blend:false,depth:false});
  }

  renderMinimapPass(){
    const now=performance.now();
    if(ActiveViewState.minimap&&now-ActiveViewState.minimap.lastDrawAt>=100)ActiveViewState.minimap.draw();
  }

  loop(){
    try{
    const frameStarted=performance.now();this._framePresentationAt=frameStarted;
    this.prunePredictedFlag(frameStarted);
    this.resize();
    // DOM viewport synchronization is once per frame, not once per terrain/Fog vertex.
    // All math still uses the shared camera; input and standalone passes refresh on demand.
    LaunchPresentation.followAim(this);
    this._frameCamera=this.stableCamera();
    this.updateClientShake();

    // Result/lobby UI owns the screen after a match ends. Do not continue sampling
    // presentation state from an ended match (especially the delayed sample buffer).
    if(UiRuntimeState.value.screen!=="game"&&UiRuntimeState.value.screen!=="replay"){
      if(this.vectorContext.active)this.vectorContext.endFrame();
      if(this.vectorContext.beginFrame())this.vectorContext.endFrame();
      requestAnimationFrame(this.loop);
      return;
    }

    const rp=this.perfStats;
    rp.drawCalls=0;rp.bufferUploadBytes=0;rp.cpuDepthSortMs=0;
    this.geometryTemplateHits=0;this.unitBodyMeshCacheHits=0;this.unitBodyMeshCacheMisses=0;

    this.passProfiler.beginFrame();
    const visibleUnits=this.passProfiler.measure("prepare",()=>this.snapshot?this.prepareVisibleUnitFrame():this.visibleUnitFrame);
    if(this.vectorContext.active)this.vectorContext.endFrame();
    this.grainFaces.prepare();
    if(!this.passProfiler.measure("device-begin",()=>this.vectorContext.beginFrame())){requestAnimationFrame(this.loop);return}
    Object.assign(this.passState,{depthEnabled:true,depthWrite:true,depthFunc:'lequal',stencil:false,colorMask:[true,true,true,true]});

    this.passProfiler.measure("ground",()=>this.renderGroundPass());
    this.vectorAssetDrawnInstances=0;this.vectorTerrainOcclusionTests=0;this.vectorTerrainOcclusionRegions=0;this.vectorTerrainOcclusionTriangles=0;
    this.passProfiler.measure("world",()=>this.renderWorldPass(visibleUnits));
    this.passProfiler.measure("shadow",()=>this.renderShadowPass(visibleUnits));
    this.passProfiler.measure("overlay",()=>this.renderOverlayPass());
    this.passProfiler.measure("ui-fx",()=>this.renderUiFxPass());
    this.passProfiler.measure("camera-compose",()=>this.renderCameraShakePass());
    this.passProfiler.measure("minimap",()=>this.renderMinimapPass());

    const vectorStats=this.vectorContext.stats().mesh;
    rp.vectorAssetDraws=this.vectorAssetDrawnInstances;rp.vectorAssetInstances=vectorStats.instances;rp.vectorAssetDrawCalls=vectorStats.draws;
    rp.vectorFlushDiagnostics=MobileBattleTestMode.phase==="sampling"&&MobileBattleTestMode.vectorFlushDiagnosticsAvailable?{
      safeAlphaRunBatching:vectorStats.safeAlphaRunBatching===true,
      flushReasons:{...vectorStats.flushReasons},drawDispatchReasons:{...vectorStats.drawDispatchReasons},
      alphaRunSafeBatches:vectorStats.alphaRunSafeBatches,alphaRunBatchedInstances:vectorStats.alphaRunBatchedInstances,alphaRunDrawsSaved:vectorStats.alphaRunDrawsSaved,
      alphaRunSafeRunDraws:vectorStats.alphaRunSafeRunDraws,alphaRunImmediateRunDraws:vectorStats.alphaRunImmediateRunDraws,
      alphaRunOverlapBoundaries:vectorStats.alphaRunOverlapBoundaries,alphaRunSignatureBoundaries:vectorStats.alphaRunSignatureBoundaries,
      alphaRunUnbatchableBounds:vectorStats.alphaRunUnbatchableBounds,alphaRunImmediateInstances:vectorStats.alphaRunImmediateInstances
    }:null;
    rp.vectorTerrainOcclusionTests=this.vectorTerrainOcclusionTests;rp.vectorTerrainOcclusionRegions=this.vectorTerrainOcclusionRegions;rp.vectorTerrainOcclusionTriangles=this.vectorTerrainOcclusionTriangles;
    rp.vectorAssetGeometryBytes=vectorStats.geometryBytesUploaded;rp.vectorAssetInstanceBytes=vectorStats.instanceBytesUploaded;rp.vectorAssetRetainedBytes=vectorStats.retainedBytes;rp.vectorAssetMeshes=vectorStats.meshCount;
    if(MobileBattleTestMode.phase==="sampling"){
      rp.vectorAlphaRunCacheHits=vectorStats.alphaRunCacheHits;rp.vectorAlphaRunCacheMisses=vectorStats.alphaRunCacheMisses;
      rp.vectorGeometryUploads=vectorStats.geometryUploads;rp.vectorPartUniformBytesSubmitted=vectorStats.partUniformBytesSubmitted;rp.vectorStagingBytes=vectorStats.stagingBytes;
    }
    rp.drawCalls+=vectorStats.draws;rp.bufferUploadBytes+=vectorStats.geometryBytesUploaded+vectorStats.instanceBytesUploaded;
    rp.geometryTemplateHits=this.geometryTemplateHits;
    rp.unitBodyMeshCacheHits=this.unitBodyMeshCacheHits;
    rp.unitBodyMeshCacheMisses=this.unitBodyMeshCacheMisses;
    rp.unitBodyMeshCacheSize=this.unitBodyMeshCache.size;
    rp.passes=this.passProfiler.snapshot();
    const frameEnded=performance.now(),work=frameEnded-frameStarted;
    rp.frameWorkMs=work;rp.maxFrameWorkMs=Math.max(rp.maxFrameWorkMs||0,work);
    rp.ewmaFrameWorkMs=rp.ewmaFrameWorkMs?rp.ewmaFrameWorkMs*.85+work*.15:work;
    const frameInterval=Math.max(0,frameEnded-(rp.lastFrameAt||frameEnded));
    rp.lastFrameAt=frameEnded;
    if(frameInterval>0){
      rp.frameIntervalMs=frameInterval;
      rp.ewmaFrameIntervalMs=rp.ewmaFrameIntervalMs?rp.ewmaFrameIntervalMs*.85+frameInterval*.15:frameInterval;
      rp.maxFrameIntervalMs=Math.max(rp.maxFrameIntervalMs||0,frameInterval);
    }
    if(MobileBattleTestMode.phase==="sampling"){
      rp.frameSequence=(rp.frameSequence||0)+1;
      MobileBattleTestMode.captureRendererFrame(frameEnded,rp);
    }
    rp.frames++;
    const fpsSpan=frameEnded-rp.fpsWindowAt;
    if(fpsSpan>=1000){
      rp.fps=rp.frames*1000/fpsSpan;rp.frames=0;rp.fpsWindowAt=frameEnded;
      // Recent max, not lifetime max, so a mobile spike remains visible for about a second.
      rp.maxFrameIntervalMs=rp.frameIntervalMs||0;
      rp.maxFrameWorkMs=rp.frameWorkMs||0;
    }
    requestAnimationFrame(this.loop);
    }catch(err){
      this.reportRenderFatal(err);
      // Do not permanently kill requestAnimationFrame. Entity-level failures are isolated
      // above; a remaining frame-level failure keeps the diagnostic visible and retries so
      // recovery/correction or a later valid snapshot can restore presentation.
      requestAnimationFrame(this.loop);
    }finally{if(this.vectorContext.active)this.vectorContext.endFrame();this._framePresentationAt=null;this._frameCamera=null}

  }
}
class MiniMap{
  constructor(canvas){
    this.canvas=canvas;
    this.ctx=canvas.getContext("2d");
    this.renderer=null;
    this.snapshot=null;
    this.lastDrawAt=0;this.fogMaskTarget=null;this.fogMaskDarkKey='';
    this.dragging=false;
    this.pointerId=null;
    this.bind();
  }
  bind(){
    const jump=e=>{
      if(!this.renderer)return;
      e.preventDefault();
e.stopPropagation();

      const rect=this.contentRect();
      const px=RangeUtil.clamp(e.clientX-rect.left,0,rect.width);
      const py=RangeUtil.clamp(e.clientY-rect.top,0,rect.height);

      // 미니맵 좌표는 항상 "내 본진 좌하단 → 적 본진 우상단" 사용자 시점.
      const viewWorldX=px/rect.width*this.renderer.world.width;
      const viewWorldY=py/rect.height*this.renderer.world.height;

      // 탭한 지점이 화면 중앙에 오도록 즉시 점프.
      const vw=this.renderer.viewWorldW(),vh=this.renderer.viewWorldH();
      this.renderer.cameraLeft=RangeUtil.clamp(viewWorldX-vw/2,0,Math.max(0,this.renderer.world.width-vw));
      const elevation=this.renderer.world.terrain.surfaces.heightAt(this.renderer.viewX(viewWorldX),this.renderer.viewY(viewWorldY));
      this.renderer.cameraTop=this.renderer.clampCameraTop(BattlefieldProjection.planarY(viewWorldY,elevation)-vh/2);

      if(LocalEnvironmentUtil.isLocalTest()&&ActiveViewState.role){
        ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft=this.renderer.cameraLeft;
        ViewRuntimeState.byRole[ActiveViewState.role].cameraTop=this.renderer.cameraTop;
      }
      this.draw();
    };

    this.input=RallyGamekit.createDOMInput({target:this.canvas,
      pointerButtons:{0:'minimap',1:'minimap',2:'minimap'},touchAction:'none',
      onPointer:point=>{
        const e=point.originalEvent;
        if(point.type==='down'){
          if(this.dragging&&this.pointerId!==point.pointerId)return;
          this.dragging=true;this.pointerId=point.pointerId;jump(e);
        }else if(point.type==='move'){
          if(this.dragging&&this.pointerId===point.pointerId)jump(e);
        }else if(this.pointerId===point.pointerId){
          this.dragging=false;this.pointerId=null;e?.preventDefault();e?.stopPropagation();
        }
      },onRelease:()=>{this.dragging=false;this.pointerId=null}
    });
  }
  set(renderer,snapshot){
    this.renderer=renderer;
    this.snapshot=snapshot;
    this.canvas.style.objectFit="contain";
  }
  contentRect(){
    const rect=this.canvas.getBoundingClientRect(),scale=Math.min(rect.width/this.canvas.width,rect.height/this.canvas.height);
    const width=this.canvas.width*scale,height=this.canvas.height*scale;
    return {left:rect.left+(rect.width-width)/2,top:rect.top+(rect.height-height)/2,width,height};
  }
  resize(){
    const dpr=Math.min(1.6,devicePixelRatio||1),world=this.renderer?.world||WorldContext.standard;
    const scale=Math.min(this.canvas.clientWidth/world.width,this.canvas.clientHeight/world.height)*dpr;
    const w=Math.max(1,Math.round(world.width*scale));
    const h=Math.max(1,Math.round(world.height*scale));
    if(this.canvas.width!==w||this.canvas.height!==h){
      this.canvas.width=w;
      this.canvas.height=h;
    }
  }
  point(authX,authY){
    const vx=this.renderer.viewX(authX);
    const vy=this.renderer.viewY(authY);
    return[
      vx/this.renderer.world.width*this.canvas.width,
      vy/this.renderer.world.height*this.canvas.height
    ];
  }
  dot(x,y,r,color){
    const c=this.ctx;
    c.beginPath();
    c.arc(x,y,r,0,Math.PI*2);
    c.fillStyle=color;
    c.fill();
  }
  drawFog(){
    const r=this.renderer;if(!r||r.replayObserverAll)return;const w=this.canvas.width,h=this.canvas.height,field=r.fogVisibilityGrid(64),mw=field.w,mh=field.h,
      mask=this.fogMask||(this.fogMask=document.createElement('canvas'));if(mask.width!==mw||mask.height!==mh){mask.width=mw;mask.height=mh}
    const target=field.atGround(r),dark=r.replayVisionMode?[2,4,6,245]:[7,12,13,224],darkKey=dark.join(',');
    if(this.fogMaskTarget!==target||this.fogMaskDarkKey!==darkKey){
      const c=mask.getContext('2d'),img=c.createImageData(mw,mh);
      for(let k=0;k<target.length;k++){const p=k*4;img.data[p]=dark[0];img.data[p+1]=dark[1];img.data[p+2]=dark[2];img.data[p+3]=target[k]?0:dark[3]}
      c.putImageData(img,0,0);this.fogMaskTarget=target;this.fogMaskDarkKey=darkKey;
    }
    const out=this.ctx;out.save();out.imageSmoothingEnabled=true;out.imageSmoothingQuality='high';out.drawImage(mask,0,0,mw,mh,0,0,w,h);out.restore();
  }
  draw(){
    if(!this.renderer||!this.snapshot)return;
    this.lastDrawAt=performance.now();
    this.resize();

    const c=this.ctx,w=this.canvas.width,h=this.canvas.height,s=this.snapshot,r=this.renderer;
    c.clearRect(0,0,w,h);
    TerrainPresentation.fillPlanarGround(c,w,h);

    // 현재 맵 descriptor의 실제 지형을 먼저 표시한다.
    // 미니맵은 전략 지도를 축약한 것이므로 강/고지/등고선을 생략하지 않는다.
    const miniTerrain=MapGeneration.mapTerrainDescriptor(s.mapDescriptor);
    const drawMiniRiverPolygon=(poly,fill)=>{
      if(!Array.isArray(poly)||poly.length<3)return;
      const pts=poly.map(p=>this.point(p.x,p.y));
      c.fillStyle=fill;c.beginPath();c.moveTo(pts[0][0],pts[0][1]);
      for(let i=1;i<pts.length;i++)c.lineTo(pts[i][0],pts[i][1]);
      c.closePath();c.fill();
    };
    drawMiniRiverPolygon(miniTerrain.riverPolygon||[],"#326d84cc");
    for(const poly of miniTerrain.riverBranchPolygons||[])drawMiniRiverPolygon(poly,"#39778ccc");
    if((!miniTerrain.riverPolygon||miniTerrain.riverPolygon.length<3)&&(miniTerrain.riverPath||[]).length>1){
      const pts=miniTerrain.riverPath.map(p=>this.point(p.x,p.y));
      c.lineCap="round";c.strokeStyle="#326d84";c.lineWidth=Math.max(2,(miniTerrain.riverHalfWidth||80)/this.renderer.world.width*w*2);
      c.beginPath();c.moveTo(pts[0][0],pts[0][1]);for(let i=1;i<pts.length;i++)c.lineTo(pts[i][0],pts[i][1]);c.stroke();
    }
    TerrainPresentation.drawMini(c,s.mapDescriptor,p=>this.point(p.x,p.y),w/this.renderer.world.width);
    // 현재 맵 descriptor의 실제 lane을 표시한다.
    const miniLanePoints=s.mapDescriptor?.laneControlPoints||LANE_CONTROL_POINTS;
    for(const lane of ((s.mapDescriptor?.terrain?.roads?.length)?[]:[
      {id:"top",color:"#72b8f477"},
      {id:"mid",color:"#ead36e77"},
      {id:"bot",color:"#8bd57b77"}
    ])){
      const pts=miniLanePoints[lane.id].map(p=>this.point(p.x,p.y));
      c.strokeStyle=lane.color;
      c.lineWidth=Math.max(1,w*.014);
      c.beginPath();c.moveTo(pts[0][0],pts[0][1]);
      for(let i=1;i<pts.length;i++)c.lineTo(pts[i][0],pts[i][1]);
      c.stroke();
    }

    // 스타크래프트식 미니맵 가시성:
    // 먼저 지형 바탕에 현재 전장 시야 Fog를 적용해 "지금 확보한 시야"를 밝게 구분한다.
    // 알려진 전략 지점은 그 위에 다시 그려 Fog 밖에서도 위치 자체는 계속 읽을 수 있게 한다.
    this.drawFog();

    // TOP / MID / BOT 점령지는 항상 전략 정보로 표시.
    for(const cp of s.capturePoints||[]){
      const p=this.point(cp.x,cp.y);
      const relation=r.factionRelation(cp.owner);
      const col=relation==="friendly"?"#4d93ff":relation==="neutral"?(cp.enabled?"#e7bc48":"#68717a"):"#ef5757";
      this.dot(p[0],p[1],3.2,col);
      c.strokeStyle=col;c.lineWidth=1;
      c.beginPath();c.arc(p[0],p[1],5.2,0,Math.PI*2);c.stroke();
    }

    if(s.launchMode){
      const now=performance.now();
      for(const m of LaunchPresentation.marks){
        const p=this.point(m.x,m.y),age=RangeUtil.clamp((now-m.at)/LaunchRules.landingMarkMs,0,1);
        c.strokeStyle=`rgba(255,228,128,${1-age})`;c.lineWidth=2;c.beginPath();c.arc(p[0],p[1],4+8*age,0,Math.PI*2);c.stroke();
      }
    }

    // 미네랄은 알려진 전략 자원 위치로 항상 표시한다.
    for(const m of s.resources||[]){
      const p=this.point(m.x,m.y);
      const rr=Math.max(1.7,w*.0085);
      this.dot(p[0],p[1],rr,m.amount>0?"#55c9ff":"#547582");
      c.strokeStyle=m.amount>0?"#d6f5ff":"#78909a";c.lineWidth=Math.max(.7,w*.0025);
      c.beginPath();c.arc(p[0],p[1],rr+1.4,0,Math.PI*2);c.stroke();
    }

    // 가스도 알려진 전략 자원 위치로 항상 표시.
    for(const g of s.gasNodes||[]){
      const p=this.point(g.x,g.y);
      this.dot(p[0],p[1],1.7,g.amount>0?"#67c96b":"#6f8b6b");
    }

    // 중립 캠프 위치는 지도 정보로 항상 표시하되, 실제 중립 유닛은 아래 유닛 루프에서 시야가 있을 때만 표시한다.
    for(const camp of s.camps||[]){
      const p=this.point(camp.x,camp.y),mainObjective=!!CampDefinition.get(camp.kind)?.mainObjective;
      const color=camp.kind==="objectiveBear"?"#d08a36":camp.kind==="objectiveDeathWorm"?"#b2cf35":camp.kind==="objectiveDragon"?"#e85d3c":"#a9823c";
      this.dot(p[0],p[1],mainObjective?3.4:2.15,color);
      if(mainObjective){
        c.strokeStyle=camp.state==="captured"?(camp.capturedOwner===r.mySide()?"#65a4ff":"#ff6961"):camp.state==="cooldown"?"#89928a":"#fff0c2";
        c.lineWidth=Math.max(1,w*.003);c.beginPath();c.arc(p[0],p[1],5.2,0,Math.PI*2);c.stroke();
      }
    }

    // 건물: 양쪽 메인 Base는 고정 전략 정보라 항상 표시.
    // 그 외 적 건물만 실제 현재 시야가 있을 때 표시한다.
    for(const b of s.buildings){
      if(b.alive===false)continue;
      const own=r.isFriendlySide(b.side);
      const mainBase=BuildingDefinition.get(b.type)?.isMainBase;
      if(!own&&!mainBase&&!r.visibleRaw(b.x,b.y))continue;
      const p=this.point(b.x,b.y);
      if(own){
        c.fillStyle="#4c8fff";
      }else if(mainBase){
        c.fillStyle="#ef5757";
      }else{
        c.fillStyle="#ef5757";
      }
      const size=mainBase?5:BuildingDefinition.get(b.type)?.isOutpost?4:3;
      c.fillRect(p[0]-size/2,p[1]-size/2,size,size);
    }

    // 유닛: 아군은 항상, 적/중립은 실제 시야 안에서만.
    for(const u of s.units){
      if(!u.alive)continue;
      if(u.side===NEUTRAL_SIDE){
        if(!r.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR"))continue;
        const p=this.point(u.x,u.y);
        this.dot(p[0],p[1],UnitVisualDefinition.get(u.type)?.minimapNeutralRadius||1.7,"#c69543");
        continue;
      }

      const own=r.isFriendlySide(u.side);
      if(!own&&!r.visibleRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR"))continue;
      const cloaked=r.snapshotStealthed(u);
      if(!own&&cloaked&&!r.detectedRaw(u.x,u.y,UnitDefinition.get(u.type)?.layer==="AIR"))continue;
      const p=this.point(u.x,u.y);
      this.dot(p[0],p[1],!!UnitDefinition.get(u.type)?.economyWorker?1.15:1.55,own?"#64a1ff":"#ff6666");
    }

    // 깃발
    const f=s.flags?.[r.mySide()];
    if(f){
      const p=this.point(f.x,f.y);
      c.strokeStyle=f.forced?"#ff9f2f":"#ffe36d";
      c.lineWidth=1.4;
      c.beginPath();c.moveTo(p[0]-3,p[1]);c.lineTo(p[0]+3,p[1]);c.moveTo(p[0],p[1]-3);c.lineTo(p[0],p[1]+3);c.stroke();
    }

    // 현재 카메라 뷰포트. cameraLeft/Top 자체가 이미 사용자 시점 좌표다.
    c.strokeStyle="#ffffff";
    c.lineWidth=Math.max(1,window.devicePixelRatio||1);
    c.beginPath();
    const corners=[[0,0],[r.canvas.width,0],[r.canvas.width,r.canvas.height],[0,r.canvas.height]];
    for(let i=0;i<corners.length;i++){
      const a=corners[i],b=corners[(i+1)%corners.length];
      for(let j=0;j<4;j++){
        const t=j/4,p=r.surfaceAtScreen(a[0]+(b[0]-a[0])*t,a[1]+(b[1]-a[1])*t);
        const q=this.point(RangeUtil.clamp(p.x,0,r.world.width),RangeUtil.clamp(p.z,0,r.world.height));
        if(!i&&!j)c.moveTo(...q);else c.lineTo(...q);
      }
    }
    c.closePath();c.stroke();
  }
}

/* =========================
   6. Procedural audio
   ========================= */
class AudioSystem{
  constructor(){
    this.ctx=null;
    this.master=null;
    this.compressor=null;
    this.noiseBuffer=null;
    this.enabled=true;
    this.unlocked=false;
    this.lastSnapshotTick=-1;

    // 짧은 시간 창 안에서 같은 계열 SFX가 너무 많이 겹치지 않게 제한.
    this.budgets={
      hit:{window:70,max:4,times:[]},
      shot:{window:80,max:3,times:[]},
      explosion:{window:120,max:2,times:[]},
      death:{window:100,max:2,times:[]}
    };
  }

  unlock(){
    if(!this.enabled)return;
    try{
      if(!this.ctx){
        const AC=window.AudioContext||window.webkitAudioContext;
        if(!AC)return;
        this.ctx=new AC();

        this.master=this.ctx.createGain();
        this.master.gain.value=.46;

        this.compressor=this.ctx.createDynamicsCompressor();
        this.compressor.threshold.value=-18;
        this.compressor.knee.value=16;
        this.compressor.ratio.value=6;
        this.compressor.attack.value=.002;
        this.compressor.release.value=.16;

        this.master.connect(this.compressor);
        this.compressor.connect(this.ctx.destination);

        // 0.5초짜리 노이즈 버퍼 한 번만 생성. 외부 음원 리소스 없음.
        const len=Math.floor(this.ctx.sampleRate*.5);
        this.noiseBuffer=this.ctx.createBuffer(1,len,this.ctx.sampleRate);
        const data=this.noiseBuffer.getChannelData(0);
        let state=0x12345678;
        for(let i=0;i<len;i++){
          state=(Math.imul(state,1664525)+1013904223)>>>0;
          data[i]=(state/0xffffffff)*2-1;
        }
      }
      if(this.ctx.state==="suspended")this.ctx.resume();
      this.unlocked=true;
    }catch(_){}
  }

  setEnabled(v){
    this.enabled=!!v;
    if(this.enabled)this.unlock();
    if(this.master&&this.ctx){
      const t=this.ctx.currentTime;
      this.master.gain.cancelScheduledValues(t);
      this.master.gain.setTargetAtTime(this.enabled?.46:0,t,.015);
    }
  }

  allow(kind){
    const b=this.budgets[kind];
    if(!b)return true;
    const now=performance.now();
    b.times=b.times.filter(t=>now-t<b.window);
    if(b.times.length>=b.max)return false;
    b.times.push(now);
    return true;
  }

  spatialGain(x,y,renderer){
    if(!renderer)return .7;
    // renderer camera는 사용자 시점 좌표이므로 이벤트도 같은 시점으로 변환.
    const vx=renderer.viewX(x),vy=renderer.viewY(y);
    const vw=renderer.viewWorldW(),vh=renderer.viewWorldH();
    const cx=renderer.cameraLeft+vw/2;
    const cy=renderer.cameraTop+vh/2;
    const dx=(vx-cx)/(vw*.5);
    const dy=(vy-cy)/(vh*.5);
    const d=Math.hypot(dx,dy);

    if(d>2.25)return 0;
    if(d<=.65)return 1;
    return Math.max(.08,1-(d-.65)/1.60);
  }

  gainNode(value,when=0){
    const g=this.ctx.createGain();
    const t=this.ctx.currentTime+when;
    g.gain.setValueAtTime(Math.max(.0001,value),t);
    g.connect(this.master);
    return {g,t};
  }

  tone({freq=220,endFreq=null,type="sine",gain=.15,duration=.1,attack=.002,when=0,filter=0}={}){
    if(!this.ctx||!this.enabled)return;
    const {g,t}=this.gainNode(gain,when);
    g.gain.setValueAtTime(.0001,t);
    g.gain.exponentialRampToValueAtTime(Math.max(.0002,gain),t+attack);
    g.gain.exponentialRampToValueAtTime(.0001,t+duration);

    const o=this.ctx.createOscillator();
    o.type=type;
    o.frequency.setValueAtTime(Math.max(20,freq),t);
    if(endFreq)o.frequency.exponentialRampToValueAtTime(Math.max(20,endFreq),t+duration);

    if(filter){
      const f=this.ctx.createBiquadFilter();
      f.type="lowpass";
      f.frequency.value=filter;
      o.connect(f);f.connect(g);
    }else o.connect(g);

    o.start(t);o.stop(t+duration+.02);
  }

  noise({gain=.1,duration=.08,when=0,lowpass=2500,highpass=0}={}){
    if(!this.ctx||!this.enabled||!this.noiseBuffer)return;
    const t=this.ctx.currentTime+when;
    const src=this.ctx.createBufferSource();
    src.buffer=this.noiseBuffer;

    let node=src;
    if(highpass){
      const hp=this.ctx.createBiquadFilter();
      hp.type="highpass";hp.frequency.value=highpass;
      node.connect(hp);node=hp;
    }
    if(lowpass){
      const lp=this.ctx.createBiquadFilter();
      lp.type="lowpass";lp.frequency.value=lowpass;
      node.connect(lp);node=lp;
    }

    const g=this.ctx.createGain();
    g.gain.setValueAtTime(Math.max(.0001,gain),t);
    g.gain.exponentialRampToValueAtTime(.0001,t+duration);
    node.connect(g);g.connect(this.master);
    src.start(t);src.stop(t+duration+.02);
  }

  metalHit(g=.5){
    if(!this.allow("hit"))return;
    this.noise({gain:.08*g,duration:.045,highpass:1800,lowpass:7200});
    this.tone({freq:920,endFreq:560,type:"square",gain:.035*g,duration:.055});
    this.tone({freq:1450,endFreq:1180,type:"triangle",gain:.025*g,duration:.035,when:.008});
  }

  fleshHit(g=.5){
    if(!this.allow("hit"))return;
    this.noise({gain:.10*g,duration:.055,lowpass:1000});
    this.tone({freq:105,endFreq:72,type:"sine",gain:.12*g,duration:.075});
  }

  gunShot(g=.5){
    if(!this.allow("shot"))return;
    this.noise({gain:.14*g,duration:.055,highpass:500,lowpass:6500});
    this.tone({freq:220,endFreq:90,type:"square",gain:.07*g,duration:.065});
  }

  bowShot(g=.5){
    if(!this.allow("shot"))return;
    this.noise({gain:.045*g,duration:.07,highpass:1500,lowpass:5000});
    this.tone({freq:520,endFreq:260,type:"triangle",gain:.035*g,duration:.095});
  }

  magicShot(g=.5){
    if(!this.allow("shot"))return;
    this.tone({freq:330,endFreq:940,type:"sine",gain:.055*g,duration:.14});
    this.tone({freq:660,endFreq:420,type:"triangle",gain:.035*g,duration:.12,when:.015});
  }

  explosion(g=.6,heavy=false){
    if(!this.allow("explosion"))return;
    const mul=heavy?1.25:1;
    this.noise({gain:.22*g*mul,duration:heavy?.34:.20,lowpass:heavy?1200:2100});
    this.tone({freq:heavy?72:105,endFreq:heavy?34:55,type:"sine",gain:.25*g*mul,duration:heavy?.36:.20});
    if(heavy)this.tone({freq:42,endFreq:28,type:"sine",gain:.20*g,duration:.42,when:.015});
  }

  death(g=.5){
    if(!this.allow("death"))return;
    this.tone({freq:130,endFreq:52,type:"sawtooth",gain:.06*g,duration:.16});
    this.noise({gain:.06*g,duration:.13,lowpass:900});
  }

  flagPlant(g=.8){
    // 지면 충돌 + 금속 깃대 울림.
    this.tone({freq:88,endFreq:45,type:"sine",gain:.23*g,duration:.16});
    this.noise({gain:.18*g,duration:.12,lowpass:1200});
    this.tone({freq:780,endFreq:430,type:"triangle",gain:.065*g,duration:.18,when:.035});
    this.tone({freq:1170,endFreq:850,type:"sine",gain:.035*g,duration:.11,when:.045});
  }

  researchComplete(g=.6){
    this.tone({freq:330,endFreq:440,type:"sine",gain:.06*g,duration:.16});
    this.tone({freq:440,endFreq:660,type:"sine",gain:.055*g,duration:.18,when:.09});
    this.tone({freq:660,endFreq:880,type:"triangle",gain:.045*g,duration:.22,when:.18});
  }

  buildingCollapse(g=.7){
    this.noise({gain:.20*g,duration:.35,lowpass:1000});
    this.tone({freq:74,endFreq:32,type:"sine",gain:.25*g,duration:.38});
    this.noise({gain:.08*g,duration:.22,highpass:1200,lowpass:3200,when:.08});
  }

  presentationProfile(sourceType){
    const d=UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType)||{};
    const attackVisual=AttackPresentationDefinition.forSource(sourceType);
    const heavy=!!d.projectileArc||(d.splash||0)>=80||((BuildingDefinition.get(sourceType)||null)&&(d.atk||0)>=70)||!!d.vfxHeavy;
    return {d,attackVisual,heavy};
  }
  playShotForType(sourceType,gain){
    const p=this.presentationProfile(sourceType),impact=p.attackVisual.impact;
    if(p.heavy||impact==="explosive")this.explosion(gain*.62,p.heavy);
    else if(impact==="arcane")this.magicShot(gain);
    else if(p.d?.vfxMuzzle==="gun")this.gunShot(gain);
    else this.bowShot(gain*.78);
  }
  playHitForType(sourceType,gain){
    const p=this.presentationProfile(sourceType),impact=p.attackVisual.impact;
    if(p.heavy||impact==="explosive")this.explosion(gain,p.heavy);
    else if(impact==="arcane")this.magicShot(gain*.58);
    else if(impact==="pierce")this.metalHit(gain*.78);
    else this.fleshHit(gain*.78);
  }

  playEvent(e,renderer){
    if(!e||!this.enabled||!this.unlocked)return;
    const gain=this.spatialGain(e.x??renderer.world.center.x,e.y??renderer.world.center.y,renderer);
    if(gain<=0)return;

    if(e.type==="flag"){
      this.flagPlant(Math.max(.55,gain));
      return;
    }
    if(e.type==="meteorImpact"){
      this.explosion(Math.max(.82,gain),true);
      this.tone({freq:52,endFreq:26,type:"sine",gain:.24*gain,duration:.48,when:.02});
      return;
    }
    if(e.type==="spellCast"&&e.spell==="tunnel"){
      this.tone({freq:180,endFreq:62,type:"sine",gain:.09*gain,duration:.28});
      this.tone({freq:420,endFreq:780,type:"triangle",gain:.045*gain,duration:.20,when:.03});
      return;
    }
    if(e.type==="tunnelTransit"){
      this.tone({freq:310,endFreq:760,type:"sine",gain:.045*gain,duration:.12});
      return;
    }
    if(e.type==="spellEquipped"||e.type==="spellMasteryUp"||e.type==="tacticalChestEarned"||e.type==="captureComplete"){
      this.researchComplete(Math.max(.45,gain));
      return;
    }
    if(e.type==="buildCancelled"){
      this.tone({freq:120,endFreq:65,type:"triangle",gain:.08*gain,duration:.12});
      return;
    }
    if(e.type==="researchComplete"||e.type==="abilityComplete"||e.type==="specialResearchComplete"||e.type==="complete"){
      this.researchComplete(gain*.75);
      return;
    }
    if(e.type==="buildingDeath"){
      this.buildingCollapse(gain);
      return;
    }
    if(e.type==="death"){
      this.death(gain);
      return;
    }
    if(e.type==="pillbugBurst"){
      this.explosion(Math.max(.78,gain),true);
      return;
    }
    if(e.type==="deepThornSpike"||e.type==="rootSpike"){
      this.explosion(Math.max(.52,gain),true);
      return;
    }
    if(e.type==="mineHit"){
      // 짧은 금속성 곡괭이 타격 + 광석 파편음. 총성과 완전히 다른 음색.
      if(!this.allow("hit"))return;
      this.tone({freq:690,endFreq:410,type:"triangle",gain:.065*gain,duration:.075});
      this.tone({freq:1180,endFreq:760,type:"sine",gain:.025*gain,duration:.045,when:.012});
      return;
    }
    if(e.type==="shoot"||e.type==="towerShot"){
      this.playShotForType(e.unit||e.sourceType||"",gain);
      return;
    }
    if(e.type==="hit"){
      this.playHitForType(e.sourceType||"",gain);
      return;
    }
  }

  processSnapshot(snapshot,renderer){
    if(!snapshot||snapshot.tick===this.lastSnapshotTick)return;
    this.lastSnapshotTick=snapshot.tick;
    for(const e of snapshot.events||[])this.playEvent(e,renderer);
  }
}

const audioSystem=new AudioSystem();

/* =========================
   7. UI wiring
   ========================= */
class DomUtil{static byId(id){return document.getElementById(id)}}
class UiRegistry{static refs={p2pHealth:DomUtil.byId("p2pHealth"),p2pHealthText:DomUtil.byId("p2pHealthText"),lobby:DomUtil.byId("lobby"),game:DomUtil.byId("gameScreen"),net:DomUtil.byId("netStatus"),createDialog:DomUtil.byId("createDialog"),joinDialog:DomUtil.byId("joinDialog"),createClose:DomUtil.byId("createCloseBtn"),joinClose:DomUtil.byId("joinCloseBtn"),createStatus:DomUtil.byId("createStatus"),createRetry:DomUtil.byId("createRetryBtn"),joinConfirm:DomUtil.byId("joinConfirmBtn"),room:DomUtil.byId("roomInput"),codeArea:DomUtil.byId("hostCodeArea"),code:DomUtil.byId("hostCode"),joinError:DomUtil.byId("joinError"),localTest:DomUtil.byId("localTestBtn"),testSwitcher:DomUtil.byId("testSwitcher"),hostView:DomUtil.byId("hostViewBtn"),guestView:DomUtil.byId("guestViewBtn"),canvas:DomUtil.byId("glCanvas"),minimapCanvas:DomUtil.byId("minimapCanvas"),minimapExpandBtn:DomUtil.byId("minimapExpandBtn"),minerals:DomUtil.byId("minerals"),gas:DomUtil.byId("gas"),workers:DomUtil.byId("workers"),supply:DomUtil.byId("supply"),supplyChip:DomUtil.byId("supplyChip"),supplyWarning:DomUtil.byId("supplyWarning"),reinforcementOverview:DomUtil.byId("reinforcementOverview"),reinforcementGrid:DomUtil.byId("reinforcementGrid"),tier:DomUtil.byId("tier"),soundBtn:DomUtil.byId("soundBtn"),modeTip:DomUtil.byId("modeTip"),buildFinishBtn:DomUtil.byId("buildFinishBtn"),spellCancelBtn:DomUtil.byId("spellCancelBtn"),productionEfficiencySummary:DomUtil.byId("productionEfficiencySummary"),unitGrid:DomUtil.byId("unitGrid"),spellCloseBtn:DomUtil.byId("spellCloseBtn"),spellChoiceArea:DomUtil.byId("spellChoiceArea"),spellInventory:DomUtil.byId("spellInventory"),tacticalChestArea:DomUtil.byId("tacticalChestArea"),flagBtn:DomUtil.byId("flagBtn"),pauseBtn:DomUtil.byId("pauseBtn"),cancelModeBtn:DomUtil.byId("cancelModeBtn"),supplyBtn:DomUtil.byId("supplyBtn"),gasExtractorBtn:DomUtil.byId("gasExtractorBtn"),defenseCardChoices:DomUtil.byId("defenseCardChoices"),academyBtn:DomUtil.byId("academyBtn"),airIncubatorBtn:DomUtil.byId("airIncubatorBtn"),labBtn:DomUtil.byId("labBtn"),buildingPanel:DomUtil.byId("buildingPanel"),buildingPanelTitle:DomUtil.byId("buildingPanelTitle"),buildingPanelStatus:DomUtil.byId("buildingPanelStatus"),buildingPanelActions:DomUtil.byId("buildingPanelActions"),buildingDeselectBtn:DomUtil.byId("buildingDeselectBtn"),tech2:DomUtil.byId("tech2Line"),tech3:DomUtil.byId("tech3Line"),attackUpgradeTag:DomUtil.byId("attackUpgradeTag"),armorUpgradeTag:DomUtil.byId("armorUpgradeTag"),hint:DomUtil.byId("selectionHint"),log:DomUtil.byId("eventLog"),result:DomUtil.byId("result"),resultTitle:DomUtil.byId("resultTitle"),resultText:DomUtil.byId("resultText"),rematch:DomUtil.byId("rematchBtn")}}
UiRegistry.refs.infoDetailDialog=DomUtil.byId("infoDetailDialog");
UiRegistry.refs.infoDetailCloseBtn=DomUtil.byId("infoDetailCloseBtn");
UiRegistry.refs.infoDetailIcon=DomUtil.byId("infoDetailIcon");
UiRegistry.refs.infoDetailTitle=DomUtil.byId("infoDetailTitle");
UiRegistry.refs.infoDetailKicker=DomUtil.byId("infoDetailKicker");
UiRegistry.refs.infoDetailBody=DomUtil.byId("infoDetailBody");
UiRegistry.refs.infoDetailMeta=DomUtil.byId("infoDetailMeta");

class MinimapPresentation{
  static setMinimapExpanded(expanded){
  UiRuntimeState.value.options.minimapExpanded=!!expanded;
  UiController.renderUiState();
  if(ActiveViewState.minimap)requestAnimationFrame(()=>ActiveViewState.minimap.draw());
}
}

UiRegistry.refs.minimapExpandBtn?.addEventListener("click",e=>{
  e.preventDefault();e.stopPropagation();
  MinimapPresentation.setMinimapExpanded(!UiRuntimeState.value.options.minimapExpanded);
});
document.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&UiRuntimeState.value.options.minimapExpanded)MinimapPresentation.setMinimapExpanded(false);
});
UiRegistry.refs.lockstepDebugPanel=DomUtil.byId("lockstepDebugPanel");
UiRegistry.refs.lockstepDebugCloseBtn=DomUtil.byId("lockstepDebugCloseBtn");
UiRegistry.refs.manualRecoveryBtn=DomUtil.byId("manualRecoveryBtn");
UiRegistry.refs.fullConnectionResetBtn=DomUtil.byId("fullConnectionResetBtn");
UiRegistry.refs.lockstepDebugResetBtn=DomUtil.byId("lockstepDebugResetBtn");
UiRegistry.refs.recoveryLogExportBtn=DomUtil.byId("recoveryLogExportBtn");
UiRegistry.refs.balanceTelemetryExportBtn=DomUtil.byId("balanceTelemetryExportBtn");UiRegistry.refs.performanceBenchmarkBtn=DomUtil.byId("performanceBenchmarkBtn");
UiRegistry.refs.lockstepDebugSummary=DomUtil.byId("lockstepDebugSummary");
UiRegistry.refs.lockstepDebugVerdict=DomUtil.byId("lockstepDebugVerdict");
UiRegistry.refs.synctestRunBtn=DomUtil.byId("synctestRunBtn");
UiRegistry.refs.dbgSyncStatus=DomUtil.byId("dbgSyncStatus");
UiRegistry.refs.dbgSyncChecked=DomUtil.byId("dbgSyncChecked");
UiRegistry.refs.dbgSyncResimulated=DomUtil.byId("dbgSyncResimulated");
UiRegistry.refs.dbgSyncDistance=DomUtil.byId("dbgSyncDistance");
UiRegistry.refs.dbgSyncHash=DomUtil.byId("dbgSyncHash");
UiRegistry.refs.dbgSyncBytes=DomUtil.byId("dbgSyncBytes");
UiRegistry.refs.dbgSyncCost=DomUtil.byId("dbgSyncCost");
UiRegistry.refs.dbgSyncFailure=DomUtil.byId("dbgSyncFailure");
UiRegistry.refs.dbgCoreLatency=DomUtil.byId("dbgCoreLatency");
for(const id of ['dbgPerfInputDelay','dbgPerfCommandConfirm','dbgPerfCommandPending','dbgPerfIceRtt','dbgPerfEventLoop','dbgPerfLongTask','dbgPerfPulseGap','dbgPerfPulse','dbgPerfStateSave','dbgPerfResimulation','dbgPerfPresentation','dbgPerfFrameInterval','dbgPerfDeviceBegin','dbgPerfRenderPasses','dbgPerfRenderEffects','dbgPerfRenderTail','dbgPerfNavigation','dbgPerfProjection','dbgPerfDrawCalls','performanceTimingExportBtn'])UiRegistry.refs[id]=DomUtil.byId(id);
UiRegistry.refs.dbgCorePacing=DomUtil.byId("dbgCorePacing");
UiRegistry.refs.dbgCorePrediction=DomUtil.byId("dbgCorePrediction");
UiRegistry.refs.dbgCoreHistory=DomUtil.byId("dbgCoreHistory");
UiRegistry.refs.dbgCoreStatus=DomUtil.byId("dbgCoreStatus");
UiRegistry.refs.dbgCoreRollback=DomUtil.byId("dbgCoreRollback");
UiRegistry.refs.dbgCoreRecovery=DomUtil.byId("dbgCoreRecovery");
UiRegistry.refs.dbgCoreBytes=DomUtil.byId("dbgCoreBytes");
UiRegistry.refs.dbgPerfStep=DomUtil.byId("dbgPerfStep");UiRegistry.refs.dbgPerfPeerStep=DomUtil.byId("dbgPerfPeerStep");UiRegistry.refs.dbgPerfCore=DomUtil.byId("dbgPerfCore");UiRegistry.refs.dbgPerfCombat=DomUtil.byId("dbgPerfCombat");UiRegistry.refs.dbgPerfTail=DomUtil.byId("dbgPerfTail");
UiRegistry.refs.dbgPerfSnapshot=DomUtil.byId("dbgPerfSnapshot");UiRegistry.refs.dbgPerfEntities=DomUtil.byId("dbgPerfEntities");UiRegistry.refs.dbgPerfSpatial=DomUtil.byId("dbgPerfSpatial");UiRegistry.refs.dbgPerfTarget=DomUtil.byId("dbgPerfTarget");UiRegistry.refs.dbgPerfCollision=DomUtil.byId("dbgPerfCollision");UiRegistry.refs.dbgPerfRender=DomUtil.byId("dbgPerfRender");UiRegistry.refs.dbgPerfAllowanceLabel=DomUtil.byId("dbgPerfAllowanceLabel");UiRegistry.refs.dbgPerfAllowance=DomUtil.byId("dbgPerfAllowance");UiRegistry.refs.dbgPerfUsedLabel=DomUtil.byId("dbgPerfUsedLabel");UiRegistry.refs.dbgPerfUsed=DomUtil.byId("dbgPerfUsed");UiRegistry.refs.dbgPerfBudgetLabel=DomUtil.byId("dbgPerfBudgetLabel");UiRegistry.refs.dbgPerfBudget=DomUtil.byId("dbgPerfBudget");
UiRegistry.refs.dbgPerfCollisionCore=DomUtil.byId("dbgPerfCollisionCore");UiRegistry.refs.dbgPerfCollisionTail=DomUtil.byId("dbgPerfCollisionTail");
UiRegistry.refs.dbgPerfCombatSplit=DomUtil.byId("dbgPerfCombatSplit");UiRegistry.refs.dbgPerfCollisionSweepFlow=DomUtil.byId("dbgPerfCollisionSweepFlow");UiRegistry.refs.dbgPerfCollisionHardFixFlow=DomUtil.byId("dbgPerfCollisionHardFixFlow");
UiRegistry.refs.dbgEnduranceMismatchRate=DomUtil.byId("dbgEnduranceMismatchRate");UiRegistry.refs.dbgEnduranceCorrectionRate=DomUtil.byId("dbgEnduranceCorrectionRate");UiRegistry.refs.dbgEndurancePeaks=DomUtil.byId("dbgEndurancePeaks");
UiRegistry.refs.dbgBalanceTime=DomUtil.byId("dbgBalanceTime");UiRegistry.refs.dbgBalanceT2=DomUtil.byId("dbgBalanceT2");UiRegistry.refs.dbgBalanceT3=DomUtil.byId("dbgBalanceT3");UiRegistry.refs.dbgBalanceTech=DomUtil.byId("dbgBalanceTech");UiRegistry.refs.dbgBalanceCombat=DomUtil.byId("dbgBalanceCombat");UiRegistry.refs.dbgBalanceCapture=DomUtil.byId("dbgBalanceCapture");
UiRegistry.refs.dbgBalanceMineral=DomUtil.byId("dbgBalanceMineral");UiRegistry.refs.dbgBalanceGas=DomUtil.byId("dbgBalanceGas");UiRegistry.refs.dbgBalanceArmy=DomUtil.byId("dbgBalanceArmy");UiRegistry.refs.dbgBalanceAir=DomUtil.byId("dbgBalanceAir");UiRegistry.refs.dbgBalanceAA=DomUtil.byId("dbgBalanceAA");UiRegistry.refs.dbgBalanceExhaust=DomUtil.byId("dbgBalanceExhaust");UiRegistry.refs.dbgBalanceLosses=DomUtil.byId("dbgBalanceLosses");

UiRegistry.refs.gameStartBtn=DomUtil.byId("gameStartBtn");
UiRegistry.refs.campaignRepositoryList=DomUtil.byId("campaignRepositoryList");UiRegistry.refs.campaignRefreshBtn=DomUtil.byId("campaignRefreshBtn");UiRegistry.refs.campaignDialog=DomUtil.byId("campaignDialog");UiRegistry.refs.campaignCloseBtn=DomUtil.byId("campaignCloseBtn");UiRegistry.refs.campaignUrlInput=DomUtil.byId("campaignUrlInput");UiRegistry.refs.campaignLoadUrlBtn=DomUtil.byId("campaignLoadUrlBtn");UiRegistry.refs.campaignFileInput=DomUtil.byId("campaignFileInput");UiRegistry.refs.campaignLoadFileBtn=DomUtil.byId("campaignLoadFileBtn");UiRegistry.refs.campaignStartBtn=DomUtil.byId("campaignStartBtn");UiRegistry.refs.campaignStatus=DomUtil.byId("campaignStatus");UiRegistry.refs.campaignMissionTitle=DomUtil.byId("campaignMissionTitle");UiRegistry.refs.campaignMissionBrief=DomUtil.byId("campaignMissionBrief");
UiRegistry.refs.singleStatus=DomUtil.byId("singleStatus");
UiRegistry.refs.deckEditBtn=DomUtil.byId("deckEditBtn");
UiRegistry.refs.deckConfirmBtn=DomUtil.byId("deckConfirmBtn");

UiRegistry.refs.installPwaBtn=DomUtil.byId("installPwaBtn");
UiRegistry.refs.installPwaMeta=DomUtil.byId("installPwaMeta");
UiRegistry.refs.installGuideBtn=DomUtil.byId("installGuideBtn");
UiRegistry.refs.installGuideModal=DomUtil.byId("installGuideModal");
UiRegistry.refs.installGuideBackdrop=DomUtil.byId("installGuideBackdrop");
UiRegistry.refs.installGuideCloseBtn=DomUtil.byId("installGuideCloseBtn");
UiRegistry.refs.installGuideDoneBtn=DomUtil.byId("installGuideDoneBtn");
UiRegistry.refs.bootGate=DomUtil.byId("bootGate");
UiRegistry.refs.bootTitle=DomUtil.byId("bootTitle");
UiRegistry.refs.bootStatus=DomUtil.byId("bootStatus");
UiRegistry.refs.bootProgressBar=DomUtil.byId("bootProgressBar");
UiRegistry.refs.bootBuild=DomUtil.byId("bootBuild");
UiRegistry.refs.bootRetryBtn=DomUtil.byId("bootRetryBtn");

UiRegistry.refs.helpBtn=DomUtil.byId("helpBtn");
UiRegistry.refs.helpModal=DomUtil.byId("helpModal");
UiRegistry.refs.helpBackdrop=DomUtil.byId("helpBackdrop");
UiRegistry.refs.helpCloseBtn=DomUtil.byId("helpCloseBtn");
UiRegistry.refs.helpBody=DomUtil.byId("helpBody");
UiRegistry.refs.helpUnitTable=DomUtil.byId("helpUnitTable");
UiRegistry.refs.helpSpellTable=DomUtil.byId("helpSpellTable");
UiRegistry.refs.replayOpenBtn=DomUtil.byId("replayOpenBtn");UiRegistry.refs.replayFileInput=DomUtil.byId("replayFileInput");UiRegistry.refs.replayWatchBtn=DomUtil.byId("replayWatchBtn");UiRegistry.refs.replaySaveBtn=DomUtil.byId("replaySaveBtn");
UiRegistry.refs.replayDock=DomUtil.byId("replayDock");UiRegistry.refs.replayPlayPauseBtn=DomUtil.byId("replayPlayPauseBtn");UiRegistry.refs.replayStepBackBtn=DomUtil.byId("replayStepBackBtn");UiRegistry.refs.replayStepForwardBtn=DomUtil.byId("replayStepForwardBtn");UiRegistry.refs.replayStepBack30Btn=DomUtil.byId("replayStepBack30Btn");UiRegistry.refs.replayStepForward30Btn=DomUtil.byId("replayStepForward30Btn");UiRegistry.refs.replayTimeline=DomUtil.byId("replayTimeline");UiRegistry.refs.replayTime=DomUtil.byId("replayTime");UiRegistry.refs.replayTimeInput=DomUtil.byId("replayTimeInput");UiRegistry.refs.replayTimeGoBtn=DomUtil.byId("replayTimeGoBtn");UiRegistry.refs.replaySpeed=DomUtil.byId("replaySpeed");UiRegistry.refs.replayExitBtn=DomUtil.byId("replayExitBtn");
UiRegistry.refs.replayHostViewBtn=DomUtil.byId("replayHostViewBtn");UiRegistry.refs.replayGuestViewBtn=DomUtil.byId("replayGuestViewBtn");UiRegistry.refs.replayAllViewBtn=DomUtil.byId("replayAllViewBtn");UiRegistry.refs.replayHostOrientationBtn=DomUtil.byId("replayHostOrientationBtn");UiRegistry.refs.replayGuestOrientationBtn=DomUtil.byId("replayGuestOrientationBtn");UiRegistry.refs.replayZoomOutBtn=DomUtil.byId("replayZoomOutBtn");UiRegistry.refs.replayZoomInBtn=DomUtil.byId("replayZoomInBtn");UiRegistry.refs.replayZoomValue=DomUtil.byId("replayZoomValue");UiRegistry.refs.replayStats=DomUtil.byId("replayStats");
UiRegistry.refs.matchMenuBtnGame=DomUtil.byId("matchMenuBtnGame");UiRegistry.refs.matchMenuModal=DomUtil.byId("matchMenuModal");UiRegistry.refs.matchMenuBackdrop=DomUtil.byId("matchMenuBackdrop");UiRegistry.refs.matchMenuCloseBtn=DomUtil.byId("matchMenuCloseBtn");UiRegistry.refs.matchMenuContinueBtn=DomUtil.byId("matchMenuContinueBtn");UiRegistry.refs.matchMenuReplaySaveBtn=DomUtil.byId("matchMenuReplaySaveBtn");UiRegistry.refs.matchMenuHelpBtn=DomUtil.byId("matchMenuHelpBtn");UiRegistry.refs.matchMenuSurrenderBtn=DomUtil.byId("matchMenuSurrenderBtn");UiRegistry.refs.matchMenuLeaveBtn=DomUtil.byId("matchMenuLeaveBtn");UiRegistry.refs.matchMenuWarning=DomUtil.byId("matchMenuWarning");
UiRegistry.refs.disconnectGate=DomUtil.byId("disconnectGate");UiRegistry.refs.disconnectGateTitle=DomUtil.byId("disconnectGateTitle");UiRegistry.refs.disconnectGateCount=DomUtil.byId("disconnectGateCount");UiRegistry.refs.disconnectGateCopy=DomUtil.byId("disconnectGateCopy");UiRegistry.refs.disconnectGateActions=DomUtil.byId("disconnectGateActions");UiRegistry.refs.disconnectReconnectBtn=DomUtil.byId("disconnectReconnectBtn");UiRegistry.refs.disconnectSurrenderBtn=DomUtil.byId("disconnectSurrenderBtn");

UiRegistry.refs.spellChoiceModal=DomUtil.byId("spellChoiceModal");
UiRegistry.refs.spellChoiceModalBackdrop=DomUtil.byId("spellChoiceModalBackdrop");
UiRegistry.refs.spellChoiceModalTitle=DomUtil.byId("spellChoiceModalTitle");
UiRegistry.refs.spellChoiceModalSub=DomUtil.byId("spellChoiceModalSub");
UiRegistry.refs.spellChoiceModalClose=DomUtil.byId("spellChoiceModalClose");
UiRegistry.refs.spellChoiceModalContent=DomUtil.byId("spellChoiceModalContent");
UiRegistry.refs.tacticalChestFeedback=DomUtil.byId("tacticalChestFeedback");
UiRegistry.refs.tacticalChestFeedbackText=DomUtil.byId("tacticalChestFeedbackText");

UiRegistry.refs.battleCommandDock=DomUtil.byId("battleCommandDock");
UiRegistry.refs.launchHand=DomUtil.byId("launchHand");UiRegistry.refs.launchCards=DomUtil.byId("launchCards");
UiRegistry.refs.launchEnergyFill=DomUtil.byId("launchEnergyFill");UiRegistry.refs.launchEnergyText=DomUtil.byId("launchEnergyText");
UiRegistry.refs.launchCards?.addEventListener("click",e=>{const b=e.target.closest("[data-launch-card]");if(b)LaunchPresentation.selectCard(b.dataset.launchCard)});
UiRegistry.refs.commandDrawer=DomUtil.byId("commandDrawer");
UiRegistry.refs.buildTree=DomUtil.byId("buildTree");
UiRegistry.refs.buildDrawerCloseBtn=DomUtil.byId("buildDrawerCloseBtn");
UiRegistry.refs.commandBackBtn=DomUtil.byId("commandBackBtn");
UiRegistry.refs.economyTreeBtn=DomUtil.byId("economyTreeBtn");
UiRegistry.refs.militaryTreeBtn=DomUtil.byId("militaryTreeBtn");
UiRegistry.refs.researchTreeBtn=DomUtil.byId("researchTreeBtn");
UiRegistry.refs.tacticsTreeBtn=DomUtil.byId("tacticsTreeBtn");
UiRegistry.refs.techTreeTitle=DomUtil.byId("techTreeTitle");
UiRegistry.refs.techTreePathLabel=DomUtil.byId("techTreePathLabel");
UiRegistry.refs.economyTreePane=DomUtil.byId("economyTreePane");
UiRegistry.refs.militaryTreePane=DomUtil.byId("militaryTreePane");
UiRegistry.refs.researchTreePane=DomUtil.byId("researchTreePane");
UiRegistry.refs.tacticsTreePane=DomUtil.byId("tacticsTreePane");
UiRegistry.refs.militaryHomePage=DomUtil.byId("militaryHomePage");
UiRegistry.refs.militaryTierPage=DomUtil.byId("militaryTierPage");
UiRegistry.refs.militaryTierMeta=DomUtil.byId("militaryTierMeta");
UiRegistry.refs.militaryT1Btn=DomUtil.byId("militaryT1Btn");
UiRegistry.refs.militaryT2Btn=DomUtil.byId("militaryT2Btn");
UiRegistry.refs.militaryT3Btn=DomUtil.byId("militaryT3Btn");
UiRegistry.refs.researchHomePage=DomUtil.byId("researchHomePage");
UiRegistry.refs.researchTechPage=DomUtil.byId("researchTechPage");
UiRegistry.refs.researchUpgradePage=DomUtil.byId("researchUpgradePage");
UiRegistry.refs.researchAbilityPage=DomUtil.byId("researchAbilityPage");
UiRegistry.refs.researchAbilityGrid=DomUtil.byId("researchAbilityGrid");
UiRegistry.refs.researchUpgradeGrid=DomUtil.byId("researchUpgradeGrid");
UiRegistry.refs.researchTechBtn=DomUtil.byId("researchTechBtn");
UiRegistry.refs.researchUpgradeBtn=DomUtil.byId("researchUpgradeBtn");
UiRegistry.refs.researchAbilityBtn=DomUtil.byId("researchAbilityBtn");
UiRegistry.refs.tacticsHomePage=DomUtil.byId("tacticsHomePage");
UiRegistry.refs.tacticsDefensePage=DomUtil.byId("tacticsDefensePage");
UiRegistry.refs.tacticsSpellPage=DomUtil.byId("tacticsSpellPage");
UiRegistry.refs.tacticsDefenseBtn=DomUtil.byId("tacticsDefenseBtn");
UiRegistry.refs.tacticsSpellBtn=DomUtil.byId("tacticsSpellBtn");
UiRegistry.refs.tacticsChestBtn=DomUtil.byId("tacticsChestBtn");
UiRegistry.refs.tacticsChestPage=DomUtil.byId("tacticsChestPage");
UiRegistry.refs.passiveStatusHome=DomUtil.byId("passiveStatusHome");
UiRegistry.refs.passiveStatusChest=DomUtil.byId("passiveStatusChest");

/*
 * Command-panel layout contract:
 * - horizontal N columns (currently 4), wrapping by rendered rows
 * - rows 1..3 expand naturally with no vertical scroller
 * - row 4+ keeps the first 3 rendered rows visible and scrolls this grid only
 * Card heights intentionally remain content-driven, so the 3-row cutoff is measured
 * from the real DOM instead of hard-coding pixels.
 */
const COMMAND_CHOICE_GRID_SELECTOR=[
  ".command-card-grid",
  ".command-unit-grid",
  ".quick-unit-grid",
  ".quick-special-grid",
  ".spell-inventory.quick-spell-grid",
  "#researchUpgradeGrid",
  "#researchAbilityGrid",
  ".defense-card-choices"
].join(",");
const COMMAND_CHOICE_MAX_VISIBLE_ROWS=3;

class CommandPresentation{
  static commandGridLayoutRaf=0;

  static commandGridChoiceChildren(grid){
  return [...grid.children].filter(el=>{
    if(!(el instanceof HTMLElement)||el.hidden)return false;
    const cs=getComputedStyle(el);
    if(cs.display==="none"||cs.visibility==="hidden")return false;
    // Full-width copy is context, not a command-choice row, but its height is
    // naturally included in offsetTop when calculating the third card row.
    if(el.classList.contains("command-pane-copy"))return false;
    return true;
  });
}
  static syncCommandChoiceGrid(grid){
  if(!(grid instanceof HTMLElement))return;
  grid.classList.add("command-choice-scroll-grid");
  if(grid.offsetParent===null)return;
  const cards=CommandPresentation.commandGridChoiceChildren(grid);
  if(!cards.length){
    grid.classList.remove("command-grid-overflow");
    grid.style.maxHeight="";
    grid.style.overflowY="";
    grid.scrollTop=0;
    return;
  }
  const rows=[];
  for(const el of cards){
    const top=Math.round(el.offsetTop);
    if(!rows.some(v=>Math.abs(v-top)<=1))rows.push(top);
  }
  rows.sort((a,b)=>a-b);
  if(rows.length<=COMMAND_CHOICE_MAX_VISIBLE_ROWS){
    grid.classList.remove("command-grid-overflow");
    grid.style.maxHeight="";
    grid.style.overflowY="";
    grid.scrollTop=0;
    return;
  }
  const cutoffTop=rows[COMMAND_CHOICE_MAX_VISIBLE_ROWS-1];
  const thirdRow=cards.filter(el=>Math.abs(Math.round(el.offsetTop)-cutoffTop)<=1);
  const rowBottom=Math.max(...thirdRow.map(el=>el.offsetTop+el.offsetHeight));
  const cs=getComputedStyle(grid);
  const padBottom=parseFloat(cs.paddingBottom)||0;
  const maxHeight=Math.ceil(rowBottom+padBottom);
  const next=`${maxHeight}px`;
  if(grid.style.maxHeight!==next)grid.style.maxHeight=next;
  grid.style.overflowY="auto";
  grid.style.overflowX="hidden";
  grid.classList.add("command-grid-overflow");
}
  static syncAllCommandChoiceGrids(){
  CommandPresentation.commandGridLayoutRaf=0;
  document.querySelectorAll(COMMAND_CHOICE_GRID_SELECTOR).forEach(CommandPresentation.syncCommandChoiceGrid);
}
  static scheduleCommandChoiceGridSync(){
  if(CommandPresentation.commandGridLayoutRaf)return;
  CommandPresentation.commandGridLayoutRaf=requestAnimationFrame(CommandPresentation.syncAllCommandChoiceGrids);
}
  
  static commandSubpageLabel(){
  const labels={
    "military-t1":"T1 병종","military-t2":"T2 병종","military-t3":"T3 병종",
    "research-tech":"테크 건설","research-upgrade":"전투 강화","research-ability":"병종 특수 연구",
    "tactics-defense":"방어 카드","tactics-chest":"전술상자","tactics-spell":"전술 스펠"
  };
  return labels[UiRuntimeState.value.command.page]||null;
}
  static activeMilitaryTier(){
  const page=UiRuntimeState.value.command.page;
  return page==="military-t1"?1:page==="military-t2"?2:page==="military-t3"?3:0;
}
  static applyCommandSubpage(){
  const page=UiRuntimeState.value.command.page,categoryKey=UiRuntimeState.value.command.category,branch=UiRuntimeState.value.command.branch;
  const militaryTier=CommandPresentation.activeMilitaryTier();
  UiRegistry.refs.militaryHomePage?.classList.toggle("hidden",!!militaryTier);
  UiRegistry.refs.militaryTierPage?.classList.toggle("hidden",!militaryTier);
  const researchChild=page==="research-tech"||page==="research-upgrade"||page==="research-ability";
  UiRegistry.refs.researchHomePage?.classList.toggle("hidden",researchChild);
  UiRegistry.refs.researchTechPage?.classList.toggle("hidden",page!=="research-tech");
  UiRegistry.refs.researchUpgradePage?.classList.toggle("hidden",page!=="research-upgrade");
  UiRegistry.refs.researchAbilityPage?.classList.toggle("hidden",page!=="research-ability");
  const tacticsChild=page==="tactics-defense"||page==="tactics-chest"||page==="tactics-spell";
  UiRegistry.refs.tacticsHomePage?.classList.toggle("hidden",tacticsChild);
  UiRegistry.refs.tacticsDefensePage?.classList.toggle("hidden",page!=="tactics-defense");
  UiRegistry.refs.tacticsChestPage?.classList.toggle("hidden",page!=="tactics-chest");
  UiRegistry.refs.tacticsSpellPage?.classList.toggle("hidden",page!=="tactics-spell");
  const sub=CommandPresentation.commandSubpageLabel();
  UiRegistry.refs.commandBackBtn?.classList.toggle("hidden",!sub);
  const categoryLabels={economy:"경제",military:"군사",research:"연구",tactics:"전술"};
  const category=categoryLabels[categoryKey]||"경제";
  if(UiRegistry.refs.techTreeTitle)UiRegistry.refs.techTreeTitle.textContent=sub||category;
  if(UiRegistry.refs.techTreePathLabel)UiRegistry.refs.techTreePathLabel.textContent=sub?`${category} › ${sub}`:category;
  const spellOpen=branch==="tree"&&categoryKey==="tactics"&&page==="tactics-spell";
  if(categoryKey==="tactics"&&ActiveViewState.snap)BattlePresentation.renderPassiveStatus(ActiveViewState.snap);
  if(spellOpen&&ActiveViewState.snap)SpellPresentation.renderSpellPanel(ActiveViewState.snap);
  if(page==="tactics-chest"&&ActiveViewState.snap)BattlePresentation.renderTacticalChest(ActiveViewState.snap);
  if((page==="research-upgrade"||page==="research-ability")&&ActiveViewState.snap)ResearchPresentation.renderResearchCommandPanels(ActiveViewState.snap);
}
  static applyTechTreeCategory(category,{resetSubpage=false}={}){
  const allowed=["economy","military","research","tactics"];
  const next=allowed.includes(category)?category:"economy";
  const page=(resetSubpage||next!==UiRuntimeState.value.command.category)?null:UiRuntimeState.value.command.page;
  UiController.setUiCommand({category:next,page});
  const paneMap={economy:UiRegistry.refs.economyTreePane,military:UiRegistry.refs.militaryTreePane,research:UiRegistry.refs.researchTreePane,tactics:UiRegistry.refs.tacticsTreePane};
  const buttonMap={economy:UiRegistry.refs.economyTreeBtn,military:UiRegistry.refs.militaryTreeBtn,research:UiRegistry.refs.researchTreeBtn,tactics:UiRegistry.refs.tacticsTreeBtn};
  for(const key of allowed){
    paneMap[key]?.classList.toggle("hidden",key!==UiRuntimeState.value.command.category);
    buttonMap[key]?.classList.toggle("mode-selected",UiRuntimeState.value.command.branch==="tree"&&key===UiRuntimeState.value.command.category);
  }
  CommandPresentation.applyCommandSubpage();
}
  static openCommandSubpage(page){
  if(UiRuntimeState.value.command.page===page)return;
  UiController.setUiCommand({page});BattlePresentationCache.lastUnitGridHtml=null;CommandPresentation.applyCommandSubpage();
}
  static commandBack(){
  if(UiRuntimeState.value.command.page){
    if(UiRuntimeState.value.target.type==="spell")UiController.cancelTargetMode(true);
    UiController.setUiCommand({page:null});BattlePresentationCache.lastUnitGridHtml=null;CommandPresentation.applyCommandSubpage();return;
  }
  CommandPresentation.closeCommandDrawer();
}
  static openTechTree(category){
  const sameRoot=UiRuntimeState.value.command.branch==="tree"&&UiRuntimeState.value.command.category===category&&!UiRuntimeState.value.command.page;
  if(sameRoot){CommandPresentation.closeCommandDrawer();return}
  UiController.setUiCommand({branch:"tree",category,page:null});
  CommandPresentation.applyTechTreeCategory(category,{resetSubpage:true});CommandPresentation.syncCommandDock();
}
  static syncCommandDock(){
  UiController.renderUiState();
  const buttonMap={economy:UiRegistry.refs.economyTreeBtn,military:UiRegistry.refs.militaryTreeBtn,research:UiRegistry.refs.researchTreeBtn,tactics:UiRegistry.refs.tacticsTreeBtn};
  for(const [key,btn] of Object.entries(buttonMap))btn?.classList.toggle("mode-selected",UiRuntimeState.value.command.branch==="tree"&&UiRuntimeState.value.command.category===key);
  UiRegistry.refs.flagBtn?.classList.toggle("mode-selected",UiRuntimeState.value.target.type==="flag");
  CommandPresentation.applyTechTreeCategory(UiRuntimeState.value.command.category);
}
  static setCommandDrawerMode(next){
  UiController.setUiCommand({branch:next||"closed"});CommandPresentation.syncCommandDock();
  if(UiRuntimeState.value.command.branch==="building"&&ActiveViewState.snap)BuildingPresentation.renderSelectedBuildingPanel(ActiveViewState.snap);
}
  static closeCommandDrawer({cancelTarget=true}={}){
  if(cancelTarget&&(UiRuntimeState.value.target.type==="build"||UiRuntimeState.value.target.type==="spell"))UiController.cancelTargetMode(true);
  CommandPresentation.setCommandDrawerMode(null);
}
}

const commandGridMutationObserver=new MutationObserver(()=>CommandPresentation.scheduleCommandChoiceGridSync());
if(UiRegistry.refs.commandDrawer){
  commandGridMutationObserver.observe(UiRegistry.refs.commandDrawer,{childList:true,subtree:true});
  // Navigation changes hidden pages through click handlers; measure after the same event.
  UiRegistry.refs.commandDrawer.addEventListener("click",()=>CommandPresentation.scheduleCommandChoiceGridSync(),{passive:true});
}
window.addEventListener("resize",CommandPresentation.scheduleCommandChoiceGridSync,{passive:true});
CommandPresentation.scheduleCommandChoiceGridSync();

const UI_RADIO=Object.freeze({
  screen:new Set(["lobby","game","replay","result"]),
  modal:new Set(["none","campaign","create","join","match-menu","detail","spell-choice","disconnect","help"]),
  command:new Set(["closed","tree","building"])
});
// UI STATE CONTRACT:
// Radio: screen/modal/command.branch; Tree: command category/page + modalState phases;
// Checkbox: only independent options. DOM classes are derived output, never app-state input.
// Async/transient gesture/network booleans may remain local when simultaneous truth is valid.
class UiRuntimeState{static value={screen:"lobby",modal:"none",modalState:{spellChoice:"idle",disconnect:"hidden"},command:{branch:"closed",category:"economy",page:null},options:{minimapExpanded:false,lockstepDebugOpen:false},settings:{presetId:"standard",simulationTps:10},target:{type:"flag"},selection:{unit:null,buildingId:null}}}

/* DOM write ownership contract:
   UiController is the sole generic visibility/screen/modal writer.
   Domain Presentation owners write their own content and domain-local visual state only.
   CSS owns layout/appearance, never application visibility; component display rules must
   not override the shared hidden state. */
class UiController{
  static switchTestView(nextRole,auto=false){
  if(!MatchLifecycle.localTest||!MatchLifecycle.localTest.sessions[nextRole])return;
  if(ActiveViewState.role===nextRole&&!auto)return;
  BattlePresentationCache.lastUnitGridHtml=null;
  UiController.invalidatePanelHtmlCaches({unit:true,reinforcement:true});

  AppLifecycle.saveActiveViewState();
  ActiveViewState.role=nextRole;
  MatchLifecycle.setActiveSession();

  UiRuntimeState.value.selection.unit=ViewRuntimeState.byRole[ActiveViewState.role].selection.unit;
  UiRuntimeState.value.selection.buildingId=ViewRuntimeState.byRole[ActiveViewState.role].selection.buildingId||null;
  UiRuntimeState.value.target=CloneUtil.clone(ViewRuntimeState.byRole[ActiveViewState.role].target||{type:"flag"});

  UiController.setRoleSwitcherActive(ActiveViewState.role);
  UiRegistry.refs.net.textContent="로컬 테스트 · "+ActiveViewState.role.toUpperCase()+" 화면";
  if(ActiveViewState.session?.networkOpened)ConnectionPresentation.renderP2PHealth({state:ActiveViewState.session.networkState,rtt:ActiveViewState.session.lastRtt},true);

  if(ActiveViewState.renderer){
    ActiveViewState.renderer.role=ActiveViewState.role;
    ActiveViewState.renderer.cameraLeft=ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft==null?0:ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft;
    ActiveViewState.renderer.cameraTop=ViewRuntimeState.byRole[ActiveViewState.role].cameraTop==null?(ActiveViewState.renderer?.world||WorldContext.standard).height-VIEW_H:ViewRuntimeState.byRole[ActiveViewState.role].cameraTop;
  }

  const liveState=ViewRuntimeState.byRole[ActiveViewState.role].snapshot;
  if(liveState)BattlePresentation.renderGame(liveState);
}

  static setElementVisible(ref,visible){
  if(!ref)return false;
  ref.classList.toggle("hidden",!visible);
  return !!visible;
}
  static setRoleSwitcherActive(role){
  UiRegistry.refs.hostView?.classList.toggle("active",role==="host");
  UiRegistry.refs.guestView?.classList.toggle("active",role==="guest");
}
  static setUiRadio(group,value){const allowed=UI_RADIO[group];if(!allowed?.has(value))throw new Error(`Invalid UI ${group}: ${value}`);UiRuntimeState.value[group]=value;return value}
  static setUiScreen(value){UiController.setUiRadio("screen",value);UiController.renderUiState();LaunchScreens.syncScreen(value);return value}
  static setUiModal(value){
  const prev=UiRuntimeState.value.modal;UiController.setUiRadio("modal",value);
  if(prev==="spell-choice"&&value!=="spell-choice")UiRuntimeState.value.modalState.spellChoice="idle";
  if(prev==="disconnect"&&value!=="disconnect")UiRuntimeState.value.modalState.disconnect="hidden";
  return value;
}
  static setUiCommand({branch=UiRuntimeState.value.command.branch,category=UiRuntimeState.value.command.category,page=UiRuntimeState.value.command.page}={}){
  if(!UI_RADIO.command.has(branch))throw new Error(`Invalid UI command branch: ${branch}`);
  if(!["economy","military","research","tactics"].includes(category))category="economy";
  if(branch!=="tree")page=null;
  UiRuntimeState.value.command={branch,category,page};if(typeof UiRegistry.refs!=="undefined")UiController.renderUiState();return UiRuntimeState.value.command;
}
  
  static interactivePointerHeldInside(container){
  const el=pointerInteractions.active?.el;
  return !!(container&&el&&container.contains(el));
}
  static openDialog(d){
  if(typeof d.showModal==="function"){
    if(!d.open)d.showModal();
  }else{
    d.setAttribute("open","");
  }
}
  static closeDialog(d){
  if(typeof d.close==="function"&&d.open)d.close();
  else d.removeAttribute("open");
}
  static syncModalState(){
  for(const [kind,key] of Object.entries(UI_MODAL_DIALOG_KEYS)){const el=UiRegistry.refs[key],should=UiRuntimeState.value.modal===kind;if(!el)continue;if(should){if(!el.open)UiController.openDialog(el)}else if(el.open)UiController.closeDialog(el)}
  UiRegistry.refs.matchMenuModal?.classList.toggle("hidden",UiRuntimeState.value.modal!=="match-menu");
  UiRegistry.refs.helpModal?.classList.toggle("active",UiRuntimeState.value.modal==="help");
  UiRegistry.refs.spellChoiceModal?.classList.toggle("active",UiRuntimeState.value.modal==="spell-choice");
  UiRegistry.refs.disconnectGate?.classList.toggle("hidden",UiRuntimeState.value.modal!=="disconnect");
}
  static openUiModal(kind){UiController.setUiModal(kind);UiController.syncModalState();return kind}
  static closeUiModal(kind=UiRuntimeState.value.modal){if(UiRuntimeState.value.modal!==kind)return false;UiController.setUiModal("none");UiController.syncModalState();return true}
  static setStartNetcodeMode(value){CONFIG.netcode.mode=netcodeMode(value)}
  static setStartSimulationTps(value){UiRuntimeState.value.settings.simulationTps=RangeUtil.clamp(Math.round(Number(value)||10),10,30)}
  static openJoinDialog(){
  NetworkModuleLoader.pendingPeerAction=null;
  UiRegistry.refs.joinError.textContent="";
  UiRegistry.refs.room.value="";
  UiRegistry.refs.joinConfirm.disabled=false;
  UiRegistry.refs.joinConfirm.textContent="참가하기";

  UiController.openUiModal("join");

  // 모바일에서는 다이얼로그를 연 직후 입력칸을 강제 focus하지 않는다.
  // 사용자가 입력칸을 탭했을 때 키보드가 열리는 일반적인 동작을 따른다.
}
  static clearTransientTargetModeForUiAction(target){
  if(UiRuntimeState.value.target.type!=="build"&&UiRuntimeState.value.target.type!=="spell")return;
  const btn=target?.closest?.("button");
  if(!btn||btn.disabled||UiController.shouldKeepTargetModeForButton(btn))return;
  UiController.cancelTargetMode(true);
}
  static renderUiState(){
  const screen=UiRuntimeState.value.screen;
  UiRegistry.refs.lobby?.classList.toggle("hidden",screen!=="lobby");
  // screen state maps 1:1 to sibling DOM screens.
  const gameShellVisible=screen==="game"||screen==="replay";
  UiRegistry.refs.game?.classList.toggle("hidden",!gameShellVisible);
  document.body.classList.toggle("playing",gameShellVisible);
  document.body.classList.toggle("replay-mode",screen==="replay");
  document.body.classList.toggle("result-mode",screen==="result");
  UiRegistry.refs.result?.classList.toggle("hidden",screen!=="result");
  if(typeof UiController.syncModalState==="function")UiController.syncModalState();
  document.body.classList.toggle("minimap-expanded",!!UiRuntimeState.value.options.minimapExpanded);
  UiRegistry.refs.lockstepDebugPanel?.classList.toggle("hidden",!UiRuntimeState.value.options.lockstepDebugOpen);
  UiRegistry.refs.p2pHealth?.setAttribute("aria-expanded",UiRuntimeState.value.options.lockstepDebugOpen?"true":"false");
  if(UiRegistry.refs.minimapExpandBtn){
    UiRegistry.refs.minimapExpandBtn.setAttribute("aria-pressed",UiRuntimeState.value.options.minimapExpanded?"true":"false");
    UiRegistry.refs.minimapExpandBtn.textContent=UiRuntimeState.value.options.minimapExpanded?"↙":"⛶";
  }
  const branch=UiRuntimeState.value.command.branch;
  UiRegistry.refs.commandDrawer?.classList.toggle("hidden",branch==="closed");
  if(UiRegistry.refs.commandDrawer){
    if(branch==="closed")delete UiRegistry.refs.commandDrawer.dataset.popupMode;
    else UiRegistry.refs.commandDrawer.dataset.popupMode=branch;
  }
  UiRegistry.refs.buildTree?.classList.toggle("hidden",branch!=="tree");
  UiRegistry.refs.buildingPanel?.classList.toggle("hidden",branch!=="building"||!BuildingPresentation.selectedOwnBuilding());
}
  static invalidatePanelHtmlCaches({unit=false,reinforcement=false,clearDom=true}={}){
  // Cache invalidation uses null rather than an empty string. Some panels can
  // legitimately render an empty string, so using "" as both "invalid" and
  // "currently empty" lets stale DOM survive a context switch.
  if(unit)BattlePresentationCache.lastUnitGridHtml=null;
  BattlePresentationCache.lastSpellInventoryHtml=null;
  BattlePresentationCache.lastSpellChoiceAreaHtml=null;
  BattlePresentationCache.lastSpellChoiceModalHtml=null;
  BattlePresentationCache.lastBuildingActionsHtml=null;
  if(reinforcement)BattlePresentationCache.lastReinforcementOverviewHtml=null;

  if(!clearDom)return;
  if(unit&&UiRegistry.refs.unitGrid)UiRegistry.refs.unitGrid.innerHTML="";
  if(UiRegistry.refs.spellInventory)UiRegistry.refs.spellInventory.innerHTML="";
  if(UiRegistry.refs.spellChoiceArea)UiRegistry.refs.spellChoiceArea.innerHTML="";
  if(UiRegistry.refs.buildingPanelActions)UiRegistry.refs.buildingPanelActions.innerHTML="";
  if(reinforcement&&UiRegistry.refs.reinforcementGrid)UiRegistry.refs.reinforcementGrid.innerHTML="";
  if(UiRegistry.refs.spellChoiceModalContent&&!BattlePresentation.tacticalChestModalIsOpen())UiRegistry.refs.spellChoiceModalContent.innerHTML="";
}
  static setMode(m,{silent=false}={}){
  UiRuntimeState.value.target=m;
  if(LocalEnvironmentUtil.isLocalTest())ViewRuntimeState.byRole[ActiveViewState.role].target=CloneUtil.clone(m);

  const isBuild=m.type==="build",isSpell=m.type==="spell";
  document.body.classList.toggle("build-mode-active",isBuild);
  document.body.classList.toggle("spell-mode-active",isSpell);
  UiRegistry.refs.flagBtn.classList.toggle("active",m.type==="flag");
  // 건설 종료 UX는 전장 하단의 전용 「건설 마침」 영역 하나로만 표시한다.
  // 기존 modeTip 건설 안내는 중복/겹침을 피하기 위해 항상 숨긴다.
  UiRegistry.refs.modeTip.classList.toggle("build-mode",false);
  UiRegistry.refs.modeTip.classList.add("hidden");
  UiRegistry.refs.modeTip.setAttribute("aria-hidden","true");

  BuildingPresentation.syncBuildPlacementSelectionUi();

  if(ActiveViewState.renderer){
    if(!isBuild)ActiveViewState.renderer.buildPreview=null;
    if(!isSpell)ActiveViewState.renderer.spellPreview=null;
  }

  if(m.type==="flag"){
    const forced=!!ActiveViewState.snap?.flags?.[ConnectionSideUtil.roleSide(ActiveViewState.role)]?.forced;
    UiRegistry.refs.modeTip.textContent=forced
      ? "⚡ 강제 이동 깃발 · 탭: 일반 집결 · 정지 홀드: 집결·충전 · 이후 드래그: 조준 · 놓기: 발사"
      : "🚩 탭: 자동전투 깃발 · 정지 홀드: 집결·충전 · 홀드 전 드래그: 맵 이동 · 이후 드래그: 조준 · 놓기: 발사";
    CommandPresentation.syncCommandDock();
    if(!silent)LogUtil.log("🚩 깃발 이동 모드");
    return;
  }

  if(isSpell){
    const d=SpellDefinition.get(m.spellId);
    const stage=m.spellId==="tunnel"?(m.stage==="exit"?"출구":"입구"):"목표";
    UiRegistry.refs.modeTip.textContent=`${d?.icon||"✦"} ${d?.name||"스펠"} · ${stage} 지정`;
    CommandPresentation.syncCommandDock();
    return;
  }

  const bd=BuildingDefinition.get(m.building);

  if(ActiveViewState.renderer){
    // 건설 모드 진입은 카메라 위치를 절대 변경하지 않는다.
    // 미리보기만 현재 보이는 화면 중앙에서 시작하고,
    // 사용자가 드래그/탭해서 원하는 위치를 직접 선택한다.
    const previewX=RangeUtil.clamp(ActiveViewState.renderer.cameraLeft+VIEW_W*.5,80,(ActiveViewState.renderer?.world||WorldContext.standard).width-80);
    const previewY=RangeUtil.clamp(ActiveViewState.renderer.cameraTop+VIEW_H*.5,80,(ActiveViewState.renderer?.world||WorldContext.standard).height-80);

    const auth=UiController.viewToAuth(previewX,previewY);
    const action={type:"BUILD",building:m.building,produceType:m.produceType||null,x:auth.x,y:auth.y};
    const err=ActiveViewState.snap?BuildingPresentation.buildValidation(ActiveViewState.snap,ConnectionSideUtil.roleSide(ActiveViewState.role),action):"상태 준비 중";
    ActiveViewState.renderer.buildPreview={
      x:previewX,
      y:previewY,
      building:m.building,
      valid:!err,
      error:err,
      density:BuildingPresentation.previewBuildDensity(ConnectionSideUtil.roleSide(ActiveViewState.role),action)
    };
  }

  const label=m.produceType
    ? `${UnitDefinition.get(m.produceType).name} ${BuildingDefinition.get(m.building)?.productionLabel||BuildingDefinition.get(m.building)?.name||"생산시설"}`
    : (bd?.name||"건물");
  // 전장 내 건설 종료 표시는 buildFinishBtn 하나만 사용한다.
  CommandPresentation.syncCommandDock();
  if(silent)return;
  LogUtil.log(ActiveViewState.renderer?.buildPreview?.valid
    ? `🏗️ ${label} 건설 모드 · 초록 미리보기 위치를 클릭하세요`
    : `⚠ ${label} 건설 모드 · ${ActiveViewState.renderer?.buildPreview?.error||"건설 가능한 위치로 이동하세요"}`);
}
  static viewToAuth(x,y){
  return ActiveViewState.role==="guest"
    ? {x:(ActiveViewState.renderer?.world||WorldContext.standard).width-x,y:(ActiveViewState.renderer?.world||WorldContext.standard).height-y}
    : {x,y};
}
  static cancelTargetMode(silent=false){if(UiRuntimeState.value.target.type!=="flag")UiController.setMode({type:"flag"},{silent})}
  static interactionActionKeyFromElement(el){
  if(!el)return null;
  if(el.dataset.deckCardType&&el.dataset.deckCardId)return `deck-card:${el.dataset.deckCardType}:${el.dataset.deckCardId}`;
  if(el.dataset.deckUnitSlot!=null)return `deck-builder-slot:${el.dataset.deckUnitSlot}`;
  if(el.dataset.deckFilter!=null)return `deck-filter:${el.dataset.deckFilter}`;
  if(el.dataset.globalResearch)return `research-global:${el.dataset.globalResearch}:${el.dataset.unit||""}:${el.dataset.researchId||""}`;
  if(el.dataset.research)return `research:${el.dataset.research}:${el.dataset.unit||""}`;
  if(el.dataset.produceUnit)return `produce:${el.dataset.produceUnit}`;
  if(el.dataset.defenseBuild)return `defense:${el.dataset.defenseBuild}`;
  if(el.id)return `id:${el.id}`;
  // Generic delegated cards/buttons: derive a rerender-stable identity from data-*.
  // This keeps trailing native click suppression working even when the pressed DOM
  // node is replaced between pointerup and click.
  const dataKeys=Object.keys(el.dataset||{}).sort();
  if(dataKeys.length){
    const signature=dataKeys.map(k=>`${k}=${String(el.dataset[k])}`).join("&");
    return `data:${el.tagName||"el"}:${signature}`;
  }
  return null;
}
  static shouldKeepTargetModeForButton(btn){
  if(!btn)return false;
  // These controls either finish/cancel the current target explicitly or
  // immediately replace it with another build/spell target. Their own handlers
  // own the transition semantics.
  return btn===UiRegistry.refs.buildFinishBtn ||
    btn===UiRegistry.refs.spellCancelBtn ||
    !!btn.closest?.("[data-produce-unit],[data-defense-build],[data-cast-spell]") ||
    [UiRegistry.refs.supplyBtn,UiRegistry.refs.gasExtractorBtn,UiRegistry.refs.academyBtn,UiRegistry.refs.airIncubatorBtn,UiRegistry.refs.labBtn].includes(btn);
}
  static bindImmediateButton(btn,handler){
  if(!btn)return;
  btn.addEventListener("click",e=>{
    if(btn.disabled)return;
    e.preventDefault();
    handler(e);
  });
}
}

class SpellPresentation{
  static setSpellChoicePhase(phase){if(!["idle","requesting","choosing","replacing"].includes(phase))throw new Error(`Invalid spell-choice phase: ${phase}`);UiRuntimeState.value.modalState.spellChoice=phase;return phase}
  
  static formatSpellRows(rows){
  return rows.map(([label,value])=>`<div class="spell-stat-row"><span>${label}</span><b>${value}</b></div>`).join("");
}
  static formatSpellUpgradeRows(rows){
  return rows.map(([label,from,to])=>`<div class="spell-stat-row spell-stat-change"><span>${label}</span><b>${from} → ${to}</b></div>`).join("");
}
  static spellCooldownProgress(id,mastery,remaining){
  const total=Math.max(1,Number(SpellDefinition.statsAt(id,mastery)?.cooldown)||1);
  const left=Math.max(0,Number(remaining)||0);
  const ready=left<=0;
  // Cooldown UX is normalized to readiness: cast = 0%, ready = 100%.
  const pct=ready?100:RangeUtil.clamp(Math.floor((1-Math.min(left,total)/total)*100),0,99);
  return {total,left,ready,pct};
}
  static spellCooldownBarHtml(id,mastery,remaining){
  const p=SpellPresentation.spellCooldownProgress(id,mastery,remaining);
  return `<div class="cooldown-progress ${p.ready?"ready":""}" role="progressbar" aria-label="${p.ready?"사용 가능":"재사용 대기"}" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${p.pct}"><span style="width:${p.pct}%"></span></div><div class="cooldown-progress-label ${p.ready?"ready":""}"><span>${p.ready?"READY":"재사용 대기"}</span><b>${p.pct}%</b></div>`;
}
  static renderSpellChoiceModal(state){
  if(!UiRegistry.refs.spellChoiceModal||!UiRegistry.refs.spellChoiceModalContent||!ActiveViewState.role)return;
  if(!BattlePresentation.tacticalChestModalIsOpen()){
    return;
  }
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role),count=Number(state?.spellChests?.[side])||0;
  const offer=state?.pendingChestOffers?.[side]||null;
  const replacement=state?.pendingSpellReplacement?.[side]||null;
  const books=state?.spellBooks?.[side]||{},equipped=state?.equippedSpells?.[side]||[];

  if(!offer){
    if(BattlePresentation.tacticalChestModalAwaitingOffer()&&count>0){
      UiRegistry.refs.spellChoiceModalTitle.textContent="📦 전술상자";
      UiRegistry.refs.spellChoiceModalSub.textContent=`보유 ${count}개 · 보상 후보를 생성하고 있습니다.`;
      const html=`<div class="spell-choice-inline-hint">잠시 후 현재 게임 상태에서 유효한 보상 3개가 고정됩니다. 지금 취소해도 상자는 차감되지 않습니다.</div>`;
      if(BattlePresentationCache.lastSpellChoiceModalHtml!==html){UiRegistry.refs.spellChoiceModalContent.innerHTML=html;BattlePresentationCache.lastSpellChoiceModalHtml=html}
      return;
    }
    if(UiRuntimeState.value.modal==="spell-choice")UiController.closeUiModal("spell-choice");
    SpellPresentation.setSpellChoicePhase("idle");
    return;
  }

  SpellPresentation.setSpellChoicePhase(replacement?"replacing":"choosing");
  let html="";
  if(replacement){
    const d=SpellDefinition.get(replacement.reward.spellId);
    UiRegistry.refs.spellChoiceModalTitle.textContent="스펠 빼기";
    UiRegistry.refs.spellChoiceModalSub.textContent=`${d?.name||"새 스펠"}을 장착할 슬롯을 선택하세요. 취소하면 동일한 전술상자 3택이 그대로 남습니다.`;
    html=`<div class="spell-choice-modal-grid">${equipped.map(id=>{const old=SpellDefinition.get(id),e=books[id]||{mastery:0};return `<button type="button" class="spell-card ready" data-replace-spell="${id}" data-offer-id="${replacement.offerId}"><div class="spell-icon">${old.icon}</div><div class="spell-name">${old.name} Lv.${SpellDefinition.masteryLevel(e.mastery||0)}</div><div class="spell-desc">이 스펠을 빼고 ${d?.name||"새 스펠"} 장착</div></button>`}).join("")}</div>`;
  }else{
    UiRegistry.refs.spellChoiceModalTitle.textContent="📦 전술상자 보상";
    UiRegistry.refs.spellChoiceModalSub.textContent=`보유 ${count}개 · 하나를 최종 선택할 때만 상자 1개가 차감됩니다. 취소해도 이 3택은 그대로 유지됩니다.`;
    html=`<div class="spell-choice-modal-grid" data-offer-id="${offer.id}">${offer.options.map(r=>BattlePresentation.renderTacticalRewardCard(r,books)).join("")}</div>`;
  }
  if(BattlePresentationCache.lastSpellChoiceModalHtml!==html){UiRegistry.refs.spellChoiceModalContent.innerHTML=html;BattlePresentationCache.lastSpellChoiceModalHtml=html}
}
  static renderSpellPanel(state){
  if(!state||!ActiveViewState.role)return;
  BattlePresentation.renderPassiveStatus(state);
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role),books=state.spellBooks?.[side]||{},equipped=state.equippedSpells?.[side]||[];
  const choiceAreaHtml=`<div class="spell-choice-inline-hint">장착 ${equipped.length}/${SPELL_SLOT_MAX} · 비장착 보유 스펠은 전술상자 보상으로 다시 장착할 수 있습니다.</div>`;
  if(choiceAreaHtml!==BattlePresentationCache.lastSpellChoiceAreaHtml){UiRegistry.refs.spellChoiceArea.innerHTML=choiceAreaHtml;BattlePresentationCache.lastSpellChoiceAreaHtml=choiceAreaHtml}
  BattlePresentation.updateTacticalChestBadge(state);
  SpellPresentation.renderSpellChoiceModal(state);
  const inventoryHtml=!equipped.length
    ? `<div class="small" style="grid-column:1/-1">전술상자를 열어 스펠을 획득하세요. 동시에 최대 3개까지 장착됩니다.</div>`
    : equipped.map(id=>{
        const d=SpellDefinition.get(id),e=books[id]||{mastery:0,cooldownUntil:0};
        const remaining=Math.max(0,(e.cooldownUntil||0)-state.tick),cooldown=SpellPresentation.spellCooldownProgress(id,e.mastery||0,remaining),ready=cooldown.ready,level=SpellDefinition.masteryLevel(e.mastery||0);
        return `<button type="button" class="spell-card ${ready?"ready":"cooldown"}" data-cast-spell="${id}" ${ready?"":"disabled"}><div class="spell-icon">${d.icon}</div><div class="spell-name">${d.name} · Lv.${level}</div><div class="spell-desc">${d.desc}</div>${SpellPresentation.formatSpellRows(SpellDefinition.statRows(id,e.mastery||0))}${SpellPresentation.spellCooldownBarHtml(id,e.mastery||0,remaining)}</button>`;
      }).join("");
  if(inventoryHtml!==BattlePresentationCache.lastSpellInventoryHtml){UiRegistry.refs.spellInventory.innerHTML=inventoryHtml;BattlePresentationCache.lastSpellInventoryHtml=inventoryHtml}
  const readyCount=equipped.filter(id=>Math.max(0,(books[id]?.cooldownUntil||0)-state.tick)<=0).length;
  const meta=UiRegistry.refs.tacticsSpellBtn?.querySelector("small");if(meta)meta.textContent=equipped.length?`${readyCount}/${equipped.length} READY · ${equipped.length}/${SPELL_SLOT_MAX}`:`0/${SPELL_SLOT_MAX} 장착`;
  if(UiRuntimeState.value.command.page==="tactics-chest")BattlePresentation.renderTacticalChest(state);
}
  static beginSpellTarget(id){
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role);
  const d=SpellDefinition.get(id);
  if(!d)return;

  const entry=ActiveViewState.snap?.spellBooks?.[side]?.[id];
  const tick=ActiveViewState.snap?.tick||0;
  if(!entry?.unlocked||!(ActiveViewState.snap?.equippedSpells?.[side]||[]).includes(id)){
    LogUtil.log("⚠ 현재 장착된 스펠이 아닙니다.");
    return;
  }
  if(tick<(entry.cooldownUntil||0)){
    const progress=SpellPresentation.spellCooldownProgress(id,entry.mastery||0,(entry.cooldownUntil||0)-tick);
    LogUtil.log(`⚠ ${d.name} 재사용 대기 중 · 게이지 ${progress.pct}%`);
    return;
  }

  
  CommandPresentation.closeCommandDrawer();
  if(id==="tunnel"){
    UiController.setMode({type:"spell",spellId:id,stage:"entry"});
    LogUtil.log(`⛏ ${d.name} 입구를 현재 시야 안에서 지정하세요.`);
  }else{
    UiController.setMode({type:"spell",spellId:id,stage:"point"});
    LogUtil.log(`${d.icon} ${d.name} 시전 위치를 지정하세요.`);
  }
}
}

/* Draft presentation invariant:
   FINAL ROSTER is finale-only. Draft entry/round screens must keep draftCountdown hidden;
   mobile/desktop layout CSS must never override the shared visibility state. */
// Native mouse click requires the same DOM node to survive from pointerdown through pointerup.
// Dynamic command/research panels can refresh from selected-TPS simulation / 10 Hz snapshots, so hold their DOM stable
// while any primary pointer is actively pressing an interactive target inside them.

// Local-only debounced gas assignment UI. Authoritative target changes only after the user pauses input.
const pendingGasWorkerTargets=new Map();

class GasWorkerAssignmentPolicy{
  static clearPendingGasWorkerTargets(){
  for(const p of pendingGasWorkerTargets.values()){
    if(p?.timer)clearTimeout(p.timer);
    if(p?.expireTimer)clearTimeout(p.expireTimer);
  }
  pendingGasWorkerTargets.clear();
}
  static pendingGasTargetFor(building){
  const p=building?pendingGasWorkerTargets.get(building.id):null;
  if(!p||p.session!==MatchLifecycle.activeSession())return Math.max(0,Number(building?.gasWorkerTarget)||0);
  const authoritative=Math.max(0,Number(building?.gasWorkerTarget)||0);
  if(p.sent&&authoritative===p.target){
    if(p.timer)clearTimeout(p.timer);
    if(p.expireTimer)clearTimeout(p.expireTimer);
    pendingGasWorkerTargets.delete(building.id);
    return authoritative;
  }
  return p.target;
}
  static stageGasWorkerTarget(buildingId,target){
  const sess=MatchLifecycle.activeSession();
  if(!sess?.sim)return false;
  target=RangeUtil.clamp(Math.round(Number(target)||0),0,GAS_ASSIGNMENT_MAX);
  const prev=pendingGasWorkerTargets.get(buildingId);
  if(prev?.timer)clearTimeout(prev.timer);
  if(prev?.expireTimer)clearTimeout(prev.expireTimer);
  const state={session:sess,target,sent:false,timer:0,expireTimer:0};
  state.timer=setTimeout(()=>{
    state.timer=0;
    if(sess.disposed||sess.simEnded||pendingGasWorkerTargets.get(buildingId)!==state){
      if(pendingGasWorkerTargets.get(buildingId)===state)pendingGasWorkerTargets.delete(buildingId);return;
    }
    state.sent=true;sess.command({type:"SET_GAS_WORKERS",buildingId,target:state.target});
    // Never let a rejected/stale optimistic target poison later +/- input forever.
    state.expireTimer=setTimeout(()=>{
      if(pendingGasWorkerTargets.get(buildingId)===state)pendingGasWorkerTargets.delete(buildingId);
    },2000);
  },GAS_WORKER_UI_DEBOUNCE_MS);
  pendingGasWorkerTargets.set(buildingId,state);
  return true;
}
}

class ViewRuntimeState{static byRole={
  host:{draft:null,snapshot:null,cameraLeft:null,cameraTop:null,selection:{unit:null,buildingId:null},target:{type:"flag"}},
  guest:{draft:null,snapshot:null,cameraLeft:null,cameraTop:null,selection:{unit:null,buildingId:null},target:{type:"flag"}}
}}

window.addEventListener("resize",()=>requestAnimationFrame(()=>ConnectionPresentation.positionP2PHealthNextToMenu()));
window.addEventListener("orientationchange",()=>setTimeout(()=>ConnectionPresentation.positionP2PHealthNextToMenu(),80));

class DebugFormatUtil{
  static formatDebugBytes(bytes){
    const n=Number(bytes)||0;
    if(n<1024)return n+" B";
    if(n<1024*1024)return (n/1024).toFixed(1)+" KB";
    return (n/(1024*1024)).toFixed(2)+" MB";
  }
}

class ConnectionPresentation{
  static showVersionMismatch(info,role){
    const message=String(info.message||"게임 버전이 다릅니다. 양쪽 모두 같은 최신 HTML을 사용하세요.");
    UiRegistry.refs.net.textContent=message;
    if(SinglePlayerModeUtil.isSinglePlayer()){
      UiRegistry.refs.singleStatus.textContent=message;
      UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
      MatchLifecycle.stopSinglePlayer();
    }else if(role==="host"){
      UiRegistry.refs.createStatus.textContent=message+" · 현재 방은 참가 대기를 유지합니다.";
    }else{
      UiRegistry.refs.joinError.textContent=message;
      UiRegistry.refs.joinConfirm.disabled=false;UiRegistry.refs.joinConfirm.textContent="참가하기";
    }
    if(UiRegistry.refs.log)UiRegistry.refs.log.textContent=message;
  }

  static lastP2PHealthInfo=null;
  static lastP2PHealthLocal=false;

  static openLockstepDebugPanel(){UiRuntimeState.value.options.lockstepDebugOpen=true;UiController.renderUiState();ConnectionPresentation.renderLockstepDebugPanel()}
  static closeLockstepDebugPanel(){UiRuntimeState.value.options.lockstepDebugOpen=false;UiController.renderUiState()}
  static renderP2PHealth(info,isLocal=false){
  if(!info)return;
  const netcode=MatchLifecycle.activeSession?.()?.netcodeSession;
  if(netcode){const state={running:"connected",resimulating:"connected",synchronizing:"unstable",recovering:"unstable",interrupted:"unstable",disconnected:"disconnected",failed:"fatal",closed:"disconnected"}[netcode.status];info={...info,rtt:netcode.metrics.smoothedRTT,state:info.state==="fatal"?"fatal":state||info.state}}
  ConnectionPresentation.lastP2PHealthInfo=info;ConnectionPresentation.lastP2PHealthLocal=!!isLocal;
  UiRegistry.refs.p2pHealth.classList.remove("hidden","connected","unstable","disconnected","fatal");
  const state=info.state||"connected";UiRegistry.refs.p2pHealth.classList.add(state==="fatal"?"disconnected":state);
  if(state==="fatal")UiRegistry.refs.p2pHealthText.textContent="오류";
  else if(state==="disconnected")UiRegistry.refs.p2pHealthText.textContent="끊김";
  else if(state==="unstable")UiRegistry.refs.p2pHealthText.textContent=info.rtt==null?"불안정":`⚠ ${Math.round(info.rtt)}ms`;
  else UiRegistry.refs.p2pHealthText.textContent=info.rtt==null?(isLocal?"● LOCAL":"● P2P"):`● ${Math.round(info.rtt)}ms`;
  const active=MatchLifecycle.activeSession?.(),rp=ActiveViewState.renderer?.perfStats,detail=[];if(info.rtt!=null)detail.push(`RTT ${Math.round(info.rtt)}ms`);if(active?.sim)detail.push(active.netcodeMode,`tick ${active.sim.tick}`,`${SimulationTiming.tps()} TPS`);if(rp?.fps>0)detail.push(`${Math.round(rp.fps)} FPS`);UiRegistry.refs.p2pHealth.title=detail.join(" · ")||"동기화 진단 열기";
  ConnectionPresentation.positionP2PHealthNextToMenu();
}
  static renderLockstepDebugPanel(){
  if(!UiRuntimeState.value.options.lockstepDebugOpen)return;
  const active=MatchLifecycle.activeSession?.();

  if(!active?.netcodeSession){
    for(const el of UiRegistry.refs.lockstepDebugPanel.querySelectorAll('#performanceTimingPanel b'))el.textContent='-';
    UiRegistry.refs.lockstepDebugSummary.textContent="활성 경기에서 확정 입력을 검사할 수 있습니다.";
    UiRegistry.refs.synctestRunBtn.disabled=true;return;
  }
  const core=active.netcodeSession,metrics=core.metrics,report=RallySynctestDiagnostics.report(active),sync=report?.metrics;
  const text=(id,value)=>{UiRegistry.refs[id].textContent=value};
  text("dbgSyncStatus",report?.status||"미실행");
  text("dbgSyncChecked",sync?String(sync.checkedTicks):"-");
  text("dbgSyncResimulated",sync?String(sync.resimulatedTicks):"-");
  text("dbgSyncDistance",sync?String(sync.checkDistance):"-");
  text("dbgSyncHash",sync?.stateHash!=null?sync.stateHash.toString(16).padStart(8,"0"):"-");
  text("dbgSyncBytes",sync?DebugFormatUtil.formatDebugBytes(sync.historyBytes):"-");
  text("dbgSyncCost",sync?Number(sync.totalCostMs).toFixed(2)+"ms":"-");
  const failure=sync?.failure;
  text("dbgSyncFailure",failure?.code==="determinism-mismatch"?"S["+failure.tick+"] · byte "+failure.firstDifference+" · "+failure.expectedHash.toString(16).padStart(8,"0")+" / "+failure.actualHash.toString(16).padStart(8,"0"):failure?.message||report?.error||"없음");
  text("dbgCoreLatency",metrics.smoothedRTT.toFixed(2)+"ms / "+metrics.jitter.toFixed(2)+"ms");
  text("dbgCorePacing",metrics.holds+" / "+metrics.stalls+" / "+metrics.pace);
  text("dbgCorePrediction",metrics.predictedTicks+" / "+metrics.lateInputRate.toFixed(4));
  text("dbgCoreHistory",DebugFormatUtil.formatDebugBytes(metrics.retainedSnapshotBytes)+" / "+metrics.stateHashComputations);
  text("dbgCoreStatus",core.profile.mode+" / "+core.status+" / "+core.confirmedTick);
  text("dbgCoreRollback",metrics.inputDelay+"t / "+metrics.rollbacks+" / "+metrics.resimulatedTicks);
  text("dbgCoreRecovery",metrics.hashMismatches+" / "+metrics.recoveries+" / "+metrics.rejectedSnapshots);
  text("dbgCoreBytes",DebugFormatUtil.formatDebugBytes(metrics.sentBytes)+" / "+DebugFormatUtil.formatDebugBytes(metrics.receivedBytes));
  UiRegistry.refs.synctestRunBtn.disabled=report?.status==="running"||core.resimulating||active.disposed;
  const perf=active.sim?.perfStats||PerformanceTelemetry.createLocalPerfStats();
  const fmtMs=v=>`${(Number(v)||0).toFixed(2)}ms`;
  const peerRole=active.role==="host"?"guest":"host";
  const peerPerf=SinglePlayerModeUtil.isSinglePlayer()?MatchLifecycle.singleMatch?.sessions?.[peerRole]?.sim?.perfStats:null;
  const avgCandidates=perf.spatialQueries?perf.spatialCandidates/perf.spatialQueries:0;
  UiRegistry.refs.dbgPerfStep.textContent=`${fmtMs(perf.lastStepMs)} / ${fmtMs(perf.ewmaStepMs)} / ${fmtMs(perf.maxStepMs)}`;
  UiRegistry.refs.dbgPerfPeerStep.textContent=peerPerf?`${peerRole} ${fmtMs(peerPerf.lastStepMs)} / EWMA ${fmtMs(peerPerf.ewmaStepMs)}`:"-";
  UiRegistry.refs.dbgPerfCore.textContent=`${fmtMs(perf.indexMs)} / ${fmtMs(perf.worldMs)} / ${fmtMs(perf.economyMs)}`;
  UiRegistry.refs.dbgPerfCombat.textContent=`${fmtMs(perf.workerMs)} / ${fmtMs(perf.visionMs)} / ${fmtMs(perf.combatMs)}`;
  UiRegistry.refs.dbgPerfTail.textContent=`${fmtMs(perf.projectileMs)} / ${fmtMs(perf.collisionMs)} / ${fmtMs(perf.postMs)}`;
  UiRegistry.refs.dbgPerfSnapshot.textContent=perf.snapshotSamples?`${fmtMs(perf.snapshotMs)} / ${fmtMs(perf.maxSnapshotMs)}`:'표본 수집 중';
  UiRegistry.refs.dbgPerfEntities.textContent=`${perf.aliveUnits||0} / ${perf.combatUnits||0} / ${perf.workers||0} / ${perf.projectiles||0}`;
  UiRegistry.refs.dbgPerfSpatial.textContent=`${perf.spatialQueries||0} / ${perf.spatialCandidates||0} (${avgCandidates.toFixed(1)})`;
  UiRegistry.refs.dbgPerfTarget.textContent=`target ${perf.targetQueries||0} · reject ${perf.targetVisibilityRejects||0} / vis ${perf.visibilityChecks||0} · sideQ ${perf.sideSpatialQueries||0}`;
  UiRegistry.refs.dbgPerfCombatSplit.textContent=`${fmtMs(perf.combatTargetPickMs)} / ${fmtMs(perf.combatOtherMs)} · ${perf.combatTargetPickCalls||0} target calls`;
  UiRegistry.refs.dbgPerfCollision.textContent=`${perf.collisionPairs||0} / ${perf.collisionSoftContacts||0} / ${perf.collisionSoftMovedUnits||0} / ${perf.collisionSoftCappedUnits||0} / ${perf.collisionSoftPasses||0}`;
  UiRegistry.refs.dbgPerfCollisionCore.textContent=`${fmtMs(perf.collisionPrepMs)} / ${fmtMs(perf.collisionGridBuildMs)} / ${fmtMs(perf.collisionPairScanMs)} / ${fmtMs(perf.collisionSoftApplyMs)}`;
  UiRegistry.refs.dbgPerfCollisionTail.textContent=`${fmtMs(perf.collisionSweptMotionMs)} / ${fmtMs(perf.collisionTerrainMs)} / ${fmtMs(perf.collisionHardFixMs)} / ${fmtMs(perf.collisionOtherMs)}`;
  UiRegistry.refs.dbgPerfCollisionSweepFlow.textContent=`${perf.collisionSweptCalls||0} / ${perf.collisionSweptActivePasses||0} / ${perf.collisionSweptPairTests||0} / ${perf.collisionSweptHits||0} / ${perf.collisionSweptCorrectionUnits||0} / ${perf.collisionSweptNoCorrectionPasses||0}`;
  UiRegistry.refs.dbgPerfCollisionHardFixFlow.textContent=`${perf.collisionHardFixCalls||0} / ${perf.collisionHardFixPasses||0} / ${perf.collisionHardFixActivePairTests||0} / ${perf.collisionHardFixCandidates||0} / ${perf.collisionHardFixCorrections||0} / ${perf.collisionHardFixNoOpCalls||0}`;
  const rp=ActiveViewState.renderer?.perfStats;
  UiRegistry.refs.dbgPerfRender.textContent=rp?`${(rp.fps||0).toFixed(1)} FPS / ${fmtMs(rp.ewmaFrameWorkMs)} (max ${fmtMs(rp.maxFrameWorkMs)})`:"-";
  const stats=active.performanceStats,t=stats.timings,m=PerformanceTelemetry.runtimeMonitor;
  const timing=row=>row?.samples?`${fmtMs(row.currentMs)} / ${fmtMs(row.ewmaMs)} / ${fmtMs(row.maxMs)}`:'표본 수집 중';
  PerformanceTelemetry.sampleConnection(active);
  text('dbgPerfInputDelay',`${metrics.inputDelay}t · ${fmtMs(metrics.inputDelay*1000/active.sim.tps)}`);
  text('dbgPerfCommandConfirm',t.commandConfirm?.samples?timing(t.commandConfirm):'입력 없음');
  const commandNow=performance.now();let pendingCommandMs=0;
  for(const ticket of active.pendingNetcodeCommands.values())if(Number.isFinite(ticket.submittedAt))pendingCommandMs=Math.max(pendingCommandMs,commandNow-ticket.submittedAt);
  text('dbgPerfCommandPending',`${active.pendingNetcodeCommands.size}개 · ${fmtMs(pendingCommandMs)}`);
  const iceAge=stats.iceFetchedAt===null?null:performance.now()-stats.iceFetchedAt;
  text('dbgPerfIceRtt',!active.transport?.pc?.getStats?'지원 안 됨':stats.iceError?'조회 실패':stats.iceRttMs===null?'ICE RTT 표본 없음':`${fmtMs(stats.iceRttMs)} · ${fmtMs(iceAge)} 전 조회`);
  text('dbgPerfEventLoop',timing(m?.timings.eventLoop)+(document.hidden?' · 백그라운드':''));
  text('dbgPerfLongTask',!m?.observer?'지원 안 됨':`${m.longTasks}회 · 최근 ${fmtMs(m.longTaskMs)} / 최대 ${fmtMs(m.maxLongTaskMs)}`);
  text('dbgPerfPulseGap',timing(t.pulseGap));text('dbgPerfPulse',timing(t.pulse));text('dbgPerfStateSave',timing(t.save));
  text('dbgPerfResimulation',metrics.resimulatedTicks?`${fmtMs(metrics.latestResimulationMs)} / ${fmtMs(metrics.resimulationCostMs)}`:'미실행');
  text('dbgPerfPresentation',`Targets ${timing(t.renderTargets)} · UI ${timing(t.snapshotUi)}`);
  text('dbgPerfFrameInterval',rp?`${fmtMs(rp.frameIntervalMs)} / ${fmtMs(rp.ewmaFrameIntervalMs)} / ${fmtMs(rp.maxFrameIntervalMs)}`:'표본 수집 중');
  const pass=name=>rp?.passes?.[name],passMs=name=>pass(name)?fmtMs(pass(name).ms):'-',begin=pass('device-begin');
  text('dbgPerfDeviceBegin',begin?`${fmtMs(begin.ms)} / ${fmtMs(begin.ewmaMs)} / ${fmtMs(begin.maxMs)}`:'표본 수집 중');
  text('dbgPerfRenderPasses',`${passMs('prepare')} / ${passMs('ground')} / ${passMs('world')}`);
  text('dbgPerfRenderEffects',`${passMs('shadow')} / ${passMs('overlay')} / ${passMs('ui-fx')}`);
  text('dbgPerfRenderTail',`${passMs('camera-compose')} / ${passMs('minimap')} / ${rp?fmtMs(rp.cpuDepthSortMs):'-'}`);
  const nav=active.sim.navigation?.metrics;
  text('dbgPerfNavigation',nav?`${fmtMs(nav.meshBuildMs)} / ${fmtMs(nav.astarCostMs)} / ${fmtMs(nav.fieldBuildMs)}`:'-');
  text('dbgPerfProjection',nav?fmtMs(nav.projectionBuildMs):'-');
  text('dbgPerfDrawCalls',`${rp?.drawCalls||0} / ${DebugFormatUtil.formatDebugBytes(rp?.bufferUploadBytes||0)} · 전송 대기 ${DebugFormatUtil.formatDebugBytes(active.transport?.netcodeBufferedAmount||0)}`);
  const activeTps=SimulationTiming.tps(),allowanceMs=1000/activeTps,isSingle=SinglePlayerModeUtil.isSinglePlayer();
  UiRegistry.refs.dbgPerfAllowanceLabel.textContent=activeTps+" TPS 틱 허용시간";
  UiRegistry.refs.dbgPerfAllowance.textContent=fmtMs(allowanceMs);
  UiRegistry.refs.dbgPerfUsedLabel.textContent=isSingle?"사용시간 · 싱글 두 세션 step EWMA":"사용시간 · 현재 세션 step EWMA";
  const sampled=perf.stepSamples>0&&(!isSingle||peerPerf?.stepSamples>0);
  if(!sampled){UiRegistry.refs.dbgPerfUsed.textContent=UiRegistry.refs.dbgPerfBudget.textContent="표본 수집 중"}
  else{
    const usedMs=perf.ewmaStepMs+(isSingle?peerPerf.ewmaStepMs:0),remainingMs=Math.max(0,allowanceMs-usedMs),overrunMs=Math.max(0,usedMs-allowanceMs);
    UiRegistry.refs.dbgPerfUsed.textContent=fmtMs(usedMs)+" · "+(usedMs/allowanceMs*100).toFixed(1)+"% 사용";
    UiRegistry.refs.dbgPerfBudget.textContent=fmtMs(remainingMs)+" · "+(remainingMs/allowanceMs*100).toFixed(1)+"% 남음"+(overrunMs>0?" · "+fmtMs(overrunMs)+" 초과":"");
  }
  UiRegistry.refs.dbgEndurancePeaks.textContent=`${perf.peakAliveUnits||0} / ${perf.peakBuildings||0} / ${perf.peakProjectiles||0}`;

  const bs=active.sim?.balanceStats||PerformanceTelemetry.createLocalBalanceStats();
const formatTickTime=t=>t==null?"-":`${SimulationTiming.ticksToSeconds(t).toFixed(1)}s`;
  const pairTicks=a=>`${formatTickTime(a?.[0])} / ${formatTickTime(a?.[1])}`;
  const pairNums=a=>`${Number(a?.[0])||0} / ${Number(a?.[1])||0}`;
  const avgArmy=[0,1].map(side=>bs.samples?bs.armyTotal[side]/bs.samples:0);
  const pct=(n,d)=>d?`${Math.round(n/d*100)}%`:"0%";
  const elapsedMinutes=SimulationTiming.elapsedMinutes(active.sim?.tick);
  const mineralRate=bs.mineralIncome.map(v=>Math.round((Number(v)||0)/elapsedMinutes));
  const gasRate=bs.gasIncome.map(v=>Math.round((Number(v)||0)/elapsedMinutes));
  UiRegistry.refs.dbgBalanceTime.textContent=`${formatTickTime(active.sim?.tick)} / ${bs.gameEndTick==null?"진행 중":`${formatTickTime(bs.gameEndTick)} · ${bs.winner||"-"}`}`;
  UiRegistry.refs.dbgBalanceT2.textContent=pairTicks(bs.firstTier2UnitTick);
  UiRegistry.refs.dbgBalanceT3.textContent=pairTicks(bs.firstTier3UnitTick);
  UiRegistry.refs.dbgBalanceTech.textContent=`A ${pairTicks(bs.firstTech2Tick)} · L ${pairTicks(bs.firstTech3Tick)}`;
  UiRegistry.refs.dbgBalanceCombat.textContent=formatTickTime(bs.firstCombatTick);
  UiRegistry.refs.dbgBalanceCapture.textContent=pairTicks(bs.firstCaptureTick);
  UiRegistry.refs.dbgBalanceMineral.textContent=`${pairNums(bs.mineralIncome)} · 분당 ${mineralRate[0]} / ${mineralRate[1]}`;
  UiRegistry.refs.dbgBalanceGas.textContent=`${pairNums(bs.gasIncome)} · 분당 ${gasRate[0]} / ${gasRate[1]}`;
  UiRegistry.refs.dbgBalanceArmy.textContent=`${bs.currentArmy[0]}/${avgArmy[0].toFixed(1)}/${bs.armyPeak[0]} · ${bs.currentArmy[1]}/${avgArmy[1].toFixed(1)}/${bs.armyPeak[1]}`;
  UiRegistry.refs.dbgBalanceAir.textContent=`${pct(bs.currentAir[0],bs.currentArmy[0])} / ${pct(bs.currentAir[1],bs.currentArmy[1])}`;
  UiRegistry.refs.dbgBalanceAA.textContent=`${pct(bs.currentAntiAir[0],bs.currentArmy[0])} / ${pct(bs.currentAntiAir[1],bs.currentArmy[1])}`;
  UiRegistry.refs.dbgBalanceExhaust.textContent=pairNums(bs.productionExhausted);
  UiRegistry.refs.dbgBalanceLosses.textContent=`${bs.buildingLosses[0]}/${bs.outpostLosses[0]} · ${bs.buildingLosses[1]}/${bs.outpostLosses[1]}`;

  if(UiRegistry.refs.manualRecoveryBtn){
    const recovering=!!(
      active.syncHold &&
      active.recoveryPhase &&
      active.recoveryPhase!=="idle" &&
      active.recoveryPhase!=="needs-manual"
    );

    // Recovery itself is restartable from zero with the same button.
    UiRegistry.refs.manualRecoveryBtn.disabled=!active.sim||active.simEnded;
    UiRegistry.refs.manualRecoveryBtn.textContent=recovering
      ?"복구 처음부터 다시 시작"
      :active.simpleRecoveryNeedsManual||active.recoveryPhase==="needs-manual"
        ?"복구 필요 · 입력 이력으로 재접속"
        :"입력 이력으로 연결 복구";
  }

  if(UiRegistry.refs.fullConnectionResetBtn){
    UiRegistry.refs.fullConnectionResetBtn.disabled=true;
    UiRegistry.refs.fullConnectionResetBtn.classList.add("hidden");
  }

  UiRegistry.refs.lockstepDebugSummary.textContent="확정 입력 Synctest · "+(sync?"S[0]~S["+sync.tick+"]":"미실행")+" · "+core.profile.mode+" · Core "+core.status;
  UiRegistry.refs.lockstepDebugVerdict.className="lockstep-debug-verdict "+(report?.status==="failed"?"bad":report?.status==="passed"?"ok":"warn");
  UiRegistry.refs.lockstepDebugVerdict.textContent=report?.status==="passed"?"검사한 입력 구간의 저장·복원·재실행 결과가 일치했습니다.":report?.status==="failed"?"Synctest가 실패했습니다. 위 라이브러리 실패 정보를 확인하세요.":report?.status==="running"?"공통 Synctest 검사 중…":"Synctest를 실행하면 라이브러리가 측정한 결과를 표시합니다.";

}
  static renderConnectionGate(){
  if(!UiRegistry.refs.disconnectGate||ReplayPresentation.replayPlayer){ConnectionPresentation.setDisconnectPhase("hidden");if(UiRuntimeState.value.modal==="disconnect")UiController.closeUiModal("disconnect");return}
  const active=RecoveryTelemetry.localRecoverySession?.();
  if(!active||active.simEnded){ConnectionPresentation.setDisconnectPhase("hidden");if(UiRuntimeState.value.modal==="disconnect")UiController.closeUiModal("disconnect");return}
  const now=Date.now();
  if(active.postRecoveryResumeAt>now){
    UiController.openUiModal("disconnect");ConnectionPresentation.setDisconnectPhase("resuming");
    const n=Math.max(1,Math.ceil((active.postRecoveryResumeAt-now)/1000));
        UiRegistry.refs.disconnectGateTitle.textContent="연결 복구 완료";
    UiRegistry.refs.disconnectGateCount.textContent=String(n);
    UiRegistry.refs.disconnectGateCount.classList.add("resume");
    UiRegistry.refs.disconnectGateCopy.textContent="권위 상태 검증 완료 · 게임을 곧 재개합니다.";
    UiRegistry.refs.disconnectGateActions.classList.add("hidden");
    return;
  }
  if(active.disconnectGraceDeadlineAt>now){
    UiController.openUiModal("disconnect");
    UiRegistry.refs.disconnectGateTitle.textContent="상대와 연결이 끊겼습니다";
    UiRegistry.refs.disconnectGateCount.textContent=GraceTimeFormatUtil.formatGraceTime(active.disconnectGraceDeadlineAt-now);
    UiRegistry.refs.disconnectGateCount.classList.remove("resume");
    const recovering=active.recoveryPhase&&active.recoveryPhase!=="idle"&&active.recoveryPhase!=="needs-manual";
    ConnectionPresentation.setDisconnectPhase(recovering?"recovering":"grace");
    UiRegistry.refs.disconnectGateCopy.textContent=recovering?"재접속 및 Host 권위 상태 복구 중입니다.":"게임은 현재 정지되어 있습니다. 제한시간 안에 재접속할 수 있습니다.";
    UiRegistry.refs.disconnectGateActions.classList.remove("hidden");
    UiRegistry.refs.disconnectReconnectBtn.disabled=!!recovering;
    UiRegistry.refs.disconnectReconnectBtn.textContent=recovering?"재접속 중…":"재접속 시도";
    return;
  }
  ConnectionPresentation.setDisconnectPhase("hidden");if(UiRuntimeState.value.modal==="disconnect")UiController.closeUiModal("disconnect");
}
  static positionP2PHealthNextToMenu(){
  if(!UiRegistry.refs.p2pHealth)return;
  const inGame=UiRuntimeState.value.screen==="game";
  const menu=UiRegistry.refs.matchMenuBtnGame;
  if(inGame&&menu){
    const r=menu.getBoundingClientRect();
    const badgeH=UiRegistry.refs.p2pHealth.offsetHeight||34;
    UiRegistry.refs.p2pHealth.style.left=`${Math.round(r.right+6)}px`;
    UiRegistry.refs.p2pHealth.style.top=`${Math.round(r.top+(r.height-badgeH)/2)}px`;
    UiRegistry.refs.p2pHealth.classList.add("in-game-positioned");
  }else{
    UiRegistry.refs.p2pHealth.style.left="";UiRegistry.refs.p2pHealth.style.top="";
    UiRegistry.refs.p2pHealth.classList.remove("in-game-positioned");
  }
}
  static hideP2PHealth(){
  UiRegistry.refs.p2pHealth.classList.add("hidden");
  UiRegistry.refs.p2pHealth.classList.remove("connected","unstable","disconnected","in-game-positioned");
  UiRegistry.refs.p2pHealth.style.left="";UiRegistry.refs.p2pHealth.style.top="";
}
  static requestFullConnectionResetFromUi(){
  return RecoveryTelemetry.requestManualRecovery();
}
  static requestConnectionReconnect(){
  const active=RecoveryTelemetry.localRecoverySession?.();
  if(!active||active.simEnded)return false;
  if(active.sim)return RecoveryTelemetry.requestManualRecovery();
  const trans=active.transport;
  if(active.role==="guest")return !!trans?.rebuildRecoveryGuest?.("pre-start-disconnect-reconnect");
  return !!trans?.prepareRecoveryHost?.("pre-start-disconnect-reconnect");
}
  static setDisconnectPhase(phase){if(!["hidden","grace","recovering","resuming"].includes(phase))throw new Error(`Invalid disconnect phase: ${phase}`);UiRuntimeState.value.modalState.disconnect=phase;return phase}
  static runWhenNetworkReady(action,onWaiting){
  if(typeof window.RallyNetcode?.createNostrSignaler==="function"){
    NetworkModuleLoader.networkLoadState="ready";
    action();
    return;
  }
  NetworkModuleLoader.pendingPeerAction=action;
  if(NetworkModuleLoader.networkLoadState==="error"){
    if(onWaiting)onWaiting(NetworkModuleLoader.networkLoadError||"URL 네트워크 모듈이 준비되지 않았습니다.",true);
    return;
  }
  if(onWaiting)onWaiting("네트워크 모듈을 준비하고 있습니다…",false);
}
}

UiRegistry.refs.p2pHealth?.addEventListener("click",e=>{
  e.preventDefault();
  e.stopPropagation();
  if(!UiRuntimeState.value.options.lockstepDebugOpen)ConnectionPresentation.openLockstepDebugPanel();
  else ConnectionPresentation.closeLockstepDebugPanel();
});
UiRegistry.refs.p2pHealth?.addEventListener("keydown",e=>{
  if(e.key==="Enter"||e.key===" "){
    e.preventDefault();
    if(!UiRuntimeState.value.options.lockstepDebugOpen)ConnectionPresentation.openLockstepDebugPanel();
    else ConnectionPresentation.closeLockstepDebugPanel();
  }
});
UiRegistry.refs.lockstepDebugCloseBtn?.addEventListener("click",ConnectionPresentation.closeLockstepDebugPanel);
UiRegistry.refs.manualRecoveryBtn?.addEventListener("click",e=>{
  e.preventDefault();
  RecoveryTelemetry.requestManualRecovery();
});
UiRegistry.refs.fullConnectionResetBtn?.addEventListener("click",e=>{
  e.preventDefault();
  ConnectionPresentation.requestFullConnectionResetFromUi();
});

const performanceBenchmark={
  running:false,
  async run(){
    if(this.running)return;
    const active=MatchLifecycle.activeSession?.();
    if(!active?.sim||UiRuntimeState.value.screen!=="game"){LogUtil.log("⚠ 게임 중에만 성능 벤치를 실행할 수 있습니다.");return}
    this.running=true;
    const btn=UiRegistry.refs.performanceBenchmarkBtn;
    if(btn){btn.disabled=true;btn.textContent="벤치 실행 중…"}
    const samples=[];
    const startedAt=new Date().toISOString();
    const startWall=performance.now();
    const durationMs=12000;
    const sampleEveryMs=100;
    let nextSample=startWall;
    try{
      LogUtil.log("성능 벤치 시작 · 12초 · 현재 유닛/실제 Host+Guest+WebGL 경로");
      while(performance.now()-startWall<durationMs){
        await new Promise(requestAnimationFrame);
        const now=performance.now();
        if(now<nextSample)continue;
        nextSample=now+sampleEveryMs;
        const sessions=SinglePlayerModeUtil.isSinglePlayer()?Object.values(MatchLifecycle.singleMatch?.sessions||{}):LocalEnvironmentUtil.isLocalTest()?Object.values(MatchLifecycle.localTest?.sessions||{}):[ActiveViewState.session].filter(Boolean);
        const sessionStats={};
        for(const sess of sessions){
          const p=sess?.sim?.perfStats||{};
          sessionStats[sess?.role||"unknown"]={
            tick:sess?.sim?.tick??null,
            units:sess?.sim?.units?.filter?.(u=>u?.alive!==false)?.length||0,
            projectiles:sess?.sim?.projectiles?.filter?.(x=>x?.alive!==false)?.length||0,
            stepMs:Number(p.totalMs)||0,
            stepEwmaMs:Number(p.ewmaStepMs)||0,
            stepMaxMs:Number(p.maxStepMs)||0,
            indexMs:Number(p.indexMs)||0,
            worldMs:Number(p.worldMs)||0,
            economyMs:Number(p.economyMs)||0,
            workerMs:Number(p.workerMs)||0,
            visionMs:Number(p.visionMs)||0,
            combatMs:Number(p.combatMs)||0,
            combatTargetPickMs:Number(p.combatTargetPickMs)||0,
            combatOtherMs:Number(p.combatOtherMs)||0,
            projectileMs:Number(p.projectileMs)||0,
            collisionMs:Number(p.collisionMs)||0,
            collisionDetails:{sampleTick:Number(p.sampleTick)||0,detailedSamples:Number(p.collisionSoftDetailedSamples)||0,
              gridCandidateVisits:Number(p.collisionPairs)||0,allySoftPasses:Number(p.collisionSoftPasses)||0,
              allySoftContacts:Number(p.collisionSoftContacts)||0,allySoftMovedUnits:Number(p.collisionSoftMovedUnits)||0,
              allySoftCappedUnits:Number(p.collisionSoftCappedUnits)||0,
              combatTargetPickMs:Number(p.combatTargetPickMs)||0,combatOtherMs:Number(p.combatOtherMs)||0,combatTargetPickCalls:Number(p.combatTargetPickCalls)||0,
              pairScanMs:Number(p.collisionPairScanMs)||0,softApplyMs:Number(p.collisionSoftApplyMs)||0,sweptMotionMs:Number(p.collisionSweptMotionMs)||0,
              terrainMs:Number(p.collisionTerrainMs)||0,finalSapMs:Number(p.collisionHardFixMs)||0,
              sweptCalls:Number(p.collisionSweptCalls)||0,sweptPasses:Number(p.collisionSweptActivePasses)||0,sweptPairTests:Number(p.collisionSweptPairTests)||0,
              sweptHits:Number(p.collisionSweptHits)||0,sweptCorrectionUnits:Number(p.collisionSweptCorrectionUnits)||0,sweptNoCorrectionPasses:Number(p.collisionSweptNoCorrectionPasses)||0,
              sweptZeroMotionCalls:Number(p.collisionSweptZeroMotionCalls)||0,sweptEmptyPasses:Number(p.collisionSweptEmptyPasses)||0,
              sapCalls:Number(p.collisionHardFixCalls)||0,sapPasses:Number(p.collisionHardFixPasses)||0,sapActivePairTests:Number(p.collisionHardFixActivePairTests)||0,
              sapCandidates:Number(p.collisionHardFixCandidates)||0,sapCorrections:Number(p.collisionHardFixCorrections)||0,sapNoOpCalls:Number(p.collisionHardFixNoOpCalls)||0},
            postMs:Number(p.postMs)||0,
            snapshotMs:Number(p.snapshotMs)||0,
            checksumMs:Number(p.checksumMs)||0
          };
        }
        const rp=ActiveViewState.renderer?.perfStats||{};
        samples.push({
          atMs:Math.round(now-startWall),
          frameMs:Number(rp.frameWorkMs)||0,
          frameEwmaMs:Number(rp.ewmaFrameWorkMs)||0,
          frameMaxMs:Number(rp.maxFrameWorkMs)||0,
          frameIntervalMs:Number(rp.frameIntervalMs)||0,
          fps:Number(rp.fps)||0,
          drawCalls:Number(rp.drawCalls)||0,
          uploadBytes:Number(rp.bufferUploadBytes)||0,
          vertexBufferGrows:Number(rp.vertexBufferGrows)||0,
          geometryTemplateHits:Number(rp.geometryTemplateHits)||0,
          unitBodyMeshCacheHits:Number(rp.unitBodyMeshCacheHits)||0,
          unitBodyMeshCacheMisses:Number(rp.unitBodyMeshCacheMisses)||0,
          unitBodyMeshCacheSize:Number(rp.unitBodyMeshCacheSize)||0,
          passes:rp.passes||null,
          sessions:sessionStats
        });
      }
      const nums=(path)=>{
        const out=[];
        for(const x of samples){let v=x;for(const k of path)v=v?.[k];if(Number.isFinite(v))out.push(v)}
        return out;
      };
      const summary=a=>{
        if(!a.length)return null;
        const b=a.slice().sort((x,y)=>x-y),avg=a.reduce((x,y)=>x+y,0)/a.length;
        return {avg:+avg.toFixed(3),p95:+b[Math.min(b.length-1,Math.floor(b.length*.95))].toFixed(3),max:+Math.max(...a).toFixed(3)};
      };
      const roles=[...new Set(samples.flatMap(x=>Object.keys(x.sessions||{})))];
      const roleSummary={};
      for(const r of roles){
        const collisionDetails=[...new Map(samples.map(x=>x.sessions?.[r]?.collisionDetails).filter(x=>x?.sampleTick).map(x=>[x.sampleTick,x])).values()];
        roleSummary[r]={
          stepMs:summary(nums(["sessions",r,"stepMs"])),
          combatMs:summary(nums(["sessions",r,"combatMs"])),
          collisionMs:summary(nums(["sessions",r,"collisionMs"])),
          collisionDetailedSamples:collisionDetails.length,
          alliedSoftPasses:collisionDetails.reduce((sum,x)=>sum+x.allySoftPasses,0),
          alliedSoftContacts:collisionDetails.reduce((sum,x)=>sum+x.allySoftContacts,0),
          alliedSoftMovedUnits:collisionDetails.reduce((sum,x)=>sum+x.allySoftMovedUnits,0),
          alliedSoftCappedUnits:collisionDetails.reduce((sum,x)=>sum+x.allySoftCappedUnits,0),
          collisionStagesMs:Object.fromEntries(["pairScanMs","softApplyMs","sweptMotionMs","terrainMs","finalSapMs"].map(key=>[key,summary(collisionDetails.map(x=>Number(x[key])).filter(Number.isFinite))])),
          combatTargetPickMs:summary(collisionDetails.map(x=>Number(x.combatTargetPickMs)).filter(Number.isFinite)),
          combatOtherMs:summary(collisionDetails.map(x=>Number(x.combatOtherMs)).filter(Number.isFinite)),
          targetPickCalls:collisionDetails.reduce((sum,x)=>sum+x.combatTargetPickCalls,0),
          sweptCalls:collisionDetails.reduce((sum,x)=>sum+x.sweptCalls,0),sweptActivePasses:collisionDetails.reduce((sum,x)=>sum+x.sweptPasses,0),
          sweptEmptyPasses:collisionDetails.reduce((sum,x)=>sum+x.sweptEmptyPasses,0),sweptZeroMotionCalls:collisionDetails.reduce((sum,x)=>sum+x.sweptZeroMotionCalls,0),
          sweptHits:collisionDetails.reduce((sum,x)=>sum+x.sweptHits,0),sweptCorrectionUnits:collisionDetails.reduce((sum,x)=>sum+x.sweptCorrectionUnits,0),sweptNoCorrectionPasses:collisionDetails.reduce((sum,x)=>sum+x.sweptNoCorrectionPasses,0),
          hardFixCalls:collisionDetails.reduce((sum,x)=>sum+x.sapCalls,0),hardFixPasses:collisionDetails.reduce((sum,x)=>sum+x.sapPasses,0),hardFixNoOpCalls:collisionDetails.reduce((sum,x)=>sum+x.sapNoOpCalls,0),
          hardFixPairTests:collisionDetails.reduce((sum,x)=>sum+x.sapActivePairTests,0),hardFixCandidates:collisionDetails.reduce((sum,x)=>sum+x.sapCandidates,0),hardFixCorrections:collisionDetails.reduce((sum,x)=>sum+x.sapCorrections,0),
          workerMs:summary(nums(["sessions",r,"workerMs"])),
          visionMs:summary(nums(["sessions",r,"visionMs"])),
          projectileMs:summary(nums(["sessions",r,"projectileMs"])),
          snapshotMs:summary(nums(["sessions",r,"snapshotMs"])),
          checksumMs:summary(nums(["sessions",r,"checksumMs"]))
        };
      }
      const payload={
        kind:"RALLY_FRONTIER_PERFORMANCE_BENCHMARK",
        build:BUILD_META.id,buildMetadata:BUILD_META.snapshot(),
        startedAt,
        durationMs:Math.round(performance.now()-startWall),
        mode:SinglePlayerModeUtil.isSinglePlayer()?"single":LocalEnvironmentUtil.isLocalTest()?"local-test":"p2p",
        tps:active.sim?.tps??null,
        sampleCount:samples.length,
        render:{
          fps:summary(nums(["fps"])),
          frameWorkMs:summary(nums(["frameMs"])),
          frameIntervalMs:summary(nums(["frameIntervalMs"])),
          drawCalls:summary(nums(["drawCalls"])),
          uploadBytes:summary(nums(["uploadBytes"])),
          passes:Object.fromEntries(["prepare","ground","shadow","world","overlay","ui-fx","camera-compose","minimap"].map(name=>[
            name,summary(samples.map(x=>Number(x.passes?.[name]?.ms)).filter(Number.isFinite))
          ]))
        },
        sessions:roleSummary,
        samples
      };
      const blob=new Blob([JSON.stringify(payload)],{type:"application/json"}),url=URL.createObjectURL(blob),a=document.createElement("a");
      a.href=url;a.download=`rally-frontier-performance-${Date.now()}.json`;document.body.appendChild(a);a.click();a.remove();
      setTimeout(()=>URL.revokeObjectURL(url),1000);
      LogUtil.log(`성능 벤치 완료 · ${samples.length} samples · JSON 저장`);
    }catch(err){
      LogUtil.log(`⚠ 성능 벤치 실패 · ${err?.message||err}`);
    }finally{
      this.running=false;
      if(btn){btn.disabled=false;btn.textContent="600 유닛 성능 벤치"}
    }
  }
};
UiRegistry.refs.performanceBenchmarkBtn?.addEventListener("click",e=>{e.preventDefault();performanceBenchmark.run()});

UiRegistry.refs.recoveryLogExportBtn?.addEventListener("click",e=>{
  e.preventDefault();
  RecoveryTelemetry.exportCorrectionFlightLog();
});
UiRegistry.refs.balanceTelemetryExportBtn?.addEventListener("click",e=>{
  e.preventDefault();
  PerformanceTelemetry.exportBalanceTelemetry();
});
UiRegistry.refs.synctestRunBtn?.addEventListener("click",()=>RallySynctestDiagnostics.request());
UiRegistry.refs.lockstepDebugResetBtn?.addEventListener("click",()=>{RallySynctestDiagnostics.clear(MatchLifecycle.activeSession?.());ConnectionPresentation.renderLockstepDebugPanel()});
UiRegistry.refs.performanceTimingExportBtn?.addEventListener('click',()=>PerformanceTelemetry.exportTimingTelemetry());
setInterval(()=>{
  if(UiRuntimeState.value.options.lockstepDebugOpen)ConnectionPresentation.renderLockstepDebugPanel();
},500);

class GraceTimeFormatUtil{
  static formatGraceTime(ms){
    const sec=Math.max(0,Math.ceil(ms/1000));
    return `${String(Math.floor(sec/60)).padStart(2,"0")}:${String(sec%60).padStart(2,"0")}`;
  }
}

class ReplayPresentation{
  static replayPlayer=null;
  static replayLoadedData=null;
  static replayTimelineDragging=false;
  static replayTimelineResumePlaying=null;
  static timeline=new RallyGamekit.ReplayTimeline({
    read:()=>({tick:ReplayPresentation.replayPlayer?.sim?.tick||0,firstTick:0,lastTick:ReplayPresentation.replayPlayer?.endTick||0,playing:!!ReplayPresentation.replayPlayer?.playing}),
    seek:tick=>ReplayPresentation.replayPlayer?.seek(tick),
    setPlaying:value=>ReplayPresentation.replayPlayer?.setPlaying(value)
  });

  static formatReplayTime(tick){
  const sec=Math.max(0,Math.floor((Number(tick)||0)/SimulationTiming.tps()));
  const m=Math.floor(sec/60),s=sec%60;
  return `${String(m).padStart(2,"0")}:${String(s).padStart(2,"0")}`;
}
  static replaySourceSession(){
  if(ReplayPresentation.replayPlayer)return null;
  const active=LocalEnvironmentUtil.isLocalTest()?MatchLifecycle.localTest?.sessions?.[ActiveViewState.role]:ActiveViewState.session;
  if(active?.replayRecorder?.result)return active;
  if(SinglePlayerModeUtil.isSinglePlayer()){
    if(MatchLifecycle.singleMatch?.sessions?.host?.replayRecorder?.result)return MatchLifecycle.singleMatch.sessions.host;
    if(MatchLifecycle.singleMatch?.sessions?.guest?.replayRecorder?.result)return MatchLifecycle.singleMatch.sessions.guest;
  }
  return active?.replayRecorder?active:null;
}
  static currentReplayPayload(){
  const sess=ReplayPresentation.replaySourceSession();
  if(!sess?.replayRecorder)return null;
  if(!sess.replayRecorder.result&&sess.simEnded)sess.replayRecorder.finalize(sess.matchResult?.winner||null,sess.sim,sess.matchResult?.reason||"base-destroyed");
  if(!sess.replayRecorder.result&&sess.sim)sess.replayRecorder.captureCheckpoint(sess.sim,true);
  const payload=sess.replayRecorder.payload(sess.simEnded?null:sess.sim);
  const saverRole=SinglePlayerModeUtil.isSinglePlayer()?(MatchLifecycle.singleMatch?.humanRole||ActiveViewState.role||"host"):(ActiveViewState.role||sess.role||"host");
  payload.savedByRole=saverRole==="guest"?"guest":"host";
  payload.defaultOrientationRole=payload.savedByRole;
  return payload;
}
  static downloadReplay(payload){
  if(!payload)return false;
  const blob=new Blob([JSON.stringify(payload)],{type:"application/json"});
  const url=URL.createObjectURL(blob),a=document.createElement("a");
  const stamp=new Date().toISOString().replace(/[:.]/g,"-");
  a.href=url;a.download=`rally-frontier-replay-${stamp}.json`;
  document.body.appendChild(a);a.click();a.remove();setTimeout(()=>URL.revokeObjectURL(url),1000);
  const state=payload.result?.reason==="in-progress"?" · 진행 중 저장본":"";
  LogUtil.log(`리플레이 저장 · ${payload.commands?.length||0}개 명령 · ${payload.checkpoints?.length||0}개 체크포인트${state}`);
  return true;
}
  static replayStatsHtml(snapshot,sim){
  if(!snapshot||!sim)return"";
  const card=side=>{
    const army=(snapshot.units||[]).filter(u=>u.alive&&u.side===side&&!UnitDefinition.get(u.type)?.economyWorker&&!UnitDefinition.get(u.type)?.carrierSummon).length;
    const workers=(snapshot.units||[]).filter(u=>u.alive&&u.side===side&&!!UnitDefinition.get(u.type)?.economyWorker).length;
    const buildings=(snapshot.buildings||[]).filter(b=>b.alive!==false&&b.side===side).length;
    const supply=sim.supplyUsed(side)+"/"+sim.supplyCap(side);
    return `<div class="replay-side-card ${side===0?"host":"guest"}"><div class="replay-side-name">${side===0?"HOST":"GUEST"}</div><div class="replay-side-line"><span>◆ 미네랄</span><b>${Math.floor(snapshot.wallet?.[side]||0)}</b></div><div class="replay-side-line"><span>⬡ 가스</span><b>${Math.floor(snapshot.gasWallet?.[side]||0)}</b></div><div class="replay-side-line"><span>▣ 보급</span><b>${supply}</b></div><div class="replay-side-line"><span>⚔ 병력 / ⚒ 일꾼</span><b>${army} / ${workers}</b></div><div class="replay-side-line"><span>⌂ 건물 · 테크</span><b>${buildings} · T${snapshot.tech?.[side]||1}</b></div></div>`;
  };
  return `<div class="replay-stats-title">REPLAY · 양측 현황</div><div class="replay-stats-grid">${card(0)}${card(1)}</div>`;
}
  static applyReplayPerspective({preserveCenter=false}={}){
  if(!ReplayPresentation.replayPlayer||!ActiveViewState.renderer)return;
  const viewMode=ReplayPresentation.replayPlayer.viewMode,orientation=ReplayPresentation.replayPlayer.orientationRole==="guest"?"guest":"host";
  const oldOrientation=ActiveViewState.renderer.orientationRole();
  const oldW=ActiveViewState.renderer.viewWorldW(),oldH=ActiveViewState.renderer.viewWorldH();
  let oldCenterX=ActiveViewState.renderer.cameraLeft+oldW/2,oldCenterY=ActiveViewState.renderer.cameraTop+oldH/2;
  if(preserveCenter&&oldOrientation!==orientation){oldCenterX=(ActiveViewState.renderer?.world||WorldContext.standard).width-oldCenterX;oldCenterY=(ActiveViewState.renderer?.world||WorldContext.standard).height-oldCenterY}
  ActiveViewState.role=orientation;
  ActiveViewState.renderer.role=orientation;
  ActiveViewState.renderer.replayOrientationRole=orientation;
  ActiveViewState.renderer.replayPerspectiveSide=ConnectionSideUtil.roleSide(orientation);
  ActiveViewState.renderer.replayVisionMode=viewMode==="all"?"union":viewMode;
  ActiveViewState.renderer.replayObserverAll=false;
  ActiveViewState.renderer.replayZoom=ReplayPresentation.replayPlayer.zoom||1;
  if(preserveCenter){
    const vw=ActiveViewState.renderer.viewWorldW(),vh=ActiveViewState.renderer.viewWorldH();
    ActiveViewState.renderer.cameraLeft=RangeUtil.clamp(oldCenterX-vw/2,0,Math.max(0,(ActiveViewState.renderer?.world||WorldContext.standard).width-vw));
    ActiveViewState.renderer.cameraTop=ActiveViewState.renderer.clampCameraTop(oldCenterY-vh/2);
  }
  if(ActiveViewState.minimap)ActiveViewState.minimap.renderer=ActiveViewState.renderer;
  UiRegistry.refs.replayHostViewBtn?.classList.toggle("active",viewMode==="host");
  UiRegistry.refs.replayGuestViewBtn?.classList.toggle("active",viewMode==="guest");
  UiRegistry.refs.replayAllViewBtn?.classList.toggle("active",viewMode==="all");
  UiRegistry.refs.replayHostOrientationBtn?.classList.toggle("active",orientation==="host");
  UiRegistry.refs.replayGuestOrientationBtn?.classList.toggle("active",orientation==="guest");
}
  static applyReplayZoom(value){
  if(!ReplayPresentation.replayPlayer||!ActiveViewState.renderer)return;

  // Replay zoom is camera presentation only. Transient gameplay/prediction
  // visuals must never be scaled or carried across replay zoom changes.
  ActiveViewState.renderer.buildPreview=null;
  ActiveViewState.renderer.spellPreview=null;
  ActiveViewState.renderer.pendingBuildGhosts=[];
  ActiveViewState.renderer.chargedSkillGesture=null;
  ActiveViewState.renderer.predictedFlag=null;
  ActiveViewState.renderer.selectedBuildingId=null;

  const oldW=ActiveViewState.renderer.viewWorldW(),oldH=ActiveViewState.renderer.viewWorldH();
  const centerX=ActiveViewState.renderer.cameraLeft+oldW/2,centerY=ActiveViewState.renderer.cameraTop+oldH/2;
  ActiveViewState.renderer.replayZoom=RangeUtil.clamp(Number(value)||1,.6,1.8);
  ReplayPresentation.centerReplayCamera(centerX,centerY);
}
  static centerReplayCamera(x,y){
  const renderer=ActiveViewState.renderer,vw=renderer.viewWorldW(),vh=renderer.viewWorldH();
  renderer.cameraLeft=RangeUtil.clamp(x-vw/2,0,Math.max(0,(renderer.world||WorldContext.standard).width-vw));
  renderer.cameraTop=renderer.clampCameraTop(y-vh/2);
  ActiveViewState.minimap?.draw();
}
  static renderReplaySnapshot(s){
  if(!ReplayPresentation.replayPlayer)return;
  UiController.setUiScreen("replay");
  ActiveViewState.snap=s;
  if(!ActiveViewState.renderer){
    ActiveViewState.renderer=new GLRenderer(UiRegistry.refs.canvas);
    ActiveViewState.renderer.cameraLeft=0;ActiveViewState.renderer.cameraTop=(ActiveViewState.renderer?.world||WorldContext.standard).height-VIEW_H;
    ActiveViewState.minimap=new MiniMap(UiRegistry.refs.minimapCanvas);
  }
  ReplayPresentation.applyReplayPerspective();
  ActiveViewState.renderer.buildPreview=null;
  ActiveViewState.renderer.spellPreview=null;
  ActiveViewState.renderer.pendingBuildGhosts=[];
  ActiveViewState.renderer.chargedSkillGesture=null;
  ActiveViewState.renderer.predictedFlag=null;
  ActiveViewState.renderer.selectedBuildingId=null;
  ActiveViewState.renderer.setSnapshot(s,{liveTargets:false});ActiveViewState.minimap?.set(ActiveViewState.renderer,s);
  const side=ConnectionSideUtil.roleSide(ReplayPresentation.replayPlayer.orientationRole||"host");
  UiRegistry.refs.minerals.textContent=Math.floor(s.wallet?.[side]||0);
  UiRegistry.refs.gas.textContent=Math.floor(s.gasWallet?.[side]||0);
  UiRegistry.refs.workers.textContent=(s.units||[]).filter(u=>u.alive&&u.side===side&&!!UnitDefinition.get(u.type)?.economyWorker).length;
  UiRegistry.refs.supply.textContent=`${ReplayPresentation.replayPlayer.sim.supplyUsed(side)}/${ReplayPresentation.replayPlayer.sim.supplyCap(side)}`;
  UiRegistry.refs.tier.textContent=`T${s.tech?.[side]||1}`;
  UiRegistry.refs.supplyChip?.classList.remove("supply-blocked");UiRegistry.refs.supplyWarning?.classList.add("hidden");
  audioSystem.processSnapshot(s,ActiveViewState.renderer);
  UiRegistry.refs.replayDock?.classList.remove("hidden");UiRegistry.refs.replayStats?.classList.remove("hidden");
  if(UiRegistry.refs.replayStats)UiRegistry.refs.replayStats.innerHTML=ReplayPresentation.replayStatsHtml(s,ReplayPresentation.replayPlayer.sim);
  UiRegistry.refs.net.textContent="리플레이 · 네트워크 시뮬레이션 없음";
  UiRegistry.refs.p2pHealth?.classList.add("hidden");
}
  static syncReplayControls(){
  if(!ReplayPresentation.replayPlayer)return;
  const tick=ReplayPresentation.replayPlayer.sim?.tick||0,end=ReplayPresentation.replayPlayer.endTick||0;
  if(UiRegistry.refs.replayTimeline){
    UiRegistry.refs.replayTimeline.max=String(Math.max(.1,end/SimulationTiming.tps()));
    if(!ReplayPresentation.replayTimelineDragging)UiRegistry.refs.replayTimeline.value=String(RangeUtil.clamp(tick/SimulationTiming.tps(),0,end/SimulationTiming.tps()||.1));
  }
  if(UiRegistry.refs.replayTime)UiRegistry.refs.replayTime.textContent=`${ReplayPresentation.formatReplayTime(tick)} / ${ReplayPresentation.formatReplayTime(end)}`;
  if(UiRegistry.refs.replayPlayPauseBtn)UiRegistry.refs.replayPlayPauseBtn.textContent=ReplayPresentation.replayPlayer.playing?"⏸ 일시정지":"▶ 재생";
  if(UiRegistry.refs.replaySpeed)UiRegistry.refs.replaySpeed.value=String(ReplayPresentation.replayPlayer.speed);
  if(UiRegistry.refs.replayZoomValue)UiRegistry.refs.replayZoomValue.textContent=`${Math.round((ReplayPresentation.replayPlayer.zoom||1)*100)}%`;
}
  static replayImportFailureMessage(error){
  const detail=String(error?.message||error||"");
  let reason="파일을 읽거나 검증하지 못했습니다. JSON 형식과 필수 데이터가 올바른지 확인하세요.";
  if(error instanceof SyntaxError||/json|unexpected token|unexpected end/i.test(detail))reason="JSON으로 읽을 수 없습니다. 파일이 잘렸거나 JSON 형식이 아닙니다.";
  else if(/version|sim_version|버전/i.test(detail))reason="다른 게임 버전에서 저장한 리플레이입니다. 현재 게임 버전과 맞는 파일을 선택하세요.";
  else if(/checksum|check.?point|체크포인트|체크섬/i.test(detail))reason="시작 상태 체크포인트 검증에 실패했습니다. 파일이 손상되었을 수 있습니다.";
  else if(/protocol|rally frontier|형식/i.test(detail))reason="지원하지 않는 형식입니다. RALLY FRONTIER에서 저장한 리플레이 JSON을 선택하세요.";
  else if(/command|payload|초기 상태|리플레이 데이터|손상/i.test(detail))reason="리플레이의 명령 기록이나 초기 상태가 없거나 손상되었습니다.";
  return `리플레이를 열지 못했습니다. ${reason} 현재 화면은 유지했습니다. 정상 파일을 선택해 다시 시도하세요.`;
}
  static showReplayImportError(error){
  const status=UiRegistry.refs.singleStatus;if(!status)return;
  status.textContent="";status.dataset.tone="error";status.setAttribute("role","alert");status.setAttribute("aria-live","assertive");
  UiController.setElementVisible(status,true);status.textContent=this.replayImportFailureMessage(error);
}
  static clearReplayImportError(){
  const status=UiRegistry.refs.singleStatus;if(!status)return;
  status.textContent="";delete status.dataset.tone;status.removeAttribute("role");status.setAttribute("aria-live","polite");
  UiController.setElementVisible(status,false);
}
  static startReplay(data,{onError=null}={}){
  let loadedData,player,snapshot;
  try{
    ReplayPolicy.validateReplayPayload(data);
    loadedData=CloneUtil.clone(data);
    player=new ReplayPlayer(loadedData);
    snapshot=player.sim.snapshot();
  }catch(e){player?.stop();LogUtil.log(`⚠ 리플레이 열기 실패 · ${e.message||e}`);onError?.(e);return false}
  CampaignPresentation.clear();CampaignRuntime.clear();
  MatchLifecycle.disposeMatches("replay-start");
  ReplayPresentation.replayPlayer?.stop();
  ReplayPresentation.replayLoadedData=loadedData;
  ReplayPresentation.replayPlayer=player;
  UiRuntimeState.value.target={type:"flag"};UiRuntimeState.value.selection.buildingId=null;UiRuntimeState.value.selection.unit=null;
  UiController.setUiCommand({branch:"closed",page:null});
  if(UiRuntimeState.value.modal==="spell-choice")UiController.closeUiModal("spell-choice");SpellPresentation.setSpellChoicePhase("idle");
  UiController.invalidatePanelHtmlCaches({unit:true,reinforcement:true});
  if(ActiveViewState.renderer){
    ActiveViewState.renderer.pendingBuildGhosts=[];ActiveViewState.renderer.predictedFlag=null;ActiveViewState.renderer.latencySpellFx=[];ActiveViewState.renderer.buildPreview=null;ActiveViewState.renderer.spellPreview=null;ActiveViewState.renderer.chargedSkillGesture=null;
  }
  UiController.closeUiModal("create");UiController.closeUiModal("join");
  
  ReplayPresentation.renderReplaySnapshot(snapshot);
  ReplayPresentation.applyReplayPerspective();ReplayPresentation.syncReplayControls();
  ReplayPresentation.replayPlayer.start();
  UiRegistry.refs.log.style.removeProperty("display");
  LogUtil.log(`▶ 리플레이 시작 · ${ReplayPresentation.formatReplayTime(ReplayPresentation.replayPlayer.endTick)} · 명령 ${data.commands.length}개`);
  return true;
}
  static stopReplay(){
  ReplayPresentation.replayPlayer?.stop();ReplayPresentation.replayPlayer=null;ReplayPresentation.replayLoadedData=null;
  UiController.setUiScreen("lobby");
  location.reload();
}
}

class LogUtil{static log(t){UiRegistry.refs.log.textContent=t}}
class RoomCodeUtil{static randomCode(){return String(Math.floor(Math.random()*10000)).padStart(4,"0")}}
class LocalEnvironmentUtil{static isLocalTest(){return !!MatchLifecycle.localTest}}
class SinglePlayerModeUtil{static isSinglePlayer(){return !!MatchLifecycle.singleMatch}}

const DEBUG_BATTLE_TIMELINE_MS=600000;
class DebugScenarioHarness{
  static pending=null;
  static unitOptions(){
    return Object.entries(UnitDefinition.all)
      .filter(([id,d])=>d&&d.tier>=1&&d.tier<=3&&!d.economyWorker&&!d.carrierSummon)
      .sort((a,b)=>(a[1].tier-b[1].tier)||String(a[1].name||a[0]).localeCompare(String(b[1].name||b[0])));
  }
  static normalize(raw){
    const valid=new Set(this.unitOptions().map(([id])=>id));
    const allyType=valid.has(raw?.allyType)?raw.allyType:"swarmbug";
    const enemyType=valid.has(raw?.enemyType)?raw.enemyType:"shelltitan";
    const testMode=raw?.testMode==="mobile-battle";
    const totalUnits=testMode&&[100,200,400].includes(Number(raw?.totalUnits))?Number(raw.totalUnits):100;
    const composition=testMode&&["melee","ranged","mixed"].includes(raw?.composition)?raw.composition:"mixed";
    const requestedSeed=Number(raw?.fixedSeed),fixedSeed=testMode&&Number.isFinite(requestedSeed)?Math.trunc(RangeUtil.clamp(requestedSeed,0,0xffffffff))>>>0:20261015;
    const sampleSeconds=testMode&&[10,15,30].includes(Number(raw?.sampleSeconds))?Number(raw.sampleSeconds):15;
    return{kind:"unit-combat",testMode:testMode?"mobile-battle":null,composition:testMode?composition:"single",fixedSeed:testMode?fixedSeed:null,totalUnits:testMode?totalUnits:null,warmupSeconds:testMode?5:null,sampleSeconds:testMode?sampleSeconds:null,allyType,enemyType,allyCount:testMode?totalUnits/2:RangeUtil.clamp(Math.round(Number(raw?.allyCount)||10),1,60),enemyCount:testMode?totalUnits/2:RangeUtil.clamp(Math.round(Number(raw?.enemyCount)||5),1,60),research:raw?.research!==false,humanRole:raw?.humanRole==="host"?"host":"guest"};
  }
  static unitRoster(config,side){
    const humanSide=config?.humanRole==="host"?0:1;
    if(config?.testMode==="mobile-battle"){
      if(config.composition==="melee")return["swordsman"];
      if(config.composition==="ranged")return["archer"];
      return["swordsman","archer"];
    }
    return[side===humanSide?config?.allyType:config?.enemyType].filter(Boolean);
  }
  static liveDraft(cfg,roomCode){
    const draft={
      phase:"live",roomCode,
      decks:{host:[],guest:[]},defenseCards:{host:[],guest:[]},
      winner:null
    };
    for(const role of ["host","guest"])draft.decks[role]=this.unitRoster(cfg,role==="host"?0:1);
    return draft;
  }
  // The debug scene starts from the same match factory as a real debug match and plays it
  // through the real replay player, so only the network is absent.
  static openReplayBattle({seed,allyType,enemyType,allyCount,enemyCount,commands=null}){
    const valid=new Set(this.unitOptions().map(([id])=>id));
    for(const type of [allyType,enemyType])if(!valid.has(type))throw new Error(`battle needs a combat unit type: ${type}`);
    for(const count of [allyCount,enemyCount])if(!Number.isInteger(count)||count<1||count>60)throw new Error(`battle needs a unit count from 1 to 60: ${count}`);
    const cfg=this.normalize({allyType,enemyType,allyCount,enemyCount,humanRole:"host"});
    const draft=this.liveDraft(cfg,null),sim=StrategySim.createForMatch({draft,seed,debugScenario:cfg});
    const recorder=new ReplayRecorder({seed,draft,roomCode:null,sim});
    // A scene may script host commands from the spawned state; they replay like recorded commits.
    const scripted=(commands?.(sim)||[]).map((c,i)=>({type:"RUNTIME_COMMIT",seq:i+1,tick:c.tick,actor:"host",action:c.action,proposalId:null,authorityTick:null}));
    const fighters=sim.units.filter(u=>u.side===0&&u.type===allyType||u.side===1&&u.type===enemyType);
    const focusX=fighters.reduce((a,u)=>a+u.x,0)/fighters.length,focusY=fighters.reduce((a,u)=>a+u.y,0)/fighters.length;
    sim.dispose("debug-scene-recorded");
    // The scene has no recorded end; stepping past this timeline fails instead of stretching it.
    const payload={...recorder.payload(),commands:scripted,result:{winner:null,reason:"debug-scene",endTick:SimulationTiming.msToTicks(DEBUG_BATTLE_TIMELINE_MS,sim.tps),checksum:null}};
    if(!ReplayPresentation.startReplay(payload))throw new Error("battle replay failed to start");
    const player=ReplayPresentation.replayPlayer;
    player.setPlaying(false);
    ReplayPresentation.centerReplayCamera(focusX,focusY);
    return player;
  }
  static openChargeReplay({seed,unitType,enemyType,count,enemyCount}){
    if(!UnitDefinition.get(unitType)?.chargedSkill)throw new Error(`charge needs a charged-skill unit type: ${unitType}`);
    // Hold on the own group, aim at the enemy group once gathered, release at full charge:
    // the same commands the battlefield gesture submits.
    return this.openReplayBattle({seed,allyType:unitType,enemyType,allyCount:count,enemyCount,commands:sim=>{
      const centroid=(side,type)=>{const list=sim.units.filter(u=>u.side===side&&u.type===type);return{x:list.reduce((a,u)=>a+u.x,0)/list.length,y:list.reduce((a,u)=>a+u.y,0)/list.length}};
      const own=centroid(0,unitType),foe=centroid(1,enemyType),castId=1,begin=1;
      const aim=begin+sim.msTicks(ChargedSkillGeometry.gatherMs),release=begin+sim.msTicks(ChargedSkillGeometry.gatherMs+ChargedSkillGeometry.chargeMs);
      return [
        {tick:begin,action:{type:"CHARGE_BEGIN",castId,x:own.x,y:own.y}},
        {tick:aim,action:{type:"CHARGE_AIM",castId,x:foe.x,y:foe.y}},
        {tick:release,action:{type:"CHARGE_RELEASE",castId,x:foe.x,y:foe.y}}
      ];
    }});
  }
  // Address settings (src/ui/dev-query.js) checked against the playable units; a typo fails instead of falling back.
  static fromQuery(params){
    const valid=new Set(this.unitOptions().map(([id])=>id));
    for(const key of ["allyType","enemyType"])if(params[key]!=null&&!valid.has(params[key]))throw new Error(`Unknown unit for ${key}: ${params[key]}`);
    return this.normalize(params);
  }
}

class MobileBattleTestMode{
  static phase="idle";static config=null;static report=null;static frameHandle=0;static phaseStartedAt=0;static connectStartedAt=0;static lastFrameAt=0;static lastHudAt=0;
  static paused=false;static pausedAt=0;static sampleStartedAt=0;static sampleCount=0;static overflowFrames=0;static capacity=16384;
  static vectorFlushReasonMetricKeys=Object.freeze({
    "frame-to-vector-switch":"vectorFlushFrameToVectorSwitch","air-transient-effects":"vectorFlushAirTransientEffects",
    "vector-to-frame-painter-switch":"vectorFlushVectorToFramePainterSwitch","world-pass-end":"vectorFlushWorldPassEnd",
    explicit:"vectorFlushExplicit",mesh:"vectorFlushMesh",indexVariant:"vectorFlushIndexVariant",clip:"vectorFlushClip",stencil:"vectorFlushStencil",
    depthState:"vectorFlushDepthState",projection:"vectorFlushProjection",strokeViewport:"vectorFlushStrokeViewport",parts:"vectorFlushParts",capacity:"vectorFlushCapacity",
    alphaDepthBoundary:"vectorFlushAlphaDepthBoundary",alphaOverlap:"vectorFlushAlphaOverlap",alphaSignature:"vectorFlushAlphaSignature",
    alphaUnsupportedBoundary:"vectorFlushAlphaUnsupportedBoundary",alphaImmediateBoundary:"vectorFlushAlphaImmediateBoundary"
  });
  static vectorFlushDiagnosticsAvailable=false;static vectorSafeAlphaRunBatching=null;static sampleVectorDiagnostics=[];
  static sampleMetricKeys=Object.freeze(["rendererFrameSequence","frameIntervalMs","frameWindowMs","rendererCpuWorkMs","drawCalls","vectorAssetDrawCalls","vectorAssetDraws","bufferUploadBytes","vectorAssetGeometryBytes","vectorAssetInstanceBytes","alphaRunCacheHits","alphaRunCacheMisses","vectorGeometryUploads","partUniformBytesSubmitted","vectorStagingBytes","vectorInstances","vectorFlushEvents","vectorAlphaRunDrawCalls","vectorAlphaRunSafeBatches","vectorAlphaRunBatchedInstances","vectorAlphaRunDrawsSaved","vectorAlphaRunSafeRunDraws","vectorAlphaRunImmediateRunDraws","vectorAlphaRunOverlapBoundaries","vectorAlphaRunSignatureBoundaries","vectorAlphaRunUnbatchableBounds","vectorAlphaRunImmediateInstances",...Object.values(this.vectorFlushReasonMetricKeys),"hostStepCpuMs","hostStepCount","hostSnapshotCpuMs","hostSnapshotCount","hostSnapshotUiCpuMs","hostSnapshotUiCount","hostSessionPulseCpuMs","hostSessionPulseCount","guestStepCpuMs","guestStepCount","guestSnapshotCpuMs","guestSnapshotCount","guestSnapshotUiCpuMs","guestSnapshotUiCount","guestSessionPulseCpuMs","guestSessionPulseCount","unattributedElapsedMs"]);
  static sampleBuffers=Object.create(null);static lastCapturedRendererFrameSequence=0;static sampleFrameWindowStartedAt=0;
  static peerSamples={host:[],guest:[]};static peerSampleTicks={host:0,guest:0};static peerSnapshotBaseline={};static peerFrameBaseline={};static peerStepSampleCounts={host:0,guest:0};static peerStepSampleCountsAtStart={host:0,guest:0};static peerMaxStepMs={host:0,guest:0};
  static visibilityStats={visibilityStateAtStart:"visible",visibilityStateAtSampleStart:null,hiddenEvents:0,unpausedHiddenEvents:0,hiddenWhilePausedEvents:0,pagehideEvents:0,invalidated:false};
  static lastSampleState=null;static sampleStartState=null;static lastIntervalMs=0;static savedSettings=null;
  static savedCampaignPending=null;static savedDebugPending=null;
  static ref(id){return document.getElementById(id)}
  static bindUi(){
    this.ref("battleTestPauseBtn")?.addEventListener("click",()=>this.paused?this.resume():this.pause());
    this.ref("battleTestResetBtn")?.addEventListener("click",()=>this.reset());
    this.ref("battleTestExitBtn")?.addEventListener("click",()=>this.exit());
    this.ref("battleTestCopyBtn")?.addEventListener("click",()=>this.copyReport());
    this.ref("battleTestDownloadBtn")?.addEventListener("click",()=>this.downloadReport());
    document.addEventListener("visibilitychange",()=>this.onVisibilityChange());
    window.addEventListener("pagehide",()=>this.onPageHide());
  }
  static beginRun(){
    this.vectorFlushDiagnosticsAvailable=false;this.vectorSafeAlphaRunBatching=null;
    this.phase="connecting";this.paused=false;this.pausedAt=0;this.report=null;this.connectStartedAt=performance.now();this.phaseStartedAt=0;this.sampleStartedAt=0;this.lastFrameAt=0;this.lastHudAt=0;this.lastSampleState=null;this.sampleStartState=null;this.sampleCount=0;this.overflowFrames=0;this.lastIntervalMs=0;
    this.resetCopyFallback();
    this.sampleBuffers=Object.fromEntries(this.sampleMetricKeys.map(key=>[key,new Float32Array(this.capacity)]));this.sampleVectorDiagnostics=new Array(this.capacity);this.lastCapturedRendererFrameSequence=0;this.sampleFrameWindowStartedAt=0;
    this.peerSamples={host:[],guest:[]};this.peerSampleTicks={host:0,guest:0};this.peerSnapshotBaseline={};this.peerFrameBaseline={};this.peerStepSampleCounts={host:0,guest:0};this.peerStepSampleCountsAtStart={host:0,guest:0};this.peerMaxStepMs={host:0,guest:0};
    this.visibilityStats={visibilityStateAtStart:document.visibilityState||"unknown",visibilityStateAtSampleStart:null,hiddenEvents:0,unpausedHiddenEvents:0,hiddenWhilePausedEvents:0,pagehideEvents:0,invalidated:false};
  }
  static activePhase(){return["connecting","warmup","sampling"].includes(this.phase)}
  static onVisibilityChange(){
    if(document.visibilityState==="visible"||!this.activePhase())return;
    if(this.paused){this.visibilityStats.hiddenEvents++;this.visibilityStats.hiddenWhilePausedEvents++;return}
    this.invalidateForVisibility("앱이 백그라운드로 전환되어 측정을 무효화했습니다. 화면을 켜 둔 상태에서 다시 시작하세요.",true);
  }
  static onPageHide(){
    if(!this.activePhase())return;
    this.visibilityStats.pagehideEvents++;
    if(this.paused)return;
    this.invalidateForVisibility("페이지가 숨겨지거나 닫혀 측정을 무효화했습니다. 다시 시작하세요.",true);
  }
  static invalidateForVisibility(message,countHidden){
    if(this.visibilityStats.invalidated)return;
    this.visibilityStats.invalidated=true;if(countHidden)this.visibilityStats.unpausedHiddenEvents++;
    this.fail(message,true);
  }
  static beginSampling(now,live){
    this.phase="sampling";this.phaseStartedAt=now;this.sampleStartedAt=now;this.sampleCount=0;this.overflowFrames=0;
    this.sampleFrameWindowStartedAt=now;
    this.sampleStartState=this.stateSnapshot(live);this.lastSampleState=this.sampleStartState;
    this.visibilityStats.visibilityStateAtSampleStart=document.visibilityState||"unknown";
    this.lastCapturedRendererFrameSequence=Number(live.renderer?.perfStats?.frameSequence)||0;
    const match=live.match;
    for(const role of ["host","guest"]){
      const session=match.sessions?.[role],sim=session?.sim,perf=sim?.perfStats||{},timings=session?.performanceStats?.timings||{};
      const pulse=timings.pulse||{},snapshotUi=timings.snapshotUi||{};
      this.peerSampleTicks[role]=Number(perf.sampleTick)||0;
      this.peerStepSampleCounts[role]=Number(perf.stepSamples)||0;this.peerStepSampleCountsAtStart[role]=Number(perf.stepSamples)||0;this.peerMaxStepMs[role]=0;
      const stepCount=Number(perf.stepSamples)||0,stepCpuMs=Number(perf.stepCumulativeMs)||0,snapshotCount=Number(perf.snapshotSamples)||0,snapshotCpuMs=Number(perf.snapshotCumulativeMs)||0;
      const pulseCount=Number(pulse.samples)||0,pulseCpuMs=Number(pulse.cumulativeMs)||0,snapshotUiCount=Number(snapshotUi.samples)||0,snapshotUiCpuMs=Number(snapshotUi.cumulativeMs)||0;
      this.peerSnapshotBaseline[role]={count:snapshotCount,totalMs:snapshotCpuMs,stepCount,stepTotalMs:stepCpuMs,pulseCount,pulseTotalMs:pulseCpuMs,snapshotUiCount,snapshotUiTotalMs:snapshotUiCpuMs};
      this.peerFrameBaseline[role]={session,sim,stepCount,stepCpuMs,snapshotCount,snapshotCpuMs,pulseCount,pulseCpuMs,snapshotUiCount,snapshotUiCpuMs};
    }
    const stats=live.renderer?.vectorContext?.stats?.().mesh;
    this.vectorFlushDiagnosticsAvailable=!!stats&&!!stats.flushReasons&&!!stats.drawDispatchReasons&&typeof stats.safeAlphaRunBatching==="boolean";
    this.vectorSafeAlphaRunBatching=this.vectorFlushDiagnosticsAvailable?stats.safeAlphaRunBatching:null;
  }
  static start(params){
    if(!["idle","stopped"].includes(this.phase))return;
    this.config=DebugScenarioHarness.normalize({testMode:"mobile-battle",...params,humanRole:"host",research:false});this.savedSettings={presetId:UiRuntimeState.value.settings.presetId,simulationTps:UiRuntimeState.value.settings.simulationTps,netcodeMode:CONFIG.netcode.mode};
    this.savedCampaignPending=CampaignRuntime.pending;this.savedDebugPending=DebugScenarioHarness.pending;
    DebugScenarioHarness.pending=this.config;CampaignRuntime.pending=null;CampaignPresentation.clear();this.beginRun();
    document.body.classList.add("battle-test-mode");
    const hud=this.ref("battleTestHud");if(hud&&hud.parentElement!==document.body)document.body.appendChild(hud);hud?.classList.remove("hidden");
    UiRuntimeState.value.settings.presetId="standard";UiController.setStartSimulationTps(10);UiController.setStartNetcodeMode("lockstep");
    audioSystem.unlock();this.renderHud();
    try{MatchLifecycle.startSinglePlayerWebRTC("host");this.scheduleFrame()}
    catch(error){this.fail(`매치 시작 실패: ${String(error?.message||error)}`)}
  }
  static liveState(){
    const match=MatchLifecycle.singleMatch;if(!match)return null;
    const session=match.sessions?.[match.humanRole],peer=match.sessions?.[match.botRole],sim=session?.sim;
    if(UiRuntimeState.value.screen!=="game"||!sim||!peer?.sim||!session?.netcodeSession?.ready||!peer.netcodeSession?.ready)return null;
    return{match,session,peer,sim,renderer:ActiveViewState.renderer};
  }
  static readCounts(sim){
    let total=0,host=0,guest=0,workers=0;
    for(const unit of sim?.units||[]){if(!unit||unit.alive===false||unit.hp<=0||(unit.side!==0&&unit.side!==1))continue;total++;if(unit.side===0)host++;else guest++;if(UnitDefinition.get(unit.type)?.economyWorker)workers++}
    return{total,host,guest,workers};
  }
  static stateSnapshot(live){
    const counts=this.readCounts(live?.sim);
    return{tick:live?.session?.sim?.tick??null,peerTick:live?.peer?.sim?.tick??null,units:counts};
  }
  static scheduleFrame(){
    if(this.frameHandle||this.paused||!["connecting","warmup","sampling"].includes(this.phase))return;
    if(document.visibilityState!=="visible"){this.invalidateForVisibility("앱이 백그라운드로 전환되어 측정을 무효화했습니다. 화면을 켜 둔 상태에서 다시 시작하세요.",true);return}
    this.frameHandle=requestAnimationFrame(timestamp=>{this.frameHandle=0;this.frame(timestamp);this.scheduleFrame()});
  }
  static frame(timestamp){
    const now=Number.isFinite(timestamp)?timestamp:performance.now();
    if(this.activePhase()&&!this.paused&&document.visibilityState!=="visible"){
      this.invalidateForVisibility("앱이 백그라운드로 전환되어 측정을 무효화했습니다. 화면을 켜 둔 상태에서 다시 시작하세요.",true);return;
    }
    if(this.phase==="connecting"){
      const live=this.liveState();
      if(live){this.phase="warmup";this.phaseStartedAt=now;this.lastFrameAt=now;this.lastSampleState=this.stateSnapshot(live);this.renderHud(now)}
      else if(now-this.connectStartedAt>30000)this.fail("매치 연결 시간이 초과됐습니다. 종료 후 다시 시작하세요.");
      if(this.phase==="connecting"&&now-this.lastHudAt>500){this.lastHudAt=now;this.renderHud(now)}
      return;
    }
    if(this.paused)return;
    if(UiRuntimeState.value.screen==="result"){
      if(this.phase==="sampling")this.finishSample(now,true);else this.fail("측정 구간 전에 매치가 종료됐습니다.");
      return;
    }
    const live=this.liveState();
    if(!live){if(this.phase==="sampling")this.finishSample(now,true);return}
    if(this.phase==="warmup"&&now-this.phaseStartedAt>=this.config.warmupSeconds*1000){
      this.beginSampling(now,live);this.renderHud(now);return;
    }
    if(this.phase==="sampling"){
      if(now-this.phaseStartedAt>=this.config.sampleSeconds*1000){this.finishSample(now,false);return}
    }
    if(now-this.lastHudAt>=1000){this.lastHudAt=now;this.lastSampleState=this.stateSnapshot(live);this.renderHud(now)}
  }
  static captureRendererFrame(frameEnded,rp){
    if(this.phase!=="sampling"||this.paused)return;
    if(document.visibilityState!=="visible"){
      this.invalidateForVisibility("앱이 백그라운드로 전환되어 측정을 무효화했습니다. 화면을 켜 둔 상태에서 다시 시작하세요.",true);return;
    }
    const sequence=Number(rp.frameSequence)||0;
    if(sequence&&sequence<=this.lastCapturedRendererFrameSequence)return;
    if(sequence)this.lastCapturedRendererFrameSequence=sequence;
    this.lastIntervalMs=Number(rp.frameIntervalMs)||0;
    const sampleIndex=this.sampleCount,storeSample=sampleIndex<this.capacity;
    const windowStartedAt=Number(this.sampleFrameWindowStartedAt)||this.sampleStartedAt||frameEnded;
    const frameWindowMs=Math.max(0,frameEnded-windowStartedAt);
    if(storeSample){
      const flush=rp.vectorFlushDiagnostics,flushReasons=flush?.flushReasons||null;
      const sumCounts=counts=>counts?Object.values(counts).reduce((sum,count)=>sum+(Number(count)||0),0):NaN;
      const values={frameIntervalMs:rp.frameIntervalMs,frameWindowMs,rendererCpuWorkMs:rp.frameWorkMs,drawCalls:rp.drawCalls,vectorAssetDrawCalls:rp.vectorAssetDrawCalls,
        vectorAssetDraws:rp.vectorAssetDraws,bufferUploadBytes:rp.bufferUploadBytes,vectorAssetGeometryBytes:rp.vectorAssetGeometryBytes,vectorAssetInstanceBytes:rp.vectorAssetInstanceBytes,
        alphaRunCacheHits:rp.vectorAlphaRunCacheHits,alphaRunCacheMisses:rp.vectorAlphaRunCacheMisses,vectorGeometryUploads:rp.vectorGeometryUploads,
        partUniformBytesSubmitted:rp.vectorPartUniformBytesSubmitted,vectorStagingBytes:rp.vectorStagingBytes,vectorInstances:rp.vectorAssetInstances,
        rendererFrameSequence:sequence,vectorFlushEvents:sumCounts(flushReasons),
        vectorAlphaRunDrawCalls:flush?(Number(flush.alphaRunSafeRunDraws)||0)+(Number(flush.alphaRunImmediateRunDraws)||0):NaN,
        vectorAlphaRunSafeBatches:flush?.alphaRunSafeBatches,vectorAlphaRunBatchedInstances:flush?.alphaRunBatchedInstances,vectorAlphaRunDrawsSaved:flush?.alphaRunDrawsSaved,
        vectorAlphaRunSafeRunDraws:flush?.alphaRunSafeRunDraws,vectorAlphaRunImmediateRunDraws:flush?.alphaRunImmediateRunDraws,
        vectorAlphaRunOverlapBoundaries:flush?.alphaRunOverlapBoundaries,vectorAlphaRunSignatureBoundaries:flush?.alphaRunSignatureBoundaries,
        vectorAlphaRunUnbatchableBounds:flush?.alphaRunUnbatchableBounds,vectorAlphaRunImmediateInstances:flush?.alphaRunImmediateInstances};
      for(const [reason,key] of Object.entries(this.vectorFlushReasonMetricKeys))values[key]=flush?Number(flushReasons?.[reason])||0:NaN;
      for(const key of this.sampleMetricKeys){const value=Number(values[key]);this.sampleBuffers[key][sampleIndex]=Number.isFinite(value)?value:NaN}
      this.sampleVectorDiagnostics[sampleIndex]=flush?{safeAlphaRunBatching:flush.safeAlphaRunBatching,flushReasons:{...flush.flushReasons},drawDispatchReasons:{...flush.drawDispatchReasons}}:null;
    }
    const match=MatchLifecycle.singleMatch;
    this.capturePeerFrameMetrics(match,sampleIndex,storeSample,frameWindowMs,Number(rp.frameWorkMs));
    if(match?.sessions)this.capturePeerSimulation(match);
    this.sampleFrameWindowStartedAt=frameEnded;
    if(storeSample)this.sampleCount++;else this.overflowFrames++;
  }
  static capturePeerFrameMetrics(match,index,storeSample,frameWindowMs,rendererCpuWorkMs){
    let pulseCpuMs=0,accountingComplete=true;
    const delta=(current,previous)=>Number.isFinite(current)&&Number.isFinite(previous)&&current>=previous?current-previous:NaN;
    const write=(key,value)=>{if(storeSample)this.sampleBuffers[key][index]=Number.isFinite(value)?value:NaN};
    for(const role of ["host","guest"]){
      const session=match?.sessions?.[role],sim=session?.sim,perf=sim?.perfStats,timings=session?.performanceStats?.timings||{},pulse=timings.pulse||{},snapshotUi=timings.snapshotUi||{};
      const prefix=role==="host"?"host":"guest",previous=this.peerFrameBaseline[role];
      const stepCount=Number(perf?.stepSamples),stepCpuMs=Number(perf?.stepCumulativeMs),snapshotCount=Number(perf?.snapshotSamples),snapshotCpuMs=Number(perf?.snapshotCumulativeMs);
      const pulseCount=Number(pulse.samples),sessionPulseCpuMs=Number(pulse.cumulativeMs),snapshotUiCount=Number(snapshotUi.samples),snapshotUiCpuMs=Number(snapshotUi.cumulativeMs);
      if(!session||!sim||!perf||!previous||previous.session!==session||previous.sim!==sim){
        for(const key of ["StepCpuMs","StepCount","SnapshotCpuMs","SnapshotCount","SnapshotUiCpuMs","SnapshotUiCount","SessionPulseCpuMs","SessionPulseCount"])write(prefix+key,NaN);
        if(session&&sim&&perf)this.peerFrameBaseline[role]={session,sim,stepCount,stepCpuMs,snapshotCount,snapshotCpuMs,pulseCount,sessionPulseCpuMs,snapshotUiCount,snapshotUiCpuMs};
        else this.peerFrameBaseline[role]=null;
        accountingComplete=false;
        continue;
      }
      const stepCpuDelta=delta(stepCpuMs,previous.stepCpuMs),pulseCpuDelta=delta(sessionPulseCpuMs,previous.sessionPulseCpuMs);
      write(prefix+"StepCpuMs",stepCpuDelta);write(prefix+"StepCount",delta(stepCount,previous.stepCount));
      write(prefix+"SnapshotCpuMs",delta(snapshotCpuMs,previous.snapshotCpuMs));write(prefix+"SnapshotCount",delta(snapshotCount,previous.snapshotCount));
      write(prefix+"SnapshotUiCpuMs",delta(snapshotUiCpuMs,previous.snapshotUiCpuMs));write(prefix+"SnapshotUiCount",delta(snapshotUiCount,previous.snapshotUiCount));
      write(prefix+"SessionPulseCpuMs",pulseCpuDelta);write(prefix+"SessionPulseCount",delta(pulseCount,previous.pulseCount));
      if(Number.isFinite(pulseCpuDelta))pulseCpuMs+=pulseCpuDelta;else accountingComplete=false;
      previous.stepCount=stepCount;previous.stepCpuMs=stepCpuMs;previous.snapshotCount=snapshotCount;previous.snapshotCpuMs=snapshotCpuMs;
      previous.pulseCount=pulseCount;previous.sessionPulseCpuMs=sessionPulseCpuMs;previous.snapshotUiCount=snapshotUiCount;previous.snapshotUiCpuMs=snapshotUiCpuMs;
    }
    write("frameWindowMs",frameWindowMs);
    write("unattributedElapsedMs",accountingComplete&&Number.isFinite(rendererCpuWorkMs)?frameWindowMs-rendererCpuWorkMs-pulseCpuMs:NaN);
  }
  static capturePeerSimulation(match){
    const stageKeys=["totalMs","indexMs","worldMs","economyMs","workerMs","visionMs","combatMs","combatTargetPickMs","projectileMs","collisionMs","collisionPrepMs","collisionGridBuildMs","collisionPairScanMs","collisionSoftApplyMs","collisionSweptMotionMs","collisionTerrainMs","collisionHardFixMs","collisionOtherMs","postMs"];
    const counterKeys=["spatialQueries","spatialCandidates","targetQueries","collisionPairs","collisionOverlaps","collisionSoftPasses","collisionSoftContacts","collisionSoftMovedUnits","collisionSoftCappedUnits","collisionSweptCalls","collisionSweptActivePasses","collisionHardFixCalls","collisionHardFixPasses","collisionHardFixCorrections","combatTargetPickCalls","aliveUnits","workers","projectiles"];
    for(const role of ["host","guest"]){
      const perf=match.sessions?.[role]?.sim?.perfStats;if(!perf)continue;
      const stepSamples=Number(perf.stepSamples)||0;
      if(stepSamples>this.peerStepSampleCounts[role])this.peerMaxStepMs[role]=Math.max(this.peerMaxStepMs[role],Number(perf.lastStepMs)||0);
      this.peerStepSampleCounts[role]=stepSamples;
      const sampleTick=Number(perf.sampleTick)||0;
      if(sampleTick<=this.peerSampleTicks[role])continue;
      this.peerSampleTicks[role]=sampleTick;
      const project=keys=>Object.fromEntries(keys.map(key=>[key,Number.isFinite(Number(perf[key]))?Number(perf[key]):null]));
      this.peerSamples[role].push({sampleTick,stageMs:project(stageKeys),workCounters:project(counterKeys),
        step:{lastMs:Number(perf.lastStepMs)||0,ewmaMs:Number(perf.ewmaStepMs)||0,samples:Number(perf.stepSamples)||0},
        snapshot:{latestMs:Number(perf.snapshotMs)||0,samplesAtCapture:Number(perf.snapshotSamples)||0,totalMsAtCapture:Number(perf.snapshotCumulativeMs)||0}});
    }
  }
  static stats(values,count){
    const rows=[];for(let i=0;i<count;i++)if(Number.isFinite(values[i]))rows.push(values[i]);
    if(!rows.length)return{count:0,p50:null,p95:null,max:null,mean:null};
    const sorted=rows.sort((a,b)=>a-b),n=sorted.length,sum=sorted.reduce((a,b)=>a+b,0),round=value=>Math.round(value*100)/100;
    return{count:n,p50:round(sorted[Math.floor((n-1)*.5)]),p95:round(sorted[Math.floor((n-1)*.95)]),max:round(sorted[n-1]),mean:round(sum/n)};
  }
  static indexedStats(values,indexes){
    const selected=new Float32Array(indexes.length);for(let i=0;i<indexes.length;i++)selected[i]=values[indexes[i]];
    return this.stats(selected,selected.length);
  }
  static pairedSlowFrameRows(indexes,limit=20){
    const value=(key,index)=>{const n=Number(this.sampleBuffers[key]?.[index]);return Number.isFinite(n)?Math.round(n*100)/100:null};
    return indexes.slice().sort((a,b)=>(value("frameIntervalMs",b)||0)-(value("frameIntervalMs",a)||0)||a-b).slice(0,limit).map(index=>{
      const peer=role=>{const p=role==="host"?"host":"guest";return{step:{count:value(p+"StepCount",index),cpuMs:value(p+"StepCpuMs",index)},snapshot:{count:value(p+"SnapshotCount",index),cpuMs:value(p+"SnapshotCpuMs",index)},snapshotUi:{count:value(p+"SnapshotUiCount",index),cpuMs:value(p+"SnapshotUiCpuMs",index)},sessionPulse:{count:value(p+"SessionPulseCount",index),cpuMs:value(p+"SessionPulseCpuMs",index)}}};
      const vectorDiagnostics=this.sampleVectorDiagnostics[index]||null;
      return{frameIndex:index,rendererFrameSequence:value("rendererFrameSequence",index),frameIntervalMs:value("frameIntervalMs",index),elapsedWindowMs:value("frameWindowMs",index),rendererCpuMs:value("rendererCpuWorkMs",index),
        host:peer("host"),guest:peer("guest"),unattributedElapsedMs:value("unattributedElapsedMs",index),
        vector:{drawMeshSubmissions:value("vectorAssetDraws",index),meshInstances:value("vectorInstances",index),webglDrawDispatches:value("vectorAssetDrawCalls",index),alphaRunDispatches:value("vectorAlphaRunDrawCalls",index),
          alphaRunSafeBatches:value("vectorAlphaRunSafeBatches",index),alphaRunBatchedInstances:value("vectorAlphaRunBatchedInstances",index),alphaRunDrawsSaved:value("vectorAlphaRunDrawsSaved",index),
          alphaRunOverlapBoundaries:value("vectorAlphaRunOverlapBoundaries",index),alphaRunSignatureBoundaries:value("vectorAlphaRunSignatureBoundaries",index),alphaRunUnbatchableBounds:value("vectorAlphaRunUnbatchableBounds",index)},
        vectorFlushes:{events:value("vectorFlushEvents",index),reasons:vectorDiagnostics?.flushReasons||null},vectorDrawDispatchReasons:vectorDiagnostics?.drawDispatchReasons||null};
    });
  }
  static aggregateVectorReasonCounts(indexes,field){
    const totals=Object.create(null);
    for(const index of indexes)for(const [reason,count] of Object.entries(this.sampleVectorDiagnostics[index]?.[field]||{}))totals[reason]=(totals[reason]||0)+(Number(count)||0);
    return totals;
  }
  static pairedSlowFrameSummary(frameIntervals){
    const threshold=frameIntervals.p95;if(threshold===null)return{frameCount:0,selection:{metric:"frameIntervalMs",operator:">=",thresholdMs:null},metrics:null,frames:[]};
    const indexes=[];for(let i=0;i<this.sampleCount;i++)if(Number.isFinite(this.sampleBuffers.frameIntervalMs[i])&&this.sampleBuffers.frameIntervalMs[i]>=threshold)indexes.push(i);
    const keys=["frameIntervalMs","frameWindowMs","rendererCpuWorkMs","drawCalls","vectorAssetDrawCalls","vectorAssetDraws","bufferUploadBytes","vectorAssetGeometryBytes","vectorAssetInstanceBytes","alphaRunCacheHits","alphaRunCacheMisses","vectorGeometryUploads","partUniformBytesSubmitted","vectorStagingBytes","vectorInstances","vectorFlushEvents","vectorAlphaRunDrawCalls","vectorAlphaRunSafeBatches","vectorAlphaRunBatchedInstances","vectorAlphaRunDrawsSaved","vectorAlphaRunSafeRunDraws","vectorAlphaRunImmediateRunDraws","vectorAlphaRunOverlapBoundaries","vectorAlphaRunSignatureBoundaries","vectorAlphaRunUnbatchableBounds","vectorAlphaRunImmediateInstances",...Object.values(this.vectorFlushReasonMetricKeys),"hostStepCpuMs","hostStepCount","hostSnapshotCpuMs","hostSnapshotCount","hostSnapshotUiCpuMs","hostSnapshotUiCount","hostSessionPulseCpuMs","hostSessionPulseCount","guestStepCpuMs","guestStepCount","guestSnapshotCpuMs","guestSnapshotCount","guestSnapshotUiCpuMs","guestSnapshotUiCount","guestSessionPulseCpuMs","guestSessionPulseCount","unattributedElapsedMs"];
    const metrics=Object.fromEntries(keys.map(key=>[key,this.indexedStats(this.sampleBuffers[key],indexes)]));
    return{frameCount:indexes.length,selection:{metric:"frameIntervalMs",operator:">=",thresholdMs:threshold,detailLimit:20},metrics,flushReasons:this.aggregateVectorReasonCounts(indexes,"flushReasons"),drawDispatchReasons:this.aggregateVectorReasonCounts(indexes,"drawDispatchReasons"),frames:this.pairedSlowFrameRows(indexes,20)};
  }
  static peerSimulationSummary(match){
    const peers={};
    for(const role of ["host","guest"]){
      const session=match?.sessions?.[role],perf=session?.sim?.perfStats,baseline=this.peerSnapshotBaseline[role]||{count:0,totalMs:0,stepCount:0,stepTotalMs:0,pulseCount:0,pulseTotalMs:0,snapshotUiCount:0,snapshotUiTotalMs:0};
      if(!perf){peers[role]={available:false,reason:"해당 역할의 StrategySim.perfStats를 읽을 수 없음",sampledStages:[],snapshot:null,step:null};continue}
      const snapshotCount=Math.max(0,(Number(perf.snapshotSamples)||0)-baseline.count),snapshotTotalMs=Math.max(0,(Number(perf.snapshotCumulativeMs)||0)-baseline.totalMs);
      const pulse=session?.performanceStats?.timings?.pulse||{},snapshotUi=session?.performanceStats?.timings?.snapshotUi||{};
      const pulseCount=Math.max(0,(Number(pulse.samples)||0)-baseline.pulseCount),pulseTotalMs=Math.max(0,(Number(pulse.cumulativeMs)||0)-baseline.pulseTotalMs);
      const snapshotUiCount=Math.max(0,(Number(snapshotUi.samples)||0)-baseline.snapshotUiCount),snapshotUiTotalMs=Math.max(0,(Number(snapshotUi.cumulativeMs)||0)-baseline.snapshotUiTotalMs);
      const stepTotalMs=Math.max(0,(Number(perf.stepCumulativeMs)||0)-baseline.stepTotalMs);
      peers[role]={available:true,sampleCadenceMs:1000,sampledStages:this.peerSamples[role],
        step:{ticksDuringSample:Math.max(0,(Number(perf.stepSamples)||0)-this.peerStepSampleCountsAtStart[role]),totalCpuMsDuringSample:Math.round(stepTotalMs*100)/100,lastStepMs:Number(perf.lastStepMs)||0,ewmaStepMs:Number(perf.ewmaStepMs)||0,maxObservedStepMs:this.peerMaxStepMs[role],lifetimeMaxStepMs:Number(perf.maxStepMs)||0},
        snapshot:{samplesDuringSample:snapshotCount,totalMsDuringSample:Math.round(snapshotTotalMs*100)/100,averageMsDuringSample:snapshotCount?Math.round(snapshotTotalMs/snapshotCount*100)/100:null,latestSnapshotMs:Number(perf.snapshotMs)||0,lifetimeMaxSnapshotMs:Number(perf.maxSnapshotMs)||0},
        snapshotUi:{samplesDuringSample:snapshotUiCount,totalMsDuringSample:Math.round(snapshotUiTotalMs*100)/100},
        sessionPulse:{samplesDuringSample:pulseCount,totalMsDuringSample:Math.round(pulseTotalMs*100)/100,averageMsDuringSample:pulseCount?Math.round(pulseTotalMs/pulseCount*100)/100:null}};
    }
    return peers;
  }
  static finishSample(now,interrupted){
    if(this.phase!=="sampling")return;
    const live=this.liveState(),start=this.sampleStartState||this.lastSampleState,end=this.stateSnapshot(live||{}),elapsed=Math.max(0,now-this.sampleStartedAt);
    const summary=key=>this.stats(this.sampleBuffers[key],this.sampleCount),intervals=summary("frameIntervalMs"),render=summary("rendererCpuWorkMs"),draws=summary("drawCalls"),vectorDraws=summary("vectorAssetDrawCalls");
    const paired=this.pairedSlowFrameSummary(intervals),sampleMetrics=Object.fromEntries(this.sampleMetricKeys.map(key=>[key,summary(key)]));
    const rendererMetricAvailability=Object.fromEntries(["vectorAssetDrawCalls","vectorAssetDraws","vectorAssetGeometryBytes","vectorAssetInstanceBytes","alphaRunCacheHits","alphaRunCacheMisses","vectorGeometryUploads","partUniformBytesSubmitted","vectorStagingBytes","vectorInstances","vectorFlushEvents","vectorAlphaRunDrawCalls","vectorAlphaRunSafeBatches","vectorAlphaRunBatchedInstances","vectorAlphaRunDrawsSaved"].map(key=>{
      const available=(sampleMetrics[key]?.count||0)>0,vectorPathUsed=(sampleMetrics.vectorAssetDraws?.max||0)>0;
      return[key,available?{available:true,vectorPathUsed,reason:vectorPathUsed?null:"No vector draw occurred in this sample; zero counters mean no calls."}:{available:false,value:null,reason:"No finite VectorContext mesh statistic was exposed for this metric during the sample."}];
    }));
    const match=MatchLifecycle.singleMatch,renderer=ActiveViewState.renderer,unitsPerSide=this.config.totalUnits/2,peers=this.peerSimulationSummary(match);
    const peerStepCpuMs=["host","guest"].map(role=>peers[role]?.available?Number(peers[role].step?.totalCpuMsDuringSample):NaN);
    const simulationCpuTimeMs=peerStepCpuMs.every(Number.isFinite)?Math.round(peerStepCpuMs.reduce((sum,value)=>sum+value,0)*100)/100:null;
    const frameAlignedPeers=Object.fromEntries(["host","guest"].map(role=>{
      const prefix=role==="host"?"host":"guest",metric=suffix=>sampleMetrics[prefix+suffix];
      return[role,{step:{cpuMs:metric("StepCpuMs"),count:metric("StepCount")},snapshot:{cpuMs:metric("SnapshotCpuMs"),count:metric("SnapshotCount")},
        snapshotUi:{cpuMs:metric("SnapshotUiCpuMs"),count:metric("SnapshotUiCount")},sessionPulse:{cpuMs:metric("SessionPulseCpuMs"),count:metric("SessionPulseCount")}}];
    }));
    const frameAlignedSimulation={frameWindowMs:sampleMetrics.frameWindowMs,rendererCpuWorkMs:sampleMetrics.rendererCpuWorkMs,peers:frameAlignedPeers,unattributedElapsedMs:sampleMetrics.unattributedElapsedMs,
      accounting:"Per-frame deltas between completed renderer frames. Session pulse CPU includes StrategySim step and snapshot work; component values are nested details and must not be added again. Unattributed elapsed is window minus renderer and host/guest pulse CPU; it is not GPU time or idle time."};
    const vectorAssetDrawCallMeaning="VectorContext mesh stats draws: WebGL device.draw() dispatches, instanced where supported; this counts API draw dispatches, not measured GPU execution time.";
    const vectorAssetDrawsMeaning="Rally vector unit-body submissions to VectorContext.drawVectorActor(), counted once per submitted unit body; distinct from WebGL draw dispatches.";
    const sampleIndexes=Array.from({length:this.sampleCount},(_,index)=>index),vectorFlushReasons=this.aggregateVectorReasonCounts(sampleIndexes,"flushReasons"),vectorDrawDispatchReasons=this.aggregateVectorReasonCounts(sampleIndexes,"drawDispatchReasons");
    const vectorDrawDispatchReasonTotal=Object.values(vectorDrawDispatchReasons).reduce((sum,count)=>sum+(Number(count)||0),0);
    this.report={schemaVersion:3,testMode:"mobile-battle",capturedAt:new Date().toISOString(),build:BUILD_META.snapshot(),collisionModel:"ally-soft-one-pass",
      device:{userAgent:navigator.userAgent||"",platform:navigator.platform||"",hardwareConcurrency:navigator.hardwareConcurrency||null,viewport:{width:innerWidth,height:innerHeight,devicePixelRatio:devicePixelRatio,orientation:screen.orientation?.type||""}},
      condition:{seed:this.config.fixedSeed,totalCombatUnits:this.config.totalUnits,unitsPerSide,composition:this.config.composition,rosters:{host:DebugScenarioHarness.unitRoster(this.config,0),guest:DebugScenarioHarness.unitRoster(this.config,1)},tps:live?.sim?.tps||match?.sessions?.host?.sim?.tps||10,warmupSeconds:this.config.warmupSeconds,requestedSampleSeconds:this.config.sampleSeconds,selectionMode:"deck",presetId:"standard"},
      measurement:{collector:"completed renderer frame hook",observer:"preallocated numeric sample buffers; no CDP profiler",perFrameCounters:this.sampleMetricKeys,overheadMs:null,overheadUnavailableReason:"Observer cost is not isolated; rendererCpuWorkMs is captured before the diagnostic hook runs.",
        pairing:"all renderer and host/guest counter deltas share each completed-render-frame window; slow-frame subset selects by that same frame's frameIntervalMs p95",
        nestedCpuAccounting:"host/guest sessionPulseCpuMs includes StrategySim step and snapshot work; step/snapshot/snapshotUi are reported as nested components, not additive totals",vectorAssetDrawCallMeaning,vectorAssetDrawsMeaning,
        vectorFlushDiagnostics:{available:this.vectorFlushDiagnosticsAvailable,safeAlphaRunBatching:this.vectorSafeAlphaRunBatching,scope:"reads native VectorContext.stats().mesh during sampling; does not wrap or replace renderer methods",
          flushReasonsMeaning:"Pinned GameKit flushReasons counts non-empty queue flush boundaries by reason; empty flush() no-ops are not counted.",drawDispatchReasonsMeaning:"Pinned GameKit drawDispatchReasons classifies every VectorContext mesh device.draw() dispatch; the reason total should equal metrics.draws. These are submission counters, not GPU execution timing."}},
      sample:{status:interrupted?"interrupted":"complete",durationMs:Math.round(elapsed),frameCount:intervals.count,fps:elapsed>0?Math.round(intervals.count*100000/elapsed)/100:null,
        frameIntervalMs:intervals,rendererCpuWorkMs:render,drawCalls:draws,vectorAssetDrawCalls:vectorDraws,bufferUploadBytes:sampleMetrics.bufferUploadBytes,
        vectorAssetGeometryBytes:sampleMetrics.vectorAssetGeometryBytes,vectorAssetInstanceBytes:sampleMetrics.vectorAssetInstanceBytes,alphaRunCacheHits:sampleMetrics.alphaRunCacheHits,alphaRunCacheMisses:sampleMetrics.alphaRunCacheMisses,
        vectorGeometryUploads:sampleMetrics.vectorGeometryUploads,partUniformBytesSubmitted:sampleMetrics.partUniformBytesSubmitted,vectorStagingBytes:sampleMetrics.vectorStagingBytes,
        vectorAssetDraws:sampleMetrics.vectorAssetDraws,vectorInstances:sampleMetrics.vectorInstances,metricAvailability:rendererMetricAvailability,pairedSlowFrames:paired,frameAlignedSimulation,capacityExceededFrames:this.overflowFrames,
        vectorFlushReasons,vectorDrawDispatchReasons,vectorDrawDispatchReasonTotal,vectorDrawDispatchReasonsMatchDrawCalls:Number.isFinite(sampleMetrics.vectorAssetDrawCalls?.sum)?vectorDrawDispatchReasonTotal===sampleMetrics.vectorAssetDrawCalls.sum:null,
        vectorAlphaRunBatching:{enabled:this.vectorSafeAlphaRunBatching,safeBatches:sampleMetrics.vectorAlphaRunSafeBatches,batchedInstances:sampleMetrics.vectorAlphaRunBatchedInstances,drawsSaved:sampleMetrics.vectorAlphaRunDrawsSaved,
          safeRunDraws:sampleMetrics.vectorAlphaRunSafeRunDraws,immediateRunDraws:sampleMetrics.vectorAlphaRunImmediateRunDraws,overlapBoundaries:sampleMetrics.vectorAlphaRunOverlapBoundaries,
          signatureBoundaries:sampleMetrics.vectorAlphaRunSignatureBoundaries,unbatchableBounds:sampleMetrics.vectorAlphaRunUnbatchableBounds,immediateInstances:sampleMetrics.vectorAlphaRunImmediateInstances},
        gpuTime:{measured:false,timeMs:null,reason:"렌더러에서 GPU 타이머 질의를 수집하지 않음"},simulationCpuTimeMs,simulationCpuTimeSource:simulationCpuTimeMs===null?null:"sum of Host and Guest StrategySim step cumulative CPU",simulationCpuTimeUnavailableReason:simulationCpuTimeMs===null?"StrategySim step cumulative CPU was unavailable for one or both peers":null,
        gcTimeMs:null,gcTimeUnavailableReason:"이 테스트 모드는 GC PerformanceEntry를 등록하지 않음",transportSerializationMs:null,transportSerializationUnavailableReason:"GameSession snapshot 복사 시간은 측정하지만 WebRTC 전송 직렬화 시간은 계측하지 않음"},
      visibility:{...this.visibilityStats,visibilityStateAtFinish:document.visibilityState||"unknown",sampleValid:this.visibilityStats.visibilityStateAtSampleStart==="visible"&&!this.visibilityStats.invalidated&&this.visibilityStats.unpausedHiddenEvents===0},
      simulation:{startTick:start?.tick??null,endTick:end.tick,ticksAdvanced:start?.tick!=null&&end.tick!=null?end.tick-start.tick:null,peerStartTick:start?.peerTick??null,peerEndTick:end.peerTick,aliveUnitsStart:start?.units||null,aliveUnitsEnd:end.units,peers},
      renderer:{backend:renderer?.backend||null,canvas:{width:renderer?.canvas?.width||null,height:renderer?.canvas?.height||null},vectorAssets:!!window.RallyVectorAssets,vectorMeshes:renderer?.perfStats?.vectorAssetMeshes??null,
        lastFrameSequence:renderer?.perfStats?.frameSequence??null,alphaRunCache:{hits:sampleMetrics.alphaRunCacheHits,misses:sampleMetrics.alphaRunCacheMisses},
        vectorFlushDiagnostics:{available:this.vectorFlushDiagnosticsAvailable,safeAlphaRunBatching:this.vectorSafeAlphaRunBatching,reason:this.vectorFlushDiagnosticsAvailable?null:"Pinned VectorContext.stats().mesh did not expose native flush and draw dispatch reason maps."},
        instancing:{enabled:typeof renderer?.vectorContext?.stats?.().mesh?.instanced==="boolean"?renderer.vectorContext.stats().mesh.instanced:null,reason:typeof renderer?.vectorContext?.stats?.().mesh?.instanced==="boolean"?null:"Pinned VectorContext.stats().mesh did not expose its instancing flag",
          usedInSample:(sampleMetrics.vectorAssetDraws?.max||0)>0?null:false,usageReason:(sampleMetrics.vectorAssetDraws?.max||0)>0?"Pinned stats expose renderer instancing capability, but not per-frame instanced-draw activity.":"No vector draw occurred in this sample."}}};
    this.phase="complete";this.pause();this.renderHud(now);
  }
  static pause(){
    if(this.paused||!MatchLifecycle.singleMatch)return;
    let applied=0;for(const session of Object.values(MatchLifecycle.singleMatch.sessions||{}))if(session.setTestModePaused(true))applied++;
    if(!applied)return;
    this.paused=true;this.pausedAt=performance.now();if(this.frameHandle)cancelAnimationFrame(this.frameHandle);this.frameHandle=0;this.renderHud();
  }
  static resume(){
    if(!this.paused||!MatchLifecycle.singleMatch)return;
    let applied=0;for(const session of Object.values(MatchLifecycle.singleMatch.sessions||{}))if(session.setTestModePaused(false))applied++;
    if(!applied)return;
    const now=performance.now(),pauseMs=now-this.pausedAt;if(this.phase==="warmup"||this.phase==="sampling")this.phaseStartedAt+=pauseMs;if(this.phase==="sampling")this.sampleStartedAt+=pauseMs;
    this.lastFrameAt=now;this.paused=false;this.pausedAt=0;this.renderHud(now);this.scheduleFrame();
  }
  static reset(){
    if(!this.config||!["connecting","warmup","sampling","complete","error"].includes(this.phase))return;
    if(this.frameHandle)cancelAnimationFrame(this.frameHandle);this.frameHandle=0;MatchLifecycle.stopSinglePlayer();
    DebugScenarioHarness.pending=this.config;this.beginRun();this.renderHud();
    try{MatchLifecycle.startSinglePlayerWebRTC("host");this.scheduleFrame()}
    catch(error){this.fail(`매치 다시 시작 실패: ${String(error?.message||error)}`)}
  }
  static fail(message,pauseSessions=false){
    this.phase="error";if(this.frameHandle)cancelAnimationFrame(this.frameHandle);this.frameHandle=0;
    if(pauseSessions){let applied=0;for(const session of Object.values(MatchLifecycle.singleMatch?.sessions||{}))if(session.setTestModePaused(true))applied++;if(applied){this.paused=true;this.pausedAt=performance.now()}}
    const status=this.ref("battleTestHudStatus");if(status)status.textContent=message;this.renderHud();
  }
  static renderHud(now=performance.now()){
    const hud=this.ref("battleTestHud");if(!hud)return;
    hud.classList.toggle("hidden",!["connecting","warmup","sampling","complete","error"].includes(this.phase));
    const status=this.ref("battleTestHudStatus"),roster=this.ref("battleTestHudRoster"),metrics=this.ref("battleTestHudMetrics");
    if(roster&&this.config)roster.textContent=`${this.config.totalUnits} · ${this.config.composition} · ${this.config.fixedSeed}`;
    if(status){
      const left=this.phase==="warmup"?Math.max(0,Math.ceil((this.config.warmupSeconds*1000-(now-this.phaseStartedAt))/1000)):this.phase==="sampling"?Math.max(0,Math.ceil((this.config.sampleSeconds*1000-(now-this.phaseStartedAt))/1000)):0;
      status.textContent=this.phase==="connecting"?"로컬 AI 매치 연결 중…":this.phase==="warmup"?`워밍업 ${left}초`:this.phase==="sampling"?`측정 ${this.config.sampleSeconds-left} / ${this.config.sampleSeconds}초`:this.phase==="complete"?"측정 완료 · 전투는 일시정지됨":this.phase==="error"?(status.textContent||"매치 시작 실패"):"";
    }
    const snapshot=this.lastSampleState,live=this.liveState(),current=live?this.stateSnapshot(live):snapshot;
    if(metrics){
      if(this.report){const s=this.report.sample,m=this.report.simulation;metrics.innerHTML=`<span>FPS <b>${s.fps??"—"}</b></span><span>프레임 p50/p95 <b>${s.frameIntervalMs.p50??"—"}/${s.frameIntervalMs.p95??"—"} ms</b></span><span>전투 유닛 <b>${this.config.totalUnits}</b> · 전체 생존 <b>${m.aliveUnitsEnd?.total??"—"}</b></span><span>드로우 p95 <b>${s.drawCalls.p95??"—"}</b> calls · 벡터 p95 <b>${s.vectorAssetDrawCalls.p95??"—"}</b></span><span>틱 <b>${m.startTick??"—"} → ${m.endTick??"—"}</b></span><span>렌더 CPU p95 <b>${s.rendererCpuWorkMs.p95??"—"} ms</b></span>`}
      else if(current){const stats=live?.renderer?.perfStats||{};metrics.innerHTML=`<span>전투 유닛 <b>${this.config?.totalUnits||0}</b> · 생존 <b>${current.units.total}</b></span><span>Host / Guest <b>${current.units.host} / ${current.units.guest}</b></span><span>시뮬레이션 틱 <b>${current.tick??"—"}</b></span><span>렌더 드로우 <b>${stats.drawCalls??"—"}</b> · 벡터 <b>${stats.vectorAssetDrawCalls??"—"}</b></span><span>마지막 프레임 간격 <b>${Math.round(this.lastIntervalMs*100)/100} ms</b></span><span>워밍업/측정 <b>5초 / ${this.config?.sampleSeconds||15}초</b></span>`}
      else metrics.textContent="시뮬레이션 준비 중";
    }
    const pause=this.ref("battleTestPauseBtn"),copy=this.ref("battleTestCopyBtn"),download=this.ref("battleTestDownloadBtn");
    if(pause){pause.textContent=this.paused?"재개":"일시정지";pause.disabled=["connecting","error","complete"].includes(this.phase)}
    this.ref("battleTestResetBtn")?.toggleAttribute("disabled",this.phase==="connecting");
    copy?.classList.toggle("hidden",!this.report);download?.classList.toggle("hidden",!this.report);
  }
  static resetCopyFallback(){
    const area=this.ref("battleTestCopyFallback");if(!area)return;area.value="";area.classList.add("hidden");
  }
  static summaryReportText(report=this.report){
    if(!report)return"";
    const n=value=>value==null||!Number.isFinite(Number(value))?"n/a":Number.isInteger(Number(value))?String(Number(value)):String(Number(Number(value).toFixed(2)));
    const safe=(value,max=72)=>String(value??"n/a").replace(/[\r\n\t]+/g," ").slice(0,max);
    const triplet=metric=>`${n(metric?.p50)}/${n(metric?.p95)}/${n(metric?.max)}`;
    const p95=metric=>n(metric?.p95);
    const sample=report.sample||{},condition=report.condition||{},visibility=report.visibility||{},sim=report.simulation||{},renderer=report.renderer||{};
    const rosters=condition.rosters||{},roster=role=>Array.isArray(rosters[role])?rosters[role].slice(0,5).map(type=>safe(type,28)).join("+")||"n/a":"n/a";
    const viewport=report.device?.viewport||{},paired=sample.pairedSlowFrames||{},pairedMetrics=paired.metrics||{};
    const vectorAvailability=sample.metricAvailability?.vectorAssetDraws;
    const vectorPath=vectorAvailability?.available===false?"metrics unavailable":vectorAvailability?.vectorPathUsed===false?"unused in sample":vectorAvailability?.vectorPathUsed===true||p95(sample.vectorAssetDraws)!=="n/a"?"used":"status unknown";
    const worstFrame=paired.frames?.[0]||null;
    const sameFrameLine=worstFrame?(()=>{const topReasons=map=>Object.entries(map||{}).filter(([,count])=>Number(count)>0).sort((a,b)=>Number(b[1])-Number(a[1])).slice(0,2).map(([reason,count])=>`${reason}:${n(count)}`).join(",")||"none",reasons=topReasons(worstFrame.vectorFlushes?.reasons),dispatches=topReasons(worstFrame.vectorDrawDispatchReasons),peer=row=>`step ${n(row?.step?.count)}/${n(row?.step?.cpuMs)}ms snap ${n(row?.snapshot?.count)}/${n(row?.snapshot?.cpuMs)}ms pulse ${n(row?.sessionPulse?.cpuMs)}ms`;return`Same frame #${n(worstFrame.rendererFrameSequence??worstFrame.frameIndex)} elapsed/render=${n(worstFrame.elapsedWindowMs)}/${n(worstFrame.rendererCpuMs)}ms; H ${peer(worstFrame.host)}; G ${peer(worstFrame.guest)}; vector submit/WebGL/alpha-run=${n(worstFrame.vector?.drawMeshSubmissions)}/${n(worstFrame.vector?.webglDrawDispatches)}/${n(worstFrame.vector?.alphaRunDispatches)}; safe alpha batches/instances saved=${n(worstFrame.vector?.alphaRunSafeBatches)}/${n(worstFrame.vector?.alphaRunBatchedInstances)}/${n(worstFrame.vector?.alphaRunDrawsSaved)}; flush events=${n(worstFrame.vectorFlushes?.events)} (${reasons}); dispatch reasons=${dispatches}; unattributed=${n(worstFrame.unattributedElapsedMs)}ms`})():"Same-frame rows unavailable";
    const aliveStart=sim.aliveUnitsStart||{},aliveEnd=sim.aliveUnitsEnd||{};
    const stageKeys=[["total","totalMs"],["index","indexMs"],["world","worldMs"],["economy","economyMs"],["worker","workerMs"],["vision","visionMs"],["combat","combatMs"],["target-pick","combatTargetPickMs"],["combat-other","combatOtherMs"],["projectile","projectileMs"],["collision","collisionMs"],["post","postMs"]];
    const peerLine=(role,label)=>{
      const peer=sim.peers?.[role];if(!peer?.available)return`${label}: unavailable`;
      const rows=Array.isArray(peer.sampledStages)?peer.sampledStages:[];
      const stages=stageKeys.map(([name,key])=>{
        const values=rows.map(row=>row?.stageMs?.[key]).filter(value=>Number.isFinite(value)).sort((a,b)=>a-b);
        const value=values.length?values[Math.floor((values.length-1)*.95)]:null;return`${name}=${n(value)}`;
      }).join("/");
      const work=key=>{
        const values=rows.map(row=>row?.workCounters?.[key]).filter(value=>Number.isFinite(value));
        return values.length?n(Math.max(...values)):"n/a";
      };
      const total=key=>rows.reduce((sum,row)=>sum+(Number(row?.workCounters?.[key])||0),0);
      const step=peer.step||{},snapshot=peer.snapshot||{};
      return`${label}: step ticks/cpu/last/ewma/max=${n(step.ticksDuringSample)}/${n(step.totalCpuMsDuringSample)}/${n(step.lastStepMs)}/${n(step.ewmaStepMs)}/${n(step.maxObservedStepMs)}ms; snapshot n/avg/max=${n(snapshot.samplesDuringSample)}/${n(snapshot.averageMsDuringSample)}/${n(snapshot.lifetimeMaxSnapshotMs)}ms; stage p95ms ${stages}; work max nearby-return/targetQueries/collisions=${work("spatialCandidates")}/${work("targetQueries")}/${work("collisionPairs")} target-pick calls=${total("combatTargetPickCalls")}; collision sum soft pass/contact/moved/capped=${total("collisionSoftPasses")}/${total("collisionSoftContacts")}/${total("collisionSoftMovedUnits")}/${total("collisionSoftCappedUnits")} sweep call/pass=${total("collisionSweptCalls")}/${total("collisionSweptActivePasses")} hardfix call/pass/correction=${total("collisionHardFixCalls")}/${total("collisionHardFixPasses")}/${total("collisionHardFixCorrections")}`;
    };
    const unavailable=[];
    if(sample.gpuTime?.measured!==true)unavailable.push("GPU timer not measured");
    if(sample.gcTimeMs==null)unavailable.push("GC timing not collected");
    if(sample.transportSerializationMs==null)unavailable.push("transport serialization not measured");
    if(sample.simulationCpuTimeMs==null)unavailable.push("Host/Guest StrategySim step CPU totals unavailable");
    const lines=[
      `RALLY FRONTIER · mobile battle diagnostics`,
      `Build ${safe(report.build?.id)} / commit ${safe(report.build?.commit,48)} / collision=${safe(report.collisionModel,32)}`,
      `Condition seed=${n(condition.seed)} units=${n(condition.totalCombatUnits)} (${n(condition.unitsPerSide)}/side) roster H=${roster("host")} G=${roster("guest")} TPS=${n(condition.tps)} warmup/sample=${n(condition.warmupSeconds)}/${n(condition.requestedSampleSeconds)}s`,
      `Run ${safe(sample.status,24)} ${n(sample.durationMs)}ms/${n(sample.frameCount)} frames FPS=${n(sample.fps)} viewport=${n(viewport.width)}x${n(viewport.height)}@${n(viewport.devicePixelRatio)} ${safe(viewport.orientation,24)}`,
      `Visibility valid=${visibility.sampleValid===true?"yes":visibility.sampleValid===false?"no":"unknown"} sample/finish=${safe(visibility.visibilityStateAtSampleStart,16)}/${safe(visibility.visibilityStateAtFinish,16)} hidden=${n(visibility.hiddenEvents)} unpaused=${n(visibility.unpausedHiddenEvents)} paused=${n(visibility.hiddenWhilePausedEvents)} pagehide=${n(visibility.pagehideEvents)} invalidated=${n(visibility.invalidated===true?1:visibility.invalidated===false?0:null)}`,
      `Frame ms p50/p95/max=${triplet(sample.frameIntervalMs)}; renderer CPU ms p50/p95/max=${triplet(sample.rendererCpuWorkMs)}; all/WebGL-vector draws p95=${p95(sample.drawCalls)}/${p95(sample.vectorAssetDrawCalls)}; vector unit submissions p95=${p95(sample.vectorAssetDraws)}; vector path=${vectorPath}`,
      `Paired slow-frame p95 ms window/render/Host pulse/Guest pulse/unattributed=${p95(pairedMetrics.frameWindowMs)}/${p95(pairedMetrics.rendererCpuWorkMs)}/${p95(pairedMetrics.hostSessionPulseCpuMs)}/${p95(pairedMetrics.guestSessionPulseCpuMs)}/${p95(pairedMetrics.unattributedElapsedMs)}; nested step CPU/count H/G=${p95(pairedMetrics.hostStepCpuMs)}/${p95(pairedMetrics.hostStepCount)} / ${p95(pairedMetrics.guestStepCpuMs)}/${p95(pairedMetrics.guestStepCount)}; snapshot CPU/count H/G=${p95(pairedMetrics.hostSnapshotCpuMs)}/${p95(pairedMetrics.hostSnapshotCount)} / ${p95(pairedMetrics.guestSnapshotCpuMs)}/${p95(pairedMetrics.guestSnapshotCount)}; pulse includes nested sim work`,
      sameFrameLine,
      `Alpha-run batching enabled=${sample.vectorAlphaRunBatching?.enabled===true?"yes":sample.vectorAlphaRunBatching?.enabled===false?"no":"unknown"}; safe batches/batched instances/draws saved p50/p95/max=${triplet(sample.vectorAlphaRunBatching?.safeBatches)}/${triplet(sample.vectorAlphaRunBatching?.batchedInstances)}/${triplet(sample.vectorAlphaRunBatching?.drawsSaved)}; overlap boundaries p95=${p95(sample.vectorAlphaRunBatching?.overlapBoundaries)}`,
      `Uploads p95 bytes buffer/geometry/instance/staging/partUniform=${p95(sample.bufferUploadBytes)}/${p95(sample.vectorAssetGeometryBytes)}/${p95(sample.vectorAssetInstanceBytes)}/${p95(sample.vectorStagingBytes)}/${p95(sample.partUniformBytesSubmitted)}; geometry uploads p95=${p95(sample.vectorGeometryUploads)}; vector instances p95=${p95(sample.vectorInstances)}`,
      `Alpha cache avg hits/misses per frame=${n(sample.alphaRunCacheHits?.mean)}/${n(sample.alphaRunCacheMisses?.mean)}; paired slow frames=${n(paired.frameCount)} at >=${n(paired.selection?.thresholdMs)}ms, renderer CPU/draw/upload p95=${p95(pairedMetrics.rendererCpuWorkMs)}/${p95(pairedMetrics.drawCalls)}/${p95(pairedMetrics.bufferUploadBytes)}, cache hits/misses p95=${p95(pairedMetrics.alphaRunCacheHits)}/${p95(pairedMetrics.alphaRunCacheMisses)}`,
      `Ticks ${n(sim.startTick)}→${n(sim.endTick)} (+${n(sim.ticksAdvanced)}); alive H/G ${n(aliveStart.host)}/${n(aliveStart.guest)}→${n(aliveEnd.host)}/${n(aliveEnd.guest)} (total ${n(aliveStart.total)}→${n(aliveEnd.total)})`,
      peerLine("host","Host"),peerLine("guest","Guest"),
      `Renderer ${safe(renderer.backend)} canvas=${n(renderer.canvas?.width)}x${n(renderer.canvas?.height)} vectorAssets=${renderer.vectorAssets===true?"yes":renderer.vectorAssets===false?"no":"unknown"}; unavailable: ${unavailable.join("; ")||"none"}`
    ];
    return lines.join("\n");
  }
  static revealCopyFallback(text){
    const area=this.ref("battleTestCopyFallback");if(!area)return;
    area.value=text;area.classList.remove("hidden");area.focus({preventScroll:true});area.select();area.setSelectionRange(0,area.value.length);area.scrollIntoView?.({block:"nearest"});
  }
  static async copyReport(){
    if(!this.report)return;const text=this.summaryReportText(this.report),status=this.ref("battleTestHudStatus");let copied=false;
    try{if(navigator.clipboard?.writeText){await navigator.clipboard.writeText(text);copied=true}}catch{}
    if(!copied){
      const area=document.createElement("textarea");area.value=text;area.setAttribute("readonly","");area.style.cssText="position:fixed;left:-9999px;top:0";
      try{document.body.appendChild(area);area.select();copied=!!document.execCommand?.("copy")}catch{}finally{area.remove()}
    }
    if(copied){this.resetCopyFallback();if(status)status.textContent="진단 요약을 복사했습니다."}
    else{this.revealCopyFallback(text);if(status)status.textContent="자동 복사에 실패했습니다. 아래 요약을 선택해 복사하세요."}
  }
  static deferDownloadUrlRevoke(url){
    let timer=0;const revoke=()=>{if(timer)clearTimeout(timer);window.removeEventListener("pagehide",revoke);URL.revokeObjectURL(url)};
    window.addEventListener("pagehide",revoke,{once:true});timer=setTimeout(revoke,60000);
  }
  static downloadReport(){
    if(!this.report)return;const status=this.ref("battleTestHudStatus");let url=null,anchor=null,requested=false;
    try{
      const blob=new Blob([JSON.stringify(this.report,null,2)],{type:"application/json"});url=URL.createObjectURL(blob);
      anchor=document.createElement("a");anchor.href=url;anchor.download=`rally-mobile-battle-${this.report.condition?.seed??this.config?.fixedSeed??"unknown"}-${this.report.condition?.totalCombatUnits??this.config?.totalUnits??"unknown"}.json`;
      document.body.appendChild(anchor);anchor.click();requested=true;
      if(status)status.textContent="상세 JSON 다운로드를 요청했습니다. 완료 여부는 브라우저 다운로드에서 확인하세요.";
    }catch{if(status)status.textContent="상세 JSON 다운로드 요청을 시작하지 못했습니다."}
    finally{anchor?.remove();if(url){if(requested)this.deferDownloadUrlRevoke(url);else URL.revokeObjectURL(url)}}
  }
  static exit(){
    if(["idle","stopped"].includes(this.phase))return;
    if(this.frameHandle)cancelAnimationFrame(this.frameHandle);this.frameHandle=0;this.phase="stopped";this.paused=false;
    MatchLifecycle.stopSinglePlayer();DebugScenarioHarness.pending=this.savedDebugPending;CampaignRuntime.pending=this.savedCampaignPending;CampaignPresentation.clear();document.body.classList.remove("battle-test-mode");this.ref("battleTestHud")?.classList.add("hidden");
    UiController.setElementVisible(UiRegistry.refs.singleStatus,false);
    if(this.savedSettings){UiRuntimeState.value.settings.presetId=this.savedSettings.presetId;UiController.setStartSimulationTps(this.savedSettings.simulationTps);UiController.setStartNetcodeMode(this.savedSettings.netcodeMode)}
    UiController.setUiScreen("lobby");
    this.phase="idle";this.config=null;this.report=null;this.savedSettings=null;this.savedCampaignPending=null;this.savedDebugPending=null;
  }
}

const CAMPAIGN_MISSION_SCHEMA_VERSION=7;
const CAMPAIGN_MANIFEST_SCHEMA_VERSION=2;
class CampaignFaction{
 static values=Object.freeze({player:"player",enemy:"enemy",neutral:"neutral"});
 static side(faction,humanSide){
  const key=String(faction||"").trim().toLowerCase();
  if(!Object.prototype.hasOwnProperty.call(this.values,key))throw new Error(`알 수 없는 캠페인 진영: ${faction}`);
  return key==="player"?humanSide:key==="enemy"?1-humanSide:NEUTRAL_SIDE;
 }
}
class CampaignMapDefinition{
 static normalizeType(raw){
  const type=String(raw?.type||"").trim().toLowerCase();
  if(type==="auto"||type==="manual")return type;
  throw new Error(`지원하지 않는 캠페인 맵 타입: ${type||"미지정"}`);
 }
 static build(raw,rules=GameRuleDefinition.current,seed=0,humanSide=0){
  const mapType=this.normalizeType(raw);
  if(mapType==="auto"){
    const generated=MapGeneration.generateMapDescriptor({rules,seed:seed>>>0,roundNumber:rules?.roundNumber||1});
    return generated;
  }
  const width=Math.max(2400,Math.round(Number(raw?.width)||Number(rules?.map?.width)||GameRuleDefinition.defaults.map.width)),height=Math.max(2400,Math.round(Number(raw?.height)||Number(rules?.map?.height)||GameRuleDefinition.defaults.map.height)),minDim=Math.min(width,height);
  const point=p=>({x:Math.round(RangeUtil.clamp(Number(p?.[0])||0,0,1)*width),y:Math.round(RangeUtil.clamp(Number(p?.[1])||0,0,1)*height)});
  const pts=a=>(Array.isArray(a)?a:[]).map(point),radius=v=>Math.max(20,Math.round(RangeUtil.clamp(Number(v)||.05,.005,.4)*minDim));
  const base=MapGeneration.fixedStandardMapDescriptor(rules,seed,1),sp=raw?.spawns||{};
  base.generator="campaign-authored";base.generatorVersion=4;base.seed=seed>>>0;base.width=width;base.height=height;
  // Strict manual-map contract: procedural descriptor contents are never inherited.
  // The authored JSON is the sole source of terrain/control/resources/scenario objects.
  base.resources=[];base.gasNodes=[];base.camps=[];base.capturePoints=[];base.biome=String(raw?.biome||"flower-border");base.symmetry="authored";
  base.spawns={host:point(sp.host||[.14,.84]),guest:point(sp.guest||[.86,.16])};
  const lanes=raw?.lanes||{};for(const k of ["top","mid","bot"])base.laneControlPoints[k]=Array.isArray(lanes[k])&&lanes[k].length>=2?pts(lanes[k]):[{...base.spawns.host},{...base.spawns.guest}];
  base.flags=[MapGeometry.pointOnPolyline(base.laneControlPoints.mid,.18),MapGeometry.pointOnPolyline(base.laneControlPoints.mid,.82)].map(p=>({...p,forced:false}));
  base.capturePoints=(Array.isArray(raw?.capturePoints)?raw.capturePoints:[]).map((c,i)=>({...point(c.position),id:String(c.id||`campaign-cp-${i}`),laneKey:String(c.lane||"mid"),lane:String(c.lane||"mid").toUpperCase(),label:String(c.label||"전선 거점"),stage:Number(c.stage)||1,enabled:c.enabled!==false,owner:c.owner===0||c.owner===1?c.owner:null}));
  const t=raw?.terrain||{};base.terrain={riverPath:pts(t.river?.points),riverHalfWidth:radius(t.river?.halfWidth||.035),riverBranches:[],riverPolygon:[],riverBranchPolygons:[],bridges:(Array.isArray(t.bridges)?t.bridges:[]).map((b,i)=>({...point(b.position),id:String(b.id||`bridge-${i}`),angle:Number(b.angle)||0,level:Number(b.level??0),halfLength:radius(b.halfLength||.055),halfWidth:radius(b.halfWidth||.018)}))};
  base.terrain.layers=(t.layers||[]).map(o=>({id:String(o.id),level:Number(o.level),points:pts(o.points),...(o.innerPoints?{innerPoints:pts(o.innerPoints)}:{})}));
  base.terrain.ramps=(t.ramps||[]).map(o=>({...o,run:radius(o.run)}));
  base.terrain.blockers=(t.blockers||[]).map(o=>({id:o.id,kind:o.kind||"cliff",points:pts(o.points),blocksMovement:o.blocksMovement!==false,blocksVision:o.blocksVision!==false,blocksProjectile:!!o.blocksProjectile,blocksAirVision:!!o.blocksAirVision}));
  base.terrain.roads=(t.roads||[]).map(o=>({id:o.id,points:pts(o.points),width:Math.max(32,(Number(o.width)||.04)*minDim)}));
  // Resource placement is a shared map policy, not a campaign exception.
  // objective-auto reuses the normal base/capture-point resource generator, so every
  // expansion resource cluster has a meaningful control point and balance changes flow through automatically.
  const resourcePlacement=String(raw?.content?.resourcePlacement||rules?.map?.content?.resourcePlacement||"objective-auto");
  if(resourcePlacement==="objective-auto"){
    const host=base.spawns.host,guest=base.spawns.guest,axisX=guest.x-host.x,axisY=guest.y-host.y,axisLen=Math.hypot(axisX,axisY)||1;
    const ux=axisX/axisLen,uy=axisY/axisLen,nx=-uy,ny=ux,margin=150;
    const ctx={rules,width,height,seed:seed>>>0,host,guest,ux,uy,nx,ny,scale:Math.min(width/3600,height/4200),clampPt:p=>({x:Math.round(RangeUtil.clamp(p.x,margin,width-margin)),y:Math.round(RangeUtil.clamp(p.y,margin,height-margin))})};
    const amountCfg={...(rules?.map?.content?.resourceAmounts||{}),...(raw?.content?.resourceAmounts||{})};
    ctx.resourceAmounts=amountCfg;
    const generated=MapGeneration.generateProceduralResources(ctx,base.capturePoints);
    base.resources=generated.resources;base.gasNodes=generated.gasNodes;
  }else if(resourcePlacement==="manual"){
    base.resources=(Array.isArray(raw?.resources)?raw.resources:[]).map((r,i)=>({...point(r.position),id:String(r.id||`cm${i+1}`),amount:Math.max(1,Math.round(Number(r.amount)||900)),max:Math.max(1,Math.round(Number(r.amount)||900)),r:28}));
    base.gasNodes=(Array.isArray(raw?.gasNodes)?raw.gasNodes:[]).map((g,i)=>({...point(g.position),id:String(g.id||`cg${i+1}`),amount:Math.max(1,Math.round(Number(g.amount)||1600)),max:Math.max(1,Math.round(Number(g.amount)||1600)),r:32}));
  }else{base.resources=[];base.gasNodes=[]}
  if(base.terrain.blockers.length||base.terrain.layers.length){
    const geometry=TerrainGeometry.fromMap(base);
    const occupied=[];
    for(const node of [...base.resources,...base.gasNodes]){
      const r=base.gasNodes.includes(node)?110:65;
      if(!geometry.circleClear(node.x,node.y,r)){
        const origin={x:node.x,y:node.y};let found=null;
        for(let ring=32;ring<=512&&!found;ring+=32)for(let k=0;k<24;k++){
          const a=k*Math.PI/12,x=origin.x+Math.cos(a)*ring,y=origin.y+Math.sin(a)*ring;
          if(!geometry.circleClear(x,y,r)||occupied.some(p=>Math.hypot(x-p.x,y-p.y)<r+p.r)||[base.spawns.host,base.spawns.guest,...base.capturePoints].some(p=>Math.hypot(x-p.x,y-p.y)<130+r))continue;
          found={x:Math.round(x),y:Math.round(y)};break;
        }
        if(!found)throw new Error(`자원권에 접근 가능한 공간이 없습니다: ${node.id}`);
        Object.assign(node,found);
      }
      occupied.push({x:node.x,y:node.y,r});
    }
  }

  const authoredForces=[
    ...(Array.isArray(raw?.garrisons)?raw.garrisons:[]).map(spec=>({spec,kind:"unitNeutralObject",spawnOnStart:spec.spawnOnStart!==false})),
    ...(Array.isArray(raw?.attackForces)?raw.attackForces:[]).map(spec=>({spec,kind:"scenarioUnitGroup",spawnOnStart:spec.spawnOnStart!==false}))
  ];
  base.camps=authoredForces.map(({spec:o,kind,spawnOnStart},i)=>{
    const anchorId=String(o.capturePoint||"").trim();
    const anchor=anchorId?base.capturePoints.find(cp=>cp.id===anchorId):null;
    const rawPos=point(o.position);
    const offset=Array.isArray(o.offset)?o.offset:[0,0];
    const pos=anchor?{x:Math.round(anchor.x+(Number(offset[0])||0)*width),y:Math.round(anchor.y+(Number(offset[1])||0)*height)}:rawPos;
    const composition=UnitCompositionDefinition.normalize(Array.isArray(o.composition)?o.composition:[]);
    const campSide=CampaignFaction.side(o.faction,humanSide);
    const neutralObject=kind==="unitNeutralObject";
    const control=kind==="scenarioUnitGroup"?"guard":["guard","attack"].includes(String(o.control))?String(o.control):"attack";
    return {id:String(o.id||`authored-force-${i}`),kind,x:pos.x,y:pos.y,state:"ready",respawnAt:0,lastHitSide:null,spawnNo:0,side:neutralObject?NEUTRAL_SIDE:campSide,friendlySide:neutralObject?campSide:null,composition,formation:["cluster","line","spread"].includes(String(o.formation))?String(o.formation):"cluster",control,guardRadius:radius(o.guardRadius||.085),label:String(o.label||"배치 병력"),homeSpread:radius(o.spread||.018),spawnOnStart};
  }).filter(c=>UnitCompositionDefinition.total(c.composition)>0);
  base.authoredStructures=(Array.isArray(raw?.structures)?raw.structures:[]).map((o,i)=>{
    const anchorId=String(o.capturePoint||"").trim();
    const anchor=anchorId?base.capturePoints.find(cp=>cp.id===anchorId):null;
    const offset=Array.isArray(o.offset)?o.offset:[0,0],rawPos=point(o.position);
    const pos=anchor?{x:Math.round(anchor.x+(Number(offset[0])||0)*width),y:Math.round(anchor.y+(Number(offset[1])||0)*height)}:rawPos;
    const side=CampaignFaction.side(o.faction,humanSide);
    const type=String(o.building||"");
    if(!BuildingDefinition.get(type))return null;
    return {id:String(o.id||`authored-structure-${i}`),type,side,x:pos.x,y:pos.y,label:String(o.label||type),capturePoint:anchorId||null,objectiveGroup:String(o.objectiveGroup||"").trim()||null};
  }).filter(Boolean);
  TerrainGeometry.cache.delete(base);
  if(base.terrain.blockers.length||base.terrain.layers.length){
    const g=TerrainGeometry.fromMap(base),errors=[];
    for(const [role,p] of Object.entries(base.spawns))if(!g.circleClear(p.x,p.y,BuildingDefinition.get(BuildingDefinition.forRole("mainBase")).size+40))errors.push(`map.spawns.${role}: 본진과 시작 병력 공간이 막힌 지형과 겹칩니다.`);
    for(const cp of base.capturePoints)if(!g.circleClear(cp.x,cp.y,BuildingDefinition.get(BuildingDefinition.forRole("outpost")).size+20))errors.push(`map.capturePoints.${cp.id}: 전진 거점 자리가 막힌 지형과 겹칩니다.`);
    for(const b of base.authoredStructures)if(!g.circleClear(b.x,b.y,(BuildingDefinition.get(b.type)?.size||35)+2))errors.push(`map.structures.${b.id}: 건물이 막힌 지형과 겹칩니다.`);
    for(const c of base.camps){const ground=c.composition.filter(x=>UnitDefinition.get(x.unit)?.layer!=="AIR");if(ground.length&&!g.circleClear(c.x,c.y,30))errors.push(`map.forces.${c.id}: 병력 배치 중심이 막힌 지형과 겹칩니다.`)}
    if(errors.length)throw new Error(errors.join("\n"));
  }
  return base;
 }
}
class CampaignModuleLoader{
 static evaluate(source,label="campaign.js"){
  const text=String(source||"").trim();if(!text)throw new Error("빈 Mission JS입니다.");
  let mission;
  try{mission=(new Function('"use strict";return (\n'+text+'\n);\n//# sourceURL='+String(label).replace(/[^a-zA-Z0-9_./:-]/g,"_") ))()}
  catch(e){throw new Error(`Mission JS 실행 실패 · ${e?.message||e}`)}
  if(!mission||typeof mission!=="object"||Array.isArray(mission))throw new Error("Mission JS는 미션 객체를 반환해야 합니다.");
  Object.defineProperty(mission,"__moduleSource",{value:text,enumerable:false,configurable:true});
  return mission;
 }
 static sourceOf(raw){return typeof raw?.__moduleSource==="string"?raw.__moduleSource:String(raw?.moduleSource||"")}
}
class CampaignScriptRuntime{
 constructor(sim,mission){this.sim=sim;this.mission=mission;this.definitionHash=HashUtil.hash(StableSerializationUtil.stableStringify(mission));this.state=Object.create(null);this.module=null;this.script=null;this.started=false;this.compile()}
 compile(){const source=String(this.mission?.moduleSource||"");if(!source)return;this.module=CampaignModuleLoader.evaluate(source,this.mission?.missionId||"campaign.js");this.script=this.module?.script&&typeof this.module.script==="object"?this.module.script:null}
 ctx(){const sim=this.sim,mission=this.mission,state=this.state,humanSide=this.humanSide(),enemySide=1-humanSide;
  const group=id=>{id=String(id);if(!sim.camps.some(c=>c.id===id))throw new Error(`알 수 없는 캠페인 그룹: ${id}`);return sim.units.filter(u=>u.alive&&(u.campId||u.scenarioGroupId)===id)};
  const mainBase=side=>sim.buildings.find(b=>b.alive!==false&&b.hp>0&&b.side===side&&BuildingDefinition.get(b.type)?.isMainBase)||null;
  return Object.freeze({sim,time:Object.freeze({tick:sim.tick,seconds:sim.ticksMs(sim.tick)/1000,tps:sim.tps}),state,mission,humanSide,enemySide,
   random:Object.freeze({next:()=>{const n=(state.__randomSeq=(state.__randomSeq||0)+1),v=HashUtil.hash(`${sim.seed}|campaign-script|${mission.missionId}|${sim.tick}|${n}`)>>>0;return v/4294967296},range:(a,b)=>{const n=(state.__randomSeq=(state.__randomSeq||0)+1),v=(HashUtil.hash(`${sim.seed}|campaign-script|${mission.missionId}|${sim.tick}|${n}`)>>>0)/4294967296;return a+v*(b-a)}}),
   units:Object.freeze({all:()=>sim.units.filter(u=>u.alive),group,side:s=>sim.units.filter(u=>u.alive&&u.side===s),inRegion:(region,side=null)=>{const r=typeof region==="string"?mission.regions?.[region]:region;if(!r)throw new Error(`알 수 없는 캠페인 지역: ${region}`);const x=(Number(r.center?.[0])||0)*sim.world.width,y=(Number(r.center?.[1])||0)*sim.world.height,rr=(Number(r.radius)||.08)*Math.min(sim.world.width,sim.world.height);return sim.units.filter(u=>u.alive&&(side==null||u.side===side)&&Math.hypot(u.x-x,u.y-y)<=rr)}}),
   buildings:Object.freeze({all:()=>sim.buildings.filter(b=>b.alive!==false&&b.hp>0),side:s=>sim.buildings.filter(b=>b.alive!==false&&b.hp>0&&b.side===s),mainBase}),
   resources:Object.freeze({minerals:s=>Number(sim.wallet?.[s]||0),gas:s=>Number(sim.gasWallet?.[s]||0)}),
   groups:Object.freeze({get:group}),regions:Object.freeze({get:id=>{if(!Object.prototype.hasOwnProperty.call(mission.regions,id))throw new Error(`알 수 없는 캠페인 지역: ${id}`);return mission.regions[id]}}),
   orders:Object.freeze({attack:(id,target="playerBase")=>this.runAction({type:"order",group:id,order:"attack",target}),hold:id=>this.runAction({type:"order",group:id,order:"hold"})}),
   spawn:Object.freeze({group:id=>{this.runAction({type:"spawnObject",objectId:String(id)});return group(id)}}),
   flags:Object.freeze({get:id=>this.scenario.flags[String(id)],set:(id,v)=>this.runAction({type:"setFlag",id,value:v})}),
   ui:Object.freeze({toast:(text,durationMs)=>this.runAction({type:"toast",text,durationMs}),ping:region=>this.runAction({type:"ping",region})}),
   objectives:Object.freeze({set:(id,text,state="active")=>this.runAction({type:"setObjective",id,text,state}),complete:id=>this.runAction({type:"completeObjective",id})}),
   action:a=>this.runAction(a),
   emit:(type,data={})=>sim.events.push({...data,type:String(type)}),raw:Object.freeze({sim})});
 }
 call(name,...args){
  if(this.disposed)throw new Error(`종료된 캠페인 스크립트 호출: ${name}`);
  const fn=this.script?.[name];if(typeof fn!=="function")return;
  try{const result=fn(this.ctx(),...args);if(result&&typeof result.then==="function")throw new Error("시뮬레이션 hook은 동기 함수여야 합니다.");return result}
  catch(error){throw new Error(`[${this.mission.missionId}] ${name} · tick ${this.sim.tick}: ${error?.message||error}`,{cause:error})}
 }
 start(){if(this.started)return;this.started=true;this.scenario;this.call("onInit");this.call("onStart")}
 tick(){if(!this.started)this.start();this.call("onTick")}
 event(event){this.call("onEvent",event)}
 dispose(reason="disposed"){
  if(this.disposed)return false;
  this.disposed=true;
  const fn=this.script?.onDispose;
  // Teardown is local, unlike onTick: it may happen on only one peer during seek
  // or recovery. Supply detached data, never the live sim/command API.
  try{
   if(typeof fn==="function"){
    const result=fn(Object.freeze({reason,missionId:this.mission.missionId,
     time:Object.freeze({tick:this.sim.tick,seconds:this.sim.ticksMs(this.sim.tick)/1000,tps:this.sim.tps}),
     state:CloneUtil.clone(this.state)}));
    if(result&&typeof result.then==="function")throw new Error("onDispose는 동기 함수여야 합니다.");
   }
  }finally{this.script=null;this.module=null}
  return true;
 }

 get scenario(){
  return this.state.__scenario||(this.state.__scenario={
   flags:CloneUtil.clone(this.mission.flags||{}),
   objectives:CloneUtil.clone(this.mission.objectives||[]),
   triggers:{},pending:[],presentationSeq:0,result:null
  });
 }
 humanSide(){return this.mission.playerRole==="guest"?1:0}
 region(def){return typeof def==="string"?this.mission.regions?.[def]||null:def&&typeof def==="object"?def:null}
 postStep(){
  for(const e of [...this.sim.events])this.event(e);
  this.runTriggers();
 }
 runTriggers(){
  const sim=this.sim,st=this.scenario;
  const due=st.pending.filter(x=>x.tick<=sim.tick);
  st.pending=st.pending.filter(x=>x.tick>sim.tick);
  for(const job of due){const event=this.mission.events.find(e=>e.id===job.id);if(event)for(const a of event.actions)this.runAction(a)}
  for(const e of this.mission.events||[]){
   if(e.enabled===false)continue;
   const f=st.triggers[e.id]||{count:0,lastTick:0};
   if((e.once!==false&&f.count>0)||(e.repeatCount!=null&&f.count>=e.repeatCount))continue;
   if(f.count&&sim.tick-f.lastTick<sim.msTicks(e.cooldownMs||0))continue;
   if(!this.triggerMet(e.when))continue;
   st.triggers[e.id]={count:f.count+1,lastTick:sim.tick};
   const delay=sim.msTicks(e.delayMs||0,{minimum:0});
   if(e.delayMs>0)st.pending.push({id:e.id,tick:sim.tick+delay});
   else for(const a of e.actions)this.runAction(a);
  }
 }
 present(action){
  const id=++this.scenario.presentationSeq;
  this.sim.events.push({type:"campaignPresentation",campaignEventId:id,action:CloneUtil.clone(action)});
 }
 static actionDefinitions=Object.freeze([
{types:["toast","ping","cameraFocus"],run(a,sim,st){this.present(a);return}},
{types:["setFlag"],run(a,sim,st){st.flags[String(a.id||"")]=a.value;return}},
{types:["setObjective","completeObjective"],run(a,sim,st){const type=String(a.type||"");
   const id=String(a.id||"objective"),i=st.objectives.findIndex(o=>o.id===id),old=i<0?{id,text:id}:st.objectives[i];
   const next=type==="completeObjective"?{...old,state:"complete"}:{...old,id,text:String(a.text||old.text||id),state:String(a.state||"active")};
   if(i<0)st.objectives.push(next);else st.objectives[i]=next;return;
  }},
{types:["spawnGroup"],run(a,sim,st){const id=String(a.id||a.group||`campaign-${sim.seq+1}`);let camp=sim.camps.find(c=>c.id===id);if(!camp){const p=a.position||[.5,.5],side=CampaignFaction.side(a.faction||"enemy",this.humanSide());camp={id,kind:"scenarioUnitGroup",x:(Number(p[0])||0)*sim.world.width,y:(Number(p[1])||0)*sim.world.height,state:"ready",respawnAt:0,spawnNo:0,side,composition:UnitCompositionDefinition.normalize(a.composition),formation:String(a.formation||"cluster"),label:String(a.label||id),homeSpread:(Number(a.spread)||.02)*Math.min(sim.world.width,sim.world.height),spawnOnStart:false};sim.camps.push(camp)}if(!sim.units.some(u=>u.alive&&(u.campId||u.scenarioGroupId)===id))sim.spawnCamp(camp);return}},
{types:["order"],run(a,sim,st){const id=String(a.group||a.objectId||""),members=sim.units.filter(u=>u.alive&&(u.campId||u.scenarioGroupId)===id),camp=sim.camps.find(c=>c.id===id);let target=null;if(a.target==="playerBase")target=sim.buildings.find(b=>b.side===this.humanSide()&&b.alive!==false&&b.hp>0&&BuildingDefinition.get(b.type)?.isMainBase);else if(a.target==="enemyBase")target=sim.buildings.find(b=>b.side!==this.humanSide()&&b.side!==NEUTRAL_SIDE&&b.alive!==false&&b.hp>0&&BuildingDefinition.get(b.type)?.isMainBase);if(!target&&typeof a.target==="string")target=sim.liveEntityRefById(a.target)?.entity||null;if(!target&&Array.isArray(a.position))target={x:Number(a.position[0])*sim.world.width,y:Number(a.position[1])*sim.world.height};const order=String(a.order||"attack");if(camp){camp.control=order==="hold"?"guard":"attack";camp.order={type:order,targetId:target?.id||null,x:target?.x??camp.x,y:target?.y??camp.y};}for(const u of members){if(order==="hold"){u.aggroed=false;u.forcedTargetId=null;u.target=null}else{u.aggroed=true;if(target){u.forcedTargetId=target.id??null;u.target=target.id??null}}}sim.events.push({type:"campaignOrder",groupId:id,order,targetId:target?.id||null});return}},
{types:["spawnObject","attackWave"],run(a,sim,st){const type=String(a.type||"");const camp=sim.camps?.find(c=>c.id===String(a.objectId||""));if(!camp)return;if(!sim.units.some(u=>u.alive&&(u.campId||u.scenarioGroupId)===camp.id))sim.spawnCamp(camp);if(type==="attackWave")this.runAction({type:"order",group:camp.id,order:"attack",target:a.target||"playerBase"});return}},
{types:["setCaptureActive"],run(a,sim,st){const cp=sim.capturePoints.find(c=>c.id===String(a.id||a.captureId||""));if(cp)cp.enabled=a.enabled!==false;return}},
{types:["setFaction"],run(a,sim,st){const id=String(a.group||a.objectId||""),side=CampaignFaction.side(a.faction,this.humanSide()),c=sim.camps.find(x=>x.id===id);if(c)c.side=side;for(const u of sim.units)if((u.campId||u.scenarioGroupId)===id){if(side===NEUTRAL_SIDE){u.scenarioGroupId=null;sim.makeUnitNeutralObject(u,id)}else{sim.enlistNeutralObjectUnit(u,side);u.scenarioGroupId=id}}return}},
{types:["unlockUnit"],run(a,sim,st){const unit=String(a.unit||""),side=a.side==="enemy"?1-this.humanSide():this.humanSide();if(!CampaignMissionDefinition.validProductionUnit(unit))throw new Error(`생산 해금할 수 없는 병종: ${unit}`);if(!(sim.decks[side]||[]).includes(unit)){sim.decks[side].push(unit);sim.events.push({type:"campaignUnitUnlocked",side,unit})}return}},
{types:["victory","defeat"],run(a,sim,st){const type=String(a.type||"");
   st.result={winner:ConnectionRoleUtil.sideRole(type==="victory"?this.humanSide():1-this.humanSide()),reason:"campaign-trigger"};return;
  }}
]);
 static actions=new Map(this.actionDefinitions.flatMap(def=>def.types.map(type=>[type,def.run])));
 runAction(a){
  const type=String(a?.type||""),handler=CampaignScriptRuntime.actions.get(type);
  if(!handler)throw new Error(`지원하지 않는 캠페인 액션: ${type}`);
  CampaignContentValidator.validateRuntimeAction(a,this);
  return handler.call(this,a,this.sim,this.scenario);
 }
 static conditionDefinitions=Object.freeze([
{types:["time"],run(t,sim,humanSide){return sim.tick>=sim.msTicks((Number(t.seconds)||0)*1000);}},
{types:["flag"],run(t,sim,humanSide){return this.scenario.flags?.[String(t.id||"")]===t.equals;}},
{types:["objectAlive","objectDead"],run(t,sim,humanSide){const type=String(t.type||"");const alive=sim.units.some(u=>u.alive&&(u.campId||u.scenarioGroupId)===String(t.objectId||t.id||""));return type==="objectAlive"?alive:!alive}},
{types:["groupCount"],run(t,sim,humanSide){const n=sim.units.filter(u=>u.alive&&(u.campId||u.scenarioGroupId)===String(t.group||t.objectId||"")).length,v=Math.max(0,Number(t.value)||0),op=String(t.op||"<=");return op===">="?n>=v:op===">"?n>v:op==="="?n===v:op==="<"?n<v:n<=v}},
{types:["regionCaptured"],run(t,sim,humanSide){const cp=sim.capturePoints.find(c=>c.id===String(t.id||t.captureId||"")),side=t.side==="enemy"?1-humanSide:humanSide;return !!cp&&cp.owner===side}},
{types:["resource"],run(t,sim,humanSide){const side=t.side==="enemy"?1-humanSide:humanSide,val=String(t.resource||"mineral")==="gas"?sim.gasWallet?.[side]:sim.wallet?.[side];return Number(val||0)>=Number(t.atLeast||t.value||0)}},
{types:["techReached"],run(t,sim,humanSide){const side=t.side==="enemy"?1-humanSide:humanSide;return Number(sim.tech?.[side]||0)>=Number(t.tier||1)}},
{types:["enterRegion","unitsInRegion"],run(t,sim,humanSide){const r=this.region(t.region)||{center:t.center||[.5,.5],radius:t.radius||.08},x=(Number(r.center?.[0])||0)*sim.world.width,y=(Number(r.center?.[1])||0)*sim.world.height,rad=(Number(r.radius)||.08)*Math.min(sim.world.width,sim.world.height),side=t.side==="enemy"?1-humanSide:humanSide,n=sim.units.filter(u=>u.alive&&u.side===side&&Math.hypot(u.x-x,u.y-y)<=rad).length;return n>=Math.max(1,Number(t.count)||1)}},
{types:["discoverObject"],run(t,sim,humanSide){const camp=sim.camps?.find(c=>c.id===String(t.objectId||""));if(!camp)return false;const targets=sim.units.filter(u=>u.alive&&(u.campId||u.scenarioGroupId)===camp.id),r=(Number(t.radius)||.11)*Math.min(sim.world.width,sim.world.height);return targets.length>0&&sim.units.some(a=>a.alive&&a.side===humanSide&&targets.some(x=>Math.hypot(a.x-x.x,a.y-x.y)<=r))}},
{types:["cyclePhase"],run(t,sim,humanSide){const cycle=Math.max(1,Number(t.cycleSeconds)||1),offset=Number(t.offsetSeconds)||0,elapsed=Math.max(0,sim.ticksMs(sim.tick)/1000-offset);if(sim.ticksMs(sim.tick)/1000<offset)return false;const cycleIndex=Math.floor(elapsed/cycle)+1,within=elapsed%cycle,start=Math.max(0,Number(t.startSeconds)||0),end=Math.min(cycle,Number(t.endSeconds??cycle));if(cycleIndex<Math.max(1,Number(t.cycleAtLeast)||1))return false;if(t.cycleAtMost!=null&&cycleIndex>Number(t.cycleAtMost))return false;return within>=start&&within<end}},
{types:["unitCount"],run(t,sim,humanSide){const side=t.side==="enemy"?1-humanSide:humanSide,type=t.unit==null?null:String(t.unit),n=sim.units.filter(u=>u.alive&&u.side===side&&(!type||u.type===type)).length,v=Math.max(0,Number(t.value??t.atLeast)||0),op=String(t.op||">=");return op===">="?n>=v:op===">"?n>v:op==="="?n===v:op==="<"?n<v:n<=v}},
{types:["buildingComplete"],run(t,sim,humanSide){const side=t.side==="enemy"?1-humanSide:humanSide,type=String(t.building||"");return sim.buildings.some(b=>b.alive!==false&&b.complete&&b.side===side&&b.type===type)}},
{types:["researchCompleted"],run(t,sim,humanSide){const side=t.side==="enemy"?1-humanSide:humanSide;if(t.researchId)return !!sim.specialResearch?.[side]?.[String(t.researchId)];if(t.unit)return !!sim.abilities?.[side]?.[String(t.unit)];if(t.research==="attack")return Number(sim.attackUpgrade?.[side]||0)>=Math.max(1,Number(t.level)||1);if(t.research==="armor")return Number(sim.armorUpgrade?.[side]||0)>=Math.max(1,Number(t.level)||1);return false}},
{types:["structureCount"],run(t,sim,humanSide){const side=t.side==="enemy"?1-humanSide:t.side==="player"?humanSide:t.side==="neutral"?NEUTRAL_SIDE:null,group=String(t.group||t.objectiveGroup||""),types=Array.isArray(t.types)?new Set(t.types.map(String)):null,r=this.region(t.region),cx=(Number(r?.center?.[0])||0)*sim.world.width,cy=(Number(r?.center?.[1])||0)*sim.world.height,rr=r?(Number(r.radius)||.08)*Math.min(sim.world.width,sim.world.height):0;const n=sim.buildings.filter(b=>b.alive!==false&&b.hp>0&&(side==null||b.side===side)&&(!group||b.campaignObjectiveGroup===group)&&(!types||types.has(String(b.type)))&&(!r||Math.hypot(b.x-cx,b.y-cy)<=rr)).length,v=Math.max(0,Number(t.value)||0),op=String(t.op||"<=");return op===">="?n>=v:op===">"?n>v:op==="="?n===v:op==="<"?n<v:n<=v}}
]);
 static conditions=new Map(this.conditionDefinitions.flatMap(def=>def.types.map(type=>[type,def.run])));
 triggerMet(t,sim=this.sim,humanSide=this.humanSide()){
  if(!t||!sim)return false;
  if(Array.isArray(t.all))return t.all.every(x=>this.triggerMet(x,sim,humanSide));
  if(Array.isArray(t.any))return t.any.some(x=>this.triggerMet(x,sim,humanSide));
  if(t.not)return !this.triggerMet(t.not,sim,humanSide);
  const type=String(t.type||""),handler=CampaignScriptRuntime.conditions.get(type);
  if(!handler)throw new Error(`지원하지 않는 캠페인 조건: ${type}`);
  return handler.call(this,t,sim,humanSide);
 }
}
class CampaignOutcomeRules{
 static normalize(raw,map){
  const type=String(raw?.type||"base-destroyed");
  if(!["base-destroyed","structure-group-destroyed","scripted"].includes(type))throw new Error(`지원하지 않는 미션 승리 조건: ${type}`);
  if(type==="base-destroyed"||type==="scripted")return {type};
  const objectiveGroup=String(raw?.objectiveGroup||"").trim();
  if(!objectiveGroup)throw new Error("구조물 파괴 승리 조건에는 objectiveGroup이 필요합니다.");
  const targets=(map?.structures||[]).filter(b=>String(b.objectiveGroup||"")===objectiveGroup);
  if(!targets.length)throw new Error(`승리 목표 구조물이 없습니다: ${objectiveGroup}`);
  return {type,objectiveGroup};
 }
 static resolve(sim){
  const alive=side=>sim.buildings.some(b=>b.alive!==false&&b.hp>0&&b.side===side&&BuildingDefinition.isMainBase(b.type));
  const host=alive(0),guest=alive(1),m=sim.campaignScenario;
  if(m){
   const human=m.playerRole==="guest"?1:0,opponent=1-human,role=ConnectionRoleUtil.sideRole;
   if(m.victory?.type==="scripted"){
    if(!(human===0?host:guest))return {winner:role(opponent),reason:"base-destroyed"};
    return sim.campaignScriptRuntime?.scenario.result||null;
   }
   if(m.victory?.type==="structure-group-destroyed"){
    // Losing the defended base wins precedence over clearing the last objective.
    if(!(human===0?host:guest))return {winner:role(opponent),reason:"base-destroyed"};
    const requested=sim.campaignScriptRuntime?.scenario.result;
    if(requested?.winner===role(opponent))return requested;
    const group=m.victory.objectiveGroup;
    const defined=(sim.mapDescriptor?.authoredStructures||[]).filter(b=>b.side===opponent&&b.objectiveGroup===group);
    if(!defined.length)throw new Error(`적 승리 목표 구조물이 없습니다: ${group}`);
    const remaining=sim.buildings.some(b=>b.alive!==false&&b.hp>0&&b.side===opponent&&b.campaignObjectiveGroup===group);
    return remaining?null:{winner:role(human),reason:"campaign-objectives"};
   }
   const scripted=sim.campaignScriptRuntime?.scenario.result;
   if(scripted)return scripted;
  }
  if(!host&&!guest)return {winner:"draw",reason:"draw"};
  if(!host)return {winner:"guest",reason:"base-destroyed"};
  if(!guest)return {winner:"host",reason:"base-destroyed"};
  return null;
 }
}
// Validate authored references before normalization can drop/replace anything.
// Legal primitive names are derived from the actual runtime dispatch registries.
class CampaignContentValidator{
 static has(defs,id){return typeof id==="string"&&Object.prototype.hasOwnProperty.call(defs,id)}
 static validate(raw){
  const errors=[],err=(path,text)=>errors.push(`${path}: ${text}`);
  if(Number(raw?.schemaVersion)!==CAMPAIGN_MISSION_SCHEMA_VERSION)err("schemaVersion",`현재 스키마 ${CAMPAIGN_MISSION_SCHEMA_VERSION}가 필요합니다.`);
  const object=(v,path)=>{if(!v||typeof v!=="object"||Array.isArray(v)){err(path,"객체가 필요합니다.");return false}return true};
  const array=(v,path)=>{if(v==null)return [];if(!Array.isArray(v)){err(path,"배열이 필요합니다.");return []}return v};
  const name=(id,path)=>{if(typeof id!=="string"||!id.trim()){err(path,"비어 있지 않은 ID가 필요합니다.");return ""}return id};
  const number=(v,path,min=0,max=Infinity)=>{if(typeof v!=="number"||!Number.isFinite(v)||v<min||v>max)err(path,`${min}~${max===Infinity?"유한값":max} 범위의 숫자가 필요합니다.`)};
  const position=(v,path,offset=false)=>{if(!Array.isArray(v)||v.length!==2){err(path,"[x,y] 상대좌표가 필요합니다.");return}v.forEach((n,i)=>number(n,`${path}[${i}]`,offset?-1:0,1))};
  const units=(v,path,roster=false)=>array(v,path).forEach((id,i)=>{
   if(!this.has(UnitDefinition.all,id))err(`${path}[${i}]`,`알 수 없는 병종 '${id}'`);
   else if(roster){const d=UnitDefinition.get(id);if(!(d.tier>=1&&d.tier<=3)||d.economyWorker||d.carrierSummon)err(`${path}[${i}]`,`생산 덱에 사용할 수 없는 병종 '${id}'`)}
  });
  const composition=(v,path)=>{const rows=array(v,path);if(!rows.length)err(path,"한 종류 이상의 병력이 필요합니다.");rows.forEach((row,i)=>{
    if(!object(row,`${path}[${i}]`))return;
    units([row.unit],`${path}[${i}].unit`);
    if(!Number.isSafeInteger(row.count)||row.count<1)err(`${path}[${i}].count`,"1 이상의 정수가 필요합니다.");
   })};
  const faction=(v,path,required=false)=>{const key=String(v??"").trim().toLowerCase();if(!key){if(required)err(path,"player / enemy / neutral 중 하나가 필요합니다.");return}if(!Object.prototype.hasOwnProperty.call(CampaignFaction.values,key))err(path,`알 수 없는 진영 '${v}'`)};
  const add=(table,id,path)=>{if(table.has(id))err(path,`중복 ID '${id}'`);else table.set(id,path)};
  const check=(table,id,path)=>{if(!table.has(id))err(path,`존재하지 않는 참조 '${id}'`)};
  const cps=new Map(),groups=new Map(),structures=new Map(),objectives=new Map(),regions=new Map(),objectiveGroups=new Map(),eventIds=new Map();
  for(const side of ["player","enemy"]){
   const d=raw[side]||{};if(!object(d,side))continue;
   if(Object.prototype.hasOwnProperty.call(d,"units"))err(`${side}.units`,"schema 7에서는 availableUnits를 사용합니다.");
   units(d.availableUnits,`${side}.availableUnits`,true);
   const starting=array(d.startingUnits,`${side}.startingUnits`);starting.forEach((row,i)=>{if(!object(row,`${side}.startingUnits[${i}]`))return;units([row.unit],`${side}.startingUnits[${i}].unit`,true);if(!Number.isSafeInteger(row.count)||row.count<1)err(`${side}.startingUnits[${i}].count`,"1 이상의 정수가 필요합니다.")});
   if(d.startingWorkers!=null)number(d.startingWorkers,`${side}.startingWorkers`,0,30);
   if(d.startingResources!=null){if(object(d.startingResources,`${side}.startingResources`)){number(Number(d.startingResources.minerals||0),`${side}.startingResources.minerals`,0);number(Number(d.startingResources.gas||0),`${side}.startingResources.gas`,0)}}
   if(d.startingTech!=null)number(d.startingTech,`${side}.startingTech`,1,3);
   array(d.startingBuildings,`${side}.startingBuildings`).forEach((spec,i)=>{const path=`${side}.startingBuildings[${i}]`;if(!object(spec,path))return;const building=String(spec.building||"");if(!this.has(BuildingDefinition.all,building)||BuildingDefinition.get(building)?.scenarioOnly)err(`${path}.building`,`시작 건물로 사용할 수 없는 건물 '${building}'`);if(spec.produceType!=null)units([spec.produceType],`${path}.produceType`,true)});
   array(d.defenseCards,`${side}.defenseCards`).forEach((id,i)=>{if(!this.has(DefenseCardDefinition.all,id))err(`${side}.defenseCards[${i}]`,`알 수 없는 방어 카드 '${id}'`)});
   if(d.techCap!=null)number(d.techCap,`${side}.techCap`,1,3);
   if(d.startingTech!=null&&d.techCap!=null&&Number(d.startingTech)>Number(d.techCap))err(`${side}.startingTech`,"techCap보다 높을 수 없습니다.");
  }
  if(raw.playerRole!=null&&!["host","guest"].includes(raw.playerRole))err("playerRole","host 또는 guest여야 합니다.");
  if(raw.enemy?.aiProfile!=null&&!["standard","scripted"].includes(raw.enemy.aiProfile))err("enemy.aiProfile",`알 수 없는 AI profile '${raw.enemy.aiProfile}'`);
  if(raw.script!=null&&object(raw.script,"script"))for(const [key,fn]of Object.entries(raw.script)){
   if(!["onInit","onStart","onTick","onEvent","onDispose"].includes(key))err(`script.${key}`,"지원하지 않는 lifecycle hook입니다. 보조 함수는 미션 JS 내부에 선언하세요.");
   if(typeof fn!=="function")err(`script.${key}`,"함수가 필요합니다.");
   else if(fn.constructor?.name!=="Function")err(`script.${key}`,"동기 함수가 필요합니다. simulation clock/state를 사용하세요.");
  }
  const map=raw.map||{};
  if(raw.map!=null)object(raw.map,"map");
  try{CampaignMapDefinition.normalizeType(map)}catch(e){err("map.type",e.message)}
  for(const key of ["width","height"])if(map[key]!=null)number(map[key],`map.${key}`,2400);
  for(const [key,p]of Object.entries(map.spawns||{})){if(!["host","guest"].includes(key))err(`map.spawns.${key}`,"host/guest 시작 지점만 지원합니다.");position(p,`map.spawns.${key}`);}
  for(const [key,lane]of Object.entries(map.lanes||{})){
   if(!["top","mid","bot"].includes(key))err(`map.lanes.${key}`,"지원하지 않는 레인입니다.");
   const points=array(lane,`map.lanes.${key}`);if(points.length<2)err(`map.lanes.${key}`,"최소 두 좌표가 필요합니다.");points.forEach((p,i)=>position(p,`map.lanes.${key}[${i}]`));
  }
  array(map.capturePoints,"map.capturePoints").forEach((cp,i)=>{
   if(!object(cp,`map.capturePoints[${i}]`))return;
   add(cps,cp.id||`campaign-cp-${i}`,`map.capturePoints[${i}].id`);position(cp.position,`map.capturePoints[${i}].position`);
  });
  if(raw.enemy?.offense!=null&&object(raw.enemy.offense,"enemy.offense")){
    const cfg=raw.enemy.offense;
    if(raw.enemy.aiProfile==="scripted")err("enemy.offense","standard AI에서만 공세 설정을 사용합니다.");
    for(const key of Object.keys(cfg))if(!["firstAttackMs","regroupMs","attackSize","counterattackPoints","productionLimit"].includes(key))err(`enemy.offense.${key}`,"알 수 없는 공세 설정입니다.");
    number(cfg.firstAttackMs,"enemy.offense.firstAttackMs",0);number(cfg.regroupMs,"enemy.offense.regroupMs",0);
    if(!Number.isSafeInteger(cfg.attackSize)||cfg.attackSize<1)err("enemy.offense.attackSize","1 이상의 정수가 필요합니다.");
    if(cfg.productionLimit!=null&&(!Number.isSafeInteger(cfg.productionLimit)||cfg.productionLimit<1))err("enemy.offense.productionLimit","1 이상의 정수가 필요합니다.");
    array(cfg.counterattackPoints,"enemy.offense.counterattackPoints").forEach((id,i)=>check(cps,id,`enemy.offense.counterattackPoints[${i}]`));
  }
  const anchor=(o,path)=>{const id=o.capturePoint;if(id){check(cps,id,`${path}.capturePoint`);if(o.offset)position(o.offset,`${path}.offset`,true)}else position(o.position,`${path}.position`);faction(o.faction,`${path}.faction`,true)};
  let forceIndex=0;
  for(const key of ["garrisons","attackForces"])array(map[key],`map.${key}`).forEach((o,i)=>{
   const path=`map.${key}[${i}]`,index=forceIndex++;if(!object(o,path))return;
   add(groups,o.id||`authored-force-${index}`,`${path}.id`);anchor(o,path);composition(o.composition,`${path}.composition`);
   if(o.control!=null&&!["guard","attack"].includes(o.control))err(`${path}.control`,"지원하지 않는 병력 제어입니다.");
   if(o.formation!=null&&!["cluster","line","spread"].includes(o.formation))err(`${path}.formation`,`알 수 없는 진형 '${o.formation}'`);
  });
  array(map.structures,"map.structures").forEach((o,i)=>{
   const path=`map.structures[${i}]`;if(!object(o,path))return;
   const id=o.id||`authored-structure-${i}`;add(structures,id,`${path}.id`);
   if(["base0","base1"].includes(id))err(`${path}.id`,"기본 본진 ID와 충돌합니다.");
   const type=o.building;if(!this.has(BuildingDefinition.all,type))err(`${path}.building`,`알 수 없는 건물 '${type}'`);
   anchor(o,path);const group=o.objectiveGroup;if(group)objectiveGroups.set(group,path);
  });
  for(const [id,r]of Object.entries(raw.regions||{})){
   add(regions,id,`regions.${id}`);if(!object(r,`regions.${id}`))continue;
   position(r.center,`regions.${id}.center`);if(r.radius!=null)number(r.radius,`regions.${id}.radius`,0.001,1);
  }
  array(raw.objectives,"objectives").forEach((o,i)=>{if(object(o,`objectives[${i}]`))add(objectives,name(o.id,`objectives[${i}].id`),`objectives[${i}].id`)});
  const events=array(raw.events,"events");
  // Declarations in actions can be referenced by another trigger; execution order
  // is still checked by runtime APIs for dynamically created groups.
  events.forEach((e,i)=>{if(!object(e,`events[${i}]`))return;add(eventIds,e.id||`event-${i}`,`events[${i}].id`);
   array(e.actions,`events[${i}].actions`).forEach(a=>{
    if(a?.type==="setObjective"&&a.id)objectives.set(a.id,"setObjective");
    if(a?.type==="spawnGroup"&&(a.id||a.group))groups.set(a.id||a.group,"spawnGroup");
   });
  });
  const region=(v,path)=>{if(typeof v==="string")check(regions,v,path);else if(object(v,path)){position(v.center,`${path}.center`);if(v.radius!=null)number(v.radius,`${path}.radius`,0.001,1)}};
  const condition=(t,path)=>{
   if(!object(t,path))return;
   const branches=["all","any","not"].filter(k=>t[k]!=null);
   if(branches.length){if(branches.length!==1||t.type)err(path,"all/any/not 또는 type 중 하나만 사용하세요.");for(const key of branches)if(key==="not")condition(t.not,`${path}.not`);else array(t[key],`${path}.${key}`).forEach((v,i)=>condition(v,`${path}.${key}[${i}]`));return}
   if(!CampaignScriptRuntime.conditions.has(t.type)){err(`${path}.type`,`알 수 없는 조건 '${t.type}'`);return}
   if(t.region!=null)region(t.region,`${path}.region`);
   if(["objectAlive","objectDead","discoverObject"].includes(t.type))check(groups,t.objectId||t.id,`${path}.objectId`);
   if(t.type==="groupCount")check(groups,t.group||t.objectId,`${path}.group`);
   if(t.type==="regionCaptured")check(cps,t.id||t.captureId,`${path}.id`);
   if(t.type==="unitCount"&&t.unit!=null)units([t.unit],`${path}.unit`,true);
   if(t.type==="buildingComplete"){const id=String(t.building||"");if(!this.has(BuildingDefinition.all,id))err(`${path}.building`,`알 수 없는 건물 '${id}'`)}
   if(t.type==="researchCompleted"){if(t.unit!=null)units([t.unit],`${path}.unit`,true);if(t.researchId!=null&&!UnitSpecialResearchDefinition.get(String(t.researchId)))err(`${path}.researchId`,`알 수 없는 특수 연구 '${t.researchId}'`);if(t.research!=null&&!['attack','armor'].includes(String(t.research)))err(`${path}.research`,`attack 또는 armor여야 합니다.`)}
   if(t.type==="structureCount"){
    if(t.group||t.objectiveGroup)check(objectiveGroups,t.group||t.objectiveGroup,`${path}.group`);
    array(t.types,`${path}.types`).forEach((id,i)=>{if(!this.has(BuildingDefinition.all,id))err(`${path}.types[${i}]`,`알 수 없는 건물 '${id}'`)});
   }
   if(["groupCount","structureCount"].includes(t.type)&&t.op!=null&&!["=",">","<",">=","<="].includes(t.op))err(`${path}.op`,"지원하지 않는 비교 연산자입니다.");
   if(["enterRegion","unitsInRegion"].includes(t.type)&&t.region==null)position(t.center,`${path}.center`);
   if(t.type==="time")number(t.seconds,`${path}.seconds`);
   if(t.type==="cyclePhase"){
    number(t.cycleSeconds,`${path}.cycleSeconds`,0.001);
    for(const k of ["startSeconds","endSeconds"])if(t[k]!=null)number(t[k],`${path}.${k}`,0,t.cycleSeconds);
    if((t.endSeconds??t.cycleSeconds)<=(t.startSeconds??0))err(path,"phase 종료가 시작보다 뒤여야 합니다.");
   }
  };
  events.forEach((e,i)=>{
   if(!e||typeof e!=="object")return;const path=`events[${i}]`;
   condition(e.when,`${path}.when`);
   for(const key of ["delayMs","cooldownMs","repeatCount"])if(e[key]!=null)number(e[key],`${path}.${key}`,key==="repeatCount"?1:0);
   array(e.actions,`${path}.actions`).forEach((a,j)=>{
    const ap=`${path}.actions[${j}]`;if(!object(a,ap))return;
    if(!CampaignScriptRuntime.actions.has(a.type)){err(`${ap}.type`,`알 수 없는 액션 '${a.type}'`);return}
    if(a.region!=null)region(a.region,`${ap}.region`);
    if(a.position)position(a.position,`${ap}.position`);
    if(["ping","cameraFocus"].includes(a.type)&&a.region==null&&!a.position)err(ap,"region 또는 position이 필요합니다.");
    if(["order","setFaction"].includes(a.type))check(groups,a.group||a.objectId,`${ap}.group`);
    if(["spawnObject","attackWave"].includes(a.type))check(groups,a.objectId,`${ap}.objectId`);
    if(a.type==="spawnGroup"&&a.composition)composition(a.composition,`${ap}.composition`);
    if(a.type==="order"){
     if(a.order!=null&&!["attack","hold"].includes(a.order))err(`${ap}.order`,"지원하지 않는 명령입니다.");
     if(a.target&&!["playerBase","enemyBase"].includes(a.target))check(structures,a.target,`${ap}.target`);
    }
    if(a.type==="setCaptureActive")check(cps,a.id||a.captureId,`${ap}.id`);
    if(a.type==="unlockUnit")units([a.unit],`${ap}.unit`,true);
    if(a.type==="completeObjective")check(objectives,a.id,`${ap}.id`);
    faction(a.faction,`${ap}.faction`);
   });
  });
  const terrain=map.terrain||{};
  const terrainIds=new Map();
  const terrainLayers=new Map();
  array(terrain.layers,'map.terrain.layers').forEach((l,i)=>{
   const path=`map.terrain.layers[${i}]`;if(!object(l,path))return;
   name(l.id,path+'.id');add(terrainIds,l.id,path+'.id');terrainLayers.set(l.id,l);
   if(Object.prototype.hasOwnProperty.call(l,'elevation'))err(path+'.elevation','고도는 level에서 자동 파생됩니다. elevation을 선언하지 마세요.');
   if(!Number.isSafeInteger(l.level))err(path+'.level','부호 있는 정수가 필요합니다.');
   const points=array(l.points,path+'.points');if(points.length<3)err(path+'.points','정점 3개 이상이 필요합니다.');
   points.forEach((p,j)=>position(p,path+`.points[${j}]`));
   if(l.innerPoints!=null){const inner=array(l.innerPoints,path+'.innerPoints');if(inner.length!==points.length)err(path+'.innerPoints','경사면 안쪽과 바깥쪽 정점 수가 같아야 합니다.');inner.forEach((p,j)=>position(p,path+`.innerPoints[${j}]`));}
  });
  array(terrain.ramps,'map.terrain.ramps').forEach((r,i)=>{
   const path=`map.terrain.ramps[${i}]`;if(!object(r,path))return;
   name(r.id,path+'.id');add(terrainIds,r.id,path+'.id');check(terrainLayers,r.layerId,path+'.layerId');
   const layer=terrainLayers.get(r.layerId);
   if(!Number.isInteger(r.edge)||r.edge<0||r.edge>=(layer?.points?.length||0))err(path+'.edge','고지 다각형의 유효한 변 인덱스가 필요합니다.');
   number(r.t0,path+'.t0',0,1);number(r.t1,path+'.t1',0,1);if(!(r.t1>r.t0))err(path+'.t1','t0보다 커야 합니다.');
   number(r.run,path+'.run',.005,.4);
  });
  for(const key of ["blockers","roads"])array(terrain[key],`map.terrain.${key}`).forEach((b,i)=>{
    const path=`map.terrain.${key}[${i}]`;if(!object(b,path))return;
    name(b.id,path+".id");add(terrainIds,b.id,path+".id");
    const pts=array(b.points,path+".points");if(pts.length<(key==="blockers"?3:2))err(path+".points","정점 수가 부족합니다.");
    pts.forEach((p,j)=>position(p,path+`.points[${j}]`));
    if(key==="roads"){if(b.width!=null)number(b.width,path+".width",.003,.15)}
    else{
      if(b.kind!=null&&!["cliff","roots"].includes(b.kind))err(path+".kind","cliff 또는 roots여야 합니다.");
      for(const flag of ["blocksMovement","blocksVision","blocksProjectile","blocksAirVision"])if(b[flag]!=null&&typeof b[flag]!=="boolean")err(path+"."+flag,"boolean이어야 합니다.");
      if(pts.every(p=>Array.isArray(p)&&p.length===2&&p.every(Number.isFinite))){
        let area=0;for(let j=0;j<pts.length;j++){const a=pts[j],c=pts[(j+1)%pts.length];area+=a[0]*c[1]-c[0]*a[1];
          for(let k=j+2;k<pts.length;k++){if(j===0&&k===pts.length-1)continue;const d=pts[k],e=pts[(k+1)%pts.length];if(TerrainGeometry.segmentsIntersect(...a,...c,...d,...e))err(path+".points","자기 교차 polygon은 사용할 수 없습니다.")}
        }if(Math.abs(area)<.000001)err(path+".points","면적이 없는 지형입니다.");
      }
    }
  });
  array(terrain.river?.points,"map.terrain.river.points").forEach((p,i)=>position(p,`map.terrain.river.points[${i}]`));
  array(terrain.bridges,"map.terrain.bridges").forEach((item,i)=>{if(object(item,`map.terrain.bridges[${i}]`)){position(item.position,`map.terrain.bridges[${i}].position`);if(item.level!=null&&!Number.isSafeInteger(item.level))err(`map.terrain.bridges[${i}].level`,"부호 있는 정수가 필요합니다.")}});
  if(Array.isArray(terrain.hills)&&terrain.hills.length)err("map.terrain.hills","고지는 terrain.layers의 level로 선언하세요.");
  if(map.content?.resourcePlacement!=null&&!["objective-auto","manual","none"].includes(map.content.resourcePlacement))err("map.content.resourcePlacement","지원하지 않는 자원 배치 정책입니다.");
  for(const key of ["resources","gasNodes"])array(map[key],`map.${key}`).forEach((v,i)=>{if(object(v,`map.${key}[${i}]`))position(v.position,`map.${key}[${i}].position`)});
  const counter=raw.presentation?.hud?.counter;if(counter?.objectiveGroup)check(objectiveGroups,counter.objectiveGroup,"presentation.hud.counter.objectiveGroup");
  const phase=raw.presentation?.hud?.phaseCycle;if(phase){number(phase.cycleSeconds,"presentation.hud.phaseCycle.cycleSeconds",0.001);number(phase.daySeconds,"presentation.hud.phaseCycle.daySeconds",0,phase.cycleSeconds)}
  if(errors.length){const error=new Error(`미션 사전검증 실패 (${errors.length}건)\n`+errors.join("\n"));error.name="CampaignValidationError";error.issues=errors;throw error}
  return true;
 }
 static validateRuntimeAction(a,runtime){
  const sim=runtime.sim,type=a.type,fail=text=>{throw new Error(`[${runtime.mission.missionId}] ${type} · tick ${sim.tick}: ${text}`)};
  if(["order","setFaction","spawnObject","attackWave"].includes(type)){
    const id=a.group||a.objectId;if(!sim.camps.some(c=>c.id===id))fail(`그룹 '${id}'가 없습니다.`);
  }
  if(type==="setCaptureActive"&&!sim.capturePoints.some(c=>c.id===(a.id||a.captureId)))fail("점령지 참조가 없습니다.");
  if(type==="unlockUnit"&&!CampaignMissionDefinition.validProductionUnit(String(a.unit||"")))fail(`생산 해금할 수 없는 병종 '${a.unit}'`);
  if(["ping","cameraFocus"].includes(type)&&typeof a.region==="string"&&!Object.prototype.hasOwnProperty.call(runtime.mission.regions,a.region))fail(`지역 '${a.region}'가 없습니다.`);
  if(type==="spawnGroup"&&a.composition){for(const item of a.composition)if(!this.has(UnitDefinition.all,item.unit))fail(`병종 '${item.unit}'가 없습니다.`)}
 }
}

class CampaignMissionDefinition{
 static validProductionUnit(id){const d=UnitDefinition.get(id);return !!d&&d.tier>=1&&d.tier<=3&&!d.economyWorker&&!d.carrierSummon}
 static cleanUnits(v){return [...new Set((Array.isArray(v)?v:[]).filter(id=>this.validProductionUnit(id)))]}
 static cleanStartingUnits(v){return UnitCompositionDefinition.normalize(Array.isArray(v)?v:[]).filter(row=>this.validProductionUnit(row.unit))}
 static cleanResources(v){return Object.freeze({minerals:Math.max(0,Math.round(Number(v?.minerals)||0)),gas:Math.max(0,Math.round(Number(v?.gas)||0))})}
 static cleanStartingBuildings(v){return (Array.isArray(v)?v:[]).map((spec,i)=>{
   const o=typeof spec==="string"?{building:spec}:spec&&typeof spec==="object"?spec:null;if(!o)return null;
   const building=String(o.building||"");if(!BuildingDefinition.get(building)||BuildingDefinition.get(building)?.scenarioOnly)return null;
   const produceType=o.produceType==null?null:String(o.produceType);if(produceType&&!this.validProductionUnit(produceType))return null;
   return Object.freeze({id:String(o.id||`start-building-${i}`),building,produceType});
  }).filter(Boolean)}
 static normalizeSide(rawSide={}){
  const techCap=RangeUtil.clamp(Math.round(Number(rawSide.techCap)||1),1,3),startingTech=RangeUtil.clamp(Math.round(Number(rawSide.startingTech)||1),1,techCap);
  return Object.freeze({availableUnits:this.cleanUnits(rawSide.availableUnits),startingUnits:this.cleanStartingUnits(rawSide.startingUnits),startingWorkers:RangeUtil.clamp(Math.round(Number(rawSide.startingWorkers??STARTING_WORKER_COUNT)),0,30),startingResources:this.cleanResources(rawSide.startingResources),startingTech,startingBuildings:this.cleanStartingBuildings(rawSide.startingBuildings),defenseCards:DefenseCardDefinition.list(Array.isArray(rawSide.defenseCards)?rawSide.defenseCards:[]),techCap});
 }
 static normalize(raw){if(!raw||typeof raw!=="object"||Array.isArray(raw))throw new Error("Mission JS가 반환한 객체가 필요합니다.");
 CampaignContentValidator.validate(raw);
 const missionId=String(raw.missionId||"").trim();if(!missionId)throw new Error("missionId가 필요합니다.");
 const player=this.normalizeSide(raw.player),enemyBase=this.normalizeSide(raw.enemy),events=(Array.isArray(raw.events)?raw.events:[]).map((e,i)=>({id:String(e.id||`event-${i}`),enabled:e.enabled!==false,once:e.once!==false,when:e.when&&typeof e.when==="object"?CloneUtil.clone(e.when):null,delayMs:Math.max(0,Number(e.delayMs)||0),cooldownMs:Math.max(0,Number(e.cooldownMs)||0),repeatCount:e.repeatCount==null?null:Math.max(1,Math.round(Number(e.repeatCount)||1)),actions:(Array.isArray(e.actions)?e.actions:[]).map(a=>a&&typeof a==="object"?CloneUtil.clone(a):null).filter(Boolean)}));
 if(new Set(events.map(e=>e.id)).size!==events.length)throw new Error("중복된 캠페인 이벤트 ID입니다.");
 if(raw.map?.terrain?.blockers?.length||raw.map?.terrain?.layers?.length)CampaignMapDefinition.build(raw.map,GameRuleDefinition.resolve(),Number(raw.seed)||HashUtil.hash(missionId),raw.playerRole==="guest"?1:0);
 const offense=raw.enemy?.offense?Object.freeze({firstAttackMs:raw.enemy.offense.firstAttackMs,regroupMs:raw.enemy.offense.regroupMs,attackSize:raw.enemy.offense.attackSize,productionLimit:raw.enemy.offense.productionLimit??null,counterattackPoints:Object.freeze([...(raw.enemy.offense.counterattackPoints||[])])}):null;
 const moduleSource=CampaignModuleLoader.sourceOf(raw),enemy=Object.freeze({...enemyBase,offense,aiProfile:["standard","scripted"].includes(String(raw.enemy?.aiProfile||"standard"))?String(raw.enemy?.aiProfile||"standard"):"standard"});
 return Object.freeze({schemaVersion:CAMPAIGN_MISSION_SCHEMA_VERSION,moduleSource,missionId,playerRole:raw.playerRole==="guest"?"guest":"host",victory:CampaignOutcomeRules.normalize(raw.victory,raw.map),title:String(raw.title||missionId),briefing:String(raw.briefing||""),faction:String(raw.faction||"frontier"),seed:(Number(raw.seed)>>>0)||HashUtil.hash(missionId),map:raw.map&&typeof raw.map==="object"?CloneUtil.clone(raw.map):null,player,enemy,presentation:{opening:Array.isArray(raw.presentation?.opening)?raw.presentation.opening.map(String):[],outro:Array.isArray(raw.presentation?.outro)?raw.presentation.outro.map(String):[],hud:raw.presentation?.hud&&typeof raw.presentation.hud==="object"?CloneUtil.clone(raw.presentation.hud):null},regions:raw.regions&&typeof raw.regions==="object"?CloneUtil.clone(raw.regions):{},objectives:Array.isArray(raw.objectives)?CloneUtil.clone(raw.objectives):[],flags:raw.flags&&typeof raw.flags==="object"?CloneUtil.clone(raw.flags):{},events})}
}

class CampaignPresentation{
 static after(fn,ms){const id=setTimeout(()=>{this.timers.delete(id);fn()},ms);this.timers.add(id);return id}
 static shownMissionId=null; static shownSim=null; static timers=new Set(); static hudTimer=null; static flags=Object.create(null); static objectives=new Map(); static pingSeq=0; static lastPresentationId=0; static lastPresentationTick=0;
 static ensureBubble(){let el=document.getElementById("campaignStoryBubble");const host=document.querySelector("#gameScreen .canvas-wrap");if(el){if(host&&el.parentElement!==host)host.appendChild(el);return el}el=document.createElement("div");el.id="campaignStoryBubble";el.setAttribute("role","status");el.setAttribute("aria-live","polite");el.style.cssText="position:absolute;left:50%;bottom:18px;transform:translateX(-50%);z-index:30;width:max-content;max-width:min(760px,88%);box-sizing:border-box;padding:12px 16px;border:1px solid rgba(230,240,220,.5);border-radius:14px;background:rgba(15,28,24,.92);color:#f4f7ef;font:600 15px/1.45 system-ui;text-align:center;box-shadow:0 8px 28px rgba(0,0,0,.32);pointer-events:none;opacity:0;transition:opacity .18s ease";(host||document.body).appendChild(el);return el}
 static toast(text,duration=3200){const el=this.ensureBubble();el.textContent=String(text||"");el.style.opacity="1";this.after(()=>{el.style.opacity="0"},Math.max(900,Number(duration)||3200))}
 static clear(){this.shownMissionId=null;this.shownSim=null;for(const t of this.timers)clearTimeout(t);this.timers.clear();if(this.hudTimer){clearInterval(this.hudTimer);this.hudTimer=null}this.lastPresentationId=0;this.lastPresentationTick=0;this.flags=Object.create(null);this.objectives.clear();const el=document.getElementById("campaignStoryBubble");if(el)el.style.opacity="0";const hud=document.getElementById("campaignObjectives");if(hud)hud.remove();const shade=document.getElementById("campaignAtmosphere");if(shade)shade.remove();for(const p of document.querySelectorAll(".campaign-world-ping,.campaign-edge-ping"))p.remove();document.body.classList.remove("campaign-mode");if(UiRegistry.refs.reinforcementOverview){UiRegistry.refs.reinforcementOverview.style.left="";UiRegistry.refs.reinforcementOverview.style.right="";UiRegistry.refs.reinforcementOverview.style.top=""}}
 static region(def){const m=MatchLifecycle.activeSession?.()?.sim?.campaignScenario||CampaignRuntime.pending;if(typeof def==="string")return m?.regions?.[def]||null;return def&&typeof def==="object"?def:null}
 static phaseInfo(sim){const cfg=sim?.campaignScenario?.presentation?.hud?.phaseCycle;if(!cfg||!sim)return null;const cycle=Math.max(1,Number(cfg.cycleSeconds)||1),day=Math.max(0,Math.min(cycle,Number(cfg.daySeconds)||0)),elapsed=Math.max(0,sim.ticksMs(sim.tick)/1000-(Number(cfg.offsetSeconds)||0)),within=((elapsed%cycle)+cycle)%cycle,index=Math.floor(elapsed/cycle)+1,phase=within<day?"day":"night",remaining=phase==="day"?day-within:cycle-within;return{cfg,cycle,day,within,index,phase,remaining}}
 static counterInfo(sim){const cfg=sim?.campaignScenario?.presentation?.hud?.counter;if(!cfg||!sim)return null;const human=this.humanSide(),side=cfg.side==="player"?human:cfg.side==="neutral"?NEUTRAL_SIDE:1-human,group=String(cfg.objectiveGroup||"");const remaining=sim.buildings.filter(b=>b.alive!==false&&b.hp>0&&b.side===side&&(!group||b.campaignObjectiveGroup===group)).length,total=Math.max(remaining,Number(cfg.total)||remaining);return{remaining,total,label:String(cfg.label||"목표")}}
 static ensureAtmosphere(){let el=document.getElementById("campaignAtmosphere"),host=document.querySelector("#gameScreen .canvas-wrap");if(!el){el=document.createElement("div");el.id="campaignAtmosphere";el.style.cssText="position:absolute;inset:0;z-index:4;pointer-events:none;background:rgba(5,10,18,0);transition:background .25s linear";(host||document.body).appendChild(el)}return el}
 static renderAtmosphere(){const sim=MatchLifecycle.activeSession?.()?.sim,info=this.phaseInfo(sim),el=this.ensureAtmosphere();if(!info){el.style.background="rgba(5,10,18,0)";return}const max=RangeUtil.clamp(Number(info.cfg.maxNightOpacity)||.48,0,.72),dusk=Math.max(1,Number(info.cfg.duskSeconds)||25),dawn=Math.max(1,Number(info.cfg.dawnSeconds)||18);let opacity=0;if(info.phase==="night")opacity=max;else if(info.index>1&&info.within<dawn)opacity=max*(1-info.within/dawn);else if(info.within>info.day-dusk)opacity=max*RangeUtil.clamp((info.within-(info.day-dusk))/dusk,0,1);el.style.background=`rgba(5,10,18,${opacity.toFixed(3)})`}
 static renderObjectives(){let el=document.getElementById("campaignObjectives"),host=document.querySelector("#gameScreen .canvas-wrap");if(!el){el=document.createElement("div");el.id="campaignObjectives";el.style.cssText="position:absolute;left:7px;top:48px;z-index:29;width:min(250px,56%);box-sizing:border-box;padding:7px 9px;border-radius:8px;background:rgba(12,22,19,.84);border:1px solid rgba(220,235,215,.28);color:#eef4e8;font:600 10px/1.35 system-ui;pointer-events:none";(host||document.body).appendChild(el)}const sim=MatchLifecycle.activeSession?.()?.sim,phase=this.phaseInfo(sim),counter=this.counterInfo(sim);let head="";if(phase){const icon=phase.phase==="day"?"☀":"☾",label=phase.phase==="day"?String(phase.cfg.dayLabel||"낮"):String(phase.cfg.nightLabel||"밤"),secs=Math.max(0,Math.ceil(phase.remaining)),mm=String(Math.floor(secs/60)).padStart(2,"0"),ss=String(secs%60).padStart(2,"0"),progress=phase.phase==="day"?1-phase.remaining/Math.max(1,phase.day):1-phase.remaining/Math.max(1,phase.cycle-phase.day),accent=phase.phase==="day"?"#d7b65e":"#7ea2d8";head=`<div style="display:flex;align-items:center;justify-content:space-between;gap:7px;font-size:11px;font-weight:950"><span>${icon} ${label} · ${phase.index}주기</span><b>${mm}:${ss}</b></div><div style="height:3px;margin:5px 0 6px;background:#ffffff20;border-radius:999px;overflow:hidden"><i style="display:block;height:100%;width:${Math.round(RangeUtil.clamp(progress,0,1)*100)}%;background:${accent}"></i></div>`}let count="";if(counter)count=`<div style="margin-bottom:5px;color:#dce8d6;font-size:9px"><b>${counter.label}</b> · ${counter.remaining}/${counter.total} 남음</div>`;const obj=(sim?.campaignScriptRuntime?.scenario.objectives||[...this.objectives.values()]).filter(o=>o.state!=="hidden").map(o=>`<div style="margin-top:2px;opacity:${o.state==="complete"?.55:1}">${o.state==="complete"?"✓":"◆"} ${o.text}</div>`).join("");el.innerHTML=head+count+obj;el.style.display=el.innerHTML?"block":"none"}
 static ping(a){const r=ActiveViewState.renderer,host=document.querySelector("#gameScreen .canvas-wrap");if(!r||!host)return;const rg=this.region(a.region),p=rg?.center||a.position;if(!Array.isArray(p))return;const wx=(Number(p[0])||0)*r.world.width,wy=(Number(p[1])||0)*r.world.height,vx=r.viewX(wx),vy=r.viewY(wy),canvas=r.canvas,rect=canvas.getBoundingClientRect(),px=r.worldToPx(vx,vy),cx=px[0]/canvas.width*rect.width,cy=px[1]/canvas.height*rect.height,inside=cx>=8&&cx<=rect.width-8&&cy>=8&&cy<=rect.height-8,id=++this.pingSeq;let el=document.createElement("div");el.className=inside?"campaign-world-ping":"campaign-edge-ping";el.dataset.pingId=String(id);if(inside){el.style.cssText=`position:absolute;z-index:17;left:${cx}px;top:${cy}px;width:42px;height:42px;transform:translate(-50%,-50%);border:3px solid #f0c55b;border-radius:50%;box-shadow:0 0 0 8px #f0c55b24;pointer-events:none;animation:campaignPingPulse .72s ease-out 3`;}else{const ex=RangeUtil.clamp(cx,18,rect.width-18),ey=RangeUtil.clamp(cy,18,rect.height-18),dx=cx-rect.width/2,dy=cy-rect.height/2,angle=Math.atan2(dy,dx)*180/Math.PI;el.textContent="➤";el.style.cssText=`position:absolute;z-index:17;left:${ex}px;top:${ey}px;transform:translate(-50%,-50%) rotate(${angle}deg);color:#f0c55b;font-size:22px;font-weight:1000;text-shadow:0 1px 3px #000;pointer-events:none;animation:campaignEdgePulse .72s ease-in-out 3`;}host.appendChild(el);this.after(()=>el.remove(),2400)}
 static runAction(a){const type=String(a?.type||"");if(type==="ping"){this.ping(a);return}if(type==="toast"){this.toast(a.text,a.durationMs);return}if(type==="setFlag"){this.flags[String(a.id||"")]=a.value;return}if(type==="setObjective"){const id=String(a.id||"objective"),old=this.objectives.get(id)||{};this.objectives.set(id,{...old,id,text:String(a.text||old.text||id),state:String(a.state||"active")});this.renderObjectives();return}if(type==="completeObjective"){const id=String(a.id||""),old=this.objectives.get(id);if(old){this.objectives.set(id,{...old,state:"complete"});this.renderObjectives()}return}
  if(type==="cameraFocus"){const r=ActiveViewState.renderer;if(!r)return;const rg=this.region(a.region),p=rg?.center||a.position;if(!Array.isArray(p))return;const x=(Number(p[0])||0)*r.world.width,y=(Number(p[1])||0)*r.world.height,vx=r.viewX(x),vy=r.viewY(y);r.cameraLeft=RangeUtil.clamp(vx-r.viewWorldW()/2,0,Math.max(0,r.world.width-r.viewWorldW()));r.cameraTop=r.clampCameraTop(BattlefieldProjection.planarY(vy,r.world.terrain.surfaces.heightAt(x,y))-r.viewWorldH()/2);return}
  throw new Error(`시뮬레이션 액션은 CampaignScriptRuntime에서 실행해야 합니다: ${type}`);
 }
 static humanSide(){return (MatchLifecycle.activeSession?.()?.sim?.campaignScenario?.playerRole||"host")==="host"?0:1}
 static consume(snapshot){
  if(snapshot.tick<this.lastPresentationTick)this.lastPresentationId=0;
  this.lastPresentationTick=snapshot.tick;
  for(const e of snapshot.events||[]){
   if(e.type!=="campaignPresentation"||e.campaignEventId<=this.lastPresentationId)continue;
   this.lastPresentationId=e.campaignEventId;
   this.runAction(e.action);
  }
 }
 static onGameEnter(){const sim=MatchLifecycle.activeSession?.()?.sim,m=sim?.campaignScenario;if(!m){this.clear();return}if(this.shownSim===sim)return;this.clear();this.shownMissionId=m.missionId;this.shownSim=sim;document.body.classList.add("campaign-mode");if(UiRegistry.refs.reinforcementOverview){UiRegistry.refs.reinforcementOverview.style.left="auto";UiRegistry.refs.reinforcementOverview.style.right="7px";UiRegistry.refs.reinforcementOverview.style.top="62px"}this.flags={...(m.flags||{})};for(const o of m.objectives||[])this.objectives.set(String(o.id),{id:String(o.id),text:String(o.text||o.label||o.id),state:String(o.state||"active")});this.renderObjectives();this.renderAtmosphere();this.hudTimer=setInterval(()=>{this.renderObjectives();this.renderAtmosphere()},250);const humanRole=MatchLifecycle.singleMatch?.humanRole||ActiveViewState.role||"host",spawn=m.map?.spawns?.[humanRole];if(Array.isArray(spawn)){const focus=()=>{const renderer=ActiveViewState.renderer;if(!renderer)return;const x=(Number(spawn[0])||0)*sim.world.width,y=(Number(spawn[1])||0)*sim.world.height,vx=renderer.viewX(x),vy=renderer.viewY(y),left=RangeUtil.clamp(vx-renderer.viewWorldW()/2,0,Math.max(0,sim.world.width-renderer.viewWorldW())),top=renderer.clampCameraTop(BattlefieldProjection.planarY(vy,sim.world.terrain.surfaces.heightAt(x,y))-renderer.viewWorldH()/2);renderer.cameraLeft=left;renderer.cameraTop=top;if(ViewRuntimeState.byRole?.[ActiveViewState.role]){ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft=left;ViewRuntimeState.byRole[ActiveViewState.role].cameraTop=top}};focus();this.after(focus,120)}const lines=m.presentation?.opening||[],el=this.ensureBubble();lines.forEach((line,i)=>this.after(()=>{el.textContent=line;el.style.opacity="1"},i*3200));if(lines.length)this.after(()=>{el.style.opacity="0"},lines.length*3200+2600);}
 static outroDuration(lines){const n=Array.isArray(lines)?lines.filter(Boolean).length:0;return n? n*3200+350:0}
 static playOutro(lines,onDone){const seq=Array.isArray(lines)?lines.filter(Boolean):[];if(!seq.length){onDone?.();return 0}const el=this.ensureBubble();let total=0;for(const line of seq){this.after(()=>{el.textContent=String(line);el.style.opacity="1"},total);total+=3200}this.after(()=>{el.style.opacity="0"},Math.max(0,total-350));this.after(()=>onDone?.(),total+350);return total+350}
}

class CampaignBuiltinCatalog{
 static importPromise=null; static importAttempt=0;
 static async manifest(){
  if(!this.importPromise)this.importPromise=import(this.importAttempt?`../campaign/campaigns.js?retry=${this.importAttempt}`:"../campaign/campaigns.js").then(({default:manifest})=>{
   if(manifest?.schemaVersion!==CAMPAIGN_MANIFEST_SCHEMA_VERSION||!Array.isArray(manifest.campaigns))throw new Error("지원하지 않는 정식 캠페인 목록입니다.");
   return manifest;
  }).catch(error=>{this.importPromise=null;this.importAttempt++;throw error});
  return this.importPromise;
 }
}
class CampaignRuntime{
 static pending=null; static loadRevision=0; static setMission(raw,source=""){if(source&&raw&&typeof raw==="object")Object.defineProperty(raw,"__moduleSource",{value:String(source),enumerable:false,configurable:true});this.pending=CampaignMissionDefinition.normalize(raw);return this.pending} static clear(){this.pending=null;this.loadRevision++}
 static matchConfig(){const m=this.pending;if(!m)return null;return {presetId:"standard",simulationTps:UiRuntimeState.value.settings.simulationTps,campaignScenario:m}}
}
class MatchLifecycle{
  static localTest=null;
  static singleMatch=null;

  static activeSession(){if(ReplayPresentation.replayPlayer)return ReplayPresentation.replayPlayer;return LocalEnvironmentUtil.isLocalTest()?MatchLifecycle.localTest.sessions[ActiveViewState.role]:ActiveViewState.session}
  static setActiveSession(){
  if(LocalEnvironmentUtil.isLocalTest()){ActiveViewState.session=MatchLifecycle.localTest.sessions[ActiveViewState.role];ActiveViewState.transport=MatchLifecycle.localTest.transports[ActiveViewState.role]}
}
  static currentMatchConfig(){
  if(CampaignRuntime.pending)return CampaignRuntime.matchConfig();
  return {presetId:UiRuntimeState.value.settings.presetId,simulationTps:UiRuntimeState.value.settings.simulationTps,debugScenario:DebugScenarioHarness.pending?DebugScenarioHarness.normalize(DebugScenarioHarness.pending):null};
}
  static wireSessionForView(r,sess,trans){
  sess.onDraft=state=>{
    sess.draft=state;
    const debugScenario=!!sess.matchConfig?.debugScenario;
    if(LocalEnvironmentUtil.isLocalTest())ViewRuntimeState.byRole[r].draft=state;
    if(ActiveViewState.role===r&&debugScenario&&!sess.sim){
      UiRegistry.refs.singleStatus.textContent=state?.phase==="live"?"테스트 전투 시작 중…":"테스트 초기조건 준비 중…";
      UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
    }

  };
  sess.onSnapshot=state=>{
    if(LocalEnvironmentUtil.isLocalTest())ViewRuntimeState.byRole[r].snapshot=state;
    if(ActiveViewState.role===r)BattlePresentation.renderGame(state);
  };
  sess.onRenderTargets=(sim,snapNow=false)=>{
    if(ActiveViewState.role===r&&ActiveViewState.renderer)ActiveViewState.renderer.updatePresentationTargets(sim,!!snapNow);
  };
  sess.onLog=text=>{if(ActiveViewState.role===r)LogUtil.log(text)};
  sess.onNetworkHealth=info=>{
    const visibleForRole=ActiveViewState.role===r;
    if(!visibleForRole&&!LocalEnvironmentUtil.isLocalTest())return;

    if(visibleForRole)ConnectionPresentation.renderP2PHealth(info,LocalEnvironmentUtil.isLocalTest());

    if(info?.state==="fatal"){
      const fatal=info.simulationFatalInfo||{};
      UiRegistry.refs.net.textContent="시뮬레이션 오류로 일시 중단됨";
      if(SinglePlayerModeUtil.isSinglePlayer()){
        UiRegistry.refs.singleStatus.textContent="시뮬레이션 오류 · 안전을 위해 경기를 중단했습니다.";
        UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
      }
      LogUtil.log(`⚠ 시뮬레이션 오류 · ${(fatal.role||r).toUpperCase()} tick ${fatal.localTick??fatal.tick??"-"} · ${fatal.message||"unknown"}`);
      return;
    }

    if(!visibleForRole)return;

    if(
      info?.state==="connected" &&
      sess.sim &&
      !sess.syncHold &&
      sess.recoveryPhase==="idle"
    ){
      UiRegistry.refs.net.textContent=SinglePlayerModeUtil.isSinglePlayer()
        ?"싱글 · 공통 코어 재연결 완료 · 게임 재개"
        :"공통 코어 재연결 완료 · 연결됨";

      if(SinglePlayerModeUtil.isSinglePlayer()){
        UiRegistry.refs.singleStatus.textContent=`복구 완료 · ${r==="host"?"내":"AI"} Host 권위 상태와 일치 · 게임 재개`;
        UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
      }
    }
  };
  sess.onResult=(w,reason="base-destroyed")=>{
    // Authoritative result must not depend on which role is currently displayed.
    MatchLifecycle.presentMatchResult(w,reason,r);
  };

  trans.onPeerReady=()=>{
    if(ActiveViewState.role!==r)return;
    if(SinglePlayerModeUtil.isSinglePlayer()){
      UiRegistry.refs.net.textContent="싱글 · AI WebRTC 연결 준비";
      UiRegistry.refs.singleStatus.textContent="AI용 WebRTC 피어를 연결하고 있습니다…";
      UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
    }else if(!LocalEnvironmentUtil.isLocalTest()){
      UiRegistry.refs.net.textContent="방 "+ActiveViewState.roomCode+" · 상대 대기";
      if(r==="host")UiRegistry.refs.createStatus.textContent="방이 열렸습니다. 상대 참가를 기다립니다.";
    }
  };
  trans.onOpen=()=>{
    // DataChannel open is only transport readiness. During recovery the match
    // is NOT "connected" until Host snapshot READY/RUN finishes.
    sess.localVisible=document.visibilityState==="visible";
    sess.onTransportOpen();

    if(ActiveViewState.role===r){
      const recovering=!!(
        sess.sim&&
        (sess.syncHold||sess.recoveryPhase!=="idle")
      );

      UiRegistry.refs.net.textContent=LocalEnvironmentUtil.isLocalTest()
        ?"로컬 테스트 · "+r.toUpperCase()+" 화면"
        :SinglePlayerModeUtil.isSinglePlayer()
          ?recovering
            ?"싱글 · 새 DataChannel 연결됨 · 공통 코어 입력 동기화 중"
            :`싱글 · ${r.toUpperCase()} 테스트 · AI ${(MatchLifecycle.singleMatch?.botRole||"guest").toUpperCase()} 연결됨`
          :recovering
            ?"새 DataChannel 연결됨 · 공통 코어 입력 동기화 중"
            :"연결됨 · "+ActiveViewState.roomCode;

      if(!LocalEnvironmentUtil.isLocalTest()){
        UiController.closeUiModal("create");
        UiController.closeUiModal("join");
      }

      if(SinglePlayerModeUtil.isSinglePlayer()){
        UiRegistry.refs.singleStatus.textContent=recovering
          ?"새 WebRTC 채널 연결 완료 · Host 게임 상태 복원 중"
          :`내 역할 ${r.toUpperCase()} · AI ${(MatchLifecycle.singleMatch?.botRole||"guest").toUpperCase()}와 실제 WebRTC 연결 완료`;
        UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
      }
    }

    AppLifecycle.requestScreenWakeLock();
  };
  trans.onError=e=>{
    if(e?.type==="version-mismatch"){ConnectionPresentation.showVersionMismatch(e,r);return}
    if(ActiveViewState.role===r){
      const message=e.message||e.type||"연결 오류";
      UiRegistry.refs.net.textContent="연결 오류";
      if(SinglePlayerModeUtil.isSinglePlayer()){
        if(trans.everOpened){
          UiRegistry.refs.singleStatus.textContent="WebRTC 복구 중 · "+message;
          UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
        }else{
          MatchLifecycle.failSinglePlayer("싱글 WebRTC 연결 실패 · 다시 시도해 주세요: "+message);
        }
      }else if(r==="host"){
        UiRegistry.refs.createStatus.textContent="방 연결에 실패했습니다: "+message;
        UiController.setElementVisible(UiRegistry.refs.createRetry,true);
      }else{
        const friendly=(message==="signal-timeout"||message==="nostr-module-unavailable")
          ?"해당 방을 찾을 수 없습니다. 방 코드와 방장이 아직 접속 중인지 확인해 주세요."
          :"연결에 실패했습니다: "+message;
        UiRegistry.refs.joinError.textContent=friendly;
        UiRegistry.refs.joinConfirm.disabled=false;
        UiRegistry.refs.joinConfirm.textContent="참가하기";
      }
    }
  };
  trans.onClose=()=>{
    sess.onTransportClosed();
    if(ActiveViewState.role===r){
      UiRegistry.refs.net.textContent=SinglePlayerModeUtil.isSinglePlayer()
        ?"싱글 · 연결 끊김 · 게임 정지 · 복구 버튼 필요"
        :"P2P 연결 끊김 · 게임 정지 · 복구 버튼 필요";

      if(SinglePlayerModeUtil.isSinglePlayer()){
        UiRegistry.refs.singleStatus.textContent="연결이 끊겼습니다 · 복구 버튼으로 Host 권위 스냅샷을 기준으로 새 연결을 만드세요.";
        UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
      }
    }
  };
}
  static disposeMatches(reason="mode-change"){
    GasWorkerAssignmentPolicy.clearPendingGasWorkerTargets();
    CampaignPresentation.clear();
    const sessions=new Set([ActiveViewState.session,
      ...Object.values(this.localTest?.sessions||{}),...Object.values(this.singleMatch?.sessions||{})].filter(Boolean));
    this.singleMatch?.bot?.stop();
    const errors=[];
    for(const session of sessions){try{session.dispose(reason)}catch(error){errors.push(error)}}
    this.localTest=null;this.singleMatch=null;
    ActiveViewState.session=null;ActiveViewState.transport=null;ActiveViewState.snap=null;
    if(errors.length)throw new AggregateError(errors,"세션 종료 처리 중 오류가 발생했습니다.");
  }
  static connect(r,c){
  MatchLifecycle.disposeMatches("online-start");
  CampaignRuntime.clear();
  DebugScenarioHarness.pending=null;
  CampaignPresentation.clear();
  MatchLifecycle.localTest=null;
  MatchLifecycle.singleMatch=null;
  ConnectionPresentation.hideP2PHealth();
  UiRegistry.refs.testSwitcher.classList.add("hidden");
  ActiveViewState.role=r;ActiveViewState.roomCode=c;
  UiController.invalidatePanelHtmlCaches({reinforcement:true});
  UiController.setUiCommand({branch:"closed"});
  UiController.setUiCommand({category:"economy",page:null});
  UiRegistry.refs.net.textContent="연결 중…";
  ActiveViewState.transport=new NostrRtcTransport(r,c);
  ActiveViewState.session=new GameSession(r,ActiveViewState.transport,c,r==="host"?MatchLifecycle.currentMatchConfig():null);
  MatchLifecycle.wireSessionForView(r,ActiveViewState.session,ActiveViewState.transport);
  ActiveViewState.transport.open();
}
  static startLocalTest(){
  if(MatchLifecycle.localTest)return;
  UiController.closeUiModal();
  MatchLifecycle.disposeMatches("local-start");

  MatchLifecycle.singleMatch=null;
  ConnectionPresentation.hideP2PHealth();
  NetworkModuleLoader.pendingPeerAction=null;
  UiController.closeUiModal("create");
  UiController.closeUiModal("join");
  ActiveViewState.roomCode="TEST";
  ActiveViewState.role="host";
  UiRuntimeState.value.selection.unit=null;
  UiRuntimeState.value.target={type:"flag"};
  UiController.setUiCommand({branch:"closed"});
  UiController.setUiCommand({category:"economy",page:null});
  ActiveViewState.snap=null;
  UiController.setUiScreen("lobby");
  UiRegistry.refs.testSwitcher.classList.remove("hidden");

  const hostTransport=new LoopbackTransport("host",ActiveViewState.roomCode);
  const guestTransport=new LoopbackTransport("guest",ActiveViewState.roomCode);
  hostTransport.pair(guestTransport);
  guestTransport.pair(hostTransport);

  const hostSession=new GameSession("host",hostTransport,ActiveViewState.roomCode,MatchLifecycle.currentMatchConfig());
  const guestSession=new GameSession("guest",guestTransport,ActiveViewState.roomCode);

  MatchLifecycle.localTest={
    transports:{host:hostTransport,guest:guestTransport},
    sessions:{host:hostSession,guest:guestSession}
  };

  ViewRuntimeState.byRole.host={draft:null,snapshot:null,cameraLeft:0,cameraTop:WorldContext.standard.height-VIEW_H,selection:{unit:null,buildingId:null},target:{type:"flag"}};
  ViewRuntimeState.byRole.guest={draft:null,snapshot:null,cameraLeft:0,cameraTop:WorldContext.standard.height-VIEW_H,selection:{unit:null,buildingId:null},target:{type:"flag"}};

  MatchLifecycle.wireSessionForView("host",hostSession,hostTransport);
  MatchLifecycle.wireSessionForView("guest",guestSession,guestTransport);

  MatchLifecycle.setActiveSession();
  UiController.setRoleSwitcherActive("host");
  UiRegistry.refs.net.textContent="로컬 테스트 연결 중… · "+(ActiveViewState.renderer?.backend||"WebGL");

  // 실전처럼 양쪽 transport가 각각 open 되고 GameSession.start()가 호출된다.
  hostTransport.open();
  guestTransport.open();
}
  static singleRoomToken(){
  return "AI"+Date.now().toString(36)+Math.random().toString(36).slice(2,8);
}
  static stopSinglePlayer(){
    if(!this.singleMatch)return;
    MatchLifecycle.disposeMatches("single-stop");
  }
  static startSinglePlayerWebRTC(humanRole="guest"){
  if(MatchLifecycle.singleMatch)return;
  MatchLifecycle.disposeMatches("single-start");

  humanRole=humanRole==="host"?"host":"guest";
  const botRole=humanRole==="host"?"guest":"host";
  if(DebugScenarioHarness.pending)DebugScenarioHarness.pending={...DebugScenarioHarness.pending,humanRole};

  ConnectionPresentation.hideP2PHealth();
  NetworkModuleLoader.pendingPeerAction=null;
  MatchLifecycle.localTest=null;
  UiController.closeUiModal("create");
  UiController.closeUiModal("join");

  const token=MatchLifecycle.singleRoomToken();
  ActiveViewState.roomCode=token;
  ActiveViewState.role=humanRole;

  UiRuntimeState.value.selection.unit=null;
  UiRuntimeState.value.selection.buildingId=null;
  UiRuntimeState.value.target={type:"flag"};
  UiController.setUiCommand({branch:"closed"});
  UiController.setUiCommand({category:"economy",page:null});
  ActiveViewState.snap=null;
  UiController.invalidatePanelHtmlCaches({unit:true,reinforcement:true});

  UiController.setUiScreen("lobby");
  UiRegistry.refs.testSwitcher.classList.add("hidden");
  UiRegistry.refs.singleStatus.textContent=`${humanRole.toUpperCase()} 테스트용 실제 WebRTC 양쪽 피어를 준비하고 있습니다…`;
  UiController.setElementVisible(UiRegistry.refs.singleStatus,true);

  const hostTransport=new NostrRtcTransport("host",token,{signalMode:"local"});
  const guestTransport=new NostrRtcTransport("guest",token,{signalMode:"local"});
  const transports={host:hostTransport,guest:guestTransport};
  const humanTransport=transports[humanRole];
  const botTransport=transports[botRole];
  const config=MatchLifecycle.currentMatchConfig(),configFor=role=>role==="host"?config:undefined;
  const humanSession=new GameSession(humanRole,humanTransport,token,configFor(humanRole));
  // CONFIG.single.botWorker runs the AI session in src/sim-worker.js; its WebRTC transport stays here.
  const botSession=CONFIG.single.botWorker
    ?new WorkerSessionProxy(botRole,botTransport,token,configFor(botRole))
    :new GameSession(botRole,botTransport,token,configFor(botRole));
  const sessions={[humanRole]:humanSession,[botRole]:botSession};
  const bot=CONFIG.single.botWorker?null:BotController.attach(botSession,botRole);
  if(CONFIG.single.botWorker)botSession.onFatal=e=>MatchLifecycle.failSinglePlayer(`AI ${botRole.toUpperCase()} Worker 오류 · ${e.message}`);

  MatchLifecycle.singleMatch={
    roomCode:token,
    humanRole,
    botRole,
    recoveryInitiatorRole:humanRole,
    transports,
    sessions,
    bot
  };

  ActiveViewState.session=humanSession;
  ActiveViewState.transport=humanTransport;
  MatchLifecycle.wireSessionForView(humanRole,humanSession,humanTransport);

  botTransport.onOpen=()=>{
    botSession.localVisible=document.visibilityState==="visible";
    botSession.onTransportOpen();
    AppLifecycle.requestScreenWakeLock();
  };

  botTransport.onError=e=>{
    if(e?.type==="version-mismatch"){ConnectionPresentation.showVersionMismatch(e,botRole);return}
    const message=e?.type||e?.message||`AI ${botRole.toUpperCase()} 연결 오류`;
    if(botTransport.everOpened){
      UiRegistry.refs.singleStatus.textContent=`AI ${botRole.toUpperCase()} WebRTC 복구 필요 · ${message}`;
      UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
    }else{
      MatchLifecycle.failSinglePlayer(`AI ${botRole.toUpperCase()} WebRTC 연결 실패 · 다시 시도해 주세요: ${message}`);
    }
  };
  botTransport.onClose=()=>botSession.onTransportClosed();

  // 싱글은 Host RTCPeerConnection signaling endpoint를 먼저 연 뒤 Guest가 참가한다.
  hostTransport.onPeerReady=()=>{
    if(humanRole==="host"){
      UiRegistry.refs.singleStatus.textContent="내 Host 방 준비 완료 · AI Guest가 실제 WebRTC로 참가 중…";
    }else{
      UiRegistry.refs.singleStatus.textContent="AI Host 준비 완료 · 내 Guest가 실제 WebRTC로 참가 중…";
    }
    guestTransport.open();
  };

  // A Worker-hosted AI loads main.js first; open the link once it can answer, or the
  // human's core reads the load time as an interrupted peer.
  if(CONFIG.single.botWorker)void botSession.ready.then(()=>{if(!botSession.disposed)hostTransport.open()});
  else hostTransport.open();
}
  static beginCreateRoom(){
  const c=RoomCodeUtil.randomCode();
  UiRegistry.refs.code.textContent=c;
  UiRegistry.refs.codeArea.classList.add("hidden");
  UiController.setElementVisible(UiRegistry.refs.createRetry,false);
  UiRegistry.refs.createStatus.textContent="방을 준비하고 있습니다…";

  ConnectionPresentation.runWhenNetworkReady(
    ()=>{
      NetworkModuleLoader.pendingPeerAction=null;
      UiRegistry.refs.codeArea.classList.remove("hidden");
      UiRegistry.refs.createStatus.textContent="방이 열렸습니다 · 상대 참가를 기다립니다.";
      MatchLifecycle.connect("host",c);
    },
    (msg,failed)=>{
      UiRegistry.refs.createStatus.textContent=msg;
      UiController.setElementVisible(UiRegistry.refs.createRetry,!!failed);
    }
  );
}
  static submitJoinRoom(){
  const c=UiRegistry.refs.room.value.replace(/\D/g,"").slice(0,4);
  UiRegistry.refs.room.value=c;

  if(c.length!==4){
    UiRegistry.refs.joinError.textContent="4자리 숫자 코드를 입력해 주세요.";
    return;
  }

  audioSystem.unlock();
  UiRegistry.refs.joinError.textContent="";
  UiRegistry.refs.joinConfirm.disabled=true;
  UiRegistry.refs.joinConfirm.textContent="연결 준비 중…";

  ConnectionPresentation.runWhenNetworkReady(
    ()=>{
      NetworkModuleLoader.pendingPeerAction=null;
      UiRegistry.refs.joinConfirm.disabled=false;
      UiRegistry.refs.joinConfirm.textContent="참가하기";
      MatchLifecycle.connect("guest",c);
    },
    (msg,failed)=>{
      UiRegistry.refs.joinConfirm.disabled=false;
      UiRegistry.refs.joinConfirm.textContent="참가하기";
      UiRegistry.refs.joinError.textContent=msg;
      if(failed)NetworkModuleLoader.networkLoadError=msg;
    }
  );
}
  static requestMatchSurrender({leave=false}={}){
  const active=RecoveryTelemetry.localRecoverySession?.()||MatchLifecycle.activeSession?.();
  if(!active||active.simEnded)return false;
  const ok=window.confirm(leave?"진행 중인 게임에서 나가면 패배 처리됩니다. 나갈까요?":"항복하면 패배 처리됩니다. 항복할까요?");
  if(!ok)return false;
  if(!active.surrender())return false;
  active.leaveAfterResult=!!leave;
  MatchLifecycle.closeMatchMenu();
  return true;
}
  static presentMatchResult(winner,reason="base-destroyed",sourceRole=null){
  const humanRole=SinglePlayerModeUtil.isSinglePlayer()?(MatchLifecycle.singleMatch?.humanRole||ActiveViewState.role):ActiveViewState.role;
  const viewRole=humanRole==="host"?"host":"guest";
  MatchLifecycle.closeMatchMenu();
  if(UiRuntimeState.value.modal==="disconnect")UiController.closeUiModal("disconnect");
  ConnectionPresentation.setDisconnectPhase("hidden");
  const draw=reason==="draw"||!winner,mine=!draw&&winner===viewRole;
  UiRegistry.refs.resultTitle.textContent=draw?"무승부":mine?"승리":"패배";
  if(reason==="surrender")UiRegistry.refs.resultText.textContent=mine?"상대가 항복했습니다.":"항복했습니다.";
  else if(reason==="disconnect-timeout")UiRegistry.refs.resultText.textContent="연결을 60초 안에 복구하지 못해 경기가 중단되었습니다.";
  else if(reason==="draw")UiRegistry.refs.resultText.textContent="양쪽 메인 거점이 같은 tick에 파괴되었습니다.";
  else if(reason==="campaign-objectives"||reason==="campaign-trigger")UiRegistry.refs.resultText.textContent=mine?"미션 목표를 모두 완료했습니다.":"미션 방어에 실패했습니다.";
  else UiRegistry.refs.resultText.textContent=mine?"적 메인 거점을 파괴했습니다.":"내 메인 거점이 파괴되었습니다.";
  const end=ActiveViewState.snap,stats=end?.launchStats,mySide=ConnectionSideUtil.roleSide(viewRole);
  if(stats)LaunchScreens.renderResult({durationMs:1000*end.tick/(end.tps||SimulationTiming.tps()),launches:stats.launches[mySide],sent:stats.sent[mySide],kills:stats.kills[mySide]});
  const replayReady=!!ReplayPresentation.replaySourceSession()?.replayRecorder?.result;
  if(UiRegistry.refs.replaySaveBtn)UiRegistry.refs.replaySaveBtn.disabled=!replayReady;
  if(UiRegistry.refs.replayWatchBtn)UiRegistry.refs.replayWatchBtn.disabled=!replayReady;
  UiController.setUiScreen("result");
  requestAnimationFrame(()=>UiRegistry.refs.result?.focus?.({preventScroll:true}));
}
  static failSinglePlayer(message){
  MatchLifecycle.disposeMatches("single-start-failed");
  UiRuntimeState.value.settings.presetId="standard";
  UiRegistry.refs.singleStatus.textContent=message;
UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
}
  static openMatchMenu(){
  if(ReplayPresentation.replayPlayer){
    if(UiRegistry.refs.matchMenuReplaySaveBtn)UiRegistry.refs.matchMenuReplaySaveBtn.disabled=true;
    if(UiRegistry.refs.matchMenuSurrenderBtn)UiRegistry.refs.matchMenuSurrenderBtn.classList.add("hidden");
    if(UiRegistry.refs.matchMenuLeaveBtn){UiRegistry.refs.matchMenuLeaveBtn.classList.remove("hidden");UiRegistry.refs.matchMenuLeaveBtn.textContent="리플레이 종료"}
    if(UiRegistry.refs.matchMenuWarning)UiRegistry.refs.matchMenuWarning.textContent="리플레이 재생은 경기 결과에 영향을 주지 않습니다.";
    UiController.openUiModal("match-menu");
    return;
  }
  UiRegistry.refs.matchMenuSurrenderBtn?.classList.remove("hidden");
  // A live launch match leaves only by surrender; the leave button is for ending a replay.
  UiRegistry.refs.matchMenuLeaveBtn?.classList.add("hidden");
  const active=RecoveryTelemetry.localRecoverySession?.()||MatchLifecycle.activeSession?.();
  if(!active||active.simEnded)return;
  const replayReady=!!active.replayRecorder;
  if(UiRegistry.refs.matchMenuReplaySaveBtn)UiRegistry.refs.matchMenuReplaySaveBtn.disabled=!replayReady;
  if(UiRegistry.refs.matchMenuWarning)UiRegistry.refs.matchMenuWarning.textContent=active.sim?"진행 중인 경기에서 항복하거나 나가면 패배 처리됩니다.":"드래프트 중 항복하거나 나가도 패배 처리됩니다.";
  UiController.openUiModal("match-menu");
}
  static closeMatchMenu(){UiController.closeUiModal("match-menu")}
}

// Worker side of a single-player AI peer: the same GameSession + BotController
// as the in-page path. Its transport is a mirror of the AI's real WebRTC
// transport, which stays on the main thread (Workers have no RTCPeerConnection).
class SimWorkerHost{
  static STATUS_MS=250;
  // Session calls the main thread may forward.
  static SESSION_CALLS=new Set(["setTestModePaused","setLocalVisibility","markManualRecoveryNeeded","prepareSimpleRecovery","startSimpleRecovery","balanceTelemetry"]);
  static session=null;static bot=null;static transport=null;static statusTimer=0;
  static install(){
    self.onmessage=e=>{
      const m=e.data;
      if(m?.type==="start")this.start(m);
      else if(m?.type==="transport")this.transport?.receive(m);
      else if(m?.type==="call")this.call(m);
      else if(m?.type==="dispose")this.dispose(m.reason);
    };
    self.postMessage({type:"ready"});
  }
  static start({role,token,config,netcodeState,netcodeMode}){
    if(netcodeMode)UiController.setStartNetcodeMode(netcodeMode);
    const transport=new WorkerRelayTransport(role,token,netcodeState),session=new GameSession(role,transport,token,config??undefined);
    this.transport=transport;this.session=session;this.bot=BotController.attach(session,role);
    transport.onOpen=visible=>{session.localVisible=visible;session.onTransportOpen()};
    transport.onClose=()=>session.onTransportClosed();
    this.statusTimer=setInterval(()=>this.publishStatus(),this.STATUS_MS);
  }
  static call({id,method,args}){
    let result=null;
    if(this.session&&this.SESSION_CALLS.has(method))try{result=this.session[method](...(args||[]))}catch(error){self.postMessage({type:"error",message:String(error?.message||error)})}
    if(id)self.postMessage({type:"result",id,result:result??null});
    this.publishStatus();
  }
  static publishStatus(){
    const s=this.session;if(!s)return;
    const core=s.netcodeSession;
    self.postMessage({type:"status",tick:s.sim?.tick??0,simEnded:!!s.simEnded,transportConnected:!!s.transportConnected,perfStats:s.sim?.perfStats||null,timings:s.performanceStats?.timings||{},
      netcode:core?{ready:!!core.ready,status:core.status,metrics:core.metrics}:null,
      recovery:{phase:s.recoveryPhase||"idle",needsManual:!!s.simpleRecoveryNeedsManual,token:s.simpleRecoveryToken||"",syncHold:!!s.syncHold}});
  }
  static dispose(reason){
    clearInterval(this.statusTimer);this.bot?.stop();
    try{this.session?.dispose(reason)}finally{this.session=null;this.bot=null;this.transport=null;self.close()}
  }
}
// The Worker session's view of the AI's main-thread WebRTC transport: state is
// mirrored from WorkerSessionProxy, sends and recovery calls are relayed to it.
class WorkerRelayTransport{
  constructor(role,roomCode,netcodeState){
    this.role=role;this.roomCode=roomCode;this.connected=false;this.netcodeState=netcodeState||"closed";
    this.netcodeListeners=new Set();this.netcodeStatusListeners=new Set();
    this.onMessage=()=>{};this.onPeerReady=()=>{};this.onOpen=()=>{};this.onClose=()=>{};this.onError=()=>{};
  }
  receive({event,data,state,visible}){
    if(event==="open"){this.connected=true;this.onOpen(visible)}
    else if(event==="close"){this.connected=false;this.onClose()}
    else if(event==="message")this.onMessage(data);
    else if(event==="packet")for(const listener of this.netcodeListeners){try{listener(data)}catch(error){this.onError(error)}}
    else if(event==="netcode-state"){this.netcodeState=state;for(const listener of this.netcodeStatusListeners)listener(state)}
  }
  relay(op,payload,transfer){self.postMessage({type:"transport",op,...payload},transfer||[])}
  isOpen(){return this.connected}
  isNetcodeOpen(){return this.netcodeState==="open"}
  get netcodeBufferedAmount(){return 0}
  send(message){if(!this.connected)return false;this.relay("send",{data:message});return true}
  sendNetcode(packet){
    if(!(packet instanceof Uint8Array)||!this.isNetcodeOpen())return false;
    const copy=packet.slice();this.relay("send-netcode",{data:copy},[copy.buffer]);return true;
  }
  subscribeNetcode(listener){this.netcodeListeners.add(listener);return ()=>this.netcodeListeners.delete(listener)}
  subscribeNetcodeStatus(listener){this.netcodeStatusListeners.add(listener);return ()=>this.netcodeStatusListeners.delete(listener)}
  prepareRecoveryHost(reason){this.relay("call",{method:"prepareRecoveryHost",args:[reason]});return this.role==="host"}
  rebuildRecoveryGuest(reason){this.relay("call",{method:"rebuildRecoveryGuest",args:[reason]});return this.role==="guest"}
  forceReconnect(reason){this.relay("call",{method:"forceReconnect",args:[reason]});return true}
  // The main thread owns the WebRTC transport and closes it with the proxy.
  close(){this.netcodeListeners.clear();this.netcodeStatusListeners.clear()}
}
// Main-thread stand-in for the AI GameSession in SimWorkerHost. It keeps the AI's
// real WebRTC transport here, relays its traffic to the Worker, mirrors the state
// the UI and recovery read (every STATUS_MS and after each call) and forwards
// session calls. Forwarded calls answer true once sent; the outcome arrives as status.
class WorkerSessionProxy{
  static TRANSPORT_CALLS=new Set(["prepareRecoveryHost","rebuildRecoveryGuest","forceReconnect"]);
  constructor(role,transport,token,config){
    this.role=role;this.roomCode=token;this.transport=transport;this.sim=null;this.netcodeSession=null;this.performanceStats={timings:{}};this.statusMessages=0;
    this.simEnded=false;this.disposed=false;this.transportConnected=false;this.syncHold=true;this.simpleRecoverySeq=0;this.localVisible=true;
    this.recoveryPhase="idle";this.simpleRecoveryNeedsManual=false;this.simpleRecoveryToken="";this.onFatal=()=>{};
    this.pending=new Map();this.nextCallId=0;this.started=false;this.outbox=[];
    this.ready=new Promise(resolve=>this.resolveReady=resolve);
    // Relay traffic for diagnostics: control messages are structured-cloned, netcode packets are moved.
    this.traffic={sentMessages:0,sentPackets:0,sentPacketBytes:0,receivedMessages:0,receivedPackets:0,receivedPacketBytes:0};
    transport.onMessage=data=>{this.traffic.receivedMessages++;this.toTransport("message",{data})};
    this.detachTransport=[
      transport.subscribeNetcode(packet=>{const copy=packet.slice();this.traffic.receivedPackets++;this.traffic.receivedPacketBytes+=copy.byteLength;this.toTransport("packet",{data:copy},[copy.buffer])}),
      transport.subscribeNetcodeStatus(state=>this.toTransport("netcode-state",{state}))
    ];
    this.worker=new Worker(new URL("./sim-worker.js",import.meta.url),{type:"module"});
    this.worker.onmessage=e=>{
      const m=e.data;
      if(m?.type==="ready"){
        // The WebRTC link may open before the Worker has loaded main.js; hold what it sent until then.
        // The Worker realm has its own CONFIG: hand it the page's sync mode, or both peers fail the handshake.
        this.worker.postMessage({type:"start",role,token,config,netcodeState:transport.netcodeState,netcodeMode:CONFIG.netcode.mode});this.started=true;
        for(const [message,transfer] of this.outbox)this.worker.postMessage(message,transfer);this.outbox.length=0;this.resolveReady();
      }
      else if(m?.type==="transport")this.fromTransport(m);
      else if(m?.type==="status")this.applyStatus(m);
      else if(m?.type==="result"){this.pending.get(m.id)?.(m.result);this.pending.delete(m.id)}
      else if(m?.type==="fatal"||m?.type==="error")this.onFatal(m);
    };
    this.worker.onerror=e=>this.onFatal({message:e.message||"worker error"});
  }
  post(message,transfer=[]){if(this.started)this.worker.postMessage(message,transfer);else this.outbox.push([message,transfer])}
  toTransport(event,payload,transfer){if(!this.disposed)this.post({type:"transport",event,...payload},transfer)}
  fromTransport({op,data,method,args}){
    if(this.disposed)return;
    if(op==="send"){if(this.transport.send(data))this.traffic.sentMessages++}
    else if(op==="send-netcode"){if(this.transport.sendNetcode(data)){this.traffic.sentPackets++;this.traffic.sentPacketBytes+=data.byteLength}}
    else if(op==="call"&&WorkerSessionProxy.TRANSPORT_CALLS.has(method))this.transport[method]?.(...(args||[]));
  }
  // The single-player wiring calls these from the AI transport's onOpen/onClose, as for a GameSession.
  onTransportOpen(){this.toTransport("open",{visible:this.localVisible})}
  onTransportClosed(){this.toTransport("close")}
  applyStatus(m){
    this.statusMessages++;this.simEnded=m.simEnded;this.transportConnected=m.transportConnected;this.performanceStats.timings=m.timings;
    this.recoveryPhase=m.recovery.phase;this.simpleRecoveryNeedsManual=m.recovery.needsManual;this.simpleRecoveryToken=m.recovery.token;this.syncHold=m.recovery.syncHold;
    // Readers test sim/netcodeSession presence and identity the way they do for an in-page session.
    if(m.tick>0||m.perfStats){this.sim||={tick:0,perfStats:null};this.sim.tick=m.tick;this.sim.perfStats=m.perfStats}
    this.netcodeSession=m.netcode;
  }
  forward(method,args=[]){
    if(this.disposed)return false;
    this.post({type:"call",method,args});return true;
  }
  request(method,args=[]){
    if(this.disposed)return Promise.resolve(null);
    const id=++this.nextCallId;
    return new Promise(resolve=>{this.pending.set(id,resolve);this.post({type:"call",id,method,args})});
  }
  setTestModePaused(paused){return this.forward("setTestModePaused",[!!paused])}
  setLocalVisibility(visible){this.localVisible=!!visible;this.forward("setLocalVisibility",[!!visible])}
  markManualRecoveryNeeded(reason){return !!this.sim&&!this.simEnded&&this.forward("markManualRecoveryNeeded",[reason])}
  prepareSimpleRecovery(token,reason){return !!this.sim&&!this.simEnded&&this.forward("prepareSimpleRecovery",[token,reason])}
  startSimpleRecovery(reason){return !!this.sim&&!this.simEnded&&this.forward("startSimpleRecovery",[reason])}
  balanceTelemetry(){return this.request("balanceTelemetry")}
  dispose(reason){
    if(this.disposed)return false;
    this.disposed=true;this.worker.postMessage({type:"dispose",reason});
    for(const resolve of this.pending.values())resolve(null);this.pending.clear();
    for(const detach of this.detachTransport)detach();
    const t=this.transport;t.onMessage=()=>{};t.onOpen=()=>{};t.onClose=()=>{};t.onPeerReady=()=>{};t.onError=()=>{};t.close();
    // The Worker closes itself after disposing; terminate covers a stuck one.
    setTimeout(()=>this.worker.terminate(),1000);return true;
  }
}
class AppLifecycle{
  static async requestScreenWakeLock(){
  if(document.visibilityState!=="visible")return;
  if(!("wakeLock" in navigator))return;

  try{
    if(AppLifecycle.screenWakeLock&&!AppLifecycle.screenWakeLock.released)return;

    AppLifecycle.screenWakeLock=await navigator.wakeLock.request("screen");
    AppLifecycle.screenWakeLock.addEventListener("release",()=>{
      AppLifecycle.screenWakeLock=null;
    });
  }catch{
    // 미지원/권한 거절 환경에서도 visibility freeze 프로토콜은 정상 동작한다.
    AppLifecycle.screenWakeLock=null;
  }
}

  static bootGateFinished=false;

  static pageHiddenAtWall=0;

  static screenWakeLock=null;

  static backgroundTickWorker=null;
  static backgroundTickFallback=0;

  static sessionsForVisibility(){
  if(LocalEnvironmentUtil.isLocalTest()){
    return Object.values(MatchLifecycle.localTest.sessions||{});
  }
  if(SinglePlayerModeUtil.isSinglePlayer()){
    return Object.values(MatchLifecycle.singleMatch.sessions||{});
  }
  return ActiveViewState.session?[ActiveViewState.session]:[];
}

  static saveActiveViewState(){
  if(!LocalEnvironmentUtil.isLocalTest()||!ActiveViewState.role)return;
  ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft=ActiveViewState.renderer?ActiveViewState.renderer.cameraLeft:ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft;
  ViewRuntimeState.byRole[ActiveViewState.role].cameraTop=ActiveViewState.renderer?ActiveViewState.renderer.cameraTop:ViewRuntimeState.byRole[ActiveViewState.role].cameraTop;
  ViewRuntimeState.byRole[ActiveViewState.role].selection.unit=UiRuntimeState.value.selection.unit;
  ViewRuntimeState.byRole[ActiveViewState.role].selection.buildingId=UiRuntimeState.value.selection.buildingId;
  ViewRuntimeState.byRole[ActiveViewState.role].target=CloneUtil.clone(UiRuntimeState.value.target);
}
  static pulseBackgroundSessions(now=performance.now()){
  for(const sess of [...BACKGROUND_TICK_SESSIONS]){
    try{
      PerformanceTelemetry.measureSessionPulse(sess,now);
    }catch(err){
      try{
        if(typeof sess?.enterSimulationFatal==="function"){
          sess.enterSimulationFatal(err,{source:"background-pulse"});
        }else{
          BACKGROUND_TICK_SESSIONS.delete(sess);
          console.error("simulation pulse fatal",err);
        }
      }catch(fatalErr){
        BACKGROUND_TICK_SESSIONS.delete(sess);
        console.error("simulation fatal handler",fatalErr,err);
      }
    }
  }
  if(BACKGROUND_TICK_SESSIONS.size===0){AppLifecycle.stopBackgroundTicker();PerformanceTelemetry.stopRuntimeMonitor()}
}
  static registerBackgroundSession(sess){
  if(!sess)return;
  if(BACKGROUND_TICK_SESSIONS.size===0)PerformanceTelemetry.startRuntimeMonitor();
  BACKGROUND_TICK_SESSIONS.add(sess);
  AppLifecycle.ensureBackgroundTicker();
}
  static unregisterBackgroundSession(sess){
  BACKGROUND_TICK_SESSIONS.delete(sess);
  if(BACKGROUND_TICK_SESSIONS.size===0){AppLifecycle.stopBackgroundTicker();PerformanceTelemetry.stopRuntimeMonitor()}
}
  static applyPageVisibility(){
  const visible=document.visibilityState==="visible";
  const allSessions=AppLifecycle.sessionsForVisibility();

  for(const sess of allSessions){
    sess?.setLocalVisibility(visible);
  }

  if(!visible){
    AppLifecycle.pageHiddenAtWall=Date.now();
    if(ActiveViewState.session?.sim){
      UiRegistry.refs.net.textContent="백그라운드 전환 · 연결 이상 시 복구 버튼 사용";
    }
    return;
  }

  AppLifecycle.requestScreenWakeLock();
  AppLifecycle.pageHiddenAtWall=0;
  AppLifecycle.pulseBackgroundSessions(performance.now());

  const active=RecoveryTelemetry.localRecoverySession();
  if(active?.simpleRecoveryNeedsManual||active?.recoveryPhase==="needs-manual"){
    UiRegistry.refs.net.textContent=SinglePlayerModeUtil.isSinglePlayer()
      ?"싱글 연결 복구 필요 · 복구 버튼을 눌러주세요"
      :"P2P 연결 복구 필요 · 복구 버튼을 눌러주세요";
  }else if(ActiveViewState.session?.sim){
    UiRegistry.refs.net.textContent=SinglePlayerModeUtil.isSinglePlayer()
      ?"싱글 · 게임 계속"
      :"연결됨 · 게임 계속";
  }
}
  static invalidateLiveConnectionForLifecycle(reason){
  // Memory-only live match: if the page lifecycle freezes the RTC path,
  // discard that DataConnection and require the same manual Host-snapshot flow.
  const sessions=AppLifecycle.sessionsForVisibility();
  const seenTrans=new Set();
  for(const sess of sessions){
    if(!sess?.sim||sess.simEnded)continue;
    RecoveryTelemetry.recordRecovery("page.lifecycle-invalidates-connection",sess,sess.transport,{reason});
    sess.markManualRecoveryNeeded(reason);
    const trans=sess.transport;
    if(trans&&!seenTrans.has(trans)){
      seenTrans.add(trans);
      trans.discardCurrentConnection?.(reason);
    }
  }
}
  static setBootState(title,status,progress,retry=false){
  if(UiRegistry.refs.bootTitle)UiRegistry.refs.bootTitle.textContent=title;
  if(UiRegistry.refs.bootStatus)UiRegistry.refs.bootStatus.textContent=status;
  if(UiRegistry.refs.bootProgressBar)UiRegistry.refs.bootProgressBar.style.width=Math.max(4,Math.min(100,progress))+"%";
  if(UiRegistry.refs.bootBuild)UiRegistry.refs.bootBuild.textContent=BUILD_META.commit?`BUILD ${BUILD_META.commit.slice(0,12)}`:`BUILD · 배포 정보 ${BUILD_META.status==="pending"?"확인 중":"확인 불가"}`;
  if(UiRegistry.refs.bootRetryBtn)UiRegistry.refs.bootRetryBtn.classList.toggle("hidden",!retry);
}
  static finishBootGate(){
  if(AppLifecycle.bootGateFinished)return;
  AppLifecycle.bootGateFinished=true;
  AppLifecycle.setBootState("게임 준비 완료","브라우저 게임 · 별도 설치 파일 없음",100,false);
  requestAnimationFrame(()=>{
    UiRegistry.refs.bootGate?.classList.add("ready");
    setTimeout(()=>{
      document.body.classList.remove("boot-loading");
      if(UiRegistry.refs.bootGate)UiRegistry.refs.bootGate.style.display="none";
    },180);
  });
}
  static runBootAndStartApp(){
  // No version.json fetch, service-worker registration, or external boot gate.
  // The existing binary Nostr signaling / raw WebRTC connection path remains unchanged.
  AppLifecycle.finishBootGate();
  NetworkModuleLoader.ensureReady();
}
  static stopBackgroundTicker(){
  const worker=AppLifecycle.backgroundTickWorker;
  AppLifecycle.backgroundTickWorker=null;
  if(worker){
    try{worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.postMessage("stop")}catch{}
    try{worker.terminate()}catch{}
  }
  if(AppLifecycle.backgroundTickFallback){
    clearTimeout(AppLifecycle.backgroundTickFallback);
    AppLifecycle.backgroundTickFallback=0;
  }
}
  static backgroundWorkerSource(){
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
  static startBackgroundTickFallback(delayMs=BACKGROUND_TICK_PULSE_MS){
  if(!BACKGROUND_TICK_SESSIONS.size||AppLifecycle.backgroundTickWorker||AppLifecycle.backgroundTickFallback)return;
  // A single timeout is armed only after the previous main-thread pulse returns.
  // CPU work therefore never leaves a queue of overdue timer callbacks.
  AppLifecycle.backgroundTickFallback=setTimeout(()=>{
    AppLifecycle.backgroundTickFallback=0;
    const started=performance.now();
    try{AppLifecycle.pulseBackgroundSessions(performance.now())}
    finally{AppLifecycle.startBackgroundTickFallback(Math.max(1,BACKGROUND_TICK_PULSE_MS-(performance.now()-started)))}
  },delayMs);
}
  static ensureBackgroundTicker(){
  if(!BACKGROUND_TICK_SESSIONS.size||AppLifecycle.backgroundTickWorker||AppLifecycle.backgroundTickFallback)return;

  // Dedicated Worker timers are generally much less coupled to tab rendering
  // than requestAnimationFrame. Some browsers/OSes may still suspend the whole
  // page process; elapsed-time catch-up below handles that on wake.
  if(typeof Worker==="function"&&typeof Blob==="function"&&typeof URL!=="undefined"){
    try{
      const source=AppLifecycle.backgroundWorkerSource();
      const blob=new Blob([source],{type:"text/javascript"});
      const url=URL.createObjectURL(blob);
      let worker;
      try{worker=new Worker(url)}finally{URL.revokeObjectURL(url)}
      AppLifecycle.backgroundTickWorker=worker;
      worker.onmessage=e=>{
        if(AppLifecycle.backgroundTickWorker!==worker||e.data?.type!=="tick"||!Number.isSafeInteger(e.data.sequence))return;
        try{AppLifecycle.pulseBackgroundSessions(performance.now())}
        finally{if(AppLifecycle.backgroundTickWorker===worker)try{worker.postMessage({type:"ack",sequence:e.data.sequence})}catch{fallback()}}
      };
      const fallback=()=>{
        if(AppLifecycle.backgroundTickWorker!==worker)return;
        try{worker.onmessage=null;worker.onerror=null;worker.onmessageerror=null;worker.terminate()}catch{}
        AppLifecycle.backgroundTickWorker=null;
        AppLifecycle.startBackgroundTickFallback();
      };
      worker.onerror=fallback;worker.onmessageerror=fallback;
      worker.postMessage("start");
      return;
    }catch{AppLifecycle.stopBackgroundTicker()}
  }

  AppLifecycle.startBackgroundTickFallback();
}
}

class BuildingPresentation{
  static productionCard(t,state){
  const d=UnitDefinition.get(t),side=ConnectionSideUtil.roleSide(ActiveViewState.role);
  const isHeavy=d.tier===3,building=isHeavy?"factory":"barracks";
  const cost=UnitDefinition.productionCost(t),mineralCost=cost.mineral,gasCost=cost.gas;
  const techLockStatus=BuildPrerequisitePolicy.unitReason(state,side,t)||"";
  const techLocked=!!techLockStatus;
  const moneyLocked=state.wallet[side]<mineralCost;
  const gasLocked=(state.gasWallet?.[side]||0)<gasCost;
  const resourceShortage=moneyLocked||gasLocked;
  const locked=techLocked||resourceShortage;
  const selected=UiRuntimeState.value.target.type==="build"&&UiRuntimeState.value.target.building===building&&UiRuntimeState.value.target.produceType===t;
  const liveSim=MatchLifecycle.activeSession()?.sim;

  let efficiencyHtml="";
  if(liveSim){
    const existing=liveSim.buildings.filter(
      b=>b.alive!==false&&b.complete&&b.side===side&&b.produceType===t&&BuildingDefinition.get(b.type)?.isProductionBuilding
    );
    if(existing.length){
      const speeds=existing.map(b=>liveSim.productionSpeedPct(b));
      const avg=Math.round(speeds.reduce((a,b)=>a+b,0)/speeds.length),penalty=100-avg;
      efficiencyHtml=penalty>0
        ? `<span class="unit-efficiency warn">생산 효율 ${avg}% · -${penalty}%</span>`
        : `<span class="unit-efficiency ok">생산 효율 100%</span>`;
    }
  }

  const info=UnitDefinition.cardInfo[t]||{icon:"◆",desc:""},pp=UnitDefinition.get(t)?.production;
  const costText=`<span class="cost-part mineral${moneyLocked?" shortage":""}">◆ ${mineralCost}</span>${gasCost?`<span class="cost-sep">·</span><span class="cost-part gas${gasLocked?" shortage":""}">⬡ ${gasCost}</span>`:""}`;
  const productionText=pp?`선호 ${pp.batchSize}기씩 · ${pp.productionSeconds}초 간격`:"";
  const stateClass=techLocked?"tech-locked":resourceShortage?"resource-shortage":"";
  return `<button class="unit-card production-card ${stateClass} ${selected?"mode-selected":""}" data-produce-unit="${t}" ${locked?"disabled":""}>
    <div class="row"><span class="name"><span aria-hidden="true">${info.icon}</span> ${d.name}</span><span class="cost">${costText}</span></div>
    <div class="building-name">${isHeavy?"중화기 공장":"전용 배럭"} · ${productionText}</div>
    <div class="meta">T${d.tier} · ${d.layer==="AIR"?"AIR":"GROUND"} · 크기 ${SIZE_CLASS_LABEL[d.sizeClass]||"대형"} · 공격 ${DAMAGE_CLASS_LABEL[UnitDefinition.damageClass(t)]||"일반형"} · 특수 연구 ${UnitSpecialResearchDefinition.namesForUnit(t)}<br>${d.canAttackGround?"대지 O":"대지 X"} / ${d.canAttackAir?"대공 O":"대공 X"} · 총 ${pp?.totalUnits||0}기 · 보급 ${d.supply||0}/기</div>
    ${efficiencyHtml}
    ${techLockStatus?`<span class="lock" aria-label="${HtmlAttributeUtil.escapeHtmlAttr(techLockStatus)}" title="${HtmlAttributeUtil.escapeHtmlAttr(techLockStatus)}">🔒</span>`:""}
  </button>`;
}
  static productionUiState(b,liveSim){
  const q=b?.queue?.[0]?.productionBatch?b.queue[0]:null;
  const remaining=Math.max(0,Number(b?.productionRemaining)||0);
  const total=Math.max(0,Number(b?.productionTotal)||0);
  const batch=Math.max(1,Number(b?.productionBatchSize)||1);
  const efficiency=Math.max(1,Number(liveSim?.productionSpeedPct?.(b))||100);
  const unit=b?.produceType?UnitDefinition.get(b.produceType):null;

  let progressPct=0;
  let remainSec=0;
  let state="idle";
  let label="다음 증원 준비";

  const productionLock=liveSim&&b?.produceType?BuildPrerequisitePolicy.unitReason(liveSim,b.side,b.produceType):null;
  if(productionLock){
    state="paused";label=productionLock;
    if(q)progressPct=Math.max(0,Math.min(100,Math.round((1-Math.max(0,q.remaining||0)/Math.max(1,q.total||1))*100)));
  }else if(q){
    const qTotal=Math.max(1,Number(q.total)||1);
    const qRemaining=Math.max(0,Number(q.remaining)||0);
    progressPct=Math.max(0,Math.min(100,Math.round((1-qRemaining/qTotal)*100)));

    if(qRemaining<=0){
      progressPct=100;
      state="blocked";
      label="생산 완료 · 출격 공간 대기";
    }else{
      remainSec=Math.max(1,Math.ceil(qRemaining/efficiency/SimulationTiming.tps()));
      state="active";
      label=`${q.count||1}기 생산 중`;
    }
  }else if(liveSim?.productionPaused?.[b.side]){
    state="paused";
    label="자동 생산 일시정지";
  }else if(remaining<=0){
    state="done";
    progressPct=100;
    label="생산 계약 완료";
  }else{
    const preferredCount=Math.min(batch,remaining);
    const supplyPerUnit=Math.max(0,Number(unit?.supply)||0);
    const reservable=liveSim?.reservableProductionBatchSize?.(b.side,b)??preferredCount;

    if(preferredCount>0&&reservable<=0){
      state="blocked";
      label=`보급 대기 · 유닛당 ${supplyPerUnit} 필요`;
    }else{
      state="idle";
      label=reservable<preferredCount?`보급에 맞춰 ${reservable}기 우선 생산`:`다음 ${preferredCount}기 생산 대기`;
    }
  }

  const produced=Math.max(0,total-remaining);
  const batchesTotal=Math.max(1,Math.ceil(total/batch));
  const batchesDone=Math.max(0,Number(b?.productionBatchesCompleted)||0);
  const currentBatch=q?1:0;

  return {
    q,unit,remaining,total,batch,efficiency,
    progressPct,remainSec,state,label,produced,
    batchesTotal,batchesDone,currentBatch
  };
}
  static productionStatusHtml(b,liveSim){
  const p=BuildingPresentation.productionUiState(b,liveSim);
  const info=UnitDefinition.cardInfo[b.produceType]||{icon:"◆"};
  const currentCount=p.q?.count||Math.min(p.batch,p.remaining)||p.batch;

  const pips=Array.from({length:Math.min(12,p.batchesTotal)},(_,i)=>{
    const cls=i<p.batchesDone
      ?"filled"
      :i===p.batchesDone&&p.q
        ?"current"
        :"remaining";
    return `<span class="production-batch-pip ${cls}"></span>`;
  }).join("");

  const barClass=
    p.state==="blocked"?" blocked":
    p.state==="paused"?" paused":"";

  const timeText=
    p.q&&p.q.remaining>0
      ?`${p.remainSec}초`
      :p.state==="blocked"&&p.q
        ?"출격 대기"
        :p.state==="blocked"
          ?"보급 대기"
          :p.state==="paused"
            ?"일시정지"
            :"";

  return `<div class="production-status-card">
    <div class="production-status-icon" aria-hidden="true">${info.icon}</div>
    <div class="production-status-main">
      <div class="production-status-title">
        <span>${p.unit?.name||"병력"} · ${p.label}</span>
        <span class="time">${timeText}</span>
      </div>
      <div class="production-status-sub">
        ${p.q?`현재 batch ${currentCount}기 · Supply ${(p.unit?.supply||0)*currentCount} 예약`:`생산효율 ${p.efficiency}%`}
      </div>
      <div class="production-progress${barClass}">
        <span style="width:${p.progressPct}%"></span>
        <div class="production-progress-label">${p.progressPct}%</div>
      </div>
    </div>

    <div class="production-contract-strip">
      <div class="production-contract-cell">전체 계약<b>${p.produced} / ${p.total} 생산</b></div>
      <div class="production-contract-cell">남은 병력<b>${p.remaining}기</b></div>
      <div class="production-contract-cell">증원 단위<b>${p.batch}기씩</b></div>
    </div>
    <div class="production-batch-pips" aria-label="생산 batch 진행">${pips}</div>
  </div>`;
}
  static ownBuildingAt(authX,authY){
  if(!ActiveViewState.snap)return null;
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role);
  let best=null,bestD=Infinity;
  for(const b of [...ActiveViewState.snap.buildings,...(ActiveViewState.snap.constructionOrders||[])]){
    if(b.alive===false||b.side!==side)continue;
    const size=BuildingDefinition.get(b.type)?.size||35;
    const d=Math.hypot(b.x-authX,b.y-authY);
    if(d<=size+22&&d<bestD){best=b;bestD=d}
  }
  return best;
}
  static startBuildPlacement(building,produceType=null){
  if(!building||!BuildingDefinition.get(building))return false;

  // Build selection is an idempotent START action, never a toggle.
  // Duplicate pointer/click delivery, DOM rerender, or repeated taps must leave
  // the same build target armed. Build targeting is cancelled only through an
  // explicit cancel path (건설 마침 / drawer close / another non-build action).
  const next={type:"build",building,produceType:produceType||null};

  // Commit gameplay UI state first. Closing the drawer afterwards must never be
  // able to interpret the close itself as a request to cancel the just-selected
  // build target.
  UiController.setMode(next);
  CommandPresentation.closeCommandDrawer({cancelTarget:false});

  return true;
}
  static selectBuilding(id){
  const requested=id||null;

  // Building selection is NOT a toggle.
  // Re-selecting the same building must be idempotent: mobile browsers can emit
  // compatibility clicks after pointer release and rerenders can replay the same
  // semantic selection. Treating the second selection as "toggle off" made the
  // building panel flash open and immediately close.
  const changed=UiRuntimeState.value.selection.buildingId!==requested;
  UiRuntimeState.value.selection.buildingId=requested;

  if(changed){
    // Building-specific action HTML must be invalidated together with the DOM.
    // Some buildings intentionally have no actions; clearing only the cache would
    // make BuildingPresentation.setBuildingActionsHtml("") skip the update and leave previous actions visible.
    if(UiRegistry.refs.buildingPanelActions)UiRegistry.refs.buildingPanelActions.innerHTML="";
    BattlePresentationCache.lastBuildingActionsHtml=null;
  }

  if(UiRuntimeState.value.selection.buildingId){
    // Building inspection must never leave an accidental build/spell target armed.
    if(UiRuntimeState.value.target.type!=="flag")UiController.setMode({type:"flag"},{silent:true});
    CommandPresentation.setCommandDrawerMode("building");
  }else if(UiRuntimeState.value.command.branch==="building"){
    CommandPresentation.closeCommandDrawer();
  }

  if(LocalEnvironmentUtil.isLocalTest()&&ActiveViewState.role)ViewRuntimeState.byRole[ActiveViewState.role].selection.buildingId=UiRuntimeState.value.selection.buildingId;
  if(ActiveViewState.renderer)ActiveViewState.renderer.selectedBuildingId=UiRuntimeState.value.selection.buildingId;
  if(ActiveViewState.snap)BuildingPresentation.renderSelectedBuildingPanel(ActiveViewState.snap);

  CommandPresentation.syncCommandDock();
  return !!UiRuntimeState.value.selection.buildingId;
}
  static selectedOwnBuilding(state=ActiveViewState.snap){
  if(!state||!UiRuntimeState.value.selection.buildingId)return null;
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role);
  return [...state.buildings,...(state.constructionOrders||[])].find(b=>b.id===UiRuntimeState.value.selection.buildingId&&b.alive!==false&&b.side===side)||null;
}
  static isConstructionOrder(b,state=ActiveViewState.snap){
    return !!b&&(state?.constructionOrders||[]).some(order=>order.id===b.id);
  }
  static detailForDefenseBuilding(buildingType){
  const bd=BuildingDefinition.get(buildingType);
  const entry=Object.entries(DefenseCardDefinition.all).find(([,v])=>v?.building===buildingType);
  const card=entry?.[1];
  if(!bd&&!card)return null;
  const gas=BuildingDefinition.gasCost(buildingType);
  const body=[card?.desc,bd?.desc].filter(Boolean).join("<br><br>")||"방어 건물 카드";
  return {title:card?.name||bd?.name||buildingType,icon:card?.icon||"✣",kicker:"DEFENSE",body,meta:`◆ ${bd?.cost||0}${gas?` · ⬡ ${gas}`:""} · 사거리 ${bd?.range||0}`};
}
  static detailForBuilding(buildingType){
  const bd=BuildingDefinition.get(buildingType);if(!bd)return null;
  const gas=BuildingDefinition.gasCost(buildingType);
  return {title:bd.name||buildingType,icon:bd.detailIcon||"🏗️",kicker:"BUILDING",body:bd.desc||"건설 가능한 구조물",meta:`◆ ${bd.cost||0}${gas?` · ⬡ ${gas}`:""}${bd.buildTimeMs?` · ${Math.ceil(bd.buildTimeMs/1000)}초`:""}`};
}
  static buildPlacementActionFromElement(el){
  if(!el||el.disabled)return null;
  if(el.dataset.produceUnit){
    const unit=el.dataset.produceUnit,d=UnitDefinition.get(unit);
    if(!d)return null;
    return {building:d.tier===3?"factory":"barracks",produceType:unit};
  }
  if(el.dataset.defenseBuild)return {building:el.dataset.defenseBuild,produceType:null};
  const staticBuild={
    supplyBtn:"supply",
    gasExtractorBtn:"gasExtractor",
    academyBtn:"academy",
    airIncubatorBtn:"airIncubator",
    labBtn:"lab"
  }[el.id];
  return staticBuild?{building:staticBuild,produceType:null}:null;
}
  static commitBuildPlacementElement(el){
  const action=BuildingPresentation.buildPlacementActionFromElement(el);
  if(!action)return false;
  if(action.produceType){
    UiRuntimeState.value.selection.unit=action.produceType;
    if(LocalEnvironmentUtil.isLocalTest())ViewRuntimeState.byRole[ActiveViewState.role].selection.unit=UiRuntimeState.value.selection.unit;
  }
  return BuildingPresentation.startBuildPlacement(action.building,action.produceType);
}
  static setBuildingActionsHtml(html){
  if(html===BattlePresentationCache.lastBuildingActionsHtml)return;
  UiRegistry.refs.buildingPanelActions.innerHTML=html;
  BattlePresentationCache.lastBuildingActionsHtml=html;
}
  static renderSelectedBuildingPanel(state){
  const b=BuildingPresentation.selectedOwnBuilding(state);

  if(!b){
    UiRuntimeState.value.selection.buildingId=null;
    if(ActiveViewState.renderer)ActiveViewState.renderer.selectedBuildingId=null;
    if(UiRuntimeState.value.command.branch==="building")UiController.setUiCommand({branch:"closed"});

    if(BattlePresentationCache.lastBuildingActionsHtml!==null||UiRegistry.refs.buildingPanelActions.innerHTML){
      UiRegistry.refs.buildingPanelActions.innerHTML="";
      BattlePresentationCache.lastBuildingActionsHtml=null;
    }

    UiRegistry.refs.cancelModeBtn.disabled=true;
    UiRegistry.refs.cancelModeBtn.classList.add("hidden");
    return;
  }

  const side=ConnectionSideUtil.roleSide(ActiveViewState.role),bd=BuildingDefinition.get(b.type),liveSim=MatchLifecycle.activeSession()?.sim;

  UiRegistry.refs.buildingPanelTitle.textContent=bd?.name||"건물";

  if(BuildingPresentation.isConstructionOrder(b,state)){
    const refund=b.paidMineral||0,gasRefund=b.paidGas||0;
    UiRegistry.refs.buildingPanelStatus.innerHTML=`건설 예약 · <b>${b.builderUnitId?"일꾼 이동 중":"가용 일꾼 대기"}</b>`;
    BuildingPresentation.setBuildingActionsHtml(
      `<div class="small">선결제 <b>${refund} 미네랄${gasRefund?` · ${gasRefund} 가스`:""}</b> · 일꾼이 도착하면 착공합니다.<br>착공 전 취소하면 지불한 비용을 전액 돌려받습니다.</div>`
    );
    UiRegistry.refs.cancelModeBtn.disabled=false;
    UiRegistry.refs.cancelModeBtn.classList.remove("hidden");
    UiRegistry.refs.cancelModeBtn.classList.add("cancel-refund");
    UiRegistry.refs.cancelModeBtn.innerHTML=`예약 취소 · +${refund} 미네랄${gasRefund?` · +${gasRefund} 가스`:""} 전액 환불`;
    return;
  }

  if(!b.complete){
    const pct=Math.max(0,Math.min(100,Math.floor((b.progress/Math.max(1,SimulationTiming.msToTicks(bd.buildTimeMs,SimulationTiming.tps())))*100)));
    const remain=Math.max(0,Math.ceil((Math.max(0,SimulationTiming.msToTicks(bd.buildTimeMs,SimulationTiming.tps())-b.progress))/SimulationTiming.tps()));
    const refund=(Number.isFinite(Number(b.constructionMineralCost))?Number(b.constructionMineralCost):BuildingDefinition.mineralCost(b.type,b.produceType||null))*.5;
    const gasRefund=(Number(b.constructionGasCost)||0)*.5;

    const builder=liveSim&&b.builderUnitId?(liveSim.unitById.get(b.builderUnitId)||liveSim.units.find(u=>u.id===b.builderUnitId)):null;
    const buildState=b.constructionState==="building"
      ? `건설 중 · <b>${pct}%</b> · 약 ${remain}초 남음`
      : builder?.alive
        ? `기초 설치 완료 · <b>일꾼 이동 중</b> · HP ${Math.round((b.hp/b.maxHp)*100)}%`
        : `기초 설치 완료 · <b>가용 일꾼 대기</b> · HP ${Math.round((b.hp/b.maxHp)*100)}%`;
    UiRegistry.refs.buildingPanelStatus.innerHTML=`${buildState}
      <div class="research-progress"><span style="width:${pct}%"></span></div>`;

    BuildingPresentation.setBuildingActionsHtml(
      `<div class="small">이 건물을 취소하면 <b>${refund} 미네랄${gasRefund?` · ${gasRefund} 가스`:""}(건설비 50%)</b>을 돌려받습니다.</div>`
    );

    UiRegistry.refs.cancelModeBtn.disabled=false;
    UiRegistry.refs.cancelModeBtn.classList.remove("hidden");
    UiRegistry.refs.cancelModeBtn.classList.add("cancel-refund");
    UiRegistry.refs.cancelModeBtn.innerHTML=`건설 취소 · +${refund} 미네랄${gasRefund?` · +${gasRefund} 가스`:""} 환불`;
    return;
  }

  const completedPaidMineral=Number.isFinite(Number(b.constructionMineralCost))
    ?Number(b.constructionMineralCost)
    :BuildingDefinition.mineralCost(b.type,b.produceType||null);
  const completedRefund=completedPaidMineral*.5;
  const completedGasRefund=(Number(b.constructionGasCost)||0)*.5;

  if(BuildingDefinition.get(b.type)?.isDropoff){
    UiRegistry.refs.cancelModeBtn.disabled=true;
    UiRegistry.refs.cancelModeBtn.classList.add("hidden");
    UiRegistry.refs.cancelModeBtn.classList.remove("cancel-refund");
  }else{
    UiRegistry.refs.cancelModeBtn.disabled=false;
    UiRegistry.refs.cancelModeBtn.classList.remove("hidden");
    UiRegistry.refs.cancelModeBtn.classList.add("cancel-refund");
    UiRegistry.refs.cancelModeBtn.innerHTML=`건물 철거 · +${completedRefund} 미네랄${completedGasRefund?` · +${completedGasRefund} 가스`:""} 환불`;
  }

  const q=b.queue?.[0];

  if(q?.kind==="research"){
    const qRemaining=SimulationTiming.queueRemainingTicks(q,state.tick||0);
    const pct=Math.max(0,Math.min(100,Math.floor((1-qRemaining/q.total)*100)));
    const remain=Math.ceil(qRemaining/SimulationTiming.tps());
    const name=q.research==="attack"?`공격 Lv.${q.level}`:
      q.research==="armor"?`방어 Lv.${q.level}`:
`${UnitDefinition.get(q.unit)?.name||""} · ${ABILITY_INFO[q.unit]?.name||"특수능력"}`;

    UiRegistry.refs.buildingPanelStatus.innerHTML=`연구 진행 중 · <b>${name}</b> · ${pct}% · 약 ${remain}초
      <div class="research-progress"><span style="width:${pct}%"></span></div>`;
  }else if(BuildingDefinition.get(b.type)?.isProductionBuilding){
    UiRegistry.refs.buildingPanelStatus.innerHTML=BuildingPresentation.productionStatusHtml(b,liveSim);
  }else if(BuildingDefinition.get(b.type)?.isGasExtractor){
    const gasNode=liveSim?.gasNodeForExtractor(b);
    const remain=Math.max(0,gasNode?.amount||0);
    const max=Math.max(1,gasNode?.max||1);
    const pct=Math.round(remain/max*100);
    UiRegistry.refs.buildingPanelStatus.innerHTML=`가스 추출장 · 내구도 ${Math.round((b.hp/b.maxHp)*100)}% · 가스 <b>${remain}</b> 남음
      <div class="research-progress"><span style="width:${pct}%"></span></div>
      <span class="small">${remain>0
        ?`정상 채취 · 1회 왕복당 <b>${GAS_MINE_AMOUNT}</b> 가스`
        :`고갈 상태 · 계속 채취 가능 · 1회 왕복당 <b>${GAS_DEPLETED_MINE_AMOUNT}</b> 가스(25%)`
      }</span>`;
  }else{
    const hpPct=Math.round((b.hp/b.maxHp)*100);

    const defenseEff=BuildingDefinition.isDefenseTower(b.type)&&liveSim?` · 발사효율 <b>${liveSim.defenseFireSpeedPct(b)}%</b>`:"";
    UiRegistry.refs.buildingPanelStatus.innerHTML=`완공 · 내구도 ${hpPct}%${defenseEff}${b.queue?.length?" · 작업 중":""}${
      !BuildingDefinition.get(b.type)?.isDropoff
        ? `<br><span class="small">철거 시 건설비 50% 환불${b.queue?.length?" · 진행 중 생산은 취소되며 해당 비용은 환불되지 않음":""}</span>`
        : (b.queue?.length?`<br><span class="small">일꾼 생산 대기 ${b.queue.filter(q=>q.kind==="workerProduction").length}</span>`:"")
    }`;
  }

  let actionsHtml="";

  if(BuildingDefinition.get(b.type)?.isDropoff){
    const workerQueue=(b.queue||[]).filter(q=>q.kind==="workerProduction");
    const remaining=workerQueue.length?SimulationTiming.queueRemainingTicks(workerQueue[0],state.tick||0):0;
    const supplyUsed=liveSim?.supplyUsed(side)||0;
    const supplyCap=liveSim?.supplyCap(side)||BASE_SUPPLY;
    const supplyOk=supplyUsed+(ECONOMY_WORKER_DEF.supply||0)<=supplyCap;
    const moneyOk=state.wallet[side]>=WORKER_COST;
    const queueOk=workerQueue.length<WORKER_QUEUE_LIMIT;

    const assignedWorkers=liveSim?.workersAssignedToBase(b)||[];
    const gasTarget=GasWorkerAssignmentPolicy.pendingGasTargetFor(b);
    const gasAuthoritativeTarget=Math.max(0,Number(b.gasWorkerTarget)||0);
    const gasPending=gasTarget!==gasAuthoritativeTarget;
    const gasAssigned=Math.min(gasAuthoritativeTarget,assignedWorkers.length);
    const validExtractors=liveSim?.validGasExtractors(side)?.length||0;

    actionsHtml=`<div class="research-action">
      <div class="research-title">⬡ 가스 일꾼 배정</div>
      <div class="research-desc">이 거점에 속한 가장 가까운 일꾼 중 목표 수만큼 가스를 캐고, 나머지는 미네랄을 캡니다.</div>
      <div class="research-meta">${gasPending?`조정 중 <b>${gasTarget}명</b> · 입력이 멈추면 확정`:`현재 ${gasAssigned}/${assignedWorkers.length}명 가스 목표`} · 유효 추출장 ${validExtractors}개</div>
      <div class="gas-worker-stepper">
        <button class="gas-step-btn" type="button" data-gas-workers-dec="${b.id}" aria-label="가스 일꾼 감소" ${gasTarget<=0?"disabled":""}>−</button>
        <div class="gas-worker-count"><b>${gasTarget}</b><span>명</span></div>
        <button class="gas-step-btn" type="button" data-gas-workers-inc="${b.id}" aria-label="가스 일꾼 증가" ${gasTarget>=GAS_ASSIGNMENT_MAX?"disabled":""}>＋</button>
      </div>
    </div>

    <button class="research-action ${(!supplyOk||!moneyOk||!queueOk)?"":"ready"}"
      data-train-worker="${b.id}"
      ${(!supplyOk||!moneyOk||!queueOk)?"disabled":""}>
        <div class="research-title">⚒ 일꾼 생산</div>
        <div class="research-desc">${BuildingDefinition.get(b.type)?.isMainBase?"메인 거점":"전진 거점"}에서 일꾼을 생산합니다. 자원은 가장 가까운 거점으로 귀환합니다.</div>
        <div class="research-meta">${
          !supplyOk?"보급 부족":
          !moneyOk?`미네랄 ${WORKER_COST} 필요`:
          !queueOk?"대기열 가득":
          `◆ ${WORKER_COST} · 보급 ${ECONOMY_WORKER_DEF.supply||0} · ${Math.ceil(ECONOMY_WORKER_DEF.buildTimeMs/1000)}초${
            workerQueue.length?` · 대기 ${workerQueue.length} · ${Math.ceil(remaining/SimulationTiming.tps())}초`:""
          }`
        }</div>
    </button>`;
  }

  BuildingPresentation.setBuildingActionsHtml(actionsHtml);
}
  static syncBuildPlacementSelectionUi(){
  const isBuild=UiRuntimeState.value.target.type==="build";
  const building=isBuild?UiRuntimeState.value.target.building:null,produceType=isBuild?(UiRuntimeState.value.target.produceType||null):null;

  for(const b of UiRegistry.refs.unitGrid.querySelectorAll("[data-produce-unit]")){
    b.classList.toggle("mode-selected",!!produceType&&b.dataset.produceUnit===produceType);
  }
  const staticButtons=[
    [UiRegistry.refs.supplyBtn,"supply"],
    [UiRegistry.refs.gasExtractorBtn,"gasExtractor"],
    [UiRegistry.refs.academyBtn,"academy"],
    [UiRegistry.refs.airIncubatorBtn,"airIncubator"],
    [UiRegistry.refs.labBtn,"lab"]
  ];
  for(const [btn,type] of staticButtons)btn?.classList.toggle("mode-selected",isBuild&&!produceType&&building===type);
  for(const btn of UiRegistry.refs.defenseCardChoices?[...UiRegistry.refs.defenseCardChoices.querySelectorAll("[data-defense-build]")]:[]){
    btn.classList.toggle("mode-selected",isBuild&&!produceType&&btn.dataset.defenseBuild===building);
  }
}
  static buildValidation(state,side,action){
  // Pointer preview checks placement only. Builder reachability is authoritative
  // simulation work when BUILD executes; never construct a NavMesh for a pointer.
  const bd=BuildingDefinition.get(action.building);
  if(!bd)return "알 수 없는 건물입니다.";
  const ruleReason=BuildPrerequisitePolicy.buildingReason(state,side,action.building,action.produceType);
  if(ruleReason)return ruleReason;
  const cost=BuildingDefinition.resourceCost(action.building,action.produceType);
  if(state.wallet[side]<cost.mineral)return `미네랄이 부족합니다. ${cost.mineral} 필요`;

  const gasCost=cost.gas;
  if((state.gasWallet?.[side]||0)<gasCost)return `가스가 부족합니다. ${gasCost} 필요`;

  const liveSim=MatchLifecycle.activeSession()?.sim;

  if(!buildingPlacementInsideWorld(action.building,action.x,action.y,WorldContext.forState(state)))return "절벽·뿌리벽·경사로 위에는 건설할 수 없습니다.";

  if(bd.isGasExtractor){
    const gas=liveSim?.nearestGasNodeAt(action.x,action.y);
    if(!gas)return "가스 지점 위에 추출장을 건설해야 합니다.";
    if(liveSim?.gasNodeOccupied(gas.id))return "이미 추출장이 있는 가스 지점입니다.";
    action.x=gas.x;
    action.y=gas.y;
  }

  for(const m of state.resources||[]){
    const min=bd.size+(m.r||28)+MINERAL_BUILD_MARGIN;
    if(Math.hypot(m.x-action.x,m.y-action.y)<min){
      return "미네랄 매장지 위나 바로 옆에는 건설할 수 없습니다.";
    }
  }

  if(!bd.isGasExtractor){
    for(const g of state.gasNodes||[]){
      const min=bd.size+(g.r||32)+14;
      if(Math.hypot(g.x-action.x,g.y-action.y)<min){
        return "가스 지점에는 추출장만 건설할 수 있습니다.";
      }
    }
  }

  if(liveSim&&!liveSim.buildPointVisible(side,action.x,action.y)){
    return "현재 확보한 시야 안에서만 건설할 수 있습니다.";
  }

  for(const b of [...state.buildings,...(state.constructionOrders||[])]){
    if(b.alive===false)continue;
    if(Math.hypot(b.x-action.x,b.y-action.y)<buildingPlacementSeparation(action.building,b.type))return "다른 건물·건설 예약과 너무 가깝습니다. 일꾼 이동 통로를 확보하세요.";
  }
  return null;
}
  static previewBuildDensity(side,action){
  const liveSim=MatchLifecycle.activeSession()?.sim;
  if(!liveSim)return null;
  if(BuildingDefinition.get(action.building)?.isProductionBuilding){
    const near=liveSim.nearbyProductionCount(side,action.x,action.y);
    const speed=PRODUCTION_CLUSTER_SPEED_PCT[Math.min(near,PRODUCTION_CLUSTER_SPEED_PCT.length-1)];
    return {kind:"production",near,speed,penalty:100-speed};
  }
  if(BuildingDefinition.isDefenseTower(action.building)){
    const near=liveSim.nearbyDefenseTowerCount(side,action.x,action.y);
    const speed=PRODUCTION_CLUSTER_SPEED_PCT[Math.min(near,PRODUCTION_CLUSTER_SPEED_PCT.length-1)];
    return {kind:"defense",near,speed,penalty:100-speed};
  }
  return null;
}
  static renderBuildMetadata(){
  document.documentElement.dataset.build=BUILD_META.id;
  document.documentElement.dataset.buildStatus=BUILD_META.status;
  document.documentElement.dataset.buildCommit=BUILD_META.commit||"";
  const buildTag=document.querySelector('meta[name="rally-frontier-build"]');
  const updatedTag=document.querySelector('meta[name="rally-frontier-updated-at"]');
  if(buildTag)buildTag.setAttribute("content",BUILD_META.id);
  if(updatedTag)updatedTag.setAttribute("content",BUILD_META.updatedAt||"");

  const el=document.getElementById("titleUpdateStamp");
  if(el){
    const updated=new Date(BUILD_META.updatedAt);
    const now=new Date();
    const validUpdated=BUILD_META.updatedAt!==null&&Number.isFinite(updated.getTime());
    const kstDayKey=d=>new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Seoul",year:"numeric",month:"2-digit",day:"2-digit"}).format(d);
    const daySerial=key=>Math.floor(Date.parse(key+"T00:00:00Z")/86400000);
    const dayDiff=validUpdated?daySerial(kstDayKey(now))-daySerial(kstDayKey(updated)):null;
    const buildTimeZone="Asia/Seoul";
    const hm=validUpdated?new Intl.DateTimeFormat("ko-KR",{timeZone:buildTimeZone,hour:"2-digit",minute:"2-digit",hour12:false}).format(updated):"시간 미상";
    let label;
    if(BUILD_META.status==="pending")label="배포 정보 확인 중";
    else if(BUILD_META.status!=="available")label="배포 정보 확인 불가";
    else if(!validUpdated)label="업데이트 시간 미상";
    else if(dayDiff===0)label=`오늘 ${hm}`;
    else if(dayDiff===1)label=`어제 ${hm}`;
    else label=new Intl.DateTimeFormat("ko-KR",{timeZone:"Asia/Seoul",year:"numeric",month:"numeric",day:"numeric",hour:"2-digit",minute:"2-digit",hour12:false}).format(updated);
    el.textContent=`최근 업데이트 · ${label}${BUILD_META.commit?` · ${BUILD_META.commit.slice(0,12)}`:""}`;
    el.title=BUILD_META.updatedAt?`배포 기록 ${BUILD_META.commit} · 복사 시각 ${BUILD_META.updatedAt} · build.json`:`배포 정보 ${BUILD_META.status==="pending"?"확인 중":"확인 불가"}`;
  }
  if(UiRegistry.refs.bootBuild)UiRegistry.refs.bootBuild.textContent=BUILD_META.commit?`BUILD ${BUILD_META.commit.slice(0,12)}`:`BUILD · 배포 정보 ${BUILD_META.status==="pending"?"확인 중":"확인 불가"}`;
}
}

class HtmlAttributeUtil{
  static escapeHtmlAttr(value){
    return String(value??"").replace(/&/g,"&amp;").replace(/"/g,"&quot;").replace(/</g,"&lt;").replace(/>/g,"&gt;");
  }
}

// 발사전 화면: 카드 패, 자원 게이지, 착탄 흔적. 착탄 예정 지점은 절대 그리지 않는다.
class LaunchPresentation{
  static card=null;static deckKey="";static lastPower=null;static marks=[];static pods=new Map();static hold=null;
  static active(s=ActiveViewState.snap){return !!s?.launchMode&&!ReplayPresentation.replayPlayer}
  static reset(){this.card=null;this.deckKey="";this.lastPower=null;this.marks=[];this.pods=new Map();this.hold=null}
  static render(s,side){
    const on=!!s?.launchMode;document.body.classList.toggle("launch-mode",on);
    UiRegistry.refs.launchHand?.classList.toggle("hidden",!on);
    if(!on)return;
    const deck=LaunchRules.deck,wallet=Math.floor(s.wallet?.[side]||0);
    if(!deck.includes(this.card))this.card=deck[0]||null;
    const key=deck.join("|");
    if(key!==this.deckKey){
      this.deckKey=key;
      UiRegistry.refs.launchCards.innerHTML=deck.map(t=>LaunchScreens.cardMarkup(t)).join("");
      LaunchScreens.fillCardPortraits(UiRegistry.refs.launchCards);
    }
    for(const el of UiRegistry.refs.launchCards.querySelectorAll("[data-launch-card]")){
      const t=el.dataset.launchCard;el.classList.toggle("selected",t===this.card);el.classList.toggle("unaffordable",LaunchRules.payload(t).cost>wallet);
    }
    UiRegistry.refs.launchEnergyFill.style.width=`${Math.round(100*wallet/LaunchRules.walletCap)}%`;
    UiRegistry.refs.launchEnergyText.textContent=`◆ ${wallet} / ${LaunchRules.walletCap}`;
    this.renderHud(s,side);
    // A pod that left the snapshot has landed: leave a short mark at its point.
    const now=performance.now(),seen=new Set();
    for(const p of s.projectiles||[]){if(!p.payload||p.side!==side)continue;seen.add(p.id);this.pods.set(p.id,{x:p.lockedAimX,y:p.lockedAimY})}
    for(const [id,p] of this.pods)if(!seen.has(id)){this.pods.delete(id);this.marks.push({x:p.x,y:p.y,at:now})}
    this.marks=this.marks.filter(m=>now-m.at<LaunchRules.landingMarkMs);
    if(!this.hold&&UiRegistry.refs.hint){const hint="카드 고르기 · 길게 눌러 충전 · 손가락 방향으로 조준 · 놓으면 발사 · 너무 오래 누르면 과열";if(UiRegistry.refs.hint.textContent!==hint)UiRegistry.refs.hint.textContent=hint}
  }
  // Both main bases' health, elapsed time, and an edge arrow while the enemy base is off screen.
  static renderHud(s,side){
    const main=BuildingDefinition.forRole("mainBase"),hp=k=>{const b=(s.buildings||[]).find(b=>b.side===k&&b.type===main);return b&&b.alive!==false?Math.ceil(100*Math.max(0,b.hp||0)/Math.max(1,b.maxHp||1)):0};
    const r=ActiveViewState.renderer,enemy=(s.buildings||[]).find(b=>b.side===1-side&&b.type===main&&b.alive!==false);
    let enemyDirection=null;
    if(r&&enemy){
      // Camera space: x right, y down, in world units, so the distance reads like the map.
      const vw=r.viewWorldW(),vh=r.viewWorldH(),x=r.viewX(enemy.x)-r.cameraLeft,y=BattlefieldProjection.planarY(r.viewY(enemy.y),r.world.terrain.surfaces.heightAt(enemy.x,enemy.y))-r.cameraTop;
      if(x<0||x>vw||y<0||y>vh){const dx=x-vw/2,dy=y-vh/2;enemyDirection={angle:Math.atan2(dy,dx)+Math.PI/2,distance:Math.hypot(dx,dy)}}
    }
    LaunchScreens.renderHud({myHpPct:hp(side),enemyHpPct:hp(1-side),elapsedMs:1000*s.tick/(s.tps||SimulationTiming.tps()),enemyDirection});
  }
  static selectCard(type){this.card=type;const s=ActiveViewState.snap;if(s)this.render(s,ConnectionSideUtil.roleSide(ActiveViewState.role))}
  static nearestCannon(s,side,x,y){
    const main=BuildingDefinition.forRole("mainBase"),outpost=BuildingDefinition.forRole("outpost");
    let best=null,bestD=Infinity;
    for(const b of s.buildings||[]){if(b.side!==side||b.alive===false||(b.type!==main&&b.type!==outpost))continue;const d=Math.hypot(b.x-x,b.y-y);if(d<bestD){bestD=d;best=b}}
    return best;
  }
  static begin(a,pointerId){
    const s=ActiveViewState.snap,side=ConnectionSideUtil.roleSide(ActiveViewState.role),cannon=s&&this.nearestCannon(s,side,a.x,a.y);
    if(!cannon||!this.card)return null;
    const wait=Math.max(0,(Number(cannon.launchReadyTick)||0)-s.tick);
    if(wait>0){LogUtil.log(`⏳ ${BuildingDefinition.get(cannon.type)?.name||"대포"} 재장전 중 · ${(wait/(s.tps||SimulationTiming.tps())).toFixed(1)}초`);return null}
    if(LaunchRules.payload(this.card).cost>Math.floor(s.wallet[side]))LogUtil.log("◆ 자원이 모자랍니다. 게이지가 차면 다시 누르세요.");
    this.hold={pointerId,cannonId:cannon.id,cannonX:cannon.x,cannonY:cannon.y,aimX:a.x,aimY:a.y,armedAt:performance.now(),card:this.card,lastPower:this.lastPower};
    if(navigator.vibrate)navigator.vibrate(12);
    return this.hold;
  }
  static aim(a){if(this.hold){this.hold.aimX=a.x;this.hold.aimY=a.y}}
  // Where the sim will land this hold: same rule and fallback direction as the LAUNCH command.
  static landing(hold,holdMs,world){
    const flag=ActiveViewState.snap?.flags?.[ConnectionSideUtil.roleSide(ActiveViewState.role)]||{x:hold.cannonX,y:hold.cannonY};
    return LaunchRules.target({x:hold.cannonX,y:hold.cannonY},hold.aimX,hold.aimY,holdMs,world,flag,hold.card);
  }
  // While charging, the camera eases just far enough to keep the landing ring on screen.
  static followAim(r){
    const hold=this.hold;if(!hold||!r.world){if(this.labelShown){this.labelShown=false;LaunchScreens.renderAimLabel(null)}return}
    const at=this.landing(hold,performance.now()-hold.armedAt,r.world),vx=r.viewX(at.x),vy=r.viewY(at.y);
    const vw=r.viewWorldW(),vh=r.viewWorldH(),margin=(LaunchRules.grain(hold.card)?.splash||120)+80;
    const py=BattlefieldProjection.planarY(vy,r.world.terrain.surfaces.heightAt(at.x,at.y));
    // The top keeps room for the HUD, the enemy arrow and the ring's label (about 120 CSS px).
    const hud=120*vw/Math.max(1,r.canvas.clientWidth);
    const left=RangeUtil.clamp(r.cameraLeft,vx+margin-vw,vx-margin),top=RangeUtil.clamp(r.cameraTop,py+margin-vh,py-margin-hud);
    r.cameraLeft=RangeUtil.clamp(r.cameraLeft+(left-r.cameraLeft)*.2,0,Math.max(0,r.world.width-vw));
    r.cameraTop=r.clampCameraTop(r.cameraTop+(top-r.cameraTop)*.2);
    // Canvas pixels to the label's CSS pixels, just above the ring.
    const [lx,ly]=r.worldToPx(vx,vy),k=r.canvas.clientWidth/Math.max(1,r.canvas.width),splash=(LaunchRules.grain(hold.card)?.splash||120)*r.sc();
    this.labelShown=true;LaunchScreens.renderAimLabel({x:lx*k,y:(ly-splash)*k-6},hold.card);
  }
  static cancel(){this.hold=null}
  static release(a){
    const hold=this.hold;this.hold=null;if(!hold)return;
    if(a){hold.aimX=a.x;hold.aimY=a.y}
    const holdMs=Math.round(performance.now()-hold.armedAt),sess=MatchLifecycle.activeSession();
    if(!sess?.sim)return;
    const accepted=sess.command({type:"LAUNCH",cannonId:hold.cannonId,x:Math.round(hold.aimX),y:Math.round(hold.aimY),holdMs,unitType:hold.card});
    if(!accepted){LogUtil.log("⚠ 발사 명령을 접수할 수 없습니다.");return}
    if(LaunchRules.overheated(holdMs)){LogUtil.log(`🔥 과열! 대포가 ${LaunchRules.overheatMs/1000}초 멈춥니다 · 자원은 그대로`);if(navigator.vibrate)navigator.vibrate([30,40,30]);return}
    this.lastPower=LaunchRules.power(holdMs);
    if(navigator.vibrate)navigator.vibrate(20);
  }
}
class BattlePresentation{
  static tacticalChestModalIsOpen(){return UiRuntimeState.value.modal==="spell-choice"}
  static tacticalChestModalAwaitingOffer(){return UiRuntimeState.value.modalState.spellChoice==="requesting"}

  static setupCanvas(){
  const pointerPreview=e=>{
    if(!ActiveViewState.renderer||!ActiveViewState.snap)return;
    const[vx,vy]=ActiveViewState.renderer.pxToWorld(e.clientX,e.clientY);
    const a=UiController.viewToAuth(vx,vy);

    if(UiRuntimeState.value.target.type==="build"){
      const action={type:"BUILD",building:UiRuntimeState.value.target.building,produceType:UiRuntimeState.value.target.produceType||null,x:a.x,y:a.y};
      const err=BuildingPresentation.buildValidation(ActiveViewState.snap,ConnectionSideUtil.roleSide(ActiveViewState.role),action);
      const density=BuildingPresentation.previewBuildDensity(ConnectionSideUtil.roleSide(ActiveViewState.role),action);

      let previewX=vx,previewY=vy;
      if(BuildingDefinition.get(UiRuntimeState.value.target.building)?.isGasExtractor){
        const gas=MatchLifecycle.activeSession()?.sim?.nearestGasNodeAt(action.x,action.y);
        if(gas){
          previewX=ActiveViewState.renderer.viewX(gas.x);
          previewY=ActiveViewState.renderer.viewY(gas.y);
        }
      }

      ActiveViewState.renderer.buildPreview={x:previewX,y:previewY,building:UiRuntimeState.value.target.building,valid:!err,error:err,density};
      if(density){
        const label=UiRuntimeState.value.target.produceType
          ? `${UnitDefinition.get(UiRuntimeState.value.target.produceType).name} ${BuildingDefinition.get(UiRuntimeState.value.target.building)?.productionLabel||BuildingDefinition.get(UiRuntimeState.value.target.building)?.name||"생산시설"}`
          : (BuildingDefinition.get(UiRuntimeState.value.target.building)?.name||"건물");
        const metric=density.kind==="defense"?"발사효율":"생산효율";
        const group=density.kind==="defense"?"방어건물":"생산건물";
        UiRegistry.refs.hint.innerHTML=density.penalty>0
          ? `<span class="build-preview-label">🏗️ <b>${label}</b></span> · <b style="color:#b34818">예상 ${metric} ${density.speed}% (-${density.penalty}%)</b><br>주변 ${group} ${density.near}개 · ${group==="포탑"?DEFENSE_CLUSTER_RADIUS:PRODUCTION_CLUSTER_RADIUS} 이내 밀집`
          : `<span class="build-preview-label">🏗️ <b>${label}</b></span> · <b style="color:#247343">예상 ${metric} 100%</b><br>주변 ${group} 없음`;
      }
      return;
    }

    if(UiRuntimeState.value.target.type==="spell"){
      const sim=MatchLifecycle.activeSession()?.sim,d=SpellDefinition.get(UiRuntimeState.value.target.spellId);
      if(!sim||!d)return;
      const margin=UiRuntimeState.value.target.spellId==="tunnel"&&UiRuntimeState.value.target.stage==="entry"?0:d.castMargin;
      const valid=sim.spellTargetAllowed(ConnectionSideUtil.roleSide(ActiveViewState.role),a.x,a.y,margin);
      ActiveViewState.renderer.spellPreview={
        spellId:UiRuntimeState.value.target.spellId,x:vx,y:vy,valid,
        entry:UiRuntimeState.value.target.entryView?{x:UiRuntimeState.value.target.entryView.x,y:UiRuntimeState.value.target.entryView.y}:null
      };
    }
  };

  let nextChargedCastId=0;
  const pendingChargeCancels=new Map();
  let chargeCancelRetry=0;
  const retryChargeCancels=()=>{
    chargeCancelRetry=0;
    for(const [key,hold] of pendingChargeCancels){
      if(hold.session!==MatchLifecycle.activeSession()||hold.session.disposed||hold.session.simEnded||hold.session.command({type:'CHARGE_CANCEL',castId:hold.castId}))pendingChargeCancels.delete(key);
    }
    if(pendingChargeCancels.size)chargeCancelRetry=setTimeout(retryChargeCancels,100);
  };
  const cancelChargedSkillHold=(cancelCast=true)=>{
    const hold=ActiveViewState.drag?.chargedSkillHold;
    if(hold?.timer){clearTimeout(hold.timer);hold.timer=0}
    if(hold?.aimTimer){clearTimeout(hold.aimTimer);hold.aimTimer=0}
    if(hold)hold.aimDirty=false;
    if(cancelCast&&hold?.accepted){
      if(!hold.session.command({type:'CHARGE_CANCEL',castId:hold.castId})){
        pendingChargeCancels.set(hold.castId,hold);
        if(!chargeCancelRetry)chargeCancelRetry=setTimeout(retryChargeCancels,100);
      }
      hold.accepted=false;
    }
    if(ActiveViewState.renderer)ActiveViewState.renderer.chargedSkillGesture=null;
  };

  const flushChargedAim=hold=>{
    hold.aimTimer=0;
    if(ActiveViewState.drag?.chargedSkillHold!==hold||!hold.accepted||hold.session!==MatchLifecycle.activeSession()||hold.session.disposed||hold.session.simEnded||UiRuntimeState.value.target.type!=='flag'){
      hold.aimDirty=false;return;
    }
    const tick=hold.session.sim?.tick;
    if(hold.aimDirty&&tick!==hold.lastAimTick&&hold.session.command({type:'CHARGE_AIM',castId:hold.castId,x:hold.aimX,y:hold.aimY})){
      hold.lastAimTick=tick;hold.aimDirty=false;
    }
    // At most one queued callback for the active pointer. A final point that arrived
    // after this tick's first move survives until the next simulation tick.
    if(hold.aimDirty)hold.aimTimer=setTimeout(()=>flushChargedAim(hold),25);
  };

  const armChargedSkillHold=e=>{
    // Replay canvas is camera-only. Never arm any gameplay target/long-press state.
    if(ReplayPresentation.replayPlayer)return;
    if(UiRuntimeState.value.target.type!=="flag"||!ActiveViewState.renderer||!ActiveViewState.snap||!ActiveViewState.drag)return;
    const [vx,vy]=ActiveViewState.renderer.pxToWorld(e.clientX,e.clientY);
    const a=UiController.viewToAuth(vx,vy);
    // Long press on an own building remains building selection, never a rally order.
    if(BuildingPresentation.ownBuildingAt(a.x,a.y))return;
    const session=MatchLifecycle.activeSession(),side=ConnectionSideUtil.roleSide(ActiveViewState.role);
    const hold={x:vx,y:vy,authX:a.x,authY:a.y,session,side,castId:0,triggered:false,accepted:false,timer:0,aimTimer:0,aimDirty:false,lastAimTick:-1,pointerType:e.pointerType};
    ActiveViewState.drag.chargedSkillHold=hold;
    hold.timer=setTimeout(()=>{
      if(!ActiveViewState.drag||ActiveViewState.drag.id!==e.pointerId||ActiveViewState.drag.moved||UiRuntimeState.value.target.type!=="flag")return;
      const live=ActiveViewState.drag.chargedSkillHold;
      if(!live||live!==hold||live.triggered)return;
      const sess=MatchLifecycle.activeSession();
      if(!sess?.sim||sess!==session)return;
      live.triggered=true;
      live.timer=0;
      hold.castId=nextChargedCastId=Math.max(nextChargedCastId,sess.sim.chargedCastSerial?.[side]||0)+1;
      hold.accepted=sess.command({type:'CHARGE_BEGIN',castId:hold.castId,x:hold.authX,y:hold.authY});
      if(hold.accepted){
        ActiveViewState.renderer.chargedSkillGesture={castId:hold.castId,side,x:vx,y:vy,aimX:hold.authX,aimY:hold.authY,pointerType:e.pointerType};
        if(navigator.vibrate)navigator.vibrate(18);
        LogUtil.log('집결·충전 명령 접수 · 전장에 확정된 준비 상태와 착탄점 표시');
      }else LogUtil.log('현재 스킬 명령을 접수할 수 없습니다.');
    },CHARGED_SKILL_HOLD_MS);
  };

  // Launch: a still press arms charging; dragging before that pans the camera.
  const armLaunchHold=e=>{
    const drag=ActiveViewState.drag;
    drag.launchTimer=setTimeout(()=>{
      drag.launchTimer=0;
      if(ActiveViewState.drag!==drag||drag.moved||!ActiveViewState.renderer)return;
      const [vx,vy]=ActiveViewState.renderer.pxToWorld(drag.lastX,drag.lastY);
      drag.launchHold=LaunchPresentation.begin(UiController.viewToAuth(vx,vy),drag.id);
    },CHARGED_SKILL_HOLD_MS);
  };
  const cancelLaunchHold=()=>{
    const drag=ActiveViewState.drag;if(drag?.launchTimer){clearTimeout(drag.launchTimer);drag.launchTimer=0}
    if(drag)drag.launchHold=null;LaunchPresentation.cancel();
  };

  const battlefieldPointerDown=e=>{
    if(ActiveViewState.drag&&ActiveViewState.drag.id!==e.pointerId)return;
    if(ActiveViewState.drag){cancelChargedSkillHold(true);cancelLaunchHold()}
    audioSystem.unlock();
    e.preventDefault();
    if(!ActiveViewState.renderer)return;

    // Replay accepts only camera drag. Do not create build/spell previews,
    // selection state, predicted flags, or long-press gameplay feedback.
    if(!ReplayPresentation.replayPlayer)pointerPreview(e);
    else{
      ActiveViewState.renderer.buildPreview=null;
      ActiveViewState.renderer.spellPreview=null;
      ActiveViewState.renderer.chargedSkillGesture=null;
      ActiveViewState.renderer.predictedFlag=null;
      ActiveViewState.renderer.pendingBuildGhosts=[];
      ActiveViewState.renderer.selectedBuildingId=null;
    }

    ActiveViewState.drag={
      id:e.pointerId,
      x:e.clientX,
      y:e.clientY,
      lastX:e.clientX,
      lastY:e.clientY,
      left:ActiveViewState.renderer.cameraLeft,
      top:ActiveViewState.renderer.cameraTop,
      moved:false,
      started:performance.now()
    };
    if(LaunchPresentation.active())armLaunchHold(e);else armChargedSkillHold(e);
  };

  const battlefieldPointerMove=e=>{
    if(!ActiveViewState.renderer)return;
    if(!ReplayPresentation.replayPlayer&&(UiRuntimeState.value.target.type==="build"||UiRuntimeState.value.target.type==="spell"))pointerPreview(e);
    if(!ActiveViewState.drag||ActiveViewState.drag.id!==e.pointerId)return;
    e.preventDefault();

    const total=Math.hypot(e.clientX-ActiveViewState.drag.x,e.clientY-ActiveViewState.drag.y);
    if(ActiveViewState.drag.launchHold){
      const [vx,vy]=ActiveViewState.renderer.pxToWorld(e.clientX,e.clientY);LaunchPresentation.aim(UiController.viewToAuth(vx,vy));
      ActiveViewState.drag.lastX=e.clientX;ActiveViewState.drag.lastY=e.clientY;return;
    }
    const hold=ActiveViewState.drag.chargedSkillHold;
    if(hold?.triggered){
      if(hold.accepted&&UiRuntimeState.value.target.type==='flag'){
        const [vx,vy]=ActiveViewState.renderer.pxToWorld(e.clientX,e.clientY),a=UiController.viewToAuth(vx,vy);
        hold.aimX=a.x;hold.aimY=a.y;hold.aimDirty=true;
        const gesture=ActiveViewState.renderer.chargedSkillGesture;
        if(gesture?.castId===hold.castId){gesture.aimX=a.x;gesture.aimY=a.y}
        if(!hold.aimTimer)flushChargedAim(hold);
      }else cancelChargedSkillHold(true);
      ActiveViewState.drag.lastX=e.clientX;ActiveViewState.drag.lastY=e.clientY;return;
    }
    if(total>CHARGED_SKILL_DRAG_PX&&!ActiveViewState.drag.moved){
      ActiveViewState.drag.moved=true;
      cancelChargedSkillHold(true);cancelLaunchHold();
    }

    // 건설 모드에서는 짧은 손가락 흔들림을 카메라 드래그로 오인하지 않는다.
    if(ActiveViewState.drag.moved){
      const rect=UiRegistry.refs.canvas.getBoundingClientRect(),
        dx=(e.clientX-ActiveViewState.drag.x)*UiRegistry.refs.canvas.width/rect.width,
        dy=(e.clientY-ActiveViewState.drag.y)*UiRegistry.refs.canvas.height/rect.height,
        scale=ActiveViewState.renderer.sc();
      ActiveViewState.renderer.cameraLeft=RangeUtil.clamp(ActiveViewState.drag.left-dx/scale,0,Math.max(0,(ActiveViewState.renderer?.world||WorldContext.standard).width-ActiveViewState.renderer.viewWorldW()));
      ActiveViewState.renderer.cameraTop=ActiveViewState.renderer.clampCameraTop(ActiveViewState.drag.top-dy/scale);
      if(LocalEnvironmentUtil.isLocalTest()){
        ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft=ActiveViewState.renderer.cameraLeft;
        ViewRuntimeState.byRole[ActiveViewState.role].cameraTop=ActiveViewState.renderer.cameraTop;
      }
      pointerPreview(e);
    }
    ActiveViewState.drag.lastX=e.clientX;
    ActiveViewState.drag.lastY=e.clientY;
  };

  const battlefieldPointerCancel=e=>{
    if(ActiveViewState.drag&&ActiveViewState.drag.id===e.pointerId){
      cancelChargedSkillHold(true);cancelLaunchHold();
      ActiveViewState.drag=null;
    }
  };

  const battlefieldPointerUp=e=>{
    if(!ActiveViewState.renderer||!ActiveViewState.snap)return;
    e.preventDefault();
    if(!ActiveViewState.drag||ActiveViewState.drag.id!==e.pointerId)return;

    const moved=ActiveViewState.drag.moved||Math.hypot(e.clientX-ActiveViewState.drag.x,e.clientY-ActiveViewState.drag.y)>CHARGED_SKILL_DRAG_PX;
    if(ActiveViewState.drag.launchTimer){clearTimeout(ActiveViewState.drag.launchTimer);ActiveViewState.drag.launchTimer=0}
    if(ActiveViewState.drag.launchHold){
      const [vx,vy]=ActiveViewState.renderer.pxToWorld(e.clientX,e.clientY);
      ActiveViewState.drag=null;LaunchPresentation.release(UiController.viewToAuth(vx,vy));return;
    }
    const hold=ActiveViewState.drag.chargedSkillHold||null;
    if(hold?.timer)clearTimeout(hold.timer);
    if(hold?.aimTimer){clearTimeout(hold.aimTimer);hold.aimTimer=0}
    if(hold)hold.aimDirty=false;
    if(hold?.triggered){
      if(hold.accepted){
        const [vx,vy]=ActiveViewState.renderer.pxToWorld(e.clientX,e.clientY),a=UiController.viewToAuth(vx,vy);
        if(UiRuntimeState.value.target.type==='flag'){
          if(!hold.session.command({type:'CHARGE_RELEASE',castId:hold.castId,x:a.x,y:a.y})){
            cancelChargedSkillHold(true);LogUtil.log('발사 명령을 접수할 수 없어 충전을 취소합니다.');
          }
        }else cancelChargedSkillHold(true);
      }
      if(ActiveViewState.renderer)ActiveViewState.renderer.chargedSkillGesture=null;
      ActiveViewState.drag=null;return;
    }
    ActiveViewState.drag=null;
    if(!ReplayPresentation.replayPlayer)pointerPreview(e);
    if(moved)return;
    if(ReplayPresentation.replayPlayer)return;
    // Launch mode has no tap commands: a short tap neither flags nor selects.
    if(LaunchPresentation.active())return;

    const[vx,vy]=ActiveViewState.renderer.pxToWorld(e.clientX,e.clientY);
    const a=UiController.viewToAuth(vx,vy);
    const sess=MatchLifecycle.activeSession();

    // 스펠 타게팅 모드에서는 건물 선택보다 시전이 우선한다.
    if(UiRuntimeState.value.target.type==="spell"){
      if(!sess?.sim)return;
      const d=SpellDefinition.get(UiRuntimeState.value.target.spellId);
      const margin=UiRuntimeState.value.target.spellId==="tunnel"&&UiRuntimeState.value.target.stage==="entry"?0:d.castMargin;
      if(!sess.sim.spellTargetAllowed(ConnectionSideUtil.roleSide(ActiveViewState.role),a.x,a.y,margin)){
        LogUtil.log("⚠ 현재 시야/전술 투사 범위 밖입니다.");
        return;
      }

      if(UiRuntimeState.value.target.spellId==="tunnel"){
        if(UiRuntimeState.value.target.stage==="entry"){
          UiController.setMode({
            type:"spell",spellId:"tunnel",stage:"exit",
            entryX:a.x,entryY:a.y,entryView:{x:vx,y:vy}
          });
          LogUtil.log("⛏ 땅굴 출구를 지정하세요. 입구보다 최소 220 이상 떨어져야 합니다.");
          return;
        }
        if(Math.hypot(a.x-UiRuntimeState.value.target.entryX,a.y-UiRuntimeState.value.target.entryY)<220){
          LogUtil.log("⚠ 땅굴 출구가 입구와 너무 가깝습니다.");
          return;
        }
        ActiveViewState.renderer?.predictSpellCast("tunnel",{entryX:UiRuntimeState.value.target.entryX,entryY:UiRuntimeState.value.target.entryY,exitX:a.x,exitY:a.y});
        sess.command({
          type:"CAST_SPELL",spellId:"tunnel",
          entryX:UiRuntimeState.value.target.entryX,entryY:UiRuntimeState.value.target.entryY,exitX:a.x,exitY:a.y
        });
        {const st=sess.sim.spellStats(ConnectionSideUtil.roleSide(ActiveViewState.role),"tunnel");LogUtil.log(`⛏ 땅굴 굴착 시작 · ${Math.ceil((st?.buildTime||0)/SimulationTiming.tps())}초 후 단방향 통로 활성화`)}
      }else{
        ActiveViewState.renderer?.predictSpellCast(UiRuntimeState.value.target.spellId,{x:a.x,y:a.y});
        sess.command({type:"CAST_SPELL",spellId:UiRuntimeState.value.target.spellId,x:a.x,y:a.y});
        LogUtil.log(`${d.icon} ${d.name} 시전 명령 접수`);
      }
      if(ActiveViewState.renderer)ActiveViewState.renderer.spellPreview=null;
      UiController.setMode({type:"flag"});
      return;
    }

    // 아군 건물을 탭/클릭한 경우 명령 지점이 아니라 "건물 선택"으로 처리한다.
    // 특히 깃발 모드에서도 건물 위에는 절대 깃발을 꽂지 않는다.
    const ownBuilding=BuildingPresentation.ownBuildingAt(a.x,a.y);
    if(ownBuilding){
      BuildingPresentation.selectBuilding(ownBuilding.id);
      LogUtil.log(`▣ ${BuildingDefinition.get(ownBuilding.type)?.name||"건물"} 선택`);
      return;
    }

    // 빈 전장을 누르면 기존 건물 선택은 해제하고 원래 명령을 수행한다.
    if(UiRuntimeState.value.selection.buildingId)BuildingPresentation.selectBuilding(null);

    if(!sess||!sess.sim){
      LogUtil.log("⚠ 게임 시뮬레이션이 아직 준비되지 않았습니다.");
      return;
    }

    if(UiRuntimeState.value.target.type==="flag"){
      ActiveViewState.renderer?.predictFlag(a.x,a.y,false);
      sess.command({type:"SET_FLAG",x:a.x,y:a.y,forced:false});
      if(ActiveViewState.renderer)ActiveViewState.renderer.chargedSkillGesture=null;
      if(navigator.vibrate)navigator.vibrate(18);
      LogUtil.log("✓ 일반 집결 깃발 명령 접수");
      return;
    }

    if(UiRuntimeState.value.target.type==="build"){
      const action={type:"BUILD",building:UiRuntimeState.value.target.building,produceType:UiRuntimeState.value.target.produceType||null,x:a.x,y:a.y};
      const err=BuildingPresentation.buildValidation(ActiveViewState.snap,ConnectionSideUtil.roleSide(ActiveViewState.role),action);
      if(err){
        LogUtil.log("⚠ "+err);
        if(ActiveViewState.renderer)ActiveViewState.renderer.buildPreview={
          x:vx,y:vy,building:UiRuntimeState.value.target.building,valid:false,error:err,
          density:BuildingPresentation.previewBuildDensity(ConnectionSideUtil.roleSide(ActiveViewState.role),action)
        };
        return;
      }

      const density=BuildingPresentation.previewBuildDensity(ConnectionSideUtil.roleSide(ActiveViewState.role),action);
      // Latency hiding: show the exact selected building immediately at 30% opacity.
      // Resource spend / collision / construction progress remain authoritative.
      ActiveViewState.renderer?.predictBuild(action);
      sess.command(action);
      if(BuildingDefinition.get(UiRuntimeState.value.target.building)?.isGasExtractor){
        LogUtil.log(`✓ 가스 추출장 건설 명령 · ${BuildingDefinition.get(UiRuntimeState.value.target.building)?.cost||0} 미네랄 · 가스 지점 고정`);
      }else if(density&&density.penalty>0){
        LogUtil.log(`✓ 건설 접수 · 밀집 생산속도 ${density.speed}% (-${density.penalty}%)`);
      }else{
        LogUtil.log(`✓ ${BuildingDefinition.get(UiRuntimeState.value.target.building).name} 건설 명령 접수 · ${((MatchLifecycle.activeSession()?.netcodeSession?.inputDelay||0)/SimulationTiming.tps()).toFixed(2)}초 입력 지연`);
      }

      // 연속 건설 UX: 전장 안에서는 같은 건설 모드를 계속 유지한다.
      // 전장 밖 UI를 선택하면 document capture 단계에서 즉시 건설 모드를 해제한다.
      if(ActiveViewState.renderer)ActiveViewState.renderer.buildPreview=null;
      // 연속 건설 종료 안내는 전장 하단 buildFinishBtn 하나로 통일.
      LogUtil.log("↻ 같은 건물 연속 배치 모드 유지");
    }
  };
  const battlefieldInput=RallyGamekit.createDOMInput({target:UiRegistry.refs.canvas,
    pointerButtons:{0:'battlefield'},touchAction:'none',
    onPointer:point=>{
      const event=point.originalEvent||point;
      // Points on a hidden battlefield cannot aim: a press there is ignored and a release cancels the hold.
      if(point.type!=='cancel'&&ActiveViewState.renderer&&!ActiveViewState.renderer.hasDisplayArea()){
        if(point.type==='up')battlefieldPointerCancel(event);
        return;
      }
      if(point.type==='down')battlefieldPointerDown(event);
      else if(point.type==='move')battlefieldPointerMove(event);
      else{
        try{if(point.type==='up')battlefieldPointerUp(event);else battlefieldPointerCancel(event)}
        finally{if(ActiveViewState.drag?.id===point.pointerId){cancelChargedSkillHold(true);ActiveViewState.drag=null}}
      }
    },onRelease:()=>{cancelChargedSkillHold(true);ActiveViewState.drag=null;pointerInteractions.cancelActive()}
  });

}

  static detailForUnit(id){
  const d=UnitDefinition.get(id),info=UnitDefinition.cardInfo[id]||{},ability=ABILITY_INFO[id]||{};
  if(!d)return null;
  const rows=[
    `T${d.tier} · ${d.layer||"GROUND"} · ${SIZE_CLASS_LABEL[d.sizeClass]||d.sizeClass||""}`,
    `HP ${d.hp??"-"} · 공격 ${d.atk??"-"} · 사거리 ${d.range??"-"}`,
    `대지 ${d.canAttackGround?"O":"X"} · 대공 ${d.canAttackAir?"O":"X"} · 보급 ${d.supply??0}`
  ];
  const researchDetails=[];
  if(ability.name)researchDetails.push(`<b>${ability.name}</b> · ${DefinitionDetails.ability(id)}`);
  for(const r of UnitSpecialResearchDefinition.forUnit(id))researchDetails.push(`<b>${r.name}</b> · ${DefinitionDetails.special(r)}`);
  const body=[info.desc,DefinitionDetails.unit(id),...researchDetails].filter(Boolean).join("<br><br>");
  return {title:d.name,icon:info.icon||"◆",kicker:"UNIT",body:body||"전투 유닛",meta:rows.join(" · ")};
}
  static unitRoleLabel(roleName){
  const labels={
    bruiser:"근접 전투",
    pikeman:"대돌격",
    ranged:"장거리",
    skirmisher:"기동 사격",
    guardian:"방어",
    assassin:"암살",
    caster:"광역 마법",
    charger:"돌격",
    support:"지원",
    controller:"제어",
    artillery:"포병"
  };
  return labels[roleName]||roleName||"-";
}
  static renderTacticalRewardCard(reward,books){
  if(reward.type==="passive"){
    const d=PassiveCardDefinition.get(reward.passiveId);
    const from=Math.max(0,Number(reward.fromLevel)||0),to=Math.max(1,Number(reward.toLevel)||1);
    const fromValue=from>0?d.values[from-1]:0,toValue=d.values[to-1];
    const levelText=d.maxLevel===1?"고유 패시브":`Lv.${from} → Lv.${to}`;
    const valueText=d.maxLevel===1?`${toValue}${d.suffix}`:`+${fromValue}${d.suffix} → +${toValue}${d.suffix}`;
    return `<button type="button" class="spell-card ready tactical-reward-card tactical-passive" data-tactical-reward="${reward.id}"><div class="tactical-reward-kind">패시브</div><div class="spell-icon">${d.icon}</div><div class="spell-name">${d.name}</div><div class="spell-desc"><b>${levelText}</b> · ${d.desc}</div><div class="spell-stat-row"><span>${d.statLabel}</span><b>${valueText}</b></div><div class="spell-meta">${d.maxLevel===1?"재획득 없음":"같은 카드 재획득 시 강화"} · 상시 발동</div></button>`;
  }
  if(reward.type==="economy"){
    return `<button type="button" class="spell-card ready tactical-reward-card tactical-economy" data-tactical-reward="${reward.id}"><div class="tactical-reward-kind">경제</div><div class="spell-icon">${reward.icon||"📦"}</div><div class="spell-name">${reward.name}</div><div class="spell-desc">${reward.desc||"즉시 자원 획득"}</div><div class="spell-meta">선택 즉시 상자 1개 소비</div></button>`;
  }
  const id=reward.spellId,d=SpellDefinition.get(id),e=books[id]||{mastery:0,unlocked:false};
  if(reward.type==="spell-upgrade"){
    const from=SpellDefinition.masteryLevel(e.mastery||0),to=Math.min(SPELL_MASTERY_MAX+1,from+1);
    return `<button type="button" class="spell-card ready tactical-reward-card tactical-spell" data-tactical-reward="${reward.id}"><div class="tactical-reward-kind">스펠</div><div class="spell-icon">${d.icon}</div><div class="spell-name">${d.name} 숙련 강화</div><div class="spell-desc"><b>Lv.${from} → Lv.${to}</b></div>${SpellPresentation.formatSpellUpgradeRows(SpellDefinition.upgradeRows(id,e.mastery||0))}<div class="spell-meta">현재 남은 쿨다운도 30초 단축</div></button>`;
  }
  const reEquip=reward.type==="spell-equip";
  return `<button type="button" class="spell-card ready tactical-reward-card tactical-spell" data-tactical-reward="${reward.id}"><div class="tactical-reward-kind">스펠</div><div class="spell-icon">${d.icon}</div><div class="spell-name">${d.name}</div><div class="spell-desc">${reEquip?`보유 스펠 재장착 · Lv.${SpellDefinition.masteryLevel(e.mastery||0)}`:`신규 스펠 · Lv.1`}</div>${SpellPresentation.formatSpellRows(SpellDefinition.statRows(id,e.mastery||0))}<div class="spell-meta">3슬롯이 가득 찼으면 빼기 선택</div></button>`;
}
  static renderPassiveStatus(state){
  if(!state||!ActiveViewState.role)return;
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role),owned=state.passiveCards?.[side]||{};
  const entries=PassiveCardDefinition.ids
    .map(id=>({id,level:Math.max(0,Number(owned[id])||0),def:PassiveCardDefinition.get(id)}))
    .filter(x=>x.level>0);

  const levelText=(d,lv)=>d.maxLevel===1?"적용 중":`Lv.${lv}/${d.maxLevel}`;
  const effectText=(d,lv)=>{
    const value=Number(d.values?.[Math.min(lv,d.values.length)-1])||0;
    if(d.formatKind==="blockedHits")return `피해 ${value}회 완전 무효`;
    return `${d.statLabel} +${value}${d.suffix}`;
  };
  const html=entries.length
    ? `<div class="passive-status-head"><b>상시 패시브</b><span>${entries.length}/${PassiveCardDefinition.ids.length}종 보유 · 슬롯 없음</span></div><div class="passive-status-grid">${entries.map(({def:d,level})=>`<div class="passive-status-card"><div class="passive-name"><span>${d.icon}</span><span>${d.name}</span><span class="passive-level">${levelText(d,level)}</span></div><div class="passive-effect">${effectText(d,level)}</div></div>`).join("")}</div>`
    : `<div class="passive-status-head"><b>상시 패시브</b><span>0/${PassiveCardDefinition.ids.length}종</span></div><div class="passive-status-empty">아직 획득한 패시브 카드가 없습니다. 전술상자에서 획득하면 즉시 적용됩니다.</div>`;

  if(UiRegistry.refs.passiveStatusHome&&UiRegistry.refs.passiveStatusHome.innerHTML!==html)UiRegistry.refs.passiveStatusHome.innerHTML=html;
  if(UiRegistry.refs.passiveStatusChest&&UiRegistry.refs.passiveStatusChest.innerHTML!==html)UiRegistry.refs.passiveStatusChest.innerHTML=html;
}
  static renderTacticalChest(state){
  if(!state||!ActiveViewState.role||!UiRegistry.refs.tacticalChestArea)return;
  BattlePresentation.renderPassiveStatus(state);
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role),count=Number(state.spellChests?.[side])||0,offer=state.pendingChestOffers?.[side]||null,replacement=state.pendingSpellReplacement?.[side]||null;
  BattlePresentation.updateTacticalChestBadge(state);
  let html=`<div class="command-pane-copy"><b>📦 전술상자 ${count}개</b> · 상자는 최종 보상을 선택할 때만 1개 소비됩니다.</div>`;
  if(count>0){
    html+=`<button type="button" class="command-card command-card-wide" data-open-tactical-chest="1">📦<b>${offer||replacement?"전술상자 다시 열기":"전술상자 열기"}</b><small>${offer||replacement?"기존 보상 3택 그대로 · 취소 가능":"현재 유효 보상 중 랜덤 3개 · 취소 가능"}</small></button>`;
  }else{
    html+=`<div class="small">전술 오브젝트를 정리하면 상자를 획득합니다. 강제 팝업은 뜨지 않습니다.</div>`;
  }
  if(offer||replacement)html+=`<div class="spell-choice-inline-hint">선택 대기 중인 상자가 있습니다. 메뉴를 닫거나 팝업 바깥을 눌러도 후보와 상자 개수는 유지됩니다.</div>`;
  if(UiRegistry.refs.tacticalChestArea.innerHTML!==html)UiRegistry.refs.tacticalChestArea.innerHTML=html;
  SpellPresentation.renderSpellChoiceModal(state);
}
  static productionDeck(state,side){
    const decks=state?.decks;
    if(!Array.isArray(decks)||decks.length!==2||!decks.every(deck=>Array.isArray(deck)&&deck.every(id=>typeof id==="string"&&Object.hasOwn(UnitDefinition.all,id))))return null;
    return decks[side]??null;
  }
  static renderGame(s){
  // An already queued snapshot must never switch Result back to Game.
  if(UiRuntimeState.value.screen==="result")return;
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role);
  const liveSession=MatchLifecycle.activeSession();
  const deck=BattlePresentation.productionDeck(s,side);
  if(!liveSession?.sim||deck===null){
    DiagnosticPresentation.presentFatalDiagnostic({
      kind:"RALLY_FRONTIER_PRESENTATION_CONTRACT_FATAL",
      build:BUILD_META.id,buildMetadata:BUILD_META.snapshot(),at:new Date().toISOString(),source:"BattlePresentation.renderGame",
      role:ActiveViewState.role,tick:Number(s?.tick)||0,
      message:!liveSession?.sim
        ?"Live snapshot reached game presentation without an active simulation."
        :"Live snapshot reached game presentation without valid authoritative production decks."
    });
    return;
  }

  // BattlePresentation.renderGame() is also the recurring live-snapshot render path.
  // Transient battle UI must be reset only when entering the game screen;
  // otherwise every snapshot closes an open command drawer immediately.
  const enteringGame=UiRuntimeState.value.screen!=="game";
  UiController.setUiScreen("game");
  if(enteringGame){BattlePresentation.closeTransientBattleUi();CampaignPresentation.onGameEnter();}
  if(MatchLifecycle.activeSession?.()?.sim?.campaignScenario)CampaignPresentation.consume(s);
  UiController.closeUiModal("create");UiController.closeUiModal("join");
  
  if(LocalEnvironmentUtil.isLocalTest())ViewRuntimeState.byRole[ActiveViewState.role].snapshot=s;
  ActiveViewState.snap=s;
  
  
  
  
  requestAnimationFrame(()=>ConnectionPresentation.positionP2PHealthNextToMenu());

  const rendererRoleChanged=!!ActiveViewState.renderer&&ActiveViewState.renderer.role!==ActiveViewState.role;
  if(!ActiveViewState.renderer){
    ActiveViewState.renderer=new GLRenderer(UiRegistry.refs.canvas);
    ActiveViewState.renderer.role=ActiveViewState.role;
    LogUtil.log(`렌더러 ${ActiveViewState.renderer.backend} · 입력/UI ${STATE_PUBLISH_HZ}Hz · Render Target ${SimulationTiming.tps()}Hz · 시뮬 ${SimulationTiming.tps()}TPS · 렌더 rAF 60Hz+`);
    ActiveViewState.renderer.cameraLeft=0;
    ActiveViewState.renderer.cameraTop=(ActiveViewState.renderer?.world||WorldContext.standard).height-VIEW_H;
  }else{
    ActiveViewState.renderer.role=ActiveViewState.role;
  }
  // Live gameplay owns its faction strictly from role. Replay-only fields must never
  // leak into host/guest colors, FoW ownership or minimap ownership.
  if(UiRuntimeState.value.screen!=="replay"){
    ActiveViewState.renderer.replayPerspectiveSide=null;
    ActiveViewState.renderer.replayOrientationRole=null;
    ActiveViewState.renderer.replayVisionMode=null;
    ActiveViewState.renderer.replayObserverAll=false;
  }
  if(!ActiveViewState.minimap)ActiveViewState.minimap=new MiniMap(UiRegistry.refs.minimapCanvas);

  if(LocalEnvironmentUtil.isLocalTest()){
    if(ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft!=null)ActiveViewState.renderer.cameraLeft=ViewRuntimeState.byRole[ActiveViewState.role].cameraLeft;
    if(ViewRuntimeState.byRole[ActiveViewState.role].cameraTop!=null)ActiveViewState.renderer.cameraTop=ViewRuntimeState.byRole[ActiveViewState.role].cameraTop;
  }
  ActiveViewState.renderer.setSnapshot(s,{liveTargets:true,snapTargets:rendererRoleChanged});
  ActiveViewState.renderer.selectedBuildingId=UiRuntimeState.value.selection.buildingId;
  ActiveViewState.minimap.set(ActiveViewState.renderer,s);
  ActiveViewState.minimap.draw();
  audioSystem.processSnapshot(s,ActiveViewState.renderer);
  LaunchPresentation.render(s,side);

  const unlocked=deck.filter(t=>UnitDefinition.get(t)?.tier<=s.tech[side]);

  // 생산 카드 선택은 UI selection state이며, 생산 가능 여부는 authoritative deck/tech 상태에서 계산한다.
  if(!UiRuntimeState.value.selection.unit || !deck.includes(UiRuntimeState.value.selection.unit) || UnitDefinition.get(UiRuntimeState.value.selection.unit).tier>s.tech[side]){
    UiRuntimeState.value.selection.unit=unlocked[0] || deck[0] || null;
    if(LocalEnvironmentUtil.isLocalTest())ViewRuntimeState.byRole[ActiveViewState.role].selection.unit=UiRuntimeState.value.selection.unit;
  }

  const workers=s.units.filter(u=>u.alive&&u.side===side&&!!UnitDefinition.get(u.type)?.economyWorker).length;
  const wallet=Math.floor(s.wallet[side]);
  const gas=Math.floor(s.gasWallet?.[side]||0);
  const liveSim=liveSession.sim;
  const supplyUsed=liveSim.supplyUsed(side);
  const supplyCap=liveSim.supplyCap(side);

  const aggroEvent=[...(s.events||[])].reverse().find(e=>e.type==="neutralAggro");
  if(aggroEvent)LogUtil.log("⚠ 중립 캠프가 공격자에게 반격합니다.");

  const cancelEvent=[...(s.events||[])].reverse().find(e=>e.type==="buildCancelled"&&e.side===side);
  if(cancelEvent)LogUtil.log(`↩ ${cancelEvent.wasComplete?"건물 철거":"건설 취소"} 완료 · +${cancelEvent.refund} 미네랄${cancelEvent.gasRefund?` · +${cancelEvent.gasRefund} 가스`:""} 환불`);

  const exhaustedEvent=[...(s.events||[])].reverse().find(e=>e.type==="productionExhausted"&&e.side===side);
  if(exhaustedEvent){
    LogUtil.log(`🏚 ${UnitDefinition.get(exhaustedEvent.produceType)?.name||"병력"} 생산 완료 · 생산건물 소진 · +${exhaustedEvent.refund} 미네랄${exhaustedEvent.gasRefund?` · +${exhaustedEvent.gasRefund} 가스`:""} 환불`);
  }

    const researchEvent=[...(s.events||[])].reverse().find(e=>e.type==="researchComplete"&&e.side===side);
  if(researchEvent){
    LogUtil.log(researchEvent.research==="attack"
      ? `⚔ 공격 강화 완료 · Lv.${researchEvent.level}`
      : `🛡 방어 강화 완료 · Lv.${researchEvent.level}`);
  }
  const abilityEvent=[...(s.events||[])].reverse().find(e=>e.type==="abilityComplete"&&e.side===side);
  if(abilityEvent){
    LogUtil.log(`✦ ${UnitDefinition.get(abilityEvent.unit).name} 특수능력 해금 · ${ABILITY_INFO[abilityEvent.unit]?.name||"특수 전술"}`);
  }
  const specialResearchEvent=[...(s.events||[])].reverse().find(e=>e.type==="specialResearchComplete"&&e.side===side);
  if(specialResearchEvent){
    const rd=UnitSpecialResearchDefinition.get(specialResearchEvent.researchId);
    LogUtil.log(`✦ ${UnitDefinition.get(specialResearchEvent.unit)?.name||"병종"} 특수 연구 완료 · ${rd?.name||specialResearchEvent.researchId}`);
  }

  const campEvent=[...(s.events||[])].reverse().find(e=>e.type==="campClear"&&e.side===side);
  if(campEvent){
    const name=CampDefinition.get(campEvent.camp)?.name||"중립 캠프";
    LogUtil.log(`🐾 ${name} 정리 · 보너스 +${campEvent.bonus} 미네랄`);
  }

  const captureEvent=[...(s.events||[])].reverse().find(e=>e.type==="captureComplete"&&e.side===side);
  if(captureEvent)LogUtil.log(`🏳 ${captureEvent.label||captureEvent.lane} 점령 완료 · 전진 거점 확보`);

  const chestEvent=[...(s.events||[])].reverse().find(e=>e.type==="tacticalChestEarned"&&e.side===side);
  if(chestEvent){
    LogUtil.log(`📦 전술 오브젝트 확보 · 전술상자 +1 · 보유 ${chestEvent.count}`);
    BattlePresentation.showTacticalChestFeedback(chestEvent,s.tick);
  }
  const masteryEvent=[...(s.events||[])].reverse().find(e=>e.type==="spellMasteryUp"&&e.side===side);
  if(masteryEvent)LogUtil.log(`✦ ${SpellDefinition.get(masteryEvent.spell)?.name||"스펠"} Lv.${masteryEvent.fromLevel} → Lv.${masteryEvent.toLevel}`);
  const equipEvent=[...(s.events||[])].reverse().find(e=>e.type==="spellEquipped"&&e.side===side);
  if(equipEvent)LogUtil.log(`✦ ${SpellDefinition.get(equipEvent.spell)?.name||"스펠"} 장착${equipEvent.replaced?` · ${SpellDefinition.get(equipEvent.replaced)?.name||"스펠"} 빼기`:""}`);

  UiRegistry.refs.minerals.textContent=wallet;
  UiRegistry.refs.gas.textContent=gas;
  UiRegistry.refs.workers.textContent=workers;
  UiRegistry.refs.supply.textContent=supplyUsed+"/"+supplyCap;
  const supplyBlocked=liveSim?liveSim.productionSupplyBlocked(side):false;
  UiRegistry.refs.supplyChip.classList.toggle("supply-blocked",supplyBlocked);
  UiRegistry.refs.supplyWarning.classList.toggle("hidden",!supplyBlocked);
  UiRegistry.refs.tier.textContent="T"+s.tech[side];

  // Persistent whole-army reinforcement overview. This survives individual
  // production-building expiration so "why did this unit stop spawning?" is
  // visible without selecting a building.
  BattlePresentation.renderReinforcementOverview(s,liveSim,side,deck);
  UiRegistry.refs.tech2.classList.toggle("locked",s.tech[side]<2);
  UiRegistry.refs.tech3.classList.toggle("locked",s.tech[side]<3);
  UiRegistry.refs.attackUpgradeTag.textContent=`Lv.${liveSim?.attackUpgrade[side]||0}`;
  UiRegistry.refs.armorUpgradeTag.textContent=`Lv.${liveSim?.armorUpgrade[side]||0}`;
  if(UiRegistry.refs.pauseBtn){
    UiRegistry.refs.pauseBtn.innerHTML=s.productionPaused[side]
      ?`▶<b>생산 재개</b><small>눌러서 전체 재개</small>`
      :`⏸<b>생산 정지</b><small>전체 일시정지</small>`;
  }

  // 드래프트한 각 병종이 곧 생산건물 버튼이다.
  // 별도의 "병종 선택 → 배럭" 2단계를 없앤다.
  // 생산건물 전체 밀집 효율 요약.
  const prodBuildings=liveSim
    ? liveSim.buildings.filter(b=>b.alive!==false&&b.complete&&b.side===side&&BuildingDefinition.get(b.type)?.isProductionBuilding)
    : [];
  const penalized=prodBuildings.filter(b=>liveSim.productionSpeedPct(b)<100);
  if(penalized.length){
    const worst=Math.min(...penalized.map(b=>liveSim.productionSpeedPct(b)));
    UiRegistry.refs.productionEfficiencySummary.style.display="";
    UiRegistry.refs.productionEfficiencySummary.style.background="#fff3ed";
    UiRegistry.refs.productionEfficiencySummary.style.borderColor="#efb08e";
    UiRegistry.refs.productionEfficiencySummary.style.color="#9c3e17";
    UiRegistry.refs.productionEfficiencySummary.innerHTML=`⚠ 생산건물 ${penalized.length}개 밀집 패널티 · 최저 효율 <b>${worst}%</b>`;
  }else{
    UiRegistry.refs.productionEfficiencySummary.style.display=prodBuildings.length?"":"none";
    if(prodBuildings.length){
      UiRegistry.refs.productionEfficiencySummary.style.background="#edf8f0";
      UiRegistry.refs.productionEfficiencySummary.style.borderColor="#b9ddc4";
      UiRegistry.refs.productionEfficiencySummary.style.color="#247343";
      UiRegistry.refs.productionEfficiencySummary.innerHTML=`✓ 생산건물 ${prodBuildings.length}개 · 밀집 패널티 없음 · <b>100%</b>`;
    }
  }

  const tier=CommandPresentation.activeMilitaryTier();
  const tierUnits=tier?deck.filter(t=>UnitDefinition.get(t)?.tier===tier):[];
  const tierLocked=tier?s.tech[side]<tier:false;
  const tierLabels={
    1:"T1 · 기본 병종",
    2:"T2 · 특수/정예 병종",
    3:"T3 · 게임체인저"
  };
  if(UiRegistry.refs.militaryTierMeta){
    UiRegistry.refs.militaryTierMeta.innerHTML=tier
      ? `<b>${tierLabels[tier]}</b> · ${tierLocked?`🔒 T${tier} 해금 필요`:`${tierUnits.length}종 사용 가능`}`
      : "";
  }
  const unitGridHtml=tier
    ? tierUnits.map(t=>BuildingPresentation.productionCard(t,s)).join("")
    : "";
  // 동적 TPS 시뮬레이션 / 10Hz 스냅샷마다 버튼 DOM을 빼기하면 PC에서 mousedown/mouseup 사이에
  // 요소가 바뀌어 클릭이 사라질 수 있다. 실제 내용이 달라질 때만 갱신한다.
  if(unitGridHtml!==BattlePresentationCache.lastUnitGridHtml&&!UiController.interactivePointerHeldInside(UiRegistry.refs.unitGrid)){
    UiRegistry.refs.unitGrid.innerHTML=unitGridHtml;
    BattlePresentationCache.lastUnitGridHtml=unitGridHtml;
  }

  const supplyCost=BuildingDefinition.get(BuildingDefinition.forRole("supply")).cost;
  const gasExtractorCost=BuildingDefinition.get(BuildingDefinition.forRole("gasExtractor")).cost;
  const academyCost=BuildingDefinition.get(BuildingDefinition.forRole("academy")).cost;
  const airIncubatorCost=BuildingDefinition.get(BuildingDefinition.forRole("airTech")).cost;
  const airIncubatorGas=BuildingDefinition.gasCost(BuildingDefinition.forRole("airTech"));
  const labCost=BuildingDefinition.get(BuildingDefinition.forRole("lab")).cost;

  UiRegistry.refs.supplyBtn.disabled=wallet<supplyCost;
  UiRegistry.refs.gasExtractorBtn.disabled=wallet<gasExtractorCost;
  UiRegistry.refs.gasExtractorBtn.innerHTML=`⬡<b>가스 추출장</b><small>${gasExtractorCost} · 가스 지점</small>`;

  const ownTechBuilding=type=>s.buildings.find(b=>b.alive!==false&&b.side===side&&b.type===type)||null;
  const academyBuilding=ownTechBuilding("academy");
  const airIncubatorBuilding=ownTechBuilding("airIncubator");
  const labBuilding=ownTechBuilding("lab");

  // Tech construction cards always show their actual cost/status and mirror the
  // authoritative buildingAllowed() rules. Knowledge (tech level) survives a
  // destroyed Academy/Lab, but a replacement building can and must be rebuilt.
  UiRegistry.refs.academyBtn.disabled=!!BuildPrerequisitePolicy.buildingReason(s,side,"academy")||wallet<academyCost;
  UiRegistry.refs.academyBtn.innerHTML=academyBuilding
    ? `Ⅱ<b>아카데미</b><small>${academyCost} · ${academyBuilding.complete?"T2 인프라 가동 중 ✓":"건설 중"}</small>`
    : `Ⅱ<b>아카데미</b><small>${academyCost} · ${s.tech[side]>=2?"T2 인프라 재건":"T2 인프라"}</small>`;

  if(UiRegistry.refs.airIncubatorBtn){
    UiRegistry.refs.airIncubatorBtn.disabled=!!BuildPrerequisitePolicy.buildingReason(s,side,"airIncubator")||wallet<airIncubatorCost||gas<airIncubatorGas;
    UiRegistry.refs.airIncubatorBtn.innerHTML=airIncubatorBuilding
      ? `☁<b>공중 배양소</b><small>${airIncubatorCost} + ⬡${airIncubatorGas} · ${airIncubatorBuilding.complete?"AIR 가동 중 ✓":"건설 중"}</small>`
      : `☁<b>공중 배양소</b><small>${airIncubatorCost} + ⬡${airIncubatorGas} · AIR 해금</small>`;
  }

  const labLockReason=BuildPrerequisitePolicy.buildingReason(s,side,"lab");
  const labTechLocked=!!labLockReason;
  UiRegistry.refs.labBtn.disabled=!!labBuilding||labTechLocked||wallet<labCost;
  UiRegistry.refs.labBtn.innerHTML=labBuilding
    ? `Ⅲ<b>첨단 전술 연구소</b><small>${labCost} · ${labBuilding.complete?"T3 인프라 가동 중 ✓":"건설 중"}</small>`
    : `Ⅲ<b>첨단 전술 연구소</b><small>${labCost} · ${labTechLocked?`🔒 ${labLockReason}`:s.tech[side]>=3?"T3 인프라 재건":"T3 인프라"}</small>`;

  if(UiRuntimeState.value.target.type==="build"){
    const target=UiRuntimeState.value.target;
    if(BuildPrerequisitePolicy.buildingReason(s,side,target.building,target.produceType))UiController.setMode({type:"flag"},{silent:true});
  }
  const defenseCards=DefenseCardDefinition.list(s.defenseCards?.[side]||liveSim?.defenseCards?.[side]);
  if(UiRegistry.refs.defenseCardChoices){
    const defenseHtml=!defenseCards.length
      ? `<button class="command-card command-card-wide" disabled>✣<b>방어 카드</b><small>선택된 카드 없음</small></button>`
      : defenseCards.map(cardId=>{
          const card=DefenseCardDefinition.get(cardId),building=BuildingDefinition.get(card?.building),gasCost=card?BuildingDefinition.gasCost(card.building):0;
          const mineralCost=building?.cost||0;
          const mineralShortage=!!card&&wallet<mineralCost;
          const gasShortage=!!card&&gas<gasCost;
          const resourceShortage=mineralShortage||gasShortage;
          const disabled=!card||resourceShortage;
          const costText=`<span class="cost-part mineral${mineralShortage?" shortage":""}">◆ ${mineralCost}</span>${gasCost?`<span class="cost-sep">·</span><span class="cost-part gas${gasShortage?" shortage":""}">⬡ ${gasCost}</span>`:""}`;
          return `<button class="unit-card production-card defense-production-card longpress-info-target ${resourceShortage?"resource-shortage":""}" data-defense-build="${card?.building||""}" ${disabled?"disabled":""}>
            <div class="row"><span class="name"><span aria-hidden="true">${card?.icon||"✣"}</span> ${card?.name||"방어 카드"}</span></div>
            <div class="building-name">방어 건물 · 사거리 ${building?.range||0}</div>
            <span class="cost">${costText}</span>
          </button>`;
        }).join("");
    if(defenseHtml!==BattlePresentationCache.lastDefenseCardChoicesHtml&&!UiController.interactivePointerHeldInside(UiRegistry.refs.defenseCardChoices)){
      UiRegistry.refs.defenseCardChoices.innerHTML=defenseHtml;
      BattlePresentationCache.lastDefenseCardChoicesHtml=defenseHtml;
    }
  }
  UiRegistry.refs.supplyBtn.classList.toggle("danger",supplyBlocked);
  UiRegistry.refs.supplyBtn.innerHTML=supplyBlocked
    ? `⚠<b>보급소</b><small>${supplyCost} · +${BuildingDefinition.get(BuildingDefinition.forRole("supply")).supplyPlus} · 생산 재개</small>`
    : `▣<b>보급소</b><small>${supplyCost} · +${BuildingDefinition.get(BuildingDefinition.forRole("supply")).supplyPlus} 보급</small>`;

  // Build mode has one authoritative state (uiState.target). Whenever the drawer is open,
  // mirror that state back to the matching card instead of forcibly clearing it.
  BuildingPresentation.syncBuildPlacementSelectionUi();
  CommandPresentation.syncCommandDock();
  UiRegistry.refs.hint.classList.toggle("build-hint",UiRuntimeState.value.target.type==="build");

  if(UiRuntimeState.value.target.type==="flag"){
    const forced=!!ActiveViewState.snap?.flags?.[ConnectionSideUtil.roleSide(ActiveViewState.role)]?.forced;
    UiRegistry.refs.hint.textContent=forced
      ? `⚡ 강제 이동 깃발 활성 · 아군 전투 유닛은 교전을 무시하고 깃발로 이동합니다. 전장을 짧게 탭하면 일반 깃발로 전환됩니다.`
      : `깃발로 주력 전선을 지휘하세요. 탭은 기존 자동전투 집결입니다. 0.25초 정지 홀드는 그때 원 안의 준비된 병력만 집결·충전합니다. 이후 드래그로 조준하고 놓으면 발사하며, 홀드 전 드래그는 맵을 이동합니다. 가까운 포인터보다 멀리 발사하지 않습니다.`;
  }else if(UiRuntimeState.value.target.type==="spell"){
    const d=SpellDefinition.get(UiRuntimeState.value.target.spellId);
    UiRegistry.refs.hint.innerHTML=`${d?.icon||"✦"} <b>${d?.name||"스펠"}</b> · ${UiRuntimeState.value.target.spellId==="tunnel"?(UiRuntimeState.value.target.stage==="entry"?"입구는 실제 시야 안에서 지정":"출구는 시야 경계 밖 추가 범위까지 지정 가능"):"현재 시야 + 추가 투사 범위 안을 탭"}`;
  }else{
    const bd=BuildingDefinition.get(UiRuntimeState.value.target.building);
    const label=UiRuntimeState.value.target.produceType
      ? `${UnitDefinition.get(UiRuntimeState.value.target.produceType).name} ${BuildingDefinition.get(UiRuntimeState.value.target.building)?.productionLabel||BuildingDefinition.get(UiRuntimeState.value.target.building)?.name||"생산시설"}`
      : (bd?.name||"건물");
    const density=ActiveViewState.renderer?.buildPreview?.density;
    const densityText=density
      ? (density.penalty>0
          ? ` · 주변 ${density.kind==="defense"?"방어":"생산"}건물 ${density.near} · ${density.kind==="defense"?"발사":"생산"} ${density.speed}%`
          : ` · ${density.kind==="defense"?"발사":"생산"} 100%`)
      : "";
    const defenseText=BuildingDefinition.isDefenseTower(UiRuntimeState.value.target.building)
      ? `<br><b>방어 포탑:</b> 개수/거점 제한 없음 · ${DEFENSE_CLUSTER_RADIUS} 이내 밀집 시 발사효율 ${PRODUCTION_CLUSTER_SPEED_PCT.join("→")}%`
      : "";
    const singletonTech=!!BuildingDefinition.get(UiRuntimeState.value.target.building)?.singleton;
    const buildModeText=singletonTech
      ? `<br><b>단일 테크 건설:</b> 같은 테크 건물은 하나만 유지할 수 있습니다. 파괴 후에는 재건할 수 있습니다.`
      : `<br><b>연속 건설:</b> 배치 후에도 같은 건설 모드 유지 · <b>화면 하단 「건설 마침」 터치로 종료</b>`;
    UiRegistry.refs.hint.innerHTML=`<span class="build-preview-label">🏗️ <b>${label}</b></span>${densityText}${buildModeText}<br>현재 확보한 시야 안에 건설 · 생산건물은 ${PRODUCTION_CLUSTER_RADIUS} 이내 밀집 시 생산속도가 ${PRODUCTION_CLUSTER_SPEED_PCT.join("→")}%로 느려집니다.${defenseText}`;
  }
  SpellPresentation.renderSpellPanel(s);
  if(UiRuntimeState.value.command.page==="tactics-chest")BattlePresentation.renderTacticalChest(s);
  if(UiRuntimeState.value.command.page==="research-upgrade"||UiRuntimeState.value.command.page==="research-ability")ResearchPresentation.renderResearchCommandPanels(s);
  BuildingPresentation.renderSelectedBuildingPanel(s);
  CommandPresentation.syncCommandDock();
}
  static longPressDetailFor(el){
  if(!el)return null;
  if(el.dataset.detailTitle){return {title:el.dataset.detailTitle,icon:el.dataset.detailIcon||"◆",kicker:el.dataset.detailKicker||"DETAIL",body:el.dataset.detailBody||"",meta:el.dataset.detailMeta||""};}
  const cardType=el.dataset.deckCardType,cardId=el.dataset.deckCardId;
  if(cardType==="unit"&&cardId)return BattlePresentation.detailForUnit(cardId);
  if(cardType==="defense"&&cardId){const c=DefenseCardDefinition.get(cardId);return BuildingPresentation.detailForDefenseBuilding(c?.building);}
  if(el.dataset.produceUnit)return BattlePresentation.detailForUnit(el.dataset.produceUnit);
  if(el.dataset.defenseBuild)return BuildingPresentation.detailForDefenseBuilding(el.dataset.defenseBuild);
  const id=el.id||"";
  const buildingMap={supplyBtn:"supply",gasExtractorBtn:"gasExtractor",academyBtn:"academy",airIncubatorBtn:"airIncubator",labBtn:"lab"};
  if(buildingMap[id])return BuildingPresentation.detailForBuilding(buildingMap[id]);
  const title=el.querySelector("b,.name,.research-title,.spell-name")?.textContent?.trim()||el.textContent?.trim().slice(0,40)||"상세 정보";
  const visibleMeta=el.querySelector("small,.meta,.research-meta,.spell-meta")?.textContent?.trim()||"";
  return {title,icon:(el.textContent||"◆").trim().slice(0,2),kicker:"DETAIL",body:visibleMeta||"꾹 눌러 상세 정보를 확인합니다.",meta:""};
}
  static showInfoDetail(detail){
  if(!detail||!UiRegistry.refs.infoDetailDialog)return;
  UiRegistry.refs.infoDetailIcon.textContent=detail.icon||"◆";
  UiRegistry.refs.infoDetailTitle.textContent=detail.title||"상세 정보";
  UiRegistry.refs.infoDetailKicker.textContent=detail.kicker||"DETAIL";
  UiRegistry.refs.infoDetailBody.innerHTML=detail.body||"";
  UiRegistry.refs.infoDetailMeta.textContent=detail.meta||"";
  UiRegistry.refs.infoDetailMeta.classList.toggle("hidden",!detail.meta);
  UiController.openUiModal("detail");
}
  static installLongPressDetails(){
  // Generic detail-capable controls keep delegated click semantics.
  pointerInteractions.register({
    selector:".longpress-info-target,.command-card:not(.command-card-info),.unit-card,.research-action,#buildingPanelActions button",
    key:el=>UiController.interactionActionKeyFromElement(el),
    detail:el=>BattlePresentation.longPressDetailFor(el)
  });

}
  static closeInfoDetail(){UiController.closeUiModal("detail")}
  static updateTacticalChestBadge(state){
  if(!state||!ActiveViewState.role||!UiRegistry.refs.tacticsChestBtn)return;
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role),count=Number(state.spellChests?.[side])||0;
  const passiveCount=PassiveCardDefinition.ids.filter(id=>(Number(state.passiveCards?.[side]?.[id])||0)>0).length;
  const waiting=!!state.pendingChestOffers?.[side]||!!state.pendingSpellReplacement?.[side];
  const meta=UiRegistry.refs.tacticsChestBtn.querySelector("small");
  if(meta)meta.textContent=waiting?`📦 ${count} · 패시브 ${passiveCount}종 · 선택 대기`:`📦 ${count} · 패시브 ${passiveCount}종`;
  UiRegistry.refs.tacticsChestBtn.classList.toggle("chest-ready",count>0);
}
  static showTacticalChestFeedback(event,tick){
  if(!event||!UiRegistry.refs.tacticalChestFeedback)return;
  const key=`${ActiveViewState.role}|${event.source||""}|${event.count||0}|${tick||0}`;
  if(key===BattlePresentationCache.lastTacticalChestFeedbackKey)return;
  BattlePresentationCache.lastTacticalChestFeedbackKey=key;
  if(BattlePresentationCache.tacticalChestFeedbackTimer)clearTimeout(BattlePresentationCache.tacticalChestFeedbackTimer);
  UiRegistry.refs.tacticalChestFeedbackText.textContent=`보유 ${event.count||0}개 · 전술 메뉴에서 원하는 순간 열 수 있습니다.`;
  UiRegistry.refs.tacticalChestFeedback.classList.remove("hidden","pop");
  void UiRegistry.refs.tacticalChestFeedback.offsetWidth;
  UiRegistry.refs.tacticalChestFeedback.classList.add("pop");
  UiRegistry.refs.tacticsChestBtn?.classList.remove("chest-earned-pulse");
  void UiRegistry.refs.tacticsChestBtn?.offsetWidth;
  UiRegistry.refs.tacticsChestBtn?.classList.add("chest-earned-pulse");
  try{if(document.visibilityState==="visible"&&navigator.vibrate)navigator.vibrate([35,35,70])}catch(_){ }
  BattlePresentationCache.tacticalChestFeedbackTimer=setTimeout(()=>{
    UiRegistry.refs.tacticalChestFeedback?.classList.add("hidden");
    UiRegistry.refs.tacticalChestFeedback?.classList.remove("pop");
  },1950);
}
  static closeTacticalChestModal({cancelReplacement=true}={}){
  const state=ActiveViewState.snap,side=ActiveViewState.role?ConnectionSideUtil.roleSide(ActiveViewState.role):0,replacement=state?.pendingSpellReplacement?.[side];
  if(cancelReplacement&&replacement){
    const sess=MatchLifecycle.activeSession();
    if(sess?.sim)sess.command({type:"CANCEL_SPELL_REPLACEMENT",offerId:replacement.offerId});
  }
  if(UiRuntimeState.value.modal==="spell-choice")UiController.closeUiModal("spell-choice");
  SpellPresentation.setSpellChoicePhase("idle");
}
  static openTacticalChestModal(){
  const state=ActiveViewState.snap,sess=MatchLifecycle.activeSession();
  if(!state||!ActiveViewState.role||!sess?.sim)return;
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role),count=Number(state.spellChests?.[side])||0;
  const offer=state.pendingChestOffers?.[side]||null;
  if(!offer&&count<=0){LogUtil.log("📦 보유한 전술상자가 없습니다.");return}
  UiController.openUiModal("spell-choice");
  if(offer){
    SpellPresentation.setSpellChoicePhase(state.pendingSpellReplacement?.[side]?"replacing":"choosing");
    SpellPresentation.renderSpellChoiceModal(state);
  }else{
    SpellPresentation.setSpellChoicePhase("requesting");
    SpellPresentation.renderSpellChoiceModal(state);
    sess.command({type:"OPEN_TACTICAL_CHEST"});
    LogUtil.log("📦 전술상자 개봉 · 최종 선택 전에는 차감되지 않습니다.");
  }
}
  static closeTransientBattleUi(){
  MinimapPresentation.setMinimapExpanded(false);
  MatchLifecycle.closeMatchMenu();
  if(UiRegistry.refs.infoDetailDialog?.open)BattlePresentation.closeInfoDetail();
  UiController.setUiCommand({branch:"closed",page:null});
  UiController.renderUiState();
}
  static renderReinforcementOverview(state,liveSim,side,deck){
  if(!UiRegistry.refs.reinforcementGrid)return;

  const rows=BattlePresentation.reinforcementOverviewModel(state,liveSim,side,deck);
  const html=rows.map(r=>`<div class="reinforcement-card ${r.statusClass}" title="${r.name} · ${r.status}">
    <span class="reinforcement-icon" aria-hidden="true">${r.icon}</span>
    <span class="reinforcement-name">${r.name}</span>
    <span class="reinforcement-numbers"><b>${r.field}</b> / ${r.remaining}</span>
    <span class="reinforcement-mini-status">${r.miniStatus}</span>
  </div>`).join("");

  if(html!==BattlePresentationCache.lastReinforcementOverviewHtml){
    UiRegistry.refs.reinforcementGrid.innerHTML=html;
    BattlePresentationCache.lastReinforcementOverviewHtml=html;
  }
}
  static reinforcementOverviewModel(state,liveSim,side,deck){
  const buildings=liveSim?.buildings||state.buildings||[];
  const units=liveSim?.units||state.units||[];
  const paused=!!(liveSim?.productionPaused?.[side]??state.productionPaused?.[side]);

  return deck.map(type=>{
    const d=UnitDefinition.get(type);
    const all=buildings.filter(b=>
      b.side===side&&
      b.produceType===type&&
      BuildingDefinition.get(b.type)?.isProductionBuilding
    );

    const alive=all.filter(b=>b.alive!==false);
    const constructing=alive.filter(b=>!b.complete);
    const active=alive.filter(b=>b.complete);
    const expired=all.filter(b=>
      b.alive===false&&
      (Number(b.productionTotal)||0)>0&&
      (Number(b.productionRemaining)||0)<=0
    );

    const field=units.filter(u=>
      u.alive&&u.side===side&&u.type===type
    ).length;

    const remaining=alive.reduce(
      (sum,b)=>sum+Math.max(0,Number(b.productionRemaining)||0),0
    );

    let producing=0;
    let nextSec=Infinity;
    let spawnWaiting=false;

    for(const b of active){
      const q=b.queue?.[0]?.productionBatch?b.queue[0]:null;
      if(!q)continue;

      producing+=Math.max(0,Number(q.count)||0);

      if((Number(q.remaining)||0)<=0){
        spawnWaiting=true;
        nextSec=0;
        continue;
      }

      const speed=Math.max(1,Number(liveSim?.productionSpeedPct?.(b))||100);
      nextSec=Math.min(
        nextSec,
        Math.max(1,Math.ceil((Number(q.remaining)||0)/speed/SimulationTiming.tps()))
      );
    }

    let supplyWaiting=false;
    if(liveSim&&!paused){
      supplyWaiting=active.some(b=>{
        if(b.queue?.length||(Number(b.productionRemaining)||0)<=0)return false;
        const count=liveSim.reservableProductionBatchSize?.(b.side,b)??0;
        return (Number(b.productionRemaining)||0)>0&&count<=0;
      });
    }

    const buildPct=constructing.length
      ?Math.max(...constructing.map(b=>{
          const bd=BuildingDefinition.get(b.type);
          return Math.max(0,Math.min(100,Math.floor(
            (Number(b.progress)||0)/Math.max(1,SimulationTiming.msToTicks(bd?.buildTimeMs,SimulationTiming.tps()))*100
          )));
        }))
      :0;

    const locked=d.tier>(state.tech?.[side]||1);
    let status="미건설";
    let statusClass="unbuilt";

    if(paused&&active.length){
      status="생산 일시정지";
      statusClass="paused";
    }else if(spawnWaiting){
      status="출격 공간 대기";
      statusClass="waiting";
    }else if(producing>0){
      status=Number.isFinite(nextSec)?`생산중 · ${nextSec}초`:"생산중";
      statusClass="producing";
    }else if(supplyWaiting){
      status="보급 대기";
      statusClass="waiting";
    }else if(active.length){
      status=`시설 ${active.length} · 다음 생산`;
      statusClass="producing";
    }else if(constructing.length){
      status=`건설중 · ${buildPct}%`;
      statusClass="constructing";
    }else if(expired.length){
      status="소진 · 새 배럭 필요";
      statusClass="expired";
    }else if(locked){
      status=`T${d.tier} 잠김`;
      statusClass="locked";
    }

    let miniStatus="-";
    if(paused&&active.length){
      miniStatus="정지";
    }else if(spawnWaiting){
      miniStatus="출격";
    }else if(producing>0){
      miniStatus=Number.isFinite(nextSec)
        ?`+${producing}·${nextSec}s`
        :`+${producing}`;
    }else if(supplyWaiting){
      miniStatus="보급";
    }else if(active.length){
      miniStatus="대기";
    }else if(constructing.length){
      miniStatus=`${buildPct}%`;
    }else if(expired.length){
      miniStatus="소진";
    }else if(locked){
      miniStatus=`T${d.tier}`;
    }

    return {
      type,name:d.name,icon:(UnitDefinition.cardInfo[type]||{icon:"◆"}).icon,
      field,producing,remaining,
      activeBuildings:active.length,
      constructing:constructing.length,
      expired:expired.length,
      status,statusClass,miniStatus
    };
  });
}
}

const POINTER_INTERACTION_HOLD_MS=450;
const POINTER_INTERACTION_MOVE_CANCEL_PX=16;

class PointerInteractionController{
  constructor(){
    this.bindings=[];
    this.active=null;
    this.suppressKey=null;
    this.suppressElement=null;
    this.suppressUntil=0;
    this.installed=false;
  }
  register(binding){
    if(binding?.selector)this.bindings.push(binding);
  }
  bindingForTarget(target){
    for(let i=this.bindings.length-1;i>=0;i--){
      const binding=this.bindings[i],el=target?.closest?.(binding.selector);
      if(el)return {binding,el};
    }
    return null;
  }
  actionKey(binding,el){
    return binding.key?.(el)||UiController.interactionActionKeyFromElement(el)||null;
  }
  clearActive(){
    if(this.active?.timer)clearTimeout(this.active.timer);
    this.active=null;
  }
  suppressActive(active){
    if(!active)return;
    this.suppressKey=active.key;this.suppressElement=active.el;
    this.suppressUntil=performance.now()+900;
  }
  cancelActive(){this.suppressActive(this.active);this.clearActive()}
  install(){
    if(this.installed)return;
    this.installed=true;

    document.addEventListener("pointerdown",e=>{
      if(!e.isPrimary||(e.pointerType==="mouse"&&e.button!==0))return;
      const hit=this.bindingForTarget(e.target);if(!hit)return;
      this.cancelActive();
      this.suppressKey=null;this.suppressElement=null;this.suppressUntil=0;
      const {binding,el}=hit,key=this.actionKey(binding,el);
      const active=this.active={
        pointerId:e.pointerId,pointerType:e.pointerType||"",
        startX:e.clientX,startY:e.clientY,binding,el,key,
        cancelled:false,longPressed:false,timer:0
      };
      const allowLong=typeof binding.longPress==="function"?!!binding.longPress(el):binding.longPress!==false;
      if(allowLong){
        active.timer=setTimeout(()=>{
          active.timer=0;
          if(this.active!==active||active.cancelled||document.hidden||active.el.isConnected===false){if(this.active===active)this.cancelActive();return}
          active.longPressed=true;
          if(active.pointerType!=="mouse"&&navigator.vibrate)try{navigator.vibrate(18)}catch(_e){}
          const detail=typeof binding.detail==="function"?binding.detail(active.el):BattlePresentation.longPressDetailFor(active.el);
          if(detail)BattlePresentation.showInfoDetail(detail);
          this.suppressActive(active);
        },binding.holdMs||POINTER_INTERACTION_HOLD_MS);
      }
    },true);

    document.addEventListener("pointermove",e=>{
      const a=this.active;if(!a||e.pointerId!==a.pointerId)return;
      const limit=a.binding.moveCancelPx||POINTER_INTERACTION_MOVE_CANCEL_PX;
      if(Math.hypot(e.clientX-a.startX,e.clientY-a.startY)>limit){
        a.cancelled=true;
        if(a.timer)clearTimeout(a.timer);
        a.timer=0;
      }
    },true);

    document.addEventListener("pointerup",e=>{
      const a=this.active;if(!a||e.pointerId!==a.pointerId)return;
      if(a.timer)clearTimeout(a.timer);
      a.timer=0;
      if(a.cancelled||a.longPressed)this.suppressActive(a);
      // Native click is the single activation event for normal controls.
      // Pointer tracking here exists only for long-press detail and drag cancellation.
      // Never synthesize el.click() from pointerup: W3C defines click as the
      // device-independent activation event, and pointerup preventDefault does not
      // guarantee suppressing click.
      this.active=null;
    },true);

    document.addEventListener("pointercancel",e=>{if(this.active&&e.pointerId===this.active.pointerId)this.cancelActive()},true);
    document.addEventListener("lostpointercapture",e=>{if(this.active&&e.pointerId===this.active.pointerId)this.cancelActive()},true);
    document.addEventListener("contextmenu",e=>{
      const hit=this.bindingForTarget(e.target);
      if(hit&&this.active?.longPressed)e.preventDefault();
    },true);
    document.addEventListener("selectstart",e=>{
      const hit=this.bindingForTarget(e.target);
      if(hit&&this.active)e.preventDefault();
    },true);

    document.addEventListener("click",e=>{
      const hit=this.bindingForTarget(e.target);if(!hit)return;
      const {binding,el}=hit,key=this.actionKey(binding,el);
      const suppressing=performance.now()<this.suppressUntil&&(el===this.suppressElement||!!this.suppressKey&&key===this.suppressKey)&&e.detail!==0;
      if(suppressing){
        e.preventDefault();
        e.stopImmediatePropagation();
        this.suppressKey=null;this.suppressElement=null;
        this.suppressUntil=0;
        return;
      }
      // Registered tap bindings own activation through this single native-click path.
      // This works for mouse, touch-generated click, and keyboard activation (detail === 0)
      // without synthesizing a second click from pointerup.
      if(typeof binding.tap==="function"&&!el.disabled){
        e.preventDefault();
        e.stopImmediatePropagation();
        binding.tap(el,e);
      }
    },true);
  }
}

const pointerInteractions=new PointerInteractionController();

class ResearchPresentation{
  static researchAbilityTier=1;

  
  static globalResearchProgressHtml(q){
  if(!q)return"";
  const tick=ActiveViewState.snap?.tick||ActiveViewState.session?.sim?.tick||0,remaining=SimulationTiming.queueRemainingTicks(q,tick);
  const pct=Math.max(0,Math.min(100,Math.floor((1-remaining/Math.max(1,q.total))*100)));
  return `<div class="research-progress"><span style="width:${pct}%"></span></div><div class="research-meta">연구 중 · ${pct}% · 약 ${Math.ceil(remaining/SimulationTiming.tps())}초</div>`;
}
  static renderResearchCommandPanels(state){
  if(!state||!ActiveViewState.role)return;
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role),wallet=state.wallet?.[side]||0,gasWallet=state.gasWallet?.[side]||0,tech=state.tech?.[side]||1;
  const queues=state.researchQueues?.[side]||{attack:null,armor:null,ability:null};
  const locked=tech<2;
  if(UiRegistry.refs.researchUpgradeGrid){
    const atk=state.attackUpgrade?.[side]||0,arm=state.armorUpgrade?.[side]||0;
    const adef=ResearchDefinition.all.attack[atk],ddef=ResearchDefinition.all.armor[arm];
    const combatResearchBusy=!!(queues.attack||queues.armor);
    const card=(kind,lv,def,q,pct,title)=>{
      if(lv>=3)return `<button class="research-action longpress-info-target done" data-detail-title="${HtmlAttributeUtil.escapeHtmlAttr(title+" 완료")}" data-detail-body="${HtmlAttributeUtil.escapeHtmlAttr(`최대 Lv.3 · 누적 ${pct*3}%`)}" data-detail-meta="완료 ✓" disabled><div class="research-title">${title} 완료</div><div class="research-meta">완료 ✓</div></button>`;
      const gasCost=Math.max(0,Number(def?.gasCost)||0);
      const blocked=locked||combatResearchBusy||wallet<(def?.cost||Infinity)||gasWallet<gasCost;
      const busyOther=combatResearchBusy&&!q;
      const detail=`${kind==="attack"?"전군 공격력":"전군 피해 감소"} ${kind==="attack"?"+":"-"}${pct}% · 누적 ${kind==="attack"?"+":"-"}${pct*(lv+1)}%`;const shortMeta=locked?"아카데미 필요":busyOther?"다른 연구 진행 중":`◆ ${def.cost} · ⬡ ${gasCost} · ${Math.ceil((def.timeMs??SimulationTiming.ticksToMs(def.time||0,SimulationTiming.tps()))/1000)}초`;return `<button class="research-action longpress-info-target ${q?"active":""}" data-global-research="${kind}" data-detail-title="${HtmlAttributeUtil.escapeHtmlAttr(title+` Lv.${lv+1}`)}" data-detail-body="${HtmlAttributeUtil.escapeHtmlAttr(detail)}" data-detail-meta="${HtmlAttributeUtil.escapeHtmlAttr(shortMeta)}" ${blocked?"disabled":""}><div class="research-title">${title} Lv.${lv+1}</div>${q?ResearchPresentation.globalResearchProgressHtml(q):`<div class="research-meta">${shortMeta}</div>`}</button>`;
    };
    const upgradeHtml=card("attack",atk,adef,queues.attack,ATTACK_UPGRADE_PCT_PER_LEVEL,"⚔ 공격 강화")+card("armor",arm,ddef,queues.armor,ARMOR_REDUCTION_PCT_PER_LEVEL,"⬢ 방어 강화");
    if(upgradeHtml!==BattlePresentationCache.lastResearchUpgradeHtml&&!UiController.interactivePointerHeldInside(UiRegistry.refs.researchUpgradeGrid)){
      UiRegistry.refs.researchUpgradeGrid.innerHTML=upgradeHtml;
      BattlePresentationCache.lastResearchUpgradeHtml=upgradeHtml;
    }
  }
  if(UiRegistry.refs.researchAbilityGrid){
    const deck=BattlePresentation.productionDeck(state,side)?.filter(id=>UnitDefinition.get(id)?.tier===ResearchPresentation.researchAbilityTier&&UnitSpecialResearchDefinition.hasOptions(id));
    if(!deck)return;
    const q=queues.ability;
    const cards=deck.flatMap(id=>{
      const out=[];
      if(ABILITY_INFO[id]){
        const done=!!state.abilities?.[side]?.[id],active=q?.unit===id&&!q?.researchId,info=ABILITY_INFO[id]||{},def=ResearchDefinition.abilityForUnit(id);
        const blocked=locked||done||q||wallet<def.cost||gasWallet<def.gasCost;
        const title=`${UnitDefinition.get(id).name} · ${info.name||"특수 연구"}`,detail=DefinitionDetails.ability(id)||"병종 고유 능력을 강화합니다.",shortMeta=done?"해금 완료 ✓":locked?"아카데미 필요":`${def.label} · ◆ ${def.cost} · ⬡ ${def.gasCost} · ${Math.ceil((def.timeMs??SimulationTiming.ticksToMs(def.time||0,SimulationTiming.tps()))/1000)}초`;
        out.push(`<button class="research-action longpress-info-target ${done?"done":active?"active":""}" data-global-research="ability" data-unit="${id}" data-detail-title="${HtmlAttributeUtil.escapeHtmlAttr(title)}" data-detail-body="${HtmlAttributeUtil.escapeHtmlAttr(detail)}" data-detail-meta="${HtmlAttributeUtil.escapeHtmlAttr(shortMeta)}" ${blocked?"disabled":""}><div class="research-title">${title}</div>${active?ResearchPresentation.globalResearchProgressHtml(q):`<div class="research-meta">${shortMeta}</div>`}</button>`);
      }
      for(const def of UnitSpecialResearchDefinition.forUnit(id)){
        const done=!!state.specialResearch?.[side]?.[def.id],active=q?.researchId===def.id,prereq=ResearchDefinition.specialResearchPrereqMet(state,side,def);
        const requiredType=BuildingDefinition.forRole(def.requiredBuildingRole),requirement=requiredType?`${BuildingDefinition.get(requiredType)?.name||"연구 건물"} 필요`:"테크 필요";
        const blocked=done||q||!prereq||wallet<def.cost||gasWallet<def.gasCost;
        const title=`${UnitDefinition.get(id).name} · ${def.name}`,shortMeta=done?"해금 완료 ✓":!prereq?requirement:`◆ ${def.cost} · ⬡ ${def.gasCost} · ${Math.ceil((def.timeMs??SimulationTiming.ticksToMs(def.time||0,SimulationTiming.tps()))/1000)}초`;
        out.push(`<button class="research-action longpress-info-target ${done?"done":active?"active":""}" data-global-research="ability" data-unit="${id}" data-research-id="${def.id}" data-detail-title="${HtmlAttributeUtil.escapeHtmlAttr(title)}" data-detail-body="${HtmlAttributeUtil.escapeHtmlAttr(DefinitionDetails.special(def))}" data-detail-meta="${HtmlAttributeUtil.escapeHtmlAttr(shortMeta)}" ${blocked?"disabled":""}><div class="research-title">${title}</div>${active?ResearchPresentation.globalResearchProgressHtml(q):`<div class="research-meta">${shortMeta}</div>`}</button>`);
      }
      return out;
    }).join("");
    const abilityHtml=`<div class="command-pane-copy"><b>T${ResearchPresentation.researchAbilityTier} 특수 연구</b></div>${cards||'<div class="command-pane-copy">연구 가능한 병종 없음</div>'}`;
    if(abilityHtml!==BattlePresentationCache.lastResearchAbilityHtml&&!UiController.interactivePointerHeldInside(UiRegistry.refs.researchAbilityGrid)){
      UiRegistry.refs.researchAbilityGrid.innerHTML=abilityHtml;
      BattlePresentationCache.lastResearchAbilityHtml=abilityHtml;
    }
  }
}
}

const UI_MODAL_DIALOG_KEYS=Object.freeze({campaign:"campaignDialog",create:"createDialog",join:"joinDialog",detail:"infoDetailDialog"});

class SimulationTiming{
  static queueRemainingTicks(q,tick){
  if(!q)return 0;
  if(Number.isFinite(Number(q.readyTick)))return Math.max(0,Number(q.readyTick)-(Number(tick)||0));
  return Math.max(0,Number(q.remaining)||0);
}

  static periodicTickOffsets(durationMs,intervalMs,tps=SIM_TPS,{fireImmediately=true}={}){
  durationMs=Math.max(0,Math.round(Number(durationMs)||0));
  intervalMs=Math.max(1,Math.round(Number(intervalMs)||1));
  tps=Math.max(1,Math.round(Number(tps)||1));
  const out=[],threshold=intervalMs*tps;
  let phase=0;
  if(fireImmediately&&durationMs>0)out.push(0);
  // Integer remainder/Bresenham-style scheduler. Each simulation tick contributes
  // exactly 1000 phase units; one interval costs intervalMs*tps units.
  const maxTicks=Math.max(0,Math.ceil(durationMs*tps/1000));
  for(let tick=1;tick<maxTicks;tick++){
    phase+=1000;
    while(phase>=threshold){
      phase-=threshold;
      out.push(tick);
    }
  }
  return out;
}

  static timerTicksWithPhase(durationMs,tps,phase=0,{min=1}={}){
  const hz=Math.max(1,Math.round(Number(tps)||SIM_TPS));
  const total=Math.max(0,Math.round(Number(durationMs)||0))*hz+Math.max(0,Math.round(Number(phase)||0));
  const ticks=Math.floor(total/1000);
  return{ticks:Math.max(min,ticks),phase:total%1000};
}

  static ticksToMs(ticks,tps=SIM_TPS){
  return Math.round(Math.max(0,Number(ticks)||0)*1000/tps);
}

  static msToTicks(ms,tps=SIM_TPS,{min=1}={}){
  const value=Math.max(0,Math.round(Number(ms)||0));
  return Math.max(min,Math.round(value*tps/1000));
}

  static tps(){
    // Query the real active GameSession. `runtime` was a refactor-only phantom owner.
    const active=typeof MatchLifecycle!=="undefined"?MatchLifecycle.activeSession():null;
    return RangeUtil.clamp(Math.round(Number(
      active?.sim?.tps||
      active?.roundRules?.simulation?.tps||
      active?.matchConfig?.simulationTps||
      UiRuntimeState.value?.settings?.simulationTps||
      SIM_TPS
    )),10,30);
  }
  static tickMs(){return 1000/this.tps()}
  static ticksToSeconds(ticks){return Number(ticks||0)/this.tps()}
  static elapsedMinutes(ticks){return Math.max(1/this.tps(),Number(ticks||0)/this.tps())/60}
  
  
}

pointerInteractions.install();


const renderCampaignLoadedMission=(m,source="preview")=>{UiRegistry.refs.campaignMissionTitle.textContent=m.title;UiRegistry.refs.campaignMissionBrief.textContent=m.briefing||m.missionId;UiRegistry.refs.campaignStatus.textContent=`${source==="builtin"?"내장":"Preview"} · 시작 생산 ${m.player.availableUnits.length}종 · 각 맵 독립 상태 · 현재 Definition 수치 사용`;UiRegistry.refs.campaignStartBtn.disabled=false};
const loadCampaignSource=async(readSource,label="campaign.js",origin="preview")=>{
 CampaignRuntime.clear();
 const revision=CampaignRuntime.loadRevision;
 UiRegistry.refs.campaignStartBtn.disabled=true;
 UiRegistry.refs.campaignStatus.textContent="미션 JS 불러오는 중…";
 try{
  const source=await readSource();
  if(revision!==CampaignRuntime.loadRevision||UiRuntimeState.value.modal!=="campaign")return false;
  const raw=CampaignModuleLoader.evaluate(source,label);
  renderCampaignLoadedMission(CampaignRuntime.setMission(raw,source),origin);
  return true;
 }catch(e){
  if(revision!==CampaignRuntime.loadRevision||UiRuntimeState.value.modal!=="campaign")return false;
  CampaignRuntime.clear();UiRegistry.refs.campaignStartBtn.disabled=true;
  UiRegistry.refs.campaignStatus.textContent="미션 로드 실패 · "+(e?.message||e);
  return false;
 }
};
const renderCampaignRepository=manifest=>{const host=UiRegistry.refs.campaignRepositoryList;if(!host)return;host.replaceChildren();for(const campaign of manifest.campaigns){const head=document.createElement("div");head.textContent=campaign.title;head.style.cssText="font-weight:900;font-size:13px;margin-top:4px";host.appendChild(head);for(const mission of campaign.missions){const b=document.createElement("button");b.type="button";b.className="dialog-action";b.textContent=mission.title;b.dataset.missionId=mission.id;b.onclick=()=>{CampaignRuntime.clear();UiRegistry.refs.campaignStartBtn.disabled=true;try{renderCampaignLoadedMission(CampaignRuntime.setMission(CloneUtil.clone(mission.mission)),"builtin")}catch(e){UiRegistry.refs.campaignStatus.textContent="미션 로드 실패 · "+(e?.message||e)}};host.appendChild(b)}}};
const refreshCampaignRepository=async()=>{
 const revision=++CampaignRuntime.loadRevision;
 const loadedStatus=CampaignRuntime.pending?UiRegistry.refs.campaignStatus.textContent:null;
 UiRegistry.refs.campaignRepositoryList.replaceChildren();
 UiRegistry.refs.campaignStatus.textContent="정식 캠페인 불러오는 중…";
 try{
  const manifest=await CampaignBuiltinCatalog.manifest();
  if(revision!==CampaignRuntime.loadRevision||UiRuntimeState.value.modal!=="campaign")return false;
  renderCampaignRepository(manifest);
  if(CampaignRuntime.pending)UiRegistry.refs.campaignStatus.textContent=loadedStatus;
  else UiRegistry.refs.campaignStatus.textContent=`정식 캠페인 ${manifest.campaigns.reduce((n,c)=>n+c.missions.length,0)}개 미션 · 각 미션 독립 실행`;
  return true;
 }catch(e){
  if(revision!==CampaignRuntime.loadRevision||UiRuntimeState.value.modal!=="campaign")return false;
  UiRegistry.refs.campaignStatus.textContent="캠페인 목록 로드 실패 · "+(e?.message||e)+" · 새로고침으로 다시 시도하세요. HTTP(S)에서 실행해야 합니다.";
  return false;
 }
};
// Opened by ?campaign=1 (src/ui/dev-query.js).
const openCampaign=()=>{audioSystem.unlock();DebugScenarioHarness.pending=null;CampaignRuntime.clear();UiRegistry.refs.campaignStartBtn.disabled=true;UiRegistry.refs.campaignMissionTitle.textContent="캠페인";UiRegistry.refs.campaignMissionBrief.textContent="각 미션은 자원·병력·테크·생산 가능 병종을 자체 정의하며, 다른 미션의 게임 상태를 요구하지 않습니다. 파일/URL Preview는 개발용입니다.";UiController.openUiModal("campaign");refreshCampaignRepository()};
UiRegistry.refs.campaignRefreshBtn.onclick=()=>refreshCampaignRepository();
UiRegistry.refs.campaignCloseBtn.onclick=()=>UiController.closeUiModal("campaign");
UiRegistry.refs.campaignLoadFileBtn.onclick=()=>UiRegistry.refs.campaignFileInput.click();
UiRegistry.refs.campaignFileInput.onchange=async()=>{const f=UiRegistry.refs.campaignFileInput.files?.[0];if(!f)return;await loadCampaignSource(()=>f.text(),f.name);UiRegistry.refs.campaignFileInput.value="";};
UiRegistry.refs.campaignLoadUrlBtn.onclick=()=>{const url=UiRegistry.refs.campaignUrlInput.value.trim();if(!url)return;return loadCampaignSource(async()=>{const r=await fetch(url,{cache:"no-store"});if(!r.ok)throw new Error(`HTTP ${r.status}`);return r.text()},url)};
UiRegistry.refs.campaignStartBtn.onclick=()=>{if(!CampaignRuntime.pending)return;audioSystem.unlock();UiController.closeUiModal("campaign");UiRegistry.refs.singleStatus.textContent=`캠페인 · ${CampaignRuntime.pending.title} 준비 중…`;UiController.setElementVisible(UiRegistry.refs.singleStatus,true);NetworkModuleLoader.pendingPeerAction=null;MatchLifecycle.startSinglePlayerWebRTC("host")};
MobileBattleTestMode.bindUi();



UiRegistry.refs.joinConfirm.addEventListener("click",e=>{
  e.preventDefault();
  if(!UiRegistry.refs.joinConfirm.disabled)MatchLifecycle.submitJoinRoom();
});

UiRegistry.refs.room.oninput=()=>{
  UiRegistry.refs.room.value=UiRegistry.refs.room.value.replace(/\D/g,"").slice(0,4);
  if(UiRegistry.refs.joinError.textContent)UiRegistry.refs.joinError.textContent="";
};

UiRegistry.refs.room.addEventListener("keydown",e=>{
  if(e.key==="Enter"){
    e.preventDefault();
    if(!UiRegistry.refs.joinConfirm.disabled)MatchLifecycle.submitJoinRoom();
  }
});

UiRegistry.refs.createRetry.onclick=()=>{
  NetworkModuleLoader.networkLoadState="loading";
  NetworkModuleLoader.networkLoadError="";
  UiController.setElementVisible(UiRegistry.refs.createRetry,false);
  UiRegistry.refs.createStatus.textContent="네트워크 모듈을 다시 불러오는 중…";
  NetworkModuleLoader.networkLoaderStarted=false;NetworkModuleLoader.ensureReady();
};

UiRegistry.refs.createClose.onclick=()=>{
  NetworkModuleLoader.pendingPeerAction=null;
  UiController.closeUiModal("create");
};
UiRegistry.refs.joinClose.onclick=()=>{
  NetworkModuleLoader.pendingPeerAction=null;
  UiRegistry.refs.joinConfirm.disabled=false;
  UiRegistry.refs.joinConfirm.textContent="참가하기";
  UiController.closeUiModal("join");
};
UiRegistry.refs.createDialog.addEventListener("click",e=>{if(e.target===UiRegistry.refs.createDialog){NetworkModuleLoader.pendingPeerAction=null;UiController.closeUiModal("create")}});
UiRegistry.refs.joinDialog.addEventListener("click",e=>{
  if(e.target!==UiRegistry.refs.joinDialog)return;

  NetworkModuleLoader.pendingPeerAction=null;
  UiRegistry.refs.joinConfirm.disabled=false;
  UiRegistry.refs.joinConfirm.textContent="참가하기";
  UiController.closeUiModal("join");
});
UiController.bindImmediateButton(UiRegistry.refs.localTest,MatchLifecycle.startLocalTest);
UiController.bindImmediateButton(UiRegistry.refs.hostView,()=>UiController.switchTestView("host"));
UiController.bindImmediateButton(UiRegistry.refs.guestView,()=>UiController.switchTestView("guest"));

class DefinitionDetails{
 static n(v){return HelpPresentation.wikiStatNumber(v,2)}
 static unitFields=Object.freeze([
  ["healRange","치유 사거리"],["healAmount","치유량"],["healCooldownMs","치유 간격","ms"],["healManaPerPacket","치유 마나 비용"],
  ["guardChargeRadius","보호막 반경"],["guardPulseIntervalMs","보호막 주기","ms"],["guardTargetsPerPulse","펄스당 대상"],["guardManaCost","대상당 마나"],
  ["summonMax","소환 한도"],["summonIntervalMs","소환 시도 주기","ms"],["summonManaCost","소환 마나"],["summonLifetimeMs","소환 수명","ms"],
  ["hookRange","집게 사거리"],["hookCooldownMs","집게 재사용","ms"],["hookImpulseDistance","집게 끌기 거리"],
  ["interceptRadius","요격 반경"],["interceptManaCost","요격 마나"],["carrierMax","공생충 한도"],["carrierRadius","공생충 작전 반경"],["carrierRespawnMs","공생충 재생 간격","ms"],["carrierRespawnManaCost","공생충 재생 마나"],
  ["leapRange","도약 거리"],["leapCooldownMs","도약 재사용","ms"],["burrowRange","잠복 돌입 거리"],["burrowCooldownMs","잠복 재사용","ms"],
  ["burrowAirborneMs","출현 에어본","ms"],["airborneMs","에어본","ms"],["detectRadius","Detection 반경"],
  ["cloakAuraRadius","은폐 오라 반경"],["mobilityAuraRadius","기동 오라 반경"],["lineWidth","관통 폭"],["splash","광역 반경"]
 ]);
 static abilityFields=Object.freeze([
  ["abilityGuardPulseIntervalPct","보호막 주기 배율","pct"],["hookAirborneMs","집게 에어본","ms"],
  ["abilityFlatArmor","연구 후 고정 방어"],["abilityBurrowAirborneMs","연구 후 출현 에어본","ms"],
  ["abilityRangeMultiplier","사거리 배율","mult"],["secondaryCount","추가 융기 수"],["secondaryDamageScale","추가 피해 배율","ratio"],["secondaryAirborneScale","추가 에어본 배율","ratio"],
  ["abilityInterceptRadius","연구 후 요격 반경"],["abilityInterceptManaCost","연구 후 요격 마나"],
  ["abilityAttackCooldownResetChance","공격 쿨다운 초기화 확률","ratio"],["abilityCarrierRespawnMs","연구 후 재생 간격","ms"],["abilityCarrierRespawnManaCostPct","재생 마나 비용 배율","pct"],
  ["abilityTurnLimitedFlight.engageRadius","교전 비행 범위"],["abilityTurnLimitedFlight.speedPct","교전 비행 속도 배율","pct"],["abilityTurnLimitedFlight.orbitRadius","선회 반경"]
 ]);
 static fields(def,spec){return spec.flatMap(([path,label,unit])=>{const v=path.split('.').reduce((o,k)=>o?.[k],def);if(typeof v!=="number"||!Number.isFinite(v))return [];return [[label,unit==="ms"?`${this.n(v/1000)}초`:unit==="ratio"?`${this.n(v*100)}%`:unit==="pct"?`${this.n(v)}%`:unit==="mult"?`${this.n(v)}배`:this.n(v)]]})}
 static text(rows){return rows.map(([k,v])=>`${k} ${v}`).join(" · ")}
 static unit(type){return this.text(this.fields(UnitDefinition.get(type),this.unitFields))}
 static ability(type){
  const d=UnitDefinition.get(type),a=ABILITY_INFO[type];if(!a)return "";
  const rows=this.fields(d,this.abilityFields);
  for(const v of d?.basicAttack?.variants||[])if(v.requires?.ability===type){
   if(v.trigger?.type==="chance")rows.push(["발동 확률",`${this.n(v.trigger.chance*100)}%`]);
   if(v.attack?.knockbackDistance!=null)rows.push(["넉백 거리",this.n(v.attack.knockbackDistance)]);
  }
  return [a.desc,this.text(rows)].filter(Boolean).join(" · ");
 }
 static special(def){
  const e=def.effects||{},rows=[];
  const labels={attackMultiplier:"공격력 배율",attackRangeMultiplier:"공격 사거리 배율",moveSpeedPct:"이동속도 배율",stationaryAttackSpeedPerStack:"중첩당 공격속도",stationaryAttackSpeedMaxStacks:"최대 중첩"};
  for(const [k,label]of Object.entries(labels))if(e[k]!=null)rows.push([label,`${this.n(e[k])}${k.endsWith('Multiplier')?'배':k.endsWith('Pct')||k==='stationaryAttackSpeedPerStack'?'%':''}`]);
  if(e.guardRetaliation)rows.push(...this.fields(UnitDefinition.get(def.unit),[["guardRetaliationManaCost","반격 마나"],["guardRetaliationDamage","반격 피해"],["guardRetaliationSplash","반격 반경"]]));
  return [def.desc,this.text(rows)].filter(Boolean).join(" · ");
 }
 static requirement(def){const id=BuildingDefinition.forRole(def.requiredBuildingRole);return id?`${BuildingDefinition.get(id).name} 완공`:`T${def.requiredTech||2}`}
}

class HelpPresentation{
  static wikiStatNumber(value,digits=1){
  const n=Number(value);
  if(!Number.isFinite(n))return "-";
  const fixed=n.toFixed(digits);
  return String(Number(fixed));
}
  static wikiBaseDps(d){
  if(d?.continuous?.dps!=null)return Number(d.continuous.dps);
  if(!d||(Number(d.atk)||0)<=0||d.selfDestruct)return null;
  const cooldown=Math.max(.01,Number(d.cooldown)||0);
  return (Number(d.atk)||0)/cooldown;
}
  static wikiDefenseSummary(d){
  const parts=[];
  const flat=Math.max(0,Number(d?.flatArmor)||0);
  if(flat>0)parts.push(`고정 ${flat}`);
  const ranged=Math.max(0,Math.min(100,Number(d?.rangedReduction)||100));
  if(ranged<100)parts.push(`원거리 ${100-ranged}%↓`);
  return parts.length?parts.join("<br>"):"0";
}
  static wikiAttackTargetSummary(d){
  return `${d?.canAttackGround?"대지 O":"대지 X"}<br>${d?.canAttackAir?"대공 O":"대공 X"}`;
}
  static wikiBaseTraitSummary(id,d){
  const parts=[];
  if(d.selfDestruct)parts.push(`자폭 R${d.attackSplash||0}`);
  else if((d.splash||0)>0)parts.push(`광역 R${d.splash}`);
  if((d.chainBounces||0)>0)parts.push(`연쇄 ${d.chainBounces}회 · ${d.chainRange||0}`);
  if((d.lineWidth||0)>0)parts.push(`직선 폭 ${d.lineWidth}`);
  if(d.taunt)parts.push(`도발 R${d.tauntRadius||0}`);
  if(d.stealth)parts.push("지속 은신");
  if(d.usesMana)parts.push(`마나 ${UnitDefinition.manaMax(id)} · +${UnitDefinition.manaRegen(id)}/s`);
  if(d.healAmount)parts.push(`치유 ${d.healAmount}/${HelpPresentation.wikiStatNumber((d.healCooldownMs||0)/1000,2)}s`);
  if(d.guardChargeRadius)parts.push(`보호막 R${d.guardChargeRadius}`);
  if(d.summonMax)parts.push(`소환 최대 ${d.summonMax}`);
  if(d.hookRange)parts.push(`갈고리 ${d.hookRange}`);
  if(d.meleeSplashRadius)parts.push(`근접광역 R${d.meleeSplashRadius}`);
  if(d.spikeRadius)parts.push(`융기 R${d.spikeRadius}`);
  if(d.burrowWhileMoving)parts.push("이동 중 잠복");
  else if(d.burrowCapable)parts.push("잠복 돌입");
  if(d.cloakAuraRadius)parts.push(`은폐오라 R${d.cloakAuraRadius}`);
  if(d.mobilityAuraRadius)parts.push(`이속오라 R${d.mobilityAuraRadius}`);
  if(d.carrierMax)parts.push(`공생충 ${d.carrierMax}기`);
  if(d.detectRadius)parts.push(`Detection R${d.detectRadius}`);
  return parts.length?parts.join("<br>"):(d.counter||"-");
}
  static renderHelpDynamicTables(){
  HelpPresentation.renderRuleFacts();
  if(UiRegistry.refs.helpUnitTable){
    UiRegistry.refs.helpUnitTable.innerHTML=`
      <div class="wiki-note"><b>밸런스 표 읽기:</b> 스타크래프트 계열 유닛 통계표처럼 HP·방어·공격·공격주기·DPS·사거리·시야·이동속도·보급·가격을 한 표에서 비교한다. <b>기본 DPS</b>는 공격력÷기본 공격주기의 원시 단일 대상 값이며 크기 상성·방어·광역/연쇄·특수능력·연구 효과는 포함하지 않는다. 자폭형은 지속 DPS 대신 1회 공격값으로 판단한다.</div>
      <div class="wiki-note"><b>계약 합계:</b> 생산건물 하나를 끝까지 유지했을 때의 총 HP·기본 DPS·보급 합계다. 소환체와 연구 효과는 포함하지 않으므로 생산축 자체의 가성비를 비교하는 기준으로 사용한다.</div>
      <div class="wiki-note"><b>자원 규칙:</b> 모든 미네랄/가스 비용은 25 단위다. 병종별 생산축 가격을 한 번 지불하면 정해진 총량을 batch 단위로 자동 생산하며, 배럭/공장 템플릿 가격은 중복 과금하지 않는다.</div>
      <div class="wiki-note"><b>크기 상성:</b> 일반형이 기본값이다. ${Object.entries(DAMAGE_CLASS_MATRIX).map(([id,row])=>`${DAMAGE_CLASS_LABEL[id]} = ${Object.entries(row).map(([size,n])=>`${SIZE_CLASS_LABEL[size]} ${n}%`).join(" / ")}`).join(" · ")}. 예외 타입은 명확한 크기 카운터 의도가 있을 때만 지정하며, 범위형은 실제로 여러 대상을 타격하는 splash·chain·line·충격파 등에 사용된다.</div>
      <div class="wiki-note"><b>특수 연구:</b> ${Object.values(ABILITY_RESEARCH_COSTS).map(d=>`${d.label} ◆${d.cost}/⬡${d.gasCost}`).join(" · ")}. 티어가 아니라 전투 영향도 기준이다.</div>
      <table class="wiki-table">
      <thead>
        <tr>
          <th>병종</th>
          <th>T</th>
          <th>레이어</th>
          <th>크기</th>
          <th>공격 유형</th>
          <th>대상</th>
          <th>HP</th>
          <th>방어</th>
          <th>공격</th>
          <th>주기</th>
          <th>기본 DPS</th>
          <th>사거리</th>
          <th>시야</th>
          <th>이속</th>
          <th>보급</th>
          <th>생산축 비용</th>
          <th>생산 계약</th>
          <th>계약 합계</th>
          <th>기본 특성</th>
          <th>특수 연구</th>
        </tr>
      </thead>
      <tbody>
        ${COMBAT_UNITS.map(id=>{
          const d=UnitDefinition.get(id);
          const pp=UnitDefinition.productionProfile(id);
          const info=UnitDefinition.cardInfo[id]||{icon:"◆",desc:""};
          const ability=ABILITY_INFO[id];
          const extraResearch=UnitSpecialResearchDefinition.forUnit(id);
          const cost=UnitDefinition.get(id)?.carrierSummon?null:UnitDefinition.productionCost(id);
          const research=ability?ResearchDefinition.abilityForUnit(id):null;
          const interval=pp?HelpPresentation.wikiStatNumber(pp.productionMs/1000,1):"-";
          const baseDps=HelpPresentation.wikiBaseDps(d);
          const contractHp=pp?Math.round((Number(d.hp)||0)*pp.totalUnits):0;
          const contractDps=pp&&baseDps!=null?baseDps*pp.totalUnits:null;
          const contractSupply=pp?Math.round((Number(d.supply)||0)*pp.totalUnits):0;
          return `<tr>
            <td><span class="wiki-unit-icon">${info.icon}</span><b>${d.name}</b><br><span class="small">${BattlePresentation.unitRoleLabel(d.role)}</span></td>
            <td>T${d.tier}</td>
            <td>${d.layer||"GROUND"}</td>
            <td>${SIZE_CLASS_LABEL[d.sizeClass]||"대형"}</td>
            <td>${DAMAGE_CLASS_LABEL[UnitDefinition.damageClass(id)]||"일반형"}</td>
            <td>${HelpPresentation.wikiAttackTargetSummary(d)}</td>
            <td>${d.hp}</td>
            <td>${HelpPresentation.wikiDefenseSummary(d)}</td>
            <td>${d.atk}</td>
            <td>${(Number(d.atk)||0)>0?`${HelpPresentation.wikiStatNumber(d.cooldown,2)}초`:"-"}</td>
            <td>${d.selfDestruct?`자폭 ${d.atk}`:(baseDps==null?"-":HelpPresentation.wikiStatNumber(baseDps,1))}</td>
            <td>${d.range}</td>
            <td>${d.sight}</td>
            <td>${d.speed}</td>
            <td>${d.supply||0}</td>
            <td>${cost?`◆ ${cost.mineral}<br>⬡ ${cost.gas}`:"소환 전용"}</td>
            <td>${pp?`총 ${pp.totalUnits}기<br>선호 ${pp.batchSize}기씩<br>${interval}초 간격`:"-"}</td>
            <td>${pp?`HP ${contractHp}<br>DPS ${d.selfDestruct?"자폭":HelpPresentation.wikiStatNumber(contractDps,1)}<br>보급 ${contractSupply}`:"-"}</td>
            <td>${HelpPresentation.wikiBaseTraitSummary(id,d)}<br>${DefinitionDetails.unit(id)}<br><span class="small">${info.desc||""}</span></td>
            <td>${[
              ability?`<b>${ability.name}</b><br><span class="small">${research.label} · ◆${research.cost}/⬡${research.gasCost}<br>${DefinitionDetails.ability(id)}</span>`:"",
              ...extraResearch.map(r=>`<b>${r.name}</b><br><span class="small">${DefinitionDetails.requirement(r)} · ◆${r.cost}/⬡${r.gasCost}<br>${DefinitionDetails.special(r)}</span>`)
            ].filter(Boolean).join("<br><br>")||"없음"}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
  }

  if(UiRegistry.refs.helpSpellTable){
    UiRegistry.refs.helpSpellTable.innerHTML=`<table class="wiki-table">
      <thead>
        <tr>
          <th>스펠</th>
          <th>기본 쿨다운</th>
          <th>효과</th>
        </tr>
      </thead>
      <tbody>
        ${SpellDefinition.ids.map(id=>{
          const d=SpellDefinition.get(id);
          const s=SpellDefinition.statsAt(id,0);
          const extra=SpellDefinition.statRows(id,0).map(([k,v])=>`${k} ${v}`).join(" · ");
          return `<tr>
            <td><span class="wiki-spell-icon">${d.icon}</span><b>${d.name}</b><br><span class="small">${d.category||"전술"}</span></td>
            <td>${HelpPresentation.wikiStatNumber(s.cooldownMs/1000,2)}초</td>
            <td>${d.desc}${extra?`<br><span class="small">Lv.1 · ${extra}</span>`:""}</td>
          </tr>`;
        }).join("")}
      </tbody>
    </table>`;
  }
}
  static renderRuleFacts(){
    const sim=MatchLifecycle.activeSession()?.sim,rules=sim?.rules||GameRuleDefinition.defaults,w=sim?.world||WorldContext.standard;
    const esc=HtmlAttributeUtil.escapeHtmlAttr,n=HelpPresentation.wikiStatNumber;
    const put=(id,html)=>{const el=document.getElementById(id);if(el)el.innerHTML=html};
    const table=(headers,rows)=>`<table class="wiki-table"><thead><tr>${headers.map(x=>`<th>${esc(x)}</th>`).join('')}</tr></thead><tbody>${rows.map(r=>`<tr>${r.map(c=>`<td>${esc(String(c??'-'))}</td>`).join('')}</tr>`).join('')}</tbody></table>`;
    put('helpWorldFacts',`<b>${sim?'현재 전장':'기본 전장'}:</b> ${w.width} × ${w.height} · ${sim?.tps||SimulationTiming.tps()} TPS`);
    put('helpEconomyFacts',`<b>${sim?'현재 경기':'기본 규칙'}:</b> 시작 ◆${rules.economy.startingResources.minerals} / ⬡${rules.economy.startingResources.gas} · 시작 일꾼 ${STARTING_WORKER_COUNT}기<br>일꾼 생산 ◆${WORKER_COST} · 보급 ${ECONOMY_WORKER_DEF.supply} · ${n(ECONOMY_WORKER_DEF.buildTimeMs/1000,2)}초<br>미네랄 운반량 ${WORKER_CARRY_CAP} · 가스 채취량 ${GAS_MINE_AMOUNT} / 고갈 후 ${GAS_DEPLETED_MINE_AMOUNT}`);
    put('helpDeckFacts',`저장 슬롯 ${DECK_SLOT_COUNT}개 · 한 덱 ${DECK_TOTAL_CARD_COUNT}장 · 방어 카드 최대 ${DeckCardRuleDefinition.rules.defense.max}장`);
    put('helpCaptureFacts',`점령 반경 ${CAPTURE_RADIUS} · 기본 점령시간 ${n(CAPTURE_DURATION_MS/1000)}초 · 획득한 메인 오브젝트 사망 후 재등장 ${n(MAIN_OBJECTIVE_RESPAWN_MS/1000)}초`);
    put('helpSpellFacts',`스펠 장착 최대 ${SPELL_SLOT_MAX}개 · 전술상자 ${TACTICAL_CHEST_OPTION_COUNT}택 보상`);
    put('helpNetworkFacts',`현재 SIM_VERSION ${SIM_VERSION} · 상태 청크 ${RallyNetcode.CHUNK_SIZE/1024} KiB · 연결 복구 유예 ${DISCONNECT_GRACE_MS/1000}초<br>시뮬레이션 ${SimulationTiming.tps()} TPS · 입력 명령 이벤트 기반 · 상태 발행 ${STATE_PUBLISH_HZ} Hz · 전장 렌더 WebGL`);
    put('helpBuildingTable',table(['건물','HP','비용 ◆ / ⬡','건설시간','기능·선행조건'],Object.entries(BuildingDefinition.all).map(([id,d])=>[
      d.name,d.hp,d.productionFacility?'병종 생산 계약 기준':`${d.cost||0} / ${d.gasCost||0}`,d.productionFacility?'병종 Definition 기준':`${n((d.buildTimeMs||0)/1000,2)}초`,
      [d.supplyPlus?`보급 +${d.supplyPlus}`:'',d.tech?`T${d.tech} 해금`:'',d.unlocksAir?'공중 해금':'',d.requiresTech?`T${d.requiresTech}`:'',...(d.requiresBuildings||[]).map(t=>`${BuildingDefinition.get(t)?.name||t} 완공`),d.isDefenseTower?`공격 ${d.atk} · 사거리 ${d.range} · 주기 ${n(d.cooldownMs/1000,2)}초`:''].filter(Boolean).join(' · ')
    ])));
    put('helpResearchTable',table(['연구','수준','비용 ◆ / ⬡','시간','효과'],['attack','armor'].flatMap(kind=>ResearchDefinition.get(kind).map((d,i)=>[
      kind==='attack'?'공격 강화':'방어 강화',i+1,`${d.cost} / ${d.gasCost}`,`${n(d.timeMs/1000)}초`,`${kind==='attack'?'+':'-'}${kind==='attack'?ATTACK_UPGRADE_PCT_PER_LEVEL:ARMOR_REDUCTION_PCT_PER_LEVEL}% / 레벨`
    ])))+`<div class="wiki-note">생산 밀집 반경 ${PRODUCTION_CLUSTER_RADIUS}, 방어 밀집 반경 ${DEFENSE_CLUSTER_RADIUS} · 밀집 효율 ${PRODUCTION_CLUSTER_SPEED_PCT.join(' → ')}%</div>`);
    put('helpNeutralTable',table(['중립 종','HP','공격','사거리','이속','기본 능력'],Object.entries(UnitDefinition.all).filter(([,d])=>d.tier===0).map(([id,d])=>[d.name,d.hp,d.atk,d.range,d.speed,HelpPresentation.wikiBaseTraitSummary(id,d).replaceAll('<br>',' · ')])));
  }

  static openHelp(){HelpPresentation.renderHelpDynamicTables();UiController.openUiModal("help");if(UiRegistry.refs.helpBody)UiRegistry.refs.helpBody.scrollTop=0}
  static closeHelp(){UiController.closeUiModal("help")}
}

UiController.bindImmediateButton(UiRegistry.refs.helpBtn,HelpPresentation.openHelp);
UiController.bindImmediateButton(UiRegistry.refs.matchMenuHelpBtn,()=>{UiController.closeUiModal("match-menu");HelpPresentation.openHelp()});
UiController.bindImmediateButton(UiRegistry.refs.helpCloseBtn,HelpPresentation.closeHelp);
UiRegistry.refs.helpBackdrop.onclick=HelpPresentation.closeHelp;

document.addEventListener("keydown",e=>{
  if(e.key==="Escape"&&UiRuntimeState.value.modal==="help"){
    e.preventDefault();
    HelpPresentation.closeHelp();
  }
});

UiRegistry.refs.helpModal.addEventListener("click",e=>{
  const link=e.target.closest('.wiki-toc a[href^="#"]');
  if(!link)return;
  e.preventDefault();
  const target=document.querySelector(link.getAttribute("href"));
  target?.scrollIntoView({behavior:"smooth",block:"start"});
});

/*
 * 게임 입력 계약
 * 1) 일반 UI 선택/버튼은 click 확정 후 처리한다. 스크롤 시작(pointerdown)은 선택이 아니다.
 * 2) 동적 버튼은 안정적인 부모에 click 이벤트를 위임한다.
 * 3) 동적 TPS 시뮬레이션 렌더는 동일한 인터랙티브 DOM을 재생성하지 않는다.
 * 4) Guest 권위 입력은 proposal → Host commit → ACK/수렴 경로만 사용한다.
 */

// Build placement / spell targeting is a transient battlefield uiState.target.
// 기본 UI 액션은 모두 click 확정 뒤에만 처리한다. 모바일 스크롤 시작은 UI 선택이 아니다.
document.addEventListener("click",e=>{
  UiController.clearTransientTargetModeForUiAction(e.target);
},true);

UiController.bindImmediateButton(UiRegistry.refs.soundBtn,()=>{
  audioSystem.setEnabled(!audioSystem.enabled);
  UiRegistry.refs.soundBtn.textContent=audioSystem.enabled?"🔊":"🔇";
  UiRegistry.refs.soundBtn.classList.toggle("muted",!audioSystem.enabled);
});

UiController.bindImmediateButton(UiRegistry.refs.spellCloseBtn,()=>{
  if(UiRuntimeState.value.target.type==="spell")UiController.cancelTargetMode(true);
  
  if(UiRuntimeState.value.command.page==="tactics-spell")CommandPresentation.commandBack();
  else CommandPresentation.closeCommandDrawer();
});

UiRegistry.refs.tacticalChestArea?.addEventListener("click",e=>{
  const open=e.target.closest("[data-open-tactical-chest]");
  if(!open)return;
  e.preventDefault();e.stopPropagation();
  BattlePresentation.openTacticalChestModal();
});

UiRegistry.refs.spellChoiceModalContent?.addEventListener("click",e=>{
  const sess=MatchLifecycle.activeSession();if(!sess?.sim||!BattlePresentation.tacticalChestModalIsOpen())return;
  const reward=e.target.closest("[data-tactical-reward]");
  const rep=e.target.closest("[data-replace-spell]");
  if(!reward&&!rep)return;
  e.preventDefault();e.stopPropagation();
  if(rep){
    sess.command({type:"REPLACE_SPELL",offerId:rep.dataset.offerId,oldSpellId:rep.dataset.replaceSpell});
    return;
  }
  const offer=ActiveViewState.snap?.pendingChestOffers?.[ConnectionSideUtil.roleSide(ActiveViewState.role)];if(!offer)return;
  sess.command({type:"CHOOSE_TACTICAL_REWARD",offerId:offer.id,rewardId:reward.dataset.tacticalReward});
});

UiController.bindImmediateButton(UiRegistry.refs.spellChoiceModalClose,()=>BattlePresentation.closeTacticalChestModal({cancelReplacement:true}));
UiRegistry.refs.spellChoiceModalBackdrop?.addEventListener("click",e=>{
  e.preventDefault();e.stopPropagation();
  BattlePresentation.closeTacticalChestModal({cancelReplacement:true});
});

UiRegistry.refs.spellInventory.addEventListener("click",e=>{
  const btn=e.target.closest("[data-cast-spell]");
  if(!btn||btn.disabled)return;

  e.preventDefault();
  e.stopPropagation();
  SpellPresentation.beginSpellTarget(btn.dataset.castSpell);
});

// Build-card activation follows the platform button contract: one native `click`
// (touch, mouse, pen, keyboard) -> one semantic build selection.
UiRegistry.refs.commandDrawer.addEventListener("click",e=>{
  const el=e.target.closest("#supplyBtn,#gasExtractorBtn,#academyBtn,#airIncubatorBtn,#labBtn,[data-produce-unit],[data-defense-build]");
  if(!el||el.disabled)return;
  e.preventDefault();
  e.stopPropagation();
  BuildingPresentation.commitBuildPlacementElement(el);
});

UiController.bindImmediateButton(UiRegistry.refs.buildingDeselectBtn,()=>BuildingPresentation.selectBuilding(null));
UiController.bindImmediateButton(UiRegistry.refs.buildFinishBtn,()=>{
  if(UiRuntimeState.value.target.type!=="build")return;
  UiController.cancelTargetMode(true);
  LogUtil.log("✓ 연속 건설 마침");
});

UiController.bindImmediateButton(UiRegistry.refs.spellCancelBtn,()=>{
  if(UiRuntimeState.value.target.type!=="spell")return;
  const d=SpellDefinition.get(UiRuntimeState.value.target.spellId);
  UiController.cancelTargetMode(true);
  LogUtil.log(`✕ ${d?.name||"스펠"} 타게팅 취소`);
});

UiRegistry.refs.buildingPanelActions.addEventListener("click",e=>{
  const gasDec=e.target.closest("[data-gas-workers-dec]");
  const gasInc=e.target.closest("[data-gas-workers-inc]");
  if(gasDec||gasInc){
    e.preventDefault();
    const b=BuildingPresentation.selectedOwnBuilding();
    const sess=MatchLifecycle.activeSession();
    if(!b||!sess?.sim)return;
    const delta=gasInc?1:-1;
    const current=GasWorkerAssignmentPolicy.pendingGasTargetFor(b);
    const target=RangeUtil.clamp(current+delta,0,GAS_ASSIGNMENT_MAX);
    if(GasWorkerAssignmentPolicy.stageGasWorkerTarget(b.id,target)){
      // Keep the pressed stepper DOM stable through this release. Update the visible
      // count directly; normal snapshot rendering will reconcile the full panel.
      const count=UiRegistry.refs.buildingPanelActions.querySelector(".gas-worker-count b");
      if(count)count.textContent=String(target);
      if(gasDec)gasDec.disabled=target<=0;
      if(gasInc)gasInc.disabled=target>=GAS_ASSIGNMENT_MAX;
      const meta=UiRegistry.refs.buildingPanelActions.querySelector(".research-meta");
      if(meta)meta.innerHTML=`조정 중 <b>${target}명</b> · 입력이 멈추면 확정`;
      LogUtil.log(`⬡ 가스 일꾼 목표 조정 ${target}명 · 입력 완료 후 확정`);
    }
    return;
  }

  const workerBtn=e.target.closest("[data-train-worker]");
  if(workerBtn&&!workerBtn.disabled){
    e.preventDefault();
    const sess=MatchLifecycle.activeSession();if(!sess?.sim)return;
    sess.command({type:"TRAIN_WORKER",buildingId:workerBtn.dataset.trainWorker});
    LogUtil.log(`✓ 일꾼 생산 명령 · ${WORKER_COST} 미네랄 · 보급 ${ECONOMY_WORKER_DEF.supply||0}`);
    return;
  }
});

document.addEventListener("click",e=>{
  const tier=e.target.closest?.("[data-ability-tier]");
  if(tier){e.preventDefault();ResearchPresentation.researchAbilityTier=RangeUtil.clamp(Number(tier.dataset.abilityTier)||1,1,3);if(ActiveViewState.snap)ResearchPresentation.renderResearchCommandPanels(ActiveViewState.snap);return}
  const btn=e.target.closest?.("[data-global-research]");
  if(!btn||btn.disabled)return;
  e.preventDefault();
  const sess=MatchLifecycle.activeSession();if(!sess?.sim)return;
  const research=btn.dataset.globalResearch,unit=btn.dataset.unit||null,researchId=btn.dataset.researchId||null;
  sess.command({type:"START_RESEARCH",research,unit,researchId});
  const label=research==="attack"?"공격 강화":research==="armor"?"방어 강화":researchId?`${UnitDefinition.get(unit)?.name||"병종"} · ${UnitSpecialResearchDefinition.get(researchId)?.name||"특수 연구"}`:`${UnitDefinition.get(unit)?.name||"병종"} 특수 연구`;
  LogUtil.log(`⌛ ${label} 연구 명령 접수`);
});

UiController.bindImmediateButton(UiRegistry.refs.flagBtn,()=>{
  CommandPresentation.closeCommandDrawer();
  UiController.setMode({type:"flag"});
});

UiController.bindImmediateButton(UiRegistry.refs.pauseBtn,()=>{
  const sess=MatchLifecycle.activeSession();
  if(sess&&sess.sim){
    sess.command({type:"TOGGLE_PRODUCTION"});
    LogUtil.log("✓ 자동 병력 생산 상태 변경 명령 접수");
  }
});

UiRegistry.refs.cancelModeBtn.disabled=true;
UiController.bindImmediateButton(UiRegistry.refs.cancelModeBtn,()=>{
  const b=BuildingPresentation.selectedOwnBuilding();
  const sess=MatchLifecycle.activeSession();

  if(!b){
    LogUtil.log("⚠ 철거할 아군 건물을 먼저 선택하세요.");
    return;
  }
  if(!BuildingPresentation.isConstructionOrder(b)&&BuildingDefinition.get(b.type)?.isDropoff){
    LogUtil.log("⚠ 메인/전진 거점은 직접 철거할 수 없습니다.");
    return;
  }
  if(!sess?.sim){
    LogUtil.log("⚠ 게임 시뮬레이션이 아직 준비되지 않았습니다.");
    return;
  }

  const order=BuildingPresentation.isConstructionOrder(b);
  const refund=order?(b.paidMineral||0):(Number(b.constructionMineralCost)||BuildingDefinition.mineralCost(b.type,b.produceType||null))*.5;
  const actionName=order?"예약 취소":b.complete?"철거":"건설 취소";
  const buildingId=b.id;

  // selectedBuildingId가 다음 동적 TPS 시뮬레이션 렌더에서 변해도 정확한 ID로 이미 명령을 보낸다.
  sess.command({type:"CANCEL_BUILDING",buildingId});

  // 반복 탭으로 동일 명령이 여러 번 들어가는 것을 막고 즉시 피드백.
  UiRegistry.refs.cancelModeBtn.disabled=true;
  UiRegistry.refs.cancelModeBtn.innerHTML=`${actionName} 요청됨 · 처리 중…`;

  LogUtil.log(`✕ ${BuildingDefinition.get(b.type)?.name||"건물"} ${actionName} 명령 · ${refund} 미네랄 환불`);
});

UiController.bindImmediateButton(UiRegistry.refs.militaryT1Btn,()=>CommandPresentation.openCommandSubpage("military-t1"));
UiController.bindImmediateButton(UiRegistry.refs.militaryT2Btn,()=>CommandPresentation.openCommandSubpage("military-t2"));
UiController.bindImmediateButton(UiRegistry.refs.militaryT3Btn,()=>CommandPresentation.openCommandSubpage("military-t3"));
UiController.bindImmediateButton(UiRegistry.refs.researchTechBtn,()=>CommandPresentation.openCommandSubpage("research-tech"));
UiController.bindImmediateButton(UiRegistry.refs.researchUpgradeBtn,()=>CommandPresentation.openCommandSubpage("research-upgrade"));
UiController.bindImmediateButton(UiRegistry.refs.researchAbilityBtn,()=>CommandPresentation.openCommandSubpage("research-ability"));
UiController.bindImmediateButton(UiRegistry.refs.tacticsDefenseBtn,()=>CommandPresentation.openCommandSubpage("tactics-defense"));
UiController.bindImmediateButton(UiRegistry.refs.tacticsChestBtn,()=>CommandPresentation.openCommandSubpage("tactics-chest"));
UiController.bindImmediateButton(UiRegistry.refs.tacticsSpellBtn,()=>CommandPresentation.openCommandSubpage("tactics-spell"));
UiController.bindImmediateButton(UiRegistry.refs.commandBackBtn,CommandPresentation.commandBack);

UiController.bindImmediateButton(UiRegistry.refs.economyTreeBtn,()=>CommandPresentation.openTechTree("economy"));
UiController.bindImmediateButton(UiRegistry.refs.militaryTreeBtn,()=>CommandPresentation.openTechTree("military"));
UiController.bindImmediateButton(UiRegistry.refs.researchTreeBtn,()=>CommandPresentation.openTechTree("research"));
UiController.bindImmediateButton(UiRegistry.refs.tacticsTreeBtn,()=>CommandPresentation.openTechTree("tactics"));
UiController.bindImmediateButton(UiRegistry.refs.buildDrawerCloseBtn,()=>{
  CommandPresentation.closeCommandDrawer();
});

UiRegistry.refs.matchMenuReplaySaveBtn?.addEventListener("click",()=>{const data=ReplayPresentation.currentReplayPayload();if(data)ReplayPresentation.downloadReplay(data);else LogUtil.log("아직 저장할 전투 리플레이가 없습니다.")});
UiRegistry.refs.matchMenuSurrenderBtn?.addEventListener("click",()=>MatchLifecycle.requestMatchSurrender());
UiRegistry.refs.matchMenuLeaveBtn?.addEventListener("click",()=>{if(ReplayPresentation.replayPlayer){MatchLifecycle.closeMatchMenu();ReplayPresentation.stopReplay();return}MatchLifecycle.requestMatchSurrender({leave:true})});
UiRegistry.refs.disconnectReconnectBtn?.addEventListener("click",ConnectionPresentation.requestConnectionReconnect);
UiRegistry.refs.disconnectSurrenderBtn?.addEventListener("click",()=>MatchLifecycle.requestMatchSurrender({leave:true}));
setInterval(ConnectionPresentation.renderConnectionGate,100);
setInterval(()=>{
  if(UiRuntimeState.value.screen==="game"&&ConnectionPresentation.lastP2PHealthInfo)ConnectionPresentation.renderP2PHealth(ConnectionPresentation.lastP2PHealthInfo,ConnectionPresentation.lastP2PHealthLocal);
},250);

UiRegistry.refs.replaySaveBtn?.addEventListener("click",()=>{
  const data=ReplayPresentation.currentReplayPayload();
  if(!data){LogUtil.log("저장할 리플레이가 없습니다.");return}
  ReplayPresentation.downloadReplay(data);
});
UiRegistry.refs.replayWatchBtn?.addEventListener("click",()=>{
  const data=ReplayPresentation.currentReplayPayload();
  if(!data){LogUtil.log("재생할 리플레이가 없습니다.");return}
  ReplayPresentation.startReplay(data);
});
UiRegistry.refs.replayOpenBtn?.addEventListener("click",()=>UiRegistry.refs.replayFileInput?.click());
UiRegistry.refs.replayFileInput?.addEventListener("change",async()=>{
  const file=UiRegistry.refs.replayFileInput.files?.[0];if(!file)return;
  ReplayPresentation.clearReplayImportError();
  try{
    const data=JSON.parse(await file.text());
    const started=ReplayPresentation.startReplay(data,{onError:error=>ReplayPresentation.showReplayImportError(error)});
    if(started)ReplayPresentation.clearReplayImportError();
  }catch(e){LogUtil.log(`⚠ 리플레이 열기 실패 · ${e.message||e}`);ReplayPresentation.showReplayImportError(e)}
  finally{UiRegistry.refs.replayFileInput.value=""}
});
UiRegistry.refs.replayPlayPauseBtn?.addEventListener("click",()=>ReplayPresentation.replayPlayer?.setPlaying(!ReplayPresentation.replayPlayer.playing));
UiRegistry.refs.replaySpeed?.addEventListener("change",()=>ReplayPresentation.replayPlayer?.setSpeed(UiRegistry.refs.replaySpeed.value));
class ReplayInteraction{
  static seekSeconds(seconds,{resumePlaying=null}={}){
  if(!ReplayPresentation.replayPlayer)return;
  const targetTick=Math.round(RangeUtil.clamp(Number(seconds)||0,0,ReplayPresentation.replayPlayer.endTick/SimulationTiming.tps())*SimulationTiming.tps());
  const shouldResume=resumePlaying==null?!!ReplayPresentation.replayPlayer.playing:!!resumePlaying;
  try{
    if((ReplayPresentation.replayPlayer.sim?.tick||0)!==targetTick)ReplayPresentation.timeline.seek(targetTick);
    UiRegistry.refs.log.style.removeProperty("display");
  }catch(error){
    LogUtil.log(`⚠ 리플레이 시간 이동 실패 · ${error.message||error}`);
    UiRegistry.refs.log.style.display="block";
    if(UiRegistry.refs.replayTimeInput)UiRegistry.refs.replayTimeInput.value=ReplayPresentation.formatReplayTime(ReplayPresentation.replayPlayer.sim?.tick||0);
  }
  ReplayPresentation.replayPlayer.setPlaying(shouldResume&&(ReplayPresentation.replayPlayer.sim?.tick||0)<ReplayPresentation.replayPlayer.endTick);
  ReplayPresentation.syncReplayControls();
}
  static parseTimeInput(value){
  const raw=String(value||"").trim();if(!raw)return null;
  if(/^\d+(?:\.\d+)?$/.test(raw))return Number(raw);
  const m=raw.match(/^(\d+):(\d{1,2})(?:\.(\d+))?$/);if(!m)return null;
  return Number(m[1])*60+Number(m[2])+Number("0."+(m[3]||"0"));
  }
}
UiRegistry.refs.replayTimeline?.addEventListener("pointerdown",()=>{
  if(!ReplayPresentation.replayPlayer)return;
  ReplayPresentation.replayTimelineDragging=true;
  if(ReplayPresentation.replayTimelineResumePlaying==null)ReplayPresentation.replayTimelineResumePlaying=!!ReplayPresentation.replayPlayer.playing;
  ReplayPresentation.replayPlayer.setPlaying(false);
});
UiRegistry.refs.replayTimeline?.addEventListener("input",()=>{
  if(!ReplayPresentation.replayPlayer)return;ReplayPresentation.replayTimelineDragging=true;
  if(UiRegistry.refs.replayTime)UiRegistry.refs.replayTime.textContent=`${ReplayPresentation.formatReplayTime((Number(UiRegistry.refs.replayTimeline.value)||0)*SimulationTiming.tps())} / ${ReplayPresentation.formatReplayTime(ReplayPresentation.replayPlayer.endTick)}`;
});
class ReplayTimelineInteraction{
  static commit(){
  if(!ReplayPresentation.replayPlayer||!UiRegistry.refs.replayTimeline)return;
  const sec=Number(UiRegistry.refs.replayTimeline.value)||0;
  const resumePlaying=ReplayPresentation.replayTimelineResumePlaying==null?!!ReplayPresentation.replayPlayer.playing:ReplayPresentation.replayTimelineResumePlaying;
  ReplayPresentation.replayTimelineDragging=false;
  ReplayPresentation.replayTimelineResumePlaying=null;
  ReplayInteraction.seekSeconds(sec,{resumePlaying});
  }
}
// Range controls already emit one `change` at commit time for mouse/touch/keyboard.
// Do not also seek on pointerup: that would replay the same expensive seek twice.
UiRegistry.refs.replayTimeline?.addEventListener("change",ReplayTimelineInteraction.commit);
UiRegistry.refs.replayTimeline?.addEventListener("pointercancel",()=>{
  ReplayPresentation.replayTimelineDragging=false;
  if(ReplayPresentation.replayPlayer&&ReplayPresentation.replayTimelineResumePlaying!=null)ReplayPresentation.replayPlayer.setPlaying(ReplayPresentation.replayTimelineResumePlaying);
  ReplayPresentation.replayTimelineResumePlaying=null;
  ReplayPresentation.syncReplayControls();
});
UiRegistry.refs.replayTimeGoBtn?.addEventListener("click",()=>{const sec=ReplayInteraction.parseTimeInput(UiRegistry.refs.replayTimeInput?.value);if(sec==null){LogUtil.log("시간 형식은 MM:SS 또는 초 단위로 입력하세요.");return}ReplayInteraction.seekSeconds(sec)});
UiRegistry.refs.replayTimeInput?.addEventListener("keydown",e=>{if(e.key==="Enter")UiRegistry.refs.replayTimeGoBtn?.click()});
UiRegistry.refs.replayStepBackBtn?.addEventListener("click",()=>ReplayInteraction.seekSeconds((ReplayPresentation.replayPlayer?.sim?.tick||0)/SimulationTiming.tps()-5));
UiRegistry.refs.replayStepForwardBtn?.addEventListener("click",()=>ReplayInteraction.seekSeconds((ReplayPresentation.replayPlayer?.sim?.tick||0)/SimulationTiming.tps()+5));
UiRegistry.refs.replayStepBack30Btn?.addEventListener("click",()=>ReplayInteraction.seekSeconds((ReplayPresentation.replayPlayer?.sim?.tick||0)/SimulationTiming.tps()-30));
UiRegistry.refs.replayStepForward30Btn?.addEventListener("click",()=>ReplayInteraction.seekSeconds((ReplayPresentation.replayPlayer?.sim?.tick||0)/SimulationTiming.tps()+30));
UiRegistry.refs.replayHostViewBtn?.addEventListener("click",()=>ReplayPresentation.replayPlayer?.setViewMode("host"));
UiRegistry.refs.replayGuestViewBtn?.addEventListener("click",()=>ReplayPresentation.replayPlayer?.setViewMode("guest"));
UiRegistry.refs.replayAllViewBtn?.addEventListener("click",()=>ReplayPresentation.replayPlayer?.setViewMode("all"));
UiRegistry.refs.replayHostOrientationBtn?.addEventListener("click",()=>ReplayPresentation.replayPlayer?.setOrientation("host"));
UiRegistry.refs.replayGuestOrientationBtn?.addEventListener("click",()=>ReplayPresentation.replayPlayer?.setOrientation("guest"));
UiRegistry.refs.replayZoomOutBtn?.addEventListener("click",()=>ReplayPresentation.replayPlayer?.setZoom((ReplayPresentation.replayPlayer.zoom||1)-.2));
UiRegistry.refs.replayZoomInBtn?.addEventListener("click",()=>ReplayPresentation.replayPlayer?.setZoom((ReplayPresentation.replayPlayer.zoom||1)+.2));
UiRegistry.refs.replayExitBtn?.addEventListener("click",ReplayPresentation.stopReplay);

// A rematch reloads into a fresh match: the AI starts again from #/play, a friend match goes back to the friend sheet.
const reloadAt=hash=>{history.replaceState(null,"",location.pathname+location.search+hash);location.reload()};
UiController.bindImmediateButton(UiRegistry.refs.rematch,()=>reloadAt(MatchLifecycle.singleMatch?"#/play":"#/friend"));
if(!SIM_WORKER)BattlePresentation.setupCanvas();

// Recovery initiation must mirror a real multiplayer client:
// only the session controlled by this UI/tab initiates recovery.
// In single player this is whichever role the human selected.
// The AI remains the opposite real WebRTC peer.

document.addEventListener("visibilitychange",()=>{
  RecoveryTelemetry.recordRecovery("page.visibility",RecoveryTelemetry.localRecoverySession?.(),RecoveryTelemetry.localRecoverySession?.()?.transport,{visibility:document.visibilityState});
  AppLifecycle.applyPageVisibility();
});

document.addEventListener("freeze",()=>{
  RecoveryTelemetry.recordRecovery("page.freeze",RecoveryTelemetry.localRecoverySession?.(),RecoveryTelemetry.localRecoverySession?.()?.transport);
  AppLifecycle.invalidateLiveConnectionForLifecycle("page-freeze");
});

document.addEventListener("resume",()=>{
  RecoveryTelemetry.recordRecovery("page.resume",RecoveryTelemetry.localRecoverySession?.(),RecoveryTelemetry.localRecoverySession?.()?.transport);
});

window.addEventListener("pagehide",e=>{
  RecoveryTelemetry.recordRecovery("page.pagehide",RecoveryTelemetry.localRecoverySession?.(),RecoveryTelemetry.localRecoverySession?.()?.transport,{persisted:!!e.persisted});
  if(e.persisted)AppLifecycle.invalidateLiveConnectionForLifecycle("pagehide-bfcache");
});
window.addEventListener("pageshow",e=>{
  RecoveryTelemetry.recordRecovery("page.pageshow",RecoveryTelemetry.localRecoverySession?.(),RecoveryTelemetry.localRecoverySession?.()?.transport,{persisted:!!e.persisted});
  if(document.visibilityState==="visible"&&AppLifecycle.pageHiddenAtWall)AppLifecycle.applyPageVisibility();
});
window.addEventListener("focus",()=>{
  RecoveryTelemetry.recordRecovery("page.focus",RecoveryTelemetry.localRecoverySession?.(),RecoveryTelemetry.localRecoverySession?.()?.transport);
  if(document.visibilityState==="visible"&&AppLifecycle.pageHiddenAtWall)AppLifecycle.applyPageVisibility();
});
window.addEventListener("blur",()=>{
  RecoveryTelemetry.recordRecovery("page.blur",RecoveryTelemetry.localRecoverySession?.(),RecoveryTelemetry.localRecoverySession?.()?.transport);
});

// 페이지가 실제로 사용자에게 보여지는 동안 화면 자동 꺼짐을 최대한 방지한다.
if(!SIM_WORKER)AppLifecycle.requestScreenWakeLock();

/* Title-screen procedural scene. Pure presentation: fixed local paths, no StrategySim state. */
(function initTitleScene(){
  const canvas=SIM_WORKER?null:document.getElementById("titleSceneCanvas");
  if(!canvas)return;
  const ctx=canvas.getContext("2d");
  if(!ctx)return;
  const agents=[
    {lane:.21,p:.02,s:.020,type:"seed",team:0},{lane:.21,p:.19,s:.017,type:"bug",team:0},{lane:.21,p:.39,s:.014,type:"moth",team:0},
    {lane:.50,p:.08,s:.018,type:"bug",team:0},{lane:.50,p:.29,s:.015,type:"seed",team:0},{lane:.50,p:.67,s:-.016,type:"bug",team:1},
    {lane:.79,p:.13,s:.016,type:"moth",team:0},{lane:.79,p:.75,s:-.019,type:"seed",team:1},{lane:.79,p:.92,s:-.015,type:"bug",team:1},
    {lane:.21,p:.82,s:-.017,type:"moth",team:1},{lane:.50,p:.88,s:-.013,type:"seed",team:1}
  ];
  function resize(){
    const r=canvas.getBoundingClientRect(),dpr=Math.min(1.6,window.devicePixelRatio||1);
    const w=Math.max(1,Math.floor(r.width*dpr)),h=Math.max(1,Math.floor(r.height*dpr));
    if(canvas.width!==w||canvas.height!==h){canvas.width=w;canvas.height=h}
    return {w,h,dpr};
  }
  function pathPoint(t,lane,w,h){
    const x=w*(.07+.86*t),baseY=h*(.88-.76*t),curve=Math.sin(t*Math.PI*1.35+lane*3.2)*h*.055;
    return {x,y:baseY+(lane-.5)*h*.42+curve};
  }
  function drawLeafUnit(x,y,r,team,phase){
    const body=team===0?"#4d8d4b":"#b75749",dark=team===0?"#214f34":"#6e302b";
    ctx.save();ctx.translate(x,y);ctx.rotate(Math.sin(phase)*.18);
    ctx.fillStyle="#173b2230";ctx.beginPath();ctx.ellipse(2,r*.8,r*1.05,r*.45,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle=body;ctx.beginPath();ctx.ellipse(0,0,r*.78,r,0,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=dark;ctx.lineWidth=Math.max(1,r*.13);ctx.beginPath();ctx.moveTo(-r*.15,-r*.3);ctx.lineTo(r*.95,-r*.95);ctx.stroke();
    ctx.fillStyle="#9ed86e";ctx.beginPath();ctx.ellipse(r*.72,-r*.9,r*.62,r*.26,-.65,0,Math.PI*2);ctx.fill();
    ctx.restore();
  }
  function drawBug(x,y,r,team,phase){
    const body=team===0?"#6aa94e":"#c66a52",dark=team===0?"#315d31":"#71382f";
    ctx.save();ctx.translate(x,y);ctx.rotate(Math.sin(phase*.7)*.12);
    ctx.fillStyle="#173b2230";ctx.beginPath();ctx.ellipse(2,r*.8,r*1.1,r*.45,0,0,Math.PI*2);ctx.fill();
    ctx.strokeStyle=dark;ctx.lineWidth=Math.max(1,r*.12);for(const sy of [-.45,0,.45]){ctx.beginPath();ctx.moveTo(-r*.55,r*sy);ctx.lineTo(-r*1.05,r*(sy+.2));ctx.moveTo(r*.55,r*sy);ctx.lineTo(r*1.05,r*(sy+.2));ctx.stroke()}
    ctx.fillStyle=body;ctx.beginPath();ctx.ellipse(0,0,r*.72,r,0,0,Math.PI*2);ctx.fill();
    ctx.fillStyle="#e9d874";ctx.beginPath();ctx.arc(0,-r*.64,r*.19,0,Math.PI*2);ctx.fill();ctx.restore();
  }
  function drawMoth(x,y,r,team,phase){
    const body=team===0?"#4f9a75":"#c56d63";
    ctx.save();ctx.translate(x,y-Math.sin(phase*2)*r*.28);
    ctx.fillStyle="#173b2230";ctx.beginPath();ctx.ellipse(2,r*1.25,r*1.15,r*.38,0,0,Math.PI*2);ctx.fill();
    ctx.globalAlpha=.78;ctx.fillStyle=team===0?"#c7efd0":"#ffd5c8";
    const flap=.62+.22*Math.sin(phase*3);for(const sx of [-1,1]){ctx.save();ctx.scale(sx,1);ctx.rotate(-.3*flap);ctx.beginPath();ctx.ellipse(r*.7,-r*.15,r*.72,r*.38,-.5,0,Math.PI*2);ctx.fill();ctx.restore()}
    ctx.globalAlpha=1;ctx.fillStyle=body;ctx.beginPath();ctx.ellipse(0,0,r*.28,r*.85,0,0,Math.PI*2);ctx.fill();ctx.restore();
  }
  function frame(ms){
    const {w,h}=resize();
    if(UiRuntimeState.value.screen==="lobby"){
      ctx.clearRect(0,0,w,h);
const g=ctx.createLinearGradient(0,0,w,h);g.addColorStop(0,"#b9dba6");g.addColorStop(.58,"#8fc48d");g.addColorStop(1,"#6eaa83");ctx.fillStyle=g;ctx.fillRect(0,0,w,h);
      // terrain patches
      ctx.fillStyle="#dfe5a7";for(let i=0;i<7;i++){const x=w*(.12+(i*.137)% .82),y=h*(.12+((i*37)%73)/100*.76);ctx.beginPath();ctx.ellipse(x,y,w*.08,h*.04,(i%3-.8)*.4,0,Math.PI*2);ctx.fill()}
      // river
      ctx.strokeStyle="#7fc4dd";ctx.lineWidth=Math.max(10,w*.055);ctx.lineCap="round";ctx.globalAlpha=.82;ctx.beginPath();ctx.moveTo(w*.02,h*.38);ctx.bezierCurveTo(w*.28,h*.25,w*.55,h*.72,w*.98,h*.53);ctx.stroke();ctx.globalAlpha=1;
      ctx.strokeStyle="#dff6ff88";ctx.lineWidth=Math.max(2,w*.008);ctx.beginPath();ctx.moveTo(w*.02,h*.36);ctx.bezierCurveTo(w*.28,h*.23,w*.55,h*.70,w*.98,h*.51);ctx.stroke();
      // three strategic lanes
      ctx.setLineDash([Math.max(4,w*.012),Math.max(5,w*.016)]);ctx.lineWidth=Math.max(1,w*.003);ctx.strokeStyle="#f7ffe377";
      for(const lane of [.21,.5,.79]){ctx.beginPath();for(let i=0;i<=28;i++){const p=pathPoint(i/28,lane,w,h);i?ctx.lineTo(p.x,p.y):ctx.moveTo(p.x,p.y)}ctx.stroke()}
      ctx.setLineDash([]);
      // rally flag at center
      const c=pathPoint(.5,.5,w,h);const pulse=1+Math.sin(ms*.004)*.06;
      ctx.strokeStyle="#fffbd0";ctx.lineWidth=Math.max(2,w*.005);ctx.beginPath();ctx.arc(c.x,c.y,w*.048*pulse,0,Math.PI*2);ctx.stroke();
      ctx.strokeStyle="#214b32";ctx.lineWidth=Math.max(2,w*.006);ctx.beginPath();ctx.moveTo(c.x,c.y+h*.055);ctx.lineTo(c.x,c.y-h*.075);ctx.stroke();
      ctx.fillStyle="#f3b63e";ctx.beginPath();ctx.moveTo(c.x,c.y-h*.075);ctx.lineTo(c.x+w*.07,c.y-h*.055);ctx.lineTo(c.x+w*.05,c.y-h*.018);ctx.lineTo(c.x,c.y-h*.035);ctx.closePath();ctx.fill();
      // units
      const t=ms/1000;
      for(let i=0;i<agents.length;i++){
        const a=agents[i];let p=(a.p+t*a.s)%1;if(p<0)p+=1;const pt=pathPoint(p,a.lane,w,h);const r=Math.max(5,Math.min(w,h)*(.025+(i%3)*.002));
        if(a.type==="bug")drawBug(pt.x,pt.y,r,a.team,t+i);else if(a.type==="moth")drawMoth(pt.x,pt.y,r,a.team,t+i);else drawLeafUnit(pt.x,pt.y,r,a.team,t+i);
      }
      // bases
      for(const [x,y,team] of [[w*.08,h*.87,0],[w*.91,h*.13,1]]){ctx.fillStyle=team===0?"#e5f1d3":"#f3d2c9";ctx.strokeStyle=team===0?"#356c47":"#9d4d43";ctx.lineWidth=Math.max(2,w*.005);ctx.beginPath();ctx.arc(x,y,w*.055,0,Math.PI*2);ctx.fill();ctx.stroke();ctx.fillStyle=ctx.strokeStyle;ctx.beginPath();ctx.arc(x,y,w*.019,0,Math.PI*2);ctx.fill()}
    }
    if(UiRuntimeState.value.screen!=="lobby"){
      setTimeout(()=>requestAnimationFrame(frame),320);
    }else{
      requestAnimationFrame(frame);
    }
  }
  requestAnimationFrame(frame);
})();

// Deployment metadata is optional diagnostics. Its fetch never gates game startup.

if(UiRegistry.refs.infoDetailCloseBtn)UiRegistry.refs.infoDetailCloseBtn.onclick=BattlePresentation.closeInfoDetail;
if(UiRegistry.refs.infoDetailDialog)UiRegistry.refs.infoDetailDialog.addEventListener("click",e=>{if(e.target===UiRegistry.refs.infoDetailDialog)BattlePresentation.closeInfoDetail()});
BattlePresentation.installLongPressDetails();
BuildingPresentation.renderBuildMetadata();
void BUILD_META.load().then(()=>BuildingPresentation.renderBuildMetadata());

if(UiRegistry.refs.bootRetryBtn)UiController.bindImmediateButton(UiRegistry.refs.bootRetryBtn,AppLifecycle.runBootAndStartApp);
// The Worker realm hosts only a simulation session; the page boots the app.
if(SIM_WORKER)SimWorkerHost.install();
else{
  UnitVisualLookup.validateCoverage();
  AppLifecycle.runBootAndStartApp();
  const dev=readDevQuery(location.search);
  if(dev.tps)UiController.setStartSimulationTps(dev.tps);
  if(dev.netcode)UiController.setStartNetcodeMode(dev.netcode);
  const leaveSetup=()=>{audioSystem.unlock();CampaignRuntime.clear();DebugScenarioHarness.pending=null;CampaignPresentation.clear();UiRuntimeState.value.settings.presetId="standard"};
  LaunchScreens.install({createNavigation:RallyGamekit.createNavigation,actions:{
    inMatch:()=>UiRuntimeState.value.screen==="game",
    hasResult:()=>UiRuntimeState.value.screen==="result",
    startAiMatch:()=>{leaveSetup();MatchLifecycle.startSinglePlayerWebRTC(dev.role||"host")},
    openMenu:()=>{if(UiRuntimeState.value.modal!=="match-menu")MatchLifecycle.openMatchMenu()},
    closeMenu:()=>{if(UiRuntimeState.value.modal==="match-menu")MatchLifecycle.closeMatchMenu()},
    grains:()=>LaunchRules.deck,
    grainName:t=>UnitDefinition.get(t)?.name||t,
    grainStats:t=>({...LaunchRules.payload(t),maxReach:LaunchRules.maxReachOf(t)}),
    portraitSource:t=>grainPortrait(t,window.RallyVectorAssets[t]),
    toggleSound:()=>audioSystem.setEnabled(!audioSystem.enabled),
    soundOn:()=>!!audioSystem.enabled,
    createRoom:()=>{leaveSetup();UiController.openUiModal("create");MatchLifecycle.beginCreateRoom()},
    joinRoom:code=>{leaveSetup();UiController.openJoinDialog();UiRegistry.refs.room.value=code;MatchLifecycle.submitJoinRoom()},
    leaveToTitle:()=>reloadAt("#/")
  }});
  if(dev.battleTest)MobileBattleTestMode.start(dev.battleTest);
  else if(dev.unitTest){
    leaveSetup();DebugScenarioHarness.pending=DebugScenarioHarness.fromQuery(dev.unitTest);UiRuntimeState.value.settings.presetId="unitTest";
    MatchLifecycle.startSinglePlayerWebRTC(dev.role||"host");
  }else if(dev.campaign)openCampaign();
  if(new URLSearchParams(location.search).has("debug")){
    const {createDebugScenes}=await import("./debug-scenes.js");
    RallyGamekit.installDebugHost({scenes:createDebugScenes({openBattle:params=>DebugScenarioHarness.openReplayBattle(params),openCharge:params=>DebugScenarioHarness.openChargeReplay(params)})});
  }
}

export { AppLifecycle, CampaignMapDefinition, CampaignMissionDefinition, CampaignOutcomeRules, CampaignPresentation, CampaignScriptRuntime, ConnectionPresentation, DebugScenarioHarness, DiagnosticPresentation, LocalEnvironmentUtil, LogUtil, MatchLifecycle, ReplayPresentation, SimulationTiming, SinglePlayerModeUtil, UiController, UiRegistry };
