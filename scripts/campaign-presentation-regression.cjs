const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const {chromium}=require('playwright');
async function run(){
 const output=path.resolve(__dirname,'../.qa/campaign-presentation');fs.mkdirSync(output,{recursive:true});
 let html=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8');const end=html.lastIndexOf('})();');assert.ok(end>=0);
 html=html.slice(0,end)+'window.__campaignQA={ActiveViewState,MatchLifecycle,UiRuntimeState,BattlePresentation,ResearchPresentation,DiagnosticPresentation,UnitDefinition,UnitSpecialResearchDefinition};'+html.slice(end);
 const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
 try{
 const page=await browser.newPage({viewport:{width:1280,height:900}}),errors=[];
 page.on('pageerror',e=>errors.push(e.message));page.on('dialog',d=>d.accept());
 await page.route('http://127.0.0.1:32119/',r=>r.fulfill({contentType:'text/html',body:html}));
 await page.goto('http://127.0.0.1:32119/');await page.locator('#gameStartBtn').click();await page.locator('#campaignBtn').click();await page.locator('[data-mission-id="frontier-01-first-flag"]').click();await page.locator('#campaignStartBtn').click();
 await page.waitForFunction(()=>window.__campaignQA.ActiveViewState.snap?.tick>20,null,{timeout:30000});
 const initial=await page.evaluate(()=>{const q=window.__campaignQA;return {deck:q.ActiveViewState.snap.decks,backend:q.ActiveViewState.renderer.backend,tick:q.ActiveViewState.snap.tick,simDeck:q.MatchLifecycle.activeSession().sim.decks}});
 assert.deepEqual(initial.deck,[[],[]]);assert.equal(initial.backend,'WebGL');
 await page.locator('#militaryTreeBtn').click();await page.locator('#militaryT1Btn').click();assert.equal(await page.locator('#unitGrid [data-produce-unit]').count(),0);
 await page.screenshot({path:path.join(output,'campaign-empty-deck.png')});
 // The actual minimap and battlefield pointer place a rally inside the authored rescue region.
 const mini=await page.evaluate(()=>{const r=window.__campaignQA.ActiveViewState.renderer,m=window.__campaignQA.ActiveViewState.minimap,b=m.contentRect();return{x:b.left+r.viewX(r.world.width*.30)/r.world.width*b.width,y:b.top+r.viewY(r.world.height*.72)/r.world.height*b.height}});
 await page.mouse.click(mini.x,mini.y);await page.waitForTimeout(250);
 const target=await page.evaluate(()=>{const r=window.__campaignQA.ActiveViewState.renderer,b=r.canvas.getBoundingClientRect(),p=r.projectRenderWorldPosition({x:r.world.width*.30,y:0,z:r.world.height*.72});return{x:b.left+p.x*b.width/r.canvas.width,y:b.top+p.y*b.height/r.canvas.height}});
 await page.mouse.click(target.x,target.y);
 await page.waitForFunction(()=>window.__campaignQA.ActiveViewState.snap?.decks[0].includes('swordsman'),null,{timeout:60000});
 const unlocked=await page.evaluate(()=>{const q=window.__campaignQA;return{tick:q.ActiveViewState.snap.tick,deck:q.ActiveViewState.snap.decks,draft:q.MatchLifecycle.activeSession().draft.decks,selection:q.UiRuntimeState.value.selection.unit,flags:q.MatchLifecycle.activeSession().sim.campaignScriptRuntime.state}});
 assert.deepEqual(unlocked.draft.host,[]);assert.equal(unlocked.selection,'swordsman');
 await page.locator('#militaryTreeBtn').click();await page.locator('#militaryT1Btn').click();
 await page.locator('#unitGrid [data-produce-unit="swordsman"]').waitFor({state:'visible'});assert.equal(await page.locator('#unitGrid [data-produce-unit="swordsman"]').count(),1);
 const research=await page.evaluate(()=>{const q=window.__campaignQA,s=structuredClone(q.ActiveViewState.snap),id=Object.keys(q.UnitDefinition.all).find(id=>q.UnitSpecialResearchDefinition.hasOptions(id));if(!id)throw Error('No research-capable definition');s.decks[0]=[id];q.ResearchPresentation.researchAbilityTier=q.UnitDefinition.get(id).tier;q.ResearchPresentation.renderResearchCommandPanels(s);const displayed=!!document.querySelector('#researchAbilityGrid [data-unit="'+id+'"]');q.ResearchPresentation.researchAbilityTier=1;q.ResearchPresentation.renderResearchCommandPanels(q.ActiveViewState.snap);return {id,displayed}});assert.equal(research.displayed,true);
 const ground=async(x,z)=>page.evaluate(({x,z})=>{const r=window.__campaignQA.ActiveViewState.renderer,b=r.canvas.getBoundingClientRect(),p=r.projectRenderWorldPosition({x:r.world.width*x,y:0,z:r.world.height*z});return{x:b.left+p.x*b.width/r.canvas.width,y:b.top+p.y*b.height/r.canvas.height}},{x,z});
 await page.locator('#economyTreeBtn').click();await page.locator('#supplyBtn').click();let placement=await ground(.26,.73);await page.mouse.click(placement.x,placement.y);await page.locator('#buildFinishBtn').click();
 await page.waitForFunction(()=>window.__campaignQA.ActiveViewState.snap.buildings.some(b=>b.side===0&&b.type==='supply'&&b.complete),null,{timeout:45000});
 await page.locator('#militaryTreeBtn').click();await page.locator('#militaryT1Btn').click();await page.locator('[data-produce-unit="swordsman"]').click();placement=await ground(.31,.76);await page.mouse.click(placement.x,placement.y);await page.locator('#buildFinishBtn').click();
 await page.waitForFunction(()=>window.__campaignQA.ActiveViewState.snap.buildings.some(b=>b.side===0&&b.produceType==='swordsman'&&b.productionBatchesCompleted>0),null,{timeout:60000});
 const production=await page.evaluate(()=>window.__campaignQA.ActiveViewState.snap.buildings.filter(b=>b.side===0&&b.produceType==='swordsman'));
 await page.screenshot({path:path.join(output,'campaign-unlocked-deck.png')});
 await page.waitForTimeout(4000);assert.equal(await page.locator('body').innerText().then(t=>t.includes('RALLY_FRONTIER_PRESENTATION_CONTRACT_FATAL')),false);
 await page.locator('#matchMenuBtnGame').click();await page.locator('#matchMenuSurrenderBtn').click();await page.locator('#result').waitFor({state:'visible'});await page.screenshot({path:path.join(output,'campaign-result.png')});await page.locator('#rematchBtn').click();await page.locator('#gameStartBtn').waitFor({state:'visible'});
 // Isolated contract probes preserve diagnostics without poisoning the actual UI match.
 const contract=await page.evaluate(()=>{const q=window.__campaignQA,diagnostics=[],original=q.DiagnosticPresentation.presentFatalDiagnostic,active=q.MatchLifecycle.activeSession;const check=(ok,msg)=>{if(!ok)throw Error(msg)};try{q.DiagnosticPresentation.presentFatalDiagnostic=d=>diagnostics.push(d);q.MatchLifecycle.activeSession=()=>({sim:{}});for(const decks of [undefined,null,{},[],[[]],['bad',[]],[['missing-unit'],[]],[['constructor'],[]],[[42],[]]]){const count=diagnostics.length;q.BattlePresentation.renderGame({tick:37,decks});check(diagnostics.length===count+1,'Each malformed snapshot is rejected');check(diagnostics.at(-1)?.kind==='RALLY_FRONTIER_PRESENTATION_CONTRACT_FATAL','Malformed deck remains fatal')}check(q.BattlePresentation.productionDeck({decks:[[],[]]},0)?.length===0,'Empty deck is valid');check(q.BattlePresentation.productionDeck({decks:[[],['swordsman']]},1)[0]==='swordsman','Guest reads side 1');q.MatchLifecycle.activeSession=()=>null;q.BattlePresentation.renderGame({tick:38,decks:[[],[]]});check(diagnostics.at(-1).message.includes('without an active simulation'),'Missing simulation remains fatal');return{diagnostics:diagnostics.length,guestDeck:true,emptyDeck:true}}finally{q.DiagnosticPresentation.presentFatalDiagnostic=original;q.MatchLifecycle.activeSession=active}});
 assert.deepEqual(errors,[]);const result={initial,unlocked,research,production,contract,pageErrors:errors,returnedToLobby:true};fs.writeFileSync(path.join(output,'result.json'),JSON.stringify(result,null,2));console.log(JSON.stringify(result,null,2));
 }finally{await browser.close()}
}
run().catch(e=>{console.error(e.stack);process.exitCode=1});
