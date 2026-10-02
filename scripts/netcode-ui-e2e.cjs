const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { chromium: nativeChromium } = require('playwright');
const chromium = require('./netcode-qa-module.cjs').wrapChromium(nativeChromium);

// Only the observer is injected. All match, deck, command, result, and replay
// actions below enter through native production UI controls.
const htmlPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const output = path.resolve(__dirname, '..', '.qa', 'netcode-ui-e2e');
const observer = `
window.__netcodeE2E={ActiveViewState,MatchLifecycle,ReplayPresentation,UiRuntimeState,
  BuildingPresentation,BuildingDefinition,UnitDefinition,SIM_VERSION,BUILD_ID,
  observedHits:[],observedHitKeys:new Set(),
  observeCombat(){
    for(const s of Object.values(MatchLifecycle.singleMatch?.sessions||{})){
      for(const frame of s.frameOutputs.values()){
        if(frame.gameTick>s.confirmedGameTick)continue;
        frame.events.forEach((e,i)=>{
          if(e.type!=='hit'||(![0,1].includes(e.sourceSide)&&![0,1].includes(e.side)))return;
          const key=s.role+':'+frame.gameTick+':'+i;
          if(this.observedHitKeys.has(key))return;
          this.observedHitKeys.add(key);this.observedHits.push({role:s.role,tick:frame.gameTick,...e});
        });
      }
    }
    return this.observedHits;
  },
  telemetry(){
    const m=MatchLifecycle.singleMatch,b=m?.bot,r=ActiveViewState.renderer;
    return {role:ActiveViewState.role,screen:UiRuntimeState.value.screen,
      confirmedHits:this.observeCombat().length,
      sessions:Object.fromEntries(Object.entries(m?.sessions||{}).map(([role,s])=>[role,{
        tick:s.sim?.tick,confirmedTick:s.confirmedGameTick,coreTick:s.netcodeSession?.tick,
        resimulating:s.netcodeSession?.resimulating,pendingTickets:s.getPendingCommandTickets?.().length,
        fatal:s.simulationFatal,metrics:s.netcodeSession?.metrics,
        perf:{stepEwmaMs:s.sim?.perfStats?.ewmaStepMs,snapshotMs:s.sim?.perfStats?.snapshotMs},
        army:s.sim?.units?.filter(u=>u.alive&&u.side===(role==='host'?0:1)&&!UnitDefinition.get(u.type)?.economyWorker).length
      }])),
      ai:{enabled:b?.enabled,role:b?.role,lastSnapshotTick:b?.lastSnapshot?.tick,
        confirmedSnapshotTick:b?.session?.latestConfirmedSnapshot?.tick,
        stats:b?.commandExecutor?.stats,lastEconomyTick:b?.lastEconomyTick,
        lastPlannerTick:b?.lastPlannerTick,lastResponsePlan:b?.lastResponsePlan,
        lastExecutedMacro:b?.lastExecutedMacro,lastAiDecision:b?.lastAiDecision},
      renderer:{fps:r?.perfStats?.fps,frameEwmaMs:r?.perfStats?.ewmaFrameWorkMs,
        frameIntervalEwmaMs:r?.perfStats?.ewmaFrameIntervalMs}};
  },
  inspect(){
    const match=MatchLifecycle.singleMatch, renderer=ActiveViewState.renderer;
    const gl=renderer?.gl,gpuInfo=gl?.getExtension('WEBGL_debug_renderer_info');
    const cores=Object.values(match?.sessions||{}).map(s=>s.netcodeSession).filter(Boolean);
    const confirmedTick=cores.length?Math.min(...cores.map(c=>Math.min(c.tick,c.confirmedTick+1))):null;
    const sessions=Object.fromEntries(Object.entries(match?.sessions||{}).map(([role,s])=>{
      const core=s.netcodeSession, sim=s.sim, replay=core&&!core.resimulating?core.exportReplay():null;
      return [role,{role,tick:sim?.tick,tps:sim?.tps,checksum:sim?.checksum(),
        coreName:core?.constructor.name,coreTick:core?.tick,ready:core?.ready,
        confirmedGameTick:s.confirmedGameTick,resimulating:core?.resimulating,
        confirmedStateHash:core?.getStateHash(confirmedTick),
        metrics:core?.metrics,profile:core?.profile,fatal:s.simulationFatal,
        fatalInfo:s.simulationFatalInfo,simEnded:s.simEnded,result:s.matchResult,
        lastCommandTicket:s.lastCommandTicket,pending:s.getPendingCommandTickets?.(),
        replayFrames:replay?.frames?.length,replayHash:replay?.hash,
        recordedCommands:s.replayRecorder?.commands?.map(c=>({seq:c.seq,tick:c.tick,
          actor:c.actor,action:c.action?.type,netcodeSequence:c.netcodeSequence})),
        replayResult:s.replayRecorder?.result,
        units:sim?.units?.filter(u=>u.alive).map(u=>({id:u.id,side:u.side,type:u.type})),
        buildings:sim?.buildings?.filter(b=>b.alive!==false).map(b=>({id:b.id,side:b.side,
          type:b.type,produceType:b.produceType,complete:b.complete,produced:b.productionProduced})),
        balance:sim?.balanceStats,receipts:sim?.commandReceipts}];
    }));
    const transports=Object.fromEntries(Object.entries(match?.transports||{}).map(([role,t])=>
      [role,{name:t.constructor.name,open:t.isOpen(),connectionState:t.pc?.connectionState,
        lobby:t.dc?{label:t.dc.label,state:t.dc.readyState}:null,
        inputs:t.netcodeInputChannel?{label:t.netcodeInputChannel.label,state:t.netcodeInputChannel.readyState}:null,
        control:t.netcodeControlChannel?{label:t.netcodeControlChannel.label,state:t.netcodeControlChannel.readyState}:null,
        allChannels:Object.values(t).filter(v=>v instanceof RTCDataChannel).map(c=>({label:c.label,
          state:c.readyState,ordered:c.ordered,maxRetransmits:c.maxRetransmits}))}]));
    return {build:BUILD_ID,simVersion:SIM_VERSION,sdkVersion:window.RallyNetcode?.VERSION,
      sdkRevision:window.RallyNetcodeSource?.url,
      role:ActiveViewState.role,screen:UiRuntimeState.value.screen,
      renderer:{backend:renderer?.backend,tick:renderer?.snapshot?.tick,
        canvasWidth:renderer?.canvas?.width,canvasHeight:renderer?.canvas?.height,
        gpuVendor:gpuInfo?gl.getParameter(gpuInfo.UNMASKED_VENDOR_WEBGL):null,
        gpuRenderer:gpuInfo?gl.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL):null},
      humanRole:match?.humanRole,botRole:match?.botRole,
      confirmedTick,
      aiStats:match?.bot?.commandExecutor?.stats,
      combatHits:this.observeCombat(),telemetry:this.telemetry(),
      aiHistory:match?.bot?.commandExecutor?.history?.map(c=>({actor:c.actor,
        netcodeSequence:c.netcodeSequence,seq:c.seq,status:c.status,action:c.action?.type})),
      sessions,transports};
  }
};`;

function loadHTML() {
  const source = fs.readFileSync(htmlPath, 'utf8');
  for (const [i, match] of [...source.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)].entries()) {
    if (!match[2].trim() || /type\s*=\s*["']application\/json/i.test(match[1])) continue;
    new vm.Script(match[2], { filename: `inline-script-${i}.js` });
  }
  const end = source.lastIndexOf('})();');
  assert.ok(end > 0, 'Production app IIFE exists');
  return source.slice(0, end) + observer + source.slice(end);
}

async function confirmDeck(page) {
  await page.locator('#deckConfirmBtn').waitFor({ state: 'visible', timeout: 35000 });
  // Exercise the actual deck editor even when a fresh storage starter deck exists.
  await page.locator('#deckEditBtn').click();
  await page.locator('#deckBuilderClearBtn').click();
  const cards = ['swordsman', 'archer', 'kickhopper', 'tank', 'medic', 'clawhunter', 'siege', 'aegisbeetle'];
  for (const id of cards) await page.locator(`[data-deck-card-type="unit"][data-deck-card-id="${id}"]`).click();
  for (const id of ['thornTowerCard', 'sporeTowerCard']) {
    const card = page.locator(`[data-deck-card-type="defense"][data-deck-card-id="${id}"]`);
    if (await card.count()) await card.click();
  }
  if (await page.locator('.deck-builder-slot.filled').count() < 10) {
    for (let i = await page.locator('.deck-builder-slot.filled').count(); i < 10; i++) {
      await page.locator('[data-deck-card-type="defense"]:not(.selected)').first().click();
    }
  }
  assert.equal(await page.locator('.deck-builder-slot.filled').count(), 10, 'Real deck has ten cards');
  await page.locator('#deckBuilderSaveBtn').click();
  await page.waitForFunction(() => !document.querySelector('#deckConfirmBtn').disabled);
  await page.locator('#deckConfirmBtn').click();
}

async function placeProduction(page) {
  await page.locator('#militaryTreeBtn').click();
  await page.locator('#militaryT1Btn').click();
  await page.locator('[data-produce-unit="swordsman"]').click();
  const point = await page.evaluate(() => {
    const q=window.__netcodeE2E,r=q.ActiveViewState.renderer,s=q.MatchLifecycle.activeSession();
    const side=s.role==='host'?0:1,state=q.ActiveViewState.snap;
    const base=s.sim.buildings.find(b=>b.side===side&&q.BuildingDefinition.get(b.type)?.isMainBase);
    if(!base)throw Error('Actual main base is missing');
    const rect=r.canvas.getBoundingClientRect();
    for(let radius=150;radius<=650;radius+=40)for(let i=0;i<32;i++){
      const x=Math.round(base.x+Math.cos(i*Math.PI/16)*radius),y=Math.round(base.y+Math.sin(i*Math.PI/16)*radius);
      const action={type:'BUILD',building:'barracks',produceType:'swordsman',x,y};
      if(q.BuildingPresentation.buildValidation(state,side,{...action}))continue;
      const p=r.projectRenderWorldPosition({x,y:r.world.terrain.surfaces.heightAt(x,y),z:y,groundY:0});
      const cx=rect.left+(p.x+(r.frameShakeX||0))/r.canvas.width*rect.width;
      const cy=rect.top+(p.y+(r.frameShakeY||0))/r.canvas.height*rect.height;
      if(cx<rect.left+30||cx>rect.right-30||cy<rect.top+80||cy>rect.bottom-40)continue;
      if(document.elementFromPoint(cx,cy)?.id!=='glCanvas')continue;
      return {x:cx,y:cy,world:{x,y}};
    }
    throw Error('No visible valid production site for native canvas placement');
  });
  await page.mouse.click(point.x, point.y);
  await page.waitForFunction(() => {
    const q=window.__netcodeE2E,s=q.MatchLifecycle.activeSession(),side=s.role==='host'?0:1;
    return s.sim.buildings.some(b=>b.alive!==false&&b.side===side&&b.produceType==='swordsman');
  }, null, { timeout: 15000 });
  await page.locator('#buildFinishBtn').click();
  return point.world;
}

async function focusBattle(page) {
  const point = await page.evaluate(() => {
    const q=window.__netcodeE2E,r=q.ActiveViewState.renderer,m=q.ActiveViewState.minimap;
    const rect=m.contentRect();
    return {x:rect.left+rect.width*.5,y:rect.top+rect.height*.5};
  });
  await page.mouse.click(point.x, point.y);
  const target = await page.evaluate(() => {
    const r=window.__netcodeE2E.ActiveViewState.renderer,rect=r.canvas.getBoundingClientRect();
    for(const fy of [.55,.65,.45])for(const fx of [.5,.4,.6]){
      const x=rect.left+rect.width*fx,y=rect.top+rect.height*fy;
      if(document.elementFromPoint(x,y)?.id==='glCanvas')return {x,y};
    }
    throw Error('Unobstructed native flag target missing');
  });
  await page.mouse.click(target.x,target.y);
}

async function runRole(browser, html, humanRole) {
  const context=await browser.newContext({viewport:{width:412,height:915},deviceScaleFactor:1});
  const page=await context.newPage(),errors=[],consoleErrors=[];
  let progressTimer=null;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
  page.on('dialog',d=>d.accept());
  try {
    await page.route('http://netcode-qa.local/**',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://netcode-qa.local/',{waitUntil:'domcontentloaded'});
    await page.locator('#gameStartBtn').click();
    await page.locator('#selectionDeckBtn').click();
    await page.locator('#advancedTestSettings summary').click();
    await page.locator('[data-sim-tps="20"]').click();
    await page.locator('#singleBtn').click();
    await page.locator(humanRole==='host'?'#singleHostBtn':'#singleGuestBtn').click();
    await confirmDeck(page);
    await page.locator('#gameScreen').waitFor({state:'visible',timeout:35000});
    await page.waitForFunction(()=>Object.values(window.__netcodeE2E.MatchLifecycle.singleMatch?.sessions||{})
      .every(s=>s.netcodeSession?.ready&&s.sim?.tick>=4),null,{timeout:15000});
    const initial=await page.evaluate(()=>window.__netcodeE2E.inspect());
    fs.writeFileSync(path.join(output,humanRole+'-initial.json'),JSON.stringify(initial,null,2));
    assert.equal(initial.sdkVersion,'0.2.0-dev','The URL imported SDK actually runs');
    assert.equal(initial.sdkRevision,'https://byh-playground.github.io/rollback-netcode/rollback-netcode.js');
    assert.equal(initial.renderer.backend,'WebGL');
    assert.equal(initial.role,humanRole);
    assert.deepEqual(Object.keys(initial.sessions).sort(),['guest','host']);
    for(const role of ['host','guest']){
      assert.equal(initial.sessions[role].coreName,'RollbackSession');
      assert.equal(initial.sessions[role].tps,20);
      assert.equal(initial.transports[role].name,'NostrRtcTransport');
      assert.equal(initial.transports[role].connectionState,'connected');
      const channels=initial.transports[role].allChannels;
      assert.ok(channels.length>=3&&channels.every(c=>c.state==='open'),`${role}: real lobby/input/control channels open`);
      assert.ok(channels.some(c=>!c.ordered&&c.maxRetransmits===0),`${role}: unreliable input carrier open`);
      assert.ok(channels.filter(c=>c.ordered&&c.maxRetransmits===null).length>=2,`${role}: reliable lobby/control carriers open`);
    }
    const productionPoint=await placeProduction(page);
    await focusBattle(page);
    progressTimer=setInterval(async()=>{
      const telemetry=await page.evaluate(()=>window.__netcodeE2E.telemetry()).catch(()=>null);
      if(!telemetry)return;
      fs.writeFileSync(path.join(output,humanRole+'-progress.json'),JSON.stringify(telemetry,null,2));
      console.log(JSON.stringify({progress:humanRole,...telemetry}));
    },15000);
    await page.waitForFunction(()=>{
      const q=window.__netcodeE2E,match=q.MatchLifecycle.singleMatch;
      if(Object.values(match.sessions).some(s=>s.simulationFatal))throw Error('Simulation fatal in actual UI match');
      const human=match.sessions[match.humanRole],side=human.role==='host'?0:1;
      return human.sim.units.some(u=>u.alive&&u.side===side&&u.type==='swordsman')
        &&(match.bot.commandExecutor.stats.applied||0)>0
        &&human.sim.buildings.some(b=>b.alive!==false&&b.side===1-side&&b.produceType)
        &&q.observeCombat().length>0;
    },null,{timeout:Number(process.env.QA_BATTLE_TIMEOUT_MS)||180000});
    clearInterval(progressTimer);progressTimer=null;
    const battle=await page.evaluate(()=>window.__netcodeE2E.inspect());
    const combatFocus=await page.evaluate(()=>{
      const q=window.__netcodeE2E,s=q.MatchLifecycle.activeSession(),r=q.ActiveViewState.renderer,m=q.ActiveViewState.minimap;
      const side=s.role==='host'?0:1;
      const unit=s.sim.units.find(u=>u.alive&&u.side===side&&!q.UnitDefinition.get(u.type)?.economyWorker&&u.target!=null)
        ||s.sim.units.find(u=>u.alive&&u.side===side&&u.type==='swordsman');
      const rect=m.contentRect();
      return {x:rect.left+r.viewX(unit.x)/r.world.width*rect.width,
        y:rect.top+r.viewY(unit.y)/r.world.height*rect.height};
    });
    await page.mouse.click(combatFocus.x,combatFocus.y);
    await page.waitForTimeout(100);
    await page.screenshot({path:path.join(output,`${humanRole}-battle.png`)});
    assert.ok(battle.aiStats.submitted>0&&battle.aiStats.applied>0,'AI has actual accepted and applied commands');
    assert.equal(battle.sessions.host.confirmedStateHash,battle.sessions.guest.confirmedStateHash,
      'Live peers agree on an actual public SDK confirmed state hash');
    assert.ok(Number.isInteger(battle.sessions.host.confirmedStateHash));
    assert.ok(battle.aiHistory.some(c=>c.status==='applied'&&c.netcodeSequence>0&&c.seq>0),'AI receipt retains SDK identity and canonical game sequence');
    assert.ok(battle.sessions[humanRole].recordedCommands.some(c=>c.actor===humanRole&&c.action==='BUILD'));
    assert.ok(battle.sessions[humanRole].recordedCommands.some(c=>c.actor===humanRole&&c.action==='SET_FLAG'));
    await page.locator('#matchMenuBtnGame').click();
    await page.locator('#matchMenuSurrenderBtn').click();
    await page.locator('#result').waitFor({state:'visible',timeout:15000});
    await page.waitForFunction(()=>Object.values(window.__netcodeE2E.MatchLifecycle.singleMatch.sessions)
      .every(s=>s.simEnded&&s.replayRecorder?.result),null,{timeout:10000});
    const ended=await page.evaluate(()=>window.__netcodeE2E.inspect());
    await page.screenshot({path:path.join(output,`${humanRole}-result.png`)});
    assert.equal(ended.sessions[humanRole].replayResult.reason,'surrender');
    assert.equal(ended.sessions[humanRole].replayResult.winner,humanRole==='host'?'guest':'host');
    assert.equal(ended.sessions.host.replayResult.endTick,ended.sessions.guest.replayResult.endTick);
    assert.equal(ended.sessions.host.replayResult.checksum,ended.sessions.guest.replayResult.checksum);
    await page.locator('#replayWatchBtn').click();
    await page.locator('#replayDock').waitFor({state:'visible',timeout:15000});
    await page.waitForFunction(()=>window.__netcodeE2E.ReplayPresentation.replayPlayer?.sim?.tick>0);
    const moving=await page.evaluate(()=>window.__netcodeE2E.ReplayPresentation.replayPlayer.sim.tick);
    await page.waitForFunction(t=>window.__netcodeE2E.ReplayPresentation.replayPlayer.sim.tick>t,moving,{timeout:5000});
    await page.locator('#replayPlayPauseBtn').click();
    const middle=Math.floor(ended.sessions[humanRole].replayResult.endTick/40);
    await page.locator('#replayTimeInput').fill(String(middle));
    await page.locator('#replayTimeGoBtn').click();
    await page.waitForFunction(t=>window.__netcodeE2E.ReplayPresentation.replayPlayer.sim.tick===t,middle*20);
    const endSeconds=ended.sessions[humanRole].replayResult.endTick/20;
    await page.locator('#replayTimeInput').fill(String(endSeconds));
    await page.locator('#replayTimeGoBtn').click();
    const replay=await page.evaluate(()=>{
      const p=window.__netcodeE2E.ReplayPresentation.replayPlayer;
      return {tick:p.sim.tick,endTick:p.endTick,checksum:p.sim.checksum(),backend:window.__netcodeE2E.ActiveViewState.renderer.backend};
    });
    assert.equal(replay.tick,ended.sessions[humanRole].replayResult.endTick);
    assert.equal(replay.checksum,ended.sessions[humanRole].replayResult.checksum,'UI recorded replay final checksum is identical');
    await page.screenshot({path:path.join(output,`${humanRole}-replay.png`)});
    await page.locator('#replayExitBtn').click();
    await page.locator('#lobby').waitFor({state:'visible',timeout:10000});
    assert.equal(await page.evaluate(()=>!!window.__netcodeE2E.ReplayPresentation.replayPlayer),false);
    assert.deepEqual(errors,[],'No uncaught exceptions across normal match and replay');
    assert.ok(!consoleErrors.some(m=>/simulation fatal|CONTRACT_FATAL/i.test(m)),consoleErrors.join('\n'));
    const result={humanRole,initial,productionPoint,battle,ended,replay,pageErrors:errors,consoleErrors};
    fs.writeFileSync(path.join(output,humanRole+'-result.json'),JSON.stringify(result,null,2));
    return result;
  } catch(error) {
    const evidence={humanRole,error:String(error.stack),pageErrors:errors,consoleErrors,
      state:await page.evaluate(()=>window.__netcodeE2E?.inspect()).catch(()=>null)};
    fs.writeFileSync(path.join(output,`${humanRole}-failure.json`),JSON.stringify(evidence,null,2));
    await page.screenshot({path:path.join(output,`${humanRole}-failure.png`)}).catch(()=>{});
    throw error;
  } finally {if(progressTimer)clearInterval(progressTimer);await context.close();}
}

(async()=>{
  fs.mkdirSync(output,{recursive:true});
  const html=loadHTML(),browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',
    headless:process.env.QA_HEADED!=='1',args:process.env.QA_SOFTWARE_GPU==='1'
      ?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});
  try{
    const results=[];
    for(const role of (process.env.QA_ROLES||'host,guest').split(','))results.push(await runRole(browser,html,role));
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({htmlPath,results},null,2));
    console.log(JSON.stringify({htmlPath,results:results.map(r=>({humanRole:r.humanRole,
      build:r.initial.build,sdkVersion:r.initial.sdkVersion,renderer:r.initial.renderer,
      battleTick:r.battle.sessions[r.humanRole].tick,aiStats:r.battle.aiStats,
      result:r.ended.sessions[r.humanRole].replayResult,replay:r.replay,pageErrors:r.pageErrors}))},null,2));
  }finally{await browser.close();}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
