/* Actual Edge/WebGL, two production GameSessions, deterministic pre-game fixtures.
 * N is TOTAL ordinary ground units per simulation, never summed across peers.
 * Main matrix: common-goal traversal (not time-to-destination). Battle is separate.
 * Policies, roster > debug UI's 60 limit, terrain and AI overrides exist only here.
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),os=require('node:os'),cp=require('node:child_process');
const {chromium}=require('playwright');
const {installFixture}=require('./ground-planner-fixture.cjs');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2);
const opt=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1]};
const config={timingVersion:2,modes:opt('modes','astar,shared-astar,flow-field').split(','),counts:opt('counts','100,200,400').split(',').map(Number),complexities:opt('complexities','low,medium,high').split(','),runs:Number(opt('runs','2')),ticks:Number(opt('ticks','10')),scenario:opt('scenario','movement'),formation:opt('formation','dense'),synctest:opt('synctest','0')==='1',unit:opt('unit','swordsman'),timeoutMs:Number(opt('timeout','120000')),output:path.resolve(opt('output',path.join(root,'.qa','ground-planners')))};
assert(Number.isInteger(config.runs)&&config.runs>0);assert(Number.isInteger(config.ticks)&&config.ticks>5);
assert(config.modes.every(x=>['astar','shared-astar','flow-field','adaptive'].includes(x)));
assert(config.complexities.every(x=>['low','medium','high'].includes(x)));
assert(config.counts.every(x=>Number.isInteger(x)&&x>=1&&x<=400&&(config.scenario==='movement'||x%2===0)));assert(['movement','battle'].includes(config.scenario));assert(['dense','clear'].includes(config.formation));assert(config.formation!=='clear'||config.scenario==='movement');
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const stats=xs=>{const a=xs.filter(Number.isFinite).sort((a,b)=>a-b);return a.length?{n:a.length,mean:a.reduce((s,x)=>s+x,0)/a.length,p50:a[Math.floor((a.length-1)*.5)],p95:a[Math.floor((a.length-1)*.95)],max:a.at(-1),sum:a.reduce((s,x)=>s+x,0)}:null};
const write=(p,x)=>fs.writeFileSync(p,JSON.stringify(x,null,2));
function instrument(cfg){
  const q=window.__groundBench={cfg,MatchLifecycle,ActiveViewState,RallySynctestDiagnostics,RangeUtil,BattlefieldProjection,ViewRuntimeState,initial:{},end:{},steps:[],frames:[],startedAt:null,done:false,complete:false,readyForMeasure:false,networkEvents:[],errors:[],validation:{}};
  const {initialPoints}=installFixture(cfg);
  const netEvent=GameSession.prototype.onNetcodeEvent;GameSession.prototype.onNetcodeEvent=function(event){if(q.startedAt!==null&&!q.complete&&['peer-interrupted','peer-resumed','peer-timeout'].includes(event.type))q.networkEvents.push({role:this.role,...event});return netEvent.call(this,event);};
  const navKeys=['routeQueries','directQueries','fieldsBuilt','fieldHits','fieldBuildMs','astarQueries','astarExpanded','astarCostMs','sharedAstarQueries','sharedAstarHits','layersBuilt','meshBuildMs','regionsBuilt','regionHits','adaptiveFlowQueries','adaptiveSharedQueries','adaptiveAstarQueries'];
  const snapshotResult=sim=>{
    const starts=new Map(initialPoints.get(sim).map(p=>[p.id,p])),alive=sim.units.filter(u=>u.alive),poses=alive.map(u=>({id:u.id,x:u.x,y:u.y,hp:u.hp,side:u.side})).sort((a,b)=>a.id.localeCompare(b.id));
    return {heightChanged:alive.filter(u=>Math.abs(sim.world.terrain.surfaces.heightAt(u.x,u.y)-starts.get(u.id).height)>.01).length,tick:sim.tick,checksum:sim.checksum(),alive:alive.length,hp:alive.reduce((s,u)=>s+u.hp,0),
      movedDistance:alive.reduce((s,u)=>s+Math.hypot(u.x-starts.get(u.id).x,u.y-starts.get(u.id).y),0)/Math.max(1,alive.length),
      navigationAdmissions:Array.isArray(sim.navigationAdmissions)?sim.navigationAdmissions.slice():[],
      remainingDistance:alive.reduce((s,u)=>s+Math.hypot(u.x-3500,u.y-2400),0)/Math.max(1,alive.length),poses,nav:{...sim.navigation.metrics}};
  };
  q.collect=()=>{for(const [role,s] of Object.entries(MatchLifecycle.singleMatch.sessions)){if(s.sim.tick!==cfg.ticks)throw Error('Timed endpoint overshot');q.end[role]=snapshotResult(s.sim);}};
  const start=GameSession.prototype.startSim;
  GameSession.prototype.startSim=function(){const t=performance.now();let r;try{r=start.call(this,20261003)}catch(error){q.startupError=String(error.stack);throw error}
    const sim=this.sim,nav=sim.navigation,layer=nav.layer(sim.unitRadius(cfg.unit)+.12),goal=nav.locate(3500,2400,layer),points=initialPoints.get(sim);
    let connected=0,directBlocked=0;
    for(const p of points){const loc=nav.locate(p.x,p.y,layer);if(loc&&goal&&loc.cell.component===goal.cell.component)connected++;if(!nav.directGoal(p.x,p.y,NavigationGoal.point(3500,2400),sim.unitRadius(cfg.unit),false))directBlocked++;}
    if(connected!==cfg.count)throw Error('Fixture has disconnected spawn');
    if(cfg.scenario==='movement'&&directBlocked!==cfg.count)throw Error('Movement fixture must actually use selected path planner');
    const layers=[...nav.layers.values()];let minimumSeparation=Infinity;for(let i=0;i<points.length;i++)for(let j=0;j<i;j++)minimumSeparation=Math.min(minimumSeparation,Math.hypot(points[i].x-points[j].x,points[i].y-points[j].y));if(cfg.formation==='clear'&&minimumSeparation<2*sim.unitRadius(cfg.unit))throw Error('Clear formation overlaps');
    q.initial[this.role]={formation:cfg.formation,minimumSeparation,unitRadius:sim.unitRadius(cfg.unit),ms:performance.now()-t,preparationMs:nav.metrics.preparationMs,tps:sim.tps,seed:sim.seed,map:sim.mapDescriptor,roster:points,stateHash:sim.checksum(),buildings:sim.buildings.map(b=>({id:b.id,type:b.type,side:b.side,x:b.x,y:b.y})),nav:{...nav.metrics},
      complexity:{terrainLayers:sim.mapDescriptor.terrain.layers.length,ramps:sim.mapDescriptor.terrain.ramps.length,goalHeight:sim.world.terrain.surfaces.heightAt(3500,2400),blockers:sim.mapDescriptor.terrain.blockers.length,cells:layer.cellCount,portals:layer.portalCount,nodes:layer.nodeCount,edges:layer.fieldNodes.filter(Boolean).reduce((s,n)=>s+n.links.length,0),connected,directBlocked,layers:layers.length}};
    return r;
  };
  const run=StrategySim.prototype.step;
  StrategySim.prototype.step=function(...args){
    const entry=Object.entries(MatchLifecycle.singleMatch?.sessions||{}).find(([,s])=>s.sim===this);
    if(!entry)return run.apply(this,args);if(q.done||this.tick>=cfg.ticks)throw Error('Timed loop advanced past endpoint');
    if(q.startedAt===null)q.startedAt=performance.now();
    const role=entry[0],before={...this.navigation.metrics},t=performance.now(),winner=run.apply(this,args),elapsed=performance.now()-t;
    q.steps.push({role,tick:this.tick,ms:elapsed,at:t-q.startedAt,alive:this.units.filter(u=>u.alive).length,hits:this.events.filter(e=>e.type==='hit').length,nav:Object.fromEntries(navKeys.map(k=>[k,(this.navigation.metrics[k]||0)-(before[k]||0)]))});
    if(this.tick===cfg.ticks)q.end[role]={tick:this.tick};
    if(Object.keys(q.end).length===2){q.done=true;q.simFinishedAt=performance.now();}
    return winner;
  };
  let last=null;function frame(){const now=performance.now();
    if(q.startedAt!==null&&!q.complete&&last!==null){const p=ActiveViewState.renderer?.perfStats;q.frames.push({interval:now-Math.max(last,q.startedAt),partial:last<q.startedAt,work:p?.frameWorkMs,drawCalls:p?.drawCalls});if(q.done){q.complete=true;q.durationMs=performance.now()-q.startedAt;}}
    last=now;requestAnimationFrame(frame);
  }requestAnimationFrame(frame);
}
async function runOne(browser,mode,count,complexity,rep){
  const cfg={...config,mode,count,complexity,rep},id=[config.scenario,complexity,count,mode,rep].join('-'),dir=path.join(config.output,id);fs.mkdirSync(dir,{recursive:true});
  const original=fs.readFileSync(path.join(root,'index.html'),'utf8');assert.equal(original.split('canAdvance:()=>!this.simEnded').length,2,'Exactly one live loop gate');const source=original.replace('canAdvance:()=>!this.simEnded','canAdvance:()=>window.__groundBench.readyForMeasure&&this.sim.tick<'+cfg.ticks+'&&!this.simEnded'),end=source.lastIndexOf('})();'),html=source.slice(0,end)+'const installFixture='+installFixture.toString()+';('+instrument.toString()+')('+JSON.stringify(cfg)+');'+source.slice(end);
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://ground-bench.local/',r=>r.fulfill({contentType:'text/html',body:html}));
  try{
    await page.goto('https://ground-bench.local/');
    await page.locator('#gameStartBtn').click();await page.locator('#advancedTestSettings summary').click();
    for(const side of ['Ally','Enemy']){await page.locator('#unitTest'+side+'Type').selectOption(config.unit);await page.locator('#unitTest'+side+'Count').fill('1');}
    await page.locator('#unitTestResearch').uncheck();await page.locator('#unitTestBtn').click();await page.locator('#singleHostBtn').click();
    await page.waitForFunction(()=>__groundBench.startupError||!document.querySelector('#gameScreen').classList.contains('hidden'),null,{timeout:60000});const startupError=await page.evaluate(()=>__groundBench.startupError);assert(!startupError,startupError);
    await page.evaluate(()=>{
      const q=__groundBench,{RangeUtil,BattlefieldProjection}=q,r=q.ActiveViewState.renderer,point=q.cfg.scenario==='movement'?{x:650,y:2400}:{x:1070,y:2500};
      r.cameraLeft=RangeUtil.clamp(r.viewX(point.x)-r.viewWorldW()/2,0,Math.max(0,r.world.width-r.viewWorldW()));
      r.cameraTop=r.clampCameraTop(BattlefieldProjection.planarY(r.viewY(point.y),r.world.terrain.surfaces.heightAt(point.x,point.y))-r.viewWorldH()/2);
    });
    await page.waitForFunction(()=>Object.keys(__groundBench.initial).length===2&&Object.values(__groundBench.MatchLifecycle.singleMatch.sessions).every(s=>s.netcodeSession.ready),null,{timeout:60000});
    await page.evaluate(()=>new Promise(resolve=>requestAnimationFrame(()=>{__groundBench.readyForMeasure=true;resolve()})));
    await page.waitForFunction(()=>__groundBench.complete,null,{timeout:config.timeoutMs});
    const result=await page.evaluate(()=>{
      const q=__groundBench;q.collect();const r=q.ActiveViewState.renderer,gl=r.gl,ext=gl.getExtension('WEBGL_debug_renderer_info');
      return {networkEvents:q.networkEvents,initial:q.initial,end:q.end,steps:q.steps,frames:q.frames,durationMs:q.durationMs,backend:r.backend,gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):gl.getParameter(gl.RENDERER),sessions:Object.values(q.MatchLifecycle.singleMatch.sessions).map(s=>({role:s.role,fatal:s.simulationFatalInfo,metrics:s.netcodeSession.metrics,status:s.netcodeSession.status}))};
    });
    result.id=id;result.config=cfg;result.errors=errors;result.frameCoverageGapMs=result.durationMs-result.frames.reduce((sum,f)=>sum+f.interval,0);assert(result.frames.every(f=>f.interval>=0),'Callback clock cannot produce negative frames');assert(Math.abs(result.frameCoverageGapMs)<5,'Frame samples cover the entire timed window including final work');
    result.fixtureHash=hash({map:result.initial.host.map,roster:result.initial.host.roster,state:result.initial.host.stateHash,tps:result.initial.host.tps});
    assert.equal(result.initial.host.stateHash,result.initial.guest.stateHash,'Peers start with same authority state');
    assert.equal(result.end.host.checksum,result.end.guest.checksum,'Same fixed tick results agree across peers');
    assert.deepEqual(result.end.host.navigationAdmissions,result.end.guest.navigationAdmissions,'Adaptive navigation admissions agree across peers');
    assert.equal(result.backend,'WebGL');assert(!/swiftshader|llvmpipe|software/i.test(result.gpu),'Native GPU required');
    assert.deepEqual(errors,[]);assert(result.sessions.every(s=>!s.fatal&&s.metrics.hashMismatches===0));
    result.summary={step:stats(result.steps.map(s=>s.ms)),firstTick:stats(result.steps.filter(s=>s.tick===1).map(s=>s.ms)),laterTicks:stats(result.steps.filter(s=>s.tick>5).map(s=>s.ms)),frame:stats(result.frames.map(f=>f.interval)),render:stats(result.frames.map(f=>f.work)),interruptions:result.networkEvents.filter(e=>e.type==='peer-interrupted').length,windowThroughput:config.ticks*1000/result.durationMs,actualTps:2*(config.ticks-1)*1000/['host','guest'].reduce((sum,role)=>{const rows=result.steps.filter(s=>s.role===role),first=rows[0],last=rows.at(-1);return sum+(last.at+last.ms-first.at-first.ms);},0),combatHits:result.steps.reduce((sum,s)=>sum+s.hits,0),
      nav:Object.fromEntries(Object.keys(result.steps[0].nav).map(k=>[k,result.steps.reduce((sum,s)=>sum+s.nav[k],0)])),heightChanged:result.end.host.heightChanged,alive:result.end.host.alive,hp:result.end.host.hp,movedDistance:result.end.host.movedDistance,checksum:result.end.host.checksum,complexity:result.initial.host.complexity};
    assert.equal(result.steps.length,config.ticks*2,'Exactly same simulated work window');
    if(config.scenario==='movement'){if(result.initial.host.roster.some(p=>p.height!==0))assert(result.end.host.heightChanged>0,'Real movement changes terrain height in the measured window');assert(result.end.host.movedDistance>0,'Units actually move');assert.equal(result.end.host.alive,count);assert(result.summary.nav.routeQueries>0);if(mode==='flow-field')assert(result.summary.nav.fieldsBuilt>0);else if(mode!=='adaptive')assert.equal(result.summary.nav.fieldsBuilt,0);}
    if(config.scenario==='battle')assert(result.summary.combatHits>0,'Battle fixture must include actual combat');
    if(config.synctest){result.synctest=await page.evaluate(async()=>await __groundBench.RallySynctestDiagnostics.run(__groundBench.MatchLifecycle.singleMatch.sessions.host));assert.equal(result.synctest.status,'passed','Library Synctest validates the benchmark game state');}
    write(path.join(dir,'result.json'),result);
    if(rep===1)await page.screenshot({path:path.join(dir,'scene.png')});
    console.log(JSON.stringify({id,stepMs:result.summary.step.mean,frameP95:result.summary.frame?.p95,tps:result.summary.actualTps,alive:result.summary.alive,checksum:result.summary.checksum,nodes:result.summary.complexity.nodes}));
    return {id,config:cfg,fixtureHash:result.fixtureHash,summary:result.summary,initial:result.initial.host,gpu:result.gpu};
  }catch(error){write(path.join(dir,'failure.json'),{error:String(error.stack),errors,state:await page.evaluate(()=>({startupError:__groundBench?.startupError,initial:__groundBench?.initial,end:__groundBench?.end,steps:__groundBench?.steps?.slice(-4),sessions:Object.values(__groundBench?.MatchLifecycle.singleMatch?.sessions||{}).map(s=>({role:s.role,tick:s.sim?.tick,fatal:s.simulationFatalInfo,status:s.netcodeSession?.status}))})).catch(()=>null)});throw error;
  }finally{await page.close();}
}
(async()=>{
  fs.mkdirSync(config.output,{recursive:true});const results=[],browser=await chromium.launch({channel:'msedge',headless:true});
  const revision=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
  try{
    for(let rep=1;rep<=config.runs;rep++)for(const complexity of config.complexities)for(const count of config.counts){
      const modes=config.modes.slice((rep-1)%config.modes.length).concat(config.modes.slice(0,(rep-1)%config.modes.length));
      for(const mode of modes){
        const result=await runOne(browser,mode,count,complexity,rep),peers=results.filter(r=>r.config.count===count&&r.config.complexity===complexity);
        for(const previous of peers){assert.equal(result.fixtureHash,previous.fixtureHash,'Map/roster/state/TPS identical across all modes and repeats');if(previous.config.mode===mode||[previous.config.mode,mode].every(m=>['astar','shared-astar'].includes(m)))assert.equal(result.summary.checksum,previous.summary.checksum,'Repeated mode and plain/shared A* have identical fixed-tick result');}
        results.push(result);write(path.join(config.output,'summary.json'),{config,revision,sourceHash:hash(fs.readFileSync(path.join(root,'index.html'),'utf8')),machine:{cpus:os.cpus().map(c=>c.model),memory:os.totalmem()},browser:browser.version(),results});
      }
    }
  }finally{await browser.close();}
})().catch(e=>{console.error(e);process.exitCode=1});
