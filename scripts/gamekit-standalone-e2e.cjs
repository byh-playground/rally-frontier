const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
// No-external-network file execution. QA_STRICT_OFFLINE=1 retains whole-browser offline diagnostics.
const {pathToFileURL}=require('node:url');const {chromium}=require('playwright');
(async()=>{
 const input=path.resolve(process.argv[2]||'_site/index.html'),output=path.resolve('.qa/gamekit-standalone');fs.mkdirSync(output,{recursive:true});
 const source=fs.readFileSync(input,'utf8'),tail=source.lastIndexOf('})();');assert(tail>0);
 const file=path.join(output,'standalone.html');fs.writeFileSync(file,source.slice(0,tail)+'window.__gamekitOffline={ActiveViewState,MatchLifecycle,UiRuntimeState};'+source.slice(tail));
 const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'chromium',headless:true,args:['--use-angle=swiftshader','--enable-unsafe-swiftshader','--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE localhost, EXCLUDE *.local']});
 try{
  const strictOffline=process.env.QA_STRICT_OFFLINE==='1',context=await browser.newContext({offline:strictOffline}),page=await context.newPage(),errors=[],requests=[],websockets=[];
  await context.route(/^https?:/,route=>route.abort());
  await context.routeWebSocket('**/*',socket=>{websockets.push(socket.url());socket.close()});
  page.on('pageerror',e=>errors.push(e.message));page.on('dialog',dialog=>dialog.accept());page.on('request',r=>{if(/^https?:/.test(r.url()))requests.push(r.url())});
  await page.goto(pathToFileURL(file).href);await page.waitForFunction(()=>window.RallyGamekit&&window.RallyNetcode);
  await page.locator('#gameStartBtn').click();await page.locator('#campaignBtn').click();
  await page.locator('[data-mission-id]').first().waitFor();const missions=await page.locator('[data-mission-id]').count();assert(missions>0);
  const info=await page.evaluate(()=>({pinned:window.RallyNetcodeSource.pinned,modules:['InterpolationTimeline','WebGLDevice','createDOMInput','CameraViewport','PresentationEventQueue','resolveAnchorInto','DiagnosticRing'].every(k=>typeof window.RallyGamekit[k]==='function')}));
  assert(info.pinned&&info.modules);assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'Standalone boot and authored campaign require no HTTP request');
  await page.screenshot({path:path.join(output,'offline-campaign.png')});
  await page.locator('[data-mission-id]').first().click();await page.locator('#campaignStartBtn').click();
  try{await page.waitForFunction(()=>window.__gamekitOffline.ActiveViewState.snap?.tick>=20,null,{timeout:60000})}
  catch(error){
   const diagnostic=await page.evaluate(()=>{const q=window.__gamekitOffline,m=q?.MatchLifecycle.singleMatch;return {screen:q?.UiRuntimeState.value.screen,tick:q?.ActiveViewState.snap?.tick,online:navigator.onLine,secure:isSecureContext,status:document.querySelector('#singleStatus')?.textContent,fatal:window.__RALLY_FATAL_DIAGNOSTIC__,sessions:Object.fromEntries(Object.entries(m?.sessions||{}).map(([role,s])=>[role,{tick:s.sim?.tick,ready:s.netcodeSession?.ready,fatal:s.simulationFatal,phase:s.phase}])),transports:Object.fromEntries(Object.entries(m?.transports||{}).map(([role,t])=>[role,{open:t.isOpen(),connection:t.pc?.connectionState,ice:t.pc?.iceConnectionState,gathering:t.pc?.iceGatheringState,iceServerCount:t.pc?.getConfiguration().iceServers?.length,localCandidateCount:(t.pc?.localDescription?.sdp?.match(/a=candidate:/g)||[]).length,remoteCandidateCount:(t.pc?.remoteDescription?.sdp?.match(/a=candidate:/g)||[]).length,localType:t.pc?.localDescription?.type,remoteType:t.pc?.remoteDescription?.type}])),visibleText:document.body.innerText.slice(-6000)}});
   console.log('RALLY_OFFLINE_FAILURE '+JSON.stringify({errors,requests,diagnostic}));await page.screenshot({path:path.join(output,'offline-failure.png')});throw error;
  }
  assert.equal(await page.locator('#glCanvas').getAttribute('data-renderer-backend'),'WebGL');
  const peers=await page.evaluate(async()=>{
   const rows=[];for(const [role,t]of Object.entries(window.__gamekitOffline.MatchLifecycle.singleMatch.transports)){
    const stats=await t.pc.getStats(),transport=[...stats.values()].find(r=>r.type==='transport'&&r.selectedCandidatePairId),pair=stats.get(transport?.selectedCandidatePairId)||[...stats.values()].find(r=>r.type==='candidate-pair'&&r.state==='succeeded'&&r.nominated),local=stats.get(pair?.localCandidateId),remote=stats.get(pair?.remoteCandidateId);
    rows.push({role,connection:t.pc.connectionState,iceServerCount:t.pc.getConfiguration().iceServers.length,localType:local?.candidateType,remoteType:remote?.candidateType,protocol:local?.protocol,addressComparable:typeof local?.address==='string'&&typeof remote?.address==='string',sameHostAddress:typeof local?.address==='string'&&local.address===remote?.address});
   }return rows;
  });
  assert.equal(peers.length,2);for(const peer of peers){assert.equal(peer.connection,'connected');assert.equal(peer.iceServerCount,0);assert.equal(peer.localType,'host');assert.equal(peer.remoteType,'host');if(peer.addressComparable)assert(peer.sameHostAddress)}
  assert.deepEqual(websockets,[]);await page.screenshot({path:path.join(output,'standalone-campaign-game.png')});
  await page.locator('#matchMenuBtnGame').click();await page.locator('#matchMenuSurrenderBtn').click();await page.locator('#result').waitFor({state:'visible'});
  assert.deepEqual(errors,[]);assert.deepEqual(requests,[],'Self-contained authored campaign reaches a real result without external HTTP resources');
  fs.writeFileSync(path.join(output,'result.json'),JSON.stringify({mode:strictOffline?'strict-browser-offline':'external-network-blocked',missions,...info,standaloneCampaignResult:true,peers,errors,requests,websockets},null,2));console.log({mode:strictOffline?'strict-browser-offline':'external-network-blocked',missions,...info,standaloneCampaignResult:true,peers,errors,requests,websockets});
 }finally{await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
