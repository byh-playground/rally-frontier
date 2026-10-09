const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const reference=fs.readFileSync(path.join(__dirname,'fixtures/contact-reference.js'),'utf8');
const source=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const end=source.lastIndexOf('})();');assert(end>0);
// Frozen pre-optimization functions are a byte-equality oracle, only inside QA.
const html=source.slice(0,end)+`
${reference}
window.__contactQA={StrategySim,GameRuleDefinition,DebugScenarioHarness,RallyStateCodec,InteractionGeometry,
  SweptCircleContact,reference:contactReference};
`+source.slice(end);
(async()=>{
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://contact-qa.local/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://contact-qa.local/');await page.waitForFunction(()=>window.__contactQA&&window.RallyNetcode);
    const results=await page.evaluate(async()=>{
      const q=window.__contactQA,{StrategySim,GameRuleDefinition,DebugScenarioHarness,RallyStateCodec,SweptCircleContact,InteractionGeometry}=q;
      const actual={cast:SweptCircleContact.cast,sweep:StrategySim.prototype.resolveNonAlliedSurfaceMotion,solve:StrategySim.prototype.solveContacts,target:StrategySim.prototype.pickCombatTarget,geometryContact:InteractionGeometry.contact};
      const install=methods=>{SweptCircleContact.cast=methods.cast;StrategySim.prototype.resolveNonAlliedSurfaceMotion=methods.sweep;StrategySim.prototype.solveContacts=methods.solve;StrategySim.prototype.pickCombatTarget=methods.target;InteractionGeometry.contact=methods.geometryContact};
      const bytes=sim=>RallyStateCodec.encode(sim.exportState());
      const same=(a,b,label)=>{if(a.length!==b.length||!a.every((v,i)=>v===b[i]))throw Error('Authoritative bytes differ: '+label)};
      const results=[];
      let randomState=0x12345678;
      const random=()=>((randomState=(Math.imul(randomState,1664525)+1013904223)>>>0)/4294967296);
      for(let i=0;i<20000;i++){
        const r=5+random()*100,rx=(random()-.5)*256,ry=(random()-.5)*256;
        const vx=i%4?(random()-.5)*128:0,vy=i%3?(random()-.5)*128:0;
        const policy=i%2?SweptCircleContact.policies.relative:SweptCircleContact.policies.surface;
        const fallback=()=>({x:1,y:0});
        const a=q.reference.cast(rx,ry,vx,vy,r,policy,fallback),b=actual.cast(rx,ry,vx,vy,r,policy,fallback);
        if(JSON.stringify(a)!==JSON.stringify(b))throw Error('Cast differs at '+i);
      }
      results.push({primitiveComparisons:20000,identical:true});
      for(const c of [{type:'swordsman',count:60,seed:3,ticks:120},{type:'shelltitan',count:60,seed:8,ticks:80},{type:'hivecarrier',count:15,seed:3,ticks:80},
        {type:'sporeherd',count:20,seed:8,ticks:100},{type:'pillbug',count:20,seed:3,ticks:80},
        {type:'burrowbeast',count:20,seed:8,ticks:80},{type:'swarmbug',count:20,seed:3,ticks:80},{type:'kickhopper',count:20,seed:8,ticks:80},
        {type:'mantis',enemy:'medic',count:20,seed:3,ticks:80},{type:'ancientmistray',enemy:'lanternmoth',count:20,seed:8,ticks:80},
        {type:'siege',enemy:'tank',count:20,seed:3,ticks:80},{type:'rocket',enemy:'swordsman',count:20,seed:8,ticks:80}]){
        const enemy=c.enemy||c.type,draft={decks:{host:[c.type],guest:[enemy]},defenseCards:{host:[],guest:[]}};
        const scenario=DebugScenarioHarness.normalize({kind:'unit-combat',allyType:c.type,enemyType:enemy,allyCount:c.count,enemyCount:c.count,research:true,humanRole:'host'});
        if(scenario.allyType!==c.type||scenario.enemyType!==enemy)throw Error('Unknown fixture unit '+c.type);
        const rules=GameRuleDefinition.resolve({overrides:{simulation:{tps:10}}});
        const a=StrategySim.createForMatch({draft,seed:c.seed,rules,debugScenario:scenario}),b=StrategySim.createForMatch({draft,seed:c.seed,rules,debugScenario:scenario});
        let referenceMs=0,actualMs=0;
        try{
          same(bytes(a),bytes(b),'initial '+c.type);
          for(let tick=1;tick<=c.ticks;tick++){
            if(tick===30||tick===60)for(const sim of [a,b])sim.applyCommand('host',{type:'SET_FLAG',x:sim.world.width*.5+120,y:sim.world.height*.5-120,forced:tick===60});
            install(q.reference);let started=performance.now();a.step();referenceMs+=performance.now()-started;
            install(actual);started=performance.now();b.step();actualMs+=performance.now()-started;
            same(bytes(a),bytes(b),c.type+' tick '+tick);
            if(tick===45){b.importState(a.exportState());same(bytes(a),bytes(b),'cold restore '+c.type)}
            if(tick%10===0)await new Promise(r=>setTimeout(r,0));
          }
          results.push({...c,referenceMs,actualMs,bytesEqualEveryTick:true,units:b.units.length,maxStepMs:b.perfStats.maxStepMs});
        }finally{install(actual);a.dispose('qa');b.dispose('qa')}
      }
      return results;
    });
    assert.deepEqual(errors,[]);
    fs.mkdirSync(path.join(root,'.qa/contact-reuse'),{recursive:true});
    fs.writeFileSync(path.join(root,'.qa/contact-reuse/differential.json'),JSON.stringify(results,null,2));
    console.log(JSON.stringify(results,null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(String(e.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[bundled gamekit]'));process.exitCode=1});
