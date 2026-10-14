const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b));
const common=section('class NavigationMinHeap{','class PolygonTriangulation{')+section('class NavigationGraphOrder{','class NavigationGraphSlots{')+section('class NavigationFunnel{','class NavigationGoalVisibility{');
const current=section('class TerrainNavigation{','class WorldContext{');
const reference=require('node:child_process').execFileSync('git',['show','a8648f8ce4ed7a7eaafce47705428bdf03723cb7:index.html'],{cwd:path.join(__dirname,'..'),encoding:'utf8',maxBuffer:20*1024*1024});
const previous=reference.slice(reference.indexOf('class TerrainNavigation{'),reference.indexOf('class WorldContext{'));
assert.notEqual(previous,current,'Oracle is the unchanged published navigation implementation');
function load(source){return new Function('performance',`const FP=100;const UnitDefinition={get:type=>({layer:type==='air'?'AIR':'GROUND',navigationPlanner:'shared-astar'})};const RangeUtil={clamp:(x,a,b)=>Math.max(a,Math.min(b,x))};const NavigationMeshBuilder={cross:(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)};${common}${source};return {TerrainNavigation,NavigationGoal};`)(performance)}
const candidate=load(current),oracle=load(previous);
function fixture(api,seed){
  const {TerrainNavigation:Nav,NavigationGoal:Goal}=api,nav=Object.create(Nav.prototype),cells=[],portals=[],fieldNodes=[];
  const width=7,height=5,byXY=new Map();
  for(let y=0;y<height;y++)for(let x=0;x<width;x++){
    if(x===3&&y!==1&&y!==3)continue;
    const id=cells.length,cell={id,tile:id,local:0,x:x*100+50,y:y*100+50,component:0,links:[],points:[{x:x*100,y:y*100},{x:x*100+100,y:y*100},{x:x*100+100,y:y*100+100},{x:x*100,y:y*100+100}]};cells.push(cell);byXY.set(x+':'+y,cell);
  }
  for(const a of cells)for(const b of cells){
    if(b.id<=a.id||Math.abs(a.x-b.x)+Math.abs(a.y-b.y)!==100)continue;
    const mid={x:(a.x+b.x)/2,y:(a.y+b.y)/2},vertical=a.x!==b.x,p={id:portals.length,a:a.id,b:b.id,p:{x:mid.x+(vertical?0:-50),y:mid.y+(vertical?-50:0)},q:{x:mid.x+(vertical?0:50),y:mid.y+(vertical?50:0)},nodes:[]};portals.push(p);a.links.push({to:b.id,portal:p.id});b.links.push({to:a.id,portal:p.id});
    for(let sample=0;sample<3;sample++){const t=sample/2,id=fieldNodes.length;p.nodes.push(id);fieldNodes.push({id,portal:p.id,x:p.p.x+(p.q.x-p.p.x)*t,y:p.p.y+(p.q.y-p.p.y)*t,sample,order:{kind:0,owner:p.id,direction:0,local:0},links:[]})}
  }
  for(const cell of cells)for(let a=0;a<cell.links.length;a++)for(let b=a+1;b<cell.links.length;b++)for(const ai of portals[cell.links[a].portal].nodes)for(const bi of portals[cell.links[b].portal].nodes){const A=fieldNodes[ai],B=fieldNodes[bi],cost=Math.max(1,Math.round(Math.hypot(A.x-B.x,A.y-B.y)*1024));A.links.push({to:bi,via:cell.id,cost});B.links.push({to:ai,via:cell.id,cost})}
  const layer={cells,portals,fieldNodes,nodeCount:fieldNodes.length,fields:new Map(),goals:new Map()};
  nav.sim={tick:0,unitRadius:()=>10};nav.layers=new Map([['fixture',layer]]);nav.metrics={astarQueries:0,astarExpanded:0,astarCostMs:0,funnelQueries:0,fieldsBuilt:0,fieldHits:0,fieldBuildMs:0,routeQueries:0,astarMoveQueries:0};nav.layer=()=>layer;
  nav.locate=(x,y)=>{const cell=byXY.get(Math.floor(x/100)+':'+Math.floor(y/100));return cell?{cell,point:{x,y},d2:0}:null};
  nav.regions=goal=>{const key=goal.key+':0';if(layer.goals.has(key))return layer.goals.get(key);const areas=[],byCell=new Map();for(const cell of cells){const p=goal.closest(goal.x,goal.y,cell.points);if(!p)continue;const area={id:areas.length,cell,polygon:cell.points,point:goal.radius===0?p:null};areas.push(area);byCell.set(cell.id,[area])}const value={key,goal,areas,byCell};layer.goals.set(key,value);return value};
  nav.acceptsGoalPoint=(g,x,y)=>g.contains(x,y);nav.segmentClear=()=>false;nav.sync=()=>{};
  return {nav,layer,Goal};
}
let comparisons=0;const timings=[];
for(let seed=0;seed<24;seed++){
  const A=fixture(candidate,seed),B=fixture(oracle,seed);
  for(const shape of ['point','disc','annulus']){
    const make=api=>shape==='point'?api.Goal.point(650,250):api.Goal.range(650,250,shape==='disc'?65:100,shape==='annulus'?40:0);
    for(let repeat=0;repeat<8;repeat++){
      A.nav.sim.tick=B.nav.sim.tick=repeat;
      const x=25+(seed%3)*10+.137*(repeat+1),y=125+(seed%2)*200+.271*(repeat+1),start=performance.now();
      const a=A.nav.astarPlan(x,y,make(A),10,false,true);timings.push(performance.now()-start);
      const b=B.nav.astarPlan(x,y,make(B),10,false,true);
      assert.equal(JSON.stringify(a&&{path:a.path,endpoint:a.goal.point,length:a.length,graphCost:a.graphCost}),JSON.stringify(b&&{path:b.path,endpoint:b.goal.point,length:b.length,graphCost:b.graphCost}),`Complete path/funnel/endpoint/fraction differs: ${seed}/${shape}/${repeat}`);comparisons++;
    }
  }
  assert(A.nav.metrics.fieldsBuilt>0,'Repeated shared goals construct reverse fields');
  for(const field of A.layer.fields.values())for(const node of A.layer.fieldNodes)for(const edge of node.links)assert(field.cost[node.id]<=edge.cost+field.cost[edge.to],'Heuristic remains consistent on every graph edge');
  A.layer.fields.clear();A.layer.goals.clear();A.layer.sharedPaths.clear();
  const goal=A.Goal.point(650,250),before=A.nav.metrics.fieldsBuilt;A.nav.astarPlan(25.125,125.375,goal,10,false,false);assert.equal(A.layer.fields.size,1,'Persistent goal rebuilds a fresh potential after graph cache invalidation even for the first unit');assert.equal(A.nav.metrics.fieldsBuilt,before+1,'Invalidation cannot reuse old graph costs');
}
const churn=fixture(candidate,0);for(let i=0;i<60;i++){churn.nav.sim.tick=i;for(let unit=0;unit<4;unit++)churn.nav.astarPlan(25+unit,125,churn.Goal.point(640+i*.1,250),10,false,true)}assert.equal(churn.layer.fields.size,0,'Multiple units querying each moving exact goal in one tick do not build fields');
const stationary=fixture(candidate,0),fixed=stationary.Goal.point(650,250);for(let i=0;i<4;i++)stationary.nav.astarPlan(25+i,125,fixed,10,false,true);assert.equal(stationary.layer.fields.size,0,'First stationary-goal tick stays Euclidean for all units');stationary.nav.sim.tick++;stationary.nav.astarPlan(25,125,fixed,10,false,true);assert.equal(stationary.layer.fields.size,1,'Stationary goal starts reusing distance field on a later tick');
const ready=stationary.layer.fields.get(fixed.key+':0'),built=stationary.nav.metrics.fieldsBuilt;stationary.nav.astarPlan(25.137,125.271,fixed,10,false,false);assert.equal(stationary.nav.metrics.fieldsBuilt,built,'A solo A* consumer reuses an already computed potential');assert.equal(stationary.layer.fields.get(fixed.key+':0'),ready,'Potential identity is shared');
const cold=fixture(candidate,0);cold.nav.sim.tick=100;cold.nav.astarPlan(25,125,cold.Goal.point(650,250),10,false,true);assert.equal(cold.layer.fields.size,0,'Cold restore has no inherited goal lifetime');
const bounded=fixture(candidate,0);for(let i=0;i<100;i++){bounded.nav.sim.tick=i;bounded.nav.astarPlan(25,125,bounded.Goal.point(640+i*.1,250),10,false,true)}assert.equal(bounded.layer.goalLifetimes.size,48,'Goal lifetime metadata is bounded per layer');
for(const type of ['ground','air']){const A=fixture(candidate,0),B=fixture(oracle,0),u={id:'mover',type,x:25.137,y:125.271};for(let tick=0;tick<4;tick++){A.nav.sim.tick=B.nav.sim.tick=tick;const goal=A.Goal.point(650,250),oldGoal=B.Goal.point(650,250);assert.equal(JSON.stringify(A.nav.nextPoint(u,goal)),JSON.stringify(B.nav.nextPoint(u,oldGoal)),'Current-position plan consumption preserves nextPoint for '+type);const record=A.nav.movementPlan(u,goal);assert.equal(JSON.stringify(A.nav.nextPlanPoint(u,record)),JSON.stringify(A.nav.nextPoint(u,goal)),'Planning record consumption agrees with public nextPoint')}}
for(const api of [candidate,oracle]){const f=fixture(api,0);for(const node of f.layer.fieldNodes)node.links=node.links.filter(edge=>(node.x<400)===(f.layer.fieldNodes[edge.to].x<400));for(let repeat=0;repeat<3;repeat++){f.nav.sim.tick=repeat;assert.equal(f.nav.astarPlan(25.125,125.375,f.Goal.point(650,250),10,false,true),null,'Disconnected graph remains unreachable with warm fields')}}
const edited=fixture(candidate,0),editGoal=edited.Goal.point(650,250);edited.nav.astarPlan(25,125,editGoal,10,false,true);edited.nav.sim.tick=1;edited.nav.astarPlan(25,125,editGoal,10,false,true);const oldField=edited.layer.fields.get(editGoal.key+':0');edited.layer.fields.clear();edited.layer.goals.clear();edited.layer.sharedPaths.clear();for(const node of edited.layer.fieldNodes)node.links=node.links.filter(edge=>(node.x<400)===(edited.layer.fieldNodes[edge.to].x<400));edited.nav.sim.tick=2;assert.equal(edited.nav.astarPlan(25,125,editGoal,10,false,false),null,'Changed graph can disconnect a persistent goal');const freshField=edited.layer.fields.get(editGoal.key+':0');assert.notEqual(freshField,oldField,'Dirty graph never reuses old potential');assert(freshField.cost.some((cost,i)=>cost!==oldField.cost[i]),'Rebuilt potential incorporates changed connectivity');
const separate=fixture(candidate,0);separate.nav.sim.tick=1;separate.nav.astarPlan(25,125,separate.Goal.point(650,250),32,true,true);assert.equal(separate.layer.fields.size,0,'Different radius/ignore layer cannot inherit another layer lifetime');
const moved=fixture(candidate,0),mover={id:'moved',type:'ground',x:25.137,y:125.271},moveGoal=moved.Goal.point(650,250),oldRecord=moved.nav.movementPlan(mover,moveGoal);mover.x=130.375;mover.y=150.125;assert.equal(JSON.stringify(moved.nav.nextPlanPoint(mover,oldRecord)),JSON.stringify(moved.nav.nextPoint(mover,moveGoal)),'A record cannot make a moved unit follow an old route');
const componentRegions={...stationary.nav.regions(fixed),key:fixed.key+':changed-component'},oldPotential=stationary.layer.fields.get(fixed.key+':0'),componentPotential=stationary.nav.goalPotential(stationary.layer,componentRegions,false);assert.notEqual(componentPotential,oldPotential,'Changed component identity creates its own potential');assert.equal(stationary.layer.fields.get(componentRegions.key),componentPotential,'Component remains part of the potential key');
console.log(JSON.stringify({pass:true,comparisons,coverage:['published navigation oracle','equal-cost corridors','fractional starts','point/disc/annulus terminals','cold/warm shared suffixes','complete funnel and endpoint','edge consistency','dirty-graph potential rebuild','bounded lifetime metadata','solo A* potential reuse','first-tick moving-goal churn guard','cold restore','layer isolation','ground/air nextPoint','plan-record consumption'],timingIncludesFieldConstruction:true,candidateTotalMs:timings.reduce((a,b)=>a+b,0),maxQueryMs:Math.max(...timings)},null,2));

