// Entity state contracts and components.
import { RangeUtil } from '../core/game-rules.js';
import { ObjectiveMixin } from './unit-mixins.js';
import { RallyStateCodec } from '../session/game-session.js';
import { HashUtil } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { SPAWN_UNIT_GAP, SUMMON_SPAWN_ACTION_GRACE_MS } from '../definitions/combat-rules.js';
import { COLLISION_RADIUS_SCALE, DIVE_BACKLINE_ROLES, ROGUE_BACKLINE_ROLES, ROGUE_BLINK_COOLDOWN_MS, ROGUE_BLINK_RANGE, ROGUE_LEAP_ARC_HEIGHT, ROGUE_LEAP_DURATION_MS, SPORELING_LEAP_ROLES } from '../definitions/world-rules.js';
import { NavigationGoal, TerrainNavigation } from './navigation.js';
import { FP } from '../core/config.js';
import { SimulationTiming } from '../main.js';

/* =========================
   3. Deterministic strategy simulation
   ========================= */

// State owners declare defaults and classify non-authoritative fields once.
// Extra fields in trusted campaign state remain serializable AND hash-visible;
// only explicitly declared presentation/derived fields are excluded.
class StateValue{
  static freeze(value){
    if(!value||typeof value!=="object"||Object.isFrozen(value))return value;
    for(const v of Object.values(value))this.freeze(v);return Object.freeze(value);
  }
  static numberBits=new DataView(new ArrayBuffer(8));
  static copy(value){
    if(value===null||typeof value!=="object")return value;
    if(Array.isArray(value))return value.map(v=>this.copy(v));
    if(ArrayBuffer.isView(value))return new value.constructor(value);
    if(value instanceof ArrayBuffer)return value.slice(0);
    if(value instanceof Date)return new Date(value);
    const out={};for(const key of Object.keys(value))if(typeof value[key]!=="function")out[key]=this.copy(value[key]);return out;
  }
  static hash(h,value){
    if(value===null){h.m(0);return}
    switch(typeof value){
      case "undefined":h.m(1);return;
      case "boolean":h.m(2);h.m(value?1:0);return;
      case "number":h.m(3);if(Number.isNaN(value)){h.m(0x7ff80000);return}this.numberBits.setFloat64(0,value===0?0:value,true);h.m(this.numberBits.getUint32(0,true));h.m(this.numberBits.getUint32(4,true));return;
      case "string":h.m(4);h.m(value.length);h.ms(value);return;
      case "bigint":h.m(5);h.ms(value.toString());return;
      case "function":throw new Error("A function is not simulation state");
    }
    if(Array.isArray(value)||ArrayBuffer.isView(value)){h.m(6);h.m(value.length);for(const v of value)this.hash(h,v);return}
    h.m(7);const keys=Object.keys(value).filter(k=>typeof value[k]!=="function").sort();h.m(keys.length);
    for(const key of keys){h.ms(key);this.hash(h,value[key])}
  }
}
class StateContract{
  // mode "save" is the canonical sorted state; "snapshot" adds presentation fields;
  // "view" is what UI/renderer/bot read. A contract with a view list copies only
  // those keys there, so view snapshots skip simulation-only internals.
  constructor(defaults={}, {presentation=[],derived=[],children={},view=null}={}){
    this.defaults=Object.freeze(defaults);this.presentation=new Set(presentation);this.derived=new Set(derived);this.children=children;this.view=view&&Object.freeze([...view]);
  }
  create(state={}){
    const out=StateValue.copy(this.defaults);
    for(const key of Object.keys(state||{}))if(!this.derived.has(key))out[key]=StateValue.copy(state[key]);
    return out;
  }
  keys(value,mode){
    if(mode==="view"&&this.view)return this.view.filter(k=>k in value);
    const keys=Object.keys(value).filter(k=>!this.derived.has(k)&&(mode!=="save"||!this.presentation.has(k))&&typeof value[k]!=="function");
    return mode==="save"?keys.sort():keys;
  }
  capture(value,mode="snapshot"){
    const out={};for(const key of this.keys(value,mode)){const child=this.children[key];out[key]=child?child.capture(value[key],mode):StateValue.copy(value[key])}return out;
  }
  hash(h,value){
    const keys=this.keys(value,"save");h.m(keys.length);
    for(const key of keys){h.ms(key);const child=this.children[key];if(child)child.hash(h,value[key]);else StateValue.hash(h,value[key])}
  }
}

class SimTimerComponent{
  static stateContract=new StateContract({deadlines:{},periodicPhase:{}},{view:[],children:{deadlines:new StateContract({}, {presentation:["burrowTrail","neutralRecoverFx"]}),periodicPhase:new StateContract({}, {presentation:["burrowTrail","neutralRecoverFx"]})}});
  constructor(state={}){Object.assign(this,SimTimerComponent.stateContract.create(state))}
  start(sim,key,durationMs,{min=0}={}){const ticks=sim.msTicks(durationMs,{min});this.deadlines[key]=sim.tick+ticks;return this.deadlines[key]}
  clear(key){delete this.deadlines[key];delete this.periodicPhase[key]}
  ready(sim,key){return sim.tick>=(Number(this.deadlines[key])||0)}
  active(sim,key){const end=Number(this.deadlines[key])||0;return end>0&&sim.tick<end}
  remainingMs(sim,key){return Math.max(0,sim.ticksMs((Number(this.deadlines[key])||0)-sim.tick))}
  periodic(sim,key,intervalMs,{immediate=true}={}){
    const now=sim.tick,end=Number(this.deadlines[key])||0;
    if(!end){this.deadlines[key]=immediate?now:now+sim.msTicks(intervalMs);return !!immediate}
    if(now<end)return false;
    const scheduled=SimulationTiming.timerTicksWithPhase(intervalMs,sim.tps,this.periodicPhase[key]||0,{min:1});
    this.periodicPhase[key]=scheduled.phase;this.deadlines[key]=now+scheduled.ticks;return true;
  }
}
class StatusComponent{
  static stateContract=new StateContract({slowUntil:0,knockbackImmuneUntil:0,timedModifiers:{},airborneStartTick:0,airborneUntil:0,airborneDurationTicks:0,airborneHeight:0,airborneSourceType:null,impulseCompleteEffect:null,terrainRevealUntil0:0,terrainRevealUntil1:0},{view:["airborneStartTick","airborneUntil","airborneDurationTicks","airborneHeight","terrainRevealUntil0","terrainRevealUntil1"]});
  constructor(state={}){Object.assign(this,StatusComponent.stateContract.create(state))}
  applySlowUntil(untilTick){this.slowUntil=Math.max(Number(this.slowUntil)||0,Math.max(0,Math.round(Number(untilTick)||0)));return this.slowUntil}
  isSlowed(sim){return sim.tick<(Number(this.slowUntil)||0)}
}
class ResourceComponent{
  static stateContract=new StateContract({manaMax:0,mana:0,nextManaRegenTick:0},{view:["manaMax","mana"]});
  constructor(state={}){Object.assign(this,ResourceComponent.stateContract.create(state))}
}
class MovementComponent{
  static stateContract=new StateContract({routes:[],routeIndex:-1,impulseFx:0,impulseFy:0,impulseUntil:0,impulseDecay:0,lastMoveTick:-999999,outOfCombatStartedAt:-1,chargeMomentum:1000,crouchStartedAt:-1,crouched:false},{view:["lastMoveTick","outOfCombatStartedAt","chargeMomentum"]});
  constructor(state={}){Object.assign(this,MovementComponent.stateContract.create(state))}
  static plannerCodes=Object.freeze({direct:0,astar:1,'shared-astar':2,'flow-field':3});
  static planners=Object.freeze(['direct','astar','shared-astar','flow-field']);
  static encodeRouteRecipe(recipe){
    const code=this.plannerCodes[recipe?.planner];
    if(recipe?.kind==='plan'&&code!==undefined)return[0,recipe.key,recipe.radius,recipe.ignore,recipe.fromX,recipe.fromY,code];
    if(recipe?.kind==='unreachable')return[1,recipe.key,recipe.radius,recipe.ignore,recipe.fromX,recipe.fromY];
    const rootCode=this.plannerCodes[recipe?.root?.planner];
    if(recipe?.kind==='join'&&rootCode!==undefined)return[2,recipe.key,recipe.radius,recipe.ignore,recipe.fromX,recipe.fromY,recipe.root.fromX,recipe.root.fromY,rootCode];
    throw new Error('Invalid movement route recipe');
  }
  static decodeRouteRecipe(data){
    if(!Array.isArray(data))throw new Error('Invalid packed movement route recipe');
    if(data.length===7&&data[0]===0&&Number.isSafeInteger(data[6])&&this.planners[data[6]])return{kind:'plan',key:data[1],radius:data[2],ignore:data[3],fromX:data[4],fromY:data[5],planner:this.planners[data[6]]};
    if(data.length===6&&data[0]===1)return{kind:'unreachable',key:data[1],radius:data[2],ignore:data[3],fromX:data[4],fromY:data[5]};
    if(data.length===9&&data[0]===2&&Number.isSafeInteger(data[8])&&this.planners[data[8]])return{kind:'join',key:data[1],radius:data[2],ignore:data[3],fromX:data[4],fromY:data[5],root:{kind:'plan',fromX:data[6],fromY:data[7],planner:this.planners[data[8]]}};
    throw new Error('Invalid packed movement route recipe');
  }
  static validateRoutes(state,world,type,maxRevision=Number.MAX_SAFE_INTEGER){
    if(!state||!Array.isArray(state.routes)||state.routes.length>3||!Number.isSafeInteger(state.routeIndex)||state.routeIndex< -1||state.routeIndex>=state.routes.length)throw new Error('Invalid movement route state');
    const keys=new Set();
    for(const route of state.routes){
      if(!route||Array.isArray(route)||Object.keys(route).sort().join(',')!=='cursor,legX,legY,recipe,retained'||typeof route.retained!=='boolean'||!Number.isSafeInteger(route.cursor)||route.cursor<0||route.cursor>RallyStateCodec.MAX_ARRAY||!Number.isFinite(route.legX)||!Number.isFinite(route.legY)||route.legX<0||route.legY<0||route.legX>world.width||route.legY>world.height)throw new Error('Invalid movement route handle');
      const recipe=this.decodeRouteRecipe(route.recipe);
      if(typeof recipe.key!=='string'||recipe.key.length>1024||!Number.isFinite(recipe.radius)||recipe.radius<=0||recipe.radius>1024||typeof recipe.ignore!=='boolean'||!Number.isFinite(recipe.fromX)||!Number.isFinite(recipe.fromY)||recipe.fromX<0||recipe.fromY<0||recipe.fromX>world.width||recipe.fromY>world.height)throw new Error('Invalid movement route recipe');
      NavigationGoal.fromKey(recipe.key);
      if(recipe.kind==='join'){
        const root=recipe.root;if(!root||!Number.isFinite(root.fromX)||!Number.isFinite(root.fromY)||root.fromX<0||root.fromY<0||root.fromX>world.width||root.fromY>world.height)throw new Error('Invalid joined route root recipe');
      }
      const key=TerrainNavigation.routeKey(recipe.key,recipe.radius,recipe.ignore);if(keys.has(key))throw new Error('Duplicate movement route');keys.add(key);
    }
  }
  impulseActive(sim){return sim.tick<(Number(this.impulseUntil)||0)}
  impulseCompletesAfterCurrentTick(sim){return this.impulseActive(sim)&&sim.tick+1>=(Number(this.impulseUntil)||0)}
  clearImpulse(){this.impulseFx=0;this.impulseFy=0;this.impulseUntil=0;this.impulseDecay=0}
}
class CombatComponent{
  static stateContract=new StateContract({cooldownUntil:0,attackCooldownPhase:0,attackArcTargetId:null,attackArcUntilTick:0,attackWindupUntil:0,attackWindupStartedAt:0,attackWindupTargetId:null,attackWindupIsBuilding:false,moveRecoveryUntil:0,hitBurstCooldownUntil:0,recentImpactUntil:0},{presentation:["attackArcTargetId","attackArcUntilTick"],derived:["lastTimerTick"],view:["attackArcTargetId","attackArcUntilTick"]});
  constructor(state={}){Object.assign(this,CombatComponent.stateContract.create(state))}
  cooldownActive(sim){return sim.tick<(Number(this.cooldownUntil)||0)}
  windupPending(){return (Number(this.attackWindupUntil)||0)>0}
  moveRecoveryActive(sim){return sim.tick<(Number(this.moveRecoveryUntil)||0)}
  recordImpact(sim,ticks){this.recentImpactUntil=sim.tick+Math.max(0,ticks)-(this.lastTimerTick===sim.tick?0:1)}
  recentlyImpacted(sim){return sim.tick<(Number(this.recentImpactUntil)||0)}
  windupElapsedTicks(sim){return Math.max(0,sim.tick-(Number(this.attackWindupStartedAt)||sim.tick))}
}
class CapabilityHost{
  constructor(){
    Object.defineProperty(this,"available",{value:new Set(),enumerable:false,configurable:false,writable:false});
    Object.defineProperty(this,"capabilityMap",{value:new Map(),enumerable:false,configurable:false,writable:false});
  }
  registerCapability(capability){
    if(!capability?.key)throw new Error("Capability key required");
    this.available.add(capability.key);this.capabilityMap.set(capability.key,capability);
    Object.defineProperty(this,capability.key,{value:capability,enumerable:false,configurable:false,writable:false});
    return capability;
  }
  capability(key){return this.capabilityMap.get(key)||null}
}
class UnitCapability{
  // CAN-BE contract: every mixin registers its own key when constructed.
  constructor(owner,key){this.owner=owner;this.key=key;owner.registerCapability(this)}
  static supports(){return false}
}
class BurrowableMixin extends UnitCapability{
  static KEY="burrowable";
  static supports(_u,d){return !!(d.burrowCapable||d.burrowWhileMoving)}
  static stateActive(u){return !!u?.alive&&(u.burrowPhase==="dive"||u.burrowPhase==="travel")}
  static stateDefaults={"root":{"burrowPhase":"none","burrowTargetId":null,"burrowDestX":0,"burrowDestY":0},"behavior":{"burrowCooldownUntil":0,"burrowPhaseUntil":0,"burrowTrackTarget":false,"burrowOriginX":0,"burrowOriginY":0}};
  constructor(owner){super(owner,BurrowableMixin.KEY)}
  isActive(){return BurrowableMixin.stateActive(this.owner)}
  isUntargetable(){return this.isActive()&&!!UnitDefinition.get(this.owner.type)?.burrowUntargetable}
  setPhase(phase,options={}){
    const u=this.owner,next=(phase==="dive"||phase==="travel")?phase:"none";u.burrowPhase=next;
    if(next==="none"){u.behaviorState.burrowPhaseUntil=0;u.burrowTargetId=null;u.behaviorState.burrowTrackTarget=false;u.behaviorState.burrowOriginX=0;u.behaviorState.burrowOriginY=0;u.burrowDestX=0;u.burrowDestY=0;return next}
    if(!options.keepRoute){u.burrowTargetId=options.targetId??null;u.behaviorState.burrowTrackTarget=!!options.trackTarget;u.behaviorState.burrowOriginX=Number.isFinite(options.originX)?options.originX:u.x;u.behaviorState.burrowOriginY=Number.isFinite(options.originY)?options.originY:u.y;u.burrowDestX=Number.isFinite(options.destX)?options.destX:u.x;u.burrowDestY=Number.isFinite(options.destY)?options.destY:u.y}
    u.behaviorState.burrowPhaseUntil=Math.max(0,Math.round(Number(options.until)||0));return next;
  }

  setMovementActive(sim,active){
    const u=this.owner,d=UnitDefinition.get(u.type)||{};if(!u?.alive||!d.burrowWhileMoving)return;
    if(active){if(!this.isActive())this.setPhase("travel",{keepRoute:true})}else if(this.isActive())this.setPhase("none");
  }
  startDive(sim,target,options=null){
    const u=this.owner,d=UnitDefinition.get(u.type);if(!u||!target||!u.alive||target.alive===false||!d?.burrowCapable)return false;
    const fixedX=Number(options?.x),fixedY=Number(options?.y);let tx,ty;
    if(Number.isFinite(fixedX)&&Number.isFinite(fixedY)){tx=RangeUtil.clamp(fixedX,20,sim.world.width-20);ty=RangeUtil.clamp(fixedY,20,sim.world.height-20)}
    else{const dx=target.x-u.x,dy=target.y-u.y,dist=Math.hypot(dx,dy)||1,rearGap=sim.unitRadius(u.type)+sim.unitRadius(target.type)+24;tx=RangeUtil.clamp(target.x+dx/dist*rearGap,20,sim.world.width-20);ty=RangeUtil.clamp(target.y+dy/dist*rearGap,20,sim.world.height-20)}
    if(sim.world.terrain.active){const p=sim.navigation.resolveGroundGoal(u,tx,ty,true);if(!p)return false;tx=p.x;ty=p.y}
    this.setPhase("dive",{until:u.timers.start(sim,"burrowDive",d.burrowDiveMs||450),targetId:target.id||null,trackTarget:options?.trackTarget!==false,originX:u.x,originY:u.y,destX:tx,destY:ty});
    u.movement.clearImpulse();const cooldown=Math.max(0,Math.round(Number(d.burrowCooldownMs)||0));if(cooldown)u.behaviorState.burrowCooldownUntil=u.timers.start(sim,"burrowCooldown",cooldown);
    sim.events.push({type:"burrowDive",side:u.side,x:u.x,y:u.y,targetId:target.id||null,targetType:target.type||null,sourceType:u.type});return true;
  }
  moveToward(sim,tx,ty,speed){
    const u=this.owner,goalX=tx,goalY=ty;
    const point=sim.navigation.nextPoint(u,NavigationGoal.point(tx,ty));if(!point)return false;
    const dx=point.x-u.x,dy=point.y-u.y,dist=Math.hypot(dx,dy)||1,step=Math.min(speed/sim.tps,dist),oldX=u.fx,oldY=u.fy;
    sim.navigation.motion.move(u,u.x+dx/dist*step,u.y+dy/dist*step,'steer');
    if(u.fx!==oldX||u.fy!==oldY)u.movement.lastMoveTick=sim.tick;
    return Math.hypot(u.x-goalX,u.y-goalY)<=2;
  }
  finishEmerge(sim){
    const u=this.owner,d=UnitDefinition.get(u.type)||{},radius=d.burrowEmergeRadius||92,airborneMs=sim.hasAbility(u.side,u.type)?(d.abilityBurrowAirborneMs||d.burrowAirborneMs||900):(d.burrowAirborneMs||900),airborneTicks=sim.msTicks(airborneMs),airborneHeight=d.burrowAirborneHeight||54,damage=Math.max(1,Math.floor(Number(d.burrowEmergeDamage)||((d.atk||58)*(d.burrowEmergeDamageScale||.78))));
    // Emerge is an explicit displacement event, not ordinary crowd pressure.
    // The materializing unit owns its occupied space; non-allied ground units already
    // intersecting that space are moved only far enough to clear the new solid.
    sim.resolveSolidEmergence(u);
    this.setPhase("none");sim.events.push({type:"burrowEmerge",side:u.side,x:u.x,y:u.y,radius,damage,sourceId:u.id,sourceType:u.type});let winner=null;
    sim.withNearbyUnits(u.x,u.y,radius+sim.maxUnitRadius,indices=>{
      for(const idx of indices){const e=sim.units[idx];if(!e?.alive||e.side===u.side||e.id===u.id||sim.unitLayer(e.type)!=="GROUND")continue;if(Math.hypot(e.x-u.x,e.y-u.y)>radius+sim.unitRadius(e.type))continue;const r=sim.applyDamage(u.side,u.type,e,false,damage,u.id,{damageClass:"area"});if(r)winner=r;sim.applyAirborne(e,{durationTicks:airborneTicks,height:airborneHeight,sourceSide:u.side,sourceType:u.type})}
    });
    return winner;
  }
  update(sim){
    const u=this.owner;if(!this.isActive())return {active:false,winner:null};const d=UnitDefinition.get(u.type)||{};
    if(u.burrowPhase==="dive"){if(sim.tick<u.behaviorState.burrowPhaseUntil)return {active:true,winner:null};this.setPhase("travel",{keepRoute:true});sim.events.push({type:"burrowTravel",side:u.side,x:u.x,y:u.y,targetId:u.burrowTargetId,sourceType:u.type})}
    let tx=u.burrowDestX,ty=u.burrowDestY;const target=sim.unitById.get(u.burrowTargetId)||sim.units.find(x=>x.id===u.burrowTargetId&&x.alive);
    if(u.behaviorState.burrowTrackTarget&&target?.alive){const dx=target.x-u.behaviorState.burrowOriginX,dy=target.y-u.behaviorState.burrowOriginY,dist=Math.hypot(dx,dy)||1,rearGap=sim.unitRadius(u.type)+sim.unitRadius(target.type)+24;tx=RangeUtil.clamp(target.x+dx/dist*rearGap,20,sim.world.width-20);ty=RangeUtil.clamp(target.y+dy/dist*rearGap,20,sim.world.height-20);u.burrowDestX=tx;u.burrowDestY=ty}
    if(sim.world.terrain.active){const p=sim.navigation.resolveGroundGoal(u,tx,ty,true);if(!p)return {active:false,winner:this.finishEmerge(sim)};tx=p.x;ty=p.y;u.burrowDestX=tx;u.burrowDestY=ty}
    const reached=this.moveToward(sim,tx,ty,d.burrowMoveSpeed||420);if(u.timers.periodic(sim,"burrowTrail",100)){sim.events.push({type:"burrowTrail",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type})}
    if(reached||Math.hypot(u.x-tx,u.y-ty)<12)return {active:false,winner:this.finishEmerge(sim)};return {active:true,winner:null};
  }
}
class LeapableMixin extends UnitCapability{
  static KEY="leapable";
  static supports(_u,d){return Number(d.leapRange)>0}
  static stateDefaults={"root":{"leapStartTick":0,"leapEndTick":0,"leapStartX":0,"leapStartY":0,"leapEndX":0,"leapEndY":0,"leapActive":false},"behavior":{"leapTargetId":null,"blinkCooldownUntil":0}};
  constructor(owner){super(owner,LeapableMixin.KEY)}
  isActive(sim){const u=this.owner;return !!u?.alive&&!!u.leapActive&&sim.tick<(u.leapEndTick||0)}
  pathClear(sim,tx,ty){
    const u=this.owner;if(!u)return false;
    sim.navigation.sync();
    return !sim.navigation.motion.buildingCast(u.x,u.y,tx-u.x,ty-u.y,sim.unitRadius(u.type));
  }
  start(sim,target,isBuilding=false){
    const u=this.owner;if(!u?.alive||!target?.alive||u.leapActive)return false;
    const d=UnitDefinition.get(u.type)||{},leapRange=Math.max(1,Number(d.leapRange)||ROGUE_BLINK_RANGE);
    const dx=target.x-u.x,dy=target.y-u.y,dist=Math.hypot(dx,dy)||1;if(dist>leapRange)return false;
    const targetRadius=isBuilding?(Number(BuildingDefinition.get(target.type)?.size)||35):sim.unitRadius(target.type);
    const gap=sim.unitRadius(u.type)+targetRadius+8,ux=dx/dist,uy=dy/dist;
    const near={x:RangeUtil.clamp(target.x-ux*gap,20,sim.world.width-20),y:RangeUtil.clamp(target.y-uy*gap,20,sim.world.height-20)};
    const far={x:RangeUtil.clamp(target.x+ux*gap,20,sim.world.width-20),y:RangeUtil.clamp(target.y+uy*gap,20,sim.world.height-20)};
    const minTravel=sim.unitRadius(u.type)*2+SPAWN_UNIT_GAP,candidates=(Math.hypot(near.x-u.x,near.y-u.y)<minTravel)?[far,near]:[near,far];
    let landing=null;for(const p of candidates)if(sim.pointClearForUnit(u.type,p.x,p.y,null,[])&&this.pathClear(sim,p.x,p.y)){landing=p;break}
    if(!landing)return false;
    sim.clearAttackWindup(u);u.leapActive=true;u.leapStartTick=sim.tick;u.leapEndTick=sim.tick+sim.msTicks(ROGUE_LEAP_DURATION_MS);
    u.leapStartX=u.x;u.leapStartY=u.y;u.leapEndX=landing.x;u.leapEndY=landing.y;u.behaviorState.leapTargetId=target.id;u.movement.outOfCombatStartedAt=-1;
    sim.events.push({type:"rogueLeapStart",side:u.side,x:u.x,y:u.y,x2:landing.x,y2:landing.y,sourceId:u.id,sourceType:u.type,targetId:target.id,arcHeight:ROGUE_LEAP_ARC_HEIGHT});
    return true;
  }
  finish(sim){
    const u=this.owner,d=UnitDefinition.get(u?.type)||{};if(!u?.leapActive)return null;
    u.x=u.leapEndX;u.y=u.leapEndY;u.fx=Math.round(u.x*FP);u.fy=Math.round(u.y*FP);sim.syncUnitSpatial(u);
    sim.resetTerrainMotionOrigin(u);
    u.leapActive=false;u.leapEndTick=0;const targetId=u.behaviorState.leapTargetId;u.behaviorState.leapTargetId=null;
    u.behaviorState.blinkCooldownUntil=sim.tick+Math.max(1,sim.msTicks(Number(UnitDefinition.get(u.type)?.leapCooldownMs)||ROGUE_BLINK_COOLDOWN_MS));
    let winner=null;
    const landingDamageMult=Number(d.leapLandingTargetDamageMultiplier)||0,landingRadius=Number(d.leapLandingAirborneRadius)||0;
    if(landingDamageMult>0&&sim.hasAbility(u.side,u.type)){
      const leapTarget=sim.unitById.get(targetId)||sim.units.find(e=>e.id===targetId&&e.alive);
      if(leapTarget?.alive&&leapTarget.side!==u.side)winner=sim.applyDamage(u.side,u.type,leapTarget,false,Math.max(1,Math.round((d.atk||60)*landingDamageMult)),u.id,{damageClass:UnitDefinition.damageClass(u.type)});
      for(const idx of sim.nearbyUnits(u.x,u.y,landingRadius+sim.maxUnitRadius)){const e=sim.units[idx];if(!e?.alive||e.side===u.side||sim.unitLayer(e.type)!=="GROUND")continue;if(Math.hypot(e.x-u.x,e.y-u.y)>landingRadius+sim.unitRadius(e.type))continue;sim.applyAirborne(e,{durationTicks:sim.msTicks(d.leapLandingAirborneMs||0),height:d.leapLandingAirborneHeight||0,sourceSide:u.side,sourceType:u.type})}
    }
    sim.events.push({type:"rogueLeapLand",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type,targetId,radius:landingDamageMult>0&&sim.hasAbility(u.side,u.type)?landingRadius:0});
    return winner;
  }
  tryAuto(sim,visionSources,ability){
    const u=this.owner,d=UnitDefinition.get(u.type)||{};if(sim.tick<(u.behaviorState.spawnActionLockUntilTick||0))return false;if(sim.tick<(u.behaviorState.blinkCooldownUntil||0))return false;
    let enabled=false,roles=DIVE_BACKLINE_ROLES,range=Math.max(1,Number(d.leapRange)||ROGUE_BLINK_RANGE);
    const policy=String(d.leapAutoPolicy||"");
    if(policy==="always")enabled=true;
    else if(policy==="ability")enabled=!!ability;
    else if(policy.startsWith("parentAbility:"))enabled=sim.hasAbility(u.side,policy.slice("parentAbility:".length));
    else if(policy.startsWith("specialResearch:"))enabled=sim.hasSpecialResearch(u.side,policy.slice("specialResearch:".length));
    if(d.leapTargetRoles==="rogueBackline")roles=ROGUE_BACKLINE_ROLES;
    else if(d.leapTargetRoles==="sporeling")roles=SPORELING_LEAP_ROLES;
    if(!enabled)return false;
    const leapTarget=sim.findOffensiveMobilityTarget(u,range,roles,visionSources,{fallbackAny:true});
    return !!(leapTarget&&this.start(sim,leapTarget.entity,leapTarget.isBuilding));
  }
  update(sim){
    const u=this.owner;if(!u?.leapActive)return {active:false,winner:null};
    const total=Math.max(1,(u.leapEndTick||0)-(u.leapStartTick||0));if(sim.tick>=u.leapEndTick)return {active:false,winner:this.finish(sim)};
    const q=RangeUtil.clamp((sim.tick-u.leapStartTick)/total,0,1);u.x=u.leapStartX+(u.leapEndX-u.leapStartX)*q;u.y=u.leapStartY+(u.leapEndY-u.leapStartY)*q;
    u.movement.lastMoveTick=sim.tick;u.fx=Math.round(u.x*FP);u.fy=Math.round(u.y*FP);sim.syncUnitSpatial(u);return {active:true,winner:null};
  }
}
class TurnLimitedFlightMixin extends UnitCapability{
  static KEY="turnLimitedFlight";
  static supports(_u,d){return !!(d.turnLimitedFlight||d.abilityTurnLimitedFlight)}
  static stateDefaults={"behavior":{"turnFlightHeadingMilliDeg":null}};
  constructor(owner){super(owner,TurnLimitedFlightMixin.KEY)}
  config(sim){const d=UnitDefinition.get(this.owner.type)||{};return d.turnLimitedFlight||(sim?.hasAbility?.(this.owner.side,this.owner.type)?d.abilityTurnLimitedFlight:null)}
  normalizeMilliDeg(v){v=Math.round(Number(v)||0)%360000;return v<0?v+360000:v}
  headingTo(tx,ty){const u=this.owner;return this.normalizeMilliDeg(Math.atan2(ty-u.y,tx-u.x)*180000/Math.PI)}
  headingDelta(from,to){let d=this.normalizeMilliDeg(to)-this.normalizeMilliDeg(from);if(d>180000)d-=360000;if(d<-180000)d+=360000;return d}
  ensureHeading(tx,ty){const u=this.owner;if(u.behaviorState.turnFlightHeadingMilliDeg==null)u.behaviorState.turnFlightHeadingMilliDeg=this.headingTo(tx,ty);return u.behaviorState.turnFlightHeadingMilliDeg}
  orbitDirection(cfg){const u=this.owner;if(cfg?.orbitDirection!=="idSplit")return 1;return (HashUtil.hash(`${u.id}|turn-flight-orbit`)&1)?1:-1}
  steeringTarget(tx,ty,cfg){
    const u=this.owner,r=Math.max(0,Number(cfg?.orbitRadius)||0);if(r<=0)return{x:tx,y:ty};
    const dx=u.x-tx,dy=u.y-ty,dist=Math.hypot(dx,dy);if(dist>r||dist<.001)return{x:tx,y:ty};
    const nx=dx/dist,ny=dy/dist,dir=this.orbitDirection(cfg),tangentX=-ny*dir,tangentY=nx*dir;
    // Aim ahead along the chosen tangent while softly holding the configured orbit radius.
    // This is steering only: weapon range and authoritative collision remain unchanged.
    const radialError=r-dist,radialGain=.7,look=Math.max(r,100);
    return{x:u.x+tangentX*look+nx*radialError*radialGain,y:u.y+tangentY*look+ny*radialError*radialGain};
  }
  move(sim,tx,ty,speed){const u=this.owner,cfg=this.config(sim);if(!cfg)return sim.moveToward(u,tx,ty,speed);const steer=this.steeringTarget(tx,ty,cfg);let heading=this.ensureHeading(steer.x,steer.y),desired=this.headingTo(steer.x,steer.y),delta=this.headingDelta(heading,desired);const maxTurn=Math.max(1,Math.round((Number(cfg.turnDegPerSecond)||360)*1000/sim.tps));delta=RangeUtil.clamp(delta,-maxTurn,maxTurn);heading=this.normalizeMilliDeg(heading+delta);u.behaviorState.turnFlightHeadingMilliDeg=heading;const a=heading*Math.PI/180000,lookAhead=Math.max(100,speed);return sim.moveToward(u,u.x+Math.cos(a)*lookAhead,u.y+Math.sin(a)*lookAhead,speed)}
  facingAllowsAttack(sim,target){const cfg=this.config(sim);if(!cfg)return true;const heading=this.ensureHeading(target.x,target.y),desired=this.headingTo(target.x,target.y);return Math.abs(this.headingDelta(heading,desired))<=Math.round((Number(cfg.attackHalfAngleDeg)||45)*1000)}
}
class HealerMixin extends UnitCapability{
  static KEY="healer";static supports(_u,d){return Number(d.healAmount)>0}static stateDefaults={"behavior":{"healTargetId":null}};
  constructor(owner){super(owner,HealerMixin.KEY)}
  clearTarget(){this.owner.behaviorState.healTargetId=null}
  validTarget(sim,target,searchRange){
    const u=this.owner;if(!target?.alive||target.side!==u.side||target.id===u.id||UnitDefinition.get(target.type)?.economyWorker||target.hp>=target.maxHp)return false;
    return Math.hypot(target.x-u.x,target.y-u.y)<=searchRange;
  }
  update(sim){
    const u=this.owner,d=UnitDefinition.get(u.type),manaPerPacket=Math.max(1,Math.round(Number(d.healManaPerPacket)||5)),healPerPacket=Math.max(1,Math.round(Number(d.healPerManaPacket)||5));
    if((Number(u.resources.mana)||0)<manaPerPacket){this.clearTarget();return false}
    const healRange=sim.abilityRangeModifier(u.side,u.type,"heal",d.healRange),searchRange=Math.max(300,healRange+70);
    let best=u.behaviorState.healTargetId?sim.unitById.get(u.behaviorState.healTargetId):null;
    if(!this.validTarget(sim,best,searchRange)){
      this.clearTarget();best=null;let score=Infinity;
      for(const idx of sim.nearbyUnits(u.x,u.y,searchRange,u.side)){const ally=sim.units[idx];if(!this.validTarget(sim,ally,searchRange))continue;const dist=Math.hypot(ally.x-u.x,ally.y-u.y),missing=(ally.maxHp-ally.hp)/ally.maxHp,sc=dist-Math.floor(missing*130);if(sc<score||(sc===score&&best&&ally.id<best.id)){best=ally;score=sc}}
      if(best)u.behaviorState.healTargetId=best.id;
    }
    if(!best)return false;
    const dist=Math.hypot(best.x-u.x,best.y-u.y);if(dist>healRange){sim.moveToInteraction(u,best,"heal",d.speed,healRange);return true}if(u.combat.cooldownActive(sim))return true;
    const missing=Math.max(0,best.maxHp-best.hp);if(missing<=0){this.clearTarget();return false}
    const actualHeal=Math.min(healPerPacket,missing);if(!sim.consumeUnitMana(u,manaPerPacket)){this.clearTarget();return false}
    u.combat.cooldownUntil=sim.tick+Math.max(1,sim.msTicks(Math.round(d.healCooldownMs)));u.attackFlash=1;
    const before=best.hp;best.hp=Math.min(best.maxHp,best.hp+actualHeal);const actual=best.hp-before;
    sim.events.push({type:"heal",side:u.side,x:best.x,y:best.y,amount:actual,sourceId:u.id,targetId:best.id,sourceType:u.type,manaCost:manaPerPacket});
    sim.events.push({type:"healLink",side:u.side,x:u.x,y:u.y,x2:best.x,y2:best.y,sourceId:u.id,targetId:best.id,sourceType:u.type,durationTicks:Math.max(3,sim.msTicks(Math.round(d.healCooldownMs)+100))});
    if(best.hp>=best.maxHp)this.clearTarget();
    return true;
  }
}
class SummonerMixin extends UnitCapability{
  static KEY="summoner";static supports(_u,d){return !!(d.summonType||d.summonIntervalMs||d.carrierMax)}static stateDefaults={"root":{"nextSummonTick":0},"behavior":{"carrierInitialized":false,"nextCarrierSpawnTick":0,"carrierRecoveryQueue":[]}};
  constructor(owner){super(owner,SummonerMixin.KEY)}
  spawnCarrierMite(sim,slot=0){
    const u=this.owner,d=UnitDefinition.get(u.type),md=UnitDefinition.get(d.summonType);
    // Carrier slots are physical launch positions, not random samples. A stable per-carrier
    // phase plus evenly spaced slots prevents same/near-same spawn centers before the
    // generic crowd solver ever has to repair them.
    const max=Math.max(1,Math.round(Number(d.carrierMax)||8)),phase=(HashUtil.hash(`${u.id}|carrier-launch-phase`)%6283)/1000,a=phase+(Math.max(0,Math.round(Number(slot)||0))%max)*(Math.PI*2/max),rr=(d.size+md.size)*COLLISION_RADIUS_SCALE+16;
    const child=sim.spawnUnit(u.side,d.summonType,RangeUtil.clamp(u.x+Math.cos(a)*rr,20,sim.world.width-20),RangeUtil.clamp(u.y+Math.sin(a)*rr,20,sim.world.height-20));child.summonerId=u.id;child.carrierSlot=slot;return child;
  }
  recoveryQueue(){const u=this.owner;return Array.isArray(u.behaviorState.carrierRecoveryQueue)?u.behaviorState.carrierRecoveryQueue:(u.behaviorState.carrierRecoveryQueue=[])}
  updateCarrierRecovery(sim){
    const u=this.owner,d=UnitDefinition.get(u.type),md=UnitDefinition.get(d.summonType)||{},queue=this.recoveryQueue();if(!queue.length)return;
    const maxHp=Math.max(1,Number(md.hp)||1),healPerTick=maxHp*Math.max(0,Number(md.carrierRecoverHpPctPerSecond)||100)/100/sim.tps;
    for(let i=queue.length-1;i>=0;i--){
      const q=queue[i];q.hp=Math.min(maxHp,(Number(q.hp)||0)+healPerTick);
      if(q.hp<maxHp)continue;
      const child=this.spawnCarrierMite(sim,Math.max(0,Math.round(Number(q.slot)||0)));child.hp=child.maxHp;
      queue.splice(i,1);sim.events.push({type:"carrierMiteRecovered",side:u.side,x:child.x,y:child.y,unitId:child.id,sourceId:u.id,slot:child.carrierSlot});
    }
  }
  isCarrierController(){return Number(UnitDefinition.get(this.owner.type)?.carrierMax)>0}
  update(sim){
    const u=this.owner,d=UnitDefinition.get(u.type);
    if(this.isCarrierController()){
      const ability=sim.hasAbility(u.side,u.type),respawnMs=ability?(d.abilityCarrierRespawnMs||d.carrierRespawnMs||4000):(d.carrierRespawnMs||4000),respawn=sim.msTicks(respawnMs),baseManaCost=Math.max(0,Math.round(Number(d.carrierRespawnManaCost)||0)),manaCost=ability?Math.max(0,Math.round(baseManaCost*Math.max(0,Number(d.abilityCarrierRespawnManaCostPct)||100)/100)):baseManaCost;
      this.updateCarrierRecovery(sim);
      const living=[];for(const idx of sim.nearbyUnits(u.x,u.y,d.carrierRadius+180,u.side)){const x=sim.units[idx];if(x?.alive&&UnitDefinition.get(x.type)?.carrierSummon&&x.summonerId===u.id)living.push(x)}
      const recovering=this.recoveryQueue(),ownedCount=living.length+recovering.length;
      if(!u.behaviorState.carrierInitialized){const used=new Set([...living.map(x=>x.carrierSlot),...recovering.map(x=>x.slot)]);for(let i=ownedCount;i<(d.carrierMax||8);i++){let slot=0;while(used.has(slot))slot++;used.add(slot);this.spawnCarrierMite(sim,slot)}u.behaviorState.carrierInitialized=true;u.behaviorState.nextCarrierSpawnTick=sim.tick+respawn;return true}
      if(ownedCount>=(d.carrierMax||8)){u.behaviorState.nextCarrierSpawnTick=sim.tick+respawn;return true}
      if(sim.tick>=(u.behaviorState.nextCarrierSpawnTick||0)&&((Number(u.resources?.mana)||0)>=manaCost)&&(!manaCost||sim.consumeUnitMana(u,manaCost))){const used=new Set([...living.map(x=>x.carrierSlot),...recovering.map(x=>x.slot)]);let slot=0;while(used.has(slot))slot++;const child=this.spawnCarrierMite(sim,slot);u.behaviorState.nextCarrierSpawnTick=sim.tick+respawn;sim.events.push({type:"carrierMiteRespawn",side:u.side,x:child.x,y:child.y,unitId:child.id,sourceId:u.id,manaCost,respawnMs})}
      return true;
    }
    const summonType=d.summonType||"sporeling",interval=Math.max(1,sim.msTicks(Number(d.summonIntervalMs)||500)),max=Math.max(1,Math.round(Number(d.summonMax)||5)),cost=Math.max(1,Math.round(Number(d.summonManaCost)||35));
    if(!u.nextSummonTick)u.nextSummonTick=sim.tick+interval;if(sim.tick<u.nextSummonTick)return false;u.nextSummonTick=sim.tick+interval;
    const living=sim.units.filter(x=>x.alive&&x.type===summonType&&x.summonerId===u.id).length;if(living>=max||(Number(u.resources.mana)||0)<cost)return false;
    const baseR=sim.unitRadius(u.type)+sim.unitRadius(summonType)+SPAWN_UNIT_GAP+6;
    const spawn=sim.findOpenSpawnAround(u,summonType,{baseRadius:baseR,maxRadius:baseR+48,angleSlots:12,radialStep:8,seedKey:`${u.id}|summon|${sim.tick}|${living}`});
    if(!spawn||!sim.consumeUnitMana(u,cost))return false;const child=sim.spawnUnit(u.side,summonType,spawn.x,spawn.y);child.summonerId=u.id;child.behaviorState.spawnActionLockUntilTick=sim.tick+Math.max(1,sim.msTicks(SUMMON_SPAWN_ACTION_GRACE_MS));child.expireTick=child.timers.start(sim,"summonLifetime",d.summonLifetimeMs||12000);
    sim.events.push({type:"sporeSpawn",side:u.side,x:spawn.x,y:spawn.y,unitId:child.id,intervalTicks:interval,manaCost:cost});return true;
  }
}
class InterceptorMixin extends UnitCapability{
  static KEY="interceptor";static supports(_u,d){return Number(d.interceptRadius)>0}constructor(owner){super(owner,InterceptorMixin.KEY)}
  manaCost(sim){const u=this.owner,d=UnitDefinition.get(u.type)||{};return sim.hasAbility(u.side,u.type)?Math.max(1,d.abilityInterceptManaCost||10):Math.max(1,d.interceptManaCost||20)}
  radius(sim){const u=this.owner,d=UnitDefinition.get(u.type)||{};return sim.hasAbility(u.side,u.type)?(d.abilityInterceptRadius||d.interceptRadius||0):(d.interceptRadius||0)}
  canIntercept(sim,p){const u=this.owner;return !!u?.alive&&u.side!==p.side&&Math.hypot(u.x-p.x,u.y-p.y)<=this.radius(sim)&&Math.round(Number(u.resources.mana)||0)>=this.manaCost(sim)}
}
class ChargerMixin extends UnitCapability{
  static KEY="charger";static supports(_u,d){return Number(d.chargeSpeed)>0||!!d.momentumCharge}constructor(owner){super(owner,ChargerMixin.KEY)}
  consumeImpact(sim,target,isBuilding=false){
    const u=this.owner;if(!UnitDefinition.get(u.type)?.momentumCharge)return 1;
    const mult=Math.max(1,(u.movement.chargeMomentum||1000)/1000);u.movement.chargeMomentum=1000;u.movement.outOfCombatStartedAt=-1;
    sim.events.push({type:"chargeImpact",side:u.side,x:target.x,y:target.y,multiplier:mult});return mult;
  }
  applyImpactControl(sim,target,mult,ability){
    const u=this.owner;if(!UnitDefinition.get(u.type)?.momentumCharge||!ability||!target||mult<1.25)return false;
    sim.applyKnockback(u,target,{distance:18+Math.round((Math.min(2,mult)-1)*18),roleMultiplier:{charger:1.1},sizeMultiplier:{light:1,medium:.82,heavy:.60},lockTicks:sim.msTicks(250)});return true;
  }
  startObjective(sim,target){
    const u=this.owner,d=UnitDefinition.get(u.type);if(!u?.alive||!target||target.alive===false||!u.capability(ObjectiveMixin.KEY))return false;
    const dx=target.x-u.x,dy=target.y-u.y,len=Math.hypot(dx,dy)||1;u.objectiveChargePending=false;u.objectiveChargeActive=true;u.behaviorState.objectiveChargeDirX=dx/len;u.behaviorState.objectiveChargeDirY=dy/len;u.objectiveChargeRemaining=d.chargeDistance||180;u.objectiveChargeHitIds=[];sim.clearAttackWindup(u);
    sim.events.push({type:"objectiveBearChargeStart",side:u.side,x:u.x,y:u.y,x2:target.x,y2:target.y,sourceId:u.id,sourceType:u.type});return true;
  }
  updateObjective(sim){
    const u=this.owner;if(!u?.objectiveChargeActive)return {active:false,winner:null};const d=UnitDefinition.get(u.type),step=Math.min((d.chargeSpeed||330)/sim.tps,Math.max(0,u.objectiveChargeRemaining||0));
    const oldX=u.x,oldY=u.y;let nx=RangeUtil.clamp(u.x+(u.behaviorState.objectiveChargeDirX||0)*step,20,sim.world.width-20),ny=RangeUtil.clamp(u.y+(u.behaviorState.objectiveChargeDirY||0)*step,20,sim.world.height-20),blocked=false,buildingHit=null;
    const motion=sim.navigation.motion.move(u,nx,ny,'stop');nx=motion.x;ny=motion.y;blocked=!!motion.hit;
    const obstacle=motion.hit?.obstacle,building=obstacle?(sim.buildingById.get(obstacle.id)||sim.buildings.find(b=>b.id===obstacle.id)):null;
    if(building&&sim.objectiveIsEnemy(u,building))buildingHit=building;
    u.x=nx;u.y=ny;u.fx=Math.round(nx*FP);u.fy=Math.round(ny*FP);u.movement.lastMoveTick=sim.tick;sim.syncUnitSpatial(u);const moved=Math.hypot(nx-oldX,ny-oldY);u.objectiveChargeRemaining=Math.max(0,(u.objectiveChargeRemaining||0)-moved);
    const hitIds=new Set(u.objectiveChargeHitIds||[]),hitRadius=sim.unitRadius(u.type)+34;let winner=null;
    if(buildingHit&&!hitIds.has(buildingHit.id)){hitIds.add(buildingHit.id);const r=sim.applyDamage(u.side,u.type,buildingHit,true,d.chargeDamage||75,u.id,{damageClass:"area"});if(r)winner=r;u.objectiveChargeActive=false;u.objectiveChargeRemaining=0;u.objectiveChargeHitIds=[...hitIds].sort();const w=sim.objectiveBearShockwave(u,u.x,u.y,buildingHit.id,d.shockDamage||50);if(w)winner=w;sim.events.push({type:"objectiveBearChargeEnd",side:u.side,x:u.x,y:u.y,radius:d.shockRadius||90,sourceId:u.id,sourceType:u.type,targetId:buildingHit.id,targetType:buildingHit.type,isBuilding:true});return {active:false,winner}}
    sim.withNearbyUnits(u.x,u.y,hitRadius+sim.maxUnitRadius,indices=>{
      for(const idx of indices){const e=sim.units[idx];if(!sim.objectiveIsEnemy(u,e)||hitIds.has(e.id)||sim.unitLayer(e.type)!=="GROUND")continue;if(Math.hypot(e.x-u.x,e.y-u.y)>hitRadius+sim.unitRadius(e.type))continue;hitIds.add(e.id);const r=sim.applyDamage(u.side,u.type,e,false,d.chargeDamage||75,u.id,{damageClass:"area"});if(r)winner=r;sim.applyKnockbackFromPoint(u,e,oldX,oldY,{distance:46,lockTicks:sim.msTicks(300),sizeMultiplier:{light:1,medium:.82,heavy:.62}})}
    });
    u.objectiveChargeHitIds=[...hitIds].sort();sim.events.push({type:"objectiveBearChargeTrail",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type});
    if(blocked||u.objectiveChargeRemaining<=.5||moved<.001){u.objectiveChargeActive=false;u.objectiveChargeRemaining=0;const w=sim.objectiveBearShockwave(u,u.x,u.y,null,d.shockDamage||50);if(w)winner=w;sim.events.push({type:"objectiveBearChargeEnd",side:u.side,x:u.x,y:u.y,radius:d.shockRadius||90,sourceId:u.id,sourceType:u.type});return {active:false,winner}}
    return {active:true,winner};
  }
}
// One authoritative cast owns membership and timing; capabilities own execution only.
class ChargedSkillGeometry{
  static gatheringR=180;static gatherMs=350;static chargeMs=1400;static maxHoldMs=6000;
  static aimPoint(unit,cast,tick,tps,world){
    const d=UnitDefinition.get(unit.type)?.chargedSkill;if(!d)return null;
    const progress=RangeUtil.clamp((tick-cast.gatherUntil)/Math.max(1,SimulationTiming.msToTicks(this.chargeMs,tps)),0,1);
    const reach=d.minReach+(d.maxReach-d.minReach)*progress,dx=cast.aimX-unit.x,dy=cast.aimY-unit.y,distance=Math.hypot(dx,dy),scale=distance>0?Math.min(distance,reach)/distance:0;
    return {x:RangeUtil.clamp(unit.x+dx*scale,20,world.width-20),y:RangeUtil.clamp(unit.y+dy*scale,20,world.height-20),reach,progress};
  }
}

export { BurrowableMixin, CapabilityHost, ChargedSkillGeometry, ChargerMixin, CombatComponent, HealerMixin, InterceptorMixin, LeapableMixin, MovementComponent, ResourceComponent, SimTimerComponent, StateContract, StateValue, StatusComponent, SummonerMixin, TurnLimitedFlightMixin, UnitCapability };
