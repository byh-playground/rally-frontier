const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
async function run(){
  const root=path.resolve(__dirname,'..'),source=fs.readFileSync(path.join(root,'index.html'),'utf8'),end=source.lastIndexOf('})();');
  const method=source.slice(source.indexOf('  astarPlan(x,y,goal,'),source.indexOf('  astarTrace(layer,')).trim().replace(/^astarPlan/,'function').replace(/const distanceField=shared&&[^;]+;/,'const distanceField=null;');
  const injected=source.slice(0,end)+`window.__heuristicQA={StrategySim,GameRuleDefinition,TerrainNavigation,NavigationGoal,WorldContext,UnitDefinition,RallyStateCodec,oracleAstar:(${method})};`+source.slice(end);
  require('./setup-gamekit.cjs').readGamekit(root);
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage();await page.route('http://nav-heuristic.test/**',r=>{const file=decodeURIComponent(new URL(r.request().url()).pathname);if(file==='/')return r.fulfill({contentType:'text/html',body:injected});if(file==='/gamekit.lock.json'||/^\/\.cache\/gamekit\/[\w-]+\.js$/.test(file))return r.fulfill({contentType:file.endsWith('.json')?'application/json':'text/javascript',body:fs.readFileSync(path.join(root,file))});return r.abort()});await page.goto('http://nav-heuristic.test/');await page.waitForFunction(()=>window.__heuristicQA);
    const result=await page.evaluate(()=>{
      const {StrategySim,GameRuleDefinition,TerrainNavigation,NavigationGoal,WorldContext,UnitDefinition,RallyStateCodec,oracleAstar}=window.__heuristicQA;
      const ensure=(ok,message)=>{if(!ok)throw Error(message)},projection=p=>p&&({path:p.path,endpoint:p.goal.point,length:p.length,graphCost:p.graphCost});
      const sim=new StrategySim({decks:{host:['archer'],guest:['archer']},defenseCards:{host:[],guest:[]}},20261014,GameRuleDefinition.resolve({overrides:{simulation:{tps:10}}}));
      const saved=Array.from(RallyStateCodec.encode(sim.exportState()));
      let compared=0,candidateMs=0,oracleMs=0,fieldBytes=0,firstMs=0,secondMs=0;
      const rect=(id,x,y,w,h)=>({id,points:[{x,y},{x:x+w,y},{x:x+w,y:y+h},{x,y:y+h}]});
      const descriptor={width:3072,height:4096,terrain:{blockers:[rect('wall',1450,600,150,2900),rect('island',900,1800,200,250)],layers:[],ramps:[],bridges:[]}};
      for(const radius of [4,12,32]){
        const state=()=>({world:WorldContext.fromMap(descriptor),buildings:[],tick:0,navigationRevision:0,unitRadius:()=>radius});
        const a=new TerrainNavigation(state()),b=new TerrainNavigation(state());b.astarPlan=oracleAstar;
        const goals=[NavigationGoal.point(2500,2000),NavigationGoal.range(2500,2000,150),NavigationGoal.range(2500,2000,200,100,true),NavigationGoal.point(1500,2000)];
        for(let pass=0;pass<3;pass++)for(const goal of goals)for(let i=0;i<12;i++){
          a.sim.tick=b.sim.tick=pass;
          const x=300+i*7+.137,y=1800+i*21+.271,t=performance.now(),p=a.astarPlan(x,y,goal,radius,false,true),elapsed=performance.now()-t;candidateMs+=elapsed;if(!compared)firstMs=elapsed;if(compared===1)secondMs=elapsed;
          const ot=performance.now(),q=b.astarPlan(x,y,goal,radius,false,true);oracleMs+=performance.now()-ot;
          ensure(JSON.stringify(projection(p))===JSON.stringify(projection(q)),`Path/endpoint/funnel/cost differ r${radius} pass${pass} goal${goal.key} i${i}`);compared++;
          if(pass===0)ensure(a.metrics.fieldsBuilt===0,'Entire first tick must stay Euclidean');
        }
        for(const layer of a.layers.values())for(const f of layer.fields.values())fieldBytes+=Object.values(f).reduce((sum,v)=>sum+(v.byteLength||0),0);
        const type=UnitDefinition.get('archer'),planner=type.navigationPlanner;type.navigationPlanner='shared-astar';
        try{for(let i=0;i<4;i++){const u={id:'next'+i,type:'archer',x:300+i+.125,y:1800+i+.375},goal=NavigationGoal.point(2500,2000);ensure(JSON.stringify(a.nextPoint(u,goal))===JSON.stringify(b.nextPoint(u,goal)),'Actual nextPoint differs')}}finally{type.navigationPlanner=planner}
        a.sim.navigationRevision++;b.sim.navigationRevision++;a.sim.tick++;b.sim.tick++;a.sim.buildings=[];b.sim.buildings=[];a.sync();b.sync();
        ensure(JSON.stringify(projection(a.astarPlan(300.125,1800.375,goals[0],radius,false,true)))===JSON.stringify(projection(b.astarPlan(300.125,1800.375,goals[0],radius,false,true))),'Topology sync differs');
        const moving=new TerrainNavigation(state());for(let tick=0;tick<12;tick++){moving.sim.tick=tick;for(let unit=0;unit<3;unit++)moving.astarPlan(300+unit,1800,NavigationGoal.point(2500+tick*.1,2000),radius,false,true)}ensure(moving.metrics.fieldsBuilt===0,'Same-tick multi-unit moving goals cannot create distance fields');
      }
      ensure(JSON.stringify(saved)===JSON.stringify(Array.from(RallyStateCodec.encode(sim.exportState()))),'Read-only queries change authoritative state bytes');
      sim.dispose('heuristic-qa');return{pass:true,compared,candidateMs,oracleMs,firstMs,secondMs,fieldBytes,authoritativeBytesEqual:true,coverage:['actual NavMesh geometry','point/disc/annulus/terrainLine','blocked point projection','funnel/path/endpoint/fraction','nextPoint','state bytes']};
    });
    assert(result.pass);console.log(JSON.stringify(result,null,2));
  }finally{await browser.close()}
}
run().catch(e=>{console.error(e);process.exitCode=1});

