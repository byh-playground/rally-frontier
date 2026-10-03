const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
(async()=>{
 const source=fs.readFileSync(path.resolve(__dirname,'../index.html'),'utf8'),end=source.lastIndexOf('})();');
 const html=source.slice(0,end)+'window.__ordersQA={StrategySim,GameRuleDefinition,BuildingDefinition,UnitDefinition,RallySimulationAdapter,RallyStateCodec,Building,InteractionGeometry,WorldContext,TerrainNavigation,FP};'+source.slice(end);
 const browser=await chromium.launch({channel:'msedge',headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://orders.test/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('http://orders.test');await page.waitForFunction(()=>window.__ordersQA);
  const result=await page.evaluate(()=>{
   const {StrategySim,GameRuleDefinition,BuildingDefinition,UnitDefinition,RallySimulationAdapter,RallyStateCodec,Building,InteractionGeometry,WorldContext,TerrainNavigation,FP}=window.__ordersQA;
   const check=(v,m)=>{if(!v)throw Error(m)},draft={decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}};
   const rules=GameRuleDefinition.resolve({overrides:{map:{generator:'fixed-standard'},economy:{startingResources:{minerals:10000,gas:10000}}}});
   const make=()=>{const sim=new StrategySim(draft,831047,rules);sim.units=sim.units.filter(u=>UnitDefinition.get(u.type)?.economyWorker);sim.rebuildRuntimeIndexes();sim.productionPaused=[true,true];return sim};
   const sim=make(),adapter=new RallySimulationAdapter({sim}),base=sim.buildings.find(b=>b.side===0&&BuildingDefinition.get(b.type)?.isMainBase),initialBuildings=sim.buildings.length;
   let action=null;
   outer:for(let radius=220;radius<=500;radius+=40)for(let i=0;i<24;i++){
    const candidate={type:'BUILD',building:'barracks',produceType:'swordsman',x:Math.round(base.x+Math.cos(i*Math.PI/12)*radius),y:Math.round(base.y+Math.sin(i*Math.PI/12)*radius)};
    if(sim.applyCommand('host',candidate)){action=candidate;break outer}
   }
   check(action,'Find an accepted real construction site');const order=sim.constructionOrders[0],paid=order.paidMineral,id=order.id;
   check(sim.buildings.length===initialBuildings&&sim.wallet[0]===10000-paid,'Upfront charge without physical building');
   check(!sim.applyCommand('host',action),'Reservation prevents overlapping orders');
   const snapshot=sim.snapshot();snapshot.constructionOrders[0].x++;check(order.x!==snapshot.constructionOrders[0].x,'Render snapshot isolated');
   const saved=adapter.save();check(adapter.validateSnapshot(saved),'Order binary snapshot is valid');
   for(const mutate of [s=>s.constructionOrders[0].paidMineral=-1,s=>s.constructionOrders[0].id=s.buildings[0].id,s=>s.constructionOrders[0].builderUnitId='missing',s=>s.constructionOrders[0].renderRadius=20]){
    const envelope=RallyStateCodec.decode(saved);mutate(envelope.state);check(!adapter.validateSnapshot(RallyStateCodec.encode(envelope)),'Reject corrupt order state');
   }
   check(sim.applyCommand('host',{type:'CANCEL_BUILDING',buildingId:id})&&sim.wallet[0]===10000&&!sim.constructionOrders.length,'Full exact prestart refund');
   check(!sim.applyCommand('host',{type:'CANCEL_BUILDING',buildingId:id}),'No repeated refund');
   adapter.load(saved);check(sim.resolveConstructionTarget(id)===sim.constructionOrders[0],'Rollback restores order target');
   const twin=make();twin.importState(sim.exportState());let started=-1;
   for(let t=0;t<400;t++){
    sim.step();twin.step();check(JSON.stringify(sim.exportState())===JSON.stringify(twin.exportState()),'Restored simulation matches each tick');
    if(sim.buildings.some(b=>b.id===id)){started=t;break}
   }
   check(started>0&&!sim.constructionOrders.length&&sim.buildings.filter(b=>b.id===id).length===1,'Worker arrival creates one real building');
   const beforeCancel=sim.wallet[0];sim.applyCommand('host',{type:'CANCEL_BUILDING',buildingId:id});check(sim.wallet[0]===beforeCancel+paid*.5,'Started construction retains half refund');
   adapter.load(saved);const dying=sim.units.find(u=>u.id===sim.constructionOrders[0].builderUnitId);sim.emitUnitDeath(dying,1,'swordsman');sim.updateConstructionOrders();check(sim.constructionOrders[0].builderUnitId&&sim.constructionOrders[0].builderUnitId!==dying.id,'Dead builder reassigns order');
   adapter.load(saved);const blocked=sim.constructionOrders[0];sim.buildings.push(new Building({id:'qa-block',type:blocked.type,side:1,x:blocked.x,y:blocked.y,hp:100,maxHp:100,alive:true,complete:true}));sim.markBuildingSpatialDirty();
   const wallet=sim.wallet[0];check(sim.startConstructionOrder(blocked)===null&&!sim.constructionOrders.length&&sim.wallet[0]===wallet+paid,'Blocked arrival cancels and refunds');
   adapter.load(saved);const queued=sim.constructionOrders[0],onlyWorker=sim.units.find(u=>u.id===queued.builderUnitId);sim.units=sim.units.filter(u=>u.side!==0||u===onlyWorker);sim.rebuildRuntimeIndexes();
   outer:for(let radius=220;radius<=500;radius+=40)for(let i=0;i<24;i++){
    const candidate={...action,x:Math.round(base.x+Math.cos(i*Math.PI/12)*radius),y:Math.round(base.y+Math.sin(i*Math.PI/12)*radius)};
    if(sim.applyCommand('host',candidate))break outer;
   }
   check(sim.constructionOrders.length===2&&sim.constructionOrders[1].builderUnitId===null,'Busy worker queues a nonphysical reservation');
   const twoAdapter=new RallySimulationAdapter({sim});check(twoAdapter.validateSnapshot(twoAdapter.save()),'Two-order arrays are not mistaken for fixed side pairs');
   sim.cancelConstructionOrder(queued);sim.updateConstructionOrders();check(sim.constructionOrders[0]?.builderUnitId===onlyWorker.id,'Freed builder claims waiting reservation');
   adapter.load(saved);const centeredOrder=sim.constructionOrders[0],centeredWorker=sim.units.find(u=>u.id===centeredOrder.builderUnitId);
   const place=(u,x,y)=>{u.fx=Math.round(x*FP);u.fy=Math.round(y*FP);u.x=u.fx/FP;u.y=u.fy/FP};
   place(centeredWorker,centeredOrder.x,centeredOrder.y);sim.rebuildRuntimeIndexes();sim.updateConstructionOrders();
   check(sim.constructionOrders.length===1&&!sim.builderCanConstruct(centeredWorker,centeredOrder),'Worker inside reserved footprint cannot start construction');
   let centerExitTicks=0;
   while(sim.constructionOrders.length&&centerExitTicks++<200){sim.updateWorker(centeredWorker);sim.updateConstructionOrders()}
   check(!sim.constructionOrders.length&&Math.hypot(centeredWorker.x-centeredOrder.x,centeredWorker.y-centeredOrder.y)>=InteractionGeometry.buildingClearance(centeredWorker,centeredOrder)-1e-6,'Centered worker exits to a legal workface before building materializes');
   const cliff=make(),cliffWorker=cliff.units.find(u=>u.side===0),cliffOrder={...centeredOrder,id:'qa-cliff-order',x:1000,y:1000,builderUnitId:cliffWorker.id};
   const radius=BuildingDefinition.get(cliffOrder.type).size,wallX=cliffOrder.x-radius-3;
   cliff.world=WorldContext.fromMap({width:2048,height:2048,terrain:{blockers:[{id:'thin-cliff',points:[{x:wallX,y:920},{x:wallX+1,y:920},{x:wallX+1,y:1080},{x:wallX,y:1080}]}]}});
   cliff.buildings=[];cliff.resources=[];cliff.gasNodes=[];cliff.units=[cliffWorker];cliff.constructionOrders=[cliffOrder];cliffWorker.buildTargetId=cliffOrder.id;
   cliff.navigation=new TerrainNavigation(cliff);cliff.rebuildRuntimeIndexes();place(cliffWorker,cliffOrder.x-InteractionGeometry.reach(cliffWorker,cliffOrder,'worker-build')+.1,cliffOrder.y);
   check(InteractionGeometry.region(cliffWorker,cliffOrder,'worker-build').contains(cliffWorker.x,cliffWorker.y),'Cliff fixture starts within distance bounds');
   cliff.updateConstructionOrders();check(cliff.constructionOrders.length===1&&!cliff.builderCanConstruct(cliffWorker,cliffOrder),'Thin cliff blocks work despite distance bounds');
   let cliffTravelTicks=0;
   while(cliff.constructionOrders.length&&cliffTravelTicks++<300){cliff.updateWorker(cliffWorker);cliff.updateConstructionOrders()}
   check(!cliff.constructionOrders.length&&cliff.buildings.some(b=>b.id===cliffOrder.id)&&cliff.world.terrain.segmentClear(cliffWorker.x,cliffWorker.y,cliffOrder.x,cliffOrder.y,0),'Worker paths around cliff before actual construction starts');
   const noWorkers=make();noWorkers.units=noWorkers.units.filter(u=>u.side!==0);noWorkers.rebuildRuntimeIndexes();check(!noWorkers.applyCommand('host',action)&&noWorkers.wallet[0]===10000,'No-worker rejection retains funds');
   return {arrivalTick:started+1,upfrontCharge:paid,rollbackTicksCompared:started+1,corruptSnapshotsRejected:4,prestartRefund:paid,startedRefund:paid*.5,centerExitTicks,cliffTravelTicks};
  });
  assert.deepEqual(errors,[]);console.log(JSON.stringify({result,errors},null,2));
 }finally{await browser.close()}
})().catch(e=>{console.error(e);process.exitCode=1});
