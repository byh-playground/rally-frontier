const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),{inject}=require('./inject.cjs');
const root=path.resolve(__dirname,'../..'),out=path.join(root,'.qa/physics-controller-20261011/ui');
(async()=>{
  fs.mkdirSync(out,{recursive:true});const results=[];
  for(const variant of ['matter-guarded-lite','rapier-guarded-lite']){
    const html=inject(root,{variant}),browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
    try{
      const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
      await page.route('https://physics-ui.local/**',r=>r.fulfill({contentType:'text/html',body:html}));
      await page.goto('https://physics-ui.local/');await page.waitForFunction(()=>globalThis.PhysicsControllerProbe?.exposed);
      await page.locator('#gameStartBtn').click();await page.locator('#advancedTestSettings summary').click();
      await page.locator('[data-netcode-mode="lockstep"]').click();await page.locator('[data-sim-tps="10"]').click();
      await page.locator('#unitTestAllyCount').fill('10');await page.locator('#unitTestEnemyCount').fill('10');
      await page.locator('#unitTestBtn').click();await page.locator('#singleHostBtn').click();
      await page.locator('#gameScreen').waitFor({state:'visible'});
      await page.waitForFunction(()=>PhysicsControllerProbe.exposed.MatchLifecycle.activeSession()?.sim?.tick>=10);
      const point=await page.evaluate(()=>{const r=PhysicsControllerProbe.exposed.ActiveViewState.minimap.contentRect();return{x:r.left+r.width*.5,y:r.top+r.height*.5}});
      await page.mouse.click(point.x,point.y);
      const rect=await page.locator('#glCanvas').boundingBox();await page.mouse.click(rect.x+rect.width*.6,rect.y+rect.height*.3);
      await page.waitForFunction(()=>PhysicsControllerProbe.exposed.MatchLifecycle.activeSession()?.performanceStats.timings.commandConfirm?.samples>0);
      await page.waitForFunction(()=>PhysicsControllerProbe.exposed.MatchLifecycle.activeSession()?.sim?.tick>=35);
      const state=await page.evaluate(()=>{const q=PhysicsControllerProbe,s=q.exposed.MatchLifecycle.activeSession();return {tick:s.sim.tick,variant:q.records.get(s.sim).variant,backend:q.exposed.ActiveViewState.renderer.backend,
        units:s.sim.units.filter(u=>u.alive).length,commands:s.performanceStats.timings.commandConfirm,metrics:s.netcodeSession.metrics,fatal:s.simulationFatal}});
      await page.screenshot({path:path.join(out,variant+'.png')});
      assert.equal(state.variant,variant);assert.equal(state.backend,'WebGL');assert(!state.fatal);assert.equal(state.metrics.hashMismatches,0);assert.equal(state.metrics.recoveries,0);
      await page.locator('#matchMenuBtnGame').click();await page.locator('#matchMenuSurrenderBtn').click();await page.locator('#result').waitFor({state:'visible',timeout:30000});
      await page.locator('#replayWatchBtn').click();await page.locator('#replayDock').waitFor({state:'visible'});
      await page.waitForFunction(()=>{const p=PhysicsControllerProbe.exposed.ReplayPresentation.replayPlayer;return p?.sim?.tick>=p?.endTick},null,{timeout:30000});
      const replay=await page.evaluate(()=>{const p=PhysicsControllerProbe.exposed.ReplayPresentation.replayPlayer;return {tick:p.sim.tick,endTick:p.endTick,playing:p.playing,variant:PhysicsControllerProbe.records.get(p.sim).variant}});
      assert.equal(replay.variant,variant);state.replay=replay;
      assert.deepEqual(errors,[]);results.push({variant,state,pageErrors:errors});console.log(JSON.stringify(results.at(-1)));
    }finally{await browser.close()}
  }
  fs.writeFileSync(path.join(out,'result.json'),JSON.stringify(results,null,2));
})().catch(e=>{console.error(String(e.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[bundled module]'));process.exitCode=1});
