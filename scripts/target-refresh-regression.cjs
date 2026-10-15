const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path');
const {chromium}=require('playwright');
const root=path.resolve(__dirname,'..'),out=path.join(root,'.qa/target-stagger-20261011');
const game=require('./bundle-gamekit.cjs').bundleGame(root,fs.readFileSync(path.join(root,'index.html'),'utf8'));
const end=game.lastIndexOf('})();');assert(end>0);
const html=game.slice(0,end)+'window.__targetQA={StrategySim,GameRuleDefinition,DebugScenarioHarness,RallyStateCodec,UnitDefinition,BuildingDefinition,HashUtil,COMBAT_TARGET_REFRESH_MS};'+game.slice(end);
(async()=>{
  const browser=await chromium.launch({channel:process.env.QA_BROWSER_CHANNEL||'msedge',headless:true});
  try{
    const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.route('https://target-refresh.local/**',r=>r.fulfill({contentType:'text/html',body:html}));
    await page.goto('https://target-refresh.local/');await page.waitForFunction(()=>window.__targetQA&&window.RallyNetcode);
    const result=await page.evaluate(async()=>{
      const {StrategySim,GameRuleDefinition,DebugScenarioHarness,RallyStateCodec,UnitDefinition,HashUtil}=window.__targetQA;
      const check=(v,m)=>{if(!v)throw Error(m)},same=(a,b,m)=>check(a.length===b.length&&a.every((v,i)=>v===b[i]),m);
      const create=(type='swordsman',tps=10)=>StrategySim.createForMatch({
        draft:{decks:{host:[type],guest:[type]},defenseCards:{host:[],guest:[]}},seed:3,
        rules:GameRuleDefinition.resolve({overrides:{simulation:{tps}}}),
        debugScenario:DebugScenarioHarness.normalize({kind:'unit-combat',allyType:type,enemyType:type,allyCount:6,enemyCount:6,research:false,humanRole:'host'})});
      const bytes=s=>RallyStateCodec.encode(s.exportState());
      const focused=[],sim=create();
      try{
        const u=sim.units.find(u=>u.side===0&&u.type==='swordsman'),e=sim.units.find(u=>u.side===1&&u.type==='swordsman');
        const nonSlot=()=>{do{sim.tick++}while(sim.combatTargetRefreshDue(u));sim.tickVisibilityCache.forEach(c=>c.clear());sim.rebuildRuntimeIndexes()};
        const vision=()=>[sim.visionSources(0),sim.visionSources(1)];
        nonSlot();u.target=e.id;
        check(sim.retainedCombatTarget(u,vision()[0])?.entity===e,'Existing hostile target is retained');
        const origPick=sim.pickCombatTarget;let calls=0;sim.pickCombatTarget=function(...a){calls++;return origPick.apply(this,a)};
        const before={x:u.x,y:u.y};sim.updateCombat(u,vision());
        check(calls===0,'Non-slot chase does not scan candidates');check(u.target===e.id,'Chase keeps target');
        check(u.x!==before.x||u.y!==before.y,'Chase movement still executes');focused.push('non-slot movement');
        e.alive=false;nonSlot();sim.updateCombat(u,vision());check(u.target===null&&calls===0,'Dead target clears without emergency scan');focused.push('death clears immediately');e.alive=true;
        u.target=e.id;e.side=0;nonSlot();check(sim.retainedCombatTarget(u,vision()[0])===null,'Allied target rejected');e.side=1;focused.push('allegiance');
        const savedSee=sim.canSeeCombatTarget;sim.canSeeCombatTarget=()=>false;u.target=e.id;
        const hiddenHp=e.hp,hiddenShots=sim.projectiles.length;nonSlot();sim.updateCombat(u,vision());
        check(u.target===null&&!u.combat.windupPending()&&calls===0&&e.hp===hiddenHp&&sim.projectiles.length===hiddenShots,'Hidden target clears without attack or emergency scan');sim.canSeeCombatTarget=savedSee;focused.push('visibility');
        const savedTarget=sim.canTargetUnit;sim.canTargetUnit=()=>false;
        u.target=e.id;nonSlot();sim.updateCombat(u,vision());
        check(u.target===null&&!u.combat.windupPending()&&calls===0&&e.hp===hiddenHp&&sim.projectiles.length===hiddenShots,'Untargetable target clears without attack or emergency scan');sim.canTargetUnit=savedTarget;u.target=e.id;focused.push('targetability');
        const old={x:e.x,y:e.y};e.x=u.x+10000;e.y=u.y;check(sim.retainedCombatTarget(u,vision()[0])===null,'Out-of-aggro target rejected');Object.assign(e,old);focused.push('aggro limit');
        const b=sim.buildings.find(b=>b.side===1);u.target=b.id;const savedVisible=sim.isVisible,savedDistance=sim.interactionDistance;
        sim.isVisible=()=>true;sim.interactionDistance=()=>Infinity;
        check(sim.retainedCombatTarget(u,vision()[0])?.entity===b,'Building target retained');
        b.alive=false;check(sim.retainedCombatTarget(u,vision()[0])===null,'Destroyed building rejected');b.alive=true;
        b.side=0;check(sim.retainedCombatTarget(u,vision()[0])===null,'Allied building rejected');b.side=1;
        sim.isVisible=()=>false;check(sim.retainedCombatTarget(u,vision()[0])===null,'Hidden building rejected');
        sim.isVisible=savedVisible;sim.interactionDistance=savedDistance;focused.push('building death/allegiance/visibility');
        // Keep the attack in real legal range while crossing a non-search tick.
        const range=sim.interactionDistance(u,e,'attack',sim.basicAttackRange(u));
        e.x=u.x+Math.max(1,range-1);e.y=u.y;e.fx=Math.round(e.x*100);e.fy=Math.round(e.y*100);
        nonSlot();u.target=e.id;sim.clearAttackWindup(u);u.combat.cooldownUntil=0;
        sim.updateCombat(u,vision());check(u.combat.windupPending(),'Non-slot starts real attack windup');
        do{sim.tick++}while(!sim.combatTargetRefreshDue(u));
        sim.updateCombat(u,vision());check(calls===0,'Committed attack does not reacquire even on due slot');
        check(u.target===e.id&&(!u.combat.windupPending()||u.combat.attackWindupTargetId===e.id),'Windup/committed attack keeps retained target after due-slot update');focused.push('non-slot attack and due-slot windup lock');
        sim.clearAttackWindup(u);nonSlot();u.target=e.id;
        const guardian=sim.spawnUnit(1,'tank',u.x+20,u.y);sim.rebuildRuntimeIndexes();
        sim.updateCombat(u,vision());check(u.target===e.id&&calls===0,'New taunt waits on a non-slot tick');
        sim.clearAttackWindup(u);do{sim.tick++}while(!sim.combatTargetRefreshDue(u));
        sim.tickVisibilityCache.forEach(c=>c.clear());sim.rebuildRuntimeIndexes();
        sim.updateCombat(u,vision());check(calls===1&&u.target===guardian.id,'Next search slot honors taunt');focused.push('taunt changes target at next slot');
      }finally{sim.dispose('target-refresh-focused')}
      const artillery=create('siege');
      try{
        const u=artillery.units.find(u=>u.side===0&&u.type==='siege'),e=artillery.units.find(u=>u.side===1&&u.type==='siege');
        e.x=u.x+80;e.y=u.y;e.fx=Math.round(e.x*100);e.fy=Math.round(e.y*100);u.target=e.id;
        do{artillery.tick++}while(artillery.combatTargetRefreshDue(u));artillery.rebuildRuntimeIndexes();
        artillery.startAttackWindup(u,e,false,UnitDefinition.get(u.type),artillery.basicAttackRange(u));
        const before=artillery.projectiles.length;
        artillery.updateCombat(u,[artillery.visionSources(0),artillery.visionSources(1)]);
        check(!u.combat.windupPending(),'Minimum range cancels windup every tick');check(artillery.projectiles.length===before,'No illegal close-range shot');focused.push('minimum range cancels windup on non-slot tick');
      }finally{artillery.dispose('target-refresh-artillery')}
      const distributions=[];
      for(const tps of [10,15,20,30]){
        const s=create('swordsman',tps),n=s.msTicks(300),buckets=Array(n).fill(0);
        for(let i=1;i<=360;i++)buckets[(HashUtil.hash('u'+i)>>>0)%n]++;
        for(const u of s.units){let due=0;for(let t=1;t<=n;t++){s.tick=t;due+=s.combatTargetRefreshDue(u)?1:0}check(due===1,'Exactly one search slot per interval')}
        distributions.push({tps,intervalTicks:n,buckets});s.dispose('slot-distribution');
      }
      const deterministic=[];
      for(const type of ['swordsman','archer','tank','siege','rocket','pillbug','burrowbeast','hivecarrier','sporeherd','ancientmistray']){
        const a=create(type),b=create(type);
        try{
          for(let tick=1;tick<=45;tick++){
            if(tick===20||tick===30)for(const s of [a,b])s.applyCommand('host',{type:'SET_FLAG',x:s.world.width*.5,y:s.world.height*.5,forced:tick===30});
            a.step();b.step();same(bytes(a),bytes(b),type+' deterministic tick '+tick);
            if([13,14,15].includes(tick)){b.importState(a.exportState());same(bytes(a),bytes(b),type+' cold restore phase '+tick%3)}
            if(tick%5===0)await new Promise(r=>setTimeout(r,0));
          }
          deterministic.push({type,ticks:45,coldRestorePhases:3});
        }finally{a.dispose('qa');b.dispose('qa')}
      }
      return {focused,distributions,deterministic};
    });
    assert.deepEqual(errors,[]);fs.mkdirSync(out,{recursive:true});fs.writeFileSync(path.join(out,'regression.json'),JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result,null,2));
  }finally{await browser.close()}
})().catch(e=>{console.error(String(e.stack).replace(/data:text\/javascript;base64,[A-Za-z0-9+/=]+/g,'[bundled gamekit]'));process.exitCode=1});
