const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
let html=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const end=html.lastIndexOf('})();');html=html.slice(0,end)+';window.__checkpoint={StrategySim,GameRuleDefinition,MovementComponent,RallySimulationAdapter,RallyStateCodec,NavigationGoal,UnitDefinition,WorldContext,TerrainNavigation,StateValue,SIM_VERSION};'+html.slice(end);
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://route-checkpoint.test/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('http://route-checkpoint.test/');await page.waitForFunction(()=>window.__checkpoint);
  const result=await page.evaluate(()=>{
    const q=__checkpoint,check=(v,m)=>{if(!v)throw Error(m)},equal=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
    const seed=20261015,rules=q.GameRuleDefinition.current;
    const rect=(id,x0,y0,x1,y1)=>({id,points:[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]});
    const map=q.StateValue.freeze({width:3072,height:3072,terrain:{blockers:[rect('route-checkpoint-wall',1250,200,1350,2300)]}});
    const createSim=()=>{
      const sim=new q.StrategySim({decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},seed,rules);
      sim.mapDescriptor=map;sim.world=q.WorldContext.fromMap(map);sim.buildings=[];sim.navigationRevision=0;sim.navigation=new q.TerrainNavigation(sim);
      let workers=sim.units.filter(u=>q.UnitDefinition.get(u.type)?.economyWorker);
      while(workers.length<20)workers.push(sim.spawnUnit(0,'worker',830+(workers.length%4)*8,1390+Math.floor(workers.length/4)*8));
      workers=workers.slice(0,20);sim.units=workers;sim.rebuildRuntimeIndexes();
      workers.forEach((u,i)=>{u.x=830+(i%4)*8;u.y=1390+Math.floor(i/4)*8;u.fx=Math.round(u.x*100);u.fy=Math.round(u.y*100);u.movement.routes=[];u.movement.routeIndex=-1});
      return{sim,workers};
    };
    check(q.SIM_VERSION===199&&q.RallyStateCodec.schemaVersion===4,'SIM and checkpoint schemas must advance');
    const {sim,workers}=createSim(),goal=q.NavigationGoal.point(1800,1500);sim.navigation.sync();
    const originSim=createSim().sim;originSim.navigation.sync();
    const routeFrom=(x,y)=>originSim.navigation.movementPlan({type:'worker',x,y},goal),northStart={x:900,y:1500},southStart={x:900,y:2500};
    const northPlan=routeFrom(northStart.x,northStart.y),southPlan=routeFrom(southStart.x,southStart.y),northReplay=routeFrom(northStart.x,northStart.y);
    const pathPoints=plan=>plan?.route?.path?.map(p=>[p.x,p.y])||[];
    check(northPlan?.route&&southPlan?.route,'same-goal counterexample must produce two blocked routes');
    check(equal(q.RallyStateCodec.encode(pathPoints(northPlan)),q.RallyStateCodec.encode(pathPoints(northReplay))),'same route origin, goal, planner, and topology must deterministically reconstruct the selected path');
    check(northPlan.planner===southPlan.planner&&JSON.stringify(pathPoints(northPlan))!==JSON.stringify(pathPoints(southPlan)),'goal alone cannot reproduce the selected path from another start');
    const routeOriginProof={goalKey:goal.key,profile:{unitType:'worker',radius:originSim.unitRadius('worker'),ignoreBuildings:false},northStart,southStart,planner:northPlan.planner,northWaypoints:pathPoints(northPlan),southWaypoints:pathPoints(southPlan),sameOriginReplayIdentical:true,goalOnlyReplayDiffers:true};
    const joinsBefore=sim.navigation.metrics.routeJoins||0;
    for(const worker of workers)check(sim.navigation.nextPoint(worker,goal),'every worker must acquire a route or join an existing one');
    const joins=(sim.navigation.metrics.routeJoins||0)-joinsBefore;
    check(joins>0,'same-goal workers must join a shared route');
    const joined=workers.map(u=>u.movement.routes[u.movement.routeIndex]).find(r=>r?.routeRecipe?.kind==='join');
    check(joined,'fixture must produce a semantic join recipe');
    const joinedPath=sim.routePathStore.get(joined.pathId),rootPath=sim.routePathStore.get(joinedPath.rootPathId);
    check(rootPath&&joinedPath.tailId===rootPath.id&&joinedPath.length>joinedPath.points.length/2,'joined runtime route must reuse its root suffix');
    const adapter=new q.RallySimulationAdapter({sim}),state=sim.exportState(),bytes=adapter.save(),wire=q.RallyStateCodec.decode(bytes);
    check(!['routePaths','routeProfiles','routeTopologies','nextRoutePathId','nextRouteProfileId','nextRouteTopologyId'].some(k=>Object.hasOwn(wire.state,k)),'checkpoints must omit runtime route tables and allocators');
    check(!['routePaths','routeProfiles','routeTopologies','nextRoutePathId','routePathStore','routePathIndex'].some(k=>Object.hasOwn(state,k)),'state export must omit runtime route cache');
    const savedWorkers=wire.state.units.filter(u=>q.UnitDefinition.get(u.type)?.economyWorker),savedRoutes=savedWorkers.flatMap(u=>u.movement.routes);
    check(savedWorkers.length===20&&savedRoutes.length===20,'fixture must checkpoint all twenty workers');
    check(savedRoutes.every(r=>Object.keys(r).sort().join(',')==='cursor,legX,legY,recipe,retained'),'unit state must contain only semantic route acquisition data and follow state');
    const decodedRecipes=savedRoutes.map(r=>q.MovementComponent.decodeRouteRecipe(r.recipe));
    check(decodedRecipes.some(r=>r.kind==='join')&&decodedRecipes.some(r=>r.kind==='plan'),'checkpoint must retain both root and joined route recipes');
    check(savedRoutes.every(r=>!Object.hasOwn(r,'pathId')),'runtime path IDs must not cross the checkpoint boundary');
    check(equal(q.RallyStateCodec.encode(state.units),q.RallyStateCodec.encode(wire.state.units)),'state export and decoded unit state must agree');
    const snapshot=sim.snapshot();check(!Object.hasOwn(snapshot,'routePaths')&&!Object.hasOwn(snapshot,'nextRoutePathId'),'UI snapshot must omit runtime route bodies and allocators');
    const beforeBody=adapter.save();
    const extraPoints=Array.from({length:4013},(_,i)=>({x:300+(i%100),y:300+Math.floor(i/100)}));
    const extraGoal=q.NavigationGoal.point(2000,2000),radius=sim.unitRadius(workers[0].type),extraRecipe={kind:'plan',key:extraGoal.key,radius,ignore:false,fromX:300,fromY:300,revision:sim.navigationRevision,planner:'flow-field'};
    sim.internRoutePath({key:extraGoal.key,radius,ignore:false,points:extraPoints,tailId:null,tailStart:0,topology:'[]',recipe:extraRecipe});
    check(equal(beforeBody,adapter.save()),'unused runtime path body length must not change checkpoint bytes');
    check(JSON.stringify(sim.exportState())===JSON.stringify(state),'saving and runtime cache growth must not mutate authoritative state');

    const baselineState=JSON.stringify(sim.exportState()),badCases=[];
    const joinedUnit=savedWorkers.find(u=>u.movement.routes.some(r=>q.MovementComponent.decodeRouteRecipe(r.recipe).kind==='join')),routeAt=(copy,id)=>copy.state.units.find(u=>u.id===id).movement.routes[0];
    const cases=[
      ['legacy route paths',s=>s.state.routePaths=[]],['legacy profiles',s=>s.state.routeProfiles=[]],['legacy topologies',s=>s.state.routeTopologies=[]],
      ['path ID allocator',s=>s.state.nextRoutePathId=1],['profile allocator',s=>s.state.nextRouteProfileId=1],['topology allocator',s=>s.state.nextRouteTopologyId=1],
      ['invalid cursor',s=>routeAt(s,workers[0].id).cursor=99999],['invalid leg',s=>routeAt(s,workers[0].id).legX=-1],
      ['invalid goal key',s=>routeAt(s,workers[0].id).recipe[1]='1:2:3:4:1'],
      ['unsupported recipe tag',s=>routeAt(s,workers[0].id).recipe.push(99)],
      ['extra runtime path ID',s=>routeAt(s,workers[0].id).pathId=1],
      ['invalid join root planner',s=>routeAt(s,joinedUnit.id).recipe[8]=99],
      ['invalid route index',s=>s.state.units.find(u=>u.id===workers[0].id).movement.routeIndex=3]
    ];
    for(const [name,mutate]of cases){const copy=structuredClone(wire);mutate(copy);let rejected=false;try{adapter.readSnapshot(q.RallyStateCodec.encode(copy))}catch{rejected=true}check(rejected,name+' must be rejected');check(JSON.stringify(sim.exportState())===baselineState,'rejected snapshot must not mutate live simulation');badCases.push(name)}
    const huge=Array.from({length:25},()=>new Array(20000).fill(0));let budgetRejected=false;try{q.RallyStateCodec.assertData(huge)}catch{budgetRejected=true}
    check(budgetRejected,'the 500000-node codec ceiling must remain enforced');badCases.push('500000-node codec budget');

    adapter.load(bytes);check(equal(adapter.save(),bytes),'warm save-load-save must produce identical bytes');
    const cold=createSim(),coldAdapter=new q.RallySimulationAdapter({sim:cold.sim});coldAdapter.load(bytes);
    check(equal(coldAdapter.save(),bytes),'cold save-load-save must produce identical bytes');
    check(cold.sim.navigationRevision===sim.navigationRevision,'cold restore must preserve the authoritative obstacle revision');
    const restoredWorkers=sim.units.filter(u=>q.UnitDefinition.get(u.type)?.economyWorker),coldWorkers=cold.sim.units.filter(u=>q.UnitDefinition.get(u.type)?.economyWorker);
    check(coldWorkers.every(u=>u.movement.routes.every(r=>Number.isSafeInteger(r.pathId))),'cold restore must bind runtime-only handles');
    const coldHandles={store:cold.sim.routePathStore.size,routeIndex:coldWorkers.map(u=>u.movement.routeIndex),paths:coldWorkers.map(u=>u.movement.routes.map(r=>[r.pathId,cold.sim.routePathStore.has(r.pathId)]))};
    const warmLookups=sim.navigation.metrics.routeCacheLookups||0,coldLookups=cold.sim.navigation.metrics.routeCacheLookups||0;
    for(let tick=0;tick<18;tick++){
      sim.tick++;cold.sim.tick++;
      for(let i=0;i<restoredWorkers.length;i++){
        const a=restoredWorkers[i],b=coldWorkers[i],pa=sim.navigation.nextPoint(a,goal),pb=cold.sim.navigation.nextPoint(b,goal);
        check(pa&&pb&&pa.x===pb.x&&pa.y===pb.y,'warm and cold route following must choose the same point');
        const distance=Math.hypot(pa.x-a.x,pa.y-a.y),step=Math.min(distance,7);if(step){a.x+=(pa.x-a.x)/distance*step;a.y+=(pa.y-a.y)/distance*step;a.fx=Math.round(a.x*100);a.fy=Math.round(a.y*100);b.x=a.x;b.y=a.y;b.fx=a.fx;b.fy=a.fy}
        check(a.movement.routes[a.movement.routeIndex].cursor===b.movement.routes[b.movement.routeIndex].cursor,'warm and cold cursors must match');
      }
      check(sim.checksum()===cold.sim.checksum(),'warm and cold authoritative state must remain deterministic');
    }
    check((sim.navigation.metrics.routeCacheLookups||0)===warmLookups&&(cold.sim.navigation.metrics.routeCacheLookups||0)===coldLookups,`normal following after restore must not reacquire routes: warm ${warmLookups}->${sim.navigation.metrics.routeCacheLookups||0}, cold ${coldLookups}->${cold.sim.navigation.metrics.routeCacheLookups||0}, handles ${JSON.stringify(coldHandles)}, invalid ${JSON.stringify(Object.fromEntries(Object.entries(cold.sim.navigation.metrics).filter(([k])=>k.startsWith('routeInvalid_'))))}`);
    return{pass:true,simVersion:q.SIM_VERSION,schemaVersion:q.RallyStateCodec.schemaVersion,workers:savedWorkers.length,joinedWorkers:decodedRecipes.filter(r=>r.kind==='join').length,rootRecipeWorkers:decodedRecipes.filter(r=>r.kind==='plan').length,joinAcquisitions:joins,rootPoints:rootPath.length,joinedPrefixPoints:joinedPath.points.length/2,sharedSuffixPoints:joinedPath.length-joinedPath.points.length/2,routeOriginProof,checkpointBytes:bytes.length,badCases,coldRestore:'save-load-save identical; runtime handles rebound; 18 ticks checksum-identical',normalFollowAcquisitions:0};
  });
  assert.deepEqual(errors,[]);const out=path.join(root,'.qa/route-checkpoint');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...result,errors},null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
