// Unit combat and objective behavior tables and logic controllers.
import { RangeUtil } from '../core/game-rules.js';
import { ChargedSkillMixin, CloakAuraMixin, DeployableCombatMixin, ObjectiveMixin, PullerMixin, ShieldProviderMixin, StealthMixin, WorkerMixin } from './unit-mixins.js';
import { BurrowableMixin, ChargerMixin, CombatComponent, HealerMixin, InterceptorMixin, LeapableMixin, MovementComponent, ResourceComponent, SimTimerComponent, StateContract, StateValue, StatusComponent, SummonerMixin, TurnLimitedFlightMixin } from './components.js';
import { HashUtil } from './map-generation.js';
import { UnitDefinition } from '../definitions/units.js';
import { NEUTRAL_SIDE } from '../definitions/cards.js';
import { PIKE_KNOCKBACK_DISTANCE, PIKE_KNOCKBACK_LOCK_MS, SWARM_CARCASS_PIECES, SWARM_NEARBY_RADIUS } from '../definitions/world-rules.js';

const NEUTRAL_BEHAVIORS=Object.freeze({
  seedwasp:Object.freeze({
    preUpdate(sim,u){
      if(u.summonerId&&u.neutralSummonExpireTick&&sim.tick>=u.neutralSummonExpireTick){u.hp=0;u.alive=false;sim.events.push({type:"neutralSummonExpired",side:NEUTRAL_SIDE,x:u.x,y:u.y,sourceId:u.summonerId,sourceType:"queenwasp",unitId:u.id,unitType:u.type});return {handled:true,winner:null}}
      return null;
    }
  }),
  wildhound:Object.freeze({
    preUpdate(sim,u){
      if(!u.leapActive)return null;const d=UnitDefinition.get(u.type),wasActive=u.leapActive,st=u.capability(LeapableMixin.KEY)?.update(sim);
      if(wasActive&&!u.leapActive&&u.neutralLeapLandingPending){u.neutralLeapLandingPending=false;const winner=sim.neutralAreaHit(u,u.x,u.y,d.leapSplashRadius||75,Math.round(d.atk*(d.leapSplashDamagePct||200)/100));if(winner)return {handled:true,winner}}
      return st?.active?{handled:true,winner:st.winner}:null;
    },
    beforeAttack(sim,u,target,dist){
      const d=UnitDefinition.get(u.type);if(sim.tick<(u.neutralLeapReadyTick||0)||dist>d.leapRange)return false;
      if(u.capability(LeapableMixin.KEY)?.start(sim,target,false)){u.neutralLeapReadyTick=sim.tick+sim.msTicks(d.leapCooldownMs);u.neutralLeapLandingPending=true;return true}return false;
    }
  }),
  sporetoad:Object.freeze({
    stateDefaults:{root:{"objectiveBreathPhase":"idle","objectiveBreathTellUntil":0,"objectiveBreathUntil":0,"objectiveBreathNextTick":0,"objectiveBreathTargetId":null,"objectiveBreathDirX":1,"objectiveBreathDirY":0}},

    preUpdate(sim,u){if(!sim.objectiveDragonBreathIsActive(u))return null;const st=sim.updateNeutralBreath(u);return st.active||st.winner?{handled:true,winner:st.winner}:null},
    afterAttackCommitted(sim,u,target){
      const d=UnitDefinition.get(u.type),chance=RangeUtil.clamp(Number(d.breathChance)||0,0,1);
      // Stateless deterministic chance: no shared RNG stream, stable across peers/recovery.
      let bits=HashUtil.hash(`${sim.seed}|${u.id}|neutral-breath|${u.neutralAttackCount||0}`)>>>0;
      bits^=bits>>>16;bits=Math.imul(bits,0x7feb352d)>>>0;bits^=bits>>>15;bits=Math.imul(bits,0x846ca68b)>>>0;bits^=bits>>>16;
      if((bits>>>0)/4294967296<chance)sim.startNeutralBreath(u,target);
    }
  }),
  queenwasp:Object.freeze({preUpdate(sim,u){sim.updateNeutralQueen(u);return null},onCampReturn(_sim,u){u.nextNeutralSummonTick=0}})
});
const UNIT_COMBAT_BEHAVIORS=Object.freeze({
  shellbug:Object.freeze({
    updatePosture(sim,u,found,ability){
      if(!ability){u.movement.crouchStartedAt=-1;u.movement.crouched=false;return}
      const d=UnitDefinition.get(u.type),engaged=!!found,stationary=sim.ticksMs(sim.tick-(u.movement.lastMoveTick??-999999))>=100;
      if(engaged&&stationary){
        if((u.movement.crouchStartedAt??-1)<0)u.movement.crouchStartedAt=sim.tick;
        u.movement.crouched=(sim.tick-u.movement.crouchStartedAt+1)>=sim.msTicks(d.crouchPrepMs||2250);
      }else{u.movement.crouchStartedAt=-1;u.movement.crouched=false}
    }
  }),
  swarmbug:Object.freeze({
    modifyCombatStats(sim,u,stats,ability){
      if(!ability)return stats;
      const swarm=sim.nearbyUnitScaling(u,{sameType:true,radius:SWARM_NEARBY_RADIUS,countPerStep:2,maxSteps:4,movePctPerStep:5,attackSpeedPctPerStep:10});
      stats.moveSpeed*=swarm.movePct/100;stats.cooldown*=100/swarm.attackSpeedPct;return stats;
    },
    onDeath(sim,target){
      if(!(target.side===0||target.side===1)||!sim.hasAbility(target.side,target.type))return;
      const d=UnitDefinition.get(target.type)||{},radius=Number(d.carcassConsumeRadius)||SWARM_NEARBY_RADIUS,pieces=Math.max(1,Math.round(Number(d.carcassPieces)||SWARM_CARCASS_PIECES));
      const candidates=[];
      for(const idx of sim.nearbyUnits(target.x,target.y,radius,target.side)){
        const ally=sim.units[idx];if(!ally?.alive||ally.id===target.id||ally.side!==target.side||ally.type!==target.type)continue;
        const dx=ally.x-target.x,dy=ally.y-target.y,dist2=dx*dx+dy*dy;if(dist2>radius*radius)continue;
        candidates.push({ally,dist2});
      }
      candidates.sort((a,b)=>a.dist2-b.dist2||String(a.ally.id).localeCompare(String(b.ally.id)));
      const healPerPiece=Math.max(1,Math.round((Number(d.hp)||Number(target.maxHp)||1)/pieces));
      for(const {ally} of candidates.slice(0,pieces)){
        const before=ally.hp;ally.hp=Math.min(Number(UnitDefinition.get(ally.type)?.hp)||ally.hp,ally.hp+healPerPiece);
        const healed=Math.max(0,ally.hp-before);
        sim.events.push({type:"swarmCarcassConsume",side:target.side,x:target.x,y:target.y,targetId:ally.id,targetX:ally.x,targetY:ally.y,amount:healed,pieceHeal:healPerPiece,sourceId:target.id,sourceType:target.type});
      }
    }
  }),
  mantis:Object.freeze({
    stateDefaults:{"behavior":{"ambushReady":false}},

    init(_sim,u){u.behaviorState.ambushReady=true},
    onNoTarget(_sim,u){u.behaviorState.ambushReady=true},
    modifyMelee(sim,u,mult,target){
      const d=UnitDefinition.get(u.type);if(sim.isStealthed(u)&&u.behaviorState.ambushReady){u.behaviorState.ambushReady=false;sim.events.push({type:"ambush",side:u.side,x:target.x,y:target.y,targetType:target.type});return mult*(d.ambushDamage||1.5)}return mult;
    }
  }),
  sporefly:Object.freeze({
    maneuverBeforeAttack(sim,u,target,_isBuilding,speed,attackRange,dist){
      const flight=u.capability(TurnLimitedFlightMixin.KEY),cfg=flight?.config(sim);if(!cfg)return false;
      const engage=Math.max(attackRange,Number(cfg.engageRadius)||150);if(dist>engage)return false;
      const boosted=speed*Math.max(1,Number(cfg.speedPct)||200)/100;
      const max=sim.interactionDistance(u,target,"attack",attackRange),winding=u.combat.windupPending();
      if(winding){if(dist>max){sim.clearAttackWindup(u);flight.move(sim,target.x,target.y,boosted);return true}return false}
      flight.move(sim,target.x,target.y,boosted);if(dist>max||!flight.facingAllowsAttack(sim,target))return true;return false;
    }
  }),
  carriermite:Object.freeze({
    stateDefaults:{"behavior":{"carrierFlightState":"active"},"root":{"carrierSlot":0}},

    summoner(sim,u){return sim.unitById.get(u.summonerId)||sim.units.find(x=>x.id===u.summonerId&&x.alive)||null},
    flight(u){return u.capability(TurnLimitedFlightMixin.KEY)},
    turnLimitedMove(sim,u,tx,ty,speed){return this.flight(u)?.move(sim,tx,ty,speed)??sim.moveToward(u,tx,ty,speed)},
    facingAllowsAttack(sim,u,target){return this.flight(u)?.facingAllowsAttack(sim,target)??true},
    flightState(u){return u.behaviorState.carrierFlightState||"active"},
    setFlightState(sim,u,state){
      if(this.flightState(u)===state)return;
      u.behaviorState.carrierFlightState=state;
      sim.clearAttackWindup(u);u.target=null;
    },
    retreatThreshold(u){const d=UnitDefinition.get(u.type)||{};return u.maxHp*Math.max(0,Number(d.carrierRetreatHpPct)||50)/100},
    forcedMove(sim,u,speed){const carrier=this.summoner(sim,u);if(carrier?.alive){this.turnLimitedMove(sim,u,carrier.x,carrier.y,speed);return true}return false},
    preCombat(sim,u,speed){
      const carrier=this.summoner(sim,u);if(!carrier?.alive){u.alive=false;return true}
      const d=UnitDefinition.get(u.type)||{},state=this.flightState(u),dist=Math.hypot(u.x-carrier.x,u.y-carrier.y),dock=Math.max(25,Number(d.carrierDockRadius)||50);
      if(state==="active"&&u.hp<=this.retreatThreshold(u))this.setFlightState(sim,u,"retreat");
      if(this.flightState(u)==="retreat"){
        if(dist<=dock){
          const queue=Array.isArray(carrier.behaviorState.carrierRecoveryQueue)?carrier.behaviorState.carrierRecoveryQueue:(carrier.behaviorState.carrierRecoveryQueue=[]);
          queue.push({slot:Math.max(0,Math.round(Number(u.carrierSlot)||0)),hp:Math.max(0,Math.min(u.maxHp,Number(u.hp)||0))});
          sim.clearAttackWindup(u);u.target=null;u.alive=false;
          sim.events.push({type:"carrierMiteDocked",side:u.side,x:carrier.x,y:carrier.y,sourceId:carrier.id,unitId:u.id,slot:u.carrierSlot,hp:u.hp,maxHp:u.maxHp});
          return true;
        }
        this.turnLimitedMove(sim,u,carrier.x,carrier.y,speed);return true;
      }
      if(dist>(Number(d.aggroRange)||650)){this.turnLimitedMove(sim,u,carrier.x,carrier.y,speed);return true}
      return false;
    },
    onNoTarget(sim,u){
      // Outside combat, any missing HP uses the same dock/recovery cycle as the <=50% combat retreat.
      if(u.hp<u.maxHp)this.setFlightState(sim,u,"retreat");
    },
    noTarget(sim,u,speed){return this.forcedMove(sim,u,speed)},
    validateTarget(sim,u,target,speed){const carrier=this.summoner(sim,u),rr=Number(UnitDefinition.get(u.type)?.aggroRange)||650;if(!carrier?.alive||Math.hypot(target.x-carrier.x,target.y-carrier.y)>rr){sim.clearAttackWindup(u);u.target=null;if(carrier?.alive)this.turnLimitedMove(sim,u,carrier.x,carrier.y,speed);return false}return true},
    maneuverBeforeAttack(sim,u,target,isBuilding,speed,attackRange,dist){
      const max=sim.interactionDistance(u,target,"attack",attackRange);
      const winding=u.combat.windupPending();
      // Enter the attack run through the forward hemisphere. Once a legal shot
      // has committed to wind-up, normal target/range validation owns cancellation;
      // steering must not repeatedly erase the shot merely because the mite arcs past 90°.
      if(winding){
        if(dist>max){sim.clearAttackWindup(u);this.turnLimitedMove(sim,u,target.x,target.y,speed);return true}
        return false;
      }
      this.turnLimitedMove(sim,u,target.x,target.y,speed);
      if(dist>max||!this.facingAllowsAttack(sim,u,target))return true;
      return false;
    }
  }),
  ancientmistray:Object.freeze({
    stateDefaults:{"behavior":{"adaptiveRangeCache":0,"adaptiveMoveSpeedCache":0,"adaptiveRangeCacheTick":-999999}},

    forcedMove(sim,u,speed){
      if(!sim.hasAbility(u.side,u.type))return false;
      const f=sim.flags[u.side];sim.moveToward(u,f.x,f.y,Math.max(speed,sim.adaptiveFormationMoveSpeed(u)));return true;
    },
    modifyCombatStats(sim,u,stats,ability){
      if(!ability)return stats;
      return{...stats,moveSpeed:Math.max(stats.moveSpeed,sim.adaptiveFormationMoveSpeed(u))};
    },
    holdAdaptiveRange(sim,u,target,isBuilding,ability,dist){
      if(!ability||isBuilding||!u.combat.cooldownActive(sim))return false;
      const d=UnitDefinition.get(u.type),preferred=sim.adaptivePreferredRange(u);
      return dist<=preferred&&dist>sim.interactionDistance(u,target,"attack",d.range);
    }
  }),
  rootstalker:Object.freeze({
    stateDefaults:{"behavior":{"rootSetupTicks":0,"rootTargetId":null},"presentation":["rootSetupTicks","rootTargetId"]},

    onWindupClear(_sim,u){u.behaviorState.rootSetupTicks=0;u.behaviorState.rootTargetId=null},
    onWindupStart(_sim,u,target){u.behaviorState.rootSetupTicks=0;u.behaviorState.rootTargetId=target.id},
    onWindupTick(sim,u){u.behaviorState.rootSetupTicks=u.combat.windupElapsedTicks(sim)},
    resolveAttack(sim,u,target,isBuilding,attackValue,attackRange,_ability){
      if(isBuilding)return null;
      const d=UnitDefinition.get(u.type);return {handled:true,winner:sim.rootLineAttack(u,target,attackValue,attackRange,d.lineWidth||34)};
    }
  }),
  chainflower:Object.freeze({
    resolveAttack(sim,u,target,isBuilding,attackValue,_attackRange,_ability){
      if(isBuilding)return null;
      const d=UnitDefinition.get(u.type);return {handled:true,winner:sim.chainFlowerAttack(u,target,attackValue,d.chainBounces||2,d.chainRange||118)};
    }
  }),
  deepthorn:Object.freeze({
    resolveAttack(sim,u,target,isBuilding,attackValue,_attackRange,ability){
      const d=UnitDefinition.get(u.type),radius=d.spikeRadius||58,airborneTicks=sim.msTicks(d.airborneMs||850),airborneHeight=d.airborneHeight||52;
      const winner=sim.deepThornAttack(u,target,isBuilding,attackValue,radius,airborneTicks,airborneHeight);
      if(ability){
        const count=Math.max(1,Math.round(d.secondaryCount||3)),step=(Number(d.secondaryAngleStepDeg)||120)*Math.PI/180,offsetRadius=Math.max(0,Number(d.secondaryOffsetRadius)||100);
        // One deterministic random rotation per attack; the three eruptions remain exactly 120° apart.
        let bits=HashUtil.hash(`${sim.seed}|${u.id}|deepthorn-secondary|${u.combat?.attackSequence||0}|${sim.tick}`)>>>0;
        bits^=bits>>>16;bits=Math.imul(bits,0x7feb352d)>>>0;bits^=bits>>>15;bits=Math.imul(bits,0x846ca68b)>>>0;bits^=bits>>>16;
        const baseAngle=((bits>>>0)/4294967296)*Math.PI*2;
        for(let i=0;i<count;i++){
          const a=baseAngle+i*step,x=target.x+Math.cos(a)*offsetRadius,y=target.y+Math.sin(a)*offsetRadius;
          sim.queueDelayedEffect({kind:"areaDamage",executeTick:sim.tick+sim.msTicks(d.secondaryDelayMs||300),side:u.side,sourceType:u.type,sourceId:u.id,x,y,radius:d.secondaryRadius||50,damage:Math.max(1,Math.round(attackValue*(d.secondaryDamageScale||.5))),damageClass:"area",airborneTicks:sim.msTicks((d.airborneMs||0)*(d.secondaryAirborneScale||.5),{min:0}),airborneHeight:d.secondaryAirborneHeight||25,eventType:"deepThornSecondary"});
        }
      }
      return {handled:true,winner};
    }
  }),
  aegisbeetle:Object.freeze({
    resolveAttack(sim,u,target,isBuilding,attackValue){
      const d=UnitDefinition.get(u.type),continuous=sim.continuousDamageProfile(d.continuous),capture={dealt:0,blocked:false},pulseDamage=continuous?continuous.damagePerTick:attackValue,winner=sim.applyDamage(u.side,u.type,target,isBuilding,pulseDamage,u.id,{damageClass:"normal",capture,damageDelivery:continuous?"continuous":"hit",deliverySeconds:continuous?.deliverySeconds||0});
      u.combat.attackArcTargetId=target.id;u.combat.attackArcUntilTick=sim.tick+sim.msTicks(Math.max(500,d.cooldownMs||200));
      sim.events.push({type:"chainArc",side:u.side,sourceId:u.id,sourceType:u.type,x:u.x,y:u.y,x2:target.x,y2:target.y,targetId:target.id,targetType:target.type,points:[{x:u.x,y:u.y,type:u.type},{x:target.x,y:target.y,type:target.type}],aegisArc:true});
      return {handled:true,winner};
    }
  }),
  burrowbeast:Object.freeze({
    afterMeleeHit(sim,u,target,attackValue,mult){
      const d=UnitDefinition.get(u.type),radius=d.meleeSplashRadius||64,scale=d.meleeSplashScale||.48;
      sim.events.push({type:"burrowMelee",side:u.side,x:target.x,y:target.y,radius,sourceId:u.id});
      sim.withNearbyUnits(target.x,target.y,radius,indices=>{for(const idx of indices){const e=sim.units[idx];if(!e?.alive||e.id===target.id||e.side===u.side||!sim.canAttackEntity(u.type,e,false))continue;if(Math.hypot(e.x-target.x,e.y-target.y)<=radius)sim.applyDamage(u.side,u.type,e,false,Math.floor(attackValue*mult*scale),u.id,{damageClass:"area"})}});
    }
  }),
  kickhopper:Object.freeze({
    afterMeleeHit(sim,u,target,attackValue,mult,ability){
      const d=UnitDefinition.get(u.type),airborneTicks=sim.msTicks(ability?(d.abilityAirborneMs||400):(d.airborneMs||300)),airborneHeight=ability?(d.abilityAirborneHeight||28):(d.airborneHeight||22);
      sim.applyAirborne(target,{durationTicks:airborneTicks,height:airborneHeight,sourceSide:u.side,sourceType:u.type});
      if(!ability)return;
      const radius=d.abilitySplashRadius||55,scale=d.abilitySplashScale||.45;
      sim.withNearbyUnits(target.x,target.y,radius,indices=>{for(const idx of indices){const e=sim.units[idx];if(!e?.alive||e.id===target.id||e.side===u.side||!sim.canAttackEntity(u.type,e,false))continue;if(Math.hypot(e.x-target.x,e.y-target.y)<=radius)sim.applyDamage(u.side,u.type,e,false,Math.max(1,Math.floor(attackValue*mult*scale)),u.id,{damageClass:"area"})}});
      sim.events.push({type:"kickhopperSplash",side:u.side,x:target.x,y:target.y,radius,sourceId:u.id,targetId:target.id});
    }
  }),
  pikeman:Object.freeze({
    afterMeleeHit(sim,u,target,_attackValue,_mult,ability){sim.applyKnockback(u,target,{distance:ability?34:PIKE_KNOCKBACK_DISTANCE,roleMultiplier:ability?{charger:1.55}:{charger:1.35},sizeMultiplier:{light:1,medium:.88,heavy:.72},lockTicks:sim.msTicks(PIKE_KNOCKBACK_LOCK_MS)})}
  }),
  shelltitan:Object.freeze({
    afterMeleeHit(sim,u,target,attackValue){
      const d=UnitDefinition.get(u.type),ability=sim.hasAbility(u.side,u.type),radius=d.slamRadius||92,scale=d.slamScale||.48;
      sim.withNearbyUnits(target.x,target.y,radius,indices=>{for(const idx of indices){const e=sim.units[idx];if(!e?.alive||e.side===u.side||e.id===target.id)continue;if(Math.hypot(e.x-target.x,e.y-target.y)<=radius)sim.applyDamage(u.side,u.type,e,false,Math.floor(attackValue*scale),u.id,{damageClass:"area"})}});
      if(ability){sim.applyAreaKnockback({sourceSide:u.side,sourceType:u.type,sourceEntityId:u.id,x:target.x,y:target.y,radius,distance:d.slamKnockbackDistance||28,lockTicks:sim.msTicks(250)});sim.applyAreaAirborne({sourceSide:u.side,sourceType:u.type,x:target.x,y:target.y,radius,durationTicks:sim.msTicks(d.slamAirborneMs||300),height:d.slamAirborneHeight||24})}
      sim.events.push({type:"titanSlam",side:u.side,x:target.x,y:target.y,radius,sourceId:u.id,targetId:target.id});
    }
  }),
  seedwasp:Object.freeze({
    onDeath(sim,target,sourceSide){
      if(!target.summonerId||!(sourceSide===0||sourceSide===1))return null;
      const d=UnitDefinition.get(target.type),radius=d.deathExplosionRadius||75,damage=Math.max(1,Math.round((d.atk||1)*(d.deathExplosionDamagePct||300)/100));
      sim.withNearbyUnits(target.x,target.y,radius+sim.maxUnitRadius,indices=>{for(const idx of indices){const e=sim.units[idx];if(!e?.alive||e.side!==sourceSide)continue;if(Math.hypot(e.x-target.x,e.y-target.y)>radius+sim.unitRadius(e.type))continue;sim.applyDamage(NEUTRAL_SIDE,target.type,e,false,damage,target.id,{damageClass:"area"})}});
      sim.events.push({type:"seedWaspDeathExplosion",side:NEUTRAL_SIDE,x:target.x,y:target.y,radius,damage,sourceId:target.id,sourceType:target.type});return null;
    }
  }),
  tank:Object.freeze({
    modifyIncomingDamage(sim,target,dmg,sourceDef){
      if(!sim.hasAbility(target.side,target.type)||!sourceDef.projectile)return dmg;
      const d=UnitDefinition.get(target.type),base=d.rangedReduction||70,reduced=d.abilityRangedReduction||50;return Math.max(1,Math.floor(dmg*reduced/base));
    }
  }),
  thornfruit:Object.freeze({
    afterDamaged(sim,target,ctx){
      if(target.alive===false||ctx.sourceSide===target.side)return null;
      sim.thornReflectDamage(target,ctx.sourceType,ctx.sourceEntityId,ctx.options);
      if(!sim.hasAbility(target.side,target.type))return null;
      const d=UnitDefinition.get(target.type),burstRadius=sim.hasSpecialResearch(target.side,"thornfruitSpines")?(d.abilityHitBurstRadius||175):(d.hitBurstRadius||100),windowTicks=sim.msTicks(d.hitBurstWindowMs)||sim.tps;
      const history=(target.recentHitTicks||[]).filter(tick=>sim.tick-tick<windowTicks);history.push(sim.tick);target.recentHitTicks=history;
      if(history.length<(d.hitBurstThreshold||4)||sim.tick<(target.combat.hitBurstCooldownUntil||0))return null;
      target.recentHitTicks=[];target.combat.hitBurstCooldownUntil=sim.tick+sim.msTicks(d.hitBurstCooldownMs||1000);
      sim.events.push({type:"thornBurst",side:target.side,x:target.x,y:target.y,radius:burstRadius,sourceId:target.id,sourceType:target.type});
      return sim.applyAreaDamage({sourceSide:target.side,sourceType:target.type,sourceEntityId:target.id,x:target.x,y:target.y,radius:burstRadius,damage:d.hitBurstDamage||20,damageClass:"area"});
    }
  }),
  pillbug:Object.freeze({
    stateDefaults:{"root":{"pillbugBlastDone":false}},

    onDeath(sim,target){return sim.triggerPillbugBlast(target,UnitDefinition.get(target.type).deathDamageScale||.65,UnitDefinition.get(target.type).deathSplash||78)}
  })
});

const OBJECTIVE_BEHAVIORS=Object.freeze({
  ancientbear:Object.freeze({
    updateActive(sim,u){
      if(u.objectiveChargeActive)return u.capability(ChargerMixin.KEY)?.updateObjective(sim)||{active:false,winner:null};
      return {active:false,winner:null};
    },
    attack(sim,u,target,isBuilding){
      const d=UnitDefinition.get(u.type),dist=Math.hypot(target.x-u.x,target.y-u.y)||1;
      if(sim.unitLayer(target.type)==="AIR"&&!isBuilding){
        if(dist>sim.interactionDistance(u,target,"attack",d.airRange||220)){sim.moveToInteraction(u,target,"attack",d.speed,d.airRange||220);return null}
        if(sim.tick<(u.behaviorState.objectiveAirCooldownUntil||0))return null;
        u.behaviorState.objectiveAirCooldownUntil=sim.tick+Math.max(1,sim.msTicks(Math.round(d.airCooldownMs||3000)));u.attackFlash=1;
        sim.spawnProjectile({id:"p"+(++sim.seq),owner:u.id,side:u.side,type:u.type,x:u.x,y:u.y,target:target.id,isBuilding:false,speed:d.projectile||250,damage:d.airDamage||60,splash:d.airSplash||60,splashScale:1,damageClass:"area",visualTag:"bearRock"});
        sim.events.push({type:"objectiveBearThrow",side:u.side,x:u.x,y:u.y,targetId:target.id,sourceId:u.id,sourceType:u.type});return null;
      }
      if(u.objectiveChargePending&&(isBuilding||sim.unitLayer(target.type)==="GROUND")&&u.capability(ChargerMixin.KEY)?.startObjective(sim,target))return null;
      const max=sim.interactionDistance(u,target,"attack",d.range);if(dist>max){sim.clearAttackWindup(u);sim.moveToInteraction(u,target,"attack",d.speed,d.range);return null}
      if(!sim.attackReadyAfterWindup(u,target,isBuilding,d,d.range,false))return null;
      sim.commitAttackTiming(u,d);let winner=sim.applyDamage(u.side,u.type,target,isBuilding,d.atk,u.id);
      if(!isBuilding&&sim.unitLayer(target.type)==="GROUND"){sim.applyKnockbackFromPoint(u,target,u.x,u.y,{distance:38,lockTicks:sim.msTicks(250),sizeMultiplier:{light:1,medium:.82,heavy:.62}});sim.applyAirborne(target,{durationTicks:sim.msTicks(d.shockAirborneMs||3000),height:d.shockAirborneHeight||72,sourceSide:u.side,sourceType:u.type})}
      const w=sim.objectiveBearShockwave(u,target.x,target.y,target.id,d.shockDamage||50);if(w)winner=w;u.objectiveAttackCount=(u.objectiveAttackCount||0)+1;if(u.objectiveAttackCount%(d.chargeEvery||3)===0)u.objectiveChargePending=true;return winner;
    }
  }),
  deathworm:Object.freeze({
    updateActive(sim,u){return u.capability(BurrowableMixin.KEY)?.isActive()?u.capability(BurrowableMixin.KEY).update(sim):{active:false,winner:null}},
    attack(sim,u,target,isBuilding){
      const d=UnitDefinition.get(u.type),dist=Math.hypot(target.x-u.x,target.y-u.y)||1,max=sim.interactionDistance(u,target,"attack",d.range);
      if(dist>max){sim.clearAttackWindup(u);sim.moveToInteraction(u,target,"attack",d.speed,d.range);return null}
      if(!sim.attackReadyAfterWindup(u,target,isBuilding,d,d.range,false))return null;
      sim.commitAttackTiming(u,d);u.objectiveAttackCount=(u.objectiveAttackCount||0)+1;const rupture=u.objectiveAttackCount%(d.ruptureEvery||4)===0;
      sim.spawnProjectile({id:"p"+(++sim.seq),owner:u.id,side:u.side,type:u.type,x:u.x,y:u.y,target:target.id,isBuilding,speed:d.projectile||620,damage:d.atk,splash:rupture?(d.ruptureRadius||60):0,splashScale:1,splashBuildings:rupture,damageClass:rupture?"area":"normal",visualTag:rupture?"rupture":"needle"});
      sim.events.push({type:rupture?"objectiveWormRuptureShot":"shoot",side:u.side,x:u.x,y:u.y,unit:u.type,sourceId:u.id,targetId:target.id,targetType:target.type});
      if(u.objectiveAttackCount%(d.burrowEvery||20)===0){const dense=u.capability(ObjectiveMixin.KEY)?.pickBurrowTarget(sim);if(dense)u.capability(BurrowableMixin.KEY)?.startDive(sim,dense,{x:dense.x,y:dense.y,trackTarget:false})}
      return null;
    }
  }),
  dragon:Object.freeze({
    updateActive(sim,u,visionSources){return sim.objectiveDragonBreathIsActive(u)?sim.updateObjectiveDragonBreath(u,visionSources):{active:false,winner:null}},
    attack(sim,u,target,isBuilding,visionSources){
      const d=UnitDefinition.get(u.type);if(sim.objectiveDragonBreathIsActive(u))return sim.updateObjectiveDragonBreath(u,visionSources).winner;
      const dist=Math.hypot(target.x-u.x,target.y-u.y)||1,max=sim.interactionDistance(u,target,"attack",d.range);if(dist>max){sim.clearAttackWindup(u);sim.moveToInteraction(u,target,"attack",d.speed,d.range);return null}
      if(!sim.attackReadyAfterWindup(u,target,isBuilding,d,d.range,false))return null;
      sim.commitAttackTiming(u,d);u.objectiveAttackCount=(u.objectiveAttackCount||0)+1;
      sim.spawnProjectile({id:"p"+(++sim.seq),owner:u.id,side:u.side,type:u.type,x:u.x,y:u.y,target:target.id,isBuilding,speed:d.projectile||250,damage:d.atk,splash:d.splash||90,splashScale:1,splashBuildings:true,damageClass:"area",visualTag:"dragonFireball"});
      sim.events.push({type:"objectiveDragonFireball",side:u.side,x:u.x,y:u.y,targetId:target.id,sourceId:u.id,sourceType:u.type});if(u.objectiveAttackCount%(d.breathEvery||5)===0)sim.startObjectiveDragonBreath(u,target);return null;
    }
  })
});
const UNIT_CAPABILITY_MIXINS=Object.freeze([ChargedSkillMixin,BurrowableMixin,LeapableMixin,TurnLimitedFlightMixin,HealerMixin,SummonerMixin,InterceptorMixin,ChargerMixin,PullerMixin,StealthMixin,CloakAuraMixin,ShieldProviderMixin,DeployableCombatMixin,WorkerMixin,ObjectiveMixin]);
class DefaultUnitLogicController{
  constructor(owner,state={}){this.owner=owner;this.kind="default";this.state={...state}}
  update(sim,vision){return sim.updateCombat(this.owner,vision)}
  toState(){return StateValue.copy(this.state)}
}
class NeutralObjectUnitLogicController{
  constructor(owner,state={}){
    this.owner=owner;this.kind="neutral-object";
    this.state={campId:null,aggroed:false,returningHome:false,...state};
  }
  update(sim,_vision){return sim.updateNeutral(this.owner)}
  toState(){return StateValue.copy(this.state)}
}
class UnitLogicControllerFactory{
  static normalizeProfile(profile,side){
    const p=String(profile||"").trim();
    if(p==="default"||p==="neutral-object")return p;
    return side===NEUTRAL_SIDE?"neutral-object":"default";
  }
  static create(owner,profile=null,state={}){
    const normalized=this.normalizeProfile(profile,owner.side);
    return normalized==="neutral-object"?new NeutralObjectUnitLogicController(owner,state):new DefaultUnitLogicController(owner,state);
  }
}
class UnitStateContracts{
  static cache=new Map();
  static forType(type){
    let result=this.cache.get(type);if(result)return result;
    const root={hitGuard:0,hitGuardSourceId:null,hitFlash:0,attackFlash:0,target:null,recentHitTicks:[],summonerId:null,expireTick:0};
    const behavior={spawnActionLockUntilTick:0,basicAttackCount:0,attackCooldownResetRollCount:0,clawRetargetBlockedUntil0:0,clawRetargetBlockedUntil1:0};
    const presentation=[];
    const merge=spec=>{if(!spec)return;Object.assign(root,spec.root||{});Object.assign(behavior,spec.behavior||{});presentation.push(...(spec.presentation||[]))};
    const d=UnitDefinition.get(type)||{};
    for(const Feature of UNIT_CAPABILITY_MIXINS)if(Feature.supports({type},d))merge(Feature.stateDefaults);
    merge(UNIT_COMBAT_BEHAVIORS[type]?.stateDefaults);merge(NEUTRAL_BEHAVIORS[type]?.stateDefaults);
    const behaviorContract=new StateContract(behavior,{presentation,view:["chargedExecution","deploymentState","deploymentUntil","rootSetupTicks"]});
    const rootContract=new StateContract(root,{presentation:["hitFlash","attackFlash"],derived:["logicController","collisionIntentTick","collisionIntentTx","collisionIntentTy","collisionMoveTick","collisionMoveStartFx","collisionMoveStartFy"],children:{timers:SimTimerComponent.stateContract,status:StatusComponent.stateContract,resources:ResourceComponent.stateContract,movement:MovementComponent.stateContract,combat:CombatComponent.stateContract,behaviorState:behaviorContract}});
    result={root:rootContract,behavior:behaviorContract};this.cache.set(type,result);return result;
  }
}

export { NEUTRAL_BEHAVIORS, OBJECTIVE_BEHAVIORS, UNIT_CAPABILITY_MIXINS, UNIT_COMBAT_BEHAVIORS, UnitLogicControllerFactory, UnitStateContracts };
