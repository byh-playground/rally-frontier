const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const option=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1]};
const duration=Number(option('duration',30000)),runId=option('run','current');
assert(/^[a-z0-9-]+$/.test(runId));assert(duration>=10000&&duration<=120000);
const sourcePath=path.resolve(option('html',path.join(root,'index.html')));
let source=fs.readFileSync(sourcePath,'utf8');
if(!source.includes('"rollback":"data:text/javascript;base64,'))source=require('./bundle-gamekit.cjs').bundleGame(root,source);
const mapFile=option('map',null),canonical=mapFile?JSON.parse(fs.readFileSync(path.resolve(mapFile),'utf8')):null;
const cases=JSON.parse(option('cases',JSON.stringify([{name:'shell-cpu4',type:'shelltitan',count:60,rate:4},{name:'sword-native',type:'swordsman',count:60,rate:1},{name:'hive-native',type:'hivecarrier',count:30,rate:1}])));
const output=path.join(root,'.qa/netcode-starvation',runId);fs.mkdirSync(output,{recursive:true});
const write=(name,data)=>fs.writeFileSync(path.join(output,name),JSON.stringify(data,null,2)+'\n');
const bounded=(promise,ms,label)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error(label+' timed out')),ms);timer.unref()})]);
function observer(){
  const q=window.__starvation={GameSession,NostrRtcTransport,MatchLifecycle,ActiveViewState,MapGeneration,LocalRtcSignalBus,DebugScenarioHarness,CONFIG,RALLY_RTC_SIGNAL_PROTOCOL,
    samples:[],commands:[],ice:[],longTasks:[],running:false};
  const emit=(kind,row)=>console.info('__starvation__'+JSON.stringify({kind,...row}));
  const advance=GameSession.prototype.advanceSimulation;
  GameSession.prototype.advanceSimulation=function(...args){
    const result=advance.apply(this,args);
    if(q.running)for(const c of q.commands){
      if(c.confirmedAt)continue;
      const receipt=this.sim.commandReceipts.find(r=>r.actor===this.role&&r.netcodeSequence===c.sequence);
      if(receipt&&this.confirmedGameTick>=receipt.tick){c.confirmedAt=performance.now();c.ms=c.confirmedAt-c.submittedAt;emit('command',c)}
    }
    return result;
  };
  q.start=()=>{
    q.started=performance.now();q.running=true;
    const observer=new PerformanceObserver(list=>{if(q.running)for(const t of list.getEntries())q.longTasks.push({at:t.startTime,ms:t.duration})});observer.observe({type:'longtask',buffered:false});q.observer=observer;
    q.heartbeat=setInterval(()=>{
      const s=ActiveViewState.session,m=s.netcodeSession.metrics,at=performance.now();
      const row={at,tick:s.sim.tick,rtt:m.smoothedRTT,jitter:m.jitter,inputDelay:m.inputDelay,recoveries:m.recoveries,hashMismatches:m.hashMismatches,
        frameMs:ActiveViewState.renderer.perfStats.frameWorkMs,stepMs:s.sim.perfStats.lastStepMs,pulseMs:s.performanceStats.timings.pulse?.currentMs};
      q.samples.push(row);emit('sample',row);
      if(q.icePending||at-(q.lastIce||0)<1000)return;q.lastIce=at;q.icePending=true;
      s.transport.pc.getStats().then(report=>{for(const r of report.values())if(r.type==='transport'&&r.selectedCandidatePairId){const pair=report.get(r.selectedCandidatePairId);if(pair)q.ice.push({at:performance.now(),rttMs:pair.currentRoundTripTime*1000})}}).catch(()=>{}).finally(()=>q.icePending=false);
    },100);
    q.commandTimer=setInterval(()=>{
      const s=ActiveViewState.session;
      const accepted=s.command({type:'SET_FLAG',x:s.sim.world.width*.5+120,y:s.sim.world.height*.5-120,forced:false});
      if(accepted)q.commands.push({sequence:s.lastCommandTicket.sequence,submittedAt:performance.now(),tick:s.sim.tick});
    },3000);
  };
  q.stop=()=>{
    q.running=false;clearInterval(q.heartbeat);clearInterval(q.commandTimer);q.observer.disconnect();
    const s=ActiveViewState.session;
    return {started:q.started,stopped:performance.now(),samples:q.samples,commands:q.commands,ice:q.ice,longTasks:q.longTasks,
      tick:s.sim.tick,seed:s.sim.seed,mapHash:s.sim.mapFingerprint(),units:s.sim.units.length,
      fatal:s.simulationFatal,renderFatal:ActiveViewState.renderer.renderFatalReported,metrics:s.netcodeSession.metrics,profile:s.netcodeSession.profile,
      timings:s.performanceStats.timings,hashes:Object.fromEntries([0,1,2].map(i=>Math.floor(s.sim.tick/s.netcodeSession.profile.checksumInterval)*s.netcodeSession.profile.checksumInterval-i*s.netcodeSession.profile.checksumInterval).filter(t=>t>=0).map(t=>[t,s.netcodeSession.getStateHash(t)]))};
  };
}
function connect({role,c,canonical}){
  const q=window.__starvation; q.MatchLifecycle.disposeMatches('starvation-start');q.CONFIG.netcode.mode='lockstep';
  if(canonical)q.MapGeneration.generateMapDescriptor=()=>JSON.parse(JSON.stringify(canonical));
  q.LocalRtcSignalBus.prototype.open=function(){this.opened=true;window.__signalBridge=this;queueMicrotask(()=>this.owner.onSignalingReady())};
  q.LocalRtcSignalBus.prototype.publish=function(payload){if(!this.opened)return false;window.__emitSignal({...payload,from:this.owner.signalId,roomCode:this.owner.roomCode,protocol:q.RALLY_RTC_SIGNAL_PROTOCOL});return true};
  const room='RF_FOG_MATCHED20261009',t=new q.NostrRtcTransport(role,room,{signalMode:'local'});
  const config=role==='host'?{selectionMode:'deck',presetId:'standard',simulationTps:10,debugScenario:q.DebugScenarioHarness.normalize({kind:'unit-combat',allyType:c.type,enemyType:c.type,allyCount:c.count,enemyCount:c.count,research:false,humanRole:'host'})}:null;
  const s=new q.GameSession(role,t,room,config);
  Object.assign(q.ActiveViewState,{role,roomCode:room,session:s,transport:t});q.MatchLifecycle.wireSessionForView(role,s,t);t.open();
}
(async()=>{
  const end=source.lastIndexOf('})();');assert(end>0);
  const html=source.slice(0,end)+`(${observer.toString()})();`+source.slice(end),results=[];
  for(const c of cases){
    assert(/^[a-z0-9-]+$/.test(c.name));const browsers=[],servers=[],pages=[],cdps=[],errors=[],streamed=[[],[]];let phase='start';
    const watchdog=setTimeout(()=>{write(c.name+'-timeout.json',{phase,streamed});for(const b of browsers)b.close().catch(()=>{})},duration+60000);watchdog.unref();
    try{
      for(let i=0;i<2;i++){
        const server=await chromium.launchServer({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true,args:['--disable-background-timer-throttling','--disable-renderer-backgrounding','--disable-backgrounding-occluded-windows']});servers.push(server);
        const browser=await chromium.connect(server.wsEndpoint());browsers.push(browser);
        const page=await browser.newPage({viewport:{width:1280,height:800}});pages.push(page);
        page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
        page.on('console',msg=>{const text=msg.text();if(text.startsWith('__starvation__')){const row=JSON.parse(text.slice(14));streamed[i].push(row);fs.appendFileSync(path.join(output,c.name+'-'+(i?'guest':'host')+'.jsonl'),JSON.stringify(row)+'\n')}});
        await page.route('https://starvation-qa.local/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('https://starvation-qa.local/');
        await page.waitForFunction(()=>window.__starvation&&window.RallyNetcode);
      }
      for(let i=0;i<2;i++)await pages[i].exposeBinding('__emitSignal',async(_,payload)=>bounded(pages[1-i].evaluate(p=>window.__signalBridge?.onSignal(p),payload),10000,'signaling'));
      await pages[0].evaluate(connect,{role:'host',c,canonical});await pages[1].evaluate(connect,{role:'guest',c,canonical});
      await Promise.all(pages.map(p=>p.waitForFunction(()=>window.__starvation.ActiveViewState.session?.sim?.tick>=4&&window.__starvation.ActiveViewState.session.netcodeSession.ready,null,{timeout:45000})));
      if(c.center)for(const p of pages){
        const point=await p.evaluate(()=>{const rect=window.__starvation.ActiveViewState.minimap.contentRect();return{x:rect.left+rect.width*.5,y:rect.top+rect.height*.5}});
        await p.mouse.click(point.x,point.y);
      }
      // Measure before changing CPU rate so the watchdog does not depend on a busy page starting a timer.
      await Promise.all(pages.map(p=>p.evaluate(()=>window.__starvation.start())));
      for(const p of pages){const d=await p.context().newCDPSession(p);cdps.push(d);if(c.rate>1)await d.send('Emulation.setCPUThrottlingRate',{rate:c.rate})}
      phase='measure';console.log(JSON.stringify({case:c.name,phase}));await new Promise(r=>setTimeout(r,duration));
      phase='stop';const data=await bounded(Promise.all(pages.map(p=>p.evaluate(()=>window.__starvation.stop()))),5000,'main-thread stop');
      data.forEach((d,i)=>write(c.name+'-'+(i?'guest':'host')+'.json',d));
      const max=values=>values.length?Math.max(...values):0;
      const summaries=data.map((d,i)=>{
        const gaps=d.samples.map((r,j)=>r.at-(j?d.samples[j-1].at:d.started));gaps.push(d.stopped-(d.samples.at(-1)?.at||d.started));
        const oldPending=d.commands.filter(r=>!r.confirmedAt&&d.stopped-r.submittedAt>=4000);
        return {role:i?'guest':'host',samples:d.samples.length,ticks:d.samples.at(-1).tick-d.samples[0].tick,
          heartbeatMaxGapMs:max(gaps),rttMaxMs:max(d.samples.map(r=>r.rtt)),jitterMaxMs:max(d.samples.map(r=>r.jitter)),iceMaxMs:max(d.ice.map(r=>r.rttMs)),
          commandMaxMs:max(d.commands.filter(r=>r.confirmedAt).map(r=>r.ms)),oldPending:oldPending.length,maxTaskMs:max(d.longTasks.map(r=>r.ms)),
          recoveries:d.metrics.recoveries,hashMismatches:d.metrics.hashMismatches,seed:d.seed,mapHash:d.mapHash,units:d.units,inputDelay:d.metrics.inputDelay};
      });
      write(c.name+'-summary.json',{case:c,summaries,errors});results.push({case:c,summaries});console.log(JSON.stringify({case:c.name,summaries}));
      assert.deepEqual(errors,[]);assert(data.every(d=>!d.fatal&&!d.renderFatal));
      assert.equal(data[0].seed,data[1].seed);assert.equal(data[0].mapHash,data[1].mapHash);
      const interval=data[0].profile.checksumInterval,hashTick=Math.floor(Math.min(...data.map(d=>d.tick))/interval)*interval;
      assert(Number.isInteger(data[0].hashes[hashTick]));assert.equal(data[0].hashes[hashTick],data[1].hashes[hashTick],'Actual peers agree on the latest common checkpoint');
      for(const s of summaries){assert(s.samples>=10&&s.ticks>=10,'Timers and simulation keep progressing');assert(s.heartbeatMaxGapMs<2000,'No multi-second event-loop starvation');assert(s.rttMaxMs<2000,'No multi-second application RTT');assert(s.oldPending===0&&s.commandMaxMs<4000,'No four-second command amplification');assert.equal(s.hashMismatches,0);assert.equal(s.recoveries,0)}
      assert(data.every(d=>d.commands.filter(r=>r.confirmedAt).length>=2),'Both players confirm actual commands');
      if(source.includes('dbgPerfCommandConfirm'))assert(data.every(d=>d.timings.commandConfirm?.samples>=2),'Production telemetry records both players');
      await bounded(pages[0].screenshot({path:path.join(output,c.name+'.png')}),5000,'screenshot');
    }catch(error){write(c.name+'-failure.json',{phase,error:String(error.stack),errors,streamed});throw error}
    finally{
      clearTimeout(watchdog);
      for(const d of cdps)await bounded(d.detach(),1000,'CDP detach').catch(()=>{});
      await bounded(Promise.all(browsers.map(b=>b.close())),5000,'browser close').catch(()=>{});
      // The public BrowserServer kill only owns these two diagnostic browsers.
      // Cleanup must not depend on JavaScript in a frozen renderer responding.
      for(const server of servers)await bounded(server.kill(),5000,'owned browser shutdown').catch(()=>{});
    }
  }
  write('summary.json',results);
})().catch(e=>{console.error(e.stack);process.exitCode=1});
