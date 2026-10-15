const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const htmlPath = path.resolve(process.argv[2] || path.join(root, '_site', 'index.html'));
const outDir = path.resolve(process.argv[3] || path.join(root, '.qa', 'render-interpolation'));
const source = fs.readFileSync(htmlPath, 'utf8');
const appUrl = process.env.QA_DIAG_URL || 'https://byh-playground.github.io/rally-frontier/';
const liveMode = process.env.QA_DIAG_LIVE === '1';
for (const [index, match] of [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
  if (!match[2].trim() || /type\s*=\s*["']application\/json/i.test(match[1])) continue;
  new vm.Script(match[2], { filename: `inline-script-${index}.js` });
}
const end = source.lastIndexOf('})();');
assert.ok(end > 0, 'Production app IIFE exists');

const observer = `
window.__motionQA={
  BUILD_META, MatchLifecycle, ActiveViewState, RenderStateStore, GLRenderer,
  StrategySim, GameSession, MapGeneration, UnitDefinition,
  cases:[], captures:[], draws:[], frames:[], startupFrames:[], longTasks:[], startupLongTasks:[], commands:[], timelineEdges:[],gpuSamples:[],gpuPending:[],gpuFrame:0,
  caseName:null, side:null, ids:null, requestedCount:null, startedAt:null,
};
MapGeneration.mapRuleSeed=()=>20261015;
const q=window.__motionQA;
const timelineValue=new WeakMap();
Object.defineProperty(GameSession.prototype,'renderTimelineChanged',{configurable:true,get(){return timelineValue.get(this)||false},set(value){
  const next=!!value,previous=timelineValue.get(this)||false;timelineValue.set(this,next);
  if(next&&!previous&&q.startedAt!==null){
    const stack=String(new Error().stack||'').split('\\n').slice(2);
    q.timelineEdges.push({at:performance.now(),role:this.role,tick:this.sim?.tick,advances:this.driverPulseAdvances,
      cause:stack.some(x=>x.includes('onBacklogDrop'))?'backlog-drop':stack.some(x=>x.includes('canAdvance'))?'cpu-budget-yield':stack.some(x=>x.includes('beforeFrame'))?'clock-gap':stack.some(x=>x.includes('rollback'))?'rollback':stack.some(x=>x.includes('reconcileNetcodePresentation'))?'reconcile':'other',
      frames:stack.filter(x=>/index\\.html|canAdvance|beforeFrame/.test(x)).slice(0,3).map(x=>x.slice(0,180))});
  }
}});
const originalCapture=RenderStateStore.prototype.capture;
RenderStateStore.prototype.capture=function(source,now,snap,stepMs){
  if(q.startedAt!==null){
    q.captures.push({at:performance.now(),tick:source.tick,sourceTimeMs:(Number(source.tick)||0)*stepMs,stepMs,snap,snapStack:snap?String(new Error().stack||'').split('\\n').slice(2,7):[],flag:source.flags?.[q.side]||null,unitCount:(source.units||[]).filter(u=>u.alive!==false&&u.side===q.side).length,
      authority:(source.units||[]).filter(u=>u.alive!==false&&u.side===q.side&&q.ids?.has(u.id)).map(u=>({id:u.id,x:u.x,y:u.y}))});
  }
  return originalCapture.call(this,source,now,snap,stepMs);
};
const originalDraw=GLRenderer.prototype.drawUnitSafely;
GLRenderer.prototype.drawUnitSafely=function(unit,options){
  if(q.startedAt!==null&&q.ids?.has(unit.id)){
    const now=this.presentationNow(),model=this.renderState.model('unit',unit.id,now),world=options?.worldPosition||this.resolveRenderWorldPosition(unit,'unit');
    const projected=this.projectRenderWorldPosition(world);
    q.draws.push({at:performance.now(),frameAt:now,id:unit.id,simTick:this.snapshot?.tick,
      authority:{x:unit.x,y:unit.y},model:model?{x:model.entity?.x,y:model.entity?.y,tick:model.tick,delta:model.delta}:null,interpolationAlpha:model&&Number.isFinite(model.tick)?model.tick-Math.floor(model.tick):null,presentationTimeMs:this.renderState.currentFrame?.timeMs,presentationNowMs:this.renderState.currentFrame?.nowMs,
      world:{x:world.x,y:world.y,z:world.z,groundY:world.groundY},screen:{x:projected.x,y:projected.y},
      camera:{left:this.cameraLeft,top:this.cameraTop},frameWorkMs:this.perfStats?.frameWorkMs,
      frameIntervalMs:this.perfStats?.frameIntervalMs});
  }
  return originalDraw.call(this,unit,options);
};
const originalLoop=GLRenderer.prototype.loop;
GLRenderer.prototype.loop=function(...args){
  const gl=this.gl;let ext=null,query=null;
  if(q.startedAt!==null&&gl&&++q.gpuFrame%4===0&&q.gpuPending.length<8){
    try{ext=gl.getExtension('EXT_disjoint_timer_query_webgl2');if(ext&&typeof gl.createQuery==='function'){query=gl.createQuery();gl.beginQuery(ext.TIME_ELAPSED_EXT,query)}}catch{query=null}
  }
  try{return originalLoop.apply(this,args)}finally{
    if(query){try{gl.endQuery(ext.TIME_ELAPSED_EXT);q.gpuPending.push({gl,ext,query,at:performance.now()})}catch{try{gl.deleteQuery(query)}catch{}}}
    for(let i=q.gpuPending.length-1;i>=0;i--){const p=q.gpuPending[i];try{
      if(!p.gl.getQueryParameter(p.query,p.gl.QUERY_RESULT_AVAILABLE))continue;
      const disjoint=p.gl.getParameter(p.ext.GPU_DISJOINT_EXT),ns=p.gl.getQueryParameter(p.query,p.gl.QUERY_RESULT);
      if(!disjoint&&Number.isFinite(ns))q.gpuSamples.push({at:p.at,ms:ns/1e6});p.gl.deleteQuery(p.query);q.gpuPending.splice(i,1);
    }catch{}}
  }
};
const originalCommand=GameSession.prototype.command;
GameSession.prototype.command=function(action,...args){
  const result=originalCommand.call(this,action,...args);
  if(q.startedAt!==null&&action?.type==='SET_FLAG')q.commands.push({at:performance.now(),role:this.role,action:{...action},accepted:result});
  return result;
};
try{new PerformanceObserver(list=>{for(const e of list.getEntries()){const row={at:e.startTime,duration:e.duration};(q.startedAt===null||e.startTime<q.startedAt?q.startupLongTasks:q.longTasks).push(row)}}).observe({type:'longtask',buffered:true})}catch{}
let last=0;function sample(){const now=performance.now(),r=ActiveViewState.renderer,session=MatchLifecycle.activeSession();
  const row={at:now,rafInterval:last?now-last:0,renderWorkMs:r?.perfStats?.frameWorkMs,renderIntervalMs:r?.perfStats?.frameIntervalMs,
    simTick:session?.sim?.tick,tps:session?.sim?.tps,driverPulseAdvances:session?.driverPulseAdvances??0,
    confirmedGameTick:session?.confirmedGameTick??0,netcodeNow:session?.netcodeNow??null,lastDriverPulseAt:session?.lastDriverPulseAt??null,hidden:document.hidden};
  if(q.startedAt!==null)q.frames.push(row);else if(q.startupFrames.length<600)q.startupFrames.push(row);
  last=now;requestAnimationFrame(sample);
}requestAnimationFrame(sample);
`;
const html = source.slice(0, end) + observer + source.slice(end);
const hash = require('node:crypto').createHash('sha256').update(source).digest('hex');
const finiteStats = values => {
  const sorted = values.filter(Number.isFinite).sort((a,b)=>a-b);
  return sorted.length ? {n:sorted.length,mean:sorted.reduce((s,x)=>s+x,0)/sorted.length,p50:sorted[Math.floor((sorted.length-1)*.5)],p95:sorted[Math.floor((sorted.length-1)*.95)],max:sorted.at(-1)} : null;
};

async function runCase(browser, role, count, trackedCount=count) {
  const name = `${role}-${trackedCount===1?'single':'cluster'}`;
  const page = await browser.newPage({viewport:{width:1280,height:800},deviceScaleFactor:1});
  const errors=[];
  page.on('pageerror',e=>errors.push(e.stack||e.message));
  page.on('console',m=>{if(m.type()==='error')errors.push(m.text())});
  page.on('dialog',d=>d.accept());
await page.route(`${appUrl}**`,async route=>{
    if(!route.request().isNavigationRequest())return route.continue();
    if(!liveMode)return route.fulfill({status:200,contentType:'text/html',body:html});
    const response=await route.fetch(),liveSource=await response.text(),liveEnd=liveSource.lastIndexOf('})();');
    assert.ok(liveEnd>0,'Live Pages app IIFE exists');
    const headers={...response.headers()};delete headers['content-length'];delete headers['content-encoding'];delete headers['transfer-encoding'];
    return route.fulfill({status:response.status(),headers,body:liveSource.slice(0,liveEnd)+observer+liveSource.slice(liveEnd)});
  });
  try {
    await page.goto(appUrl,{waitUntil:'domcontentloaded'});
    await page.screenshot({path:path.join(outDir,name+'-start.png')});
    await page.locator('#gameStartBtn').click();
    await page.locator('#advancedTestSettings summary').click();
    await page.locator('#unitTestAllyType').selectOption('swordsman');
    await page.locator('#unitTestAllyCount').fill(String(count));
    await page.locator('#unitTestEnemyType').selectOption('medic');
    await page.locator('#unitTestEnemyCount').fill('1');
    await page.locator('#unitTestResearch').uncheck();
    await page.locator('#unitTestBtn').click();
    await page.locator(role==='host'?'#singleHostBtn':'#singleGuestBtn').click();
    await page.locator('#gameScreen').waitFor({state:'visible',timeout:45000});
    await page.evaluate(()=>window.__motionQA.MatchLifecycle.singleMatch?.bot?.stop());
    await page.waitForFunction(()=>{
      const q=window.__motionQA,m=q.MatchLifecycle.singleMatch;
      return m&&Object.values(m.sessions||{}).length===2&&Object.values(m.sessions).every(s=>s.netcodeSession?.ready&&s.sim?.tick>=8);
    },null,{timeout:45000});
    await page.screenshot({path:path.join(outDir,name+'-battle-start.png')});
    await page.evaluate(count=>{window.__motionQA.requestedCount=count},trackedCount);
    const initial=await page.evaluate(()=>{
      const q=window.__motionQA,s=q.MatchLifecycle.activeSession(),r=q.ActiveViewState.renderer;
      const side=s.role==='host'?0:1,roster=s.sim.units.filter(u=>u.alive&&u.side===side&&!q.UnitDefinition.get(u.type)?.economyWorker);
      const units=roster.filter(u=>u.type==='swordsman');
      if(units.length===0)throw Error('No requested swordsman cohort spawned');
      const tracked=units.slice(0,q.requestedCount||units.length);
      q.side=side;q.ids=new Set(tracked.map(u=>u.id));
      const debugInfo=r?.gl?.getExtension('WEBGL_debug_renderer_info');
      q.initial={build:q.BUILD_META?.commit,role:s.role,tps:s.sim.tps,unitCount:roster.length,rosterTypeCount:units.length,trackedCount:tracked.length,ids:tracked.map(u=>u.id),
        roster:roster.map(u=>({id:u.id,type:u.type,x:u.x,y:u.y})),
        simTick:s.sim.tick,seed:s.sim.seed,mapSeed:s.sim.mapDescriptor?.seed,renderer:r?.backend,
        gpu:r?.gl?(debugInfo?r.gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL):r.gl.getParameter(r.gl.RENDERER)):null,
        gpuVendor:r?.gl&&debugInfo?r.gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL):null,
        gpuTimer:!!r?.gl?.getExtension('EXT_disjoint_timer_query_webgl2')};
      return q.initial;
    });
    assert.equal(initial.role,role);assert.equal(initial.tps,10);assert.equal(initial.trackedCount,trackedCount);
    await page.evaluate(name=>{window.__motionQA.caseName=name},name);
    const focus=await page.evaluate(()=>{const q=window.__motionQA,m=q.ActiveViewState.minimap,rect=m.contentRect();return{x:rect.left+rect.width*.5,y:rect.top+rect.height*.5}});
    await page.mouse.click(focus.x,focus.y);
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(outDir,name+'-before.png')});
    const target=await page.evaluate(()=>{
      const q=window.__motionQA,s=q.MatchLifecycle.activeSession(),r=q.ActiveViewState.renderer,side=s.role==='host'?0:1;
      const unit=s.sim.units.find(u=>u.alive&&u.side===side&&u.type==='swordsman'&&q.ids.has(u.id));
      if(!unit)throw Error('No live tracked swordsman for movement command');
      const x=2100,y=side===0?2200:2590,screen=r.projectRenderWorldPosition({x,y:0,z:y,groundY:0});
      if(document.elementFromPoint(screen.x,screen.y)?.id!=='glCanvas')throw Error('Short movement target is outside the battlefield canvas');
      q.startedAt=performance.now();q.movementTarget={id:unit.id,start:{x:unit.x,y:unit.y},target:{x,y}};
      return {x:screen.x,y:screen.y,world:q.movementTarget};    });
    await page.mouse.click(target.x,target.y);
    await page.waitForFunction(()=>window.__motionQA.commands.some(c=>c.accepted),null,{timeout:8000});
    const injectedStallMs=Math.min(1500,Math.max(0,Number(process.env.QA_DIAG_STALL_MS)||0));
    if(injectedStallMs>0){
      await page.waitForTimeout(250);
      await page.evaluate(ms=>{const until=performance.now()+ms;while(performance.now()<until){}},injectedStallMs);
    }
    await page.waitForTimeout(2500);
    await page.screenshot({path:path.join(outDir,name+'-moving.png')});
    await page.waitForTimeout(2500);
    await page.screenshot({path:path.join(outDir,name+'-combat.png')});
    const result=await page.evaluate(()=>{
      const finiteStats=values=>{const sorted=values.filter(Number.isFinite).sort((a,b)=>a-b);return sorted.length?{n:sorted.length,mean:sorted.reduce((s,x)=>s+x,0)/sorted.length,p50:sorted[Math.floor((sorted.length-1)*.5)],p95:sorted[Math.floor((sorted.length-1)*.95)],max:sorted.at(-1)}:null};
      const q=window.__motionQA,draws=q.draws,frames=q.frames,captures=q.captures;
      const moving=draws.filter(x=>x.model&&x.model.tick%1>.01&&x.model.tick%1<.99);
      const idRows=new Map();for(const d of draws){let rows=idRows.get(d.id);if(!rows)idRows.set(d.id,rows=[]);rows.push(d)}
      const perUnit=[...idRows].map(([id,rows])=>{
        const valid=rows.filter(x=>Number.isFinite(x.world.x)&&Number.isFinite(x.world.z)&&x.model);
        const distances=valid.slice(1).map((x,i)=>Math.hypot(x.world.x-valid[i].world.x,x.world.z-valid[i].world.z));
        const fallback=rows.filter(x=>!x.model).length;
        const nonmonotone=valid.slice(1).filter((x,i)=>x.frameAt<=valid[i].frameAt).length;
        const movedFrames=distances.filter(x=>x>.01).length;
        const tickFractions=rows.filter(x=>x.model&&Math.abs(x.model.tick-Math.round(x.model.tick))>.02&&Math.abs(x.model.tick-Math.round(x.model.tick))<.98).length;
        const endpointError=valid.map(x=>Math.hypot(x.world.x-x.model.x,x.world.z-x.model.y));
        const maxWorldStep=Math.max(0,...distances);
        const maxAuthorityDelta=Math.max(0,...valid.slice(1).map((x,i)=>Math.hypot(x.authority.x-valid[i].authority.x,x.authority.y-valid[i].authority.y)));
        return{id,samples:rows.length,movedFrames,tickFractions,drawPoseSamples:valid.length,
          maxDrawPoseError:Math.max(0,...endpointError),missingModel:fallback,nonmonotoneFrameClock:nonmonotone,maxWorldStep,maxAuthorityDelta,
          first:rows[0],last:rows.at(-1)};
      });

      const raf=frames.map(f=>f.rafInterval).filter(x=>x>0),work=frames.map(f=>f.renderWorkMs).filter(Number.isFinite),gaps50=raf.filter(x=>x>50),gaps33=raf.filter(x=>x>33.3),overBudget=work.filter(x=>x>1000/60);
      return {caseName:q.caseName,startedAt:q.startedAt,endedAt:performance.now(),commands:q.commands,initial:q.initial,
        captures,frames,startupFrames:q.startupFrames,draws,perUnit,longTasks:q.longTasks,startupLongTasks:q.startupLongTasks,timelineEdges:q.timelineEdges,gpuSamples:q.gpuSamples,
        finalState:(()=>{const s=q.MatchLifecycle.activeSession();return{flags:s.sim.flags.map(f=>f?{...f}:null),units:s.sim.units.filter(u=>q.ids.has(u.id)).map(u=>({id:u.id,alive:u.alive,x:u.x,y:u.y,target:u.target,routeIndex:u.movement?.routeIndex})),tick:s.sim.tick,stepMs:s.sim.perfStats?.lastStepMs,botEnabled:q.MatchLifecycle.singleMatch?.bot?.enabled}})(),
        summary:{captureCount:captures.length,captureTicks:captures.map(x=>x.tick),resetCaptures:captures.filter(x=>x.snap).length,
          unitCounts:[...new Set(captures.map(x=>x.unitCount))],drawCount:draws.length,unitIds:[...idRows.keys()],
          modelMissing:draws.filter(x=>!x.model).length,modelPresent:draws.filter(x=>x.model).length,interpolatedTickSamples:moving.length,
          frameInterval:finiteStats(raf),rendererWork:finiteStats(work),gpuTime:finiteStats(q.gpuSamples.map(x=>x.ms)),longTaskCount:q.longTasks.length,longTaskMs:q.longTasks.reduce((s,x)=>s+x.duration,0),
          rafGapOver33Ms:gaps33.length,rafGapOver50Ms:gaps50.length,rendererWorkOver16_7Ms:overBudget.length,maxRafGapMs:Math.max(0,...raf),
          movingDrawFrames:perUnit.reduce((s,x)=>s+x.movedFrames,0),interpolatedTickFrames:perUnit.reduce((s,x)=>s+x.tickFractions,0),maxDrawPoseError:Math.max(0,...perUnit.map(x=>x.maxDrawPoseError)),maxWorldStep:Math.max(0,...perUnit.map(x=>x.maxWorldStep)),
          gpuTimer:q.initial.gpuTimer}};
    });
    result.initial=initial;result.movementTarget=target.world;result.pageErrors=errors;result.injectedStallMs=injectedStallMs;
    fs.writeFileSync(path.join(outDir,name+'.json'),JSON.stringify(result,null,2));
    assert.deepEqual(errors,[]);
    assert.equal(result.commands.length,1,'Exactly one native GameSession flag command was accepted');
    assert.equal(result.timelineEdges.filter(e=>e.cause==='cpu-budget-yield').length,0,'CPU catchup yields must preserve interpolation history');
    if(injectedStallMs>0&&process.env.QA_DIAG_ASSERT_STALL_PRESERVED==='1'){
      assert.ok(result.summary.maxRafGapMs>=injectedStallMs*.75,'The injected main-thread stall must appear as a missed-rAF interval');
      assert.equal(result.timelineEdges.filter(e=>e.cause==='clock-gap').length,0,'A recoverable main-thread stall must preserve buffered presentation history');
      assert.equal(result.summary.resetCaptures,0,'A recoverable main-thread stall must not snap the presentation timeline');
    }
    assert.ok(result.perUnit.some(unit=>unit.movedFrames>5),'Tracked final draw coordinates must move across rendered frames');
    assert.ok(result.summary.maxDrawPoseError<0.001,'The final draw world pose must consume the interpolated model');
    await page.screenshot({path:path.join(outDir,`${name}.png`)});
    fs.writeFileSync(path.join(outDir,`${name}.json`),JSON.stringify(result,null,2));
    return result;
  } finally { await page.close(); }
}

(async()=>{
  fs.mkdirSync(outDir,{recursive:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const cases=[],only=(process.env.QA_DIAG_ONLY||'').split(',').filter(Boolean);
    for(const role of ['host','guest'])for(const [count,trackedCount] of [[24,1],[24,24]]){
      const name=`${role}-${trackedCount===1?'single':'cluster'}`;if(only.length&&!only.includes(name))continue;
      cases.push(await runCase(browser,role,count,trackedCount));
    }
    const report={sourceCommit:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceSha256:hash,
      browser:browser.version(),createdAt:new Date().toISOString(),cases:cases.map(({caseName,initial,summary,perUnit,movementTarget,timelineEdges,pageErrors})=>({caseName,initial:{role:initial.role,tps:initial.tps,unitCount:initial.unitCount,rosterTypeCount:initial.rosterTypeCount,trackedCount:initial.trackedCount},movementTarget,summary,perUnit:perUnit.map(({id,samples,movedFrames,tickFractions,maxDrawPoseError,missingModel,nonmonotoneFrameClock,maxWorldStep,maxAuthorityDelta})=>({id,samples,movedFrames,tickFractions,maxDrawPoseError,missingModel,nonmonotoneFrameClock,maxWorldStep,maxAuthorityDelta})),timelineEdges:timelineEdges.map(({tick,cause})=>({tick,cause})),pageErrors}))};
    fs.writeFileSync(path.join(outDir,'summary.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({...report,cases:report.cases.map(({caseName,initial,summary,timelineEdges,pageErrors})=>{const{captureTicks,unitCounts,unitIds,...metrics}=summary;return{caseName,initial,summary:metrics,timelineEdges,pageErrors}})},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
