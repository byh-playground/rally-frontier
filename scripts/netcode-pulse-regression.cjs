const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
let html=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const end=html.lastIndexOf('})();');assert(end>0);
html=html.slice(0,end)+'window.__pulseQA={CONFIG,GameSession,LoopbackTransport,AppLifecycle,SimulationRuntimeState};'+html.slice(end);
(async()=>{
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://pulse-qa.local/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://pulse-qa.local/');await page.waitForFunction(()=>window.__pulseQA&&window.RallyNetcode);
    const results=await page.evaluate(async()=>{
      const {CONFIG,GameSession,LoopbackTransport,AppLifecycle,SimulationRuntimeState}=window.__pulseQA;
      const check=(value,message)=>{if(!value)throw Error(message)};
      const pause=ms=>new Promise(r=>setTimeout(r,ms));
      const results=[];
      for(const [tps,base,max] of [[10,1,3],[15,2,4],[20,2,6],[30,3,9]]){
        CONFIG.netcode.mode='lockstep';
        const room='pulse-'+tps,ht=new LoopbackTransport('host',room),gt=new LoopbackTransport('guest',room);
        ht.pair(gt);gt.pair(ht);
        const h=new GameSession('host',ht,room,{selectionMode:'deck',simulationTps:tps,debugScenario:{kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',allyCount:1,enemyCount:1,research:false,humanRole:'host'}});
        const g=new GameSession('guest',gt,room),sessions=[h,g];let published=0,polls=0;
        for(const s of sessions){s.transport.onOpen=()=>s.onTransportOpen();s.transport.onMessage=m=>s.handle(m);s.onSnapshot=()=>published++}
        try{
          ht.open();gt.open();const deadline=performance.now()+15000;
          while(!sessions.every(s=>s.netcodeSession?.ready&&s.sim?.tick>=2)){check(performance.now()<deadline,'Handshake/ticks');await pause(10)}
          AppLifecycle.stopBackgroundTicker();
          for(const s of sessions){const profile=s.netcodeSession.profile;check(profile.baseInputDelayTicks===base&&profile.minInputDelayTicks===base&&profile.maxInputDelayTicks===max,'TPS-scaled public input bounds');const poll=s.netcodeSession.poll;s.netcodeSession.poll=function(...args){polls++;return poll.apply(this,args)}}
          let now=Math.max(...sessions.map(s=>s.lastDriverPulseAt));
          const pulse=async(delta)=>{now+=delta;for(const s of sessions)s.advanceSimulation(now);await pause(0)};
          const ticks=sessions.map(s=>s.sim.tick),before=polls;
          await pulse(4000);
          check(polls===before+2,'Long suspension still polls both Core sessions');
          check(sessions.every((s,i)=>s.sim.tick===ticks[i]),'Suspension drops old debt without advancing stale ticks');
          for(let i=0;i<6;i++)await pulse(1000/tps);
          check(sessions.every((s,i)=>s.sim.tick>ticks[i]),'Ordinary ticks resume after suspension');
          sessions.forEach(s=>s.syncHold=true);
          await pulse(100);await pulse(100);const heldTick=sessions.map(s=>s.sim.tick),heldPublications=published,heldPolls=polls;
          for(let i=0;i<5;i++)await pulse(500);
          check(polls===heldPolls+10,'Ongoing slow pulses poll rather than rebase/return');
          check(sessions.every((s,i)=>s.sim.tick===heldTick[i]),'Hold preserves state');
          check(published===heldPublications,'Unchanged held snapshots are not republished');
          SimulationRuntimeState.invalidate(h.sim);await pulse(100);
          check(published===heldPublications+1,'Same-tick runtime correction is published');
          h.presentationEventBuffer.push({type:'qa-presentation'});await pulse(100);
          check(published===heldPublications+2&&h.presentationEventBuffer.length===0,'Pending events publish at the same tick');
          check(sessions.every(s=>s.netcodeSession.metrics.hashMismatches===0&&s.netcodeSession.metrics.recoveries===0),'Scheduling never invents divergence/recovery');
          // Exercise the real Worker lifecycle and existing timer fallback while held.
          AppLifecycle.ensureBackgroundTicker();const worker=AppLifecycle.backgroundTickWorker;check(worker,'Real Worker exists');
          worker.dispatchEvent(new ErrorEvent('error'));
          check(!AppLifecycle.backgroundTickWorker&&AppLifecycle.backgroundTickFallback,'Worker error activates one timer fallback');
          const fallback=AppLifecycle.backgroundTickFallback;AppLifecycle.ensureBackgroundTicker();check(AppLifecycle.backgroundTickFallback===fallback,'Fallback is not duplicated');
          await pause(100);AppLifecycle.stopBackgroundTicker();AppLifecycle.ensureBackgroundTicker();
          check(AppLifecycle.backgroundTickWorker&&AppLifecycle.backgroundTickWorker!==worker&&!AppLifecycle.backgroundTickFallback,'Restart replaces the old worker once');
          results.push({tps,base,max,suspensionPolls:true,heldSnapshotReuse:true,sameTickCorrection:true,workerRestart:true});
        }finally{for(const s of sessions)s.dispose('pulse-qa');AppLifecycle.stopBackgroundTicker()}
      }
      return results;
    });
    assert.deepEqual(errors,[]);console.log(JSON.stringify(results,null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(e.stack);process.exitCode=1});
