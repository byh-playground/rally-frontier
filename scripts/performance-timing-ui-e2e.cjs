const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.qa/performance-timing');
const source=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const end=source.lastIndexOf('})();');assert(end>0);
const html=source.slice(0,end)+'window.__timingQA={MatchLifecycle,PerformanceTelemetry,ActiveViewState};'+source.slice(end);
async function run(browser,{name,role,mode,viewport}){
  const page=await browser.newPage({viewport}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
  try{
    await page.route('http://timing-qa.local/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://timing-qa.local/');
    await page.locator('#gameStartBtn').click();await page.locator('#advancedTestSettings summary').click();
    await page.locator(`[data-netcode-mode="${mode}"]`).click();
    await page.locator('#unitTestAllyCount').fill('10');await page.locator('#unitTestEnemyCount').fill('10');
    await page.locator('#unitTestBtn').click();await page.locator(role==='host'?'#singleHostBtn':'#singleGuestBtn').click();
    await page.locator('#gameScreen').waitFor({state:'visible'});
    await page.waitForFunction(()=>window.__timingQA.MatchLifecycle.activeSession()?.sim?.tick>=4);
    await page.locator('#p2pHealth').click();
    await page.waitForFunction(()=>window.__timingQA.MatchLifecycle.activeSession()?.performanceStats.iceFetchedAt!==null);
    const before=await page.evaluate(()=>{
      const q=window.__timingQA,s=q.MatchLifecycle.activeSession(),r=q.ActiveViewState.renderer;
      const ids=[...document.querySelectorAll('#performanceTimingPanel b')].map(el=>el.id);
      return {ids,counts:ids.map(id=>document.querySelectorAll('#'+id).length),tick:s.sim.tick,mode:s.netcodeMode,
        timings:s.performanceStats.timings,snapshotSamples:s.sim.perfStats.snapshotSamples,backend:r.backend,
        passes:r.perfStats.passes,longTasks:q.PerformanceTelemetry.runtimeMonitor.longTasks};
    });
    assert.equal(before.backend,'WebGL');assert.equal(before.mode,mode);assert(before.ids.length>=24);
    assert(before.counts.every(n=>n===1),'Each timing has one owner in the top section');
    for(const name of ['save','pulse','pulseGap','renderTargets','snapshotUi'])assert(before.timings[name]?.samples>0,name+' is actually measured');
    assert(before.snapshotSamples>0);assert(before.passes['device-begin']);
    assert.equal(await page.evaluate(()=>Number.isFinite(window.__timingQA.MatchLifecycle.activeSession().performanceStats.iceRttMs)),true,'Real RTC supplies a numeric connection RTT');
    // A real main-thread stall must appear separately from the network sample.
    await page.evaluate(()=>{const deadline=performance.now()+350;while(performance.now()<deadline){}});
    await page.waitForFunction(n=>window.__timingQA.PerformanceTelemetry.runtimeMonitor.longTasks>n,before.longTasks);
    await page.waitForFunction(()=>window.__timingQA.PerformanceTelemetry.runtimeMonitor.timings.eventLoop?.maxMs>=50);
    await page.waitForFunction(t=>window.__timingQA.MatchLifecycle.activeSession().sim.tick>t,before.tick);
    await page.screenshot({path:path.join(out,name+'-top.png')});
    await page.locator('#dbgPerfNavigation').scrollIntoViewIfNeeded();
    await page.screenshot({path:path.join(out,name+'-details.png')});
    assert.equal(await page.locator('#performanceTimingPanel').evaluate(el=>el.scrollWidth>el.clientWidth),false,'Timing section fits the viewport');
    const downloadPromise=page.waitForEvent('download');await page.locator('#performanceTimingExportBtn').click();
    const download=await downloadPromise,file=path.join(out,name+'.json');await download.saveAs(file);
    const data=JSON.parse(fs.readFileSync(file,'utf8'));
    assert.equal(data.sessions[role].mode,mode);assert(data.sessions[role].timings.timings.pulse.samples>0);
    assert(data.mainThread.maxLongTaskMs>=300);assert(data.renderer.passes['device-begin']);
    await page.locator('#lockstepDebugCloseBtn').click();
    await page.locator('#matchMenuBtnGame').click();await page.locator('#matchMenuSurrenderBtn').click();
    await page.locator('#result').waitFor({state:'visible',timeout:20000});
    await page.waitForFunction(()=>window.__timingQA.PerformanceTelemetry.runtimeMonitor===null);
    assert.deepEqual(errors,[]);
    return {name,mode,role,timingRows:before.ids.length,backend:before.backend,pageErrors:errors};
  }catch(error){
    const state=await page.evaluate(()=>Object.fromEntries(Object.entries(window.__timingQA?.MatchLifecycle.singleMatch?.sessions||{}).map(([role,s])=>[role,{tick:s.sim?.tick,status:s.netcodeSession?.status,syncHold:s.syncHold,fatal:s.simulationFatal,fatalInfo:s.simulationFatalInfo,metrics:s.netcodeSession?.metrics}]))).catch(()=>null);
    fs.writeFileSync(path.join(out,name+'-failure.json'),JSON.stringify({error:String(error.stack),state,pageErrors:errors},null,2));
    await page.screenshot({path:path.join(out,name+'-failure.png')}).catch(()=>{});throw error;
  }finally{await page.close()}
}
(async()=>{
  fs.mkdirSync(out,{recursive:true});const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const results=[];
    for(const scenario of [{name:'desktop-lockstep',role:'host',mode:'lockstep',viewport:{width:1280,height:800}},
      {name:'mobile-rollback',role:'guest',mode:'rollback',viewport:{width:412,height:915}}])results.push(await run(browser,scenario));
    console.log(JSON.stringify(results,null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
