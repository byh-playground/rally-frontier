const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
// Run each HTML variant with BOTH peers on that variant. Gameplay differs.
// --html <path> --run <unique-id> --map <canonical-map.json> --duration 30000
// --cases accepts the same 400-supply roster format as the normal400 probe.
const root=path.resolve(__dirname,'..');
const option=(name,fallback)=>{const i=process.argv.indexOf('--'+name);return i<0?fallback:process.argv[i+1]};
const duration=Number(option('duration',30000)),runId=option('run','current');
assert(/^[a-z0-9-]+$/.test(runId));assert(duration>=10000&&duration<=120000);
const sourcePath=path.resolve(option('html',path.join(root,'index.html')));
let source=fs.readFileSync(sourcePath,'utf8');
const sourceSha256=require('node:crypto').createHash('sha256').update(source).digest('hex');
if(!source.includes('"rollback":"data:text/javascript;base64,'))source=require('./bundle-gamekit.cjs').bundleGame(root,source);
const mapFile=option('map',null),canonical=mapFile?JSON.parse(fs.readFileSync(path.resolve(mapFile),'utf8')):null;
const cases=JSON.parse(option('cases',JSON.stringify([
  {name:'basic400',type:'swordsman',count:1,rate:1,center:true,research:false,roster:[{type:'worker',count:40},{type:'swordsman',count:180}]},
  {name:'mixed400',type:'swordsman',count:1,rate:1,center:true,research:true,roster:[{type:'worker',count:40},{type:'tank',count:12},{type:'swordsman',count:60},{type:'archer',count:60},{type:'medic',count:10},{type:'mage',count:10}]}
])));
const output=path.join(root,'.qa/netcode-starvation',runId);fs.mkdirSync(output,{recursive:true});
const write=(name,data)=>fs.writeFileSync(path.join(output,name),JSON.stringify(data,null,2)+'\n');
const bounded=(promise,ms,label)=>Promise.race([promise,new Promise((_,reject)=>{const timer=setTimeout(()=>reject(Error(label+' timed out')),ms);timer.unref()})]);
function observer(){
  const q=window.__starvation={GameSession,NostrRtcTransport,MatchLifecycle,ActiveViewState,MapGeneration,LocalRtcSignalBus,DebugScenarioHarness,CONFIG,RALLY_RTC_SIGNAL_PROTOCOL,
    samples:[],steps:[],commands:[],ice:[],longTasks:[],running:false};
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


  let pickCalls=0,pickMs=0,reuseCalls=0,reuseMs=0,collisionMs=0,sweepMs=0;
  for(const name of ['solveContacts','resolveNonAlliedSurfaceMotion']){
    const original=StrategySim.prototype[name];
    StrategySim.prototype[name]=function(...args){
      if(!q.running||this!==ActiveViewState.session.sim)return original.apply(this,args);
      const started=performance.now();try{return original.apply(this,args)}finally{
        if(name==='solveContacts')collisionMs+=performance.now()-started;else sweepMs+=performance.now()-started;
      }
    };
  }
  for(const [name,reuse] of [['pickCombatTarget',false],['retainedCombatTarget',true]]){
    const original=StrategySim.prototype[name];if(!original)continue;
    StrategySim.prototype[name]=function(...args){
      if(!q.running||this!==ActiveViewState.session.sim)return original.apply(this,args);
      const started=performance.now();try{return original.apply(this,args)}finally{
        if(reuse){reuseCalls++;reuseMs+=performance.now()-started}else{pickCalls++;pickMs+=performance.now()-started}
      }
    };
  }
  const step=StrategySim.prototype.step;
  StrategySim.prototype.step=function(...args){
    const record=q.running&&this===ActiveViewState.session.sim;
    if(record){pickCalls=0;pickMs=0;reuseCalls=0;reuseMs=0;collisionMs=0;sweepMs=0}
    const result=step.apply(this,args);
    const physics=globalThis.PhysicsControllerProbe?.records.get(this);
    if(record)q.steps.push({tick:this.tick,ms:this.perfStats.lastStepMs,pickCalls,pickMs,reuseCalls,reuseMs,
      physicsMs:physics?.lastMs??collisionMs,sweepMs,engineMs:physics?.lastEngineMs??null,physicsCalls:physics?.lastCalls??null,
      sweepCandidates:this.perfStats.sampleTick===this.tick?this.perfStats.collisionSweptPairTests:null,
      sweepPasses:this.perfStats.sampleTick===this.tick?this.perfStats.collisionSweptActivePasses:null,
      sweepHits:this.perfStats.sampleTick===this.tick?this.perfStats.collisionSweptHits:null,units:this.units.filter(u=>u.alive).length});
    return result;
  };

  const apply=StrategySim.prototype.applyDebugScenario;
  StrategySim.prototype.applyDebugScenario=function(raw){
    const cfg=apply.call(this,raw),c=q.fixtureCase;if(!c?.roster)return cfg;
    this.units=this.units.filter(u=>u.side===NEUTRAL_SIDE);this.unitById.clear();this.unitIndexById.clear();this.runtimeIndexTick=-1;this.rebuildRuntimeIndexes();
    const combat=c.roster.filter(x=>x.type!=='worker'),cx=this.world.width*.5,cy=this.world.height*.5;
    this.decks=[combat.map(x=>x.type),combat.map(x=>x.type)];
    for(const side of [0,1]){
      const dir=side===0?1:-1,base=this.buildings.find(b=>b.side===side&&BuildingDefinition.get(b.type)?.isMainBase);let depth=0;
      for(const group of c.roster){const type=group.type==='worker'?ECONOMY_WORKER_TYPE:group.type;
        if(cfg.research&&!UnitDefinition.get(type)?.economyWorker)this.abilities[side][type]=true;
        if(group.type==='worker'){
          for(let i=0;i<group.count;i++){if(this.spawnFromBuilding(base,type))continue;const a=i*Math.PI*2/group.count,r=140+(i%3)*28;this.spawnUnit(side,type,base.x+Math.cos(a)*r,base.y+Math.sin(a)*r)}
        }else{
          const cols=Math.min(12,group.count),spacing=Math.max(24,this.unitRadius(type)*2+8),rows=Math.ceil(group.count/cols);
          for(let i=0;i<group.count;i++)this.spawnUnit(side,type,cx+(i%cols-(cols-1)/2)*spacing,cy+dir*(110+depth+Math.floor(i/cols)*spacing));
          depth+=rows*spacing+16;
        }
      }
    }
    this.rebuildRuntimeIndexes();q.fixture={supply:[this.supplyUsed(0),this.supplyUsed(1)],units:this.units.length,types:this.units.filter(u=>u.alive).reduce((a,u)=>{const k=u.side+':'+u.type;a[k]=(a[k]||0)+1;return a},{})};
    if(q.fixture.supply.some(n=>n!==400))throw Error('QA fixture must start at 400 supply per player: '+q.fixture.supply);
    return cfg;
  };

  q.start=()=>{
    q.started=performance.now();q.running=true;q.startedTick=ActiveViewState.session.sim.tick;
    const observer=new PerformanceObserver(list=>{if(q.running)for(const t of list.getEntries())q.longTasks.push({at:t.startTime,ms:t.duration})});observer.observe({type:'longtask',buffered:false});q.observer=observer;
    q.heartbeat=setInterval(()=>{
      const s=ActiveViewState.session,m=s.netcodeSession.metrics,at=performance.now();
      const row={at,tick:s.sim.tick,rtt:m.smoothedRTT,jitter:m.jitter,inputDelay:m.inputDelay,recoveries:m.recoveries,hashMismatches:m.hashMismatches,
        units:s.sim.units.length,projectiles:s.sim.projectiles?.length||0,fps:ActiveViewState.renderer.perfStats.fps,frameMs:ActiveViewState.renderer.perfStats.frameWorkMs,stepMs:s.sim.perfStats.lastStepMs,pulseMs:s.performanceStats.timings.pulse?.currentMs};
      q.samples.push(row);emit('sample',row);
      if(q.icePending||at-(q.lastIce||0)<1000)return;q.lastIce=at;q.icePending=true;
      s.transport.pc.getStats().then(report=>{for(const r of report.values())if(r.type==='transport'&&r.selectedCandidatePairId){const pair=report.get(r.selectedCandidatePairId);if(pair)q.ice.push({at:performance.now(),rttMs:pair.currentRoundTripTime*1000})}}).catch(()=>{}).finally(()=>q.icePending=false);
    },100);
    q.commandTimer=setInterval(()=>{
      const s=ActiveViewState.session;
      const submittedAt=performance.now();
      // Submit a real, idempotent command so throughput does not alter rally intent.
      const accepted=s.command({type:'SET_FLAG',...s.sim.flags[s.role==='host'?0:1]});
      if(accepted)q.commands.push({sequence:s.lastCommandTicket.sequence,submittedAt,tick:s.sim.tick});
    },1000);
  };
  q.stop=()=>{
    q.running=false;clearInterval(q.heartbeat);clearInterval(q.commandTimer);q.observer.disconnect();
    const s=ActiveViewState.session;
    const grid=s.sim.collisionSweepGrid,refs=(buckets,used)=>used.reduce((n,key)=>n+buckets[key].length,0);
    const index={fullReferences:refs(grid.buckets,grid.used)+grid.ordered.length+grid.overflow.length,
      hostileReferences:grid.hostileBuckets?grid.hostileBuckets.reduce((n,b,side)=>n+refs(b,grid.hostileUsed[side])+grid.hostileOrdered[side].length+grid.hostileOverflow[side].length,0):0,
      allocatedFullCells:grid.buckets.filter(Boolean).length,allocatedHostileCells:grid.hostileBuckets?grid.hostileBuckets.reduce((n,b)=>n+b.filter(Boolean).length,0):0};
    return {started:q.started,startedTick:q.startedTick,stopped:performance.now(),samples:q.samples,steps:q.steps,commands:q.commands,ice:q.ice,longTasks:q.longTasks,
      index,
      fixture:q.fixture,supply:[s.sim.supplyUsed(0),s.sim.supplyUsed(1)],types:s.sim.units.filter(u=>u.alive).reduce((a,u)=>{const k=u.side+":"+u.type;a[k]=(a[k]||0)+1;return a},{}),perfStats:s.sim.perfStats,tick:s.sim.tick,seed:s.sim.seed,mapHash:s.sim.mapFingerprint(),units:s.sim.units.length,
      fatal:s.simulationFatal,renderFatal:ActiveViewState.renderer.renderFatalReported,metrics:s.netcodeSession.metrics,profile:s.netcodeSession.profile,
      timings:s.performanceStats.timings,hashes:Object.fromEntries([0,1,2].map(i=>Math.floor(s.sim.tick/s.netcodeSession.profile.checksumInterval)*s.netcodeSession.profile.checksumInterval-i*s.netcodeSession.profile.checksumInterval).filter(t=>t>=0).map(t=>[t,s.netcodeSession.getStateHash(t)]))};
  };
}
function connect({role,c,canonical}){
  const q=window.__starvation;q.fixtureCase=c; q.MatchLifecycle.disposeMatches('starvation-start');q.CONFIG.netcode.mode='lockstep';
  if(canonical)q.MapGeneration.generateMapDescriptor=()=>JSON.parse(JSON.stringify(canonical));
  q.LocalRtcSignalBus.prototype.open=function(){this.opened=true;window.__signalBridge=this;queueMicrotask(()=>this.owner.onSignalingReady())};
  q.LocalRtcSignalBus.prototype.publish=function(payload){if(!this.opened)return false;window.__emitSignal({...payload,from:this.owner.signalId,roomCode:this.owner.roomCode,protocol:q.RALLY_RTC_SIGNAL_PROTOCOL});return true};
  const room='RF_FOG_MATCHED20261009',t=new q.NostrRtcTransport(role,room,{signalMode:'local'});
  const config=role==='host'?{selectionMode:'deck',presetId:'standard',simulationTps:10,debugScenario:q.DebugScenarioHarness.normalize({kind:'unit-combat',allyType:c.type,enemyType:c.type,allyCount:c.count,enemyCount:c.count,research:c.research===true,humanRole:'host'})}:null;
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
      for(const d of data)assert.equal(d.steps.length,d.tick-d.startedTick,'Record every measured simulation tick');
      const max=values=>values.length?Math.max(...values):0;
      const stats=values=>{const a=values.filter(Number.isFinite).sort((a,b)=>a-b);return {n:a.length,mean:a.length?a.reduce((s,v)=>s+v,0)/a.length:0,p50:a[Math.floor((a.length-1)*.5)]||0,p95:a[Math.ceil(a.length*.95)-1]||0,max:max(a)}};
      const summaries=data.map((d,i)=>{
        const gaps=d.samples.map((r,j)=>r.at-(j?d.samples[j-1].at:d.started));gaps.push(d.stopped-(d.samples.at(-1)?.at||d.started));
        const oldPending=d.commands.filter(r=>!r.confirmedAt&&d.stopped-r.submittedAt>=4000);
        return {role:i?'guest':'host',tps:(d.tick-d.startedTick)*1000/(d.stopped-d.started),
          step:stats(d.steps.map(s=>s.ms)),pickCalls:stats(d.steps.map(s=>s.pickCalls)),pickMs:stats(d.steps.map(s=>s.pickMs)),reuseMs:stats(d.steps.map(s=>s.reuseMs)),
          physics:stats(d.steps.map(s=>s.physicsMs)),sweep:stats(d.steps.map(s=>s.sweepMs)),engine:stats(d.steps.map(s=>s.engineMs)),
          sweepCandidates:stats(d.steps.map(s=>s.sweepCandidates)),index:d.index,
          command:stats(d.commands.filter(c=>c.confirmedAt).map(c=>c.ms)),pending:d.commands.filter(c=>!c.confirmedAt).map(c=>({sequence:c.sequence,ageMs:d.stopped-c.submittedAt})),samples:d.samples.length,ticks:d.samples.at(-1).tick-d.samples[0].tick,
          heartbeatMaxGapMs:max(gaps),rttMaxMs:max(d.samples.map(r=>r.rtt)),jitterMaxMs:max(d.samples.map(r=>r.jitter)),iceMaxMs:max(d.ice.map(r=>r.rttMs)),
          commandMaxMs:max(d.commands.filter(r=>r.confirmedAt).map(r=>r.ms)),oldPending:oldPending.length,maxTaskMs:max(d.longTasks.map(r=>r.ms)),
          recoveries:d.metrics.recoveries,hashMismatches:d.metrics.hashMismatches,seed:d.seed,mapHash:d.mapHash,units:d.units,inputDelay:d.metrics.inputDelay};
      });
      write(c.name+'-summary.json',{case:c,sourcePath,sourceSha256,summaries,errors});results.push({case:c,sourcePath,sourceSha256,summaries});console.log(JSON.stringify({case:c.name,summaries}));
      await bounded(pages[0].screenshot({path:path.join(output,c.name+'.png')}),10000,'screenshot');
      assert.deepEqual(errors,[]);assert(data.every(d=>!d.fatal&&!d.renderFatal));
      assert.equal(data[0].seed,data[1].seed);assert.equal(data[0].mapHash,data[1].mapHash);
      const interval=data[0].profile.checksumInterval,hashTick=Math.floor(Math.min(...data.map(d=>d.tick))/interval)*interval;
      assert(Number.isInteger(data[0].hashes[hashTick]));assert.equal(data[0].hashes[hashTick],data[1].hashes[hashTick],'Actual peers agree on the latest common checkpoint');
      for(const s of summaries){assert(s.samples>=10&&s.ticks>=10,'Timers and simulation keep progressing');assert.equal(s.hashMismatches,0);assert.equal(s.recoveries,0)}
      assert(data.every(d=>d.commands.filter(r=>r.confirmedAt).length>=2),'Both players confirm actual commands');
      if(source.includes('dbgPerfCommandConfirm'))assert(data.every(d=>d.timings.commandConfirm?.samples>=2),'Production telemetry records both players');

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
