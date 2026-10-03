const fs=require('node:fs');
const path=require('node:path');
const assert=require('node:assert/strict');
const {chromium}=require('playwright');
async function run(){
  const source=fs.readFileSync(path.resolve(__dirname,'..','index.html'),'utf8'),end=source.lastIndexOf('})();');
  const html=source.slice(0,end)+'window.__prepareQA={StrategySim,GameSession,TerrainNavigation,UnitDefinition,WorldContext,GameRuleDefinition,RallyStateCodec,NavigationGoal};'+source.slice(end);
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage();await page.route('http://prepare.test/**',route=>route.fulfill({contentType:'text/html',body:html}));
    await page.goto('http://prepare.test/');await page.waitForFunction(()=>window.__prepareQA);
    const results=await page.evaluate(()=>{
      const {StrategySim,GameSession,TerrainNavigation,UnitDefinition,WorldContext,GameRuleDefinition,RallyStateCodec,NavigationGoal}=window.__prepareQA;
      const check=(v,m)=>{if(!v)throw Error(m)},bytes=sim=>RallyStateCodec.encode(sim.exportState()),same=(a,b)=>a.length===b.length&&a.every((v,i)=>v===b[i]);
      const draft={decks:{host:['swordsman','swarmbug'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},rules=GameRuleDefinition.resolve({overrides:{map:{generator:'fixed-standard'}}});
      const cold=new StrategySim(draft,831047,rules),warm=StrategySim.createForMatch({draft,seed:831047,rules});
      check(!warm.navigation.metrics.preparationMs&&warm.navigation.layers.size===cold.navigation.layers.size,'Generic simulation factory stays lazy for diagnostics and replay');
      warm.navigation.prepareLayers(warm.units,warm.decks.flat());
      check(same(bytes(cold),bytes(warm)),'Explicit layer preparation leaves authoritative state bytes unchanged');
      const nav=warm.navigation,initialBuilds=nav.metrics.layersBuilt,initialLayers=[...nav.layers.values()];
      check(nav.metrics.preparationProfiles>0&&nav.metrics.preparationLayersBuilt>0,'Explicit match loading preparation builds navigation');
      check(initialLayers.every(l=>l.fields.size===0&&!l.sharedPaths?.size&&!l.astarScratch),'Preparation builds geometry/graph only, no flow fields or A* path cache');
      for(const type of [...new Set(warm.units.filter(u=>u.alive!==false&&u.hp>0).map(u=>u.type).concat(warm.decks.flat()))]){
        if(UnitDefinition.get(type)?.layer==='AIR')continue;
        const r=warm.unitRadius(type)+.12,ignore=!!UnitDefinition.get(type)?.burrowWhileMoving,key=TerrainNavigation.layerProfile(r,ignore).key;
        check(nav.layers.has(key),'Present/deck ground collision profile is available before the first game tick');
        nav.layer(r,ignore);
      }
      check(nav.metrics.layersBuilt===initialBuilds,'First available unit profile access does not build a cold layer');
      const repeat=nav.prepareLayers(warm.units,warm.decks.flat());
      check(repeat.layersBuilt===0&&initialLayers.every(layer=>[...nav.layers.values()].includes(layer)),'Repeated preparation preserves ready layer objects without rebuilding/evicting');
      const unit=warm.units.find(u=>UnitDefinition.get(u.type)?.economyWorker),goal=NavigationGoal.point(warm.world.width*.65,warm.world.height*.45);
      const project=p=>p&&{path:p.path,length:p.length,graphCost:p.graphCost};
      const mode=TerrainNavigation.planner(unit.type),radius=warm.unitRadius(unit.type)+.12;
      check(JSON.stringify(project(nav.plan(unit.x,unit.y,goal,radius,false,mode)))===JSON.stringify(project(cold.navigation.plan(unit.x,unit.y,goal,radius,false,mode))),'Prepared and cold graphs yield identical paths');
      for(let i=0;i<24;i++){warm.step();cold.step();check(same(bytes(warm),bytes(cold)),'Prepared/cold simulations remain byte-identical after stepping')}
      const results=[{factoryPreparedProfiles:repeat.profiles,preparationMs:nav.metrics.preparationMs,preparationLayersBuilt:nav.metrics.preparationLayersBuilt,equivalentGameTicks:24}];
      warm.dispose('qa-finished');cold.dispose('qa-finished');
      const scenarioDraft={decks:{host:['swordsman'],guest:['swordsman']},defenseCards:{host:[],guest:[]}},debugScenario={allyType:'swarmbug',enemyType:'shelltitan',allyCount:1,enemyCount:1,humanRole:'host'};
      const scenarioCold=new StrategySim(scenarioDraft,831047,rules);scenarioCold.applyDebugScenario(debugScenario);
      const scenarioWarm=StrategySim.createForMatch({draft:scenarioDraft,seed:831047,rules,debugScenario});
      check(!scenarioWarm.navigation.metrics.preparationMs,'Scenario diagnostics factory also stays lazy');
      scenarioWarm.navigation.prepareLayers(scenarioWarm.units,scenarioWarm.decks.flat());
      check(same(bytes(scenarioCold),bytes(scenarioWarm)),'Scenario is fully applied before preparation without state changes');
      check(scenarioWarm.navigation.layers.has(TerrainNavigation.layerProfile(scenarioWarm.unitRadius('swarmbug')+.12,true).key),'Preparation includes the scenario replacement roster and deck');
      results.push({scenarioRosterPrepared:true,scenarioBytesEqual:true});scenarioCold.dispose('qa-finished');scenarioWarm.dispose('qa-finished');
      const factory=StrategySim.createForMatch,marker=Error('preparation stage reached'),calls=[];
      const mock={units:[{type:'swordsman'}],decks:[['swordsman'],['swarmbug']],navigation:{prepareLayers(units,types){calls.push('prepare');check(units===mock.units&&types.join(',')==='swordsman,swarmbug','Live coordinator prepares the created scenario roster and decks');throw marker}},dispose(reason){calls.push(reason)}};
      const session={disposed:false,sim:null,draft,roundRules:rules,matchConfig:{},clearDisconnectGrace(){},clearPostRecoveryCountdown(){}};
      StrategySim.createForMatch=()=>{calls.push('factory');return mock};
      try{let failure=null;try{GameSession.prototype.startSim.call(session,831047)}catch(error){failure=error}
        check(failure===marker&&calls.join(',')==='factory,prepare,initialization-failed','Actual live startSim prepares after creation and disposes preparation failures');
        check(session.sim===null&&!session.simulationAdapter&&!session.netcodeSession,'Failed preparation cannot leave a partial live/core owner');
      }finally{StrategySim.createForMatch=factory}
      results.push({liveCoordinatorPreparesBeforeCore:true,failedPreparationDisposed:true,genericFactoryLazy:true});
      const types=Object.keys(UnitDefinition.all).filter(type=>UnitDefinition.get(type)?.layer!=='AIR').slice(0,22),radii=new Map(types.map((type,i)=>[type,4+i]));
      const sim={world:WorldContext.fromMap({width:3072,height:3072,terrain:{}}),buildings:[],tick:0,navigationRevision:0,unitRadius:type=>radii.get(type)},bounded=new TerrainNavigation(sim);
      const units=types.slice(-4).map(type=>({type,hp:1,alive:true})),present=units[0],held=bounded.layer(sim.unitRadius(present.type)+.12,TerrainNavigation.ignoresBuildings(present));
      for(let i=0;i<11;i++)bounded.layer(60+i,false);
      const report=bounded.prepareLayers(units,types),count=bounded.metrics.layersBuilt;
      check(report.profiles.length===12&&report.skipped>0&&bounded.layers.size===12,'Preparation respects the existing bounded layer capacity');
      check(bounded.layers.get(TerrainNavigation.layerProfile(sim.unitRadius(present.type)+.12,TerrainNavigation.ignoresBuildings(present)).key)===held,'Existing prioritized present layer survives capacity reservation');
      for(const u of units)check(report.profiles.includes(TerrainNavigation.layerProfile(sim.unitRadius(u.type)+.12,TerrainNavigation.ignoresBuildings(u)).key),'Present profiles take priority over later deck-only profiles');
      bounded.prepareLayers([...units].reverse(),[...types].reverse());check(bounded.metrics.layersBuilt===count,'Equivalent reordered preparation does not churn the cache');
      results.push({capacity:bounded.layers.size,selectedProfiles:report.profiles,skippedProfiles:report.skipped,repeatedBuilds:bounded.metrics.layersBuilt-count});
      return results;
    });
    console.log(JSON.stringify(results,null,2));assert.equal(results.length,4);
  }finally{await browser.close()}
}
run().catch(error=>{console.error(error);process.exitCode=1});
