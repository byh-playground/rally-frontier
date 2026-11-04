// AI observation, policy, planning and command execution.
import { SIM_TPS } from '../core/game-rules.js';
import { StateValue } from '../sim/components.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { StableSerializationUtil } from '../net/lobby-codec.js';
import { ResearchDefinition } from '../definitions/research.js';
import { BuildingDefinition, buildingPlacementSeparation } from '../definitions/buildings.js';
import { DefenseCardDefinition } from '../definitions/decks.js';
import { UnitDefinition } from '../definitions/units.js';
import { WORKER_COST, WORKER_QUEUE_LIMIT } from '../definitions/world-rules.js';
import { WorldContext } from '../sim/world-context.js';
import { SimulationTiming } from '../main.js';

/* =========================
   4.5 Single-player bot
   - 상대 입력 주체만 AI다.
   - 게임 상태 변경은 반드시 guest GameSession의 command()를 거친다.
   - 실제 싱글 연결은 NostrRtcTransport의 raw WebRTC 경로를 그대로 사용하고 signaling만 in-page local bus로 대체한다.
   ========================= */

// === AI decision architecture v33 ===
// Observation -> SituationAnalyzer -> Policy -> MacroAction -> existing deterministic executor.
// Policies never mutate simulation state directly, so a future learned policy can replace UtilityAiPolicy
// without changing production/build/movement execution contracts.
class AiObservationBuilder{
  static build(bot,state,p){
    const enemySide=1-bot.side;
    const ownProduction=bot.productionFacilityCount(state,bot.side);
    // Enemy values intentionally come from the bot perception snapshot (p) wherever practical.
    const visibleEnemyProduction=(p.enemyBuildings||[]).filter(b=>BuildingDefinition.get(b.type)?.isProductionBuilding).length;
    const ownBases=bot.workerBases(state).length;
    const visibleEnemyBases=(p.enemyBuildings||[]).filter(b=>BuildingDefinition.get(b.type)?.isDropoff).length;
    const ownWorkers=(p.ownWorkers||[]).length;
    const visibleEnemyWorkers=(p.enemyUnits||[]).filter(u=>!!UnitDefinition.get(u.type)?.economyWorker).length;
    const ownArmy=(p.ownArmy||[]).length;
    const visibleEnemyArmy=(p.enemyUnits||[]).filter(u=>!UnitDefinition.get(u.type)?.economyWorker).length;
    const neutralObjectives=(p.capturePoints||[]).filter(cp=>cp.enabled&&cp.owner==null).length;
    const ownedObjectives=(p.capturePoints||[]).filter(cp=>cp.enabled&&cp.owner===bot.side).length;
    const enemyObjectives=(p.capturePoints||[]).filter(cp=>cp.enabled&&cp.owner===enemySide).length;
    const wallet=Number(state.wallet?.[bot.side]||0),gas=Number(state.gasWallet?.[bot.side]||0);
    const queued=state.buildings.filter(b=>b.alive!==false&&b.side===bot.side&&BuildingDefinition.get(b.type)?.isProductionBuilding)
      .reduce((n,b)=>n+(Array.isArray(b.queue)?b.queue.length:0)+((b.productionRemaining||0)>0?1:0),0);
    const productionCapacity=Math.max(1,ownProduction);
    const spendPressure=Math.max(0,Math.min(3,wallet/(350*productionCapacity)));
    let nearbyThreat=0;
    for(const base of p.ownBuildings||[]){
      if(!BuildingDefinition.get(base.type)?.isDropoff)continue;
      for(const e of p.enemyUnits||[])if(Math.hypot(e.x-base.x,e.y-base.y)<560)nearbyThreat++;
    }
    return Object.freeze({
      tick:Number(state.tick||0),elapsedSec:Number(state.tick||0)/Math.max(1,bot.session?.sim?.tps||SIM_TPS),
      economy:Object.freeze({minerals:wallet,gas,ownBases,visibleEnemyBases,ownWorkers,visibleEnemyWorkers,spendPressure}),
      production:Object.freeze({own:ownProduction,enemyObserved:visibleEnemyProduction,queued,idlePressure:Math.max(0,ownProduction-queued)}),
      military:Object.freeze({ownArmy,enemyObservedArmy:visibleEnemyArmy,nearbyThreat}),
      map:Object.freeze({neutralObjectives,ownedObjectives,enemyObjectives}),
      tech:Object.freeze({tier:Number(state.tech?.[bot.side]||1)}),
      enemy:Object.freeze({side:enemySide})
    });
  }
}
class AiSituationAnalyzer{
  static analyze(o){
    const productionDelta=o.production.enemyObserved-o.production.own;
    const productionComparable=Math.abs(productionDelta)<=1;
    const playerProductionAhead=productionDelta>=2;
    const enemyEvidence=o.production.enemyObserved+o.economy.visibleEnemyWorkers+o.economy.visibleEnemyBases+o.military.enemyObservedArmy;
    const enemyGreedEarly=o.elapsedSec<=210&&enemyEvidence>0&&(
      o.production.enemyObserved<=Math.max(1,o.production.own-1)||
      o.economy.visibleEnemyWorkers>=o.economy.ownWorkers+4||
      o.economy.visibleEnemyBases>o.economy.ownBases
    )&&o.military.enemyObservedArmy<=Math.max(5,o.military.ownArmy*.8);
    const armyRatio=o.military.ownArmy/Math.max(1,o.military.enemyObservedArmy);
    const decisiveArmyLead=o.military.ownArmy>=18&&armyRatio>=2;
    const overwhelmingArmyLead=o.military.ownArmy>=24&&armyRatio>=3;
    return Object.freeze({productionDelta,productionComparable,playerProductionAhead,enemyGreedEarly,armyRatio,decisiveArmyLead,overwhelmingArmyLead,
      underThreat:o.military.nearbyThreat>=2,canExpand:o.map.neutralObjectives>0,
      floatingResources:o.economy.spendPressure>=1.35,severeFloat:o.economy.spendPressure>=2.1});
  }
}
class AiPolicy{
  decide(_observation,_situation,_legalActions){return null}
  intentWeights(_observation,_situation){return Object.freeze({})}
}
class UtilityAiPolicy extends AiPolicy{
  intentWeights(o,s){
    let expand=0,defend=0,rush=0,army=0,production=0,tech=0,fortify=0;
    if(s.productionComparable&&s.canExpand)expand+=Math.max(10,42-o.map.ownedObjectives*10-o.economy.ownBases*4);
    else if(o.production.own>o.production.enemyObserved&&s.canExpand)expand+=Math.max(8,24-o.map.ownedObjectives*6);
    // Expansion is a means to win, not a checklist. Once the army lead is decisive,
    // neutral ground has sharply diminishing value and must not delay a direct push.
    if(s.decisiveArmyLead&&!s.underThreat)expand*=.35;
    if(s.overwhelmingArmyLead&&!s.underThreat)expand=0;
    if(s.playerProductionAhead){defend+=48;army+=42;production+=46;fortify+=30}
    else if(s.productionDelta===1){defend+=24;army+=18}
    if(s.enemyGreedEarly){rush+=72;army+=34}
    if(s.underThreat){defend+=90;fortify+=55;army+=35}
    if(s.floatingResources){army+=35;production+=32;expand+=s.canExpand?18:0}
    if(s.severeFloat){army+=35;production+=45;tech+=18}
    if(s.armyRatio<.75){defend+=30;army+=45}
    else if(s.armyRatio>1.5&&!s.underThreat)rush+=22+Math.min(35,o.map.ownedObjectives*8);
    if(s.decisiveArmyLead&&!s.underThreat)rush+=55;
    if(s.overwhelmingArmyLead&&!s.underThreat)rush+=70;
    if(!s.underThreat&&o.military.ownArmy>=12&&o.military.enemyObservedArmy>0&&s.armyRatio>=1.25)rush+=38;
    if(!s.underThreat&&o.military.ownArmy>=16&&s.severeFloat)rush+=30;
    return Object.freeze({expand,defend,rush,army,production,tech,fortify});
  }
  decide(o,s,legalActions){
    const w=this.intentWeights(o,s);
    if(!legalActions?.length)return null;
    const scored=legalActions.map(a=>{
      const intent=a.intent||"army";
      const utility=Number(a.baseScore||0)+Number(w[intent]||0)+Number(a.contextScore||0);
      return{...a,utility};
    }).sort((a,b)=>b.utility-a.utility||String(a.id||a.kind||'').localeCompare(String(b.id||b.kind||'')));
    return scored[0]||null;
  }
}
// Placeholder adapter contract for a future inference model. It deliberately consumes the same
// observation/legal-action boundary as UtilityAiPolicy; no simulation object leaks into the model.
class LearnedAiPolicy extends AiPolicy{
  constructor(inference=null,fallback=new UtilityAiPolicy()){super();this.inference=inference;this.fallback=fallback}
  intentWeights(o,s){return this.fallback.intentWeights(o,s)}
  decide(o,s,legalActions){
    if(typeof this.inference!=="function")return this.fallback.decide(o,s,legalActions);
    const picked=this.inference(o,legalActions.map(a=>({id:a.id||a.kind,intent:a.intent||"army"})));
    return legalActions.find(a=>(a.id||a.kind)===picked)||this.fallback.decide(o,s,legalActions);
  }
}
class AiDecisionTrace{
  constructor(limit=256){this.enabled=false;this.limit=limit;this.rows=[]}
  record(row){if(!this.enabled)return;this.rows.push(row);if(this.rows.length>this.limit)this.rows.splice(0,this.rows.length-this.limit)}
  snapshot(){return this.rows.slice()}
}

// === AI response planning architecture v35 ===
// Strategic policy says WHY; planner/action-generator/scheduler decide WHAT NOW and the
// executor is the only layer allowed to translate that plan into existing game commands.
// Campaign pacing owns only local AI intent. Every resulting order still travels
// through the normal command ledger; units/resources and replay state stay in sim.
class CampaignAiOffense{
  constructor(bot){this.bot=bot;this.phase="gather";this.readyAt=0;this.members=[];this.target=null;this.pending=null;this.staging=null;this.lastTick=-1;this.wave=0}
  config(){
    const m=this.bot.session.matchConfig?.campaignScenario;
    return m&&m.enemy?.aiProfile==="standard"&&this.bot.role!==(m.playerRole||"host")?m.enemy.offense||null:null;
  }
  combat(p){return p.ownArmy.filter(u=>u.alive!==false&&!u.scenarioGroupId&&!u.campId&&UnitDefinition.get(u.type)?.role!=="support")}
  matches(flag,target){return !!flag&&!flag.forced&&Math.hypot(flag.x-target.x,flag.y-target.y)<90}
  regroup(tick,cfg,tps){
    this.phase="gather";this.readyAt=tick+SimulationTiming.msToTicks(cfg.regroupMs,tps);
    this.members=[];this.target=null;this.pending=null;this.staging=null;
  }
  order(target,phase,members=[]){return{id:phase==="assault"?`campaign-attack:${target.id}`:"campaign-gather",kind:phase==="assault"?"attack":"hold",intent:phase==="assault"?"rush":"defend",priority:260,target,campaignOffense:{phase,members}}}
  accept(action,state){
    if(action.campaignOffense?.phase!=="assault"||this.phase==="assault"&&this.target?.id===action.target.id)return;
    if(!this.pending)this.pending={target:{...action.target},members:action.campaignOffense.members.slice(),tick:state.tick};
  }
  action(state,p,ctx){
    const cfg=this.config();if(!cfg)return null;
    const tps=state.tps||SIM_TPS,combat=this.combat(p),world=WorldContext.forState(state);
    if(this.lastTick<0||state.tick<this.lastTick){
      this.phase="gather";this.readyAt=SimulationTiming.msToTicks(cfg.firstAttackMs,tps);
      this.target=null;this.pending=null;this.members=[];this.staging=null;
    }
    this.lastTick=state.tick;
    if(this.pending&&state.tick>this.pending.tick&&this.matches(state.flags?.[this.bot.side],this.pending.target)){
      this.phase="assault";this.target=this.pending.target;this.members=this.pending.members;this.pending=null;this.wave++;
    }
    // Defense can interrupt a wave. New attackers must regroup after that defense,
    // rather than letting the ordinary expansion/rush planner overwrite this cycle.
    if(ctx.situation.underThreat){
      if(this.phase!=="gather"||this.pending)this.regroup(state.tick,cfg,tps);
      return null;
    }
    // Owned points disable neutral capture while their outpost stands. Ownership,
    // not that neutral-capture switch, determines counterattack targets.
    const points=(p.capturePoints||[]).filter(cp=>cfg.counterattackPoints.includes(cp.id));
    const center=this.bot.armyCenter({ownArmy:combat})||world.bases[this.bot.side];
    const counter=points.filter(cp=>cp.owner===1-this.bot.side).sort((a,b)=>Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y)||String(a.id).localeCompare(String(b.id)))[0];
    if(this.phase==="assault"){
      const living=new Set(combat.map(u=>u.id)),survivors=this.members.filter(id=>living.has(id)).length;
      const objective=this.target.capturePointId?points.find(cp=>cp.id===this.target.capturePointId):null;
      if(survivors<Math.max(1,Math.ceil(this.members.length*.4))||this.target.capturePointId&&(!objective||objective.owner===this.bot.side||objective.owner==null&&!objective.enabled))this.regroup(state.tick,cfg,tps);
      else if(!this.pending){
        if(counter&&!this.target.capturePointId)return this.order({id:`capture:${counter.id}`,capturePointId:counter.id,x:counter.x,y:counter.y},"assault",combat.map(u=>u.id));
        return this.order(this.target,"assault");
      }
    }
    if(this.pending)return this.order(this.pending.target,"assault",this.pending.members);
    const anchors=(p.ownBuildings||[]).filter(b=>b.alive!==false&&b.complete&&BuildingDefinition.get(b.type)?.isDropoff);
    if(!this.staging||!anchors.some(b=>b.id===this.staging.id)){
      const anchor=anchors.slice().sort((a,b)=>Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y)||String(a.id).localeCompare(String(b.id)))[0];
      this.staging=anchor?{id:anchor.id,x:anchor.x,y:anchor.y}:{id:"home",...world.bases[this.bot.side]};
    }
    const gathered=combat.filter(u=>Math.hypot(u.x-this.staging.x,u.y-this.staging.y)<=500);
    if(state.tick>=this.readyAt&&gathered.length>=cfg.attackSize){
      const base=world.bases[1-this.bot.side],target=counter?{id:`capture:${counter.id}`,capturePointId:counter.id,x:counter.x,y:counter.y}:{id:"main",x:base.x,y:base.y};
      return this.order(target,"assault",gathered.map(u=>u.id));
    }
    return this.order(this.staging,"gather");
  }
}
class AiActionGenerator{
  static threat(bot,state,p){
    let best=null;
    const anchors=(p.ownBuildings||[]).filter(b=>BuildingDefinition.get(b.type)?.isDropoff);
    for(const a of anchors)for(const e of p.enemyUnits||[]){
      const d=Math.hypot(e.x-a.x,e.y-a.y),ed=UnitDefinition.get(e.type)||{};
      const speed=Math.max(30,Number(ed.speed)||100);
      const eta=Math.max(0,(d-Math.max(60,Number(ed.range)||0))/speed);
      const score=Math.max(0,700-d)+(ed.layer==="AIR"?120:0);
      if(!best||eta<best.eta||(eta===best.eta&&score>best.score))best={anchor:a,enemy:e,distance:d,eta,score};
    }
    return best;
  }
  static unitScores(bot,state,p){
    let enemyAir=0,enemyGround=0,enemyLight=0,enemyHeavy=0,enemyRanged=0;
    for(const e of p.enemyUnits||[]){
      const d=UnitDefinition.get(e.type)||{};
      if(d.layer==="AIR")enemyAir++;else enemyGround++;
      if(d.sizeClass==="heavy")enemyHeavy++;else enemyLight++;
      if((d.range||0)>=180)enemyRanged++;
    }
    const ownCounts=new Map();for(const u of p.ownArmy||[])ownCounts.set(u.type,(ownCounts.get(u.type)||0)+1);
    // Include already-paid reinforcements so support cannot crowd out the army
    // while the first combat batches are still travelling or in production.
    const committedCounts=new Map(ownCounts);
    for(const b of bot.plannedBuildings(state))if(b.alive!==false&&b.side===bot.side&&b.produceType){
      committedCounts.set(b.produceType,(committedCounts.get(b.produceType)||0)+Math.max(0,Number(b.productionRemaining)||0));
    }
    let combatCount=0,supportCount=0,frontCount=0;
    for(const [id,count] of committedCounts){
      const role=UnitDefinition.get(id)?.role;
      if(role==="support")supportCount+=count;else combatCount+=count;
      if(["guardian","bruiser","pikeman","charger"].includes(role))frontCount+=count;
    }
    const gas=Number(state.gasWallet?.[bot.side]||0),wallet=Number(state.wallet?.[bot.side]||0);
    return bot.deck().filter(id=>bot.productionPrerequisitesReady(state,id)).map(id=>{
      const d=UnitDefinition.get(id)||{},c=UnitDefinition.productionCost(id),profile=UnitDefinition.productionProfile(id)||{};
      let score=40;
      if(enemyAir&&d.canAttackAir)score+=90+enemyAir*7;
      if(enemyAir&&!d.canAttackAir)score-=70;
      if(enemyLight>=enemyHeavy&&["artillery","caster","controller"].includes(d.role))score+=35;
      if(enemyHeavy>enemyLight&&["pikeman","bruiser","artillery"].includes(d.role))score+=32;
      if(enemyRanged>=3&&["assassin","charger","guardian"].includes(d.role))score+=24;
      if(enemyGround&&["guardian","bruiser","pikeman"].includes(d.role))score+=18;
      if(frontCount===0&&["guardian","bruiser","pikeman"].includes(d.role))score+=24;
      if(d.role==="support"&&(combatCount===0||supportCount>=Math.max(1,combatCount*.25)))score-=100;
      score-=Math.min(45,(ownCounts.get(id)||0)*4);
      if(c.gas>gas)score-=80;if(c.mineral>wallet)score-=45;
      const productionSec=Math.max(1,(profile.productionMs||3000)/1000);
      const facilityType=bot.productionBuildingType(id),hasFacility=bot.productionContractCount(state,id)>0;
      const facilitySec=hasFacility?0:Math.max(0,Number(BuildingDefinition.get(facilityType)?.buildTimeMs||0)/1000);
      const sec=productionSec+facilitySec;score+=Math.max(0,18-sec*1.2);
      return{id,score,cost:c,effectSec:sec,affordableNow:c.mineral<=wallet&&c.gas<=gas};
    }).sort((a,b)=>b.score-a.score||a.cost.gas-b.cost.gas||a.cost.mineral-b.cost.mineral||String(a.id).localeCompare(String(b.id)));
  }
  static generate(bot,state,p,ctx){
    const out=[],o=ctx.observation,s=ctx.situation,w=ctx.weights,th=this.threat(bot,state,p);
    const unitScores=this.unitScores(bot,state,p),bestUnit=unitScores.find(x=>x.affordableNow)||unitScores[0]||null;
    const affordableUnits=unitScores.filter(x=>x.affordableNow).slice(0,3);
    const freeSupply=Math.max(0,bot.supplyCap(state)-bot.supplyUsed(state));
    const nextSupplyNeed=affordableUnits.length?Math.max(1,...affordableUnits.map(x=>(UnitDefinition.get(x.id)?.supply||0)*Math.max(1,UnitDefinition.productionProfile(x.id)?.batchSize||1))):0;
    if(th&&th.distance<720){
      const deadline=Math.max(1,th.eta);
      out.push({id:`hold:${th.anchor.id}`,kind:"hold",intent:"defend",priority:deadline<12?460+(w.defend||0):220+(w.defend||0),deadlineSec:deadline,target:th.anchor});
      // Static defense wins the time-to-effect race when fresh troops cannot arrive before contact.
      if(deadline<Math.max(10,(bestUnit?.effectSec||25)+8))out.push({id:`fortify:${th.anchor.id}`,kind:"fortify",intent:"fortify",priority:720+(w.fortify||0),deadlineSec:deadline,target:th.anchor});
      if(bestUnit)out.push({id:`reinforce:${bestUnit.id}`,kind:"production",intent:"army",priority:deadline<12?310+(w.army||0):205+(w.army||0),deadlineSec:deadline,unitType:bestUnit.id});
    }
    if(nextSupplyNeed>0&&freeSupply<nextSupplyNeed)out.push({id:"supply-buffer",kind:"supply",intent:"army",priority:260+(w.army||0)});
    for(let i=0;i<affordableUnits.length;i++){const pick=affordableUnits[i];if(s.floatingResources||s.armyRatio<1||s.playerProductionAhead||p.ownArmy.length<12)out.push({id:`army:${pick.id}`,kind:"production",intent:"army",priority:120+(w.army||0)+(s.severeFloat?35:0)-i*8,unitType:pick.id});}
    if(!affordableUnits.length&&unitScores.some(x=>x.cost.gas>Number(state.gasWallet?.[bot.side]||0)))out.push({id:"gas-readiness",kind:"gas-readiness",intent:"economy",priority:180+(w.army||0)});
    if(s.floatingResources||s.playerProductionAhead)out.push({id:"capacity",kind:"production-capacity",intent:"production",priority:105+(w.production||0)});
    if(s.canExpand&&!s.underThreat&&p.ownArmy.length>=4&&!s.overwhelmingArmyLead){
      const cps=(p.capturePoints||[]).filter(cp=>cp.enabled&&cp.owner==null).map(cp=>({...cp,d:bot.armyDistance(p,cp.x,cp.y)})).sort((a,b)=>a.d-b.d||String(a.id).localeCompare(String(b.id)));
      const leadPenalty=s.decisiveArmyLead?90:0;
      if(cps[0])out.push({id:`expand:${cps[0].id}`,kind:"expand",intent:"expand",priority:95+(w.expand||0)-leadPenalty-cps[0].d/100,target:cps[0]});
    }
    if(s.enemyGreedEarly&&p.ownArmy.length>=7)out.push({id:"rush-main",kind:"attack",intent:"rush",priority:135+(w.rush||0),target:{x:WorldContext.forState(state).bases[1-bot.side].x,y:WorldContext.forState(state).bases[1-bot.side].y}});
    // Mid-game pressure prevents a healthy army from endlessly re-selecting neutral expansions.
    // It uses the same rally/attack path as normal play; no free units/resources are created.
    const observedEnemyArmy=Math.max(1,Number(o.military.enemyObservedArmy)||1);
    const pressureReady=p.ownArmy.length>=18&&p.ownArmy.length>=Math.ceil(observedEnemyArmy*1.2)&&o.map.ownedObjectives>=1;
    if(!s.underThreat&&pressureReady){
      const visibleTarget=(p.enemyBuildings||[]).slice().sort((a,b)=>Math.hypot(a.x-WorldContext.forState(state).bases[bot.side].x,a.y-WorldContext.forState(state).bases[bot.side].y)-Math.hypot(b.x-WorldContext.forState(state).bases[bot.side].x,b.y-WorldContext.forState(state).bases[bot.side].y))[0];
      const target=visibleTarget||{x:WorldContext.forState(state).bases[1-bot.side].x,y:WorldContext.forState(state).bases[1-bot.side].y};
      out.push({id:"pressure-main",kind:"attack",intent:"rush",priority:150+(w.rush||0)+Math.min(55,(p.ownArmy.length-observedEnemyArmy)*3),target});
    }
    // A mature army must convert its economic lead into a win instead of endlessly taking neutral ground.
    // This is a normal rally/attack order; no units or resources are granted.
    const decisiveArmy=p.ownArmy.length>=Math.max(24,Math.ceil(Math.max(1,o.military.enemyObservedArmy)*1.5));
    const mapLead=o.map.ownedObjectives>=o.map.enemyObjectives;
    // A large military lead is itself enough reason to try to end the game.
    // Remaining neutral objectives may improve the position, but they never gate FINISH.
    if(!s.underThreat&&decisiveArmy){
      const visibleMain=(p.enemyBuildings||[]).find(b=>BuildingDefinition.get(b.type)?.isMainBase);
      const target=visibleMain||{x:WorldContext.forState(state).bases[1-bot.side].x,y:WorldContext.forState(state).bases[1-bot.side].y};
      out.push({id:"finish-main",kind:"attack",intent:"rush",priority:225+(w.rush||0)+(s.severeFloat?35:0)+(mapLead?15:0)+(s.overwhelmingArmyLead?80:s.decisiveArmyLead?40:0),target});
    }
    if(!s.underThreat&&o.economy.minerals>650)out.push({id:"tech",kind:"tech",intent:"tech",priority:60+(w.tech||0)});
    if(bot.campaignOffense?.config()){
      const offense=bot.campaignOffense.action(state,p,ctx);
      for(let i=out.length-1;i>=0;i--)if(out[i].kind==="attack"||out[i].kind==="expand")out.splice(i,1);
      if(offense)out.push(offense);
    }
    return out.sort((a,b)=>b.priority-a.priority||String(a.id).localeCompare(String(b.id)));
  }
}
class AiResponsePlanner{
  static plan(bot,state,p){
    const ctx=bot.aiDecisionContext(state,p),actions=AiActionGenerator.generate(bot,state,p,ctx);
    const legal=actions.map(a=>({...a,baseScore:a.priority,contextScore:a.deadlineSec?Math.max(0,40-a.deadlineSec*2):0}));
    const selected=bot.aiPolicy.decide(ctx.observation,ctx.situation,legal)||legal[0]||null;
    return{tick:state.tick,observation:ctx.observation,situation:ctx.situation,weights:ctx.weights,actions:legal,selected};
  }
}
class AiMacroExecutor{
  static execute(bot,state,p,a){
    if(!a)return false;
    if(a.kind==="hold"||a.kind==="expand"||a.kind==="attack"){
      if(a.campaignOffense){
        const admitted=bot.setFlag(a.target.x,a.target.y,{forced:false});
        if(!admitted&&!bot.campaignOffense.matches(state.flags?.[bot.side],a.target))return false;
        bot.currentTarget={kind:a.kind,...a.target};bot.campaignOffense.accept(a,state);return true;
      }
      bot.currentTarget={kind:a.kind,id:a.target?.id||null,x:a.target.x,y:a.target.y,score:a.priority||0};
      if(a.id==="finish-main"){
        const center=bot.armyCenter(p),tx=a.target.x,ty=a.target.y,own=p.ownArmy||[];
        if(center){
          const dx=center.x-tx,dy=center.y-ty,d=Math.hypot(dx,dy);
          const nearest=own.reduce((best,u)=>Math.min(best,Math.hypot(u.x-tx,u.y-ty)),Infinity);
          // Forced march ignores only irrelevant friction. If the visible vanguard
          // meets a meaningful combat group or a defensive structure, restore normal
          // combat immediately; after that threat disappears the next planner pulse
          // may resume the march. This preserves FINISH urgency without donating an
          // army while it is being shot on the way in.
          let localOwn=0,defenseContact=false;const localEnemyIds=new Set();
          const resistance=(p.enemyUnits||[]).concat(p.activeNeutralThreats||[]);
          for(const u of own){
            if(Math.hypot(u.x-tx,u.y-ty)>nearest+520)continue;
            localOwn++;
            for(const e of resistance){
              if(!!UnitDefinition.get(e.type)?.economyWorker)continue;
              if(Math.hypot(u.x-e.x,u.y-e.y)<=360)localEnemyIds.add(e.id||`${e.type}:${Math.round(e.x)}:${Math.round(e.y)}`);
            }
            if(!defenseContact)for(const b of p.enemyBuildings||[]){
              if(BuildingDefinition.isDefenseTower(b.type)&&Math.hypot(u.x-b.x,u.y-b.y)<=460){defenseContact=true;break;}
            }
          }
          const meaningfulResistance=defenseContact||localEnemyIds.size>=Math.max(2,Math.ceil(Math.max(1,localOwn)*.25));
          if(nearest>850&&!meaningfulResistance){const keep=700/Math.max(1,d);bot.setFlag(tx+dx*keep,ty+dy*keep,{forced:true});return true;}
        }
        bot.setFlag(tx,ty,{forced:false});return true;
      }
      bot.setFlag(a.target.x,a.target.y,{forced:false});return true;
    }
    if(a.kind==="fortify"){
      const cards=DefenseCardDefinition.list(state.defenseCards?.[bot.side]||bot.session.draft?.defenseCards?.[bot.role]);
      for(const card of cards){const type=DefenseCardDefinition.get(card)?.building;if(!type)continue;const c=BuildingDefinition.resourceCost(type);if((state.wallet[bot.side]||0)<c.mineral||(state.gasWallet?.[bot.side]||0)<c.gas)continue;if(bot.tryBuild(state,p,type,null,a.target.id))return true;}return false;
    }
    if(a.kind==="production"){
      const id=a.unitType;if(!id||!bot.productionPrerequisitesReady(state,id))return false;
      const c=UnitDefinition.productionCost(id);if((state.wallet[bot.side]||0)<c.mineral||(state.gasWallet?.[bot.side]||0)<c.gas)return false;
      const type=bot.productionBuildingType(id);return bot.tryBuild(state,p,type,id,null,{allowProductionDensity:true});
    }
    if(a.kind==="supply"){const t=BuildingDefinition.forRole("supply"),c=BuildingDefinition.resourceCost(t);if((state.wallet[bot.side]||0)<c.mineral)return false;return bot.tryBuild(state,p,t);}
    if(a.kind==="gas-readiness"){const t=BuildingDefinition.forRole("gasExtractor"),c=BuildingDefinition.resourceCost(t);if((state.wallet[bot.side]||0)<c.mineral)return false;const existing=bot.plannedBuildings(state).some(b=>b.alive!==false&&b.side===bot.side&&BuildingDefinition.get(b.type)?.isGasExtractor);if(!existing)return bot.tryBuild(state,p,t);const bases=bot.workerBases(state);return bot.updateGasAssignments(state,p,bases)===true;}
    if(a.kind==="production-capacity")return bot.trySurplusProduction(state,p);
    if(a.kind==="tech"){
      const tier=Number(state.tech?.[bot.side]||1),wallet=Number(state.wallet?.[bot.side]||0),gas=Number(state.gasWallet?.[bot.side]||0);
      if(tier<2){const t=BuildingDefinition.forRole("academy"),c=BuildingDefinition.resourceCost(t);if(bot.countBuilding(state,t)===0&&wallet>=c.mineral&&gas>=c.gas)return bot.tryBuild(state,p,t);}
      if(tier===2&&bot.deck().some(id=>(UnitDefinition.get(id)?.tier||0)>=3)){const t=BuildingDefinition.forRole("lab"),c=BuildingDefinition.resourceCost(t);if(bot.countBuilding(state,t)===0&&wallet>=c.mineral&&gas>=c.gas)return bot.tryBuild(state,p,t);}
      return bot.runResearch(state,p)===true;
    }
    return false;
  }
}
class AiActionScheduler{
  static run(bot,state,p,plan){
    if(!plan?.actions?.length)return null;
    const ordered=plan.selected?[plan.selected,...plan.actions.filter(a=>a.id!==plan.selected.id)]:plan.actions;
    const executed=[];let tacticalCommitted=false,spendCommitted=0;
    // Strategic movement and economy are orthogonal. A PUSH must not freeze production for the
    // whole planning pulse, otherwise a winning AI floats thousands of minerals while attacking.
    // Keep one positional order plus at most two resource-spending actions per pulse.
    for(const a of ordered){
      if(Number(a.priority??0)<0)continue;
      const tactical=a.kind==="hold"||a.kind==="expand"||a.kind==="attack";
      const spending=a.kind==="fortify"||a.kind==="production"||a.kind==="production-capacity"||a.kind==="tech"||a.kind==="supply"||a.kind==="gas-readiness";
      if(tactical&&tacticalCommitted)continue;if(spending&&spendCommitted>=2)continue;
      if(!bot.commandExecutor.withMacro(a.id,()=>AiMacroExecutor.execute(bot,state,p,a)))continue;
      executed.push(a);if(tactical)tacticalCommitted=true;if(spending)spendCommitted++;
      if(executed.length>=3)break;
    }
    return executed.length?{primary:executed[0],actions:executed}:null;
  }
}

globalThis.RallyAiArchitecture={AiObservationBuilder,AiSituationAnalyzer,AiPolicy,UtilityAiPolicy,LearnedAiPolicy,AiActionGenerator,AiResponsePlanner,AiActionScheduler,AiMacroExecutor};
// Actual AI commands have one admission/submission ledger. Macro choice and
// cadence remain independent; no gameplay command bypasses the shared budget.
class AiCommandExecutor{
  constructor(bot){this.bot=bot;this.pending=[];this.queue=[];this.history=[];this.channel="planner";this.macro=null;this.state=null;this.epoch=-1;this.stats={offered:0,submitted:0,applied:0,rejected:0,budgetRejected:0,duplicateRejected:0,cancelled:0};}
  static key(action){return StableSerializationUtil.stableStringify(action)}
  remember(entry){this.history.push({...entry,action:StateValue.copy(entry.action)});if(this.history.length>256)this.history.shift()}
  outstanding(){return this.pending.concat(this.queue)}
  // Receipt identity stays pending until confirmed; a decision state that already
  // contains its execution must not reserve the same money or capacity again.
  reservations(state=this.state){
    const receipts=this.bot.session.sim?.commandReceipts||[];
    return this.pending.filter(entry=>!receipts.some(r=>r.netcodeSequence===entry.netcodeSequence&&r.actor===entry.actor&&r.tick<=(state?.tick??-1))).concat(this.queue);
  }
  quote(state,action){
    if(action.type==="BUILD")return BuildingDefinition.get(action.building)?BuildingDefinition.resourceCost(action.building,action.produceType):null;
    if(action.type==="TRAIN_WORKER")return{mineral:WORKER_COST,gas:0};
    if(action.type==="LAUNCH"){const payload=LaunchRules.payload(action.unitType);return payload?{mineral:payload.cost,gas:0}:null}
    if(action.type==="START_RESEARCH"){const def=ResearchDefinition.resolveAction(state,this.bot.side,action).def;return def?{mineral:Number(def.cost)||0,gas:Number(def.gasCost)||0}:null}
    return{mineral:0,gas:0};
  }
  reconcile(state){
    const session=this.bot.session,sim=session.sim,receipts=sim?.commandReceipts||[],epochChanged=this.epoch!==sim?.runtimeEpoch,confirmedTick=Math.min(state.tick,session.confirmedGameTick??state.tick);
    const matches=(entry,sequence,actor)=>entry.netcodeSequence===sequence&&entry.actor===actor;
    const tickets=session.getPendingCommandTickets();
    this.pending=this.pending.filter(entry=>{
      const receipt=receipts.find(r=>matches(entry,r.netcodeSequence,r.actor));
      if(receipt&&receipt.tick<=confirmedTick){
        this.stats[receipt.applied?"applied":"rejected"]++;
        this.remember({...entry,status:receipt.applied?"applied":"rejected",executedTick:receipt.tick,seq:receipt.seq});return false;
      }
      if(!epochChanged||receipt||tickets.some(ticket=>matches(entry,ticket.sequence,ticket.actor)))return true;
      for(const list of sim?.scheduled?.values?.()||[])if(list.some(c=>matches(entry,c.netcodeSequence,c.actor)))return true;
      this.remember({...entry,status:"reconciled-from-state"});return false;
    });
    this.epoch=sim?.runtimeEpoch;
  }
  begin(snapshot){
    this.reconcile(snapshot);this.queue=[];
    // This is an isolated decision view, never a mutation of a published snapshot.
    const view={...snapshot,wallet:snapshot.wallet.slice(),gasWallet:(snapshot.gasWallet||[0,0]).slice()};
    for(const p of this.reservations(snapshot)){view.wallet[this.bot.side]-=p.cost.mineral;view.gasWallet[this.bot.side]-=p.cost.gas}
    this.state=view;return view;
  }
  withChannel(channel,fn){const old=this.channel;this.channel=channel;try{return fn()}finally{this.channel=old}}
  withMacro(id,fn){const old=this.macro;this.macro=id;try{return fn()}finally{this.macro=old}}
  conflictsBuilding(type,x,y){
    return (this.state?.constructionOrders||[]).some(p=>p.side===this.bot.side&&Math.hypot(p.x-x,p.y-y)<buildingPlacementSeparation(type,p.type))||
      this.reservations().some(p=>p.action.type==="BUILD"&&Math.hypot(p.action.x-x,p.action.y-y)<buildingPlacementSeparation(type,p.action.building));
  }
  offer(action){
    if(!this.state)return false;
    const session=this.bot.session;if(session.disposed||session.simEnded||session.netcodeSession?.resimulating||typeof session.inputAvailable==="function"&&!session.inputAvailable())return false;
    this.stats.offered++;const key=AiCommandExecutor.key(action),entries=this.reservations(),side=this.bot.side,cost=this.quote(this.state,action);
    if(!cost)return false;
    const duplicates=entries.some(p=>p.key===key&&action.type!=="TRAIN_WORKER"||action.type==="START_RESEARCH"&&p.action.type==="START_RESEARCH"&&((action.research==="ability")===(p.action.research==="ability")));
    if(duplicates){this.stats.duplicateRejected++;return false}
    if(this.state.wallet[side]<cost.mineral||this.state.gasWallet[side]<cost.gas){this.stats.budgetRejected++;return false}
    if(action.type==="BUILD"&&this.conflictsBuilding(action.building,action.x,action.y))return false;
    if(action.type==="TRAIN_WORKER"){
      const base=this.state.buildings.find(b=>b.id===action.buildingId),reserved=entries.filter(p=>p.action.type==="TRAIN_WORKER"),onBase=reserved.filter(p=>p.action.buildingId===action.buildingId).length;
      if(!base||(base.queue?.length||0)+onBase>=WORKER_QUEUE_LIMIT||this.bot.supplyUsed(this.state)+reserved.length+1>this.bot.supplyCap(this.state))return false;
    }
    const entry={key,action:StateValue.copy(action),cost,channel:this.channel,macro:this.macro,status:"admitted",decisionTick:this.state.tick};
    this.queue.push(entry);this.state.wallet[side]-=cost.mineral;this.state.gasWallet[side]-=cost.gas;return true;
  }
  dispose(reason="match-ended"){
    const sim=this.bot.session.sim;if(sim)this.reconcile({tick:sim.tick});
    for(const entry of this.outstanding()){this.stats.cancelled++;this.remember({...entry,status:"cancelled",reason})}
    this.pending=[];this.queue=[];this.state=null;
  }
  flush(){
    const session=this.bot.session;
    for(const entry of this.queue){
      const submitted=session.command(entry.action)===true;
      if(submitted){
        const ticket=session.lastCommandTicket;
        if(!ticket||ticket.actor!==this.bot.role||ticket.key!==entry.key||!Number.isSafeInteger(ticket.sequence))throw new Error("AI 명령의 Netcode 제출 영수증이 없습니다.");
        Object.assign(entry,{status:"submitted",sentTick:ticket.submittedTick,actor:ticket.actor,netcodeSequence:ticket.sequence});this.pending.push(entry);this.stats.submitted++;
      }
      else{this.stats.rejected++;this.remember({...entry,status:"not-submitted"})}
    }
    this.queue=[];this.state=null;
  }
}

export { AiActionGenerator, AiActionScheduler, AiCommandExecutor, AiDecisionTrace, AiObservationBuilder, AiResponsePlanner, AiSituationAnalyzer, CampaignAiOffense, UtilityAiPolicy };
