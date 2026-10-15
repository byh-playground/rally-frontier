const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),{execFileSync}=require('node:child_process');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..');
const fixture=fs.readFileSync(path.join(__dirname,'fixtures/contact-reference.js'),'utf8');
const baseline=execFileSync('git',['show','714aed8f49ee8eff4ccc887791dd5b2045d8c54c:index.html'],{cwd:root,encoding:'utf8',maxBuffer:16*1024*1024});
const start=baseline.indexOf('  enforceNonAlliedNoOverlap('),end=baseline.indexOf('  resetTerrainMotionOrigin(',start);
assert(start>=0&&end>start,'Pinned SAP baseline must exist');
const hardFix=baseline.slice(start,end).trim();
const game=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const iifeEnd=game.lastIndexOf('})();');assert(iifeEnd>0);
const html=game.slice(0,iifeEnd)+`\n${fixture}\ncontactReference.hardFix={${hardFix}}.enforceNonAlliedNoOverlap;\nwindow.__hardFix400={StrategySim,GameRuleDefinition,DebugScenarioHarness,RallyStateCodec,BuildingDefinition,ECONOMY_WORKER_TYPE,NEUTRAL_SIDE,reference:contactReference};\n`+game.slice(iifeEnd);

(async()=>{
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://hardfix-400.local/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://hardfix-400.local/');await page.waitForFunction(()=>window.__hardFix400&&window.RallyNetcode);
    const rows=await page.evaluate(async()=>{
      const q=window.__hardFix400,{StrategySim,GameRuleDefinition,DebugScenarioHarness,RallyStateCodec,BuildingDefinition,ECONOMY_WORKER_TYPE,NEUTRAL_SIDE}=q;
      const actual=StrategySim.prototype.enforceNonAlliedNoOverlap;
      const install=fn=>{StrategySim.prototype.enforceNonAlliedNoOverlap=fn};
      const bytes=sim=>RallyStateCodec.encode(sim.exportState());
      const same=(a,b,label)=>{if(a.length!==b.length||!a.every((v,i)=>v===b[i]))throw Error('Authoritative bytes differ: '+label)};
      const scenario=DebugScenarioHarness.normalize({kind:'unit-combat',allyType:'swordsman',enemyType:'swordsman',allyCount:60,enemyCount:60,research:false,humanRole:'host'});
      const draft={decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}};
      const rules=GameRuleDefinition.resolve({overrides:{simulation:{tps:10}}});
      const create=()=>StrategySim.createForMatch({draft,seed:3231409986,rules,debugScenario:scenario});
      const a=create(),b=create();
      const build400=sim=>{
        sim.units=sim.units.filter(u=>u.side===NEUTRAL_SIDE);sim.unitById.clear();sim.unitIndexById.clear();sim.runtimeIndexTick=-1;sim.rebuildRuntimeIndexes();
        const cx=sim.world.width*.5,cy=sim.world.height*.5;
        for(const side of [0,1]){
          const dir=side===0?1:-1,base=sim.buildings.find(x=>x.side===side&&BuildingDefinition.get(x.type)?.isMainBase);let depth=0;
          for(let i=0;i<40;i++){
            if(sim.spawnFromBuilding(base,ECONOMY_WORKER_TYPE))continue;
            const angle=i*Math.PI*2/40,r=140+(i%3)*28;sim.spawnUnit(side,ECONOMY_WORKER_TYPE,base.x+Math.cos(angle)*r,base.y+Math.sin(angle)*r);
          }
          const type='swordsman',cols=12,spacing=Math.max(24,sim.unitRadius(type)*2+8);
          for(let i=0;i<180;i++)sim.spawnUnit(side,type,cx+(i%cols-(cols-1)/2)*spacing,cy+dir*(110+depth+Math.floor(i/cols)*spacing));
        }
        sim.rebuildRuntimeIndexes();
        const supply=[sim.supplyUsed(0),sim.supplyUsed(1)];if(supply.some(v=>v!==400))throw Error('Expected 400 supply each: '+supply);
      };
      build400(a);build400(b);same(bytes(a),bytes(b),'initial normal400 roster');
      const result=[];
      for(let tick=1;tick<=30;tick++){
        install(q.reference.hardFix);a.step();
        install(actual);b.step();
        same(bytes(a),bytes(b),'normal400 tick '+tick);
        if(tick%10===0){
          result.push({tick,units:b.units.length,baselineMs:a.perfStats.totalMs,currentMs:b.perfStats.totalMs,
            baselineHardFixMs:a.perfStats.collisionHardFixMs,currentHardFixMs:b.perfStats.collisionHardFixMs,
            currentCalls:b.perfStats.collisionHardFixCalls,currentPasses:b.perfStats.collisionHardFixPasses,
            currentActivePairTests:b.perfStats.collisionHardFixActivePairTests,currentCandidates:b.perfStats.collisionHardFixCandidates,
            currentCorrections:b.perfStats.collisionHardFixCorrections});
        }
        if(tick%5===0)await new Promise(r=>setTimeout(r,0));
      }
      a.dispose('hardfix-400-qa');b.dispose('hardfix-400-qa');install(actual);return result;
    });
    assert.deepEqual(errors,[]);assert.equal(rows.length,3);console.log(JSON.stringify(rows,null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(String(e.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[bundled gamekit]'));process.exitCode=1});
