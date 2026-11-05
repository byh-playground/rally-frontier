// Simulation performance sampling.
import { ActiveViewState } from '../session/runtime-state.js';
import { CloneUtil } from '../sim/map-generation.js';
import { PRODUCT_VERSION } from '../core/product-version.js';
import { BUILD_META } from '../core/build-info.js';
import { LogUtil, MatchLifecycle, SinglePlayerModeUtil } from '../main.js';

class PerformanceTelemetry{
  static runtimeMonitor=null;
  static recordTiming(stats,key,ms){
    const row=stats[key]||(stats[key]={samples:0,currentMs:0,cumulativeMs:0,ewmaMs:0,maxMs:0});
    row.currentMs=Math.max(0,ms);row.cumulativeMs=(row.cumulativeMs||0)+row.currentMs;row.ewmaMs=row.samples?row.ewmaMs*.85+row.currentMs*.15:row.currentMs;
    row.maxMs=Math.max(row.maxMs,row.currentMs);row.samples++;
  }
  static measureSessionPulse(session,now){
    const stats=session.performanceStats;
    if(!stats||!session.sim||session.simEnded||session.simulationFatal)return session.advanceSimulation(now);
    const started=performance.now();
    if(stats.lastPulseAt!==null)this.recordTiming(stats.timings,'pulseGap',started-stats.lastPulseAt);
    stats.lastPulseAt=started;
    try{return session.advanceSimulation(now)}finally{this.recordTiming(stats.timings,'pulse',performance.now()-started)}
  }
  static startRuntimeMonitor(){
    if(this.runtimeMonitor)return;
    const m=this.runtimeMonitor={timings:{},longTasks:0,longTaskMs:0,maxLongTaskMs:0,lastLongTaskAt:null,observer:null,timer:0};
    let expectedAt=performance.now()+250;
    m.timer=setInterval(()=>{const now=performance.now();this.recordTiming(m.timings,'eventLoop',now-expectedAt);expectedAt=now+250},250);
    if(globalThis.PerformanceObserver?.supportedEntryTypes?.includes('longtask')){
      m.observer=new PerformanceObserver(list=>{for(const e of list.getEntries()){m.longTasks++;m.longTaskMs=e.duration;m.maxLongTaskMs=Math.max(m.maxLongTaskMs,e.duration);m.lastLongTaskAt=e.startTime+e.duration}});
      m.observer.observe({type:'longtask',buffered:false});
    }
  }
  static stopRuntimeMonitor(){
    const m=this.runtimeMonitor;if(!m)return;
    clearInterval(m.timer);m.observer?.disconnect();this.runtimeMonitor=null;
  }
  static async sampleConnection(session){
    const stats=session.performanceStats,pc=session.transport?.pc,now=performance.now();
    if(session.performanceIceConnection!==pc){session.performanceIceConnection=pc;stats.iceRttMs=null;stats.iceFetchedAt=null;stats.iceError=null;stats.iceRequestedAt=-1000}
    if(!pc?.getStats||stats.icePending||now-stats.iceRequestedAt<1000||session.disposed)return;
    stats.iceRequestedAt=now;stats.icePending=true;
    try{
      const report=await pc.getStats();
      if(session.disposed||session.transport?.pc!==pc)return;
      let pair=null;
      for(const row of report.values())if(row.type==='transport'&&row.selectedCandidatePairId)pair=report.get(row.selectedCandidatePairId)||pair;
      if(!pair)for(const row of report.values())if(row.type==='candidate-pair'&&row.state==='succeeded'&&row.nominated){pair=row;break}
      stats.iceRttMs=Number.isFinite(pair?.currentRoundTripTime)?pair.currentRoundTripTime*1000:null;
      stats.iceFetchedAt=performance.now();stats.iceError=null;
    }catch(error){if(!session.disposed&&session.transport?.pc===pc){stats.iceRttMs=null;stats.iceFetchedAt=performance.now();stats.iceError=String(error.message||error)}}
    finally{stats.icePending=false}
  }
  static exportTimingTelemetry(){
    const active=MatchLifecycle.activeSession?.();if(!active?.sim)return;
    const sessions=SinglePlayerModeUtil.isSinglePlayer()?MatchLifecycle.singleMatch.sessions:{[active.role]:active};
    const m=this.runtimeMonitor;
    const payload={exportedAt:new Date().toISOString(),build:BUILD_META.id,buildMetadata:BUILD_META.snapshot(),gameVersion:PRODUCT_VERSION,visibility:document.visibilityState,
      note:'Local timings only. Nested timings overlap. App RTT includes browser message handling; ICE RTT is a separate sample. GPU begin time is CPU API cost. Collision details are sampled once per second; allied soft-contact counters describe that sampled tick.',
      mainThread:m?{timings:m.timings,longTasks:m.longTasks,lastLongTaskMs:m.longTaskMs,maxLongTaskMs:m.maxLongTaskMs}:null,
      renderer:ActiveViewState.renderer?.perfStats||null,
      sessions:Object.fromEntries(Object.entries(sessions).map(([role,s])=>[role,{tick:s.sim?.tick,mode:s.netcodeMode,status:s.netcodeSession?.status,
        timings:s.performanceStats,simulation:s.sim?.perfStats,core:s.netcodeSession?.metrics,bufferedBytes:s.transport?.netcodeBufferedAmount||0}]))};
    const url=URL.createObjectURL(new Blob([JSON.stringify(payload,null,2)],{type:'application/json'}));
    const a=document.createElement('a');a.href=url;a.download=`rally-frontier-performance-${Date.now()}.json`;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);
  }
  static async exportBalanceTelemetry(){
  const active=MatchLifecycle.activeSession?.();
  if(!active?.sim)return;
  const sessions={};
  if(SinglePlayerModeUtil.isSinglePlayer()&&MatchLifecycle.singleMatch?.sessions){
    // A Worker-hosted AI session answers asynchronously.
    for(const r of ["host","guest"]){
      const sess=MatchLifecycle.singleMatch.sessions[r];
      if(sess?.sim)sessions[r]=await sess.balanceTelemetry();
    }
  }else{
    sessions[active.role||ActiveViewState.role||"local"]=active.balanceTelemetry();
  }
  const payload={
    exportedAt:new Date().toISOString(),build:BUILD_META.id,buildMetadata:BUILD_META.snapshot(),gameVersion:PRODUCT_VERSION,roomCode:active.roomCode||null,
    localOnly:true,note:"Balance telemetry is diagnostics-only and excluded from checksum/exportState/recovery authority.",
    sessions
  };
  const blob=new Blob([JSON.stringify(payload,null,2)],{type:"application/json"});
  const url=URL.createObjectURL(blob);
  const a=document.createElement("a");
  a.href=url;a.download=`rally-frontier-balance-${Date.now()}.json`;
  document.body.appendChild(a);a.click();a.remove();
  setTimeout(()=>URL.revokeObjectURL(url),1000);
  LogUtil.log("밸런스 계측 JSON 저장 · authoritative state에는 포함되지 않음");
}

  static balanceTelemetrySnapshot(sim){
  if(!sim)return null;
  const b=CloneUtil.clone(sim.balanceStats||PerformanceTelemetry.createLocalBalanceStats());
  b.tick=sim.tick;
  b.seconds=sim.tick/sim.tps;
  b.averageArmy=[0,1].map(side=>b.samples?b.armyTotal[side]/b.samples:0);
  b.currentWallet=sim.wallet.slice();
  b.checksum=sim.checksum();
  return b;
}

  static createLocalPerfStats(){
    return{
      sampleTick:0,totalMs:0,indexMs:0,worldMs:0,visionMs:0,combatMs:0,
      projectileMs:0,collisionMs:0,collisionPrepMs:0,collisionGridBuildMs:0,collisionPairScanMs:0,collisionSoftApplyMs:0,collisionSweptMotionMs:0,collisionTerrainMs:0,collisionHardFixMs:0,collisionOtherMs:0,
      collisionSoftPasses:0,collisionSoftContacts:0,collisionSoftMovedUnits:0,collisionSoftCappedUnits:0,collisionSoftDetailedSamples:0,
      collisionSweptCalls:0,collisionSweptActivePasses:0,collisionSweptZeroMotionCalls:0,collisionSweptEmptyPasses:0,collisionSweptPairTests:0,collisionSweptHits:0,collisionSweptCorrectionUnits:0,collisionSweptNoCorrectionPasses:0,
      collisionHardFixCalls:0,collisionHardFixPasses:0,collisionHardFixActivePairTests:0,collisionHardFixCandidates:0,collisionHardFixCorrections:0,collisionHardFixNoOpCalls:0,
      combatTargetPickMs:0,combatTargetPickCalls:0,combatOtherMs:0,
      postMs:0,snapshotMs:0,snapshotCumulativeMs:0,maxSnapshotMs:0,snapshotSamples:0,lastStepMs:0,stepSamples:0,stepCumulativeMs:0,maxStepMs:0,ewmaStepMs:0,
      aliveUnits:0,combatUnits:0,projectiles:0,
      peakAliveUnits:0,peakBuildings:0,peakProjectiles:0,
      spatialQueries:0,spatialCandidates:0,
      targetQueries:0,targetVisibilityRejects:0,sideSpatialQueries:0,visibilityChecks:0,collisionPairs:0,collisionOverlaps:0,buildingCollisionCandidates:0
    };
  }
  static createLocalBalanceStats(){
    return{
      startedTick:0,lastSampleTick:0,
      firstCombatTick:null,firstCaptureTick:[null,null],captures:[0,0],
      buildingLosses:[0,0],outpostLosses:[0,0],
      samples:0,armyTotal:[0,0],armyPeak:[0,0],currentArmy:[0,0],
      gameEndTick:null,winner:null,history:[]
    };
  }
}

export { PerformanceTelemetry };
