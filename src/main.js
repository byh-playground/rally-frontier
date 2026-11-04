import { RangeUtil, SIM_TPS } from './core/game-rules.js';
import { GrainFaceOverlay } from './core/grain-face-overlay.js';
import './sim/strategy-sim.js';
import { TerrainQuery, VisionField } from './sim/entities.js';
import { BotController } from './ai/bot-controller.js';
import { GameSession, RallySynctestDiagnostics } from './session/game-session.js';
import { ReplayPlayer, ReplayPolicy } from './session/replay.js';
import { ActiveViewState, BACKGROUND_TICK_SESSIONS, NetworkModuleLoader } from './session/runtime-state.js';
import { LaunchRules } from './sim/launch-rules.js';
import './sim/spatial-grids.js';
import { NostrRtcTransport } from './net/rtc-transport.js';
import { RecoveryTelemetry } from './diagnostics/recovery-telemetry.js';
import { ConnectionSideUtil } from './net/lobby-codec.js';
import { CloneUtil, HashUtil, MapGeneration } from './sim/map-generation.js';
import { AttackPresentationDefinition } from './definitions/attack-presentation.js';
import { BuildingDefinition } from './definitions/buildings.js';
import { UnitDefinition, UnitFactionPalette, UnitVisualDefinition } from './definitions/units.js';
import { MapGeometry } from './sim/map-geometry.js';
import { CAPTURE_DURATION_MS, CAPTURE_RADIUS, LANE_CONTROL_POINTS } from './definitions/combat-rules.js';
import { PerformanceTelemetry } from './diagnostics/performance-telemetry.js';
import './definitions/formations.js';
import { ROGUE_LEAP_ARC_HEIGHT, VIEW_H, VIEW_W } from './definitions/world-rules.js';
import { WorldContext } from './sim/world-context.js';
import { NavigationGoal, NavigationMeshBuilder } from './sim/navigation.js';
import { BattlefieldProjection, PolygonTriangulation, TerrainSurfaceAtlas, TerrainSurfaceProjection } from './sim/terrain.js';
import { BACKGROUND_TICK_PULSE_MS } from './core/session-timing.js';
import { RENDER_TRACKS } from './render/render-tracks.js';
import { CONFIG, LAUNCH_HOLD_ARM_MS, LAUNCH_HOLD_DRAG_PX, STATE_PUBLISH_HZ, STATE_PUBLISH_INTERVAL_MS, netcodeMode } from './core/config.js';
import { BUILD_META } from './core/build-info.js';
import { RallyGamekit, SIM_WORKER } from './core/gamekit.js';
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
    dodge:Object.freeze({lifeMs:750,baseSize:15,minSize:10,rise:30,alpha:.8,strokeAlpha:.8,pop:1})
  });
  static get(kind){return this.presets[kind]||this.presets.damageDealt}
}

class EffectObjectFactory{
  static makeFloatFx(){return {x:0,y:0,kind:"",text:"",amount:0,start:0,jitter:0,lane:0}}
  static resetFloatFx(v){v.x=0;v.y=0;v.kind="";v.text="";v.amount=0;v.start=0;v.jitter=0;v.lane=0}
  static makeShakeFx(){return {start:0,duration:0,intensity:0,seed:0}}
  static resetShakeFx(v){v.start=0;v.duration=0;v.intensity=0;v.seed=0}
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
// Depth gap between consecutive grains in painter order: a few 24-bit depth steps, so 500 grains shift terrain occlusion by ~2e-4.
const GRAIN_DEPTH_RANK_STEP=4e-7;

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
const PROJECTILE_VISUAL_RENDER_FNS=Object.freeze({
  "launchAmmo":(rdr,c)=>{const {p,sc,screenMotion,x,y}=c;
    // Each grain flies as its own bundle SVG, nose along the screen-space flight direction.
    const dx=screenMotion?.valid?screenMotion.dx:1,dy=screenMotion?.valid?screenMotion.dy:0,length=Math.max(30,58*sc);
    const record=rdr.launchAmmoRecord(p.payload?.type);if(!record)return;
    rdr.drawVectorBillboard(record,x,y,Math.atan2(dy,dx),length/200);
    rdr.circle(x,y,Math.max(2,3*sc),rdr.factionRelation(p.side)==="friendly"?[.30,.55,1,1]:[1,.36,.32,1],8);
  },
});
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
    // One actor per grain: a shared actor re-seeked per grain rewrites its pose row and splits the instanced batch.
    this.grainActors=new Map();this.grainActorFrame=0;this.grainBodyGroups=new Map();this.grainOpaqueCoverage=new Map();
    this._vectorUnitMatrix=new Float32Array(6);
    this._vectorOcclusionCoords=new Float32Array(0);
    this.gl=this.device.gl;
    this.passState={depthEnabled:true,depthWrite:true,depthFunc:"lequal",stencil:false,colorMask:[true,true,true,true]};
    if(!this.gl)throw new Error("RALLY FRONTIER requires WebGL for battlefield rendering.");
    this.backend="WebGL";
    this.canvas.dataset.rendererBackend=this.backend;

    // Render-only visibility spatial cache.
    this.visionFields=[null,null];
    this.fogVisibilityGrids=new Map();
    this.visibleUnitFrame=[];

    // High-frequency renderer pools. They are presentation-only and deliberately
    // excluded from deterministic state. Sizes are bounded to prevent hidden growth.
    this.renderState=new RenderStateStore(RENDER_TRACKS);
    this.liveRenderTargets=false;
    this.combatFxPool=new RallyGamekit.ObjectPool(EffectObjectFactory.makeCombatFx,EffectObjectFactory.resetCombatFx,256);
    this.floatFxPool=new RallyGamekit.ObjectPool(EffectObjectFactory.makeFloatFx,EffectObjectFactory.resetFloatFx,96);
    this.shakeFxPool=new RallyGamekit.ObjectPool(EffectObjectFactory.makeShakeFx,EffectObjectFactory.resetShakeFx,16);
    this.commonEffectPool=new CommonEffectPool(this);
    // Presentation-only shared hitGuard shield state. All shield sources use the same visual language.

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
    this.attackVariantBreathFx=[];
    // Presentation-only facing: never enters StrategySim/checksum/export/recovery.
    this.unitFacingStates=new Map();
    this.artilleryFacingStates=new Map();
    this.projectileScreenMotionStates=new Map();
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
    this.frameShakeX=0;
    this.frameShakeY=0;
    this.cameraShakePresentationMoved=false;
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
    if(side!==0&&side!==1)return "neutral";
    return this.isFriendlySide(side)?"friendly":"enemy";
  }
  factionColor(side,{alpha=1,neutral=[.95,.73,.25]}={}){
    const relation=this.factionRelation(side);
    const rgb=relation==="friendly"?[.22,.50,1]:relation==="enemy"?[1,.30,.30]:neutral;
    return [rgb[0],rgb[1],rgb[2],alpha];
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
  v(x,y,c){
    this.frame.push7(x,y,this._renderDepth??0,c[0],c[1],c[2],RangeUtil.clamp(c[3]??1,0,1));
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
    const units=source.units||[],projectiles=source.projectiles||[];
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
  renderTrackedDelta(entity,kind="unit"){
    return this.renderState.delta(kind,entity.id);
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
  unitVisibleForRender(u){
    if(!u?.alive||!this.presentationEntityActive("unit",u.id))return false;
    const p=this.projectEntityScreen(u,"unit"),pad=((UnitDefinition.get(u.type)?.size||15)+80)*this.sc();
    if(p.x<-pad||p.y<-pad||p.x>this.canvas.width+pad||p.y>this.canvas.height+pad)return false;
    return u.side===this.mySide()||this.visibleRaw(u.x,u.y);
  }
  prepareVisibleUnitFrame(){
    const out=this.visibleUnitFrame;out.length=0;
    for(const u of this.renderState.displayed("unit",this.presentationNow()))if(this.unitVisibleForRender(u))out.push(u);
    return out;
  }

  drawUnitShadow(u,visibilityChecked=false){
    const own=u.side===this.mySide();
    if(!visibilityChecked&&!own&&!this.visibleRaw(u.x,u.y))return;
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
      this.circle(ground.x+2*sc,ground.y+Math.max(1,2*sc),r*.96*shrink,[.04,.06,.08,alpha],12);
      this.circle(ground.x,ground.y,r*.52*shrink,[.04,.06,.08,alpha*.50],10);
    },.0003);
  }

  rebuildVisibilityCache(){
    if(!this.snapshot)return;
    for(const side of [0,1])VisionField.of(this,side,this.snapshot);
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

    this.rebuildVisibilityCache();

    this.processFloatingEvents(s);
    this.processClientCombatEffects(s);
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

  

  processClientCombatEffects(snapshot){
    if(!snapshot||!this.fxCtx)return;

    const roleKey=this.role==="guest"?"guest":"host";
    if(this.lastCombatFxTickByRole[roleKey]===snapshot.tick)return;
    this.lastCombatFxTickByRole[roleKey]=snapshot.tick;

    const mySide=this.mySide();
    let index=0;

    for(const e of snapshot.events||[]){
      const x=Number(e.x),y=Number(e.y);
      const visible=e.side===mySide||(Number.isFinite(x)&&Number.isFinite(y)&&this.visibleRaw(x,y));
      if(!visible){index++;continue}

      if(e.type==="hit"){
        const sourceType=e.sourceType||"";
        const attackVisual=AttackPresentationDefinition.forSource(sourceType),impactPreset=AttackPresentationDefinition.impactPreset(sourceType);
        if(attackVisual.travel==="none"&&attackVisual.sourceMotion&&e.sourceId){
          const source=(snapshot.units||[]).find(u=>u.id===e.sourceId&&u.alive);
          if(source)this.addClientFx("meleeSourceMotion",{...e,x:source.x,y:source.y,x2:e.x,y2:e.y},snapshot,index,{motion:attackVisual.sourceMotion});
          this.attackPresentationUntil.set(e.sourceId,performance.now()+220);
        }
        if(!e.suppressImpactFx)this.addClientFx("meleeImpact",e,snapshot,index,{impactScale:impactPreset.scale});
        if(e.side===mySide)this.triggerClientShake(1.5,90,HashUtil.hash(`${snapshot.tick}|hurt|${index}`));
      }else if(e.type==="death"){
        this.addClientFx("deathBurst",e,snapshot,index);
      }else if(e.type==="buildingDeath"){
        this.addClientFx("buildingBurst",e,snapshot,index);
        this.triggerClientShake(3.5,180,HashUtil.hash(`${snapshot.tick}|building|${index}`));
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
      }else if(e.type==="dodge"){      }else if(e.type==="dodge"||e.type==="graze"){
        if(e.side!==side&&!this.visibleRaw(e.x,e.y)){index++;continue}
        kind="dodge";
        text="MISS";
      }

      if(!kind){index++;continue}

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
        fx.kind==="buildingBurst"?620:
        fx.kind==="deathBurst"?480:
        fx.kind==="meleeSourceMotion"?(AttackPresentationDefinition.sourceMotions[fx.motion]?.lifeMs||220):
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

      if(fx.kind==="meleeSourceMotion"){
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
      }

      ctx.restore();
      this.combatFx[write++]=fx;
    }

    this.combatFx.length=write;
  }

  drawWorldHudOverlay(){
    const ctx=this.fxCtx,snap=this.snapshot;
    if(!ctx||!this.fxCanvas||!snap)return;
    const side=this.mySide(),sc=this.sc();

    ctx.save();
    ctx.lineCap="round";
    ctx.lineJoin="round";

    // Single-owner invariant for status bars: building and unit HP are drawn ONLY here,
    // never inside drawBuilding()/drawUnit(). This pass stays above combat VFX so
    // explosions/debris can never cover persistent information.
    for(const b of snap.buildings||[]){
      if(b.alive===false||b.hp>=b.maxHp)continue;
      if(b.side!==side&&!this.visibleRaw(b.x,b.y))continue;
      if(!this.onScreenAuth(b.x,b.y,(BuildingDefinition.get(b.type)?.size||40)+100))continue;
      const d=BuildingDefinition.get(b.type)||{size:35};
      const anchor=RallyGamekit.resolveAnchorInto(this.stableCamera(),{space:'world',
        x:this.viewX(b.x),y:this.viewY(b.y),z:this.world.terrain.surfaces.heightAt(b.x,b.y)},{});
      const {x,y}=anchor,r=d.size*sc;
      const ratio=RangeUtil.clamp((b.hp||0)/Math.max(1,b.maxHp||1),0,1);
      const bw=r*2,bh=Math.max(2.4,3.2*sc),by=y+r+3*sc;
      ctx.fillStyle="rgba(18,24,28,.72)";ctx.fillRect(x-r-1*sc,by-1*sc,bw+2*sc,bh+2*sc);
      ctx.fillStyle=ratio>.48?"#62c775":"#f04d49";ctx.fillRect(x-r,by,bw*ratio,bh);
    }

    for(const u of snap.units||[]){
      const maxHp=Math.max(1,Number(u.maxHp)||1);
      if(!u.alive||(Number(u.hp)||0)>=maxHp)continue;
      if(u.side!==side&&!this.visibleRaw(u.x,u.y))continue;
      if(!this.onScreenAuth(u.x,u.y,(UnitDefinition.get(u.type)?.size||15)+100))continue;
      const projected=this.projectRenderWorldPosition(this.resolveRenderWorldPosition(u,"unit"));
      const r=this.unitRenderRadius(u),bw=r*2.2,bh=Math.max(2.2,3.2*sc),x=projected.x,y=projected.y-r*1.58;
      const ratio=RangeUtil.clamp((Number(u.hp)||0)/maxHp,0,1);
      ctx.fillStyle="rgba(7,10,12,.72)";
      ctx.fillRect(x-bw/2-1*sc,y-1*sc,bw+2*sc,bh+2*sc);
      ctx.fillStyle=ratio>.48?"#6fdf63":"#f34d47";
      ctx.fillRect(x-bw/2,y,bw*ratio,bh);
    }

    ctx.restore();
  }
  drawSelectedBuildingOverlay(){
    const ctx=this.fxCtx,snap=this.snapshot,id=this.selectedBuildingId;
    if(!ctx||!snap||!id)return;
    const side=this.mySide(),b=(snap.buildings||[]).find(x=>x.id===id&&x.alive!==false&&x.side===side);
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

  drawFloatingFx(){
    const ctx=this.fxCtx;
    if(!ctx||!this.fxCanvas)return;

    ctx.clearRect(0,0,this.fxCanvas.width,this.fxCanvas.height);

    // Stable presentation order. It never changes with unit count:
    // world annotations -> decorative combat VFX -> persistent world HUD -> numbers -> status/selection.
    this.drawStrategicLabels();

    // Decorative presentation is always below information overlays.
    this.commonEffectPool.beginFrame(performance.now());
    this.drawClientCombatFx();
    this.commonEffectPool.drawFire(ctx);
    this.commonEffectPool.endFrame();

    // Persistent information is never hidden by combat density.
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

      let fill="#d7e9ff",stroke="#1a3d64";
      if(f.kind==="damageTaken"){fill="#ff6b6b";stroke="#4b0909"}
      else if(f.kind==="damageDealt"){fill="#fff0c2";stroke="#6d2c12"}

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

    // Selection is the final world-space UI layer, readable over explosions.
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
  drawBuilding(b){
    if(BuildingDefinition.get(b.type)?.isTerrainBarrier)return TerrainPresentation.drawBarrier(this,b);
    const own=this.isFriendlySide(b.side);
    if(!own&&!this.visibleRaw(b.x,b.y))return;
    const[x,y]=this.worldToPx(this.viewX(b.x),this.viewY(b.y)),sc=this.sc(),d=BuildingDefinition.get(b.type);
    const r=d.size*sc;
    const shell=[.12,.16,.20,1];
    const stone=[.72,.74,.73,1];
    const teamCap=own?[.19,.48,.94,1]:[.94,.27,.27,1];
    const teamHi=own?[.57,.78,1,1]:[1,.62,.60,1];

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
  }
  // Identity comes from species silhouette, appendages, equipment and VFX.

  unitRenderVisualScale(u){
    return UnitVisualDefinition.get(u?.type)?.visualScale??1.08;
  }
  unitRenderRadius(u){
    const d=UnitDefinition.get(u?.type)||{};
    return Math.max(6.2,(d.size||10)*this.sc()*1.56*this.unitRenderVisualScale(u));
  }
  
  shouldUseVectorUnitArt(u){
    return !!window.RallyVectorAssets?.[u?.type];
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
    record={compiled:source,ground:point("ground")};this.vectorUnitAssetCache.set(key,record);return record;
  }
  // Poses every visible grain before any is drawn, so the context evaluates them in one pass
  // (budmori farm-renderer does the same). Entries arrive far to near; each grain's depth is its
  // world depth pulled nearer by its rank, so equal world depths still keep painter order.
  prepareGrainPoses(entries){
    this.grainActorFrame++;
    const now=this.presentationNow(performance.now());let rank=0;
    for(const {kind,entity:u,world,depth} of entries){
      if(kind!=="unit"||!this.shouldUseVectorUnitArt(u))continue;
      const record=this.grainUnitRecord(u.type);if(!record)continue;
      const grain=this.grainActor(u,record),actor=grain.actor,delta=this.renderTrackedDelta(u,"unit"),moving=Math.hypot(delta.x,delta.y)>.01;
      const clip=u.attackFlash>0?"fire":u.hitFlash>0?"hit":moving?"walk":"idle";
      if(actor.currentClip!==clip)actor.play(clip,0);
      actor.seek(now+(HashUtil.hash(u.id)%997)*7);
      actor.preparePose();
      // Budmori bodies are front-facing: no rotation, ground socket on the unit's ground point.
      const p=this.projectRenderWorldPosition(world),r=this.unitRenderRadius(u),scale=r*2.7/260*(UnitVisualDefinition.get(u.type)?.visualScale||1),m=grain.matrix;
      m[0]=scale;m[1]=0;m[2]=0;m[3]=scale;m[4]=p.x-scale*record.ground[0];m[5]=p.y+r*.55-scale*record.ground[1];
      grain.depth=RangeUtil.clamp(depth,-.98,.98)-(++rank)*GRAIN_DEPTH_RANK_STEP;
      grain.face=u.hitFlash>0?"hurt":u.attackFlash>0?"attack":"neutral";grain.bodyDrawn=false;
    }
    this.vectorContext.preparePoses();
  }
  // Opaque bodies go first, grouped by species, writing depth: the native path draws each species in one
  // instanced call and the depth buffer, not submission order, settles overlaps. Faces follow in painter order.
  drawGrainBodies(entries){
    if(!this.passState.depthEnabled)return;
    const C=this.vectorContext,groups=this.grainBodyGroups;
    for(const g of groups.values())g.length=0;
    for(const {kind,entity:u} of entries){
      if(kind!=="unit")continue;
      const grain=this.grainActors.get(u.id);
      if(!grain||grain.frame!==this.grainActorFrame||!this.grainBodyOpaque(grain))continue;
      let g=groups.get(grain.compiled);if(!g)groups.set(grain.compiled,g=[]);g.push(grain);
    }
    C.depthTest=true;C.depthWrite=true;C.depthFunc=this.passState.depthFunc||"lequal";
    for(const g of groups.values())for(const grain of g){
      C.depth=grain.depth;C.drawVectorActor(grain.actor,{matrix:grain.matrix});grain.bodyDrawn=true;
    }
    C.depth=0;C.depthTest=false;C.depthWrite=false;C.depthFunc="lequal";
  }
  grainBodyOpaque(grain){
    const expression=grain.actor.currentExpression,cache=this.grainOpaqueCoverage;
    let byExpression=cache.get(grain.compiled);if(!byExpression)cache.set(grain.compiled,byExpression=new Map());
    if(!byExpression.has(expression)){
      const geometry=grain.compiled.geometry;
      byExpression.set(expression,RallyGamekit.hasOpaqueCoverage(geometry,{indexVariant:geometry.expressionIndices?.[expression]?expression:null}));
    }
    return byExpression.get(expression);
  }
  // The painter-order part of a grain: its face, and its body too when that was not depth-batched.
  // The face sits just in front of its own body and behind every nearer grain. The depth policy stays set
  // until the world pass ends, since changing it closes the vector stream that batches every face.
  drawGrainUnit(u){
    const grain=this.grainActors.get(u.id);
    if(!grain||grain.frame!==this.grainActorFrame)throw new Error(`Grain ${u.id} was drawn without a prepared pose`);
    if(this.frame.length){this.flushVectorMesh("frame-to-vector-switch");this.flush(this.frame,true);this.begin()}
    const C=this.vectorContext;
    C.depthTest=!!this.passState.depthEnabled;C.depthWrite=false;C.depthFunc=this.passState.depthFunc||"lequal";
    C.depth=grain.depth;
    if(!grain.bodyDrawn)C.drawVectorActor(grain.actor,{matrix:grain.matrix});
    C.depth=grain.depth-GRAIN_DEPTH_RANK_STEP/2;
    // Budmori faces: shared eye/mouth/cheek atlas parts placed on this body's posed face sockets.
    this.grainFaces.draw(grain.compiled,grain.actor,grain.face,grain.matrix,1);
    this.vectorAssetDrawnInstances=(this.vectorAssetDrawnInstances||0)+1;
  }
  grainActor(u,record){
    let grain=this.grainActors.get(u.id);
    if(grain?.compiled!==record.compiled){
      grain?.actor.dispose();
      grain={actor:RallyGamekit.createVectorActor(this.vectorContext,record.compiled,{clip:"idle",startedAtMs:0}),compiled:record.compiled,
        ground:record.ground,matrix:new Float64Array(6),depth:0,face:"neutral",bodyDrawn:false,frame:0};
      this.grainActors.set(u.id,grain);
    }
    grain.frame=this.grainActorFrame;
    return grain;
  }
  // Releases actors of grains that were not drawn this frame (dead or out of sight).
  pruneGrainActors(){
    for(const [id,grain] of this.grainActors)if(grain.frame!==this.grainActorFrame){grain.actor.dispose();this.grainActors.delete(id)}
  }
  flushVectorMesh(reason){
    return this.vectorContext.active?this.vectorContext.flush(reason):undefined;
  }
  drawUnitSafely(u,renderOptions=null){
    try{return this.drawUnit(u,renderOptions)}
    catch(err){
      this.reportEntityRenderError("unit",u,err);
      try{
        const q=this.projectEntityScreen(u,"unit");
        this.circle(q.x,q.y,Math.max(4,this.unitRenderRadius(u)),u.side===this.mySide()?[.18,.43,.93,1]:[.72,.25,.22,1],10);
      }catch(fallbackErr){this.reportEntityRenderError("unit-fallback",u,fallbackErr)}
    }
  }
  reportEntityRenderError(kind,entity,err){
    this.entityRenderErrors??=new Set();
    const key=`${kind}:${entity?.type||"unknown"}:${String(err?.message||err)}`;
    if(this.entityRenderErrors.has(key))return;
    this.entityRenderErrors.add(key);
    console.error("[RALLY FRONTIER] entity render fallback",kind,entity?.type,err);
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
      entity:entity?{id:entity.id||null,type:entity.type||null,side:entity.side??null,x:entity.x??null,y:entity.y??null}:null,
      projectiles:s.projectiles?.length||0,units:s.units?.length||0,
      message:String(err?.message||err),stack:String(err?.stack||"")
    };
    DiagnosticPresentation.presentFatalDiagnostic(diag);
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
    if(!renderOptions?.visibilityChecked&&!own&&!this.visibleRaw(u.x,u.y,false))return;
    // Health/status bars are drawn by drawWorldHudOverlay(), never in the unit pass.
    this.drawGrainUnit(u);
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
    // Direction is sampled after interpolation/camera projection/z-height, but before
    // transient hit/camera shake.
    projectileCtx.screenMotion=this.projectileScreenMotion(p,stablePp.x,stablePp.y);
    PROJECTILE_VISUAL_RENDER_FNS.launchAmmo(this,projectileCtx);
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

    // 상대 메인 베이스: 위치/존재는 항상 알지만, 시야 밖에서는
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
  renderGroundPass(){
    this.renderStage="ground";this.renderEntity=null;
    const gl=this.gl;this.passState.depthWrite=true;
    this.setRenderDepth(.97);this.begin();this.drawGround();this.flush();
    this.passState.depthWrite=false;
    this.begin();TerrainPresentation.drawSurfaceEdges(this);
    this.setRenderDepth(.969);this.drawStrategicMap();
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
    const entries=this.prepareWorldSpriteFrame(visibleUnits);this.prepareGrainPoses(entries);this.drawGrainBodies(entries);
    for(const entry of entries){
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
        else this.drawProjectileSafely(entity);
      });
    }
    this.flushVectorMesh("world-pass-end");this.pruneGrainActors();
    const C=this.vectorContext;C.depth=0;C.depthTest=false;C.depthWrite=false;C.depthFunc="lequal";
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
    this.drawFogLandmarks();this.flush();
    this.begin();this.drawLaunchOverlay();this.flush();
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
        this.cameraShakePresentationMoved=false;
      }
      return;
    }
    const rect=this.canvas.getBoundingClientRect(),cssX=sx*rect.width/w,cssY=sy*rect.height/h;
    if(this.fxCanvas)this.fxCanvas.style.transform=`translate(${cssX}px,${cssY}px)`;
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
    rp.vectorTerrainOcclusionTests=this.vectorTerrainOcclusionTests;rp.vectorTerrainOcclusionRegions=this.vectorTerrainOcclusionRegions;rp.vectorTerrainOcclusionTriangles=this.vectorTerrainOcclusionTriangles;
    rp.vectorAssetGeometryBytes=vectorStats.geometryBytesUploaded;rp.vectorAssetInstanceBytes=vectorStats.instanceBytesUploaded;rp.vectorAssetRetainedBytes=vectorStats.retainedBytes;rp.vectorAssetMeshes=vectorStats.meshCount;
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

    const now=performance.now();
    for(const m of LaunchPresentation.marks){
      const p=this.point(m.x,m.y),age=RangeUtil.clamp((now-m.at)/LaunchRules.landingMarkMs,0,1);
      c.strokeStyle=`rgba(255,228,128,${1-age})`;c.lineWidth=2;c.beginPath();c.arc(p[0],p[1],4+8*age,0,Math.PI*2);c.stroke();
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

    // 유닛: 아군은 항상, 적은 실제 시야 안에서만.
    for(const u of s.units){
      if(!u.alive)continue;
      const own=r.isFriendlySide(u.side);
      if(!own&&!r.visibleRaw(u.x,u.y))continue;
      const p=this.point(u.x,u.y);
      this.dot(p[0],p[1],1.55,own?"#64a1ff":"#ff6666");
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

  captureChime(g=.6){
    this.tone({freq:330,endFreq:440,type:"sine",gain:.06*g,duration:.16});
    this.tone({freq:440,endFreq:660,type:"sine",gain:.055*g,duration:.18,when:.09});
    this.tone({freq:660,endFreq:880,type:"triangle",gain:.045*g,duration:.22,when:.18});
  }

  buildingCollapse(g=.7){
    this.noise({gain:.20*g,duration:.35,lowpass:1000});
    this.tone({freq:74,endFreq:32,type:"sine",gain:.25*g,duration:.38});
    this.noise({gain:.08*g,duration:.22,highpass:1200,lowpass:3200,when:.08});
  }

  playHitForType(sourceType,gain){
    const d=UnitDefinition.get(sourceType)||BuildingDefinition.get(sourceType)||{};
    if((d.splash||0)>=80)this.explosion(gain,true);
    else this.fleshHit(gain*.78);
  }

  playEvent(e,renderer){
    if(!e||!this.enabled||!this.unlocked)return;
    const gain=this.spatialGain(e.x??renderer.world.center.x,e.y??renderer.world.center.y,renderer);
    if(gain<=0)return;
    if(e.type==="captureComplete")this.captureChime(Math.max(.45,gain));
    else if(e.type==="buildingDeath")this.buildingCollapse(gain);
    else if(e.type==="death")this.death(gain);
    else if(e.type==="hit")this.playHitForType(e.sourceType||"",gain);
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
class UiRegistry{static refs={p2pHealth:DomUtil.byId("p2pHealth"),p2pHealthText:DomUtil.byId("p2pHealthText"),lobby:DomUtil.byId("lobby"),game:DomUtil.byId("gameScreen"),createDialog:DomUtil.byId("createDialog"),joinDialog:DomUtil.byId("joinDialog"),createClose:DomUtil.byId("createCloseBtn"),joinClose:DomUtil.byId("joinCloseBtn"),createStatus:DomUtil.byId("createStatus"),createRetry:DomUtil.byId("createRetryBtn"),joinConfirm:DomUtil.byId("joinConfirmBtn"),room:DomUtil.byId("roomInput"),codeArea:DomUtil.byId("hostCodeArea"),code:DomUtil.byId("hostCode"),joinError:DomUtil.byId("joinError"),canvas:DomUtil.byId("glCanvas"),minimapCanvas:DomUtil.byId("minimapCanvas"),result:DomUtil.byId("result"),resultTitle:DomUtil.byId("resultTitle"),resultText:DomUtil.byId("resultText"),rematch:DomUtil.byId("rematchBtn")}}


UiRegistry.refs.lockstepDebugPanel=DomUtil.byId("lockstepDebugPanel");
UiRegistry.refs.lockstepDebugCloseBtn=DomUtil.byId("lockstepDebugCloseBtn");
UiRegistry.refs.manualRecoveryBtn=DomUtil.byId("manualRecoveryBtn");
UiRegistry.refs.fullConnectionResetBtn=DomUtil.byId("fullConnectionResetBtn");
UiRegistry.refs.lockstepDebugResetBtn=DomUtil.byId("lockstepDebugResetBtn");
UiRegistry.refs.recoveryLogExportBtn=DomUtil.byId("recoveryLogExportBtn");
UiRegistry.refs.balanceTelemetryExportBtn=DomUtil.byId("balanceTelemetryExportBtn");UiRegistry.refs.lockstepDebugSummary=DomUtil.byId("lockstepDebugSummary");
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
UiRegistry.refs.dbgEndurancePeaks=DomUtil.byId("dbgEndurancePeaks");
UiRegistry.refs.dbgBalanceTime=DomUtil.byId("dbgBalanceTime");UiRegistry.refs.dbgBalanceCombat=DomUtil.byId("dbgBalanceCombat");UiRegistry.refs.dbgBalanceCapture=DomUtil.byId("dbgBalanceCapture");
UiRegistry.refs.dbgBalanceArmy=DomUtil.byId("dbgBalanceArmy");UiRegistry.refs.dbgBalanceLosses=DomUtil.byId("dbgBalanceLosses");

UiRegistry.refs.gameStartBtn=DomUtil.byId("gameStartBtn");
UiRegistry.refs.singleStatus=DomUtil.byId("singleStatus");

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

UiRegistry.refs.replayOpenBtn=DomUtil.byId("replayOpenBtn");UiRegistry.refs.replayFileInput=DomUtil.byId("replayFileInput");UiRegistry.refs.replayWatchBtn=DomUtil.byId("replayWatchBtn");UiRegistry.refs.replaySaveBtn=DomUtil.byId("replaySaveBtn");
UiRegistry.refs.replayDock=DomUtil.byId("replayDock");UiRegistry.refs.replayPlayPauseBtn=DomUtil.byId("replayPlayPauseBtn");UiRegistry.refs.replayStepBackBtn=DomUtil.byId("replayStepBackBtn");UiRegistry.refs.replayStepForwardBtn=DomUtil.byId("replayStepForwardBtn");UiRegistry.refs.replayStepBack30Btn=DomUtil.byId("replayStepBack30Btn");UiRegistry.refs.replayStepForward30Btn=DomUtil.byId("replayStepForward30Btn");UiRegistry.refs.replayTimeline=DomUtil.byId("replayTimeline");UiRegistry.refs.replayTime=DomUtil.byId("replayTime");UiRegistry.refs.replayTimeInput=DomUtil.byId("replayTimeInput");UiRegistry.refs.replayTimeGoBtn=DomUtil.byId("replayTimeGoBtn");UiRegistry.refs.replaySpeed=DomUtil.byId("replaySpeed");UiRegistry.refs.replayExitBtn=DomUtil.byId("replayExitBtn");
UiRegistry.refs.replayHostViewBtn=DomUtil.byId("replayHostViewBtn");UiRegistry.refs.replayGuestViewBtn=DomUtil.byId("replayGuestViewBtn");UiRegistry.refs.replayAllViewBtn=DomUtil.byId("replayAllViewBtn");UiRegistry.refs.replayHostOrientationBtn=DomUtil.byId("replayHostOrientationBtn");UiRegistry.refs.replayGuestOrientationBtn=DomUtil.byId("replayGuestOrientationBtn");UiRegistry.refs.replayZoomOutBtn=DomUtil.byId("replayZoomOutBtn");UiRegistry.refs.replayZoomInBtn=DomUtil.byId("replayZoomInBtn");UiRegistry.refs.replayZoomValue=DomUtil.byId("replayZoomValue");UiRegistry.refs.replayStats=DomUtil.byId("replayStats");
UiRegistry.refs.matchMenuBtnGame=DomUtil.byId("matchMenuBtnGame");UiRegistry.refs.matchMenuModal=DomUtil.byId("matchMenuModal");UiRegistry.refs.matchMenuBackdrop=DomUtil.byId("matchMenuBackdrop");UiRegistry.refs.matchMenuCloseBtn=DomUtil.byId("matchMenuCloseBtn");UiRegistry.refs.matchMenuContinueBtn=DomUtil.byId("matchMenuContinueBtn");UiRegistry.refs.matchMenuReplaySaveBtn=DomUtil.byId("matchMenuReplaySaveBtn");UiRegistry.refs.matchMenuHelpBtn=DomUtil.byId("matchMenuHelpBtn");UiRegistry.refs.matchMenuSurrenderBtn=DomUtil.byId("matchMenuSurrenderBtn");UiRegistry.refs.matchMenuLeaveBtn=DomUtil.byId("matchMenuLeaveBtn");UiRegistry.refs.matchMenuWarning=DomUtil.byId("matchMenuWarning");
UiRegistry.refs.disconnectGate=DomUtil.byId("disconnectGate");UiRegistry.refs.disconnectGateTitle=DomUtil.byId("disconnectGateTitle");UiRegistry.refs.disconnectGateCount=DomUtil.byId("disconnectGateCount");UiRegistry.refs.disconnectGateCopy=DomUtil.byId("disconnectGateCopy");UiRegistry.refs.disconnectGateActions=DomUtil.byId("disconnectGateActions");UiRegistry.refs.disconnectReconnectBtn=DomUtil.byId("disconnectReconnectBtn");UiRegistry.refs.disconnectSurrenderBtn=DomUtil.byId("disconnectSurrenderBtn");


UiRegistry.refs.launchHand=DomUtil.byId("launchHand");UiRegistry.refs.launchCards=DomUtil.byId("launchCards");
UiRegistry.refs.launchEnergyFill=DomUtil.byId("launchEnergyFill");UiRegistry.refs.launchEnergyText=DomUtil.byId("launchEnergyText");
UiRegistry.refs.launchCards?.addEventListener("click",e=>{const b=e.target.closest("[data-launch-card]");if(b)LaunchPresentation.selectCard(b.dataset.launchCard)});

const UI_RADIO=Object.freeze({
  screen:new Set(["lobby","game","replay","result"]),
  modal:new Set(["none","create","join","match-menu","disconnect"]),
  command:new Set(["closed","tree","building"])
});
// UI STATE CONTRACT:
// Radio: screen/modal/command.branch; Tree: command category/page + modalState phases;
// Checkbox: only independent options. DOM classes are derived output, never app-state input.
// Async/transient gesture/network booleans may remain local when simultaneous truth is valid.
class UiRuntimeState{static value={screen:"lobby",modal:"none",modalState:{disconnect:"hidden"},options:{minimapExpanded:false,lockstepDebugOpen:false},settings:{presetId:"standard",simulationTps:10}}}

/* DOM write ownership contract:
   UiController is the sole generic visibility/screen/modal writer.
   Domain Presentation owners write their own content and domain-local visual state only.
   CSS owns layout/appearance, never application visibility; component display rules must
   not override the shared hidden state. */
class UiController{
  static setElementVisible(ref,visible){
  if(!ref)return false;
  ref.classList.toggle("hidden",!visible);
  return !!visible;
}
  static setUiRadio(group,value){const allowed=UI_RADIO[group];if(!allowed?.has(value))throw new Error(`Invalid UI ${group}: ${value}`);UiRuntimeState.value[group]=value;return value}
  static setUiScreen(value){UiController.setUiRadio("screen",value);UiController.renderUiState();LaunchScreens.syncScreen(value);return value}
  static setUiModal(value){
  const prev=UiRuntimeState.value.modal;UiController.setUiRadio("modal",value);
  if(prev==="disconnect"&&value!=="disconnect")UiRuntimeState.value.modalState.disconnect="hidden";
  return value;
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
  UiRegistry.refs.lockstepDebugPanel?.classList.toggle("hidden",!UiRuntimeState.value.options.lockstepDebugOpen);
  UiRegistry.refs.p2pHealth?.setAttribute("aria-expanded",UiRuntimeState.value.options.lockstepDebugOpen?"true":"false");
}
  static viewToAuth(x,y){
  return ActiveViewState.role==="guest"
    ? {x:(ActiveViewState.renderer?.world||WorldContext.standard).width-x,y:(ActiveViewState.renderer?.world||WorldContext.standard).height-y}
    : {x,y};
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
    LogUtil.status(message);
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
    LogUtil.log(message);
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
  UiRegistry.refs.dbgPerfCore.textContent=`${fmtMs(perf.indexMs)} / ${fmtMs(perf.worldMs)}`;
  UiRegistry.refs.dbgPerfCombat.textContent=`${fmtMs(perf.visionMs)} / ${fmtMs(perf.combatMs)}`;
  UiRegistry.refs.dbgPerfTail.textContent=`${fmtMs(perf.projectileMs)} / ${fmtMs(perf.collisionMs)} / ${fmtMs(perf.postMs)}`;
  UiRegistry.refs.dbgPerfSnapshot.textContent=perf.snapshotSamples?`${fmtMs(perf.snapshotMs)} / ${fmtMs(perf.maxSnapshotMs)}`:'표본 수집 중';
  UiRegistry.refs.dbgPerfEntities.textContent=`${perf.aliveUnits||0} / ${perf.combatUnits||0} / ${perf.projectiles||0}`;
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
  const avgArmy=[0,1].map(side=>bs.samples?bs.armyTotal[side]/bs.samples:0);
  UiRegistry.refs.dbgBalanceTime.textContent=`${formatTickTime(active.sim?.tick)} / ${bs.gameEndTick==null?"진행 중":`${formatTickTime(bs.gameEndTick)} · ${bs.winner||"-"}`}`;
  UiRegistry.refs.dbgBalanceCombat.textContent=formatTickTime(bs.firstCombatTick);
  UiRegistry.refs.dbgBalanceCapture.textContent=pairTicks(bs.firstCaptureTick);
  UiRegistry.refs.dbgBalanceArmy.textContent=`${bs.currentArmy[0]}/${avgArmy[0].toFixed(1)}/${bs.armyPeak[0]} · ${bs.currentArmy[1]}/${avgArmy[1].toFixed(1)}/${bs.armyPeak[1]}`;
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
  const active=ActiveViewState.session;
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
    const army=(snapshot.units||[]).filter(u=>u.alive&&u.side===side).length;
    const buildings=(snapshot.buildings||[]).filter(b=>b.alive!==false&&b.side===side).length;
    const captures=(snapshot.capturePoints||[]).filter(cp=>cp.owner===side).length;
    return `<div class="replay-side-card ${side===0?"host":"guest"}"><div class="replay-side-name">${side===0?"HOST":"GUEST"}</div><div class="replay-side-line"><span>◆ 자원</span><b>${Math.floor(snapshot.wallet?.[side]||0)}</b></div><div class="replay-side-line"><span>⚔ 병력</span><b>${army}</b></div><div class="replay-side-line"><span>⌂ 건물 · 거점</span><b>${buildings} · ${captures}</b></div></div>`;
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
  ActiveViewState.renderer.selectedBuildingId=null;
  ActiveViewState.renderer.setSnapshot(s,{liveTargets:false});ActiveViewState.minimap?.set(ActiveViewState.renderer,s);
  audioSystem.processSnapshot(s,ActiveViewState.renderer);
  UiRegistry.refs.replayDock?.classList.remove("hidden");UiRegistry.refs.replayStats?.classList.remove("hidden");
  if(UiRegistry.refs.replayStats)UiRegistry.refs.replayStats.innerHTML=ReplayPresentation.replayStatsHtml(s,ReplayPresentation.replayPlayer.sim);
  LogUtil.status("리플레이 · 네트워크 시뮬레이션 없음");
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
  MatchLifecycle.disposeMatches("replay-start");
  ReplayPresentation.replayPlayer?.stop();
  ReplayPresentation.replayLoadedData=loadedData;
  ReplayPresentation.replayPlayer=player;
  if(ActiveViewState.renderer){
  }
  UiController.closeUiModal("create");UiController.closeUiModal("join");
  
  ReplayPresentation.renderReplaySnapshot(snapshot);
  ReplayPresentation.applyReplayPerspective();ReplayPresentation.syncReplayControls();
  ReplayPresentation.replayPlayer.start();
  LogUtil.log(`▶ 리플레이 시작 · ${ReplayPresentation.formatReplayTime(ReplayPresentation.replayPlayer.endTick)} · 명령 ${data.commands.length}개`);
  return true;
}
  static stopReplay(){
  ReplayPresentation.replayPlayer?.stop();ReplayPresentation.replayPlayer=null;ReplayPresentation.replayLoadedData=null;
  UiController.setUiScreen("lobby");
  location.reload();
}
}

// The game screen has no log or status line; the last messages stay readable from the console for diagnostics.
class LogUtil{
  static last="";static lastStatus="";
  static log(t){LogUtil.last=String(t)}
  static status(t){LogUtil.lastStatus=String(t)}
}
class RoomCodeUtil{static randomCode(){return String(Math.floor(Math.random()*10000)).padStart(4,"0")}}
class SinglePlayerModeUtil{static isSinglePlayer(){return !!MatchLifecycle.singleMatch}}



class MatchLifecycle{
  static singleMatch=null;

  static activeSession(){return ReplayPresentation.replayPlayer||ActiveViewState.session}
  static currentMatchConfig(){
  return {presetId:UiRuntimeState.value.settings.presetId,simulationTps:UiRuntimeState.value.settings.simulationTps};
}
  static wireSessionForView(r,sess,trans){
  sess.onDraft=state=>{sess.draft=state};
  sess.onSnapshot=state=>{
    if(ActiveViewState.role===r)BattlePresentation.renderGame(state);
  };
  sess.onRenderTargets=(sim,snapNow=false)=>{
    if(ActiveViewState.role===r&&ActiveViewState.renderer)ActiveViewState.renderer.updatePresentationTargets(sim,!!snapNow);
  };
  sess.onLog=text=>{if(ActiveViewState.role===r)LogUtil.log(text)};
  sess.onNetworkHealth=info=>{
    if(ActiveViewState.role!==r)return;
    ConnectionPresentation.renderP2PHealth(info,false);

    if(info?.state==="fatal"){
      const fatal=info.simulationFatalInfo||{};
      LogUtil.status("시뮬레이션 오류로 일시 중단됨");
      if(SinglePlayerModeUtil.isSinglePlayer()){
        UiRegistry.refs.singleStatus.textContent="시뮬레이션 오류 · 안전을 위해 경기를 중단했습니다.";
        UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
      }
      LogUtil.log(`⚠ 시뮬레이션 오류 · ${(fatal.role||r).toUpperCase()} tick ${fatal.localTick??fatal.tick??"-"} · ${fatal.message||"unknown"}`);
      return;
    }


    if(
      info?.state==="connected" &&
      sess.sim &&
      !sess.syncHold &&
      sess.recoveryPhase==="idle"
    ){
      LogUtil.status(SinglePlayerModeUtil.isSinglePlayer()
        ?"싱글 · 공통 코어 재연결 완료 · 게임 재개"
        :"공통 코어 재연결 완료 · 연결됨");

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
      LogUtil.status("싱글 · AI WebRTC 연결 준비");
      UiRegistry.refs.singleStatus.textContent="AI용 WebRTC 피어를 연결하고 있습니다…";
      UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
    }else{
      LogUtil.status("방 "+ActiveViewState.roomCode+" · 상대 대기");
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

      LogUtil.status(SinglePlayerModeUtil.isSinglePlayer()
          ?recovering
            ?"싱글 · 새 DataChannel 연결됨 · 공통 코어 입력 동기화 중"
            :`싱글 · ${r.toUpperCase()} 테스트 · AI ${(MatchLifecycle.singleMatch?.botRole||"guest").toUpperCase()} 연결됨`
          :recovering
            ?"새 DataChannel 연결됨 · 공통 코어 입력 동기화 중"
            :"연결됨 · "+ActiveViewState.roomCode);

      UiController.closeUiModal("create");
      UiController.closeUiModal("join");

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
      LogUtil.status("연결 오류");
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
      LogUtil.status(SinglePlayerModeUtil.isSinglePlayer()
        ?"싱글 · 연결 끊김 · 게임 정지 · 복구 버튼 필요"
        :"P2P 연결 끊김 · 게임 정지 · 복구 버튼 필요");

      if(SinglePlayerModeUtil.isSinglePlayer()){
        UiRegistry.refs.singleStatus.textContent="연결이 끊겼습니다 · 복구 버튼으로 Host 권위 스냅샷을 기준으로 새 연결을 만드세요.";
        UiController.setElementVisible(UiRegistry.refs.singleStatus,true);
      }
    }
  };
}
  static disposeMatches(reason="mode-change"){
    const sessions=new Set([ActiveViewState.session,...Object.values(this.singleMatch?.sessions||{})].filter(Boolean));
    this.singleMatch?.bot?.stop();
    const errors=[];
    for(const session of sessions){try{session.dispose(reason)}catch(error){errors.push(error)}}
    this.singleMatch=null;
    ActiveViewState.session=null;ActiveViewState.transport=null;ActiveViewState.snap=null;
    if(errors.length)throw new AggregateError(errors,"세션 종료 처리 중 오류가 발생했습니다.");
  }
  static connect(r,c){
  MatchLifecycle.disposeMatches("online-start");
  MatchLifecycle.singleMatch=null;
  ConnectionPresentation.hideP2PHealth();
  ActiveViewState.role=r;ActiveViewState.roomCode=c;
  LogUtil.status("연결 중…");
  ActiveViewState.transport=new NostrRtcTransport(r,c);
  ActiveViewState.session=new GameSession(r,ActiveViewState.transport,c,r==="host"?MatchLifecycle.currentMatchConfig():null);
  MatchLifecycle.wireSessionForView(r,ActiveViewState.session,ActiveViewState.transport);
  ActiveViewState.transport.open();
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

  ConnectionPresentation.hideP2PHealth();
  NetworkModuleLoader.pendingPeerAction=null;
  UiController.closeUiModal("create");
  UiController.closeUiModal("join");

  const token=MatchLifecycle.singleRoomToken();
  ActiveViewState.roomCode=token;
  ActiveViewState.role=humanRole;

  ActiveViewState.snap=null;

  UiController.setUiScreen("lobby");
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
  if(SinglePlayerModeUtil.isSinglePlayer()){
    return Object.values(MatchLifecycle.singleMatch.sessions||{});
  }
  return ActiveViewState.session?[ActiveViewState.session]:[];
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
      LogUtil.status("백그라운드 전환 · 연결 이상 시 복구 버튼 사용");
    }
    return;
  }

  AppLifecycle.requestScreenWakeLock();
  AppLifecycle.pageHiddenAtWall=0;
  AppLifecycle.pulseBackgroundSessions(performance.now());

  const active=RecoveryTelemetry.localRecoverySession();
  if(active?.simpleRecoveryNeedsManual||active?.recoveryPhase==="needs-manual"){
    LogUtil.status(SinglePlayerModeUtil.isSinglePlayer()
      ?"싱글 연결 복구 필요 · 복구 버튼을 눌러주세요"
      :"P2P 연결 복구 필요 · 복구 버튼을 눌러주세요");
  }else if(ActiveViewState.session?.sim){
    LogUtil.status(SinglePlayerModeUtil.isSinglePlayer()
      ?"싱글 · 게임 계속"
      :"연결됨 · 게임 계속");
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

// Shows which deployed build is running: title stamp, boot card and the document metadata.
class BuildMetadataPresentation{
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



// 발사전 화면: 카드 패, 자원 게이지, 착탄 흔적. 착탄 예정 지점은 절대 그리지 않는다.
class LaunchPresentation{
  static card=null;static deckKey="";static lastPower=null;static marks=[];static pods=new Map();static hold=null;
  static active(s=ActiveViewState.snap){return !!s&&!ReplayPresentation.replayPlayer}
  static reset(){this.card=null;this.deckKey="";this.lastPower=null;this.marks=[];this.pods=new Map();this.hold=null}
  static render(s,side){
    const on=!!s;document.body.classList.toggle("launch-mode",on);
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
  // The battlefield takes one gesture: a still press charges a launch, a drag pans the camera. Replay only pans.
  static setupCanvas(){
  const armLaunchHold=()=>{
    const drag=ActiveViewState.drag;
    drag.launchTimer=setTimeout(()=>{
      drag.launchTimer=0;
      if(ActiveViewState.drag!==drag||drag.moved||!ActiveViewState.renderer)return;
      const [vx,vy]=ActiveViewState.renderer.pxToWorld(drag.lastX,drag.lastY);
      drag.launchHold=LaunchPresentation.begin(UiController.viewToAuth(vx,vy),drag.id);
    },LAUNCH_HOLD_ARM_MS);
  };
  const cancelLaunchHold=()=>{
    const drag=ActiveViewState.drag;if(drag?.launchTimer){clearTimeout(drag.launchTimer);drag.launchTimer=0}
    if(drag)drag.launchHold=null;LaunchPresentation.cancel();
  };

  const pointerDown=e=>{
    if(ActiveViewState.drag&&ActiveViewState.drag.id!==e.pointerId)return;
    if(ActiveViewState.drag)cancelLaunchHold();
    audioSystem.unlock();
    e.preventDefault();
    if(!ActiveViewState.renderer)return;
    ActiveViewState.drag={id:e.pointerId,x:e.clientX,y:e.clientY,lastX:e.clientX,lastY:e.clientY,
      left:ActiveViewState.renderer.cameraLeft,top:ActiveViewState.renderer.cameraTop,moved:false};
    if(LaunchPresentation.active())armLaunchHold();
  };

  const pointerMove=e=>{
    const drag=ActiveViewState.drag,r=ActiveViewState.renderer;
    if(!r||!drag||drag.id!==e.pointerId)return;
    e.preventDefault();
    if(drag.launchHold){
      const [vx,vy]=r.pxToWorld(e.clientX,e.clientY);LaunchPresentation.aim(UiController.viewToAuth(vx,vy));
    }else{
      if(!drag.moved&&Math.hypot(e.clientX-drag.x,e.clientY-drag.y)>LAUNCH_HOLD_DRAG_PX){drag.moved=true;cancelLaunchHold()}
      if(drag.moved){
        const rect=UiRegistry.refs.canvas.getBoundingClientRect(),
          dx=(e.clientX-drag.x)*UiRegistry.refs.canvas.width/rect.width,
          dy=(e.clientY-drag.y)*UiRegistry.refs.canvas.height/rect.height,
          scale=r.sc();
        r.cameraLeft=RangeUtil.clamp(drag.left-dx/scale,0,Math.max(0,(r.world||WorldContext.standard).width-r.viewWorldW()));
        r.cameraTop=r.clampCameraTop(drag.top-dy/scale);
      }
    }
    drag.lastX=e.clientX;drag.lastY=e.clientY;
  };

  const pointerCancel=e=>{
    if(ActiveViewState.drag?.id!==e.pointerId)return;
    cancelLaunchHold();ActiveViewState.drag=null;
  };

  const pointerUp=e=>{
    const drag=ActiveViewState.drag;
    if(!drag||drag.id!==e.pointerId)return;
    e.preventDefault();
    ActiveViewState.drag=null;
    if(drag.launchTimer)clearTimeout(drag.launchTimer);
    if(drag.launchHold&&ActiveViewState.renderer){
      const [vx,vy]=ActiveViewState.renderer.pxToWorld(e.clientX,e.clientY);
      LaunchPresentation.release(UiController.viewToAuth(vx,vy));
    }
  };

  RallyGamekit.createDOMInput({target:UiRegistry.refs.canvas,
    pointerButtons:{0:'battlefield'},touchAction:'none',
    onPointer:point=>{
      const event=point.originalEvent||point;
      // Points on a hidden battlefield cannot aim: a press there is ignored and a release cancels the hold.
      if(point.type!=='cancel'&&ActiveViewState.renderer&&!ActiveViewState.renderer.hasDisplayArea()){
        if(point.type==='up')pointerCancel(event);
        return;
      }
      if(point.type==='down')pointerDown(event);
      else if(point.type==='move')pointerMove(event);
      else if(point.type==='up')pointerUp(event);
      else pointerCancel(event);
    },onRelease:()=>{cancelLaunchHold();ActiveViewState.drag=null}
  });
}

  static renderGame(s){
  // An already queued snapshot must never switch Result back to Game.
  if(UiRuntimeState.value.screen==="result")return;
  const side=ConnectionSideUtil.roleSide(ActiveViewState.role);
  if(!MatchLifecycle.activeSession()?.sim){
    DiagnosticPresentation.presentFatalDiagnostic({
      kind:"RALLY_FRONTIER_PRESENTATION_CONTRACT_FATAL",
      build:BUILD_META.id,buildMetadata:BUILD_META.snapshot(),at:new Date().toISOString(),source:"BattlePresentation.renderGame",
      role:ActiveViewState.role,tick:Number(s?.tick)||0,
      message:"Live snapshot reached game presentation without an active simulation."
    });
    return;
  }
  UiController.setUiScreen("game");
  UiController.closeUiModal("create");UiController.closeUiModal("join");
  ActiveViewState.snap=s;
  requestAnimationFrame(()=>ConnectionPresentation.positionP2PHealthNextToMenu());

  const rendererRoleChanged=!!ActiveViewState.renderer&&ActiveViewState.renderer.role!==ActiveViewState.role;
  if(!ActiveViewState.renderer){
    ActiveViewState.renderer=new GLRenderer(UiRegistry.refs.canvas);
    LogUtil.log(`렌더러 ${ActiveViewState.renderer.backend} · 입력/UI ${STATE_PUBLISH_HZ}Hz · Render Target ${SimulationTiming.tps()}Hz · 시뮬 ${SimulationTiming.tps()}TPS · 렌더 rAF 60Hz+`);
    ActiveViewState.renderer.cameraLeft=0;
    ActiveViewState.renderer.cameraTop=(ActiveViewState.renderer?.world||WorldContext.standard).height-VIEW_H;
  }
  ActiveViewState.renderer.role=ActiveViewState.role;
  // Live gameplay owns its faction strictly from role. Replay-only fields must never
  // leak into host/guest colors, FoW ownership or minimap ownership.
  ActiveViewState.renderer.replayPerspectiveSide=null;
  ActiveViewState.renderer.replayOrientationRole=null;
  ActiveViewState.renderer.replayVisionMode=null;
  ActiveViewState.renderer.replayObserverAll=false;
  if(!ActiveViewState.minimap)ActiveViewState.minimap=new MiniMap(UiRegistry.refs.minimapCanvas);
  ActiveViewState.renderer.setSnapshot(s,{liveTargets:true,snapTargets:rendererRoleChanged});
  ActiveViewState.minimap.set(ActiveViewState.renderer,s);
  ActiveViewState.minimap.draw();
  audioSystem.processSnapshot(s,ActiveViewState.renderer);
  LaunchPresentation.render(s,side);
}
}




const UI_MODAL_DIALOG_KEYS=Object.freeze({create:"createDialog",join:"joinDialog"});

class SimulationTiming{
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
/*
 * 게임 입력 계약
 * 1) 일반 UI 선택/버튼은 click 확정 후 처리한다. 스크롤 시작(pointerdown)은 선택이 아니다.
 * 2) 동적 버튼은 안정적인 부모에 click 이벤트를 위임한다.
 * 3) 동적 TPS 시뮬레이션 렌더는 동일한 인터랙티브 DOM을 재생성하지 않는다.
 * 4) Guest 권위 입력은 proposal → Host commit → ACK/수렴 경로만 사용한다.
 */

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
  }catch(error){
    LogUtil.log(`⚠ 리플레이 시간 이동 실패 · ${error.message||error}`);
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

BuildMetadataPresentation.renderBuildMetadata();
void BUILD_META.load().then(()=>BuildMetadataPresentation.renderBuildMetadata());

if(UiRegistry.refs.bootRetryBtn)UiController.bindImmediateButton(UiRegistry.refs.bootRetryBtn,AppLifecycle.runBootAndStartApp);
// The Worker realm hosts only a simulation session; the page boots the app.
if(SIM_WORKER)SimWorkerHost.install();
else{
  AppLifecycle.runBootAndStartApp();
  const dev=readDevQuery(location.search);
  if(dev.tps)UiController.setStartSimulationTps(dev.tps);
  if(dev.netcode)UiController.setStartNetcodeMode(dev.netcode);
  const leaveSetup=()=>{audioSystem.unlock()};
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
}

export { AppLifecycle, ConnectionPresentation, DiagnosticPresentation, LogUtil, MatchLifecycle, ReplayPresentation, SimulationTiming, SinglePlayerModeUtil, UiController, UiRegistry };
