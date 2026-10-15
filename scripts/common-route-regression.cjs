const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.qa/common-route');fs.mkdirSync(out,{recursive:true});
let html=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const end=html.lastIndexOf('})();');html=html.slice(0,end)+';window.__routes={StrategySim,GameRuleDefinition,UnitDefinition,BuildingDefinition,NavigationGoal,MovementComponent,TerrainNavigation,WorldContext,InteractionGeometry};'+html.slice(end);
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('http://common-route.test/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('http://common-route.test/');await page.waitForFunction(()=>window.__routes);
  const result=await page.evaluate(()=>{
    const q=__routes,check=(v,m)=>{if(!v)throw Error(m)};
    const rect=(id,x0,y0,x1,y1)=>({id,points:[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]});
    const map={width:3072,height:3072,terrain:{blockers:[rect('wall',1250,200,1350,2300)]}};
const sim={world:q.WorldContext.fromMap(map),buildings:[],units:[],tick:1,navigationRevision:0,runtimeEpoch:0,nextRoutePathId:1,routePathStore:new Map(),routePathIndex:new Map(),unitRadius:()=>12,routePathSignature:q.StrategySim.prototype.routePathSignature,routePathBody:q.StrategySim.prototype.routePathBody,internRoutePath:q.StrategySim.prototype.internRoutePath},nav=new q.TerrainNavigation(sim),goal=q.NavigationGoal.point(1800,1500);
    const unit=(id,x,y)=>({id,type:'worker',side:0,alive:true,x,y,movement:new q.MovementComponent()});
    const a=unit('a',900,1500);sim.units.push(a);nav.nextPoint(a,goal);
    check(nav.metrics.astarQueries===1,'fixture must run real A* around terrain wall');
    const saved=a.movement.routes[a.movement.routeIndex],savedPath=sim.routePathStore.get(saved.pathId),start=nav.routePoint(savedPath,0),corner=nav.routePoint(savedPath,1);
    const b=unit('b',(start.x+corner.x)/2-40,(start.y+corner.y)/2);sim.units.push(b);sim.tick++;
    const beforeA=nav.metrics.astarQueries,beforeF=nav.metrics.funnelQueries;
    nav.nextPoint(b,goal);check(nav.metrics.routeJoins===1,'distant start must join an existing suffix');
    check(nav.metrics.astarQueries===beforeA&&nav.metrics.funnelQueries===beforeF,'join must avoid A*/funnel');
    check(Math.hypot(b.x-start.x,b.y-start.y)>24,'join starts beyond old worker departure tolerance');
    const acquired=nav.metrics.routeCacheLookups,requests=nav.metrics.routeQueries;
    let fullChecks=0;const clear=nav.segmentClear;nav.segmentClear=function(...args){fullChecks++;return clear.apply(this,args)};
    const topology=nav.routeTopology;nav.routeTopology=function(route){check(this.routeChecks.get(route)?.records===this.circles,'normal movement must not inspect the complete saved path');return topology.call(this,route)};
    let ticks=0;
    while(ticks++<1000){
      sim.tick++;const point=nav.nextPoint(b,goal);check(point,'active route must remain available');
      const dx=point.x-b.x,dy=point.y-b.y,d=Math.hypot(dx,dy),step=Math.min(d,16);if(d){b.x+=dx/d*step;b.y+=dy/d*step}
      if(Math.hypot(b.x-goal.x,b.y-goal.y)<.02)break;
    }
    check(ticks<1000,'following must arrive');
    check(nav.metrics.routeCacheLookups===acquired&&nav.metrics.routeQueries===requests,'normal movement and corners must make zero acquisition requests');
    nav.segmentClear=clear;nav.routeTopology=topology;
    const normalRequests=nav.metrics.routeQueries-requests;
    const beforeChange=nav.metrics.routeCacheLookups;nav.nextPoint(b,q.NavigationGoal.point(1700,1400));check(nav.metrics.routeCacheLookups===beforeChange+1,'changed destination reacquires');
    const c=unit('c',900,1500);sim.units.push(c);nav.nextPoint(c,goal);c.x=700;c.y=800;sim.tick++;nav.nextPoint(c,goal);check(nav.metrics.routeInvalid_deviation>0,'physical departure reacquires');
    const big=unit('big',900,1500);sim.units.push(big);sim.unitRadius=u=>u==='large'?24:12;big.type='large';const joins=nav.metrics.routeJoins||0;nav.nextPoint(big,goal);check((nav.metrics.routeJoins||0)===joins,'radius profile must not reuse small route');
    // A failed straight join may never tunnel through the wall.
    const opposite=unit('opposite',1450,1400);const p=nav.joinRoute(opposite,saved);
    if(p){const path=sim.routePathStore.get(p.pathId);for(let i=1;i<path.length;i++){const a=nav.routePoint(path,i-1),b=nav.routePoint(path,i);check(nav.segmentClear(a.x,a.y,b.x,b.y,12,null,true,0),'joined route must preserve terrain clearance')}}
    const bad=structuredClone(b.movement);bad.routes[bad.routeIndex].cursor=99999;let rejected=false;try{q.MovementComponent.validateRoutes(bad,map,sim.routePathStore)}catch{rejected=true}check(rejected,'invalid common cursor must be rejected');
    const real=new q.StrategySim({decks:{host:['archer'],guest:['archer']},defenseCards:{host:[],guest:[]}},3919536611,q.GameRuleDefinition.resolve({overrides:{simulation:{tps:10}}}));
    const worker=real.units.find(u=>u.side===0&&q.UnitDefinition.get(u.type)?.economyWorker),capability=worker.capability('worker'),base=capability.dropoff(real);
    check(base,'real worker must have a dropoff');real.navigation.nextPoint(worker,q.InteractionGeometry.goal(worker,base,'worker-dropoff'));
    Object.defineProperty(worker.movement.routes,'find',{value:()=>{throw Error('Normal dropoff searched route history')},configurable:true});
    check(capability.dropoff(real)===base,'normal dropoff must use the active handle');delete worker.movement.routes.find;
    const soldier=real.spawnUnit(0,'swordsman',800,800);real.navigation.nextPoint(soldier,q.NavigationGoal.point(900,900));
    check(soldier.movement.routeIndex>=0,'combat movement uses common routes');real.applyCommand('host',{type:'SET_FLAG',x:900,y:900});check(soldier.movement.routeIndex===-1,'new command releases the active handle even for the same destination');
    const target=real.spawnUnit(1,'swordsman',1100,800),pursuit=q.InteractionGeometry.goal(soldier,target,'attack'),beforePursuit=real.navigation.metrics.routeCacheLookups||0;
    real.navigation.nextPoint(soldier,pursuit);real.navigation.nextPoint(soldier,pursuit);
    check((real.navigation.metrics.routeCacheLookups||0)-beforePursuit===1,'stationary unit target must keep its active handle');
    target.x+=1;target.fx=Math.round(target.x*100);real.navigation.nextPoint(soldier,q.InteractionGeometry.goal(soldier,target,'attack'));
    check(soldier.movement.routes.length===1&&real.routePathStore.get(soldier.movement.routes[0].pathId).key!==pursuit.key,'obsolete pursuit positions must not accumulate in route history');
    check(q.InteractionGeometry.goal(worker,base,'worker-dropoff').retainHistory,'static destinations retain recurring route history');
    const long=unit('long',300,300),longGoal=q.NavigationGoal.point(900,300),planner=nav.movementPlan;sim.units.push(long);sim.tick++;
    let longRequests=0;nav.movementPlan=()=>{longRequests++;return{route:{path:Array.from({length:600},(_,i)=>({x:300+i*600/599,y:300}))},planner:'flow-field'}};
    nav.nextPoint(long,longGoal);for(let i=0;i<10;i++){sim.tick++;long.x+=1;nav.nextPoint(long,longGoal)}nav.movementPlan=planner;
    check(longRequests===1&&sim.routePathStore.get(long.movement.routes[0].pathId).length===600,'checkpoint-supported long paths must retain their handle instead of planning every update');q.MovementComponent.validateRoutes(long.movement,map,sim.routePathStore);
    return{pass:true,ticks,initialAstar:1,joinAstar:0,joinFunnel:0,normalRequests,normalCacheLookups:0,normalFullRouteScans:0,normalLocalSegmentChecks:fullChecks,metrics:nav.metrics};
  });
  assert.deepEqual(errors,[]);fs.writeFileSync(path.join(out,'report.json'),JSON.stringify({...result,errors},null,2));console.log(JSON.stringify(result,null,2));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
