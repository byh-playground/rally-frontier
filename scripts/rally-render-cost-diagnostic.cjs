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
const fixtureUnits = Math.max(1, Math.min(400, Number(process.env.QA_DIAG_UNITS) || Number(process.argv[4]) || 24));
const fixtureSeed = Number(process.env.QA_DIAG_SEED) || 20261015;
const viewport = { width: Number(process.env.QA_DIAG_WIDTH) || Number(process.argv[6]) || 1280, height: Number(process.env.QA_DIAG_HEIGHT) || Number(process.argv[7]) || 800 };
const airSweepEnabled = process.argv[8] === '--air-sweep';
for (const [index, match] of [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
  if (!match[2].trim() || /type\s*=\s*["']application\/json/i.test(match[1])) continue;
  new vm.Script(match[2], { filename: `inline-script-${index}.js` });
}
const end = source.lastIndexOf('})();');
assert.ok(end > 0, 'Production app IIFE exists');

const observer = `
window.__motionQA={airSweepEnabled:${airSweepEnabled},
  BUILD_META, MatchLifecycle, ActiveViewState, RenderStateStore, GLRenderer,
  StrategySim, GameSession, MapGeneration, UnitDefinition,
  cases:[], captures:[], draws:[], frames:[], startupFrames:[], longTasks:[], startupLongTasks:[], commands:[], timelineEdges:[],gpuSamples:[],gpuPending:[],gpuFrame:0,
  caseName:null, side:null, ids:null, drawIds:null, requestedCount:null, startedAt:null, inputClickAt:null, profileCalls:{}, previewEvents:[], previewDraws:[],captureHoldTick:null,captureRenderRole:null,presentationHoldNow:null,captureHolds:[],massPhase:false,massFrames:[],
};
MapGeneration.mapRuleSeed=()=>20261015;
const q=window.__motionQA;
const sessionRoleForSim=sim=>Object.values(MatchLifecycle.singleMatch?.sessions||{}).find(session=>session.sim===sim)?.role||null;
q.seedRandom=seed=>{let state=seed>>>0;Math.random=()=>{state=(state+0x6D2B79F5)>>>0;let t=state;t=Math.imul(t^(t>>>15),t|1);t^=t+Math.imul(t^(t>>>7),t|61);return((t^(t>>>14))>>>0)/4294967296}};
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
  if(q.startedAt!==null||q.captureHoldTick!==null){
    q.captures.push({role:sessionRoleForSim(source),at:performance.now(),nowMs:now,tick:source.tick,sourceTimeMs:(Number(source.tick)||0)*stepMs,stepMs,snap,snapStack:snap?String(new Error().stack||'').split('\\n').slice(2,7):[],flag:source.flags?.[q.side]||null,unitCount:(source.units||[]).filter(u=>u.alive!==false&&u.side===q.side).length,
      authority:(source.units||[]).filter(u=>u.alive!==false&&u.side===q.side&&q.drawIds?.has(u.id)).map(u=>({id:u.id,x:u.x,y:u.y}))});
  }
  return originalCapture.call(this,source,now,snap,stepMs);
};
const originalApplied=GameSession.prototype.onNetcodeFrameApplied;
GameSession.prototype.onNetcodeFrameApplied=function(...args){
  const result=originalApplied.apply(this,args);
  if(q.captureHoldTick!==null&&this.sim?.tick>=q.captureHoldTick){
    q.captureHolds??=[];q.captureHolds.push({role:this.role,tick:this.sim.tick,previousSyncHold:this.syncHold});
    q.freezeHookCalls??=[];q.freezeHookCalls.push({role:this.role,wanted:q.captureRenderRole,renderer:!!q.ActiveViewState.renderer,renderState:!!q.ActiveViewState.renderer?.renderState,alreadyFixed:q.presentationHoldNow!==null});
    if(q.presentationHoldNow===null&&this.role===q.captureRenderRole){
      const r=q.ActiveViewState.renderer,last=[...q.captures].reverse().find(c=>c.role===this.role&&c.tick<=this.sim.tick);
      if(r?.renderState&&last){
        const holdNow=last.nowMs+200+(this.sim.tick-last.tick)*100;
        q.presentationHoldNow=holdNow;r._framePresentationAt=holdNow;
      }
    }
    this.syncHold=true;
  }
  return result;
};
const originalPresentationNow=GLRenderer.prototype.presentationNow;
GLRenderer.prototype.presentationNow=function(now){
  if(q.presentationHoldNow!==null)return q.presentationHoldNow;
  return originalPresentationNow.call(this,now);
};
const originalDraw=GLRenderer.prototype.drawUnitSafely;
GLRenderer.prototype.drawUnitSafely=function(unit,options){
  if(q.startedAt!==null&&q.drawIds?.has(unit.id)){
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
for(const method of ['prepareVisibleUnitFrame','prepareWorldSpriteFrame','renderWorldPass','drawUnit','drawUnitBodyComposed','drawUnitCommonBody','drawUnitStateFeedback','drawVectorUnitBody','unitVectorAssetRecord','appendVectorTerrainOccludedBody','flush']){
  const original=GLRenderer.prototype[method];if(typeof original!=='function')continue;
  GLRenderer.prototype[method]=function(...args){if(q.startedAt===null)return original.apply(this,args);const started=performance.now();try{return original.apply(this,args)}finally{const row=q.profileCalls[method]||(q.profileCalls[method]={calls:0,totalMs:0,maxMs:0});const ms=performance.now()-started;row.calls++;row.totalMs+=ms;row.maxMs=Math.max(row.maxMs,ms)}};
}
const originalPredictFlag=GLRenderer.prototype.predictFlag;
GLRenderer.prototype.predictFlag=function(...args){const value=originalPredictFlag.apply(this,args);if(q.startedAt!==null)q.previewEvents.push({at:performance.now(),x:args[0],y:args[1],forced:!!args[2]});return value};
const originalDrawFlag=GLRenderer.prototype.drawFlag;
GLRenderer.prototype.drawFlag=function(...args){const value=originalDrawFlag.apply(this,args);if(q.startedAt!==null&&this.predictedFlag)q.previewDraws.push({at:performance.now(),x:this.predictedFlag.x,y:this.predictedFlag.y,start:this.predictedFlag.start});return value};
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
try{new PerformanceObserver(list=>{for(const e of list.getEntries()){const row={at:e.startTime,duration:e.duration};(q.startedAt===null?q.startupLongTasks:q.longTasks).push(row)}}).observe({type:'longtask',buffered:true})}catch{}
let last=0;function sample(){const now=performance.now(),r=ActiveViewState.renderer,session=MatchLifecycle.activeSession();
  const row={at:now,rafInterval:last?now-last:0,renderWorkMs:r?.perfStats?.frameWorkMs,renderIntervalMs:r?.perfStats?.frameIntervalMs,
    drawCalls:r?.perfStats?.drawCalls,bufferUploadBytes:r?.perfStats?.bufferUploadBytes,cpuDepthSortMs:r?.perfStats?.cpuDepthSortMs,
    unitBodyMeshCacheHits:r?.perfStats?.unitBodyMeshCacheHits,unitBodyMeshCacheMisses:r?.perfStats?.unitBodyMeshCacheMisses,passes:r?.perfStats?.passes,
    vectorAssetDraws:r?.perfStats?.vectorAssetDraws,vectorAssetInstances:r?.perfStats?.vectorAssetInstances,vectorAssetDrawCalls:r?.perfStats?.vectorAssetDrawCalls,
    vectorTerrainOcclusionTests:r?.perfStats?.vectorTerrainOcclusionTests,vectorTerrainOcclusionRegions:r?.perfStats?.vectorTerrainOcclusionRegions,vectorTerrainOcclusionTriangles:r?.perfStats?.vectorTerrainOcclusionTriangles,
    vectorAssetGeometryBytes:r?.perfStats?.vectorAssetGeometryBytes,vectorAssetInstanceBytes:r?.perfStats?.vectorAssetInstanceBytes,vectorAssetRetainedBytes:r?.perfStats?.vectorAssetRetainedBytes,vectorAssetMeshes:r?.perfStats?.vectorAssetMeshes,
    simTick:session?.sim?.tick,tps:session?.sim?.tps,driverPulseAdvances:session?.driverPulseAdvances??0,
    confirmedGameTick:session?.confirmedGameTick??0,netcodeNow:session?.netcodeNow??null,lastDriverPulseAt:session?.lastDriverPulseAt??null,hidden:document.hidden};
  if(q.startedAt!==null)q.frames.push(row);else if(q.startupFrames.length<600)q.startupFrames.push(row);
  if(q.massPhase)q.massFrames.push(row);
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
  const page = await browser.newPage({viewport,deviceScaleFactor:1});
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
    await page.evaluate(seed=>{
      window.__motionQA.seedRandom(seed);
      Date.now=()=>1700000000000+seed;
    },fixtureSeed);
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
    await page.evaluate(role=>{const q=window.__motionQA;q.captureRenderRole=role;q.captureHoldTick=24},role);
    await page.waitForFunction(()=>{
      const q=window.__motionQA,m=q.MatchLifecycle.singleMatch,sessions=Object.values(m?.sessions||{});
      return sessions.length===2&&sessions.every(s=>s.syncHold&&s.sim?.tick===24);
    },null,{timeout:15000});
    if(count>60){
      const massFixture=await page.evaluate(({role,count})=>{
        const q=window.__motionQA,s=q.MatchLifecycle.activeSession(),sim=s.sim,side=role==='host'?0:1,r=q.ActiveViewState.renderer;
        const originalUnits=sim.units.slice(),originalSeq=sim.seq,own=sim.units.filter(u=>u.alive&&u.side===side&&u.type==='swordsman');
        const center=r.projectedCoordinatesAtScreen(r.canvas.width/2,r.canvas.height/2),anchor={x:r.viewX(center.x),y:r.viewY(center.y)};
        for(let i=own.length;i<count;i++){
          const col=i%20,row=Math.floor(i/20);
          const spacing=Math.max(28,sim.unitRadius('swordsman')*2+8),x=anchor.x+(col-9.5)*spacing,y=anchor.y+(row-9.5)*spacing;
          sim.spawnUnit(side,'swordsman',x,y);
        }
        const tracked=sim.units.filter(u=>u.alive&&u.side===side&&u.type==='swordsman');
        for(let i=0;i<tracked.length;i++){const u=tracked[i];u.x=anchor.x+(i%20-9.5)*18;u.y=anchor.y+(Math.floor(i/20)-9.5)*18;u.fx=u.x;u.fy=u.y}
        q.side=side;q.ids=new Set(tracked.map(u=>u.id));q.drawIds=new Set(tracked.slice(0,24).map(u=>u.id));q.requestedCount=tracked.length;
        q.startedAt=performance.now();q.massPhase=true;q.massFrames=[];
        q.massBackup={session:s,sim,originalUnits,originalSeq,originalRenderTargets:s.onRenderTargets,side,originalTracked:own.map(u=>u.id)};
        s.emitRenderTargets(sim,true);
        // Netcode holds may keep publishing bookkeeping snapshots at tick 24.
        // Freeze this renderer's target callback after its one 400-unit reset so
        // the presentation buffer can retain the complete stress fixture.
        s.onRenderTargets=()=>{};
        const last=[...q.captures].reverse().find(c=>c.tick===sim.tick);
        if(r?.renderState&&last){q.presentationHoldNow=last.nowMs+200;r._framePresentationAt=q.presentationHoldNow}
        return{count:tracked.length,unitCount:sim.units.filter(u=>u.alive&&u.side===side&&!q.UnitDefinition.get(u.type)?.economyWorker).length,tick:sim.tick,side,trackedForInterpolation:q.drawIds.size,anchor};
      },{role,count});
      assert.equal(massFixture.count,count,'QA fixture must render exactly the requested troop count');
      assert.equal(massFixture.tick,24);
      await page.waitForTimeout(1000);
      const massVisibility=await page.evaluate(()=>{
        const q=window.__motionQA,r=q.ActiveViewState.renderer,units=r.prepareVisibleUnitFrame(),world=r.prepareWorldSpriteFrame(units);
        const displayed=r.renderState.displayed('unit',q.presentationHoldNow);
        return{renderStateUnits:r.renderState.displayed('unit',q.presentationHoldNow).length,visibleUnits:units.length,worldSpriteUnits:world.filter(x=>x.kind==='unit').length,
          snapshotUnits:r.snapshot?.units?.length,vectorUnits:typeof r.shouldUseVectorUnitArt==='function'?units.filter(u=>r.shouldUseVectorUnitArt(u)).length:null,role:r.role,mySide:r.mySide(),
          samples:displayed.slice(0,3).map(u=>({id:u.id,alive:u.alive,side:u.side,type:u.type,x:u.x,y:u.y,active:r.presentationEntityActive('unit',u.id),screen:r.projectEntityScreen(u,'unit')})),
          camera:{left:r.cameraLeft,top:r.cameraTop,canvas:[r.canvas.width,r.canvas.height]}};
      });
      assert.equal(massVisibility.visibleUnits,count,`The 400-unit fixture must reach the renderer visible-unit list: ${JSON.stringify(massVisibility)}`);
      if(massVisibility.vectorUnits!==null)assert.equal(massVisibility.vectorUnits,count,`All stress units must use the vector renderer: ${JSON.stringify(massVisibility)}`);
      assert.equal(massVisibility.worldSpriteUnits,count,`All stress units must reach the world-sprite painter: ${JSON.stringify(massVisibility)}`);
      await page.evaluate(massVisibility=>{window.__motionQA.massVisibility=massVisibility},massVisibility);
      await page.evaluate(()=>{window.__motionQA.massPhase=false});
    }
    const battleSnapshot=await page.evaluate(()=>{
      const q=window.__motionQA,s=q.MatchLifecycle.activeSession(),r=q.ActiveViewState.renderer;
      if(q.presentationHoldNow===null)throw Error('The display clock did not freeze at the requested simulation tick');
      if(q.airSweepEnabled){
        q.battleTimeBackup={renderState:r.renderState,presentationHoldNow:q.presentationHoldNow};
        const fixed=new q.RenderStateStore(r.renderState.definitions);fixed.capture(s.sim,2600,true,r.renderState.stepMs);r.renderState=fixed;
        q.presentationHoldNow=2800;r._framePresentationAt=2800;
        const frame=fixed.frame(2800);
        return q.battleSnapshot={tick:s.sim.tick,displayTimeMs:frame?.timeMs??null,nowMs:frame?.nowMs??null,holds:q.captureHolds};
      }
      let holdNow=q.presentationHoldNow,frame=r.renderState.frame(holdNow);
      for(let i=0;i<5&&frame&&Math.abs(frame.timeMs-2400)>.05;i++){holdNow+=2400-frame.timeMs;frame=r.renderState.frame(holdNow)}
      q.presentationHoldNow=holdNow;r._framePresentationAt=holdNow;
      return q.battleSnapshot={tick:s.sim.tick,displayTimeMs:frame?.timeMs??null,nowMs:frame?.nowMs??null,holds:q.captureHolds};
    });
    assert.equal(battleSnapshot.tick,24,'Host and guest simulations must be held at the same tick');
    assert.equal(battleSnapshot.displayTimeMs,2400,'Battlefield screenshot must use the fixed 24th-tick display time');
    const airSweep=airSweepEnabled?await page.evaluate(()=>{
      const q=window.__motionQA,s=window.__motionQA.MatchLifecycle.activeSession(),r=window.__motionQA.ActiveViewState.renderer;
      const side=s.role==='host'?0:1,types=Object.keys(q.UnitDefinition.all||{}).filter(type=>q.UnitDefinition.get(type)?.layer==='AIR').sort();
      const rect=r.canvas.getBoundingClientRect(),cols=4,spacingX=Math.min(148,rect.width/(cols+1)),spacingY=Math.min(78,rect.height/5),
        startX=rect.left+rect.width/2-spacingX*(cols-1)/2,startY=rect.top+rect.height*.68-spacingY*1.5;
      q.airSweepBackup={session:s,sim:s.sim,originalUnits:s.sim.units.slice(),originalSeq:s.sim.seq};
      const units=[];
      for(let i=0;i<types.length;i++){
        const type=types[i],screen=type==='dragon'?{x:rect.left+rect.width*.54,y:rect.top+155}:{x:startX+(i%cols)*spacingX,y:startY+Math.floor(i/cols)*spacingY},world=r.pxToWorld(screen.x,screen.y),unit=s.sim.spawnUnit(side,type,world[0],world[1]);
        unit.hitFlash=i%4>=2?5:0;unit.attackFlash=i%4%2===1?5:0;
        if(type==='dragon')unit.objectiveBreathPhase='tell';
        units.push({id:unit.id,type,screen,world:{x:unit.x,y:unit.y},usesVector:typeof r.shouldUseVectorUnitArt==='function'&&r.shouldUseVectorUnitArt(unit),
          visual:{side:unit.side,mySide:r.mySide(),own:unit.side===r.mySide(),cloaked:r.snapshotStealthed(unit),relation:r.factionRelation(unit.side),radius:r.unitRenderRadius(unit),world:r.resolveRenderWorldPosition(unit,'unit')}});
      }
      s.emitRenderTargets(s.sim,true);
      const fixed=new q.RenderStateStore(r.renderState.definitions);fixed.capture(s.sim,2600,true,r.renderState.stepMs);r.renderState=fixed;
      const holdNow=2800,frame=fixed.frame(holdNow);q.presentationHoldNow=holdNow;r._framePresentationAt=holdNow;
      q.airSweep={role:s.role,side,tick:s.sim.tick,displayTimeMs:frame?.timeMs??null,vectorAssetCount:Object.keys(window.RallyVectorAssets||{}).length,units};
      q.savedPerformanceNow=performance.now.bind(performance);
      Object.defineProperty(performance,'now',{configurable:true,value:()=>q.presentationHoldNow});
      return q.airSweep;
    }):null;
    if(airSweep){assert.equal(airSweep.units.length,13,'AIR visual sweep must instantiate all 13 AIR unit types');assert.equal(airSweep.displayTimeMs,2400,'AIR snapshot must use the fixed 24th-tick display time');assert.ok(airSweep.units.every(unit=>unit.usesVector===(airSweep.vectorAssetCount>0)),'AIR test units must consistently use the compiled vector renderer when assets are present')}
    if(airSweep)await page.waitForTimeout(250);
    await page.screenshot({path:path.join(outDir,airSweep?`${name}-air-sweep.png`:name+'-battlefield-start.png')});
    await page.locator('#glCanvas').screenshot({path:path.join(outDir,name+'-battlefield-start.png')});
    if(airSweep)await page.evaluate(()=>{const q=window.__motionQA;if(q.savedPerformanceNow){Object.defineProperty(performance,'now',{configurable:true,value:q.savedPerformanceNow});delete q.savedPerformanceNow}});
    if(airSweep)await page.evaluate(()=>{const q=window.__motionQA,b=q.airSweepBackup,r=q.ActiveViewState.renderer;if(!b)return;b.sim.units=b.originalUnits;b.sim.seq=b.originalSeq;b.sim.rebuildRuntimeIndexes();
      if(q.battleTimeBackup){r.renderState=q.battleTimeBackup.renderState;q.presentationHoldNow=q.battleTimeBackup.presentationHoldNow;r._framePresentationAt=q.presentationHoldNow;q.battleTimeBackup=null}
      b.session.emitRenderTargets(b.sim,true);q.airSweepBackup=null});
    await page.evaluate(snapshot=>{window.__motionQA.battleSnapshot=snapshot},battleSnapshot);
    await page.screenshot({path:path.join(outDir,name+'-battle-start.png')});
    await page.evaluate(count=>{window.__motionQA.requestedCount=count},trackedCount);
    const initial=await page.evaluate(()=>{
      const q=window.__motionQA,s=q.MatchLifecycle.activeSession(),r=q.ActiveViewState.renderer;
      const side=s.role==='host'?0:1,roster=s.sim.units.filter(u=>u.alive&&u.side===side&&!q.UnitDefinition.get(u.type)?.economyWorker);
      const units=roster.filter(u=>u.type==='swordsman');
      if(units.length===0)throw Error('No requested swordsman cohort spawned');
      const tracked=units.slice(0,q.requestedCount||units.length);
      q.side=side;q.ids=new Set(tracked.map(u=>u.id));q.drawIds=q.requestedCount>60?new Set(tracked.slice(0,24).map(u=>u.id)):q.ids;
      const debugInfo=r?.gl?.getExtension('WEBGL_debug_renderer_info');
      const unitTypes=Object.keys(q.UnitDefinition.all||{}),groundTypes=unitTypes.filter(type=>q.UnitDefinition.get(type)?.layer!=='AIR');
      q.initial={build:q.BUILD_META?.commit,role:s.role,tps:s.sim.tps,unitCount:roster.length,rosterTypeCount:units.length,trackedCount:tracked.length,ids:tracked.map(u=>u.id),
        roster:roster.map(u=>({id:u.id,type:u.type,x:u.x,y:u.y})),
        simTick:s.sim.tick,seed:s.sim.seed,mapSeed:s.sim.mapDescriptor?.seed,renderer:r?.backend,vectorAssetCount:Object.keys(window.RallyVectorAssets||{}).length,
        vectorUnitCoverage:{ground:groundTypes.length,withAssets:groundTypes.filter(type=>window.RallyVectorAssets?.[type]).length,missing:groundTypes.filter(type=>!window.RallyVectorAssets?.[type]),air:unitTypes.filter(type=>q.UnitDefinition.get(type)?.layer==='AIR')},
        vectorCacheSize:r?.vectorUnitAssetCache?.size||0,vectorMesh:r?.vectorMeshRenderer?.stats?.()||null,
        screenshot:window.__motionQA.battleSnapshot,vectorClipTimeMs:0,viewport:{width:innerWidth,height:innerHeight,dpr:devicePixelRatio,canvasWidth:r?.canvas?.width,canvasHeight:r?.canvas?.height},
        terrain:(()=>{const a=s.sim.world.terrain.surfaces,bounds=points=>{const xs=points.map(p=>Array.isArray(p)?p[0]:p.x),ys=points.map(p=>Array.isArray(p)?p[1]:(p.z??p.y));return{minX:Math.min(...xs),maxX:Math.max(...xs),minY:Math.min(...ys),maxY:Math.max(...ys)}};return{world:{width:s.sim.world.width,height:s.sim.world.height},bridges:(a.bridges||[]).map(b=>({id:b.id,elevation:b.elevation,points:b.points,bounds:bounds(b.points)})),cliffs:a.renderSurfaceMesh.filter(p=>p.kind==="cliff").map(p=>({id:p.id,kind:p.kind,bounds:bounds(p.vertices)}))}})(),
        gpu:r?.gl?(debugInfo?r.gl.getParameter(debugInfo.UNMASKED_RENDERER_WEBGL):r.gl.getParameter(r.gl.RENDERER)):null,
        gpuVendor:r?.gl&&debugInfo?r.gl.getParameter(debugInfo.UNMASKED_VENDOR_WEBGL):null,
        gpuTimer:!!r?.gl?.getExtension('EXT_disjoint_timer_query_webgl2'),massVisibility:q.massVisibility||null};
      return q.initial;
    });
    assert.equal(initial.role,role);assert.equal(initial.tps,10);assert.equal(initial.trackedCount,trackedCount);
    if(count>60)assert.equal(initial.rosterTypeCount,count,'The active player must have exactly 400 swordsmen in the stress fixture');
    await page.evaluate(name=>{window.__motionQA.caseName=name},name);
    if(count>60)await page.evaluate(()=>{
      const q=window.__motionQA,b=q.massBackup,s=b.session;b.sim.units=b.originalUnits;b.sim.seq=b.originalSeq;b.sim.rebuildRuntimeIndexes();s.onRenderTargets=b.originalRenderTargets;
      q.ids=new Set(b.originalTracked);q.drawIds=new Set(b.originalTracked.slice(0,24));s.emitRenderTargets(b.sim,true);q.massBackup=null;
    });
    const focus=await page.evaluate(()=>{const q=window.__motionQA,s=q.MatchLifecycle.activeSession(),m=q.ActiveViewState.minimap,rect=m.contentRect();
      if(q.requestedCount>60){const u=s.sim.units.find(unit=>unit.alive&&unit.side===q.side&&unit.type==='swordsman'&&q.ids.has(unit.id));if(u){const p=m.point(u.x,u.y);return{x:rect.left+p[0]/m.canvas.width*rect.width,y:rect.top+p[1]/m.canvas.height*rect.height}}}
      return{x:rect.left+rect.width*.5,y:rect.top+rect.height*.5}});
    await page.mouse.click(focus.x,focus.y);
    await page.waitForTimeout(300);
    await page.screenshot({path:path.join(outDir,name+'-before.png')});
    const target=await page.evaluate(()=>{
      const q=window.__motionQA,s=q.MatchLifecycle.activeSession(),r=q.ActiveViewState.renderer,side=s.role==='host'?0:1;
      const unit=s.sim.units.find(u=>u.alive&&u.side===side&&u.type==='swordsman'&&q.ids.has(u.id));
      if(!unit)throw Error('No live tracked swordsman for movement command');
      const rect=r.canvas.getBoundingClientRect(),center={x:rect.left+rect.width*.5,y:rect.top+rect.height*.5};
      const visibleUnits=r.prepareVisibleUnitFrame(),visible=visibleUnits.find(u=>q.ids.has(u.id))||visibleUnits.find(u=>u.type==='swordsman'&&u.side===side)||visibleUnits.find(u=>u.side===side);
      if(!visible)throw Error(`No friendly unit is visible for the movement command; ${JSON.stringify(visibleUnits.map(u=>({id:u.id,type:u.type,side:u.side})))}`);
      q.ids.add(visible.id);q.drawIds.add(visible.id);
      const pose=r.projectEntityScreen(visible,'unit'),poseClient={x:rect.left+pose.x/r.canvas.width*rect.width,y:rect.top+pose.y/r.canvas.height*rect.height};
      const screen={x:poseClient.x+(center.x-poseClient.x)*.45,y:poseClient.y+(center.y-poseClient.y)*.45},[x,y]=r.pxToWorld(screen.x,screen.y);
      if(document.elementFromPoint(screen.x,screen.y)?.id!=='glCanvas')throw Error('Short movement target is outside the battlefield canvas');
      q.startedAt=performance.now();q.inputClickAt=q.startedAt;q.movementTarget={id:unit.id,start:{x:unit.x,y:unit.y},target:{x,y}};
      return {x:screen.x,y:screen.y,world:q.movementTarget};    });
    await page.evaluate(()=>{
      const q=window.__motionQA,m=q.MatchLifecycle.singleMatch;
      q.presentationHoldNow=null;
      for(const hold of q.captureHolds||[]){const s=Object.values(m?.sessions||{}).find(x=>x.role===hold.role);if(s)s.syncHold=hold.previousSyncHold}
      q.captureHolds=[];q.captureHoldTick=null;
    });
    await page.evaluate(()=>{window.__motionQA.inputClickAt=performance.now()});
    await page.mouse.click(target.x,target.y);
    await page.waitForFunction(()=>window.__motionQA.commands.some(c=>c.accepted),null,{timeout:8000});
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
      const preview=q.previewEvents.find(event=>event.at>=q.inputClickAt);
      const previewDraw=preview&&q.previewDraws.find(draw=>draw.at>=preview.at&&Math.hypot(draw.x-preview.x,draw.y-preview.y)<.01);
      const previewResponseMs=previewDraw?previewDraw.at-q.inputClickAt:null;
      return {caseName:q.caseName,startedAt:q.startedAt,endedAt:performance.now(),commands:q.commands,initial:q.initial,airSweep:q.airSweep||null,profileCalls:q.profileCalls,previewEvents:q.previewEvents,previewDraws:q.previewDraws,previewResponseMs,massFrames:q.massFrames,
        captures,frames,startupFrames:q.startupFrames,draws,perUnit,longTasks:q.longTasks,startupLongTasks:q.startupLongTasks,timelineEdges:q.timelineEdges,gpuSamples:q.gpuSamples,
        finalState:(()=>{const s=q.MatchLifecycle.activeSession();return{flags:s.sim.flags.map(f=>f?{...f}:null),units:s.sim.units.filter(u=>q.ids.has(u.id)).map(u=>({id:u.id,alive:u.alive,x:u.x,y:u.y,target:u.target,routeIndex:u.movement?.routeIndex})),tick:s.sim.tick,stepMs:s.sim.perfStats?.lastStepMs,botEnabled:q.MatchLifecycle.singleMatch?.bot?.enabled}})(),
        summary:{captureCount:captures.length,captureTicks:captures.map(x=>x.tick),resetCaptures:captures.filter(x=>x.snap).length,
          unitCounts:[...new Set(captures.map(x=>x.unitCount))],drawCount:draws.length,unitIds:[...idRows.keys()],
          modelMissing:draws.filter(x=>!x.model).length,modelPresent:draws.filter(x=>x.model).length,interpolatedTickSamples:moving.length,
          frameInterval:finiteStats(raf),rendererWork:finiteStats(work),gpuTime:finiteStats(q.gpuSamples.map(x=>x.ms)),longTaskCount:q.longTasks.length,longTaskMs:q.longTasks.reduce((s,x)=>s+x.duration,0),
          rafGapOver33Ms:gaps33.length,rafGapOver50Ms:gaps50.length,rendererWorkOver16_7Ms:overBudget.length,maxRafGapMs:Math.max(0,...raf),
          movingDrawFrames:perUnit.reduce((s,x)=>s+x.movedFrames,0),interpolatedTickFrames:perUnit.reduce((s,x)=>s+x.tickFractions,0),maxDrawPoseError:Math.max(0,...perUnit.map(x=>x.maxDrawPoseError)),maxWorldStep:Math.max(0,...perUnit.map(x=>x.maxWorldStep)),
          massRenderWork:finiteStats(q.massFrames.map(f=>f.renderWorkMs).filter(Number.isFinite)),massFrameCount:q.massFrames.length,massVectorDraws:q.massFrames.reduce((s,f)=>s+(f.vectorAssetDraws||0),0),
          gpuTimer:q.initial.gpuTimer}};
    });
    result.initial=initial;result.movementTarget=target.world;result.pageErrors=errors;
    fs.writeFileSync(path.join(outDir,name+'.json'),JSON.stringify(result,null,2));
    assert.deepEqual(errors,[]);
    assert.equal(result.commands.length,1,'Exactly one native GameSession flag command was accepted');
    assert.equal(result.timelineEdges.filter(e=>e.cause==='cpu-budget-yield').length,0,'CPU catchup yields must preserve interpolation history');
    if(count<=60){
      assert.ok(result.perUnit.some(unit=>unit.movedFrames>5),'Tracked final draw coordinates must move across rendered frames');
      assert.ok(result.summary.maxDrawPoseError<0.001,'The final draw world pose must consume the interpolated model');
      if(!airSweepEnabled)assert.ok(result.previewResponseMs!==null&&result.previewResponseMs<100,'Local predicted flag must render within 100ms of the input click');
    }
    await page.screenshot({path:path.join(outDir,`${name}.png`)});
    fs.writeFileSync(path.join(outDir,`${name}.json`),JSON.stringify(result,null,2));
    return result;
  } finally { await page.close(); }
}

(async()=>{
  fs.mkdirSync(outDir,{recursive:true});
  const browser=await chromium.launch({channel:'msedge',headless:true});
  try {
    const cases=[],only=(process.env.QA_DIAG_ONLY||process.argv[5]||'').split(',').filter(Boolean);
    for(const role of ['host','guest'])for(const [count,trackedCount] of [[fixtureUnits,1],[fixtureUnits,fixtureUnits]]){
      const name=`${role}-${trackedCount===1?'single':'cluster'}`;if(only.length&&!only.includes(name))continue;
      cases.push(await runCase(browser,role,count,trackedCount));
    }
    const report={sourceCommit:require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceSha256:hash,
      browser:browser.version(),viewport,createdAt:new Date().toISOString(),cases:cases.map(({caseName,initial,summary,perUnit,movementTarget,airSweep,timelineEdges,pageErrors})=>({caseName,initial:{role:initial.role,tps:initial.tps,unitCount:initial.unitCount,rosterTypeCount:initial.rosterTypeCount,trackedCount:initial.trackedCount,vectorAssetCount:initial.vectorAssetCount,vectorUnitCoverage:initial.vectorUnitCoverage,vectorCacheSize:initial.vectorCacheSize,screenshot:initial.screenshot,vectorClipTimeMs:initial.vectorClipTimeMs,viewport:initial.viewport,seed:initial.seed,mapSeed:initial.mapSeed,simTick:initial.simTick},movementTarget,airSweep,summary,perUnit:perUnit.map(({id,samples,movedFrames,tickFractions,maxDrawPoseError,missingModel,nonmonotoneFrameClock,maxWorldStep,maxAuthorityDelta})=>({id,samples,movedFrames,tickFractions,maxDrawPoseError,missingModel,nonmonotoneFrameClock,maxWorldStep,maxAuthorityDelta})),timelineEdges:timelineEdges.map(({tick,cause})=>({tick,cause})),pageErrors}))};
    fs.writeFileSync(path.join(outDir,'summary.json'),JSON.stringify(report,null,2));
    console.log(JSON.stringify({...report,cases:report.cases.map(({caseName,initial,summary,airSweep,timelineEdges,pageErrors})=>{const{captureTicks,unitCounts,unitIds,...metrics}=summary;return{caseName,initial,airSweep,summary:metrics,timelineEdges,pageErrors}})},null,2));
  } finally { await browser.close(); }
})().catch(error=>{console.error(error.stack||error);process.exitCode=1});
