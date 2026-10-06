const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium: nativeChromium } = require('playwright');
const chromium = require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);

const mode=process.env.QA_NETCODE_MODE||'lockstep';
assert(['lockstep','rollback'].includes(mode));
const htmlPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const output = path.resolve(__dirname, '..', '.qa', 'netcode-integration-'+mode);
const source = fs.readFileSync(htmlPath, 'utf8').replace('economy:{startingResources:{minerals:0,gas:0}}','economy:{startingResources:{minerals:10000,gas:10000}}'); // Equal pre-game resource fixture on both peers.
const consumer = source;
assert.ok(!/\b(?:netcodeSession|netcode|core|sdk|RallyNetcode)\s*(?:\.|\?\.)\s*_[A-Za-z]/.test(consumer),
  'Game consumer never accesses private SDK members');
assert.ok(!/\b(?:netcodeSession|netcode|core|sdk|RallyNetcode)\s*\[\s*["']_/.test(consumer),
  'Game consumer never indexes private SDK members');
for (const [i, script] of [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
  if (script[2].trim() && !/type\s*=\s*["']application\/json/i.test(script[1]))
    new vm.Script(script[2], { filename: `inline-script-${i}.js` });
}
const end = source.lastIndexOf('})();');
assert.ok(end > 0, 'Production app IIFE exists');
const html = source.slice(0, end) + `
CONFIG.netcode.mode=${JSON.stringify(mode)};
// Preserve the pre-game economy workers in this 120-combat-unit fixture so BUILD is meaningful.
const originalDebug=StrategySim.prototype.applyDebugScenario;
StrategySim.prototype.applyDebugScenario=function(...args){const workers=this.units.filter(u=>UnitDefinition.get(u.type)?.economyWorker);const result=originalDebug.apply(this,args);this.units.push(...workers);this.rebuildRuntimeIndexes();return result;};
window.__netcodeIntegration={GameSession,LoopbackTransport,AppLifecycle,
  CONFIG,RallyStateCodec,RallyCommandCodec,StrategySim,BuildingDefinition,BuildingPresentation,SIM_VERSION,BUILD_ID};
` + source.slice(end);

async function integration() {
  const q=window.__netcodeIntegration,sdk=window.RallyNetcode,mode=q.CONFIG.netcode.mode;
  const check=(yes,message)=>{if(!yes)throw Error(message);};
  const equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
  const sleep=ms=>new Promise(resolve=>setTimeout(resolve,ms));
  const wait=async(test,label,limit=12000)=>{
    const deadline=performance.now()+limit;
    while(!test()){
      if(performance.now()>deadline)throw Error('Timed out: '+label);
      await sleep(10);
    }
  };
  check(sdk?.VERSION==='0.2.0-dev','URL imported SDK is available');
  check(window.RallyNetcodeSource?.pinned===true&&window.RallyNetcodeSource?.repository==='byh-playground/bloom-gamekit',
    'SDK uses the pinned shared gamekit modules');
  const hostTransport=new q.LoopbackTransport('host','NETCODE-INTEGRATION');
  const guestTransport=new q.LoopbackTransport('guest','NETCODE-INTEGRATION');
  hostTransport.pair(guestTransport);guestTransport.pair(hostTransport);
  const host=new q.GameSession('host',hostTransport,'NETCODE-INTEGRATION',{
    selectionMode:'deck',simulationTps:20,
    debugScenario:{kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',
      allyCount:60,enemyCount:60,research:false,humanRole:'host'}});
  const guest=new q.GameSession('guest',guestTransport,'NETCODE-INTEGRATION');
  const sessions=[host,guest],events=[],packets=[],rawSends=new Map(),routingCarriers=[],
    faults={mode:'off',count:0,dropped:0,held:[],reordered:0,corrupted:0};
  for(const s of sessions){
    s.transport.onOpen=()=>s.onTransportOpen();
    s.transport.onClose=()=>s.onTransportClosed();
    s.onSnapshot=()=>{};s.onRenderTargets=()=>{};
    s.onLog=message=>events.push({role:s.role,kind:'log',message:String(message)});
    const send=s.transport.sendNetcode.bind(s.transport);rawSends.set(s.transport,send);
    const channel=carrier=>({label:'qa-'+carrier,readyState:'open',bufferedAmount:0,
      addEventListener(){},removeEventListener(){},close(){},
      send(value){
        check(value instanceof Uint8Array,'SDK-selected carrier receives actual typed frames');
        const bytes=value.slice();packets.push({role:s.role,carrier,bytes:bytes.length});
        if(s.role==='guest'&&carrier==='inputs'&&faults.mode==='inputs'){
          faults.count++;
          if(faults.count<=2){faults.dropped++;return;}
          faults.held.push(bytes);return;
        }
        if(s.role==='host'&&carrier==='control'&&bytes.length>sdk.CHUNK_SIZE/2&&
          faults.mode==='corrupt-chunk'&&!faults.corrupted){
          bytes[bytes.length-1]^=1;faults.corrupted++;
        }
        check(send(bytes)!==false,'Original production Loopback carrier accepts SDK-selected bytes');
      }});
    // Let the public SDK transport select reliability; the fault harness never
    // decodes a packet header or reimplements SDK packet classification.
    const routing=new sdk.WebRTCTransport({inputChannel:channel('inputs'),controlChannel:channel('control')});
    routingCarriers.push(routing);s.transport.sendNetcode=bytes=>routing.send(bytes);
  }
  const core=()=>[host.netcodeSession,guest.netcodeSession];
  let runtimeNow=performance.now();
  let maxGameTickDrift=0;
  const poll=async()=>{
    for(const c of core())c?.poll(runtimeNow);
    await sleep(0);
  };
  const noFatal=()=>check(sessions.every(s=>!s.simulationFatal),
    'No GameSession simulation fatal: '+JSON.stringify(sessions.map(s=>s.simulationFatalInfo)));
  const step=async(n=1)=>{
    for(let i=0;i<n;i++){
      noFatal();
      runtimeNow+=50;
      for(const s of sessions)if(!s.simEnded)s.stepSimulationOnce(runtimeNow);
      await poll();
      maxGameTickDrift=Math.max(maxGameTickDrift,Math.abs(host.sim.tick-guest.sim.tick));
      await sleep(50); // 20 TPS wall time; the actual game and SDK keep fixed dt.
    }
  };
  const confirmedEquality=label=>{
    const a=host.netcodeSession,b=guest.netcodeSession;
    const common=Math.min(a.tick,b.tick,a.confirmedTick+1,b.confirmedTick+1);
    const tick=mode==='lockstep'&&a.tick!==b.tick?Math.floor(common/a.profile.checksumInterval)*a.profile.checksumInterval:common;
    const ah=a.getStateHash(tick),bh=b.getStateHash(tick);
    check(Number.isInteger(ah)&&ah===bh,label+': public confirmed SDK state hashes agree at '+tick+' ('+ah+'/'+bh+')');
    return {tick,hash:ah};
  };
  try{
    hostTransport.open();guestTransport.open();
    await wait(()=>host.sim&&guest.sim&&core().every(c=>c?.ready),'actual HELLO/GAME_START/core handshake');
    runtimeNow=Math.max(...sessions.map(s=>s.netcodeNow));
    for(const s of sessions)q.AppLifecycle.unregisterBackgroundSession(s);
    check(host.sim.tps===20&&guest.sim.tps===20,'Production TPS negotiation is preserved');
    check(core().every(c=>c.profile.mode===mode),'The selected next-session mode reaches both SDK peers');
    check(core().every(c=>c.constructor===sdk.RollbackSession),'GameSession owns actual SDK RollbackSession');
    check(core().every(c=>c.tick===sizedTick(c.adapter.save())),'Fresh SDK tick uses the pre-step game-state boundary');
    for(const s of sessions){
      const event=s.netcodeSession.onEvent;
      s.netcodeSession.onEvent=e=>{events.push({role:s.role,...e,error:e.error?String(e.error.message||e.error):undefined});event(e);};
    }
    function sizedTick(bytes){return q.RallyStateCodec.decode(bytes).state.tick;}
    const startup=confirmedEquality('Startup');
    const adapter=guest.netcodeSession.adapter,saveStarted=performance.now(),saved=adapter.save(),
      saveMs=performance.now()-saveStarted;
    check(sdk.hashBytes(saved)===guest.netcodeSession.getStateHash(guest.netcodeSession.tick),
      'SDK saved state hash is the real complete game memento hash');
    check(adapter.validateSnapshot(saved,{tick:guest.netcodeSession.tick})===true,'Actual full game memento validates');
    check(adapter.validateSnapshot(saved,{tick:guest.netcodeSession.tick+1})===false,'Unexpected frame boundary is rejected');
    const invalid=q.RallyStateCodec.decode(saved);invalid.state.units[0].side=99;
    check(adapter.validateSnapshot(q.RallyStateCodec.encode(invalid),{tick:guest.netcodeSession.tick})===false,'Game-specific impossible side is rejected');
    check(equal(saved,adapter.save()),'Validation does not mutate actual game state');
    const loadStarted=performance.now();adapter.load(saved);const loadMs=performance.now()-loadStarted;
    check(equal(saved,adapter.save()),'Actual game save/load bytes are canonical');
    check(saved.length>sdk.CHUNK_SIZE,'The test uses an actual large game memento requiring multiple binary chunks');
    const profile=guest.netcodeSession.profile;
    check(saved.length*profile.stateHistorySize<=profile.maxHistoryBytes,
      'The actual large match memento fits the configured bounded history budget');
    const stateChecks={bytes:saved.length,units:guest.sim.units.length,saveMs,loadMs,
      estimatedRingBytes:saved.length*profile.stateHistorySize,historyBudgetBytes:profile.maxHistoryBytes,
      pureValidation:true,canonicalRoundtrip:true};
    await step(5);
    for(const s of sessions)s.netcodeSession.setInputDelay(0);
    await step(5); // Drain immutable frames captured before public delay reduction.
    faults.mode='inputs';
    const faultStartTick=host.sim.tick,faultStartStalls=host.netcodeSession.metrics.stalls;
    const guestFlag={type:'SET_FLAG',x:Math.round(guest.sim.world.width*.57),y:Math.round(guest.sim.world.height*.41),forced:false};
    const hostFlag={type:'SET_FLAG',x:Math.round(host.sim.world.width*.43),y:Math.round(host.sim.world.height*.59),forced:false};
    check(host.command(hostFlag)===true&&guest.command(guestFlag)===true,'Both roles register commands through GameSession');
    const hostTicket={...host.lastCommandTicket},guestTicket={...guest.lastCommandTicket};
    check(hostTicket.actor==='host'&&guestTicket.actor==='guest','Ticket identifies the actor');
    check(hostTicket.sequence===guestTicket.sequence,'Equal player-local sequences remain distinct actor identities');
    const guestBase=guest.sim.buildings.find(b=>b.side===1&&q.BuildingDefinition.get(b.type)?.isMainBase);
    let buildAction=null;
    outer:for(let radius=180;radius<=500;radius+=40)for(let i=0;i<24;i++){
      const action={type:'BUILD',building:'barracks',produceType:'swordsman',x:Math.round(guestBase.x+Math.cos(i*Math.PI/12)*radius),y:Math.round(guestBase.y+Math.sin(i*Math.PI/12)*radius)};
      if(!q.BuildingPresentation.buildValidation(guest.sim.snapshot(),1,action)){buildAction=action;break outer;}
    }
    check(buildAction&&guest.command(buildAction)===true,'Delayed guest BUILD enters the production command stream');
    await step(7);
    check(faults.dropped===2&&faults.held.length>0,'Typed frames were genuinely lost and delayed');
    if(mode==='lockstep')check(host.sim.tick<faultStartTick+7&&host.netcodeSession.metrics.stalls>faultStartStalls&&host.netcodeSession.metrics.predictedTicks===0,'Missing remote input stalls without prediction');
    faults.mode='off';
    // Newest retransmission arrives first, then old copies in reverse order.
    for(const bytes of faults.held.reverse()){rawSends.get(guestTransport)(bytes);faults.reordered++;}
    faults.held=[];
    await step(10);
    const rollback=host.netcodeSession.metrics;
    if(mode==='rollback')check(rollback.rollbacks>0&&rollback.maxRollbackDepth>=1&&rollback.resimulatedTicks>=1,
      'Late actual RTS commands cause a real SDK rollback within production pacing limits: '+JSON.stringify(rollback));
    else check(rollback.rollbacks===0&&rollback.resimulatedTicks===0&&rollback.predictedTicks===0,'Lockstep fault recovery never predicts or rolls back gameplay');
    check(rollback.maxRollbackDepth<=host.netcodeSession.profile.rollbackWindowTicks,
      'The actual game rollback respects the SDK prediction/history limit');
    check(rollback.holds+rollback.stalls>0,'Faults exercised real SDK hold/stall pacing');
    check(maxGameTickDrift<=host.netcodeSession.profile.rollbackWindowTicks+
      host.netcodeSession.profile.tickDriftThreshold+1,'Actual game peer drift stays within SDK pacing and rollback bounds');
    const afterFaults=confirmedEquality('After packet loss/delay/reordering');
    const hostSide=host.sim.flags[0],guestSide=host.sim.flags[1];
    check(hostSide.x===hostFlag.x&&hostSide.y===hostFlag.y&&guestSide.x===guestFlag.x&&guestSide.y===guestFlag.y,
      'Both actor-local commands execute on the correct faction after rollback');
    const commands=host.replayRecorder.commands.filter(c=>c.action?.type==='SET_FLAG');
    check(commands.length===2,'Confirmed command recorder emits each actor command once after rollback');
    check(new Set(commands.map(c=>c.seq)).size===2,'Canonical game sequence remains globally unique');
    const canonical=commands.every(c=>c.seq>=Math.floor((c.tick-1)*4096)+1&&c.seq<=Math.floor((c.tick-1)*4096)+4096);
    check(canonical,'Game command sequence follows SDK frame and stable ordinal');
    check(host.replayRecorder.commands.filter(c=>c.action?.type==='BUILD').length===1,'Rollback records the construction command exactly once');
    check(sessions.every(s=>[...s.sim.buildings,...s.sim.constructionOrders].filter(b=>b.side===1&&b.produceType==='swordsman'&&Math.hypot(b.x-buildAction.x,b.y-buildAction.y)<1).length===1),'Delayed construction produces exactly one order or real building on each peer: '+JSON.stringify(sessions.map(s=>({role:s.role,receipts:s.sim.commandReceipts,workers:s.sim.units.filter(u=>u.type==='worker').length,wallet:s.sim.wallet,orders:s.sim.constructionOrders,buildings:s.sim.buildings.map(b=>({id:b.id,type:b.type,side:b.side,produceType:b.produceType,x:b.x,y:b.y}))}))));
    const firstRing=host.netcodeSession.profile.stateHistorySize;
    await step(firstRing*3);
    const wrapped=confirmedEquality('After three state-ring wraps');
    check(Math.min(...core().map(c=>c.tick))>firstRing*3,'Actual game exceeds three bounded state-ring lengths');
    check(core().every(c=>c.getStateHash(0)===undefined),'Public state history confirms the old ring slot was evicted');
    // Freeze stepping and pump only the public SDK poll path. Snapshot transactions
    // must preserve current game bytes until the whole candidate is accepted.
    const beforeReject=adapter.save(),rejectedBefore=guest.netcodeSession.metrics.rejectedSnapshots;
    faults.mode='corrupt-chunk';
    const recoveryTick=Math.min(...core().map(c=>Math.min(c.tick,c.confirmedTick+1)))-2;
    check(guest.netcodeSession.requestResync(recoveryTick)===true,'Public SDK accepts retained snapshot recovery request');
    async function pumpUntil(test,label,onPending=null){
      const deadline=performance.now()+12000;
      while(!test()){
        if(performance.now()>deadline)throw Error('Timed out: '+label);
        await poll();if(!test())onPending?.();await sleep(10);
      }
    }
    await pumpUntil(()=>guest.netcodeSession.metrics.rejectedSnapshots>rejectedBefore,'corrupt binary candidate rejection');
    check(faults.corrupted===1,'An actual SDK binary snapshot chunk was corrupted');
    check(equal(beforeReject,adapter.save()),'Rejected partial/corrupt transaction preserves current game bytes');
    faults.mode='off';
    const corrupt=guest.sim.wallet[1];guest.sim.wallet[1]=corrupt+37;
    const corruptedState=adapter.save();
    check(!equal(corruptedState,beforeReject),'Authoritative game corruption was actually introduced');
    const recoveredBefore=guest.netcodeSession.metrics.recoveries;
    let pendingRecoveryChecks=0;
    check(guest.netcodeSession.requestResync(recoveryTick)===true,'SDK permits a clean retry of the retained candidate');
    await pumpUntil(()=>guest.netcodeSession.metrics.recoveries>recoveredBefore,'validated binary snapshot recovery',()=>{
      if(!guest.netcodeSession.resimulating)return;
      check(equal(corruptedState,adapter.save()),'Incomplete staged candidate never exposes partial replay state');
      pendingRecoveryChecks++;
    });
    check(equal(beforeReject,adapter.save()),'Valid recovery atomically replaces corruption with identical whole game state');
    const recovered=confirmedEquality('After actual game snapshot resync');
    const chunks=packets.filter(p=>p.carrier==='control'&&p.bytes>sdk.CHUNK_SIZE/2);
    check(chunks.length>2&&chunks.every(p=>p.bytes<=sdk.CHUNK_SIZE),'Actual game snapshot travels in bounded SDK binary chunks');
    noFatal();
    const metrics=Object.fromEntries(sessions.map(s=>[s.role,s.netcodeSession.metrics]));
    const replay=host.netcodeSession.exportReplay();
    check(replay.frames.length>firstRing*3&&!replay.truncated,'Actual SDK confirmed input replay remains available past ring wraps');
    check(replay.frames.flatMap(f=>f.inputs.flatMap(i=>i.commands.map(c=>({actor:i.playerId,sequence:c.sequence}))))
      .filter(c=>c.sequence===hostTicket.sequence).length===2,'SDK replay retains both distinct actor-local command identities');
    if(mode==='lockstep'){
      for(const c of core())check(c.metrics.snapshotSaves<c.tick/3,'Sparse lockstep checkpoints do not serialize every tick: '+JSON.stringify(c.metrics));
      const c=host.netcodeSession,before=c.metrics.snapshotSaves;
      check(c.getStateHash()===sdk.hashBytes(host.simulationAdapter.save()),'On-demand hash uses current canonical game bytes');
      c.getStateHash();check(c.metrics.snapshotSaves<=before+1,'Repeated same-boundary hash does not serialize again');
    }
    return {mode,build:q.BUILD_ID,sdkVersion:sdk.VERSION,startup,stateChecks,hostTicket,guestTicket,
      faults:{lost:faults.dropped,reordered:faults.reordered,corruptedChunks:faults.corrupted},
      afterFaults,wrapped,recovered,ringSize:firstRing,metrics,maxGameTickDrift,pendingRecoveryChecks,
      binaryChunks:{count:chunks.length,maxBytes:Math.max(...chunks.map(p=>p.bytes))},
      replay:{tick:replay.tick,hash:replay.hash,frames:replay.frames.length},events};
  }finally{for(const s of sessions)s.dispose('netcode-integration-complete');for(const c of routingCarriers)c.close();}
}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true,
    args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try{
    const page=await browser.newPage(),errors=[];
    page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://netcode-integration.local/**',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://netcode-integration.local/',{waitUntil:'domcontentloaded'});
    await page.waitForFunction(()=>window.__netcodeIntegration);
    const result=await page.evaluate(integration);
    assert.deepEqual(errors,[],'No uncaught application errors');
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({htmlPath,result,pageErrors:errors},null,2));
    console.log(JSON.stringify({htmlPath,result:{...result,events:result.events.filter(e=>e.kind!=='log')},pageErrors:errors},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
