// Controlled full StrategySim.step costs. No rendering/RTC claims from this suite.
const fs=require('fs'),path=require('path'),cp=require('child_process'),assert=require('assert/strict'),crypto=require('crypto');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..');
const before='18ebc60474d75ea9ec7ae9c8e21281433b5e4da6',after='94cf1fabe3d0f7e48b08e0803fc70ef51f6197b0';
const out=path.join(root,'.qa/worker-route-performance');fs.mkdirSync(out,{recursive:true});
const map=JSON.parse(fs.readFileSync(process.argv[2]||path.join(root,'.qa/canonical-map.json'),'utf8'));
const stats=a=>{const s=a.slice().sort((x,y)=>x-y);return{n:s.length,mean:s.reduce((n,x)=>n+x,0)/s.length,median:s[Math.floor((s.length-1)*.5)],p95:s[Math.floor((s.length-1)*.95)],max:s.at(-1)}};
(async()=>{const browser=await chromium.launch({channel:'msedge',headless:true});const rows=[],started=Date.now();try{
  for(const count of [1,20])for(const [run,sha]of [before,after,after,before].entries()){
    assert(Date.now()-started<140000,'Controlled scenarios leave budget for RTC suite');
    const source=cp.execFileSync('git',['show',sha+':index.html'],{cwd:root,encoding:'utf8',maxBuffer:20e6});
    let html=require('./bundle-gamekit.cjs').bundleGame(root,source);const end=html.lastIndexOf('})();');html=html.slice(0,end)+';window.__workerPerf={StrategySim,GameRuleDefinition,MapGeneration,UnitDefinition,Building,BuildingDefinition,RallySimulationAdapter};'+html.slice(end);
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('http://worker-perf.local/**',r=>r.fulfill({contentType:'text/html',headers:{'Cross-Origin-Opener-Policy':'same-origin','Cross-Origin-Embedder-Policy':'require-corp'},body:html}));await page.goto('http://worker-perf.local/');await page.waitForFunction(()=>window.__workerPerf&&window.RallyGamekit);
    const data=await page.evaluate(({map,count})=>{
      const q=__workerPerf;q.MapGeneration.generateMapDescriptor=()=>structuredClone(map);const sim=new q.StrategySim({decks:{host:['archer'],guest:['archer']},defenseCards:{host:[],guest:[]}},3919536611,q.GameRuleDefinition.resolve({overrides:{simulation:{tps:10}}}));
      const workers=sim.units.filter(u=>u.side===0&&q.UnitDefinition.get(u.type)?.economyWorker),base=sim.buildings.find(b=>b.side===0&&q.BuildingDefinition.get(b.type)?.isDropoff),resource=sim.resources[0];
      while(workers.length<count)workers.push(sim.spawnUnit(0,'worker',base.x+90+(workers.length%4)*8,base.y-70+Math.floor(workers.length/4)*8));
      sim.units=workers.slice(0,count);sim.camps=[];sim.rebuildRuntimeIndexes();resource.x=base.x+650;resource.y=base.y;resource.amount=10000;sim.resources=[resource];for(const w of sim.units){w.mineId=resource.id;w.workState='seek'}
      sim.buildings.push(new q.Building({...base,id:'perf-obstacle',type:'barracks',x:base.x+325,y:base.y,side:1,alive:true,complete:true}));sim.markBuildingSpatialDirty();
      const adapter=new q.RallySimulationAdapter({sim}),steps=[],snapshots=[];const t=performance.now();let income=0;
      for(let tick=1;tick<=300;tick++){
        const old={...sim.navigation.metrics},at=performance.now();sim.step();const ms=performance.now()-at,nav={};for(const k of ['routeQueries','directQueries','astarQueries','astarExpanded','funnelQueries','regionHits','fieldsBuilt','fieldHits','sharedAstarHits','layersBuilt','meshBuildMs','fieldBuildMs','workerRouteBuilds','workerRouteReuses','workerRouteShared','workerRouteInvalid_topology','workerRouteInvalid_deviation'])nav[k]=(sim.navigation.metrics[k]||0)-(old[k]||0);
        income+=sim.events.filter(e=>e.type==='income'&&e.reason==='worker').length;steps.push({tick:sim.tick,ms,nav,alive:sim.units.filter(u=>u.alive).length});
        if(tick%10===0){const a=performance.now(),bytes=adapter.save();snapshots.push({tick:sim.tick,ms:performance.now()-a,bytes:bytes.length})}
      }
      const canvas=document.createElement('canvas'),gl=canvas.getContext('webgl2'),ext=gl?.getExtension('WEBGL_debug_renderer_info');
      return{elapsedMs:performance.now()-t,steps,snapshots,income,units:sim.units.length,seed:sim.seed,mapHash:sim.mapFingerprint(),inputs:[],gpu:ext?gl.getParameter(ext.UNMASKED_RENDERER_WEBGL):null,isolated:crossOriginIsolated,clockResolutionMs:(()=>{let last=performance.now(),min=Infinity;for(let i=0;i<5000;i++){const now=performance.now();if(now>last)min=Math.min(min,now-last);last=now}return Number.isFinite(min)?min:null})()};
    },{map,count});assert.deepEqual(errors,[]);assert.equal(data.units,count);
    const summary={};for(const [phase,filter]of [['initial',x=>x.tick<=100],['steady',x=>x.tick>100]]){const steps=data.steps.filter(filter),snaps=data.snapshots.filter(filter),nav={};for(const x of steps)for(const[k,v]of Object.entries(x.nav))nav[k]=(nav[k]||0)+v;summary[phase]={stepMs:stats(steps.map(x=>x.ms)),nav,snapshotMs:stats(snaps.map(x=>x.ms)),snapshotBytes:stats(snaps.map(x=>x.bytes))}}
    const row={sha,count,run,sourceHash:crypto.createHash('sha256').update(source).digest('hex'),browser:browser.version(),data,summary,errors};fs.writeFileSync(path.join(out,count+'-'+run+'.json'),JSON.stringify(row,null,2));rows.push({...row,data:{...data,steps:undefined,snapshots:undefined}});console.log(JSON.stringify({sha,count,run,elapsedMs:data.elapsedMs,summary}));await page.close();
  }
  fs.writeFileSync(path.join(out,'summary.json'),JSON.stringify({rows,scenarioElapsedMs:rows.reduce((n,x)=>n+x.data.elapsedMs,0),suiteWallMs:Date.now()-started,fixture:'same canonical map/seed/input[]/fixed mineral,barracks,workers; full sim.step 300 logical ticks; snapshots every10; initial1..100 vs steady101..300; ABBA order; single Edge, no game renderer/RTC'},null,2));
}finally{await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
