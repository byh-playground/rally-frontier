const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const html=fs.readFileSync(path.join(__dirname,'..','index.html'),'utf8');
const section=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b));
const common=section('class NavigationMinHeap{','class PolygonTriangulation{')+section('class NavigationGraphOrder{','class NavigationGraphSlots{')+section('class NavigationFunnel{','class NavigationGoalVisibility{');
const current=section('class TerrainNavigation{','class WorldContext{');
const previous=current.replace(/const distanceField=shared&&[^;]+;/,'const distanceField=null;');
assert.notEqual(previous,current,'Differential oracle disables only the new heuristic');
function load(source){return new Function('performance',`const FP=100;const RangeUtil={clamp:(x,a,b)=>Math.max(a,Math.min(b,x))};const NavigationMeshBuilder={cross:(a,b,c)=>(b.x-a.x)*(c.y-a.y)-(b.y-a.y)*(c.x-a.x)};${common}${source};return {TerrainNavigation,NavigationGoal};`)(performance)}
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
  nav.sim={tick:0};nav.layers=new Map([['fixture',layer]]);nav.metrics={astarQueries:0,astarExpanded:0,astarCostMs:0,funnelQueries:0,fieldsBuilt:0,fieldHits:0,fieldBuildMs:0};nav.layer=()=>layer;
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
  const goal=A.Goal.point(650,250);A.nav.astarPlan(25.125,125.375,goal,10,false,true);assert.equal(A.layer.fields.size,0,'Invalidation resets repeated-goal guard');
}
const churn=fixture(candidate,0);for(let i=0;i<60;i++){churn.nav.sim.tick=i;for(let unit=0;unit<4;unit++)churn.nav.astarPlan(25+unit,125,churn.Goal.point(640+i*.1,250),10,false,true)}assert.equal(churn.layer.fields.size,0,'Multiple units querying each moving exact goal in one tick do not build fields');
const stationary=fixture(candidate,0),fixed=stationary.Goal.point(650,250);for(let i=0;i<4;i++)stationary.nav.astarPlan(25+i,125,fixed,10,false,true);assert.equal(stationary.layer.fields.size,0,'First stationary-goal tick stays Euclidean for all units');stationary.nav.sim.tick++;stationary.nav.astarPlan(25,125,fixed,10,false,true);assert.equal(stationary.layer.fields.size,1,'Stationary goal starts reusing distance field on a later tick');
for(const api of [candidate,oracle]){const f=fixture(api,0);for(const node of f.layer.fieldNodes)node.links=node.links.filter(edge=>(node.x<400)===(f.layer.fieldNodes[edge.to].x<400));for(let repeat=0;repeat<3;repeat++){f.nav.sim.tick=repeat;assert.equal(f.nav.astarPlan(25.125,125.375,f.Goal.point(650,250),10,false,true),null,'Disconnected graph remains unreachable with warm fields')}}
console.log(JSON.stringify({pass:true,comparisons,coverage:['equal-cost corridors','fractional starts','point/disc/annulus terminals','cold/warm shared suffixes','complete funnel and endpoint','edge consistency','invalidation','distinct-goal churn'],timingIncludesFieldConstruction:true,candidateTotalMs:timings.reduce((a,b)=>a+b,0),maxQueryMs:Math.max(...timings)},null,2));

