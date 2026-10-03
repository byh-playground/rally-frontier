const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
async function run(){
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'index.html'),'utf8'),end=source.lastIndexOf('})();');
  const html=source.slice(0,end)+'window.__plannerQA={WorldContext,TerrainNavigation,NavigationGoal,NavigationMinHeap,NavigationAStarScratch,UnitDefinition,BuildingDefinition,StrategySim,GameRuleDefinition,RallyStateCodec,InteractionGeometry};'+source.slice(end);
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://planner.test/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://planner.test/');await page.waitForFunction(()=>window.__plannerQA);
    const results=await page.evaluate(()=>{
      const {WorldContext,TerrainNavigation,NavigationGoal,NavigationMinHeap,NavigationAStarScratch,UnitDefinition,BuildingDefinition,StrategySim,GameRuleDefinition,RallyStateCodec,InteractionGeometry}=window.__plannerQA;
      const check=(v,m)=>{if(!v)throw Error(m)},results=[];
      const rect=(id,x0,y0,x1,y1)=>({id,points:[{x:x0,y:y0},{x:x1,y:y0},{x:x1,y:y1},{x:x0,y:y1}]});
      const descriptor={width:3072,height:3072,terrain:{blockers:[rect('wall',1250,200,1350,2300)]}};
      const create=(map=descriptor,buildings=[])=>{const sim={world:WorldContext.fromMap(map),buildings,tick:0,navigationRevision:0,unitRadius:()=>12};return {sim,nav:new TerrainNavigation(sim)}};
      const goal=(x,y)=>NavigationGoal.point(x,y);
      const plain=p=>p&&{path:p.path,length:p.length,graphCost:p.graphCost,point:p.goal.point};
      function oracle(nav,x,y,goal,radius){
        const layer=nav.layer(radius),s=nav.locate(x,y,layer,null,{radius:Math.max(0,radius-.12)});
        if(!s||s.d2>256*256)return Infinity;
        const regions=nav.regions(goal,layer,s.cell.component);if(!regions.areas.length)return Infinity;
        const dist=new Float64Array(layer.fieldNodes.length);dist.fill(Infinity);const heap=new NavigationMinHeap();let best=Infinity;
        for(const area of regions.byCell.get(s.cell.id)||[]){const p=nav.regionPoint(area,goal,s.point.x,s.point.y);if(p)best=Math.min(best,Math.sqrt(p.d2)*1024)}
        for(const link of s.cell.links)for(const id of layer.portals[link.portal].nodes){const n=layer.fieldNodes[id],d=Math.hypot(n.x-s.point.x,n.y-s.point.y)*1024;if(d<dist[id]){dist[id]=d;heap.push(id,d)}}
        while(heap.length){const a=heap.pop();if(a.cost!==dist[a.id])continue;const node=layer.fieldNodes[a.id],portal=layer.portals[node.portal];
          for(const cell of [portal.a,portal.b])for(const area of regions.byCell.get(cell)||[]){const p=nav.regionPoint(area,goal,node.x,node.y);if(p)best=Math.min(best,a.cost+Math.round(Math.sqrt(p.d2)*1024))}
          for(const edge of node.links){const d=a.cost+edge.cost;if(d<dist[edge.to]){dist[edge.to]=d;heap.push(edge.to,d)}}
        }
        return best;
      }
      const maps=[descriptor,{width:3072,height:3072,terrain:{blockers:[rect('closed-wall',1250,0,1350,3072)]}},
        {width:3072,height:3072,terrain:{layers:[{...rect('pit',1024,1024,2048,2048),level:-1}],ramps:[{id:'pit-ramp',layerId:'pit',edge:0,t0:.125,t1:.375,run:128}]}}];
      let cases=0;
      for(const map of maps)for(const radius of [4.12,12.12,32.12])for(const target of [goal(1900,1800),NavigationGoal.range(1800,1000,180,30),NavigationGoal.range(1280,1150,100,0,true),goal(1300,1600)]){
        const {nav}=create(map),p=nav.plan(600,700,target,radius,false,'astar'),expected=oracle(nav,600,700,target,radius);
        check(p?Math.abs(p.graphCost-expected)<1e-7:!Number.isFinite(expected),'A* graph cost must equal independent zero-heuristic Dijkstra');
        if(p){check(p.path.every((q,i)=>!i||nav.segmentClear(p.path[i-1].x,p.path[i-1].y,q.x,q.y,radius-.12)),'A* funnel corridor must be physically clear');
          if(target.radius>0)check(nav.acceptsGoalPoint(target,p.goal.point.x,p.goal.point.y),'Terminal lies in the actual continuous interaction region');
        }
        check(nav.metrics.fieldsBuilt===0,'A* cannot produce a reverse flow field');cases++;
        const shared=nav.plan(600,700,target,radius,false,'shared-astar');
        check(JSON.stringify(plain(shared))===JSON.stringify(plain(p)),'Cold shared A* must return the complete plain A* path and cost');
        nav.plan(620,720,target,radius,false,'shared-astar');
        const warm=nav.plan(600,700,target,radius,false,'shared-astar');
        check(JSON.stringify(plain(warm))===JSON.stringify(plain(p)),'Warm shared suffixes cannot change path, endpoint, or cost: '+JSON.stringify({radius,target,expected:plain(p),actual:plain(warm)}));
        const reversed=create(map).nav;reversed.plan(620,720,target,radius,false,'shared-astar');
        check(JSON.stringify(plain(reversed.plan(600,700,target,radius,false,'shared-astar')))===JSON.stringify(plain(p)),'Different source query order cannot change shared A* result');
      }
      results.push({astarOracleCases:cases});
      const sharedFixture=create(),sharedGoal=goal(1900,1800),starts=[[600,700],[600,1800],[800,800],[900,1500],[1600,700],[1800,2500],[400,1000],[700,2400]];
      const expected=starts.map(([x,y])=>plain(sharedFixture.nav.plan(x,y,sharedGoal,12.12,false,'astar')));
      for(const order of [starts.map((_,i)=>i),starts.map((_,i)=>i).reverse(),[4,0,7,2,5,1,6,3]]){
        const warmed=create().nav;
        for(const i of order){const [x,y]=starts[i];check(JSON.stringify(plain(warmed.plan(x,y,sharedGoal,12.12,false,'shared-astar')))===JSON.stringify(expected[i]),'Shared junction choice preserves the global optimum and complete canonical path for every query order')}
        for(let i=0;i<starts.length;i++){const [x,y]=starts[i];check(JSON.stringify(plain(warmed.plan(x,y,sharedGoal,12.12,false,'shared-astar')))===JSON.stringify(expected[i]),'Fully warm suffix reuse preserves all source routes')}
        check(warmed.metrics.sharedAstarHits>0,'Shared mode actually reuses proven suffix nodes');
      }
      const capped=create().nav,normalCap=TerrainNavigation.SHARED_ASTAR_NODES;TerrainNavigation.SHARED_ASTAR_NODES=4;
      for(let i=0;i<starts.length;i++){const [x,y]=starts[i];check(JSON.stringify(plain(capped.plan(x,y,sharedGoal,12.12,false,'shared-astar')))===JSON.stringify(expected[i]),'Node cap cannot change the route')}
      for(const cache of capped.layer(12.12).sharedPaths.values()){check(cache.size<=4,'Shared node memory cap is respected');for(const entry of cache.values())check(entry.next<0||cache.has(entry.next),'Capped cache retains complete suffix chains')}
      TerrainNavigation.SHARED_ASTAR_NODES=normalCap;
      for(let i=0;i<20;i++)capped.plan(600,700,goal(1900+i,1800),12.12,false,'shared-astar');
      check(capped.layer(12.12).sharedPaths.size<=TerrainNavigation.SHARED_ASTAR_GOALS,'Shared goal cache has a fixed bound');
      check(JSON.stringify(plain(capped.plan(600,700,sharedGoal,12.12,false,'shared-astar')))===JSON.stringify(expected[0]),'Evicted goals return the same cold path');
      const cachedLayer=capped.layer(12.12);
      for(const cache of cachedLayer.sharedPaths.values())for(const [id,entry]of cache){const node=cachedLayer.fieldNodes[id];
        if(entry.next<0)check(entry.remaining===Math.round(Math.hypot(node.x-entry.point.x,node.y-entry.point.y)*1024),'Cached terminal cost is exact');
        else{const next=cache.get(entry.next),edge=node.links.find(e=>e.to===entry.next&&e.via===entry.via);check(next&&edge&&entry.remaining===edge.cost+next.remaining,'Every suffix cost equals its actual graph edge plus complete child suffix')}
      }
      results.push({sharedSourceOrders:3,sharedSources:starts.length,boundedSuffixes:true});
      const {nav,sim}=create(),worker=UnitDefinition.get('worker'),combat=UnitDefinition.get('swarmbug'),oldWorker=worker.navigationPlanner,oldCombat=combat.navigationPlanner;
      check(TerrainNavigation.planner('worker')==='shared-astar'&&TerrainNavigation.planner('swarmbug')==='flow-field','Default unit configuration selects worker shared A* and combat field');
      const original=nav.field;let fieldCalls=0;nav.field=function(...args){fieldCalls++;return original.apply(this,args)};
      for(const [workerMode,combatMode]of [['astar','flow-field'],['flow-field','astar']]){
        worker.navigationPlanner=workerMode;combat.navigationPlanner=combatMode;
        for(const [type,mode]of [['worker',workerMode],['swarmbug',combatMode]]){
          const before=fieldCalls,astar=nav.metrics.astarQueries;
          check(nav.nextPoint({type,x:600,y:700},goal(1900,1800)),'Configured movement finds an obstacle detour');
          check(Number.isFinite(nav.distance(600,700,goal(1900,1800),type)),'Configured distance finds same reachable destination');
          check(nav.connected(600,700,1900,1800,type),'Connected inherits the type planner');
          check(nav.resolveGroundGoal({type,x:600,y:700},1900,1800),'Ground goal resolution inherits the type planner');
          check(mode==='astar'?fieldCalls===before&&nav.metrics.astarQueries===astar+4:fieldCalls===before+4&&nav.metrics.astarQueries===astar,'All unit entry points use the requested configurable planner even with other cache warm');
        }
      }
      for(const type of ['worker','swarmbug']){
        const definition=UnitDefinition.get(type),before=fieldCalls,queries=nav.metrics.sharedAstarQueries||0;definition.navigationPlanner='shared-astar';
        nav.nextPoint({type,x:600,y:700},goal(1900,1800));nav.distance(600,700,goal(1900,1800),type);
        check(fieldCalls===before&&nav.metrics.sharedAstarQueries===queries+2,'Any unit definition can select shared A*');
      }
      for(const invalid of ['invalid','',false]){worker.navigationPlanner=invalid;let rejects=0;try{nav.distance(100,100,goal(110,100),'worker')}catch{rejects++}try{nav.nextPoint({type:'worker',x:100,y:100},goal(110,100))}catch{rejects++}
        check(rejects===2,'Explicit invalid planner is rejected even on straight paths');}
      worker.navigationPlanner=oldWorker;if(oldCombat===undefined)delete combat.navigationPlanner;else combat.navigationPlanner=oldCombat;
      results.push({configurations:'both defaults and reverse configurations passed',fieldCalls});
      const building=(id,x,y)=>({id,type:'barracks',x,y,hp:100,alive:true});
      for(let phase=0;phase<8;phase++){
        sim.buildings=phase%2?[building('a',1024,1024),building('b',1500,2400)]:[];sim.navigationRevision++;sim.tick++;
        const warm=nav.plan(600,700,goal(1900,1800),12.12,false,'astar'),cold=create(descriptor,[...sim.buildings].reverse()).nav.plan(600,700,goal(1900,1800),12.12,false,'astar');
        check(JSON.stringify(plain(warm))===JSON.stringify(plain(cold)),'A* route must not depend on reused graph slots or scratch warmth');
        const layer=nav.layer(12.12);if(phase>0)check(!layer.sharedPaths?.size,'Topology rebuild clears all shared suffixes before reused slots are queried');
        check(JSON.stringify(plain(nav.plan(600,700,goal(1900,1800),12.12,false,'shared-astar')))===JSON.stringify(plain(cold)),'Shared paths after topology change match cold plain A*');
      }
      const layer=nav.layer(12.12),scratch=layer.astarScratch,costArray=scratch.cost;
      nav.plan(600,700,goal(1700,1400),12.12,false,'astar');check(layer.astarScratch===scratch&&scratch.cost===costArray,'A* reuses stamped scratch without per-query graph-sized array allocation');
      results.push({slotChurnPhases:8,scratchCapacity:scratch.capacity,expanded:nav.metrics.astarExpanded});
      const draft={decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},rules=GameRuleDefinition.resolve({overrides:{map:{generator:'fixed-standard'},economy:{startingResources:{minerals:10000,gas:10000}}}});
      worker.navigationPlanner='shared-astar';
      const game=new StrategySim(draft,831047,rules);
      game.units=game.units.filter(u=>UnitDefinition.get(u.type)?.economyWorker);game.rebuildRuntimeIndexes();
      game.applyCommand('host',{type:'TOGGLE_PRODUCTION'});game.applyCommand('guest',{type:'TOGGLE_PRODUCTION'});
      game.navigation.field=()=>{throw Error('Economy worker called a reverse field')};
      let targetChecks=0;
      for(const u of game.units.filter(u=>UnitDefinition.get(u.type)?.economyWorker)){
        const targets=game.resources.filter(m=>m.amount>0);
        const exhaustive=targets.map(target=>({target,d:game.navigation.distance(u.x,u.y,InteractionGeometry.goal(u,target,'worker-mineral'),u.type,TerrainNavigation.ignoresBuildings(u))})).filter(a=>Number.isFinite(a.d)).sort((a,b)=>a.d-b.d||(String(a.target.id)<String(b.target.id)?-1:String(a.target.id)>String(b.target.id)?1:0))[0]?.target||null;
        for(const order of [targets,[...targets].reverse()]){check(game.nearestInteractionTarget(u,order,'worker-mineral')?.id===exhaustive?.id,'Lower-bound candidate ordering preserves exhaustive exact target and ID tie');targetChecks++;}
      }
      results.push({exactTargetSelections:targetChecks});

      const base=game.buildings.find(b=>b.side===0&&BuildingDefinition.get(b.type)?.isMainBase);let built=null;
      outer:for(let radius=180;radius<=500;radius+=40)for(let i=0;i<24;i++){
        const x=Math.round(base.x+Math.cos(i*Math.PI/12)*radius),y=Math.round(base.y+Math.sin(i*Math.PI/12)*radius);
        if(game.applyCommand('host',{type:'BUILD',building:'barracks',produceType:'swordsman',x,y})){built=game.constructionOrders?.at(-1)||game.buildings.at(-1);break outer}
      }
      check(built&&built.builderUnitId,'Worker construction assignment succeeds without a reverse field');
      const builtId=built.id;
      const coldGame=new StrategySim(draft,831047,rules);coldGame.importState(game.exportState());coldGame.navigation.field=()=>{throw Error('Cold economy worker called a reverse field')};
      const coldSearch=coldGame.navigation.astarPlan;coldGame.navigation.astarPlan=function(...args){for(const layer of this.layers.values())layer.sharedPaths?.clear();return coldSearch.apply(this,args)};
      let mineHits=0,returns=0,builderTravel=false,constructing=false;
      for(let tick=0;tick<1000;tick++){
        game.step();coldGame.step();built=game.buildings.find(b=>b.id===builtId)||built;mineHits+=game.events.filter(e=>e.type==='mineHit').length;returns+=game.events.filter(e=>e.type==='income'&&e.reason==='worker').length;
        if(tick%10===0){const a=RallyStateCodec.encode(game.exportState()),b=RallyStateCodec.encode(coldGame.exportState());check(a.length===b.length&&a.every((value,i)=>value===b[i]),'Actual mining/building state bytes cannot depend on warm shared suffixes')}
        builderTravel||=game.units.some(u=>u.workState==='buildTravel');constructing||=game.units.some(u=>u.workState==='building');
        if(built.complete&&mineHits&&returns&&tick>150)break;
      }
      check(built.complete&&mineHits>0&&returns>0&&builderTravel&&constructing,'Real workers travel, construct, mine, and return cargo');
      check(game.navigation.metrics.astarQueries>0&&game.navigation.metrics.fieldsBuilt===0,'Actual economy work uses A* without creating shared fields');
      check(game.navigation.metrics.sharedAstarHits>0,'Actual workers use shared suffixes');
      results.push({economyTicks:game.tick,constructionComplete:built.complete,mineHits,returns,astarQueries:game.navigation.metrics.astarQueries,sharedHits:game.navigation.metrics.sharedAstarHits,fieldsBuilt:game.navigation.metrics.fieldsBuilt,warmColdGameBytesEqual:true});game.dispose('qa-finished');coldGame.dispose('qa-finished');worker.navigationPlanner=oldWorker;
      return results;
    });
    console.log(JSON.stringify({results,errors},null,2));assert.deepEqual(errors,[]);
  }finally{await browser.close()}
}
run().catch(error=>{console.error(error);process.exitCode=1});
