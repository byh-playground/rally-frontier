const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {chromium: nativeChromium}=require('playwright');
const chromium=require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);
const htmlPath=process.env.QA_HTML_PATH||path.resolve(__dirname,'..','index.html');
let html=fs.readFileSync(htmlPath,'utf8');
for(const [,attrs,source] of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)){
  if(!/\btype=["'](?:module|application\/json)["']/i.test(attrs))new vm.Script(source);
}
const end=html.lastIndexOf('})();');assert.ok(end>=0);
html=html.slice(0,end)+'window.__lifecycleQA={GameSession,NostrRtcTransport,AppLifecycle,DebugScenarioHarness,ReplayPlayer,ReplayPolicy};'+html.slice(end);
const debugConfig={selectionMode:'deck',debugScenario:{allyType:'swordsman',enemyType:'swordsman',allyCount:1,enemyCount:1,research:false,humanRole:'host'}};

async function runLifecycle(config){
  const {GameSession,NostrRtcTransport,AppLifecycle,ReplayPlayer,ReplayPolicy}=window.__lifecycleQA;
  const check=(v,m)=>{if(!v)throw Error(m);};
  const pause=ms=>new Promise(r=>setTimeout(r,ms));
  const wait=async(fn,label)=>{const end=Date.now()+16000;while(!fn()){if(Date.now()>end)throw Error('Timed out: '+label);await pause(5);}};
  const results=[];
  function verifyReplay(session){
    const payload=session.replayRecorder.payload(),endTick=session.matchResult.tick;
    check(payload.result.endTick===endTick&&payload.result.checksum===session.sim.checksum(),'Replay result records the exact completed simulation');
    check(payload.commands.filter(c=>c.action.type==='MATCH_SURRENDER').length===1,'Winning surrender command appears exactly once in the replay');
    check(payload.commands.every(c=>c.tick<=endTick)&&payload.checkpoints.every(c=>c.tick<=endTick),'Replay records no command or checkpoint beyond its outcome');
    check(payload.checkpoints.at(-1).tick===endTick,'Last replay checkpoint is the winning tick');
    const player=new ReplayPlayer({...payload,checkpoints:payload.checkpoints.filter(c=>c.tick===0)});
    try{
      player.seek(endTick,{render:false});
      const expected=ReplayPolicy.replayChecksumForState(session.sim.exportState()),actual=ReplayPolicy.replayChecksumForState(player.sim.exportState());
      check(player.sim.tick===endTick&&actual===expected,'Replay from tick zero reconstructs the authoritative terminal canonical hash');
      return {commands:payload.commands.length,endTick,fromTickZero:true,canonicalHash:actual};
    }finally{player.stop();}
  }
  let serial=0;
  async function pair({late=false,mismatch=false}={}){
    const room='lifecycle-'+(++serial);
    const ht=new NostrRtcTransport('host',room,{signalMode:'local'}),gt=new NostrRtcTransport('guest',room,{signalMode:'local'});
    const h=new GameSession('host',ht,room,config),g=new GameSession('guest',gt,room);
    const faults=[],lobby=[];let delayedStart;
    for(const [s,t]of[[h,ht],[g,gt]]){
      const start=s.startSim.bind(s);
      s.startSim=seed=>{const out=start(seed);AppLifecycle.unregisterBackgroundSession(s);return out;};
      t.onOpen=()=>{s.onTransportOpen();s.stopHeartbeat(false);};
      t.onClose=()=>s.onTransportClosed();t.onError=e=>faults.push(String(e?.message||e));
      t.onMessage=m=>{lobby.push({role:s.role,type:m.type});if(s===g&&m.type==='GAME_START'){
        if(mismatch)m={...m,seed:(m.seed+1)>>>0};
        if(late){delayedStart=m;return;}
      }s.handle(m);};
    }
    ht.open();gt.open();
    await wait(()=>h.sim&&(late?delayedStart:g.sim)&&(mismatch||ht.isNetcodeOpen()&&gt.isNetcodeOpen()),'RTC channels and production HELLO/GAME_START');
    let now=Math.max(h.netcodeNow,g.netcodeNow,performance.now());
    const pulse=async(target=Infinity)=>{
      now+=100;
      for(const s of[h,g]){
        if(!s.sim||s.simEnded||s.simulationFatal)continue;
        if(s.sim.tick<target||s.netcodeSession.resimulating||s.pendingTerminalFrame)s.stepSimulationOnce(now);
        else{s.netcodeNow=Math.max(s.netcodeNow,now);s.netcodeSession.poll(s.netcodeNow);s.publishConfirmedFrames();}
      }
      await pause(5);
    };
    const pump=async(test,label,target=Infinity,max=300)=>{for(let i=0;i<max&&!test();i++)await pulse(target);check(test(),label);};
    const cleanup=async()=>{
      const all=[ht,gt].map(t=>[t.pc,t.dc,t.netcodeInputChannel,t.netcodeControlChannel]);
      check(h.dispose('lifecycle-regression')&&g.dispose('lifecycle-regression'),'First disposal completes');
      check(!h.dispose('lifecycle-regression')&&!g.dispose('lifecycle-regression'),'Disposal is idempotent');
      await wait(()=>all.every(([pc,...channels])=>(!pc||pc.connectionState==='closed')&&channels.every(c=>!c||c.readyState==='closed')),'all RTC resources closed');
      check(ht.netcodeListeners.size===0&&gt.netcodeListeners.size===0,'Raw core subscribers detach on final transport close');
      for(const s of[h,g])check(s.netcodeSession.closed&&!s.heartbeatTimer&&!s.disconnectGraceTimer&&!s.draftPickTimer&&!s.deckSelectTimer,'Core and coordinator timers close');
      return {channelsClosed:true,subscribersDetached:true,timersCleared:true,idempotent:true};
    };
    return {h,g,ht,gt,lobby,faults,pulse,pump,cleanup,releaseStart:()=>g.handle(delayedStart)};
  }
  for(const mode of['delay','drop']){
    const p=await pair();
    try{
      await p.pump(()=>p.h.netcodeSession.ready&&p.g.netcodeSession.ready,'Public SDK peers become ready',0);
      check(p.h.netcodeSession.profile.resimulationBudget===2,'Candidate uses a bounded two-frame resimulation budget');
      await p.pump(()=>p.h.sim.tick===7&&p.g.sim.tick===7,'Both peers reach fixture tick 7',7);
      const held=[];let faultCount=0;
      const channel=p.ht.netcodeInputChannel,send=channel.send.bind(channel);
      // Opaque packet-size fault on the SDK-selected input channel. No protocol bytes are read.
      channel.send=data=>{const packet=new Uint8Array(data.buffer||data,data.byteOffset||0,data.byteLength);if(packet.byteLength>64){faultCount++;if(mode==='delay')held.push(packet.slice());return;}send(data);};
      check(p.h.surrender(),'Surrender enters the public SDK command queue');
      await p.pump(()=>p.h.pendingTerminalFrame&&p.g.sim.tick>p.h.pendingTerminalFrame.gameTick,'Terminal peer waits while remote predicts beyond terminal',Infinity,150);
      await p.pump(()=>p.g.sim.tick>=p.h.pendingTerminalFrame.gameTick+3,'Prediction extends beyond the two-frame resimulation budget',Infinity,120);
      const before={hostTick:p.h.sim.tick,guestTick:p.g.sim.tick,terminalTick:p.h.pendingTerminalFrame.gameTick,hostCoreOpen:!p.h.netcodeSession.closed};
      check(!p.h.simEnded&&!p.g.simEnded&&before.hostCoreOpen,'Local confirmation retains Core until mutual completion');
      channel.send=send;
      if(mode==='delay')for(const packet of held)send(packet);
      await p.pump(()=>p.h.simEnded&&p.g.simEnded,'Both peers complete after '+mode+' fault clears');
      check(p.h.matchResult.tick===p.g.matchResult.tick&&p.h.sim.tick===p.h.matchResult.tick&&p.g.sim.tick===p.g.matchResult.tick,'Result and simulation share the exact winning tick');
      check(p.h.matchResult.winner==='guest'&&p.g.matchResult.winner==='guest'&&p.h.matchResult.reason==='surrender'&&p.g.matchResult.reason==='surrender','Resolved outcome agrees');
      const stateHash=s=>RallyNetcode.hashBytes(s.simulationAdapter.save());
      check(stateHash(p.h)===stateHash(p.g)&&p.h.sim.checksum()===p.g.sim.checksum(),'Completed authoritative state agrees byte-for-byte by full state hash');
      check(p.g.netcodeSession.metrics.rollbacks>0&&p.g.netcodeSession.metrics.maxRollbackDepth>=3,'Late terminal command uses multiple bounded SDK rollback pulses');
      check(p.ht.isOpen()&&p.gt.isOpen()&&p.ht.isNetcodeOpen()&&p.gt.isNetcodeOpen(),'Core completion leaves the game carrier open until disposal');
      check(p.lobby.some(m=>m.type==='MATCH_TERMINAL_ACK'),'Reliable game completion receipt was exchanged');
      check(p.faults.length===0,'No transport errors: '+p.faults.join(';'));
      results.push({name:'terminal-'+mode,before,faultPackets:faultCount,finalTick:p.h.matchResult.tick,stateHash:stateHash(p.h),rollbackCount:p.g.netcodeSession.metrics.rollbacks,rollbackDepth:p.g.netcodeSession.metrics.maxRollbackDepth,replay:[verifyReplay(p.h),verifyReplay(p.g)],cleanup:await p.cleanup()});
    }finally{if(!p.h.disposed){p.h.dispose();p.g.dispose();}}
  }
  const p=await pair({late:true});
  try{
    check(!p.g.sim&&!p.h.netcodeSession.ready,'Host SDK starts before remote GameSession initialization');
    await p.pump(()=>p.h.netcodeNow-p.h.simClockLast>650,'Early HELLO retry window',0,20);
    check(p.h.sim.tick===0,'Unready Core creates no gameplay ticks');
    p.releaseStart();
    await p.pump(()=>p.h.netcodeSession.ready&&p.g.netcodeSession.ready,'Late SDK HELLO retries settle',0);
    await p.pump(()=>p.h.sim.tick===10&&p.g.sim.tick===10,'Peers advance after late handshake',10);
    const cores=[p.h.netcodeSession,p.g.netcodeSession],pcs=[p.ht.pc,p.gt.pc],channels=[p.ht.dc,p.ht.netcodeInputChannel,p.ht.netcodeControlChannel,p.gt.dc,p.gt.netcodeInputChannel,p.gt.netcodeControlChannel];
    const subscribers=[p.ht.netcodeListeners.size,p.gt.netcodeListeners.size];
    p.ht.forceReconnect('lifecycle-regression');p.gt.forceReconnect('lifecycle-regression');
    await wait(()=>p.ht.isOpen()&&p.gt.isOpen()&&p.ht.isNetcodeOpen()&&p.gt.isNetcodeOpen()&&p.h.transportConnected&&p.g.transportConnected,'Actual RTC reconnect');
    check(cores[0]===p.h.netcodeSession&&cores[1]===p.g.netcodeSession,'Reconnect retains the same SDK sessions');
    check(pcs.every(pc=>pc.connectionState==='closed')&&channels.every(c=>c.readyState==='closed'),'RTC replacement releases prior channels and PCs');
    check(subscribers[0]===p.ht.netcodeListeners.size&&subscribers[1]===p.gt.netcodeListeners.size,'Reconnect preserves subscriptions exactly once');
    await p.pump(()=>p.h.sim.tick===18&&p.g.sim.tick===18&&p.h.confirmedGameTick===18&&p.g.confirmedGameTick===18,'Same Core resumes after RTC reconnect',18);
    check(p.h.sim.checksum()===p.g.sim.checksum(),'Reconnected authoritative state agrees');
    check(p.faults.length===0,'Late handshake/reconnect have no transport errors');
    results.push({name:'late-hello-and-rtc-reconnect',sameSdkSessions:true,reconnectSerial:p.ht.connectionSerial,finalTick:18,cleanup:await p.cleanup()});
  }finally{if(!p.h.disposed){p.h.dispose();p.g.dispose();}}
  const bad=await pair({mismatch:true});
  try{
    await bad.pump(()=>bad.h.simulationFatal&&bad.g.simulationFatal,'Initial SDK HELLO mismatch stops both sessions',0);
    check(bad.h.sim.tick===0&&bad.g.sim.tick===0&&bad.h.netcodeSession.closed&&bad.g.netcodeSession.closed,'Mismatched initial states produce no gameplay tick and close Core');
    check([bad.h,bad.g].some(s=>s.simulationFatalInfo.source==='netcode-handshake'),'Mismatch reports the public SDK handshake failure');
    results.push({name:'initial-state-mismatch',fatal:true,gameTicks:[bad.h.sim.tick,bad.g.sim.tick],cleanup:await bad.cleanup()});
  }finally{if(!bad.h.disposed){bad.h.dispose();bad.g.dispose();}}
  const divergent=await pair();
  try{
    await divergent.pump(()=>divergent.h.netcodeSession.ready&&divergent.g.netcodeSession.ready,'Divergence fixture is ready',0);
    check(divergent.h.command({type:'SET_FLAG',x:1200,y:1500}),'Replay fixture submits a meaningful earlier command');
    await divergent.pump(()=>divergent.h.sim.tick===7&&divergent.g.sim.tick===7,'Divergence fixture reaches tick 7',7);
    divergent.g.sim.wallet[1]+=37;
    check(divergent.h.surrender(),'Divergence fixture submits surrender');
    await divergent.pump(()=>divergent.h.simEnded&&divergent.g.simEnded,'Terminal hash mismatch recovers through the public SDK');
    check(!divergent.h.simulationFatal&&!divergent.g.simulationFatal&&divergent.g.netcodeSession.metrics.recoveries>=1,'Guest recovers authoritative terminal state without a fatal stop');
    check(divergent.h.matchResult.tick===divergent.g.matchResult.tick&&divergent.h.matchResult.winner===divergent.g.matchResult.winner,'Recovered terminal outcome agrees');
    const hash=s=>RallyNetcode.hashBytes(s.simulationAdapter.save());
    check(hash(divergent.h)===hash(divergent.g),'Recovered terminal full state agrees');
    check(divergent.g.replayRecorder.commands.filter(c=>c.action.type==='SET_FLAG').length===1,'Recovery retains the earlier input log exactly once');
    results.push({name:'terminal-hash-divergence',finalTick:divergent.h.matchResult.tick,stateHash:hash(divergent.h),guestRecoveries:divergent.g.netcodeSession.metrics.recoveries,replay:[verifyReplay(divergent.h),verifyReplay(divergent.g)],cleanup:await divergent.cleanup()});
  }finally{if(!divergent.h.disposed){divergent.h.dispose();divergent.g.dispose();}}
  const early=await pair();
  try{
    await early.pump(()=>early.h.netcodeSession.ready&&early.g.netcodeSession.ready,'False early-terminal fixture is ready',0);
    check(early.h.command({type:'SET_FLAG',x:1200,y:1500}),'False terminal replay has an earlier real input');
    await early.pump(()=>early.h.sim.tick===7&&early.g.sim.tick===7,'False terminal fixture reaches tick 7',7);
    // An authoritative-state DESYNC can invent a premature outcome before the real command.
    early.g.sim.netcodeMatchResult={winner:'host',reason:'surrender',tick:early.g.sim.tick};
    check(early.h.surrender(),'Authority submits the actual later terminal command');
    await early.pump(()=>early.h.simEnded&&early.g.simEnded,'A corrected nonterminal snapshot clears the obsolete terminal barrier');
    check(!early.h.simulationFatal&&!early.g.simulationFatal&&early.g.netcodeSession.metrics.recoveries>=1,'False early outcome recovers without a fatal stop');
    check(early.h.matchResult.tick===12&&early.g.matchResult.tick===12&&early.h.matchResult.winner==='guest'&&early.g.matchResult.winner==='guest','Both peers publish the independently replayed real outcome');
    const hash=s=>RallyNetcode.hashBytes(s.simulationAdapter.save());
    check(hash(early.h)===hash(early.g),'False terminal recovery preserves the full authoritative state');
    results.push({name:'false-early-terminal-recovery',finalTick:12,stateHash:hash(early.h),guestRecoveries:early.g.netcodeSession.metrics.recoveries,replay:[verifyReplay(early.h),verifyReplay(early.g)],cleanup:await early.cleanup()});
  }finally{if(!early.h.disposed){early.h.dispose();early.g.dispose();}}
  return results;
}

async function liveStart({role,room,config}){
  const{GameSession,NostrRtcTransport,AppLifecycle}=window.__lifecycleQA;
  const t=new NostrRtcTransport(role,room),s=new GameSession(role,t,room,role==='host'?config:null),lobby=[],errors=[];
  const start=s.startSim.bind(s);s.startSim=seed=>{const out=start(seed);AppLifecycle.unregisterBackgroundSession(s);return out;};
  t.onOpen=()=>{s.onTransportOpen();s.stopHeartbeat(false);};t.onClose=()=>s.onTransportClosed();t.onError=e=>errors.push(String(e?.message||e));
  t.onMessage=m=>{lobby.push(m.type);s.handle(m);};window.__liveLifecycle={t,s,lobby,errors};t.open();
}
async function runLive(browser){
  const room=String(1000+Math.floor(Math.random()*9000));
  const contexts=await Promise.all([browser.newContext(),browser.newContext()]),pageErrors=[];
  try{
    const pages=await Promise.all(contexts.map(async context=>{const p=await context.newPage();p.on('pageerror',e=>pageErrors.push(e.message));await p.route('https://lifecycle-qa.local/**',r=>r.fulfill({contentType:'text/html',body:html}));await p.goto('https://lifecycle-qa.local/');return p;}));
    await pages[0].evaluate(liveStart,{role:'host',room,config:debugConfig});
    await pages[1].evaluate(liveStart,{role:'guest',room,config:debugConfig});
    await Promise.all(pages.map(p=>p.waitForFunction(()=>window.__liveLifecycle?.s.sim&&window.__liveLifecycle.t.isNetcodeOpen(),{},{timeout:45000})));
    for(let i=0;i<300;i++){
      const states=await Promise.all(pages.map(p=>p.evaluate(()=>{const{s}=window.__liveLifecycle;s.netcodeNow=Math.max(s.netcodeNow+100,performance.now());if(s.sim.tick<12||s.netcodeSession.resimulating)s.stepSimulationOnce(s.netcodeNow);else{s.netcodeSession.poll(s.netcodeNow);s.publishConfirmedFrames();}return{tick:s.sim.tick,confirmed:s.confirmedGameTick,ready:s.netcodeSession.ready,fatal:s.simulationFatal};})));
      if(states.every(s=>s.tick===12&&s.confirmed===12&&s.ready&&!s.fatal))break;
      await new Promise(r=>setTimeout(r,10));
    }
    const results=await Promise.all(pages.map(p=>p.evaluate(()=>{const{t,s,lobby,errors}=window.__liveLifecycle;return{tick:s.sim.tick,confirmed:s.confirmedGameTick,ready:s.netcodeSession.ready,fatal:s.simulationFatal,stateHash:RallyNetcode.hashBytes(s.simulationAdapter.save()),lobby,relayErrors:errors,selectedSdkIdentity:/^[a-f0-9]{64}$/.test(t.signalId)&&/^[a-f0-9]{64}$/.test(t.remoteSignalId),inputOpen:t.netcodeInputChannel.readyState==='open',controlOpen:t.netcodeControlChannel.readyState==='open'};})));
    assert.ok(results.every(r=>r.tick===12&&r.confirmed===12&&r.ready&&!r.fatal&&r.selectedSdkIdentity&&r.inputOpen&&r.controlOpen),'Real public Nostr and RTC GameSessions complete 12 confirmed ticks');
    assert.equal(results[0].stateHash,results[1].stateHash);
    assert.ok(results[0].lobby.includes('HELLO')&&results[1].lobby.includes('GAME_START'));
    await Promise.all(pages.map(async p=>{await p.evaluate(()=>{const{t,s}=window.__liveLifecycle;window.__liveResources=[t.pc,t.dc,t.netcodeInputChannel,t.netcodeControlChannel];s.dispose('live-network-regression');});await p.waitForFunction(()=>{const{t,s}=window.__liveLifecycle;return s.disposed&&s.netcodeSession.closed&&!t.pc&&!t.signaler&&!t.netcodeListeners.size&&window.__liveResources[0].connectionState==='closed'&&window.__liveResources.slice(1).every(c=>c.readyState==='closed');});}));
    assert.deepEqual(pageErrors,[]);
    return{room,independentBrowserContexts:true,results,pageErrors,closed:true};
  }finally{await Promise.all(contexts.map(c=>c.close()));}
}
(async()=>{
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://lifecycle-qa.local/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://lifecycle-qa.local/');await page.waitForFunction(()=>window.__lifecycleQA);
    const lifecycle=await page.evaluate(runLifecycle,debugConfig);assert.deepEqual(errors,[]);
    console.log(JSON.stringify({lifecycle,pageErrors:errors},null,2));
    if(process.env.QA_LIVE_NOSTR==='1')console.log(JSON.stringify({publicNostr:await runLive(browser)},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error);process.exitCode=1;});
