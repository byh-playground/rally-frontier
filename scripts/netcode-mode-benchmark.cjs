'use strict';
// Actual shipped StrategySim + adapter + public Core. Controlled input timing,
// isolated from RTC jitter; WebGL CPU submission is measured separately.
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const input=path.resolve(process.argv[2]||path.join(__dirname,'../_site/index.html'));
let html=fs.readFileSync(input,'utf8'),end=html.lastIndexOf('})();');assert(end>0);
html=html.slice(0,end)+'window.__modeBench={StrategySim,GameRuleDefinition,RallySimulationAdapter,RallyStateCodec,RallyCommandCodec,GLRenderer,UiController,UiRegistry,ActiveViewState};'+html.slice(end);
async function measure(){
 const q=window.__modeBench,sdk=window.RallyNetcode,check=(v,m)=>{if(!v)throw Error(m)},equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
 const summarize=values=>{const a=[...values].sort((a,b)=>a-b);return{n:a.length,total:a.reduce((a,b)=>a+b,0),p50:a[Math.floor((a.length-1)*.5)],p95:a[Math.floor((a.length-1)*.95)]}};
 const results=[],raf=window.requestAnimationFrame;window.requestAnimationFrame=()=>0;
 let renderer;
 try{
  q.UiController.setUiScreen('game');renderer=new q.GLRenderer(q.UiRegistry.refs.canvas);q.ActiveViewState.renderer=renderer;
  for(const count of[10,60]){
   const worlds=['lockstep','rollback'].map(mode=>{
    const rules=q.GameRuleDefinition.resolve({overrides:{simulation:{tps:20},map:{generator:'fixed-standard'}}});
    const sim=q.StrategySim.createForMatch({draft:{decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},seed:831047,rules,debugScenario:{kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',allyCount:count,enemyCount:count,research:false,humanRole:'host'}});
    const world={mode,sim,clock:0,saveMs:[],stepMs:[],advanceMs:[],latencyTicks:[],submitted:new Map(),renderMs:[]};
    const adapter=new q.RallySimulationAdapter({sim,onNetcodeFrameApplied(frame){for(const cmd of frame.commands){const tick=world.submitted.get(cmd.netcodeSequence);if(tick!==undefined)world.latencyTicks.push(frame.frameTick-tick)}}});
    const save=adapter.save.bind(adapter),step=adapter.step.bind(adapter);
    adapter.save=()=>{const t=performance.now();try{return save()}finally{world.saveMs.push(performance.now()-t)}};
    adapter.step=c=>{const t=performance.now();try{return step(c)}finally{world.stepMs.push(performance.now()-t)}};
    world.adapter=adapter;world.rawSave=save;
    // One local input owner deliberately removes transport scheduling noise.
    world.core=sdk.createSession({players:['host'],localPlayerId:'host',sessionId:'mode-bench',simulationVersion:'rally-mode-bench',seed:831047,inputSize:1,adapter,clock:()=>world.clock,profile:{...sdk.profiles.rts,mode,tickRate:20,adaptiveInputDelay:false,checksumInterval:20,maxHistoryBytes:64*1024*1024,maxSnapshotBytes:q.RallyStateCodec.maxBytes}});
    return world;
   });
   check(equal(worlds[0].rawSave(),worlds[1].rawSave()),'Identical seed, unit population and canonical starting bytes');
   for(let tick=0;tick<100;tick++){
    for(const w of tick%2?[worlds[1],worlds[0]]:worlds){
     if(tick===20){w.saveMs.length=w.stepMs.length=w.advanceMs.length=0;w.startMetrics=w.core.metrics;}
     if(tick%20===0){const sequence=w.core.queueCommand(q.RallyCommandCodec.encode({type:'SET_FLAG',x:1800+(tick%40)*8,y:2200,forced:false}));w.submitted.set(sequence,tick);}
     w.clock+=50;const started=performance.now(),result=w.core.advance(new Uint8Array(1));const ms=performance.now()-started;
     check(result.status==='advanced'&&w.sim.tick===tick+1,'Seeded local input bootstraps and advances exactly once');if(tick>=20)w.advanceMs.push(ms);
    }
   }
   check(equal(worlds[0].rawSave(),worlds[1].rawSave()),'Modes preserve identical canonical state after the exact same inputs');
   for(const w of worlds){
    const endMetrics=w.core.metrics;
    renderer.setSnapshot(w.sim.snapshot(),{liveTargets:false,snapTargets:true});
    for(let frame=0;frame<25;frame++){const t=performance.now();renderer.loop();if(frame>=5)w.renderMs.push(performance.now()-t);}
    check(!renderer.renderFatalReported&&renderer.backend==='WebGL','Actual WebGL renderer succeeds');
    const delta=k=>endMetrics[k]-w.startMetrics[k];
    results.push({mode:w.mode,combatUnitsPerSide:count,actualUnits:w.sim.units.length,tickRate:20,measuredTicks:80,hash:sdk.hashBytes(w.rawSave()),advanceCPUms:summarize(w.advanceMs),simulationCPUms:summarize(w.stepMs),snapshotCPUms:summarize(w.saveMs),renderSubmissionCPUms:summarize(w.renderMs),snapshotSaves:delta('snapshotSaves'),snapshotOwnedCopies:delta('snapshotSaves'),serializedSnapshotBytes:delta('serializedSnapshotBytes'),retainedSnapshotBytes:endMetrics.retainedSnapshotBytes,commandDelayTicks:w.latencyTicks,configuredInputDelayTicks:w.core.inputDelay});
    w.core.close();w.sim.dispose('mode-benchmark');
   }
  }
  return {method:'Same browser, interleaved actual StrategySim/adapter/Core worlds: 20 warmup + 80 measured ticks, same seed and tick-indexed commands. One local input owner removes transport jitter. Renderer is actual WebGL, 5 warmup + 20 CPU submission samples on each final identical state; excludes GPU completion and is not FPS. Snapshot-owned copies count Core save copies, not every allocation inside serialization. Delay is measured simulation ticks, not physical input-to-display latency.',results};
 }finally{window.requestAnimationFrame=raf;q.ActiveViewState.renderer=null;renderer?.device?.dispose?.();}
}
(async()=>{const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'chromium',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader']});try{
 const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
 await page.route('https://mode-bench.local/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('https://mode-bench.local/');await page.waitForFunction(()=>window.__modeBench&&window.RallyNetcode);
 const result=await page.evaluate(measure);assert.deepEqual(errors,[]);for(const count of[10,60]){const [a,b]=result.results.filter(x=>x.combatUnitsPerSide===count);assert.equal(a.hash,b.hash);assert(a.snapshotSaves<b.snapshotSaves/5);assert.deepEqual(a.commandDelayTicks,b.commandDelayTicks)}
 const output=path.join(__dirname,'../.qa/netcode-mode-benchmark.json');fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
