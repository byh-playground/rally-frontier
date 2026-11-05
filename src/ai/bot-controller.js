// Single-player launch bot. It plays through the same GameSession command interface as a human,
// whether it runs in the page or in src/sim-worker.js. The old RTS bot lives in legacy/rts-sim/ai/.
import { RangeUtil, SIM_TPS } from '../core/game-rules.js';
import { StateValue } from '../sim/components.js';
import { LaunchRules } from '../sim/launch-rules.js';
import { ConnectionSideUtil, StableSerializationUtil } from '../net/lobby-codec.js';
import { HashUtil } from '../sim/map-generation.js';
import { BuildingDefinition } from '../definitions/buildings.js';
import { SimulationTiming } from '../main.js';

// Tracks the bot's commands from offer to the sim's receipt, so a shot already paid for
// is not paid again from a snapshot that predates it.
class AiCommandExecutor{
  constructor(bot){this.bot=bot;this.pending=[];this.queue=[];this.state=null;this.epoch=-1}
  static key(action){return StableSerializationUtil.stableStringify(action)}
  reservations(state=this.state){
    const receipts=this.bot.session.sim?.commandReceipts||[];
    return this.pending.filter(entry=>!receipts.some(r=>r.netcodeSequence===entry.netcodeSequence&&r.actor===entry.actor&&r.tick<=(state?.tick??-1))).concat(this.queue);
  }
  reconcile(state){
    const session=this.bot.session,sim=session.sim,receipts=sim?.commandReceipts||[],epochChanged=this.epoch!==sim?.runtimeEpoch,confirmedTick=Math.min(state.tick,session.confirmedGameTick??state.tick);
    const matches=(entry,sequence,actor)=>entry.netcodeSequence===sequence&&entry.actor===actor;
    const tickets=session.getPendingCommandTickets();
    this.pending=this.pending.filter(entry=>{
      const receipt=receipts.find(r=>matches(entry,r.netcodeSequence,r.actor));
      if(receipt&&receipt.tick<=confirmedTick)return false;
      if(!epochChanged||receipt||tickets.some(ticket=>matches(entry,ticket.sequence,ticket.actor)))return true;
      for(const list of sim?.scheduled?.values?.()||[])if(list.some(c=>matches(entry,c.netcodeSequence,c.actor)))return true;
      return false;
    });
    this.epoch=sim?.runtimeEpoch;
  }
  begin(snapshot){
    this.reconcile(snapshot);this.queue=[];
    // An isolated decision view, never a mutation of a published snapshot.
    const view={...snapshot,wallet:snapshot.wallet.slice(),launchRangeLevel:snapshot.launchRangeLevel.slice()};
    for(const p of this.reservations(snapshot)){
      view.wallet[this.bot.side]-=p.cost;
      if(p.action.type==="UPGRADE_LAUNCH_RANGE")view.launchRangeLevel[this.bot.side]++;
    }
    this.state=view;return view;
  }
  offer(action){
    if(!this.state)return false;
    const session=this.bot.session;if(session.disposed||session.simEnded||session.netcodeSession?.resimulating||typeof session.inputAvailable==="function"&&!session.inputAvailable())return false;
    const key=AiCommandExecutor.key(action),side=this.bot.side,cost=action.type==="UPGRADE_LAUNCH_RANGE"?LaunchRules.upgradeCost(this.state.launchRangeLevel[side]):LaunchRules.payload(action.unitType)?.cost;
    if(cost==null||this.reservations().some(p=>p.key===key)||this.state.wallet[side]<cost)return false;
    this.queue.push({key,action:StateValue.copy(action),cost});this.state.wallet[side]-=cost;
    if(action.type==="UPGRADE_LAUNCH_RANGE")this.state.launchRangeLevel[side]++;
    return true;
  }
  dispose(){
    const sim=this.bot.session.sim;if(sim)this.reconcile({tick:sim.tick});
    this.pending=[];this.queue=[];this.state=null;
  }
  flush(){
    const session=this.bot.session;
    for(const entry of this.queue){
      if(session.command(entry.action)!==true)continue;
      const ticket=session.lastCommandTicket;
      if(!ticket||ticket.actor!==this.bot.role||ticket.key!==entry.key||!Number.isSafeInteger(ticket.sequence))throw new Error("AI 명령의 Netcode 제출 영수증이 없습니다.");
      Object.assign(entry,{actor:ticket.actor,netcodeSequence:ticket.sequence});this.pending.push(entry);
    }
    this.queue=[];this.state=null;
  }
}

class BotController{
  static attach(session,role){
    const bot=new BotController(session,{role});
    session.publishConfirmedSnapshots=true;
    session.onSnapshot=state=>bot.handleSnapshot(state);
    session.onLog=()=>{};session.onResult=()=>bot.stop();session.onNetworkHealth=()=>{};
    return bot;
  }
  constructor(session,options={}){
    this.session=session;this.commandExecutor=new AiCommandExecutor(this);
    this.role=options.role||session.role||"guest";
    this.side=ConnectionSideUtil.roleSide(this.role);
    this.enabled=true;
    this.lastLaunchTick=-99999;
  }

  stop(){this.enabled=false;this.commandExecutor.dispose()}

  handleSnapshot(snapshot){
    if(!this.enabled||!snapshot||this.session.netcodeSession?.resimulating)return;
    if(snapshot.tick>(this.session.confirmedGameTick??snapshot.tick)){this.commandExecutor.reconcile(snapshot);return}
    const state=this.commandExecutor.begin(snapshot);
    try{
      if(state.tick-this.lastLaunchTick>=SimulationTiming.msToTicks(1200,state.tps||SIM_TPS)){this.lastLaunchTick=state.tick;this.runLaunch(state)}
    }finally{this.commandExecutor.flush()}
  }
  // Defend the base first, then empty capture points, then enemy groups.
  launchTarget(state,cannon){
    const side=this.side,mine=state.buildings.find(b=>b.id==="base"+side),enemyBase=state.buildings.find(b=>b.id==="base"+(1-side));
    const enemies=state.units.filter(u=>u.alive&&u.side===1-side);
    const centroid=list=>({x:list.reduce((a,u)=>a+u.x,0)/list.length,y:list.reduce((a,u)=>a+u.y,0)/list.length});
    const threat=mine?enemies.filter(u=>Math.hypot(u.x-mine.x,u.y-mine.y)<900):[];
    if(threat.length)return centroid(threat);
    const open=(state.capturePoints||[]).filter(cp=>cp.owner==null&&cp.enabled!==false).sort((a,b)=>Math.hypot(a.x-cannon.x,a.y-cannon.y)-Math.hypot(b.x-cannon.x,b.y-cannon.y));
    if(open.length&&Math.hypot(open[0].x-cannon.x,open[0].y-cannon.y)<=LaunchRules.maxReachOf("rice",state.launchRangeLevel[side]))return open[0];
    if(enemies.length){
      const near=enemies.slice().sort((a,b)=>Math.hypot(a.x-cannon.x,a.y-cannon.y)-Math.hypot(b.x-cannon.x,b.y-cannon.y)).slice(0,12);
      return centroid(near);
    }
    return enemyBase||null;
  }
  // Hold time carries a deterministic +-12% error and never overheats.
  runLaunch(state){
    const side=this.side,main=BuildingDefinition.forRole("mainBase"),outpost=BuildingDefinition.forRole("outpost");
    const level=state.launchRangeLevel[side],upgradeCost=LaunchRules.upgradeCost(level);
    const base=state.buildings.find(b=>b.id==="base"+side);
    const defending=base&&state.units.some(u=>u.alive&&u.side===1-side&&Math.hypot(u.x-base.x,u.y-base.y)<=LaunchRules.maxReachOf("rice",level));
    // Every thirty seconds, reserve income for the next range level unless the base is under attack.
    if(upgradeCost!=null&&!defending&&state.tick>=SimulationTiming.msToTicks(30000*(level+1),state.tps||SIM_TPS)){
      this.commandExecutor.offer({type:"UPGRADE_LAUNCH_RANGE"});
      return;
    }
    const busy=new Set(this.commandExecutor.reservations().map(p=>p.action.cannonId));
    const cannons=state.buildings.filter(b=>b.side===side&&b.alive!==false&&!b.construction&&(b.type===main||b.type===outpost)&&state.tick>=(Number(b.launchReadyTick)||0)&&!busy.has(b.id));
    for(const cannon of cannons){
      const affordable=LaunchRules.deck.filter(t=>LaunchRules.grain(t).cost<=state.wallet[side]);if(!affordable.length)return;
      const target=this.launchTarget(state,cannon);if(!target)return;
      const distance=Math.hypot(target.x-cannon.x,target.y-cannon.y);
      const reaching=affordable.filter(t=>LaunchRules.maxReachOf(t,level)>=distance),pool=reaching.length?reaching:affordable;
      const unitType=pool[HashUtil.hash(`${state.tick}|${cannon.id}`)%pool.length];
      const error=1+((HashUtil.hash(`${state.tick}|${cannon.id}|err`)%241)-120)/1000;
      const holdMs=Math.round(RangeUtil.clamp(LaunchRules.holdFor(distance,unitType,level)*error,0,LaunchRules.chargeMs));
      this.commandExecutor.offer({type:"LAUNCH",cannonId:cannon.id,x:Math.round(target.x),y:Math.round(target.y),holdMs,unitType});
    }
  }
}

export { BotController };
