const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {chromium}=require('playwright'),root=path.resolve(__dirname,'..'),out=path.join(root,'.qa/sweep-side-index-20261012');
const denseOnly=process.argv.includes('--dense-only');
const baseline=execFileSync('git',['show','ffbc47e7091f48f27e1a0f429f721c5371193e02:index.html'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
const a=baseline.indexOf('class DeterministicSweptCollisionGrid{'),b=baseline.indexOf('class DeterministicUnitSpatialGrid{',a);assert(a>=0&&b>a);
const reference=baseline.slice(a,b).replaceAll('DeterministicSweptCollisionGrid','ReferenceSweptCollisionGrid');
const source=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8')),end=source.lastIndexOf('})();');assert(end>0);
const html=source.slice(0,end)+reference+'\nwindow.__sweepSideQA={StrategySim,GameRuleDefinition,DebugScenarioHarness,RallyStateCodec,BuildingDefinition,ECONOMY_WORKER_TYPE,NEUTRAL_SIDE,ReferenceSweptCollisionGrid};'+source.slice(end);
(async()=>{
 const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
 try{
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
  await page.route('https://sweep-side.local/**',r=>r.fulfill({contentType:'text/html',body:html}));await page.goto('https://sweep-side.local/');await page.waitForFunction(()=>window.__sweepSideQA);
  const results=await page.evaluate(async(denseOnly)=>{
   const q=window.__sweepSideQA,bytes=s=>q.RallyStateCodec.encode(s.exportState()),same=(a,b,label)=>{if(a.length!==b.length||!a.every((v,i)=>v===b[i]))throw Error('Authoritative state differs: '+label)};
   const stats=a=>{const s=a.slice().sort((a,b)=>a-b);return {mean:a.reduce((s,v)=>s+v,0)/a.length,p95:s[Math.ceil(s.length*.95)-1],max:s.at(-1)}};
   const cases=[{type:'swordsman',count:60,ticks:90},{type:'tank',count:40,ticks:60},{type:'hivecarrier',count:15,ticks:60},{type:'sporeherd',count:20,ticks:60},
    {type:'burrowbeast',count:20,ticks:60},{type:'pillbug',count:20,ticks:60},{type:'ancientmistray',count:20,ticks:60},{type:'rocket',count:20,ticks:60},
    {type:'swordsman',count:1,ticks:90,roster:'basic400'},{type:'swordsman',count:1,ticks:90,roster:'mixed400'}];
   const rows=[],rules=q.GameRuleDefinition.resolve({overrides:{simulation:{tps:10}}});
   const build400=(sim,mixed)=>{
    sim.units=sim.units.filter(u=>u.side===q.NEUTRAL_SIDE);sim.rebuildRuntimeIndexes();
    const groups=mixed?[['worker',40],['tank',12],['swordsman',60],['archer',60],['medic',10],['mage',10]]:[['worker',40],['swordsman',180]],cx=sim.world.width*.5,cy=sim.world.height*.5;
    for(const side of [0,1]){const dir=side===0?1:-1,base=sim.buildings.find(b=>b.side===side&&q.BuildingDefinition.get(b.type)?.isMainBase);let depth=0;
     for(const [name,count]of groups){const type=name==='worker'?q.ECONOMY_WORKER_TYPE:name;if(mixed&&name!=='worker')sim.abilities[side][type]=true;
      if(name==='worker'){for(let i=0;i<count;i++){if(sim.spawnFromBuilding(base,type))continue;const angle=i*Math.PI*2/count,r=140+i%3*28;sim.spawnUnit(side,type,base.x+Math.cos(angle)*r,base.y+Math.sin(angle)*r)}}
      else{const cols=Math.min(12,count),spacing=Math.max(24,sim.unitRadius(type)*2+8);for(let i=0;i<count;i++)sim.spawnUnit(side,type,cx+(i%cols-(cols-1)/2)*spacing,cy+dir*(110+depth+Math.floor(i/cols)*spacing));depth+=Math.ceil(count/cols)*spacing+16}
     }
    }sim.rebuildRuntimeIndexes();if(sim.supplyUsed(0)!==400||sim.supplyUsed(1)!==400)throw Error('Fixture supply');
   };
   for(const c of denseOnly?cases.filter(c=>c.roster):cases){
    const scenario=q.DebugScenarioHarness.normalize({kind:'unit-combat',allyType:c.type,enemyType:c.type,allyCount:c.count,enemyCount:c.count,research:!c.roster||c.roster==='mixed400',humanRole:'host'}),draft={decks:{host:[c.type],guest:[c.type]},defenseCards:{host:[],guest:[]}},create=()=>q.StrategySim.createForMatch({draft,seed:3231409986,rules,debugScenario:scenario});
    const sims=[create(),create()];sims[0].collisionSweepGrid=new q.ReferenceSweptCollisionGrid(sims[0].world);
    if(c.roster)for(const s of sims)build400(s,c.roster==='mixed400');
    const times=[[],[]],physics=[[],[]];let hostileEntries=0,fullEntries=0;
    try{
     for(let t=1;t<=c.ticks;t++){
      if(t===25||t===65)for(const s of sims)s.applyCommand('host',{type:'SET_FLAG',x:s.world.width*.5+100,y:s.world.height*.5-100,forced:t===65});
      for(const i of t%2?[0,1]:[1,0]){const s=sims[i],start=performance.now();s.step();times[i].push(performance.now()-start);if(t%10===0)physics[i].push(s.perfStats.collisionSweptMotionMs)}
      same(bytes(sims[0]),bytes(sims[1]),(c.roster||c.type)+' tick '+t);
      if(t===35)sims[1].importState(sims[0].exportState());
      if(t===45){sims[0].importState(sims[1].exportState());sims[0].collisionSweepGrid=new q.ReferenceSweptCollisionGrid(sims[0].world)}
      const grid=sims[1].collisionSweepGrid;hostileEntries+=grid.hostileOrdered[0].length+grid.hostileOrdered[1].length;fullEntries+=grid.ordered.length;
      if(t%5===0)await new Promise(r=>setTimeout(r,0));
     }
     rows.push({...c,baseline:stats(times[0]),candidate:stats(times[1]),sampledSweepBaseline:stats(physics[0]),sampledSweepCandidate:stats(physics[1]),hostileEntries,fullEntries,identicalEveryTick:true});
     console.info('__sweepSide__'+JSON.stringify(rows.at(-1)));
    }finally{for(const s of sims)s.dispose('sweep-side-qa')}
   }return rows;
  },denseOnly);
  assert.deepEqual(errors,[]);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,denseOnly?'differential-dense.json':'differential.json'),JSON.stringify({errors,results},null,2));console.log(JSON.stringify({cases:results.length,ticks:results.reduce((n,c)=>n+c.ticks,0),identicalEveryTick:true}));
 }finally{await browser.close()}
})().catch(e=>{console.error(String(e.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[bundled module]'));process.exitCode=1});
