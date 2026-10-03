const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const{chromium}=require('playwright');
const root=path.resolve(__dirname,'..');process.chdir(root);fs.mkdirSync('.qa/five-builds',{recursive:true});
let html=fs.readFileSync(process.env.QA_HTML_PATH||'index.html','utf8');
// Controlled resource fixture, applied to BOTH peers before session initialization.
html=html.replace('economy:{startingResources:{minerals:0,gas:0}}','economy:{startingResources:{minerals:10000,gas:10000}}');
const observer=`
const originalStart=GameSession.prototype.startSim;GameSession.prototype.startSim=function(){const start=performance.now();try{return originalStart.call(this,20261003)}finally{probe.initializations.push({role:this.role,ms:performance.now()-start,layers:this.sim?.navigation?.layers?.size||0,preparationMs:this.sim?.navigation?.metrics?.preparationMs||0});}};
BotController.prototype.handleSnapshot=function(){}; // Keep native draft negotiation, disable gameplay AI before its first snapshot.
const defaultBotDeck=DeckRecord.defaultBotDeckPayload;DeckRecord.defaultBotDeckPayload=function(){return defaultBotDeck.call(this,'construction-benchmark-fixed-deck')};
window.__buildQA={MatchLifecycle,ActiveViewState,BuildingPresentation,BuildingDefinition,TerrainNavigation,StrategySim};
const probe=window.__buildProbe={enabled:false,phase:'idle',context:'presentation',records:[],initializations:[],frames:[],longtasks:[],commands:[],navigationUpdates:[],fieldCalls:[],astarCalls:[],constructionTransitions:[],unitType:null};
function measure(obj,key,label,filter){const original=obj[key];if(typeof original!=='function')throw Error('Missing '+label);obj[key]=function(...args){if(!probe.enabled||(filter&&!filter(args)))return original.apply(this,args);const start=performance.now(),context=probe.context,phase=probe.phase;try{return original.apply(this,args)}finally{const ms=performance.now()-start;if(ms>=.05||label==='mesh.build')probe.records.push({label,ms,start,context,phase,tick:this.tick??this.sim?.tick??this.session?.sim?.tick,navKind:label==='nav.layer'?(this.sim instanceof StrategySim?'live':'snapshot'):undefined});}};}
const validatePreview=BuildingPresentation.buildValidation;BuildingPresentation.buildValidation=function(...args){const old=probe.context;probe.context='ui-preview';try{return validatePreview.apply(this,args)}finally{probe.context=old}};
const originalStep=RallySimulationAdapter.prototype.step;RallySimulationAdapter.prototype.step=function(frame){const old=probe.context;probe.context=this.session.role+(frame.resimulating?'-replay':'-forward');try{const result=originalStep.call(this,frame);if(probe.enabled){const sim=this.session.sim;for(const [kind,items] of [['order',sim.constructionOrders||[]],['building',sim.buildings]])for(const item of items){if(item.produceType!=='swordsman')continue;const key=this.session.role+':'+kind+':'+item.id;if(!probe.constructionTransitions.some(e=>e.key===key))probe.constructionTransitions.push({key,kind,id:item.id,side:item.side,role:this.session.role,tick:sim.tick,at:performance.now(),phase:probe.phase,x:item.x,y:item.y});}}return result}finally{probe.context=old}};
if(typeof StrategySim.prototype.startConstructionOrder==='function')measure(StrategySim.prototype,'startConstructionOrder','sim.startConstructionOrder');
measure(SurfaceMotion.prototype,'recover','collision.recover');measure(StrategySim.prototype,'step','sim.step');measure(StrategySim.prototype,'applyCommand','sim.BUILD',a=>a[1]?.type==='BUILD');
for(const name of ['assignBuilderToBuilding','updateBuildings','updateWorker','solveContacts','exportState','importState'])measure(StrategySim.prototype,name,'sim.'+name);
for(const name of ['save','load'])measure(RallySimulationAdapter.prototype,name,'adapter.'+name);
for(const name of ['layer','field','sync'])measure(TerrainNavigation.prototype,name,'nav.'+name);
if(typeof TerrainNavigation.prototype.astarPlan==='function')measure(TerrainNavigation.prototype,'astarPlan','nav.astar');measure(NavigationMeshBuilder,'build','mesh.build');measure(NavigationMeshBuilder,'connect','graph.connect');measure(NavigationMeshTiles.prototype,'rebuild','nav.rebuild');measure(BuildingPresentation,'buildValidation','ui.validation');
const originalRebuild=NavigationMeshTiles.prototype.rebuild;NavigationMeshTiles.prototype.rebuild=function(...args){const layer=originalRebuild.apply(this,args);if(probe.enabled)probe.navigationUpdates.push({phase:probe.phase,context:probe.context,rebuiltTiles:layer.rebuiltTiles,graphChanges:layer.graphChanges?{...layer.graphChanges}:null,geometryMs:layer.geometryMs,connectMs:layer.connectMs,detachMs:layer.detachMs,relinkMs:layer.relinkMs,componentMs:layer.componentMs,cellCount:layer.cellCount,nodeCount:layer.nodeCount});return layer};
for(const name of ['nextPoint','distance']){const fn=TerrainNavigation.prototype[name];TerrainNavigation.prototype[name]=function(...args){const previous=probe.unitType;probe.unitType=name==='nextPoint'?args[0].type:(args[3]||'worker');try{return fn.apply(this,args)}finally{probe.unitType=previous}}}
const observedField=TerrainNavigation.prototype.field;TerrainNavigation.prototype.field=function(...args){if(probe.enabled)probe.fieldCalls.push({unitType:probe.unitType,planner:UnitDefinition.get(probe.unitType)?.navigationPlanner||'flow-field',phase:probe.phase,context:probe.context});return observedField.apply(this,args)};
if(typeof TerrainNavigation.prototype.astarPlan==='function'){const fn=TerrainNavigation.prototype.astarPlan;TerrainNavigation.prototype.astarPlan=function(...args){const expanded=this.metrics.astarExpanded,start=performance.now();const result=fn.apply(this,args);if(probe.enabled)probe.astarCalls.push({phase:probe.phase,context:probe.context,type:probe.unitType,x:args[0],y:args[1],goal:args[2].key,radius:args[3],ignore:args[4],ms:performance.now()-start,expanded:this.metrics.astarExpanded-expanded,length:result?.length??null,cost:result?.graphCost??null,revision:this.topology.version});return result}}
const originalCommand=GameSession.prototype.command;GameSession.prototype.command=function(action){if(action.type==='BUILD')probe.commands.push({at:performance.now(),tick:this.sim.tick,role:this.role,action});return originalCommand.call(this,action)};
new PerformanceObserver(list=>{if(probe.enabled)for(const x of list.getEntries())probe.longtasks.push({start:x.startTime,ms:x.duration,phase:probe.phase});}).observe({type:'longtask',buffered:false});
let last;function sample(t){if(probe.enabled&&last!==undefined)probe.frames.push({at:t,ms:t-last,phase:probe.phase});last=t;requestAnimationFrame(sample)}requestAnimationFrame(sample);
`;
const end=html.lastIndexOf('})();');html=html.slice(0,end)+observer+html.slice(end);
(async()=>{const b=await chromium.launch({channel:'msedge',headless:true});try{
 const p=await b.newPage({viewport:process.env.QA_MOBILE?{width:412,height:915}:{width:1280,height:900},hasTouch:!!process.env.QA_MOBILE}),errors=[];p.on('pageerror',e=>errors.push(e.message));
 await p.route('https://build-qa.local/',r=>r.fulfill({contentType:'text/html',body:html}));
 await p.goto('https://build-qa.local/');await p.locator('#gameStartBtn').click();await p.locator('#selectionDeckBtn').click();await p.locator('#singleBtn').click();await p.locator('#singleHostBtn').click();await p.locator('#deckConfirmBtn').click();await p.locator('#gameScreen').waitFor({state:'visible',timeout:35000});
 await p.waitForFunction(()=>window.__buildQA.MatchLifecycle.activeSession()?.sim?.tick>=10);
 {await p.evaluate(()=>__buildQA.MatchLifecycle.singleMatch.bot.stop());await p.waitForTimeout(3000);}
 await p.evaluate(()=>{__buildProbe.enabled=true;__buildProbe.phase='baseline'});await p.waitForTimeout(3000);
 await p.evaluate(()=>{__buildProbe.enabled=false});
 const points=await p.evaluate(()=>{
  const q=__buildQA,r=q.ActiveViewState.renderer,s=q.MatchLifecycle.activeSession(),side=s.role==='host'?0:1,state=q.ActiveViewState.snap;
  const base=s.sim.buildings.find(b=>b.side===side&&q.BuildingDefinition.get(b.type)?.isMainBase),rect=r.canvas.getBoundingClientRect(),points=[];
  for(let radius=150;radius<=650;radius+=40)for(let i=0;i<48;i++){
   const x=Math.round(base.x+Math.cos(i*Math.PI/24)*radius),y=Math.round(base.y+Math.sin(i*Math.PI/24)*radius);
   if(points.some(p=>Math.hypot(p.wx-x,p.wy-y)<130))continue;
   const action={type:'BUILD',building:'barracks',produceType:'swordsman',x,y};if(q.BuildingPresentation.buildValidation(state,side,action))continue;
   const pos=r.projectRenderWorldPosition({x,y:r.world.terrain.surfaces.heightAt(x,y),z:y,groundY:0}),cx=rect.left+(pos.x+(r.frameShakeX||0))/r.canvas.width*rect.width,cy=rect.top+(pos.y+(r.frameShakeY||0))/r.canvas.height*rect.height;
   if(cx<rect.left+40||cx>rect.right-40||cy<rect.top+100||cy>rect.bottom-60||document.elementFromPoint(cx,cy)?.id!=='glCanvas')continue;
   points.push({x:cx,y:cy,wx:x,wy:y});if(points.length===5)return points;
  }throw Error('Only '+points.length+' visible valid sites');
 });
 await p.locator('#militaryTreeBtn').click();await p.locator('#militaryT1Btn').click();await p.locator('[data-produce-unit="swordsman"]').click();
 await p.evaluate(()=>{__buildProbe.enabled=true;__buildProbe.phase='five-builds'});
 const clickTimes=[];
 for(const point of points){clickTimes.push(Date.now());if(process.env.QA_MOBILE)await p.touchscreen.tap(point.x,point.y);else await p.mouse.click(point.x,point.y);await p.waitForTimeout(Number(process.env.BUILD_GAP_MS||400));}
 await p.locator('#buildFinishBtn').click();await p.evaluate(()=>__buildProbe.phase='after-builds');await p.waitForTimeout(Number(process.env.BUILD_SETTLE_MS||20000));
 const result=await p.evaluate(()=>{__buildProbe.enabled=false;return{probe:__buildProbe,sessions:Object.values(__buildQA.MatchLifecycle.singleMatch.sessions).map(s=>({role:s.role,tick:s.sim.tick,tps:s.sim.tps,fatal:s.simulationFatalInfo,decks:s.sim.decks,defenseCards:s.sim.defenseCards,orders:(s.sim.constructionOrders||[]).map(o=>({...o})),receipts:s.sim.commandReceipts.filter(c=>c.type==='BUILD'),buildings:s.sim.buildings.filter(b=>b.produceType==='swordsman').map(b=>({id:b.id,side:b.side,complete:b.complete,x:b.x,y:b.y})),metrics:s.netcodeSession.metrics,nav:s.sim.navigation.metrics}))}});
 result.authorityCheck=await p.evaluate(point=>{
  const q=__buildQA,live=q.MatchLifecycle.activeSession().sim;
  const sim=new q.StrategySim({decks:{host:live.decks[0],guest:live.decks[1]},defenseCards:{host:live.defenseCards[0],guest:live.defenseCards[1]}},20261003,live.rules);
  sim.units=sim.units.filter(u=>u.side!==0);sim.rebuildRuntimeIndexes();
  const action={type:'BUILD',building:'barracks',produceType:'swordsman',x:point.wx,y:point.wy};
  const wallet=sim.wallet[0],count=sim.buildings.length;
  const preview=q.BuildingPresentation.buildValidation(sim.snapshot(),0,{...action});
  const applied=sim.applyCommand('host',action);
  return{preview,applied,unchanged:wallet===sim.wallet[0]&&count===sim.buildings.length};
 },points[0]);
 if(!process.env.QA_ALLOW_PREVIEW_MESH)assert.equal(result.authorityCheck.preview,null,'Placement preview does not run worker reachability');
 assert.equal(result.authorityCheck.applied,false,'Authoritative BUILD rejects unreachable/no-worker request');
 assert.equal(result.authorityCheck.unchanged,true,'Rejected BUILD changes neither resources nor buildings');
 result.mapHash=await p.evaluate(()=>RallyNetcode.hashBytes(new TextEncoder().encode(JSON.stringify(__buildQA.MatchLifecycle.activeSession().sim.mapDescriptor))));
 result.fixture={seed:20261003,requestedClickGapMs:Number(process.env.BUILD_GAP_MS||400),startingResources:10000,aiStopped:true,nativeCanvasClicks:true,touch:!!process.env.QA_MOBILE};result.errors=errors;result.points=points;result.clickTimes=clickTimes;
 const work=result.probe.records.filter(x=>x.phase!=='baseline'),frames=result.probe.frames.filter(x=>x.phase!=='baseline').map(x=>x.ms).sort((a,b)=>a-b);
 result.measurement={window:'five native clicks plus '+Number(process.env.BUILD_SETTLE_MS||20000)+'ms settle; includes real construction arrival',work:Object.fromEntries(['sim.step','sim.startConstructionOrder','nav.rebuild','graph.connect','collision.recover','sim.BUILD','nav.field','nav.astar'].map(label=>{const a=work.filter(x=>x.label===label);return[label,{calls:a.length,totalMs:a.reduce((s,x)=>s+x.ms,0),maxMs:Math.max(0,...a.map(x=>x.ms))}]})),frameMaxMs:frames.at(-1),frameP95Ms:frames[Math.floor(frames.length*.95)]};
 const name=process.env.PROBE_NAME||'run';fs.writeFileSync('.qa/five-builds/'+name+'.json',JSON.stringify(result,null,2));await p.screenshot({path:'.qa/five-builds/'+name+'.png'});
 const summary={measurement:result.measurement,initializations:result.probe.initializations,constructionTransitions:result.probe.constructionTransitions,clickGaps:clickTimes.slice(1).map((t,i)=>t-clickTimes[i]),commands:result.probe.commands,sessions:result.sessions.map(s=>({role:s.role,tick:s.tick,receipts:s.receipts,nav:s.nav,rollbacks:s.metrics.rollbacks})),top:result.probe.records.sort((a,b)=>b.ms-a.ms).slice(0,20),longtasks:result.probe.longtasks,errors};console.log(JSON.stringify(summary,null,2));
 assert.ok(result.sessions.every(s=>!s.fatal&&s.metrics.hashMismatches===0),'Both peers remain healthy');const lastClickTick=Math.max(...result.probe.commands.filter(c=>c.role==='host').map(c=>c.tick));assert.ok(result.sessions.every(s=>s.tick>lastClickTick+Number(process.env.BUILD_SETTLE_MS||20000)/1000*s.tps*.75),'Both peers keep advancing after the command burst');assert.equal(result.probe.commands.filter(c=>c.role==='host').length,5);assert.equal(result.probe.commands.filter(c=>c.role==='guest').length,0,'No AI build may enter even during startup');if(!process.env.QA_ALLOW_WORKER_FIELD)assert.equal(result.probe.fieldCalls.filter(c=>c.unitType==='worker').length,0,'Worker queries never enter shared fields');assert.ok(result.sessions.every(s=>s.buildings.filter(b=>b.side===0).length===5),'All five actual buildings must start inside the measurement window');assert.ok(result.sessions.every(s=>s.orders.filter(o=>o.side===0).length===0),'No pending order hides deferred cost outside the window');assert.deepEqual(errors,[]);if(!process.env.QA_ALLOW_PREVIEW_MESH)assert.equal(result.probe.records.filter(r=>r.label==='mesh.build'&&r.context==='ui-preview').length,0,'Preview never builds navigation meshes');
 }finally{await b.close()}})().catch(e=>{console.error(e);process.exit(1)});
