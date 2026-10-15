const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
let html=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const end=html.lastIndexOf('})();');html=html.slice(0,end)+';window.__checkpoint={StrategySim,GameRuleDefinition,MovementComponent,RallySimulationAdapter,RallyStateCodec,NavigationGoal,UnitDefinition,SIM_VERSION};'+html.slice(end);
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://route-checkpoint.test/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('http://route-checkpoint.test/');await page.waitForFunction(()=>window.__checkpoint);
  const result=await page.evaluate(()=>{
    const q=__checkpoint,check=(v,m)=>{if(!v)throw Error(m)},sim=new q.StrategySim({decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},20261015,q.GameRuleDefinition.current),workers=sim.units.filter(u=>q.UnitDefinition.get(u.type)?.economyWorker),worker=workers[0];
    check(q.SIM_VERSION===198&&q.RallyStateCodec.schemaVersion===3,'SIM and checkpoint schemas must advance');
    const goal=q.NavigationGoal.point(worker.x+45,worker.y+15),radius=sim.unitRadius(worker.type),points=[];
    for(let i=0;i<4013;i++)points.push({x:worker.x-5+(i%100)*.1,y:worker.y-3+Math.floor(i/100)*.01+(i%7)/997});
    sim.navigation.sync();const key=goal.key,rootDraft={key,radius,ignore:false,points,tailId:null,tailStart:0,length:points.length},rootTopology=sim.navigation.routeTopology(rootDraft),rootId=sim.internRoutePath({...rootDraft,topology:rootTopology});
    const duplicateId=sim.internRoutePath({...rootDraft,topology:rootTopology});
    check(rootId===duplicateId,'Identical immutable roots must intern to one path ID');
    const childPoints=[{x:worker.x,y:worker.y},{x:worker.x+1,y:worker.y+1}],childDraft={key,radius,ignore:false,points:childPoints,tailId:rootId,tailStart:200,length:childPoints.length+points.length-200},childTopology=sim.navigation.routeTopology(childDraft),childId=sim.internRoutePath({...childDraft,topology:childTopology});
    const makeRef=(pathId,cursor,x,y)=>({pathId,cursor,legX:x,legY:y,retained:true});
    for(const [i,u]of workers.entries()){u.movement.routes=[makeRef(i===0?childId:rootId,i===0?2:i+1,worker.x+i/7,worker.y+i/11)];u.movement.routeIndex=0}
    const adapter=new q.RallySimulationAdapter({sim}),before=JSON.stringify(sim.exportState()),bytes=adapter.save(),wire=q.RallyStateCodec.decode(bytes),decoded=adapter.readSnapshot(bytes);
    const tables=wire.state.routePaths.flat(),body=id=>tables.find(row=>row[0]===id);
    check(tables.length===2,'Root and joined prefix must be saved once in the path table');
check(body(childId)[3].length===4&&body(childId)[4]===rootId&&body(childId)[5]===200,'Joined path must store only its prefix and root ID/offset');
check(wire.state.routeProfiles.flat().length===1&&body(rootId)[1]===body(childId)[1],'Identical movement profiles must be stored once and referenced by ID');
check(wire.state.routeTopologies.flat().length===1&&body(rootId)[2]===body(childId)[2],'Identical exact obstacle topology must be stored once and referenced by ID');
    check(workers.every(u=>u.movement.routes[0].pathId===rootId||u.movement.routes[0].pathId===childId),'Units must reference shared bodies');
    check(workers.every(u=>Object.keys(u.movement.routes[0]).sort().join(',')==='cursor,legX,legY,pathId,retained'),'Unit route state must contain only a handle and cursor');
    check(BufferLikeEqual(q.RallyStateCodec.encode(decoded.units),q.RallyStateCodec.encode(sim.exportState().units)),'Decoded units must preserve every route reference and Number');
    check(BufferLikeEqual(q.RallyStateCodec.encode(decoded.routePaths),q.RallyStateCodec.encode(sim.exportState().routePaths)),'Decoded immutable path table must preserve every waypoint');
check(BufferLikeEqual(q.RallyStateCodec.encode(decoded.routeProfiles),q.RallyStateCodec.encode(sim.exportState().routeProfiles)),'Decoded profile table must preserve exact route requirements');
check(BufferLikeEqual(q.RallyStateCodec.encode(decoded.routeTopologies),q.RallyStateCodec.encode(sim.exportState().routeTopologies)),'Decoded exact topology table must preserve every obstacle signature');
    check(JSON.stringify(sim.exportState())===before,'Saving must not mutate or alias live route state');
    const rawBytes=q.RallyStateCodec.encode({schemaVersion:3,simVersion:wire.simVersion,matchId:wire.matchId,mapFingerprint:wire.mapFingerprint,state:sim.exportState({includeIdentity:false})}).length;
    const cases=[];for(const [name,mutate]of [
      ['missing path table',s=>delete s.state.routePaths],
      ['missing profile table',s=>delete s.state.routeProfiles],
      ['missing topology table',s=>delete s.state.routeTopologies],
      ['unknown path reference',s=>s.state.units.find(u=>u.id===worker.id).movement.routes[0].pathId=999999],
      ['invalid cursor',s=>s.state.units.find(u=>u.id===worker.id).movement.routes[0].cursor=99999],
      ['invalid leg',s=>s.state.units.find(u=>u.id===worker.id).movement.routes[0].legX=-1],
      ['invalid allocator',s=>s.state.nextRoutePathId=rootId],
['unknown topology reference',s=>bodyIn(s,rootId)[2]=999999],
['invalid topology allocator',s=>s.state.nextRouteTopologyId=bodyIn(s,rootId)[2]],
['unknown profile reference',s=>bodyIn(s,rootId)[1]=999999],
['invalid profile allocator',s=>s.state.nextRouteProfileId=wire.state.routeProfiles.flat()[0][0]],
['unused profile record',s=>{const row=[s.state.nextRouteProfileId++,q.NavigationGoal.point(1220,1190).key,radius,false];s.state.routeProfiles.at(-1).push(row)}],
      ['unknown tail root',s=>bodyIn(s,childId)[4]=999999],
      ['nested tail',s=>bodyIn(s,childId)[4]=childId],
      ['tail offset',s=>bodyIn(s,childId)[5]=4013],
['invalid waypoint',s=>bodyIn(s,rootId)[3][0]=-1],
['noncanonical waypoint',s=>bodyIn(s,rootId)[3].push(0)],
      ['noncanonical handle',s=>s.state.units.find(u=>u.id===worker.id).movement.routes[0].points=[]],
      ['unused path body',s=>{const row=structuredClone(bodyIn(s,rootId));row[0]=s.state.nextRoutePathId++;s.state.routePaths.at(-1).push(row)}],
['unused topology body',s=>{s.state.routeTopologies[0].push([s.state.nextRouteTopologyId++,'[["unused","building",1,2,3,false]]'])}],
      ['bad route index',s=>s.state.units.find(u=>u.id===worker.id).movement.routeIndex=1]
    ]){const copy=structuredClone(wire);mutate(copy);let rejected=false;try{adapter.readSnapshot(q.RallyStateCodec.encode(copy))}catch{rejected=true}check(rejected,name+' must be rejected before state mutation');check(JSON.stringify(sim.exportState())===before,'Rejected bytes must leave live route state intact');cases.push(name)}
const oversized=structuredClone(wire),oversizePoints=Array.from({length:38000},(_,i)=>i%2?1+Math.floor(i/2)/3070|0:1+Math.floor(i/2)%3070),largePaths=[],largeProfiles=[];
for(let i=0;i<14;i++){const key=q.NavigationGoal.point(1000+i*10,1000).key;largeProfiles.push([i+1,key,radius,false]);largePaths.push([i+1,i+1,1,oversizePoints.slice(),null,0])}
oversized.state.routePaths=[largePaths];oversized.state.nextRoutePathId=15;oversized.state.routeProfiles=[largeProfiles];oversized.state.nextRouteProfileId=15;oversized.state.routeTopologies=[[[1,'[]']]];oversized.state.nextRouteTopologyId=2;
for(const u of oversized.state.units){u.movement.routes=[];u.movement.routeIndex=-1}
for(let i=0;i<largePaths.length;i++){const u=oversized.state.units.find(x=>x.id===workers[Math.floor(i/3)].id);u.movement.routes.push({pathId:i+1,cursor:1,legX:worker.x,legY:worker.y,retained:true});u.movement.routeIndex=0}
let budgetRejected=false;try{q.RallyStateCodec.assertData(oversized)}catch{budgetRejected=true}check(budgetRejected,'The original 500000-node codec ceiling must remain enforced');cases.push('500000-node codec budget');
    adapter.load(bytes);check(BufferLikeEqual(adapter.save(),bytes),'Save-load-save must produce identical bytes');
    const detached=sim.exportState();detached.units[0].movement.routes.length=0;detached.routePaths[0][0][3][0]=-100;
check(sim.units[0].movement.routes.length===1&&sim.routePathStore.get(rootId).points[0]!==-100,'Export must detach both handles and common path bodies');
const snapshot=sim.snapshot();check(snapshot.nextRoutePathId===sim.nextRoutePathId&&snapshot.routePaths.length===1&&snapshot.nextRouteProfileId===sim.nextRouteProfileId&&snapshot.routeProfiles.length===1&&snapshot.nextRouteTopologyId===sim.nextRouteTopologyId&&snapshot.routeTopologies.length===1,'UI snapshot must carry complete route, profile, and topology tables with allocators');
    function bodyIn(snapshot,id){return snapshot.state.routePaths.flat().find(row=>row[0]===id)}
    function BufferLikeEqual(a,b){return a.length===b.length&&a.every((v,i)=>v===b[i])}
return{pass:true,simVersion:q.SIM_VERSION,routeBodies:tables.length,routeProfiles:wire.state.routeProfiles.flat().length,units:workers.length,rootPoints:points.length,sharedSuffixPoints:points.length-200,childPrefixPoints:body(childId)[3].length/2,cases,rawBytes,checkpointBytes:bytes.length,snapshotPaths:snapshot.routePaths.flat().length,snapshotProfiles:snapshot.routeProfiles.flat().length,snapshotTopologies:snapshot.routeTopologies.flat().length};
  });assert.deepEqual(errors,[]);const out=path.join(root,'.qa/route-checkpoint');fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...result,errors},null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close()}})().catch(error=>{console.error(error);process.exitCode=1});
