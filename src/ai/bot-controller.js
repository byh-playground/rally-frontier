// Single-player bot controller.
import { RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { BuildPrerequisitePolicy, SupplyPolicy, Unit, VisibilityPolicy } from '../sim/entities.js';
import { CloakAuraMixin } from '../sim/unit-mixins.js';
import { BurrowableMixin } from '../sim/components.js';
import { AiActionGenerator, AiActionScheduler, AiCommandExecutor, AiDecisionTrace, AiObservationBuilder, AiResponsePlanner, AiSituationAnalyzer, CampaignAiOffense, UtilityAiPolicy } from './ai-policy.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { ConnectionSideUtil } from '../net/lobby-codec.js';
import { HashUtil } from '../sim/map-generation.js';
import { ABILITY_INFO } from '../definitions/balance.js';
import { ResearchDefinition, UnitSpecialResearchDefinition } from '../definitions/research.js';
import { BuildingDefinition, buildingHasBuilderApproach, buildingHasReachableBuilder, buildingPlacementEdgeMargin, buildingPlacementInsideWorld, buildingPlacementSeparation } from '../definitions/buildings.js';
import { DeckRecord, DefenseCardDefinition } from '../definitions/decks.js';
import { UnitDefinition } from '../definitions/units.js';
import { NEUTRAL_SIDE, NeutralCampPolicy, SpellDefinition } from '../definitions/cards.js';
import { DEFENSE_CLUSTER_RADIUS, MINERAL_BUILD_MARGIN, PRODUCTION_CLUSTER_RADIUS } from '../definitions/combat-rules.js';
import { GAS_ASSIGNMENT_MAX, WORKER_COST, WORKER_QUEUE_LIMIT } from '../definitions/world-rules.js';
import { WorldContext } from '../sim/world-context.js';
import { SimulationTiming } from '../main.js';

class BotController{
  // AI도 역할과 무관하게 동일한 GameSession 명령 인터페이스만 사용한다(페이지 안이든 sim-worker.js 안이든).
  static attach(session,role){
    const bot=new BotController(session,{role});
    session.publishConfirmedSnapshots=true;
    session.onDraft=state=>{session.draft=state;bot.handleDraft(state)};
    session.onSnapshot=state=>bot.handleSnapshot(state);
    session.onLog=()=>{};session.onResult=()=>bot.stop();session.onNetworkHealth=()=>{};
    return bot;
  }
  constructor(session,options={}){
    this.session=session;this.commandExecutor=new AiCommandExecutor(this);
    this.role=options.role||session.role||"guest";
    this.side=ConnectionSideUtil.roleSide(this.role);
    this.enabled=true;

    this.lastDraftKey="";
    this.lastSnapshot=null;
    this.lastEconomyTick=-99999;
    this.lastLaunchTick=-99999;
    this.lastPlannerTick=-99999;
    this.lastResponsePlan=null;
    this.lastExecutedMacro=null;
    this.lastSpellTick=-99999;
    this.lastResearchTick=-99999;
    this.lastSpellChoiceId="";
    this.currentTarget=null;
    this.enemyMemory=new Map();
    this.campaignOffense=new CampaignAiOffense(this);
    this.aiPolicy=options.aiPolicy||new UtilityAiPolicy();
    this.aiTrace=options.aiTrace||new AiDecisionTrace();
    this.lastAiDecision=null;
  }

  stop(){this.enabled=false;this.commandExecutor.dispose("bot-stopped")}

  handleDraft(state){
    if(!this.enabled||!state)return;
    if(this.session.matchConfig?.debugScenario||this.session.matchConfig?.campaignScenario)return;
    if(state.phase==="deck-select"){
      if(state.deckReady?.[this.role])return;
      const key=`deck|${state.roomCode}|${this.role}`;
      if(key===this.lastDraftKey)return;
      this.lastDraftKey=key;
      const payload=DeckRecord.defaultBotDeckPayload(`${state.roomCode}|${this.role}`);
      const commit=()=>{
        if(!this.enabled)return;
        const live=this.session.draft;
        if(live?.phase==="deck-select"&&!live.deckReady?.[this.role]){
          if(!this.session.deckAct(payload))this.lastDraftKey="";
        }
      };
      if(this.session.matchConfig?.debugScenario)queueMicrotask(commit);else setTimeout(commit,220);
      return;
    }
    if(state.phase!=="draft")return;
    if(state.draft.chooser!==this.role)return;

    const pair=state.draft.pairs[state.draft.round];
    if(!pair||pair.length!==2)return;

    const key=`${state.draft.round}|${pair.join("|")}`;
    if(key===this.lastDraftKey)return;
    this.lastDraftKey=key;

    const chosen=this.chooseDraftCard(state,pair);
    setTimeout(()=>{
      if(!this.enabled)return;
      const live=this.session.draft;
      if(live?.phase==="draft"&&live.draft.chooser===this.role){
        this.session.draftAct({type:"DRAFT_PICK",card:chosen});
      }
    },260);
  }

  chooseDraftCard(state,pair){
    if(pair.every(id=>!!DefenseCardDefinition.get(id))){
      return pair[HashUtil.hash(`${state.roomCode}|defense|${this.role}`)%pair.length];
    }
    const mine=state.decks[this.role]||[];
    const roleCounts={};
    for(const id of mine){
      const role=UnitDefinition.get(id)?.role||"";
      roleCounts[role]=(roleCounts[role]||0)+1;
    }

    const desired={
      guardian:30,bruiser:18,pikeman:18,
      ranged:24,skirmisher:20,
      caster:24,controller:18,support:22,
      assassin:18,charger:18,artillery:24
    };

    const score=id=>{
      const d=UnitDefinition.get(id);
      let value=desired[d.role]||15;
      value-=Math.min(2,roleCounts[d.role]||0)*14;

      // 조합 커버리지
      const hasFront=mine.some(x=>["guardian","bruiser","pikeman"].includes(UnitDefinition.get(x)?.role));
      const hasRange=mine.some(x=>["ranged","skirmisher","caster","artillery","controller"].includes(UnitDefinition.get(x)?.role));
      const hasSupport=mine.some(x=>UnitDefinition.get(x)?.role==="support");
      if(!hasFront&&["guardian","bruiser","pikeman"].includes(d.role))value+=28;
      if(!hasRange&&["ranged","skirmisher","caster","artillery","controller"].includes(d.role))value+=24;
      if(!hasSupport&&d.role==="support")value+=18;

      // 동일 점수는 hash로 결정해 매 판 완전히 같은 선택만 반복하지 않음.
      value+=(HashUtil.hash(`${state.roomCode}|${state.draft.round}|${id}`)%11)/10;
      return value;
    };

    return score(pair[0])>=score(pair[1])?pair[0]:pair[1];
  }

  handleSnapshot(snapshot){
    if(!this.enabled||!snapshot||this.session.netcodeSession?.resimulating)return;
    if(snapshot.tick>(this.session.confirmedGameTick??snapshot.tick)){this.commandExecutor.reconcile(snapshot);return}
    this.lastSnapshot=snapshot;
    if(this.session.matchConfig?.debugScenario)return;
    const campaign=this.session.matchConfig?.campaignScenario,humanRole=campaign?.playerRole||"host";
    if(campaign?.enemy?.aiProfile==="scripted"&&this.role!==humanRole)return;
    const state=this.commandExecutor.begin(snapshot);this.lastSnapshot=state;
    if(state.launchMode){
      try{
        if(state.tick-this.lastLaunchTick>=SimulationTiming.msToTicks(1200,state.tps||SIM_TPS)){this.lastLaunchTick=state.tick;this.commandExecutor.withChannel("launch",()=>this.runLaunch(state))}
      }finally{this.commandExecutor.flush()}
      return;
    }
    try{
      const p=this.perceive(state);this.rememberEnemies(p,state.tick);
      if(this.commandExecutor.withChannel("reward",()=>this.handleTacticalChest(state,p)))return;
      if(state.tick-this.lastEconomyTick>=SimulationTiming.msToTicks(4500,state.tps||this.session.sim?.tps||SIM_TPS)){
        this.lastEconomyTick=state.tick;this.commandExecutor.withChannel("economy",()=>this.runEconomy(state,p));
      }
      if(state.tick-this.lastResearchTick>=SimulationTiming.msToTicks(12000,state.tps||this.session.sim?.tps||SIM_TPS)){
        this.lastResearchTick=state.tick;this.commandExecutor.withChannel("research",()=>this.runResearch(state,p));
      }
      if(state.tick-this.lastPlannerTick>=SimulationTiming.msToTicks(2000,state.tps||this.session.sim?.tps||SIM_TPS)){
        this.lastPlannerTick=state.tick;this.commandExecutor.withChannel("planner",()=>this.runResponsePlanner(state,p));
      }
      if(state.tick-this.lastSpellTick>=SimulationTiming.msToTicks(9000,state.tps||this.session.sim?.tps||SIM_TPS)){
        this.lastSpellTick=state.tick;this.commandExecutor.withChannel("spell",()=>this.runSpells(state,p));
      }
    }finally{this.commandExecutor.flush()}
  }
  issueCommand(action){return this.commandExecutor.offer(action)}
  // Launch bot: defend the base first, then empty capture points, then enemy groups.
  // Hold time carries a deterministic +-12% error and never overheats.
  launchTarget(state,cannon){
    const side=this.side,mine=state.buildings.find(b=>b.id==="base"+side),enemyBase=state.buildings.find(b=>b.id==="base"+(1-side));
    const enemies=state.units.filter(u=>u.alive&&u.side===1-side);
    const centroid=list=>({x:list.reduce((a,u)=>a+u.x,0)/list.length,y:list.reduce((a,u)=>a+u.y,0)/list.length});
    const threat=mine?enemies.filter(u=>Math.hypot(u.x-mine.x,u.y-mine.y)<900):[];
    if(threat.length)return centroid(threat);
    const open=(state.capturePoints||[]).filter(cp=>cp.owner==null&&cp.enabled!==false).sort((a,b)=>Math.hypot(a.x-cannon.x,a.y-cannon.y)-Math.hypot(b.x-cannon.x,b.y-cannon.y));
    if(open.length&&Math.hypot(open[0].x-cannon.x,open[0].y-cannon.y)<=LaunchRules.maxReach)return open[0];
    if(enemies.length){
      const near=enemies.slice().sort((a,b)=>Math.hypot(a.x-cannon.x,a.y-cannon.y)-Math.hypot(b.x-cannon.x,b.y-cannon.y)).slice(0,12);
      return centroid(near);
    }
    return enemyBase||null;
  }
  runLaunch(state){
    const side=this.side,main=BuildingDefinition.forRole("mainBase"),outpost=BuildingDefinition.forRole("outpost");
    const busy=new Set(this.commandExecutor.reservations().filter(p=>p.action.type==="LAUNCH").map(p=>p.action.cannonId));
    const cannons=state.buildings.filter(b=>b.side===side&&b.alive!==false&&(b.type===main||b.type===outpost)&&state.tick>=(Number(b.launchReadyTick)||0)&&!busy.has(b.id));
    for(const cannon of cannons){
      const affordable=LaunchRules.deck.filter(t=>LaunchRules.grain(t).cost<=state.wallet[side]);if(!affordable.length)return;
      const target=this.launchTarget(state,cannon);if(!target)return;
      const distance=Math.hypot(target.x-cannon.x,target.y-cannon.y);
      const reaching=affordable.filter(t=>LaunchRules.maxReachOf(t)>=distance),pool=reaching.length?reaching:affordable;
      const unitType=pool[HashUtil.hash(`${state.tick}|${cannon.id}`)%pool.length];
      const error=1+((HashUtil.hash(`${state.tick}|${cannon.id}|err`)%241)-120)/1000;
      const holdMs=Math.round(RangeUtil.clamp(LaunchRules.holdFor(distance,unitType)*error,0,LaunchRules.chargeMs));
      this.issueCommand({type:"LAUNCH",cannonId:cannon.id,x:Math.round(target.x),y:Math.round(target.y),holdMs,unitType});
    }
  }

  visionSources(state){return VisibilityPolicy.sources(state,this.side)}

  pointVisible(x,y,sources){
    const sim=this.session?.sim;if(sim)return sim.visionSources(this.side).visibleAt(x,y);
    return sources.some(s=>{const r=Number(s.r)||0,dx=s.x-x,dy=s.y-y;return dx*dx+dy*dy<=r*r});
  }

  pointDetected(x,y,sources){
    const sim=this.session?.sim;if(sim)return sim.visionSources(this.side).detectedAt(x,y);
    return sources.some(s=>{const r=Number(s.detect)||0,dx=s.x-x,dy=s.y-y;return r>0&&dx*dx+dy*dy<=r*r});
  }

  snapshotUnitStealthed(state,u){
    if(!u?.alive)return false;
    if(BurrowableMixin.stateActive(u))return true;
    if(UnitDefinition.get(u.type)?.stealth)return true;
    for(const source of state.units){
      const rr=Number(UnitDefinition.get(source?.type)?.cloakAuraRadius)||0;
      if(rr<=0||!CloakAuraMixin.canAffect(source,u))continue;
      const dx=u.x-source.x,dy=u.y-source.y;
      if(dx*dx+dy*dy<=rr*rr)return true;
    }
    return false;
  }

  perceive(state){
    const sources=this.visionSources(state);

    const ownUnits=state.units.filter(u=>u.alive&&u.side===this.side);
    const ownArmy=ownUnits.filter(u=>!UnitDefinition.get(u.type)?.economyWorker);
    const ownWorkers=ownUnits.filter(u=>!!UnitDefinition.get(u.type)?.economyWorker);
    const ownBuildings=state.buildings.filter(b=>b.alive!==false&&b.side===this.side);

    const enemyUnits=state.units.filter(u=>
      u.alive&&u.side===1-this.side&&
      this.pointVisible(u.x,u.y,sources)&&
      (!this.snapshotUnitStealthed(state,u)||this.pointDetected(u.x,u.y,sources))
    );
    const enemyBuildings=state.buildings.filter(
      b=>b.alive!==false&&b.side===1-this.side&&this.pointVisible(b.x,b.y,sources)
    );

    // Active neutral resistance affects tactical march safety, not the opponent's
    // strategic army value. Passive wildlife and friendly garrisons are not threats.
    const campById=new Map((state.camps||[]).map(c=>[c.id,c]));
    const activeNeutralThreats=state.units.filter(u=>{
      if(!u.alive||u.side!==NEUTRAL_SIDE)return false;
      const neutral=Unit.neutralStateOf(u),camp=campById.get(neutral?.campId);
      if(NeutralCampPolicy.friendlySide(camp)===this.side||!(neutral?.aggroed||camp?.engaged))return false;
      return this.pointVisible(u.x,u.y,sources)&&(!this.snapshotUnitStealthed(state,u)||this.pointDetected(u.x,u.y,sources));
    });

    // 캠프 위치는 공개 랜드마크다. 현재 상태는 실제 시야에서만 신뢰한다.
    const camps=(state.camps||[]).map(c=>({
      ...c,
      knownState:this.pointVisible(c.x,c.y,sources)?c.state:"unknown"
    }));

    return{
      sources,
      ownUnits,ownArmy,ownWorkers,ownBuildings,
      enemyUnits,enemyBuildings,activeNeutralThreats,
      capturePoints:state.capturePoints||[],
      camps,
      resources:state.resources||[]
    };
  }

  rememberEnemies(p,tick){
    for(const e of p.enemyUnits){
      this.enemyMemory.set(e.id,{
        id:e.id,type:e.type,x:e.x,y:e.y,isBuilding:false,tick
      });
    }
    for(const b of p.enemyBuildings){
      this.enemyMemory.set(b.id,{
        id:b.id,type:b.type,x:b.x,y:b.y,isBuilding:true,tick
      });
    }
    for(const [id,m] of this.enemyMemory){
      if(tick-m.tick>SimulationTiming.msToTicks(30000,this.session?.sim?.tps||SIM_TPS))this.enemyMemory.delete(id);
    }
  }

  supplyUsed(state){return SupplyPolicy.used(state,this.side)}
  supplyCap(state){return SupplyPolicy.cap(state,this.side)}

  deck(){return this.lastSnapshot?.decks?.[this.side]||this.session.sim?.decks?.[this.side]||this.session.draft?.decks?.[this.role]||[]}

  productionBuildingType(unitType){
    return (UnitDefinition.get(unitType)?.tier||0)>=3?"factory":"barracks";
  }

  productionPrerequisitesReady(state,unitType){return !BuildPrerequisitePolicy.unitReason(state,this.side,unitType)}

  enemyAirThreat(state,p){
    let threat=0;
    for(const u of p.enemyUnits||[]){
      if(UnitDefinition.get(u.type)?.layer==="AIR")threat+=2;
    }
    const freshAfter=(state.tick||0)-SimulationTiming.msToTicks(12000,this.session?.sim?.tps||SIM_TPS);
    for(const m of this.enemyMemory.values()){
      if(m.isBuilding||m.tick<freshAfter)continue;
      if(UnitDefinition.get(m.type)?.layer==="AIR")threat+=1;
    }
return threat;
  }

  orderedProductionUnits(state,p,units){
    const scores=new Map(AiActionGenerator.unitScores(this,state,p).map(pick=>[pick.id,pick]));
    const airThreat=this.enemyAirThreat(state,p);
    return units.slice().sort((a,b)=>{
      const da=UnitDefinition.get(a)||{},db=UnitDefinition.get(b)||{};
      const readyA=this.productionPrerequisitesReady(state,a)?1:0;
      const readyB=this.productionPrerequisitesReady(state,b)?1:0;
      if(readyA!==readyB)return readyB-readyA;
      const pickA=scores.get(a),pickB=scores.get(b);
      const affordableA=pickA?.affordableNow?1:0,affordableB=pickB?.affordableNow?1:0;
      if(affordableA!==affordableB)return affordableB-affordableA;
      const scoreA=pickA?.score??-Infinity,scoreB=pickB?.score??-Infinity;
      if(scoreA!==scoreB)return scoreA>scoreB?-1:1;
      if(airThreat>0){
        const aaA=da.canAttackAir?1:0,aaB=db.canAttackAir?1:0;
        if(aaA!==aaB)return aaB-aaA;
      }
      // 아직 공중 배양소가 없으면 실행 불가능한 AIR 카드가 지상 생산을 막지 않는다.
      const airA=da.layer==="AIR"?1:0,airB=db.layer==="AIR"?1:0;
      if(airA!==airB)return airA-airB;
      const ca=UnitDefinition.productionCost(a),cb=UnitDefinition.productionCost(b);
      if(ca.gas!==cb.gas)return ca.gas-cb.gas;
      if(ca.mineral!==cb.mineral)return ca.mineral-cb.mineral;
      return String(a).localeCompare(String(b));
    });
  }

  productionContractCount(state,unitType){
    const building=this.productionBuildingType(unitType);
    return this.plannedBuildings(state).filter(b=>
      b.alive!==false&&b.side===this.side&&b.type===building&&b.produceType===unitType
    ).length;
  }

  totalProductionContractCount(state){
    return this.plannedBuildings(state).filter(b=>
      b.alive!==false&&b.side===this.side&&BuildingDefinition.get(b.type)?.isProductionBuilding&&!!b.produceType
    ).length;
  }

  productionPipelineRemaining(state,unitType){
    return this.plannedBuildings(state).reduce((sum,b)=>{
      if(b.alive===false||b.side!==this.side||b.produceType!==unitType)return sum;
      return sum+Math.max(0,Number(b.productionRemaining)||0);
    },0);
  }

  surplusProductionCap(state){
    const wallet=state.wallet?.[this.side]||0;
    const bases=this.workerBases(state).length;
    const deckSize=this.deck().filter(id=>!!UnitDefinition.get(id)).length;
    // 3,000 미네랄 같은 후반 과잉 상태에서는 실제로 여러 경제 tick에 걸쳐
    // 병렬 계약을 충분히 늘릴 수 있어야 한다. 거점 하나뿐이어도 +5축까지 허용한다.
    const extra=wallet>=2400?7:wallet>=1600?5:wallet>=900?3:wallet>=650?2:0;
    const spatialAllowance=Math.max(5,bases*4);
    return Math.min(18,Math.max(deckSize,deckSize+Math.min(extra,spatialAllowance)));
  }

  projectedRepeatGasReserve(state){
    const wallet=state.wallet?.[this.side]||0;
    if(wallet<650)return 0;
    const ready=this.deck()
      .filter(id=>this.productionPrerequisitesReady(state,id))
      .map(id=>UnitDefinition.productionCost(id).gas)
      .filter(v=>v>0)
      .sort((a,b)=>b-a);
    if(!ready.length)return 0;
    const repetitions=wallet>=1800?2:1;
    return Math.min(500,ready[0]*repetitions);
  }

  trySurplusProduction(state,p){
    const wallet=state.wallet?.[this.side]||0,gas=state.gasWallet?.[this.side]||0;
    const signals=this.strategicSignals(state,p);
    // 생산시설에서 밀리거나 적이 초반 경제에 치우치면 현금을 쌓지 말고 즉시 병력 축으로 전환한다.
    const spendFloor=(signals.productionWeight>=40||signals.armyWeight>=45||signals.rushWeight>=60)?275:(signals.spendPressure>=1.35?325:425);
    if(wallet<spendFloor)return false;
    const totalContracts=this.totalProductionContractCount(state);
    const cap=this.surplusProductionCap(state);
    if(totalContracts>=cap)return false;

    const airThreat=this.enemyAirThreat(state,p);
    const unitScores=new Map(AiActionGenerator.unitScores(this,state,p).map(pick=>[pick.id,pick.score]));
    const candidates=[];
    for(const id of this.deck()){
      if(!this.productionPrerequisitesReady(state,id))continue;
      const d=UnitDefinition.get(id)||{},c=UnitDefinition.productionCost(id),existing=this.productionContractCount(state,id);
      if(d.role==="support"&&(unitScores.get(id)??0)<0)continue;
      const maxPerType=c.gas>0?2:(wallet>=1800?3:2);
      if(existing>=maxPerType)continue;
      const pipeline=this.productionPipelineRemaining(state,id);
      const affordable=wallet>=c.mineral&&gas>=c.gas;
      let score=unitScores.get(id)||0;
      // 미네랄이 남는데 가스가 부족하면 미네랄 병종을 즉시 증원한다.
      if(c.gas===0)score+=120;
      else if(affordable)score+=55;
      if(signals.playerProductionAhead)score+=70;
      if(signals.enemyGreedEarly)score+=55;
      else score-=Math.min(140,(c.gas-gas)*.7);
      if(airThreat>0&&d.canAttackAir)score+=83;
      score+=(d.tier||1)*8;
      score-=existing*34;
      score-=Math.min(45,pipeline*2);
      // 계약이 거의 바닥난 병종은 미리 다음 계약을 붙여 생산 공백을 줄인다.
      if(existing>0&&pipeline<=Math.max(2,UnitDefinition.productionProfile(id)?.batchSize||1))score+=45;
      candidates.push({id,c,score,affordable});
    }
    candidates.sort((a,b)=>b.score-a.score||a.c.gas-b.c.gas||a.c.mineral-b.c.mineral||String(a.id).localeCompare(String(b.id)));
    for(const pick of candidates){
      if(!pick.affordable)continue;
      const building=this.productionBuildingType(pick.id);
      if(this.tryBuild(state,p,building,pick.id,null,{allowProductionDensity:true}))return true;
    }
    return false;
  }

  projectedGasNeed(state){
    const deck=this.deck(),gas=state.gasWallet?.[this.side]||0;
    let need=0;

    if(deck.some(id=>UnitDefinition.get(id)?.layer==="AIR")&&this.countBuilding(state,BuildingDefinition.forRole("airTech"))===0){
      need+=BuildingDefinition.gasCost(BuildingDefinition.forRole("airTech"));
    }

    const missing=[];
    for(const id of deck){
      const building=this.productionBuildingType(id);
      if(this.countBuilding(state,building,id)>0)continue;
      const d=UnitDefinition.get(id)||{},tech=state.tech?.[this.side]||1;
      if(d.tier<=tech+1)missing.push(UnitDefinition.productionCost(id).gas);
    }
    missing.sort((a,b)=>b-a);
    need+=missing.slice(0,2).reduce((a,b)=>a+b,0);

    // 실제로 접근 가능한 특수 연구 한 건 정도는 생산축 이후에도 가스 목표에 포함.
    const researchNeeds=[];
    for(const id of deck){
      if(ABILITY_INFO[id]&&!state.abilities?.[this.side]?.[id]&&(UnitDefinition.get(id)?.tier||1)<=(state.tech?.[this.side]||1)+1)researchNeeds.push(ResearchDefinition.abilityForUnit(id).gasCost);
      for(const def of UnitSpecialResearchDefinition.forUnit(id))if(!state.specialResearch?.[this.side]?.[def.id]&&ResearchDefinition.specialResearchPrereqMet(state,this.side,def))researchNeeds.push(def.gasCost);
    }
    researchNeeds.sort((a,b)=>a-b);
    if(researchNeeds.length)need+=researchNeeds[0];

    // 테크가 끝난 뒤에도 미네랄이 남아 있으면 다음 반복 생산계약을 위한 가스 버퍼를 유지한다.
    // 이전에는 신규 테크/누락 시설만 계산해 후반에 가스 일꾼이 0명으로 내려가는 문제가 있었다.
    need+=this.projectedRepeatGasReserve(state);

    return Math.max(0,Math.min(700,need-gas));
  }

  rawGasWorkerDemand(state){
    const completed=state.buildings.filter(b=>
      b.alive!==false&&b.complete&&b.side===this.side&&BuildingDefinition.get(b.type)?.isGasExtractor
    );
    if(!completed.length)return 0;
    const shortage=this.projectedGasNeed(state);
    const gas=state.gasWallet?.[this.side]||0;
    let perExtractor=0;
    if(shortage>=140)perExtractor=3;
    else if(shortage>0)perExtractor=2;
    else if(gas<225&&this.deck().some(id=>UnitDefinition.productionCost(id).gas>0||UnitSpecialResearchDefinition.hasOptions(id)))perExtractor=1;
    return Math.max(0,Math.min(GAS_ASSIGNMENT_MAX*Math.max(1,this.workerBases(state).length),perExtractor*completed.length));
  }

  desiredMineralWorkers(state){
    const bases=Math.max(1,this.workerBases(state).length);
    const wallet=state.wallet?.[this.side]||0;
    const productionAxes=state.buildings.filter(b=>
      b.alive!==false&&b.complete&&b.side===this.side&&
      BuildingDefinition.get(b.type)?.isProductionBuilding&&
      (b.produceType||(b.productionRemaining||0)>0)
    ).length;
    // Keep a real mineral economy alive even while gas/builders consume workers.
    // Parallel production raises the floor modestly, but wallet pressure remains the main
    // late-game signal so early one-base pacing does not inflate.
    let target=7+Math.max(0,bases-1)*3;
    if(wallet>=800)target+=1;
    if(wallet>=1600)target+=2;
    if(wallet>=2800)target+=2;
    if(productionAxes>=3)target+=1;
    if(productionAxes>=6)target+=1;
    return RangeUtil.clamp(target,7,16);
  }

  activeConstructionDemand(state){
    const activeTargets=new Set(
      state.buildings.concat(state.constructionOrders||[])
        .filter(b=>b.alive!==false&&b.side===this.side&&!b.complete&&b.type!=="wall")
        .map(b=>b.id)
    );
    if(!activeTargets.size)return 0;
    // Count workers that are actually detached from gathering for construction.
    // An unfinished building waiting for a replacement builder must not inflate the target.
    return state.units.filter(u=>
      u.alive&&u.side===this.side&&!!UnitDefinition.get(u.type)?.economyWorker&&
      u.buildTargetId!=null&&activeTargets.has(u.buildTargetId)
    ).length;
  }

  queuedWorkerCount(state){
    return this.workerBases(state).reduce((sum,b)=>sum+(b.queue||[]).filter(q=>q.kind==="workerProduction").length,0);
  }

  desiredWorkerTarget(state,p){
    const wallet=state.wallet?.[this.side]||0;
    const mineral=this.desiredMineralWorkers(state);
    const gas=this.rawGasWorkerDemand(state);
    const builders=Math.min(5,this.activeConstructionDemand(state));
    // When several structures are being placed, keep one spare worker so the next build
    // does not immediately steal from the minimum mineral line again.
    let reserve=builders>=2?1:0;
    if(wallet>=1600&&(builders>0||gas>0))reserve+=1;
    return RangeUtil.clamp(mineral+gas+builders+reserve,10,26);
  }

  desiredGasWorkers(state,p){
    const raw=this.rawGasWorkerDemand(state);
    if(raw<=0)return 0;
    // Gas may expand aggressively, but never collapse the mineral line below its dynamic floor.
    const mineralFloor=Math.min(this.desiredMineralWorkers(state),Math.max(3,(p.ownWorkers?.length||0)-1));
    return Math.max(0,Math.min(raw,Math.max(0,(p.ownWorkers?.length||0)-mineralFloor)));
  }

  updateGasAssignments(state,p,bases){
    const extractors=state.buildings.filter(b=>
      b.alive!==false&&b.complete&&b.side===this.side&&BuildingDefinition.get(b.type)?.isGasExtractor
    );
    const desired=this.desiredGasWorkers(state,p);
    const ordered=bases.slice().sort((a,b)=>{
      const da=extractors.reduce((v,g)=>Math.min(v,Math.hypot(a.x-g.x,a.y-g.y)),Infinity);
      const db=extractors.reduce((v,g)=>Math.min(v,Math.hypot(b.x-g.x,b.y-g.y)),Infinity);
      return da-db||(a.id<b.id?-1:1);
    });

    // gasWorkerTarget belongs to a dropoff/base, while actual workers are grouped by their
    // nearest dropoff in StrategySim. Build the same deterministic grouping here so a 3/3
    // fair split cannot strand demand on a base that only has one worker.
    const workersPerBase=new Map(ordered.map(b=>[b.id,0]));
    for(const worker of p.ownWorkers||[]){
      let nearest=null,nearestD=Infinity;
      for(const base of bases){
        const dx=worker.x-base.x,dy=worker.y-base.y,d=dx*dx+dy*dy;
        if(d<nearestD||(d===nearestD&&nearest&&base.id<nearest.id)){
          nearest=base;nearestD=d;
        }
      }
      if(nearest)workersPerBase.set(nearest.id,(workersPerBase.get(nearest.id)||0)+1);
    }

    let remain=desired;
    const planned=new Map();
    for(const base of ordered){
      // One base may feed several extractors. The cap is the real local worker count,
      // not "3 per base"; global desiredGasWorkers() already protects the mineral floor.
      const localWorkers=workersPerBase.get(base.id)||0;
      const target=Math.min(GAS_ASSIGNMENT_MAX,remain,localWorkers);
      planned.set(base.id,target);
      remain-=target;
    }

    // one-action-per-decision: when redistributing, lower stale targets first so
    // a transient tick never sends more workers to gas than the side-wide demand.
    for(const base of ordered){
      const current=RangeUtil.clamp(Number(base.gasWorkerTarget)||0,0,GAS_ASSIGNMENT_MAX);
      const target=planned.get(base.id)||0;
      if(current>target){
        this.issueCommand({type:"SET_GAS_WORKERS",buildingId:base.id,target});
        return true;
      }
    }
    for(const base of ordered){
      const current=RangeUtil.clamp(Number(base.gasWorkerTarget)||0,0,GAS_ASSIGNMENT_MAX);
      const target=planned.get(base.id)||0;
      if(current<target){
        this.issueCommand({type:"SET_GAS_WORKERS",buildingId:base.id,target});
        return true;
      }
    }
    return false;
  }

  // Planning commitments only. Completed capabilities continue to read state.buildings.
  plannedBuildings(state){
    const plans=(state.constructionOrders||[]).map(order=>({...order,complete:false,productionRemaining:UnitDefinition.productionProfile(order.produceType)?.totalUnits||0}));
    for(const entry of this.commandExecutor.reservations(state))if(entry.action.type==="BUILD"){
      const a=entry.action;plans.push({type:a.building,side:this.side,x:a.x,y:a.y,produceType:a.produceType,complete:false,productionRemaining:UnitDefinition.productionProfile(a.produceType)?.totalUnits||0});
    }
    return state.buildings.concat(plans);
  }

  countBuilding(state,type,produceType=null){
    return this.plannedBuildings(state).filter(b=>
      b.alive!==false&&b.side===this.side&&b.type===type&&
      (produceType==null||b.produceType===produceType)
    ).length;
  }

  

  workerBases(state){
    return state.buildings.filter(
      b=>b.alive!==false&&b.side===this.side&&b.complete&&
         BuildingDefinition.get(b.type)?.isDropoff
    );
  }

  productionFacilityCount(state,side){
    return state.buildings.filter(b=>
      b.alive!==false&&b.complete&&b.side===side&&BuildingDefinition.get(b.type)?.isProductionBuilding
    ).length;
  }

  aiDecisionContext(state,p){
    const observation=AiObservationBuilder.build(this,state,p);
    const situation=AiSituationAnalyzer.analyze(observation);
    const weights=this.aiPolicy.intentWeights(observation,situation)||{};
    return{observation,situation,weights};
  }

  strategicSignals(state,p){
    const ctx=this.aiDecisionContext(state,p),o=ctx.observation,s=ctx.situation,w=ctx.weights;
    return{
      elapsedSec:o.elapsedSec,ownProduction:o.production.own,enemyProduction:o.production.enemyObserved,
      productionDelta:s.productionDelta,productionComparable:s.productionComparable,playerProductionAhead:s.playerProductionAhead,
      ownBases:o.economy.ownBases,enemyBases:o.economy.visibleEnemyBases,ownWorkers:o.economy.ownWorkers,
      enemyWorkers:o.economy.visibleEnemyWorkers,ownArmy:o.military.ownArmy,enemyArmy:o.military.enemyObservedArmy,
      neutralCaptures:o.map.neutralObjectives,enemyGreedEarly:s.enemyGreedEarly,
      expansionWeight:Number(w.expand||0),defenseWeight:Number(w.defend||0),rushWeight:Number(w.rush||0),
      armyWeight:Number(w.army||0),productionWeight:Number(w.production||0),fortifyWeight:Number(w.fortify||0),
      spendPressure:o.economy.spendPressure,observation:o,situation:s
    };
  }

  runEconomy(state,p){
    const wallet=state.wallet[this.side]||0;
    const gas=state.gasWallet?.[this.side]||0;
    const supplyUsed=this.supplyUsed(state);
    const supplyCap=this.supplyCap(state);
    const bases=this.workerBases(state);
    const workerTarget=this.desiredWorkerTarget(state,p);
    const queuedWorkers=this.queuedWorkerCount(state);
    const projectedWorkers=p.ownWorkers.length+queuedWorkers;

    // Worker target = mineral gatherers + gas gatherers + workers currently lost to construction + a small build reserve.
    // Queue already-trained workers count toward the target so several bases do not overshoot it.
    if(projectedWorkers<workerTarget&&wallet>=WORKER_COST&&supplyUsed+1<=supplyCap){
      const deficit=workerTarget-projectedWorkers;
      const perBaseQueueLimit=deficit>=4?WORKER_QUEUE_LIMIT:3;
      const base=bases
        .filter(b=>(b.queue||[]).filter(q=>q.kind==="workerProduction").length<perBaseQueueLimit)
        .sort((a,b)=>(a.queue?.length||0)-(b.queue?.length||0)||(a.id<b.id?-1:1))[0];
      if(base){
        this.issueCommand({type:"TRAIN_WORKER",buildingId:base.id});
        return;
      }
    }

    const deck=this.deck();
    const t1=deck.filter(id=>UnitDefinition.get(id)?.tier===1);
    const t2=deck.filter(id=>UnitDefinition.get(id)?.tier===2);
    const t3=deck.filter(id=>UnitDefinition.get(id)?.tier===3);
    const airDeck=deck.filter(id=>UnitDefinition.get(id)?.layer==="AIR");
    const gasShortage=this.projectedGasNeed(state);
    const gasDemand=gasShortage>0;

    if(gasDemand){
      const extractors=this.plannedBuildings(state).filter(
        b=>b.alive!==false&&b.side===this.side&&BuildingDefinition.get(b.type)?.isGasExtractor
      );
      const maxExtractors=Math.max(1,Math.min(3,bases.length));
      const expandGas=gasShortage>=250&&wallet>=900&&extractors.length<maxExtractors;
      if((extractors.length===0||expandGas)&&wallet>=BuildingDefinition.get(BuildingDefinition.forRole("gasExtractor")).cost){
        if(this.tryBuild(state,p,BuildingDefinition.forRole("gasExtractor")))return;
      }
      if(this.updateGasAssignments(state,p,bases))return;
    }else if(bases.some(b=>(b.gasWorkerTarget||0)>0)){
      if(this.updateGasAssignments(state,p,bases))return;
    }

    const freeSupply=supplyCap-supplyUsed;
    if((freeSupply<=4||supplyCap>0&&supplyUsed/supplyCap>=.82)&&wallet>=BuildingDefinition.get(BuildingDefinition.forRole("supply")).cost){
      if(this.tryBuild(state,p,BuildingDefinition.forRole("supply")))return;
    }

    // 적 AIR이 이미 보이면 공중 테크 투자보다 현재 당장 건설 가능한 이동식 대공 생산축을 먼저 확보한다.
    if(this.enemyAirThreat(state,p)>0){
      for(const unit of this.orderedProductionUnits(state,p,deck.filter(id=>UnitDefinition.get(id)?.canAttackAir))){
        if(!this.productionPrerequisitesReady(state,unit))continue;
        const building=this.productionBuildingType(unit);
        if(this.countBuilding(state,building,unit)>0)continue;
        {const c=UnitDefinition.productionCost(unit);if(wallet<c.mineral||gas<c.gas)continue;}
        if(this.tryBuild(state,p,building,unit))return;
      }
    }

    // AIR 카드는 실제 공중 배양소가 완공된 뒤에만 생산시설 후보가 된다.
    // 배양소가 아직 없으면 지상 생산축을 막지 않고, 가스가 모이는 즉시 배양소를 올린다.
    if(
      airDeck.length&&
      this.countBuilding(state,BuildingDefinition.forRole("airTech"))===0&&
      wallet>=BuildingDefinition.get(BuildingDefinition.forRole("airTech")).cost&&
      gas>=BuildingDefinition.gasCost(BuildingDefinition.forRole("airTech"))
    ){
      if(this.tryBuild(state,p,BuildingDefinition.forRole("airTech")))return;
    }

    const buildMissingProduction=(units)=>{
      for(const unit of this.orderedProductionUnits(state,p,units)){
        if(!this.productionPrerequisitesReady(state,unit))continue;
        const building=this.productionBuildingType(unit);
        if(this.countBuilding(state,building,unit)>0)continue;
        const c=UnitDefinition.productionCost(unit);
        if(wallet<c.mineral||gas<c.gas)continue;
        if(this.tryBuild(state,p,building,unit))return true;
      }
      return false;
    };

    // 적 AIR이 보이거나 최근 관측됐으면 현재 테크에서 가능한 mobile AA 생산축을 먼저 복구/건설한다.
    if(this.enemyAirThreat(state,p)>0){
      const aa=deck.filter(id=>UnitDefinition.get(id)?.canAttackAir);
      if(buildMissingProduction(aa))return;
    }

    // T1 생산축. 실행 가능한 지상/공중 선행조건을 먼저 만족한 카드만 건설한다.
    if(buildMissingProduction(t1))return;

    // 플레이어 생산시설이 앞서거나 초반 경제에 과투자하면 테크/장식성 투자보다
    // 실제 병력 생산축을 먼저 늘린다. 공짜 병력은 주지 않고 보유 자원을 즉시 소비한다.
    {
      const signals=this.strategicSignals(state,p);
      if((signals.playerProductionAhead||signals.enemyGreedEarly)&&this.trySurplusProduction(state,p))return;
    }

    // 이미 배운 테크의 실물 인프라가 파괴된 경우 신규 상위티어 생산이 막히므로
    // 일반 방어 투자보다 재건을 먼저 수행한다.
    if(
      state.tech[this.side]>=2&&t2.length>0&&
      this.countBuilding(state,BuildingDefinition.forRole("academy"))===0&&
      wallet>=BuildingDefinition.get(BuildingDefinition.forRole("academy")).cost
    ){
      if(this.tryBuild(state,p,BuildingDefinition.forRole("academy")))return;
    }
    if(
      state.tech[this.side]>=3&&t3.length>0&&
      this.countBuilding(state,BuildingDefinition.forRole("lab"))===0&&
      wallet>=BuildingDefinition.get(BuildingDefinition.forRole("lab")).cost
    ){
      if(this.tryBuild(state,p,BuildingDefinition.forRole("lab")))return;
    }

    // 첫 생산축 이후 선택한 방어 카드들을 거점별 슬롯/실제 위협에 맞춰 순회 배치한다.
    const defenseCards=DefenseCardDefinition.list(state.defenseCards?.[this.side]||this.session.draft?.defenseCards?.[this.role]);
    for(const defenseCard of defenseCards){
      const defenseBuilding=DefenseCardDefinition.get(defenseCard)?.building||null;
      const defenseAnchor=defenseBuilding?this.chooseDefenseAnchor(state,p,defenseBuilding):null;
      if(!defenseBuilding||!defenseAnchor)continue;
      const dc=BuildingDefinition.resourceCost(defenseBuilding);
      if(wallet>=dc.mineral+50&&gas>=dc.gas&&this.tryBuild(state,p,defenseBuilding,null,defenseAnchor.id))return;
    }

    // T1 생산축이 적어도 2개 확보되면 아카데미. 이미 배운 T2 지식은 유지되지만
    // 실물 아카데미가 파괴되면 신규 T2 생산시설을 위해 재건한다.
    const t1Ready=t1.filter(u=>this.countBuilding(state,"barracks",u)>0).length;
    if(
      t1Ready>=Math.min(2,t1.length)&&
      (state.tech[this.side]<2||t2.length>0)&&
      this.countBuilding(state,BuildingDefinition.forRole("academy"))===0&&
      wallet>=BuildingDefinition.get(BuildingDefinition.forRole("academy")).cost
    ){
      if(this.tryBuild(state,p,BuildingDefinition.forRole("academy")))return;
    }

    if(state.tech[this.side]>=2){
      // T2 카드 세 장을 전부 깔 때까지 Lab을 미루면 실제 AI 경기에서 T3가
      // 6분 안에 한 번도 출전하지 않는 경우가 반복됐다. 두 개의 T2 생산축으로
      // 중반 전선을 확보한 뒤 Lab을 먼저 올리고, 나머지 T2 계약은 그 다음 채운다.
      const t2Ready=t2.filter(u=>
        this.countBuilding(state,this.productionBuildingType(u),u)>0
      ).length;
      const t2BeforeLab=Math.min(2,t2.length);
      if(t2Ready<t2BeforeLab){
        if(buildMissingProduction(t2))return;
      }

      if(
        (state.tech[this.side]<3||t3.length>0)&&
        this.countBuilding(state,BuildingDefinition.forRole("lab"))===0&&
        wallet>=BuildingDefinition.get(BuildingDefinition.forRole("lab")).cost
      ){
        if(this.tryBuild(state,p,BuildingDefinition.forRole("lab")))return;
      }

      // Lab 건설을 시작한 뒤에는 남은 T2 생산축도 계속 보강한다.
      if(buildMissingProduction(t2))return;
    }

    if(state.tech[this.side]>=3){
      if(buildMissingProduction(t3))return;
    }

    // 핵심 생산축/테크를 갖춘 뒤 미네랄을 쌓아두지 않는다.
    // 병종별 첫 계약이 살아 있어도 후반 잉여 자원으로 병렬 증원 계약을 추가한다.
    if(this.trySurplusProduction(state,p))return;
  }

  defenseTowerCountAt(state,anchor){
    return this.plannedBuildings(state).filter(b=>
      b.alive!==false&&b.side===this.side&&BuildingDefinition.isDefenseTower(b.type)&&
      Math.hypot(b.x-anchor.x,b.y-anchor.y)<=DEFENSE_CLUSTER_RADIUS
    ).length;
  }

  chooseDefenseAnchor(state,p,type){
    const bd=BuildingDefinition.get(type);
    if(!bd)return null;
    const anchors=this.workerBases(state);
    if(!anchors.length)return null;
    const enemyAir=this.enemyAirThreat(state,p)>0;
    const canAA=!!bd.canAttackAir;
    const signals=this.strategicSignals(state,p);
    const scored=[];
    for(const a of anchors){
      const count=this.defenseTowerCountAt(state,a);
      // No hard defense-tower cap. Density fire-rate penalty is the soft limiter.
      let threat=0;
      for(const e of p.enemyUnits||[]){
        const dist=Math.hypot(e.x-a.x,e.y-a.y);
        if(dist>700)continue;
        const air=UnitDefinition.get(e.type)?.layer==="AIR";
        if(air&&!canAA)continue;
        threat+=dist<420?3:1;
      }
      // 기본적으로 본진 1기, 확보한 전진 거점 1기는 경제권 안전장치로 허용한다.
      let desired=1;
      if(threat>=3)desired=2;
      if(threat>=7)desired=3;
      // 플레이어 생산축이 더 크면 확보한 경제권을 먼저 요새화한다.
      if(signals.playerProductionAhead)desired+=1;
      if(enemyAir&&!canAA&&threat===0)desired=0;
      if(count>=desired)continue;
      const ad=BuildingDefinition.get(a.type)||{};
      let score=(Number(ad.aiDefenseAnchorBaseScore)||26)+threat*20-count*12+(Number(ad.aiDefenseAnchorBonus)||0)+signals.defenseWeight;
      scored.push({a,score});
    }
    scored.sort((x,y)=>y.score-x.score||(x.a.id<y.a.id?-1:1));
    return scored[0]?.a||null;
  }

  tryBuild(state,p,type,produceType=null,preferredAnchorId=null,options=null){
    const bd=BuildingDefinition.get(type),cost=BuildingDefinition.resourceCost(type,produceType);
    const productionLimit=this.campaignOffense?.config()?.productionLimit;
    if(bd?.isProductionBuilding&&productionLimit!=null){
      const active=this.plannedBuildings(state).filter(b=>b.alive!==false&&b.side===this.side&&BuildingDefinition.get(b.type)?.isProductionBuilding).length;
      if(active>=productionLimit)return false;
    }
    if(bd?.singleton&&this.countBuilding(state,type)>0)return false;
    if(bd?.supplyPlus&&this.plannedBuildings(state).some(b=>b.alive!==false&&b.side===this.side&&b.type===type&&!b.complete))return false;
    if(BuildPrerequisitePolicy.buildingReason(state,this.side,type,produceType))return false;
    if(!bd||(state.wallet[this.side]||0)<cost.mineral)return false;
    if((state.gasWallet?.[this.side]||0)<cost.gas)return false;

    const point=this.findBuildPoint(state,p,type,produceType,preferredAnchorId,options);
    if(!point)return false;

    const liveSim=this.session?.sim||null;
    if(liveSim){
      if(!liveSim.buildPointVisible(this.side,point.x,point.y))return false;
      if(liveSim.buildingOverlapsMineral(type,point.x,point.y))return false;
    }

    return this.issueCommand({
      type:"BUILD",
      building:type,
      produceType:produceType||null,
      x:point.x,
      y:point.y
    });
  }

  findBuildPoint(state,p,type,produceType,preferredAnchorId=null,options=null){
    const own=this.plannedBuildings(state).filter(b=>b.alive!==false&&b.side===this.side);

    if(BuildingDefinition.get(type)?.isGasExtractor){
      const liveSim=this.session?.sim||null;
      const occupied=new Set(
        own.filter(b=>BuildingDefinition.get(b.type)?.isGasExtractor).map(b=>b.gasNodeId)
      );
      const candidates=(state.gasNodes||[])
        .filter(g=>!occupied.has(g.id)&&!this.commandExecutor.conflictsBuilding(type,g.x,g.y))
        .filter(g=>this.pointVisible(g.x,g.y,p.sources))
        // 실제 BUILD 커밋과 같은 미네랄 충돌 규칙을 미리 적용한다.
        .filter(g=>!liveSim||!liveSim.buildingOverlapsMineral("gasExtractor",g.x,g.y))
        .sort((a,b)=>{
          const ba=this.workerBases(state).reduce((d,x)=>Math.min(d,Math.hypot(a.x-x.x,a.y-x.y)),Infinity);
          const bb=this.workerBases(state).reduce((d,x)=>Math.min(d,Math.hypot(b.x-x.x,b.y-x.y)),Infinity);
          return ba-bb||(a.id<b.id?-1:1);
        });
      const g=candidates[0];
      return g?{x:g.x,y:g.y}:null;
    }
    let anchors=own.filter(b=>b.complete&&BuildingDefinition.get(b.type)?.isDropoff);
    if(preferredAnchorId){
      const preferred=anchors.find(a=>a.id===preferredAnchorId);
      if(preferred)anchors=[preferred,...anchors.filter(a=>a.id!==preferredAnchorId)];
    }

    // 테크 건물/보급은 메인 후방, 생산시설은 전진거점도 활용.
    if(!preferredAnchorId)anchors.sort((a,b)=>{
      const bd=BuildingDefinition.get(type)||{},ad=BuildingDefinition.get(a.type)||{},bdAnchor=BuildingDefinition.get(b.type)||{};
      const techLike=!!(bd.longTech||bd.supplyPlus);
      const ap=techLike?(ad.aiBuildAnchorPriorityTech??1):(ad.aiBuildAnchorPriorityForward??1);
      const bp=techLike?(bdAnchor.aiBuildAnchorPriorityTech??1):(bdAnchor.aiBuildAnchorPriorityForward??1);
      return ap-bp;
    });

    const bd=BuildingDefinition.get(type);
    const production=!!bd?.isProductionBuilding;
    const allowProductionDensity=!!options?.allowProductionDensity;
    const defense=BuildingDefinition.isDefenseTower(type);
    const radii=defense?[145,205,265]:production?[300,380,220,450]:[170,235,300,365];
    const angleSteps=16;

    for(const anchor of anchors){
      const enemyMain=WorldContext.forState(state).bases[1-this.side];
      const dirX=defense?enemyMain.x-anchor.x:anchor.x-enemyMain.x;
      const dirY=defense?enemyMain.y-anchor.y:anchor.y-enemyMain.y;
      const backAngle=Math.atan2(dirY,dirX);

      for(const radius of radii){
        for(let i=0;i<angleSteps;i++){
          const angle=backAngle+(i%2===0?1:-1)*Math.ceil(i/2)*(Math.PI/8);
          const edgeMargin=buildingPlacementEdgeMargin(type);
          const x=Math.round(RangeUtil.clamp(anchor.x+Math.cos(angle)*radius,edgeMargin,WorldContext.forState(state).width-edgeMargin));
          const y=Math.round(RangeUtil.clamp(anchor.y+Math.sin(angle)*radius,edgeMargin,WorldContext.forState(state).height-edgeMargin));

          if(this.commandExecutor.conflictsBuilding(type,x,y))continue;
          // Same authoritative accessibility contract as BUILD: edge placement is
          // allowed, but at least one builder interaction face must remain usable.
          if(!buildingPlacementInsideWorld(type,x,y,WorldContext.forState(state))||!buildingHasBuilderApproach(state,type,x,y)||!buildingHasReachableBuilder(state,this.side,type,x,y))continue;

          // 실제로 아군 시야 안이어야 BUILD 커밋이 유효하다.
          if(!this.pointVisible(x,y,p.sources))continue;

          // 최신 절차맵/자원 판정을 그대로 사용한다.
          // 예전 고정 지형 상수를 보면 현재 맵과 다른 좌표를 검사하게 되고,
          // 특히 가스 노드를 놓친 후보를 반복 선택해 BUILD가 매번 거절될 수 있었다.
          const liveSim=this.session?.sim||null;
          if(liveSim){
            const terrain=liveSim.terrainAt(x,y);
            if(terrain.river||!this.session.sim.world.terrain.surfaces.buildable(x,y,bd.size+2))continue;
            if(liveSim.buildingOverlapsMineral(type,x,y))continue;
          }else{
            if((state.resources||[]).some(m=>
              Math.hypot(m.x-x,m.y-y)<bd.size+(m.r||28)+MINERAL_BUILD_MARGIN
            ))continue;
            if(!bd?.isGasExtractor&&(state.gasNodes||[]).some(g=>
              Math.hypot(g.x-x,g.y-y)<bd.size+(g.r||32)+14
            ))continue;
          }

          let collision=false;
          for(const b of own){
              if(Math.hypot(b.x-x,b.y-y)<buildingPlacementSeparation(type,b.type)){
              collision=true;break;
            }
          }
          if(collision)continue;

          if(production){
            const nearby=own.filter(b=>
              b.complete&&BuildingDefinition.get(b.type)?.isProductionBuilding&&
              Math.hypot(b.x-x,b.y-y)<=PRODUCTION_CLUSTER_RADIUS
            ).length;
            // 기본 AI는 밀집 패널티를 피하지만, 후반 잉여 자원 증원은 1개 인접까지 허용한다.
            // 2개 이상 인접(70% 이하)은 여전히 피해서 무의미한 건물 도배는 방지한다.
            if((!allowProductionDensity&&nearby>0)||(allowProductionDensity&&nearby>=2))continue;
          }

          return{x,y};
        }
      }
    }
    return null;
  }

  runResearch(state,p){
    if((state.tech?.[this.side]||1)<2)return false;
    const wallet=state.wallet[this.side]||0;
    const queues=state.researchQueues?.[this.side]||{};
    // Lab이 아직 없고 T3 카드가 남아 있으면 그 건설비를 연구가 먼저 소모하지 않는다.
    // Lab 건설을 시작한 뒤(countBuilding>0)에는 다시 일반 연구를 허용한다.
    const needsLab=(state.tech?.[this.side]||1)===2&&
      this.deck().some(id=>UnitDefinition.get(id)?.tier===3)&&
      this.countBuilding(state,BuildingDefinition.forRole("lab"))===0;
    const techReserve=needsLab?BuildingDefinition.get(BuildingDefinition.forRole("lab")).cost:0;
    const lvA=state.attackUpgrade?.[this.side]||0;
    const attackDef=ResearchDefinition.all.attack[lvA];
    if(!queues.attack&&attackDef&&wallet>=attackDef.cost+80+techReserve){
      return this.issueCommand({type:"START_RESEARCH",research:"attack"});
    }
    const lvD=state.armorUpgrade?.[this.side]||0;
    const armorDef=ResearchDefinition.all.armor[lvD];
    if(!queues.armor&&armorDef&&wallet>=armorDef.cost+80+techReserve){
      return this.issueCommand({type:"START_RESEARCH",research:"armor"});
    }
    if(!queues.ability){
      const gas=state.gasWallet?.[this.side]||0;
      for(const unit of this.deck()){
        if(ABILITY_INFO[unit]&&!state.abilities?.[this.side]?.[unit]){
          const def=ResearchDefinition.abilityForUnit(unit);
          if(wallet>=def.cost+80+techReserve&&gas>=def.gasCost){return this.issueCommand({type:"START_RESEARCH",research:"ability",unit})}
        }
        for(const def of UnitSpecialResearchDefinition.forUnit(unit)){
          if(state.specialResearch?.[this.side]?.[def.id]||!ResearchDefinition.specialResearchPrereqMet(state,this.side,def))continue;
          if(wallet>=def.cost+80+techReserve&&gas>=def.gasCost){return this.issueCommand({type:"START_RESEARCH",research:"ability",unit,researchId:def.id})}
        }
      }
    }
    return false;
  }

  handleTacticalChest(state,p){
    const replacement=state.pendingSpellReplacement?.[this.side];
    if(replacement){
      const equipped=state.equippedSpells?.[this.side]||[];
      if(equipped.length){
        // Replace the lowest utility currently equipped spell for the bot.
        const score=id=>{
          if(id==="meteor")return p.enemyBuildings.length*16+p.enemyUnits.length*3+20;
          if(id==="march")return p.ownArmy.length*4+18;
          if(id==="flare")return p.enemyUnits.length?18:30;
          if(id==="tunnel")return p.ownArmy.length>=7?34:14;
          if(id==="healspore")return p.ownArmy.length*3+20;
          if(id==="rootbind")return p.enemyUnits.length*3+18;
          if(id==="sporestorm")return p.enemyUnits.length*4+18;
          if(id==="thornwall")return p.enemyUnits.length*2+18;
          if(id==="recall")return p.ownArmy.length>=8?28:16;
          return 10;
        };
        const old=equipped.slice().sort((a,b)=>score(a)-score(b)||String(a).localeCompare(String(b)))[0];
        this.issueCommand({type:"REPLACE_SPELL",offerId:replacement.offerId,oldSpellId:old});
      }
      return true;
    }

    const offer=state.pendingChestOffers?.[this.side];
    if(offer){
      const rewardScore=r=>{
        if(r.type==="spell-new")return 58;
        if(r.type==="spell-equip")return 44;
        if(r.type==="spell-upgrade")return 52;
        if(r.id==="mixed-220-70")return 48;
        if(r.gas)return (state.gasWallet?.[this.side]||0)<150?50:30;
        return 38+(Number(r.mineral)||0)/30;
      };
      const pick=offer.options.slice().sort((a,b)=>rewardScore(b)-rewardScore(a)||String(a.id).localeCompare(String(b.id)))[0];
      if(pick)this.issueCommand({type:"CHOOSE_TACTICAL_REWARD",offerId:offer.id,rewardId:pick.id});
      return true;
    }

    if((state.spellChests?.[this.side]||0)>0){
      this.issueCommand({type:"OPEN_TACTICAL_CHEST"});
      return true;
    }
    return false;
  }

  runResponsePlanner(state,p){
    const plan=AiResponsePlanner.plan(this,state,p);
    this.lastResponsePlan=plan;
    const scheduled=AiActionScheduler.run(this,state,p,plan),executed=scheduled?.primary||null;
    if(executed){
      this.lastExecutedMacro={tick:state.tick,id:executed.id,kind:executed.kind,intent:executed.intent,priority:executed.priority,actions:(scheduled.actions||[]).map(a=>a.id)};
      this.lastAiDecision={tick:state.tick,action:executed.id,intent:executed.intent,utility:executed.utility??executed.priority};
    }else if(plan.selected){
      this.lastAiDecision={tick:state.tick,action:plan.selected.id,intent:plan.selected.intent,utility:plan.selected.utility??plan.selected.priority,blocked:true};
    }
    this.aiTrace.record({tick:state.tick,observation:plan.observation,situation:plan.situation,legalActions:plan.actions.map(a=>({id:a.id,kind:a.kind,intent:a.intent,priority:a.priority,deadlineSec:a.deadlineSec??null})),selected:this.lastAiDecision,executed:this.lastExecutedMacro});
  }

  

  armyDistance(p,x,y){
    if(!p.ownArmy.length)return 99999;
    let sum=0;
    const army=p.ownArmy.slice(0,12);
    for(const u of army)sum+=Math.hypot(u.x-x,u.y-y);
    return sum/army.length;
  }

  armyCenter(p){
    if(!p.ownArmy.length)return null;
    let x=0,y=0;
    for(const u of p.ownArmy){x+=u.x;y+=u.y}
    return{x:x/p.ownArmy.length,y:y/p.ownArmy.length};
  }

  setFlag(x,y,options={}){
    const target={x:Math.round(x),y:Math.round(y),forced:!!options.forced};
    const matches=f=>f&&!!f.forced===target.forced&&Math.hypot(target.x-f.x,target.y-f.y)<90;
    if(matches(this.lastSnapshot?.flags?.[this.side])||this.commandExecutor.outstanding().some(entry=>entry.action.type==="SET_FLAG"&&matches(entry.action)))return false;
    return this.issueCommand({type:"SET_FLAG",x:target.x,y:target.y,forced:target.forced});
  }

  spellReady(state,id){
    const e=state.spellBooks?.[this.side]?.[id];
    return !!e?.unlocked&&(state.equippedSpells?.[this.side]||[]).includes(id)&&state.tick>=(e.cooldownUntil||0);
  }

  spellPointAllowed(p,x,y,margin){
    const sim=this.session?.sim;if(sim)return sim.spellTargetAllowed(this.side,x,y,margin||0);
    return p.sources.some(s=>{const r=(Number(s.r)||0)+(margin||0),dx=s.x-x,dy=s.y-y;return dx*dx+dy*dy<=r*r});
  }

  bestEnemyClusterPoint(p,radius,{groundOnly=false}={}){
    let best=null,bestScore=-1;
    for(const seed of p.enemyUnits||[]){
      if(groundOnly&&UnitDefinition.get(seed.type)?.layer==="AIR")continue;
      let score=0;
      for(const e of p.enemyUnits||[]){
        if(groundOnly&&UnitDefinition.get(e.type)?.layer==="AIR")continue;
        if(Math.hypot(e.x-seed.x,e.y-seed.y)<=radius){
          const role=UnitDefinition.get(e.type)?.role||"";
          score+=(["artillery","support","caster","ranged","skirmisher"].includes(role)?2:1);
        }
      }
      if(score>bestScore||(score===bestScore&&best&&String(seed.id)<String(best.id))){
        bestScore=score;best={id:seed.id,x:seed.x,y:seed.y,score};
      }
    }
    return best;
  }

  runSpells(state,p){
    const target=this.currentTarget;
    const center=this.armyCenter(p);
    const stat=id=>SpellDefinition.statsAt(id,state.spellBooks?.[this.side]?.[id]?.mastery||0);
    const meteorStats=stat("meteor");

    // 메테오: 보이는 생산시설/거점 밀집 지역을 우선.
    if(this.spellReady(state,"meteor")){
      let best=null,bestScore=0;

      const points=[
        ...p.enemyBuildings.map(b=>({x:b.x,y:b.y})),
        ...p.enemyUnits.map(u=>({x:u.x,y:u.y}))
      ];

      for(const pt of points){
        if(!this.spellPointAllowed(p,pt.x,pt.y,SpellDefinition.all.meteor.castMargin))continue;

        let score=0;
        for(const b of p.enemyBuildings){
          if(Math.hypot(b.x-pt.x,b.y-pt.y)<=meteorStats.radius){
            score+=Number(BuildingDefinition.get(b.type)?.aiMeteorValue)||30;
          }
        }
        for(const u of p.enemyUnits){
          if(Math.hypot(u.x-pt.x,u.y-pt.y)<=meteorStats.radius)score+=6;
        }

        if(score>bestScore){bestScore=score;best=pt}
      }

      if(best&&bestScore>=30){
        this.issueCommand({
          type:"CAST_SPELL",spellId:"meteor",
          x:Math.round(best.x),y:Math.round(best.y)
        });
        return;
      }
    }

    // 진군 가속: 주력군이 충분히 모였을 때 사용.
    if(
      center&&p.ownArmy.length>=5&&
      this.spellReady(state,"march")&&
      this.spellPointAllowed(p,center.x,center.y,SpellDefinition.all.march.castMargin)
    ){
      this.issueCommand({
        type:"CAST_SPELL",spellId:"march",
        x:Math.round(center.x),y:Math.round(center.y)
      });
      return;
    }

    // 신호탄: 목표 지역이 현재 시야 밖이면 사용.
    if(
      target&&this.spellReady(state,"flare")&&
      !this.pointVisible(target.x,target.y,p.sources)&&
      this.spellPointAllowed(p,target.x,target.y,SpellDefinition.all.flare.castMargin)
    ){
      this.issueCommand({
        type:"CAST_SPELL",spellId:"flare",
        x:Math.round(target.x),y:Math.round(target.y)
      });
      return;
    }

    // 회복 포자: 교전 중 다친 주력군이 많으면 사용.
    if(center&&this.spellReady(state,"healspore")){
      const injured=p.ownArmy.filter(u=>u.hp<u.maxHp*.72).length;
      if(injured>=3&&this.spellPointAllowed(p,center.x,center.y,SpellDefinition.all.healspore.castMargin)){
        this.issueCommand({type:"CAST_SPELL",spellId:"healspore",x:Math.round(center.x),y:Math.round(center.y)});return;
      }
    }

    // 포자 폭풍 / 가시 장벽 / 속박 뿌리: 첫 번째 적이 아니라 실제 밀집 중심을 선택한다.
    if(p.enemyUnits.length>=3){
      for(const id of ["sporestorm","thornwall","rootbind"]){
        if(!this.spellReady(state,id))continue;
        const sd=stat(id),groundOnly=id==="thornwall"||id==="rootbind";
        const pt=this.bestEnemyClusterPoint(p,sd?.radius||180,{groundOnly});
        if(pt&&pt.score>=3&&this.spellPointAllowed(p,pt.x,pt.y,SpellDefinition.get(id).castMargin)){
          this.issueCommand({type:"CAST_SPELL",spellId:id,x:Math.round(pt.x),y:Math.round(pt.y)});return;
        }
      }
    }

    // 회수 포자: 병력이 적 거점 깊숙이 있고 체력이 많이 빠졌을 때 현재 깃발로 회수.
    if(center&&p.ownArmy.length>=5&&this.spellReady(state,"recall")){
      const hurt=p.ownArmy.filter(u=>u.hp<u.maxHp*.45).length;
      if(hurt>=3&&this.spellPointAllowed(p,center.x,center.y,SpellDefinition.all.recall.castMargin)){
        this.issueCommand({type:"CAST_SPELL",spellId:"recall",x:Math.round(center.x),y:Math.round(center.y)});return;
      }
    }

    // 땅굴: 현재 군대에서 목표 방향으로 가능한 최대 전진 지점을 만든다.
    if(
      center&&target&&p.ownArmy.length>=7&&
      this.spellReady(state,"tunnel")&&
      this.pointVisible(center.x,center.y,p.sources)
    ){
      const dx=target.x-center.x,dy=target.y-center.y;
      const dist=Math.hypot(dx,dy);

      if(dist>600){
        const jump=Math.min(520,dist-120);
        const exitX=center.x+dx/dist*jump;
        const exitY=center.y+dy/dist*jump;

        if(
          Math.hypot(exitX-center.x,exitY-center.y)>=220&&
          this.spellPointAllowed(
            p,exitX,exitY,
            SpellDefinition.all.tunnel.castMargin
          )
        ){
          this.issueCommand({
            type:"CAST_SPELL",spellId:"tunnel",
            entryX:Math.round(center.x),
            entryY:Math.round(center.y),
            exitX:Math.round(exitX),
            exitY:Math.round(exitY)
          });
        }
      }
    }
  }
}

export { BotController };
