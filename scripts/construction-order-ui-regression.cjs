const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),mobile=!!process.env.QA_MOBILE;
let html=fs.readFileSync(process.env.QA_HTML_PATH||path.join(root,'index.html'),'utf8');
html=html.replace('economy:{startingResources:{minerals:0,gas:0}}','economy:{startingResources:{minerals:10000,gas:10000}}');
const end=html.lastIndexOf('})();');html=html.slice(0,end)+`
const start=GameSession.prototype.startSim;GameSession.prototype.startSim=function(){return start.call(this,20261003)};
BotController.prototype.handleSnapshot=function(){}; // Keep native draft negotiation, disable gameplay AI before its first snapshot.
const defaultBotDeck=DeckRecord.defaultBotDeckPayload;DeckRecord.defaultBotDeckPayload=function(){return defaultBotDeck.call(this,'construction-benchmark-fixed-deck')};
// Slow travel is a deterministic pre-game fixture on both peers, to exercise reservations past prediction TTL.
UnitDefinition.all.worker.speed=20;
window.__orderQA={MatchLifecycle,ActiveViewState,BuildingPresentation,BuildingDefinition,UiRuntimeState};
`+html.slice(end);
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
 const p=await browser.newPage({viewport:mobile?{width:412,height:915}:{width:1280,height:900},hasTouch:mobile}),errors=[];
 p.on('pageerror',e=>errors.push(e.message));await p.route('https://order-qa.local/',r=>r.fulfill({contentType:'text/html',body:html}));
 await p.goto('https://order-qa.local/');for(const id of ['gameStartBtn','selectionDeckBtn','singleBtn','singleHostBtn','deckConfirmBtn'])await p.locator('#'+id).click();
 await p.locator('#gameScreen').waitFor({state:'visible',timeout:35000});await p.waitForFunction(()=>__orderQA.MatchLifecycle.activeSession()?.sim?.tick>=10);
 const point=await p.evaluate(()=>{
  const q=__orderQA,r=q.ActiveViewState.renderer,s=q.MatchLifecycle.activeSession(),side=0,state=q.ActiveViewState.snap;
  const base=s.sim.buildings.find(b=>b.side===side&&q.BuildingDefinition.get(b.type)?.isMainBase),rect=r.canvas.getBoundingClientRect();
  for(let radius=250;radius<=550;radius+=25)for(let i=0;i<48;i++){
   const x=Math.round(base.x+Math.cos(i*Math.PI/24)*radius),y=Math.round(base.y+Math.sin(i*Math.PI/24)*radius);
   if(q.BuildingPresentation.buildValidation(state,side,{type:'BUILD',building:'barracks',produceType:'swordsman',x,y}))continue;
   if(Math.min(...s.sim.units.filter(u=>u.side===side&&u.type==='worker').map(u=>Math.hypot(u.x-x,u.y-y)))<225)continue;
   const pos=r.projectRenderWorldPosition({x,y:r.world.terrain.surfaces.heightAt(x,y),z:y,groundY:0}),cx=rect.left+pos.x/r.canvas.width*rect.width,cy=rect.top+pos.y/r.canvas.height*rect.height;
   if(cx<rect.left+30||cx>rect.right-30||cy<rect.top+100||cy>rect.bottom-60||document.elementFromPoint(cx,cy)?.id!=='glCanvas')continue;
   return{x:cx,y:cy};
  }throw Error('No visible distant build site');
 });
 const tap=async()=>mobile?p.touchscreen.tap(point.x,point.y):p.mouse.click(point.x,point.y);
 async function order(){for(const selector of ['#militaryTreeBtn','#militaryT1Btn','[data-produce-unit="swordsman"]'])await p.locator(selector).click();await tap();await p.locator('#buildFinishBtn').click();await p.waitForFunction(()=>__orderQA.ActiveViewState.snap?.constructionOrders?.some(o=>o.side===0));return p.evaluate(()=>__orderQA.ActiveViewState.snap.constructionOrders.find(o=>o.side===0).id)}
 const id=await order();await p.waitForTimeout(5500);assert.equal(await p.evaluate(id=>__orderQA.ActiveViewState.snap.constructionOrders.some(o=>o.id===id),id),true,'Reservation survives prediction TTL');
 assert.equal(await p.evaluate(()=>__orderQA.ActiveViewState.renderer.pendingBuildGhosts.length),0,'Confirmed order removes local prediction');
 fs.mkdirSync(path.join(root,'.qa/construction-orders'),{recursive:true});await p.screenshot({path:path.join(root,'.qa/construction-orders',mobile?'mobile-ghost.png':'desktop-ghost.png')});
 await tap();await p.waitForFunction(()=>document.querySelector('#buildingPanelStatus').textContent.includes('건설 예약'));
 assert.match(await p.locator('#cancelModeBtn').innerText(),/전액 환불/);assert.doesNotMatch(await p.locator('#buildingPanelStatus').innerText(),/HP|%/);
 fs.mkdirSync(path.join(root,'.qa/construction-orders'),{recursive:true});await p.screenshot({path:path.join(root,'.qa/construction-orders',mobile?'mobile-reservation.png':'desktop-reservation.png')});
 await p.locator('#cancelModeBtn').click();await p.waitForFunction(id=>!__orderQA.ActiveViewState.snap.constructionOrders.some(o=>o.id===id),id);
 assert.equal(await p.evaluate(()=>__orderQA.UiRuntimeState.value.selection.buildingId),null,'Canceled selection clears');
 const next=await order();await tap();await p.waitForFunction(()=>document.querySelector('#buildingPanelStatus').textContent.includes('건설 예약'));
 await p.waitForFunction(id=>__orderQA.ActiveViewState.snap.buildings.some(b=>b.id===id),next,{timeout:45000});
 assert.equal(await p.evaluate(()=>__orderQA.UiRuntimeState.value.selection.buildingId),next,'Arrival keeps selected identity');
 assert.doesNotMatch(await p.locator('#buildingPanelStatus').innerText(),/건설 예약/);assert.deepEqual(errors,[]);
 console.log(JSON.stringify({mobile,reservationId:id,startedId:next,persistentGhost:true,cancel:true,selectionTransition:true,errors}));
 }finally{await browser.close()}})().catch(e=>{console.error(e);process.exit(1)});
