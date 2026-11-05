const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

// Only the observer is injected. All match, command, result, and replay
// actions below enter through native production UI controls.
const htmlPath = path.resolve(process.argv[2] || path.join(__dirname, '..', 'index.html'));
const selectedMode=process.env.QA_NETCODE_MODE||'lockstep';
assert(['lockstep','rollback'].includes(selectedMode),'Supported UI netcode mode');
const pinnedSdkVersion=require('./setup-gamekit.cjs').readGamekit(path.resolve(__dirname,'..')).modules.rollback.toString('utf8').match(/\b(?:var|const)\s+VERSION\s*=\s*["']([^"']+)["']/)?.[1];
assert(pinnedSdkVersion,'Pinned rollback module declares its version');
const output = path.resolve(__dirname, '..', '.qa', 'netcode-ui-e2e-'+selectedMode);
// This run inspects both peers in the page, so the AI keeps the in-page real WebRTC
// session; scripts/sim-worker-e2e.cjs covers the Worker-hosted AI path.
const observer = `
CONFIG.single.botWorker=false;
window.__netcodeE2E={ActiveViewState,MatchLifecycle,ReplayPresentation,UiRuntimeState,
  BuildingDefinition,UnitDefinition,BUILD_META,PRODUCT_VERSION,
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
        army:s.sim?.units?.filter(u=>u.alive&&u.side===(role==='host'?0:1)).length
      }])),
      ai:{enabled:b?.enabled,role:b?.role,lastLaunchTick:b?.lastLaunchTick,
        confirmedSnapshotTick:b?.session?.latestConfirmedSnapshot?.tick,pending:b?.commandExecutor?.pending.length},
      renderer:{fps:r?.perfStats?.fps,frameEwmaMs:r?.perfStats?.ewmaFrameWorkMs,
        frameIntervalEwmaMs:r?.perfStats?.ewmaFrameIntervalMs}};
  },
  inspect(){
    const match=MatchLifecycle.singleMatch, renderer=ActiveViewState.renderer;
    const gl=renderer?.gl,gpuInfo=gl?.getExtension('WEBGL_debug_renderer_info');
    const cores=Object.values(match?.sessions||{}).map(s=>s.netcodeSession).filter(Boolean);
    const confirmedTick=cores.length?Math.min(...cores.map(c=>Math.min(c.tick,c.confirmedTick+1))):null;
    const stateHashTick=cores[0]?.profile.mode==='lockstep'?Math.floor(confirmedTick/cores[0].profile.checksumInterval)*cores[0].profile.checksumInterval:confirmedTick;
    const sessions=Object.fromEntries(Object.entries(match?.sessions||{}).map(([role,s])=>{
      const core=s.netcodeSession, sim=s.sim, replay=core&&!core.resimulating?core.exportReplay():null;
      return [role,{role,tick:sim?.tick,tps:sim?.tps,checksum:sim?.checksum(),
        coreName:core?.constructor.name,coreTick:core?.tick,ready:core?.ready,
        confirmedGameTick:s.confirmedGameTick,resimulating:core?.resimulating,
        confirmedStateHash:core?.getStateHash(stateHashTick),stateHashTick,
        metrics:core?.metrics,profile:core?.profile,fatal:s.simulationFatal,
        fatalInfo:s.simulationFatalInfo,simEnded:s.simEnded,result:s.matchResult,
        lastCommandTicket:s.lastCommandTicket,pending:s.getPendingCommandTickets?.(),
        replayFrames:replay?.frames?.length,replayHash:replay?.hash,
        recordedCommands:s.replayRecorder?.commands?.map(c=>({seq:c.seq,tick:c.tick,
          actor:c.actor,action:c.action?.type,netcodeSequence:c.netcodeSequence})),
        replayResult:s.replayRecorder?.result,
        units:sim?.units?.filter(u=>u.alive).map(u=>({id:u.id,side:u.side,type:u.type})),
        buildings:sim?.buildings?.filter(b=>b.alive!==false).map(b=>({id:b.id,side:b.side,
          type:b.type})),
        balance:sim?.balanceStats,receipts:sim?.commandReceipts}];
    }));
    const transports=Object.fromEntries(Object.entries(match?.transports||{}).map(([role,t])=>
      [role,{name:t.constructor.name,open:t.isOpen(),roomState:t.room?.state,netcodeState:t.netcodeState,generation:t.room?.generation,
        rtcConnectionState:t.room?.peerConnection?.connectionState}]));
    const aiReceipts=(match?.sessions?.[match?.humanRole]?.sim?.commandReceipts||[]).filter(c=>c.actor===match?.bot?.role);
    return {build:BUILD_META.id,gameVersion:PRODUCT_VERSION,sdkVersion:window.RallyNetcode?.VERSION,
      sdkRevision:window.RallyNetcodeSource?.url,
      role:ActiveViewState.role,screen:UiRuntimeState.value.screen,
      renderer:{backend:renderer?.backend,tick:renderer?.snapshot?.tick,
        canvasWidth:renderer?.canvas?.width,canvasHeight:renderer?.canvas?.height,
        gpuVendor:gpuInfo?gl.getParameter(gpuInfo.UNMASKED_VENDOR_WEBGL):null,
        gpuRenderer:gpuInfo?gl.getParameter(gpuInfo.UNMASKED_RENDERER_WEBGL):null},
      humanRole:match?.humanRole,botRole:match?.botRole,
      confirmedTick,stateHashTick,
      aiStats:{submitted:aiReceipts.length,applied:aiReceipts.filter(c=>c.applied).length},
      combatHits:this.observeCombat(),telemetry:this.telemetry(),
      // The AI's commands as the human session's sim applied them.
      aiHistory:aiReceipts.map(c=>({actor:c.actor,netcodeSequence:c.netcodeSequence,seq:c.seq,
        status:c.applied?'applied':'rejected',action:c.type})),
      sessions,transports};
  }
};`;



async function launchFromHand(page) {
  // The launch game has no build step: pick a real hand card, hold on the field, aim, release.
  const card=page.locator('[data-launch-card]').first();
  await card.click();
  await page.waitForFunction(()=>document.querySelector('.launch-card.selected:not(.unaffordable)'),null,{timeout:30000});
  const type=await card.getAttribute('data-launch-card');
  const point=await page.evaluate(()=>{
    const r=window.__netcodeE2E.ActiveViewState.renderer,rect=r.canvas.getBoundingClientRect();
    for(const fy of [.4,.5,.3])for(const fx of [.5,.6,.4]){
      const x=rect.left+rect.width*fx,y=rect.top+rect.height*fy;
      if(document.elementFromPoint(x,y)?.id==='glCanvas')return {x,y};
    }
    throw Error('Unobstructed native launch hold point missing');
  });
  await page.mouse.move(point.x,point.y);
  await page.mouse.down();
  await page.waitForTimeout(250+400);
  await page.mouse.move(point.x+8,point.y-24,{steps:1});
  await page.mouse.up();
  await page.waitForFunction(()=>{
    const s=window.__netcodeE2E.MatchLifecycle.activeSession();
    return s.replayRecorder?.commands?.some(c=>c.actor===s.role&&c.action?.type==='LAUNCH');
  },null,{timeout:15000});
  const submitted=await page.evaluate(()=>{
    const s=window.__netcodeE2E.MatchLifecycle.activeSession();
    return s.replayRecorder.commands.find(c=>c.actor===s.role&&c.action?.type==='LAUNCH').action;
  });
  const overheated=await page.evaluate(async holdMs=>{
    const {LaunchRules}=await import(new URL('./src/sim/launch-rules.js',location.href));
    return LaunchRules.overheated(holdMs);
  },submitted.holdMs);
  assert.equal(overheated,false,`The native gesture must release before overheat (${submitted.holdMs}ms)`);
  return {type,point,holdMs:submitted.holdMs};
}

async function runRole(browser, url, humanRole) {
  const context=await browser.newContext({viewport:{width:412,height:915},deviceScaleFactor:1});
  const page=await context.newPage(),errors=[],consoleErrors=[];
  let progressTimer=null;
  page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(m.type()==='error')consoleErrors.push(m.text());});
  page.on('dialog',d=>d.accept());
  try {
    await require('./netcode-qa-module.cjs').routePinnedSDK(page);
    // Test-only settings come from the address (src/ui/dev-query.js).
    await page.goto(`${url}?tps=20&netcode=${selectedMode}&role=${humanRole}`,{waitUntil:'domcontentloaded'});
    // The player presses 대전 시작 once the observer ran, so its CONFIG override (in-page AI) is in place.
    await page.waitForFunction(()=>window.__netcodeE2E,null,{timeout:60000});
    await page.locator('#gameStartBtn').click();
    await page.locator('#gameScreen').waitFor({state:'visible',timeout:35000});
    await page.waitForFunction(()=>Object.values(window.__netcodeE2E.MatchLifecycle.singleMatch?.sessions||{})
      .every(s=>s.netcodeSession?.ready&&s.sim?.tick>=4),null,{timeout:15000});
    const initial=await page.evaluate(()=>window.__netcodeE2E.inspect());
    fs.writeFileSync(path.join(output,humanRole+'-initial.json'),JSON.stringify(initial,null,2));
    assert.equal(initial.sdkVersion,pinnedSdkVersion,'The pinned SDK actually runs');
    assert.ok(initial.sdkRevision.startsWith('gamekit:'),'Pinned shared SDK provenance');
    assert.equal(initial.renderer.backend,'WebGL');
    assert(Object.values(initial.sessions).every(s=>s.profile.mode===selectedMode&&s.tps===20),'Address settings reach the chosen TPS and mode on both peers');
    assert.equal(initial.role,humanRole);
    assert.deepEqual(Object.keys(initial.sessions).sort(),['guest','host']);
    for(const role of ['host','guest']){
      assert.equal(initial.sessions[role].coreName,'RollbackSession');
      assert.equal(initial.sessions[role].tps,20);
      assert.equal(initial.transports[role].name,'RoomTransport');
      assert.equal(initial.transports[role].roomState,'open','the GameKit room is open');
      assert.equal(initial.transports[role].netcodeState,'open','the netcode input and control channels are open');
      assert.equal(initial.transports[role].rtcConnectionState,'connected','a real RTCPeerConnection connected');
      assert.ok(initial.transports[role].generation>=1,'the room has opened at least once');
    }
    const launch=await launchFromHand(page);
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
      return human.sim.units.some(u=>u.alive&&u.side===side)
        &&human.sim.commandReceipts.some(r=>r.actor===match.bot.role&&r.type==='LAUNCH'&&r.applied)
        &&human.sim.units.some(u=>u.alive&&u.side===1-side)
        &&q.observeCombat().length>0;
    },null,{timeout:Number(process.env.QA_BATTLE_TIMEOUT_MS)||180000});
    clearInterval(progressTimer);progressTimer=null;
    const battle=await page.evaluate(()=>window.__netcodeE2E.inspect());
    const combatFocus=await page.evaluate(()=>{
      const q=window.__netcodeE2E,s=q.MatchLifecycle.activeSession(),r=q.ActiveViewState.renderer,m=q.ActiveViewState.minimap;
      const side=s.role==='host'?0:1;
      const unit=s.sim.units.find(u=>u.alive&&u.side===side&&u.target!=null)
        ||s.sim.units.find(u=>u.alive&&u.side===side);
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
    assert.ok(battle.sessions[humanRole].recordedCommands.some(c=>c.actor===humanRole&&c.action==='LAUNCH'));
    assert.ok(battle.aiHistory.some(c=>c.status==='applied'&&c.action==='LAUNCH'),'AI launches through the same command');
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
    // Exiting replay reloads the document; wait for async ESM boot before inspecting the new scope.
    await page.waitForFunction(()=>window.__netcodeE2E, null, {timeout:35000});
    assert.equal(await page.evaluate(()=>!!window.__netcodeE2E.ReplayPresentation.replayPlayer),false);
    assert.deepEqual(errors,[],'No uncaught exceptions across normal match and replay');
    assert.ok(!consoleErrors.some(m=>/simulation fatal|CONTRACT_FATAL/i.test(m)),consoleErrors.join('\n'));
    const result={humanRole,initial,launch,battle,ended,replay,pageErrors:errors,consoleErrors};
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
  const server=await require('./netcode-qa-module.cjs').serveSource(htmlPath,{observer});
  let browser;
  try{
    browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',
      headless:process.env.QA_HEADED!=='1',args:process.env.QA_SOFTWARE_GPU==='1'
        ?['--use-angle=swiftshader','--enable-unsafe-swiftshader']:[]});
    const results=[];
    for(const role of (process.env.QA_ROLES||'host,guest').split(','))results.push(await runRole(browser,server.url,role));
    fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({htmlPath,results},null,2));
    console.log(JSON.stringify({htmlPath,results:results.map(r=>({humanRole:r.humanRole,
      build:r.initial.build,sdkVersion:r.initial.sdkVersion,renderer:r.initial.renderer,
      battleTick:r.battle.sessions[r.humanRole].tick,aiStats:r.battle.aiStats,
      result:r.ended.sessions[r.humanRole].replayResult,replay:r.replay,pageErrors:r.pageErrors}))},null,2));
  }finally{try{await browser?.close();}finally{await server.close();}}
})().catch(error=>{console.error(error.stack);process.exitCode=1;});
