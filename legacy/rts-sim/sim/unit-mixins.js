// Unit capability mixins.
import { RangeUtil } from '../core/game-rules.js';
import { ChargedSkillGeometry, UnitCapability } from './components.js';
import { HashUtil } from './map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { UnitDefinition } from '../definitions/units.js';
import { DIVE_BACKLINE_ROLES } from '../definitions/world-rules.js';
import { InteractionGeometry, TerrainNavigation } from './navigation.js';

class ChargedSkillMixin extends UnitCapability{
  static KEY="chargedSkill";static supports(_u,d){return !!d.chargedSkill}
  static stateDefaults={behavior:{chargedExecution:null,chargedRecoveryUntil:0}};
  constructor(owner){super(owner,ChargedSkillMixin.KEY)}
  static stateReady(u,tick){return !!u?.alive&&!!UnitDefinition.get(u.type)?.chargedSkill&&tick>=(u.status?.airborneUntil||0)&&tick>=(u.movement?.impulseUntil||0)&&!u.behaviorState?.chargedExecution&&tick>=(u.behaviorState?.chargedRecoveryUntil||0)}
  ready(sim){return ChargedSkillMixin.stateReady(this.owner,sim.tick)}
  release(sim,cast){
    const u=this.owner;if(!this.ready(sim))return false;
    const d=UnitDefinition.get(u.type).chargedSkill,point=ChargedSkillGeometry.aimPoint(u,cast,sim.tick,sim.tps,sim.world);
    sim.clearAttackWindup(u);u.target=null;u.behaviorState.chargedRecoveryUntil=sim.tick+sim.msTicks(d.recoveryMs);
    if(d.kind==="momentum"){
      const dx=point.x-u.x,dy=point.y-u.y,len=Math.hypot(dx,dy);
      u.behaviorState.chargedExecution={castId:cast.id,dirX:len?dx/len:0,dirY:len?dy/len:0,remaining:len,hitIds:[],endTick:sim.tick+sim.msTicks(2000)};
    }else{
      sim.spawnProjectile({id:"p"+(++sim.seq),owner:u.id,side:u.side,type:u.type,x:u.x,y:u.y,target:null,isBuilding:false,speed:d.speed,damage:d.damage,splash:d.radius,damageClass:"area",trajectoryPolicy:"lockedPoint",lockedAimX:point.x,lockedAimY:point.y,arcHeight:d.arcHeight,chargedCastId:cast.id});
      u.attackFlash=sim.msTicks(150);
    }
    sim.events.push({type:"chargedSkillRelease",side:u.side,sourceId:u.id,sourceType:u.type,x:u.x,y:u.y,x2:point.x,y2:point.y,castId:cast.id});return true;
  }
  update(sim){
    const u=this.owner,e=u.behaviorState.chargedExecution;if(!e)return sim.tick<u.behaviorState.chargedRecoveryUntil;
    if(sim.isAirborneStatus(u)||sim.tick>=e.endTick){u.behaviorState.chargedExecution=null;return true}
    const d=UnitDefinition.get(u.type).chargedSkill,step=Math.min(e.remaining,d.speed/sim.tps),oldX=u.x,oldY=u.y;
    const motion=sim.navigation.motion.move(u,u.x+e.dirX*step,u.y+e.dirY*step,'stop');sim.syncUnitSpatial(u);
    const moved=Math.hypot(u.x-oldX,u.y-oldY);e.remaining=Math.max(0,e.remaining-moved);u.movement.lastMoveTick=sim.tick;
    const r=sim.unitRadius(u.type),hitIds=new Set(e.hitIds);
    // Existing grid broadphase + existing impulses/PBD transfer readable momentum
    // through contacts. Each enemy receives damage once per bodily charge.
    sim.withNearbyUnits(u.x,u.y,r+step+sim.maxUnitRadius,indices=>{
      for(const i of indices){
        const target=sim.units[i];if(!sim.isHostileCombatUnit(u.side,target)||!sim.canAttackEntity(u.type,target,false)||sim.unitLayer(target.type)!=="GROUND"||hitIds.has(target.id))continue;
        const vx=u.x-oldX,vy=u.y-oldY,len2=vx*vx+vy*vy,t=len2?RangeUtil.clamp(((target.x-oldX)*vx+(target.y-oldY)*vy)/len2,0,1):0;
        if(Math.hypot(target.x-oldX-vx*t,target.y-oldY-vy*t)>r+sim.unitRadius(target.type)+3)continue;
        hitIds.add(target.id);sim.applyDamage(u.side,u.type,target,false,d.damage,u.id,{damageClass:UnitDefinition.damageClass(u.type)});
        if(target.alive)sim.addUnitImpulse(target,target.x+e.dirX*100,target.y+e.dirY*100,70,sim.msTicks(400),850);
        sim.events.push({type:"chargeImpact",side:u.side,x:target.x,y:target.y,multiplier:1.6,sourceId:u.id,sourceType:u.type});
      }
    });
    e.hitIds=[...hitIds].sort();
    if(motion.hit||e.remaining<.5||moved<.01){u.behaviorState.chargedExecution=null;u.behaviorState.chargedRecoveryUntil=Math.max(u.behaviorState.chargedRecoveryUntil,sim.tick+sim.msTicks(450))}
    return true;
  }
}
class PullerMixin extends UnitCapability{
  static KEY="puller";static supports(_u,d){return Number(d.hookRange)>0}static stateDefaults={"behavior":{"hookCooldownUntil":0}};
  constructor(owner){super(owner,PullerMixin.KEY)}
  tryPull(sim,target,visibleSources){
    const u=this.owner;if(!target||!sim.isHostileCombatUnit(u.side,target))return false;
    const d=UnitDefinition.get(u.type),ability=sim.hasAbility(u.side,u.type),cooldown=sim.msTicks(d.hookCooldownMs);
    if(sim.tick<(u.behaviorState.hookCooldownUntil||0)||sim.clawRetargetBlocked(target,u.side)||Math.hypot(target.x-u.x,target.y-u.y)>d.hookRange)return false;
    if(!sim.specialRoleEligible(target,DIVE_BACKLINE_ROLES)||!sim.canTargetUnit(u.side,target,visibleSources))return false;
    const travelTicks=sim.msTicks(d.hookTravelMs||300),fromX=target.x,fromY=target.y;
    // Reserve both source cooldown and victim retarget lock at cast time so multiple claws
    // cannot claim the same victim while the visible hook is still travelling.
    if(u.side===0)target.behaviorState.clawRetargetBlockedUntil0=sim.tick+cooldown;else if(u.side===1)target.behaviorState.clawRetargetBlockedUntil1=sim.tick+cooldown;
    u.behaviorState.hookCooldownUntil=sim.tick+cooldown;
    sim.queueDelayedEffect({kind:"clawHookImpact",executeTick:sim.tick+travelTicks,sourceId:u.id,sourceType:u.type,side:u.side,targetId:target.id,ability,impulseDistance:d.hookImpulseDistance||96,impulseTicks:sim.msTicks(d.hookImpulseMs||400),impulseDecay:d.hookImpulseDecay||780,airborneTicks:sim.msTicks(d.hookAirborneMs||1000),airborneHeight:d.hookAirborneHeight||28});
    sim.events.push({type:"clawHookLaunch",side:u.side,x:u.x,y:u.y,fromX,fromY,sourceId:u.id,sourceType:u.type,targetId:target.id,targetType:target.type,travelTicks,travelMs:d.hookTravelMs||300,arcHeight:d.hookArcHeight||90,retractMs:d.hookRetractMs||220,pullTicks:sim.msTicks(d.hookImpulseMs||400)});
    return true;
  }
}
class StealthMixin extends UnitCapability{
  static KEY="stealth";static supports(_u,d){return !!d.stealth}constructor(owner){super(owner,StealthMixin.KEY)}
  isActive(){return !!this.owner?.alive}
}
class CloakAuraMixin extends UnitCapability{
  static KEY="cloakAura";static supports(_u,d){return Number(d.cloakAuraRadius)>0}constructor(owner){super(owner,CloakAuraMixin.KEY)}
  static canAffect(source,target){
    if(!source?.alive||!target?.alive||source.side!==target.side||source.id===target.id)return false;
    const d=UnitDefinition.get(source.type);
    if(!(Number(d?.cloakAuraRadius)>0))return false;
    if(d.cloakAuraExcludeSameType&&target.type===source.type)return false;
    return true;
  }
  radius(){return Number(UnitDefinition.get(this.owner.type)?.cloakAuraRadius)||0}
}
class ShieldProviderMixin extends UnitCapability{
  static KEY="shieldProvider";static supports(_u,d){return Number(d.guardChargeRadius)>0}static stateDefaults={"root":{"nextGuardChargeTick":0}};
  constructor(owner){super(owner,ShieldProviderMixin.KEY)}
  update(sim){
    const u=this.owner;if(!u?.alive||(u.side!==0&&u.side!==1))return 0;
    const d=UnitDefinition.get(u.type),ability=sim.hasAbility(u.side,u.type),radius=d.guardChargeRadius||0,cost=Math.max(1,Math.round(Number(d.guardManaCost)||10)),intervalMs=(Number(d.guardPulseIntervalMs)||1000)*(ability?(Number(d.abilityGuardPulseIntervalPct)||100)/100:1),interval=Math.max(1,sim.msTicks(intervalMs)),maxTargets=Math.max(1,Math.round(Number(d.guardTargetsPerPulse)||3));
    if(!u.nextGuardChargeTick)u.nextGuardChargeTick=sim.tick+interval;if(sim.tick<u.nextGuardChargeTick)return 0;u.nextGuardChargeTick=sim.tick+interval;
    const affordable=Math.min(maxTargets,Math.floor((Number(u.resources.mana)||0)/cost));if(affordable<=0)return 0;const candidates=[];
    for(const idx of sim.nearbyUnits(u.x,u.y,radius,u.side)){const ally=sim.units[idx];if(!ally?.alive||ally.side!==u.side||ally.id===u.id||UnitDefinition.get(ally.type)?.economyWorker||!sim.isPlayerCombatUnit(ally.side,ally.type)||Math.hypot(ally.x-u.x,ally.y-u.y)>radius||(Number(ally.hitGuard)||0)>0)continue;candidates.push(ally)}
    if(!candidates.length)return 0;candidates.sort((a,b)=>a.id<b.id?-1:a.id>b.id?1:0);const pulseIndex=Math.floor(sim.tick/interval),start=(HashUtil.hash(String(u.id))+pulseIndex)%candidates.length;let granted=0;
    for(let step=0;step<candidates.length&&granted<affordable;step++){const ally=candidates[(start+step)%candidates.length];if(!sim.consumeUnitMana(u,cost))break;ally.hitGuard=1;ally.hitGuardSourceId=u.id;granted++}
    if(granted>0)sim.events.push({type:"guardCharge",side:u.side,x:u.x,y:u.y,radius,granted,sourceId:u.id,manaCost:granted*cost});return granted;
  }
}
/* Artillery composition contract:
   IS-A remains Unit(role=artillery). HAS-A mechanics are data-selected capabilities
   (deployment, projectilePattern). CAN-BE transient states live in behaviorState. */
class DeployableCombatMixin extends UnitCapability{
  static KEY="deployableCombat";static supports(_u,d){return !!d.deployment}static stateDefaults={"behavior":{"deploymentState":"mobile","deploymentUntil":0}};
  constructor(owner){super(owner,DeployableCombatMixin.KEY)}
  profile(){return UnitDefinition.get(this.owner.type)?.deployment||null}
  state(){return this.owner.behaviorState.deploymentState||"mobile"}
  setState(sim,state,until=0){const u=this.owner,prev=this.state();u.behaviorState.deploymentState=state;u.behaviorState.deploymentUntil=until;if(prev!==state)sim.events.push({type:"deploymentState",side:u.side,x:u.x,y:u.y,sourceId:u.id,sourceType:u.type,state,until})}
  tick(sim){const st=this.state(),until=Number(this.owner.behaviorState.deploymentUntil)||0;if((st==="deploying"||st==="undeploying")&&sim.tick>=until)this.setState(sim,st==="deploying"?"deployed":"mobile",0);return this.state()}
  ensureAttackReady(sim){const q=this.profile();if(!q)return true;const st=this.tick(sim);if(st==="deployed")return true;if(st==="mobile"){this.setState(sim,"deploying",sim.tick+sim.msTicks(Number(q.deployMs)||800));return false}return false}
  requestMovement(sim){const q=this.profile();if(!q)return true;const st=this.tick(sim);if(st==="mobile")return true;if(st==="undeploying")return false;this.setState(sim,"undeploying",sim.tick+sim.msTicks(Number(q.undeployMs)||400));return false}
}
class WorkerMixin extends UnitCapability{
  static KEY="worker";
  static supports(u){return !!UnitDefinition.get(u.type)?.economyWorker}
  static stateDefaults={"root":{"carry":0,"carryType":null,"workResourceType":"mineral","workState":"seek","buildTargetId":null,"mineId":null,"mineStartedAt":-1},"behavior":{"workerDropoffKey":"","workerDropoffId":null}};
  constructor(owner){super(owner,WorkerMixin.KEY)}
  mineElapsedTicks(sim){const u=this.owner;if((u.mineStartedAt??-1)<0)u.mineStartedAt=sim.tick;return Math.max(1,sim.tick-u.mineStartedAt+1)}
  resetMine(){this.owner.mineStartedAt=-1}
  static validateDropoff(state){
    if(typeof state.workerDropoffKey!=='string'||state.workerDropoffKey.length>65536||state.workerDropoffId!==null&&(typeof state.workerDropoffId!=='string'||state.workerDropoffId.length>256))throw new Error('Invalid worker dropoff state');
  }
  dropoff(sim){
    sim.navigation.sync();
    const u=this.owner,targets=sim.buildings.filter(b=>b.alive!==false&&b.complete&&b.side===u.side&&BuildingDefinition.get(b.type)?.isDropoff);
    const key=JSON.stringify([u.mineId,targets.map(b=>[b.id,b.type,b.x,b.y]).sort((a,b)=>String(a[0])<String(b[0])?-1:String(a[0])>String(b[0])?1:0)]),state=u.behaviorState;
    if(state.workerDropoffId===null&&state.workerDropoffKey===key+'|'+JSON.stringify(sim.navigation.topology.records))return null;
    if(state.workerDropoffKey===key){
      const found=targets.find(b=>b.id===state.workerDropoffId);
      if(found){
        const routeKey=InteractionGeometry.goal(u,found,'worker-dropoff').key,radius=sim.unitRadius(u.type),ignore=TerrainNavigation.ignoresBuildings(u),active=u.movement.routes[u.movement.routeIndex];
        // Normal return movement already has a handle. Search history only at
        // the transition from a different goal, before acquiring its handle.
        const matches=route=>{const path=sim.routePathStore.get(route.pathId);return path?.key===routeKey&&path.radius===radius&&path.ignore===ignore};
        const route=active&&matches(active)?active:u.movement.routes.find(matches),path=route&&sim.routePathStore.get(route.pathId);
        if(!route||path.length&&path.topology===sim.navigation.routeTopology(path))return found;
      }
    }
    const found=targets.length===1?targets[0]:sim.nearestInteractionTarget(u,targets,'worker-dropoff');
    state.workerDropoffKey=found?key:key+'|'+JSON.stringify(sim.navigation.topology.records);state.workerDropoffId=found?.id??null;return found;
  }
}
class ObjectiveMixin extends UnitCapability{
  static KEY="objective";static supports(_u,d){return !!d.objectiveKind}static stateDefaults={"root":{"objectiveCaptured":false,"objectiveCapturedScale":0,"objectiveLane":null,"objectiveLaneT":0,"objectiveAttackCount":0,"objectiveChargePending":false,"objectiveChargeActive":false,"objectiveChargeRemaining":0,"objectiveChargeHitIds":[],"objectiveBreathPhase":"idle","objectiveBreathTellUntil":0,"objectiveBreathUntil":0,"objectiveBreathNextTick":0,"objectiveBreathTargetId":null,"objectiveBreathDirX":1,"objectiveBreathDirY":0},"behavior":{"objectiveCampId":null,"objectiveAirCooldownUntil":0,"objectiveChargeDirX":0,"objectiveChargeDirY":0}};
  constructor(owner){super(owner,ObjectiveMixin.KEY)}
  cancelCharge(){const u=this.owner;u.objectiveChargePending=false;u.objectiveChargeActive=false;u.objectiveChargeRemaining=0;u.objectiveChargeHitIds=[]}
  pickBurrowTarget(sim){
    const u=this.owner,d=UnitDefinition.get(u.type)||{},range=Math.max(260,d.sight||500),clusterRadius=92;let best=null,bestCount=-1,bestD=Infinity;
    sim.withNearbyUnits(u.x,u.y,range,null,candidates=>{
      for(const idx of candidates){
        const e=sim.units[idx];if(!sim.objectiveIsEnemy(u,e)||Math.hypot(e.x-u.x,e.y-u.y)>range)continue;
        let count=0;
        sim.withNearbyUnits(e.x,e.y,clusterRadius,e.side,neighbors=>{
          for(const j of neighbors){const q=sim.units[j];if(q?.alive&&q.side===e.side&&Math.hypot(q.x-e.x,q.y-e.y)<=clusterRadius)count++}
        });
        const dist=Math.hypot(e.x-u.x,e.y-u.y);
        if(count>bestCount||(count===bestCount&&dist<bestD)||(count===bestCount&&dist===bestD&&best&&String(e.id)<String(best.id))){best=e;bestCount=count;bestD=dist}
      }
    });
    return best;
  }
}

export { ChargedSkillMixin, CloakAuraMixin, DeployableCombatMixin, ObjectiveMixin, PullerMixin, ShieldProviderMixin, StealthMixin, WorkerMixin };
