/* Complete production nextPoint query cost; mesh construction is outside timers.
 * Browser JIT is warmed separately. Every cold batch resets query-derived caches,
 * then the exact same N-query batch is immediately repeated without a reset.
 */
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),os=require('node:os'),cp=require('node:child_process');
const {chromium}=require('playwright');
const {installFixture}=require('./ground-planner-fixture.cjs');
const root=path.resolve(__dirname,'..'),args=process.argv.slice(2),opt=(k,d)=>{const i=args.indexOf('--'+k);return i<0?d:args[i+1]};
const config={distance:opt('distance','far'),counts:opt('counts','1,2,5,10,20,50,100,200,400').split(',').map(Number),complexities:opt('complexities','low,medium,high').split(','),patterns:opt('patterns','same,distinct').split(','),smallRuns:Number(opt('small-runs','12')),largeRuns:Number(opt('large-runs','3')),output:path.resolve(opt('output',path.join(root,'.qa','ground-query')))};
assert(['near','far'].includes(config.distance));
assert(config.counts.every(n=>Number.isInteger(n)&&n>=1&&n<=400));
assert(config.complexities.every(c=>['low','medium','high'].includes(c)));
assert(config.patterns.every(p=>['same','distinct'].includes(p)));
assert(config.smallRuns>0&&config.largeRuns>0);
const modes=['astar','shared-astar','flow-field'];
const hash=x=>crypto.createHash('sha256').update(JSON.stringify(x)).digest('hex');
const stats=values=>{const a=values.slice().sort((x,y)=>x-y),q=p=>{const i=(a.length-1)*p,k=Math.floor(i);return a[k]+(a[Math.ceil(i)]-a[k])*(i-k)};return {n:a.length,median:q(.5),q1:q(.25),q3:q(.75),iqr:q(.75)-q(.25),min:a[0],max:a.at(-1)}};
function instrument(cfg){
  const {initialPoints}=installFixture(cfg);
  const q=window.__queryBench={MatchLifecycle,ready:false};
  const start=GameSession.prototype.startSim;
  GameSession.prototype.startSim=function(){const result=start.call(this,20261003);if(this.role==='host'){q.sim=this.sim;q.points=initialPoints.get(this.sim)}return result};
  const ensure=(ok,message)=>{if(!ok)throw Error(message)};
  q.reset=nav=>{for(const layer of nav.layers.values()){layer.fields.clear();layer.goals.clear();layer.sharedPaths?.clear();delete layer.astarScratch}nav.metrics.sharedAstarCachedNodes=0};
  q.graph=layer=>({cells:layer.cells.map(c=>c&&({id:c.id,component:c.component,points:c.points})),portals:layer.portals,fieldNodes:layer.fieldNodes});
  q.isolate=()=>{
    const host=MatchLifecycle.singleMatch.sessions.host,original=host.sim,radius=original.unitRadius(cfg.unit)+.12;
    const sim=StrategySim.createForMatch({draft:host.draft,seed:20261003,rules:host.roundRules,debugScenario:host.matchConfig.debugScenario});
    sim.navigation.prepareLayers(sim.units,sim.decks.flat());
    ensure(sim.checksum()===original.checksum(),'Independent fixture authority differs from native session');
    ensure(JSON.stringify(q.graph(sim.navigation.layer(radius)))===JSON.stringify(q.graph(original.navigation.layer(radius))),'Independent fixture graph differs from native session');
    q.sim=sim;q.points=initialPoints.get(sim);q.isolated=true;
    MatchLifecycle.disposeMatches('query-benchmark-isolation');
    ensure(!sim.disposed&&original.disposed,'Fixture lifecycle isolation failed');
    return {authorityEqual:true,graphEqual:true,originalDisposed:original.disposed,querySimDisposed:!!sim.disposed,renderCallbacksSuppressed:true};
  };
  q.prepare=()=>{
    const sim=q.sim,nav=sim.navigation,radius=sim.unitRadius(cfg.unit),layer=nav.layer(radius+.12);
    // Greedy farthest-first ordering gives a spatially dispersed deterministic prefix.
    // Start at the most central member, then break equal-distance ties by roster index.
    const queryPoints=cfg.distance==='near'?q.points.map((p,i)=>({...p,x:780+i%20*8,y:1830+Math.floor(i/20)*5})):q.points;
    const center=queryPoints.reduce((p,v)=>({x:p.x+v.x/400,y:p.y+v.y/400}),{x:0,y:0}),remaining=queryPoints.map((p,i)=>({...p,index:i})),ordered=[];
    remaining.sort((a,b)=>Math.hypot(a.x-center.x,a.y-center.y)-Math.hypot(b.x-center.x,b.y-center.y)||a.index-b.index);
    ordered.push(remaining.shift());
    while(remaining.length){let best=-1,score=-1;for(let i=0;i<remaining.length;i++){const p=remaining[i],d=Math.min(...ordered.map(o=>(o.x-p.x)**2+(o.y-p.y)**2));if(d>score||d===score&&p.index<remaining[best].index){best=i;score=d}}ordered.push(remaining.splice(best,1)[0])}
    q.units=ordered.map(p=>cfg.distance==='near'?{id:p.id,type:p.type,x:p.x,y:p.y}:sim.unitById.get(p.id));
    q.goals=cfg.distance==='near'?{same:ordered.map(()=>NavigationGoal.point(1170,1700)),distinct:ordered.map((_,i)=>NavigationGoal.point(1165+(i%20)*.5,1680+Math.floor(i/20)*2))}:{same:ordered.map(()=>NavigationGoal.point(3500,2400)),distinct:ordered.map((_,i)=>NavigationGoal.point(3405+(i%20)*10,2305+Math.floor(i/20)*10))};
    for(const pattern of ['same','distinct'])for(let i=0;i<400;i++){
      const u=q.units[i],g=q.goals[pattern][i],s=nav.locate(u.x,u.y,layer),t=nav.locate(g.x,g.y,layer);
      ensure(nav.pointClear(u.x,u.y,radius)&&nav.pointClear(g.x,g.y,radius),'Query endpoint is obstructed: '+JSON.stringify({pattern,i,u,g,radius,sourceClear:nav.pointClear(u.x,u.y,radius),goalClear:nav.pointClear(g.x,g.y,radius)}));
      ensure(s&&t&&s.cell.component===t.cell.component,'Disconnected query');
      ensure(!nav.directGoal(u.x,u.y,g,radius,false),'Direct shortcut must be blocked');
    }
    q.nav=nav;q.layer=layer;
    let previous=performance.now(),resolution=Infinity;for(let i=0;i<100000;i++){const now=performance.now();if(now>previous)resolution=Math.min(resolution,now-previous);previous=now}
    const distances=Object.fromEntries(['same','distinct'].map(pattern=>[pattern,{straight:ordered.map((p,i)=>Math.hypot(p.x-q.goals[pattern][i].x,p.y-q.goals[pattern][i].y)),sampledAstarPath:[0,1,2,199,399].map(i=>({index:i,length:nav.plan(ordered[i].x,ordered[i].y,q.goals[pattern][i],radius+.12,false,'astar').length}))}]));
    return {timerResolutionMs:resolution,distances,map:sim.mapDescriptor,roster:q.points,stateHash:sim.checksum(),tps:sim.tps,radius,sources:ordered,goals:q.goals,graph:q.graph(layer),complexity:{blockers:sim.mapDescriptor.terrain.blockers.length,terrainLayers:sim.mapDescriptor.terrain.layers.length,ramps:sim.mapDescriptor.terrain.ramps.length,cells:layer.cellCount,portals:layer.portalCount,nodes:layer.nodeCount,edges:layer.fieldNodes.filter(Boolean).reduce((s,n)=>s+n.links.length,0)},caps:{fields:48,goals:48,sharedGoals:TerrainNavigation.SHARED_ASTAR_GOALS,sharedNodesPerGoal:TerrainNavigation.SHARED_ASTAR_NODES}};
  };
  q.batch=(nav,pattern,n)=>{const points=new Array(n),goals=q.goals[pattern],units=q.units;for(let i=0;i<n;i++)points[i]=nav.nextPoint(units[i],goals[i]);return points};
  q.validate=(points,nav)=>{const goalComponent=nav.locate(3500,2400,q.layer).cell.component;for(const p of points){ensure(p&&Number.isFinite(p.x)&&Number.isFinite(p.y),'Nonfinite or missing nextPoint');const loc=nav.locate(p.x,p.y,q.layer);ensure(loc&&loc.cell.component===goalComponent,'Unreachable waypoint')}};
  q.warmup=()=>{for(const mode of ['astar','shared-astar','flow-field']){UnitDefinition.get(cfg.unit).navigationPlanner=mode;q.reset(q.nav);q.batch(q.nav,'same',400);q.batch(q.nav,'same',400);q.reset(q.nav);q.batch(q.nav,'distinct',20)}q.reset(q.nav)};
  q.verifyFresh=()=>{const results=[];for(const mode of ['astar','shared-astar','flow-field'])for(const pattern of ['same','distinct']){
    UnitDefinition.get(cfg.unit).navigationPlanner=mode;
    const fresh=new TerrainNavigation(q.sim),layer=fresh.layer(q.sim.unitRadius(cfg.unit)+.12),expected=q.batch(fresh,pattern,5);
    q.reset(q.nav);const actual=q.batch(q.nav,pattern,5);ensure(JSON.stringify(expected)===JSON.stringify(actual),'Reset/fresh navigation disagreement');
    results.push({mode,pattern,n:5,equal:true,cells:layer.cellCount,nodes:layer.nodeCount});
  }q.reset(q.nav);return results};
  q.run=(mode,pattern,n)=>{
    UnitDefinition.get(cfg.unit).navigationPlanner=mode;q.reset(q.nav);
    const timed=()=>{const before={...q.nav.metrics},t=performance.now(),points=q.batch(q.nav,pattern,n),ms=performance.now()-t,metrics=Object.fromEntries(Object.entries(q.nav.metrics).filter(([,v])=>typeof v==='number').map(([k,v])=>[k,v-(before[k]||0)]));return {ms,perQueryMs:ms/n,metrics,points,caches:{fields:q.layer.fields.size,goals:q.layer.goals.size,sharedGoals:q.layer.sharedPaths?.size||0,sharedNodes:[...(q.layer.sharedPaths?.values()||[])].reduce((s,c)=>s+c.size,0)}}};
    const cold=timed(),warm=timed();
    ensure(JSON.stringify(cold.points)===JSON.stringify(warm.points),'Cold/warm waypoint disagreement');
    for(const result of [cold,warm]){q.validate(result.points,q.nav);ensure(result.metrics.layersBuilt===0&&result.metrics.meshBuildMs===0&&result.metrics.projectionTilesBuilt===0,'Geometry built inside query timer');ensure(result.metrics.routeQueries===n&&result.metrics.directQueries===0&&result.metrics.unreachable===0,'Unexpected shortcut or unreachable query')}
    ensure(q.sim.tick===0,'Simulation advanced during query benchmark');return {cold,warm};
  };
}
async function fixture(browser,complexity){
  const cfg={complexity,distance:config.distance,count:400,unit:'swordsman',mode:'astar',scenario:'movement'},original=fs.readFileSync(path.join(root,'index.html'),'utf8');
  assert.equal(original.split('canAdvance:()=>!this.simEnded').length,2);
  const source=original.replace('canAdvance:()=>!this.simEnded','canAdvance:()=>false'),end=source.lastIndexOf('})();'),html=source.slice(0,end)+'const installFixture='+installFixture.toString()+';('+instrument.toString()+')('+JSON.stringify(cfg)+');'+source.slice(end);
  const page=await browser.newPage({viewport:{width:1280,height:800}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.addInitScript(()=>{const raf=window.requestAnimationFrame.bind(window);window.requestAnimationFrame=callback=>window.__queryBench?.isolated?0:raf(t=>{if(!window.__queryBench?.isolated)callback(t)})});
  await page.route('https://ground-query.local/',r=>r.fulfill({contentType:'text/html',body:html}));
  await page.goto('https://ground-query.local/');await page.locator('#gameStartBtn').click();await page.locator('#advancedTestSettings summary').click();
  for(const side of ['Ally','Enemy']){await page.locator('#unitTest'+side+'Type').selectOption('swordsman');await page.locator('#unitTest'+side+'Count').fill('1')}
  await page.locator('#unitTestResearch').uncheck();await page.locator('#unitTestBtn').click();await page.locator('#singleHostBtn').click();
  await page.waitForFunction(()=>window.__queryBench?.sim&&Object.keys(__queryBench.MatchLifecycle.singleMatch.sessions).length===2&&Object.values(__queryBench.MatchLifecycle.singleMatch.sessions).every(s=>s.sim&&s.netcodeSession.ready),null,{timeout:60000});
  const isolation=await page.evaluate(()=>__queryBench.isolate()),metadata=await page.evaluate(()=>__queryBench.prepare());metadata.isolation=isolation;metadata.fixtureHash=hash({map:metadata.map,roster:metadata.roster,state:metadata.stateHash,tps:metadata.tps});metadata.graphHash=hash(metadata.graph);delete metadata.graph;metadata.sourceHash=hash(metadata.sources);metadata.goalHashes=Object.fromEntries(Object.entries(metadata.goals).map(([k,v])=>[k,hash(v)]));
  await page.evaluate(()=>__queryBench.warmup());metadata.freshValidation=await page.evaluate(()=>__queryBench.verifyFresh());
  assert.deepEqual(errors,[]);return {page,metadata,errors};
}
(async()=>{
  fs.mkdirSync(config.output,{recursive:true});const browser=await chromium.launch({channel:'msedge',headless:true}),results=[],fixtures={},reference=new Map();
  const report={config,revision:cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim(),sourceHash:hash(fs.readFileSync(path.join(root,'index.html'),'utf8')),browser:browser.version(),machine:{cpu:os.cpus()[0].model,logicalCpus:os.cpus().length,memory:os.totalmem()},method:{api:'TerrainNavigation.nextPoint',simulationTick:0,geometry:'prepared outside timer',cold:'JIT-warm, fields/goals/sharedPaths cleared and astarScratch deleted before each batch',warm:'immediate repeat of only the same N queries; cache caps and eviction unchanged',order:'farthest-first source prefix, same for all modes',unit:'swordsman',fixtureCount:400},fixtures,results};
  const save=()=>{report.summaries=[];for(const complexity of config.complexities)for(const pattern of config.patterns)for(const n of config.counts)for(const mode of modes){const rows=results.filter(r=>r.complexity===complexity&&r.pattern===pattern&&r.n===n&&r.mode===mode);if(rows.length)report.summaries.push({complexity,pattern,n,mode,cold:stats(rows.map(r=>r.cold.ms)),warm:stats(rows.map(r=>r.warm.ms)),coldPerQuery:stats(rows.map(r=>r.cold.perQueryMs)),warmPerQuery:stats(rows.map(r=>r.warm.perQueryMs))})}fs.writeFileSync(path.join(config.output,'results.json'),JSON.stringify(report,null,2))};
  try{for(const complexity of config.complexities){const {page,metadata,errors}=await fixture(browser,complexity);fixtures[complexity]=metadata;console.log(JSON.stringify({ready:complexity,complexity:metadata.complexity,fixtureHash:metadata.fixtureHash}));
    try{for(const pattern of config.patterns)for(const n of config.counts){const runs=n<=10?config.smallRuns:config.largeRuns;
      for(let rep=0;rep<runs;rep++)for(let j=0;j<3;j++){const mode=modes[(j+rep)%3],row=await page.evaluate(({mode,pattern,n})=>__queryBench.run(mode,pattern,n),{mode,pattern,n}),key=[complexity,pattern,n,mode==='flow-field'?mode:'astar'].join('/');
        const waypointHash=hash(row.cold.points);if(reference.has(key))assert.equal(waypointHash,reference.get(key),'Repeat and A*/shared-A* waypoints agree');else reference.set(key,waypointHash);
        for(const cache of ['cold','warm']){row[cache].waypointHash=hash(row[cache].points);delete row[cache].points}results.push({complexity,pattern,n,mode,rep:rep+1,...row});save();
      }
      console.log(JSON.stringify({completed:complexity,pattern,n,runs,medians:report.summaries.filter(r=>r.complexity===complexity&&r.pattern===pattern&&r.n===n).map(r=>({mode:r.mode,cold:r.cold.median,warm:r.warm.median}))}));
    }assert.deepEqual(errors,[])}finally{await page.close()}
  }}finally{save();await browser.close()}
})().catch(error=>{console.error(error);process.exitCode=1});
